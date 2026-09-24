// js/online.js — 联机可玩界面客户端逻辑
// 4 模块（net/state/render/action）+ 辅助（sfx/ui），全部挂在 window.online
// 复用 window.mj（mahjong.js）和 window.snd（sounds.js），绝不污染 window.game
'use strict';

(function () {
  var online = {
    // 状态
    cur: null,        // 最新 engine.snapshot(mySeat)
    mySeat: -1,
    sessionId: null,
    roomId: null,
    isOwner: false,
    room: null,       // 房间状态（seats/ownerSeat/status）
    // 网络
    ws: null,
    wsUrl: '',
    reconnectCount: 0,
    maxReconnect: 5,
    reconnectTimer: null,
    disconnected: false,
    // 玩家选中的手牌 idx（-2 = lastDraw, 0..n = hand[idx]）
    selectedIdx: null,
    // 摸牌按钮逻辑辅助
    pendingClaim: null,
    pendingKongOptions: [],
    // 阶段E：碰杠红雾状态
    mistVictims: [],       // 被碰杠者座位数组（手牌+弃牌+副露整区包红雾）
    mistCaller: null       // 碰杠执行者 {seat}(仅最新那组副露叠红雾)
  };

  // ============ ui（轻量 UI 辅助） ============
  var ui = {
    toast: function (msg, kind) {
      var box = document.getElementById('toastContainer');
      if (!box) return;
      var t = document.createElement('div');
      t.className = 'toast' + (kind ? ' ' + kind : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
    },
    showDisconnect: function (msg) {
      var mask = document.getElementById('disconnectMask');
      var txt = document.getElementById('disconnectText');
      if (txt) txt.textContent = msg || '网络断开，3 秒后重连…';
      if (mask) mask.style.display = 'flex';
      online.disconnected = true;
    },
    hideDisconnect: function () {
      var mask = document.getElementById('disconnectMask');
      if (mask) mask.style.display = 'none';
      online.disconnected = false;
    },
    showLobby: function () {
      document.getElementById('lobby').style.display = 'flex';
      document.getElementById('gameRoot').style.display = 'none';
    },
    showTable: function () {
      document.getElementById('lobby').style.display = 'none';
      document.getElementById('gameRoot').style.display = 'block';
    },
    // 房间到期：中央弹窗提示，玩家看完结算后点"返回大厅"
    showRoomExpired: function () {
      var modal = document.getElementById('expiredModal');
      if (modal) modal.style.display = 'flex';
      var cdLobby = document.getElementById('cardCountdown');
      var cdGame = document.getElementById('gameCardCountdown');
      if (cdLobby) cdLobby.style.display = 'none';
      if (cdGame) cdGame.style.display = 'none';
    },
    setLobbyStatus: function (msg) {
      var el = document.getElementById('lobbyStatus');
      if (el) el.textContent = msg || '';
    },
    // 房主卡倒计时：服务器给一个过期时间戳（ms），客户端每秒刷新显示
    _cdInterval: null,
    updateCardCountdown: function (expiryTs) {
      // 清旧定时器
      if (ui._cdInterval) { clearInterval(ui._cdInterval); ui._cdInterval = null; }
      var cdLobby = document.getElementById('cardCountdown');
      var cdGame = document.getElementById('gameCardCountdown');
      if (!expiryTs || expiryTs <= Date.now()) {
        // 过期了或没卡 → 隐藏
        if (cdLobby) cdLobby.style.display = 'none';
        if (cdGame) cdGame.style.display = 'none';
        return;
      }
      var tick = function () {
        var remain = Math.max(0, expiryTs - Date.now());
        var sec = Math.floor(remain / 1000);
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        var text = (h > 0 ? (h + ':') : '') +
                   (m < 10 && h > 0 ? '0' : '') + m + ':' +
                   (s < 10 ? '0' : '') + s;
        // 更新 DOM
        var lobbyTime = document.getElementById('cdTime');
        var gameTime = document.getElementById('gameCdTime');
        if (lobbyTime) lobbyTime.textContent = text;
        if (gameTime) gameTime.textContent = text;
        // 剩不到 30 分钟 → 加 expiring 类变红闪烁
        var expiring = remain < 30 * 60 * 1000;
        if (cdLobby) {
          cdLobby.style.display = 'flex';
          cdLobby.classList.toggle('expiring', expiring);
        }
        if (cdGame) {
          cdGame.style.display = 'flex';
          cdGame.classList.toggle('expiring', expiring);
        }
        // 过期 → 停
        if (remain <= 0) {
          clearInterval(ui._cdInterval);
          ui._cdInterval = null;
          if (cdLobby) cdLobby.style.display = 'none';
          if (cdGame) cdGame.style.display = 'none';
        }
      };
      tick();
      ui._cdInterval = setInterval(tick, 1000);
    },
    // 阶段D步骤3：托管事件提示
    onAutoAction: function (d) {
      d = d || {};
      if (d.kind === 'discard') {
        if (d.seat === online.mySeat) {
          if (d.justTakenOver) ui.toast('已超时2次，本局电脑接管，下一局自动恢复', 'error');
          else ui.toast('你超时了，电脑代打一次（再超时1次本局接管）', 'error');
        } else {
          ui.toast(d.justTakenOver
            ? (seatName(d.seat) + ' 超时2次，本局由电脑接管')
            : (seatName(d.seat) + ' 超时，电脑代打'));
        }
      } else if (d.kind === 'pass') {
        ui.toast(d.seat === online.mySeat
          ? '你超时未选择，已算“过”'
          : (seatName(d.seat) + ' 超时未选择，算“过”'));
      }
    }
  };

  // ============ timer（30秒/15秒倒计时条，250ms 刷新） ============
  var DISCARD_MS = 30000, CLAIM_MS = 15000;
  var timer = {
    handle: null,
    start: function () {
      if (this.handle) return;
      this.handle = setInterval(this.tick, 250);
    },
    tick: function () {
      var s = online.cur;
      var wrap = document.getElementById('turnTimer');
      if (!wrap) return;
      var bar = document.getElementById('turnTimerBar');
      var txt = document.getElementById('turnTimerText');
      if (!s || s.phase === 'idle' || s.phase === 'end') {
        wrap.style.display = 'none';
        return;
      }
      // 自己本局已被电脑接管：固定提示，不显示倒计时
      if (s.takenOver && s.takenOver[online.mySeat]) {
        wrap.style.display = 'flex';
        bar.style.width = '100%';
        bar.className = 'turn-timer-bar';
        txt.className = 'turn-timer-text taken';
        txt.textContent = '电脑托管中';
        return;
      }
      var total = 0, deadline = 0, label = '', mine = false;
      if (s.phase === 'discard' && s.turnDeadline) {
        total = DISCARD_MS;
        deadline = s.turnDeadline;
        mine = (s.turn === online.mySeat);
        label = mine ? '轮到你出牌' : ('等待 ' + seatName(s.turn) + ' 出牌');
      } else if (s.phase === 'claim' && s.claimDeadline && s.myClaim) {
        total = CLAIM_MS;
        deadline = s.claimDeadline;
        mine = true;
        label = '碰 / 杠 / 胡 请选择';
      }
      if (!deadline) { wrap.style.display = 'none'; return; }
      var remain = deadline - Date.now();
      if (remain < 0) remain = 0;
      var secs = Math.ceil(remain / 1000);
      wrap.style.display = 'flex';
      bar.style.width = Math.max(0, Math.min(100, remain / total * 100)) + '%';
      var urgent = remain <= 5000;
      bar.className = 'turn-timer-bar' + (mine ? ' mine' : '') + (urgent ? ' urgent' : '');
      txt.className = 'turn-timer-text' + (mine ? ' mine' : '') + (urgent ? ' urgent' : '');
      txt.textContent = label + ' · 剩 ' + secs + ' 秒';
    }
  };

  // ============ net（WebSocket 连接层） ============
  var net = {
    connect: function () {
      // 先关闭旧连接，防止旧 onclose 触发额外重连循环
      if (online.ws) {
        online.ws.onclose = null;
        online.ws.onerror = null;
        try { online.ws.close(); } catch (e) {}
      }
      if (online.reconnectTimer) { clearTimeout(online.reconnectTimer); online.reconnectTimer = null; }
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      online.wsUrl = proto + '//' + location.host + '/ws';
      try {
        online.ws = new WebSocket(online.wsUrl);
      } catch (e) {
        ui.toast('WebSocket 创建失败', 'error');
        return;
      }
      online.ws.onopen = function () {
        ui.hideDisconnect();
        online.reconnectCount = 0;
        ui.setLobbyStatus('已连接服务器，请创建或加入房间');
        // 注意：hello 收到后再尝试恢复，不在 onopen 处理
        // 因为 sessionId 必须由服务端 hello 给出，且恢复路径走 recover_session
      };
      online.ws.onmessage = net._onMessage;
      online.ws.onclose = function () {
        if (online.disconnected) return; // 已在重连流程
        net._scheduleReconnect();
      };
      online.ws.onerror = function () {
        // 错误后通常紧跟 onclose，由 onclose 处理重连
      };
    },

    _scheduleReconnect: function () {
      if (online.reconnectCount >= online.maxReconnect) {
        ui.showDisconnect('重连失败，请刷新页面');
        return;
      }
      online.reconnectCount++;
      ui.showDisconnect('网络断开，3 秒后重连（' + online.reconnectCount + '/' + online.maxReconnect + '）…');
      if (online.reconnectTimer) clearTimeout(online.reconnectTimer);
      online.reconnectTimer = setTimeout(function () {
        net.connect();
      }, 3000);
    },

    send: function (type, payload) {
      if (!online.ws || online.ws.readyState !== 1) {
        ui.toast('未连接服务器', 'error');
        return false;
      }
      var msg = Object.assign({ type: type }, payload || {});
      try {
        online.ws.send(JSON.stringify(msg));
        return true;
      } catch (e) {
        ui.toast('发送失败', 'error');
        return false;
      }
    },

    _onMessage: function (raw) {
      var m;
      try { m = JSON.parse(raw.data); } catch (e) { return; }
      switch (m.type) {
        case 'hello':
          online.sessionId = m.sessionId;
          // 启用 lobby 按钮：btnJoin 只要 nick 填了就能用；btnCreate 要 nick + pwd 都填了才启用
          var btnJoin = document.getElementById('btnJoinRoom');
          if (btnJoin) btnJoin.disabled = false;
          // btnCreate 的启用交给 initDomSetup 里的 nickInput + pwdInput 的 input 事件来控制
          // 阶段D 步骤1：尝试用 localStorage 里的旧 session 恢复房间
          try {
            var saved = localStorage.getItem('mj_online_session');
            console.log('[online] hello received, sessionId=' + m.sessionId + ', saved=' + saved);
            if (saved) {
              var data = JSON.parse(saved);
              if (data && data.sessionId && data.sessionId !== online.sessionId) {
                // 旧 sessionId 与本连接不同 → 走恢复
                if (data.nick) online._nickName = data.nick;
                console.log('[online] 发送 recover_session, oldSid=' + data.sessionId);
                net.send('recover_session', { oldSessionId: data.sessionId, name: data.nick || undefined });
                ui.setLobbyStatus('正在恢复上次房间…');
                return;
              }
            }
          } catch (e) { console.log('[online] hello recover 异常: ' + e.message); }
          break;
        case 'room_created':
        case 'room_joined':
          online.roomId = m.roomId;
          online.mySeat = m.seat;
          // 房主卡倒计时：创建房时服务器回 cardExpiry；加房时从后续 state 快照里拿
          if (m.cardExpiry) online._cardExpiry = m.cardExpiry;
          ui.updateCardCountdown(online._cardExpiry || 0);
          // 显示房号
          var ridEl = document.getElementById('displayRoomId');
          if (ridEl) ridEl.textContent = m.roomId;
          var barRid = document.getElementById('barRoomId');
          if (barRid) barRid.textContent = m.roomId;
          var barSeat = document.getElementById('barMySeat');
          if (barSeat) barSeat.textContent = '座位 ' + m.seat;
          // 显示 房内大厅
          var roomCard = document.getElementById('roomCard');
          if (roomCard) roomCard.style.display = 'block';
          // 立即按最新 mySeat 重算 isOwner 并刷新 lobby（避免按钮残留 disabled）
          if (online.room && online.room.ownerSeat === online.mySeat) online.isOwner = true;
          else online.isOwner = false;
          render.lobbyView();
          // 阶段D 步骤1：写 localStorage 持久化
          try {
            localStorage.setItem('mj_online_session', JSON.stringify({
              sessionId: online.sessionId, roomId: online.roomId,
              mySeat: online.mySeat, nick: online._nickName || ''
            }));
          } catch (e) {}
          break;
        case 'room_recovered':
          online.roomId = m.roomId;
          online.mySeat = m.seat;
          online.sessionId = m.sessionId || online.sessionId;
          var ridR = document.getElementById('displayRoomId');
          if (ridR) ridR.textContent = m.roomId;
          var barRidR = document.getElementById('barRoomId');
          if (barRidR) barRidR.textContent = m.roomId;
          var barSeatR = document.getElementById('barMySeat');
          if (barSeatR) barSeatR.textContent = '座位 ' + m.seat;
          var roomCardR = document.getElementById('roomCard');
          if (roomCardR) roomCardR.style.display = 'block';
          ui.toast('已恢复上次座位', 'ok');
          // 阶段D步骤1：写 localStorage 持久化（刷新后也能恢复）
          try {
            localStorage.setItem('mj_online_session', JSON.stringify({
              sessionId: online.sessionId, roomId: online.roomId,
              mySeat: online.mySeat, nick: online._nickName || ''
            }));
          } catch (e) {}
          break;
        case 'event':
          // 房间状态 / 增量事件
          if (m.evt === 'room_state') {
            state.applyRoomState(m.detail);
            render.lobbyView();
          } else if (m.evt === 'room_expired') {
            // 房间 6 小时到期：弹窗提示（结算画面在下层，不影响看结果）
            ui.showRoomExpired();
          } else {
            if (m.evt === 'auto_action') ui.onAutoAction(m.detail);
            // 先更新红雾等画面状态并重绘；声音等紧跟其后的 state 快照应用后再播，
            // 避免"声音先响、牌还没打出来"的错位
            sfx.applyState(m.evt, m.detail);
            render.all();
            online._pendingSfx = { evt: m.evt, detail: m.detail };
            // 兜底：万一该事件后没有 state 快照，30ms 后照播，不丢声音
            setTimeout(function () {
              if (online._pendingSfx) {
                var p = online._pendingSfx;
                online._pendingSfx = null;
                sfx.play(p.evt, p.detail);
              }
            }, 30);
          }
          break;
        case 'state':
          var fxRes = state.apply(m.state);
          render.all();
          // 房主卡倒计时：每个 state 快照都带权威时间戳，所有玩家同步
          if (m.state && m.state.cardExpiry) {
            online._cardExpiry = m.state.cardExpiry;
            ui.updateCardCountdown(m.state.cardExpiry);
          }
          // 画面已更新为最新快照，此时再播放事件声音，声画基本同步
          if (online._pendingSfx) {
            var pend = online._pendingSfx;
            online._pendingSfx = null;
            sfx.play(pend.evt, pend.detail);
          }
          if (fxRes && fxRes.lightning) triggerLightning();
          break;
        case 'error':
          ui.toast(translateErr(m.code) || m.msg || m.code, 'error');
          // 阶段D 步骤1：session.invalid 表示旧会话已失效，清 localStorage 避免循环重试
          if (m.code === 'session.invalid') {
            try { localStorage.removeItem('mj_online_session'); } catch (e) {}
            ui.setLobbyStatus('已连接服务器，请创建或加入房间');
          }
          // 房间到期：清会话、隐藏到期弹窗、回大厅
          if (m.code === 'room.expired') {
            try { localStorage.removeItem('mj_online_session'); } catch (e) {}
            var em = document.getElementById('expiredModal');
            if (em) em.style.display = 'none';
            online.roomId = null;
            online.mySeat = -1;
            online.room = null;
            online.cur = null;
            ui.showLobby();
            ui.setLobbyStatus('房间时间已到，请使用新房主卡重新开房');
          }
          break;
        case 'pong':
          break;
      }
    }
  };

  function translateErr(code) {
    var map = {
      'turn.notYours': '没轮到你',
      'tile.notInHand': '手里没这张牌',
      'action.invalid': '操作无效',
      'room.notOwner': '只有房主可以',
      'phase.wrong': '当前不能操作',
      'room.full': '房间满座',
      'room.notfound': '房间不存在',
      'room.notFull': '需满 4 人才可开局',
      'room.alreadyStarted': '本局已开始',
      'seat.occupied': '座位已有人',
      'room.notIn': '你不在房间',
      'room.idTaken': '房号已存在',
      'session.invalid': '会话已失效，无法恢复',
      'seat.takenOver': '本局电脑托管中，下一局恢复',
      // 房主卡密码
      'room.pwd.missing': '请输入房主卡密码',
      'room.pwd.invalid': '房主卡密码无效或已使用',
      'room.pwd.used': '房主卡已失效，请联系房主获取新卡',
      'room.expired': '房间时间已到，请使用新房主卡'
    };
    return map[code];
  }

  // ============ state（持有层） ============
  var state = {
    apply: function (snap) {
      if (!snap) return;
      // 闪电标记：只记录、不在此处触发，由消息层在画面重绘后触发（声画同步）
      var fxLightning = false;
      var prevPhase = online.cur ? online.cur.phase : null;
      var prevRound = online.cur ? online.cur.roundNum : 0;
      // 保存 apply 前的 mySeat.lastDraw（用于摸牌鬼牌闪电检测）
      var oldLastDraw = null;
      if (online.cur && online.cur.players && online.mySeat >= 0) {
        var _oldP = online.cur.players[online.mySeat];
        oldLastDraw = _oldP ? _oldP.lastDraw : null;
      }
      online.cur = snap;
      if (online.mySeat < 0 && typeof snap.turn === 'number') {
        // 兜底：state 里没显式给 mySeat，用之前的设置
      }
      // 检测房主身份
      if (online.room && online.room.ownerSeat === online.mySeat) {
        online.isOwner = true;
      } else {
        online.isOwner = false;
      }
      // 起手有鬼牌 → 闪电（新局开始时检测，覆盖起手发牌场景）
      if (snap.phase === 'discard' && snap.roundNum !== prevRound && online.mySeat >= 0) {
        // 阶段E：新局开始清红雾（双保险，避免上一局 mist class 拄留）
        online.mistVictims = [];
        online.mistCaller = null;
        var p = snap.players[online.mySeat];
        if (p) {
          var hasGhost = false;
          if (p.hand && p.hand.indexOf(snap.ghost) >= 0) hasGhost = true;
          if (p.lastDraw && p.lastDraw === snap.ghost) hasGhost = true;
          if (hasGhost) fxLightning = true;
        }
      }
      // 阶段E-3：摸牌摸到鬼 → 闪电（自己刚摸完进入 discard 阶段，lastDraw 新变成鬼）
      // 排除新局开始（已被上面起手检测覆盖），用 oldLastDraw !== ghost 避免同一张鬼牌重复触发
      if (snap.phase === 'discard' && snap.turn === online.mySeat && online.mySeat >= 0
          && snap.roundNum === prevRound) {
        var p2 = snap.players[online.mySeat];
        if (p2 && p2.lastDraw === snap.ghost && oldLastDraw !== snap.ghost) {
          fxLightning = true;
        }
        // 自己摸牌：lastDraw 变化时清除旧选中态，避免红框框在旧位置/未加载图上
        if (p2 && p2.lastDraw && oldLastDraw !== p2.lastDraw) {
          online.selectedIdx = null;
        }
      }
      return { lightning: fxLightning };
    },
    applyRoomState: function (detail) {
      online.room = detail;
      if (detail && detail.ownerSeat === online.mySeat) online.isOwner = true;
      else online.isOwner = false;
      // 满 4 人且 status=playing 时切到桌面
      if (detail && detail.status === 'playing') {
        ui.showTable();
      } else if (detail && detail.status === 'waiting') {
        // 等待中或本局结束回 lobby 大厅
        // 注意：abort 后 status 会变 waiting，但玩家仍可能在桌面 → 用 endData 控制
      }
    }
  };

  // ============ sfx（音效触发） ============
  // ============ 闪电特效 ============
  function triggerLightning() {
    try { if (window.snd && window.snd.lightning) window.snd.lightning(); } catch (e) {}
    var strikeEl = document.getElementById('strikeFx');
    var flashEl = document.getElementById('screenFlash');
    if (strikeEl) strikeEl.style.display = 'block';
    if (flashEl) flashEl.style.display = 'block';
    setTimeout(function () {
      if (strikeEl) strikeEl.style.display = 'none';
      if (flashEl) flashEl.style.display = 'none';
    }, 600);
  }

  // ============ fx（阶段E：抢杠爆火花） ============
  // 给被抢者副露区一闪强红（复用 .mist-meld 呼吸动画，0.6s 后移除，无音效）
  var fx = {
    spark: function (providerSeat) {
      var el = document.getElementById(seatBox('meld', providerSeat));  // 阶段E-2：视角旋转
      if (!el) return;
      el.classList.add('mist-meld');
      setTimeout(function () {
        el.classList.remove('mist-meld');
      }, 600);
    }
  };

  var sfx = {
    // 第一步（重绘前）：只更新红雾等画面状态，保证 render.all 画出最新特效
    applyState: function (evt, detail) {
      detail = detail || {};
      // 阶段E：碰杠红雾状态设置（独立于 snd 是否加载）
      if (evt === 'peng') {
        online.mistVictims = [detail.from];
        online.mistCaller = { seat: detail.seat };
      } else if (evt === 'kong') {
        // 补杠 detail.from = 被补杠来源（原碰者）→ victims=[from]
        // 明杠/暗杠 detail.from = null → victims=[]
        online.mistVictims = (detail.from != null) ? [detail.from] : [];
        online.mistCaller = { seat: detail.seat };
      } else if (evt === 'discard') {
        // 被碰杠者出牌即散雾
        online.mistVictims = [];
        online.mistCaller = null;
      }
    },
    // 第二步（重绘后）：播放声音、触发瞬时视觉特效
    play: function (evt, detail) {
      detail = detail || {};
      // 阶段E：抢杠爆火花（无音效，独立于 snd；需在 render.melds 建好节点后）
      if (evt === 'hu' && detail.robKong) {
        var provider = (detail.provider != null) ? detail.provider
          : (online.mistCaller ? online.mistCaller.seat : null);
        if (provider != null) fx.spark(provider);
      }
      if (!window.snd) return;
      try {
        switch (evt) {
          case 'discard':
            if (window.snd.tile) window.snd.tile(detail.tile);
            break;
          case 'peng':
            // 先读被碰的牌，再喊"碰"（出牌先、碰后；延迟 350ms 让牌名先播完）
            if (detail.tile && window.snd.tile) window.snd.tile(detail.tile);
            if (window.snd.peng) setTimeout(function () { window.snd.peng(); }, 350);
            break;
          case 'kong':
            // 先读被杠的牌，再喊"杠"（出牌先、杠后；延迟 350ms 让牌名先播完）
            if (detail.tile && window.snd.tile) window.snd.tile(detail.tile);
            if (window.snd.gang) setTimeout(function () { window.snd.gang(); }, 350);
            break;
          case 'hu':
            if (detail.isSelfDraw && window.snd.zimo) window.snd.zimo();
            else if (window.snd.hu) window.snd.hu();
            // 鬼牌胡牌 → 闪电
            if (online.cur && online.cur.endData && online.cur.endData.winnerHasGhost) {
              triggerLightning();
            }
            if (online.cur && online.cur.endData && window.snd.fanVoice) {
              setTimeout(function () {
                if (window.snd.fanVoice) window.snd.fanVoice(online.cur.endData.fan);
              }, 300);
            }
            break;
          default:
            break;
        }
      } catch (e) {}
    }
  };

  // ============ render（渲染层） ============
  var render = {
    all: function () {
      var s = online.cur;
      if (!s) {
        render.lobbyView();
        return;
      }
      // 切视图：phase !== 'idle' 且 phase !== 'end'(无 endData) 时显示桌面
      if (s.phase && s.phase !== 'idle') {
        ui.showTable();
      }
      render.turnInfo();
      render.deckInfo();
      render.roundInfo();
      render.ghostDisplay();
      render.seatInfos();
      render.myHand();
      // 阶段E-2：aiHand 遍历真实座位 0-3，跳过自己的手牌（由 myHand 渲染）
      for (var _abs = 0; _abs < 4; _abs++) {
        if (_abs !== online.mySeat) render.aiHand(_abs);
      }
      // 阶段E-2：pond/melds 同样遍历 4 个真实座位，内部用 seatBox 映射 DOM
      for (var _p = 0; _p < 4; _p++) render.pond(_p);
      for (var _m = 0; _m < 4; _m++) render.melds(_m);
      render.actionBar();
      render.endModal();
      render.mist();
    },

    // 阶段E：碰杠红雾呼吸（复刻单机 updateMist，基于 online.mistVictims/mistCaller + state.cur）
    // 注意：必须在 render.melds 之后调用——render.melds 重建 .meld 子节点会清掉 mist-meld
    mist: function () {
      var s = online.cur;
      if (!s || !s.players) return;
      // 阶段E-2：视角旋转——遍历真实座位号，用 relSeat 映射 DOM（不再硬编码 handEls[i]）
      for (var i = 0; i < 4; i++) {
        var r = relSeat(i);
        var isVictim = online.mistVictims.indexOf(i) >= 0;
        var hEl = document.getElementById(SEAT_BOXES.hand[r]);
        if (hEl) hEl.classList.toggle('mist-area', isVictim);
        var pEl = document.getElementById(SEAT_BOXES.pond[r]);
        if (pEl) pEl.classList.toggle('mist-area', isVictim);
        var mEl = document.getElementById(SEAT_BOXES.meld[r]);
        if (mEl) {
          mEl.classList.toggle('mist-area', isVictim);
          // 先清掉所有 .meld 上的 mist-meld（render.melds 重建 DOM 后必重新挂）
          var groups = mEl.querySelectorAll('.meld');
          for (var g = 0; g < groups.length; g++) groups[g].classList.remove('mist-meld');
          // 给碰杠者最新那组副露叠红雾（meldIdx = melds.length - 1）
          if (online.mistCaller && online.mistCaller.seat === i) {
            var idx = (s.players[i].melds || []).length - 1;
            if (groups[idx]) groups[idx].classList.add('mist-meld');
          }
        }
      }
    },

    turnInfo: function () {
      var s = online.cur; if (!s) return;
      var el = document.getElementById('turnInfo');
      if (!el) return;
      var txt = '';
      if (s.phase === 'end') {
        txt = '本局结束';
      } else if (s.phase === 'discard') {
        txt = (s.turn === online.mySeat) ? '该你出牌' : '等 ' + seatName(s.turn) + ' 出牌';
      } else if (s.phase === 'claim') {
        txt = '等 claim 决策';
      } else if (s.phase === 'idle') {
        txt = '等待开局';
      }
      el.textContent = txt;
    },

    deckInfo: function () {
      var s = online.cur; if (!s) return;
      var el = document.getElementById('deckInfo');
      if (el) el.textContent = '剩 ' + (s.deckRemain || 0) + ' 张';
    },

    roundInfo: function () {
      var s = online.cur; if (!s) return;
      var el = document.getElementById('roundInfo');
      if (el) el.textContent = '第 ' + (s.roundNum || 1) + ' 局';
    },

    ghostDisplay: function () {
      var s = online.cur; if (!s) return;
      var wrap = document.getElementById('ghostDisplay');
      var img = document.getElementById('ghostImg');
      if (!wrap || !img) return;
      if (s.ghost) {
        wrap.style.display = 'block';
        img.src = tileImgSrc(s.ghost);
        img.alt = '鬼牌 ' + s.ghost;
      } else {
        wrap.style.display = 'none';
      }
    },

    seatInfos: function () {
      var s = online.cur; if (!s || !s.players) return;
      var roomSeats = online.room && online.room.seats;
      for (var i = 0; i < 4; i++) {
        var p = s.players[i];
        if (!p) continue;
        // 阶段E-2：DOM id 是固定屏幕位置（seat0=底部/自己, seat1=右, seat2=上, seat3=左）
        // 真实座位号 i → 屏幕位置 relSeat(i) → 对应 DOM
        var r = relSeat(i);
        var nameEl = document.getElementById(SEAT_BOXES.seat[r]);
        var ptsEl = document.getElementById(SEAT_BOXES.pts[r]);
        // 机器人座位显示机器人名字
        var isBot = roomSeats && roomSeats[i] && roomSeats[i].isBot;
        if (nameEl) nameEl.textContent = isBot ? (roomSeats[i].name || seatName(i)) : (p.name || seatName(i));
        if (ptsEl) ptsEl.textContent = p.points;
        // 阶段D步骤3：本局电脑接管角标
        var autoEl = document.getElementById(SEAT_BOXES.auto[r]);
        if (autoEl) autoEl.style.display = (s.takenOver && s.takenOver[i]) ? 'inline-block' : 'none';
      }
    },

    myHand: function () {
      var s = online.cur;
      if (!s || online.mySeat < 0) return;
      var p = s.players[online.mySeat];
      if (!p) return;
      var box = document.getElementById('myHand');
      if (!box) return;
      box.innerHTML = '';
      var hand = p.hand || [];
      var lastDraw = p.lastDraw;
      // 渲染手牌
      for (var i = 0; i < hand.length; i++) {
        box.appendChild(render._mkTile(hand[i], i, false));
      }
      // lastDraw 单独渲染（带 last-draw class 产生间距）
      if (lastDraw) {
        box.appendChild(render._mkTile(lastDraw, -2, true));
      }
      // 更新选中态（加在 hand-tile div 上，匹配 game.css）
      if (online.selectedIdx !== null) {
        var sel = box.querySelector('.hand-tile[data-idx="' + online.selectedIdx + '"]');
        if (sel) sel.classList.add('selected');
      }
    },

    // 轻量选中态切换：只改 class，不重建 DOM，杜绝选牌时整排牌抖动/漂移
    updateSelection: function () {
      var box = document.getElementById('myHand');
      if (!box) return;
      var tiles = box.querySelectorAll('.hand-tile');
      for (var i = 0; i < tiles.length; i++) {
        var el = tiles[i];
        var isSel = (online.selectedIdx !== null && el.getAttribute('data-idx') === String(online.selectedIdx));
        if (isSel) el.classList.add('selected');
        else el.classList.remove('selected');
      }
    },

    aiHand: function (seat) {
      var s = online.cur;
      if (!s || !s.players || !s.players[seat]) return;
      var cnt = s.players[seat].handCount || 0;
      var boxId = seatBox('hand', seat);  // 阶段E-2：视角旋转
      if (!boxId) return;
      var box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = '';
      for (var i = 0; i < cnt; i++) {
        var div = document.createElement('div');
        div.className = 'mj-back';
        box.appendChild(div);
      }
    },

    pond: function (seat) {
      var s = online.cur;
      if (!s || !s.players || !s.players[seat]) return;
      var disp = s.players[seat].disp || [];
      var boxId = seatBox('pond', seat);  // 阶段E-2：视角旋转
      var box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = '';
      disp.forEach(function (t) {
        var img = document.createElement('img');
        img.className = 'mj pond-tile';
        img.src = tileImgSrc(t);
        img.alt = t;
        box.appendChild(img);
      });
    },

    melds: function (seat) {
      var s = online.cur;
      if (!s || !s.players || !s.players[seat]) return;
      var melds = s.players[seat].melds || [];
      var boxId = seatBox('meld', seat);  // 阶段E-2：视角旋转
      var box = document.getElementById(boxId);
      if (!box) return;
      box.innerHTML = '';
      if (melds.length === 0) {
        box.classList.remove('warn3');
        box.style.setProperty('display', 'none', 'important');
        return;
      }
      box.style.removeProperty('display');
      // 九张警示：碰/杠满3组即亮
      var warn3 = melds.length >= 3;
      box.classList.toggle('warn3', warn3);
      melds.forEach(function (m) {
        var grp = document.createElement('div');
        grp.className = 'meld meld-wrap';
        if (m.type === 'kong') grp.classList.add('meld-kong');
        // 文字标签（暗杠/明杠/公杠/碰）+ 三角箭头
        var labelText = '';
        if (m.kind === 'ag') labelText = '暗杠';
        else if (m.kind === 'mg') labelText = '明杠';
        else if (m.kind === 'bg') labelText = '公杠';
        else if (m.kind === 'peng') labelText = '碰';
        var arrowDir = '';
        if (m.from != null) {
          // 和 game.js _meldArrow 同逻辑
          var dirMap = [
            [null, 'right', 'top', 'left'],    // seat 0
            ['bottom', null, 'top', 'left'],   // seat 1
            ['bottom', 'right', null, 'left'], // seat 2
            ['bottom', 'right', 'top', null]   // seat 3
          ];
          arrowDir = dirMap[seat][m.from] || '';
        }
        // 自己的副露：label+arrow 塞进 my-m-label
        if (seat === online.mySeat) {
          var mLbl = document.createElement('div');
          mLbl.className = 'm-label my-m-label';
          if (labelText) {
            var mlText = document.createElement('span');
            mlText.className = 'ml-text';
            mlText.textContent = labelText;
            mLbl.appendChild(mlText);
          }
          if (arrowDir) {
            var mlArrow = document.createElement('span');
            mlArrow.className = 'ml-arrow ml-arrow-' + arrowDir;
            mLbl.appendChild(mlArrow);
          }
          if (mLbl.children.length) grp.appendChild(mLbl);
        } else {
          // 其他三家：独立 m-label + m-arrow
          if (labelText) {
            var aLbl = document.createElement('div');
            aLbl.className = 'm-label';
            aLbl.textContent = labelText;
            grp.appendChild(aLbl);
          }
          if (arrowDir) {
            var aArrow = document.createElement('div');
            aArrow.className = 'm-arrow m-arrow-' + arrowDir;
            grp.appendChild(aArrow);
          }
        }
        var tilesRow = document.createElement('div');
        tilesRow.className = 'tiles-row';
        m.tiles.forEach(function (t) {
          var img = document.createElement('img');
          img.className = 'mj';
          img.src = tileImgSrc(t);
          img.alt = t;
          tilesRow.appendChild(img);
        });
        grp.appendChild(tilesRow);
        box.appendChild(grp);
      });
      if (warn3) {
        var tag = document.createElement('span');
        tag.className = 'warn3-tag';
        tag.textContent = '九张';
        box.appendChild(tag);
      }
    },

    actionBar: function () {
      var s = online.cur;
      if (!s) return;
      var isMyTurn = s.phase === 'discard' && s.turn === online.mySeat;
      // 胡
      var btnHu = document.getElementById('btnHu');
      var btnKong = document.getElementById('btnKong');
      var btnPeng = document.getElementById('btnPeng');
      var btnPass = document.getElementById('btnPass');
      var btnPlay = document.getElementById('btnPlay');

      // 阶段D步骤3：本局已被电脑接管 → 隐藏操作按钮，显示"解除托管"按钮
      if (s.takenOver && s.takenOver[online.mySeat]) {
        [btnHu, btnKong, btnPeng, btnPass, btnPlay].forEach(function (b) { if (b) { b.style.display = 'none'; b.disabled = true; } });
        if (btnPlay) btnPlay.classList.remove('lit');
        var bar0 = document.getElementById('actionBar');
        if (bar0) bar0.style.visibility = 'visible';
        var tip0 = document.getElementById('tipLine');
        var tipText0 = document.getElementById('tipText');
        if (tip0 && tipText0) {
          tip0.style.display = 'block';
          tipText0.textContent = '电脑托管中 · 点下方按钮恢复你的操作';
        }
        // 显示解除托管按钮
        var btnCancel = document.getElementById('btnCancelTakeover');
        if (btnCancel) {
          btnCancel.style.display = 'inline-block';
          btnCancel.onclick = action.onCancelTakeover;
        }
        return;
      }
      // 非托管状态：隐藏解除托管按钮，显示正常操作按钮
      var btnCancelHide = document.getElementById('btnCancelTakeover');
      if (btnCancelHide) btnCancelHide.style.display = 'none';
      [btnHu, btnKong, btnPeng, btnPass, btnPlay].forEach(function (b) { if (b) b.style.display = ''; });
      if (btnHu) btnHu.disabled = !(s.myCanHu || (s.myClaim && s.myClaim.hu));
      // 杠
      var btnKong = document.getElementById('btnKong');
      var canKong = false;
      if (isMyTurn && s.myKongOptions && s.myKongOptions.length > 0) canKong = true;
      if (s.myClaim && s.myClaim.kong) canKong = true;
      if (btnKong) btnKong.disabled = !canKong;
      // 碰
      var btnPeng = document.getElementById('btnPeng');
      if (btnPeng) btnPeng.disabled = !(s.myClaim && s.myClaim.peng);
      // 过
      var btnPass = document.getElementById('btnPass');
      var canPass = !!s.myClaim;
      if (btnPass) btnPass.disabled = !canPass;
      // 打出
      var btnPlay = document.getElementById('btnPlay');
      if (btnPlay) btnPlay.disabled = !(isMyTurn && online.selectedIdx !== null);

      // 提示
      var tip = document.getElementById('tipLine');
      var tipText = document.getElementById('tipText');
      if (tip && tipText) {
        var msg = '';
        if (s.myClaim) {
          var bits = [];
          if (s.myClaim.peng) bits.push('可碰');
          if (s.myClaim.kong) bits.push('可杠(' + s.myClaim.kind + ')');
          if (s.myClaim.robKong) bits.push('可抢杠胡');
          if (s.myClaim.hu) bits.push('可胡');
          msg = bits.length ? bits.join(' · ') + '（碰/杠/胡/过 选一个）' : '';
        } else if (isMyTurn && s.myCanHu) {
          msg = '★ 你可自摸胡！';
        } else if (isMyTurn && s.myKongOptions && s.myKongOptions.length) {
          msg = '★ 你可自杠（点杠按钮）';
        }
        if (msg) { tip.style.display = 'block'; tipText.textContent = msg; }
        else { tip.style.display = 'none'; }
      }

      // 按钮区显示/隐藏：全禁用→隐藏，任一可用→显示
      var bar = document.getElementById('actionBar');
      if (bar) {
        var allDisabled = [btnHu, btnKong, btnPeng, btnPass, btnPlay].every(function (b) { return !b || b.disabled; });
        bar.style.visibility = allDisabled ? 'hidden' : 'visible';
      }
    },

    endModal: function () {
      var s = online.cur; if (!s) return;
      var modal = document.getElementById('endModal');
      if (!modal) return;
      if (s.phase !== 'end' || !s.endData) {
        modal.style.display = 'none';
        return;
      }
      modal.style.display = 'flex';
      var e = s.endData;
      var tEl = document.getElementById('endTitle');
      var fEl = document.getElementById('endFan');
      var pEl = document.getElementById('endPayText');
      var tbl = document.getElementById('endTable');

      // tile code → 中文名
      var Z_NAMES = ['', '东', '南', '西', '北', '中', '发', '白'];
      function tileName(code) {
        if (!code || code === 'ghost') return '鬼';
        var suit = code[0];
        var num = parseInt(code.slice(1));
        if (suit === 'Z') return Z_NAMES[num] || code;
        var sn = suit === 'W' ? '万' : suit === 'T' ? '条' : '筒';
        return sn + num;
      }
      function isHuSeat(i) {
        if (e.draw) return false;
        if (e.multiHu) return e.winners.some(function (w) { return w.seat === i; });
        return e.winner === i;
      }

      // ===== 顶部区 =====
      if (e.aborted) {
        if (tEl) tEl.textContent = '本局已中止';
        if (fEl) fEl.style.display = 'none';
        if (pEl) { pEl.textContent = '已回退到本局开始前积分'; pEl.style.display = 'block'; }
      } else if (e.draw) {
        if (tEl) tEl.textContent = '荒 庄';
        if (fEl) fEl.style.display = 'none';
        if (pEl) { pEl.textContent = '所有分数不计（含杠分）'; pEl.style.display = 'block'; }
      } else if (e.multiHu) {
        if (tEl) tEl.textContent = '抢 杠 胡 · ' + e.winners.length + ' 家胡牌';
        if (fEl) {
          fEl.innerHTML = e.winners.map(function (w) {
            return seatName(w.seat) + ' ' + w.name + ' · 共 ' + w.total + ' 分';
          }).join('<br>');
          fEl.style.display = 'block';
        }
        if (pEl) { pEl.textContent = e.payText || ''; pEl.style.display = e.payText ? 'block' : 'none'; }
      } else {
        if (tEl) tEl.textContent = (e.winner === online.mySeat ? '你' : seatName(e.winner)) + ' 胡 牌';
        if (fEl) {
          if (e.total && e.fan) {
            fEl.textContent = e.name + ' · 共 ' + e.total + ' 分';
          } else {
            fEl.textContent = e.name + ' ' + e.fan + ' 番';
          }
          fEl.style.display = 'block';
        }
        if (pEl) { pEl.textContent = e.payText || ''; pEl.style.display = e.payText ? 'block' : 'none'; }
      }

      // ===== 结算表 + 四家牌面 + 本局明细 =====
      if (tbl) {
        var html = '';
        // 4 家结算表
        for (var i = 0; i < 4; i++) {
          var sc = (e.scores && e.scores[i]) || 0;
          var cum = (e.points && e.points[i]) || 0;
          var isWin = isHuSeat(i);
          var rowClass = 'mt-row' + (isWin ? ' mt-winner' : '');
          html += '<div class="' + rowClass + '">';
          html += '<div class="mt-name"><span class="mt-name-text">' + seatName(i) + '</span>';
          if (isWin) html += '<span class="mt-winner-badge">胡</span>';
          html += '</div>';
          html += '<div class="mt-pay">';
          if (e.draw && sc === 0) {
            html += '<span class="mt-pay-num zero">—</span>';
          } else {
            html += '<span class="mt-pay-num ' + (sc > 0 ? 'pos' : sc < 0 ? 'neg' : 'zero') + '">' + (sc > 0 ? '+' : '') + sc + '</span>';
          }
          html += '</div>';
          html += '<div class="mt-cum"><span class="mt-cum-num">' + cum + '</span></div>';
          html += '</div>';
        }

        // 杠分明细预收集
        var gangDetails = [];
        if (e.pendingScores) {
          var merged = {};
          e.pendingScores.forEach(function (ps) {
            if (ps.score <= 0) return;
            var k = ps.kind + '_' + ps.seat + '_' + (ps.tile || '');
            if (!merged[k]) {
              merged[k] = { kind: ps.kind, seat: ps.seat, tile: ps.tile, fromSeat: ps.fromSeat, text: ps.text, score: 0 };
            }
            merged[k].score += ps.score;
          });
          gangDetails = Object.keys(merged).map(function (k) { return merged[k]; });
        }
        var hasDetail = gangDetails.length > 0 || !e.draw;

        // 四家牌面区
        html += '<div class="m-hands">';
        html += '<div class="m-hands-title">四 家 牌 面</div>';
        for (var h = 0; h < 4; h++) {
          var hMelds = (e.melds && e.melds[h]) || [];
          var hHand = (e.hands && e.hands[h]) || [];
          html += '<div class="mh-row">';
          var labelTxt = isHuSeat(h) ? '<span class="mh-hu-tag">胡牌</span>' : '手牌';
          html += '<div class="mh-label"><span class="mh-name">' + seatName(h) + '</span>' + labelTxt + '</div>';
          html += '<div class="mh-tiles">';
          // 副露
          hMelds.forEach(function (m, mi) {
            var gClass = m.type === 'kong' ? 'mh-group kong' : m.type === 'peng' ? 'mh-group peng' : 'mh-group chi';
            if (mi > 0) html += '<span style="display:inline-block;width:8px"></span>';
            html += '<div class="' + gClass + '">';
            m.tiles.forEach(function (t) {
              var isG = t === e.ghost;
              var gCls = isG ? 'mh-tile ghost' : 'mh-tile';
              if (isG) {
                html += '<span class="mh-ghost-wrap"><img class="' + gCls + '" src="' + tileImgSrc(t) + '"><span class="mh-ghost-badge">鬼</span></span>';
              } else {
                html += '<img class="' + gCls + '" src="' + tileImgSrc(t) + '">';
              }
            });
            html += '</div>';
          });
          if (hMelds.length > 0 && hHand.length > 0) {
            html += '<span style="display:inline-block;width:8px"></span>';
          }
          // 手牌
          var winIdx = (h === e.winner && e.winTile) ? hHand.lastIndexOf(e.winTile) : -1;
          hHand.forEach(function (t, ti) {
            var isWinTile = (ti === winIdx);
            var isGhostTile = (t === e.ghost);
            var hCls = isGhostTile ? 'mh-tile ghost' : 'mh-tile';
            var ghostBadge = isGhostTile ? '<span class="mh-ghost-badge">鬼</span>' : '';
            if (isWinTile) {
              if (e.isSelfDraw) {
                html += '<span class="mh-win-selfdraw"><img class="' + hCls + '" src="' + tileImgSrc(t) + '">' + ghostBadge + '<span class="mh-win-label">自摸</span></span>';
              } else {
                html += '<span class="mh-win-tile"><img class="' + hCls + '" src="' + tileImgSrc(t) + '">' + ghostBadge + '<span class="mh-win-label">胡</span></span>';
              }
            } else if (isGhostTile) {
              html += '<span class="mh-ghost-wrap"><img class="' + hCls + '" src="' + tileImgSrc(t) + '">' + ghostBadge + '</span>';
            } else {
              html += '<img class="' + hCls + '" src="' + tileImgSrc(t) + '">';
            }
          });
          html += '</div></div>';
        }
        html += '</div>';

        // 本局明细区
        if (hasDetail) {
          html += '<div class="m-detail">';
          html += '<div class="m-detail-title">本 局 明 细</div>';
          gangDetails.forEach(function (ps) {
            var kindLabel = ps.kind === 'ag' ? '暗杠' : ps.kind === 'bg' ? '公杠' : '明杠';
            var kindTag = 'tag-' + ps.kind;
            var tileNm = tileName(ps.tile);
            var whoGang = seatName(ps.seat);
            var whoPay = ps.kind === 'mg' ? seatName(ps.fromSeat) : null;
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
          if (!e.draw && e.multiHu) {
            e.winners.forEach(function (w) {
              html += '<div class="dl-row">';
              html += '<div class="dl-left">';
              html += '<span class="tag tag-hu">胡</span>';
              html += '<span class="hl">' + seatName(w.seat) + '</span> ' + w.name + ' · 共' + w.total + '分';
              if (e.huPayer !== undefined) html += ' · 抢杠胡（<span class="hl">' + seatName(e.huPayer) + '</span>包）';
              html += '</div>';
              html += '<div class="dl-right pos">+' + w.total + '</div>';
              html += '</div>';
            });
          } else if (!e.draw) {
            var huSign = e.total >= 0 ? '+' : '';
            html += '<div class="dl-row">';
            html += '<div class="dl-left">';
            html += '<span class="tag tag-hu">胡</span>';
            html += '<span class="hl">' + seatName(e.winner) + '</span> ' + e.name + ' · 共' + e.total + '分';
            if (e.payText) html += ' · ' + e.payText;
            html += '</div>';
            html += '<div class="dl-right pos">' + huSign + e.total + '</div>';
            html += '</div>';
          }
          html += '</div>';
        }

        tbl.innerHTML = html;
        var innerModal = modal.querySelector('.end-modal') || modal.querySelector('.modal');
        if (innerModal) innerModal.scrollTop = 0;
      }

      // 下一局按钮：只有房主可点
      var btnNext = document.getElementById('btnNextRound');
      if (btnNext) btnNext.disabled = !online.isOwner;
    },

    lobbyView: function () {
      var room = online.room;
      var grid = document.getElementById('seatsGrid');
      var statusText = document.getElementById('roomStatusText');
      var btnStart = document.getElementById('btnStartRound');
      var btnAbort = document.getElementById('btnAbortRound');
      if (!grid) return;
      grid.innerHTML = '';
      var seats = (room && room.seats) || [null, null, null, null];
      var takenCount = 0, botCount = 0;
      for (var i = 0; i < 4; i++) {
        var s = seats[i];
        var card = document.createElement('div');
        var cls = 'seat-card';
        if (!s) cls += ' empty';
        else { cls += ' taken'; takenCount++; if (s.isBot) botCount++; }
        if (i === online.mySeat) cls += ' me';
        card.className = cls;
        var inner = '<div class="seat-idx">' + i + '</div>';
        if (s) {
          inner += '<div class="seat-info-text">';
          inner += '<div class="seat-name-text">' + escapeHtml(s.name || '玩家' + i) + '</div>';
          if (s.isBot) inner += '<span class="bot-tag">机器人</span>';
          else inner += '<div class="seat-state ' + (s.connected ? 'online' : 'offline') + '">' + (s.connected ? '在线' : '断线') + '</div>';
          inner += '</div>';
          if (room.ownerSeat === i) inner += '<span class="seat-owner-tag">房主</span>';
          if (s.isBot && online.isOwner && (!room || room.status === 'waiting')) {
            inner += '<button class="btn-rm-bot" data-seat="' + i + '">移除</button>';
          }
        } else {
          inner += '<div class="seat-info-text"><div class="seat-name-text">空位</div>';
          if (online.isOwner && (!room || room.status === 'waiting')) {
            inner += '<button class="btn-add-bot" data-seat="' + i + '">加机器人</button>';
          }
          inner += '</div>';
        }
        card.innerHTML = inner;
        grid.appendChild(card);
      }
      // 绑定加/删机器人按钮
      if (online.isOwner && (!room || room.status === 'waiting')) {
        grid.querySelectorAll('.btn-add-bot').forEach(function (btn) {
          btn.addEventListener('click', function () { action.onAddBot(); });
        });
        grid.querySelectorAll('.btn-rm-bot').forEach(function (btn) {
          btn.addEventListener('click', function () {
            action.onRemoveBot(parseInt(btn.getAttribute('data-seat')));
          });
        });
      }
      // 状态文案
      if (statusText) {
        if (room && room.status === 'playing') statusText.textContent = '游戏进行中…';
        else {
          var realCount = takenCount - botCount;
          statusText.textContent = realCount + '人' + (botCount ? ' + ' + botCount + '机器人' : '') + '（' + takenCount + '/4）';
        }
      }
      // 开局按钮：房主 + 满 4 人（真人+机器人）+ 当前 waiting
      if (btnStart) {
        btnStart.disabled = !(online.isOwner && takenCount === 4 && (!room || room.status === 'waiting'));
      }
      // 中止按钮：房主 + playing
      if (btnAbort) {
        btnAbort.style.display = (online.isOwner && room && room.status === 'playing') ? 'inline-block' : 'none';
      }
    },

    _mkTile: function (t, idx, isLastDraw) {
      var ghost = online.cur ? online.cur.ghost : null;
      var isGhost = (t === ghost);
      var div = document.createElement('div');
      var classes = 'hand-tile';
      if (isLastDraw) classes += ' last-draw';
      if (isGhost) classes += ' ghost-tile';
      div.className = classes;
      div.setAttribute('data-idx', idx);
      div.setAttribute('data-tile', t);
      var img = document.createElement('img');
      img.className = 'mj mj-own';
      img.src = tileImgSrc(t);
      img.alt = t;
      div.appendChild(img);
      if (isGhost) {
        var badge = document.createElement('span');
        badge.className = 'ghost-badge';
        badge.textContent = '鬼';
        div.appendChild(badge);
      }
      div.addEventListener('click', function () {
        action.onTileClick(idx);
      });
      div.addEventListener('dblclick', function () {
        action.onTileDblClick(idx);
      });
      return div;
    }
  };

  // ============ action（玩家操作） ============
  var action = {
    onTileClick: function (idx) {
      var s = online.cur;
      if (!s || s.phase !== 'discard' || s.turn !== online.mySeat) return;
      if (online.disconnected) return;
      if (s.takenOver && s.takenOver[online.mySeat]) return;
      var p = s.players[online.mySeat];
      if (!p) return;
      // 已经选中了这张牌 → 直接打出（代替双击）
      if (online.selectedIdx === idx) {
        var tile, preIdx;
        if (idx === -2) {
          tile = p.lastDraw;
          preIdx = -2;
        } else {
          tile = p.hand[idx];
          preIdx = idx;
        }
        if (!tile) return;
        online.selectedIdx = null;
        render.myHand();
        render.actionBar();
        net.send('discard', { tile: tile, preIdx: preIdx });
        return;
      }
      // 没选中 → 选中（只切换 class，不重绘手牌，避免漂移）
      online.selectedIdx = idx;
      render.updateSelection();
      render.actionBar();
    },

    onTileDblClick: function (idx) {
      var s = online.cur;
      if (!s || s.phase !== 'discard' || s.turn !== online.mySeat) return;
      if (online.disconnected) return;
      if (s.takenOver && s.takenOver[online.mySeat]) return;
      var p = s.players[online.mySeat];
      if (!p) return;
      var tile, preIdx;
      if (idx === -2) {
        tile = p.lastDraw;
        preIdx = -2;
      } else {
        tile = p.hand[idx];
        preIdx = idx;
      }
      if (!tile) return;
      online.selectedIdx = null;
      net.send('discard', { tile: tile, preIdx: preIdx });
    },

    onPlay: function () {
      var s = online.cur;
      if (!s || s.phase !== 'discard' || s.turn !== online.mySeat) return;
      if (online.selectedIdx === null) { ui.toast('请先选一张牌', 'error'); return; }
      var p = s.players[online.mySeat];
      if (!p) return;
      var tile, preIdx;
      if (online.selectedIdx === -2) {
        tile = p.lastDraw;
        preIdx = -2;
      } else {
        tile = p.hand[online.selectedIdx];
        preIdx = online.selectedIdx;
      }
      if (!tile) { ui.toast('选中的牌无效', 'error'); return; }
      net.send('discard', { tile: tile, preIdx: preIdx });
      online.selectedIdx = null;
      render.myHand();
    },

    onCancelTakeover: function () {
      net.send('cancel_takeover', {});
      ui.toast('已解除托管，轮到你时可以正常操作', 'success');
    },

    onPeng: function () {
      net.send('peng', {});
    },

    onKong: function () {
      var s = online.cur;
      if (!s) return;
      // 优先用 myKongOptions（discard 阶段自杠）
      if (s.myKongOptions && s.myKongOptions.length > 0) {
        var k = s.myKongOptions[0];   // MVP：取第一个
        net.send('kong', { kind: k.kind, tile: k.tile });
        return;
      }
      // 否则 claim 阶段明杠
      if (s.myClaim && s.myClaim.kong) {
        net.send('kong', { kind: s.myClaim.kind, tile: s.myClaim.tile });
      }
    },

    onPass: function () {
      net.send('pass', {});
    },
    onAddBot: function () {
      net.send('add_bot', {});
    },
    onRemoveBot: function (seat) {
      net.send('remove_bot', { seat: seat });
    },

    onHu: function () {
      net.send('hu', {});
    },

    onStartRound: function () {
      net.send('start_round', {});
    },

    onNextRound: function () {
      net.send('next_round', {});
      // 关弹窗
      var modal = document.getElementById('endModal');
      if (modal) modal.style.display = 'none';
    },

    onAbortRound: function () {
      if (!confirm('确定中止本局？将荒庄并回退到本局开始前积分。')) return;
      net.send('abort_round', {});
    },

    onCreateRoom: function () {
      var nick = (document.getElementById('nickInput').value || '').trim();
      var pwd = (document.getElementById('pwdInput').value || '').trim();
      if (!pwd) { ui.toast('请先输入房主卡密码', 'error'); return; }
      online._nickName = nick;
      // 从大厅下拉框取底分和总分值（不再读 localStorage）
      var baseScore = parseInt(document.getElementById('baseSelect').value) || 10;
      var initScore = parseInt(document.getElementById('totalSelect').value) || 200;
      net.send('create_room', { name: nick, baseScore: baseScore, initScore: initScore, password: pwd });
      ui.setLobbyStatus('正在创建房间…');
    },

    onJoinRoom: function () {
      var nick = (document.getElementById('nickInput').value || '').trim();
      var rid = (document.getElementById('joinRoomId').value || '').trim();
      if (rid.length !== 6) { ui.toast('房号必须是 6 位', 'error'); return; }
      online._nickName = nick;
      net.send('join_room', { roomId: rid, name: nick });
      ui.setLobbyStatus('正在加入房间 ' + rid + '…');
    },

    onLeaveRoom: function () {
      if (!confirm('确定退出房间？')) return;
      net.send('leave_room', {});
      online.roomId = null;
      online.mySeat = -1;
      online.room = null;
      online.cur = null;
      // 阶段D 步骤1：清 localStorage
      try { localStorage.removeItem('mj_online_session'); } catch (e) {}
      // 回 lobby 主页
      document.getElementById('roomCard').style.display = 'none';
    },

    onBackHome: function () {
      try { localStorage.removeItem('mj_online_session'); } catch (e) {}
      if (online.ws) { try { online.ws.close(); } catch (e) {} }
      location.href = 'index.html';
    },

    // 房间到期弹窗：返回大厅（不弹确认框）
    onExpiredBack: function () {
      net.send('leave_room', {});
      online.roomId = null;
      online.mySeat = -1;
      online.room = null;
      online.cur = null;
      try { localStorage.removeItem('mj_online_session'); } catch (e) {}
      var modal = document.getElementById('expiredModal');
      if (modal) modal.style.display = 'none';
      var endModal = document.getElementById('endModal');
      if (endModal) endModal.style.display = 'none';
      document.getElementById('roomCard').style.display = 'none';
      ui.showLobby();
      ui.setLobbyStatus('房间已结束，请使用新房主卡重新开房');
    }
  };

  // ============ 工具 ============
  // 阶段E-2：视角旋转辅助——把真实座位号(abs)转成"相对屏幕位置"(0=底/自己,1=右/下家,2=上/对家,3=左/上家)
  function relSeat(abs) {
    var mine = online.mySeat;
    if (mine < 0) return abs;   // 未入房时直接返回（兜底）
    return ((abs - mine) % 4 + 4) % 4;
  }
  // 相对位置 → DOM id 映射表（单一入口，收敛所有硬编码）
  var SEAT_BOXES = {
    hand:  ['myHand',    'rightHand', 'topHand',  'leftHand'],
    pond:  ['myPond',    'rightPond', 'topPond',  'leftPond'],
    meld:  ['myMelds',   'rightMelds','topMelds', 'leftMelds'],
    seat:  ['seat0Name', 'seat1Name', 'seat2Name','seat3Name'],
    pts:   ['seat0Points','seat1Points','seat2Points','seat3Points'],
    auto:  ['seat0Auto', 'seat1Auto', 'seat2Auto', 'seat3Auto']
  };
  function seatBox(type, absSeat) {
    return (SEAT_BOXES[type] || [])[relSeat(absSeat)];
  }
  function seatName(seat) {
    // 用相对位置返回屏幕标签（不再用真实座位号）
    var labels = ['你', '右家', '对家', '左家'];
    var r = relSeat(seat);
    return labels[r] || ('座' + seat);
  }
  function tileImgSrc(t) {
    if (!t) return '';
    var name = (window.mj && window.mj.tileImage) ? window.mj.tileImage(t) : t;
    return 'images/' + name + '.png';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ============ 初始化绑定 ============
  function bind() {
    var btnCreate = document.getElementById('btnCreateRoom');
    var btnJoin = document.getElementById('btnJoinRoom');
    var btnLeave = document.getElementById('btnLeaveRoom');
    var btnStart = document.getElementById('btnStartRound');
    var btnAbort = document.getElementById('btnAbortRound');
    var btnPlay = document.getElementById('btnPlay');
    var btnHu = document.getElementById('btnHu');
    var btnKong = document.getElementById('btnKong');
    var btnPeng = document.getElementById('btnPeng');
    var btnPass = document.getElementById('btnPass');
    var btnNextRound = document.getElementById('btnNextRound');
    var btnBackHome = document.getElementById('btnBackHome');
    var btnExpiredBack = document.getElementById('btnExpiredBack');
    var btnBackHomeTop = document.getElementById('btnBackHomeTop');
    var btnLobbyBackHome = document.getElementById('btnLobbyBackHome');
    var nickInput = document.getElementById('nickInput');
    var joinInput = document.getElementById('joinRoomId');
    var pwdInput = document.getElementById('pwdInput');
    var baseSelect = document.getElementById('baseSelect');
    var totalSelect = document.getElementById('totalSelect');

    if (btnCreate) btnCreate.addEventListener('click', action.onCreateRoom);
    if (btnJoin) btnJoin.addEventListener('click', action.onJoinRoom);
    if (btnLeave) btnLeave.addEventListener('click', action.onLeaveRoom);
    if (btnStart) btnStart.addEventListener('click', action.onStartRound);
    if (btnAbort) btnAbort.addEventListener('click', action.onAbortRound);
    if (btnPlay) btnPlay.addEventListener('click', action.onPlay);
    if (btnHu) btnHu.addEventListener('click', action.onHu);
    if (btnKong) btnKong.addEventListener('click', action.onKong);
    if (btnPeng) btnPeng.addEventListener('click', action.onPeng);
    if (btnPass) btnPass.addEventListener('click', action.onPass);
    if (btnNextRound) btnNextRound.addEventListener('click', action.onNextRound);
    if (btnBackHome) btnBackHome.addEventListener('click', action.onBackHome);
    if (btnExpiredBack) btnExpiredBack.addEventListener('click', action.onExpiredBack);
    if (btnBackHomeTop) btnBackHomeTop.addEventListener('click', action.onBackHome);
    if (btnLobbyBackHome) btnLobbyBackHome.addEventListener('click', action.onBackHome);

    // 输入框 Enter 触发对应按钮
    if (nickInput) nickInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); nickInput.blur(); }
    });
    if (joinInput) joinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (btnJoin) btnJoin.click(); }
    });
    if (pwdInput) pwdInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); if (btnCreate && !btnCreate.disabled) btnCreate.click(); }
    });

    // btnCreate 启用逻辑：nick + pwd 都填了才启用
    function checkCreateEnabled() {
      if (!btnCreate) return;
      var hasNick = nickInput && nickInput.value.trim().length > 0;
      var hasPwd = pwdInput && pwdInput.value.trim().length > 0;
      btnCreate.disabled = !(hasNick && hasPwd);
    }
    if (nickInput) nickInput.addEventListener('input', checkCreateEnabled);
    if (pwdInput) pwdInput.addEventListener('input', checkCreateEnabled);

    // 下拉框 change → 同步 createHint 里的底分/总分显示
    function refreshCreateHint() {
      var sb = document.getElementById('showBase');
      var st = document.getElementById('showTotal');
      if (sb) sb.textContent = baseSelect ? baseSelect.value : '10';
      if (st) st.textContent = totalSelect ? totalSelect.value : '200';
    }
    if (baseSelect) baseSelect.addEventListener('change', refreshCreateHint);
    if (totalSelect) totalSelect.addEventListener('change', refreshCreateHint);
  }

  // ============ 启动 ============
  function start() {
    bind();
    ui.showLobby();
    timer.start();   // 阶段D步骤3：倒计时条常驻刷新（无状态时自动隐藏）
    net.connect();
    // 切窗口/切 APP（如回微信）再切回网页时：刷新服务器心跳，若已断开则立即重连
    // 让短暂切后台不算"退出"，只要没关浏览器就保持在线
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (online.ws && online.ws.readyState === 1) {
        // 连接仍活着：立即发 ping 刷新服务器心跳，避免被 90s 心跳误判掉线
        try { online.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      } else {
        // 连接已断：取消 3 秒等待，立即重连
        if (online.reconnectTimer) { clearTimeout(online.reconnectTimer); online.reconnectTimer = null; }
        net.connect();
      }
    });
  }

  // 暴露
  online.net = net;
  online.state = state;
  online.render = render;
  online.action = action;
  online.sfx = sfx;
  online.ui = ui;
  online.start = start;
  window.online = online;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
