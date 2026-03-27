const fetch = require("node-fetch");
const crypto = require("crypto");
const BASE = "https://api.bybit.com";

function sign(key, secret, ts, paramStr) {
  return crypto.createHmac("sha256", secret).update(ts + key + "5000" + paramStr).digest("hex");
}

async function call(method, path, params = {}, auth = false) {
  const key = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  const ts = Date.now().toString();
  let url = BASE + path;
  let body, headers = { "Content-Type": "application/json" };

  if (auth) {
    if (!key || !secret) throw new Error("Bybit API keys missing");
    Object.assign(headers, { "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": "5000" });
  }

  if (method === "GET") {
    const qs = new URLSearchParams(params).toString();
    if (auth) headers["X-BAPI-SIGN"] = sign(key, secret, ts, qs);
    if (qs) url += "?" + qs;
  } else {
    body = JSON.stringify(params);
    if (auth) headers["X-BAPI-SIGN"] = sign(key, secret, ts, body);
  }

  const r = await fetch(url, { method, headers, body });
  const d = await r.json();
  if (d.retCode !== undefined && d.retCode !== 0)
    throw new Error(`Bybit ${d.retCode}: ${d.retMsg}`);
  return d.result ?? d;
}

const ticker        = (s) => call("GET", "/v5/market/tickers", { category:"spot", symbol:s });
const klines        = (s, i="15", l=80) => call("GET", "/v5/market/kline", { category:"spot", symbol:s, interval:i, limit:l });
const instruments   = () => call("GET", "/v5/market/instruments-info", { category:"spot", limit:500 });
const announcements = () => call("GET", "/v5/announcements/index", { locale:"en-US", page:1, limit:30 }).catch(()=>({ list:[] }));
const orderbook     = (s, depth=50) => call("GET", "/v5/market/orderbook", { category:"spot", symbol:s, limit:depth });
// Perp funding rate — free public endpoint, no auth needed
const fundingRate   = (s="BTCUSDT") => call("GET", "/v5/market/funding/history", { category:"linear", symbol:s, limit:2 }).catch(()=>({ list:[] }));

async function getBalances() {
  const d = await call("GET", "/v5/account/wallet-balance", { accountType:"UNIFIED" }, true);
  const coins = d.list?.[0]?.coin || [];
  return {
    usdtBal: parseFloat(coins.find(c=>c.coin==="USDT")?.walletBalance || 0),
    totalUSD: parseFloat(d.list?.[0]?.totalEquity || 0),
    coins: coins.filter(c=>parseFloat(c.walletBalance)>0)
  };
}

async function placeOrder(symbol, side, qty) {
  return call("POST", "/v5/order/create", {
    category:"spot", symbol, side, orderType:"Market",
    qty: qty.toString(), timeInForce:"IOC"
  }, true);
}

// ── WEAKNESS 3: Orderbook wall analysis ──────────────────────────────────────
// Bybit orderbook format: { b: [[price,qty],...], a: [[price,qty],...] }
function analyzeOrderbook(raw, currentPrice) {
  if (!raw?.b || !raw?.a) return null;

  const parse = (side) => side.map(([p, q]) => {
    const price = parseFloat(p), qty = parseFloat(q);
    return { price, qty, value: price * qty };
  });

  const bids = parse(raw.b); // buy orders — support side
  const asks = parse(raw.a); // sell orders — resistance side

  if (!bids.length || !asks.length) return null;

  // Wall = any order whose USD value is ≥ 3× the average of its side
  const avgBid = bids.reduce((s, b) => s + b.value, 0) / bids.length;
  const avgAsk = asks.reduce((s, a) => s + a.value, 0) / asks.length;

  const bidWalls = bids
    .filter(b => b.value >= avgBid * 3 && b.price < currentPrice)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  const askWalls = asks
    .filter(a => a.value >= avgAsk * 3 && a.price > currentPrice)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  // Pressure imbalance — top-10 each side
  const bidPressure = bids.slice(0, 10).reduce((s, b) => s + b.value, 0);
  const askPressure = asks.slice(0, 10).reduce((s, a) => s + a.value, 0);
  const imbalance   = askPressure > 0 ? bidPressure / askPressure : 1;

  // Spread
  const bestBid  = bids[0]?.price || 0;
  const bestAsk  = asks[0]?.price || 0;
  const spreadPct = bestBid > 0 ? (bestAsk - bestBid) / bestBid * 100 : 0;

  // Nearest walls to current price
  const nearestBidWall = bidWalls[0] || null;
  const nearestAskWall = askWalls[0] || null;

  const imbalanceLabel = imbalance > 1.25 ? "BID_DOM" : imbalance < 0.80 ? "ASK_DOM" : "BALANCED";

  return {
    bidWalls, askWalls,
    imbalance: +imbalance.toFixed(3),
    imbalanceLabel,
    spreadPct: +spreadPct.toFixed(5),
    nearestSupport:    nearestBidWall ? nearestBidWall.price : null,
    nearestResistance: nearestAskWall ? nearestAskWall.price : null,
    bullish: imbalance > 1.25,
    bearish: imbalance < 0.80,
    // One-line summary for Claude prompt
    summary: [
      `Imbalance:${imbalance.toFixed(2)}x(${imbalanceLabel})`,
      `Spread:${spreadPct.toFixed(4)}%`,
      bidWalls.length  ? `BidWalls:${bidWalls.map(w=>`$${w.price.toFixed(4)}=$${(w.value/1000).toFixed(0)}K`).join(",")}` : "NoBidWall",
      askWalls.length  ? `AskWalls:${askWalls.map(w=>`$${w.price.toFixed(4)}=$${(w.value/1000).toFixed(0)}K`).join(",")}` : "NoAskWall",
    ].join(" | ")
  };
}

module.exports = { ticker, klines, orderbook, instruments, announcements, fundingRate, getBalances, placeOrder, analyzeOrderbook };
