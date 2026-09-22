// server/fuzz_test.js — 房间级 fuzz 测试：跑 100 局验证零和+张数守恒+无崩
// 不走 ws，直接调 RoomManager.dispatch（MockWs 接消息）
'use strict';

var { RoomManager } = require('./room.js');
var P = require('./protocol.js');
var C = P.C;
var mj = require('../js/mahjong.js');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function MockWs() { this.sent = []; this.readyState = 1; this.send = function (s) { this.sent.push(JSON.parse(s)); }; }

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
function sumPoints(eng) { return eng.players.reduce(function (s, p) { return s + p.points; }, 0); }

// 跑一局自动对局
function playOneRound(mgr, sessIds, wsMap) {
  var room = mgr.getRoomOf(sessIds[0]);
  mgr.dispatch(sessIds[0], C.START_ROUND, {});

  var safety = 0;
  while (room.engine.phase !== 'end' && safety++ < 1500) {
    var eng = room.engine;
    if (eng.phase === 'discard') {
      var turn = eng.turn;
      var sessId = sessIds[turn];
      var evalHand = eng.evalHandFor(turn);
      // 自摸胡
      if (mj.checkWin(evalHand, eng.ghost, eng.players[turn].melds)) {
        mgr.dispatch(sessId, C.HU, {});
        continue;
      }
      // 自杠
      var kongs = eng.selfKongsFor(turn);
      if (kongs.length && Math.random() < 0.25) {
        var k = kongs[0];
        mgr.dispatch(sessId, C.KONG, { kind: k.kind, tile: k.tile });
        continue;
      }
      // 出牌：优先 lastDraw
      var p = eng.players[turn];
      var tile = p.lastDraw || p.hand[Math.floor(Math.random() * p.hand.length)];
      if (!tile) break;
      var preIdx = (tile === p.lastDraw) ? -2 : p.hand.indexOf(tile);
      mgr.dispatch(sessId, C.DISCARD, { tile: tile, preIdx: preIdx });
    } else if (eng.phase === 'claim') {
      if (eng.robKongCandidates) {
        // 抢杠：30% 概率胡
        eng.robKongCandidates.forEach(function (s) {
          if (Math.random() < 0.3) mgr.dispatch(sessIds[s], C.HU, {});
          else mgr.dispatch(sessIds[s], C.PASS, {});
        });
      } else {
        // 普通 claim：30% peng，否则 pass
        var did = false;
        for (var i = 0; i < eng.claimants.length; i++) {
          var cl = eng.claimants[i];
          if (cl.peng && !did && Math.random() < 0.3) {
            mgr.dispatch(sessIds[cl.seat], C.PENG, {});
            did = true;
          } else {
            mgr.dispatch(sessIds[cl.seat], C.PASS, {});
          }
        }
      }
    }
  }
  return room;
}

// ---------- fuzz ----------
console.log('fuzz 100 局开始…');
var mgr = new RoomManager();
var wsList = [new MockWs(), new MockWs(), new MockWs(), new MockWs()];
var sessIds = ['a', 'b', 'c', 'd'];

var r = mgr.createRoom('a', wsList[0], { baseScore: 3, initScore: 1000, name: '甲' });
var rid = r.roomId;
mgr.joinRoom('b', wsList[1], rid, '乙');
mgr.joinRoom('c', wsList[2], rid, '丙');
mgr.joinRoom('d', wsList[3], rid, '丁');

var totalRounds = 100;
var zeroSumBreaks = 0;
var tileCountBreaks = 0;
var crashes = 0;
var phaseStuck = 0;

for (var g = 0; g < totalRounds; g++) {
  try {
    var room = playOneRound(mgr, sessIds, wsList);
    if (room.engine.phase !== 'end') phaseStuck++;
    if (sumPoints(room.engine) !== 4000) {
      zeroSumBreaks++;
      if (zeroSumBreaks <= 3) console.log('  零和被打破 局#' + g + ' sum=' + sumPoints(room.engine));
    }
    if (countAll(room.engine) !== 108) {
      tileCountBreaks++;
      if (tileCountBreaks <= 3) console.log('  张数被打破 局#' + g + ' count=' + countAll(room.engine));
    }
    // 房主开下一局
    mgr.dispatch('a', C.NEXT_ROUND, {});
  } catch (e) {
    crashes++;
    if (crashes <= 3) console.log('  crash 局#' + g + ': ' + e.message);
  }
}

check('100 局全部跑完', crashes === 0, crashes + ' 次 crash');
check('零和守恒（4*1000=4000）', zeroSumBreaks === 0, zeroSumBreaks + ' 次打破');
check('张数守恒（108）', tileCountBreaks === 0, tileCountBreaks + ' 次打破');
check('无 phase 卡死', phaseStuck === 0, phaseStuck + ' 次未到 end');

console.log('\n========================================');
console.log('  fuzz_test: ' + pass + ' pass / ' + fail + ' fail');
console.log('  100 局零和/张数/无崩 全部断言');
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
