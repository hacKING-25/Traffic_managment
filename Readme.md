# BSE Exchange Trades Dashboard & Resilient Ingestion Pipeline

A full-stack Node.js (Express + WebSockets) and React solution designed to pull large trade datasets from a slow upstream exchange API (`15-minute` full pull duration) across a restrictive network firewall that kills any HTTP connection held open longer than `30 seconds`.

## Key Features Mapped to Requirements

| Requirement | Implementation Details |
| :--- | :--- |
| **1. Mock BSE API (`GET /getTrades`)** | Runs on Port `4000`. Generates `3,000` seeded equity trades (`tradeId`, `client`, `symbol`, `quantity`, `price`, `timestamp`) with a configurable total pull delay (`15 minutes` default via `PULL_DURATION_MS=900000`, or `15 seconds` in demo mode). Includes a strict `30-second` HTTP socket timeout middleware that kills any naive single-request pull held open >30s. |
| **2. Survive 30s HTTP Timeout** | The Application Backend (Port `5000`) pulls from `GET /getTrades?cursor=N&limit=50` across `60` sequential batches. During a 15-minute pull (`900s`), each HTTP batch request takes `15 seconds` (`< 30s` firewall limit) and closes cleanly. |
| **3. Instant Dashboard Load** | The backend serves already-pulled trades from an in-memory `TradeStore` via `GET /api/dashboard/trades` in `< 5ms`, even while a 15-minute pull is actively running in the background. |
| **4. Real-Time Auto-Update (No Refresh / No Polling / No Cron)** | The React dashboard connects via a persistent WebSocket (`ws://localhost:5000`). When the background pull finishes, a Node.js `EventEmitter` broadcasts `PULL_COMPLETED` over the WebSocket, automatically updating the open dashboard UI. |

## Quick Setup & Run Instructions

### Prerequisites
- Node.js (v18+ recommended, uses native `fetch`)

### 1. Start the Backend (Mock BSE API on `:4000` + App Server on `:5000`)

```bash
cd backend
npm install

# Run with the default 15-minute (900,000 ms) full pull delay:
npm start

# OR run in 15-second (15,000 ms) Demo Mode for quick testing:
npm run demo
```

### 2. Start the React Trades Dashboard (`:5173`)

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.
- Notice that the dashboard **opens instantly** with 500 cached trades while a background pull is already in progress.
- You can also click **"Start 15s Demo Pull"** or **"Start Full 15-Min Pull"** in the UI to test both configurations live.

