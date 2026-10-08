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
      voice.hideButtons();
    },
    showTable: function () {
      document.getElementById('lobby').style.display = 'none';
      document.getElementById('gameRoot').style.display = 'block';
      // 牌桌右上角房号条一直显示（倒计时有卡才显示）
      var cdGame = document.getElementById('gameCardCountdown');
      if (cdGame) cdGame.style.display = 'flex';
      voice.showButtons();
      ui.checkOrientation();
    },
    // 横屏检测：只在游戏界面（牌桌）显示竖屏提示，大厅不提示
    checkOrientation: function () {
      var ov = document.getElementById('rotateOverlay');
      if (!ov) return;
      var gameRoot = document.getElementById('gameRoot');
      var inGame = gameRoot && gameRoot.style.display !== 'none';
      if (!inGame) { ov.classList.remove('show'); return; }
      var isPortrait = window.innerHeight > window.innerWidth;
      ov.classList.toggle('show', isPortrait);
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
    // 聊天：用玩家昵称显示
    appendChat: function (seat, text, name) {
      var log = document.getElementById('chatLog');
      if (!log || !text) return;
      var displayName = name || ('玩家' + (seat + 1));
      var msg = document.createElement('div');
      msg.className = 'chat-msg';
      msg.innerHTML = '<span class="chat-dir">' + escapeHtml(displayName) + '：</span><span class="chat-text">' + escapeHtml(text) + '</span>';
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
    },
    // 下一局30秒倒计时
    _nrInterval: null,
    startNextRoundCountdown: function (deadline, ready) {
      var cdEl = document.getElementById('nrCountdown');
      if (!cdEl) return;
      if (this._nrInterval) clearInterval(this._nrInterval);
      var self = this;
      function tick() {
        var remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        cdEl.textContent = remain;
        cdEl.classList.toggle('urgent', remain <= 10);
        if (remain <= 0) {
          clearInterval(self._nrInterval);
          self._nrInterval = null;
        }
      }
      tick();
      this._nrInterval = setInterval(tick, 500);
      this.updateNextRoundReady(ready);
    },
    updateNextRoundReady: function (ready) {
      var el = document.getElementById('nrReady');
      if (!el || !ready) return;
      var cnt = ready.filter(function (r) { return r; }).length;
      el.textContent = cnt + '/4 已准备';
      // 自己准备了就禁用按钮
      var btn = document.getElementById('btnNextRound');
      if (btn && online.mySeat >= 0 && ready[online.mySeat]) {
        btn.disabled = true;
        btn.textContent = '已准备';
      }
    },
    // 房主卡倒计时：服务器给一个过期时间戳（ms），客户端每秒刷新显示
    _cdInterval: null,
    updateCardCountdown: function (expiryTs) {
      // 清旧定时器
      if (ui._cdInterval) { clearInterval(ui._cdInterval); ui._cdInterval = null; }
      var cdLobby = document.getElementById('cardCountdown');
      var cdGame = document.getElementById('gameCardCountdown');
      var gameLabel = cdGame ? cdGame.querySelector('.cd-label') : null;
      var gameTime = document.getElementById('gameCdTime');
      if (!expiryTs || expiryTs <= Date.now()) {
        // 过期了或没卡 → 大厅隐藏；牌桌只隐藏倒计时文字，房号保留
        if (cdLobby) cdLobby.style.display = 'none';
        if (gameLabel) gameLabel.style.display = 'none';
        if (gameTime) gameTime.style.display = 'none';
        return;
      }
      // 有卡 → 显示倒计时文字
      if (gameLabel) gameLabel.style.display = '';
      if (gameTime) gameTime.style.display = '';
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
      var wrap = document.getElementById('ghostTimer');
      if (!wrap) return;
      var num = document.getElementById('ghostTimerNum');
      if (!s || s.phase === 'idle' || s.phase === 'end') {
        wrap.style.display = 'none';
        return;
      }
      // 自己本局已被电脑接管：显示"托管"
      if (s.takenOver && s.takenOver[online.mySeat]) {
        wrap.style.display = 'flex';
        num.textContent = '托管';
        num.className = 'ghost-timer-num taken';
        return;
      }
      var total = 0, deadline = 0, mine = false;
      if (s.phase === 'discard' && s.turnDeadline) {
        total = DISCARD_MS;
        deadline = s.turnDeadline;
        mine = (s.turn === online.mySeat);
      } else if (s.phase === 'claim' && s.claimDeadline && s.myClaim) {
        total = CLAIM_MS;
        deadline = s.claimDeadline;
        mine = true;
      }
      if (!deadline) { wrap.style.display = 'none'; return; }
      var remain = deadline - Date.now();
      if (remain < 0) remain = 0;
      var secs = Math.ceil(remain / 1000);
      wrap.style.display = 'flex';
      var urgent = remain <= 10000;
      num.className = 'ghost-timer-num' + (mine ? ' mine' : '') + (urgent ? ' urgent' : '');
      num.textContent = secs;
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
          var gameRid = document.getElementById('gameRoomId');
          if (gameRid) gameRid.textContent = m.roomId;
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
            // claim_options 只是通知客户端显示碰/杠按钮，不需要声音，也不覆盖 discard 的待播声音
            if (m.evt === 'claim_options') {
              // 不进 _pendingSfx 机制，避免吃掉 discard 的出牌声
              break;
            }
            // 聊天消息：立即显示，不进1秒延迟的动作事件流程
            if (m.evt === 'chat') {
              ui.appendChat(m.detail.seat, m.detail.text, m.detail.name);
              break;
            }
            // 语音事件：实时处理，不进延迟队列
            if (m.evt === 'voice_take') {
              voice.onTake(m.detail.seat);
              break;
            }
            if (m.evt === 'voice_data') {
              voice.onData(m.detail.seat, m.detail.name, m.detail.data, m.detail.duration);
              break;
            }
            // 下一局倒计时启动
            if (m.evt === 'next_round_countdown') {
              ui.startNextRoundCountdown(m.detail.deadline, m.detail.ready);
              break;
            }
            // 某人准备下一局
            if (m.evt === 'next_round_ready') {
              ui.updateNextRoundReady(m.detail.ready);
              break;
            }
            // 动作事件统一延迟1秒：画面+声音同时出现，给语音预加载留时间，节奏均匀
            var evtName = m.evt, evtDetail = m.detail;
            setTimeout(function () {
              sfx.applyState(evtName, evtDetail);
              if (evtName === 'peng' || evtName === 'kong') online.lastDiscard = null;
              render.all();
              online._pendingSfx = { evt: evtName, detail: evtDetail };
              setTimeout(function () {
                if (online._pendingSfx) {
                  var p = online._pendingSfx;
                  online._pendingSfx = null;
                  sfx.play(p.evt, p.detail);
                }
              }, 30);
            }, 1000);
          }
          break;
        case 'state':
          // state 快照与动作事件同步延迟1秒，保持声画一致
          setTimeout(function () {
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
          }, 1000);
          break;
        case 'error':
          // 忽略"没轮到你"、"当前不能操作"这类无实际意义的提示
          if (m.code === 'turn.notYours' || m.code === 'phase.wrong') break;
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
        // 记录最近一次出牌（用于 turnInfo 提示 + 弃牌闪烁动画）
        online.lastDiscard = { seat: detail.seat, tile: detail.tile, at: Date.now() };
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
            // 胡牌人声：普通胡喊"自摸"，特殊胡牌喊牌型名（对对糊/清一色/清对/幺九/十三幺）
            var ed = detail.endData || (online.cur && online.cur.endData) || null;
            var fanName = ed ? ed.name : null;
            var fanVoiceName = fanName && window.snd.FAN_VOICES ? window.snd.FAN_VOICES[fanName] : null;
            // 自己胡牌且是自摸时，ed 可能还没准备好，但 detail.isSelfDraw 是可靠的
            if (detail.isSelfDraw) {
              if (window.snd.playVoice) window.snd.playVoice('zimo');
            } else if (fanVoiceName) {
              if (window.snd.playVoice) window.snd.playVoice(fanVoiceName);
            } else if (window.snd.hu) {
              window.snd.hu();
            }
            // 鬼牌胡牌 → 闪电
            if (ed && ed.winnerHasGhost) {
              triggerLightning();
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
      render.dirLayer();   // 东南西北水印根据自己座位旋转
      render.sideScores(); // 右侧面板四家分数
      render.roundInfo();  // 右侧面板底分总分
      render.turnInfo();
      render.deckInfo();
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

    // 东南西北水印：根据自己的座位号旋转，让"自己的方位"永远在屏幕下方
    // 绝对方位：座位0=南, 1=东, 2=北, 3=西
    dirLayer: function () {
      var DIR = ['南', '东', '北', '西'];
      var s = online.mySeat;
      if (s < 0 || s > 3) return;
      var n = document.querySelector('.dir-n');
      var e = document.querySelector('.dir-e');
      var w = document.querySelector('.dir-w');
      var sEl = document.querySelector('.dir-s');
      // 下方=自己, 右方=下家, 上方=对家, 左方=上家
      if (sEl) sEl.textContent = DIR[s];
      if (e) e.textContent = DIR[(s + 1) % 4];
      if (n) n.textContent = DIR[(s + 2) % 4];
      if (w) w.textContent = DIR[(s + 3) % 4];
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
      for (var i = 0; i < 4; i++) {
        // 阶段E-2：DOM id 是固定屏幕位置（seat0=底部/自己, seat1=右, seat2=上, seat3=左）
        // 真实座位号 i → 屏幕位置 relSeat(i) → 对应 DOM
        var r = relSeat(i);
        // 阶段D步骤3：本局电脑接管角标
        var autoEl = document.getElementById(SEAT_BOXES.auto[r]);
        if (autoEl) autoEl.style.display = (s.takenOver && s.takenOver[i]) ? 'inline-block' : 'none';
      }
    },

    // 右侧面板：四家方位 + 名字 + 分数
    sideScores: function () {
      var s = online.cur; if (!s || !s.players) return;
      var box = document.getElementById('sideScores');
      if (!box) return;
      var roomSeats = online.room && online.room.seats;
      var DIR = ['南', '东', '北', '西'];
      var html = '';
      for (var i = 0; i < 4; i++) {
        var p = s.players[i];
        if (!p) continue;
        var isBot = roomSeats && roomSeats[i] && roomSeats[i].isBot;
        var nm = isBot ? (roomSeats[i].name || ('机器人' + (i + 1))) : (p.name || ('玩家' + (i + 1)));
        html += '<div class="score-row">' +
          '<span class="score-dir">' + DIR[i] + '</span>' +
          '<span class="score-name">' + escapeHtml(nm) + '</span>' +
          '<span class="score-pts">' + p.points + '</span>' +
          '</div>';
      }
      box.innerHTML = html;
    },

    // 右侧面板：当前牌局底分 + 总分
    roundInfo: function () {
      var s = online.cur; if (!s) return;
      var baseEl = document.getElementById('riBase');
      var initEl = document.getElementById('riInit');
      if (baseEl) baseEl.textContent = s.baseScore || '-';
      if (initEl) initEl.textContent = s.initScore || '-';
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
      // 右家：分两列，每列8张，列1（靠手牌）先满
      if (boxId === 'rightPond') {
        for (var c = 0; c < 2; c++) {
          var col = document.createElement('div');
          col.className = 'pond-col';
          box.appendChild(col);
        }
        disp.forEach(function (t, i) {
          var img = document.createElement('img');
          img.className = 'mj pond-tile';
          img.src = tileImgSrc(t);
          img.alt = t;
          var colIdx = i < 8 ? 0 : 1;  // 前8张进列1，后面进列2
          box.children[colIdx].appendChild(img);
        });
        // 最近一次出牌（持续金光直到下一张）→ 最后一张弃牌加金色脉冲动画
        if (online.lastDiscard && online.lastDiscard.seat === seat && disp.length > 0) {
          var lastColIdx = (disp.length - 1) < 8 ? 0 : 1;
          var lastImg = box.children[lastColIdx] && box.children[lastColIdx].lastElementChild;
          if (lastImg && lastImg.tagName === 'IMG') lastImg.classList.add('pond-latest');
        }
        return;
      }
      disp.forEach(function (t) {
        var img = document.createElement('img');
        img.className = 'mj pond-tile';
        img.src = tileImgSrc(t);
        img.alt = t;
        box.appendChild(img);
      });
      // 最近一次出牌（持续金光直到下一张）→ 最后一张弃牌加金色脉冲动画
      if (online.lastDiscard && online.lastDiscard.seat === seat && disp.length > 0) {
        var last = box.lastElementChild;
        if (last && last.tagName === 'IMG') last.classList.add('pond-latest');
      }
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
      var ridEl = document.getElementById('endRoomId');
      if (ridEl) ridEl.textContent = '房号 ' + (online.roomId || '------');

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

      // 下一局按钮：所有人都可以点准备（房主也不能直接开）
      var btnNext = document.getElementById('btnNextRound');
      if (btnNext) { btnNext.disabled = false; btnNext.textContent = '准备'; }
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
      // 准备后不关弹窗，按钮变"已准备"
      var btn = document.getElementById('btnNextRound');
      if (btn) { btn.disabled = true; btn.textContent = '已准备'; }
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
  // ============ 语音聊天 ============
  var voice = {
    _recorder: null,
    _chunks: [],
    _stream: null,
    _timer: null,
    _startTime: 0,
    _recording: false,
    _requested: false,      // 已发 voice_take，等服务器确认
    _pendingRelease: false, // 确认前就松手了，收到确认后立即停止

    supported: function () {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
                window.MediaRecorder);
    },

    // 按下自己的语音按钮 → 请求抢麦
    press: function () {
      if (!this.supported()) { ui.toast('当前浏览器不支持语音', 'error'); return; }
      if (this._recording || this._requested) return;
      if (online.mySeat < 0) return;
      this._requested = true;
      this._pendingRelease = false;
      net.send('voice_take', {});
    },

    // 松开按钮 → 停止录音并发送；若还没开始录音则标记待停
    release: function () {
      if (this._recording) {
        this._stopAndSend();
      } else if (this._requested) {
        this._pendingRelease = true;
      }
    },

    // 收到 VOICE_TAKE 事件（seat 为 null = 释放）
    onTake: function (seat) {
      if (seat === null || seat === undefined) {
        // 锁释放（服务器超时或别人说完）
        if (this._recording) {
          this._stopAndSend();   // 服务器超时，强制停止并发送
        } else if (this._requested) {
          // 请求未被接受或已超时
          this._requested = false;
          this._pendingRelease = false;
        }
        this._resetButtons();
        return;
      }
      var rel = relSeat(seat);
      this._setButtonState(rel);
      if (seat === online.mySeat) {
        // 自己抢到麦 → 开始录音
        this._startRecording();
      } else {
        // 别人抢到麦 → 自己的请求被拒
        if (this._requested) { this._requested = false; this._pendingRelease = false; }
      }
    },

    // 收到 VOICE_DATA 事件 → 播放 + 聊天记录
    onData: function (seat, name, data, duration) {
      var rel = relSeat(seat);
      if (data) this._play(data, rel);
      this._appendVoiceChat(seat, name, data, duration);
    },

    _startRecording: function () {
      var self = this;
      this._startTime = Date.now();
      this._chunks = [];
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        if (!self._requested) { // 期间已被释放
          stream.getTracks().forEach(function (t) { t.stop(); });
          return;
        }
        self._stream = stream;
        try {
          self._recorder = new MediaRecorder(stream);
        } catch (e) {
          ui.toast('录音失败', 'error');
          net.send('voice_data', { data: '', duration: 0 });
          self._cleanup();
          return;
        }
        self._recorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) self._chunks.push(e.data);
        };
        self._recorder.start();
        self._recording = true;
        // 松手早于录音开始 → 立即停止
        if (self._pendingRelease) {
          self._pendingRelease = false;
          setTimeout(function () { if (self._recording) self._stopAndSend(); }, 50);
          return;
        }
        // 20 秒自动停止
        self._timer = setTimeout(function () {
          if (self._recording) self._stopAndSend();
        }, 20000);
      }).catch(function () {
        ui.toast('无法访问麦克风', 'error');
        net.send('voice_data', { data: '', duration: 0 });
        self._cleanup();
      });
    },

    _stopAndSend: function () {
      if (!this._recording || !this._recorder) return;
      var self = this;
      this._recording = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      var rec = this._recorder;
      rec.onstop = function () {
        var duration = Math.max(1, Math.round((Date.now() - self._startTime) / 1000));
        if (self._chunks.length === 0) {
          net.send('voice_data', { data: '', duration: 0 });
          self._cleanup();
          return;
        }
        var blob = new Blob(self._chunks, { type: rec.mimeType || 'audio/webm' });
        var reader = new FileReader();
        reader.onloadend = function () {
          var base64 = reader.result.split(',')[1] || '';
          net.send('voice_data', { data: base64, duration: duration });
          self._cleanup();
        };
        reader.readAsDataURL(blob);
      };
      try { rec.stop(); } catch (e) { self._cleanup(); net.send('voice_data', { data: '', duration: 0 }); }
    },

    _cleanup: function () {
      if (this._stream) { this._stream.getTracks().forEach(function (t) { t.stop(); }); this._stream = null; }
      this._recorder = null;
      this._chunks = [];
      this._recording = false;
      this._pendingRelease = false;
      this._requested = false;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },

    // 说话者亮、其他灰
    _setButtonState: function (speakerRel) {
      for (var i = 0; i < 4; i++) {
        var btn = this._getBtn(i);
        if (!btn) continue;
        btn.classList.remove('active', 'disabled', 'playing');
        btn.classList.add(i === speakerRel ? 'active' : 'disabled');
      }
    },

    _resetButtons: function () {
      for (var i = 0; i < 4; i++) {
        var btn = this._getBtn(i);
        if (btn) btn.classList.remove('active', 'disabled', 'playing');
      }
    },

    _getBtn: function (rel) {
      var wrap = document.getElementById('voiceBtn' + rel);
      return wrap ? wrap.querySelector('.voice-btn') : null;
    },

    // 播放 base64 音频 + 说话者按钮声波动画
    _play: function (base64, rel) {
      try {
        var bytes = this._base64ToBytes(base64);
        var blob = new Blob([bytes], { type: 'audio/webm' });
        var url = URL.createObjectURL(blob);
        var audio = new Audio(url);
        var btn = this._getBtn(rel);
        if (btn) btn.classList.add('playing');
        audio.onended = function () {
          if (btn) btn.classList.remove('playing');
          URL.revokeObjectURL(url);
        };
        audio.play().catch(function () {});
      } catch (e) {}
    },

    _base64ToBytes: function (base64) {
      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    },

    // 聊天面板加语音记录（可点击回放）
    _appendVoiceChat: function (seat, name, data, duration) {
      var log = document.getElementById('chatLog');
      if (!log) return;
      var displayName = name || ('玩家' + (seat + 1));
      var msg = document.createElement('div');
      msg.className = 'chat-msg';
      var dir = document.createElement('span');
      dir.className = 'chat-dir';
      dir.textContent = displayName + '：';
      var voiceEl = document.createElement('span');
      voiceEl.className = 'chat-voice-msg';
      voiceEl.textContent = '🎵 语音 ' + duration + '秒';
      if (data) {
        var self = this;
        voiceEl.addEventListener('click', function () {
          voiceEl.classList.add('replaying');
          var bytes = self._base64ToBytes(data);
          var blob = new Blob([bytes], { type: 'audio/webm' });
          var url = URL.createObjectURL(blob);
          var audio = new Audio(url);
          audio.onended = function () { voiceEl.classList.remove('replaying'); URL.revokeObjectURL(url); };
          audio.play().catch(function () { voiceEl.classList.remove('replaying'); });
        });
      }
      msg.appendChild(dir);
      msg.appendChild(voiceEl);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
    },

    showButtons: function () {
      for (var i = 0; i < 4; i++) {
        var wrap = document.getElementById('voiceBtn' + i);
        if (wrap) wrap.style.display = 'flex';
      }
    },
    hideButtons: function () {
      for (var i = 0; i < 4; i++) {
        var wrap = document.getElementById('voiceBtn' + i);
        if (wrap) wrap.style.display = 'none';
      }
      this._cleanup();
    },

    // 绑定 push-to-talk（只绑自己的按钮 voiceBtn0）
    bindPushToTalk: function () {
      var btn = this._getBtn(0);
      if (!btn) return;
      var self = this;
      var start = function (e) { e.preventDefault(); self.press(); };
      var end = function (e) { e.preventDefault(); self.release(); };
      btn.addEventListener('mousedown', start);
      btn.addEventListener('mouseup', end);
      btn.addEventListener('mouseleave', end);
      btn.addEventListener('touchstart', start, { passive: false });
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false });
    }
  };
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
  // 牌码 → 中文名（全局，供 turnInfo 提示用）
  var TILE_Z_NAMES = ['', '东', '南', '西', '北', '中', '发', '白'];
  function tileCN(code) {
    if (!code || code === 'ghost') return '鬼';
    var suit = code[0];
    var num = parseInt(code.slice(1));
    if (suit === 'Z') return TILE_Z_NAMES[num] || code;
    var sn = suit === 'W' ? '万' : suit === 'T' ? '条' : '筒';
    return sn + num;
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

    // 右侧分数/聊天面板：展开/收起
    var sideToggle = document.getElementById('sideToggle');
    var sideBody = document.getElementById('sideBody');
    var sideCloseHint = document.getElementById('sideCloseHint');
    if (sideToggle && sideBody) {
      sideToggle.addEventListener('click', function () {
        sideBody.style.display = (sideBody.style.display === 'none') ? 'flex' : 'none';
      });
    }
    // "点此退出聊天"关闭面板
    if (sideCloseHint && sideBody) {
      sideCloseHint.addEventListener('click', function () {
        sideBody.style.display = 'none';
      });
    }
    // 聊天发送
    var chatInput = document.getElementById('chatInput');
    var chatSend = document.getElementById('chatSend');
    function sendChat() {
      var txt = chatInput ? chatInput.value.trim() : '';
      if (!txt) return;
      net.send('chat', { text: txt });
      if (chatInput) chatInput.value = '';
      // 发送后自动展开聊天面板，方便看到自己发的消息
      var sb = document.getElementById('sideBody');
      if (sb) sb.style.display = 'flex';
    }
    if (chatSend) chatSend.addEventListener('click', sendChat);
    if (chatInput) chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    // 语音聊天 push-to-talk 绑定
    voice.bindPushToTalk();

    // 横屏检测：旋转屏幕时实时更新提示
    window.addEventListener('resize', ui.checkOrientation);
    window.addEventListener('orientationchange', function () {
      setTimeout(ui.checkOrientation, 300);
    });

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
  online.voice = voice;
  online.start = start;
  window.online = online;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
