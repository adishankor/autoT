// ─────────────────────────────────────────────────────────────────────────────
// orderbook.js  —  WEAKNESS 3 fix: order book wall detection & pressure analysis
// Bybit orderbook format: { b:[[price,qty],...], a:[[price,qty],...] }
// b = bids (buyers), a = asks (sellers)
// ─────────────────────────────────────────────────────────────────────────────

const bybit = require("./bybit");

// Fetch deep order book (50 levels each side)
async function fetchOrderbook(symbol, depth=50) {
  try {
    const data = await bybit.orderbook(symbol, depth);
    return data;
  } catch (e) {
    return null;
  }
}

// ── Analyze the order book ────────────────────────────────────────────────────
function analyzeOrderbook(ob, currentPrice) {
  if (!ob?.b?.length || !ob?.a?.length) {
    return { available: false };
  }

  // Parse bids and asks
  const bids = ob.b.map(([p,q])=>({ price:parseFloat(p), qty:parseFloat(q), value:parseFloat(p)*parseFloat(q) }))
                   .sort((a,b)=>b.price-a.price); // best bid first
  const asks = ob.a.map(([p,q])=>({ price:parseFloat(p), qty:parseFloat(q), value:parseFloat(p)*parseFloat(q) }))
                   .sort((a,b)=>a.price-b.price); // best ask first

  if (!bids.length || !asks.length) return { available: false };

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const spread  = (bestAsk-bestBid)/bestBid*100;
  const midPrice = (bestBid+bestAsk)/2;

  // ── Total liquidity ──────────────────────────────────────────────────────
  const totalBidValue = bids.reduce((s,b)=>s+b.value,0);
  const totalAskValue = asks.reduce((s,a)=>s+a.value,0);
  const totalLiquidity = totalBidValue+totalAskValue;

  // Buy/Sell pressure ratio: >1 = more buying pressure
  const pressureRatio = totalAskValue>0 ? totalBidValue/totalAskValue : 1;
  const buyPressurePct = totalLiquidity>0 ? totalBidValue/totalLiquidity*100 : 50;

  // ── Wall detection ────────────────────────────────────────────────────────
  // A "wall" is an order that is significantly larger than average order size
  const avgBidValue = totalBidValue/bids.length;
  const avgAskValue = totalAskValue/asks.length;
  const WALL_MULTIPLIER = 3.0; // order must be 3× average to be a wall

  const bidWalls = bids
    .filter(b=>b.value>avgBidValue*WALL_MULTIPLIER)
    .map(b=>({
      price: b.price,
      value: b.value,
      distancePct: (currentPrice-b.price)/currentPrice*100,
      strength: b.value>avgBidValue*8?"MASSIVE":b.value>avgBidValue*5?"LARGE":"MEDIUM"
    }))
    .slice(0,3); // top 3 bid walls

  const askWalls = asks
    .filter(a=>a.value>avgAskValue*WALL_MULTIPLIER)
    .map(a=>({
      price: a.price,
      value: a.value,
      distancePct: (a.price-currentPrice)/currentPrice*100,
      strength: a.value>avgAskValue*8?"MASSIVE":a.value>avgAskValue*5?"LARGE":"MEDIUM"
    }))
    .slice(0,3); // top 3 ask walls

  // ── Nearest walls ─────────────────────────────────────────────────────────
  const nearestBidWall = bidWalls[0] || null;  // strongest support wall
  const nearestAskWall = askWalls[0] || null;  // strongest resistance wall

  // ── Price position within book ────────────────────────────────────────────
  const bidRange = bestBid - (bids[bids.length-1]?.price||bestBid);
  const askRange = (asks[asks.length-1]?.price||bestAsk) - bestAsk;
  const posInBidRange = bidRange>0 ? (currentPrice-bids[bids.length-1].price)/bidRange : 0.5;

  // ── Order book imbalance (top 10 levels) ─────────────────────────────────
  const top10BidVal = bids.slice(0,10).reduce((s,b)=>s+b.value,0);
  const top10AskVal = asks.slice(0,10).reduce((s,a)=>s+a.value,0);
  const imbalance = top10BidVal+top10AskVal>0
    ? (top10BidVal-top10AskVal)/(top10BidVal+top10AskVal)  // -1=full sell, +1=full buy
    : 0;

  // ── Signals ───────────────────────────────────────────────────────────────
  const signals = [];
  if (pressureRatio>1.4)      signals.push("STRONG_BUY_PRESSURE");
  else if (pressureRatio>1.15) signals.push("BUY_PRESSURE");
  else if (pressureRatio<0.7)  signals.push("STRONG_SELL_PRESSURE");
  else if (pressureRatio<0.87) signals.push("SELL_PRESSURE");

  if (nearestBidWall?.strength==="MASSIVE") signals.push(`MASSIVE_BID_WALL_$${nearestBidWall.price.toFixed(4)}`);
  else if (nearestBidWall?.strength==="LARGE") signals.push(`BID_WALL_$${nearestBidWall.price.toFixed(4)}`);

  if (nearestAskWall?.strength==="MASSIVE") signals.push(`MASSIVE_ASK_WALL_$${nearestAskWall.price.toFixed(4)}`);
  else if (nearestAskWall?.strength==="LARGE") signals.push(`ASK_WALL_$${nearestAskWall.price.toFixed(4)}`);

  if (spread<0.02) signals.push("TIGHT_SPREAD");
  else if (spread>0.2) signals.push("WIDE_SPREAD_CAUTION");

  if (imbalance>0.3)  signals.push("BOOK_IMBALANCE_BUY");
  if (imbalance<-0.3) signals.push("BOOK_IMBALANCE_SELL");

  // ── Overall book bias ─────────────────────────────────────────────────────
  let bookBias = "NEUTRAL";
  let bookScore = 50;
  if (pressureRatio>1.2 && imbalance>0.1)       { bookBias="BULLISH";       bookScore=70; }
  if (pressureRatio>1.5 && imbalance>0.25)      { bookBias="STRONG_BULL";   bookScore=85; }
  if (pressureRatio<0.85 && imbalance<-0.1)     { bookBias="BEARISH";       bookScore=30; }
  if (nearestAskWall && nearestAskWall.distancePct<0.5) { bookBias="WALL_BLOCKING"; bookScore-=15; }
  if (nearestBidWall && nearestBidWall.distancePct<0.5) { bookScore+=10; }

  return {
    available: true,
    bestBid, bestAsk, spread, midPrice,
    totalBidValue, totalAskValue,
    pressureRatio, buyPressurePct,
    imbalance,
    bidWalls, askWalls,
    nearestBidWall, nearestAskWall,
    bookBias, bookScore,
    signals,
    // Human-readable summary for Claude prompt
    summary: [
      `Spread:${spread.toFixed(3)}%`,
      `BuyPressure:${buyPressurePct.toFixed(0)}%`,
      `Imbalance:${(imbalance*100).toFixed(0)}%`,
      `Bias:${bookBias}`,
      nearestBidWall?`BidWall:$${nearestBidWall.price.toFixed(4)}(${nearestBidWall.strength},-${nearestBidWall.distancePct.toFixed(2)}%)`:"",
      nearestAskWall?`AskWall:$${nearestAskWall.price.toFixed(4)}(${nearestAskWall.strength},+${nearestAskWall.distancePct.toFixed(2)}%)`:"",
      `Signals:[${signals.slice(0,3).join(",")}]`
    ].filter(Boolean).join(" | ")
  };
}

// ── Main export: fetch + analyze ──────────────────────────────────────────────
async function getOrderbookAnalysis(symbol, currentPrice) {
  const ob = await fetchOrderbook(symbol, 50);
  if (!ob) return { available:false, summary:"Order book unavailable", bookBias:"NEUTRAL", bookScore:50, signals:[], pressureRatio:1, imbalance:0 };
  return analyzeOrderbook(ob, currentPrice);
}

module.exports = { getOrderbookAnalysis, analyzeOrderbook };
