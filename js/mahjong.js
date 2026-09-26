// js/mahjong.js — 麻将核心逻辑（浏览器版本）
// 牌类型: W=万, T=条, D=筒, Z=字
// 排序: 筒→条→万→字 (左到右)
var TYPES = [
  'D1','D2','D3','D4','D5','D6','D7','D8','D9',
  'T1','T2','T3','T4','T5','T6','T7','T8','T9',
  'W1','W2','W3','W4','W5','W6','W7','W8','W9',
  'Z1','Z2','Z3','Z4','Z5','Z6','Z7'
];

// 字牌图片名映射
var Z_IMG = { 1:'dong', 2:'nan', 3:'xi', 4:'bei', 5:'zhong', 6:'fa', 7:'bai' };
// 花色图片前缀
var SUIT_IMG = { W:'wan', T:'tiao', D:'tong' };

// 牌码转图片文件名
function tileImage(code) {
  if (!code) return '';
  if (code === 'ghost') return 'ghost';
  var suit = code[0];
  var num = parseInt(code.slice(1));
  if (suit === 'Z') return Z_IMG[num];
  return SUIT_IMG[suit] + num;
}

// 排序手牌
function sortHand(hand) {
  return hand.slice().sort(function (a, b) {
    return TYPES.indexOf(a) - TYPES.indexOf(b);
  });
}

// 统计每种牌的数量
function countTiles(hand) {
  var counts = {};
  hand.forEach(function (t) {
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

// 检查是否胡牌（含鬼牌万能）
// hand: 手牌数组, ghost: 鬼牌代码（可为null）, melds: 副露数组（可选）
function checkWin(hand, ghost, melds) {
  // 特殊胡牌型：十三幺（本游戏规则不允许七对子/七小对）
  if (check13Orphans(hand, ghost)) return true;

  // 如果有 melds，计算副露占用的面子数和张数
  var meldSuitCount = 0; // 已有的面子数（每个碰/杠算 1 个面子）
  if (melds) {
    melds.forEach(function (m) { meldSuitCount++; });
  }

  // 标准胡牌需要 4 个面子 + 1 对将 = 14 张
  // 有 melds 时，hand 需要构成 (4 - meldSuitCount) 个面子 + 将
  // 这部分交由 tryWin 处理，hand 张数已隐含了信息

  var counts = countTiles(hand);
  var tiles = Object.keys(counts);
  var ghostCount = ghost ? (counts[ghost] || 0) : 0;
  
  // 去掉鬼牌，用其余牌判断
  var normalTiles = [];
  tiles.forEach(function (t) {
    if (t !== ghost) {
      for (var i = 0; i < counts[t]; i++) normalTiles.push(t);
    }
  });
  
  // 递归算法依赖"第一个牌最小"，先排序，避免尾张牌（如刚摸的牌）位置错乱导致漏判顺子
  normalTiles = sortHand(normalTiles);
  
  // 尝试用鬼牌补全各种胡牌型
  return tryWin(normalTiles, ghostCount);
}

// 递归尝试胡牌
function tryWin(tiles, ghostCount) {
  if (tiles.length === 0) return ghostCount === 0 || ghostCount === 2; // 全鬼=十三幺特殊
  
  if (tiles.length + ghostCount < 2) return false;
  
  // 尝试将牌+顺子/刻子
  // 枚举所有可能的将牌
  var counts = countTiles(tiles);
  
  // 尝试每种牌做将
  var uniqueTiles = Object.keys(counts);
  for (var i = 0; i < uniqueTiles.length; i++) {
    var t = uniqueTiles[i];
    var c = counts[t];
    
    // 用两张相同的做将
    if (c >= 2) {
      var remaining = removeTiles(tiles, [t, t]);
      if (trySets(remaining, ghostCount)) return true;
    }
    // 用一张+一个鬼牌做将
    if (c >= 1 && ghostCount >= 1) {
      var remaining = removeTiles(tiles, [t]);
      if (trySets(remaining, ghostCount - 1)) return true;
    }
  }
  // 用两个鬼牌做将
  if (ghostCount >= 2) {
    if (trySets(tiles, ghostCount - 2)) return true;
  }
  
  return false;
}

// 尝试把手牌分解成顺子/刻子
// 约定：tiles 已排序，tiles[0] 是最小的真牌（鬼牌已被抽出，缺口用 ghostCount 个鬼补）
// 第一张真牌在面子中可能处于顺子的首/中/末位（鬼补低位时它不是顺子起点）
function trySets(tiles, ghostCount) {
  if (tiles.length === 0) return ghostCount % 3 === 0; // 没真牌时，剩余鬼牌 3 张可自成一刻

  var counts = countTiles(tiles);
  var firstTile = tiles[0];
  var c = counts[firstTile];
  var suit = firstTile[0];
  var num = parseInt(firstTile.slice(1));
  var isNum = (suit === 'W' || suit === 'T' || suit === 'D');

  // 尝试刻子：用 1~3 张真牌 + 鬼补满 3 张
  var maxReal = Math.min(c, 3);
  for (var useReal = maxReal; useReal >= 1; useReal--) {
    var gKong = 3 - useReal;
    if (ghostCount >= gKong) {
      var kongTiles = [];
      for (var ki = 0; ki < useReal; ki++) kongTiles.push(firstTile);
      var remKong = removeTiles(tiles, kongTiles);
      if (trySets(remKong, ghostCount - gKong)) return true;
    }
  }

  // 尝试顺子（只对数牌有效）
  if (isNum) {
    // (1) first 作顺子首位：n, n+1, n+2（缺谁就用鬼补谁）
    if (num <= 7) {
      var t2 = suit + (num + 1);
      var t3 = suit + (num + 2);
      var have2 = counts[t2] > 0;
      var have3 = counts[t3] > 0;
      var g1 = (have2 ? 0 : 1) + (have3 ? 0 : 1);
      if (ghostCount >= g1) {
        var rem1 = removeTiles(tiles, [firstTile]);
        if (have2) rem1 = removeTiles(rem1, [t2]);
        if (have3) rem1 = removeTiles(rem1, [t3]);
        if (trySets(rem1, ghostCount - g1)) return true;
      }
    }
    // (2) first 作顺子中位：n-1(鬼), n, n+1（n+1 可为真牌或鬼）
    //     first 是最小真牌，n-1 不可能在手，必由鬼充当（如 8,9 + 鬼补7）
    if (num >= 2 && num <= 8) {
      var tNext = suit + (num + 1);
      var haveNext = counts[tNext] > 0;
      var g2 = 1 + (haveNext ? 0 : 1);
      if (ghostCount >= g2) {
        var rem2 = removeTiles(tiles, [firstTile]);
        if (haveNext) rem2 = removeTiles(rem2, [tNext]);
        if (trySets(rem2, ghostCount - g2)) return true;
      }
    }
    // (3) first 作顺子末位：n-2(鬼), n-1(鬼), n（两张鬼补低位，如 9 + 鬼7鬼8）
    if (num >= 3 && ghostCount >= 2) {
      var rem3 = removeTiles(tiles, [firstTile]);
      if (trySets(rem3, ghostCount - 2)) return true;
    }
  }

  return false;
}

// 从数组中移除指定牌
function removeTiles(tiles, toRemove) {
  var result = tiles.slice();
  toRemove.forEach(function (t) {
    var idx = result.indexOf(t);
    if (idx >= 0) result.splice(idx, 1);
  });
  return result;
}

// 单吊判定：一手牌能否拆成"完整面子 + 恰好 1 张吊牌"
// 用于尖牌包胡判定（碰牌后单吊自摸才算包胡）
function trySetsOne(tiles, ghostCount) {
  if (tiles.length === 0) return ghostCount === 1;        // 只剩 1 张吊牌(鬼)
  if (ghostCount === 0 && tiles.length === 1) return true; // 只剩 1 张吊牌(真牌)

  var counts = countTiles(tiles);
  var first = tiles[0];
  var c = counts[first];
  var suit = first[0];
  var num = parseInt(first.slice(1));
  var isNum = (suit === 'W' || suit === 'T' || suit === 'D');

  // A) 把 first 留作单吊牌，其余须恰好成套
  if (trySets(removeTiles(tiles, [first]), ghostCount)) return true;

  // B) first 组成刻子：1~3 张真牌 + 鬼补满
  var maxReal = Math.min(c, 3);
  for (var useReal = maxReal; useReal >= 1; useReal--) {
    var gKong = 3 - useReal;
    if (ghostCount >= gKong) {
      var kongTiles = [];
      for (var ki = 0; ki < useReal; ki++) kongTiles.push(first);
      var remKong = removeTiles(tiles, kongTiles);
      if (trySetsOne(remKong, ghostCount - gKong)) return true;
    }
  }

  // C) first 组成顺子（首/中/末位，缺牌用鬼补）
  if (isNum) {
    // 首位：n, n+1, n+2
    if (num <= 7) {
      var t2 = suit + (num + 1);
      var t3 = suit + (num + 2);
      var have2 = counts[t2] > 0;
      var have3 = counts[t3] > 0;
      var g1 = (have2 ? 0 : 1) + (have3 ? 0 : 1);
      if (ghostCount >= g1) {
        var rem1 = removeTiles(tiles, [first]);
        if (have2) rem1 = removeTiles(rem1, [t2]);
        if (have3) rem1 = removeTiles(rem1, [t3]);
        if (trySetsOne(rem1, ghostCount - g1)) return true;
      }
    }
    // 中位：n-1(鬼), n, n+1（n+1 真牌或鬼）
    if (num >= 2 && num <= 8) {
      var tNext = suit + (num + 1);
      var haveNext = counts[tNext] > 0;
      var g2 = 1 + (haveNext ? 0 : 1);
      if (ghostCount >= g2) {
        var rem2 = removeTiles(tiles, [first]);
        if (haveNext) rem2 = removeTiles(rem2, [tNext]);
        if (trySetsOne(rem2, ghostCount - g2)) return true;
      }
    }
    // 末位：n-2(鬼), n-1(鬼), n
    if (num >= 3 && ghostCount >= 2) {
      var rem3 = removeTiles(tiles, [first]);
      if (trySetsOne(rem3, ghostCount - 2)) return true;
    }
  }

  return false;
}

// hand: 完整手牌（含刚摸到的胡牌）, winTile: 刚摸到的那张(做将的吊牌)
// 返回该手牌是否为"单吊自摸"（碰牌单吊包胡的前提）
function isDanDiao(hand, melds, ghost, winTile) {
  if (!winTile) return false;
  // 单吊：必须外面碰/杠满4组（手里只剩1张等摸）；副露不足4组不算尖牌单吊
  if (!melds || melds.length !== 4) return false;
  // 移除刚摸到的那张，得到摸牌前的手牌
  var pre = removeTiles(hand, [winTile]);
  var counts = countTiles(pre);
  var ghostCount = ghost ? (counts[ghost] || 0) : 0;
  var normal = [];
  Object.keys(counts).forEach(function (t) {
    if (t !== ghost) {
      for (var i = 0; i < counts[t]; i++) normal.push(t);
    }
  });
  normal = sortHand(normal);
  return trySetsOne(normal, ghostCount);
}

// 检查十三幺
function check13Orphans(hand, ghost) {
  var terminals = ['W1','W9','T1','T9','D1','D9','Z1','Z2','Z3','Z4','Z5','Z6','Z7'];
  var counts = countTiles(hand);
  var ghostCount = ghost ? (counts[ghost] || 0) : 0;
  
  var needed = [];
  var hasPair = false;
  terminals.forEach(function (t) {
    var c = counts[t] || 0;
    if (t !== ghost) {
      if (c === 0) needed.push(t);
      else if (c >= 2) hasPair = true;
      if (c >= 1) {
        // 有这张幺九牌
      }
    }
  });
  
  // 十三幺：13种幺九牌各一张+其中一种两张
  // 用鬼牌补缺少的
  if (needed.length <= ghostCount) {
    var extraGhost = ghostCount - needed.length;
    if (extraGhost === 0 && hasPair) return true;
    if (extraGhost === 1 && !hasPair) return true; // 鬼牌做将
    if (extraGhost === 1 && hasPair) return true;
  }
  return false;
}

// 检查七对
function checkSevenPairs(hand, ghost) {
  var counts = countTiles(hand);
  var ghostCount = ghost ? (counts[ghost] || 0) : 0;
  var pairs = 0;
  var singles = 0;
  
  Object.keys(counts).forEach(function (t) {
    if (t === ghost) return;
    var c = counts[t];
    pairs += Math.floor(c / 2);
    if (c % 2 === 1) singles++;
  });
  
  // 鬼牌可以补单张成对
  if (singles <= ghostCount && pairs + Math.min(ghostCount, singles) + Math.floor((ghostCount - Math.min(ghostCount, singles)) / 2) >= 7) {
    return true;
  }
  return false;
}

// 检查碰碰胡（全部刻子+将）
function checkAllPungs(hand, ghost) {
  var counts = countTiles(hand);
  var ghostCount = ghost ? (counts[ghost] || 0) : 0;
  var normalTiles = [];
  Object.keys(counts).forEach(function (t) {
    if (t !== ghost) {
      for (var i = 0; i < counts[t]; i++) normalTiles.push(t);
    }
  });
  return tryAllPungs(normalTiles, ghostCount);
}

function tryAllPungs(tiles, ghostCount) {
  if (tiles.length === 0) return ghostCount === 0 || ghostCount === 2;
  
  var counts = countTiles(tiles);
  var firstTile = tiles[0];
  
  // 尝试将牌
  for (var i = 0; i < Object.keys(counts).length; i++) {
    var t = Object.keys(counts)[i];
    var c = counts[t];
    if (c >= 2) {
      var rem = removeTiles(tiles, [t, t]);
      if (tryAllPungsSets(rem, ghostCount)) return true;
    }
    if (c >= 1 && ghostCount >= 1) {
      var rem = removeTiles(tiles, [t]);
      if (tryAllPungsSets(rem, ghostCount - 1)) return true;
    }
  }
  if (ghostCount >= 2) {
    if (tryAllPungsSets(tiles, ghostCount - 2)) return true;
  }
  return false;
}

function tryAllPungsSets(tiles, ghostCount) {
  if (tiles.length === 0) return ghostCount === 0;
  
  var counts = countTiles(tiles);
  var firstTile = tiles[0];
  
  if (counts[firstTile] >= 3) {
    var rem = removeTiles(tiles, [firstTile, firstTile, firstTile]);
    if (tryAllPungsSets(rem, ghostCount)) return true;
  }
  if (counts[firstTile] >= 2 && ghostCount >= 1) {
    var rem = removeTiles(tiles, [firstTile, firstTile]);
    if (tryAllPungsSets(rem, ghostCount - 1)) return true;
  }
  if (counts[firstTile] >= 1 && ghostCount >= 2) {
    var rem = removeTiles(tiles, [firstTile]);
    if (tryAllPungsSets(rem, ghostCount - 2)) return true;
  }
  return false;
}

// 检查清一色
function checkPure(hand, melds, ghost) {
  var suit = null;
  hand.forEach(function (t) {
    if (t === ghost) return;
    var s = t[0];
    if (suit === null) suit = s;
    else if (suit !== s) suit = '__mixed__';
  });
  if (melds) {
    melds.forEach(function (m) {
      m.tiles.forEach(function (t) {
        if (t === ghost) return;
        var s = t[0];
        if (suit === null) suit = s;
        else if (suit !== s) suit = '__mixed__';
      });
    });
  }
  if (suit === '__mixed__' || suit === null) return false;
  // 字牌不能清一色（除非全是同一种字牌）
  return suit === 'W' || suit === 'T' || suit === 'D';
}

// 检查全部是幺九（含 melds）
function checkAllYaojiu(hand, melds, ghost) {
  var allYaojiu = true;
  hand.forEach(function (t) {
    if (t === ghost) return;
    var suit = t[0];
    var num = parseInt(t.slice(1));
    if (suit === 'Z') return; // 字牌算幺九
    if (num !== 1 && num !== 9) allYaojiu = false;
  });
  if (melds) {
    melds.forEach(function (m) {
      m.tiles.forEach(function (t) {
        if (t === ghost) return;
        var suit = t[0];
        var num = parseInt(t.slice(1));
        if (suit === 'Z') return;
        if (num !== 1 && num !== 9) allYaojiu = false;
      });
    });
  }
  return allYaojiu;
}

// 检查全字牌（全翻板）
function checkAllZwords(hand, melds, ghost) {
  var allZ = true;
  hand.forEach(function (t) {
    if (t === ghost) return;
    if (t[0] !== 'Z') allZ = false;
  });
  if (melds) {
    melds.forEach(function (m) {
      m.tiles.forEach(function (t) {
        if (t === ghost) return;
        if (t[0] !== 'Z') allZ = false;
      });
    });
  }
  return allZ;
}

// 计算最佳番型
// 返回 { fan: 番数, name: 番名 }
// 番数 = 该番型在底分1分时的总分（自摸三家付总额）
// 每家应付 = 番数 × 底分 / 3，赢家收 = 番数 × 底分
// 番型优先级（从高到低，与 Excel「各种分」计分表一致）:
// 十三幺48 = 全翻板48 > 幺九牌36 = 清对36 > 清一色24 > 对对糊12 > 普通自摸6
// 特殊规则：碰杠过鬼牌（副露中有鬼牌）的手牌，番型最高只到对对糊
function bestFanEx(hand, melds, ghost, isSelfDraw, isRobKong) {
  // 碰杠过鬼牌 → 鬼牌副露不算清一色/全翻板/字牌等高档番，最高对对糊
  var hasGhostMeld = false;
  if (melds) {
    for (var mi = 0; mi < melds.length; mi++) {
      if (melds[mi].tiles && melds[mi].tiles.indexOf(ghost) >= 0) { hasGhostMeld = true; break; }
    }
  }

  if (!hasGhostMeld) {
    // 十三幺 — 48（最高档，每家应付 16×底分）
    if (check13Orphans(hand, ghost)) {
      return { fan: 48, name: '十三幺' };
    }

    // 全翻板 — 48（全字牌胡牌，与十三幺同档）
    if (checkAllZwords(hand, melds, ghost)) {
      return { fan: 48, name: '全翻板' };
    }

    // 幺九牌 — 36（hand + melds 全部是幺九/字牌，与清对同档）
    if (checkAllYaojiu(hand, melds, ghost)) {
      return { fan: 36, name: '幺九牌' };
    }

    // 清对 = 清一色 + 对对糊 — 36
    if (checkAllPungs(hand, ghost) && checkPure(hand, melds, ghost)) {
      return { fan: 36, name: '清对' };
    }

    // 清一色 — 24
    if (checkPure(hand, melds, ghost)) {
      return { fan: 24, name: '清一色' };
    }
  }

  // 对对糊（全刻子+将）— 12
  if (checkAllPungs(hand, ghost)) {
    return { fan: 12, name: '对对糊' };
  }

  // 基础胡型 — 6：按胡牌方式命名（抢杠胡 / 自摸；规则只允许自摸与抢杠胡）
  if (isRobKong) return { fan: 6, name: '抢杠胡' };
  if (isSelfDraw) return { fan: 6, name: '普通自摸' };
  return { fan: 6, name: '平胡' };
}

// 检查能否碰
function canPeng(hand, tile, ghost) {
  var count = 0;
  hand.forEach(function (t) {
    if (t === tile) count++;
  });
  return count >= 2;
}

// 检查能否杠（明杠/暗杠/公杠）
// 返回数组 [{kind:'mg'|'ag'|'bg', tile: tileCode}]
function checkKongs(hand, lastDraw, ghost) {
  var kongs = [];
  var counts = countTiles(hand);
  
  // 明杠：手中有3张相同+别人打的牌（lastDraw为别人打的牌时）
  // 暗杠：手中有4张相同
  // 公杠：已碰的牌+摸到第4张（lastDraw为刚摸到的牌）
  
  Object.keys(counts).forEach(function (t) {
    // 鬼牌也可杠（按普通杠算钱；但碰杠过鬼牌的手牌番型受限，见 bestFanEx）
    var c = counts[t];
    if (c >= 4) {
      kongs.push({ kind: 'ag', tile: t }); // 暗杠
    }
    if (c >= 3 && lastDraw === t) {
      kongs.push({ kind: 'bg', tile: t }); // 补公杠（已碰+摸到第4张）
    }
  });
  
  // 明杠：别人打出的牌+手里3张（鬼牌也允许明杠）
  if (lastDraw && counts[lastDraw] >= 3) {
    kongs.push({ kind: 'mg', tile: lastDraw });
  }
  
  return kongs;
}

// 生成全牌堆（136张）
function fullDeck() {
  var deck = [];
  var allTiles = [
    'W1','W9','T1','T2','T3','T4','T5','T6','T7','T8','T9',
    'D1','D2','D3','D4','D5','D6','D7','D8','D9',
    'Z1','Z2','Z3','Z4','Z5','Z6','Z7'
  ];
  allTiles.forEach(function (t) {
    for (var i = 0; i < 4; i++) deck.push(t);
  });
  return deck;
}

// 洗牌
function shuffle(deck) {
  var arr = deck.slice();
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// 浏览器与 Node 同构导出：浏览器挂到 window.mj，Node 挂到 module.exports
// （仅改导出，函数实现全不动；game.js 的 window.mj.xxx 调用零回归）
var __mj = {
  TYPES: TYPES,
  Z_IMG: Z_IMG,
  SUIT_IMG: SUIT_IMG,
  tileImage: tileImage,
  sortHand: sortHand,
  countTiles: countTiles,
  checkWin: checkWin,
  check13Orphans: check13Orphans,
  checkSevenPairs: checkSevenPairs,
  checkAllPungs: checkAllPungs,
  checkPure: checkPure,
  checkAllYaojiu: checkAllYaojiu,
  checkAllZwords: checkAllZwords,
  bestFanEx: bestFanEx,
  canPeng: canPeng,
  checkKongs: checkKongs,
  fullDeck: fullDeck,
  shuffle: shuffle,
  isDanDiao: isDanDiao,
  __tryWin: tryWin,
  __trySets: trySets
};
if (typeof module !== 'undefined' && module.exports) module.exports = __mj;
if (typeof window !== 'undefined') window.mj = __mj;
