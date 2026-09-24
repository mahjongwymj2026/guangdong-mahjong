// server/host_passwords.js — 房主卡密码池
// 设计：纯内存存储，重启清零（管理员登录后点"生成"即可恢复）
// 6 小时过期自动清理已用密码
// 不做重启持久化（Render 免费版硬伤；架构留口子，以后可接 Redis/磁盘）
'use strict';

// ====== 密码生成：10 位，大写+小写+数字，避开易混字符 O I 0 1 ======
const POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function _randPwd() {
  let s = '';
  for (let i = 0; i < 10; i++) {
    s += POOL[Math.floor(Math.random() * POOL.length)];
  }
  return s;
}

// ====== 状态 ======
// available: Map<pwd, {createdAt}>       可用密码
// used:      Map<pwd, {roomId, firstUsedAt, expiresAt}>  已用密码
const available = new Map();
const used = new Map();

// 房主卡有效期：默认 6 小时；可用环境变量 CARD_TTL_MS 覆盖（仅测试用）
const CARD_TTL_MS = (Number(process.env.CARD_TTL_MS) > 0)
  ? Number(process.env.CARD_TTL_MS)
  : 6 * 3600 * 1000;

// ====== 对外 API ======

/** 生成 n 条新密码，返回数组 */
function generate(n) {
  const count = Math.max(1, Math.min(n | 0, 500));
  const out = [];
  const now = Date.now();
  let tries = 0;
  while (out.length < count && tries < count * 10) {
    tries++;
    const p = _randPwd();
    if (available.has(p) || used.has(p)) continue;
    available.set(p, { createdAt: now });
    out.push(p);
  }
  return out;
}

/** 密码是否可用（存在 + 未被标记已用） */
function isAvailable(pwd) {
  if (!pwd || typeof pwd !== 'string') return false;
  return available.has(pwd);
}

/** 标记密码已用，绑定房间号；返回 {ok, cardExpiry, err?} */
function markUsed(pwd, roomId) {
  if (!available.has(pwd)) {
    return { ok: false, err: '密码无效或已使用' };
  }
  available.delete(pwd);
  const now = Date.now();
  const expiry = now + CARD_TTL_MS;
  used.set(pwd, { roomId: roomId, firstUsedAt: now, expiresAt: expiry });
  return { ok: true, cardExpiry: expiry };
}

/** 撤销：把一条已用密码放回可用池（手动操作） */
function revokeUsed(pwd) {
  if (!used.has(pwd)) return false;
  const info = used.get(pwd);
  used.delete(pwd);
  available.set(pwd, { createdAt: info.firstUsedAt });
  return true;
}

/** 清空全部 */
function clearAll() {
  available.clear();
  used.clear();
}

/** 清理过期的已用密码（过期就彻底删除） */
function cleanupExpired() {
  const now = Date.now();
  let removed = 0;
  for (const [pwd, info] of used) {
    if (info.expiresAt <= now) {
      used.delete(pwd);
      removed++;
    }
  }
  return removed;
}

/** 管理员 API 用：返回当前状态快照 */
function getState() {
  // 先清一次过期的
  cleanupExpired();
  const now = Date.now();
  const availList = [];
  for (const [pwd, info] of available) {
    availList.push({ pwd: pwd, createdAt: info.createdAt, createdAtStr: new Date(info.createdAt).toLocaleString('zh-CN', { hour12: false }) });
  }
  const usedList = [];
  for (const [pwd, info] of used) {
    const remainMs = Math.max(0, info.expiresAt - now);
    usedList.push({
      pwd: pwd,
      roomId: info.roomId,
      firstUsedAt: info.firstUsedAt,
      firstUsedAtStr: new Date(info.firstUsedAt).toLocaleString('zh-CN', { hour12: false }),
      expiresAt: info.expiresAt,
      expiresAtStr: new Date(info.expiresAt).toLocaleString('zh-CN', { hour12: false }),
      remainSec: Math.floor(remainMs / 1000)
    });
  }
  return {
    availableCount: availList.length,
    usedCount: usedList.length,
    available: availList,
    used: usedList
  };
}

// ====== 每分钟自动清理过期 ======
setInterval(cleanupExpired, 60 * 1000);

module.exports = {
  generate: generate,
  isAvailable: isAvailable,
  markUsed: markUsed,
  revokeUsed: revokeUsed,
  clearAll: clearAll,
  getState: getState,
  cleanupExpired: cleanupExpired
};
