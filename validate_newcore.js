// 验证改进版 trySets / trySetsOne（不改生产文件，就地替换验证）
'use strict';
const fs = require('fs');
function elemStub(){ return new Proxy({}, { get(t,k){ if(k==='style')return{}; if(k==='classList')return {add(){},remove(){},contains(){return false}}; return t[k];}, set(t,k,v){t[k]=v;return true;} }); }
const doc = new Proxy({}, { get(t,k){ if(k==='getElementById')return function(){return elemStub()}; if(k==='querySelectorAll')return function(){return []}; return function(){return elemStub()}; }, set(){return true;} });
global.window = { addEventListener(){}, mj:null, snd:{}, localStorage:{getItem(){return null},setItem(){}}, URLSearchParams:function(){return {get(){return null}}} };
global.document = doc;

// ================= 改进版核心 =================
function removeTiles(tiles, toRemove){ const r=tiles.slice(); toRemove.forEach(t=>{const i=r.indexOf(t); if(i>=0)r.splice(i,1);}); return r; }
function countTiles(hand){ const c={}; hand.forEach(t=>c[t]=(c[t]||0)+1); return c; }

// 用鬼作为顺子低位，需允许 first 作中位/末位。完整覆盖：
function trySets(tiles, ghostCount){
  if (tiles.length === 0) return ghostCount % 3 === 0;
  const first = tiles[0];
  const counts = countTiles(tiles);
  const c = counts[first];
  const suit = first[0], num = parseInt(first.slice(1));
  const isNum = (suit==='W'||suit==='T'||suit==='D');

  // 刻子：用 1..min(c,3) 张 real + 3-useReal 鬼
  const maxReal = Math.min(c,3);
  for (let useReal=maxReal; useReal>=1; useReal--){
    const g = 3-useReal;
    if (ghostCount>=g){
      const rem = removeTiles(tiles, Array(useReal).fill(first));
      if (trySets(rem, ghostCount-g)) return true;
    }
  }

  if (isNum){
    const t2 = suit+(num+1), t3 = suit+(num+2);
    const hn = first[0];
    // (1) first 作顺子首：first, num+1, num+2  (num+1,num+2 各 real 或鬼)
    if (num<=7){
      const have2 = counts[t2]>0, have3 = counts[t3]>0;
      const g = (have2?0:1)+(have3?0:1);
      if (ghostCount>=g){
        let rem = removeTiles(tiles,[first]);
        if (have2) rem = removeTiles(rem,[t2]);
        if (have3) rem = removeTiles(rem,[t3]);
        if (trySets(rem, ghostCount-g)) return true;
      }
    }
    // (2) first 作顺子中位：num-1(鬼), first, num+1 (num+1 real 或鬼)
    //     first 是最小真牌 → num-1 必为鬼；num+1 可为真牌或鬼
    if (num>=2 && num<=8){
      const tNext = suit+(num+1);
      const have3 = counts[tNext]>0;
      const g = 1 + (have3?0:1);
      if (ghostCount>=g){
        let rem = removeTiles(tiles,[first]);
        if (have3) rem = removeTiles(rem,[tNext]);
        if (trySets(rem, ghostCount-g)) return true;
      }
    }
    // (3) first 作顺子末位：num-2(鬼), num-1(鬼), first
    if (num>=3){
      if (ghostCount>=2){
        const rem = removeTiles(tiles,[first]);
        if (trySets(rem, ghostCount-2)) return true;
      }
    }
  }
  return false;
}

function trySetsOne(tiles, ghostCount){
  if (tiles.length === 0) return ghostCount === 1;        // 单吊=鬼
  if (ghostCount === 0 && tiles.length === 1) return true; // 单吊=真牌
  const first = tiles[0];
  const counts = countTiles(tiles);
  const c = counts[first];
  const suit = first[0], num = parseInt(first.slice(1));
  const isNum = (suit==='W'||suit==='T'||suit==='D');

  // A) 把 first 留作单吊牌
  if (trySets(removeTiles(tiles,[first]), ghostCount)) return true;

  // B) first 组成刻子
  const maxReal = Math.min(c,3);
  for (let useReal=maxReal; useReal>=1; useReal--){
    const g=3-useReal;
    if (ghostCount>=g){
      const rem = removeTiles(tiles, Array(useReal).fill(first));
      if (trySetsOne(rem, ghostCount-g)) return true;
    }
  }

  // C) first 组成顺子（首/中/末）
  if (isNum){
    const t2 = suit+(num+1), t3 = suit+(num+2);
    if (num<=7){
      const have2 = counts[t2]>0, have3 = counts[t3]>0;
      const g = (have2?0:1)+(have3?0:1);
      if (ghostCount>=g){
        let rem = removeTiles(tiles,[first]);
        if (have2) rem = removeTiles(rem,[t2]);
        if (have3) rem = removeTiles(rem,[t3]);
        if (trySetsOne(rem, ghostCount-g)) return true;
      }
    }
    if (num>=2 && num<=8){
      const tNext = suit+(num+1);
      const have3 = counts[tNext]>0;
      const g = 1 + (have3?0:1);
      if (ghostCount>=g){
        let rem = removeTiles(tiles,[first]);
        if (have3) rem = removeTiles(rem,[tNext]);
        if (trySetsOne(rem, ghostCount-g)) return true;
      }
    }
    if (num>=3){
      if (ghostCount>=2){
        const rem = removeTiles(tiles,[first]);
        if (trySetsOne(rem, ghostCount-2)) return true;
      }
    }
  }
  return false;
}

// tryWin 不变：抽查 original 逻辑实际用了将拆分，这里保留原版（仅替换 trySets/trySetsOne）
function tryWin(tiles, ghostCount){
  if (tiles.length === 0) return ghostCount === 0 || ghostCount === 2;
  if (tiles.length + ghostCount < 2) return false;
  const counts = countTiles(tiles);
  const keys = Object.keys(counts);
  for (let i=0;i<keys.length;i++){
    const t=keys[i], c=counts[t];
    if (c>=2){ if (trySets(removeTiles(tiles,[t,t]), ghostCount)) return true; }
    if (c>=1 && ghostCount>=1){ if (trySets(removeTiles(tiles,[t]), ghostCount-1)) return true; }
  }
  if (ghostCount>=2){ if (trySets(tiles, ghostCount-2)) return true; }
  return false;
}

// 供 tryWin 等使用 removeTiles/countTiles 闭包 —— 用全局
// 组装成独立上下文
const ctx = { trySets, trySetsOne, tryWin, removeTiles, countTiles };

// ===== 加载生产 mahjong.js 用于对照 + 复用辅助函数 =====
const mjSrc = fs.readFileSync('D:/TRAE/WYMJ/js/mahjong.js','utf8');
eval(mjSrc);
const prodM = window.mj;

// 将新核心挂到生产对象上（仅便于复用其检验函数）
prodM.__NS_trySets = trySets;
prodM.__NS_trySetsOne = trySetsOne;
prodM.__NS_tryWin = tryWin;

// ===== 复用 fuzz 生成器 =====
function rnd(a){ return a[Math.floor(Math.random()*a.length)]; }
function rndn(n){ return Math.floor(Math.random()*n); }
const NUM = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','T1','T2','T3','T4','T5','T6','T7','T8','T9','W1','W2','W3','W4','W5','W6','W7','W8','W9'];
const HON = ['Z1','Z2','Z3','Z4','Z5','Z6','Z7'];
function genValidHand(meldCount, useGhost, ghost){
  const melds=[]; const nonMeld=[];
  const suitChar = rnd(['D','T','W']);
  for (let i=0;i<meldCount;i++){
    const t = useGhost && Math.random()<0.3 ? ghost : rnd([...NUM,...HON]);
    melds.push({type:'peng', tiles:[t,t,t], from:1});
  }
  const setsNeed = 4 - meldCount;
  const pairTile = useGhost && Math.random()<0.2 ? ghost : rnd([...NUM,...HON]);
  nonMeld.push(pairTile, pairTile);
  for (let i=0;i<setsNeed;i++){
    if (Math.random()<0.8){ const n=rndn(7)+1; nonMeld.push(suitChar+n, suitChar+(n+1), suitChar+(n+2)); }
    else { const t=rnd([...NUM,...HON]); nonMeld.push(t,t,t); }
  }
  for (let i=nonMeld.length-1;i>0;i--){ const j=rndn(i+1); const tmp=nonMeld[i]; nonMeld[i]=nonMeld[j]; nonMeld[j]=tmp; }
  return { hand:nonMeld, melds };
}

// 新 checkWin：用新 tryWin
function newCheckWin(hand, ghost, melds){
  if (prodM.check13Orphans(hand, ghost)) return true;
  if (prodM.checkSevenPairs(hand, ghost)) return true;
  const counts = countTiles(hand);
  let ghostCount = ghost ? (counts[ghost]||0) : 0;
  let normal = [];
  Object.keys(counts).forEach(t=>{ if(t!==ghost){ for(let i=0;i<counts[t];i++) normal.push(t); } });
  normal = prodM.sortHand(normal);
  return tryWin(normal, ghostCount);
}

let pass=0, fail=0, tested=0;
for (let iter=0; iter<20000; iter++){
  const useGhost = Math.random()<0.5;
  const ghost = useGhost ? (rnd(['D','T','W']) + (rndn(9)+1)) : null;
  const meldCount = rndn(3);
  const o = genValidHand(meldCount, useGhost, ghost);
  const hand = o.hand.slice();
  if (useGhost && Math.random()<0.5 && hand.length>0) hand[rndn(hand.length)] = ghost;
  const r = newCheckWin(hand, ghost, o.melds);
  if (r){ pass++; }
  else {
    fail++;
    if (fail<=8) console.log('NEW FAIL hand='+JSON.stringify(hand)+' ghost='+ghost+' melds='+JSON.stringify(o.melds));
  }
  tested++;
}
console.log('改进版 合法胡恒真: tested='+tested+' pass='+pass+' fail='+fail);

// ===== 负向：纯 3-面子 缺1不成对 等（随机凑 4 顺子刻子 + 2单张 → 不应胡）
let negPass=0, negFail=0;
for (let iter=0; iter<5000; iter++){
  const hand=[];
  for (let i=0;i<4;i++){
    if (Math.random()<0.7){ const n=rndn(7)+1, s=rnd(['D','T','W']); hand.push(s+n,s+(n+1),s+(n+2)); }
    else { const t=rnd([...NUM,...HON]); hand.push(t,t,t); }
  }
  hand.push(rnd([...NUM,...HON]), rnd([...NUM,...HON])); // 4面子+2单张=14张，多数不能胡
  const r = newCheckWin(hand, null, []);
  if (r===false) negPass++;
  else {
    negFail++;
    if (negFail<=8) console.log('新的负样本反而胡(可能合法也应算): hand='+JSON.stringify(hand));
  }
}
console.log('负向抽样 判定不可胡: tested='+(negPass+negFail)+' pass='+negPass+' 提示=vail('+(negFail)+')');

// 决定性专项：三个已知失败用例 + T8T9鬼7
function t(hand,ghost,melds,name){
  const r=newCheckWin(hand,ghost,melds);
  console.log((r?'PASS ':'FAIL ')+name+' -> '+r);
}
console.log('=== 决定性专项 ===');
t(["T9","T8","T4","T6","T7","T7","T3","T2","T4","Z3","T5","T5","Z3","T6"], 'T7', [], 'Ghost串顺 T5T6T7+T7T8T9');
t(["T9","T4","D6","T5","W1","T3","T6","T5","T5","T7","T8","D6","T4","T3"], 'W1', [], 'Ghost补T7 拆双顺');
t(['T5','T6','T8','T9','W1','W1','D5','D5','D5','T2','T3','T4','W9','W9'], null, [], 'T8T9+将需鬼(无鬼应不可胡) -> false 预期');
console.log('单吊决定:');
t(['W1','W2','W3','W4','W5','W6','W7','W8','W9','D5','D5'], null, [{type:'peng',tiles:['Z1','Z1','Z1'],from:1}], '碰+清一色吊将 isDanDiao');
console.log('结果: fail='+fail+' negSuggestive='+negFail);
process.exit(fail ? 1 : 0);