// ─────────────────────────────────────────────────────────────────────────────
// bybit.js  V5
// Changes: safeJson (HTML detection), fallback domain api.bytick.com,
//          klinesOpt (non-fatal), tickers24h for volume fallback
// ─────────────────────────────────────────────────────────────────────────────
const fetch  = require("node-fetch");
const crypto = require("crypto");

// Primary → fallback domain (same Bybit API, different CDN)
const DOMAINS = ["https://api.bybit.com", "https://api.bytick.com"];

function sign(key, secret, ts, str) {
  return crypto.createHmac("sha256", secret).update(ts + key + "5000" + str).digest("hex");
}

// Detect HTML error pages (geo-block / rate-limit responses)
async function safeJson(r) {
  const text = await r.text();
  if (text.trimStart().startsWith("<"))
    throw new Error(`Bybit returned HTML (${r.status}) — likely IP rate-limited`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Bybit invalid JSON: ${text.slice(0,60)}`); }
}

async function call(method, path, params={}, auth=false) {
  const key = process.env.BYBIT_API_KEY;
  const sec = process.env.BYBIT_API_SECRET;
  const ts  = Date.now().toString();
  let body;

  const headers = {
    "Content-Type": "application/json",
    "Accept":        "application/json",
    "User-Agent":    "Mozilla/5.0 (compatible; BybitBot/5.0)",
  };

  if (auth) {
    if (!key || !sec) throw new Error("Bybit API keys missing in .env");
    Object.assign(headers, { "X-BAPI-API-KEY":key, "X-BAPI-TIMESTAMP":ts, "X-BAPI-RECV-WINDOW":"5000" });
  }

  let lastErr;
  for (const base of DOMAINS) {
    let url = base + path;
    if (method === "GET") {
      const qs = new URLSearchParams(params).toString();
      if (auth) headers["X-BAPI-SIGN"] = sign(key, sec, ts, qs);
      if (qs) url += "?" + qs;
    } else {
      body = JSON.stringify(params);
      if (auth) headers["X-BAPI-SIGN"] = sign(key, sec, ts, body);
    }
    try {
      const r = await fetch(url, { method, headers, body, timeout:10000 });
      const d = await safeJson(r);
      if (d.retCode !== undefined && d.retCode !== 0)
        throw new Error(`Bybit ${d.retCode}: ${d.retMsg}`);
      return d.result ?? d;
    } catch(e) {
      lastErr = e;
      // Only try fallback domain for HTML/network errors, not auth errors
      if (e.message.includes("HTML") || e.message.includes("ECONNRESET") || e.message.includes("timeout")) continue;
      throw e;
    }
  }
  throw lastErr;
}

// ── Market data ───────────────────────────────────────────────────────────────
const ticker       = (s) => call("GET", "/v5/market/tickers", { category:"spot", symbol:s });
const klines       = (s,i="15",l=80) => call("GET", "/v5/market/kline", { category:"spot", symbol:s, interval:i, limit:l });
// klinesOpt — returns null instead of throwing (for optional TFs like 1D)
const klinesOpt    = async (s,i,l) => { try { return await klines(s,i,l); } catch { return null; } };
const instruments  = () => call("GET", "/v5/market/instruments-info", { category:"spot", limit:500 });
const announcements= () => call("GET", "/v5/announcements/index", { locale:"en-US", page:1, limit:30 }).catch(()=>({list:[]}));
const orderbook    = (s,d=50) => call("GET", "/v5/market/orderbook", { category:"spot", symbol:s, limit:d });
const fundingRate  = (s="BTCUSDT") => call("GET", "/v5/market/funding/history", { category:"linear", symbol:s, limit:2 }).catch(()=>({list:[]}));
// All 24h tickers — used as Bybit-native volume ranking fallback
const tickers24h   = () => call("GET", "/v5/market/tickers", { category:"spot" });

// ── Account ───────────────────────────────────────────────────────────────────
async function getBalances() {
  const d = await call("GET", "/v5/account/wallet-balance", { accountType:"UNIFIED" }, true);
  const coins = d.list?.[0]?.coin || [];
  return {
    usdtBal:  parseFloat(coins.find(c=>c.coin==="USDT")?.walletBalance || 0),
    totalUSD: parseFloat(d.list?.[0]?.totalEquity || 0),
    coins:    coins.filter(c => parseFloat(c.walletBalance) > 0),
  };
}

async function placeOrder(symbol, side, qty) {
  return call("POST", "/v5/order/create", {
    category:"spot", symbol, side, orderType:"Market",
    qty: qty.toString(), timeInForce:"IOC",
  }, true);
}

// ── Order book analysis ───────────────────────────────────────────────────────
function analyzeOrderbook(raw, currentPrice) {
  if (!raw?.b || !raw?.a) return null;
  const parse = side => side.map(([p,q]) => ({ price:parseFloat(p), qty:parseFloat(q), value:parseFloat(p)*parseFloat(q) }));
  const bids = parse(raw.b), asks = parse(raw.a);
  if (!bids.length || !asks.length) return null;
  const avgBid = bids.reduce((s,b)=>s+b.value,0)/bids.length;
  const avgAsk = asks.reduce((s,a)=>s+a.value,0)/asks.length;
  const bidWalls = bids.filter(b=>b.value>=avgBid*3&&b.price<currentPrice).sort((a,b)=>b.value-a.value).slice(0,3);
  const askWalls = asks.filter(a=>a.value>=avgAsk*3&&a.price>currentPrice).sort((a,b)=>b.value-a.value).slice(0,3);
  const bidPressure = bids.slice(0,10).reduce((s,b)=>s+b.value,0);
  const askPressure = asks.slice(0,10).reduce((s,a)=>s+a.value,0);
  const imbalance   = askPressure>0 ? bidPressure/askPressure : 1;
  const bestBid=bids[0]?.price||0, bestAsk=asks[0]?.price||0;
  const spreadPct = bestBid>0 ? (bestAsk-bestBid)/bestBid*100 : 0;
  const lbl = imbalance>1.25?"BID_DOM":imbalance<0.80?"ASK_DOM":"BALANCED";
  return {
    bidWalls, askWalls, imbalance:+imbalance.toFixed(3), imbalanceLabel:lbl,
    spreadPct:+spreadPct.toFixed(5),
    nearestSupport:    bidWalls[0]?.price||null,
    nearestResistance: askWalls[0]?.price||null,
    bullish:imbalance>1.25, bearish:imbalance<0.80,
    summary:[`Imbalance:${imbalance.toFixed(2)}x(${lbl})`,`Spread:${spreadPct.toFixed(4)}%`,
      bidWalls.length?`BidWalls:${bidWalls.map(w=>`$${w.price.toFixed(4)}=$${(w.value/1000).toFixed(0)}K`).join(",")}`:"NoBidWall",
      askWalls.length?`AskWalls:${askWalls.map(w=>`$${w.price.toFixed(4)}=$${(w.value/1000).toFixed(0)}K`).join(",")}`:"NoAskWall",
    ].join(" | "),
  };
}

module.exports = { ticker, klines, klinesOpt, orderbook, instruments, announcements, fundingRate, tickers24h, getBalances, placeOrder, analyzeOrderbook };
