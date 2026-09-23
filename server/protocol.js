// server/protocol.js — WebSocket 消息协议（常量 + 校验 + 错误码）
// 纯函数，无副作用；被 room.js 与 index.js 引用
'use strict';

// ---------- 客户端 → 服务端 消息类型 ----------
var C = {
  PING: 'ping',
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  TAKE_SEAT: 'take_seat',
  START_ROUND: 'start_round',
  DISCARD: 'discard',
  PENG: 'peng',
  KONG: 'kong',
  PASS: 'pass',
  HU: 'hu',
  NEXT_ROUND: 'next_round',
  ABORT_ROUND: 'abort_round',
  RECOVER_SESSION: 'recover_session',
  ADD_BOT: 'add_bot',
  REMOVE_BOT: 'remove_bot'
};

// ---------- 服务端 → 客户端 消息类型 ----------
var S = {
  HELLO: 'hello',
  PONG: 'pong',
  ROOM_CREATED: 'room_created',
  ROOM_JOINED: 'room_joined',
  ROOM_UPDATED: 'room_updated',
  STATE: 'state',
  EVENT: 'event',
  ERROR: 'error',
  ROOM_RECOVERED: 'room_recovered'
};

// ---------- 增量 event 子类型 ----------
var EVT = {
  ROUND_START: 'round_start',
  ROUND_END: 'round_end',
  DRAW: 'draw',
  DISCARD: 'discard',
  PENG: 'peng',
  KONG: 'kong',
  PASS: 'pass',
  HU: 'hu',
  HUANGZHUANG: 'huangzhuang',
  CLAIM_OPTIONS: 'claim_options',
  ROOM_STATE: 'room_state',
  AUTO_ACTION: 'auto_action'        // 阶段D 步骤3：服务端代出/代 pass 提示
};

// ---------- 错误码 ----------
var ERR = {
  NOT_IN_ROOM: 'room.notIn',
  NOT_OWNER: 'room.notOwner',
  ROOM_NOT_FOUND: 'room.notfound',
  ROOM_FULL: 'room.full',
  ROOM_NOT_FULL: 'room.notFull',
  ALREADY_STARTED: 'room.alreadyStarted',
  SEAT_OCCUPIED: 'seat.occupied',
  NOT_YOUR_TURN: 'turn.notYours',
  TILE_NOT_IN_HAND: 'tile.notInHand',
  ACTION_INVALID: 'action.invalid',
  PHASE_WRONG: 'phase.wrong',
  BAD_PAYLOAD: 'payload.bad',
  ROOM_ID_TAKEN: 'room.idTaken',
  SESSION_INVALID: 'session.invalid',
  SEAT_TAKEN_OVER: 'seat.takenOver',
  // 房主卡密码相关
  ROOM_PWD_MISSING: 'room.pwd.missing',
  ROOM_PWD_INVALID: 'room.pwd.invalid',
  ROOM_PWD_USED: 'room.pwd.used'
};

// ---------- payload 校验：返回 {ok:true} 或 {ok:false, code, msg} ----------
function ok(v) { return { ok: true, value: v }; }
function bad(code, msg) { return { ok: false, code: code, msg: msg }; }

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isInt(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0; }
function isTile(t) {
  // 引擎自己会拒绝非法 tile；这里只做粗校验（W1/W9/T1-9/D1-9/Z1-7）
  return typeof t === 'string' && /^[WTD][1-9]$|^Z[1-7]$/.test(t);
}

// 校验客户端入站消息
function validateClient(msg) {
  if (!msg || typeof msg !== 'object') return bad(ERR.BAD_PAYLOAD, '消息必须是对象');
  var t = msg.type;
  if (!isStr(t)) return bad(ERR.BAD_PAYLOAD, '缺少 type');

  switch (t) {
    case C.PING:
      return ok({});
    case C.CREATE_ROOM:
      if (msg.roomId !== undefined && !isStr(msg.roomId)) return bad(ERR.BAD_PAYLOAD, 'roomId 必须是字符串');
      if (msg.baseScore !== undefined && !isInt(msg.baseScore)) return bad(ERR.BAD_PAYLOAD, 'baseScore 必须是正整数');
      if (msg.initScore !== undefined && !isInt(msg.initScore)) return bad(ERR.BAD_PAYLOAD, 'initScore 必须是正整数');
      if (!isStr(msg.password) || msg.password.length > 32) return bad(ERR.ROOM_PWD_MISSING, '缺少房主卡密码');
      return ok({ roomId: msg.roomId, baseScore: msg.baseScore, initScore: msg.initScore, name: msg.name, password: msg.password });
    case C.JOIN_ROOM:
      if (!isStr(msg.roomId)) return bad(ERR.BAD_PAYLOAD, 'roomId 必须是字符串');
      return ok({ roomId: msg.roomId, name: msg.name });
    case C.TAKE_SEAT:
      if (!isInt(msg.seat) || msg.seat > 3) return bad(ERR.BAD_PAYLOAD, 'seat 必须 0-3');
      return ok({ seat: msg.seat });
    case C.DISCARD:
      if (!isTile(msg.tile)) return bad(ERR.BAD_PAYLOAD, 'tile 非法');
      if (msg.preIdx !== undefined && msg.preIdx !== -2 && !isInt(msg.preIdx)) return bad(ERR.BAD_PAYLOAD, 'preIdx 必须 -2/正整数');
      return ok({ tile: msg.tile, preIdx: msg.preIdx });
    case C.KONG:
      if (msg.kind !== 'ag' && msg.kind !== 'bg' && msg.kind !== 'mg') return bad(ERR.BAD_PAYLOAD, 'kind 必须 ag/bg/mg');
      if (!isTile(msg.tile)) return bad(ERR.BAD_PAYLOAD, 'tile 非法');
      return ok({ kind: msg.kind, tile: msg.tile });
    case C.LEAVE_ROOM:
    case C.START_ROUND:
    case C.PENG:
    case C.PASS:
    case C.HU:
    case C.NEXT_ROUND:
    case C.ABORT_ROUND:
    case C.ADD_BOT:
      return ok({});
    case C.REMOVE_BOT:
      if (!isInt(msg.seat) || msg.seat < 0 || msg.seat > 3) return bad(ERR.BAD_PAYLOAD, 'seat 必须 0-3');
      return ok({ seat: msg.seat });
    case C.RECOVER_SESSION:
      if (!isStr(msg.oldSessionId)) return bad(ERR.BAD_PAYLOAD, 'oldSessionId 必须是字符串');
      return ok({ oldSessionId: msg.oldSessionId, name: msg.name });
    default:
      return bad(ERR.BAD_PAYLOAD, '未知消息类型: ' + t);
  }
}

// 生成 6 位房间号
function genRoomId() {
  var s = '';
  for (var i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
  return s;
}

module.exports = {
  C: C, S: S, EVT: EVT, ERR: ERR,
  validateClient: validateClient,
  genRoomId: genRoomId
};
