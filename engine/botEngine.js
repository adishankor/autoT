// ─────────────────────────────────────────────────────────────────────────────
// botEngine.js  —  Core trading loop
// v3: + WebSocket real-time SL (W1) + intelligent breakeven exit
// ─────────────────────────────────────────────────────────────────────────────
const bybit    = require("./bybit");
const ind      = require("./indicators");
const ob       = require("./orderbook");
const claude   = require("./claude");
const scanner  = require("./scanner");
const anns     = require("./announcements");
const reporter = require("./reporter");
const { DEFAULT_SETTINGS } = require("./settings");
const BybitTickerWS = require("./websocket");
const mktCtx   = require("./marketContext");

const FEE = 0.001; // 0.1% per side → 0.2% round trip

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  running: false,
  phase:   "idle",
  settings: { ...DEFAULT_SETTINGS },

  portfolioUSDT: 0,
  startBalance:  0,
  bdtRate:       120,

  position:      null,
  pendingRecovery: null,

  candidates:    [],
  activeCoin:    null,
  scanCount:     0,
  lastScan:      null,
  nextScan:      null,

  competitorSignals: {},

  paper: { usdt:0, coinQty:0, coinSymbol:null },
  logs:  [],

  // WebSocket live price for open position
  wsPrice:       null,  // latest price from WS tick
  wsConnected:   false,
  wsTickCount:   0,

  // Market context — refreshed every scan
  marketCtx:     null,
};

// ── WebSocket instance ────────────────────────────────────────────────────────
const ws = new BybitTickerWS({
  onTick: (symbol, price, data) => {
    state.wsPrice     = price;
    state.wsConnected = true;
    state.wsTickCount++;

    // Real-time trailing SL check — runs every tick (100-200ms)
    if (state.position?.symbol === symbol) {
      const { shouldSell, reason, pnlPct } = evalTrailSL(state.position, price, state.settings);
      if (shouldSell) {
        log(`⚡ [WS] ${reason} | PnL:${pnlPct.toFixed(3)}% — selling NOW`, "success");
        executeSell(reason).catch(e => log(`❌ WS sell error: ${e.message}`, "error"));
      }
    }
  },
  onLog: (msg, type) => log(`[WS] ${msg}`, type)
});

let scanTimer = null;
let bdtTimer  = null;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, type="info") {
  const e = { ts:new Date().toISOString(), t:new Date().toLocaleTimeString(), msg, type };
  state.logs = [e,...state.logs].slice(0,600);
  console.log(`[${e.t}][${type.toUpperCase()}] ${msg}`);
}

// ── BDT rate ──────────────────────────────────────────────────────────────────
async function refreshBDT() {
  try {
    const fetch=require("node-fetch");
    const r=await fetch("https://api.exchangerate-api.com/v4/latest/USD",{timeout:5000});
    state.bdtRate=(await r.json()).rates?.BDT||120;
    log(`💱 BDT: 1 USD = ${state.bdtRate.toFixed(2)} BDT`);
  } catch { log("⚠️ BDT refresh failed","warn"); }
}

// ── Portfolio sync ────────────────────────────────────────────────────────────
async function syncPortfolio() {
  if (state.settings.paperMode) {
    let val = state.paper.usdt;
    if (state.position) {
      try {
        const tk = await bybit.ticker(state.position.symbol);
        val += state.paper.coinQty * parseFloat(tk.list?.[0]?.lastPrice||state.position.entryPrice);
      } catch {}
    }
    state.portfolioUSDT = val;
    return;
  }
  try {
    const { totalUSD, usdtBal } = await bybit.getBalances();
    state.portfolioUSDT = totalUSD || usdtBal;
  } catch(e) { log("⚠️ Portfolio sync: "+e.message,"warn"); }
}

// ── Trailing SL evaluator ─────────────────────────────────────────────────────
function evalTrailSL(pos, currentPrice, s) {
  const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
  pos.peakPnlPct = Math.max(pos.peakPnlPct||0, pnlPct);
  pos.pnlPct = pnlPct;

  const breakEven = pos.entryPrice * (1 + FEE*2 + 0.001);
  let newSL = pos.trailingSL, shouldSell=false, reason=null;

  // Rule 1: pnl >= sl1TriggerPct → lock SL at +sl1LockPct
  if (pos.peakPnlPct >= s.sl1TriggerPct && pos.peakPnlPct < s.sl2TriggerPct) {
    const sl1 = pos.entryPrice * (1 + s.sl1LockPct/100);
    if (!newSL||sl1>newSL) { newSL=sl1; reason=`SL locked +${s.sl1LockPct}%`; }
    if (currentPrice<=newSL) { shouldSell=true; reason=`SL hit +${s.sl1LockPct}%`; }
  }
  // Rule 2: pnl >= sl2TriggerPct → trailing SL = peakPnl - sl2TrailPct
  if (pos.peakPnlPct >= s.sl2TriggerPct) {
    const trailPct = pos.peakPnlPct - s.sl2TrailPct;
    const trailSL  = pos.entryPrice * (1 + trailPct/100);
    if (!newSL||trailSL>newSL) { newSL=trailSL; reason=`Trailing SL @+${trailPct.toFixed(2)}%`; }
    if (currentPrice<=newSL) { shouldSell=true; reason=`Trail SL triggered @+${trailPct.toFixed(2)}%`; }
  }
  // STRICT: SL can never go below break-even (zero-loss protection)
  if (newSL && newSL<breakEven) newSL = breakEven;
  pos.trailingSL = newSL;
  return { shouldSell, reason, pnlPct, peakPnlPct:pos.peakPnlPct, newSL };
}

// ── Intelligent Breakeven Evaluator ──────────────────────────────────────────
// Called every scan when a position is open.
// Evaluates 10 signals. If enough fire AND price is still near/above entry,
// exits cleanly at breakeven rather than waiting for a bigger loss.
// This is NOT a loss exit — it's an intelligent "I was wrong, get out at 0%" exit.
function evalBreakeven(pos, currentInd, currentOB, currentMTF, s) {
  if (!s.breakevenEnabled || !pos) return { shouldExit:false };

  const currentPrice = currentInd?.price || state.wsPrice || pos.entryPrice;
  const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;
  const heldMinutes = (Date.now() - pos.entryTime) / 60000;
  const breakEvenPrice = pos.entryPrice * (1 + FEE * 2 + 0.001);

  // Gate 1: Only trigger if held long enough (avoid panicking on normal noise)
  if (heldMinutes < s.breakevenMinHeldMinutes) {
    return { shouldExit:false, reason:`Held only ${heldMinutes.toFixed(1)}min < min ${s.breakevenMinHeldMinutes}min` };
  }

  // Gate 2: Only trigger if price is still at or above breakeven
  // If we're already below breakeven, zero-loss rule takes over instead
  if (currentPrice < breakEvenPrice) {
    return { shouldExit:false, reason:`Price $${currentPrice.toFixed(6)} below breakeven $${breakEvenPrice.toFixed(6)} — zero-loss rule holds` };
  }

  // Gate 3: Only trigger if pnl is still small (not already winning big)
  if (pnlPct > s.breakevenMaxPnlPct) {
    return { shouldExit:false, reason:`PnL ${pnlPct.toFixed(3)}% > max threshold ${s.breakevenMaxPnlPct}% — in profit, don't disturb` };
  }

  // ── Time-based SL tightening ─────────────────────────────────────────────
  // If held longer than timeSLMinutes and pnl < timeSLMinPnlPct, lower threshold
  let effectiveRequired = s.breakevenMinBearishSignals;
  if (s.timeSLEnabled && heldMinutes >= (s.timeSLMinutes || 30)) {
    if (pnlPct < (s.timeSLMinPnlPct || 0.5)) {
      effectiveRequired = Math.max(2, effectiveRequired - (s.timeSLReduceSignals || 2));
      // Gate 3 also relaxed when time-based
    }
  }

  // ── Count bearish signals ────────────────────────────────────────────────
  const signals = [];
  const I = currentInd || {};

  // Signal 1: MACD flipped bearish since entry (was bullish at entry if bot entered)
  if (I.macd && !I.macd.bullish) {
    signals.push("MACD_BEARISH");
  }

  // Signal 2: RSI declining — current RSI lower than entry RSI by meaningful amount
  if (I.rsi !== null && pos.entryRsi && (pos.entryRsi - I.rsi) > 5) {
    signals.push(`RSI_DECLINING(entry:${pos.entryRsi?.toFixed(1)}→now:${I.rsi?.toFixed(1)})`);
  }

  // Signal 3: RSI entering bearish zone
  if (I.rsi !== null && I.rsi < 45 && I.rsi < (pos.entryRsi || 50)) {
    signals.push("RSI_WEAKENING");
  }

  // Signal 4: MTF agreement deteriorated
  if (currentMTF && pos.entryMtfBullCount !== undefined) {
    if (currentMTF.bullCount < pos.entryMtfBullCount) {
      signals.push(`MTF_DROPPED(entry:${pos.entryMtfBullCount}→now:${currentMTF.bullCount}/4)`);
    }
    if (currentMTF.bearish) {
      signals.push("MTF_MAJORITY_BEARISH");
    }
  }

  // Signal 5: Volume drying up (momentum gone)
  if (I.volRatio !== null && I.volRatio < 0.8) {
    signals.push(`VOL_DRYING(${I.volRatio?.toFixed(2)}x)`);
  }

  // Signal 6: Bearish RSI divergence appeared since entry
  if (I.divergence?.bearish && I.divergence.bearish.barsSince <= 5) {
    const strength = I.divergence.bearish.strength;
    signals.push(`BEARISH_DIV_${strength}`);
    // Strong bearish divergence counts double
    if (strength === "STRONG") signals.push("BEARISH_DIV_STRONG_CONFIRM");
  }

  // Signal 7: EMA9 crossed below EMA20 (momentum shift down)
  if (I.ema9 && I.ema20 && I.ema9 < I.ema20) {
    if (pos.entryEma9AboveEma20) { // was above at entry
      signals.push("EMA9_CROSSED_BELOW_EMA20");
    }
  }

  // Signal 8: Price declining for last 3 candles consecutively
  if (I.candles && I.candles.length >= 4) {
    const last4 = I.candles.slice(-4).map(c => c.c);
    const allDown = last4[3] < last4[2] && last4[2] < last4[1] && last4[1] < last4[0];
    if (allDown) signals.push("3_CONSECUTIVE_RED_CANDLES");
  }

  // Signal 9: BB position below midline AND declining
  if (I.bb && I.bb.pos < 0.4) {
    signals.push(`BB_BELOW_MID(pos:${(I.bb.pos*100).toFixed(0)}%)`);
  }

  // Signal 10: Order book flipped to sell pressure
  if (currentOB?.available && currentOB.bookBias === "BEARISH" || currentOB?.pressureRatio < 0.85) {
    signals.push(`OB_SELL_PRESSURE(ratio:${currentOB?.pressureRatio?.toFixed(2)})`);
  }

  const bearishCount = signals.length;
  const shouldExit = bearishCount >= effectiveRequired;

  return {
    shouldExit,
    bearishCount,
    required: effectiveRequired,
    signals,
    pnlPct,
    currentPrice,
    breakEvenPrice,
    timeTightened: effectiveRequired < s.breakevenMinBearishSignals,
    reason: shouldExit
      ? `Intelligent breakeven: ${bearishCount}/${effectiveRequired} signals${effectiveRequired < s.breakevenMinBearishSignals ? " [time-tightened]" : ""} — [${signals.slice(0,4).join(", ")}]`
      : `Only ${bearishCount}/${effectiveRequired} signals — holding`
  };
}

// ── Execute BUY ───────────────────────────────────────────────────────────────
async function executeBuy(symbol, price, sizePct, confidence, decision) {
  const s = state.settings;

  // ── Paper mode: always use live ticker price, not stale kline close ──────
  let execPrice = price;
  if (s.paperMode) {
    try {
      const tk = await bybit.ticker(symbol);
      const livePrice = parseFloat(tk.list?.[0]?.lastPrice || price);
      if (livePrice > 0) {
        if (Math.abs(livePrice - price) / price > 0.005) { // >0.5% deviation — log it
          log(`📌 Paper BUY price adjusted: kline $${price.toFixed(6)} → live $${livePrice.toFixed(6)}`);
        }
        execPrice = livePrice;
      }
    } catch { /* fallback to kline price */ }
  }

  const available = s.paperMode ? state.paper.usdt : (await bybit.getBalances()).usdtBal;
  const spend = available * (sizePct/100);
  if (spend < 1) { log("⚠️ Insufficient balance to trade","warn"); return false; }
  const qty = spend / execPrice;

  if (s.paperMode) {
    state.paper.usdt -= spend;
    state.paper.coinQty = qty;
    state.paper.coinSymbol = symbol;
  } else {
    const order = await bybit.placeOrder(symbol, "Buy", qty.toFixed(6));
    log("📋 Bybit BUY order: "+JSON.stringify(order));
  }

  state.position = {
    symbol, entryPrice:execPrice, entryTime:Date.now(),
    qty, spendUSDT:spend, fees:spend*FEE, confidence,
    pnlPct:0, peakPnlPct:0, trailingSL:null,
    urgency:decision.urgency, timeframe:decision.timeframe,
    id:Date.now().toString(),
    entryRsi:          decision._entryRsi          || null,
    entryMtfBullCount: decision._entryMtfBullCount || null,
    entryEma9AboveEma20: decision._entryEma9AboveEma20 || false,
  };
  reporter.recordTrade({symbol, side:"BUY", price:execPrice, qty, spendUSDT:spend, confidence});
  log(`✅ BUY ${qty.toFixed(6)} ${symbol.replace("USDT","")} @ $${execPrice.toFixed(6)} | Spend:$${spend.toFixed(2)} | Conf:${confidence}% | ${s.paperMode?"PAPER — live price":"LIVE"}`, "success");

  // ── W1: Start WebSocket real-time monitoring ──────────────────────────────
  ws.subscribe(symbol);
  log(`🔌 WebSocket subscribed to ${symbol} — real-time SL monitoring active`);

  return true;
}

// ── Execute SELL ──────────────────────────────────────────────────────────────
async function executeSell(reason, forceOverride=false, allowLoss=false) {
  if (!state.position) return { ok:false };
  const pos = state.position;
  const s   = state.settings;

  // Always fetch live ticker price for both paper and live modes
  // Paper: use live price (accurate simulation)
  // Live: use live price (actual fill reference)
  // WS price is most current — use if available and fresh
  let currentPrice = state.wsPrice || pos.entryPrice;
  try {
    const tk = await bybit.ticker(pos.symbol);
    const tickerPrice = parseFloat(tk.list?.[0]?.lastPrice || 0);
    if (tickerPrice > 0) {
      // Prefer ticker over WS if WS is stale (no ticks recently)
      currentPrice = tickerPrice;
    }
  } catch {}

  // Paper mode: simulate realistic slippage (0.05% on majors, 0.15% on alts)
  // This makes paper results more honest — real fills are never at exact price
  if (s.paperMode) {
    const isMajor = ["BTCUSDT","ETHUSDT","BNBUSDT"].includes(pos.symbol);
    const slippagePct = isMajor ? 0.0005 : 0.0015; // 0.05% or 0.15%
    currentPrice = currentPrice * (1 - slippagePct); // sell slippage is negative
    log(`📌 Paper SELL with ${(slippagePct*100).toFixed(2)}% slippage simulation`);
  }

  const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice * 100;

  // Zero-loss guard
  if (pnlPct < 0 && s.zeroLossRule && !forceOverride && !allowLoss) {
    log(`🔒 HOLD — PnL ${pnlPct.toFixed(3)}% negative. Zero-loss active.`,"warn");
    return { ok:false, pnlPct };
  }

  const gross  = pos.qty * currentPrice;
  const fees   = gross * FEE;
  const net    = gross - fees;
  const pnlUSD = net - pos.spendUSDT;

  if (s.paperMode) {
    state.paper.usdt += net;
    state.paper.coinQty = 0;
    state.paper.coinSymbol = null;
  } else {
    await bybit.placeOrder(pos.symbol, "Sell", pos.qty.toFixed(6));
    log("📋 Bybit SELL order placed");
  }

  reporter.recordTrade({
    symbol:pos.symbol, side:"SELL", price:currentPrice, qty:pos.qty,
    pnlUSD, pnlPct, exitReason:reason+(forceOverride?" [DUMP]":allowLoss?" [UPGRADE]":""),
    entryPrice:pos.entryPrice,
    heldMinutes:Math.round((Date.now()-pos.entryTime)/60000)
  });

  const tag = forceOverride?"🚨 DUMP":allowLoss?"🔀 UPGRADE EXIT":"💰 SELL";
  log(`${tag} ${pos.symbol.replace("USDT","")} @ $${currentPrice.toFixed(6)} | PnL:${pnlPct.toFixed(3)}% ($${pnlUSD.toFixed(2)}) | ${reason}`,"success");
  state.position = null;
  state.wsPrice  = null;

  // ── W1: Stop WebSocket — no position to monitor ───────────────────────────
  ws.unsubscribe();

  return { ok:true, pnlPct, pnlUSD };
}

// ── Signal Upgrade evaluator ─────────────────────────────────────────────────
// Called when we have an open position and find a strong competitor signal.
// Returns whether we should upgrade, and the allowed exit window.
function evalSignalUpgrade(pos, competitorConfidence, s) {
  if (!s.upgradeEnabled || !pos) return { shouldUpgrade:false };

  const confidenceDelta = competitorConfidence - pos.confidence;
  if (confidenceDelta < s.upgradeMinConfidenceDelta) return { shouldUpgrade:false, reason:`Delta ${confidenceDelta.toFixed(0)}% < required ${s.upgradeMinConfidenceDelta}%` };

  // Current PnL must be >= -upgradeMaxLossPct% to allow exit
  const currentPnl = pos.pnlPct || 0;
  if (currentPnl < -s.upgradeMaxLossPct) {
    return { shouldUpgrade:false, reason:`PnL ${currentPnl.toFixed(3)}% below upgrade floor -${s.upgradeMaxLossPct}%` };
  }

  return {
    shouldUpgrade:  true,
    exitAllowed:    true,
    currentPnl,
    confidenceDelta,
    reason:`Upgrade: +${confidenceDelta.toFixed(0)}% confidence | Exit PnL:${currentPnl.toFixed(3)}%`
  };
}

// ── Effective min confidence (adjusted by regime + fear/greed) ───────────────
function effectiveMinConf(s, ctx) {
  let conf = s.minConfidence;
  // Bear day (market-wide): raise bar by setting
  if (s.regimeEnabled && ctx?.global?.regime === "BEAR_DAY") {
    conf += (s.bearDayConfidenceBoost || 5);
  }
  // BTC 1D bearish regime: raise by same amount (separate from bear day)
  if (s.regimeEnabled && ctx?.bearishMode && ctx?.global?.regime !== "BEAR_DAY") {
    conf += Math.round((s.bearDayConfidenceBoost || 5) * 0.6); // slightly less aggressive than full bear day
  }
  // Extreme fear: contrarian boost
  if (s.fearGreedEnabled && (ctx?.fearGreed?.value||50) < 20) {
    conf -= (s.extremeFearConfidenceBoost || 3);
  }
  // High funding rate (overleveraged longs): raise bar
  if (s.fundingGateEnabled && (ctx?.funding?.ratePct||0) > (s.fundingMaxRatePct||0.12)) {
    conf += 5;
  }
  return Math.max(50, Math.min(95, Math.round(conf)));
}

// ── Fetch all data for a coin — now includes 1D timeframe ────────────────────
async function fetchCoinData(symbol) {
  const [k15,k5,k60,k240,k1d,obData] = await Promise.all([
    bybit.klines(symbol,"15",80),
    bybit.klines(symbol,"5", 40),
    bybit.klines(symbol,"60",60),
    bybit.klines(symbol,"240",30),
    bybit.klines(symbol,"D", 30),   // Day candles — trend context
    ob.getOrderbookAnalysis(symbol,0).catch(()=>null),
  ]);
  const i15 = ind.calcAll(k15);
  if (!i15) return null;
  const multiTF = { "5m":ind.calcAll(k5), "15m":i15, "1h":ind.calcAll(k60), "4h":ind.calcAll(k240), "1d":ind.calcAll(k1d) };
  const mtfAgreement = ind.mtfAgreement(multiTF, state.settings.mtfRequired);
  const obFull = await ob.getOrderbookAnalysis(symbol, i15.price).catch(()=>({available:false}));
  return { i15, multiTF, mtfAgreement, ob:obFull };
}

// ── Quick scan: tech score only (no news) — for upgrade comparison ─────────────
async function quickScanCoin(symbol) {
  try {
    const [k15, obData] = await Promise.all([
      bybit.klines(symbol,"15",60),
      ob.getOrderbookAnalysis(symbol,0).catch(()=>null)
    ]);
    const i15 = ind.calcAll(k15);
    if (!i15) return null;
    const multiTF = { "5m":null, "15m":i15, "1h":null, "4h":null };
    const mtfAgreement = ind.mtfAgreement(multiTF, 1); // 1 TF is enough for quick check
    const obFull = await ob.getOrderbookAnalysis(symbol, i15.price).catch(()=>({available:false}));
    const techScore = claude.quickScore(i15, mtfAgreement, obFull);
    return { symbol, techScore, i15, mtfAgreement, ob:obFull };
  } catch { return null; }
}

// ── Analyze one coin (full — with news) ──────────────────────────────────────
async function analyzeCoin(candidate, allAnnouncements) {
  const { symbol } = candidate;
  state.activeCoin = symbol;
  const s = state.settings;

  try {
    const data = await fetchCoinData(symbol);
    if (!data) { log(`⚠️ No data for ${symbol}`,"warn"); return null; }
    const { i15, multiTF, mtfAgreement, ob:obData } = data;

    // Coin-specific announcements
    const coinAnns = allAnnouncements.filter(a=>
      a.coins?.includes(symbol) || a.title?.toUpperCase().includes(symbol.replace("USDT",""))
    );

    // ── If THIS is the open position: check trailing SL ──────────────────────
    if (state.position?.symbol === symbol) {
      // Priority: WS live tick > live ticker > kline close
      // This ensures paper mode PnL reflects actual market price
      const livePrice = state.wsConnected && state.wsPrice
        ? state.wsPrice
        : i15.price; // i15.price is already fetched fresh from klines
      const { shouldSell, reason, pnlPct } = evalTrailSL(state.position, livePrice, s);
      if (shouldSell) {
        log(`🎯 ${reason} | PnL:${pnlPct.toFixed(3)}%`,"success");
        await executeSell(reason);
        return null;
      }

      // Max hold time check
      if (s.maxHoldHours > 0) {
        const heldH = (Date.now()-state.position.entryTime)/3600000;
        if (heldH >= s.maxHoldHours) { log(`⏱️ Max hold ${s.maxHoldHours}h — selling`,"warn"); await executeSell("Max hold time"); return null; }
      }

      // ── Intelligent Breakeven Check ────────────────────────────────────────
      if (s.breakevenEnabled) {
        const beResult = evalBreakeven(state.position, i15, obData, mtfAgreement, s);
        if (beResult.shouldExit) {
          log(`🧠 INTELLIGENT BREAKEVEN: ${beResult.reason}`, "warn");
          log(`   Signals: ${beResult.signals.join(" | ")}`, "info");
          // executeSell with allowLoss=false but this IS above breakeven so it will succeed
          const result = await executeSell(`Intelligent breakeven exit: ${beResult.signals.slice(0,3).join(",")}`, false, false);
          if (result.ok) {
            log(`✅ Breakeven exit successful — PnL:${beResult.pnlPct.toFixed(3)}% | Capital protected`, "success");
          }
          return null;
        } else {
          log(`🧠 Breakeven check: ${beResult.bearishCount}/${beResult.required} bearish signals — ${beResult.reason}`, "info");
        }
      }
    }

    // ── MTF agreement gate ────────────────────────────────────────────────────
    if (!state.position && !mtfAgreement.bullish) {
      log(`⏸️ ${symbol} MTF: ${mtfAgreement.bullCount}/4 bullish — need ${s.mtfRequired}. Skip.`);
      return { action:"WAIT", confidence:0, mtfPassed:false };
    }

    // ── Volume gate ───────────────────────────────────────────────────────────
    if (!state.position && (i15.volRatio||0) < s.minVolRatio) {
      log(`⏸️ ${symbol} Vol=${i15.volRatio?.toFixed(2)} < ${s.minVolRatio} — skip`);
      return { action:"WAIT", confidence:0 };
    }

    // ── Bearish divergence gate ───────────────────────────────────────────────
    if (!state.position && i15.divergence?.bearish?.strength === "STRONG") {
      log(`⏸️ ${symbol} STRONG bearish divergence — skip entry`,"warn");
      return { action:"WAIT", confidence:0 };
    }

    // ── BTC correlation gate ──────────────────────────────────────────────────
    const ctx = state.marketCtx;
    if (!state.position && s.btcGateEnabled && ctx?.btc) {
      if (!ctx.btc.allowAltEntries) {
        log(`⛔ BTC GATE: ${ctx.btc.gateReason} — blocking ${symbol} entry`,"warn");
        return { action:"WAIT", confidence:0 };
      }
      if ((ctx.btc.chg15m || 0) < -(s.btcMaxDump15mPct || 2.0)) {
        log(`⛔ BTC DUMP ${ctx.btc.chg15m?.toFixed(2)}% — blocking all entries`,"warn");
        return { action:"WAIT", confidence:0 };
      }
    }

    // ── Liquidity gate ────────────────────────────────────────────────────────
    if (!state.position && s.liquidityGateEnabled && obData) {
      const liq = mktCtx.checkLiquidity(obData, state.portfolioUSDT * 0.9, i15.price);
      if (!liq.pass) {
        log(`⏸️ ${symbol} LIQUIDITY GATE: ${liq.reason}`,"warn");
        return { action:"WAIT", confidence:0 };
      }
    }

    // ── News + AI decision ────────────────────────────────────────────────────
    state.phase = "news";
    const news = await claude.searchNews(symbol).catch(()=>"News unavailable");

    state.phase = "ai";
    const decision = await claude.getDecision({
      symbol, ind:i15, multiTF, mtf:mtfAgreement, ob:obData,
      news, anns:coinAnns, settings:s,
      portfolioUSDT: state.portfolioUSDT,
      position: state.position?.symbol===symbol ? state.position : null,
      pendingRecovery: state.pendingRecovery,
      marketCtx: ctx,
    });

    reporter.recordScan(symbol, decision);
    log(`🤖 ${symbol} → ${decision.action} | Conf:${decision.confidence}% | MTF:${mtfAgreement.bullCount}/${mtfAgreement.totalTFs||5}${decision.mtfPassed?"✅":"❌"} | OB:${decision.obBias||"?"} | ${decision.reasoning?.slice(0,55)}`
      , decision.action==="WAIT"?"info":"success");

    // ── BUY entry ─────────────────────────────────────────────────────────────
    if (!state.position && decision.action==="BUY" && decision.confidence>=effectiveMinConf(s,ctx) && decision.mtfPassed!==false) {
      // Kelly position sizing — conf 75→70%, 85→85%, 95+→100%, scaled by session
      const session = ctx?.session || mktCtx.getSession();
      let sizePct = s.useKellySizing
        ? mktCtx.kellySize(decision.confidence, session.sizeMult)
        : s.positionSizePct;

      // Bear day penalty (BEAR_DAY = market cap dropped >3% in 24h)
      if (s.regimeEnabled && (ctx?.global?.regime === "BEAR_DAY" || ctx?.bearishMode)) {
        const penalty = ctx?.global?.regime === "BEAR_DAY" ? (s.bearDaySizePenalty||0.6) : 0.7;
        sizePct = Math.round(sizePct * penalty);
        log(`📉 ${ctx?.global?.regime==="BEAR_DAY"?"Bear day":"BTC bearish regime"} — size reduced to ${sizePct}%`,"warn");
      }
      // Extreme greed size cap
      if (ctx?.fearGreed?.value > 80 && s.fearGreedEnabled) {
        sizePct = Math.min(sizePct, s.extremeGreedMaxSizePct || 60);
        log(`😱 Extreme greed ${ctx.fearGreed.value} — size capped at ${sizePct}%`,"warn");
      }

      decision._entryRsi            = i15.rsi;
      decision._entryMtfBullCount   = mtfAgreement.bullCount;
      decision._entryEma9AboveEma20 = (i15.ema9 > i15.ema20);
      state.phase = "exec";
      await executeBuy(symbol, i15.price, sizePct, decision.confidence, decision);
      if (state.pendingRecovery) {
        log(`🔄 Recovery target: need +${state.pendingRecovery.boostTargetPct.toFixed(2)}% gross`,"warn");
      }
    }

    // ── SELL (profit) ─────────────────────────────────────────────────────────
    if (state.position?.symbol===symbol && decision.action==="SELL_PROFIT") {
      state.phase = "exec";
      const result = await executeSell("AI profit target");
      if (result.ok) state.pendingRecovery = null; // clean recovery if profitable
    }

    // ── Trailing SL update from AI ────────────────────────────────────────────
    if (state.position?.symbol===symbol && decision.trailingSLUpdate && decision.trailingSLUpdate>(state.position.trailingSL||0)) {
      state.position.trailingSL = decision.trailingSLUpdate;
      log(`📌 Trailing SL → $${decision.trailingSLUpdate.toFixed(6)}`);
    }

    return decision;
  } catch(e) { log(`❌ ${symbol}: ${e.message}`,"error"); return null; }
}

// ── Background competitor scan (while in a position) ─────────────────────────
async function scanCompetitors(allAnnouncements) {
  if (!state.position || !state.settings.upgradeEnabled) return;
  const s = state.settings;
  const pos = state.position;

  log(`🔍 Scanning competitors for stronger signal (position: ${pos.symbol} PnL:${pos.pnlPct?.toFixed(3)}%)...`);

  let bestCompetitor = null;
  let bestScore = pos.confidence; // current position's entry confidence is baseline

  for (const c of state.candidates) {
    if (c.symbol === pos.symbol) continue; // skip current position coin
    if (!state.running) break;

    try {
      const quick = await quickScanCoin(c.symbol);
      if (!quick) continue;

      // Record this competitor's score
      state.competitorSignals[c.symbol] = {
        techScore: quick.techScore, ts: new Date().toISOString(),
        mtfBullCount: quick.mtfAgreement?.bullCount||0,
        obBias: quick.ob?.bookBias||"NEUTRAL"
      };

      log(`  📊 ${c.symbol} techScore:${quick.techScore} MTF:${quick.mtfAgreement?.bullCount}/4 OB:${quick.ob?.bookBias||"?"}`, "info");

      if (quick.techScore > bestScore + 5) { // must beat by at least 5 points to be interesting
        bestScore = quick.techScore;
        bestCompetitor = { ...c, ...quick };
      }

      await new Promise(r=>setTimeout(r,2000)); // 2s gap between coin scans
    } catch {}
  }

  if (!bestCompetitor) {
    log(`✅ No stronger competitor found — holding ${pos.symbol}`);
    return;
  }

  // Evaluate upgrade eligibility
  const upgrade = evalSignalUpgrade(pos, bestCompetitor.techScore, s);
  if (!upgrade.shouldUpgrade) {
    log(`ℹ️ ${bestCompetitor.symbol} score:${bestCompetitor.techScore} — ${upgrade.reason}`);
    return;
  }

  // UPGRADE — do full AI analysis on the competitor before committing
  log(`🔀 UPGRADE CANDIDATE: ${bestCompetitor.symbol} techScore:${bestCompetitor.techScore} | ${upgrade.reason}`,"warn");

  try {
    const coinAnns = allAnnouncements.filter(a=>
      a.coins?.includes(bestCompetitor.symbol) || a.title?.toUpperCase().includes(bestCompetitor.symbol.replace("USDT",""))
    );
    state.phase = "news";
    const news = await claude.searchNews(bestCompetitor.symbol).catch(()=>"News unavailable");
    state.phase = "ai";
    const decision = await claude.getDecision({
      symbol: bestCompetitor.symbol,
      ind: bestCompetitor.i15,
      multiTF: bestCompetitor.mtfAgreement ? { "15m":bestCompetitor.i15 } : {},
      mtf: bestCompetitor.mtfAgreement,
      ob: bestCompetitor.ob,
      news, anns:coinAnns, settings:s,
      portfolioUSDT: state.portfolioUSDT,
      position: null, // no position on competitor
      pendingRecovery: null
    });

    log(`🤖 Competitor ${bestCompetitor.symbol}: ${decision.action} | Conf:${decision.confidence}%`,"success");

    // Final gate: competitor needs full confidence threshold + delta
    const finalDelta = decision.confidence - pos.confidence;
    if (decision.action!=="BUY" || decision.confidence<s.minConfidence || finalDelta<s.upgradeMinConfidenceDelta) {
      log(`ℹ️ Upgrade declined: ${bestCompetitor.symbol} Conf:${decision.confidence}% delta:${finalDelta.toFixed(0)}% < required ${s.upgradeMinConfidenceDelta}%`);
      return;
    }

    // ── EXECUTE UPGRADE ───────────────────────────────────────────────────────
    log(`🔀 EXECUTING UPGRADE: Exit ${pos.symbol} → Enter ${bestCompetitor.symbol} | ConfDelta:+${finalDelta.toFixed(0)}%`,"warn");

    // Exit current position (allow up to -upgradeMaxLossPct% loss)
    const exitResult = await executeSell(`Signal upgrade → ${bestCompetitor.symbol}`, false, true);
    if (!exitResult.ok) { log(`⚠️ Upgrade exit failed or blocked`,"warn"); return; }

    // Track pending recovery if we exited at a loss
    if (exitResult.pnlPct < 0) {
      const lossAbs   = Math.abs(exitResult.pnlPct);
      const lossUSD   = Math.abs(exitResult.pnlUSD||0);
      const boostTarget = (s.minGrossProfitPct||1.2) + lossAbs + FEE*200; // recover loss + normal target
      state.pendingRecovery = {
        fromSymbol:  pos.symbol,
        lossPct:     exitResult.pnlPct,
        lossUSD,
        boostTargetPct: boostTarget,
        ts:          new Date().toISOString()
      };
      log(`📋 Recovery set: need +${boostTarget.toFixed(2)}% gross on next trade to recover -${lossAbs.toFixed(3)}% ($${lossUSD.toFixed(2)})`,"warn");
    } else {
      state.pendingRecovery = null; // exited at profit or breakeven, no recovery needed
    }

    // Enter the new position
    state.phase = "exec";
    await executeBuy(bestCompetitor.symbol, bestCompetitor.i15.price, decision.positionSizePct||s.positionSizePct, decision.confidence, decision);

  } catch(e) { log(`❌ Upgrade execution error: ${e.message}`,"error"); }
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function scanLoop() {
  if (!state.running) return;
  state.phase = "scanning";
  state.lastScan = new Date().toISOString();
  state.scanCount++;

  try {
    await syncPortfolio();
    reporter.setBalance(state.portfolioUSDT, state.bdtRate);

    // Refresh market context
    state.phase = "context";
    try {
      state.marketCtx = await mktCtx.getFullContext();
      const ctx = state.marketCtx;
      log(`🌍 BTC:${ctx.btc?.healthScore||"?"}(${ctx.btc?.trend1d||"?"}1D) | F&G:${ctx.fearGreed?.value||"?"}(${ctx.fearGreed?.label||"?"}) | Funding:${ctx.funding?.ratePct?.toFixed(4)||"?"}%(${ctx.funding?.sourcesAvailable||0}src) | ${ctx.session?.session||"?"}(×${ctx.session?.sizeMult||1}) | Gate:${ctx.allowEntry?"✅":"🚫 "+ctx.gateReason}${ctx.bearishMode?" ⚠️BEARISH_REGIME":""}`);
    } catch(e) { log("⚠️ Market context failed: "+e.message,"warn"); }

    // Refresh candidate list periodically
    if (state.scanCount===1 || state.scanCount%state.settings.refreshCandidatesEvery===0) {
      log("🔍 Refreshing coin candidates (stables excluded)...");
      const raw = await scanner.selectCandidates(state.settings.maxCandidates);
      state.candidates = await claude.rankCandidates(raw, state.marketCtx).catch(()=>raw);
      log(`📋 Watchlist: ${state.candidates.map(c=>c.symbol).join(", ")}`);
    }

    // Announcements
    const allAnns = await anns.getAll(state.candidates.map(c=>c.symbol));
    allAnns.filter(a=>a.isNew&&a.score>=state.settings.minAnnouncementScore).forEach(a=>{
      log(`📢 [${a.source}] ${a.title} (boost:${a.score})`,"warn");
      reporter.recordAnn(a);
    });

    if (state.position) {
      // ── OPEN POSITION: full analysis on the open coin ────────────────────
      await analyzeCoin({ symbol:state.position.symbol }, allAnns);
      // Competitor scan every other cycle
      if (state.scanCount%2===0 && state.settings.upgradeEnabled) {
        await scanCompetitors(allAnns);
      }
    } else {
      // ── NO POSITION: scan all candidates until one is entered ─────────────
      for (const c of state.candidates) {
        if (!state.running) break;
        await analyzeCoin(c, allAnns);
        if (state.position) break;
        await new Promise(r=>setTimeout(r,3000)); // 3s between coins
      }
    }

  } catch(e) { log(`❌ Scan error: ${e.message}`,"error"); }

  const iv = (state.position
    ? state.settings.positionScanSec   // use slower interval when holding position
    : state.settings.scanIntervalSec   // use faster interval when hunting for entry
  ) * 1000;

  state.nextScan = new Date(Date.now()+iv).toISOString();
  state.phase = state.position ? "monitoring" : "waiting";
}

// ── Controls ──────────────────────────────────────────────────────────────────
async function start() {
  if (state.running) return;
  const s = state.settings;
  if (s.paperMode) {
    state.paper.usdt    = s.initialCapital;
    state.portfolioUSDT = s.initialCapital;
    state.startBalance  = s.initialCapital;
    log(`📋 PAPER MODE — $${s.initialCapital} virtual USDT | Live prices: ✅`,"success");
  } else {
    await syncPortfolio();
    state.startBalance = state.portfolioUSDT;
    log(`⚡ LIVE MODE — $${state.portfolioUSDT.toFixed(2)} USDT`,"success");
  }

  state.running   = true;
  state.scanCount = 0;
  await refreshBDT();
  log("🚀 Bot started | scan:"+s.scanIntervalSec+"s no-position | "+s.positionScanSec+"s position | stables excluded ✅","success");

  // Start scan — use dynamic interval based on position state
  const firstInterval = s.scanIntervalSec * 1000;
  scanLoop();
  // Timer restarts itself dynamically at end of each scanLoop via reschedule
  scheduleNextScan();

  bdtTimer = setInterval(refreshBDT, 6*60*60*1000);

  const cron = require("node-cron");
  cron.schedule("0 0 * * *", ()=>{
    const r = reporter.generateSummary(state.portfolioUSDT);
    log(`📊 Daily report — ${r.summary?.totalTrades} trades | P&L:$${r.summary?.totalPnlUSD} | PF:${r.summary?.profitFactor} | WR:${r.summary?.winRate}%`,"success");
  }, { timezone:"UTC" });
}

function scheduleNextScan() {
  if (!state.running) return;
  const iv = (state.position
    ? state.settings.positionScanSec
    : state.settings.scanIntervalSec
  ) * 1000;
  scanTimer = setTimeout(async ()=>{
    await scanLoop();
    scheduleNextScan(); // reschedule after completion
  }, iv);
}

function stop() {
  state.running = false;
  clearTimeout(scanTimer);
  clearInterval(bdtTimer);
  ws.unsubscribe();
  state.phase = "idle";
  log("⏹️ Bot stopped","warn");
}

async function manualDump() {
  if (!state.position) throw new Error("No open position");
  log("🚨 MANUAL DUMP","warn");
  const r = await executeSell("Manual dump", true);
  if (!r.ok) throw new Error("Dump failed");
  state.pendingRecovery = null;
  return { ok:true };
}

function applySettings(newSettings) {
  Object.assign(state.settings, newSettings);
  log(`⚙️ Settings updated — scan:${state.settings.scanIntervalSec}s | position scan:${state.settings.positionScanSec}s`);
}

module.exports = { state, start, stop, manualDump, applySettings };
