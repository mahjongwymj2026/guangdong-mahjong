const fs = require('fs');
let s = fs.readFileSync('D:/TRAE/WYMJ/js/mahjong.js', 'utf8');
s = s.replace(/^\s*window\.mj\s*=\s*\{[\s\S]*?\};\s*$/m, '');
s = s.replace(/window\.mj\./g, 'MJ.');
const MJ = {};
eval(s);

const NUM = 'WTD';
const num = (s, n) => s + n;
function randTile() {
  const suite = NUM[Math.floor(Math.random() * 3)];
  return suite + (1 + Math.floor(Math.random() * 9));
}
function gost() { return 'D8'; } // ghost = 8筒

function sum(a){return a.length;}

// build a valid winning hand: 4 sets + pair (14 tiles)
function buildWin() {
  const tiles = [];
  const seqs = [[1,2,3]];
  const su = 'WTD'[Math.floor(Math.random()*3)];
  // 3 sequences + 1 pung + pair
  const su2 = 'WTD'[Math.floor(Math.random()*3)];
  for (let s of 'WTD') {
    if (s === su) { const base = 1+Math.floor(Math.random()*7); tiles.push(s+base,s+(base+1),s+(base+2)); }
  }
  // second suite seq
  const bb = 1+Math.floor(Math.random()*7);
  tiles.push(su2+bb, su2+(bb+1), su2+(bb+2));
  // pung in third suite
  const pp = 1+Math.floor(Math.random()*9);
  tiles.push(su2+pp, su2+pp, su2+pp);
  // pair
  const q = 1+Math.floor(Math.random()*9);
  tiles.push(su2+q, su2+q);
  return tiles.sort();
}

let fails = [];
for (let i = 0; i < 300; i++) {
  const win = buildWin();
  // replace one random tile with ghost (should still be winning via wild)
  const idx = Math.floor(Math.random() * win.length);
  const g = gost();
  const hand = win.slice();
  hand[idx] = g;
  // assert
  if (hand.includes(g) && hand.indexOf(g) === hand.lastIndexOf(g)) {
    const ok = checkWin(hand, g, []);
    if (!ok) fails.push({hand: hand.join(','), win: win.join(',')});
  } else {
    // ghost appears in win naturally or twice: skip to keep single-ghost focus
  }
  // attempt variant where ghost replaces nothing needed still
}

// also test with a meld: build 3 sets + pair + meld(west peng), one wild
function buildWinWithMeld() {
  const tiles = [];
  const su = 'WTD'[Math.floor(Math.random()*3)];
  const su2 = 'WTD'[Math.floor(Math.random()*3)];
  for (let s of 'WTD') if (s===su){const b=1+Math.floor(Math.random()*7);tiles.push(s+b,s+b+1,s+b+2);}
  const bb=1+Math.floor(Math.random()*7); tiles.push(su2+bb,su2+bb+1,su2+bb+2);
  const pp=1+Math.floor(Math.random()*9); tiles.push(su2+pp,su2+pp,su2+pp);
  const q=1+Math.floor(Math.random()*9); tiles.push(su2+q,su2+q);
  return tiles.sort(); // 11 tiles
}
let fails2 = [];
for (let i = 0; i < 300; i++) {
  const win = buildWinWithMeld();
  const idx = Math.floor(Math.random() * win.length);
  const g = gost();
  const hand = win.slice();
  hand[idx] = g;
  const melds = [{ tiles: ['WE','WE','WE'], type:'peng' }];
  const ok = checkWin(hand, g, melds);
  if (!ok) fails2.push({hand: hand.join(','), win: win.join(',')});
}

console.log('无副露 单个鬼牌改造 失败数:', fails.length, '/300');
fails.slice(0,3).forEach(f=>console.log('  hand='+f.hand+'  win='+f.win));
console.log('带碰副露 单个鬼牌改造 失败数:', fails2.length, '/300');
fails2.slice(0,3).forEach(f=>console.log('  hand='+f.hand+'  win='+f.win));