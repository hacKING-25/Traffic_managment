const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');

// ============================================================================
// CONFIGURATION (15 Minutes Default, Configurable via Env or API)
// ============================================================================
const BSE_PORT = 4000;
const APP_PORT = 5000;

// Default: 15 minutes (900,000 ms). Can be overridden via PULL_DURATION_MS=15000 for fast demo.
let configurablePullDurationMs = Number(process.env.PULL_DURATION_MS) || 15 * 60 * 1000;

// Hard network timeout: kills any HTTP request held open longer than 30 seconds (30,000 ms)
const NETWORK_HTTP_TIMEOUT_MS = 30 * 1000;

// Total seeded trades in Mock BSE API (3,000 records) & batch size (50 records per batch = 60 batches)
// At 15 minutes (900s) across 60 batches, each HTTP request takes 15 seconds (< 30s timeout!).
const TOTAL_BSE_RECORDS = 3000;
const DEFAULT_BATCH_SIZE = 50;

// ============================================================================
// PART 1: MOCK BSE EXCHANGE API (PORT 4000)
// Requirement 1:
// - GET /getTrades returns seeded trade data (trade ID, client, symbol, quantity, price, timestamp)
// - Configurable delay to pull (15 minutes total across full dataset)
// - Enforces 30-second HTTP connection kill to simulate the corporate network constraint
// ============================================================================
const bseApp = express();
bseApp.use(cors());

const SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'KOTAKBANK'];
const CLIENTS = ['CLI-101 (Arham Prop)', 'CLI-204 (Alpha Desk)', 'CLI-309 (Quant HFT)', 'CLI-412 (Retail Pool)', 'CLI-518 (Inst Desk)'];

// Generate 3,000 deterministic + realistic BSE trade records
function generateBseSeededTrades(count = TOTAL_BSE_RECORDS, pullRunId = 1) {
  const trades = [];
  const baseTime = Date.now() - count * 1000;
  for (let i = 1; i <= count; i++) {
    const symbol = SYMBOLS[i % SYMBOLS.length];
    const basePrice = 500 + (i % 25) * 120;
    trades.push({
      tradeId: `BSE-${pullRunId}-${String(i).padStart(5, '0')}`,
      client: CLIENTS[i % CLIENTS.length],
      symbol,
      quantity: ((i % 20) + 1) * 25,
      price: Number((basePrice + (Math.sin(i) * 15)).toFixed(2)),
      timestamp: new Date(baseTime + i * 1000).toISOString(),
    });
  }
  return trades;
}

let currentBseDataset = generateBseSeededTrades(TOTAL_BSE_RECORDS, 1);

// Middleware simulating the strict network rule:
// "Our network kills any HTTP connection held open longer than 30 seconds."
bseApp.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.error(`[Network Firewall] Killed HTTP connection after ${NETWORK_HTTP_TIMEOUT_MS / 1000}s: ${req.originalUrl}`);
      res.status(504).json({
        error: 'NETWORK_TIMEOUT: HTTP connection held open longer than 30 seconds was terminated by firewall.'
      });
      req.socket.destroy();
    }
  }, NETWORK_HTTP_TIMEOUT_MS);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

/**
 * GET /getTrades
 * Supports two modes:
 * 1. Naive Full Pull (`GET /getTrades?full=true`): Waits the full 15 minutes before responding.
 *    If configurablePullDurationMs > 30,000ms, the 30s network firewall middleware WILL kill it!
 * 2. Chunked Cursor Pull (`GET /getTrades?cursor=0&limit=50`):
 *    Slices the 3,000 records into 60 batches. Each batch delays for (configurablePullDurationMs / 60).
 *    For a 15-minute pull (900s), each batch takes 15 seconds (< 30s firewall limit) and succeeds!
 */
bseApp.get('/getTrades', async (req, res) => {
  const isNaiveFullPull = req.query.full === 'true';

  if (isNaiveFullPull) {
    console.log(`[Mock BSE API] Naive full pull requested. Waiting ${configurablePullDurationMs / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, configurablePullDurationMs));
    if (res.writableEnded) return;
    return res.json({
      total: currentBseDataset.length,
      trades: currentBseDataset,
    });
  }

  // Chunked batch pull (Cursor pagination to stay under the 30-second HTTP connection limit)
  const cursor = parseInt(req.query.cursor || '0', 10);
  const limit = parseInt(req.query.limit || String(DEFAULT_BATCH_SIZE), 10);
  const totalBatches = Math.ceil( currentBseDataset.length / limit );

  // Proportional delay per batch so total pull across all batches equals configurablePullDurationMs (e.g. 15 mins)
  const batchDelayMs = Math.floor(configurablePullDurationMs / totalBatches);

  await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
  if (res.writableEnded) return;

  const slice = currentBseDataset.slice(cursor, cursor + limit);
  const nextCursor = cursor + limit < currentBseDataset.length ? cursor + limit : null;

  res.json({
    cursor,
    nextCursor,
    batchSize: slice.length,
    totalRecords: currentBseDataset.length,
    batchDelayMs,
    trades: slice,
  });
});

bseApp.listen(BSE_PORT, () => {
  console.log(`[Mock BSE API] Running on http://localhost:${BSE_PORT}/getTrades`);
});

// ============================================================================
// PART 2: APPLICATION BACKEND & IN-MEMORY STORE (PORT 5000)
// Requirement 2:
// - Dashboard opens instantly showing trades already pulled — even while a pull is in progress
// - When a pull completes, new trades appear automatically — no refresh, no polling, no cronjob
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json());

const tradeEvents = new EventEmitter();

// Pre-seed in-memory store with initial historical trades (Pull Run #1)
// so the Dashboard ALWAYS opens instantly with data, even on very first page load!
const inMemoryStore = {
  pullRunCount: 1,
  trades: generateBseSeededTrades(500, 1).reverse(), // 500 already-pulled trades ready on boot
  lastCompletedAt: new Date().toISOString(),
  pullStatus: {
    inProgress: false,
    startedAt: null,
    completedBatches: 0,
    totalBatches: Math.ceil(TOTAL_BSE_RECORDS / DEFAULT_BATCH_SIZE),
    recordsPulledInCurrentRun: 0,
    totalRecordsToPull: TOTAL_BSE_RECORDS,
    configuredDurationMs: configurablePullDurationMs,
  },
};

/**
 * Background Ingestion Worker (No Cronjob, No Browser Polling)
 * Pulls batches sequentially from Mock BSE API (http://localhost:4000/getTrades).
 * Each HTTP request stays under 30 seconds. When all batches finish, emits 'PULL_COMPLETED'.
 */
async function executeBackgroundBsePull() {
  if (inMemoryStore.pullStatus.inProgress) {
    return; // Prevent overlapping pulls
  }

  const nextRunId = inMemoryStore.pullRunCount + 1;
  currentBseDataset = generateBseSeededTrades(TOTAL_BSE_RECORDS, nextRunId);

  const totalBatches = Math.ceil(TOTAL_BSE_RECORDS / DEFAULT_BATCH_SIZE);
  inMemoryStore.pullStatus = {
    inProgress: true,
    startedAt: new Date().toISOString(),
    completedBatches: 0,
    totalBatches,
    recordsPulledInCurrentRun: 0,
    totalRecordsToPull: TOTAL_BSE_RECORDS,
    configuredDurationMs: configurablePullDurationMs,
  };

  // Notify connected dashboards that a background pull has started
  tradeEvents.emit('PULL_STARTED', inMemoryStore.pullStatus);

  let cursor = 0;
  const stagedTrades = [];

  try {
    while (cursor !== null) {
      // Each fetch opens a short-lived HTTP connection (< 30s) to the Mock BSE API
      const response = await fetch(
        `http://localhost:${BSE_PORT}/getTrades?cursor=${cursor}&limit=${DEFAULT_BATCH_SIZE}`
      );

      if (!response.ok) {
        throw new Error(`BSE API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      stagedTrades.push(...data.trades);
      cursor = data.nextCursor;

      inMemoryStore.pullStatus.completedBatches += 1;
      inMemoryStore.pullStatus.recordsPulledInCurrentRun = stagedTrades.length;

      // Broadcast live progress (optional UX enhancement while pull is in progress)
      tradeEvents.emit('PULL_PROGRESS', inMemoryStore.pullStatus);
    }

    // Full 15-minute pull is now complete! Commit new trades to the in-memory store
    inMemoryStore.pullRunCount = nextRunId;
    inMemoryStore.trades = [...stagedTrades.reverse(), ...inMemoryStore.trades].slice(0, 6000);
    inMemoryStore.lastCompletedAt = new Date().toISOString();
    inMemoryStore.pullStatus.inProgress = false;

    console.log(`[App Backend] Pull #${nextRunId} complete (${stagedTrades.length} new trades). Pushing to WebSocket clients!`);

    // Event-driven push: immediately notify all open dashboards without page refresh or polling
    tradeEvents.emit('PULL_COMPLETED', {
      trades: inMemoryStore.trades,
      lastCompletedAt: inMemoryStore.lastCompletedAt,
      pullStatus: inMemoryStore.pullStatus,
      newlyAddedCount: stagedTrades.length,
    });
  } catch (error) {
    console.error('[App Backend] Pull failed:', error.message);
    inMemoryStore.pullStatus.inProgress = false;
    tradeEvents.emit('PULL_ERROR', { message: error.message, pullStatus: inMemoryStore.pullStatus });
  }
}

// 1. Instant Read Endpoint for Dashboard Initial Load (< 5ms from RAM)
app.get('/api/dashboard/trades', (req, res) => {
  res.json({
    trades: inMemoryStore.trades,
    lastCompletedAt: inMemoryStore.lastCompletedAt,
    pullStatus: {
      ...inMemoryStore.pullStatus,
      configuredDurationMs: configurablePullDurationMs,
    },
  });
});

// 2. Endpoint to Trigger a Background Pull (or auto-triggered on server start)
app.post('/api/dashboard/trigger-pull', (req, res) => {
  if (req.body && typeof req.body.durationMs === 'number') {
    configurablePullDurationMs = req.body.durationMs;
  }

  if (!inMemoryStore.pullStatus.inProgress) {
    // Fire-and-forget asynchronous background pull; return HTTP 202 immediately (< 5ms)
    executeBackgroundBsePull();
  }

  res.status(202).json({
    message: 'Background BSE trade pull initiated.',
    pullStatus: inMemoryStore.pullStatus,
  });
});

// Create HTTP server & attach WebSocket Server for zero-polling real-time push
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastToDashboards(type, payload) {
  const message = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

tradeEvents.on('PULL_STARTED', (status) => broadcastToDashboards('PULL_STARTED', status));
tradeEvents.on('PULL_PROGRESS', (status) => broadcastToDashboards('PULL_PROGRESS', status));
tradeEvents.on('PULL_COMPLETED', (data) => broadcastToDashboards('PULL_COMPLETED', data));
tradeEvents.on('PULL_ERROR', (err) => broadcastToDashboards('PULL_ERROR', err));

wss.on('connection', (ws) => {
  console.log('[WebSocket] Dashboard client connected');
  // Immediately send current pull state on connect
  ws.send(
    JSON.stringify({
      type: 'INITIAL_STATUS',
      payload: inMemoryStore.pullStatus,
    })
  );
});

server.listen(APP_PORT, () => {
  console.log(`[App Backend] Running on http://localhost:${APP_PORT}`);
  console.log(`[Config] Pull Duration set to ${configurablePullDurationMs / 1000}s (30s HTTP timeout enforced on BSE API)`);
  // Automatically start an initial background pull on server boot so any dashboard opened mid-pull sees both cached data + active pull!
  executeBackgroundBsePull();
});