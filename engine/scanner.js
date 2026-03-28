// ─────────────────────────────────────────────────────────────────────────────
// scanner.js  V5
// Primary source:   CoinGecko top 250 (30min cache)
// Fallback source:  Bybit 24h tickers sorted by USD turnover
// Hardcoded fallback: 20 high-quality coins if both fail
// Stablecoins/wrapped tokens excluded
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const bybit = require("./bybit");

let cgCache    = { coins:[], ts:0 };   // CoinGecko cache
let bybitCache = { coins:[], ts:0 };   // Bybit volume fallback cache

const STABLE_IDS = new Set([
  "tether","usd-coin","binance-usd","dai","trueusd","frax","usdd","fdusd",
  "paxos-standard","gemini-dollar","husd","susd","nusd","dola-borrowing-right",
  "liquity-usd","fei-usd","terrausd","stasis-eurs","ageur","tether-eurt",
  "euro-tether","eur-coin","wrapped-bitcoin","wrapped-ethereum","wrapped-bnb",
  "staked-ether","wrapped-steth","rocket-pool-eth","coinbase-wrapped-staked-eth",
  "weth","wbtc","leo-token","binance-eth",
]);

// Stable by symbol (base token before USDT)
const STABLE_BASES = new Set(["USDC","BUSD","DAI","TUSD","FRAX","FDUSD","USDP","USDD",
  "SUSD","HUSD","USDX","GUSD","WBTC","WETH","WBNB","STETH","CBETH","RETH",
  "BETH","BBTC","BTCB","EUR","GBP","XAUT","PAXG"]);

function isStableId(id) { return STABLE_IDS.has(id); }
function isStableSymbol(sym) {
  const base = sym.replace(/USDT$|USDC$/,"");
  if (STABLE_BASES.has(base)) return true;
  // Price near $1 with tiny volatility = likely stable
  return false;
}

// ── Primary: CoinGecko ────────────────────────────────────────────────────────
async function fromCoinGecko() {
  if (Date.now()-cgCache.ts < 30*60*1000 && cgCache.coins.length) return cgCache.coins;
  const r = await fetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=1h,24h,7d",
    { headers:{ Accept:"application/json","User-Agent":"Mozilla/5.0" }, timeout:12000 }
  );
  if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
  const data = await r.json();
  const clean = data.filter(c => !isStableId(c.id) && !isStableSymbol(c.symbol.toUpperCase()));
  cgCache = { coins:clean, ts:Date.now() };
  return clean;
}

// ── Fallback: Bybit 24h tickers ranked by USD turnover ────────────────────────
async function fromBybitVolume(n=20) {
  if (Date.now()-bybitCache.ts < 10*60*1000 && bybitCache.coins.length) return bybitCache.coins;
  const d   = await bybit.tickers24h();
  const all = (d.list||[])
    .filter(t => t.symbol.endsWith("USDT") && !isStableSymbol(t.symbol))
    .map(t => ({
      symbol:    t.symbol,
      name:      t.symbol.replace("USDT",""),
      price:     parseFloat(t.lastPrice||0),
      change24h: parseFloat(t.price24hPcnt||0)*100,
      change1h:  0,
      volume24h: parseFloat(t.turnover24h||0),
      mcap:      0,
      rank:      null,
      score:     0,
      notes:     ["bybit_vol_ranked"],
    }))
    .filter(t => t.volume24h > 2_000_000)  // min $2M daily volume
    .sort((a,b) => b.volume24h - a.volume24h);
  // Assign ranks and scores based on volume
  all.forEach((c,i) => {
    c.rank  = i+1;
    c.score = Math.max(15, 80 - i*4);
  });
  const top = all.slice(0, n);
  bybitCache = { coins:top, ts:Date.now() };
  return top;
}

// ── Hardcoded fallback (if both APIs fail) ────────────────────────────────────
const FALLBACK_20 = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  "MATICUSDT","LTCUSDT","UNIUSDT","ATOMUSDT","NEARUSDT",
  "APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT",
];
function getFallback() {
  return FALLBACK_20.map((s,i) => ({
    symbol:s, name:s.replace("USDT",""), rank:i+1, price:0,
    change24h:0, change1h:0, volume24h:0, mcap:0,
    score:Math.max(10,80-i*3), notes:["hardcoded_fallback"],
  }));
}

// ── Score a CoinGecko coin for trading potential ──────────────────────────────
function scoreCG(c) {
  let s=0, notes=[];
  const rank=c.market_cap_rank||999, vol=c.total_volume||0;
  const chg24=c.price_change_percentage_24h||0;
  const chg1=c.price_change_percentage_1h_in_currency||0;
  const chg7=c.price_change_percentage_7d_in_currency||0;
  if(rank<=10){s+=30;notes.push("Top10");}
  else if(rank<=30){s+=22;notes.push("Top30");}
  else if(rank<=60){s+=16;notes.push("Top60");}
  else if(rank<=100){s+=10;notes.push("Top100");}
  else s+=5;
  if(vol>2e9){s+=25;notes.push("Vol>$2B");}
  else if(vol>5e8){s+=18;notes.push("Vol>$500M");}
  else if(vol>1e8){s+=12;notes.push("Vol>$100M");}
  else if(vol>2e7){s+=5;} else s-=10;
  if(chg1>0.3&&chg1<8){s+=15;notes.push(`1h+${chg1.toFixed(1)}%`);}
  if(chg24>1&&chg24<20){s+=8;notes.push(`24h+${chg24.toFixed(1)}%`);}
  if(chg7>5&&chg7<50){s+=6;notes.push(`7d+${chg7.toFixed(1)}%`);}
  if(chg1<-5){s-=20;notes.push("Drop1h");}
  if(chg24<-15){s-=15;notes.push("Drop24h");}
  const vmr=vol/(c.market_cap||1);
  if(vmr>0.5){s+=15;notes.push("HighVMR");}
  else if(vmr>0.15)s+=8;
  return{score:s,notes};
}

async function getBybitPairs() {
  try {
    const d = await bybit.instruments();
    return new Set((d.list||[]).filter(i=>i.quoteCoin==="USDT"&&i.status==="Trading").map(i=>i.symbol));
  } catch { return new Set(FALLBACK_20); }
}

// ── Main selector ─────────────────────────────────────────────────────────────
async function selectCandidates(n=10) {
  const pairs = await getBybitPairs();

  // Try CoinGecko first
  let useSource = "coingecko";
  let candidates = [];
  try {
    const cg = await fromCoinGecko();
    candidates = cg
      .filter(c => pairs.has(c.symbol.toUpperCase()+"USDT"))
      .map(c => {
        const sym = c.symbol.toUpperCase()+"USDT";
        const { score, notes } = scoreCG(c);
        return { symbol:sym, name:c.name, rank:c.market_cap_rank,
          price:c.current_price, change24h:c.price_change_percentage_24h,
          change1h:c.price_change_percentage_1h_in_currency||0,
          change7d:c.price_change_percentage_7d_in_currency||0,
          volume24h:c.total_volume, mcap:c.market_cap, score, notes };
      })
      .filter(c => c.score > 15)
      .sort((a,b) => b.score-a.score)
      .slice(0, n);
  } catch(e) {
    console.log(`[Scanner] CoinGecko failed (${e.message}) — using Bybit volume fallback`);
    useSource = "bybit_volume";
  }

  // CoinGecko failed or returned too few — try Bybit volume fallback
  if (candidates.length < 5) {
    try {
      const bv = await fromBybitVolume(n);
      const filtered = bv.filter(c => pairs.has(c.symbol));
      if (filtered.length >= 3) {
        candidates = filtered.slice(0, n);
        useSource = "bybit_volume";
      }
    } catch(e) {
      console.log(`[Scanner] Bybit volume fallback failed (${e.message}) — using hardcoded list`);
    }
  }

  // Both failed — hardcoded list
  if (candidates.length < 3) {
    candidates = getFallback().filter(c => pairs.has(c.symbol)).slice(0, n);
    useSource = "hardcoded";
  }

  console.log(`[Scanner] ${candidates.length} candidates (source: ${useSource}): ${candidates.map(c=>c.symbol).join(", ")}`);
  return candidates;
}

module.exports = { selectCandidates };
