// ─────────────────────────────────────────────────────────────────────────────
// marketContext.js  V5
// ─────────────────────────────────────────────────────────────────────────────
// PRIMARY signals (every scan, blocking):
//   BTC health from 15m + 4h klines (1min TTL)
//
// SECONDARY signals (cached, non-blocking — degrade gracefully):
//   Fear & Greed     — 15min TTL  — alternative.me (very reliable, free)
//   Coinglass L/S    —  5min TTL  — Coinglass public API (sometimes blocked)
//   Global MCap/Dom  — 10min TTL  — CoinGecko global endpoint
//   Funding rates    —  2min TTL  — Bybit + Binance + OKX (multi-source median)
//
// BTC 1D klines      — 30min TTL  — cached separately, non-fatal
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const bybit = require("./bybit");
const ind   = require("./indicators");

// ── Caches ────────────────────────────────────────────────────────────────────
const C = {
  btc:       { data:null, ts:0, ttl:60_000     }, // 1 min  PRIMARY
  btc1d:     { data:null, ts:0, ttl:30*60_000  }, // 30 min SECONDARY (1D candles)
  fearGreed: { data:null, ts:0, ttl:15*60_000  }, // 15 min SECONDARY
  coinglass: { data:null, ts:0, ttl:5*60_000   }, //  5 min SECONDARY
  globalMcap:{ data:null, ts:0, ttl:10*60_000  }, // 10 min SECONDARY
  funding:   { data:null, ts:0, ttl:2*60_000   }, //  2 min SECONDARY
};
const fresh = k => C[k].data && (Date.now()-C[k].ts) < C[k].ttl;

// ── 1. BTC Health (PRIMARY — runs every scan) ─────────────────────────────────
async function getBTCHealth() {
  if (fresh("btc")) return C.btc.data;
  try {
    const [k15, k4h] = await Promise.all([
      bybit.klines("BTCUSDT","15",80),
      bybit.klines("BTCUSDT","240",60),
    ]);
    const i15 = ind.calcAll(k15);
    const i4h = ind.calcAll(k4h);
    if (!i15) throw new Error("No BTC 15m data");

    let score=50, signals=[];
    if(i15.rsi>45){score+=10;signals.push("BTC_RSI_OK");}
    else if(i15.rsi<40){score-=15;signals.push("BTC_RSI_WEAK");}
    if(i15.macd?.bullish){score+=12;signals.push("BTC_15M_BULL");}
    else{score-=12;signals.push("BTC_15M_BEAR");}
    if(i15.ema9>i15.ema20){score+=10;signals.push("BTC_EMA_BULL");}
    else{score-=10;signals.push("BTC_EMA_BEAR");}
    if(i4h?.macd?.bullish){score+=15;signals.push("BTC_4H_BULL");}
    else if(i4h){score-=15;signals.push("BTC_4H_BEAR");}
    if(i4h?.ema9>i4h?.ema20){score+=8;signals.push("BTC_4H_EMA_BULL");}
    else if(i4h){score-=8;signals.push("BTC_4H_EMA_BEAR");}

    const chg15 = i15.chg1||0;
    if(chg15<-1.5){score-=20;signals.push(`BTC_DUMP_${chg15.toFixed(2)}%`);}
    if(chg15>1.5){score+=8;signals.push(`BTC_PUMP_${chg15.toFixed(2)}%`);}
    score = Math.max(0,Math.min(100,score));

    // Get 1D from separate cache (non-fatal)
    const btc1d = await getBTC1D();
    const trend1d = btc1d?.trend || "UNKNOWN";
    const bearishRegime = trend1d==="BEAR" || score<35;
    const hardBlock = chg15 < -2.0;

    const result = {
      price:i15.price, rsi15:i15.rsi, rsi4h:i4h?.rsi,
      macd15Bull:i15.macd?.bullish, macd4hBull:i4h?.macd?.bullish,
      ema9above20:i15.ema9>i15.ema20, chg15m:chg15,
      trend4h: i4h?(i4h.macd?.bullish?"BULL":"BEAR"):"UNKNOWN",
      trend1d, healthScore:score, signals, bearishRegime, hardBlock,
      allowAltEntries:!hardBlock,
      gateReason: hardBlock?`BTC hard dump ${chg15.toFixed(2)}% this candle`
        : bearishRegime?`BTC bearish regime (score ${score})`:"OK",
    };
    C.btc = { data:result, ts:Date.now(), ttl:C.btc.ttl };
    return result;
  } catch {
    return { allowAltEntries:true, hardBlock:false, bearishRegime:false, gateReason:"BTC check failed", healthScore:50, signals:[], trend4h:"UNKNOWN", trend1d:"UNKNOWN" };
  }
}

// ── BTC 1D klines (SECONDARY — 30min cache, non-fatal) ───────────────────────
async function getBTC1D() {
  if (fresh("btc1d")) return C.btc1d.data;
  try {
    const k1d = await bybit.klinesOpt("BTCUSDT","D",30);
    if (!k1d) { C.btc1d = { data:null, ts:Date.now(), ttl:C.btc1d.ttl }; return null; }
    const i1d = ind.calcAll(k1d);
    if (!i1d) return null;
    const trend = (i1d.macd?.bullish && i1d.ema9>i1d.ema20) ? "BULL"
                : (!i1d.macd?.bullish && i1d.ema9<i1d.ema20) ? "BEAR" : "MIXED";
    const result = { trend, rsi:i1d.rsi, macdBull:i1d.macd?.bullish };
    C.btc1d = { data:result, ts:Date.now(), ttl:C.btc1d.ttl };
    return result;
  } catch {
    C.btc1d = { data:null, ts:Date.now(), ttl:C.btc1d.ttl };
    return null;
  }
}

// ── 2. Fear & Greed (SECONDARY — 15min, alternative.me) ──────────────────────
async function getFearGreed() {
  if (fresh("fearGreed")) return C.fearGreed.data;
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=2",{timeout:6000});
    const d = await r.json();
    const today=d.data?.[0], yest=d.data?.[1];
    const value=parseInt(today?.value||50), change=yest?value-parseInt(yest.value):0;
    const result = {
      value, label:today?.value_classification||"Neutral", change,
      trend:change>3?"IMPROVING":change<-3?"DETERIORATING":"STABLE",
      sentiment:value>=75?"EXTREME_GREED":value>=55?"GREED":value>=45?"NEUTRAL":value>=25?"FEAR":"EXTREME_FEAR",
      entryBias:value<=25?"STRONG_BUY":value<=45?"MILD_BUY":value>=80?"CAUTION":"NEUTRAL",
    };
    C.fearGreed = { data:result, ts:Date.now(), ttl:C.fearGreed.ttl };
    return result;
  } catch {
    return C.fearGreed.data || { value:50, label:"Neutral", sentiment:"NEUTRAL", entryBias:"NEUTRAL", trend:"STABLE" };
  }
}

// ── 3. Coinglass L/S (SECONDARY — 5min, fallback gracefully) ──────────────────
async function getCoinglass() {
  if (fresh("coinglass")) return C.coinglass.data;
  const headers = { Accept:"application/json","User-Agent":"Mozilla/5.0" };
  try {
    const r = await fetch("https://open-api.coinglass.com/public/v2/long_short_account?symbol=BTC&time_type=m15&limit=4",{headers,timeout:7000});
    if (!r.ok) throw new Error();
    const d = await r.json();
    const latest=d.data?.[0];
    const longPct=parseFloat(latest?.longAccount||50);
    const shortPct=parseFloat(latest?.shortAccount||50);
    const ratio=shortPct>0?longPct/shortPct:1;
    const result = { longPct,shortPct,ratio:+ratio.toFixed(3),
      sentiment:ratio>1.5?"OVERCROWDED_LONGS":ratio<0.7?"OVERCROWDED_SHORTS":"BALANCED",
      entryBias:ratio<0.7?"BULLISH":ratio>1.5?"CAUTION":"NEUTRAL",source:"coinglass" };
    C.coinglass = { data:result, ts:Date.now(), ttl:C.coinglass.ttl };
    return result;
  } catch {
    // Silent fallback — return stale or neutral
    return C.coinglass.data || { longPct:50,shortPct:50,ratio:1,sentiment:"BALANCED",entryBias:"NEUTRAL",source:"unavailable" };
  }
}

// ── 4. Multi-source Funding (SECONDARY — 2min) ────────────────────────────────
async function getFunding() {
  if (fresh("funding")) return C.funding.data;
  const results=[];

  await Promise.allSettled([
    // Bybit
    bybit.fundingRate("BTCUSDT").then(d=>{
      const rate=parseFloat(d.list?.[0]?.fundingRate||0);
      if(!isNaN(rate))results.push({source:"Bybit",rate,ratePct:+(rate*100).toFixed(5)});
    }),
    // Binance
    fetch("https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1",{timeout:6000}).then(async r=>{
      if(r.ok){const d=await r.json();const rate=parseFloat(d[0]?.fundingRate||0);if(!isNaN(rate))results.push({source:"Binance",rate,ratePct:+(rate*100).toFixed(5)});}
    }),
    // OKX
    fetch("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP",{timeout:6000}).then(async r=>{
      if(r.ok){const d=await r.json();const rate=parseFloat(d.data?.[0]?.fundingRate||0);if(!isNaN(rate))results.push({source:"OKX",rate,ratePct:+(rate*100).toFixed(5)});}
    }),
  ]);

  if (!results.length) return C.funding.data || { ratePct:0, sentiment:"NEUTRAL_FUNDING", entryBias:"NEUTRAL", sourcesAvailable:0, summary:"unavailable" };

  const sorted = results.map(r=>r.ratePct).sort((a,b)=>a-b);
  const mid = Math.floor(sorted.length/2);
  const avgRatePct = sorted.length%2===0?(sorted[mid-1]+sorted[mid])/2:sorted[mid];
  const sentiment = avgRatePct>0.1?"EXTREME_BULLISH_FUNDING":avgRatePct>0.03?"HIGH_FUNDING":avgRatePct<-0.01?"NEGATIVE_FUNDING":"NEUTRAL_FUNDING";
  const entryBias = avgRatePct>0.1?"CAUTION":avgRatePct<-0.01?"BULLISH":"NEUTRAL";

  const data = { ratePct:+avgRatePct.toFixed(5), sentiment, entryBias,
    sourcesAvailable:results.length,
    summary:results.map(r=>`${r.source}:${r.ratePct>=0?"+":""}${r.ratePct.toFixed(4)}%`).join("|") };
  C.funding = { data, ts:Date.now(), ttl:C.funding.ttl };
  return data;
}

// ── 5. Global MCap (SECONDARY — 10min) ───────────────────────────────────────
async function getGlobal() {
  if (fresh("globalMcap")) return C.globalMcap.data;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/global",{headers:{Accept:"application/json"},timeout:8000});
    const d = (await r.json()).data;
    const mcap=d.total_market_cap?.usd||0, btcDom=d.market_cap_percentage?.btc||50;
    const mcapChg=d.market_cap_change_percentage_24h_usd||0;
    const result = { totalMcapB:+(mcap/1e9).toFixed(0), btcDominance:+btcDom.toFixed(2),
      mcapChange24h:+mcapChg.toFixed(2),
      altSentiment:btcDom>55?"BTC_DOM_HIGH_ALT_RISK":btcDom<42?"ALT_SEASON_POSSIBLE":"NEUTRAL",
      regime:mcapChg>3?"BULL_DAY":mcapChg<-3?"BEAR_DAY":"RANGING_DAY" };
    C.globalMcap = { data:result, ts:Date.now(), ttl:C.globalMcap.ttl };
    return result;
  } catch { return C.globalMcap.data || { totalMcapB:0, btcDominance:50, mcapChange24h:0, altSentiment:"NEUTRAL", regime:"RANGING_DAY" }; }
}

// ── 6. Session ────────────────────────────────────────────────────────────────
function getSession() {
  const t = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  if(t>=1&&t<6)   return{session:"DEAD_ZONE",    sizeMult:0.4,note:"1-6am UTC low liquidity",active:false};
  if(t>=6&&t<8)   return{session:"ASIA_OPEN",    sizeMult:0.7,note:"Asia open moderate volume",active:true};
  if(t>=8&&t<13)  return{session:"LONDON",       sizeMult:1.0,note:"London session good momentum",active:true};
  if(t>=13&&t<16) return{session:"NY_LONDON",    sizeMult:1.0,note:"NY+London overlap peak volume ⭐",active:true};
  if(t>=16&&t<21) return{session:"NY_SESSION",   sizeMult:1.0,note:"NY session good volume",active:true};
  return             {session:"LATE_SESSION",     sizeMult:0.8,note:"Late session moderate caution",active:true};
}

// ── 7. Liquidity gate ─────────────────────────────────────────────────────────
function checkLiquidity(ob, spendUSD, price) {
  if (!ob) return { pass:true, reason:"OB unavailable" };
  if ((ob.spreadPct||0)>0.15) return { pass:false, reason:`Wide spread ${ob.spreadPct?.toFixed(3)}%` };
  const wall=ob.nearestResistance;
  if (wall) { const d=(wall-price)/price*100; if(d>0&&d<0.3) return { pass:false, reason:`Ask wall $${wall.toFixed(4)} ${d.toFixed(3)}% above` }; }
  return { pass:true, reason:"OK" };
}

// ── 8. Kelly sizing ───────────────────────────────────────────────────────────
function kellySize(confidence, sessionMult=1.0) {
  const raw = 70 + ((confidence-75)/20)*30;
  return Math.round(Math.min(100,Math.max(10, Math.min(100,Math.max(10,raw)) * sessionMult)));
}

// ── 9. Full context (called every scan) ──────────────────────────────────────
async function getFullContext() {
  // Primary (must succeed): BTC health
  const btc = await getBTCHealth();

  // Secondary (all parallel, all non-blocking — use stale on failure):
  const [fg, cg, fund, global] = await Promise.all([
    getFearGreed(), getCoinglass(), getFunding(), getGlobal(),
  ]);

  return { btc, fearGreed:fg, coinglass:cg, funding:fund, global, session:getSession(),
    allowEntry:btc.allowAltEntries!==false, bearishMode:btc.bearishRegime===true, gateReason:btc.gateReason||"OK" };
}

// ── 10. Format for Claude prompt ─────────────────────────────────────────────
function formatForPrompt(ctx) {
  if (!ctx) return "Market context unavailable";
  const { btc, fearGreed:fg, coinglass:cg, funding:f, global:g, session:s } = ctx;
  const warn=[];
  if(btc?.hardBlock)         warn.push(`🚫 BTC HARD DUMP ${btc?.chg15m?.toFixed(2)}%`);
  if(ctx?.bearishMode)       warn.push(`⚠️ BEARISH REGIME (1D:${btc?.trend1d}) — tighter rules`);
  if((fg?.value||50)>80)     warn.push(`⚠️ EXTREME GREED ${fg?.value} — reduce size`);
  if((fg?.value||50)<20)     warn.push(`✅ EXTREME FEAR ${fg?.value} — contrarian buy`);
  if((f?.ratePct||0)>0.08)   warn.push(`⚠️ HIGH FUNDING ${f?.ratePct?.toFixed(4)}% avg (${f?.sourcesAvailable} exchanges)`);
  if((cg?.ratio||1)<0.7)     warn.push(`✅ SHORTS CROWDED ratio=${cg?.ratio}`);
  if(g?.regime==="BEAR_DAY") warn.push(`⚠️ BEAR DAY ${g?.mcapChange24h}%`);
  if(s?.session==="DEAD_ZONE")warn.push(`⚠️ DEAD ZONE — thin liquidity`);
  return [
    `━━ MACRO MARKET CONTEXT ━━`,
    `BTC: score=${btc?.healthScore||"?"}/100 | 4H=${btc?.trend4h||"?"} | 1D=${btc?.trend1d||"?"} | 15m=${btc?.chg15m?.toFixed(2)||"?"}% | gate=${ctx?.allowEntry?"✅":"🚫"}`,
    `F&G: ${fg?.value||"?"}/100 (${fg?.label||"?"}) | ${fg?.trend||"?"} | bias=${fg?.entryBias||"?"}`,
    `L/S: ${cg?.longPct?.toFixed(1)||"?"}%L / ${cg?.shortPct?.toFixed(1)||"?"}%S | ratio=${cg?.ratio||"?"} | ${cg?.sentiment||"?"}`,
    `Funding: avg=${f?.ratePct?.toFixed(4)||"?"}%/8h | ${f?.sourcesAvailable||0} sources: ${f?.summary||"—"}`,
    `Global: $${g?.totalMcapB||"?"}B | BTC dom=${g?.btcDominance||"?"}% | 24h=${g?.mcapChange24h||"?"}% | ${g?.regime||"?"}`,
    `Session: ${s?.session||"?"} | size×${s?.sizeMult||1} | ${s?.note||""}`,
    warn.length ? "\n"+warn.join("\n") : "",
  ].join("\n");
}

module.exports = { getBTCHealth, getBTC1D, getFearGreed, getCoinglass, getFunding, getGlobal, getSession, checkLiquidity, kellySize, getFullContext, formatForPrompt };
