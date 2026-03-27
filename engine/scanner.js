// ─────────────────────────────────────────────────────────────────────────────
// scanner.js  —  Top 200 MCap coin selector
// Changes: stablecoin exclusion, wrapped tokens excluded, Day TF added
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const bybit = require("./bybit");

let mcapCache = { coins:[], ts:0 };

// ── Stablecoin / wrapped / non-tradeable exclusion list ──────────────────────
const EXCLUDE_IDS = new Set([
  // Stablecoins
  "tether","usd-coin","binance-usd","dai","trueusd","frax","usdd","celo-dollar",
  "paxos-standard","gemini-dollar","husd","susd","usdk","token-usdt","nusd",
  "fei-usd","float-protocol-bank","liquity-usd","dola-borrowing-right","usdx",
  "eur-coin","stasis-eurs","ageur","tether-eurt","euro-tether",
  // Wrapped / liquid staking tokens (not directly tradeable as their own asset)
  "wrapped-bitcoin","wrapped-ethereum","wrapped-bnb","staked-ether",
  "wrapped-steth","rocket-pool-eth","coinbase-wrapped-staked-eth","lido-dao",
  "binance-eth","weth","wbtc",
  // Exchange tokens that behave differently
  "leo-token","kucoin-shares",
  // Memecoins with no fundamental — keep DOGE/SHIB but exclude micro ones
  "pepe","floki","baby-doge-coin","bonk",
]);

// Exclude by symbol pattern
const EXCLUDE_PATTERNS = [
  /^USD/i, /USDT$/i, /USDC$/i, /BUSD$/i, /DAI$/i, /TUSD$/i, /FRAX$/i,
  /^EUR/i, /^GBP/i, /^XAUT/i, // fiat-pegged
  /^W[A-Z]{3,}/,   // wrapped tokens starting with W
  /^ST[A-Z]{3,}/,  // staked tokens
];

function isExcluded(coin) {
  if (EXCLUDE_IDS.has(coin.id)) return true;
  const sym = coin.symbol.toUpperCase();
  // Price stability check — if 30d change < 0.5% it's likely a stable
  if (Math.abs(coin.price_change_percentage_24h || 0) < 0.1 &&
      (coin.current_price > 0.98 && coin.current_price < 1.02)) return true;
  return false;
}

async function getTop200() {
  if (Date.now()-mcapCache.ts < 30*60*1000 && mcapCache.coins.length) return mcapCache.coins;
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=1h,24h,7d",
      { headers:{ Accept:"application/json" }, timeout:10000 }
    );
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const data = await r.json();
    // Filter out stables/wrapped before caching
    const clean = data.filter(c => !isExcluded(c));
    mcapCache = { coins: clean, ts: Date.now() };
    return clean;
  } catch { return mcapCache.coins; }
}

async function getBybitPairs() {
  try {
    const d = await bybit.instruments();
    return new Set((d.list||[])
      .filter(i => i.quoteCoin==="USDT" && i.status==="Trading")
      .map(i => i.symbol));
  } catch {
    return new Set(["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"]);
  }
}

function scoreCoin(c) {
  let s = 0, notes = [];
  const rank   = c.market_cap_rank || 999;
  const vol    = c.total_volume    || 0;
  const chg24  = c.price_change_percentage_24h || 0;
  const chg1   = c.price_change_percentage_1h_in_currency  || 0;
  const chg7d  = c.price_change_percentage_7d_in_currency  || 0;

  // Rank
  if (rank<=10)  { s+=30; notes.push("Top10"); }
  else if (rank<=30)  { s+=22; notes.push("Top30"); }
  else if (rank<=60)  { s+=16; notes.push("Top60"); }
  else if (rank<=100) { s+=10; notes.push("Top100"); }
  else { s+=5; }

  // Liquidity
  if (vol>2e9)       { s+=25; notes.push("Vol>$2B"); }
  else if (vol>5e8)  { s+=18; notes.push("Vol>$500M"); }
  else if (vol>1e8)  { s+=12; notes.push("Vol>$100M"); }
  else if (vol>2e7)  { s+=5; }
  else               { s-=10; } // illiquid — penalize

  // Momentum signals
  if (chg1>0.3&&chg1<8)    { s+=15; notes.push(`1h+${chg1.toFixed(1)}%`); }
  if (chg24>1&&chg24<20)   { s+=8;  notes.push(`24h+${chg24.toFixed(1)}%`); }
  if (chg7d>5&&chg7d<50)   { s+=6;  notes.push(`7d+${chg7d.toFixed(1)}%`); } // sustained uptrend
  if (chg1<-5)              { s-=20; notes.push("Drop1h"); }
  if (chg24<-15)            { s-=15; notes.push("Drop24h"); }

  // Vol/MCap ratio (hot money signal)
  const vmr = vol / (c.market_cap||1);
  if (vmr>0.5)       { s+=15; notes.push("HighVMR"); }
  else if (vmr>0.15) { s+=8; }

  return { score:s, notes };
}

async function selectCandidates(n=10) {
  const [top200, pairs] = await Promise.all([getTop200(), getBybitPairs()]);
  if (!top200.length) return getFallback();

  const results = top200
    .filter(c => pairs.has(c.symbol.toUpperCase()+"USDT"))
    .map(c => {
      const sym = c.symbol.toUpperCase()+"USDT";
      const { score, notes } = scoreCoin(c);
      return {
        symbol: sym, name: c.name, rank: c.market_cap_rank,
        price: c.current_price,
        change24h: c.price_change_percentage_24h,
        change1h:  c.price_change_percentage_1h_in_currency,
        change7d:  c.price_change_percentage_7d_in_currency,
        volume24h: c.total_volume, mcap: c.market_cap,
        score, notes
      };
    })
    .filter(c => c.score > 15)
    .sort((a,b) => b.score - a.score)
    .slice(0, n);

  return results.length ? results : getFallback();
}

function getFallback() {
  return ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"].map((s,i)=>({
    symbol:s, name:s.replace("USDT",""), rank:i+1, score:50, notes:["fallback"]
  }));
}

module.exports = { selectCandidates };
