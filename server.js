require("dotenv").config();
const express  = require("express");
const path     = require("path");
const bot      = require("./engine/botEngine");
const reporter = require("./engine/reporter");

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ── Password Protection ───────────────────────────────────────────────────────
// Set DASHBOARD_PASSWORD in Railway environment variables to enable.
// If not set, dashboard is open (useful during initial setup).
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

function authMiddleware(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next(); // no password set → open access

  // Allow health check without auth (Railway uses this to verify deployment)
  if (req.path === "/health") return next();

  const auth = req.headers["authorization"];
  if (auth) {
    const b64 = auth.split(" ")[1] || "";
    const [user, pass] = Buffer.from(b64, "base64").toString().split(":");
    if (pass === DASHBOARD_PASSWORD) return next();
  }

  // Prompt browser login dialog
  res.set("WWW-Authenticate", 'Basic realm="Claude Bybit Bot"');
  res.status(401).send("Authentication required");
}

app.use(authMiddleware);
app.use(express.static(path.join(__dirname,"public")));

// Bot controls
app.post("/api/start", async(req,res)=>{
  try{bot.state.settings.paperMode=req.body.paperMode!==false;await bot.start();res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.post("/api/stop",(req,res)=>{bot.stop();res.json({ok:true});});

// Settings — live update
app.get("/api/settings",(req,res)=>res.json(bot.state.settings));
app.post("/api/settings",(req,res)=>{
  try{bot.applySettings(req.body);res.json({ok:true,settings:bot.state.settings});}
  catch(e){res.status(400).json({error:e.message});}
});
app.post("/api/settings/reset",(req,res)=>{
  const{DEFAULT_SETTINGS}=require("./engine/settings");
  bot.applySettings({...DEFAULT_SETTINGS});
  res.json({ok:true,settings:bot.state.settings});
});

// Manual dump
app.post("/api/dump",async(req,res)=>{
  try{const r=await bot.manualDump();res.json(r);}
  catch(e){res.status(400).json({error:e.message});}
});

// State
app.get("/api/state",(req,res)=>{
  const s=bot.state;
  const settings = s.settings;
  res.json({
    running:s.running, phase:s.phase, paperMode:settings.paperMode,
    portfolioUSDT:s.portfolioUSDT, portfolioBDT:s.portfolioUSDT*(s.bdtRate||120),
    bdtRate:s.bdtRate, startBalance:s.startBalance,
    growthPct:s.startBalance?((s.portfolioUSDT-s.startBalance)/s.startBalance*100):0,
    position:s.position, pendingRecovery:s.pendingRecovery,
    candidates:s.candidates, activeCoin:s.activeCoin,
    scanCount:s.scanCount, lastScan:s.lastScan, nextScan:s.nextScan,
    competitorSignals:s.competitorSignals,
    // Scan intervals for display
    scanIntervalSec:     settings.scanIntervalSec,
    positionScanSec:     settings.positionScanSec,
    ws:{ connected:s.wsConnected, price:s.wsPrice, tickCount:s.wsTickCount },
    marketCtx: s.marketCtx ? {
      btcHealth:      s.marketCtx.btc?.healthScore,
      btcTrend4h:     s.marketCtx.btc?.trend4h,
      btcTrend1d:     s.marketCtx.btc?.trend1d,
      btcChg15m:      s.marketCtx.btc?.chg15m,
      allowEntry:     s.marketCtx.allowEntry,
      bearishMode:    s.marketCtx.bearishMode,   // BTC 1D bearish — tighter rules
      gateReason:     s.marketCtx.gateReason,
      fearGreed:      s.marketCtx.fearGreed?.value,
      fearGreedLabel: s.marketCtx.fearGreed?.label,
      fearGreedBias:  s.marketCtx.fearGreed?.entryBias,
      longShortRatio: s.marketCtx.coinglass?.ratio,
      lsSignal:       s.marketCtx.coinglass?.sentiment,
      fundingRate:    s.marketCtx.funding?.ratePct,
      fundingSignal:  s.marketCtx.funding?.sentiment,
      fundingSources: s.marketCtx.funding?.sourcesAvailable,
      fundingSummary: s.marketCtx.funding?.summary,
      btcDominance:   s.marketCtx.global?.btcDominance,
      regime:         s.marketCtx.global?.regime,
      altSentiment:   s.marketCtx.global?.altSentiment,
      session:        s.marketCtx.session?.session,
      sessionMult:    s.marketCtx.session?.sizeMult,
      sessionNote:    s.marketCtx.session?.note,
    } : null,
    logs:s.logs.slice(0,120),
  });
});

// Reports
app.get("/api/reports",(req,res)=>res.json(reporter.list()));
app.get("/api/reports/today/generate",(req,res)=>res.json(reporter.generateSummary(bot.state.portfolioUSDT)));
app.get("/api/reports/:date",(req,res)=>{const r=reporter.getReport(req.params.date);r?res.json(r):res.status(404).json({error:"Not found"});});

app.get("/health",(req,res)=>res.json({status:"ok",ts:new Date().toISOString()}));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>{
  console.log(`\n🚀 Claude Bybit Bot → http://localhost:${PORT}`);
  console.log(`   Anthropic key: ${process.env.ANTHROPIC_API_KEY?"✅":"❌ MISSING — add to .env"}`);
  console.log(`   Bybit keys:    ${process.env.BYBIT_API_KEY?"✅":"⚠️  Not set — paper mode only"}\n`);
});
