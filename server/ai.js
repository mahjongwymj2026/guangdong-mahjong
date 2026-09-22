// server/ai.js — 机器人AI（从 js/game.js 移植的纯逻辑，无 DOM 依赖）
// 6种性格：保守/普通/激进/贪番/速攻/鬼牌型
// 用于联机版机器人补位：出牌选择 + 碰/杠/过决策
'use strict';

var mj = require('../js/mahjong.js');

var PERSONALITIES = ['保守型', '普通型', '激进型', '贪番型', '速攻型', '鬼牌型'];

function pickPersonality() {
  return PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
}

// 牌留存评分（game.js:1899-1922）——分越高越留，分越低越先打
function tileKeepScore(hand, tile, ghost, style) {
  if (tile === ghost) return 9999;
  var counts = mj.countTiles(hand);
  var c = counts[tile] || 0;
  var score = c * 10;
  if (c >= 2) score += 20;
  if (c >= 3) score += 40;
  var suit = tile[0];
  var num = parseInt(tile.slice(1));
  if (suit === 'W' || suit === 'T' || suit === 'D') {
    for (var d = -2; d <= 2; d++) {
      if (d === 0) continue;
      var nb = suit + (num + d);
      if (counts[nb]) score += 6;
    }
    if (num === 1 || num === 9) score -= 3;
    if (style === '贪番型' && (num === 1 || num === 9)) score += 4;
  } else {
    if (c === 1) score -= 4;
    if (style === '贪番型') score += 5;
  }
  if (style === '速攻型' && suit === 'Z') score -= 6;
  return score;
}

// AI 选牌出牌（game.js:1885-1897）——返回要打出的牌
function aiDiscard(seat, engine, style) {
  var p = engine.players[seat];
  var hand = p.hand;
  var ghost = engine.ghost;
  var scored = hand.map(function (t, idx) {
    return { t: t, idx: idx, score: tileKeepScore(hand, t, ghost, style) };
  });
  scored.sort(function (a, b) { return a.score - b.score; });
  var pick = scored[0];
  if (scored.length > 1 && scored[1].score <= pick.score + 1 && Math.random() < 0.5) pick = scored[1];
  return pick.t;
}

// AI 是否要杠（game.js:1854-1861）——概率决策
function aiWantsKong(style) {
  if (style === '激进型' || style === '速攻型') return Math.random() < 0.9;
  if (style === '贪番型') return Math.random() < 0.7;
  if (style === '鬼牌型') return Math.random() < 0.6;
  if (style === '普通型') return Math.random() < 0.5;
  return Math.random() < 0.3; // 保守型
}

// AI 碰/杠/过决策（game.js:1863-1882）——返回 true=接受, false=过
function aiClaimDecision(claim, style) {
  if (claim.kong) {
    if (style === '激进型' || style === '速攻型') return Math.random() < 0.85;
    if (style === '贪番型') return Math.random() < 0.6;
    if (style === '鬼牌型') return Math.random() < 0.5;
    if (style === '普通型') return Math.random() < 0.45;
    return Math.random() < 0.2;
  }
  if (claim.peng) {
    if (style === '激进型') return Math.random() < 0.8;
    if (style === '速攻型') return Math.random() < 0.7;
    if (style === '贪番型') return Math.random() < 0.3;
    if (style === '鬼牌型') return Math.random() < 0.4;
    if (style === '普通型') return Math.random() < 0.45;
    return Math.random() < 0.2;
  }
  return false;
}

module.exports = {
  PERSONALITIES: PERSONALITIES,
  pickPersonality: pickPersonality,
  tileKeepScore: tileKeepScore,
  aiDiscard: aiDiscard,
  aiWantsKong: aiWantsKong,
  aiClaimDecision: aiClaimDecision
};
