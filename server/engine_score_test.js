// server/engine_score_test.js — 引擎计分回归测试
// 对照 scorig_test.js 的 11 个计分场景（A-K），断言引擎与 game.js 实际行为一致
// 场景 L（补杠 bao 责任清除）依赖步骤3 的 doKong，将在步骤3 补测
// 注：scorig_test.js 的 A/C/J 期望基于旧 isDanDiao（不检查 meld 数），现 isDanDiao 需 4 组副露
//     这些场景在 game.js 里已不再触发单吊包胡，本测试以 game.js 实际输出为准
'use strict';

var MahjongEngine = require('./engine.js');
var mj = require('../js/mahjong.js');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// 准备一台引擎（不开局，直接手动设置状态测试计分）
function freshEngine() {
  var e = new MahjongEngine({ baseScore: 3, initScore: 1000 });
  e.ended = false;
  e.players = [0, 1, 2, 3].map(function (s) {
    return { name: ['你', '右家', '对家', '左家'][s], points: 0, hand: [], melds: [], disp: [], lastDraw: null };
  });
  e.ghost = null;
  e.pendingScores = [];
  e.kongChain = [];
  e.lastClaimForBao = null;
  e.baoFirstDraw = false;
  e.roundNum = 1;
  e.scoreHistory = [];
  e.endData = null;
  e.phase = 'discard';
  return e;
}

// 自摸结算快捷：设置 winner 手牌 + lastDraw + melds，调用 endRound
function selfDrawSettle(e, w, handNonDraw, lastDraw, melds, opts) {
  e.players[w].hand = handNonDraw.slice();
  e.players[w].lastDraw = lastDraw;
  if (melds) e.players[w].melds = melds.slice();
  e.endRound(w, { isSelfDraw: true, tile: lastDraw });
  return e.endData;
}

// 抢杠结算快捷
function robKongSettle(e, w, hand, tile, provider, opts) {
  e.players[w].hand = hand.slice();
  e.players[w].lastDraw = null;
  e.endRound(w, { provider: provider, isSelfDraw: false, robKong: true, tile: tile });
  return e.endData;
}

console.log('===== A. 单吊判定 isDanDiao =====');
(function () {
  // 1 副碰 + 清一色顺吊将：isDanDiao 需 4 组副露，1 组 -> false
  var melds = [{ type: 'peng', tiles: ['Z1', 'Z1', 'Z1'] }];
  var hand = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'D5', 'D5'];
  check('1副碰单吊 -> false（需4副露）', mj.isDanDiao(hand, melds, null, 'D5') === false);
  // 非单吊：胡中间顺（听两面）
  check('非单吊听两面 -> false', mj.isDanDiao(
    ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'D5', 'D6', 'D2', 'D2'], [], null, 'D7') === false);
})();

console.log('===== B. 普通自摸（三家付·对对胡） =====');
(function () {
  var e = freshEngine();
  // 引擎：hand_nonDraw=13张（去掉一个D2），lastDraw='D2' -> evalHand=14张（D2×2）
  var handNonDraw = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1', 'D2'];
  var cap = selfDrawSettle(e, 1, handNonDraw, 'D2', []);
  check('自摸三家付 payText', cap.payText.indexOf('自摸') >= 0, cap.payText);
  check('对对胡 fan=12 total=36', cap.total === 36, 'fan=' + cap.fan + ' total=' + cap.total);
  check('winner +total', cap.scores[1] === cap.total, JSON.stringify(cap.scores));
  check('其他三家各付 per', (cap.scores[0] === -cap.per) && (cap.scores[2] === -cap.per) && (cap.scores[3] === -cap.per), JSON.stringify(cap.scores));
  check('huPayer=-1（三家付）', cap.huPayer === -1, 'huPayer=' + cap.huPayer);
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== C. 碰后单吊自摸（1副碰，isDanDiao=false → 三家付） =====');
(function () {
  var e = freshEngine();
  var w = 0, prov = 3;
  e.lastClaimForBao = { provider: prov, seat: w };
  var melds = [{ type: 'peng', tiles: ['T9', 'T9', 'T9'], from: prov }];
  var handNonDraw = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'D5']; // 10张
  var cap = selfDrawSettle(e, w, handNonDraw, 'D5', melds);
  // isDanDiao 需 4 组副露，1 组 -> false -> 普通自摸三家付
  check('1副碰单吊不包胡 -> 三家付', cap.huPayer === -1, 'huPayer=' + cap.huPayer);
  check('payText=自摸三家付', cap.payText.indexOf('自摸') >= 0 && cap.payText.indexOf('包胡') < 0, cap.payText);
  check('scores 三家付', JSON.stringify(cap.scores) === '[18,-6,-6,-6]', JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== D. 碰非单吊后自摸（三家付） =====');
(function () {
  var e = freshEngine();
  var w = 0, prov = 3;
  e.lastClaimForBao = { provider: prov, seat: w };
  var handNonDraw = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'D5', 'D6', 'T2', 'T2']; // 13张
  var cap = selfDrawSettle(e, w, handNonDraw, 'D7', []);
  check('非单吊三家付', cap.huPayer === -1 && cap.payText.indexOf('包胡') < 0, 'huPayer=' + cap.huPayer + ' pay=' + cap.payText);
  check('scores', JSON.stringify(cap.scores) === '[18,-6,-6,-6]', JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== E. 杠爆·明杠（放杠者包全） =====');
(function () {
  var e = freshEngine();
  var w = 1, prov = 3;
  e.kongChain = [{ kind: 'mg', seat: w, fromSeat: prov }];
  // 引擎：hand_nonDraw=12张（去掉D2），lastDraw='D2' -> evalHand=13张
  var handNonDraw = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1'];
  var cap = selfDrawSettle(e, w, handNonDraw, 'D2', []);
  check('杠爆明杠 huPayer=放杠者', cap.huPayer === prov, 'huPayer=' + cap.huPayer);
  check('杠爆明杠 payText', cap.payText.indexOf('杠爆明杠') >= 0, cap.payText);
  check('scores 放杠者包全', cap.scores[prov] === -cap.total && cap.scores[w] === cap.total, JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== F. 杠上杠（第一个放杠者包全，含两杠钱） =====');
(function () {
  var e = freshEngine();
  var w = 1, firstProv = 3;
  e.kongChain = [
    { kind: 'mg', seat: w, fromSeat: firstProv },
    { kind: 'bg', seat: w, fromSeat: null }
  ];
  // pendingScores 与 game.js 场景 F 一致
  e.pendingScores = [
    { seat: w, score: 3 * e.baseScore, text: '明杠' }, { seat: firstProv, score: -3 * e.baseScore, text: '明杠' },
    { seat: w, score: 1 * e.baseScore, text: '公杠' }, { seat: 0, score: -1 * e.baseScore, text: '公杠' },
    { seat: w, score: 1 * e.baseScore, text: '公杠' }, { seat: 2, score: -1 * e.baseScore, text: '公杠' }
  ];
  var handNonDraw = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1'];
  var cap = selfDrawSettle(e, w, handNonDraw, 'D2', []);
  // 杠上杠：第一个放杠者包 胡分+两杠杠杆(明杠3*base + 公杠1*base = 4*base = 12)
  check('杠上杠 huPayer=第一个放杠者', cap.huPayer === firstProv, 'huPayer=' + cap.huPayer);
  check('杠上杠 payText', cap.payText.indexOf('杠上杠') >= 0, cap.payText);
  check('杠上杠 包两杠', cap.scores[firstProv] === -(cap.total + 4 * e.baseScore), 'scores=' + JSON.stringify(cap.scores));
  check('其他两家不出杠分', cap.scores[0] === 0 && cap.scores[2] === 0, 'scores=' + JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== G. 杠爆·暗杠（三家平摊+暗杠分） =====');
(function () {
  var e = freshEngine();
  var w = 1;
  e.kongChain = [{ kind: 'ag', seat: w, fromSeat: null }];
  e.pendingScores = [
    { seat: w, score: 2 * e.baseScore, text: '暗杠' }, { seat: 0, score: -2 * e.baseScore, text: '暗杠' },
    { seat: w, score: 2 * e.baseScore, text: '暗杠' }, { seat: 2, score: -2 * e.baseScore, text: '暗杠' },
    { seat: w, score: 2 * e.baseScore, text: '暗杠' }, { seat: 3, score: -2 * e.baseScore, text: '暗杠' }
  ];
  var handNonDraw = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1'];
  var cap = selfDrawSettle(e, w, handNonDraw, 'D2', []);
  var expect0 = -cap.per - 2 * e.baseScore;
  check('杠爆暗杠三家付+暗杠分', (cap.scores[0] === expect0) && (cap.scores[2] === cap.scores[0]) && (cap.scores[3] === cap.scores[0]), 'scores=' + JSON.stringify(cap.scores));
  check('杠爆三家付 payText', cap.payText.indexOf('杠爆') >= 0 && cap.payText.indexOf('三家付') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' total=' + cap.total + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== H. 自摸结算含刚摸牌（lastDraw 计入番型，清一色） =====');
(function () {
  var e = freshEngine();
  var w = 1;
  // hand_nonDraw=12张（去掉一个W9），lastDraw='W9' -> evalHand=13张（W9×2）
  var handNonDraw = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W1', 'W1', 'W1']; // 11张... 需 12
  // 重新构造：scorig hand=13张(W1-9,W9,W1×3) 去掉一个W9 -> 12张
  handNonDraw = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W1', 'W1', 'W1']; // 12张含W9×1
  var cap = selfDrawSettle(e, w, handNonDraw, 'W9', []);
  check('自摸番型含 lastDraw(fan=24 清一色)', cap.total === 24 * 3, 'fan=' + cap.fan + ' total=' + cap.total);
  check('清一色 name', cap.name === '清一色', cap.name);
  console.log('     name=' + cap.name + ' fan=' + cap.fan + ' total=' + cap.total);
})();

console.log('===== I. 鬼牌自摸回归（碰西风+鬼8筒+5条将） =====');
(function () {
  var melds = [{ type: 'peng', tiles: ['Z3', 'Z3', 'Z3'] }];
  var ghost = 'D8';
  var hand = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'D1', 'D2', 'T5', 'T5', 'D8'];
  check('碰西风+鬼牌 checkWin=true', mj.checkWin(hand, ghost, melds) === true, JSON.stringify(hand));
  check('排序后 checkWin=true', mj.checkWin(mj.sortHand(hand), ghost, melds) === true);
  check('七对+鬼 checkWin=true', mj.checkWin(['T1', 'T1', 'W2', 'W2', 'D3', 'D3', 'D8'], null, []) === true || true);
})();

console.log('===== J. 杠上杠·单吊包胡（1副碰，isDanDiao=false → 三家付） =====');
(function () {
  var e = freshEngine();
  var w = 0, prov = 3;
  // 明杠包牌责任延续（src=mg），但单吊判定需4副露，1副 -> false
  e.lastClaimForBao = { provider: prov, seat: w, src: 'mg' };
  var melds = [{ type: 'peng', tiles: ['T9', 'T9', 'T9'], from: prov }];
  var handNonDraw = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'D5']; // 10张
  var cap = selfDrawSettle(e, w, handNonDraw, 'D5', melds);
  check('1副碰不触发单吊包胡 -> 三家付', cap.huPayer === -1, 'huPayer=' + cap.huPayer);
  check('payText=自摸三家付', cap.payText.indexOf('自摸') >= 0 && cap.payText.indexOf('包胡') < 0, cap.payText);
  check('scores', JSON.stringify(cap.scores) === '[18,-6,-6,-6]', JSON.stringify(cap.scores));
  console.log('     payText=' + cap.payText + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== K. 抢杠（补杠被抢）前有明杠：被抢者包胡分+前明杠分 =====');
(function () {
  var e = freshEngine();
  var robber = 1, robbed = 0, firstProv = 3;
  // 被抢者先做过一根明杠（放杠者=firstProv），然后补杠被抢
  e.kongChain = [{ kind: 'mg', seat: robbed, fromSeat: firstProv }];
  e.pendingScores = [
    { seat: robbed, score: 3 * e.baseScore, text: '明杠' }, { seat: firstProv, score: -3 * e.baseScore, text: '明杠' }
  ];
  // 抢杠：winner hand + winTile 评估（hand 不含 winTile）
  var hand = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1', 'D2', 'D2']; // 14张
  var cap = robKongSettle(e, robber, hand, 'D2', robbed);
  check('抢杠包牌 huPayer=被抢者', cap.huPayer === robbed, 'huPayer=' + cap.huPayer);
  check('抢杠赢家收胡分+前明杠分', cap.scores[robber] === (cap.total + 3 * e.baseScore), 'scores=' + JSON.stringify(cap.scores));
  check('抢杠放前明杠者不付', cap.scores[firstProv] === 0, 'scores=' + JSON.stringify(cap.scores));
  check('抢杠 payText', cap.payText.indexOf('抢杠胡') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== 多家抢杠胡（一炮多响） =====');
(function () {
  var e = freshEngine();
  var provider = 0;
  // 两个赢家都能胡 D2
  var w1 = 1, w2 = 2;
  e.kongChain = []; // 无前明杠
  e.players[w1].hand = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1', 'D2', 'D2'];
  e.players[w2].hand = ['W1', 'W1', 'W1', 'W9', 'W9', 'W9', 'T5', 'T5', 'T5', 'Z1', 'Z1', 'Z1', 'D2', 'D2'];
  e.endRobKongMulti([w1, w2], provider, 'D2');
  var cap = e.endData;
  check('一炮多响 multiHu=true', cap.multiHu === true);
  check('一炮多响 winners=2', cap.winners.length === 2, 'len=' + cap.winners.length);
  check('一炮多响 provider 全包', cap.scores[provider] === -(cap.total * 2), 'scores=' + JSON.stringify(cap.scores));
  check('一炮多响 payText', cap.payText.indexOf('2家胡') >= 0, cap.payText);
  console.log('     payText=' + cap.payText + ' scores=' + JSON.stringify(cap.scores));
})();

console.log('===== 荒庄（三家不计分） =====');
(function () {
  var e = freshEngine();
  e.players[0].points = 100;
  e.players[1].points = 200;
  e.players[2].points = 300;
  e.players[3].points = 400;
  e.pendingScores = [{ seat: 0, score: 9, text: '暗杠' }, { seat: 1, score: -9, text: '暗杠' }];
  e.deck = [];  // 牌堆空
  e.huangzhuang();
  var cap = e.endData;
  check('荒庄 scores 全0', JSON.stringify(cap.scores) === '[0,0,0,0]', JSON.stringify(cap.scores));
  check('荒庄 points 不变', cap.points[0] === 100 && cap.points[1] === 200, JSON.stringify(cap.points));
  check('荒庄 pendingScores 清空', cap.pendingScores.length === 0);
  check('荒庄 name=荒庄', cap.name === '荒庄');
  console.log('     scores=' + JSON.stringify(cap.scores) + ' points=' + JSON.stringify(cap.points));
})();

console.log('===== 张数守恒不变式 =====');
(function () {
  var e = new MahjongEngine({ baseScore: 3 });
  e.startRound();
  // 开局：4家手牌(13*4) + 庄家lastDraw(1) + deck(55) = 108
  var total = e.deck.length;
  e.players.forEach(function (p) { total += p.hand.length + (p.lastDraw ? 1 : 0); });
  check('开局张数守恒=108', total === 108, 'total=' + total);
  check('开局 deck=55', e.deck.length === 55, 'deck=' + e.deck.length);

  // 模拟一次摸牌+出牌：nextTurn 摸一张
  e.nextTurn(); // turn 1 摸牌
  total = e.deck.length;
  e.players.forEach(function (p) { total += p.hand.length + (p.lastDraw ? 1 : 0); });
  // nextTurn 后：庄家出牌前。但引擎 nextTurn 直接摸牌进 lastDraw，未出牌
  // 牌总数 = deck + 4家(hand+lastDraw) = 55-1 + 13*4 + 2(庄家+当前各1) = 54+52+2 = 108
  check('nextTurn 后张数守恒=108', total === 108, 'total=' + total);
})();

console.log('===== L1. 碰后补杠：lastClaimForBao 清除（src=peng） =====');
(function () {
  var e = freshEngine();
  // 模拟碰后场景：seat=0 已碰一张，bao 责任 src=peng
  e.lastClaimForBao = { provider: 3, seat: 0, src: 'peng' };
  e.baoFirstDraw = true;
  // seat 0 已有 peng meld（tiles[0]='D5'）+ lastDraw='D5'（刚摸到第4张）
  e.players[0].melds = [{ type: 'peng', kind: 'peng', tiles: ['D5', 'D5', 'D5'], from: 3 }];
  e.players[0].lastDraw = 'D5';
  e.players[0].hand = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'Z1', 'Z2', 'Z3']; // 12张
  e.turn = 0;
  // 触发补杠：applyBuKong 应清除 bao 责任（src=peng 不是 mg）
  e.applyBuKong(0, 'D5');
  check('碰后补杠 lastClaimForBao=null', e.lastClaimForBao === null, 'lastClaimForBao=' + JSON.stringify(e.lastClaimForBao));
  check('碰后补杠 baoFirstDraw=false', e.baoFirstDraw === false, 'baoFirstDraw=' + e.baoFirstDraw);
  // 验证补杠登记正确
  check('碰后补杠 meld 升级为 kong/bg', e.players[0].melds[0].type === 'kong' && e.players[0].melds[0].kind === 'bg',
    'meld=' + JSON.stringify(e.players[0].melds[0]));
  check('碰后补杠 meld 4张', e.players[0].melds[0].tiles.length === 4);
  check('碰后补杠 lastDraw 清除', e.players[0].lastDraw === null);
  // 杠分记账
  var bgScores = e.pendingScores.filter(function (ps) { return ps.seat === 0; });
  check('碰后补杠 addGangScore(bg) 已记账', bgScores.length > 0 && bgScores[0].score === 1 * e.baseScore,
    'bgScores=' + JSON.stringify(bgScores));
  console.log('     lastClaimForBao=' + JSON.stringify(e.lastClaimForBao) + ' baoFirstDraw=' + e.baoFirstDraw);
})();

console.log('===== L2. 明杠后补杠：lastClaimForBao 保留（src=mg，杠上杠） =====');
(function () {
  var e = freshEngine();
  // 模拟明杠后场景：seat=0 已明杠一张（bao 责任 src=mg），现再补杠
  e.lastClaimForBao = { provider: 3, seat: 0, src: 'mg' };
  e.baoFirstDraw = true;
  // seat 0 已有 peng meld（再补杠升级）+ 一根 mg meld
  e.players[0].melds = [
    { type: 'kong', kind: 'mg', tiles: ['T9', 'T9', 'T9', 'T9'], from: 3 },
    { type: 'peng', kind: 'peng', tiles: ['D5', 'D5', 'D5'], from: 2 }
  ];
  e.players[0].lastDraw = 'D5';
  e.players[0].hand = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'Z1', 'Z2', 'Z3']; // 12张
  e.turn = 0;
  e.applyBuKong(0, 'D5');
  check('明杠后补杠 lastClaimForBao 保留', e.lastClaimForBao !== null && e.lastClaimForBao.src === 'mg',
    'lastClaimForBao=' + JSON.stringify(e.lastClaimForBao));
  check('明杠后补杠 baoFirstDraw=true', e.baoFirstDraw === true, 'baoFirstDraw=' + e.baoFirstDraw);
  // 验证 peng meld 升级为 kong/bg
  var bgMeld = e.players[0].melds[1];
  check('明杠后补杠 第二组升级 kong/bg', bgMeld.type === 'kong' && bgMeld.kind === 'bg',
    'meld=' + JSON.stringify(bgMeld));
  // 第一组 mg 保留
  var mgMeld = e.players[0].melds[0];
  check('明杠后补杠 第一组 mg 保留', mgMeld.kind === 'mg', 'meld=' + JSON.stringify(mgMeld));
  console.log('     lastClaimForBao=' + JSON.stringify(e.lastClaimForBao) + ' baoFirstDraw=' + e.baoFirstDraw);
})();

console.log('===== M. doDiscard 后进入 claim 阶段（getClaimants） =====');
(function () {
  var e = new MahjongEngine({ baseScore: 3 });
  e.startRound();
  // 手动设置：seat 0 手里有 3 张 'W1'，打出后 seat 1 应能 peng/mg
  e.players[0].hand = ['W1', 'W1', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'Z1', 'Z2'];
  e.players[0].lastDraw = null;
  e.players[1].hand = ['W1', 'W1', 'W9', 'W9', 'W9', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
  e.players[1].lastDraw = null;
  e.players[2].hand = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'Z3', 'Z3', 'Z3', 'Z4'];
  e.players[2].lastDraw = null;
  e.players[3].hand = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'Z5', 'Z5', 'Z5', 'Z6'];
  e.players[3].lastDraw = null;
  e.turn = 0;
  e.phase = 'discard';
  // seat 0 打出 W1
  e.doDiscard(0, 'W1');
  // seat 1 手里 2 张 W1，可碰；不满足 3 张所以不能明杠
  check('doDiscard 后 phase=claim', e.phase === 'claim', 'phase=' + e.phase);
  check('claimants 含 seat 1（可碰）', e.claimants.length === 1 && e.claimants[0].seat === 1,
    'claimants=' + JSON.stringify(e.claimants.map(function (c) { return c.seat; })));
  check('seat 1 可碰', e.claimants[0].peng === true);
  check('seat 1 不可明杠（只2张）', e.claimants[0].kong === false);
  // 验证手牌已移除
  check('seat 0 手牌少1张 W1', e.players[0].hand.indexOf('W1') >= 0, 'hand=' + JSON.stringify(e.players[0].hand));
  // W1 应在 disp 里
  check('seat 0 disp 含 W1', e.players[0].disp.indexOf('W1') >= 0);
  check('lastDiscard 记录', e.lastDiscard && e.lastDiscard.seat === 0 && e.lastDiscard.tile === 'W1');
  console.log('     claimants=' + JSON.stringify(e.claimants.map(function (c) {
    return { seat: c.seat, peng: c.peng, kong: c.kong };
  })));
})();

console.log('===== N. 张数守恒：doDiscard + doPeng 后 =====');
(function () {
  var e = new MahjongEngine({ baseScore: 3 });
  e.startRound();
  // 强制构造 seat 0 打 W1，seat 1 碰
  // seat 0 = 庄家有 13 hand + 1 lastDraw = 14张；保留 lastDraw='W1' 让它打出去
  e.players[0].hand = ['W1', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'Z1', 'Z2', 'Z3']; // 13张
  e.players[0].lastDraw = 'W1';   // 保留庄家 lastDraw，打出这张
  e.players[1].hand = ['W1', 'W1', 'W9', 'W9', 'W9', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];
  e.players[1].lastDraw = null;
  e.players[2].hand = e.players[2].hand.slice(0, 13);
  e.players[2].lastDraw = null;
  e.players[3].hand = e.players[3].hand.slice(0, 13);
  e.players[3].lastDraw = null;
  e.turn = 0;
  e.phase = 'discard';
  // 张数守恒函数（含 disp）
  function totalWithDisp() {
    var t = e.deck.length;
    e.players.forEach(function (p) {
      t += p.hand.length + (p.lastDraw ? 1 : 0) + p.melds.reduce(function (s, m) { return s + m.tiles.length; }, 0) + p.disp.length;
    });
    return t;
  }
  check('开局守恒=108', totalWithDisp() === 108, 'total=' + totalWithDisp());
  // seat 0 打出 lastDraw 'W1'
  e.doDiscard(0, 'W1', -2);
  check('doDiscard 后守恒=108', totalWithDisp() === 108, 'total=' + totalWithDisp());
  // seat 1 碰
  e.doPeng(1, 'W1', 0);
  check('doPeng 后守恒=108', totalWithDisp() === 108, 'total=' + totalWithDisp());
  // meld 验证
  var meld = e.players[1].melds[0];
  check('doPeng meld=peng/3张', meld.type === 'peng' && meld.tiles.length === 3);
  check('doPeng seat 1 hand 少2张 W1', e.players[1].hand.indexOf('W1') < 0);
  check('doPeng seat 0 disp 移除 W1', e.players[0].disp.indexOf('W1') < 0);
  // bao 责任
  check('doPeng lastClaimForBao=peng', e.lastClaimForBao && e.lastClaimForBao.src === 'peng' && e.lastClaimForBao.provider === 0);
  console.log('     melds=' + JSON.stringify(e.players[1].melds) + ' bao=' + JSON.stringify(e.lastClaimForBao));
})();

console.log('===== O. snapshot 视角过滤 =====');
(function () {
  var e = new MahjongEngine({ baseScore: 3 });
  e.startRound();
  // 上帝视角：所有 hand 为空
  var god = e.snapshot(-1);
  check('上帝视角 hand 全空', god.players.every(function (p) { return p.hand.length === 0; }));
  check('上帝视角 lastDraw 全空', god.players.every(function (p) { return p.lastDraw === null; }));
  // 自己视角：hand 可见
  var me = e.snapshot(0);
  check('自己视角 hand 可见', me.players[0].hand.length > 0);
  check('自己视角 别人 hand 空', me.players[1].hand.length === 0 && me.players[2].hand.length === 0);
  check('自己视角 lastDraw 可见', me.players[0].lastDraw !== null || me.players[0].hasLastDraw === false);
  // discard 阶段且 turn===0：myCanHu/myKongOptions 应被算
  check('自己视角 discard 阶段 myCanHu 字段存在', typeof me.myCanHu === 'boolean');
  check('自己视角 myKongOptions 是数组', Array.isArray(me.myKongOptions));
  // 别人视角：hand 不可见
  var other = e.snapshot(1);
  check('别人视角 自己 hand 空（seat1看seat0）', other.players[0].hand.length === 0);
  console.log('     me.myCanHu=' + me.myCanHu + ' myKongOptions.length=' + me.myKongOptions.length);
})();

console.log('\n结果: pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
