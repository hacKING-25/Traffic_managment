import React, { useEffect, useState } from 'react';
import './App.css';

const API_BASE = 'http://localhost:5000';
const WS_URL = 'ws://localhost:5000';

export default function App() {
  const [trades, setTrades] = useState([]);
  const [lastCompletedAt, setLastCompletedAt] = useState(null);
  const [pullStatus, setPullStatus] = useState({
    inProgress: false,
    completedBatches: 0,
    totalBatches: 60,
    recordsPulledInCurrentRun: 0,
    totalRecordsToPull: 3000,
    configuredDurationMs: 900000,
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [justUpdatedBanner, setJustUpdatedBanner] = useState(null);
  const [searchSymbol, setSearchSymbol] = useState('');

  useEffect(() => {
    // 1. INSTANT LOAD: Fetch already-pulled cached trades immediately (< 5ms),
    // even if a 15-minute BSE pull is currently in progress in the background.
    fetch(`${API_BASE}/api/dashboard/trades`)
      .then((res) => res.json())
      .then((data) => {
        setTrades(data.trades || []);
        setLastCompletedAt(data.lastCompletedAt);
        if (data.pullStatus) setPullStatus(data.pullStatus);
      })
      .catch((err) => console.error('Initial load error:', err));

    // 2. REAL-TIME PUSH (NO POLLING, NO REFRESH):
    // Connect via WebSocket to receive new trades automatically when a pull completes.
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);

    ws.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);

      if (type === 'INITIAL_STATUS' || type === 'PULL_STARTED' || type === 'PULL_PROGRESS') {
        setPullStatus((prev) => ({ ...prev, ...payload }));
      }

      if (type === 'PULL_COMPLETED') {
        // Automatically update open dashboard with newly pulled trades — zero refresh!
        setTrades(payload.trades);
        setLastCompletedAt(payload.lastCompletedAt);
        setPullStatus(payload.pullStatus);
        setJustUpdatedBanner(
          `Pull Complete! ${payload.newlyAddedCount.toLocaleString()} new BSE trades appeared automatically via WebSocket push.`
        );
        setTimeout(() => setJustUpdatedBanner(null), 8000);
      }
    };

    return () => ws.close();
  }, []);

  const triggerPull = async (durationMs) => {
    await fetch(`${API_BASE}/api/dashboard/trigger-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs }),
    });
  };

  const filteredTrades = trades.filter(
    (t) =>
      t.symbol.toLowerCase().includes(searchSymbol.toLowerCase()) ||
      t.client.toLowerCase().includes(searchSymbol.toLowerCase()) ||
      t.tradeId.toLowerCase().includes(searchSymbol.toLowerCase())
  );

  const progressPercent = pullStatus.totalBatches
    ? Math.round((pullStatus.completedBatches / pullStatus.totalBatches) * 100)
    : 0;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div>
          <h1>BSE Exchange Trades Dashboard</h1>
          <p className="subtitle">
            Instant Read Cache + Chunked Cursor Pull (&lt;30s HTTP Timeout Safe) + WebSocket Auto-Push
          </p>
        </div>
        <div className="connection-badges">
          <span className={`badge ${wsConnected ? 'badge-live' : 'badge-offline'}`}>
            {wsConnected ? '● WebSocket Push Connected (No Polling)' : '○ Disconnected'}
          </span>
        </div>
      </header>

      {justUpdatedBanner && <div className="toast-banner">{justUpdatedBanner}</div>}

      <section className="control-panel">
        <div className="status-box">
          <div className="status-header">
            <strong>BSE Ingestion Status: </strong>
            {pullStatus.inProgress ? (
              <span className="status-pulling">
                Pulling from /getTrades in background ({pullStatus.recordsPulledInCurrentRun.toLocaleString()} /{' '}
                {pullStatus.totalRecordsToPull.toLocaleString()} records — Batch {pullStatus.completedBatches}/
                {pullStatus.totalBatches})
              </span>
            ) : (
              <span className="status-idle">Idle — Showing Cached Trades Instantly</span>
            )}
          </div>

          {pullStatus.inProgress && (
            <div className="progress-bar-outer">
              <div className="progress-bar-inner" style={{ width: `${progressPercent}%` }} />
            </div>
          )}

          <div className="meta-row">
            <span>
              <strong>Total Cached Trades:</strong> {trades.length.toLocaleString()}
            </span>
            <span>
              <strong>Last Pull Completed:</strong>{' '}
              {lastCompletedAt ? new Date(lastCompletedAt).toLocaleTimeString() : 'N/A'}
            </span>
            <span>
              <strong>Configured Pull Delay:</strong> {(pullStatus.configuredDurationMs / 1000).toFixed(0)}s total (
              {(pullStatus.configuredDurationMs / 1000 / (pullStatus.totalBatches || 60)).toFixed(2)}s per HTTP batch)
            </span>
          </div>
        </div>

        <div className="action-buttons">
          <button
            className="btn btn-primary"
            disabled={pullStatus.inProgress}
            onClick={() => triggerPull(15000)}
          >
            Start 15s Demo Pull
          </button>
          <button
            className="btn btn-secondary"
            disabled={pullStatus.inProgress}
            onClick={() => triggerPull(15 * 60 * 1000)}
          >
            Start Full 15-Min Pull
          </button>
        </div>
      </section>

      <section className="table-section">
        <div className="table-toolbar">
          <h2>Pulled Trades ({filteredTrades.length.toLocaleString()} records shown)</h2>
          <input
            type="text"
            placeholder="Filter by Symbol, Client, or Trade ID..."
            value={searchSymbol}
            onChange={(e) => setSearchSymbol(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Trade ID</th>
                <th>Client</th>
                <th>Symbol</th>
                <th className="num">Quantity</th>
                <th className="num">Price (₹)</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrades.slice(0, 200).map((trade) => (
                <tr key={trade.tradeId}>
                  <td className="mono">{trade.tradeId}</td>
                  <td>{trade.client}</td>
                  <td>
                    <span className="symbol-pill">{trade.symbol}</span>
                  </td>
                  <td className="num">{trade.quantity.toLocaleString()}</td>
                  <td className="num">₹{trade.price.toFixed(2)}</td>
                  <td className="mono">{new Date(trade.timestamp).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="table-footer-note">
            Showing top 200 of {filteredTrades.length.toLocaleString()} cached records in memory for smooth DOM rendering.
          </p>
        </div>
      </section>
    </div>
  );
}
