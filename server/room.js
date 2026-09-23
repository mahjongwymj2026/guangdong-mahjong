// server/room.js — 房间管理（Room + RoomManager）
// 与 engine.js 解耦：room 处理 ws/session/路由，engine 处理麻将状态机
// 阶段B：断线只标记，不自动重连托管（阶段E 才做）
'use strict';

var MahjongEngine = require('./engine.js');
var P = require('./protocol.js');
var C = P.C, S = P.S, EVT = P.EVT, ERR = P.ERR;
var ai = require('./ai.js');
var mj = require('../js/mahjong.js');

// ---------- Room ----------
function Room(roomId, baseScore, initScore, cardExpiry) {
  this.roomId = roomId;
  this.baseScore = baseScore || 3;
  this.initScore = initScore || 1000;
  this.engine = new MahjongEngine({ baseScore: this.baseScore, initScore: this.initScore });
  this.seats = [null, null, null, null];   // {sessionId, ws, name, connected, lastSeen}
  this.ownerSessionId = null;
  this.status = 'waiting';                // waiting | playing
  this.lastActivity = Date.now();
  this.eventSeq = 0;                       // 单调递增事件序号
  this.cardExpiry = cardExpiry || 0;       // 房主卡过期时间戳（0=无卡）

  // claim 等待状态（非持久化，只在 phase='claim' 时存在）
  this._passingSeats = {};                 // seat -> true（已 pass）
  this._huWinners = null;                  // 抢杠胡：候选赢家数组

  // 阶段D 步骤3：服务端托管定时器
  // 出牌 30s 超时代打；一局内同座位出牌超时累计 2 次 → 本局电脑接管（轮到他只思考 1.2s）
  // 碰/杠/胡选择 15s 超时代"过"；被接管者的选择 1s 内自动过
  // 多座位并行：claim 阶段每个候选人各有一个独立 timer
  this.autoTimers = {};                    // { seat: timerHandle }
  this.autoKinds = {};                     // { seat: 'discard' | 'claim' }
  this.autoTimeouts = { discard: 30000, claim: 15000, takeover: 1200, takeoverClaim: 1000 };
  // 本局维度状态（startRound/nextRound 重置；重连不清除）
  this.timeoutCounts = [0, 0, 0, 0];       // 本局各座位出牌超时次数
  this.takenOver = [false, false, false, false];  // 本局是否已被电脑接管
  this.deadlines = { discard: 0, claim: 0 };       // 当前阶段截止时间戳（随快照发给客户端做倒计时）
  this.botSeq = 0;                                  // 机器人编号计数
}

Room.prototype.isEmpty = function () {
  for (var i = 0; i < 4; i++) {
    if (this.seats[i] && this.seats[i].connected) return false;
  }
  return true;
};

Room.prototype.seatOf = function (sessionId) {
  for (var i = 0; i < 4; i++) {
    if (this.seats[i] && this.seats[i].sessionId === sessionId) return i;
  }
  return -1;
};

Room.prototype.playerCount = function () {
  var n = 0;
  for (var i = 0; i < 4; i++) if (this.seats[i]) n++;
  return n;
};

Room.prototype.isConnected = function (seat) {
  return this.seats[seat] && this.seats[seat].connected;
};

// 推送给指定座位（按 seat 找 ws）
Room.prototype.sendTo = function (seat, msg) {
  var s = this.seats[seat];
  if (!s || !s.connected || !s.ws || s.ws.readyState !== 1) return;
  try { s.ws.send(JSON.stringify(msg)); } catch (e) {}
};

// 广播 event 给全房（同一份，做动画）
Room.prototype.broadcastEvent = function (type, detail) {
  this.eventSeq++;
  var evt = { type: S.EVENT, seq: this.eventSeq, evt: type, detail: detail || {} };
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (!s || !s.connected) continue;
    try { s.ws.send(JSON.stringify(evt)); } catch (e) {}
  }
  return evt.seq;
};

// 广播 state 给每个座位（按 viewerSeat 过滤）
Room.prototype.broadcastState = function () {
  for (var i = 0; i < 4; i++) {
    var s = this.seats[i];
    if (!s || !s.connected) continue;
    var snap = this.engine.snapshot(i);
    // 阶段D 步骤3：倒计时截止时间与本局托管态随快照下发
    snap.turnDeadline = this.deadlines.discard;
    snap.claimDeadline = this.deadlines.claim;
    snap.takenOver = this.takenOver.slice();
    snap.timeoutCounts = this.timeoutCounts.slice();
    snap.cardExpiry = this.cardExpiry;  // 房主卡过期时间戳，所有客户端用来做倒计时
    var msg = { type: S.STATE, seq: this.eventSeq, state: snap };
    try { s.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
};

Room.prototype.sendError = function (sessionId, code, msg) {
  var seat = this.seatOf(sessionId);
  if (seat < 0) return;
  this.sendTo(seat, { type: S.ERROR, code: code, msg: msg });
};

// 广播房间更新（座位列表）
Room.prototype.broadcastRoomUpdate = function () {
  var seats = this.seats.map(function (s, i) {
    return s ? { seat: i, name: s.name, connected: s.connected, isBot: !!s.isBot } : null;
  });
  this.broadcastEvent(EVT.ROOM_STATE, {
    roomId: this.roomId, seats: seats, status: this.status, ownerSeat: this.ownerSessionId ? this.seatOf(this.ownerSessionId) : -1
  });
  this.broadcastState();
};

// ---------- 入口：处理客户端 action ----------
// 返回 {ok, code?, msg?} 或直接 throw
Room.prototype.dispatch = function (sessionId, type, payload) {
  this.lastActivity = Date.now();
  var seat = this.seatOf(sessionId);

  // 非房间类动作
  if (type === C.TAKE_SEAT) return this._doTakeSeat(sessionId, payload.seat);
  if (type === C.LEAVE_ROOM) return this._doLeave(sessionId);
  if (type === C.ADD_BOT) return this._doAddBot(sessionId);
  if (type === C.REMOVE_BOT) return this._doRemoveBot(sessionId, payload.seat);

  if (seat < 0) return { ok: false, code: ERR.NOT_IN_ROOM, msg: '你不在任何座位' };

  // 阶段D 步骤3：本局已被电脑接管的座位，出牌类动作一律拒绝（下一局自动恢复）
  if (this.takenOver[seat] &&
      (type === C.DISCARD || type === C.PENG || type === C.KONG ||
       type === C.PASS || type === C.HU)) {
    return { ok: false, code: ERR.SEAT_TAKEN_OVER, msg: '本局已由电脑接管，下一局自动恢复' };
  }

  if (type === C.START_ROUND) return this._doStartRound(sessionId, seat);
  if (type === C.ABORT_ROUND) return this._doAbortRound(sessionId, seat);
  if (type === C.NEXT_ROUND) return this._doNextRound(sessionId, seat);
  if (type === C.DISCARD) return this._doDiscard(sessionId, seat, payload);
  if (type === C.PENG) return this._doPeng(sessionId, seat);
  if (type === C.KONG) return this._doKong(sessionId, seat, payload);
  if (type === C.PASS) return this._doPass(sessionId, seat);
  if (type === C.HU) return this._doHu(sessionId, seat);

  return { ok: false, code: ERR.BAD_PAYLOAD, msg: '未知动作 ' + type };
};

Room.prototype._doTakeSeat = function (sessionId, seatIdx) {
  if (seatIdx < 0 || seatIdx > 3) return { ok: false, code: ERR.BAD_PAYLOAD, msg: '座位号 0-3' };
  // 已在该房：迁移座位
  var oldSeat = this.seatOf(sessionId);
  if (oldSeat === seatIdx) return { ok: true };
  if (this.seats[seatIdx] && this.seats[seatIdx].sessionId !== sessionId) {
    return { ok: false, code: ERR.SEAT_OCCUPIED, msg: '座位已有人' };
  }
  // 游戏中不允许换座
  if (this.status === 'playing' && oldSeat >= 0) {
    return { ok: false, code: ERR.ALREADY_STARTED, msg: '游戏中不能换座' };
  }
  // 取出原座位
  var entry = oldSeat >= 0 ? this.seats[oldSeat] : null;
  if (!entry) {
    entry = { sessionId: sessionId, ws: null, name: '玩家' + (seatIdx + 1), connected: false, lastSeen: Date.now() };
  } else {
    this.seats[oldSeat] = null;
  }
  this.seats[seatIdx] = entry;
  if (this.ownerSessionId === null) this.ownerSessionId = sessionId;
  this.broadcastRoomUpdate();
  return { ok: true };
};

Room.prototype._doLeave = function (sessionId) {
  var seat = this.seatOf(sessionId);
  if (seat < 0) return { ok: true };
  // 先清这个座位的 timer（防止孤立定时器触发到 null seat 上）
  this._clearAutoTimerForSeat(seat);
  if (this.ownerSessionId === sessionId) {
    // 房主转让给第一个非空座位
    this.ownerSessionId = null;
    for (var i = 0; i < 4; i++) {
      if (this.seats[i]) { this.ownerSessionId = this.seats[i].sessionId; break; }
    }
  }
  // 游戏进行中 → 恢复成 bot 让 AI 自动接管（engine 按 seat index 存状态，直接复用）
  if (this.status === 'playing') {
    this.botSeq++;
    this.seats[seat] = {
      isBot: true,
      name: '机器人' + this.botSeq,
      connected: true, lastSeen: Date.now()
    };
    // 清真人接管标记
    delete this.takenOver[seat];
    delete this.timeoutCounts[seat];
    // 如果该 bot 是当前 turn 或 claim 候选人，重新 arm AI timer
    this._rearmForSeat(seat);
  } else {
    this.seats[seat] = null;
  }
  this.broadcastRoomUpdate();
  return { ok: true };
};

Room.prototype._doStartRound = function (sessionId, seat) {
  if (this.ownerSessionId !== sessionId) return { ok: false, code: ERR.NOT_OWNER, msg: '只有房主可以开局' };
  if (this.playerCount() < 4) return { ok: false, code: ERR.ROOM_NOT_FULL, msg: '需满 4 人才可开局' };
  if (this.status === 'playing') return { ok: false, code: ERR.ALREADY_STARTED, msg: '本局已开始' };

  this.status = 'playing';
  this._resetTakeover();                 // 新局：超时次数与电脑接管全部清零
  var snap = this.engine.startRound();
  this.broadcastEvent(EVT.ROUND_START, {
    roundNum: snap.roundNum, ghost: snap.ghost, dealer: snap.dealer
  });
  this.broadcastState();
  this._armDiscardTimer(snap.dealer);   // 庄家先出牌
  return { ok: true };
};

Room.prototype._doNextRound = function (sessionId, seat) {
  if (this.ownerSessionId !== sessionId) return { ok: false, code: ERR.NOT_OWNER, msg: '只有房主可以开下一局' };
  if (this.engine.phase !== 'end' && this.engine.phase !== 'idle') {
    return { ok: false, code: ERR.PHASE_WRONG, msg: '本局尚未结束' };
  }
  this.status = 'playing';
  this._resetTakeover();                 // 新局：超时次数与电脑接管全部清零
  var snap = this.engine.startRound();
  this.broadcastEvent(EVT.ROUND_START, {
    roundNum: snap.roundNum, ghost: snap.ghost, dealer: snap.dealer
  });
  this.broadcastState();
  this._armDiscardTimer(snap.dealer);   // 新局庄家先出牌
  return { ok: true };
};

Room.prototype._doAbortRound = function (sessionId, seat) {
  if (this.ownerSessionId !== sessionId) return { ok: false, code: ERR.NOT_OWNER, msg: '只有房主可中止' };
  if (this.status !== 'playing') return { ok: false, code: ERR.PHASE_WRONG, msg: '当前未在游戏中' };

  this._clearAllAutoTimers();   // 中止本局：清掉所有托管定时器
  this.deadlines = { discard: 0, claim: 0 };
  // 回滚到本局开始前积分
  if (this.engine.preRoundPoints) {
    for (var i = 0; i < 4; i++) {
      if (this.engine.preRoundPoints[i] !== undefined) {
        this.engine.players[i].points = this.engine.preRoundPoints[i];
      }
    }
  }
  this.engine.ended = true;
  this.engine.phase = 'end';
  this.engine.endData = {
    aborted: true, draw: true, name: '中止本局',
    scores: [0, 0, 0, 0],
    points: this.engine.players.map(function (pl) { return pl.points; }),
    hands: this.engine.players.map(function (pl, i) { return this.engine.evalHandFor(i); }, this),
    melds: this.engine.players.map(function (pl) { return pl.melds.slice(); }),
    pendingScores: []
  };
  this.status = 'waiting';
  this.broadcastEvent(EVT.ROUND_END, { aborted: true });
  this.broadcastState();
  return { ok: true };
};

// ---------- 机器人补位（阶段C扩展：房主手动加/删机器人）----------
Room.prototype._doAddBot = function (sessionId) {
  if (this.ownerSessionId !== sessionId) return { ok: false, code: ERR.NOT_OWNER, msg: '只有房主可以加机器人' };
  if (this.status !== 'waiting') return { ok: false, code: ERR.ALREADY_STARTED, msg: '游戏进行中不能加机器人' };
  var emptySeat = -1;
  for (var i = 0; i < 4; i++) { if (!this.seats[i]) { emptySeat = i; break; } }
  if (emptySeat < 0) return { ok: false, code: ERR.ROOM_FULL, msg: '没有空位了' };
  this.botSeq++;
  this.seats[emptySeat] = {
    isBot: true,
    name: '机器人' + this.botSeq,
    connected: true,
    personality: ai.pickPersonality()
  };
  this.broadcastRoomUpdate();
  return { ok: true, seat: emptySeat };
};

Room.prototype._doRemoveBot = function (sessionId, seat) {
  if (this.ownerSessionId !== sessionId) return { ok: false, code: ERR.NOT_OWNER, msg: '只有房主可以移除机器人' };
  if (this.status !== 'waiting') return { ok: false, code: ERR.ALREADY_STARTED, msg: '游戏进行中不能移除机器人' };
  if (seat < 0 || seat > 3) return { ok: false, code: ERR.BAD_PAYLOAD, msg: '座位号 0-3' };
  var s = this.seats[seat];
  if (!s || !s.isBot) return { ok: false, code: ERR.ACTION_INVALID, msg: '该座位不是机器人' };
  this.seats[seat] = null;
  this.broadcastRoomUpdate();
  return { ok: true };
};

Room.prototype._doDiscard = function (sessionId, seat, payload) {
  if (this.engine.phase !== 'discard') return { ok: false, code: ERR.PHASE_WRONG, msg: '当前不能出牌' };
  if (this.engine.turn !== seat) return { ok: false, code: ERR.NOT_YOUR_TURN, msg: '没轮到你' };
  var p = this.engine.players[seat];
  var tile = payload.tile;
  // 校验手中有该牌
  var evalHand = this.engine.evalHandFor(seat);
  if (evalHand.indexOf(tile) < 0) return { ok: false, code: ERR.TILE_NOT_IN_HAND, msg: '手里没这张牌' };

  this._clearAutoTimerForSeat(seat);   // 玩家自己出牌了，清掉代出定时器
  this.engine.doDiscard(seat, tile, payload.preIdx);
  this.broadcastEvent(EVT.DISCARD, { seat: seat, tile: tile });
  // doDiscard 可能进 phase='claim' 或 nextTurn→'discard'
  if (this.engine.phase === 'claim') {
    this._passingSeats = {};
    this._huWinners = null;
    this.broadcastEvent(EVT.CLAIM_OPTIONS, {
      seats: this.engine.claimants.map(function (c) { return c.seat; })
    });
    this._armClaimTimers(this.engine.claimants.map(function (c) { return c.seat; }));
  } else if (this.engine.phase === 'discard') {
    // 下家摸牌了，给他上 discard 定时器
    this._armDiscardTimer(this.engine.turn);
  }
  // phase === 'end' 不上定时器（荒庄）
  this.broadcastState();
  return { ok: true };
};

Room.prototype._doPeng = function (sessionId, seat) {
  if (this.engine.phase !== 'claim') return { ok: false, code: ERR.PHASE_WRONG, msg: '当前不能碰' };
  if (this.engine.robKongCandidates) return { ok: false, code: ERR.ACTION_INVALID, msg: '抢杠窗口只能 hu/pass' };
  var c = null;
  for (var i = 0; i < this.engine.claimants.length; i++) {
    if (this.engine.claimants[i].seat === seat) { c = this.engine.claimants[i]; break; }
  }
  if (!c || !c.peng) return { ok: false, code: ERR.ACTION_INVALID, msg: '你不能碰' };
  if (this._passingSeats[seat]) return { ok: false, code: ERR.ACTION_INVALID, msg: '你已 pass' };

  // 第一个非 pass claim：立即生效，其余 claimant 收 error
  var tile = c.tile, from = c.from;
  this._clearAllAutoTimers();   // claim 阶段结束，清掉所有候选人的定时器
  this.engine.doPeng(seat, tile, from);
  this._passingSeats = {};
  this._huWinners = null;
  this.broadcastEvent(EVT.PENG, { seat: seat, tile: tile, from: from });
  this.broadcastState();
  this._armDiscardTimer(seat);   // 碰者要出牌
  return { ok: true };
};

Room.prototype._doKong = function (sessionId, seat, payload) {
  var eng = this.engine;
  if (eng.phase === 'discard' && eng.turn === seat) {
    // 自摸后自杠：ag 或 bg
    var kongs = eng.selfKongsFor(seat);
    var opt = null;
    for (var i = 0; i < kongs.length; i++) {
      if (kongs[i].kind === payload.kind && kongs[i].tile === payload.tile) { opt = kongs[i]; break; }
    }
    if (!opt) return { ok: false, code: ERR.ACTION_INVALID, msg: '你不能这么杠' };
    var preTile = payload.tile;
    this._clearAutoTimerForSeat(seat);   // 自杠前清掉自己的代出定时器
    eng.doKong(seat, payload.kind, preTile, null);
    this.broadcastEvent(EVT.KONG, { seat: seat, kind: payload.kind, tile: preTile, from: null });
    // doKong 内若 kind='bg' 且被抢 → phase='claim'，robKongCandidates 已设
    if (eng.phase === 'claim') {
      this._passingSeats = {};
      this._huWinners = [];
      this.broadcastEvent(EVT.CLAIM_OPTIONS, {
        robKong: true,
        seats: eng.robKongCandidates.slice(),
        provider: eng.kongResume ? eng.kongResume.seat : -1,
        tile: preTile
      });
      this._armClaimTimers(eng.robKongCandidates.slice());
    } else {
      this._armDiscardTimer(seat);   // 杠者补牌后要出牌
    }
    this.broadcastState();
    return { ok: true };
  }

  if (eng.phase === 'claim' && !eng.robKongCandidates) {
    // 普通 claim 的明杠（mg）
    var c2 = null;
    for (var j = 0; j < eng.claimants.length; j++) {
      if (eng.claimants[j].seat === seat) { c2 = eng.claimants[j]; break; }
    }
    if (!c2 || !c2.kong || c2.kind !== 'mg') return { ok: false, code: ERR.ACTION_INVALID, msg: '你不能明杠' };
    if (this._passingSeats[seat]) return { ok: false, code: ERR.ACTION_INVALID, msg: '你已 pass' };

    var mTile = c2.tile, mFrom = c2.from;
    this._clearAllAutoTimers();   // claim 阶段结束
    eng.doKong(seat, 'mg', mTile, { from: mFrom });
    this._passingSeats = {};
    this._huWinners = null;
    this.broadcastEvent(EVT.KONG, { seat: seat, kind: 'mg', tile: mTile, from: mFrom });
    this.broadcastState();
    this._armDiscardTimer(seat);   // 杠者补牌后要出牌
    return { ok: true };
  }

  return { ok: false, code: ERR.PHASE_WRONG, msg: '当前不能杠' };
};

Room.prototype._doPass = function (sessionId, seat) {
  var eng = this.engine;
  if (eng.phase !== 'claim') return { ok: false, code: ERR.PHASE_WRONG, msg: '当前不在 claim 阶段' };
  if (this._passingSeats[seat]) return { ok: false, code: ERR.ACTION_INVALID, msg: '已 pass 过' };

  // 抢杠窗口
  if (eng.robKongCandidates && eng.robKongCandidates.indexOf(seat) >= 0) {
    this._clearAutoTimerForSeat(seat);   // 玩家自己决策了，清掉代 pass 定时器
    this._passingSeats[seat] = true;
    this.broadcastEvent(EVT.PASS, { seat: seat, robKong: true });
    // 所有人都 pass 完？
    var allPassed = true;
    for (var i = 0; i < eng.robKongCandidates.length; i++) {
      if (!this._passingSeats[eng.robKongCandidates[i]]) { allPassed = false; break; }
    }
    if (allPassed) {
      // 全 pass → 若已收集 huWinners → endRobKongMulti；否则 resumeKong
      if (this._huWinners && this._huWinners.length > 0) {
        this._fireRobKongEnd();
      } else {
        eng.resumeKong();
        this._passingSeats = {};
        this._huWinners = null;
        this.broadcastState();
        this._armDiscardTimer(eng.turn);   // 补杠者继续摸牌出牌
      }
    } else {
      this.broadcastState();
      // 剩余候选人的定时器继续跑（_clearAutoTimerForSeat 只清当前 seat）
    }
    return { ok: true };
  }

  // 普通 claim
  var inClaim = false;
  for (var k = 0; k < eng.claimants.length; k++) {
    if (eng.claimants[k].seat === seat) { inClaim = true; break; }
  }
  if (!inClaim) return { ok: false, code: ERR.ACTION_INVALID, msg: '你不能 pass（不在候选）' };

  this._clearAutoTimerForSeat(seat);   // 玩家自己 pass 了，清掉代 pass 定时器
  this._passingSeats[seat] = true;
  this.broadcastEvent(EVT.PASS, { seat: seat });
  // 所有人 pass 完 → nextTurn
  var all = true;
  for (var j2 = 0; j2 < eng.claimants.length; j2++) {
    if (!this._passingSeats[eng.claimants[j2].seat]) { all = false; break; }
  }
  if (all) {
    eng.nextTurn();
    this._passingSeats = {};
    this._huWinners = null;
    // nextTurn 后可能荒庄 → phase='end'
    if (eng.phase === 'end') {
      this.broadcastEvent(EVT.HUANGZHUANG, eng.endData);
      // 荒庄：无定时器
    } else {
      this.broadcastEvent(EVT.DRAW, { seat: eng.turn });
      this._armDiscardTimer(eng.turn);   // 下家摸牌了
    }
  }
  this.broadcastState();
  return { ok: true };
};

Room.prototype._doHu = function (sessionId, seat) {
  var eng = this.engine;
  if (eng.phase === 'discard' && eng.turn === seat) {
    // 自摸胡
    var evalHand = eng.evalHandFor(seat);
    if (!require('../js/mahjong.js').checkWin(evalHand, eng.ghost, eng.players[seat].melds)) {
      return { ok: false, code: ERR.ACTION_INVALID, msg: '你没胡' };
    }
    this._clearAutoTimerForSeat(seat);   // 玩家自己胡了，清掉代出定时器
    eng.endRound(seat, { isSelfDraw: true });
    this.broadcastEvent(EVT.HU, { seat: seat, isSelfDraw: true, endData: eng.endData });
    this.broadcastEvent(EVT.ROUND_END, eng.endData);
    this.broadcastState();
    this.status = 'waiting';
    // 自摸胡后 phase='end'，无定时器
    return { ok: true };
  }
  if (eng.phase === 'claim' && eng.robKongCandidates && eng.robKongCandidates.indexOf(seat) >= 0) {
    // 抢杠胡：登记到 huWinners，等所有人都决策完再结算
    if (this._huWinners && this._huWinners.indexOf(seat) >= 0) {
      return { ok: false, code: ERR.ACTION_INVALID, msg: '已选胡' };
    }
    this._clearAutoTimerForSeat(seat);   // 玩家自己决策了，清掉代 pass 定时器
    if (!this._huWinners) this._huWinners = [];
    this._huWinners.push(seat);
    this.broadcastEvent(EVT.HU, { seat: seat, robKong: true });
    // 把该 seat 标记为已决策
    this._passingSeats[seat] = true;
    // 所有人决策完？
    var all = true;
    for (var i = 0; i < eng.robKongCandidates.length; i++) {
      if (!this._passingSeats[eng.robKongCandidates[i]]) { all = false; break; }
    }
    if (all) this._fireRobKongEnd();
    else this.broadcastState();
    return { ok: true };
  }
  return { ok: false, code: ERR.PHASE_WRONG, msg: '当前不能胡' };
};

// 触发抢杠胡结算
Room.prototype._fireRobKongEnd = function () {
  var eng = this.engine;
  this._clearAllAutoTimers();   // 抢杠结算：清掉所有候选人的定时器
  var winners = (this._huWinners || []).slice();
  var provider = eng.kongResume ? eng.kongResume.seat : -1;
  var tile = eng.kongResume ? eng.kongResume.tile : null;
  if (winners.length > 0 && provider >= 0) {
    eng.endRobKongMulti(winners, provider, tile);
    this.broadcastEvent(EVT.HU, { robKong: true, winners: winners, provider: provider });
    this.broadcastEvent(EVT.ROUND_END, eng.endData);
    this.status = 'waiting';
    // 抢杠胡后 phase='end'，无定时器
  } else {
    eng.resumeKong();
    this.broadcastState();
    this._armDiscardTimer(eng.turn);   // 补杠者继续摸牌出牌
  }
  this._passingSeats = {};
  this._huWinners = null;
};

// ---------- 处理 ws 生命周期 ----------
Room.prototype.attachWs = function (sessionId, ws, name) {
  // 已在该房：重连
  var seat = this.seatOf(sessionId);
  if (seat >= 0) {
    var s = this.seats[seat];
    s.ws = ws; s.connected = true; s.lastSeen = Date.now();
    if (name) s.name = name;
    this.broadcastRoomUpdate();
    return seat;
  }
  // 未入房：优先找 null 空位
  for (var i = 0; i < 4; i++) {
    if (!this.seats[i]) {
      this.seats[i] = {
        sessionId: sessionId, ws: ws, name: name || ('玩家' + (i + 1)),
        connected: true, lastSeen: Date.now()
      };
      if (this.ownerSessionId === null) this.ownerSessionId = sessionId;
      this.broadcastRoomUpdate();
      // 如果新玩家是当前 turn 或 claim 候选人，arm 真人 timer（Advisor: null-seat 路径也要 arm timer）
      this._rearmForSeat(i);
      return i;
    }
  }
  // 全满但有机器人占座 → 替换机器人
  for (var j = 0; j < 4; j++) {
    if (this.seats[j] && this.seats[j].isBot) {
      // 清该座位的 auto timer（bot 正在 auto-play 的话先停掉）
      this._clearAutoTimerForSeat(j);
      // 清接管标记（bot 不会被托管，但以防万一）
      delete this.takenOver[j];
      delete this.timeoutCounts[j];
      // 替换座位记录为真人
      this.seats[j] = {
        sessionId: sessionId, ws: ws, name: name || ('玩家' + (j + 1)),
        connected: true, lastSeen: Date.now()
      };
      this.broadcastRoomUpdate();  // 自带 broadcastState，所有人（含新玩家）拿到最新状态
      // 如果新玩家是当前 turn 或 claim 候选人，arm 真人 timer（复用 _rearmForSeat）
      this._rearmForSeat(j);
      return j;
    }
  }
  // 全是真人 → 满座
  return -1;
};

Room.prototype.markDisconnected = function (sessionId) {
  var seat = this.seatOf(sessionId);
  if (seat < 0) return;
  this.seats[seat].connected = false;
  this.broadcastRoomUpdate();
};

// ---------- 阶段D 步骤3：服务端托管定时器 ----------
// 多座位并行定时器：discard 阶段只盯一个座位（轮到的出牌者）；
// claim 阶段每个候选人各有一个独立 timer，谁先超时谁先代 pass
Room.prototype._clearAutoTimerForSeat = function (seat) {
  if (this.autoTimers[seat]) {
    clearTimeout(this.autoTimers[seat]);
    delete this.autoTimers[seat];
  }
  if (this.autoKinds) delete this.autoKinds[seat];
};

Room.prototype._clearAllAutoTimers = function () {
  if (!this.autoTimers) return;
  var self = this;
  Object.keys(this.autoTimers).forEach(function (k) {
    clearTimeout(self.autoTimers[k]);
  });
  this.autoTimers = {};
  this.autoKinds = {};
};

// 辅助：给指定座位根据 engine.phase/turn 重新 arm 正确的 timer
// 用于：attachWs（null-seat 和 bot-replace 两条路径）、_doLeave 恢复 bot
Room.prototype._rearmForSeat = function (seat) {
  if (this.status !== 'playing') return;
  var eng = this.engine;
  if (!eng) return;
  if (eng.phase === 'discard' && eng.turn === seat) {
    this._armDiscardTimer(seat);
  } else if (eng.phase === 'claim') {
    var cSeats = eng.claimants.map(function (c) { return c.seat; });
    if (cSeats.indexOf(seat) >= 0) {
      this._armClaimTimers(cSeats);
    }
  }
};

// 新局重置：超时次数与电脑接管清零
Room.prototype._resetTakeover = function () {
  this._clearAllAutoTimers();
  this.timeoutCounts = [0, 0, 0, 0];
  this.takenOver = [false, false, false, false];
  this.deadlines = { discard: 0, claim: 0 };
};

// 给轮到的出牌者上 discard 定时器
// 正常座位 30s 超时代打（一局内累计2次→本局接管）；已接管座位只等 1.2s 直接代打（不发倒计时）
Room.prototype._armDiscardTimer = function (seat) {
  this._clearAllAutoTimers();
  if (this.status !== 'playing') return;
  var self = this;
  var taken = !!this.takenOver[seat];
  var isBot = !!this.seats[seat] && !!this.seats[seat].isBot;
  var delay;
  if (isBot) delay = 1500 + Math.random() * 1500;
  else if (taken) delay = this.autoTimeouts.takeover;
  else delay = this.autoTimeouts.discard;
  this.autoKinds[seat] = 'discard';
  // 机器人和已接管座位不显示倒计时压力
  this.deadlines = { discard: (isBot || taken) ? 0 : (Date.now() + delay), claim: 0 };
  this.autoTimers[seat] = setTimeout(function () {
    delete self.autoTimers[seat];
    delete self.autoKinds[seat];
    var eng = self.engine;
    // 守卫：phase/turn 不匹配就放弃（可能玩家自己出牌了或回合被中止）
    if (eng.phase !== 'discard' || eng.turn !== seat) return;
    var p = eng.players[seat];
    var tile, preIdx = -2;
    var justTakenOver = false;

    if (isBot) {
      // 机器人AI决策
      // 1. 先检查能不能自摸胡
      var evalHand = eng.evalHandFor(seat);
      if (mj.checkWin(evalHand, eng.ghost, eng.players[seat].melds)) {
        self.deadlines = { discard: 0, claim: 0 };
        eng.endRound(seat, { isSelfDraw: true });
        self.broadcastEvent(EVT.HU, { seat: seat, isSelfDraw: true, endData: eng.endData });
        self.broadcastState();
        return;
      }
      // 2. AI 选牌出牌（不主动杠，简化）
      tile = ai.aiDiscard(seat, eng, self.seats[seat].personality);
      preIdx = (tile === p.lastDraw) ? -2 : p.hand.indexOf(tile);
    } else {
      // 真人超时代打（随机）
      tile = p.lastDraw;
      if (!tile) {
        if (!p.hand.length) return;
        var idx = Math.floor(Math.random() * p.hand.length);
        tile = p.hand[idx];
        preIdx = idx;
      }
      if (!taken) {
        self.timeoutCounts[seat]++;
        if (self.timeoutCounts[seat] >= 2) {
          self.takenOver[seat] = true;
          justTakenOver = true;
        }
      }
    }
    self.deadlines = { discard: 0, claim: 0 };
    eng.doDiscard(seat, tile, preIdx);
    if (isBot) {
      self.broadcastEvent(EVT.DISCARD, { seat: seat, tile: tile });
    } else {
      self.broadcastEvent(EVT.DISCARD, { seat: seat, tile: tile, auto: true });
      self.broadcastEvent(EVT.AUTO_ACTION, {
        seat: seat, kind: 'discard', tile: tile,
        count: self.timeoutCounts[seat], takenOver: !!self.takenOver[seat],
        justTakenOver: justTakenOver
      });
    }
    if (eng.phase === 'claim') {
      self._passingSeats = {};
      self._huWinners = null;
      self.broadcastEvent(EVT.CLAIM_OPTIONS, {
        seats: eng.claimants.map(function (c) { return c.seat; })
      });
      self._armClaimTimers(eng.claimants.map(function (c) { return c.seat; }));
    } else if (eng.phase === 'discard') {
      self._armDiscardTimer(eng.turn);
    }
    // phase === 'end' 不上定时器（荒庄或胡牌）
    self.broadcastState();
  }, delay);
  // 截止时间刚更新，立刻同步一次给各客户端
  this.broadcastState();
};

// 给所有候选人上 claim 定时器（正常 15s 超时代 pass；机器人 0.8~1.5s AI 决策；被接管者 1s 自动过）
Room.prototype._armClaimTimers = function (seats) {
  // claim 阶段开始：先清掉旧的 discard timer（同一个出牌周期里只可能有一个 timer 在跑）
  this._clearAllAutoTimers();
  if (this.status !== 'playing') return;
  var self = this;
  var hasRealSeat = false;   // 存在未接管的真人候选人时，才给全房显示 15s 选择倒计时
  seats.forEach(function (seat) {
    var taken = !!self.takenOver[seat];
    var isBot = !!self.seats[seat] && !!self.seats[seat].isBot;
    if (!taken && !isBot) hasRealSeat = true;
    var delay;
    if (isBot) delay = 800 + Math.random() * 700;
    else if (taken) delay = self.autoTimeouts.takeoverClaim;
    else delay = self.autoTimeouts.claim;
    self.autoKinds[seat] = 'claim';
    self.autoTimers[seat] = setTimeout(function () {
      delete self.autoTimers[seat];
      delete self.autoKinds[seat];
      var eng = self.engine;
      // 守卫：claim 阶段已结束就放弃（可能其他人 peng/kong 了）
      if (eng.phase !== 'claim') return;
      if (self._passingSeats[seat]) return;  // 已决策

      if (isBot) {
        // 机器人 AI 决策
        var robKong = eng.robKongCandidates && eng.robKongCandidates.indexOf(seat) >= 0;
        if (robKong) {
          // 抢杠窗口：机器人不抢杠，直接 pass
          self._doPass(null, seat);
          return;
        }
        // 普通 claim：找自己的 claim 选项
        var claim = null;
        for (var ci = 0; ci < eng.claimants.length; ci++) {
          if (eng.claimants[ci].seat === seat) { claim = eng.claimants[ci]; break; }
        }
        if (claim && ai.aiClaimDecision(claim, self.seats[seat].personality)) {
          if (claim.kong) {
            self._doKong(null, seat, { kind: claim.kind, tile: claim.tile });
          } else {
            self._doPeng(null, seat);
          }
        } else {
          self._doPass(null, seat);
        }
        return;
      }

      // 真人超时代 pass
      self.broadcastEvent(EVT.AUTO_ACTION, {
        seat: seat, kind: 'pass', takenOver: taken
      });
      self._doPass(null, seat);
    }, delay);
  });
  this.deadlines = { discard: 0, claim: hasRealSeat ? (Date.now() + this.autoTimeouts.claim) : 0 };
  this.broadcastState();
};

// ---------- RoomManager ----------
function RoomManager() {
  this.rooms = new Map();         // roomId -> Room
  this.sessionRoom = new Map();   // sessionId -> {room, seat}
}

RoomManager.prototype._genRoomId = function () {
  var id;
  for (var i = 0; i < 50; i++) {
    id = P.genRoomId();
    if (!this.rooms.has(id)) return id;
  }
  return P.genRoomId();   // 极小概率重复，交给用户处理
};

RoomManager.prototype.createRoom = function (sessionId, ws, opts) {
  opts = opts || {};
  // 已在房：先退出旧房
  if (this.sessionRoom.has(sessionId)) this.leaveRoom(sessionId);

  var roomId = opts.roomId && !this.rooms.has(opts.roomId) ? opts.roomId : this._genRoomId();
  if (this.rooms.has(roomId)) return { ok: false, code: ERR.ROOM_ID_TAKEN, msg: '房间号已存在' };

  var room = new Room(roomId, opts.baseScore, opts.initScore, opts.cardExpiry || 0);
  this.rooms.set(roomId, room);
  var seat = room.attachWs(sessionId, ws, opts.name);
  this.sessionRoom.set(sessionId, { room: room, seat: seat });
  return { ok: true, roomId: roomId, seat: seat };
};

RoomManager.prototype.joinRoom = function (sessionId, ws, roomId, name) {
  // 已在房：先退出旧房
  if (this.sessionRoom.has(sessionId)) {
    var prev = this.sessionRoom.get(sessionId);
    if (prev.room.roomId === roomId) {
      // 同房重连
      var seat = prev.room.attachWs(sessionId, ws, name);
      prev.seat = seat;
      return { ok: true, roomId: roomId, seat: seat };
    }
    this.leaveRoom(sessionId);
  }

  var room = this.rooms.get(roomId);
  if (!room) return { ok: false, code: ERR.ROOM_NOT_FOUND, msg: '房间不存在' };

  var seat = room.attachWs(sessionId, ws, name);
  if (seat < 0) return { ok: false, code: ERR.ROOM_FULL, msg: '房间满座' };
  this.sessionRoom.set(sessionId, { room: room, seat: seat });
  return { ok: true, roomId: roomId, seat: seat };
};

RoomManager.prototype.leaveRoom = function (sessionId) {
  var entry = this.sessionRoom.get(sessionId);
  if (!entry) return { ok: true };
  var room = entry.room;
  room._doLeave(sessionId);
  this.sessionRoom.delete(sessionId);
  // 房间空 → 清理
  if (room.isEmpty()) this.rooms.delete(room.roomId);
  return { ok: true };
};

RoomManager.prototype.markDisconnected = function (sessionId) {
  var entry = this.sessionRoom.get(sessionId);
  if (!entry) return;
  entry.room.markDisconnected(sessionId);
  if (entry.room.isEmpty()) {
    this.rooms.delete(entry.room.roomId);
    this.sessionRoom.delete(sessionId);
  }
};

RoomManager.prototype.dispatch = function (sessionId, type, payload) {
  var entry = this.sessionRoom.get(sessionId);
  if (!entry) return { ok: false, code: ERR.NOT_IN_ROOM, msg: '你不在房间' };
  // 先用最新 ws 同步给 seat
  return entry.room.dispatch(sessionId, type, payload);
};

RoomManager.prototype.getRoomOf = function (sessionId) {
  var entry = this.sessionRoom.get(sessionId);
  return entry ? entry.room : null;
};

// 清理超过 1 小时无活动且无连接的房
RoomManager.prototype.cleanupIdle = function () {
  var now = Date.now();
  var self = this;
  var toDel = [];
  this.rooms.forEach(function (room, id) {
    if (room.isEmpty() || (now - room.lastActivity > 3600000 && !room.seats.some(function (s) { return s && s.connected; }))) {
      toDel.push(id);
    }
  });
  toDel.forEach(function (id) {
    var room = self.rooms.get(id);
    if (!room) return;
    room._clearAllAutoTimers();   // 防泄漏：销毁房间前清掉全部托管定时器
    room.seats.forEach(function (s) {
      if (s) self.sessionRoom.delete(s.sessionId);
    });
    self.rooms.delete(id);
  });
};

module.exports = { Room: Room, RoomManager: RoomManager };
