// ─────────────────────────────────────────────────────────────────────────────
// claude.js  V5
// Key change: News cache per coin (30min TTL)
// Announcement check uses keyword scoring — NO Claude API
// This reduces Claude API calls from ~5-8 per scan down to ~1-2 per scan.
//
// Claude API calls per scan cycle:
//   - 1x  getDecision  (the trading decision)
//   - 0-1x searchNews  (only if coin's news cache is expired — every 30 min)
//   - 0x  announcements (handled by announcements.js, no Claude needed)
// ─────────────────────────────────────────────────────────────────────────────
const fetch  = require("node-fetch");
const mktCtx = require("./marketContext");

// ── Rate limit tracker ────────────────────────────────────────────────────────
let callCount=0, windowStart=Date.now();
const MAX_RPM = 40;

function checkRate() {
  const now=Date.now();
  if (now-windowStart>60000){ windowStart=now; callCount=0; }
  return ++callCount;
}

const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ── Core API call with retry + backoff ────────────────────────────────────────
async function claudeCall(messages, tools, system, retries=3) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set in .env");
  const body = { model:"claude-sonnet-4-20250514", max_tokens:1800, messages };
  if (tools)  body.tools  = tools;
  if (system) body.system = system;

  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const cnt = checkRate();
      if (cnt > MAX_RPM-5) { const w=60000-(Date.now()-windowStart)+1000; console.log(`[Claude] Rate throttle — waiting ${(w/1000).toFixed(1)}s`); await sleep(w); }
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
        body:JSON.stringify(body),
      });
      if (r.status===429||r.status===529) {
        const wait=(parseInt(r.headers.get("retry-after")||"10")+1)*1000;
        console.log(`[Claude] ${r.status} — retry in ${wait/1000}s (attempt ${attempt+1})`);
        if (attempt<retries){ await sleep(wait); continue; }
        throw new Error(`Rate limited after ${retries} retries`);
      }
      if (r.status>=500) {
        const wait=Math.pow(2,attempt)*2000;
        if (attempt<retries){ await sleep(wait); continue; }
        throw new Error(`Anthropic server error ${r.status}`);
      }
      if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
      const d = await r.json();
      if (d.type==="error"){
        if (d.error?.type==="overloaded_error"&&attempt<retries){ await sleep(Math.pow(2,attempt)*3000); continue; }
        throw new Error(`Claude: ${d.error?.message||JSON.stringify(d.error)}`);
      }
      return d;
    } catch(e) {
      if (attempt<retries&&(e.message.includes("ECONNRESET")||e.message.includes("ETIMEDOUT")||e.message.includes("fetch"))){
        await sleep(Math.pow(2,attempt)*2000); continue;
      }
      throw e;
    }
  }
}

// ── News cache (30 min per coin) ──────────────────────────────────────────────
const NEWS_CACHE = new Map(); // symbol → { text, ts }
const NEWS_TTL   = 30 * 60 * 1000; // 30 minutes

async function searchNews(symbol) {
  const cached = NEWS_CACHE.get(symbol);
  if (cached && (Date.now()-cached.ts) < NEWS_TTL) {
    console.log(`[Claude] News cache hit for ${symbol} (${Math.round((Date.now()-cached.ts)/60000)}min old)`);
    return cached.text;
  }

  const coin = symbol.replace("USDT","");
  let msgs = [{role:"user",content:`Search for: 1) ${coin} crypto news today — price catalysts, whale moves, on-chain signals. 2) Any Bybit or Binance announcements about ${coin} last 24h. Give 4-5 bullets with BULLISH/BEARISH label per point.`}];
  try {
    for (let i=0;i<6;i++) {
      const d = await claudeCall(msgs,[{type:"web_search_20250305",name:"web_search"}]);
      if (d.stop_reason==="end_turn") {
        const text = d.content.find(b=>b.type==="text")?.text||"No news.";
        NEWS_CACHE.set(symbol, { text, ts:Date.now() });
        return text;
      }
      if (d.stop_reason==="tool_use") {
        msgs.push({role:"assistant",content:d.content});
        msgs.push({role:"user",content:d.content.filter(b=>b.type==="tool_use").map(b=>({type:"tool_result",tool_use_id:b.id,content:""}))});
      } else break;
    }
  } catch(e) { console.log(`[Claude] News search error: ${e.message}`); }
  const fallback = "News unavailable — using technicals only.";
  NEWS_CACHE.set(symbol, { text:fallback, ts:Date.now() });
  return fallback;
}

function fmtDiv(div) {
  if (!div) return "None detected";
  const p=[];
  if(div.bullish)p.push(`✅ BULL DIV [${div.bullish.strength}] ${div.bullish.label} (${div.bullish.barsSince} bars ago)`);
  if(div.hidden) p.push(`✅ HIDDEN BULL [${div.hidden.strength}] ${div.hidden.label} (${div.hidden.barsSince} bars ago)`);
  if(div.bearish)p.push(`⚠️ BEAR DIV [${div.bearish.strength}] ${div.bearish.label} (${div.bearish.barsSince} bars ago)`);
  return p.length?p.join("\n"):"None detected";
}

// ── Main decision ─────────────────────────────────────────────────────────────
async function getDecision({ symbol, ind, multiTF, mtf, ob, news, anns, settings, portfolioUSDT, position, pendingRecovery, marketCtx }) {
  const I=ind||{}, OB=ob||{}, s=settings||{};
  const annText=(anns||[]).slice(0,5).map(a=>`[${a.source}+${a.score}] ${a.title}`).join("\n")||"None";
  const tfLines=Object.entries(multiTF||{}).map(([tf,d])=>{
    if(!d)return`${tf}:NO_DATA`;
    const b=d.bias||{};
    return`${tf}:RSI=${d.rsi?.toFixed(1)??"—"} MACD=${d.macd?.bullish?"BULL":"BEAR"} EMA9${d.ema9&&d.ema20?(d.ema9>d.ema20?">":"<"):"?"}EMA20 Vol=${d.volRatio?.toFixed(2)??"—"}x →${b.label||"?"}(${b.score||"?"})`;
  }).join("\n");

  const mtfBlock=mtf?`${mtf.bullCount}/${mtf.totalTFs||5} bullish | ${mtf.dominant} | ${mtf.bullish?"✅ ALLOWED":"❌ BLOCKED"}`:"unavailable";
  const posBlock=position
    ?`OPEN:${position.symbol} Entry=$${position.entryPrice.toFixed(6)} PnL=${position.pnlPct?.toFixed(3)}% Peak=${position.peakPnlPct?.toFixed(3)}% TrailSL=${position.trailingSL?"$"+position.trailingSL.toFixed(6):"not set"} Held=${Math.round((Date.now()-position.entryTime)/60000)}min Conf=${position.confidence}%`
    :"NO OPEN POSITION";
  const recovBlock=pendingRecovery?`⚡ RECOVERY: loss=${pendingRecovery.lossPct.toFixed(3)}% — need ≥${pendingRecovery.boostTargetPct.toFixed(2)}% gross`:"";
  const ctxBlock=marketCtx?mktCtx.formatForPrompt(marketCtx):"Market context unavailable";
  const effConf=s.minConfidence||75;
  const bearNote=marketCtx?.bearishMode?`\n⚠️ BEARISH REGIME (BTC 1D BEAR): still trade if setup is exceptional — require ${effConf+5}%+ confidence, reduce size 30%, clearest setups only.`:"";

  const prompt=`You are a professional quantitative crypto spot trader. Analyze ${symbol} on Bybit.

━━ PORTFOLIO ━━
$${portfolioUSDT?.toFixed(2)} USDT | ${posBlock}
${recovBlock}${bearNote}

━━ TECHNICALS (15m primary) ━━
Price:$${I.price?.toFixed(6)} RSI:${I.rsi?.toFixed(2)??"N/A"}${I.rsi>75?" ⚠️OB":I.rsi<28?" ⚠️OS":""}
MACD:${I.macd?.line?.toFixed(8)??"N/A"} → ${I.macd?.bullish?"BULL ✅":"BEAR ⚠️"}
EMA:9=$${I.ema9?.toFixed(4)??"—"} 20=$${I.ema20?.toFixed(4)??"—"} 50=$${I.ema50?.toFixed(4)??"—"}
${I.ema9&&I.ema20&&I.ema50?(I.ema9>I.ema20&&I.ema20>I.ema50?"✅ BULL STACK":I.ema9<I.ema20&&I.ema20<I.ema50?"⚠️ BEAR STACK":"⚡ MIXED"):"EMA partial"}
BB:U=$${I.bb?.upper?.toFixed(4)??"—"} M=$${I.bb?.mid?.toFixed(4)??"—"} L=$${I.bb?.lower?.toFixed(4)??"—"} pos=${((I.bb?.pos||0)*100).toFixed(0)}%
ATR:${I.atr?.toFixed(6)??"N/A"} Vol:${I.volRatio?.toFixed(2)??"N/A"}x Chg:1c=${I.chg1?.toFixed(3)??"N/A"}% 5c=${I.chg5?.toFixed(3)??"N/A"}%
S/R:Support=$${I.sr?.support?.toFixed(4)??"—"} Resistance=$${I.sr?.resistance?.toFixed(4)??"—"}

━━ RSI DIVERGENCE ━━
${fmtDiv(I.divergence)}

━━ ORDER BOOK ━━
${OB.available!==false?(OB.summary||"Analyzing"):"Unavailable"}

━━ MULTI-TIMEFRAME ━━
${tfLines}
Agreement:${mtfBlock}

━━ ANNOUNCEMENTS (4h cache — no Claude API used) ━━
${annText}

━━ NEWS (30min cache) ━━
${news}

${ctxBlock}

━━ RULES ━━
1.Spot only 2.Zero-loss:${s.zeroLossRule?"hold until profit":"OFF"} 3.Min gross:${s.minGrossProfitPct||1.2}%
4.Min conf:${effConf}%${marketCtx?.bearishMode?" (+5 bearish regime)":""} 5.MTF ≥${s.mtfRequired||3}/TFs 6.Vol ≥${s.minVolRatio||1.2}x
7.Strong bearish div → skip 8.Ask wall <0.3% → skip 9.BTC hard dump → block 10.Funding >0.1% → reduce size
${pendingRecovery?`RECOVERY TARGET: ${pendingRecovery.boostTargetPct.toFixed(2)}% gross`:""}

Reply ONLY valid JSON no markdown:
{"action":"BUY"|"HOLD_POSITION"|"SELL_PROFIT"|"WAIT","confidence":0-100,"timeframe":"5m"|"15m"|"1h"|"4h"|"1d","positionSizePct":10-100,"takeProfitPct":1.2-30,"trailingSLUpdate":null,"reasoning":"2-3 sentences","signals":["s1","s2","s3","s4","s5"],"risk":"LOW"|"MEDIUM"|"HIGH","urgency":"SCALP"|"SWING","announcementBoost":true,"divergenceBoost":true,"obBias":"BULLISH"|"NEUTRAL"|"BEARISH","mtfPassed":true,"regimeAware":true,"bearishRegimeTrade":false,"expectedMinutes":0}`;

  try {
    const d = await claudeCall([{role:"user",content:prompt}],null,"You are a top quantitative crypto spot trader. Respond ONLY with valid JSON. No markdown. Be decisive.");
    const txt = d.content?.find(b=>b.type==="text")?.text||"{}";
    return JSON.parse(txt.replace(/```json|```/g,"").trim());
  } catch(e) {
    return {action:"WAIT",confidence:0,reasoning:`Claude error:${e.message}`,signals:[],mtfPassed:false,regimeAware:false};
  }
}

// ── Quick score (no API call) ─────────────────────────────────────────────────
function quickScore(ind, mtf, ob) {
  if (!ind) return 0;
  let s=50;
  if(ind.rsi<30)s+=15;else if(ind.rsi<45)s+=8;else if(ind.rsi>75)s-=18;else if(ind.rsi>60)s+=5;
  if(ind.macd?.bullish)s+=12;else s-=12;
  if(ind.ema9&&ind.ema20&&ind.ema50){if(ind.ema9>ind.ema20&&ind.ema20>ind.ema50)s+=18;else if(ind.ema9<ind.ema20&&ind.ema20<ind.ema50)s-=18;}
  if(ind.bb?.pos<0.25)s+=10;else if(ind.bb?.pos>0.85)s-=10;
  if((ind.volRatio||0)>=1.5)s+=12;else if((ind.volRatio||0)>=1.2)s+=6;else s-=8;
  if(ind.divergence?.bullish?.strength==="STRONG")s+=14;
  if(ind.divergence?.hidden?.strength==="STRONG")s+=9;
  if(ind.divergence?.bearish?.strength==="STRONG")s-=18;
  if(mtf)s+=(mtf.bullCount-mtf.bearCount)*5;
  if(ob?.imbalance>0.3)s+=6;if(ob?.imbalance<-0.3)s-=6;
  if(ob?.nearestResistance){const d=(ob.nearestResistance-(ind.price||0))/(ind.price||1)*100;if(d>0&&d<0.3)s-=12;}
  return Math.max(0,Math.min(100,Math.round(s)));
}

// ── Rank candidates ───────────────────────────────────────────────────────────
async function rankCandidates(candidates, ctx) {
  if (!candidates.length) return candidates;
  const ctxNote = ctx ? `Market:regime=${ctx.global?.regime||"?"} BTC1D=${ctx.btc?.trend1d||"?"} F&G=${ctx.fearGreed?.value||"?"}` : "";
  const list = candidates.map(c=>`${c.symbol}:rank#${c.rank||"?"} 24h=${c.change24h?.toFixed(1)??"?"}% vol=$${((c.volume24h||0)/1e6).toFixed(0)}M score=${c.score}`).join("\n");
  try {
    const d = await claudeCall([{role:"user",content:`Rank these coins for Bybit spot trading NOW. Momentum+volume+reputable. ${ctxNote}\nReturn ONLY JSON array:\n${list}`}],null,"Return ONLY a JSON array of symbol strings.");
    const txt = d.content?.find(b=>b.type==="text")?.text||"[]";
    const ranked = JSON.parse(txt.replace(/```json|```/g,"").trim());
    return ranked.map(s=>candidates.find(c=>c.symbol===s)).filter(Boolean);
  } catch { return candidates; }
}

module.exports = { getDecision, searchNews, quickScore, rankCandidates };
