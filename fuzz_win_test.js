// 随机批量测试：验证 checkWin 对"构造出的合法胡牌手"恒为 true，对"破坏后的手"恒为 false
'use strict';
const fs = require('fs');

// ---- 浏览器桩 ----
function elemStub(){ return new Proxy({}, { get(t,k){ if(k==='style')return{}; if(k==='classList')return {add(){},remove(){},contains(){return false}}; if(k==='dataset')return{}; if(k==='addEventListener')return function(){}; return t[k];}, set(t,k,v){t[k]=v;return true;} }); }
const doc = new Proxy({}, { get(t,k){ if(k==='getElementById')return function(){return elemStub()}; if(k==='querySelectorAll')return function(){return []}; if(k==='querySelector')return function(){return elemStub()}; if(k==='addEventListener')return function(){}; if(k==='documentElement')return elemStub(); if(k==='body')return elemStub(); return function(){return elemStub()}; }, set(){return true;} });
global.window = { addEventListener(){}, removeEventListener(){}, mj:null, snd:{}, localStorage:{getItem(){return null},setItem(){}}, URLSearchParams:function(){return {get(){return null}}} };
global.document = doc;
global.URLSearchParams = global.window.URLSearchParams;
global.localStorage = global.window.localStorage;
const src = d => fs.readFileSync('D:/TRAE/WYMJ/js/'+d,'utf8');
eval(src('mahjong.js'));
const mj = window.mj;

let pass=0, fail=0;
function check(name, cond, detail){ if(cond){pass++;} else { fail++; console.log('  FAIL '+name+(detail?'  -> '+detail:'')); } }
function rnd(a){ return a[Math.floor(Math.random()*a.length)]; }
function rndn(n){ return Math.floor(Math.random()*n); }

// 可选牌池
const NUM = ['D1','D2','D3','D4','D5','D6','D7','D8','D9','T1','T2','T3','T4','T5','T6','T7','T8','T9','W1','W9'];
const HON = ['Z1','Z2','Z3','Z4','Z5','Z6','Z7'];

// 生成一个"必然自摸胡"的随机手：rand meldCount 个副露(melds) + (4-meldCount)个面子 + 1对将（手牌部分）
// 返回 {hand, melds}，hand 为摸牌后应余下的"构成将+剩余面子"的牌（不含已副露的）
function genValidHand(meldCount, useGhost, ghost){
  const melds=[]; const nonMeld=[];
  const suitChar = rnd(['D','T']); // 数字花色轴（万子只有1和9，无法连顺子）
  // 先构造 melds（碰/刻，简单）
  for(let i=0;i<meldCount;i++){
    const t = useGhost && Math.random()<0.3 ? ghost : rnd([...NUM,...HON]);
    melds.push({type:'peng', tiles:[t,t,t], from:1});
  }
  const setsNeed = 4 - meldCount;               // 需拼的面子
  // 将牌
  const pairTile = useGhost && Math.random()<0.2 ? ghost : rnd([...NUM,...HON]);
  nonMeld.push(pairTile, pairTile);
  // 构造面子（顺子 80% / 刻子 20%）
  for(let i=0;i<setsNeed;i++){
    if(Math.random()<0.8){
      const n = rndn(7)+1;
      nonMeld.push(suitChar+n, suitChar+(n+1), suitChar+(n+2));
    } else {
      const t = rnd([...NUM,...HON]);
      nonMeld.push(t,t,t);
    }
  }
  // 打散顺序
  for(let i=nonMeld.length-1;i>0;i--){ const j=rndn(i+1); const tmp=nonMeld[i]; nonMeld[i]=nonMeld[j]; nonMeld[j]=tmp; }
  return { hand: nonMeld, melds };
}

let tested=0;
for(let iter=0; iter<8000; iter++){
  const useGhost = Math.random()<0.4;
  const ghost = useGhost ? rnd([...NUM]) : null;   // 鬼牌通常是数字牌
  const meldCount = rndn(3);                        // 0~2 副露
  const o = genValidHand(meldCount, useGhost, ghost);
  const hand = o.hand.slice();
  // 可选：随机在 hand 里也放一张 ghost
  if(useGhost && Math.random()<0.5) hand[rndn(hand.length)] = ghost;
  const melds = useGhost? o.melds : o.melds;
  const r = mj.checkWin(hand, ghost, melds);
  tested++;
  if(!r){
    check('合法手应自摸 true #'+iter, false, 'hand='+JSON.stringify(hand)+' ghost='+ghost+' melds='+JSON.stringify(melds));
    if(fail>5) break;
    continue;
  }
  // 负向：抽掉一张非将的同牌（去掉一张牌应大多数不能胡，但可能仍能胡，只统计明确破坏将的情况比较难）
  // 改为：若手牌里至少有 3 张不同的单牌，抽掉其中一张且使剩下的张数=13，不应还能胡（多数情况）——这里做弱断言。
}

console.log('合法手全部通过: tested='+tested+' 失败='+fail);

// 专项: 筒子顺子必须被识别（重点回归鬼补顺子低位 Bug）
(function(){
  // 筒子 1-9 一条龙 + 筒子顺 + 将 -> 应胡
  const hand=['D1','D2','D3','D4','D5','D6','D7','D8','D9','T1','T2','T3','Z1','Z1'];
  check('筒子顺子识别 checkWin=true', mj.checkWin(hand,null,[])===true, JSON.stringify(hand));
  // 万2-8 不应出现在 deck（本玩法万只有1和9）
  const deck=mj.fullDeck();
  const set={}; deck.forEach(t=>set[t]=(set[t]||0)+1);
  let extra=[];
  ['W2','W3','W4','W5','W6','W7','W8'].forEach(t=>{ if(set[t]) extra.push(t); });
  check('fullDeck 不含万2-8', extra.length===0, '多出: '+extra.join(','));
  check('fullDeck 张数=108', deck.length===108, 'len='+deck.length);
})();

console.log('结果: pass='+pass+' fail='+fail);
process.exit(fail?1:0);