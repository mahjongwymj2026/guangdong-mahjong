'use strict';
const fs = require('fs');
function elemStub(){ return new Proxy({}, { get(t,k){ if(k==='style')return{}; if(k==='classList')return {add(){},remove(){},contains(){return false}}; return t[k];}, set(t,k,v){t[k]=v;return true;} }); }
const doc = new Proxy({}, { get(t,k){ if(k==='getElementById')return function(){return elemStub()}; if(k==='querySelectorAll')return function(){return []}; return function(){return elemStub()}; }, set(){return true;} });
global.window = { addEventListener(){}, mj:null, snd:{}, localStorage:{getItem(){return null},setItem(){}}, URLSearchParams:function(){return {get(){return null}}} };
global.document = doc;
const src=d=>fs.readFileSync('D:/TRAE/WYMJ/js/'+d,'utf8');
eval(src('mahjong.js'));
const mj=window.mj;

// 用例 #137
const ghost='T7';
const hand=["T9","T8","T4","T6","T7","T7","T3","T2","T4","Z3","T5","T5","Z3","T6"];
console.log('hand len', hand.length);
console.log('checkWin', mj.checkWin(hand, ghost, []));
console.log('checkSevenPairs', mj.checkSevenPairs(hand, ghost));
console.log('check13Orphans', mj.check13Orphans(hand, ghost));

// 手工分解成正常牌
const counts={}; hand.forEach(t=>counts[t]=(counts[t]||0)+1);
const norm=[]; Object.keys(counts).forEach(t=>{ if(t!==ghost){for(let i=0;i<counts[t];i++)norm.push(t);} });
const sorted=mj.sortHand(norm);
console.log('normal', JSON.stringify(sorted), 'ghostCount', counts['T7']||0);
console.log('tryWin', mj.__tryWin(sorted, 2));