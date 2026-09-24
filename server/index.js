// server/index.js — 联机服务器入口
// 一个服务同时干两件事：
//   1) Express 托管网页静态文件（首页/牌桌/图片/音效）
//   2) WebSocket（/ws）作为麻将裁判：阶段A ping/pong 自检；阶段B 起接入 RoomManager 房间路由
'use strict';

var path = require('path');
var http = require('http');
var express = require('express');
var { WebSocketServer } = require('ws');

var P = require('./protocol.js');
var C = P.C, S = P.S, ERR = P.ERR;
var { RoomManager } = require('./room.js');
var hp = require('./host_passwords.js');
var adminRouter = require('./admin.js');

var PORT = process.env.PORT || 8080;   // 本机开发用 8080；Render 会注入 PORT
var ROOT = path.join(__dirname, '..');

var app = express();
app.use(express.static(ROOT));
app.use(express.json());  // admin 路由需要解析 JSON body
app.use('/api/admin', adminRouter);  // 管理员 API
app.get('/admin', function(req, res) { res.sendFile(path.join(ROOT, 'admin.html')); });

// 阶段A临时连通自检页（保留不动）
app.get('/online_test', function(req, res) {
  res.send('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>联机连通自检</title></head>'
    + '<body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d3b2e;color:#fff">'
    + '<h2>广东麻将 · 联机服务器</h2>'
    + '<p id="s" style="font-size:20px">正在连接服务器…</p>'
    + '<script>var ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws");'
    + 'ws.onopen=function(){document.getElementById("s").textContent="已连接，通道正常 ✓";'
    + 'document.getElementById("s").style.color="#7CFC9A";ws.send(JSON.stringify({type:"ping"}));};'
    + 'ws.onmessage=function(e){var m=JSON.parse(e.data);if(m.type==="pong"){var p=document.createElement("p");'
    + 'p.textContent="心跳往返正常 ✓ ("+m.t+"ms 前收到)";p.style.color="#7CFC9A";document.body.appendChild(p);}};'
    + 'ws.onclose=function(){document.getElementById("s").textContent="连接已断开 ✗";'
    + 'document.getElementById("s").style.color="#ff8080";};</script>'
    + '</body></html>');
});

// 阶段B：引擎/房间联调测试页
app.get('/engine_test', function(req, res) {
  res.sendFile(path.join(__dirname, 'engine_test.html'));
});

var server = http.createServer(app);

// WebSocket 只挂在 /ws 路径
var wss = new WebSocketServer({ noServer: true });
server.on('upgrade', function(req, socket, head) {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, function(ws) {
    wss.emit('connection', ws, req);
  });
});

// 房间管理器（单例）
var roomMgr = new RoomManager();

// 给每个新 ws 分配一个 sessionId
var sessionCounter = 0;
function newSessionId() {
  sessionCounter++;
  return 'sess_' + Date.now().toString(36) + '_' + sessionCounter;
}

wss.on('connection', function(ws) {
  ws.isAlive = true;
  ws.sessionId = newSessionId();
  console.log('[ws] 新连接 sessionId=' + ws.sessionId + '，当前在线：' + wss.clients.size);

  // hello + sessionId
  ws.send(JSON.stringify({ type: S.HELLO, sessionId: ws.sessionId, msg: 'connected' }));

  ws.on('pong', function() { ws.isAlive = true; });

  ws.on('message', function(raw) {
    // 收到任何应用层消息都视为连接存活（覆盖手机切后台协议层 ping 无法响应的场景）
    ws.isAlive = true;
    var msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) {
      ws.send(JSON.stringify({ type: S.ERROR, code: ERR.BAD_PAYLOAD, msg: 'JSON 解析失败' }));
      return;
    }

    // ping 走老路径，方便 /online_test 自检
    if (msg.type === C.PING) {
      ws.send(JSON.stringify({ type: S.PONG, t: Date.now() % 100000 }));
      return;
    }

    // 校验消息
    var v = P.validateClient(msg);
    if (!v.ok) {
      ws.send(JSON.stringify({ type: S.ERROR, code: v.code, msg: v.msg }));
      return;
    }

    var sid = ws.sessionId;
    var t = msg.type;

    // 房间生命周期消息
    if (t === C.CREATE_ROOM) {
      var pwd = v.value.password;
      // 密码校验
      if (!hp.isAvailable(pwd)) {
        ws.send(JSON.stringify({ type: S.ERROR, code: ERR.ROOM_PWD_INVALID, msg: '房主卡密码无效或已使用' }));
        return;
      }
      var r = roomMgr.createRoom(sid, ws, {
        roomId: v.value.roomId, baseScore: v.value.baseScore,
        initScore: v.value.initScore, name: v.value.name
      });
      if (r.ok) {
        // 标记密码已用，拿 cardExpiry（6 小时过期时间戳）
        var mark = hp.markUsed(pwd, r.roomId);
        var cardExpiry = mark.ok ? mark.cardExpiry : 0;
        // 更新 Room 的 cardExpiry 并启动 6 小时到期定时器
        var room = roomMgr.getRoomOf(sid);
        if (room && cardExpiry) { room.cardExpiry = cardExpiry; room._armExpiry(); }
        ws.send(JSON.stringify({ type: S.ROOM_CREATED, roomId: r.roomId, seat: r.seat, cardExpiry: cardExpiry }));
      } else {
        ws.send(JSON.stringify({ type: S.ERROR, code: r.code, msg: r.msg }));
      }
      return;
    }
    if (t === C.JOIN_ROOM) {
      var j = roomMgr.joinRoom(sid, ws, v.value.roomId, v.value.name);
      if (j.ok) ws.send(JSON.stringify({ type: S.ROOM_JOINED, roomId: j.roomId, seat: j.seat }));
      else ws.send(JSON.stringify({ type: S.ERROR, code: j.code, msg: j.msg }));
      return;
    }
    if (t === C.LEAVE_ROOM) {
      roomMgr.leaveRoom(sid);
      return;
    }
    if (t === C.RECOVER_SESSION) {
      // 阶段D 步骤1：用 localStorage 里的旧 sessionId 恢复座位
      var oldSid = v.value.oldSessionId;
      console.log('[recover] 收到 oldSid=' + oldSid + ' 当前 ws.sessionId=' + sid);
      var entry = roomMgr.sessionRoom.get(oldSid);
      if (!entry) {
        console.log('[recover] 失败: sessionRoom 中无 oldSid');
        ws.send(JSON.stringify({ type: S.ERROR, code: ERR.SESSION_INVALID, msg: '旧会话不存在或已被清理' }));
        return;
      }
      var oldSeat = entry.room.seatOf(oldSid);
      if (oldSeat < 0) {
        console.log('[recover] 失败: oldSid 未绑定座位');
        ws.send(JSON.stringify({ type: S.ERROR, code: ERR.SESSION_INVALID, msg: '旧会话未绑定座位' }));
        return;
      }
      if (entry.room.expired) {
        console.log('[recover] 失败: 房间已到期');
        ws.send(JSON.stringify({ type: S.ERROR, code: ERR.ROOM_EXPIRED, msg: '房间时间已到，房号已失效' }));
        return;
      }
      if (entry.room.seats[oldSeat].connected) {
        console.log('[recover] 失败: 座位 ' + oldSeat + ' 仍在线');
        ws.send(JSON.stringify({ type: S.ERROR, code: ERR.SESSION_INVALID, msg: '会话仍在线，无需恢复' }));
        return;
      }
      // 把当前 ws 的 sessionId 改成旧的 → attachWs 走重连分支
      // 同时把 sessionRoom 里的 key 也迁移过去（删旧 key 用新 key 覆盖）
      roomMgr.sessionRoom.delete(oldSid);
      // 旧 room.seats[oldSeat].sessionId 仍是 oldSid，保持不变，让 attachWs 通过 seatOf 命中
      ws.sessionId = oldSid;
      // 先通知客户端恢复成功（让客户端先拿到 mySeat，再收 room_state/state）
      ws.send(JSON.stringify({ type: S.ROOM_RECOVERED, sessionId: oldSid, roomId: entry.room.roomId, seat: oldSeat }));
      // 再 attachWs（会触发 broadcastRoomUpdate → room_state + state）
      entry.room.attachWs(oldSid, ws, v.value.name);
      roomMgr.sessionRoom.set(oldSid, { room: entry.room, seat: oldSeat });
      console.log('[recover] 成功: 恢复座位 ' + oldSeat + ' 房号 ' + entry.room.roomId);
      return;
    }

    // 房内动作：交给 RoomManager 路由
    var d = roomMgr.dispatch(sid, t, v.value);
    if (!d.ok) {
      ws.send(JSON.stringify({ type: S.ERROR, code: d.code, msg: d.msg }));
    }
    // 成功时房间内部已经 broadcastEvent/broadcastState，无需额外回包
  });

  ws.on('close', function() {
    console.log('[ws] 断开 sessionId=' + ws.sessionId + '，剩余：' + wss.clients.size);
    roomMgr.markDisconnected(ws.sessionId);
  });
});

// 90秒心跳：及时发现手机锁屏/切后台的死连接（阶段E重连托管要用）
// 间隔从 30s → 90s，给手机切后台回微信等短暂切窗口场景更长的缓冲，避免误判断线
setInterval(function() {
  wss.clients.forEach(function(ws) {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 90000);

// 5分钟清理空闲房间
setInterval(function() {
  roomMgr.cleanupIdle();
}, 5 * 60 * 1000);

server.listen(PORT, function() {
  console.log('==========================================');
  console.log('  广东麻将联机服务器已启动');
  console.log('  本机自检：    http://localhost:' + PORT + '/online_test');
  console.log('  引擎联调页：  http://localhost:' + PORT + '/engine_test');
  console.log('  游戏页面：    http://localhost:' + PORT + '/game.html');
  console.log('  联机页面：    http://localhost:' + PORT + '/online.html');
  console.log('==========================================');
});
