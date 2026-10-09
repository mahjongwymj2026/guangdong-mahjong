// js/sounds.js — 音效系统（浏览器版本，适配 Web Audio API）

// WebAudio 上下文
var audioCtx = null;
function getCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.error('WebAudio not available', e);
    }
  }
  return audioCtx;
}

// 简单音调
function tone(freq, duration, type, vol) {
  var ctx = getCtx();
  if (!ctx) return;
  try {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol || 0.1;
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

// 牌码转文件名
function tileCodeToFileName(code) {
  if (!code) return '';
  var suit = code[0];
  var num = parseInt(code.slice(1));
  if (suit === 'W') return 'wan' + num;
  if (suit === 'T') return 'tiao' + num;
  if (suit === 'D') return 'tong' + num;
  if (suit === 'Z') return window.mj.Z_IMG[num];
  return '';
}

// 语音缓存池：每个 mp3 只下载一次，之后从内存秒播
var voiceCache = {};
function getVoice(name) {
  if (!voiceCache[name]) {
    var audio = new Audio('sounds/' + name + '.mp3');
    audio.preload = 'auto';
    audio.volume = 0.8;
    voiceCache[name] = audio;
  }
  return voiceCache[name];
}

// 全部语音清单（按 sounds/ 目录实际文件），进页面后预加载
var ALL_VOICES = [
  'wan1','wan9',
  'tiao1','tiao2','tiao3','tiao4','tiao5','tiao6','tiao7','tiao8','tiao9',
  'tong1','tong2','tong3','tong4','tong5','tong6','tong7','tong8','tong9',
  'dong','nan','xi','bei','zhong','fa','bai',
  'peng','gang','zimo',
  'duidui','qingyise','qingdui','yaojiu','y13'
];

// 预加载全部语音（页面加载后调用，静默下载，不影响界面）
function preloadAll() {
  try {
    ALL_VOICES.forEach(function (name) { getVoice(name); });
  } catch (e) {}
}

// 语音播放（缓存复用，秒播；支持快速连续播放同一语音）
function playVoice(name) {
  try {
    var audio = getVoice(name);
    // 如果上一个同名语音还在播，克隆一个播，避免被 currentTime=0 掐断
    if (!audio.paused && !audio.ended) {
      var clone = audio.cloneNode();
      clone.volume = 0.8;
      clone.play().catch(function () {});
      return;
    }
    audio.currentTime = 0;
    audio.play().catch(function (err) {
      console.log('voice error:', name, err);
    });
  } catch (e) {
    console.error('playVoice error', e);
  }
}

// 牌型语音映射
var FAN_VOICES = {
  '普通自摸': 'zimo',
  '对对糊': 'duidui',
  '清一色': 'qingyise',
  '清对': 'qingdui',
  '幺九牌': 'yaojiu',
  '十三幺': 'y13'
};

// 出牌音效（喊牌名+轻音）
function tile(code) {
  playVoice(tileCodeToFileName(code));
  tone(210, 0.1, 'triangle', 0.15);
  setTimeout(function () { tone(330, 0.08, 'sine', 0.06); }, 60);
}

// 碰（喊声比出牌声晚0.8秒，先喊牌再喊碰）
function peng() {
  setTimeout(function () { playVoice('peng'); }, 800);
  tone(180, 0.12, 'square', 0.06);
  setTimeout(function () { tone(140, 0.1, 'square', 0.06); }, 80);
}

// 杠（喊声比出牌声晚0.8秒）
function gang() {
  setTimeout(function () { playVoice('gang'); }, 800);
  tone(120, 0.15, 'sawtooth', 0.16);
  setTimeout(function () { tone(80, 0.12, 'sawtooth', 0.16); }, 100);
}

// 胡
function hu() {
  tone(523, 0.15, 'sine', 0.15);
  setTimeout(function () { tone(659, 0.15, 'sine', 0.15); }, 100);
  setTimeout(function () { tone(784, 0.2, 'sine', 0.15); }, 200);
}

// 自摸
function zimo() {
  tone(440, 0.12, 'sine', 0.12);
  setTimeout(function () { tone(554, 0.12, 'sine', 0.12); }, 80);
  setTimeout(function () { tone(659, 0.15, 'sine', 0.12); }, 160);
}

// 牌型语音
function fanVoice(fanName) {
  var voice = FAN_VOICES[fanName];
  if (voice) playVoice(voice);
}

// 鬼牌闪电音效
function lightning() {
  tone(1000, 0.05, 'sawtooth', 0.1);
  setTimeout(function () { tone(500, 0.08, 'sawtooth', 0.08); }, 30);
  setTimeout(function () { tone(200, 0.12, 'square', 0.06); }, 80);
}

// 浏览器环境：挂载到 window.snd
window.snd = {
  tone: tone,
  playVoice: playVoice,
  tileCodeToFileName: tileCodeToFileName,
  tile: tile,
  peng: peng,
  gang: gang,
  hu: hu,
  zimo: zimo,
  fanVoice: fanVoice,
  lightning: lightning,
  FAN_VOICES: FAN_VOICES,
  preloadAll: preloadAll
};

// 页面加载完成后自动预加载全部语音（下载不需要用户手势，播放才需要）
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(preloadAll, 500);
    });
  } else {
    setTimeout(preloadAll, 500);
  }
}

// ===== 音频解锁：微信/手机浏览器要求 audio.play() 必须在用户手势内调用过一次 =====
var _unlocked = false;
function unlock() {
  if (_unlocked) return;
  _unlocked = true;
  try {
    var a = new Audio();
    a.muted = true;
    a.play().then(function () { a.pause(); }).catch(function () {});
  } catch (e) {}
  try {
    var ctx = getCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  } catch (e) {}
}
window.snd = window.snd || {};
window.snd.unlock = unlock;
if (typeof document !== 'undefined') {
  function _onFirstInteraction() {
    unlock();
    document.removeEventListener('click', _onFirstInteraction);
    document.removeEventListener('touchstart', _onFirstInteraction);
    document.removeEventListener('touchend', _onFirstInteraction);
  }
  document.addEventListener('click', _onFirstInteraction);
  document.addEventListener('touchstart', _onFirstInteraction);
  document.addEventListener('touchend', _onFirstInteraction);
}
