// ─────────────────────────────────────────────────────────────────────────────
// indicators.js  —  All technical analysis
// New in v2: RSI divergence, per-TF bias, MTF agreement scoring
// ─────────────────────────────────────────────────────────────────────────────

function parseKlines(raw) {
  if (!raw?.list?.length) return [];
  // Bybit returns newest-first → reverse to chronological
  return raw.list.slice().reverse().map(k => ({
    t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]
  }));
}

// ── Base maths ────────────────────────────────────────────────────────────────
function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p;i<arr.length;i++) e = arr[i]*k + e*(1-k);
  return e;
}
function rsi(arr, p=14) {
  if (arr.length<=p) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const d=arr[i]-arr[i-1];d>=0?g+=d:l-=d;}
  let ag=g/p,al=l/p;
  for (let i=p+1;i<arr.length;i++){
    const d=arr[i]-arr[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p;
    al=(al*(p-1)+Math.max(-d,0))/p;
  }
  return al===0?100:100-100/(1+ag/al);
}
function macd(arr) {
  if (arr.length<35) return null;
  const e12=ema(arr,12),e26=ema(arr,26);
  if (!e12||!e26) return null;
  return {line:e12-e26,bullish:e12>e26,ema12:e12,ema26:e26};
}
function bb(arr,p=20) {
  if (arr.length<p) return null;
  const s=arr.slice(-p),m=s.reduce((a,b)=>a+b,0)/p;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/p);
  const price=arr[arr.length-1];
  return {upper:m+2*sd,mid:m,lower:m-2*sd,sd,pos:sd>0?(price-(m-2*sd))/(4*sd):0.5};
}
function atr(candles,p=14) {
  if (candles.length<p+1) return null;
  const trs=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],pc=candles[i-1].c;
    trs.push(Math.max(c.h-c.l,Math.abs(c.h-pc),Math.abs(c.l-pc)));
  }
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}
function volRatio(candles,p=20) {
  const vols=candles.map(c=>c.v);
  if (vols.length<p+1) return null;
  const avg=vols.slice(-p-1,-1).reduce((a,b)=>a+b,0)/p;
  return avg>0?vols[vols.length-1]/avg:null;
}
function chgPct(arr,back=1){
  if(arr.length<back+1)return null;
  return(arr[arr.length-1]-arr[arr.length-1-back])/arr[arr.length-1-back]*100;
}
function sr(candles,p=30){
  const sl=candles.slice(-p);
  return{resistance:Math.max(...sl.map(c=>c.h)),support:Math.min(...sl.map(c=>c.l))};
}

// ── RSI series (full history, needed for divergence) ──────────────────────────
function rsiSeries(closes, p=14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const d=closes[i]-closes[i-1];d>=0?g+=d:l-=d;}
  let ag=g/p,al=l/p;
  out[p] = al===0?100:100-100/(1+ag/al);
  for (let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(p-1)+Math.max(d,0))/p;
    al=(al*(p-1)+Math.max(-d,0))/p;
    out[i]=al===0?100:100-100/(1+ag/al);
  }
  return out;
}

// ── Swing point detection ─────────────────────────────────────────────────────
// Returns indices of the last N swing highs and lows
function findSwings(arr, lookback=3, n=3) {
  const highs=[], lows=[];
  for (let i=lookback;i<arr.length-lookback;i++){
    const slice=arr.slice(i-lookback,i+lookback+1);
    const val=arr[i];
    if (val===Math.max(...slice)) highs.push(i);
    if (val===Math.min(...slice)) lows.push(i);
  }
  return {
    recentHighs: highs.slice(-n),
    recentLows:  lows.slice(-n)
  };
}

// ── WEAKNESS 2: RSI Divergence Detection ─────────────────────────────────────
// Returns divergence signals with strength rating
function detectDivergence(candles) {
  if (candles.length < 30) return { bullish:null, bearish:null, hidden:null };

  const closes = candles.map(c=>c.c);
  const highs   = candles.map(c=>c.h);
  const lows    = candles.map(c=>c.l);
  const rsiArr  = rsiSeries(closes);

  const pSwings = findSwings(closes, 3, 4);
  const hSwings = findSwings(highs,  3, 4);
  const lSwings = findSwings(lows,   3, 4);

  let bullish=null, bearish=null, hidden=null;

  // ── Regular Bullish Divergence ────────────────────────────────────────────
  // Price: lower low   |  RSI: higher low   → reversal up expected
  const rLows = lSwings.recentLows.filter(i=>rsiArr[i]!==null);
  if (rLows.length>=2) {
    const [i1,i2]=[rLows[rLows.length-2], rLows[rLows.length-1]];
    if (lows[i2]<lows[i1] && rsiArr[i2]>rsiArr[i1]) {
      const strength = rsiArr[i2]-rsiArr[i1]; // RSI diff — bigger = stronger
      bullish={
        type:"REGULAR_BULLISH",
        priceLow1:lows[i1], priceLow2:lows[i2],
        rsiLow1:rsiArr[i1], rsiLow2:rsiArr[i2],
        strength: strength>10?"STRONG":strength>5?"MODERATE":"WEAK",
        strengthVal: strength,
        barsSince: candles.length-1-i2,
        label:"Price LL + RSI HL → Reversal Up"
      };
    }
  }

  // ── Regular Bearish Divergence ────────────────────────────────────────────
  // Price: higher high  |  RSI: lower high   → reversal down expected
  const rHighs = hSwings.recentHighs.filter(i=>rsiArr[i]!==null);
  if (rHighs.length>=2) {
    const [i1,i2]=[rHighs[rHighs.length-2], rHighs[rHighs.length-1]];
    if (highs[i2]>highs[i1] && rsiArr[i2]<rsiArr[i1]) {
      const strength = rsiArr[i1]-rsiArr[i2];
      bearish={
        type:"REGULAR_BEARISH",
        priceHigh1:highs[i1], priceHigh2:highs[i2],
        rsiHigh1:rsiArr[i1], rsiHigh2:rsiArr[i2],
        strength: strength>10?"STRONG":strength>5?"MODERATE":"WEAK",
        strengthVal: strength,
        barsSince: candles.length-1-i2,
        label:"Price HH + RSI LH → Reversal Down"
      };
    }
  }

  // ── Hidden Bullish Divergence ─────────────────────────────────────────────
  // Price: higher low   |  RSI: lower low   → trend continuation up
  if (rLows.length>=2) {
    const [i1,i2]=[rLows[rLows.length-2], rLows[rLows.length-1]];
    if (lows[i2]>lows[i1] && rsiArr[i2]<rsiArr[i1]) {
      const strength = rsiArr[i1]-rsiArr[i2];
      hidden={
        type:"HIDDEN_BULLISH",
        strength: strength>8?"STRONG":strength>4?"MODERATE":"WEAK",
        strengthVal: strength,
        barsSince: candles.length-1-i2,
        label:"Price HL + RSI LL → Uptrend Continuation"
      };
    }
  }

  return { bullish, bearish, hidden };
}

// ── WEAKNESS 4: Per-TF bias scoring ──────────────────────────────────────────
// Returns a bias for a single timeframe: +1=bullish, 0=neutral, -1=bearish
// Also returns a score 0-100 and breakdown
function tfBias(d) {
  if (!d) return { bias:0, score:50, signals:[], label:"NO_DATA" };

  let score=50; // neutral start
  const signals=[];

  // RSI
  if (d.rsi!==null){
    if (d.rsi<30)       { score+=15; signals.push("RSI_OVERSOLD"); }
    else if (d.rsi<45)  { score+=8;  signals.push("RSI_BULLISH_ZONE"); }
    else if (d.rsi>70)  { score-=15; signals.push("RSI_OVERBOUGHT"); }
    else if (d.rsi>60)  { score+=5;  signals.push("RSI_MOMENTUM"); }
  }

  // MACD
  if (d.macd){
    if (d.macd.bullish)  { score+=12; signals.push("MACD_BULL"); }
    else                 { score-=12; signals.push("MACD_BEAR"); }
    if (d.macd.line>0 && d.macd.line>d.macd.line*0.9) { score+=5; signals.push("MACD_RISING"); }
  }

  // EMA alignment: 9 > 20 > 50 = full bull stack
  if (d.ema9&&d.ema20&&d.ema50){
    if (d.ema9>d.ema20&&d.ema20>d.ema50) { score+=15; signals.push("EMA_BULL_STACK"); }
    else if (d.ema9<d.ema20&&d.ema20<d.ema50) { score-=15; signals.push("EMA_BEAR_STACK"); }
    else if (d.ema9>d.ema20) { score+=6; signals.push("EMA9_ABOVE_20"); }
    else { score-=6; signals.push("EMA9_BELOW_20"); }
  }

  // BB position (0=lower band, 0.5=mid, 1=upper band)
  if (d.bb){
    if (d.bb.pos<0.25)      { score+=10; signals.push("BB_NEAR_LOWER"); }  // near support
    else if (d.bb.pos>0.85) { score-=10; signals.push("BB_NEAR_UPPER"); }  // near resistance
    else if (d.bb.pos>0.45&&d.bb.pos<0.6) { score+=4; signals.push("BB_ABOVE_MID"); }
  }

  // Volume
  if (d.volRatio){
    if (d.volRatio>=1.5)   { score+=8; signals.push("HIGH_VOLUME"); }
    else if (d.volRatio>=1.2) { score+=4; signals.push("ABOVE_AVG_VOL"); }
    else if (d.volRatio<0.8)  { score-=5; signals.push("LOW_VOLUME"); }
  }

  // Price momentum
  if (d.chg1!==null){
    if (d.chg1>0.3&&d.chg1<5)  { score+=6; signals.push("POSITIVE_MOMENTUM"); }
    else if (d.chg1<-1)          { score-=6; signals.push("NEGATIVE_MOMENTUM"); }
  }

  score = Math.max(0, Math.min(100, score));
  const bias = score>=58?1:score<=42?-1:0;
  const label = bias===1?"BULLISH":bias===-1?"BEARISH":"NEUTRAL";
  return { bias, score, signals, label };
}

// ── Multi-TF agreement — supports dynamic TF list including 1d ───────────────
function mtfAgreement(multiTF, required=3) {
  // Use whatever TFs are provided — supports 4-TF (5m/15m/1h/4h) and 5-TF (+ 1d)
  const tfs = Object.keys(multiTF || {});
  const results = {};
  let bullCount=0, bearCount=0;

  for (const tf of tfs) {
    const d = multiTF[tf];
    const b = tfBias(d);
    results[tf] = b;
    if (b.bias===1)  bullCount++;
    if (b.bias===-1) bearCount++;
  }

  const availableTFs = tfs.filter(tf => multiTF[tf] !== null).length;
  // Scale required: if 5 TFs available and required=3, still reasonable
  const effectiveRequired = Math.min(required, availableTFs);
  const bullish = bullCount >= effectiveRequired;
  const bearish = bearCount >= effectiveRequired;

  return {
    results,
    bullCount,
    bearCount,
    totalTFs: availableTFs,
    neutralCount: availableTFs - bullCount - bearCount,
    bullish,
    bearish,
    agreement: bullish||bearish,
    dominant: bullCount>bearCount?"BULLISH":bearCount>bullCount?"BEARISH":"MIXED",
    summary: tfs.map(tf=>`${tf}:${results[tf]?.label||"N/A"}(${results[tf]?.score||0})`).join(" | ")
  };
}

// ── Full calcAll ──────────────────────────────────────────────────────────────
function calcAll(raw) {
  const candles=parseKlines(raw);
  if (candles.length<5) return null;
  const closes=candles.map(c=>c.c);
  const price=closes[closes.length-1];
  const div=detectDivergence(candles);

  return {
    price, candles, closes,
    rsi:     rsi(closes),
    macd:    macd(closes),
    bb:      bb(closes),
    ema9:    ema(closes,9),
    ema20:   ema(closes,20),
    ema50:   ema(closes,50),
    atr:     atr(candles),
    volRatio:volRatio(candles),
    chg1:    chgPct(closes,1),
    chg5:    chgPct(closes,5),
    chg10:   chgPct(closes,10),
    sr:      sr(candles),
    divergence: div,   // NEW: divergence analysis
    bias:    tfBias({  // NEW: this TF's own bias score
      rsi:rsi(closes),macd:macd(closes),bb:bb(closes),
      ema9:ema(closes,9),ema20:ema(closes,20),ema50:ema(closes,50),
      volRatio:volRatio(candles),chg1:chgPct(closes,1)
    })
  };
}

module.exports = { calcAll, tfBias, mtfAgreement, detectDivergence };
