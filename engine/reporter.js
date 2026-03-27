// ─────────────────────────────────────────────────────────────────────────────
// reporter.js  —  Daily report generation + profit factor tracking
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "../reports");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const todayKey = () => new Date().toISOString().slice(0, 10);

function load(date = todayKey()) {
  const f = path.join(DIR, `${date}.json`);
  if (!fs.existsSync(f)) return empty(date);
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return empty(date); }
}

function empty(date) {
  return { date, startBalance:0, endBalance:0, bdtRate:null, trades:[], scans:0, scanLog:[], announcements:[], summary:null };
}

function save(data) {
  fs.writeFileSync(path.join(DIR, `${data.date}.json`), JSON.stringify(data, null, 2));
}

// ── Record a trade (BUY or SELL) ─────────────────────────────────────────────
function recordTrade(trade) {
  const r = load();
  r.trades.push({ ...trade, ts: new Date().toISOString() });
  save(r);
}

// ── Record a scan result ──────────────────────────────────────────────────────
function recordScan(symbol, decision) {
  const r = load();
  r.scans = (r.scans || 0) + 1;
  r.scanLog = [...(r.scanLog || []).slice(-199), {
    ts: new Date().toISOString(), symbol,
    action: decision.action, confidence: decision.confidence,
    regime: decision.regimeAware
  }];
  save(r);
}

// ── Record an announcement ────────────────────────────────────────────────────
function recordAnn(ann) {
  const r = load();
  if (!(r.announcements || []).find(a => a.title === ann.title)) {
    r.announcements = [...(r.announcements || []), { ...ann, seenAt: new Date().toISOString() }];
    save(r);
  }
}

// ── Update balance ────────────────────────────────────────────────────────────
function setBalance(usdt, bdtRate) {
  const r = load();
  if (!r.startBalance || r.startBalance === 0) r.startBalance = usdt;
  r.endBalance = usdt;
  if (bdtRate) r.bdtRate = bdtRate;
  save(r);
}

// ── Generate full summary with profit factor ──────────────────────────────────
function generateSummary(portfolioUSDT) {
  const r = load();
  const closed = (r.trades || []).filter(t => t.side === "SELL");
  const wins   = closed.filter(t => t.pnlPct > 0);
  const losses = closed.filter(t => t.pnlPct <= 0);

  // ── Profit factor = gross profit / gross loss ─────────────────────────────
  const grossProfit = wins.reduce((s, t)   => s + Math.abs(t.pnlUSD || 0), 0);
  const grossLoss   = losses.reduce((s, t) => s + Math.abs(t.pnlUSD || 0), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  // ── Average hold time ─────────────────────────────────────────────────────
  const avgHoldMin = closed.length
    ? closed.reduce((s, t) => s + (t.heldMinutes || 0), 0) / closed.length
    : 0;

  // ── Avg win / avg loss ────────────────────────────────────────────────────
  const avgWinPct  = wins.length   ? wins.reduce((s,t)=>s+(t.pnlPct||0),0)/wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((s,t)=>s+(t.pnlPct||0),0)/losses.length : 0;

  // ── Best / worst trade ────────────────────────────────────────────────────
  const bestTrade  = closed.reduce((b,t) => (!b||t.pnlPct>b.pnlPct)?t:b, null);
  const worstTrade = closed.reduce((b,t) => (!b||t.pnlPct<b.pnlPct)?t:b, null);

  // ── Breakdown by coin ─────────────────────────────────────────────────────
  const byCoin = {};
  closed.forEach(t => {
    if (!byCoin[t.symbol]) byCoin[t.symbol] = { trades:0, pnlUSD:0, pnlPct:0, wins:0 };
    byCoin[t.symbol].trades++;
    byCoin[t.symbol].pnlUSD  += t.pnlUSD  || 0;
    byCoin[t.symbol].pnlPct  += t.pnlPct  || 0;
    if (t.pnlPct > 0) byCoin[t.symbol].wins++;
  });

  // ── Breakdown by exit reason ──────────────────────────────────────────────
  const byReason = {};
  closed.forEach(t => {
    const reason = t.exitReason?.split(":")[0]?.trim() || "Unknown";
    if (!byReason[reason]) byReason[reason] = { count:0, pnlUSD:0 };
    byReason[reason].count++;
    byReason[reason].pnlUSD += t.pnlUSD || 0;
  });

  // ── Total P&L ─────────────────────────────────────────────────────────────
  const totalPnlUSD = closed.reduce((s, t) => s + (t.pnlUSD || 0), 0);
  const winRate = closed.length ? (wins.length / closed.length * 100) : 0;

  r.summary = {
    // Core
    totalTrades:   closed.length,
    openTrades:    r.trades.filter(t => t.side === "BUY").length - closed.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       +winRate.toFixed(1),
    totalPnlUSD:   +totalPnlUSD.toFixed(2),
    totalPnlBDT:   r.bdtRate ? +(totalPnlUSD * r.bdtRate).toFixed(0) : null,

    // Professional metrics
    profitFactor:  +profitFactor.toFixed(3),
    // > 1.5 = good | > 2.0 = excellent | < 1.0 = losing strategy
    profitFactorRating: profitFactor >= 2 ? "EXCELLENT ✅" : profitFactor >= 1.5 ? "GOOD ✅" : profitFactor >= 1.0 ? "BREAK EVEN ⚠️" : "LOSING ❌",
    grossProfit:   +grossProfit.toFixed(2),
    grossLoss:     +grossLoss.toFixed(2),
    avgHoldMin:    +avgHoldMin.toFixed(1),
    avgWinPct:     +avgWinPct.toFixed(3),
    avgLossPct:    +avgLossPct.toFixed(3),
    expectancy:    +((avgWinPct * winRate/100) + (avgLossPct * (1 - winRate/100))).toFixed(3),

    // Context
    bestTrade:     bestTrade  ? { symbol:bestTrade.symbol,  pnlPct:+bestTrade.pnlPct.toFixed(3),  pnlUSD:+bestTrade.pnlUSD.toFixed(2)  } : null,
    worstTrade:    worstTrade ? { symbol:worstTrade.symbol, pnlPct:+worstTrade.pnlPct.toFixed(3), pnlUSD:+worstTrade.pnlUSD.toFixed(2) } : null,

    // Portfolio
    startBalance:  r.startBalance,
    endBalance:    portfolioUSDT || r.endBalance,
    growthPct:     r.startBalance ? +((( portfolioUSDT || r.endBalance) - r.startBalance) / r.startBalance * 100).toFixed(2) : 0,
    bdtRate:       r.bdtRate,

    // Breakdown
    byCoin,
    byReason,

    // Activity
    scans:         r.scans || 0,
    generatedAt:   new Date().toISOString(),
  };

  save(r);
  return r;
}

// ── List all reports ──────────────────────────────────────────────────────────
function list() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => f.endsWith(".json"))
      .sort().reverse()
      .map(f => {
        const d = JSON.parse(fs.readFileSync(path.join(DIR, f)));
        return {
          date:   d.date,
          trades: (d.trades||[]).filter(t=>t.side==="SELL").length,
          pnl:    d.summary?.totalPnlUSD || 0,
          growth: d.summary?.growthPct   || 0,
          pf:     d.summary?.profitFactor || 0,
          winRate:d.summary?.winRate     || 0,
        };
      });
  } catch { return []; }
}

function getReport(date) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${date}.json`), "utf8")); }
  catch { return null; }
}

module.exports = { load, recordTrade, recordScan, recordAnn, setBalance, generateSummary, list, getReport };
