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

// 语音播放（HTML5 Audio, .mp3）
function playVoice(name) {
  try {
    var audio = new Audio('sounds/' + name + '.mp3');
    audio.volume = 0.8;
    audio.play().catch(function(err) {
      console.log('voice error:', name, err);
    });
  } catch (e) {
    console.error('playVoice error', e);
  }
}

// 番型语音映射
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

// 碰
function peng() {
  playVoice('peng');
  tone(180, 0.12, 'square', 0.06);
  setTimeout(function () { tone(140, 0.1, 'square', 0.06); }, 80);
}

// 杠
function gang() {
  playVoice('gang');
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

// 番型语音
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
  FAN_VOICES: FAN_VOICES
};
