// js/home-ui.js — 合并首页（首页+联机大厅）的交互
// 只负责大厅外观交互；联机网络逻辑仍在 online.js，本文件不碰 WebSocket
// 依赖的元素 id 均与 online.js 契约一致：
//   baseSelect / totalSelect / nickInput / showBase / showTotal
//   btnCreateRoom / btnJoinRoom / pwdInput / joinRoomId / roomCard
(function () {
  'use strict';

  // ---------- 小工具 ----------
  function $(id) { return document.getElementById(id); }
  function on(el, evt, fn) { if (el) el.addEventListener(evt, fn); }

  // ---------- 步进器：箭头改隐藏 select，再触发 change 让 online.js 同步 ----------
  function bindSteppers() {
    document.querySelectorAll('.step-btn').forEach(function (btn) {
      on(btn, 'click', function () {
        var sel = $(btn.getAttribute('data-target'));
        var dir = parseInt(btn.getAttribute('data-dir'), 10) || 0;
        if (!sel || !sel.options.length) return;
        var n = sel.options.length;
        var idx = sel.selectedIndex + dir;
        if (idx < 0) idx = n - 1;          // 循环切换
        if (idx >= n) idx = 0;
        sel.selectedIndex = idx;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        syncStepperView();
        rememberSettings();
      });
    });

    var baseSel = $('baseSelect');
    var totalSel = $('totalSelect');
    on(baseSel, 'change', syncStepperView);
    on(totalSel, 'change', syncStepperView);
  }

  function syncStepperView() {
    var baseSel = $('baseSelect');
    var totalSel = $('totalSelect');
    if ($('baseVal') && baseSel) $('baseVal').textContent = baseSel.value;
    if ($('totalVal') && totalSel) $('totalVal').textContent = totalSel.value;
  }

  // ---------- 记忆 / 恢复 ----------
  function rememberSettings() {
    try {
      localStorage.setItem('homeBase', $('baseSelect').value);
      localStorage.setItem('homeInit', $('totalSelect').value);
    } catch (e) {}
  }

  function restoreSettings() {
    var baseSel = $('baseSelect');
    var totalSel = $('totalSelect');
    try {
      var b = localStorage.getItem('homeBase');
      var t = localStorage.getItem('homeInit');
      if (b) selectByValue(baseSel, b);
      if (t) selectByValue(totalSel, t);
      // 昵称：与单机首页共用同一个键
      var nick = localStorage.getItem('mj_nick');
      if (nick && $('nickInput')) $('nickInput').value = nick;
    } catch (e) {}
    syncStepperView();
  }

  function selectByValue(sel, val) {
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === String(val)) { sel.selectedIndex = i; return; }
    }
  }

  function rememberNick() {
    var ni = $('nickInput');
    if (ni) {
      try { localStorage.setItem('mj_nick', ni.value.trim()); } catch (e) {}
    }
  }

  // ---------- 创建 / 加入 标签 ----------
  function bindTabs() {
    var tabs = document.querySelectorAll('.mode-tab');
    tabs.forEach(function (tab) {
      on(tab, 'click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var paneId = tab.getAttribute('data-pane');
        ['paneCreate', 'paneJoin'].forEach(function (pid) {
          var p = $(pid);
          if (p) p.style.display = (pid === paneId) ? 'flex' : 'none';
        });
      });
    });
  }

  // ---------- 房号只留数字 + 加入按钮智能启用（房号6位且有昵称才可点） ----------
  function bindJoinGate() {
    var j = $('joinRoomId');
    var btnJoin = $('btnJoinRoom');
    var nick = $('nickInput');
    if (!j || !btnJoin) return;

    function sync() {
      var ok = j.value.trim().length === 6 && nick && nick.value.trim().length > 0;
      // online.js 在连上服务器后会无条件把加入按钮点亮，这里按真实条件校正
      btnJoin.disabled = !ok;
    }

    on(j, 'input', function () {
      j.value = j.value.replace(/\D/g, '').slice(0, 6);
      sync();
    });
    if (nick) on(nick, 'input', sync);
    // 防止其他代码（服务器 hello）绕过条件点亮按钮
    new MutationObserver(function () {
      var ok = j.value.trim().length === 6 && nick && nick.value.trim().length > 0;
      if (btnJoin.disabled === false && !ok) btnJoin.disabled = true;
    }).observe(btnJoin, { attributes: true, attributeFilter: ['disabled'] });
    sync();
  }

  // ---------- 进房后：隐藏入口卡；离房恢复 ----------
  function bindRoomCardSwap() {
    var rc = $('roomCard');
    var ec = $('entryCard');
    if (!rc || !ec) return;
    var mo = new MutationObserver(function () {
      ec.style.display = (rc.style.display === 'none' || rc.style.display === '') ? '' : 'none';
    });
    mo.observe(rc, { attributes: true, attributeFilter: ['style'] });
  }

  // ---------- 规则与说明面板 ----------
  var FAN_ROWS = [
    ['普通自摸', 1], ['对对糊', 5], ['清一色', 6], ['清对', 30],
    ['幺九牌', 30], ['十三幺', 40], ['全翻板', 60], ['抢杠胡', 30]
  ];
  var GANG_ROWS = [
    ['暗杠', '每家给 2 倍底分', 2],
    ['公杠', '每家给 1 倍底分', 1],
    ['明杠', '放杠者给 3 倍底分', 3]
  ];

  function renderScoreTables(base) {
    var fb = $('fanTableBody');
    var gb = $('gangTableBody');
    var tb = $('tipBase');
    if (tb) tb.textContent = base;
    if (fb) {
      fb.innerHTML = FAN_ROWS.map(function (r) {
        var total = r[1] * base;
        var each = Math.round(total / 3);
        return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + each + '</td><td>' + total + '</td></tr>';
      }).join('');
    }
    if (gb) {
      gb.innerHTML = GANG_ROWS.map(function (r) {
        return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + (r[2] * base) + '</td></tr>';
      }).join('');
    }
  }

  function bindInfoPanel() {
    var mask = $('infoMask');
    var openBtn = $('btnMoreInfo');
    var closeBtn = $('infoClose');
    if (!mask) return;

    function open() {
      var base = parseInt(($('baseSelect') || {}).value || '10', 10) || 10;
      renderScoreTables(base);
      mask.classList.add('open');
    }
    function close() { mask.classList.remove('open'); }

    on(openBtn, 'click', open);
    on(closeBtn, 'click', close);
    on(mask, 'click', function (e) { if (e.target === mask) close(); });

    // 出牌速度（单机用），键名与单机首页一致
    var savedSpeed = 3;
    try { savedSpeed = parseInt(localStorage.getItem('speedLevel'), 10) || 3; } catch (e) {}
    document.querySelectorAll('.speed-btn').forEach(function (b) {
      if (parseInt(b.getAttribute('data-value'), 10) === savedSpeed) b.classList.add('active');
      on(b, 'click', function () {
        document.querySelectorAll('.speed-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        try { localStorage.setItem('speedLevel', b.getAttribute('data-value')); } catch (e) {}
      });
    });
  }

  // ---------- 单机练习：带当前底分/总分/速度跳单机页 ----------
  function bindPractice() {
    var link = $('practiceLink');
    if (!link) return;
    on(link, 'click', function (e) {
      e.preventDefault();
      var base = $('baseSelect') ? parseInt($('baseSelect').value, 10) : 10;
      var init = $('totalSelect') ? parseInt($('totalSelect').value, 10) : 200;
      // 单机页底分只接受 1~10，超出时夹到 10（联机不受此限）
      if (!(base >= 1 && base <= 10)) base = 10;
      var speed = 3;
      try { speed = parseInt(localStorage.getItem('speedLevel'), 10) || 3; } catch (err) {}
      rememberNick();
      location.href = 'game.html?speed=' + speed + '&base=' + base + '&init=' + init;
    });
  }

  // ---------- 隐藏管理员入口：左上角透明热区 → 管理后台 ----------
  function bindAdminEntry() {
    var b = $('adminSecret');
    if (b) on(b, 'click', function () { location.href = '/admin'; });
  }

  // ---------- 启动 ----------
  function init() {
    restoreSettings();
    bindSteppers();
    bindTabs();
    bindJoinGate();
    bindRoomCardSwap();
    bindInfoPanel();
    bindPractice();
    bindAdminEntry();

    // 昵称输入即记忆；同时触发 input 让 online.js 重算"创建房间"按钮可用状态
    var ni = $('nickInput');
    if (ni) {
      on(ni, 'change', rememberNick);
      on(ni, 'blur', rememberNick);
      if (ni.value) ni.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
