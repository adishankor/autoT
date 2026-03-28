// ─────────────────────────────────────────────────────────────────────────────
// announcements.js  V5
// Key change: TTL set to 4 HOURS (not 5 min). Announcements don't change
// rapidly — checking every 4h saves Bybit/Binance API calls and is sufficient.
// NO Claude API used here — pure keyword scoring.
// High-score announcements (score >= 40, e.g. new listing) are cached and
// passed to Claude as context on next decision call.
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const bybit = require("./bybit");

const TTL  = 4 * 60 * 60 * 1000;  // 4 hours — announcements don't change hourly
const seen = new Set();
let cache  = { all:[], ts:0, lastSource:"none" };

async function fetchBybit() {
  try {
    const d = await bybit.announcements();
    return (d.list||[]).map(a => ({
      source: "Bybit",
      title:  a.title || "",
      description: a.description || "",
      date:   a.dateTimestamp ? new Date(a.dateTimestamp).toISOString() : new Date().toISOString(),
    }));
  } catch { return []; }
}

async function fetchBinance() {
  // Try JSON endpoint first
  try {
    const r = await fetch(
      "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20",
      { headers:{ Accept:"application/json","User-Agent":"Mozilla/5.0" }, timeout:8000 }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const arts = d.data?.catalogs?.flatMap(c=>c.articles||[]) || [];
    return arts.map(a => ({
      source:"Binance", title:a.title||"",
      description:(a.body||"").slice(0,200),
      date: a.releaseDate ? new Date(a.releaseDate).toISOString() : new Date().toISOString(),
    }));
  } catch {}
  // Fallback: RSS feed
  try {
    const r = await fetch("https://www.binance.com/en/support/announcement/c-48?format=rss",
      { headers:{"User-Agent":"Mozilla/5.0"}, timeout:6000 });
    const xml = await r.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,15).map(m => {
      const t = m[1];
      const title = (t.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     t.match(/<title>(.*?)<\/title>/) || [])[1] || "";
      return { source:"Binance", title, description:"", date:new Date().toISOString() };
    });
  } catch { return []; }
}

// Keyword scoring — no Claude API needed
function scoreAnn(ann) {
  const tx = (ann.title + " " + ann.description).toLowerCase();
  let score=0, signals=[];
  if(/new listing|will list\b|lists\b/.test(tx))           { score+=40; signals.push("NEW_LISTING"); }
  if(/launchpad|launchpool/.test(tx))                       { score+=35; signals.push("LAUNCHPAD"); }
  if(/spot trading.*open|now available for trading/.test(tx)){ score+=30; signals.push("TRADING_OPEN"); }
  if(/airdrop/.test(tx))                                    { score+=20; signals.push("AIRDROP"); }
  if(/staking|earn|yield/.test(tx))                         { score+=12; signals.push("STAKING"); }
  if(/partnership|integration/.test(tx))                    { score+=10; signals.push("PARTNERSHIP"); }
  if(/promotion|bonus|reward/.test(tx))                     { score+=8;  signals.push("PROMO"); }
  if(/upgrade|mainnet/.test(tx))                            { score+=8;  signals.push("UPGRADE"); }
  if(/delist|suspend|halt/.test(tx))                        { score-=50; signals.push("DELIST_WARNING"); }
  if(/investigation|risk warning/.test(tx))                 { score-=30; signals.push("RISK_FLAG"); }
  return { score, signals };
}

function extractCoins(text, knownSymbols=[]) {
  const tokens = [...text.matchAll(/\b([A-Z]{2,8})\b/g)].map(m=>m[1]);
  return [...new Set(tokens
    .map(t => t+"USDT")
    .filter(s => knownSymbols.length===0 || knownSymbols.includes(s))
  )];
}

// ── Main: fetch all announcements (4h TTL) ────────────────────────────────────
async function getAll(knownSymbols=[]) {
  if (Date.now()-cache.ts < TTL && cache.all.length) return cache.all;

  const [bb, bn] = await Promise.all([ fetchBybit(), fetchBinance() ]);
  const sources = bb.length > 0 ? (bn.length > 0 ? "Bybit+Binance" : "Bybit") : (bn.length > 0 ? "Binance" : "none");

  const all = [...bb, ...bn].map(a => {
    const { score, signals } = scoreAnn(a);
    const coins  = extractCoins(a.title+" "+a.description, knownSymbols);
    const isNew  = !seen.has(a.title);
    if (isNew) seen.add(a.title);
    return { ...a, score, signals, coins, isNew };
  }).sort((a,b) => b.score-a.score);

  cache = { all, ts:Date.now(), lastSource:sources };
  return all;
}

async function forCoin(symbol, knownSymbols=[]) {
  const all  = await getAll(knownSymbols);
  const coin = symbol.replace("USDT","");
  return all.filter(a =>
    a.coins.includes(symbol) ||
    a.title.toUpperCase().includes(coin) ||
    a.description.toUpperCase().includes(coin)
  );
}

// How long until next refresh
function nextRefreshMs() { return Math.max(0, TTL - (Date.now()-cache.ts)); }
function lastFetchAge()  { return cache.ts ? Math.round((Date.now()-cache.ts)/60000) : null; }

module.exports = { getAll, forCoin, nextRefreshMs, lastFetchAge };
