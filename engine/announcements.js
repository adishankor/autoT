const fetch = require("node-fetch");
const bybit = require("./bybit");

let cache = { all:[], ts:0 };
const TTL = 5*60*1000;
const seen = new Set();

async function fetchBybit() {
  try {
    const d = await bybit.announcements();
    return (d.list||[]).map(a=>({ source:"Bybit", title:a.title||"", description:a.description||"", date:a.dateTimestamp?new Date(a.dateTimestamp).toISOString():new Date().toISOString() }));
  } catch { return []; }
}

async function fetchBinance() {
  try {
    const r = await fetch("https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20",
      { headers:{ Accept:"application/json","User-Agent":"Mozilla/5.0" }, timeout:8000 });
    if (!r.ok) throw new Error();
    const d = await r.json();
    const arts = d.data?.catalogs?.flatMap(c=>c.articles||[])||[];
    return arts.map(a=>({ source:"Binance", title:a.title||"", description:(a.body||"").slice(0,200), date:a.releaseDate?new Date(a.releaseDate).toISOString():new Date().toISOString() }));
  } catch {
    try {
      const r2 = await fetch("https://www.binance.com/en/support/announcement/c-48?format=rss",{headers:{"User-Agent":"Mozilla/5.0"},timeout:6000});
      const xml = await r2.text();
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,15).map(m=>{
        const t=m[1],title=(t.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||t.match(/<title>(.*?)<\/title>/)||[])[1]||"";
        return { source:"Binance", title, description:"", date:new Date().toISOString() };
      });
    } catch { return []; }
  }
}

function scoreAnn(ann) {
  const tx=(ann.title+" "+ann.description).toLowerCase();
  let score=0,signals=[];
  if(/new listing|will list|lists/.test(tx)){score+=40;signals.push("NEW_LISTING");}
  if(/launchpad|launchpool/.test(tx)){score+=35;signals.push("LAUNCHPAD");}
  if(/spot trading.*open|now available for trading/.test(tx)){score+=30;signals.push("TRADING_OPEN");}
  if(/airdrop/.test(tx)){score+=20;signals.push("AIRDROP");}
  if(/staking|earn|yield/.test(tx)){score+=12;signals.push("STAKING");}
  if(/partnership|integration/.test(tx)){score+=10;signals.push("PARTNERSHIP");}
  if(/promotion|bonus|reward/.test(tx)){score+=8;signals.push("PROMO");}
  if(/upgrade|mainnet/.test(tx)){score+=8;signals.push("UPGRADE");}
  if(/delist|suspend|halt/.test(tx)){score-=50;signals.push("DELIST");}
  if(/investigation|risk warning/.test(tx)){score-=30;signals.push("RISK");}
  return {score,signals};
}

function extractCoins(text, knownSymbols=[]) {
  const tokens=[...text.matchAll(/\b([A-Z]{2,8})\b/g)].map(m=>m[1]);
  return [...new Set(tokens.map(t=>t+"USDT").filter(s=>knownSymbols.length===0||knownSymbols.includes(s)))];
}

async function getAll(knownSymbols=[]) {
  if (Date.now()-cache.ts<TTL && cache.all.length) return cache.all;
  const [bb, bn] = await Promise.all([fetchBybit(), fetchBinance()]);
  const all=[...bb,...bn].map(a=>{
    const {score,signals}=scoreAnn(a);
    const coins=extractCoins(a.title+" "+a.description, knownSymbols);
    const isNew=!seen.has(a.title);
    if(isNew)seen.add(a.title);
    return{...a,score,signals,coins,isNew};
  }).sort((a,b)=>b.score-a.score);
  cache={all,ts:Date.now()};
  return all;
}

async function forCoin(symbol, knownSymbols=[]) {
  const all=await getAll(knownSymbols);
  const coin=symbol.replace("USDT","");
  return all.filter(a=>a.coins.includes(symbol)||a.title.toUpperCase().includes(coin));
}

module.exports = { getAll, forCoin };
