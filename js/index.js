// js/index.js — 开始页逻辑

(function() {
  // ---------- 设置项 ----------
  var INIT_OPTIONS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

  // 读取已保存的设置
  var speedLevel = parseInt(localStorage.getItem('speedLevel'));
  if (!(speedLevel >= 1 && speedLevel <= 5)) speedLevel = 2;

  var baseScore = parseInt(localStorage.getItem('baseScore'));
  if (!(baseScore >= 1 && baseScore <= 10)) baseScore = 3;

  var initScore = parseInt(localStorage.getItem('initScore'));
  if (INIT_OPTIONS.indexOf(initScore) < 0) initScore = 1000;

  // ---------- 通用按钮组 ----------
  function markActive(group, value) {
    document.querySelectorAll('.opt-btn[data-group="' + group + '"]').forEach(function(btn) {
      if (parseInt(btn.dataset.value) === value) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  markActive('speed', speedLevel);
  markActive('base', baseScore);
  markActive('init', initScore);

  document.querySelectorAll('.opt-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var group = this.dataset.group;
      var value = parseInt(this.dataset.value);
      if (group === 'speed') {
        speedLevel = value;
        localStorage.setItem('speedLevel', value);
      } else if (group === 'base') {
        baseScore = value;
        localStorage.setItem('baseScore', value);
        renderScoreTables();
      } else if (group === 'init') {
        initScore = value;
        localStorage.setItem('initScore', value);
      }
      markActive(group, value);
      if (window.snd) window.snd.tone(600, 0.05, 'sine', 0.08);
    });
  });

  // ---------- 详细分值表（随底分实时计算）----------
  // 番型：番数 = 自摸三家付款总额；每番 = 1 个底分
  var FAN_ROWS = [
    { name: '普通自摸 / 抢杠胡', fan: 6 },
    { name: '对对糊', fan: 12 },
    { name: '清一色', fan: 24 },
    { name: '清对、幺九牌', fan: 36 },
    { name: '十三幺、全翻板', fan: 48 }
  ];

  function renderScoreTables() {
    var b = baseScore;
    document.getElementById('tipBase').textContent = b;

    var fanHtml = '';
    FAN_ROWS.forEach(function(row) {
      var total = row.fan * b;           // 赢家总收入
      var per = Math.round(total / 3);   // 自摸每家付（番数都是3的倍数，无余数）
      fanHtml += '<tr>'
        + '<td class="t-name">' + row.name + '</td>'
        + '<td>' + row.fan + ' 番</td>'
        + '<td class="t-hot">' + per + ' 分</td>'
        + '<td class="t-hot">' + total + ' 分</td>'
        + '</tr>';
    });
    document.getElementById('fanTableBody').innerHTML = fanHtml;

    var gangHtml = ''
      + '<tr><td class="t-name">明杠</td><td>放杠者一人付</td><td class="t-hot">收 ' + (3 * b) + ' 分</td></tr>'
      + '<tr><td class="t-name">暗杠</td><td>其余三家各付 ' + (2 * b) + ' 分</td><td class="t-hot">共收 ' + (6 * b) + ' 分</td></tr>'
      + '<tr><td class="t-name">公杠（补杠）</td><td>其余三家各付 ' + (1 * b) + ' 分</td><td class="t-hot">共收 ' + (3 * b) + ' 分</td></tr>';
    document.getElementById('gangTableBody').innerHTML = gangHtml;
  }

  renderScoreTables();

  // ---------- 详细介绍弹窗 ----------
  var detailMask = document.getElementById('detailMask');

  function openDetail() {
    renderScoreTables();
    detailMask.classList.add('show');
    var body = detailMask.querySelector('.detail-body');
    if (body) body.scrollTop = 0;
    if (window.snd) window.snd.tone(520, 0.06, 'sine', 0.08);
  }

  function closeDetail() {
    detailMask.classList.remove('show');
  }

  document.getElementById('detailBtn').addEventListener('click', openDetail);
  document.getElementById('detailClose').addEventListener('click', closeDetail);
  detailMask.addEventListener('click', function(e) {
    if (e.target === detailMask) closeDetail();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDetail();
  });

  // ---------- 开始游戏 ----------
  document.getElementById('startBtn').addEventListener('click', function() {
    if (window.snd) {
      window.snd.tone(523, 0.1, 'sine', 0.12);
      setTimeout(function() { window.snd.tone(659, 0.1, 'sine', 0.12); }, 80);
      setTimeout(function() { window.snd.tone(784, 0.15, 'sine', 0.12); }, 160);
    }

    this.style.transform = 'scale(0.95)';
    var self = this;
    setTimeout(function() {
      self.style.transform = '';
      window.location.href = 'game.html?speed=' + speedLevel
        + '&base=' + baseScore
        + '&init=' + initScore;
    }, 200);
  });

  // ---------- 联机对战 ----------
  document.getElementById('onlineBtn').addEventListener('click', function() {
    if (window.snd) window.snd.tone(660, 0.08, 'sine', 0.1);
    this.style.transform = 'scale(0.95)';
    var self = this;
    setTimeout(function() {
      self.style.transform = '';
      window.location.href = 'online.html';
    }, 200);
  });
})();
