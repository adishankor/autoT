// ─────────────────────────────────────────────────────────────────────────────
// claude.js  v4
// Changes:
//   • Retry logic with exponential backoff (handles 429, 529, 5xx)
//   • Rate limit queue — spaces calls to avoid burst
//   • Bearish regime: prompt explicitly instructs higher threshold
//   • Day TF added to multi-TF block
//   • Funding rate multi-source shown in prompt
// ─────────────────────────────────────────────────────────────────────────────
const fetch  = require("node-fetch");
const mktCtx = require("./marketContext");

// ── Rate limit tracker ────────────────────────────────────────────────────────
// Anthropic Sonnet: 50 RPM, 40K TPM on paid tier
// We throttle to 40 RPM to leave headroom
let callCount = 0;
let windowStart = Date.now();
const MAX_CALLS_PER_MIN = 40;

function checkRateLimit() {
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; callCount = 0; }
  callCount++;
  return callCount;
}

// ── Core API call with retry + backoff ────────────────────────────────────────
async function claudeCall(messages, tools, system, retries = 3) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set in .env");

  const body = { model:"claude-sonnet-4-20250514", max_tokens:1800, messages };
  if (tools)  body.tools  = tools;
  if (system) body.system = system;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Proactive throttle: if we're near rate limit, wait
      const calls = checkRateLimit();
      if (calls > MAX_CALLS_PER_MIN - 5) {
        const wait = 60000 - (Date.now() - windowStart) + 1000;
        console.log(`[Claude] Rate limit headroom low (${calls}/${MAX_CALLS_PER_MIN}) — waiting ${(wait/1000).toFixed(1)}s`);
        await sleep(wait);
      }

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key":key,
          "anthropic-version":"2023-06-01"
        },
        body:JSON.stringify(body)
      });

      // Handle rate limit (429) and overload (529)
      if (r.status === 429 || r.status === 529) {
        const retryAfter = parseInt(r.headers.get("retry-after") || "10");
        const wait = (retryAfter + 1) * 1000;
        console.log(`[Claude] ${r.status} — retry after ${retryAfter}s (attempt ${attempt+1}/${retries+1})`);
        if (attempt < retries) { await sleep(wait); continue; }
        throw new Error(`Rate limited after ${retries} retries`);
      }

      // Handle server errors (5xx)
      if (r.status >= 500) {
        const wait = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`[Claude] HTTP ${r.status} — retrying in ${wait/1000}s (attempt ${attempt+1}/${retries+1})`);
        if (attempt < retries) { await sleep(wait); continue; }
        throw new Error(`Anthropic server error ${r.status} after ${retries} retries`);
      }

      if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);

      const d = await r.json();
      // Handle error in response body
      if (d.type === "error") {
        if (d.error?.type === "overloaded_error" && attempt < retries) {
          await sleep(Math.pow(2,attempt)*3000);
          continue;
        }
        throw new Error(`Claude error: ${d.error?.message || JSON.stringify(d.error)}`);
      }

      return d;

    } catch(e) {
      if (attempt < retries && (e.message.includes("ECONNRESET")||e.message.includes("ETIMEDOUT")||e.message.includes("fetch"))) {
        const wait = Math.pow(2, attempt) * 2000;
        console.log(`[Claude] Network error: ${e.message} — retry in ${wait/1000}s`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── News search with retry ────────────────────────────────────────────────────
async function searchNews(symbol) {
  const coin = symbol.replace("USDT","");
  let msgs = [{
    role:"user",
    content:`Search for: 1) ${coin} crypto news today — price catalysts, whale activity, on-chain signals, protocol updates. 2) Any Bybit or Binance announcements about ${coin} in last 24h (listings, delistings, promotions, launchpads). Give 4-5 bullet points with BULLISH/BEARISH label per point.`
  }];
  for (let i=0;i<6;i++) {
    try {
      const d = await claudeCall(msgs,[{type:"web_search_20250305",name:"web_search"}]);
      if (d.stop_reason==="end_turn") return d.content.find(b=>b.type==="text")?.text||"No news.";
      if (d.stop_reason==="tool_use") {
        msgs.push({role:"assistant",content:d.content});
        msgs.push({role:"user",content:d.content.filter(b=>b.type==="tool_use").map(b=>({type:"tool_result",tool_use_id:b.id,content:""}))});
      } else break;
    } catch(e) {
      console.log(`[Claude] News search error: ${e.message}`);
      return "News unavailable — using technicals only.";
    }
  }
  return "News unavailable.";
}

// ── Format divergence ─────────────────────────────────────────────────────────
function fmtDiv(div) {
  if (!div) return "None detected";
  const p=[];
  if (div.bullish) p.push(`✅ BULL DIV [${div.bullish.strength}] ${div.bullish.label} (${div.bullish.barsSince} bars ago)`);
  if (div.hidden)  p.push(`✅ HIDDEN BULL [${div.hidden.strength}] ${div.hidden.label} (${div.hidden.barsSince} bars ago)`);
  if (div.bearish) p.push(`⚠️ BEAR DIV [${div.bearish.strength}] ${div.bearish.label} (${div.bearish.barsSince} bars ago)`);
  return p.length ? p.join("\n") : "None detected";
}

// ── Main decision ─────────────────────────────────────────────────────────────
async function getDecision({ symbol, ind, multiTF, mtf, ob, news, anns, settings, portfolioUSDT, position, pendingRecovery, marketCtx }) {
  const I = ind||{}, OB = ob||{}, s = settings||{};

  const annText = (anns||[]).slice(0,5).map(a=>`[${a.source}+${a.score}] ${a.title}`).join("\n")||"None";

  // Multi-TF lines — now includes Day TF if available
  const tfLines = Object.entries(multiTF||{}).map(([tf,d]) => {
    if (!d) return `${tf}: NO DATA`;
    const b = d.bias||{};
    return `${tf}: RSI=${d.rsi?.toFixed(1)??"—"} MACD=${d.macd?.bullish?"BULL":"BEAR"} EMA9${d.ema9&&d.ema20?(d.ema9>d.ema20?">":"<"):"?"}EMA20 Vol=${d.volRatio?.toFixed(2)??"—"}x → ${b.label||"?"}(${b.score||"?"})`;
  }).join("\n");

  const mtfBlock = mtf
    ? `${mtf.bullCount}/${Object.keys(multiTF||{}).length} bullish | ${mtf.bearCount} bearish | ${mtf.dominant} | entry=${mtf.bullish?"✅ ALLOWED":"❌ BLOCKED"}`
    : "MTF: unavailable";

  const posBlock = position
    ? `OPEN: ${position.symbol} Entry=$${position.entryPrice.toFixed(6)} PnL=${position.pnlPct?.toFixed(3)}% Peak=${position.peakPnlPct?.toFixed(3)}% TrailSL=${position.trailingSL?"$"+position.trailingSL.toFixed(6):"not set"} Held=${Math.round((Date.now()-position.entryTime)/60000)}min Conf=${position.confidence}%`
    : "NO OPEN POSITION";

  const recovBlock = pendingRecovery
    ? `⚡ RECOVERY: prev loss=${pendingRecovery.lossPct.toFixed(3)}% ($${pendingRecovery.lossUSD.toFixed(2)}) — need ≥${pendingRecovery.boostTargetPct.toFixed(2)}% gross`
    : "";

  const ctxBlock = marketCtx ? mktCtx.formatForPrompt(marketCtx) : "Market context unavailable";

  const effConf = s.minConfidence||75;
  const bearishNote = marketCtx?.bearishMode
    ? `\n⚠️ BEARISH REGIME ACTIVE: BTC 1D trend is BEAR. You may still trade if setup is exceptionally strong, but require ${effConf+5}%+ confidence, recommend reducing position size by 40%, and only take the clearest setups. Do NOT block trading entirely — just raise the bar.`
    : "";

  const prompt = `You are a professional quantitative crypto spot trader, 10+ years experience. Analyze ${symbol} on Bybit.

━━ PORTFOLIO & POSITION ━━
Portfolio: $${portfolioUSDT?.toFixed(2)} USDT | ${posBlock}
${recovBlock}
${bearishNote}

━━ TECHNICALS (15m primary) ━━
Price: $${I.price?.toFixed(6)} | RSI: ${I.rsi?.toFixed(2)??"N/A"}${I.rsi>75?" ⚠️OB":I.rsi<28?" ⚠️OS":""}
MACD:  ${I.macd?.line?.toFixed(8)??"N/A"} — ${I.macd?.bullish?"BULLISH ✅":"BEARISH ⚠️"}
EMA:   9=$${I.ema9?.toFixed(4)??"—"} 20=$${I.ema20?.toFixed(4)??"—"} 50=$${I.ema50?.toFixed(4)??"—"}
       ${I.ema9&&I.ema20&&I.ema50?(I.ema9>I.ema20&&I.ema20>I.ema50?"✅ BULL STACK":I.ema9<I.ema20&&I.ema20<I.ema50?"⚠️ BEAR STACK":"⚡ MIXED"):"partial data"}
BB:    U=$${I.bb?.upper?.toFixed(4)??"—"} M=$${I.bb?.mid?.toFixed(4)??"—"} L=$${I.bb?.lower?.toFixed(4)??"—"} pos=${((I.bb?.pos||0)*100).toFixed(0)}%
ATR:   ${I.atr?.toFixed(6)??"N/A"} | VolRatio: ${I.volRatio?.toFixed(2)??"N/A"}x
Chg:   1c=${I.chg1?.toFixed(3)??"N/A"}% 5c=${I.chg5?.toFixed(3)??"N/A"}% 10c=${I.chg10?.toFixed(3)??"N/A"}%
S/R:   Support=$${I.sr?.support?.toFixed(4)??"—"} Resistance=$${I.sr?.resistance?.toFixed(4)??"—"}

━━ RSI DIVERGENCE ━━
${fmtDiv(I.divergence)}

━━ ORDER BOOK ━━
${OB.available!==false ? (OB.summary||"Analyzing...") : "Unavailable"}

━━ MULTI-TIMEFRAME (incl. 1D) ━━
${tfLines}
Agreement: ${mtfBlock}

━━ ANNOUNCEMENTS ━━
${annText}

━━ NEWS ━━
${news}

${ctxBlock}

━━ RULES ━━
1. Spot only — zero leverage
2. Zero-loss: ${s.zeroLossRule?"never auto-exit below entry":"OFF"}
3. Min gross profit: ${s.minGrossProfitPct||1.2}% (covers 0.2% fees)
4. Min confidence: ${effConf}%${marketCtx?.bearishMode?" (+5 in bearish regime)":""}
5. MTF: need ≥${s.mtfRequired||3}/TFs bullish
6. Volume ratio ≥${s.minVolRatio||1.2}x
7. Strong bearish divergence → no entry
8. Ask wall within 0.3% → skip
9. BTC hard dump → block; BTC bearish regime → raise bar but still trade
10. Funding >0.1%/8h (avg across exchanges) → longs overcrowded, reduce size
11. Extreme greed (>80) → reduce size; Extreme fear (<20) → boost confidence
12. Dead zone (1-6am UTC) → reduce size, skip marginal setups
${pendingRecovery?`13. RECOVERY: need ${pendingRecovery.boostTargetPct.toFixed(2)}% gross`:""}

Reply ONLY with valid JSON, no markdown:
{
  "action": "BUY"|"HOLD_POSITION"|"SELL_PROFIT"|"WAIT",
  "confidence": 0-100,
  "timeframe": "5m"|"15m"|"1h"|"4h"|"1d",
  "positionSizePct": 10-100,
  "takeProfitPct": 1.2-30,
  "trailingSLUpdate": null,
  "reasoning": "2-3 precise sentences citing specific signals",
  "signals": ["up to 6 key signals"],
  "risk": "LOW"|"MEDIUM"|"HIGH",
  "urgency": "SCALP"|"SWING",
  "announcementBoost": true|false,
  "divergenceBoost": true|false,
  "obBias": "BULLISH"|"NEUTRAL"|"BEARISH",
  "mtfPassed": true|false,
  "regimeAware": true|false,
  "bearishRegimeTrade": true|false,
  "expectedMinutes": 0
}`;

  try {
    const d = await claudeCall([{role:"user",content:prompt}], null,
      "You are a top quantitative crypto spot trader. Respond ONLY with valid JSON. No markdown. Be decisive.");
    const txt = d.content?.find(b=>b.type==="text")?.text||"{}";
    return JSON.parse(txt.replace(/```json|```/g,"").trim());
  } catch(e) {
    console.log(`[Claude] Decision error: ${e.message}`);
    return { action:"WAIT", confidence:0, reasoning:`Claude error: ${e.message}`, signals:[], mtfPassed:false, regimeAware:false };
  }
}

// ── Quick score (no API call) ─────────────────────────────────────────────────
function quickScore(ind, mtf, ob) {
  if (!ind) return 0;
  let s = 50;
  const I = ind;
  if (I.rsi<30) s+=15; else if (I.rsi<45) s+=8; else if (I.rsi>75) s-=18; else if (I.rsi>60) s+=5;
  if (I.macd?.bullish) s+=12; else s-=12;
  if (I.ema9&&I.ema20&&I.ema50) {
    if (I.ema9>I.ema20&&I.ema20>I.ema50) s+=18;
    else if (I.ema9<I.ema20&&I.ema20<I.ema50) s-=18;
  }
  if (I.bb?.pos<0.25) s+=10; else if (I.bb?.pos>0.85) s-=10;
  if ((I.volRatio||0)>=1.5) s+=12; else if ((I.volRatio||0)>=1.2) s+=6; else s-=8;
  if (I.divergence?.bullish?.strength==="STRONG") s+=14;
  if (I.divergence?.hidden?.strength==="STRONG")  s+=9;
  if (I.divergence?.bearish?.strength==="STRONG") s-=18;
  if (mtf) s += (mtf.bullCount - mtf.bearCount)*5;
  if (ob?.imbalance>0.3) s+=6; if (ob?.imbalance<-0.3) s-=6;
  if (ob?.nearestResistance) {
    const d = (ob.nearestResistance-(I.price||0))/(I.price||1)*100;
    if (d>0&&d<0.3) s-=12;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

// ── Rank candidates ───────────────────────────────────────────────────────────
async function rankCandidates(candidates, marketCtx) {
  if (!candidates.length) return candidates;
  const ctxNote = marketCtx
    ? `Market: regime=${marketCtx.global?.regime||"?"} | BTC 1D=${marketCtx.btc?.trend1d||"?"} | F&G=${marketCtx.fearGreed?.value||"?"} | BearishMode=${marketCtx.bearishMode?"YES":"NO"}`
    : "";
  const list = candidates.map(c=>`${c.symbol}: rank#${c.rank||"?"} 24h=${c.change24h?.toFixed(1)??"?"}% 1h=${c.change1h?.toFixed(2)??"?"}% vol=$${((c.volume24h||0)/1e6).toFixed(0)}M score=${c.score}`).join("\n");
  try {
    const d = await claudeCall([{role:"user",content:`Rank these coins for Bybit spot trading NOW. Prioritize momentum+high volume+reputable projects. ${ctxNote}\nReturn ONLY a JSON array of symbols:\n${list}`}],
      null, "Return ONLY a JSON array of symbol strings. No other text.");
    const txt = d.content?.find(b=>b.type==="text")?.text||"[]";
    const ranked = JSON.parse(txt.replace(/```json|```/g,"").trim());
    return ranked.map(s=>candidates.find(c=>c.symbol===s)).filter(Boolean);
  } catch { return candidates; }
}

module.exports = { getDecision, searchNews, quickScore, rankCandidates };
