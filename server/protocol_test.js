// server/protocol_test.js — protocol + room 模拟测试
// 用 MockWs 模拟 4 个客户端，验证 RoomManager 跑完整一局不崩且守恒
'use strict';

var P = require('./protocol.js');
var C = P.C;
var { RoomManager } = require('./room.js');
var mj = require('../js/mahjong.js');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// MockWs：收集所有发送过的消息
function MockWs() {
  this.sent = [];
  this.readyState = 1;
  this.send = function (s) { this.sent.push(JSON.parse(s)); };
}

var mgr = new RoomManager();

// ---------- 场景1：房间管理 ----------
console.log('\n== 场景1：房管基础 ==');
var w1 = new MockWs();
var r1 = mgr.createRoom('s1', w1, { baseScore: 3, initScore: 1000, name: '甲' });
check('createRoom 返回 roomId+seat', r1.ok && r1.seat === 0, JSON.stringify(r1));
check('room_created 消息', w1.sent.some(function (m) { return m.type === 'event' && m.evt === 'room_state'; }));

// 第5人 join 满 → full
var w5 = new MockWs();
var r5 = mgr.createRoom('s5', w5, { name: '戊' });   // 先创建新房给戊（避免满房错误）
check('戊能 createRoom', r5.ok);

// 让 4 人入同一房：甲已入 seat0，乙丙丁 join
var w2 = new MockWs(), w3 = new MockWs(), w4 = new MockWs();
var r2 = mgr.joinRoom('s2', w2, r1.roomId, '乙');
var r3 = mgr.joinRoom('s3', w3, r1.roomId, '丙');
var r4 = mgr.joinRoom('s4', w4, r1.roomId, '丁');
check('乙丙丁 join 成功', r2.ok && r3.ok && r4.ok, JSON.stringify([r2, r3, r4]));
check('座位分配正确', r2.seat === 1 && r3.seat === 2 && r4.seat === 3);

// 第5人加入已满房 → full
var w6 = new MockWs();
var r6 = mgr.joinRoom('s6', w6, r1.roomId, '戊');
check('满房报错', !r6.ok && r6.code === P.ERR.ROOM_FULL, JSON.stringify(r6));

// 非房主尝试开局 → notOwner
var bad = mgr.dispatch('s2', C.START_ROUND, {});
check('非房主报错', !bad.ok && bad.code === P.ERR.NOT_OWNER, JSON.stringify(bad));

// 2人房开不了：先测试空房
var mgr2 = new RoomManager();
var wa = new MockWs(), wb = new MockWs();
mgr2.createRoom('a', wa, { name: '甲' });
mgr2.joinRoom('b', wb, mgr2.getRoomOf('a').roomId, '乙');
var notFull = mgr2.dispatch('a', C.START_ROUND, {});
check('2人房报 notFull', !notFull.ok && notFull.code === P.ERR.ROOM_NOT_FULL, JSON.stringify(notFull));

// ---------- 场景2：完整一局 ==========
console.log('\n== 场景2：完整一局（自动出牌）==');
// 用 r1 这个房（4 人都在）
var room = mgr.getRoomOf('s1');
check('房里有4人', room.playerCount() === 4);

// 房主开局
var startRes = mgr.dispatch('s1', C.START_ROUND, {});
check('房主开局成功', startRes.ok, JSON.stringify(startRes));
check('phase=discard', room.engine.phase === 'discard');
check('庄家 lastDraw 已摸', !!room.engine.players[room.engine.dealer].lastDraw);
check('deckRemain=55', room.engine.deck.length === 55);

// 守恒：手牌+副露+弃牌+deck+lastDraw = 108
function countAll(eng) {
  var total = 0;
  for (var i = 0; i < 4; i++) {
    total += eng.players[i].hand.length;
    total += eng.players[i].melds.reduce(function (s, m) { return s + m.tiles.length; }, 0);
    total += eng.players[i].disp.length;
    if (eng.players[i].lastDraw) total += 1;
  }
  total += eng.deck.length;
  return total;
}
check('开局张数守恒=108', countAll(room.engine) === 108, 'got ' + countAll(room.engine));

// 零和：积分总和=4*1000
function sumPoints(eng) { return eng.players.reduce(function (s, p) { return s + p.points; }, 0); }
check('初始零和=4000', sumPoints(room.engine) === 4000, 'got ' + sumPoints(room.engine));

// 自动循环：当前 turn 的玩家随便出一张
var safety = 0;
var wsMap = { 0: w1, 1: w2, 2: w3, 3: w4 };
var sessMap = { 0: 's1', 1: 's2', 2: 's3', 3: 's4' };
while (room.engine.phase !== 'end' && safety++ < 500) {
  var eng = room.engine;
  if (eng.phase === 'discard') {
    var turn = eng.turn;
    var evalHand = eng.evalHandFor(turn);
    // 优先胡
    if (mj.checkWin(evalHand, eng.ghost, eng.players[turn].melds)) {
      mgr.dispatch(sessMap[turn], C.HU, {});
      continue;
    }
    // 检查自杠
    var kongs = eng.selfKongsFor(turn);
    if (kongs.length > 0) {
      // 30% 概率杠（避免无限循环）
      if (Math.random() < 0.3) {
        var k = kongs[0];
        mgr.dispatch(sessMap[turn], C.KONG, { kind: k.kind, tile: k.tile });
        continue;
      }
    }
    // 随便出一张：优先非 lastDraw
    var tile = evalHand[Math.floor(Math.random() * evalHand.length)];
    var preIdx = -2;
    if (tile !== eng.players[turn].lastDraw) {
      preIdx = eng.players[turn].hand.indexOf(tile);
    }
    mgr.dispatch(sessMap[turn], C.DISCARD, { tile: tile, preIdx: preIdx });
  } else if (eng.phase === 'claim') {
    // 抢杠窗口：候选各 50% 概率胡
    if (eng.robKongCandidates) {
      eng.robKongCandidates.forEach(function (s) {
        if (Math.random() < 0.5) {
          mgr.dispatch(sessMap[s], C.HU, {});
        } else {
          mgr.dispatch(sessMap[s], C.PASS, {});
        }
      });
    } else {
      // 普通 claim：30% peng, 否则全 pass
      var did = false;
      for (var i = 0; i < eng.claimants.length; i++) {
        var cl = eng.claimants[i];
        if (cl.peng && Math.random() < 0.3 && !did) {
          mgr.dispatch(sessMap[cl.seat], C.PENG, {});
          did = true;
        } else {
          mgr.dispatch(sessMap[cl.seat], C.PASS, {});
        }
      }
      if (!did) {
        // 全 pass 后引擎自动 nextTurn
      }
    }
  }
  if (safety % 50 === 0) check('  ...回合持续 ' + safety + ' 步', true);
}
check('一局结束', room.engine.phase === 'end', 'phase=' + room.engine.phase);
check('一局内张数守恒=108', countAll(room.engine) === 108, 'got ' + countAll(room.engine));
check('一局后零和=4000', sumPoints(room.engine) === 4000, 'got ' + sumPoints(room.engine));
check('endData 有 winner', room.engine.endData && (room.engine.endData.winner >= 0 || room.engine.endData.draw), JSON.stringify(room.engine.endData && room.engine.endData.name));

// ---------- 场景3：消息校验 ----------
console.log('\n== 场景3：protocol.validateClient ==');
var v;
v = P.validateClient({ type: 'ping' });        check('ping ok', v.ok);
v = P.validateClient({ type: 'discard', tile: 'T5' }); check('discard ok', v.ok);
v = P.validateClient({ type: 'discard', tile: 'XX' }); check('discard 坏 tile', !v.ok);
v = P.validateClient({ type: 'kong', kind: 'mg', tile: 'T5' }); check('kong ok', v.ok);
v = P.validateClient({ type: 'kong', kind: 'xx', tile: 'T5' }); check('kong 坏 kind', !v.ok);
v = P.validateClient({ type: 'take_seat', seat: 5 }); check('seat 越界', !v.ok);
v = P.validateClient({ type: 'unknown_xxx' }); check('未知 type', !v.ok);
v = P.validateClient(null); check('null 消息', !v.ok);
v = P.validateClient({ type: 'create_room', baseScore: 3 }); check('create_room ok', v.ok);

// ---------- 场景4：断线 ==========
console.log('\n== 场景4：断线标记 ==');
var before = room.playerCount();
mgr.markDisconnected('s2');
check('断线后座位仍占', room.playerCount() === before);
check('s2 座位标 disconnected', room.seats[1] && room.seats[1].connected === false);

console.log('\n========================================');
console.log('  protocol_test: ' + pass + ' pass / ' + fail + ' fail');
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
