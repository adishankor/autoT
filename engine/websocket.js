// ─────────────────────────────────────────────────────────────────────────────
// websocket.js  —  WEAKNESS 1 fix: real-time price feed via Bybit WebSocket
// Bybit WS public spot: wss://stream.bybit.com/v5/public/spot
// No API key needed for public ticker feed
// ─────────────────────────────────────────────────────────────────────────────

const WebSocket = require("ws");

const WS_URL = "wss://stream.bybit.com/v5/public/spot";
const PING_INTERVAL_MS = 20000; // Bybit requires ping every 20s

class BybitTickerWS {
  constructor({ onTick, onLog }) {
    this.ws          = null;
    this.symbol      = null;
    this.onTick      = onTick;   // callback(symbol, price, data)
    this.onLog       = onLog;    // callback(msg, type)
    this.pingTimer   = null;
    this.reconnTimer = null;
    this.reconnDelay = 3000;
    this.running     = false;
    this.lastPrice   = null;
  }

  // ── Connect and subscribe to a symbol ────────────────────────────────────
  subscribe(symbol) {
    if (this.symbol === symbol && this.ws?.readyState === WebSocket.OPEN) return;
    this.symbol  = symbol;
    this.running = true;
    this._connect();
  }

  // ── Stop and disconnect ───────────────────────────────────────────────────
  unsubscribe() {
    this.running = false;
    this.symbol  = null;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnTimer);
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
    this.log("📴 WebSocket disconnected");
  }

  // ── Internal: connect ─────────────────────────────────────────────────────
  _connect() {
    if (!this.running || !this.symbol) return;
    clearInterval(this.pingTimer);

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.on("open", () => {
        this.log(`🔌 WebSocket connected — subscribing to ${this.symbol}`);
        this.reconnDelay = 3000; // reset backoff on success

        // Subscribe to ticker
        this.ws.send(JSON.stringify({
          op: "subscribe",
          args: [`tickers.${this.symbol}`]
        }));

        // Ping every 20s to keep connection alive
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: "ping" }));
          }
        }, PING_INTERVAL_MS);
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Ignore pong and subscription confirmations
          if (msg.op === "pong" || msg.op === "subscribe") return;

          // Ticker data
          if (msg.topic?.startsWith("tickers.") && msg.data) {
            const d     = msg.data;
            const price = parseFloat(d.lastPrice || d.markPrice || 0);
            if (price > 0 && this.onTick) {
              this.lastPrice = price;
              this.onTick(this.symbol, price, {
                price,
                bid:    parseFloat(d.bid1Price || 0),
                ask:    parseFloat(d.ask1Price || 0),
                vol24h: parseFloat(d.volume24h || 0),
                chg24h: parseFloat(d.price24hPcnt || 0),
                ts:     Date.now()
              });
            }
          }
        } catch {}
      });

      this.ws.on("error", (err) => {
        this.log(`⚠️ WebSocket error: ${err.message}`, "warn");
      });

      this.ws.on("close", (code) => {
        clearInterval(this.pingTimer);
        if (!this.running) return;
        this.log(`⚠️ WebSocket closed (code ${code}) — reconnecting in ${this.reconnDelay}ms`, "warn");
        this.reconnTimer = setTimeout(() => this._connect(), this.reconnDelay);
        this.reconnDelay = Math.min(this.reconnDelay * 2, 30000); // exponential backoff, max 30s
      });

    } catch (e) {
      this.log(`❌ WebSocket connect error: ${e.message}`, "error");
      if (this.running) {
        this.reconnTimer = setTimeout(() => this._connect(), this.reconnDelay);
      }
    }
  }

  log(msg, type = "info") {
    if (this.onLog) this.onLog(msg, type);
    else console.log(`[WS][${type}] ${msg}`);
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

module.exports = BybitTickerWS;
