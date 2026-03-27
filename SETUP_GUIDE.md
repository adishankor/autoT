# CLAUDE BYBIT BOT — COMPLETE SETUP GUIDE

---

## ✅ CONFIRMATION: YES, THE BOT IS 24/7

The bot runs a scan loop every 2 minutes (configurable) continuously:
- Fetches top 200 MCap coins from CoinGecko
- Filters to only coins listed on Bybit (Spot, USDT pairs)
- Claude AI ranks them by momentum + volume + repute
- Scans each candidate for entry signals
- Monitors open positions for trailing SL / profit exit
- Refreshes coin watchlist every 30 scans (~1 hour)
- Automatically switches to a better coin once a trade closes

---

## STEP 1 — GET YOUR API KEYS

### A) Anthropic API Key (Required for AI)
1. Go to https://console.anthropic.com/settings/keys
2. Click "Create Key"
3. Copy the key → looks like: `sk-ant-api03-...`
4. Note: usage is paid per token. ~$0.01–0.05 per scan cycle.

### B) Bybit API Key (Required for Live Trading, not needed for Paper)
1. Log into Bybit → top right → User Center
2. Left sidebar → API Management → Create New Key
3. Key name: "Claude Bot"
4. Permission settings:
   - ✅ Read
   - ✅ Spot Trading
   - ❌ Derivatives (OFF)
   - ❌ Withdraw (NEVER enable this)
5. IP restriction: Enter your server's IP address (find it with `curl ifconfig.me`)
6. Submit → copy API Key + Secret immediately (secret only shown once)

---

## STEP 2 — DOWNLOAD & CONFIGURE

```bash
# Download the bybit-bot.zip from Claude dashboard
# Extract it, then:

cd bybit-bot

# Copy the example env file
cp .env.example .env

# Edit .env with your keys:
nano .env
```

Your `.env` file should look like:
```
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxx
BYBIT_API_KEY=your_bybit_key          # leave blank for paper mode
BYBIT_API_SECRET=your_bybit_secret    # leave blank for paper mode
PORT=3000
```

---

## STEP 3 — INSTALL & RUN LOCALLY (Test First)

You need Node.js v18 or newer.

```bash
# Check Node version (must be 18+)
node --version

# If not installed: https://nodejs.org → download LTS

# Install dependencies
npm install

# Start the bot
npm start
```

Open your browser: **http://localhost:3000**

You should see the dashboard. The bot starts in Paper Mode by default — no real money involved.

---

## STEP 4 — USE THE DASHBOARD

### Starting the Bot
1. Open http://localhost:3000
2. Click **⚙ SETTINGS** tab — verify your settings
3. Make sure Mode is set to **📋 PAPER** for first run
4. Click **▶ START**
5. Watch the AGENT LOG — you'll see it scanning coins, fetching news, and making decisions

### Adjusting Settings (live, no restart needed)
All settings are editable from the Settings tab:
- Drag sliders to change values
- Toggle checkboxes for on/off features
- Click **💾 SAVE SETTINGS** → changes apply on next scan cycle

### Key Settings to Understand:
| Setting | What it does |
|---------|-------------|
| Min AI Confidence | Only enter if Claude is ≥75% confident (raise to 80%+ for caution) |
| Min Volume Ratio | Only enter if current volume is ≥1.2× the 20-candle average |
| Position Size | % of USDT to deploy per trade (90% default) |
| Take Profit Target | AI aims for this gross % (1.2%+ recommended to cover 0.2% fees) |
| SL Rule 1 Trigger | When PnL hits this → lock SL at a safe level |
| SL Rule 2 Trigger | When PnL hits this → activate trailing SL |
| Zero-Loss Rule | Bot never auto-sells at a loss — hold until profitable |
| Max Hold Hours | Force-close after N hours (0 = hold forever) |

### Manually Closing a Position (Dump)
If you want to exit a losing position manually:
1. Click the **🚨 DUMP POSITION** button on the Dashboard
2. A confirmation modal appears showing current PnL
3. Click **YES, DUMP NOW** to execute
4. This overrides the zero-loss rule

---

## STEP 5 — DEPLOY FOR 24/7 (Railway — Easiest)

### Option A: Railway (Free tier, 5 minutes)
1. Push your bybit-bot folder to GitHub (create free repo)
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo
4. In Railway → Variables tab, add:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   BYBIT_API_KEY=your_key          (if live trading)
   BYBIT_API_SECRET=your_secret    (if live trading)
   PORT=3000
   ```
5. Railway auto-deploys → you get a URL like `https://claude-bot-xxx.railway.app`
6. Open that URL → your bot dashboard, accessible from anywhere

### Option B: Render (Free tier)
1. Push to GitHub
2. https://render.com → New Web Service → Connect repo
3. Build: `npm install` | Start: `npm start`
4. Add env vars same as above
5. Deploy

### Option C: VPS (DigitalOcean / Hetzner / Linode — Best for 24/7 reliability)
```bash
# On your server (Ubuntu 22.04):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Upload your files
git clone https://github.com/YOUR/repo.git
cd repo && npm install
cp .env.example .env && nano .env

# Run forever with PM2
npm install -g pm2
pm2 start server.js --name bybit-bot
pm2 startup    # auto-start on reboot
pm2 save

# Check it's running
pm2 logs bybit-bot

# Access dashboard at: http://YOUR_SERVER_IP:3000
```

---

## STEP 6 — GO LIVE

When you're confident the paper trading results look good:
1. Go to **⚙ SETTINGS** → Mode → Click **⚡ LIVE**
2. Make sure BYBIT_API_KEY and BYBIT_API_SECRET are set in .env
3. Click **💾 SAVE SETTINGS**
4. Click **■ STOP** then **▶ START** to restart with live mode
5. The bot will read your real Bybit USDT balance and trade it

---

## REPORTS

Daily reports are auto-generated at midnight UTC and saved to:
```
bybit-bot/reports/YYYY-MM-DD.json
```

View them in the **REPORTS** tab of the dashboard. Each report shows:
- Total trades, wins, losses, win rate
- Total P&L in USD
- Portfolio growth %
- Individual trade breakdown

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| "ANTHROPIC_API_KEY not set" | Add key to .env file |
| "Bybit API keys missing" | Only needed for live mode |
| Bot not finding trades | Lower min confidence to 70%, check volume ratio filter |
| Position held too long | Set Max Hold Hours in settings, or use manual Dump |
| Bot not running 24/7 | Deploy to Railway/Render/VPS (local PC sleeps) |
| CoinGecko rate limit | Normal — bot retries and uses stale cache |

---

## COSTS ESTIMATE

| Item | Cost |
|------|------|
| Anthropic API | ~$0.01–0.05 per scan cycle (news search uses most tokens) |
| At 120s intervals | ~$5–15/day in Claude API costs |
| Bybit trading fees | 0.1% per side = 0.2% round trip |
| Railway hosting | Free tier (512MB RAM, may sleep) or $5/mo for always-on |
| Render hosting | Free tier available |
| VPS (Hetzner CAX11) | ~€4/mo (~$4.50) — best value for 24/7 |

**To reduce API costs:** Increase scan interval to 5–10 minutes (300–600 sec in settings).

---

## DISCLAIMER

Automated crypto trading is high-risk. The bot's zero-loss hold rule means capital can be locked during downtrends. Only invest what you can afford to hold long-term. Past performance does not guarantee future results.
