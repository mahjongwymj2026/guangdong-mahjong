// server/admin.js — 管理员 API 路由
// 所有管理操作都需要先登录拿 token；token 存内存（重启清零无所谓，管理员重登即可）
// 管理员账号密码从 Render 环境变量读，代码里不出现真实值
'use strict';

var express = require('express');
var hp = require('./host_passwords.js');

var router = express.Router();
var SESSION_TTL = 24 * 3600 * 1000; // 24 小时 token 有效期
var tokens = new Map();               // token -> { createdAt }

// ====== 登录接口（不校验 token） ======
router.post('/login', function (req, res) {
  var user = req.body && (req.body.username || req.body.user);
  var pass = req.body && (req.body.password || req.body.pass);
  var expectedUser = process.env.ADMIN_USER || '';
  var expectedPass = process.env.ADMIN_PASS || '';
  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ ok: false, err: '服务器未配置管理员环境变量' });
  }
  if (user !== expectedUser || pass !== expectedPass) {
    return res.status(401).json({ ok: false, err: '账号或密码错误' });
  }
  var token = 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  tokens.set(token, { createdAt: Date.now() });
  res.json({ ok: true, token: token });
});

// ====== 中间件：token 校验 ======
function requireToken(req, res, next) {
  var t = req.headers['x-admin-token'] || (req.body && req.body.token) || (req.query && req.query.token);
  if (!t || !tokens.has(t)) {
    return res.status(401).json({ ok: false, err: '未登录或登录已过期' });
  }
  var info = tokens.get(t);
  if (Date.now() - info.createdAt > SESSION_TTL) {
    tokens.delete(t);
    return res.status(401).json({ ok: false, err: '登录已过期' });
  }
  next();
}

// ====== 登出 ======
router.post('/logout', requireToken, function (req, res) {
  var t = req.headers['x-admin-token'] || (req.body && req.body.token);
  tokens.delete(t);
  res.json({ ok: true });
});

// ====== 获取状态 ======
router.get('/passwords/list', requireToken, function (req, res) {
  res.json({ ok: true, state: hp.getState() });
});

// ====== 生成 n 条新密码 ======
router.post('/passwords/generate', requireToken, function (req, res) {
  var n = (req.body && req.body.count) || 10;
  n = Math.max(1, Math.min(n | 0, 500));
  var list = hp.generate(n);
  res.json({ ok: true, generated: list.length, passwords: list });
});

// ====== 撤销：把已用密码放回可用池 ======
router.post('/passwords/revoke', requireToken, function (req, res) {
  var pwd = req.body && req.body.password;
  if (!pwd) return res.status(400).json({ ok: false, err: '缺少 password' });
  var ok = hp.revokeUsed(pwd);
  res.json({ ok: ok });
});

// ====== 清空全部 ======
router.post('/passwords/clear', requireToken, function (req, res) {
  hp.clearAll();
  res.json({ ok: true });
});

// ====== 每分钟清理过期的 token ======
setInterval(function () {
  var now = Date.now();
  for (var [t, info] of tokens) {
    if (now - info.createdAt > SESSION_TTL) tokens.delete(t);
  }
}, 60 * 1000);

module.exports = router;
