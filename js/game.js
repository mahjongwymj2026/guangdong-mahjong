// js/game.js — 广东麻将（带鬼牌）主逻辑（浏览器版本）

// 座位：0=自己(下), 1=右家, 2=对家(上), 3=左家
var SEATS = ['你', '右家', '对家', '左家'];
// 速度因子：下标 0 不用，1=慢 2=一般 3=正常 4=快 5=超快
var speedFactor = [1, 4.11, 2.74, 2.4, 2.05, 1.72];
// AI 性格池（6 种，每局给 3 个 AI 随机分配）
var AI_PERSONALITIES = ['保守型', '普通型', '激进型', '贪番型', '速攻型', '鬼牌型'];

// 游戏主对象
var game = {
  players: [],
  phase: 'idle',          // idle | discard | claim | end
  turn: 0,
  ghost: null,           // 鬼牌牌码
  ghostIdx: -1,          // 鬼牌在自己手牌中的位置
  selected: -1,          // 选中的手牌下标
  canHu: false,          // 自己是否可胡
  kongOptions: [],       // [{kind:'ag'|'bg', tile}]
  claim: null,          // {peng,kong,kind,tile,from,hu,robKong}
  claimants: [],        // 可 claim 的座位列表
  claimIdx: 0,
  turnText: '',
  claimedVictims: [],    // 红色高亮牌的座位（被碰杠者）
  claimedCallers: [],    // 红色高亮副露区的座位（碰杠执行者）
  mistVictims: [],       // 红雾：被碰杠者座位（手牌+弃牌+副露整区包裹）
  mistCaller: null,      // 红雾：碰杠执行者 {seat, meldIdx}（仅最新碰杠那组牌）
  showEnd: false,        // 结算弹窗
  endData: null,
  pendingScores: [],     // 杠分暂记 [{seat,score,text}]
  passedClaims: [],      // 同圈放弃：[{seat,tile}] 记录某座位放弃过某张牌（同圈不能再碰）
  roundStartSeat: -1,    // 当前圈起点座位（谁先摸的牌），下次轮到他摸牌时开新圈
  pendingKong: null,     // 杠爆追踪 {payer,payers,kind}
  kongChain: [],         // 杠串：记录本回合连续杠，支持杠上杠 {kind,seat,fromSeat}
  lastClaimForBao: null, // 尖牌包胡追踪 {provider,seat}
  baoFirstDraw: false,   // 碰/明杠当次内部出牌不判定单吊包（保护标志）
  speedLevel: 2,
  baseScore: 3,          // 底分（番数 × 底分）
  scoreHistory: [],
  roundNum: 1,
  deckRemain: 0,
  dealer: 0,             // 庄家
  aiPicks: [],           // 本局 3 个 AI 分配到的性格
  ended: false,
  lastDraw: null,
  lastDrawIndex: -1,  // 刚摸到的牌在手牌中的位置
  deck: [],
  redTimer: null,
  fallbackTimer: null,
  kongResume: null,
  robKongCandidates: null,   // 本次补杠全部可抢杠胡的座位（一炮多响）

  // ---------- 布局编辑 ----------
  editMode: false,
  layoutManager: null,
  zoom: 1,

  // ---------- 初始化 ----------
  init: function() {
    // 从 URL 参数或 localStorage 获取速度
    var urlParams = new URLSearchParams(window.location.search);
    var lvl = parseInt(urlParams.get('speed')) || 2;
    var saved = localStorage.getItem('speedLevel');
    if (saved && !urlParams.get('speed')) lvl = parseInt(saved);
    if (lvl < 1) lvl = 1;
    if (lvl > 5) lvl = 5;
    this.speedLevel = lvl;

    // 底分：首页选择 1~10，URL 参数优先，其次读本地保存，默认 3
    var base = parseInt(urlParams.get('base'));
    if (!(base >= 1 && base <= 10)) base = parseInt(localStorage.getItem('baseScore'));
    if (!(base >= 1 && base <= 10)) base = 3;
    this.baseScore = base;

    // 四家开局分数：URL 参数优先，其次本地保存，默认 1000
    var INIT_OPTIONS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    var initScore = parseInt(urlParams.get('init'));
    if (INIT_OPTIONS.indexOf(initScore) < 0) initScore = parseInt(localStorage.getItem('initScore'));
    if (INIT_OPTIONS.indexOf(initScore) < 0) initScore = 1000;
    this.initScore = initScore;
    this.dealer = 0;
    this.roundNum = 1;
    this.scoreHistory = [];
    
    // 绑定按钮事件
    this.bindEvents();
    
    // 更新速度按钮
    this.updateSpeedButtons();

    // 初始化布局管理器
    this.layoutManager = new LayoutManager();
    this.layoutManager.init();

    // 手机横屏检测（按真实宽高判断，比纯 CSS orientation 更稳）
    this.checkOrientation();
    var self0 = this;
    window.addEventListener('resize', function() { self0.checkOrientation(); });
    window.addEventListener('orientationchange', function() {
      setTimeout(function() { self0.checkOrientation(); }, 200);
    });

    // 禁用所有图片的长按下载/保存菜单（移动端）
    document.addEventListener('contextmenu', function(e) {
      if (e.target.tagName === 'IMG') e.preventDefault();
    });
    document.addEventListener('touchstart', function(e) {
      // 某些浏览器在 touchstart 阶段也能触发长按菜单，加个保险
      if (e.target.tagName === 'IMG') {
        e.target.style.webkitTouchCallout = 'none';
      }
    }, { passive: true });
    
    // 开始第一局
    this.startRound();
  },

  // ---------- 手机横屏检测 ----------
  checkOrientation: function() {
    var ov = document.getElementById('rotateOverlay');
    if (!ov) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    // 手机端（窄边小于 1024）且高度大于宽度 → 竖屏，显示提示
    var isMobile = Math.min(w, h) < 1024;
    var portrait = h > w;
    if (isMobile && portrait) ov.classList.add('show');
    else ov.classList.remove('show');
  },

  // ---------- 绑定事件 ----------
  bindEvents: function() {
    var self = this;
    
    // 操作按钮
    document.getElementById('btnHu').addEventListener('click', function() { self.onHu(); });
    document.getElementById('btnKong').addEventListener('click', function() { self.onKong(); });
    document.getElementById('btnPeng').addEventListener('click', function() { self.onPeng(); });
    document.getElementById('btnPass').addEventListener('click', function() { self.onGuo(); });
    document.getElementById('btnPlay').addEventListener('click', function() { self.onPlaySelected(); });

    // 结算弹窗按钮
    document.getElementById('btnNextRound').addEventListener('click', function() { self.onNextRound(); });
    document.getElementById('btnBackHome').addEventListener('click', function() { self.onBackHome(); });

    // 左上角返回首页按钮
    document.getElementById('btnBackHomeTop').addEventListener('click', function() { self.onBackHome(); });

    // 速度按钮（速度控制已从界面移除，首页选择；保留兼容旧调用）
    document.querySelectorAll('.speed-ctrl .speed-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var lv = parseInt(this.dataset.level);
        self.onSpeedChange(lv);
      });
    });

    // 编辑布局按钮
    document.getElementById('btnEditLayout').addEventListener('click', function() {
      self.toggleEditMode();
    });

    // 编辑模式工具栏按钮
    document.getElementById('btnSaveLayout').addEventListener('click', function() {
      self.saveLayout();
    });
    document.getElementById('btnResetLayout').addEventListener('click', function() {
      self.resetLayout();
    });
    document.getElementById('btnExitEdit').addEventListener('click', function() {
      self.exitEditMode();
    });

    // 缩放按钮
    document.getElementById('btnZoomIn').addEventListener('click', function() {
      self.zoomIn();
    });
    document.getElementById('btnZoomOut').addEventListener('click', function() {
      self.zoomOut();
    });
    document.getElementById('btnResetZoom').addEventListener('click', function() {
      self.resetZoom();
    });
  },

  // ---------- 速度 ----------
  aiDelay: function() {
    return (speedFactor[this.speedLevel] || 2.74) * 1000;
  },

  onSpeedChange: function(lv) {
    if (lv < 1) lv = 1;
    if (lv > 5) lv = 5;
    this.speedLevel = lv;
    localStorage.setItem('speedLevel', lv);
    this.updateSpeedButtons();
  },

  updateSpeedButtons: function() {
    document.querySelectorAll('.speed-ctrl .speed-btn').forEach(function(btn) {
      var lv = parseInt(btn.dataset.level);
      if (lv === game.speedLevel) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  },

  // ---------- 开局 ----------
  startRound: function() {
    this.clearTimers();
    this.ended = false;
    this.lastDraw = null;
    this.lastDrawIndex = -1;
    this.claim = null;
    this.claimants = [];
    this.claimIdx = 0;
    this.claimedVictims = [];
    this.claimedCallers = [];
    this.mistVictims = [];
    this.mistCaller = null;
    this.pendingScores = [];
    this.passedClaims = [];
    this.roundStartSeat = -1;
    this.pendingKong = null;
    this.kongChain = [];
    this.lastClaimForBao = null;
    this.baoFirstDraw = false;
    this.robClaim = null;
    this.kongResume = null;
    this.robKongCandidates = null;

    // 保留积分（首局用首页选择的开局分数）
    var startPts = this.initScore || 1000;
    var oldPts = [startPts, startPts, startPts, startPts];
    if (this.players && this.players.length === 4) {
      oldPts = this.players.map(function(p) { return p ? p.points : startPts; });
    }
    this.players = SEATS.map(function(name, i) {
      return { name: name, points: oldPts[i], hand: [], melds: [], disp: [], victim: false, meldVictim: false };
    });

    // 洗牌发牌
    this.deck = window.mj.shuffle(window.mj.fullDeck());
    for (var i = 0; i < 4; i++) {
      this.players[i].hand = this.deck.splice(0, 13);
    }
    // 庄家多摸一张（14 张，先出牌）
    this.players[this.dealer].hand.push(this.deck.shift());

    // 鬼牌：从实际存在的牌里抽（本玩法万只有1和9，无2~8万）
    var GHOST_TYPES = ['W1','W9',
      'T1','T2','T3','T4','T5','T6','T7','T8','T9',
      'D1','D2','D3','D4','D5','D6','D7','D8','D9',
      'Z1','Z2','Z3','Z4','Z5','Z6','Z7'];
    this.ghost = GHOST_TYPES[Math.floor(Math.random() * GHOST_TYPES.length)];

    // 排序
    for (var j = 0; j < 4; j++) {
      this.players[j].hand = window.mj.sortHand(this.players[j].hand);
    }
    // 庄家多摸的那张：自己坐庄时单独放最右边（与正常摸牌同规则，判胡/杠时再并入）
    this.lastDraw = null;
    this.lastDrawIndex = -1;
    this.passedOptions = false;
    if (this.dealer === 0) {
      var lastTile = this.players[0].hand[this.players[0].hand.length - 1];
      this.players[0].hand.splice(this.players[0].hand.length - 1, 1);
      this.lastDraw = lastTile;
    }
    this.ghostIdx = this.players[0].hand.indexOf(this.ghost);

    // 给 3 个 AI 随机分配性格
    this.aiPicks = [0, 1, 2].map(function() {
      return AI_PERSONALITIES[Math.floor(Math.random() * AI_PERSONALITIES.length)];
    });

    // 起手有鬼牌 → 闪电（仅自己；含庄家单独放最右的那张）
    if (this.ghostIdx >= 0 || this.lastDraw === this.ghost) this.triggerLightning();

    this.turn = this.dealer;
    this.phase = 'discard';
    this.showEnd = false;
    
    // 隐藏结算弹窗
    document.getElementById('endModal').style.display = 'none';
    
    // 更新局数
    document.getElementById('roundInfo').textContent = '第 ' + this.roundNum + ' 局';
    
    // 更新鬼牌显示
    this.updateGhostDisplay();
    
    // 更新 AI 性格显示
    this.updateAiStyles();
    
    this.render();
    if (this.turn === 0) this.playerTurn();
    else this.aiTurn(this.turn);
  },

  // ---------- 更新鬼牌显示 ----------
  updateGhostDisplay: function() {
    if (this.ghost) {
      var img = document.getElementById('ghostImg');
      img.onerror = function() {
        this.onerror = null;
        console.warn('鬼牌图片加载失败:', this.src);
      };
      img.src = 'images/' + window.mj.tileImage(this.ghost) + '.png';
      document.getElementById('ghostDisplay').style.display = 'block';
    }
  },

  // ---------- 更新 AI 性格显示 ----------
  updateAiStyles: function() {
    for (var i = 1; i <= 3; i++) {
      var el = document.getElementById('seat' + i + 'Style');
      if (el && this.aiPicks[i - 1]) {
        el.textContent = this.aiPicks[i - 1];
        el.style.display = 'inline';
      }
    }
  },

  // ---------- 渲染 ----------
  render: function() {
    var self = this;
    
    // 更新各座位积分
    for (var i = 0; i < 4; i++) {
      var p = this.players[i];
      var pointsEl = document.getElementById('seat' + i + 'Points');
      if (pointsEl) pointsEl.textContent = p.points;
    }
    
    // 更新剩余牌数
    var remain = this.deck ? this.deck.length : 0;
    document.getElementById('deckInfo').textContent = '剩 ' + remain + ' 张';
    
    // 渲染自己的手牌
    this.renderMyHand();
    
    // 渲染自己的副露
    this.renderMyMelds();
    
    // 渲染自己的弃牌
    this.renderPond(0, 'myPond');
    
    // 渲染对家
    this.renderAiHand(2, 'topHand', 'horizontal');
    this.renderAiMelds(2, 'topMelds', 'horizontal');
    this.renderPond(2, 'topPond');
    
    // 渲染左家
    this.renderAiHand(3, 'leftHand', 'vertical');
    this.renderAiMelds(3, 'leftMelds', 'vertical');
    this.renderPond(3, 'leftPond');
    
    // 渲染右家
    this.renderAiHand(1, 'rightHand', 'vertical');
    this.renderAiMelds(1, 'rightMelds', 'vertical');
    this.renderPond(1, 'rightPond');
    
    // 更新红色高亮状态
    this.updateVictimHighlight();
    // 更新碰杠红雾
    this.updateMist();
    
    // 更新回合信息
    document.getElementById('turnInfo').textContent = this.turnText || '';
    
    // 每次重画屏幕都刷新按钮栏，确保非己方回合时按钮熄灭/禁用
    this.updateActionBar();
    this.updateTipLine();
  },

  // ---------- 渲染自己的手牌 ----------
  renderMyHand: function() {
    var hand = this.players[0].hand;
    var ghost = this.ghost;
    var selected = this.selected;
    var el = document.getElementById('myHand');
    var html = '';
    
    for (var i = 0; i < hand.length; i++) {
      var t = hand[i];
      var imgName = window.mj.tileImage(t);
      var isGhost = t === ghost;
      var isSel = i === selected;
      var classes = 'hand-tile';
      if (isGhost) classes += ' ghost-tile';
      if (isSel) classes += ' selected';
      html += '<div class="' + classes + '" data-idx="' + i + '" data-tile="' + t + '">';
      html += '<img src="images/' + imgName + '.png" class="mj mj-own" alt="">';
      if (isGhost) html += '<span class="ghost-badge">鬼</span>';
      html += '</div>';
    }

    // 新摸的牌：单独放在最右边，不进牌堆
    if (this.lastDraw && this.turn === 0) {
      var imgName2 = window.mj.tileImage(this.lastDraw);
      var isGhost2 = this.lastDraw === ghost;
      var classes2 = 'hand-tile last-draw';
      if (isGhost2) classes2 += ' ghost-tile';
      if (selected === -2) classes2 += ' selected';
      html += '<div class="' + classes2 + '" data-idx="-2" data-tile="' + this.lastDraw + '">';
      html += '<img src="images/' + imgName2 + '.png" class="mj mj-own" alt="">';
      if (isGhost2) html += '<span class="ghost-badge">鬼</span>';
      html += '</div>';
    }
    el.innerHTML = html;
    
    // 绑定点击事件
    var self = this;
    el.querySelectorAll('.hand-tile').forEach(function(tile) {
      tile.addEventListener('click', function() {
        var idx = parseInt(this.dataset.idx);
        self.onSelectTile(idx);
      });
    });

    // 不是自己回合时，手牌变灰
    var handEl = document.getElementById('myHand');
    if (this.turn === 0 && this.phase === 'discard') {
      handEl.classList.remove('not-my-turn');
    } else {
      handEl.classList.add('not-my-turn');
    }
  },

  // ---------- 渲染自己的副露 ----------
  renderMyMelds: function() {
    var melds = this.players[0].melds;
    var el = document.getElementById('myMelds');
    if (melds.length === 0) {
      el.innerHTML = '';
      el.classList.remove('warn3');
      el.style.setProperty('display', 'none', 'important');
      return;
    }
    el.style.removeProperty('display');
    // 九张警示：碰/杠满3组即亮，四家屏幕都看得到（含自己），持续到本局结束
    el.classList.toggle('warn3', melds.length >= 3);
    var html = '';
    for (var i = 0; i < melds.length; i++) {
      var m = melds[i];
      var label = this._meldLabel(m);
      var arrow = this._meldArrow(0, m);
      html += '<div class="meld meld-wrap">';
      // 自己的副露：箭头塞进 label 里，跟字一起左上角横向排列
      // （对家/左右家的 renderAiMelds 不动，保持箭头独立贴在牌边上）
      if (label || arrow) {
        html += '<div class="m-label my-m-label">';
        if (label) html += '<span class="ml-text">' + label + '</span>';
        if (arrow) html += '<span class="ml-arrow ' + arrow + '"></span>';
        html += '</div>';
      }
      html += '<div class="tiles-row">';
      for (var j = 0; j < m.tiles.length; j++) {
        var imgName = window.mj.tileImage(m.tiles[j]);
        html += '<img src="images/' + imgName + '.png" class="mj" alt="">';
      }
      html += '</div>';
      html += '</div>';
    }
    if (melds.length >= 3) html += '<span class="warn3-tag">九张</span>';
    el.innerHTML = html;
  },

  // 副露上的文字标签
  _meldLabel: function(m) {
    if (m.kind === 'ag') return '暗杠';
    if (m.kind === 'mg') return '明杠';
    if (m.kind === 'bg') return '公杠';
    if (m.kind === 'peng') return '碰';
    return '';
  },

  // 三角形方向：seat=持有者位置，m.from=放牌者位置
  // 玩家(0)副露：右(1)→右、对(2)→上、左(3)→左
  // 右家(1)副露：玩家(0)→下、对(2)→上、左(3)→左
  // 对家(2)副露：玩家(0)→下、右(1)→右、左(3)→左
  // 左家(3)副露：玩家(0)→下、右(1)→右、对家(2)→上
  _meldArrow: function(seat, m) {
    if (m.from == null) return '';
    var dir;
    switch (seat) {
      case 0: dir = [null, 'right', 'top', 'left'][m.from]; break;
      case 1: dir = ['bottom', null, 'top', 'left'][m.from]; break;
      case 2: dir = ['bottom', 'right', null, 'left'][m.from]; break;
      case 3: dir = ['bottom', 'right', 'top', null][m.from]; break;
    }
    return dir ? 'm-arrow-' + dir : '';
  },

  // ---------- 渲染弃牌区 ----------
  renderPond: function(seat, elId) {
    var disp = this.players[seat].disp;
    var el = document.getElementById(elId);
    var html = '';
    for (var i = 0; i < disp.length; i++) {
      var imgName = window.mj.tileImage(disp[i]);
      html += '<img src="images/' + imgName + '.png" class="mj" data-tile="' + disp[i] + '" alt="">';
    }
    el.innerHTML = html;
  },

  // ---------- 渲染 AI 手牌（背面）----------
  renderAiHand: function(seat, elId, direction) {
    var hand = this.players[seat].hand;
    var el = document.getElementById(elId);
    var html = '';
    for (var i = 0; i < hand.length; i++) {
      html += '<div class="mj-back"></div>';
    }
    el.innerHTML = html;
  },

  // ---------- 渲染 AI 副露 ----------
  renderAiMelds: function(seat, elId, direction) {
    var melds = this.players[seat].melds;
    var el = document.getElementById(elId);
    if (melds.length === 0) {
      // 新局副露已清空：必须同时清掉上一局残留图片；并加 important 压过 CSS 类
      // （.my-melds/.top-melds 带 display:flex/grid !important，普通内联 none 会被覆盖导致旧副露仍显示）
      el.innerHTML = '';
      el.classList.remove('warn3');
      el.style.setProperty('display', 'none', 'important');
      return;
    }
    el.style.removeProperty('display');
    // 九张警示：碰/杠满3组即亮（亮给别家看），本局内只增不减、持续到结束，新局自动清除
    var warn3 = melds.length >= 3;
    el.classList.toggle('warn3', warn3);
    var html = '';
    for (var i = 0; i < melds.length; i++) {
      var m = melds[i];
      var label = this._meldLabel(m);
      var arrow = this._meldArrow(seat, m);
      var isVert = direction === 'vertical';
      var meldClass = 'meld meld-wrap' + (isVert ? ' meld-v' : '');
      html += '<div class="' + meldClass + '">';
      if (arrow) html += '<div class="m-arrow ' + arrow + '"></div>';
      if (label) html += '<div class="m-label">' + label + '</div>';
      html += '<div class="tiles-row">';
      for (var j = 0; j < m.tiles.length; j++) {
        var imgName = window.mj.tileImage(m.tiles[j]);
        html += '<img src="images/' + imgName + '.png" class="mj" alt="">';
      }
      html += '</div>';
      html += '</div>';
    }
    if (warn3) html += '<span class="warn3-tag">九张</span>';
    el.innerHTML = html;
  },

  // ---------- 红色高亮 ----------
  updateVictimHighlight: function() {
    // 手牌高亮（被碰杠者）
    var handEls = {
      0: 'myHand',
      1: 'rightHand',
      2: 'topHand',
      3: 'leftHand'
    };
    for (var i = 0; i < 4; i++) {
      var el = document.getElementById(handEls[i]);
      if (el) {
        if (this.claimedVictims.indexOf(i) >= 0) {
          el.classList.add('hand-victim');
        } else {
          el.classList.remove('hand-victim');
        }
      }
    }
    
    // 副露高亮（碰杠执行者）
    var meldEls = {
      0: 'myMelds',
      1: 'rightMelds',
      2: 'topMelds',
      3: 'leftMelds'
    };
    for (var j = 0; j < 4; j++) {
      var meldEl = document.getElementById(meldEls[j]);
      if (meldEl) {
        if (this.claimedCallers.indexOf(j) >= 0) {
          meldEl.classList.add('hand-victim');
        } else {
          meldEl.classList.remove('hand-victim');
        }
      }
    }
  },

  // ---------- 碰杠红雾 ----------
  // victims：被碰杠者座位数组，手牌+弃牌+副露整区红雾包裹
  // caller：{seat, meldIdx} 碰杠执行者及其副露组下标，仅该组牌红雾
  setMist: function(victims, caller) {
    this.mistVictims = victims.slice();
    this.mistCaller = caller ? { seat: caller.seat, meldIdx: caller.meldIdx } : null;
    this.updateMist();
  },
  clearMist: function() {
    this.mistVictims = [];
    this.mistCaller = null;
    this.updateMist();
  },
  updateMist: function() {
    var handEls = { 0: 'myHand', 1: 'rightHand', 2: 'topHand', 3: 'leftHand' };
    var pondEls = { 0: 'myPond', 1: 'rightPond', 2: 'topPond', 3: 'leftPond' };
    var meldEls = { 0: 'myMelds', 1: 'rightMelds', 2: 'topMelds', 3: 'leftMelds' };
    for (var i = 0; i < 4; i++) {
      var isVictim = this.mistVictims.indexOf(i) >= 0;
      var hEl = document.getElementById(handEls[i]);
      if (hEl) hEl.classList.toggle('mist-area', isVictim);
      var pEl = document.getElementById(pondEls[i]);
      if (pEl) pEl.classList.toggle('mist-area', isVictim);
      var mEl = document.getElementById(meldEls[i]);
      if (mEl) {
        mEl.classList.toggle('mist-area', isVictim);
        var groups = mEl.querySelectorAll('.meld');
        for (var g = 0; g < groups.length; g++) groups[g].classList.remove('mist-meld');
        if (this.mistCaller && this.mistCaller.seat === i) {
          var idx = this.mistCaller.meldIdx;
          if (groups[idx]) groups[idx].classList.add('mist-meld');
        }
      }
    }
  },

  // ---------- 某座位实际持有的牌 ----------
  // 自己（0号位）刚摸的牌单独放在最右、不在 hand 数组里，判胡/杠/碰时必须并入。
  // 注意：不能用 indexOf 去重——手里可能本来就有一张相同的牌（如两张鬼），
  // 去重会把新摸的那张漏掉，导致少算一张牌、该胡判成不能胡。
  evalHandFor: function(seat) {
    var h = this.players[seat].hand.slice();
    if (seat === 0 && this.lastDraw) h.push(this.lastDraw);
    return h;
  },

  // ---------- 玩家回合 ----------
  playerTurn: function(skipHuCheck) {
    var p = this.players[0];
    // 自摸胡判断需包含单独放最右边的新牌
    var evalHand = this.evalHandFor(0);
    var canHu = skipHuCheck ? false : window.mj.checkWin(evalHand, this.ghost, this.players[0].melds);
    var kongs = this.selfKongsFor(0);
    this.canHu = canHu;
    this.kongOptions = kongs;
    // 每次新进入自己的回合（新摸牌/碰杠后），"过"掉胡杠的状态重置
    this.passedOptions = false;
    this.updateDebug(p, evalHand, canHu);
    // 单吊包窗口：自我摸牌且未胡 → 清掉包胡标志（当次内部出牌保护）
    if (!canHu && this.lastClaimForBao && this.lastClaimForBao.seat === 0) {
      if (this.baoFirstDraw) this.baoFirstDraw = false;
      else this.lastClaimForBao = null;
    }
    this.phase = 'discard';
    this.selected = -1;
    this.turnText = '轮到你出牌';
    
    this.updateActionBar();
    this.updateTipLine();
    
    // 紧张红：可胡或有公杠
    if (canHu || kongs.some(function(k) { return k.kind === 'bg'; })) {
      this.setClaimedVictims([1, 2, 3], []);
    } else {
      this.render();
    }
  },

  // ---------- 调试：显示当前判定用的牌码 ----------
  updateDebug: function(p, evalHand, canHu) {
    var dbg = document.getElementById('dbg');
    if (!dbg) return;
    var CN = { W: '万', T: '条', D: '筒', Z1: '东', Z2: '南', Z3: '西', Z4: '北', Z5: '中', Z6: '发', Z7: '白' };
    var t2s = function(code) {
      if (!code) return '-';
      var s = code[0];
      if (s === 'Z') return CN[code];
      return ({ W: '万', T: '条', D: '筒' })[s] + code.slice(1);
    };
    var meldTxt = (p.melds || []).map(function(m) {
      return '[' + m.type + ']' + m.tiles.map(t2s).join('');
    }).join(' ');
    var drawTxt = this.lastDraw ? t2s(this.lastDraw) : '-';
    dbg.textContent = '判胡=' + (canHu ? '✅能胡' : '❌不能胡')
      + '  鬼=' + t2s(this.ghost)
      + '  张数=' + evalHand.length + '（手）+' + ((p.melds||[]).reduce(function(s,m){return s+m.tiles.length;},0)) + '（副露）'
      + '\n刚摸=' + drawTxt
      + '\n手牌：' + evalHand.map(t2s).join(' ')
      + '\n副露：' + (meldTxt || '无');
  },

  // ---------- 更新操作按钮 ----------
  updateActionBar: function() {
    var bar = document.getElementById('actionBar');
    var btnHu = document.getElementById('btnHu');
    var btnKong = document.getElementById('btnKong');
    var btnPeng = document.getElementById('btnPeng');
    var btnPass = document.getElementById('btnPass');
    var btnPlay = document.getElementById('btnPlay');

    // 始终显示一行按钮，可用操作亮色、不可用灰色
    var hu = false, kong = false, peng = false, pass = false, play = false;
    if (this.phase === 'discard' && this.turn === 0) {
      // 自己出牌回合：能胡/能杠不用选牌就立刻亮；点"过"可放弃本次胡杠
      var hasOption = this.canHu || this.kongOptions.length > 0;
      var opted = !this.passedOptions;
      hu = !!this.canHu && opted;
      kong = this.kongOptions.length > 0 && opted;
      pass = hasOption && opted;
      // 选中一张手牌（含刚摸的单独牌）后，打出按钮才亮
      play = this.selected !== -1;
    } else if (this.phase === 'claim') {
      hu = !!(this.claim && this.claim.hu);
      kong = !!(this.claim && this.claim.kong);
      peng = !!(this.claim && this.claim.peng);
      pass = true;
    }
    bar.style.display = 'flex';
    btnHu.disabled = !hu;
    btnKong.disabled = !kong;
    btnPeng.disabled = !peng;
    btnPass.disabled = !pass;
    btnPlay.disabled = !play;
    // 可打出时加金色发光提示（用 add/remove，兼容无 toggle 的环境）
    if (play) btnPlay.classList.add('lit');
    else btnPlay.classList.remove('lit');
  },

  // ---------- 更新提示文字（按钮区小提示已按要求移除，始终隐藏） ----------
  updateTipLine: function() {
    var tipLine = document.getElementById('tipLine');
    if (tipLine) tipLine.style.display = 'none';
  },

  // ---------- AI 回合 ----------
  aiTurn: function(seat, skipHuCheck) {
    this.turn = seat;
    this.turnText = SEATS[seat] + '思考中…';
    this.render();
    var self = this;
    setTimeout(function() {
      if (self.ended) return;
      var p = self.players[seat];
      // 可胡则胡（碰/杠后出牌阶段跳过胡检查）
      if (!skipHuCheck && window.mj.checkWin(p.hand, self.ghost, p.melds)) {
        self.endRound(seat, { isSelfDraw: true });
        return;
      }
      // 单吊包窗口：AI 自我摸牌且未胡 → 清掉包胡标志（当次内部出牌保护）
      if (self.lastClaimForBao && self.lastClaimForBao.seat === seat) {
        if (self.baoFirstDraw) self.baoFirstDraw = false;
        else self.lastClaimForBao = null;
      }
      // 可杠（暗杠/公杠）
      var kongs = self.selfKongsFor(seat);
      if (kongs.length > 0 && self.aiWantsKong(seat)) {
        var k = kongs[0];
        self.doKong(seat, k.kind, k.tile, null);
        return;
      }
      // 出牌
      var tile = self.aiDiscard(seat);
      self.doDiscard(seat, tile);
    }, this.aiDelay());
  },

  // ---------- 自己可杠选项（暗杠/公杠）----------
  selfKongsFor: function(seat) {
    var p = this.players[seat];
    // 自己摸的牌单独放最右，暗杠判断需并入
    var fullHand = this.evalHandFor(seat);
    var kongs = window.mj.checkKongs(fullHand, this.lastDraw, this.ghost).filter(function(k) {
      return k.kind === 'ag';
    });
    // 公杠：已碰的牌 + 刚摸到第 4 张
    if (this.lastDraw && this.lastDraw !== this.ghost) {
      var hasPeng = p.melds.some(function(m) { return m.type === 'peng' && m.tiles[0] === this.lastDraw; }, this);
      if (hasPeng) kongs.push({ kind: 'bg', tile: this.lastDraw });
    }
    return kongs;
  },

  // ---------- 下一回合 ----------
  nextTurn: function() {
    if (this.ended) return;
    this.turn = (this.turn + 1) % 4;
    if (this.deck.length === 0) {
      this.huangzhuang();
      return;
    }
    // 谁先摸牌就是本圈起点；下次轮到他时开新圈，清同圈放弃记录
    if (this.roundStartSeat === -1) {
      this.roundStartSeat = this.turn;
    } else if (this.turn === this.roundStartSeat) {
      // 绕了一圈回来了，开新圈
      this.passedClaims = [];
    }
    // 进入下一回合：清掉 claim 窗口状态、重置阶段、刷新按钮熄灭
    this.phase = 'discard';
    this.claim = null;
    this.claimants = [];
    this.claimIdx = 0;
    this.lastDraw = this.drawTile(this.turn);
    this.render();
    this.updateActionBar();
    this.updateTipLine();
    if (this.turn === 0) this.playerTurn();
    else this.aiTurn(this.turn);
  },

  // 荒庄
  huangzhuang: function() {
    this.ended = true;
    // 荒庄：所有分数不计，包括杠分（pendingScores 不并入积分，下局 startRound 会清空）
    var scores = [0, 0, 0, 0];

    this.endData = {
      winner: -1, draw: true, name: '荒庄', ghost: this.ghost,
      scores: scores,
      points: this.players.map(function(pl) { return pl.points; }),
      hands: this.players.map(function(pl, i) { return this.evalHandFor(i); }.bind(this)),
      melds: this.players.map(function(pl) { return pl.melds.slice(); }),
      pendingScores: []
    };
    this.scoreHistory.push({ round: this.roundNum, winner: -1, name: '荒庄', scores: scores });
    this.showEndModal();
    this.phase = 'end';
  },

  // ---------- 摸牌 ----------
  drawTile: function(seat) {
    if (this.deck.length === 0) return null;
    var t = this.deck.shift();
    this.players[seat].hand.push(t);
    this.players[seat].hand = window.mj.sortHand(this.players[seat].hand);
    this.players[seat]._lastDraw = t;   // 记录本家刚摸的牌（结算自摸特效用）
    this.lastDrawIndex = -1;
    // 自己摸的牌：不进牌堆，单独放最右边
    if (seat === 0) {
      var idx = this.players[0].hand.lastIndexOf(t);
      if (idx >= 0) this.players[0].hand.splice(idx, 1);
    }
    if (t === this.ghost && seat === 0) this.triggerLightning();
    return t;
  },

  // ---------- 出牌 ----------
  onPlaySelected: function() {
    if (this.phase !== 'discard') return;
    if (this.turn !== 0) return; // 不是自己的回合
    if (this.selected === -2) {
      // 选中的是新摸的单独牌
      this.onPlayLastDraw();
      return;
    }
    if (this.selected < 0) return;
    var idx = this.selected;
    var tile = this.players[0].hand[idx];
    if (!tile) return;
    this.selected = -1;
    this.doDiscard(0, tile, idx);
  },

  doDiscard: function(seat, tile, preIdx) {
    this.clearRed();
    var p = this.players[seat];
    var idx = (typeof preIdx === 'number' && preIdx >= 0 && preIdx < p.hand.length)
      ? preIdx : p.hand.indexOf(tile);
    if (seat === 0) {
      if (idx >= 0) {
        // 打出旧牌堆中的牌：把单独的新牌并回手牌堆，保持正确张数
        p.hand.splice(idx, 1);
        if (this.lastDraw) p.hand.push(this.lastDraw);
      }
      // 打出的是新牌（不在手牌堆）：直接从 lastDraw 清空
      this.lastDraw = null;
      this.lastDrawIndex = -1;
      p.hand = window.mj.sortHand(p.hand);
    } else {
      if (idx >= 0) p.hand.splice(idx, 1);
      p.hand = window.mj.sortHand(p.hand);
      // AI 打牌后也必须清 lastDraw——evalHandFor(seat) 会把 lastDraw 算入玩家手牌，
      // 如果 AI 的 lastDraw 残留到 getClaimants 阶段，会让 canPeng/canHu 误判多一张牌
      this.lastDraw = null;
      this.lastDrawIndex = -1;
    }
    this.afterDiscard(seat, tile);
  },

  afterDiscard: function(seat, tile) {
    var p = this.players[seat];
    p.disp.push(tile);
    window.snd.tile(tile);
    // 碰杠家出牌：红雾窗口结束（若这张出牌又被碰/杠，doPeng/doKong 会立刻重新起雾）
    this.clearMist();
    // 清理杠爆/包胡追踪窗口（出牌后失效）
    this.pendingKong = null;
    this.kongChain = [];
    // 注：单吊包胡的 lastClaimForBao 不在出牌时清，需保留到判定单吊那一刻，
    //     由 playerTurn/aiTurn 在自我摸牌未胡时清掉。
    // 1s 兜底清红
    var self = this;
    this.fallbackTimer = setTimeout(function() {
      if (self.phase !== 'claim') {
        self.claimedVictims = [];
        self.claimedCallers = [];
        self.render();
      }
    }, 1000);
    this.render();
    // 检查碰/杠/胡
    var claimants = this.getClaimants(tile, seat);
    if (claimants.length > 0) {
      this.claimants = claimants;
      this.claimIdx = 0;
      this.processClaim(0);
    } else {
      setTimeout(function() { self.nextTurn(); }, 400);
    }
  },

  // ---------- 查询可 claim 的座位 ----------
  getClaimants: function(tile, fromSeat) {
    var res = [];
    for (var i = 0; i < 4; i++) {
      if (i === fromSeat) continue;
      var p = this.players[i];
      var evalHand = this.evalHandFor(i);
      var c = { seat: i, peng: false, kong: false, kind: null, tile: tile, from: fromSeat };
      // 规则：只能自摸或抢杠胡，别人打出的普通牌只能碰/明杠，不能胡
      // 同圈放弃过该牌 → 不能再碰（杠不受影响）
      var passedPeng = this.passedClaims.some(function(pc) { return pc.seat === i && pc.tile === tile; });
      if (!passedPeng && tile !== this.ghost && window.mj.canPeng(evalHand, tile, this.ghost)) c.peng = true;
      var cnt = evalHand.filter(function(t) { return t === tile; }).length;
      if (cnt >= 3 && tile !== this.ghost) { c.kong = true; c.kind = 'mg'; }
      if (c.peng || c.kong) res.push(c);
    }
    return res;
  },

  // ---------- 处理 claim ----------
  processClaim: function(idx) {
    this.clearRed();
    if (idx >= this.claimants.length) {
      // 无人 claim，进入下一回合
      var self0 = this;
      setTimeout(function() { self0.nextTurn(); }, 300);
      return;
    }
    this.claimIdx = idx;
    var c = this.claimants[idx];
    var self = this;
    if (c.seat === 0) {
      // 自己决策：显示按钮
      this.claim = c;
      this.phase = 'claim';
      this.setClaimedVictims([1, 2, 3], []);
      this.turnText = '可选择：碰/杠/过';
      this.updateActionBar();
      this.updateTipLine();
      this.render();
      // 红色高亮：自己可碰/杠的手牌 + 别人打出的那张牌
      this.highlightClaimTargets(c.tile, c.from, c.peng, c.kong);
    } else {
      // AI 决策
      this.setClaimedVictims([1, 2, 3], []);
      this.render();
      setTimeout(function() {
        if (self.ended) return;
        var claim = self.claimants[idx];
        // 失效保护：AI 思考延时期间，claim 链可能已被下一回合推进/重置
        // （nextTurn/startRound 会清空 claimants），旧回调拿到 undefined 会崩溃并打断牌局，
        // 此时一定有别的流程（nextTurn→aiTurn/startRound）在接管，直接作废本回调。
        if (!claim || claim.seat !== c.seat || claim.tile !== c.tile) return;
        if (self.aiClaimDecision(c.seat, claim)) {
          if (claim.kong) { self.doKong(c.seat, 'mg', claim.tile, claim); return; }
          if (claim.peng) { self.doPeng(c.seat, claim.tile, claim.from); return; }
        } else {
          // AI 放弃：记录同圈放弃
          if (claim.peng || claim.kong) {
            self.passedClaims.push({ seat: c.seat, tile: claim.tile });
          }
          self.processClaim(idx + 1);
        }
      }, this.aiDelay());
    }
  },

  // ---------- 红色高亮管理 ----------
  setClaimedVictims: function(victims, callerSeats) {
    this.clearTimers();
    this.claimedVictims = victims.slice();
    this.claimedCallers = callerSeats.slice();
    this.render();
    var self = this;
    this.redTimer = setTimeout(function() {
      if (self.phase !== 'claim') {
        self.claimedVictims = [];
        self.claimedCallers = [];
        self.render();
      }
    }, 5000);
  },

  clearRed: function() {
    this.claimedVictims = [];
    this.claimedCallers = [];
    this.clearTimers();
    this.clearTileHL();
  },

  // ---------- 给可碰杠胡的牌加红色高亮 ----------
  // 用法：别人打出 tile(fromSeat)，自己(seat=0)能碰/杠时调用
  highlightClaimTargets: function(tile, fromSeat, hasPeng, hasKong) {
    if (!hasPeng && !hasKong) return;
    // 1) 手里相同的牌（自己）
    var myHand = document.getElementById('myHand');
    if (myHand) {
      var mine = myHand.querySelectorAll('[data-tile="' + tile + '"]');
      mine.forEach(function(el) { el.classList.add('tile-hl'); });
    }
    // 2) 别人刚打出的那张牌：从他弃牌区找最后一张（打出的就是它）
    var pondMap = { 0: 'myPond', 1: 'rightPond', 2: 'topPond', 3: 'leftPond' };
    var pondEl = document.getElementById(pondMap[fromSeat]);
    if (pondEl && pondEl.children.length > 0) {
      var last = pondEl.children[pondEl.children.length - 1];
      if (last.getAttribute('data-tile') === tile) {
        last.classList.add('tile-hl');
      }
    }
  },

  clearTileHL: function() {
    var els = document.querySelectorAll('.tile-hl');
    els.forEach(function(el) { el.classList.remove('tile-hl'); });
  },

  clearTimers: function() {
    if (this.redTimer) { clearTimeout(this.redTimer); this.redTimer = null; }
    if (this.fallbackTimer) { clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
  },

  // ---------- 玩家操作 ----------
  onSelectTile: function(idx) {
    if (this.phase !== 'discard') return;
    if (this.turn !== 0) return; // 不是自己的回合，不能选牌
    if (idx === -2) {
      // 新摸的单独牌：点一下选中，再点一下打出
      if (this.selected === -2) {
        this.onPlayLastDraw();
        return;
      }
      this.selected = -2;
      this.renderMyHand();
      this.updateActionBar();
      this.updateTipLine();
      return;
    }
    if (idx === this.selected) {
      this.onPlaySelected();
      return;
    }
    this.selected = idx;
    this.renderMyHand();
    this.updateActionBar();
    this.updateTipLine();
  },

  // ---------- 打出新摸的单独牌 ----------
  onPlayLastDraw: function() {
    if (this.phase !== 'discard' || this.turn !== 0) return;
    if (!this.lastDraw) return;
    var tile = this.lastDraw;
    this.lastDraw = null;
    this.lastDrawIndex = -1;
    this.selected = -1;
    this.clearRed();
    this.afterDiscard(0, tile);
  },

  onPeng: function() {
    if (!this.claim || !this.claim.peng) return;
    this.clearRed();
    this.phase = 'discard';
    this.doPeng(0, this.claim.tile, this.claim.from);
  },

  onKong: function() {
    // 自己主动暗杠/公杠
    if (this.kongOptions.length === 0) {
      // claim 别人打出的明杠
      if (this.claim && this.claim.kong) {
        this.clearRed();
        this.phase = 'discard';
        this.doKong(0, 'mg', this.claim.tile, this.claim);
      }
      return;
    }
    this.clearRed();
    var k = this.kongOptions[0];
    this.phase = 'discard';
    this.kongOptions = [];
    this.doKong(0, k.kind, k.tile, null);
  },

  onGuo: function() {
    // 自己出牌回合按"过"：放弃本次可胡/可杠，正常选牌打出
    if (this.phase === 'discard' && this.turn === 0) {
      if ((this.canHu || this.kongOptions.length > 0) && !this.passedOptions) {
        this.passedOptions = true;
        this.updateActionBar();
        this.updateTipLine();
      }
      return;
    }
    // 抢杠窗口的"过"：玩家放弃后，其余可胡 AI 仍按一炮多响结算；一家都没有才让补杠成立
    if (this.claim && this.claim.robKong) {
      var robProvider = this.claim.from;
      var robTile = this.claim.tile;
      var restWinners = (this.robKongCandidates || []).filter(function(s) { return s !== 0; });
      this.phase = 'discard';
      if (restWinners.length > 0) {
        this.endRobKongMulti(restWinners, robProvider, robTile);
      } else {
        this.resumeKong();
      }
      return;
    }
    // 同圈放弃：记录自己放弃了这张牌的碰
    if (this.claim && (this.claim.peng || this.claim.kong)) {
      this.passedClaims.push({ seat: 0, tile: this.claim.tile });
    }
    this.processClaim(this.claimIdx + 1);
  },

  onHu: function() {
    this.clearRed();
    if (this.phase === 'discard' && this.canHu) {
      this.endRound(0, { isSelfDraw: true });
      return;
    }
    if (this.phase === 'claim' && this.claim && this.claim.hu && this.claim.robKong) {
      // 只能自摸或抢杠胡：这里仅处理抢杠胡（一炮多响：玩家 + 所有可胡 AI 同时胡，补杠者逐家包）
      var winners = (this.robKongCandidates || []).slice();
      if (winners.indexOf(0) < 0) winners.unshift(0);
      this.endRobKongMulti(winners, this.claim.from, this.claim.tile);
      return;
    }
  },

  // ---------- 碰 ----------
  doPeng: function(seat, tile, fromSeat) {
    this.clearRed();
    var p = this.players[seat];
    // 手牌移除 2 张
    for (var k = 0; k < 2; k++) {
      var i = p.hand.indexOf(tile);
      if (i >= 0) p.hand.splice(i, 1);
    }
    // 从被碰者弃牌区移除该牌
    var fp = this.players[fromSeat];
    var di = fp.disp.lastIndexOf(tile);
    if (di >= 0) fp.disp.splice(di, 1);
    p.melds.push({ type: 'peng', kind: 'peng', tiles: [tile, tile, tile], from: fromSeat });
    window.snd.peng();
    // 尖牌包胡追踪（碰后若单吊自摸，放碰者包）
    this.lastClaimForBao = { provider: fromSeat, seat: seat, src: 'peng' };
    this.baoFirstDraw = true; // 当次内部出牌不判定，保留到后续自我摸牌
    this.kongChain = [];
    this.setClaimedVictims([fromSeat], [seat]);
    this.setMist([fromSeat], { seat: seat, meldIdx: this.players[seat].melds.length - 1 });
    // 碰者直接出牌（碰后不摸牌）
    this.turn = seat;
    this.lastDraw = null;
    this.lastDrawIndex = -1;
    this.render();
    if (seat === 0) this.playerTurn(true); // 碰后出牌不判定胡牌
    else {
      var self = this;
      setTimeout(function() { self.aiTurn(seat, true); }, this.aiDelay()); // AI 碰后也不判定胡牌，先出牌
    }
  },

  // ---------- 杠 ----------
  doKong: function(seat, kind, tile, claim) {
    this.clearRed();
    this.turn = seat;
    var p = this.players[seat];
    var fromSeat = claim ? claim.from : null;

    if (kind === 'ag') {
      // 暗杠：从持有牌中移除 4 张
      var needRemove = 4;
      if (seat === 0 && this.lastDraw === tile) {
        // 自己刚摸的牌单独存放，它就是第 4 张：消费它，手牌只移除 3 张
        this.lastDraw = null;
        this.lastDrawIndex = -1;
        needRemove = 3;
      } else if (seat === 0 && this.lastDraw) {
        // 刚摸的是别的牌：先并回手牌，杠后补牌会产生新的单独牌
        p.hand.push(this.lastDraw);
        this.lastDraw = null;
        this.lastDrawIndex = -1;
      }
      for (var k = 0; k < needRemove; k++) {
        var i = p.hand.indexOf(tile);
        if (i >= 0) p.hand.splice(i, 1);
      }
      p.melds.push({ type: 'kong', kind: 'ag', tiles: [tile, tile, tile, tile], from: null });
      window.snd.gang();
      this.addGangScore(seat, 'ag', tile, null);
      this.kongChain.push({ kind: 'ag', seat: seat, fromSeat: null });
      // 暗杠不新增包牌责任；但若是「明杠后摸牌再杠」的杠上杠，保留明杠责任并续保护
      if (this.lastClaimForBao) this.baoFirstDraw = true;
      this.setClaimedVictims([], [seat]);
      this.setMist([], { seat: seat, meldIdx: p.melds.length - 1 });
    } else if (kind === 'bg') {
      // 补杠（公杠）：先查是否被抢杠（补杠可被抢，暗杠/明杠不可抢）
      if (this.checkRobKong(seat, tile)) {
        // 等待抢杠决策；所有人放弃后由 resumeKong 补完成杠登记
        this.kongResume = { seat: seat, tile: tile };
        return;
      }
      this.applyBuKong(seat, tile);
    } else if (kind === 'mg') {
      // 明杠：手牌移除 3 张 + 弃牌区移除 1 张
      for (var k2 = 0; k2 < 3; k2++) {
        var i2 = p.hand.indexOf(tile);
        if (i2 >= 0) p.hand.splice(i2, 1);
      }
      var fp = this.players[fromSeat];
      var di2 = fp.disp.lastIndexOf(tile);
      if (di2 >= 0) fp.disp.splice(di2, 1);
      p.melds.push({ type: 'kong', kind: 'mg', tiles: [tile, tile, tile, tile], from: fromSeat });
      window.snd.gang();
      this.addGangScore(seat, 'mg', tile, fromSeat);
      this.pendingKong = { payer: fromSeat, payers: [fromSeat], kind: 'mg' };
      this.kongChain.push({ kind: 'mg', seat: seat, fromSeat: fromSeat });
      // 明杠后若单吊自摸，放杠者包牌（杠上杠时此责任延续到后续杠）
      this.lastClaimForBao = { provider: fromSeat, seat: seat, src: 'mg' };
      this.baoFirstDraw = true;
      this.setClaimedVictims([fromSeat], [seat]);
      this.setMist([fromSeat], { seat: seat, meldIdx: p.melds.length - 1 });
    }

    // 杠后补牌
    this.turn = seat;
    this.lastDraw = this.drawTile(seat);
    this.kongResume = null;
    this.render();
    if (seat === 0) this.playerTurn();
    else {
      var self = this;
      setTimeout(function() { self.aiTurn(seat); }, this.aiDelay());
    }
  },

  // ---------- 完成补杠登记（抢杠流程结束后调用）：移除第4张、碰组升级为杠、计分 ----------
  applyBuKong: function(seat, tile) {
    var p = this.players[seat];
    // 前一根是明杠（杠上杠）则保留明杠责任并续保护；否则（含碰后补杠）不包
    if (this.lastClaimForBao && this.lastClaimForBao.src === 'mg') {
      this.baoFirstDraw = true;
    } else {
      this.lastClaimForBao = null;
      this.baoFirstDraw = false;
    }
    // 移除第 4 张：自己的牌单独存放在 lastDraw；AI 的在手牌数组里
    if (seat === 0 && this.lastDraw === tile) {
      this.lastDraw = null;
      this.lastDrawIndex = -1;
    } else {
      var ri = p.hand.indexOf(tile);
      if (ri >= 0) p.hand.splice(ri, 1);
    }
    // 已碰的副露升级为杠（3 张 → 4 张）
    var meldIdx = -1;
    for (var m = 0; m < p.melds.length; m++) {
      if (p.melds[m].type === 'peng' && p.melds[m].tiles[0] === tile) { meldIdx = m; break; }
    }
    if (meldIdx >= 0) {
      p.melds[meldIdx] = { type: 'kong', kind: 'bg', tiles: [tile, tile, tile, tile], from: p.melds[meldIdx].from };
    }
    window.snd.gang();
    this.addGangScore(seat, 'bg', tile, null);
    this.pendingKong = { payer: null, payers: [0, 1, 2, 3].filter(function(s) { return s !== seat; }), kind: 'bg' };
    this.kongChain.push({ kind: 'bg', seat: seat, fromSeat: null });
    this.setClaimedVictims([], [seat]);
    this.setMist([], { seat: seat, meldIdx: meldIdx });
  },

  resumeKong: function() {
    // 放弃抢杠后继续杠流程：先补完成挂起的补杠登记，再补牌
    var seat = this.turn;
    if (this.kongResume) {
      var r = this.kongResume;
      this.kongResume = null;
      seat = r.seat;
      this.turn = seat;
      this.applyBuKong(seat, r.tile);
    }
    this.lastDraw = this.drawTile(seat);
    this.render();
    if (seat === 0) this.playerTurn();
    else {
      var self = this;
      setTimeout(function() { self.aiTurn(seat); }, this.aiDelay());
    }
  },

  // 抢杠胡（仅补杠/公杠可被抢，被抢的补杠者包牌；暗杠、明杠不可抢）
  checkRobKong: function(seat, tile) {
    var robbers = [];
    for (var s = 0; s < 4; s++) {
      if (s === seat) continue;
      var p = this.players[s];
      // 抢杠判胡：用纯手牌+补杠牌（14张）。不能用 evalHandFor——
      // AI 回合 lastDraw 指向补杠者刚摸的牌，evalHandFor 会把它错并入别家手牌，
      // 导致 concat([tile]) 变15张、永远判不出胡，玩家抢杠胡按钮永远不出现。
      var hand14 = p.hand.slice().concat([tile]);
      if (window.mj.checkWin(hand14, this.ghost, p.melds)) robbers.push(s);
    }
    if (robbers.length === 0) return false;
    // 按补杠者之后的座位顺序排列（一炮多响：所有可胡者都能抢，不再截胡只取第一家）
    robbers.sort(function(a, b) {
      return ((a - seat + 4) % 4) - ((b - seat + 4) % 4);
    });
    this.robKongCandidates = robbers.slice();
    var self = this;
    if (robbers.indexOf(0) >= 0) {
      // 玩家也可抢：弹窗等胡/过；无论玩家胡或过，其余可胡 AI 都同时结算
      this.claim = { robKong: true, hu: true, peng: false, kong: false, kind: null, tile: tile, from: seat, seat: 0 };
      this.claimants = [{ seat: 0, hu: true, robKong: true, kong: false, peng: false, kind: null, tile: tile, from: seat }];
      this.claimIdx = 0;
      this.phase = 'claim';
      this.turnText = '可抢杠胡 ' + tile + '（' + SEATS[seat] + '公杠）';
      this.setClaimedVictims([seat], [0]);
      this.updateActionBar();
      this.updateTipLine();
      this.render();
      return true;
    }
    // 全是 AI：所有可胡者同时抢杠胡，补杠者逐家包牌
    var aiWinners = robbers.slice();
    setTimeout(function() {
      if (self.ended) return;
      // 失效保护：startRound 会把 robKongCandidates 清空；若延时跨进了新一局，
      // 旧抢杠回调绝不能结算新局面。候选座位也要与当时一致。
      var cand = self.robKongCandidates || [];
      var same = cand.length === aiWinners.length &&
        aiWinners.every(function(s) { return cand.indexOf(s) >= 0; });
      if (!same) return;
      self.endRobKongMulti(aiWinners, seat, tile);
    }, this.aiDelay());
    return true;
  },

  // 杠分暂记
  addGangScore: function(seat, kind, tile, fromSeat) {
    var base = this.baseScore || 3;
    var others = [0, 1, 2, 3].filter(function(s) { return s !== seat; });
    var ktext = kind === 'ag' ? '暗杠' : kind === 'bg' ? '公杠' : '明杠';
    if (kind === 'ag') {
      var v = 2 * base;
      others.forEach(function(s) {
        this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: null, text: ktext });
        this.pendingScores.push({ seat: s, score: -v, kind: kind, tile: tile, fromSeat: null, text: ktext });
      }, this);
    } else if (kind === 'bg') {
      var v = 1 * base;
      others.forEach(function(s) {
        this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: null, text: ktext });
        this.pendingScores.push({ seat: s, score: -v, kind: kind, tile: tile, fromSeat: null, text: ktext });
      }, this);
    } else if (kind === 'mg') {
      var v = 3 * base;
      this.pendingScores.push({ seat: seat, score: v, kind: kind, tile: tile, fromSeat: fromSeat, text: ktext });
      this.pendingScores.push({ seat: fromSeat, score: -v, kind: kind, tile: tile, fromSeat: fromSeat, text: ktext });
    }
  },

  // ---------- 结算 ----------
  endRound: function(winner, options) {
    if (this.ended) return;
    this.ended = true;
    this.clearRed();
    options = options || {};
    var isSelfDraw = !!options.isSelfDraw;
    var robKong = !!options.robKong;
    var provider = options.provider;
    var p = this.players[winner];
    var winTile = options.tile;
    if (isSelfDraw && !winTile) {
      // 自摸调用点不传 tile：玩家0取单独存放的 lastDraw，AI 取摸牌记录
      winTile = winner === 0 ? this.lastDraw : (p._lastDraw || null);
    }

    // 评估番型（自摸时把刚摸到的牌也算进手牌，抢杠胡时把胡牌加入评估）
    var evalHand = p.hand.slice();
    if (!isSelfDraw) {
      evalHand = evalHand.concat([winTile]);
    } else if (winner === 0 && this.lastDraw) {
      // 自己(seat0)摸的牌会从手牌单独拿出，必须补回；AI 摸的牌留在手牌中
      evalHand = evalHand.concat([this.lastDraw]);
    }
    var fan = window.mj.bestFanEx(evalHand, p.melds, this.ghost, isSelfDraw, robKong);
    var base = this.baseScore || 3;
    var total = fan.fan * base;
    var per = Math.round(total / 3);

    // 杠分累计
    var gangScores = [0, 0, 0, 0];
    this.pendingScores.forEach(function(ps) { gangScores[ps.seat] += ps.score; });

    var scores = [0, 0, 0, 0];
    var huPayer = -1;   // -1 = 三家付
    var payText = '';

    var danDiao = false;
    if (isSelfDraw) {
      var wTile = this.lastDraw;
      if (wTile) danDiao = window.mj.isDanDiao(evalHand, p.melds, this.ghost, wTile);
    }
    var chain = this.kongChain || [];
    var lastKong = chain.length ? chain[chain.length - 1] : null;
    var explosion = !!lastKong && lastKong.seat === winner;   // 杠后自摸 = 杠爆
    var firstMg = null;
    chain.forEach(function (k) {
      if (k.kind === 'mg' && k.seat === winner && firstMg === null) firstMg = k;
    });
    var gangFullPack = false;   // 杠上杠：第一个放杠者包赢家整串杠的杠杆
    var robChainPack = 0;       // 抢杠：被抢者把其本串明杠的杠分付给赢家

    if (robKong) {
      // 1. 抢杠：被抢的补杠者全包，杠分不计（若被抢者本串有过明杠，其杠分也由被抢者付给赢家）
      huPayer = provider;
      payText = '抢杠胡（' + SEATS[provider] + '包）';
      var _base = this.baseScore || 3;
      chain.forEach(function (k) {
        if (k.kind === 'mg' && k.seat === provider) robChainPack += 3 * _base;
      });
    } else if (explosion && firstMg) {
      // 2/3. 杠爆·明杠 / 杠上杠：第一个放杠者包付胡牌；杠上杠另包整串杠分
      huPayer = firstMg.fromSeat;
      payText = (chain.length > 1 ? '杠上杠' : '杠爆明杠') + '（' + SEATS[huPayer] + '包）';
      gangFullPack = chain.length > 1;
    } else if (explosion) {
      // 5. 杠爆·公杠/暗杠：三家平摊
      huPayer = -1;
      payText = '杠爆（三家付）';
    } else if (this.lastClaimForBao && this.lastClaimForBao.seat === winner && danDiao) {
      // 6/4. 尖牌单吊包胡：碰/明杠提供者包胡，杠分照常
      huPayer = this.lastClaimForBao.provider;
      payText = '单吊包胡（' + SEATS[huPayer] + '包）';
    } else {
      // 7. 普通自摸（规则只允许自摸胡与抢杠胡；非抢杠不能胡别人打出的牌，无点炮分支）
      huPayer = -1;
      payText = '自摸（三家付）';
    }

    if (huPayer >= 0) {
      scores[huPayer] -= total;
      scores[winner] += total;
    } else {
      for (var i = 0; i < 4; i++) {
        if (i === winner) scores[i] += total;
        else scores[i] -= per;
      }
    }

    // 加杠分（抢杠不算杠分）
    if (!robKong) {
      if (gangFullPack) {
        // 杠上杠全包：第一个放杠者付赢家在本串所有杠（含后杠）的获利
        var winGain = 0;
        chain.forEach(function (k) {
          winGain += (k.kind === 'mg' ? 3 : k.kind === 'bg' ? 1 : 2) * base;
        });
        scores[winner] += winGain;
        scores[huPayer] -= winGain;
      } else {
        for (var j = 0; j < 4; j++) scores[j] += gangScores[j];
      }
    } else if (robChainPack > 0) {
      scores[winner] += robChainPack;
      scores[provider] -= robChainPack;
    }

    // 结算积分
    for (var s = 0; s < 4; s++) this.players[s].points += scores[s];

    // 鬼牌胡牌 → 闪电（仅自己胡牌时）
    var ghost = this.ghost;
    if (winner === 0 && (p.hand.indexOf(ghost) >= 0 || evalHand.indexOf(ghost) >= 0 || p.melds.some(function(m) { return m.tiles.indexOf(ghost) >= 0; }))) {
      this.triggerLightning();
    }

    window.snd.hu();
    if (isSelfDraw) window.snd.zimo();
    window.snd.fanVoice(fan.name);

    this.endData = {
      winner: winner, winnerName: SEATS[winner],
      fan: fan.fan, name: fan.name,
      scores: scores, total: total, per: per, payText: payText,
      huPayer: huPayer,               // -1=三家付, 否则是 seat 索引（包牌者）
      isSelfDraw: isSelfDraw, robKong: robKong,
      points: this.players.map(function(pl) { return pl.points; }),
      ghost: this.ghost,
      // 展示手牌按结算类型精确构造，避免 AI 回合 evalHandFor(0) 把别家 lastDraw 错并给玩家0
      hands: this.players.map(function(pl, i) {
        var h = pl.hand.slice();
        if (i === winner) {
          if (isSelfDraw) {
            if (i === 0 && this.lastDraw) {
              h.push(this.lastDraw);
            } else if (winTile) {
              // AI 自摸：新摸牌经排序混在手中，移到末尾单独高亮
              var wi = h.indexOf(winTile);
              if (wi >= 0) { h.splice(wi, 1); h.push(winTile); }
            }
          } else {
            h = h.concat([winTile]);
          }
        } else if (robKong && i === provider && i === 0 && this.lastDraw === winTile) {
          // 玩家0是被抢的补杠者：其独立存放的补杠牌需并回展示
          h.push(this.lastDraw);
        }
        return h;
      }.bind(this)),
      melds: this.players.map(function(pl) { return pl.melds.slice(); }),
      pendingScores: this.pendingScores.slice(),
      winTile: winTile || null
    };
    this.scoreHistory.push({ round: this.roundNum, winner: winner, name: fan.name, scores: scores });
    this.dealer = winner;
    this.phase = 'end';
    
    this.showEndModal();
    this.render();
  },

  // ---------- 多家抢杠胡结算（一炮多响）----------
  // winners 全部胡牌（已按补杠者之后顺位排序）；provider=被抢的补杠者，对每家各包一份，未胡者不出钱
  endRobKongMulti: function(winners, provider, tile) {
    if (this.ended) return;
    var self = this;
    winners = winners.filter(function(s, idx) { return winners.indexOf(s) === idx && s !== provider; });
    if (winners.length === 0) { this.resumeKong(); return; }
    winners.sort(function(a, b) {
      return ((a - provider + 4) % 4) - ((b - provider + 4) % 4);
    });

    this.ended = true;
    this.clearRed();
    var base = this.baseScore || 3;
    var scores = [0, 0, 0, 0];
    var winInfos = [];

    // provider 本串每根明杠：对每个胡牌者各赔 3*base（与单赢家抢杠口径一致）
    var robChainPack = 0;
    (this.kongChain || []).forEach(function(k) {
      if (k.kind === 'mg' && k.seat === provider) robChainPack += 3 * base;
    });

    winners.forEach(function(w) {
      var pw = self.players[w];
      var hand14 = pw.hand.slice().concat([tile]);
      var fan = window.mj.bestFanEx(hand14, pw.melds, self.ghost, false, true);
      var total = fan.fan * base;
      winInfos.push({ seat: w, fan: fan.fan, name: fan.name, total: total });
      scores[w] += total;
      scores[provider] -= total;
      if (robChainPack > 0) {
        scores[w] += robChainPack;
        scores[provider] -= robChainPack;
      }
      self.scoreHistory.push({ round: self.roundNum, winner: w, name: fan.name, scores: scores });
    });

    for (var s = 0; s < 4; s++) this.players[s].points += scores[s];

    // 鬼牌胡牌 → 闪电（玩家0胡牌时）
    var ghost = this.ghost;
    if (winners.indexOf(0) >= 0 &&
        (this.players[0].hand.indexOf(ghost) >= 0 ||
         this.players[0].melds.some(function(m) { return m.tiles.indexOf(ghost) >= 0; }))) {
      this.triggerLightning();
    }

    window.snd.hu();
    var voiceInfo = winInfos.filter(function(i) { return i.seat === 0; })[0] || winInfos[0];
    window.snd.fanVoice(voiceInfo.name);

    var payText = '抢杠胡（' + SEATS[provider] + '包·' + winners.length + '家胡）';

    // 展示手牌：赢家并入胡牌 tile；玩家0若为被抢补杠者，其独立补杠牌并回；其余纯手牌
    var hands = this.players.map(function(pl, i) {
      var h = pl.hand.slice();
      if (winners.indexOf(i) >= 0) h = h.concat([tile]);
      else if (i === provider && i === 0 && this.lastDraw === tile) h.push(tile);
      return h;
    }.bind(this));

    this.endData = {
      draw: false,
      multiHu: true,
      winner: winners[0], winnerName: SEATS[winners[0]],
      winners: winInfos,
      fan: winInfos[0].fan, name: winInfos[0].name, total: winInfos[0].total,
      scores: scores, payText: payText,
      huPayer: provider,
      isSelfDraw: false, robKong: true,
      points: this.players.map(function(pl) { return pl.points; }),
      ghost: this.ghost,
      hands: hands,
      melds: this.players.map(function(pl) { return pl.melds.slice(); }),
      pendingScores: [],
      winTile: tile
    };
    this.kongResume = null;
    this.robKongCandidates = null;
    this.claim = null;
    this.claimants = [];
    this.dealer = winners[0];   // 补杠者之后第一顺位胡牌者坐庄
    this.phase = 'end';

    this.showEndModal();
    this.render();
  },

  // ---------- 显示结算弹窗 ----------
  showEndModal: function() {
    var modal = document.getElementById('endModal');
    var titleEl = document.getElementById('endTitle');
    var fanEl = document.getElementById('endFan');
    var payEl = document.getElementById('endPayText');
    var tableEl = document.getElementById('endTable');
    var data = this.endData;

    // tile code → 中文名字
    var Z_NAMES = ['', '东', '南', '西', '北', '中', '发', '白'];
    function tileName(code) {
      if (!code || code === 'ghost') return '鬼';
      var suit = code[0];
      var num = parseInt(code.slice(1));
      if (suit === 'Z') return Z_NAMES[num] || code;
      var sn = suit === 'W' ? '万' : suit === 'T' ? '条' : '筒';
      return sn + num;
    }

    // 胡牌座位判定（单赢家 / 多家抢杠胡）
    function isHuSeat(i) {
      if (data.draw) return false;
      if (data.multiHu) return data.winners.some(function(w) { return w.seat === i; });
      return data.winner === i;
    }

    // ===== 顶部区 =====
    if (data.draw) {
      titleEl.textContent = '荒 庄';
      fanEl.style.display = 'none';
      payEl.textContent = '所有分数不计（含杠分）';
      payEl.style.display = 'block';
    } else if (data.multiHu) {
      titleEl.textContent = '抢 杠 胡 · ' + data.winners.length + ' 家胡牌';
      fanEl.innerHTML = data.winners.map(function(w) {
        return SEATS[w.seat] + ' ' + w.name + ' · 共 ' + w.total + ' 分';
      }).join('<br>');
      fanEl.style.display = 'block';
      payEl.textContent = data.payText;
      payEl.style.display = 'block';
    } else {
      titleEl.textContent = data.winnerName + ' 胡 牌';
      if (data.total && data.fan) {
        fanEl.textContent = data.name + ' · 共 ' + data.total + ' 分';
      } else {
        fanEl.textContent = data.name + ' ' + data.fan + ' 番';
      }
      fanEl.style.display = 'block';
      if (data.payText) {
        payEl.textContent = data.payText;
        payEl.style.display = 'block';
      } else {
        payEl.style.display = 'none';
      }
    }

    // ===== 4 家结算表 =====
    var html = '';
    for (var i = 0; i < 4; i++) {
      var s = (data.scores && data.scores[i]) || 0;
      var cum = (data.points && data.points[i]) || 0;
      var isWinner = isHuSeat(i);
      var rowClass = 'mt-row' + (isWinner ? ' mt-winner' : '');

      html += '<div class="' + rowClass + '">';
      html += '<div class="mt-name">';
      html += '<span class="mt-name-text">' + SEATS[i] + '</span>';
      if (isWinner) html += '<span class="mt-winner-badge">胡</span>';
      html += '</div>';
      html += '<div class="mt-pay">';
      if (data.draw && s === 0) {
        html += '<span class="mt-pay-num zero">—</span>';
      } else {
        html += '<span class="mt-pay-num ' + (s > 0 ? 'pos' : s < 0 ? 'neg' : 'zero') + '">' + (s > 0 ? '+' : '') + s + '</span>';
      }
      html += '</div>';
      html += '<div class="mt-cum">';
      html += '<span class="mt-cum-num">' + cum + '</span>';
      html += '</div>';
      html += '</div>';
    }

    // ===== 本局明细数据预收集（先算好，后渲染） =====
    var gangDetails = [];
    if (data.pendingScores) {
      // 同一玩家同一牌的杠（暗杠/公杠三家各一条 pendingScore，明杠一条）
      // 必须把同 key 的所有 score 累加，不能只取第一条
      // 否则三家各付3的公杠会只显示+3，暗杠也会只显示+6
      var merged = {};
      data.pendingScores.forEach(function(ps) {
        if (ps.score <= 0) return;
        var k = ps.kind + '_' + ps.seat + '_' + (ps.tile||'');
        if (!merged[k]) {
          merged[k] = { kind: ps.kind, seat: ps.seat, tile: ps.tile, fromSeat: ps.fromSeat, text: ps.text, score: 0 };
        }
        merged[k].score += ps.score;
      });
      gangDetails = Object.keys(merged).map(function(k) { return merged[k]; });
    }
    var hasAnyDetail = gangDetails.length > 0 || !data.draw;

    // ===== 四家牌面区（移到前面） =====
    html += '<div class="m-hands">';
    html += '<div class="m-hands-title">四 家 牌 面</div>';

    for (var h = 0; h < 4; h++) {
      var hMelds = (data.melds && data.melds[h]) || [];
      var hHand = (data.hands && data.hands[h]) || [];
      html += '<div class="mh-row">';
      var labelTxt = isHuSeat(h) ? '<span class="mh-hu-tag">胡牌</span>' : '手牌';
      html += '<div class="mh-label"><span class="mh-name">' + SEATS[h] + '</span>' + labelTxt + '</div>';
      html += '<div class="mh-tiles">';

      hMelds.forEach(function(m, mi) {
        var gClass = m.type === 'kong' ? 'mh-group kong' : m.type === 'peng' ? 'mh-group peng' : 'mh-group chi';
        if (mi > 0) html += '<span style="display:inline-block;width:8px"></span>';
        html += '<div class="' + gClass + '">';
        m.tiles.forEach(function(t) {
          var isG = t === data.ghost;
          var gCls = isG ? 'mh-tile ghost' : 'mh-tile';
          if (isG) {
            html += '<span class="mh-ghost-wrap"><img class="' + gCls + '" src="images/' + window.mj.tileImage(t) + '.png"><span class="mh-ghost-badge">鬼</span></span>';
          } else {
            html += '<img class="' + gCls + '" src="images/' + window.mj.tileImage(t) + '.png">';
          }
        });
        html += '</div>';
      });

      if (hMelds.length > 0 && hHand.length > 0) {
        html += '<span style="display:inline-block;width:8px"></span>';
      }
      var winIdx = (h === data.winner && data.winTile) ? hHand.lastIndexOf(data.winTile) : -1;
      hHand.forEach(function(t, ti) {
        var isWinTile = (ti === winIdx);
        var isGhostTile = (t === data.ghost);
        var hCls = isGhostTile ? 'mh-tile ghost' : 'mh-tile';
        var ghostBadge = isGhostTile ? '<span class="mh-ghost-badge">鬼</span>' : '';
        if (isWinTile) {
          if (data.isSelfDraw) {
            html += '<span class="mh-win-selfdraw"><img class="' + hCls + '" src="images/' + window.mj.tileImage(t) + '.png">' + ghostBadge + '<span class="mh-win-label">自摸</span></span>';
          } else {
            html += '<span class="mh-win-tile"><img class="' + hCls + '" src="images/' + window.mj.tileImage(t) + '.png">' + ghostBadge + '<span class="mh-win-label">胡</span></span>';
          }
        } else if (isGhostTile) {
          html += '<span class="mh-ghost-wrap"><img class="' + hCls + '" src="images/' + window.mj.tileImage(t) + '.png">' + ghostBadge + '</span>';
        } else {
          html += '<img class="' + hCls + '" src="images/' + window.mj.tileImage(t) + '.png">';
        }
      });

      html += '</div></div>';
    }
    html += '</div>';

    // ===== 本局明细区（移到后面） =====
    if (hasAnyDetail) {
      html += '<div class="m-detail">';
      html += '<div class="m-detail-title">本 局 明 细</div>';

      gangDetails.forEach(function(ps) {
        var kindLabel = ps.kind === 'ag' ? '暗杠' : ps.kind === 'bg' ? '公杠' : '明杠';
        var kindTag = 'tag-' + ps.kind;
        var tileNm = tileName(ps.tile);
        var whoGang = SEATS[ps.seat];
        var whoPay = ps.kind === 'mg' ? SEATS[ps.fromSeat] : null;
        var sign = ps.score >= 0 ? '+' : '';
        var rowClass = ps.score >= 0 ? 'pos' : 'neg';

        html += '<div class="dl-row">';
        html += '<div class="dl-left">';
        html += '<span class="tag ' + kindTag + '">' + kindLabel + '</span>';
        html += '<span class="hl">' + whoGang + '</span> 杠 ' + tileNm;
        if (ps.kind === 'mg') html += '（<span class="hl">' + whoPay + '</span>包杠）';
        else if (ps.kind === 'ag') html += '（三家付）';
        else html += '（公杠·三家付）';
        html += '</div>';
        html += '<div class="dl-right ' + rowClass + '">' + sign + ps.score + '</div>';
        html += '</div>';
      });

      if (!data.draw && data.multiHu) {
        // 多家抢杠胡：每家一行，补杠者逐家包
        data.winners.forEach(function(w) {
          html += '<div class="dl-row">';
          html += '<div class="dl-left">';
          html += '<span class="tag tag-hu">胡</span>';
          html += '<span class="hl">' + SEATS[w.seat] + '</span> ' + w.name + ' · 共' + w.total + '分';
          html += ' · 抢杠胡（<span class="hl">' + SEATS[data.huPayer] + '</span>包）';
          html += '</div>';
          html += '<div class="dl-right pos">+' + w.total + '</div>';
          html += '</div>';
        });
      } else if (!data.draw) {
        var huSign = data.total >= 0 ? '+' : '';
        html += '<div class="dl-row">';
        html += '<div class="dl-left">';
        html += '<span class="tag tag-hu">胡</span>';
        html += '<span class="hl">' + SEATS[data.winner] + '</span> ' + data.name + ' · 共' + data.total + '分';
        if (data.payText) html += ' · ' + data.payText;
        html += '</div>';
        html += '<div class="dl-right pos">' + huSign + data.total + '</div>';
        html += '</div>';
      }

      html += '</div>';
    }

    tableEl.innerHTML = html;
    modal.style.display = 'flex';
    var innerModal = modal.querySelector('.end-modal') || modal.querySelector('.modal');
    requestAnimationFrame(function() { if (innerModal) innerModal.scrollTop = 0; else modal.scrollTop = 0; });
  },

  // ---------- AI 决策 ----------
  aiWantsKong: function(seat) {
    var style = this.aiPicks[seat - 1];
    if (style === '激进型' || style === '速攻型') return Math.random() < 0.9;
    if (style === '贪番型') return Math.random() < 0.7;
    if (style === '鬼牌型') return Math.random() < 0.6;
    if (style === '普通型') return Math.random() < 0.5;
    return Math.random() < 0.3; // 保守型
  },

  aiClaimDecision: function(seat, claim) {
    var style = this.aiPicks[seat - 1];
    // 别人打出的牌只能碰/明杠（胡牌只能自摸或抢杠，抢杠不经此函数）
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
  },

  // AI 选牌出牌：留分高的，弃分低的
  aiDiscard: function(seat) {
    var p = this.players[seat];
    var hand = p.hand;
    var style = this.aiPicks[seat - 1];
    var self = this;
    var scored = hand.map(function(t, idx) {
      return { t: t, idx: idx, score: self.tileKeepScore(hand, t, style) };
    });
    scored.sort(function(a, b) { return a.score - b.score; });
    var pick = scored[0];
    if (scored.length > 1 && scored[1].score <= pick.score + 1 && Math.random() < 0.5) pick = scored[1];
    return pick.t;
  },

  tileKeepScore: function(hand, tile, style) {
    if (tile === this.ghost) return 9999;
    var counts = window.mj.countTiles(hand);
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
  },

  // ---------- 闪电特效 ----------
  triggerLightning: function() {
    window.snd.lightning();
    var strikeEl = document.getElementById('strikeFx');
    var flashEl = document.getElementById('screenFlash');
    strikeEl.style.display = 'block';
    flashEl.style.display = 'block';
    setTimeout(function() {
      strikeEl.style.display = 'none';
      flashEl.style.display = 'none';
    }, 600);
  },

  // ---------- UI ----------
  onNextRound: function() {
    this.roundNum = (this.roundNum || 1) + 1;
    document.getElementById('endModal').style.display = 'none';
    this.startRound();
  },

  onBackHome: function() {
    this.clearTimers();
    window.location.href = 'index.html';
  },

  // ---------- 编辑模式 ----------
  toggleEditMode: function() {
    if (this.editMode) {
      this.exitEditMode();
    } else {
      this.enterEditMode();
    }
  },

  enterEditMode: function() {
    this.editMode = true;
    var root = document.getElementById('gameRoot');
    root.classList.add('edit-mode');
    document.getElementById('editToolbar').style.display = 'flex';
    // 暂停游戏交互：如果有定时器，先清掉以防止AI自动行动
    this.clearTimers();
  },

  exitEditMode: function() {
    this.editMode = false;
    var root = document.getElementById('gameRoot');
    root.classList.remove('edit-mode');
    document.getElementById('editToolbar').style.display = 'none';
    if (this.layoutManager) this.layoutManager.clearSelection();
    // 恢复游戏：如果在游戏中，继续当前回合
    if (this.phase === 'discard' && this.turn !== 0 && !this.ended) {
      this.aiTurn(this.turn);
    } else if (this.phase === 'claim' && this.claimants.length > 0 && !this.ended) {
      // 重新处理 claim
      this.processClaim(this.claimIdx);
    }
  },

  saveLayout: function() {
    if (this.layoutManager) {
      this.layoutManager.saveLayout();
    }
    this.exitEditMode();
  },

  resetLayout: function() {
    if (this.layoutManager) {
      this.layoutManager.resetLayout();
    }
  },

  // ---------- 部件缩放（选中哪个部件就放大/缩小哪个的宽高） ----------
  scaleSelected: function(delta) {
    var lm = this.layoutManager;
    var k = lm.selectedKey;
    if (!k) { this.scaleHint('请先选中要缩放的部件'); return; }
    var el = lm.draggableItems[k];
    var layout = lm.currentLayout[k];
    if (!el || !layout) return;
    var w = el.getBoundingClientRect().width;
    var h = el.getBoundingClientRect().height;
    var step = 60 * Math.sign(delta);
    var nw = Math.max(40, Math.round(w + step));
    var nh = Math.max(40, Math.round(h + step));
    el.style.width = nw + 'px';
    el.style.height = nh + 'px';
    layout.width = nw;
    layout.height = nh;
    layout.usePx = true;
    layout.useVh = false;
    this.scaleHint('尺寸 ' + nw + ' x ' + nh);
  },
  resetSelectedScale: function() {
    var lm = this.layoutManager;
    var k = lm.selectedKey;
    if (!k) return;
    var el = lm.draggableItems[k];
    var layout = lm.currentLayout[k];
    if (layout && el) {
      layout.width = null;
      layout.height = null;
      el.style.width = '';
      el.style.height = '';
    }
    this.scaleHint('已还原为自动大小');
  },
  scaleHint: function(msg) {
    var line = document.getElementById('tipLine');
    var text = document.getElementById('tipText');
    if (line) line.style.display = 'block';
    if (text) text.textContent = msg;
  },
  zoomIn: function() { this.scaleSelected(1); },
  zoomOut: function() { this.scaleSelected(-1); },
  resetZoom: function() { this.resetSelectedScale(); }
};

// ============================================================
// 布局管理器 - 支持拖拽调整UI部件位置
// ============================================================
function LayoutManager() {
  this.storageKey = 'mahjong_layout_v9';
  this.gameRoot = null;
  this.draggableItems = {};
  this.currentDrag = null;
  this.dragStartX = 0;
  this.dragStartY = 0;
  this.origLeft = 0;
  this.origTop = 0;
  this.hasMoved = false;
  this.selectedKey = null;
  this.selectedEl = null;
  this.curResize = null;

  // 默认布局配置（百分比定位，适配不同屏幕）
  this.defaultLayout = {
    seatTop:     { top: 1, left: 50, transform: 'translateX(-50%)', useTransform: true, useVh: true },
    seatLeft:    { bottom: 8, left: 2, useBottom: true, useVh: true },
    seatRight:   { top: 50, left: 98.5, transform: 'translate(-100%, -50%)', useTransform: true, useVh: true },
    myPond:      { bottom: 12, left: 50, transform: 'translateX(-50%)', useTransform: true, useBottom: true, useVh: true },
    myMelds:     { bottom: 1, left: 2, useBottom: true, useVh: true },
    myHand:      { bottom: 1, left: 50, transform: 'translateX(-50%)', useTransform: true, useBottom: true, useVh: true },
    centerArea:  { top: 50, left: 50, transform: 'translate(-50%, -50%)', useTransform: true },
    roundInfo:   { top: 1, left: 13, useVh: true },
    actionBar:   { bottom: 24, left: 50, transform: 'translateX(-50%)', useTransform: true, useBottom: true, useVh: true }
  };

  this.currentLayout = null;
}

LayoutManager.prototype.init = function() {
  var self = this;
  this.gameRoot = document.getElementById('gameRoot');

  // 收集所有可拖拽元素
  var draggables = document.querySelectorAll('.draggable');
  draggables.forEach(function(el) {
    var key = el.dataset.layoutKey;
    if (key) {
      self.draggableItems[key] = el;
    }
  });

  // 加载保存的布局
  this.loadLayout();

  // 应用布局
  this.applyLayout();

  // 绑定拖拽事件
  this.bindDragEvents();
};

// ---------- 加载/保存布局 ----------
LayoutManager.prototype.loadLayout = function() {
  try {
    var saved = localStorage.getItem(this.storageKey);
    if (saved) {
      this.currentLayout = JSON.parse(saved);
    } else {
      // 从旧版 v8 存档迁移：速度控件已删除；左上角新增返回按钮，
      // 仍在出厂左上角的局数显示右移让位（用户手动挪过的位置保持不动）
      var old8 = localStorage.getItem('mahjong_layout_v8');
      if (old8) {
        this.currentLayout = JSON.parse(old8);
        delete this.currentLayout.speedCtrl;
        var ri = this.currentLayout.roundInfo;
        if (ri && ri.top === 1 && ri.left === 1) ri.left = 13;
        localStorage.setItem(this.storageKey, JSON.stringify(this.currentLayout));
        localStorage.removeItem('mahjong_layout_v8');
      } else {
        // 首次使用 v5：从旧版 v4 存档迁移，保留用户自定义位置；
        // 仅把弃牌池放大前的按钮出厂位置 bottom:20 上移到24，避免遮挡放大的弃牌
        var old = localStorage.getItem('mahjong_layout_v4');
        if (old) {
          this.currentLayout = JSON.parse(old);
          if (this.currentLayout.actionBar && this.currentLayout.actionBar.bottom === 20) {
            this.currentLayout.actionBar.bottom = 24;
          }
          localStorage.setItem(this.storageKey, JSON.stringify(this.currentLayout));
          localStorage.removeItem('mahjong_layout_v4');
        } else {
          this.currentLayout = this.cloneDefault();
        }
      }
    }
  } catch (e) {
    console.warn('加载布局失败，使用默认布局', e);
    this.currentLayout = this.cloneDefault();
  }
};

LayoutManager.prototype.saveLayout = function() {
  try {
    // 从当前DOM状态读取位置
    this.capturePositions();
    localStorage.setItem(this.storageKey, JSON.stringify(this.currentLayout));
  } catch (e) {
    console.warn('保存布局失败', e);
  }
};

LayoutManager.prototype.resetLayout = function() {
  this.currentLayout = this.cloneDefault();
  this.applyLayout();
};

LayoutManager.prototype.cloneDefault = function() {
  return JSON.parse(JSON.stringify(this.defaultLayout));
};

// ---------- 应用布局到DOM ----------
LayoutManager.prototype.applyLayout = function() {
  var self = this;
  Object.keys(this.draggableItems).forEach(function(key) {
    var el = self.draggableItems[key];
    var layout = self.currentLayout[key];
    if (!el || !layout) return;
    self.applyElementLayout(el, layout);
  });
};

LayoutManager.prototype.applyElementLayout = function(el, layout) {
  var unitX = layout.usePx ? "px" : "%";
  var unitY = layout.usePx ? "px" : (layout.useVh ? "vh" : "%");
  el.style.position = "absolute";
  el.style.top = ""; el.style.bottom = ""; el.style.left = ""; el.style.right = "";
  el.style.width = ""; el.style.height = "";
  if (layout.transform) el.style.transform = layout.transform;
  if (layout.useBottom && layout.bottom !== undefined) {
    el.style.bottom = layout.bottom + unitY;
  } else if (layout.top !== undefined) {
    el.style.top = layout.top + unitY;
  }
  if (layout.left !== undefined) el.style.left = layout.left + unitX;
  if (layout.right !== undefined) el.style.right = layout.right + unitX;
  if (layout.width !== undefined && layout.width !== null) el.style.width = layout.width + unitX;
  if (layout.height !== undefined && layout.height !== null) el.style.height = layout.height + unitX;
}


LayoutManager.prototype.capturePositions = function() {
  var self = this;
  var rootRect = this.gameRoot.getBoundingClientRect();

  Object.keys(this.draggableItems).forEach(function(key) {
    var el = self.draggableItems[key];
    var layout = self.currentLayout[key];
    if (!el || !layout) return;

    var rect = el.getBoundingClientRect();

    // 统一用相对根节点的像素定位，所见即所得，无单位换算误差
    layout.left = rect.left - rootRect.left;
    layout.top = rect.top - rootRect.top;
    layout.usePx = true;
    layout.useVh = false;
    delete layout.bottom;
    layout.useTransform = false;
    layout.transform = null;
  });
};

// ---------- 拖拽事件绑定 ----------
LayoutManager.prototype.bindDragEvents = function() {
  var self = this;

  Object.keys(this.draggableItems).forEach(function(key) {
    var el = self.draggableItems[key];

    // 鼠标事件 - 整个部件可拖动
    el.addEventListener('mousedown', function(e) {
      if (!self.isEditMode()) return;
      e.preventDefault();
      e.stopPropagation();
      self.selectEl(key, el);
      self.hasMoved = false;
      self.startDrag(el, key, e.clientX, e.clientY);
    });

    // 触摸事件 - 整个部件可拖动
    el.addEventListener('touchstart', function(e) {
      if (!self.isEditMode()) return;
      e.preventDefault();
      e.stopPropagation();
      self.selectEl(key, el);
      self.hasMoved = false;
      var touch = e.touches[0];
      self.startDrag(el, key, touch.clientX, touch.clientY);
    }, { passive: false });
  });

  // 全局移动事件（鼠标）
  document.addEventListener('mousemove', function(e) {
    if (self.currentDrag) {
      e.preventDefault();
      self.onDrag(e.clientX, e.clientY);
    }
  });

  // 全局移动事件（触摸）
  document.addEventListener('touchmove', function(e) {
    if (self.currentDrag) {
      e.preventDefault();
      var touch = e.touches[0];
      self.onDrag(touch.clientX, touch.clientY);
    }
  }, { passive: false });

  // 全局结束事件（鼠标）
  document.addEventListener('mouseup', function(e) {
    if (self.currentDrag) {
      self.endDrag();
    }
  });

  // 全局结束事件（触摸）
  document.addEventListener('touchend', function(e) {
    if (self.currentDrag) {
      self.endDrag();
    }
  });

  // 防止触摸滚动
  document.addEventListener('touchmove', function(e) {
    if (self.currentDrag) {
      e.preventDefault();
    }
  }, { passive: false });

  // ---------- 右下角缩放手柄（自由改变宽高） ----------
  Object.keys(this.draggableItems).forEach(function(key) {
    var el = self.draggableItems[key];
    if (!el) return;
    var handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = '拖拽调整大小';
    el.appendChild(handle);
    initResizeHandle(handle, el, key);
  });

  function initResizeHandle(handle, el, key) {
    var W, H, sx, sy;
    function onStart(e) {
      if (!self.isEditMode()) return;
      e.preventDefault();
      e.stopPropagation();
      var r = el.getBoundingClientRect();
      W = r.width; H = r.height;
      var p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY;
      self.curResize = { W: W, H: H, sx: sx, sy: sy, el: el, key: key };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }
    function onMove(ev) {
      if (!self.curResize) return;
      ev.preventDefault();
      var p = ev.touches ? ev.touches[0] : ev;
      var dx = p.clientX - self.curResize.sx;
      var dy = p.clientY - self.curResize.sy;
      var MIN = 40;
      var nw = Math.max(MIN, Math.round(self.curResize.W + dx));
      var nh = Math.max(MIN, Math.round(self.curResize.H + dy));
      self.curResize.el.style.width = nw + 'px';
      self.curResize.el.style.height = nh + 'px';
    }
    function onEnd() {
      if (!self.curResize) return;
      var k = self.curResize.key;
      var elm = self.curResize.el;
      self.curResize = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      var layout = self.currentLayout[k];
      if (layout) {
        layout.width = elm.offsetWidth;
        layout.height = elm.offsetHeight;
        layout.usePx = true;
        layout.useVh = false;
      }
    }
    handle.addEventListener('mousedown', onStart);
    handle.addEventListener('touchstart', onStart, { passive: false });
  }
};

LayoutManager.prototype.isEditMode = function() {
  return this.gameRoot.classList.contains('edit-mode');
};

// ---------- 选中部件（便于单独缩放/拖动） ----------
LayoutManager.prototype.selectEl = function(key, el) {
  if (this.selectedEl) this.selectedEl.classList.remove('layout-selected');
  el.classList.add('layout-selected');
  this.selectedEl = el;
  this.selectedKey = key;
};

LayoutManager.prototype.clearSelection = function() {
  if (this.selectedEl) this.selectedEl.classList.remove('layout-selected');
  this.selectedEl = null;
  this.selectedKey = null;
};

LayoutManager.prototype.startDrag = function(el, key, clientX, clientY) {
  this.currentDrag = { el: el, key: key };
  this.dragStartX = clientX;
  this.dragStartY = clientY;

  var rect = el.getBoundingClientRect();
  var rootRect = this.gameRoot.getBoundingClientRect();
  this.origLeft = rect.left - rootRect.left;
  this.origTop = rect.top - rootRect.top;

  el.classList.add('dragging');

  // 清除 transform 以便简单定位
  var layout = this.currentLayout[key];
  if (layout && layout.useTransform) {
    el.style.transform = 'none';
  }
};

LayoutManager.prototype.onDrag = function(clientX, clientY) {
  if (!this.currentDrag) return;

  var dx = clientX - this.dragStartX;
  var dy = clientY - this.dragStartY;

  // 标记是否真正移动了（超过3像素才算移动）
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    this.hasMoved = true;
  }

  var rootRect = this.gameRoot.getBoundingClientRect();
  var el = this.currentDrag.el;

  var newLeft = this.origLeft + dx;
  var newTop = this.origTop + dy;

  // 边界限制 - 允许部分超出但至少保留一部分在屏幕内
  var elRect = el.getBoundingClientRect();
  var maxLeft = rootRect.width - elRect.width * 0.3;
  var maxTop = rootRect.height - elRect.height * 0.3;
  var minLeft = -elRect.width * 0.7;
  var minTop = -elRect.height * 0.7;
  if (newLeft < minLeft) newLeft = minLeft;
  if (newTop < minTop) newTop = minTop;
  if (newLeft > maxLeft) newLeft = maxLeft;
  if (newTop > maxTop) newTop = maxTop;

  // 实时更新位置（使用像素，保存时转百分比）
  el.style.left = newLeft + 'px';
  el.style.top = newTop + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
};

LayoutManager.prototype.endDrag = function() {
  if (!this.currentDrag) return;

  var el = this.currentDrag.el;
  var key = this.currentDrag.key;
  var layout = this.currentLayout[key];

  el.classList.remove('dragging');

  // 如果没有真正移动，不做位置保存
  if (!this.hasMoved) {
    // 恢复 transform
    if (layout && layout.useTransform) {
      this.applyElementLayout(el, layout);
    }
    this.currentDrag = null;
    return;
  }

  // 将像素位置保存到布局中（统一用相对根节点的像素定位，所见即所得）
  var rect = el.getBoundingClientRect();
  var rootRect = this.gameRoot.getBoundingClientRect();

  if (layout) {
    // 保存像素坐标，避免单位换算漂移
    layout.left = rect.left - rootRect.left;
    layout.top = rect.top - rootRect.top;
    layout.usePx = true;
    layout.useVh = false;
    delete layout.bottom;
    layout.useTransform = false;
    layout.transform = null;

    // 重新应用以恢复纯定位
    this.applyElementLayout(el, layout);
  }

  this.currentDrag = null;
};

// 页面加载完成后初始化
window.addEventListener('load', function() {
  game.init();
});
