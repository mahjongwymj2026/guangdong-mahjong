// server/engine.js — 服务器权威麻将引擎（纯状态机）
// 无 DOM / 无 AI / 无 setTimeout：所有时序由客户端 action 驱动
// 计分逻辑逐行复刻 js/game.js 的 endRound / endRobKongMulti / addGangScore
// 牌堆 27 种 × 4 = 108 张（万只有 1/9）；鬼牌池同为 27 种
// 仅 require mahjong.js 的纯函数，绝不复制算法实现
'use strict';

var mj = require('../js/mahjong.js');

var SEATS = ['你', '右家', '对家', '左家'];   // 0=下(自己) 1=右 2=对 3=左
var GHOST_TYPES = [
  'W1', 'W9',
  'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9',
  'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9',
  'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7'
];

// ---------- 构造 ----------
function MahjongEngine(config) {
  this.baseScore = (config && config.baseScore) || 3;
  this.initScore = (config && config.initScore) || 1000;
  this.reset();
}

// ---------- 重置（回到未开局）----------
MahjongEngine.prototype.reset = function () {
  this.players = [0, 1, 2, 3].map(function (s) {
    return { name: SEATS[s], points: this.initScore, hand: [], melds: [], disp: [], lastDraw: null };
  }, this);
  this.deck = [];
  this.ghost = null;
  this.turn = 0;
  this.phase = 'idle';          // idle | discard | claim | robKong | end
  this.dealer = 0;
  this.roundNum = 0;
  this.lastDiscard = null;     // { seat, tile }
  this.claimants = [];         // 可 claim 的座位
  this.passedClaims = [];      // 同圈放弃：[{seat,tile,from}]
  this.pendingScores = [];     // 杠分暂记 [{seat,score,kind,tile,fromSeat,text}]
  this.kongChain = [];         // 本串杠链 [{kind,seat,fromSeat}]
  this.lastClaimForBao = null; // { provider, seat, src }
  this.baoFirstDraw = false;
  this.robKongCandidates = null;
  this.kongResume = null;
  this.ended = false;
  this.endData = null;
  this.scoreHistory = [];
  this.preRoundPoints = null;  // 本局开始前积分快照（abort 回退用）
};

// ---------- 配置 ----------
MahjongEngine.prototype.config = function (cfg) {
  if (!cfg) return { baseScore: this.baseScore, initScore: this.initScore };
  if (cfg.baseScore !== undefined) this.baseScore = cfg.baseScore;
  if (cfg.initScore !== undefined) this.initScore = cfg.initScore;
};

// ---------- 开局 ----------
MahjongEngine.prototype.startRound = function () {
  // 本局开始前积分快照（abort_round 荒庄回退用）
  this.preRoundPoints = this.players.map(function (p) { return p.points; });

  this.ended = false;
  this.lastDiscard = null;
  this.claimants = [];
  this.passedClaims = [];
  this.pendingScores = [];
  this.kongChain = [];
  this.lastClaimForBao = null;
  this.baoFirstDraw = false;
  this.robKongCandidates = null;
  this.kongResume = null;
  this.endData = null;

  var oldPts = this.players.map(function (p) { return p.points; });
  this.players = SEATS.map(function (name, i) {
    return { name: name, points: oldPts[i] || this.initScore, hand: [], melds: [], disp: [], lastDraw: null };
  }, this);

  // 洗牌发牌：4 家各 13 张
  this.deck = mj.shuffle(mj.fullDeck());
  for (var i = 0; i < 4; i++) {
    this.players[i].hand = this.deck.splice(0, 13);
  }
  // 庄家多摸一张（只存 lastDraw，不进 hand——引擎统一所有 seat）
  this.players[this.dealer].lastDraw = this.deck.shift();

  // 鬼牌：从 27 种里抽
  this.ghost = GHOST_TYPES[Math.floor(Math.random() * GHOST_TYPES.length)];

  // 排序
  for (var j = 0; j < 4; j++) {
    this.players[j].hand = mj.sortHand(this.players[j].hand);
  }

  this.roundNum = (this.roundNum || 0) + 1;
  this.turn = this.dealer;
  this.phase = 'discard';

  // 不变式断言：开局后 deck 应剩 108 - 13*4 - 1 = 55
  if (this.deck.length !== 55) {
    throw new Error('startRound invariant: deck should be 55, got ' + this.deck.length);
  }

  return this.snapshot(-1);
};

// ---------- 摸牌 ----------
MahjongEngine.prototype.drawTile = function (seat) {
  if (this.deck.length === 0) return null;
  var t = this.deck.shift();
  // 引擎统一：摸的牌只存 lastDraw，不进 hand；所有 seat 行为一致
  this.players[seat].lastDraw = t;
  return t;
};

// ---------- 某座位实际持有的牌（hand + lastDraw）----------
MahjongEngine.prototype.evalHandFor = function (seat) {
  var h = this.players[seat].hand.slice();
  if (this.players[seat].lastDraw) h.push(this.players[seat].lastDraw);
  return h;
};

// ---------- 下一回合 ----------
MahjongEngine.prototype.nextTurn = function () {
  if (this.ended) return;
  this.turn = (this.turn + 1) % 4;
  if (this.deck.length === 0) {
    this.huangzhuang();
    return;
  }
  // 同圈放弃记录：按"出牌者"独立计算一圈。轮到他再次摸牌（nextTurn 到他）时，
  // 仅他打出的那张牌的放弃记录过期；其他出牌者的记录不受影响
  var nturn = this.turn;
  this.passedClaims = this.passedClaims.filter(function (pc) { return pc.from !== nturn; });
  this.phase = 'discard';
  this.claimants = [];
  this.drawTile(this.turn);
  this._checkBaoOnDraw(this.turn);   // 自我摸牌未胡时清/消耗 bao 责任
};

// ---------- 荒庄 ----------
MahjongEngine.prototype.huangzhuang = function () {
  this.ended = true;
  var scores = [0, 0, 0, 0];
  this.endData = {
    winner: -1, draw: true, name: '荒庄', ghost: this.ghost,
    scores: scores,
    points: this.players.map(function (pl) { return pl.points; }),
    hands: this.players.map(function (pl, i) { return this.evalHandFor(i); }, this),
    melds: this.players.map(function (pl) { return pl.melds.slice(); }),
    pendingScores: []
  };
  this.scoreHistory.push({ round: this.roundNum, winner: -1, name: '荒庄', scores: scores });
  this.phase = 'end';
};

// ---------- 杠分暂记（复刻 game.js addGangScore）----------
MahjongEngine.prototype.addGangScore = function (seat, kind, tile, fromSeat) {
  var base = this.baseScore || 3;
  var others = [0, 1, 2, 3].filter(function (s) { return s !== seat; });
  var ktext = kind === 'ag' ? '暗杠' : kind === 'bg' ? '公杠' : '明杠';
  if (kind === 'ag') {
    var v = 2 * base;
    others.forEach(function (s) {
      this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: null, text: ktext });
      this.pendingScores.push({ seat: s, score: -v, kind: kind, tile: tile, fromSeat: null, text: ktext });
    }, this);
  } else if (kind === 'bg') {
    var v = 1 * base;
    others.forEach(function (s) {
      this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: null, text: ktext });
      this.pendingScores.push({ seat: s, score: -v, kind: kind, tile: tile, fromSeat: null, text: ktext });
    }, this);
  } else if (kind === 'mg') {
    var v = 3 * base;
    this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: fromSeat, text: ktext });
    this.pendingScores.push({ seat: fromSeat, score: -v, kind: kind, tile: tile, fromSeat: fromSeat, text: ktext });
  }
};

// ---------- 结算（复刻 game.js endRound 1388-1547）----------
// 与 game.js 的关键差异：自摸时所有 seat 都补 lastDraw（game.js 只补 seat0）
MahjongEngine.prototype.endRound = function (winner, options) {
  if (this.ended) return;
  this.ended = true;
  options = options || {};
  var isSelfDraw = !!options.isSelfDraw;
  var robKong = !!options.robKong;
  var provider = options.provider;
  var p = this.players[winner];
  var winTile = options.tile;
  if (isSelfDraw && !winTile) {
    winTile = p.lastDraw || null;
  }

  // 评估番型：自摸补 lastDraw（所有 seat）；抢杠补 winTile
  var evalHand = p.hand.slice();
  if (!isSelfDraw) {
    evalHand = evalHand.concat([winTile]);
  } else if (p.lastDraw) {
    evalHand = evalHand.concat([p.lastDraw]);
  }
  var fan = mj.bestFanEx(evalHand, p.melds, this.ghost, isSelfDraw, robKong);
  var base = this.baseScore || 3;
  var total = fan.fan * base;
  var per = Math.round(total / 3);

  // 杠分累计
  var gangScores = [0, 0, 0, 0];
  this.pendingScores.forEach(function (ps) { gangScores[ps.seat] += ps.score; });

  var scores = [0, 0, 0, 0];
  var huPayer = -1;          // -1 = 三家付
  var payText = '';

  var danDiao = false;
  if (isSelfDraw) {
    var wTile = p.lastDraw;
    if (wTile) danDiao = mj.isDanDiao(evalHand, p.melds, this.ghost, wTile);
  }
  var chain = this.kongChain || [];
  var lastKong = chain.length ? chain[chain.length - 1] : null;
  var explosion = !!lastKong && lastKong.seat === winner;   // 杠后自摸 = 杠爆
  var firstMg = null;
  chain.forEach(function (k) {
    if (k.kind === 'mg' && k.seat === winner && firstMg === null) firstMg = k;
  });
  var gangFullPack = false;   // 杠上杠：第一个放杠者包赢家整串杠的杠杆
  var robChainPack = 0;       // 抢杠：被抢者把其本串明杠的杠分付给赢家

  if (robKong) {
    // 1. 抢杠：被抢的补杠者全包；若被抢者本串有过明杠，其杠分也由被抢者付给赢家
    huPayer = provider;
    payText = '抢杠胡（' + SEATS[provider] + '包）';
    var _base = this.baseScore || 3;
    chain.forEach(function (k) {
      if (k.kind === 'mg' && k.seat === provider) robChainPack += 3 * _base;
    });
  } else if (explosion && firstMg) {
    // 2/3. 杠爆·明杠 / 杠上杠：第一个放杠者包胡牌；杠上杠另包整串杠分
    huPayer = firstMg.fromSeat;
    payText = (chain.length > 1 ? '杠上杠' : '杠爆明杠') + '（' + SEATS[huPayer] + '包）';
    gangFullPack = chain.length > 1;
  } else if (explosion) {
    // 5. 杠爆·公杠/暗杠：三家平摊
    huPayer = -1;
    payText = '杠爆（三家付）';
  } else if (this.lastClaimForBao && this.lastClaimForBao.seat === winner && danDiao) {
    // 6/4. 尖牌单吊包胡：碰/明杠提供者包胡，杠分照常
    huPayer = this.lastClaimForBao.provider;
    payText = '单吊包胡（' + SEATS[huPayer] + '包）';
  } else {
    // 7. 普通自摸（规则只允许自摸胡与抢杠胡，无点炮分支）
    huPayer = -1;
    payText = '自摸（三家付）';
  }

  if (huPayer >= 0) {
    scores[huPayer] -= total;
    scores[winner] += total;
  } else {
    for (var i = 0; i < 4; i++) {
      if (i === winner) scores[i] += total;
      else scores[i] -= per;
    }
  }

  // 加杠分（抢杠不算杠分）
  if (!robKong) {
    if (gangFullPack) {
      // 杠上杠全包：第一个放杠者付赢家在本串所有杠（含后杠）的获利
      var winGain = 0;
      chain.forEach(function (k) {
        winGain += (k.kind === 'mg' ? 3 : k.kind === 'bg' ? 1 : 2) * base;
      });
      scores[winner] += winGain;
      scores[huPayer] -= winGain;
    } else {
      for (var j = 0; j < 4; j++) scores[j] += gangScores[j];
    }
  } else if (robChainPack > 0) {
    scores[winner] += robChainPack;
    scores[provider] -= robChainPack;
  }

  // 结算积分
  for (var s = 0; s < 4; s++) this.players[s].points += scores[s];

  // 鬼牌胡牌标记（客户端据此触发闪电，仅自己胡牌时显示）
  var winnerHasGhost = false;
  var gh = this.ghost;
  if (gh) {
    if (p.hand.indexOf(gh) >= 0 || evalHand.indexOf(gh) >= 0 ||
        p.melds.some(function (m) { return m.tiles.indexOf(gh) >= 0; })) {
      winnerHasGhost = true;
    }
  }

  this.endData = {
    winner: winner, winnerName: SEATS[winner],
    fan: fan.fan, name: fan.name,
    scores: scores, total: total, per: per, payText: payText,
    huPayer: huPayer,
    isSelfDraw: isSelfDraw, robKong: robKong,
    points: this.players.map(function (pl) { return pl.points; }),
    ghost: this.ghost,
    winnerHasGhost: winnerHasGhost,
    // 展示手牌：赢家并入胡牌；其余纯手牌
    hands: this.players.map(function (pl, i) {
      var h = pl.hand.slice();
      if (i === winner) {
        if (isSelfDraw) {
          if (pl.lastDraw) h.push(pl.lastDraw);
        } else {
          h = h.concat([winTile]);
        }
      }
      return h;
    }),
    melds: this.players.map(function (pl) { return pl.melds.slice(); }),
    pendingScores: this.pendingScores.slice(),
    winTile: winTile || null
  };
  this.scoreHistory.push({ round: this.roundNum, winner: winner, name: fan.name, scores: scores });
  this.dealer = winner;
  this.phase = 'end';
};

// ---------- 多家抢杠胡结算（一炮多响，复刻 game.js 1551-1636）----------
// winners 全部胡牌（已按补杠者之后顺位排序）；provider=被抢的补杠者
MahjongEngine.prototype.endRobKongMulti = function (winners, provider, tile) {
  if (this.ended) return;
  var self = this;
  winners = winners.filter(function (s, idx) { return winners.indexOf(s) === idx && s !== provider; });
  if (winners.length === 0) { this.resumeKong(); return; }
  winners.sort(function (a, b) {
    return ((a - provider + 4) % 4) - ((b - provider + 4) % 4);
  });

  this.ended = true;
  var base = this.baseScore || 3;
  var scores = [0, 0, 0, 0];
  var winInfos = [];

  // provider 本串每根明杠：对每个胡牌者各赔 3*base
  var robChainPack = 0;
  (this.kongChain || []).forEach(function (k) {
    if (k.kind === 'mg' && k.seat === provider) robChainPack += 3 * base;
  });

  winners.forEach(function (w) {
    var pw = self.players[w];
    var hand14 = pw.hand.slice().concat([tile]);
    var fan = mj.bestFanEx(hand14, pw.melds, self.ghost, false, true);
    var total = fan.fan * base;
    winInfos.push({ seat: w, fan: fan.fan, name: fan.name, total: total });
    scores[w] += total;
    scores[provider] -= total;
    if (robChainPack > 0) {
      scores[w] += robChainPack;
      scores[provider] -= robChainPack;
    }
    self.scoreHistory.push({ round: self.roundNum, winner: w, name: fan.name, scores: scores });
  });

  for (var s = 0; s < 4; s++) this.players[s].points += scores[s];

  // 鬼牌胡牌标记
  var winnerHasGhost = false;
  var gh = this.ghost;
  if (gh && winners.indexOf(0) >= 0) {
    if (this.players[0].hand.indexOf(gh) >= 0 ||
        this.players[0].melds.some(function (m) { return m.tiles.indexOf(gh) >= 0; })) {
      winnerHasGhost = true;
    }
  }

  var payText = '抢杠胡（' + SEATS[provider] + '包·' + winners.length + '家胡）';

  var hands = this.players.map(function (pl, i) {
    var h = pl.hand.slice();
    if (winners.indexOf(i) >= 0) h = h.concat([tile]);
    return h;
  });

  this.endData = {
    draw: false,
    multiHu: true,
    winner: winners[0], winnerName: SEATS[winners[0]],
    winners: winInfos,
    fan: winInfos[0].fan, name: winInfos[0].name, total: winInfos[0].total,
    scores: scores, payText: payText,
    huPayer: provider,
    isSelfDraw: false, robKong: true,
    points: this.players.map(function (pl) { return pl.points; }),
    ghost: this.ghost,
    winnerHasGhost: winnerHasGhost,
    hands: hands,
    melds: this.players.map(function (pl) { return pl.melds.slice(); }),
    pendingScores: [],
    winTile: tile
  };
  this.kongResume = null;
  this.robKongCandidates = null;
  this.dealer = winners[0];
  this.phase = 'end';
};

// ---------- 快照（按 viewerSeat 过滤：手牌/lastDraw 只给自己，myClaim/myKongOptions/myCanHu 按阶段）----------
MahjongEngine.prototype.snapshot = function (viewerSeat) {
  var self = this;
  var snap = {
    roundNum: this.roundNum,
    dealer: this.dealer,
    ghost: this.ghost,
    turn: this.turn,
    phase: this.phase,
    deckRemain: this.deck.length,
    lastDiscard: this.lastDiscard,
    players: this.players.map(function (pl, i) {
      var isMe = (viewerSeat === i);
      return {
        name: pl.name,
        points: pl.points,
        hand: isMe ? pl.hand.slice() : [],
        handCount: pl.hand.length + (pl.lastDraw ? 1 : 0),
        lastDraw: isMe ? (pl.lastDraw || null) : null,
        hasLastDraw: !!pl.lastDraw,
        melds: pl.melds.slice(),
        disp: pl.disp.slice()
      };
    }),
    myClaim: null,
    myKongOptions: [],
    myCanHu: false,
    endData: this.endData,
    scoreHistory: this.scoreHistory.slice()
  };

  if (viewerSeat < 0 || this.ended) return snap;

  // discard 阶段且轮到自己：算可胡/可杠
  // 只有刚摸过牌（lastDraw 存在）才能自摸胡；碰之后 lastDraw 为 null，必须出牌不能胡
  // 杠之后会补牌（lastDraw 存在），杠爆自摸胡允许
  if (this.phase === 'discard' && this.turn === viewerSeat) {
    var evalHand = this.evalHandFor(viewerSeat);
    if (this.players[viewerSeat].lastDraw) {
      snap.myCanHu = mj.checkWin(evalHand, this.ghost, this.players[viewerSeat].melds);
    }
    snap.myKongOptions = this.selfKongsFor(viewerSeat);
  }

  // claim 阶段：若涉及自己，提供 myClaim
  if (this.phase === 'claim') {
    // 抢杠窗口：robKongCandidates 含自己
    if (this.robKongCandidates && this.robKongCandidates.indexOf(viewerSeat) >= 0) {
      snap.myClaim = {
        peng: false, kong: false, kind: null,
        tile: this.lastDiscard ? this.lastDiscard.tile : null,
        from: this.turn,
        robKong: true, hu: true
      };
    } else {
      // 普通 claim 窗口：在 claimants 里找自己
      var c = null;
      for (var k = 0; k < this.claimants.length; k++) {
        if (this.claimants[k].seat === viewerSeat) { c = this.claimants[k]; break; }
      }
      if (c) {
        snap.myClaim = {
          peng: c.peng, kong: c.kong, kind: c.kind,
          tile: c.tile, from: c.from,
          robKong: false, hu: false
        };
      }
    }
  }

  return snap;
};

// ---------- 出牌 ----------
// 引擎统一所有 seat：摸的牌只存 lastDraw，不进 hand
// 打出旧牌：先把 lastDraw 并回 hand → sortHand → splice 1 张
// 打出新摸的牌（preIdx===-2 或 tile===lastDraw）：只清 lastDraw
MahjongEngine.prototype.doDiscard = function (seat, tile, preIdx) {
  if (this.ended) return;
  var p = this.players[seat];

  // 打出的是新摸的单独牌
  if (p.lastDraw === tile && (preIdx === -2 || typeof preIdx !== 'number')) {
    p.lastDraw = null;
  } else {
    // 先把 lastDraw 并回 hand（摸的牌可能就是打出的牌的第4张，也可能不是）
    if (p.lastDraw) {
      p.hand.push(p.lastDraw);
      p.lastDraw = null;
    }
    p.hand = mj.sortHand(p.hand);
    var idx = (typeof preIdx === 'number' && preIdx >= 0 && preIdx < p.hand.length)
      ? preIdx : p.hand.indexOf(tile);
    if (idx >= 0 && p.hand[idx] === tile) {
      p.hand.splice(idx, 1);
    } else {
      // 兜底：直接 indexOf
      var i2 = p.hand.indexOf(tile);
      if (i2 >= 0) p.hand.splice(i2, 1);
    }
  }

  p.disp.push(tile);
  // 清杠爆/包胡追踪窗口（出牌后失效）；lastClaimForBao 不在此清，留到自我摸牌判定
  this.kongChain = [];
  this.lastDiscard = { seat: seat, tile: tile };

  // 检查碰/杠/胡
  var claimants = this.getClaimants(tile, seat);
  if (claimants.length > 0) {
    this.claimants = claimants;
    this.phase = 'claim';
  } else {
    this.nextTurn();
  }
};

// ---------- 查询可 claim 的座位（复刻 game.js 929-945）----------
MahjongEngine.prototype.getClaimants = function (tile, fromSeat) {
  var res = [];
  for (var i = 0; i < 4; i++) {
    if (i === fromSeat) continue;
    var evalHand = this.evalHandFor(i);
    var c = { seat: i, peng: false, kong: false, kind: null, tile: tile, from: fromSeat };
    // 同圈放弃过该牌的碰 → 不能再碰（杠不受此限制）
    // 鬼牌打出来与普通牌一样可被碰/杠（番型限制在 bestFanEx 处理）
    var passedPeng = this.passedClaims.some(function (pc) {
      return pc.seat === i && pc.tile === tile;
    });
    if (!passedPeng && mj.canPeng(evalHand, tile, this.ghost)) c.peng = true;
    var cnt = evalHand.filter(function (t) { return t === tile; }).length;
    if (cnt >= 3) { c.kong = true; c.kind = 'mg'; }
    if (c.peng || c.kong) res.push(c);
  }
  return res;
};

// ---------- 碰（复刻 game.js 1158-1188）----------
MahjongEngine.prototype.doPeng = function (seat, tile, fromSeat) {
  if (this.ended) return;
  var p = this.players[seat];

  // 先把 lastDraw 并回 hand（碰者可能手里有刚摸的牌）
  if (p.lastDraw) {
    p.hand.push(p.lastDraw);
    p.lastDraw = null;
  }
  p.hand = mj.sortHand(p.hand);

  // 手牌移除 2 张
  for (var k = 0; k < 2; k++) {
    var i = p.hand.indexOf(tile);
    if (i >= 0) p.hand.splice(i, 1);
  }
  // 被碰者弃牌区移除该牌
  var fp = this.players[fromSeat];
  var di = fp.disp.lastIndexOf(tile);
  if (di >= 0) fp.disp.splice(di, 1);

  p.melds.push({ type: 'peng', kind: 'peng', tiles: [tile, tile, tile], from: fromSeat });

  // 尖牌包胡追踪（碰后若单吊自摸，放碰者包）
  this.lastClaimForBao = { provider: fromSeat, seat: seat, src: 'peng' };
  this.baoFirstDraw = true;   // 当次内部出牌不判定，保留到后续自我摸牌
  this.kongChain = [];

  this.turn = seat;
  this.lastDiscard = null;
  this.phase = 'discard';
  this.claimants = [];
};

// ---------- 杠（复刻 game.js 1191-1262，去掉 DOM/AI/setTimeout）----------
MahjongEngine.prototype.doKong = function (seat, kind, tile, claim) {
  if (this.ended) return;
  this.turn = seat;
  var p = this.players[seat];
  var fromSeat = claim ? claim.from : null;

  if (kind === 'ag') {
    // 暗杠：从持有牌中移除 4 张
    var needRemove = 4;
    if (p.lastDraw === tile) {
      // 自己刚摸的牌就是第 4 张：消费它，手牌只移除 3 张
      p.lastDraw = null;
      needRemove = 3;
    } else if (p.lastDraw) {
      // 刚摸的是别的牌：先并回手牌，杠后补牌会产生新的 lastDraw
      p.hand.push(p.lastDraw);
      p.lastDraw = null;
      p.hand = mj.sortHand(p.hand);
    }
    for (var k = 0; k < needRemove; k++) {
      var i = p.hand.indexOf(tile);
      if (i >= 0) p.hand.splice(i, 1);
    }
    p.melds.push({ type: 'kong', kind: 'ag', tiles: [tile, tile, tile, tile], from: null });
    this.addGangScore(seat, 'ag', tile, null);
    this.kongChain.push({ kind: 'ag', seat: seat, fromSeat: null });
    // 暗杠不新增包牌责任；但若是「明杠后摸牌再杠」的杠上杠，保留明杠责任并续保护
    if (this.lastClaimForBao) this.baoFirstDraw = true;
  } else if (kind === 'bg') {
    // 补杠（公杠）：先查是否被抢杠（补杠可被抢，暗杠/明杠不可抢）
    if (this.checkRobKong(seat, tile)) {
      // 等待抢杠决策；所有人放弃后由 resumeKong 补完成杠登记
      this.kongResume = { seat: seat, tile: tile };
      return;
    }
    this.applyBuKong(seat, tile);
  } else if (kind === 'mg') {
    // 明杠：手牌移除 3 张 + 弃牌区移除 1 张
    if (p.lastDraw) {
      // 若有 lastDraw 先并回（虽然 mg 通常在 claim 阶段触发，碰者无 lastDraw，但兜底）
      p.hand.push(p.lastDraw);
      p.lastDraw = null;
      p.hand = mj.sortHand(p.hand);
    }
    for (var k2 = 0; k2 < 3; k2++) {
      var i2 = p.hand.indexOf(tile);
      if (i2 >= 0) p.hand.splice(i2, 1);
    }
    var fp2 = this.players[fromSeat];
    var di2 = fp2.disp.lastIndexOf(tile);
    if (di2 >= 0) fp2.disp.splice(di2, 1);
    p.melds.push({ type: 'kong', kind: 'mg', tiles: [tile, tile, tile, tile], from: fromSeat });
    this.addGangScore(seat, 'mg', tile, fromSeat);
    this.kongChain.push({ kind: 'mg', seat: seat, fromSeat: fromSeat });
    // 明杠后若单吊自摸，放杠者包牌（杠上杠时此责任延续到后续杠）
    this.lastClaimForBao = { provider: fromSeat, seat: seat, src: 'mg' };
    this.baoFirstDraw = true;
  }

  // 杠后补牌
  this.turn = seat;
  this.lastDiscard = null;
  this.claimants = [];
  this.kongResume = null;
  this.drawTile(seat);
  this._checkBaoOnDraw(seat);   // 自我摸牌未胡时清/消耗 bao 责任
  this.phase = 'discard';
};

// ---------- 完成补杠登记（复刻 game.js 1265-1296）----------
MahjongEngine.prototype.applyBuKong = function (seat, tile) {
  var p = this.players[seat];
  // 前一根是明杠（杠上杠）则保留明杠责任并续保护；否则（含碰后补杠）不包
  if (this.lastClaimForBao && this.lastClaimForBao.src === 'mg') {
    this.baoFirstDraw = true;
  } else {
    this.lastClaimForBao = null;
    this.baoFirstDraw = false;
  }
  // 移除第 4 张
  if (p.lastDraw === tile) {
    p.lastDraw = null;
  } else {
    var ri = p.hand.indexOf(tile);
    if (ri >= 0) p.hand.splice(ri, 1);
  }
  // 已碰的副露升级为杠（3 张 → 4 张）
  var meldIdx = -1;
  for (var m = 0; m < p.melds.length; m++) {
    if (p.melds[m].type === 'peng' && p.melds[m].tiles[0] === tile) { meldIdx = m; break; }
  }
  if (meldIdx >= 0) {
    p.melds[meldIdx] = { type: 'kong', kind: 'bg', tiles: [tile, tile, tile, tile], from: p.melds[meldIdx].from };
  }
  this.addGangScore(seat, 'bg', tile, null);
  this.kongChain.push({ kind: 'bg', seat: seat, fromSeat: null });
};

// ---------- 抢杠胡检查（复刻 game.js 1318-1362，去 AI 决策）----------
// 仅补杠/公杠可被抢；返回 true 时进入 phase='claim' 等客户端回 hu/pass
MahjongEngine.prototype.checkRobKong = function (seat, tile) {
  var robbers = [];
  for (var s = 0; s < 4; s++) {
    if (s === seat) continue;
    var p = this.players[s];
    // 抢杠判胡：用纯手牌 + 补杠牌（14张）。不能用 evalHandFor——
    // lastDraw 指向补杠者刚摸的牌，evalHandFor 会把它错并入别家手牌，多一张
    var hand14 = p.hand.slice().concat([tile]);
    if (mj.checkWin(hand14, this.ghost, p.melds)) robbers.push(s);
  }
  if (robbers.length === 0) return false;
  // 按补杠者之后的座位顺序排列（一炮多响：所有可胡者都能抢，不截胡）
  robbers.sort(function (a, b) {
    return ((a - seat + 4) % 4) - ((b - seat + 4) % 4);
  });
  this.robKongCandidates = robbers.slice();
  this.kongResume = { seat: seat, tile: tile };
  this.phase = 'claim';
  return true;
};

// ---------- 恢复杠流程（补杠被全 pass 后调用，复刻 game.js 1298-1315）----------
MahjongEngine.prototype.resumeKong = function () {
  if (this.ended) return;
  if (this.kongResume) {
    var r = this.kongResume;
    this.kongResume = null;
    this.turn = r.seat;
    this.applyBuKong(r.seat, r.tile);
    // 杠后补牌
    this.drawTile(r.seat);
    this._checkBaoOnDraw(r.seat);
    this.phase = 'discard';
  }
  this.robKongCandidates = null;
};

// ---------- 自我可杠选项（复刻 game.js 774-787）----------
MahjongEngine.prototype.selfKongsFor = function (seat) {
  var p = this.players[seat];
  var fullHand = this.evalHandFor(seat);
  var kongs = mj.checkKongs(fullHand, p.lastDraw, this.ghost).filter(function (k) {
    return k.kind === 'ag';
  });
  // 公杠：已碰的牌 + 刚摸到第 4 张（鬼牌也能补公杠）
  if (p.lastDraw) {
    var hasPeng = p.melds.some(function (m) {
      return m.type === 'peng' && m.tiles[0] === p.lastDraw;
    });
    if (hasPeng) kongs.push({ kind: 'bg', tile: p.lastDraw });
  }
  return kongs;
};

// ---------- 自我摸牌后的 bao 责任清理（复刻 game.js playerTurn 656-659 的清理逻辑）----------
// 碰/明杠后第一次摸牌未胡：消耗 baoFirstDraw，保留 bao 到下次摸牌
// 第二次摸牌仍未胡：清掉 lastClaimForBao
MahjongEngine.prototype._checkBaoOnDraw = function (seat) {
  if (this.ended) return;
  if (!this.lastClaimForBao || this.lastClaimForBao.seat !== seat) return;
  var evalHand = this.evalHandFor(seat);
  var canHu = mj.checkWin(evalHand, this.ghost, this.players[seat].melds);
  if (canHu) return;   // 能胡：bao 保留到 endRound 判定
  if (this.baoFirstDraw) {
    this.baoFirstDraw = false;
  } else {
    this.lastClaimForBao = null;
  }
};

module.exports = MahjongEngine;
