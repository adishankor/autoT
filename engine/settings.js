// ─────────────────────────────────────────────────────────────────────────────
// settings.js  —  All strategy settings with default/ideal values documented
// Every setting shows: current default | recommended range | what it does
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {

  // ── MODE ─────────────────────────────────────────────────────────────────────
  paperMode:       true,    // true=paper | false=live — always start paper
  initialCapital:  1000,    // USD virtual balance for paper mode | range: any

  // ── SCAN ─────────────────────────────────────────────────────────────────────
  // When NO position: scans all candidates looking for entry
  // When position OPEN: scans only that coin every positionScanSec seconds
  //                     to monitor trailing SL / breakeven / profit targets
  scanIntervalSec:     120,  // default:120 | ideal:60-300 | no-position scan frequency
  positionScanSec:     900,  // default:900 | ideal:300-900 | open-position re-analysis (15min=900)
  maxCandidates:       10,   // default:10  | ideal:5-15   | coins to watch simultaneously
  refreshCandidatesEvery: 30,// default:30  | ideal:15-60  | refresh watchlist every N scans

  // ── ENTRY FILTERS ─────────────────────────────────────────────────────────────
  minConfidence:   75,   // default:75 | ideal:70-85 | min Claude AI confidence to enter
  minVolRatio:     1.2,  // default:1.2| ideal:1.1-2.0 | current vol vs 20-candle avg
  mtfRequired:     3,    // default:3  | ideal:2-4   | min TFs bullish out of 4 (5m/15m/1h/4h)

  // ── KELLY POSITION SIZING ─────────────────────────────────────────────────────
  // Formula: 75% conf→70%, 85%→85%, 95%+→100% — scaled by session multiplier
  useKellySizing:  true, // default:true — use Kelly formula (recommended)
  kellyMinPct:     70,   // default:70  | ideal:50-75  | size at minimum confidence
  kellyMaxPct:     100,  // default:100 | ideal:80-100 | size at max confidence (100% = full portfolio)
  positionSizePct: 80,   // default:80  | ideal:50-90  | fallback if Kelly disabled

  // ── PROFIT TARGETS ────────────────────────────────────────────────────────────
  minGrossProfitPct: 1.2,  // default:1.2  | ideal:1.2-2.0 | covers 0.2% round-trip fees
  takeProfitPct:     3.0,  // default:3.0  | ideal:2-10    | ideal TP Claude aims for

  // ── TRAILING STOP-LOSS ────────────────────────────────────────────────────────
  // Rule 1: PnL ≥ sl1TriggerPct → lock SL at sl1LockPct above entry (can't go below)
  // Rule 2: PnL ≥ sl2TriggerPct → trail SL at peakPnL − sl2TrailPct (follows price up)
  // SL NEVER goes below break-even (entry + fees) — zero loss protection
  sl1TriggerPct: 1.49,  // default:1.49 | ideal:1.0-2.0 | first SL lock trigger
  sl1LockPct:    1.0,   // default:1.0  | ideal:0.8-1.5 | where SL locks on first trigger
  sl2TriggerPct: 2.0,   // default:2.0  | ideal:1.5-3.0 | trailing SL activation
  sl2TrailPct:   1.0,   // default:1.0  | ideal:0.8-1.5 | trail distance below peak

  // ── TIME-BASED SL TIGHTENING ──────────────────────────────────────────────────
  // If position held > timeSLMinutes AND PnL still low → lower breakeven threshold
  timeSLEnabled:       true,  // default:true
  timeSLMinutes:       30,    // default:30  | ideal:15-60 | minutes before tightening kicks in
  timeSLMinPnlPct:     0.5,   // default:0.5 | ideal:0.3-1.0 | if PnL < this after N min → tighten
  timeSLReduceSignals: 2,     // default:2   | ideal:1-3 | reduce required breakeven signals by this

  // ── INTELLIGENT BREAKEVEN EXIT ────────────────────────────────────────────────
  // Exits at ~0% PnL if trade goes wrong BUT price still at/above entry
  // Requires N bearish signals to fire. Never fires if PnL is already good.
  breakevenEnabled:            true,  // default:true
  breakevenMinBearishSignals:  4,     // default:4  | ideal:3-6 | signals needed (from 10 evaluated)
  breakevenMinHeldMinutes:     5,     // default:5  | ideal:3-15 | don't trigger before N min
  breakevenMaxPnlPct:          0.3,   // default:0.3| ideal:0.1-0.5 | only fires if PnL < this %

  // ── BTC CORRELATION GATE ─────────────────────────────────────────────────────
  btcGateEnabled:    true,   // default:true — gate based on BTC health
  btcMinHealthScore: 40,     // default:40  | ideal:35-55 | min BTC score to allow entries
  btcMaxDump15mPct:  2.0,    // default:2.0 | ideal:1.5-3.0 | hard block if BTC dumps > this %

  // ── BEARISH REGIME HANDLING ───────────────────────────────────────────────────
  // IMPORTANT: In bearish regime, bot does NOT stop trading.
  // It raises confidence requirement + reduces position size.
  // This way we still catch genuine setups even in a bear market.
  regimeEnabled:           true,  // default:true
  bearishAllowTrade:       true,  // default:true — always allow trades in bear regime (just tighter)
  bearDayConfidenceBoost:  5,     // default:5  | ideal:5-10 | extra % confidence needed in BEAR_DAY
  bearDaySizePenalty:      0.6,   // default:0.6| ideal:0.4-0.8 | multiply size by this in BEAR_DAY

  // ── FUNDING RATE GATE (multi-exchange) ────────────────────────────────────────
  fundingGateEnabled:      true,   // default:true — uses avg of Bybit+Binance+OKX+Coinglass
  fundingMaxRatePct:       0.12,   // default:0.12 | ideal:0.08-0.15 | above this = raise confidence
  fundingCautionRatePct:   0.06,   // default:0.06 | mild caution threshold

  // ── FEAR & GREED ─────────────────────────────────────────────────────────────
  fearGreedEnabled:             true,  // default:true
  extremeGreedMaxSizePct:       60,    // default:60 | ideal:40-70 | size cap above F&G 80
  extremeFearConfidenceBoost:   3,     // default:3  | ideal:2-5   | conf boost below F&G 20

  // ── SESSION FILTER ────────────────────────────────────────────────────────────
  sessionFilterEnabled: true,  // default:true — dead zone reduces size to 0.4×

  // ── LIQUIDITY GATE ────────────────────────────────────────────────────────────
  liquidityGateEnabled:    true,   // default:true
  liquidityMaxSpreadPct:   0.15,   // default:0.15 | ideal:0.10-0.20 | max spread %
  liquidityAskWallBlockPct:0.3,    // default:0.3  | ideal:0.2-0.5  | skip if wall within %

  // ── SIGNAL UPGRADE ────────────────────────────────────────────────────────────
  upgradeEnabled:             true,  // default:true — switch to stronger signal while in position
  upgradeMinConfidenceDelta:  15,    // default:15 | ideal:10-20 | new signal must beat current by %
  upgradeMaxLossPct:          1.0,   // default:1.0| ideal:0.5-2.0 | max exit loss to upgrade

  // ── ANNOUNCEMENTS ────────────────────────────────────────────────────────────
  announcementBoost:     true,  // default:true — Bybit+Binance announcements as signals
  minAnnouncementScore:  20,    // default:20 | ideal:15-30 | min score to act on

  // ── RISK GUARDS ──────────────────────────────────────────────────────────────
  dailyLossLimitPct: 5,    // default:5  | ideal:3-10 | circuit breaker (0=off)
  maxHoldHours:      0,    // default:0  | ideal:0-168 | max hold hours (0=unlimited)
  zeroLossRule:      true, // default:true — never auto-exit below entry price
};

module.exports = { DEFAULT_SETTINGS };
