// ─────────────────────────────────────────────────────────────────────────────
// marketContext.js  v4
// Changes:
//   • Multi-source funding rates (Bybit + Binance + OKX via Coinglass)
//   • Day (1D) timeframe added to BTC health analysis
//   • Bearish regime: don't block trades, but require stronger signals + smaller size
//   • Kelly sizing, session filter, liquidity gate unchanged
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require("node-fetch");
const bybit = require("./bybit");
const ind   = require("./indicators");

const CACHE = {
  btc:        { data:null, ts:0, ttl:60_000    }, // 1 min
  fearGreed:  { data:null, ts:0, ttl:900_000   }, // 15 min
  coinglass:  { data:null, ts:0, ttl:300_000   }, // 5 min
  globalMcap: { data:null, ts:0, ttl:600_000   }, // 10 min
  funding:    { data:null, ts:0, ttl:120_000   }, // 2 min
};

const fresh = (k) => CACHE[k].data && (Date.now()-CACHE[k].ts) < CACHE[k].ttl;

// ── 1. BTC Health — now includes 1D timeframe ─────────────────────────────────
async function getBTCHealth() {
  if (fresh("btc")) return CACHE.btc.data;
  try {
    const [k15, k4h, k1d] = await Promise.all([
      bybit.klines("BTCUSDT","15",80),
      bybit.klines("BTCUSDT","240",60),
      bybit.klines("BTCUSDT","D",30),   // Daily candles
    ]);
    const i15 = ind.calcAll(k15);
    const i4h  = ind.calcAll(k4h);
    const i1d  = ind.calcAll(k1d);
    if (!i15) throw new Error("No BTC 15m data");

    let healthScore = 50;
    const signals = [];

    // 15m signals
    if (i15.rsi > 45)       { healthScore+=10; signals.push("BTC_RSI_OK"); }
    else if (i15.rsi < 40)  { healthScore-=15; signals.push("BTC_RSI_WEAK"); }
    if (i15.macd?.bullish)  { healthScore+=12; signals.push("BTC_15M_BULL"); }
    else                    { healthScore-=12; signals.push("BTC_15M_BEAR"); }
    if (i15.ema9 > i15.ema20) { healthScore+=10; signals.push("BTC_EMA_BULL"); }
    else                      { healthScore-=10; signals.push("BTC_EMA_BEAR"); }

    // 4h signals
    if (i4h?.macd?.bullish)          { healthScore+=15; signals.push("BTC_4H_BULL"); }
    else if (i4h)                    { healthScore-=15; signals.push("BTC_4H_BEAR"); }
    if (i4h?.ema9 > i4h?.ema20)      { healthScore+=8;  signals.push("BTC_4H_EMA_BULL"); }
    else if (i4h)                    { healthScore-=8;  signals.push("BTC_4H_EMA_BEAR"); }

    // 1D signals — most important for regime
    let trend1d = "UNKNOWN";
    if (i1d) {
      if (i1d.macd?.bullish && i1d.ema9 > i1d.ema20) {
        trend1d = "BULL"; healthScore+=15; signals.push("BTC_1D_BULL");
      } else if (!i1d.macd?.bullish && i1d.ema9 < i1d.ema20) {
        trend1d = "BEAR"; healthScore-=15; signals.push("BTC_1D_BEAR");
      } else {
        trend1d = "MIXED"; healthScore+=0; signals.push("BTC_1D_MIXED");
      }
      if (i1d.rsi > 55)       { healthScore+=8; signals.push("BTC_1D_RSI_BULL"); }
      else if (i1d.rsi < 40)  { healthScore-=8; signals.push("BTC_1D_RSI_BEAR"); }
    }

    // Short-term dump
    const btcChg15 = i15.chg1 || 0;
    if (btcChg15 < -1.5) { healthScore-=20; signals.push(`BTC_DUMP_${btcChg15.toFixed(2)}%`); }
    if (btcChg15 > 1.5)  { healthScore+=8;  signals.push(`BTC_PUMP_${btcChg15.toFixed(2)}%`); }

    healthScore = Math.max(0, Math.min(100, healthScore));

    // ── Bearish regime: don't hard block, but flag for size/confidence adjustment
    // Only hard block on severe short-term dump (>2% in 15m)
    const hardBlock = btcChg15 < -2.0;
    const bearishRegime = trend1d === "BEAR" || healthScore < 35;
    const allowAltEntries = !hardBlock; // never block on regime alone — only on hard dump

    const result = {
      price:        i15.price,
      rsi15:        i15.rsi,
      rsi4h:        i4h?.rsi,
      rsi1d:        i1d?.rsi,
      macd15Bull:   i15.macd?.bullish,
      macd4hBull:   i4h?.macd?.bullish,
      macd1dBull:   i1d?.macd?.bullish,
      ema9above20:  i15.ema9 > i15.ema20,
      chg15m:       btcChg15,
      trend4h:      i4h ? (i4h.macd?.bullish ? "BULL":"BEAR") : "UNKNOWN",
      trend1d,
      healthScore,
      signals,
      bearishRegime,  // true = bearish but still allow trades (tighter rules)
      hardBlock,      // true = hard BTC dump — block ALL entries this scan
      allowAltEntries,
      gateReason: hardBlock
        ? `BTC hard dump ${btcChg15.toFixed(2)}% this candle`
        : bearishRegime
        ? `BTC bearish regime (score ${healthScore}) — tighter rules apply`
        : "OK",
    };
    CACHE.btc = { data:result, ts:Date.now(), ttl:CACHE.btc.ttl };
    return result;
  } catch(e) {
    return { allowAltEntries:true, hardBlock:false, bearishRegime:false, gateReason:"BTC check failed — permissive", healthScore:50, signals:[], trend4h:"UNKNOWN", trend1d:"UNKNOWN" };
  }
}

// ── 2. Fear & Greed ───────────────────────────────────────────────────────────
async function getFearGreed() {
  if (fresh("fearGreed")) return CACHE.fearGreed.data;
  try {
    const r = await fetch("https://api.alternative.me/fng/?limit=2", { timeout:6000 });
    const d = await r.json();
    const today = d.data?.[0], yesterday = d.data?.[1];
    const value  = parseInt(today?.value||50);
    const change = yesterday ? value - parseInt(yesterday.value) : 0;
    const result = {
      value, label:today?.value_classification||"Neutral", change,
      trend:     change>3?"IMPROVING":change<-3?"DETERIORATING":"STABLE",
      sentiment: value>=75?"EXTREME_GREED":value>=55?"GREED":value>=45?"NEUTRAL":value>=25?"FEAR":"EXTREME_FEAR",
      entryBias: value<=25?"STRONG_BUY":value<=45?"MILD_BUY":value>=80?"CAUTION":"NEUTRAL",
    };
    CACHE.fearGreed = { data:result, ts:Date.now(), ttl:CACHE.fearGreed.ttl };
    return result;
  } catch {
    return { value:50, label:"Neutral", sentiment:"NEUTRAL", entryBias:"NEUTRAL", trend:"STABLE" };
  }
}

// ── 3. Coinglass long/short ───────────────────────────────────────────────────
async function getCoinglassData() {
  if (fresh("coinglass")) return CACHE.coinglass.data;
  try {
    const headers = { Accept:"application/json", "User-Agent":"Mozilla/5.0" };
    const r = await fetch("https://open-api.coinglass.com/public/v2/long_short_account?symbol=BTC&time_type=m15&limit=4", { headers, timeout:7000 });
    if (!r.ok) throw new Error();
    const d = await r.json();
    const latest = d.data?.[0];
    const longPct  = parseFloat(latest?.longAccount||50);
    const shortPct = parseFloat(latest?.shortAccount||50);
    const ratio    = shortPct>0 ? longPct/shortPct : 1;
    const result = {
      longPct, shortPct, ratio:+ratio.toFixed(3),
      sentiment: ratio>1.5?"OVERCROWDED_LONGS":ratio<0.7?"OVERCROWDED_SHORTS":"BALANCED",
      entryBias: ratio<0.7?"BULLISH":ratio>1.5?"CAUTION":"NEUTRAL",
      source:"coinglass",
    };
    CACHE.coinglass = { data:result, ts:Date.now(), ttl:CACHE.coinglass.ttl };
    return result;
  } catch {
    try {
      const r2 = await fetch("https://fapi.coinglass.com/api/futures/globalLongShortAccountRatio?symbol=BTCUSDT&period=15m&limit=2", { headers:{ Accept:"application/json" }, timeout:5000 });
      const d2 = await r2.json();
      const item = d2.data?.[0];
      const ratio = parseFloat(item?.longShortRatio||1);
      const longPct = ratio/(1+ratio)*100;
      return { longPct, shortPct:100-longPct, ratio, sentiment:"BALANCED", entryBias:"NEUTRAL", source:"coinglass_alt" };
    } catch {
      return { longPct:50, shortPct:50, ratio:1, sentiment:"BALANCED", entryBias:"NEUTRAL", source:"unavailable" };
    }
  }
}

// ── 4. MULTI-SOURCE FUNDING RATES ─────────────────────────────────────────────
// Aggregates from Bybit, Binance, OKX (via Coinglass) and averages them
// Much more reliable than single-exchange rate
async function getFundingRates() {
  if (fresh("funding")) return CACHE.funding.data;

  const results = [];
  const errors  = [];

  // Source 1: Bybit (direct)
  try {
    const d = await bybit.fundingRate("BTCUSDT");
    const rate = parseFloat(d.list?.[0]?.fundingRate||0);
    if (!isNaN(rate)) results.push({ source:"Bybit", rate, ratePct:+(rate*100).toFixed(5) });
  } catch(e) { errors.push("Bybit:"+e.message); }

  // Source 2: Binance perpetual (free public endpoint)
  try {
    const r = await fetch("https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1", { timeout:6000 });
    if (r.ok) {
      const d = await r.json();
      const rate = parseFloat(d[0]?.fundingRate||0);
      if (!isNaN(rate)) results.push({ source:"Binance", rate, ratePct:+(rate*100).toFixed(5) });
    }
  } catch(e) { errors.push("Binance:"+e.message); }

  // Source 3: OKX (free public endpoint)
  try {
    const r = await fetch("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP", { timeout:6000 });
    if (r.ok) {
      const d = await r.json();
      const rate = parseFloat(d.data?.[0]?.fundingRate||0);
      if (!isNaN(rate)) results.push({ source:"OKX", rate, ratePct:+(rate*100).toFixed(5) });
    }
  } catch(e) { errors.push("OKX:"+e.message); }

  // Source 4: Coinglass aggregated rate (includes more exchanges)
  try {
    const r = await fetch("https://open-api.coinglass.com/public/v2/funding?symbol=BTC&limit=1", {
      headers:{ Accept:"application/json" }, timeout:7000
    });
    if (r.ok) {
      const d = await r.json();
      // Coinglass returns per-exchange rates — average the ones we recognize
      const rates = d.data?.[0]?.rates||[];
      const validRates = rates.map(x => parseFloat(x.rate||0)).filter(x => !isNaN(x) && Math.abs(x)<0.01);
      if (validRates.length) {
        const avgRate = validRates.reduce((a,b)=>a+b,0)/validRates.length;
        results.push({ source:"Coinglass_agg", rate:avgRate, ratePct:+(avgRate*100).toFixed(5) });
      }
    }
  } catch(e) { errors.push("Coinglass_funding:"+e.message); }

  // Aggregate: use median of available rates for robustness
  let avgRatePct = 0;
  let consensus  = "LOW_DATA";

  if (results.length > 0) {
    const sorted = results.map(r=>r.ratePct).sort((a,b)=>a-b);
    // Median
    const mid = Math.floor(sorted.length/2);
    avgRatePct = sorted.length%2 === 0 ? (sorted[mid-1]+sorted[mid])/2 : sorted[mid];

    // Consensus: do sources agree on direction?
    const positives = results.filter(r=>r.ratePct>0.01).length;
    const negatives = results.filter(r=>r.ratePct<-0.005).length;
    consensus = positives===results.length?"UNANIMOUS_POSITIVE"
      : negatives===results.length?"UNANIMOUS_NEGATIVE"
      : results.length>=2?"MIXED_SOURCES"
      : "SINGLE_SOURCE";
  }

  const sentiment = avgRatePct > 0.1  ? "EXTREME_BULLISH_FUNDING"
    : avgRatePct > 0.03 ? "HIGH_FUNDING"
    : avgRatePct < -0.01 ? "NEGATIVE_FUNDING"
    : "NEUTRAL_FUNDING";

  const entryBias = avgRatePct>0.1?"CAUTION":avgRatePct<-0.01?"BULLISH":"NEUTRAL";

  const data = {
    ratePct:  +avgRatePct.toFixed(5),
    sentiment, entryBias, consensus,
    sources:  results,
    errors:   errors.length ? errors : undefined,
    sourcesAvailable: results.length,
    summary: results.map(r=>`${r.source}:${r.ratePct>0?"+":""}${r.ratePct.toFixed(4)}%`).join(" | ") || "No data",
  };
  CACHE.funding = { data, ts:Date.now(), ttl:CACHE.funding.ttl };
  return data;
}

// ── 5. Global market cap & BTC dominance ─────────────────────────────────────
async function getGlobalData() {
  if (fresh("globalMcap")) return CACHE.globalMcap.data;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/global", { headers:{Accept:"application/json"}, timeout:8000 });
    const d = (await r.json()).data;
    const mcap   = d.total_market_cap?.usd||0;
    const btcDom = d.market_cap_percentage?.btc||50;
    const mcapChg = d.market_cap_change_percentage_24h_usd||0;
    const result = {
      totalMcapB:    +(mcap/1e9).toFixed(0),
      btcDominance:  +btcDom.toFixed(2),
      ethDominance:  +(d.market_cap_percentage?.eth||15).toFixed(2),
      mcapChange24h: +mcapChg.toFixed(2),
      altSentiment:  btcDom>55?"BTC_DOM_HIGH_ALT_RISK":btcDom<42?"ALT_SEASON_POSSIBLE":"NEUTRAL",
      // Regime uses 24h mcap change — bear/bull day
      regime: mcapChg>3?"BULL_DAY":mcapChg<-3?"BEAR_DAY":"RANGING_DAY",
    };
    CACHE.globalMcap = { data:result, ts:Date.now(), ttl:CACHE.globalMcap.ttl };
    return result;
  } catch {
    return { totalMcapB:0, btcDominance:50, mcapChange24h:0, altSentiment:"NEUTRAL", regime:"RANGING_DAY" };
  }
}

// ── 6. Session ────────────────────────────────────────────────────────────────
function getSession() {
  const utcH = new Date().getUTCHours();
  const utcM = new Date().getUTCMinutes();
  const t = utcH + utcM/60;
  if (t>=1&&t<6)    return { session:"DEAD_ZONE",      sizeMult:0.4, note:"1-6am UTC low liquidity — size ×0.4", active:false };
  if (t>=6&&t<8)    return { session:"ASIA_OPEN",      sizeMult:0.7, note:"Asia session — moderate volume",      active:true };
  if (t>=8&&t<13)   return { session:"LONDON",         sizeMult:1.0, note:"London session — good momentum",      active:true };
  if (t>=13&&t<16)  return { session:"NY_LONDON_PEAK", sizeMult:1.0, note:"NY+London overlap — peak volume ⭐",  active:true };
  if (t>=16&&t<21)  return { session:"NY_SESSION",     sizeMult:1.0, note:"NY session — good volume",           active:true };
  return              { session:"LATE_SESSION",         sizeMult:0.8, note:"Late session — moderate caution",    active:true };
}

// ── 7. Liquidity gate ─────────────────────────────────────────────────────────
function checkLiquidity(obData, intendedSpendUSD, currentPrice) {
  if (!obData) return { pass:true, reason:"OB unavailable — skip check" };
  if ((obData.spreadPct||0) > 0.15) return { pass:false, reason:`Wide spread ${obData.spreadPct?.toFixed(3)}% > 0.15%` };
  const askWall = obData.nearestResistance;
  if (askWall) {
    const dist = (askWall - currentPrice)/currentPrice*100;
    if (dist>0 && dist<0.3) return { pass:false, reason:`Ask wall $${askWall.toFixed(4)} only ${dist.toFixed(3)}% above` };
  }
  return { pass:true, reason:`Spread ${(obData.spreadPct||0).toFixed(3)}% OK` };
}

// ── 8. Kelly sizing ───────────────────────────────────────────────────────────
// conf 75→70%, 85→85%, 95+→100%
function kellySize(confidence, sessionMult=1.0) {
  const raw = 70 + ((confidence-75)/20)*30;
  const capped = Math.min(100, Math.max(10, raw));
  return Math.round(Math.min(100, Math.max(10, capped*sessionMult)));
}

// ── 9. Full context assembler ─────────────────────────────────────────────────
async function getFullContext() {
  const [btc, fg, cg, fund, global] = await Promise.allSettled([
    getBTCHealth(), getFearGreed(), getCoinglassData(), getFundingRates(), getGlobalData()
  ]);
  const r = (x) => x.status==="fulfilled" ? x.value : {};
  const btcData = r(btc);

  return {
    btc:       btcData,
    fearGreed: r(fg),
    coinglass: r(cg),
    funding:   r(fund),
    global:    r(global),
    session:   getSession(),
    // Hard block only on BTC dump — bearish regime allows trades with tighter rules
    allowEntry:  btcData.allowAltEntries !== false,
    bearishMode: btcData.bearishRegime   === true,   // tighter rules but still trading
    gateReason:  btcData.gateReason || "OK",
  };
}

// ── 10. Format for Claude prompt ──────────────────────────────────────────────
function formatForPrompt(ctx) {
  if (!ctx) return "Market context unavailable";
  const { btc, fearGreed, coinglass, funding, global, session } = ctx;

  const warnings = [];
  if (btc?.hardBlock)        warnings.push(`🚫 BTC HARD DUMP ${btc?.chg15m?.toFixed(2)}% — no new entries`);
  if (ctx?.bearishMode)      warnings.push(`⚠️ BEARISH REGIME (BTC 1D: ${btc?.trend1d}) — require +5% extra confidence, reduce size`);
  if ((fearGreed?.value||50)>80) warnings.push(`⚠️ EXTREME GREED ${fearGreed?.value} — reduce size`);
  if ((fearGreed?.value||50)<20) warnings.push(`✅ EXTREME FEAR ${fearGreed?.value} — contrarian buy`);
  if ((funding?.ratePct||0)>0.08) warnings.push(`⚠️ HIGH FUNDING ${funding?.ratePct?.toFixed(4)}% avg (${funding?.sourcesAvailable} exchanges) — longs overcrowded`);
  if ((coinglass?.ratio||1)<0.7)  warnings.push(`✅ SHORTS OVERCROWDED ratio=${coinglass?.ratio} — squeeze risk up`);
  if (global?.regime==="BEAR_DAY") warnings.push(`⚠️ BEAR DAY ${global?.mcapChange24h}% total mcap — raise bar`);
  if (session?.session==="DEAD_ZONE") warnings.push(`⚠️ DEAD ZONE — thin liquidity, fake moves`);

  return [
    `━━ MACRO MARKET CONTEXT ━━`,
    `BTC:      score=${btc?.healthScore||"?"}/100 | 1D=${btc?.trend1d||"?"} | 4H=${btc?.trend4h||"?"} | 15m chg=${btc?.chg15m?.toFixed(2)||"?"}% | gate=${ctx?.allowEntry?"✅":"🚫"}`,
    `Fear&Greed: ${fearGreed?.value||"?"}/100 (${fearGreed?.label||"?"}) | trend=${fearGreed?.trend||"?"} | bias=${fearGreed?.entryBias||"?"}`,
    `Long/Short: ${coinglass?.longPct?.toFixed(1)||"?"}%L / ${coinglass?.shortPct?.toFixed(1)||"?"}%S | ratio=${coinglass?.ratio||"?"} | ${coinglass?.sentiment||"?"}`,
    `Funding:  avg=${funding?.ratePct?.toFixed(4)||"?"}%/8h | ${funding?.sourcesAvailable||0} sources: ${funding?.summary||"—"} | consensus=${funding?.consensus||"?"}`,
    `Global:   $${global?.totalMcapB||"?"}B mcap | BTC dom=${global?.btcDominance||"?"}% | 24h=${global?.mcapChange24h||"?"}% | regime=${global?.regime||"?"}`,
    `Session:  ${session?.session||"?"} | size×${session?.sizeMult||1} | ${session?.note||""}`,
    warnings.length ? "\n"+warnings.join("\n") : "",
  ].join("\n");
}

module.exports = {
  getBTCHealth, getFearGreed, getCoinglassData, getFundingRates, getGlobalData,
  getSession, checkLiquidity, kellySize, getFullContext, formatForPrompt
};
