// server/ws_smoke_test.js — 真实 ws 协议全链路冒烟测试
// 起 4 个 WebSocket 连到本地 8080，跑 create+join+start+discard+auto-fuzz
'use strict';

var WebSocket = require('ws');
var P = require('./protocol.js');
var C = P.C, S = P.S, EVT = P.EVT;
var mj = require('../js/mahjong.js');

var URL = 'ws://localhost:8080/ws';

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function Client(name) {
  this.name = name;
  this.ws = null;
  this.sessionId = null;
  this.seat = -1;
  this.state = null;
  this.events = [];
  this.ready = false;
}
Client.prototype.connect = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(URL);
    ws.on('open', function () { resolve(); });
    ws.on('error', reject);
    ws.on('message', function (raw) {
      var m = JSON.parse(raw.toString());
      if (m.type === S.HELLO) { self.sessionId = m.sessionId; }
      else if (m.type === S.ROOM_CREATED) { self.seat = m.seat; self.roomId = m.roomId; }
      else if (m.type === S.ROOM_JOINED) { self.seat = m.seat; self.roomId = m.roomId; }
      else if (m.type === S.STATE) { self.state = m.state; }
      else if (m.type === S.EVENT) { self.events.push(m); }
      else if (m.type === S.ERROR) { self.lastError = m; }
    });
    self.ws = ws;
  });
};
Client.prototype.send = function (obj) { this.ws.send(JSON.stringify(obj)); };
Client.prototype.waitMsg = function (pred, timeout) {
  var self = this;
  return new Promise(function (resolve) {
    var done = false;
    var handler = function (raw) {
      var m;
      try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!done && pred(m)) {
        done = true;
        clearTimeout(t);
        self.ws.removeListener('message', handler);
        resolve(m);
      }
    };
    var t = setTimeout(function () {
      if (!done) { done = true; self.ws.removeListener('message', handler); resolve(null); }
    }, timeout || 1500);
    self.ws.on('message', handler);
  });
};

async function main() {
  var a = new Client('甲'), b = new Client('乙'), c = new Client('丙'), d = new Client('丁');
  await Promise.all([a.connect(), b.connect(), c.connect(), d.connect()]);
  await wait(100);
  check('4 个 ws 都 hello', a.sessionId && b.sessionId && c.sessionId && d.sessionId);

  // 房主 create
  a.send({ type: C.CREATE_ROOM, baseScore: 3, initScore: 1000, name: '甲' });
  var rc = await a.waitMsg(function (m) { return m.type === S.ROOM_CREATED; });
  check('client0 收到 room_created', !!rc, JSON.stringify(rc && { roomId: rc.roomId, seat: rc.seat }));
  var rid = rc.roomId;

  // 1/2/3 join
  b.send({ type: C.JOIN_ROOM, roomId: rid, name: '乙' });
  c.send({ type: C.JOIN_ROOM, roomId: rid, name: '丙' });
  d.send({ type: C.JOIN_ROOM, roomId: rid, name: '丁' });
  var jb = await b.waitMsg(function (m) { return m.type === S.ROOM_JOINED; });
  var jc = await c.waitMsg(function (m) { return m.type === S.ROOM_JOINED; });
  var jd = await d.waitMsg(function (m) { return m.type === S.ROOM_JOINED; });
  check('1/2/3 都 room_joined', jb && jc && jd, JSON.stringify([jb, jc, jd]));
  check('4 个座位分配正确', a.seat === 0 && b.seat === 1 && c.seat === 2 && d.seat === 3);

  // 等所有人都收到 room_state event
  await wait(300);
  check('client0 state 有4人', a.state && a.state.players.length === 4);

  // 非房主开局报错
  b.send({ type: C.START_ROUND });
  var err = await b.waitMsg(function (m) { return m.type === S.ERROR; });
  check('非房主报 notOwner', err && err.code === P.ERR.NOT_OWNER, JSON.stringify(err));

  // 房主开局
  a.send({ type: C.START_ROUND });
  var rs = await a.waitMsg(function (m) { return m.type === S.EVENT && m.evt === EVT.ROUND_START; });
  check('round_start 事件到达', !!rs, JSON.stringify(rs));
  await wait(200);
  check('phase=discard', a.state.phase === 'discard', a.state && a.state.phase);
  check('deckRemain=55', a.state.deckRemain === 55, 'got ' + (a.state && a.state.deckRemain));
  check('庄家有 lastDraw', !!a.state.players[a.state.turn].hasLastDraw);

  // 自动跑一局
  var safety = 0;
  var clients = [a, b, c, d];
  function clientOfSeat(s) { return clients.find(function (c) { return c.seat === s; }); }

  while (a.state && a.state.phase !== 'end' && safety++ < 800) {
    var phase = a.state.phase;
    var turn = a.state.turn;
    if (phase === 'discard') {
      var cli = clientOfSeat(turn);
      var st = cli.state;
      var me = st.players[turn];
      if (st.myCanHu) { cli.send({ type: C.HU }); await wait(100); continue; }
      var kongs = st.myKongOptions || [];
      if (kongs.length && Math.random() < 0.3) {
        var k = kongs[0];
        cli.send({ type: C.KONG, kind: k.kind, tile: k.tile });
        await wait(150); continue;
      }
      var hand = me.hand || [];
      var tile = me.lastDraw || hand[0] || null;
      if (!tile) break;
      var preIdx = (tile === me.lastDraw) ? -2 : hand.indexOf(tile);
      cli.send({ type: C.DISCARD, tile: tile, preIdx: preIdx });
      await wait(100);
    } else if (phase === 'claim') {
      // 找所有 myClaim 的客户端
      for (var i = 0; i < 4; i++) {
        var cc = clients[i];
        var mc = cc.state && cc.state.myClaim;
        if (!mc) continue;
        if (mc.robKong) {
          // 抢杠：30% 胡
          if (Math.random() < 0.3) { cc.send({ type: C.HU }); }
          else { cc.send({ type: C.PASS }); }
        } else {
          if (mc.peng && Math.random() < 0.3) { cc.send({ type: C.PENG }); }
          else { cc.send({ type: C.PASS }); }
        }
        await wait(60);
      }
      await wait(150);
    }
  }
  check('一局结束', a.state && a.state.phase === 'end', 'phase=' + (a.state && a.state.phase));
  check('endData 有 winner', a.state.endData && (a.state.endData.winner >= 0 || a.state.endData.draw), JSON.stringify(a.state.endData && { name: a.state.endData.name, winner: a.state.endData.winner }));

  // 守恒
  var sumPts = a.state.players.reduce(function (s, p) { return s + p.points; }, 0);
  check('零和=4000', sumPts === 4000, 'got ' + sumPts);

  // 下一局
  a.send({ type: C.NEXT_ROUND });
  var rs2 = await a.waitMsg(function (m) { return m.type === S.EVENT && m.evt === EVT.ROUND_START; });
  check('下一局 round_start', !!rs2);
  await wait(100);
  check('下一局 phase=discard', a.state.phase === 'discard');

  // 中止
  a.send({ type: C.ABORT_ROUND });
  var ab = await a.waitMsg(function (m) { return m.type === S.EVENT && m.evt === EVT.ROUND_END && m.detail && m.detail.aborted; });
  check('abort 触发 round_end(aborted)', !!ab);
  await wait(100);

  console.log('\n========================================');
  console.log('  ws_smoke_test: ' + pass + ' pass / ' + fail + ' fail');
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('CRASH:', e);
  process.exit(2);
});
