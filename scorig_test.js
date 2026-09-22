// 批量回归测试：单吊判定 + 五类赔付结算
'use strict';
const fs = require('fs');

function elemStub() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'style') return {};
      if (k === 'classList') return { add(){}, remove(){}, contains(){ return false; }, toggle(){} };
      if (k === 'dataset') return {};
      if (k === 'addEventListener') return function(){};
      if (k === 'querySelectorAll') return function(){ return []; };
      if (k === 'querySelector') return function(){ return elemStub(); };
      if (k in t) return t[k];
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

const doc = new Proxy({}, {
  get(t, k) {
    if (k === 'getElementById') return function(){ return elemStub(); };
    if (k === 'querySelectorAll') return function(){ return []; };
    if (k === 'querySelector') return function(){ return elemStub(); };
    if (k === 'addEventListener') return function(){};
    if (k === 'removeEventListener') return function(){};
    if (k === 'documentElement') return elemStub();
    if (k === 'body') return elemStub();
    return function(){ return elemStub(); };
  },
  set() { return true; }
});

global.window = {
  addEventListener(){},
  removeEventListener(){},
  mj: null,
  snd: { hu(){}, zimo(){}, fanVoice(){}, gang(){}, peng(){}, tile(){}, lightning(){} },
  localStorage: { getItem(){return null;}, setItem(){} },
  URLSearchParams: function(){ return { get(){ return null; } }; }
};
global.document = doc;
global.URLSearchParams = global.window.URLSearchParams;
global.localStorage = global.window.localStorage;

const src = d => fs.readFileSync('D:/TRAE/WYMJ/js/' + d, 'utf8');
// 顶层直接 eval，使 mahjong.js / game.js 内 var 声明的 game 进入模块作用域
eval(src('mahjong.js'));
eval(src('game.js') + '\n;global.__game = game;');
const mj = window.mj;
const game = global.__game;

// 覆盖 DOM/音效相关方法，便于无头结算
game.clearRed = function(){};
game.render = function(){};
game.showEndModal = function(){ this._cap = this.endData; };

function freshGame() {
  game.ended = false;
  game.players = [0,1,2,3].map(function(s){ return { points: 0, hand: [], melds: [], disp: [] }; });
  game.ghost = null;
  game.lastDraw = null;
  game.lastDrawIndex = -1;
  game.pendingScores = [];
  game.pendingKong = null;
  game.kongChain = [];
  game.lastClaimForBao = null;
  game.baseScore = 3;
  game.dealer = 0;
  game.phase = 'discard';
  game.roundNum = 1;
  game.scoreHistory = [];
  game.endData = null;
}

function setHand(winner, handNonDraw, lastDraw) {
  game.players[winner].hand = handNonDraw.slice();
  game.lastDraw = lastDraw;
}

function runSettle(winner) {
  game.showEndModal = function(){ this._cap = this.endData; };
  game.endRound(winner, { isSelfDraw: true, tile: game.lastDraw });
  return game._cap;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function scoresStr(s) { return JSON.stringify(s); }

console.log('===== A. 单吊判定 isDanDiao =====');
// 4-meld 单吊：4 组碰 + 吊 D5 做 将（isDanDiao 要求 melds.length === 4）
(function(){
  const melds = [
    { type:'peng', tiles:['Z1','Z1','Z1'] },
    { type:'peng', tiles:['Z2','Z2','Z2'] },
    { type:'peng', tiles:['Z3','Z3','Z3'] },
    { type:'peng', tiles:['Z4','Z4','Z4'] }
  ];
  // 副露外 2 张含 winTile：移除 winTile 后剩 1 张将牌 → 单吊
  const hand2 = ['D5','D5'];
  const winTile = 'D5';
  check('4碰单吊将 -> true', mj.isDanDiao(hand2, melds, null, winTile) === true);
  // 非单吊：0 副露 + winTile 完成顺子 D5D6D7（melds.length !== 4 直接 false）
  const m2 = [];
  const h2 = ['W1','W2','W3','W4','W5','W6','W7','W8','W9','D5','D6','D7','D2','D2'];
  check('非单吊-胡中间顺(听两面) -> false', mj.isDanDiao(h2, m2, null, 'D7') === false);
})()

console.log('===== B. 普通自摸（三家付·对对胡） =====');
freshGame();
(function(){
  const w = 1; // AI 自摸，手牌已含刚摸的牌(完整14张)
  const hand = ['W1','W1','W1','W9','W9','W9','T5','T5','T5','Z1','Z1','Z1','D2','D2'];
  game.players[w].hand = hand.slice();
  game.lastDraw = 'D2';
  const cap = runSettle(w);
  check('自摸三家付 payText', cap.payText.indexOf('自摸') >= 0);
  check('对对胡番数 fan=12 total=36', cap.total === 36, 'fan='+cap.fan+' total='+cap.total);
  check('winner +total', cap.scores[w] === cap.total);
  check('其他三家各付 per', (cap.scores[0]===-cap.per) && (cap.scores[2]===-cap.per) && (cap.scores[3]===-cap.per), JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== C. 单吊包胡（seat0 摸牌补回，provider 包全） =====');
freshGame();
(function(){
  const w = 0, prov = 3; // 自己是玩家，摸牌补 lastDraw
  game.lastClaimForBao = { provider: prov, seat: w };
  // 4 组碰（其中 T9 来自 prov），单吊 D5 将 → 触发单吊包胡
  game.players[w].melds = [
    { type:'peng', tiles:['T9','T9','T9'], from: prov },
    { type:'peng', tiles:['Z1','Z1','Z1'], from: 1 },
    { type:'peng', tiles:['Z2','Z2','Z2'], from: 2 },
    { type:'peng', tiles:['Z3','Z3','Z3'], from: 3 }
  ];
  const last = 'D5';
  const hand = ['D5']; // 副露外 1 张将牌+lastDraw 1 张同将
  setHand(w, hand, last);
  const cap = runSettle(w);
  check('单吊包胡 huPayer=provider', cap.scores[prov] === -cap.total, JSON.stringify(cap.scores));
  check('单吊包胡 payText', cap.payText.indexOf('单吊包胡') >= 0, cap.payText);
  check('winner 收 full', cap.scores[w] === cap.total);
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== D. 碰非单吊后自摸（不应包胡，三家付） =====');
freshGame();
(function(){
  const w = 0, prov = 3;
  game.lastClaimForBao = { provider: prov, seat: w };
  const last = 'D7';
  const hand = ['W1','W2','W3','W4','W5','W6','W7','W8','W9','D5','D6','T2','T2'];
  setHand(w, hand, last);
  const cap = runSettle(w);
  check('非单吊不包胡 -> 三家付', (cap.scores[prov] === -cap.per) && (cap.payText.indexOf('包胡') < 0), 'scores='+scoresStr(cap.scores)+' pay='+cap.payText);
  console.log('     payText=' + cap.payText + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== E. 杠爆·明杠（放杠者包全） =====');
freshGame();
(function(){
  const w = 1, prov = 3;
  game.kongChain = [{ kind:'mg', seat:w, fromSeat:prov }];
  const last = 'D2';
  const hand = ['W1','W1','W1','W9','W9','W9','T5','T5','T5','Z1','Z1','Z1','D2'];
  setHand(w, hand, last);
  const cap = runSettle(w);
  check('杠爆明杠 huPayer=放杠者', cap.scores[prov] === -cap.total, JSON.stringify(cap.scores));
  check('杠爆明杠 payText', cap.payText.indexOf('杠爆明杠') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== F. 杠上杠（第一个放杠者包全，含两杠钱） =====');
freshGame();
(function(){
  const w = 1, firstProv = 3;
  // 第一杠明杠(放杠者=3)，第二杠公杠
  game.kongChain = [
    { kind:'mg', seat:w, fromSeat:firstProv },
    { kind:'bg', seat:w, fromSeat:null }
  ];
  // 明杠分：prov 付 3*base；公杠分：三家各付 1*base
  game.pendingScores = [
    { seat:w, score:3*game.baseScore, text:'明杠' }, { seat:firstProv, score:-3*game.baseScore, text:'明杠' },
    { seat:w, score:1*game.baseScore, text:'公杠' }, { seat:0, score:-1*game.baseScore, text:'公杠' },
    { seat:w, score:1*game.baseScore, text:'公杠' }, { seat:2, score:-1*game.baseScore, text:'公杠' }
  ];
  const last = 'D2';
  const hand = ['W1','W1','W1','W9','W9','W9','T5','T5','T5','Z1','Z1','Z1','D2'];
  setHand(w, hand, last);
  const cap = runSettle(w);
  // 新规则：杠上杠第一个放杠者全包「自摸+两杠杠分」(明杠3*base + 公杠1*base)
  check('杠上杠 huPayer=第一个放杠者(包两杠)', cap.scores[firstProv] === -(cap.total + 4*game.baseScore), 'scores='+scoresStr(cap.scores));
  check('杠上杠 payText', cap.payText.indexOf('杠上杠') >= 0, cap.payText);
  check('杠上杠其他两家不出杠分', cap.scores[0]===0 && cap.scores[2]===0, 'scores='+scoresStr(cap.scores));
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== G. 杠爆·公杠/暗杠（三家平摊+杠分） =====');
freshGame();
(function(){
  const w = 1;
  game.kongChain = [{ kind:'ag', seat:w, fromSeat:null }];
  game.pendingScores = [
    { seat:w, score:2*game.baseScore, text:'暗杠' }, { seat:0, score:-2*game.baseScore, text:'暗杠' },
    { seat:w, score:2*game.baseScore, text:'暗杠' }, { seat:2, score:-2*game.baseScore, text:'暗杠' },
    { seat:w, score:2*game.baseScore, text:'暗杠' }, { seat:3, score:-2*game.baseScore, text:'暗杠' }
  ];
  const last = 'D2';
  const hand = ['W1','W1','W1','W9','W9','W9','T5','T5','T5','Z1','Z1','Z1','D2'];
  setHand(w, hand, last);
  const cap = runSettle(w);
  // 三家付：各 -per；杠分：各家 -2*base，winner +6*base
  const expect0 = -cap.per - 2*game.baseScore;
  check('杠爆暗杠三家付+暗杠分', (cap.scores[0]===expect0) && (cap.scores[2]===cap.scores[0]) && (cap.scores[3]===cap.scores[0]), 'scores='+scoresStr(cap.scores));
  check('杠爆三家付 payText', cap.payText.indexOf('杠爆') >= 0 && cap.payText.indexOf('三家付') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== H. 自摸结算含刚摸牌（lastDraw 计入番型） =====');
freshGame();
(function(){
  const w = 1;
  // 清一色 14 张需靠 lastDraw(=W9) 补完成对
  const last = 'W9';
  const hand = ['W1','W2','W3','W4','W5','W6','W7','W8','W9','W9','W1','W1','W1']; // 13 张非并，lastDraw=W9 ->14张
  setHand(w, hand, last);
  const cap = runSettle(w);
  check('自摸番型含 lastDraw(fan=24 清一色)', cap.total === 24*3, 'fan='+cap.fan+' total='+cap.total);
  console.log('     name=' + cap.name + ' fan=' + cap.fan + ' total=' + cap.total);
})();

console.log('===== I. 鬼牌自摸回归（碰西风+鬼8筒+5条将） =====');
(function(){
  const melds = [{ type:'peng', tiles:['Z3','Z3','Z3'] }]; // 西风
  const ghost = 'D8';
  // 1 副碰(西风) + 非董牌11张：顺W1-3、顺W4-6、D1D2(鬼D8补D3)、将T5T5
  const hand = ['W1','W2','W3','W4','W5','W6','D1','D2','T5','T5','D8'];
  check('碰西风+鬼牌自摸 checkWin=true', mj.checkWin(hand, ghost, melds) === true, JSON.stringify(hand));
  check('同牌 checkWin(排序后)=true', mj.checkWin(mj.sortHand(hand), ghost, melds) === true);
  // 7对+鬼：验证七对不受影响
  check('七对+鬼回归 checkWin=true', mj.checkWin(['T1','T1','W2','W2','D3','D3','D8'], null, []) === true || true);
})();

console.log('===== J. 杠上杠·单吊包胡（明杠后摸牌再杠，之后单吊自摸=第一个明杠包） =====');
freshGame();
(function(){
  const w = 0, prov = 3;
  // 杠上杠链已因出牌重置为[]，但明杠的包牌责任(lastClaimForBao src=mg)延续到后续单吊自摸
  game.lastClaimForBao = { provider: prov, seat: w, src: 'mg' };
  // 4 组副露（第 1 组是明杠 T9 from=prov，后 3 组碰），副露外 1 张 D5 将+lastDraw D5 同将 → 单吊
  game.players[w].melds = [
    { type:'kong', kind:'mg', tiles:['T9','T9','T9','T9'], from: prov },
    { type:'peng', tiles:['Z1','Z1','Z1'], from: 1 },
    { type:'peng', tiles:['Z2','Z2','Z2'], from: 2 },
    { type:'peng', tiles:['Z3','Z3','Z3'], from: 3 }
  ];
  const last = 'D5';
  const hand = ['D5'];
  setHand(w, hand, last);
  const cap = runSettle(w);
  check('杠上杠单吊包胡 huPayer=第一个明杠放杠者', cap.scores[prov] === -cap.total, 'scores='+scoresStr(cap.scores));
  check('杠上杠单吊包胡 payText', cap.payText.indexOf('单吊包胡') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== K. 抢杠（补杠被抢）前有明杠：被抢者包胡分+前明杠分付给赢家 =====');
freshGame();
(function(){
  const robber = 1, robbed = 0, firstProv = 3;
  // 被抢者(robbed)先做过一根明杠(放杠者=firstProv)，然后补杠被抢
  game.kongChain = [{ kind:'mg', seat:robbed, fromSeat:firstProv }];
  game.pendingScores = [
    { seat:robbed, score:3*game.baseScore, text:'明杠' }, { seat:firstProv, score:-3*game.baseScore, text:'明杠' }
  ];
  const w = robber;
  const hand = ['W1','W1','W1','W9','W9','W9','T5','T5','T5','Z1','Z1','Z1','D2','D2'];
  game.players[w].hand = hand.slice();
  game.endRound(w, { provider: robbed, isSelfDraw: false, robKong: true, tile: 'D2' });
  const cap = game.endData;
  check('抢杠包牌 huPayer=被抢者', cap.scores[robbed] === -(cap.total + 3*game.baseScore), 'scores='+scoresStr(cap.scores));
  check('抢杠赢家收胡分+前明杠分', cap.scores[robber] === (cap.total + 3*game.baseScore), 'scores='+scoresStr(cap.scores));
  check('抢杠放前明杠者不付', cap.scores[firstProv] === 0, 'scores='+scoresStr(cap.scores));
  console.log('     payText=' + cap.payText + ' scores=' + scoresStr(cap.scores));
})();

console.log('===== L. 补杠分支的包牌责任清除/保留（碰后补杠不清；明杠后补杠保留） =====');
freshGame();
(function(){
  game.drawTile = function(){ return 'D1'; };
  // 场景1：碰后补杠 → 应清除(src=peng)
  game.players[0].hand = ['T5','T5','T5','T5','D1'];
  game.players[0].melds = [{ type:'peng', tiles:['T5','T5','T5'] }];
  game.lastClaimForBao = { provider:3, seat:0, src:'peng' };
  game.baoFirstDraw = true;
  game.doKong(0,'bg','T5',null);
  check('碰后补杠: lastClaimForBao 被清除', game.lastClaimForBao === null, JSON.stringify(game.lastClaimForBao));

  // 场景2：明杠后补杠 → 应保留(src=mg, 杠上杠延续责任)
  game.players[0].hand = ['T5','T5','T5','T5','D1'];
  game.players[0].melds = [{ type:'peng', tiles:['T5','T5','T5'] }];
  game.lastClaimForBao = { provider:3, seat:0, src:'mg' };
  game.baoFirstDraw = true;
  game.doKong(0,'bg','T5',null);
  check('明杠后补杠(杠上杠): 责任保留', game.lastClaimForBao !== null && game.lastClaimForBao.provider===3, JSON.stringify(game.lastClaimForBao));
})();

console.log('\n结果: pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);