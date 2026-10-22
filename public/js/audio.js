// Звук игры: эффекты и фоновая музыка (нуарный джаз), всё синтезируется на WebAudio без файлов.
//
// Браузеры включают звук только после жеста пользователя, причём на телефоне жестом считается
// touchend/click, а не pointerdown. Поэтому разблокируем на нескольких событиях сразу.

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let musicDuck = null;
let musicTone = null;
let reverbIn = null;
let musicSend = null;
let rhodesBus = null;
let analyser = null;
let noiseBuf = null;

function load(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? def : v === '1';
  } catch {
    return def;
  }
}
function save(key, on) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* приватный режим */
  }
}

// старый общий переключатель «звук выкл.» отключает и эффекты, и музыку
const legacyMuted = load('ukrps.muted', false);
const prefs = {
  sfx: load('ukrps.sfx', !legacyMuted),
  music: load('ukrps.music', !legacyMuted),
};

const SFX_VOL = 0.9;
const MUSIC_VOL = 0.42;

// ---------------------------------------------------------------- запуск

const UNLOCK_EVENTS = ['pointerup', 'touchend', 'mousedown', 'click', 'keydown'];

function create() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  // iOS 17+: звук игры не глушится беззвучным режимом телефона
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    /* не поддерживается */
  }
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  // лимитер: громкие совпадения (аккорд + бас + удар) не уходят в перегруз
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  master.connect(comp).connect(limiter);
  limiter.connect(analyser);
  analyser.connect(ctx.destination);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = prefs.sfx ? SFX_VOL : 0;
  sfxBus.connect(master);

  musicTone = ctx.createBiquadFilter();
  musicTone.type = 'lowpass';
  musicTone.frequency.value = 12000;
  musicDuck = ctx.createGain();
  musicBus = ctx.createGain();
  musicBus.gain.value = prefs.music ? MUSIC_VOL : 0;
  musicTone.connect(musicDuck).connect(musicBus).connect(master);

  // ревербератор «зала»: импульс из затухающего шума
  const len = Math.floor(ctx.sampleRate * 2.4);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  reverbIn = ctx.createGain();
  reverbIn.gain.value = 0.9;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  reverbIn.connect(conv).connect(wet).connect(master);
  // хвост реверберации музыки должен приглушаться и выключаться вместе с музыкой
  musicSend = ctx.createGain();
  musicSend.gain.value = prefs.music ? 1 : 0;
  musicSend.connect(reverbIn);

  // «электропиано» с тремоло
  rhodesBus = ctx.createGain();
  rhodesBus.gain.value = 0.8;
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.frequency.value = 4.6;
  depth.gain.value = 0.22;
  lfo.connect(depth).connect(rhodesBus.gain);
  lfo.start();
  rhodesBus.connect(musicTone);

  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const n = noiseBuf.getChannelData(0);
  for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

  ctx.onstatechange = () => {
    if (ctx.state === 'running') music.kick();
  };
}

// слушатели не снимаем: iOS может снова «усыпить» звук (звонок, другое приложение)
function unlock() {
  if (!ctx) create();
  if (!ctx || ctx.state === 'running') return;
  ctx.resume().catch(() => {});
  // iOS окончательно «будит» звук, только если в обработчике жеста что-то проиграно
  const b = ctx.createBufferSource();
  b.buffer = ctx.createBuffer(1, 1, 22050);
  b.connect(ctx.destination);
  b.start(0);
  if (ctx.state === 'running') music.kick();
}

export function setupAudio() {
  for (const e of UNLOCK_EVENTS) addEventListener(e, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });
}

// совместимость: явная попытка включить звук из обработчика клика
export const initAudio = unlock;

const ready = () => ctx && ctx.state === 'running';

export function isSfxOn() {
  return prefs.sfx;
}
export function setSfx(on) {
  prefs.sfx = on;
  save('ukrps.sfx', on);
  if (ctx) sfxBus.gain.setTargetAtTime(on ? SFX_VOL : 0, ctx.currentTime, 0.05);
}
export function isMusicOn() {
  return prefs.music;
}
export function setMusic(on) {
  prefs.music = on;
  save('ukrps.music', on);
  if (ctx) {
    musicBus.gain.setTargetAtTime(on ? MUSIC_VOL : 0, ctx.currentTime, 0.3);
    musicSend.gain.setTargetAtTime(on ? (MODES[music.mode] || MODES.menu).level : 0, ctx.currentTime, 0.3);
  }
  if (on) music.kick();
}

// поток с выхода — для записи звука в тестах
export function outputStream() {
  if (!ctx) return null;
  const d = ctx.createMediaStreamDestination();
  analyser.connect(d);
  return d.stream;
}

// уровень сигнала на выходе (для проверки, что звук действительно идёт)
export function audioLevel() {
  if (!analyser) return 0;
  const a = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(a);
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
}

// ---------------------------------------------------------------- примитивы

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

function env(g, t, a, peak, d, curve = 'exp') {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  else g.gain.linearRampToValueAtTime(0, t + a + d);
}

function tone({ type = 'sine', f0, f1 = f0, dur = 0.2, gain = 0.2, at = 0, attack = 0.005, out = sfxBus, send = 0, when = null, detune = 0 }) {
  if (!ctx) return;
  const t = when ?? ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, attack, gain, dur);
  o.connect(g).connect(out);
  if (send) {
    const s = ctx.createGain();
    s.gain.value = send;
    g.connect(s).connect(out === sfxBus ? reverbIn : musicSend);
  }
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}

function noise({ dur = 0.2, gain = 0.2, at = 0, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, attack = 0.004, out = sfxBus, send = 0, when = null }) {
  if (!ctx) return;
  const t = when ?? ctx.currentTime + at;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  env(g, t, attack, gain, dur);
  s.connect(f).connect(g).connect(out);
  if (send) {
    const sg = ctx.createGain();
    sg.gain.value = send;
    g.connect(sg).connect(out === sfxBus ? reverbIn : musicSend);
  }
  // случайный сдвиг в буфере шума, но так, чтобы звук не оборвался раньше времени
  s.start(t, Math.random() * Math.max(0, 1.9 - dur - attack));
  s.stop(t + attack + dur + 0.05);
}

// ---------------------------------------------------------------- эффекты

let lastHover = 0;

export const sfx = {
  uiHover() {
    if (!ready()) return;
    const now = ctx.currentTime;
    if (now - lastHover < 0.05) return;
    lastHover = now;
    tone({ type: 'sine', f0: 2200, f1: 1800, dur: 0.03, gain: 0.025 });
  },
  hover() {
    tone({ type: 'triangle', f0: 1400, f1: 1100, dur: 0.05, gain: 0.04 });
  },
  // шорох бумаги при наведении на карту
  cardHover() {
    if (!ready()) return;
    const now = ctx.currentTime;
    if (now - lastHover < 0.04) return;
    lastHover = now;
    noise({ dur: 0.06, gain: 0.05, type: 'highpass', f0: 3500, q: 0.7 });
  },
  click() {
    tone({ type: 'triangle', f0: 700, f1: 420, dur: 0.06, gain: 0.12 });
    noise({ dur: 0.03, gain: 0.08, f0: 2400, q: 3 });
  },
  // карта летит на стол и ложится
  card() {
    noise({ dur: 0.28, gain: 0.2, f0: 600, f1: 3600, q: 0.8 });
    noise({ dur: 0.08, gain: 0.16, type: 'lowpass', f0: 1200, at: 0.45 });
    tone({ type: 'sine', f0: 160, f1: 90, dur: 0.1, gain: 0.12, at: 0.45 });
  },
  // соперник положил карту рубашкой вверх
  oppPick() {
    noise({ dur: 0.18, gain: 0.1, f0: 900, f1: 2600, q: 0.8 });
    noise({ dur: 0.06, gain: 0.1, type: 'lowpass', f0: 900, at: 0.5 });
  },
  flip() {
    noise({ dur: 0.12, gain: 0.2, f0: 2500, f1: 900, q: 1.2 });
    noise({ dur: 0.1, gain: 0.15, f0: 1800, f1: 4000, q: 1.2, at: 0.12 });
  },
  // барабанная дробь перед вскрытием
  drumroll(dur = 1.1) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const hits = Math.floor(dur / 0.045);
    for (let i = 0; i < hits; i++) {
      const k = i / hits;
      noise({ when: t0 + i * 0.045 + Math.random() * 0.006, dur: 0.06, gain: 0.03 + k * 0.11, f0: 1800, q: 0.9, send: 0.2 });
    }
    // удар тарелки в конце
    noise({ when: t0 + dur, dur: 1.2, gain: 0.16, type: 'highpass', f0: 5000, q: 0.5, send: 0.5 });
    tone({ when: t0 + dur, type: 'sine', f0: 90, f1: 50, dur: 0.4, gain: 0.3 });
  },
  gavel() {
    tone({ type: 'sine', f0: 140, f1: 48, dur: 0.45, gain: 0.5, send: 0.4 });
    tone({ type: 'triangle', f0: 420, f1: 300, dur: 0.09, gain: 0.3, send: 0.6 });
    noise({ dur: 0.07, gain: 0.35, type: 'lowpass', f0: 2200, q: 0.7, send: 0.5 });
    tone({ type: 'sine', f0: 120, f1: 60, dur: 0.25, gain: 0.16, at: 0.16 });
    noise({ dur: 0.05, gain: 0.12, type: 'lowpass', f0: 1800, at: 0.16 });
  },
  // «тук-тук» молотком и звон в начале раунда
  roundStart() {
    for (const at of [0, 0.22]) {
      tone({ type: 'sine', f0: 150, f1: 60, dur: 0.3, gain: 0.32, at, send: 0.4 });
      noise({ dur: 0.05, gain: 0.25, type: 'lowpass', f0: 2000, at, send: 0.4 });
    }
    tone({ type: 'sine', f0: 1318, dur: 0.9, gain: 0.07, at: 0.5, send: 0.6 });
    tone({ type: 'sine', f0: 1975, dur: 0.7, gain: 0.04, at: 0.5, send: 0.6 });
  },
  hit() {
    noise({ dur: 0.35, gain: 0.3, f0: 4000, f1: 300, q: 0.6, send: 0.3 });
    tone({ type: 'sawtooth', f0: 220, f1: 55, dur: 0.35, gain: 0.1 });
    tone({ type: 'sine', f0: 80, f1: 40, dur: 0.4, gain: 0.35 });
  },
  clash() {
    tone({ type: 'triangle', f0: 1200, dur: 0.35, gain: 0.08, send: 0.5 });
    tone({ type: 'triangle', f0: 1270, dur: 0.4, gain: 0.07, at: 0.02, send: 0.5 });
    noise({ dur: 0.12, gain: 0.15, f0: 3500, q: 1 });
  },
  burn() {
    noise({ dur: 1.6, gain: 0.12, type: 'lowpass', f0: 900, f1: 300, attack: 0.2 });
    noise({ dur: 0.9, gain: 0.08, f0: 400, f1: 1600, q: 0.6, attack: 0.3 });
    for (let i = 0; i < 16; i++) noise({ dur: 0.02, gain: 0.08 + Math.random() * 0.1, f0: 2000 + Math.random() * 3000, q: 4, at: Math.random() * 1.5 });
  },
  // вибрафон вверх — раунд мой
  win() {
    [62, 65, 69, 74, 77].forEach((m, i) => tone({ type: 'sine', f0: mtof(m), dur: 0.6, gain: 0.1, at: i * 0.08, send: 0.5 }));
  },
  // «грустный тромбон» — раунд проигран
  lose() {
    [55, 54, 53, 52].forEach((m, i) => {
      const last = i === 3;
      tone({ type: 'sawtooth', f0: mtof(m), f1: mtof(m) * (last ? 0.97 : 1), dur: last ? 0.7 : 0.26, gain: 0.05, at: i * 0.3, attack: 0.04 });
    });
  },
  siren() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(650, t);
    for (let i = 0; i < 4; i++) {
      o.frequency.linearRampToValueAtTime(980, t + i * 0.5 + 0.25);
      o.frequency.linearRampToValueAtTime(650, t + i * 0.5 + 0.5);
    }
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
    g.gain.setValueAtTime(0.05, t + 1.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
    o.connect(f).connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + 2.05);
  },
  tick() {
    tone({ type: 'square', f0: 1800, dur: 0.03, gain: 0.04 });
    noise({ dur: 0.02, gain: 0.05, type: 'highpass', f0: 6000 });
  },
  // медные аккорды — победа в игре
  fanfare() {
    const chords = [
      [60, 64, 67],
      [62, 65, 69],
      [64, 67, 72],
      [67, 72, 76],
    ];
    chords.forEach((ch, i) => {
      const last = i === chords.length - 1;
      for (const m of ch) {
        tone({ type: 'sawtooth', f0: mtof(m), dur: last ? 1.1 : 0.2, gain: 0.04, at: i * 0.18, attack: 0.02, send: 0.4 });
        tone({ type: 'sawtooth', f0: mtof(m), dur: last ? 1.1 : 0.2, gain: 0.03, at: i * 0.18, attack: 0.02, detune: 8 });
      }
    });
    noise({ dur: 1.4, gain: 0.12, type: 'highpass', f0: 5000, at: 0.54, send: 0.5 });
  },
  emote() {
    tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.12, gain: 0.08 });
  },
  // в лобби зашёл игрок
  join() {
    tone({ type: 'sine', f0: mtof(76), dur: 0.5, gain: 0.08, send: 0.5 });
    tone({ type: 'sine', f0: mtof(72), dur: 0.7, gain: 0.08, at: 0.18, send: 0.5 });
  },
  error() {
    tone({ type: 'square', f0: 180, dur: 0.12, gain: 0.05 });
    tone({ type: 'square', f0: 140, dur: 0.18, gain: 0.05, at: 0.13 });
  },
};

// ---------------------------------------------------------------- музыка

// Нуарный джаз в ре миноре: контрабас ходит четвертями, тарелка ride с триольным свингом,
// щётки на 2 и 4, электропиано аккордами, вибрафон иногда наигрывает фразы.
const BPM = 88;
const Q = 60 / BPM;
const SWING = 0.66;

const PROGRESSIONS = [
  // [бас (MIDI), голоса аккорда]
  [
    [38, [53, 57, 60, 64]], // Dm9
    [43, [58, 62, 65, 69]], // Gm9
    [40, [55, 58, 62, 64]], // Em7b5
    [45, [55, 61, 65, 70]], // A7b9
  ],
  [
    [38, [53, 57, 60, 64]], // Dm9
    [46, [57, 62, 65, 69]], // Bbmaj7
    [40, [55, 58, 62, 64]], // Em7b5
    [45, [55, 61, 64, 67]], // A7
  ],
];

const MODES = {
  menu: { tone: 9000, level: 1, drums: 1, keys: 1, vibes: 0.5 },
  lobby: { tone: 9000, level: 1, drums: 1, keys: 1, vibes: 0.35 },
  game: { tone: 2200, level: 0.75, drums: 0.7, keys: 0.7, vibes: 0.15 },
  over: { tone: 9000, level: 0.9, drums: 1, keys: 1, vibes: 0.5 },
};

const music = {
  mode: 'menu',
  timer: null,
  nextBeat: 0,
  beat: 0,
  rnd: 1,

  kick() {
    if (!ready() || !prefs.music || this.timer) return;
    this.applyMode(true);
    this.nextBeat = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 50);
  },

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  },

  applyMode(instant) {
    if (!ctx) return;
    const m = MODES[this.mode] || MODES.menu;
    const t = ctx.currentTime;
    musicTone.frequency.setTargetAtTime(m.tone, t, instant ? 0.01 : 0.8);
    musicDuck.gain.setTargetAtTime(m.level, t, instant ? 0.01 : 0.6);
    musicSend.gain.setTargetAtTime(prefs.music ? m.level : 0, t, instant ? 0.01 : 0.6);
  },

  random() {
    // детерминированный генератор — фразы повторяются похоже, но не одинаково
    this.rnd = (this.rnd * 16807) % 2147483647;
    return this.rnd / 2147483647;
  },

  schedule() {
    if (!ready() || !prefs.music) {
      if (!prefs.music) this.stop();
      return;
    }
    // вкладка спала — не пытаемся догнать пропущенное
    if (this.nextBeat < ctx.currentTime - 0.2) this.nextBeat = ctx.currentTime + 0.05;
    // планируем на 0,6 с вперёд: на слабом телефоне кадр может тормозить, а музыка — нет
    while (this.nextBeat < ctx.currentTime + 0.6) {
      this.playBeat(this.beat, this.nextBeat);
      this.nextBeat += Q;
      this.beat++;
    }
  },

  playBeat(n, t) {
    const m = MODES[this.mode] || MODES.menu;
    const bar = Math.floor(n / 4);
    const b = n % 4;
    const prog = PROGRESSIONS[Math.floor(bar / 4) % PROGRESSIONS.length];
    const [root, chord] = prog[bar % 4];
    const [nextRoot] = prog[(bar + 1) % 4];
    const off = t + Q * SWING; // свинговая «и»

    // контрабас: тоника, терция/квинта, квинта, хроматический подход к следующей тонике
    const walk = [root, root + (this.random() < 0.5 ? 3 : 7), root + 7, nextRoot + (this.random() < 0.5 ? -1 : 1)];
    this.bass(t, walk[b]);
    if (b === 3 && this.random() < 0.25) this.bass(off, walk[b] + 12, 0.5);

    // барабаны
    const dr = m.drums;
    this.ride(t, 0.028 * dr);
    if (b === 1 || b === 3) {
      this.ride(off, 0.02 * dr);
      this.brush(t, 0.032 * dr);
      noise({ when: t, dur: 0.04, gain: 0.012 * dr, type: 'highpass', f0: 7000, out: musicTone });
    }
    if (b === 0) tone({ when: t, type: 'sine', f0: 70, f1: 45, dur: 0.25, gain: 0.06 * dr, out: musicTone });

    // электропиано: аккорд на «раз», иногда подхват на «и» второй доли
    if (b === 0) this.chord(t, chord, Q * 3.4, 0.052 * m.keys);
    if (b === 2 && this.random() < 0.4) this.chord(off, chord, Q * 1.4, 0.04 * m.keys);

    // вибрафон: редкие фразы из звуков аккорда
    if (bar % 2 === 1 && this.random() < m.vibes) {
      const notes = chord.map((x) => x + 12);
      const note = notes[Math.floor(this.random() * notes.length)];
      this.vibe(this.random() < 0.5 ? t : off, note);
    }
  },

  bass(t, midi, vel = 1) {
    const f = mtof(midi);
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    o.type = 'triangle';
    o2.type = 'sine';
    o.frequency.value = f;
    o2.frequency.value = f / 2;
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.3);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.17 * vel, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.11 * vel, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Q * 0.98);
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(g).connect(musicTone);
    o.start(t);
    o2.start(t);
    o.stop(t + Q);
    o2.stop(t + Q);
  },

  ride(t, gain) {
    noise({ when: t, dur: 0.32, gain, f0: 7000, q: 1.6, attack: 0.002, out: musicTone, send: 0.15 });
    tone({ when: t, type: 'sine', f0: 3520, dur: 0.25, gain: gain * 0.15, attack: 0.002, out: musicTone });
  },

  brush(t, gain) {
    noise({ when: t, dur: 0.18, gain, f0: 2600, q: 0.7, attack: 0.03, out: musicTone, send: 0.2 });
  },

  chord(t, notes, dur, gain) {
    for (const midi of notes) {
      const f = mtof(midi);
      const o = ctx.createOscillator();
      const bell = ctx.createOscillator();
      const g = ctx.createGain();
      const bg = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      o.type = 'sine';
      bell.type = 'sine';
      o.frequency.value = f;
      bell.frequency.value = f * 4;
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const strum = Math.random() * 0.04;
      g.gain.setValueAtTime(0.0001, t + strum);
      g.gain.linearRampToValueAtTime(gain, t + strum + 0.025);
      g.gain.exponentialRampToValueAtTime(gain * 0.55, t + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      bg.gain.setValueAtTime(gain * 0.15, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g);
      bell.connect(bg).connect(g);
      g.connect(lp).connect(rhodesBus);
      const s = ctx.createGain();
      s.gain.value = 0.3;
      g.connect(s).connect(musicSend);
      o.start(t);
      bell.start(t);
      o.stop(t + dur + 0.05);
      bell.stop(t + dur + 0.05);
    }
  },

  vibe(t, midi) {
    tone({ when: t, type: 'sine', f0: mtof(midi), dur: 1.2, gain: 0.06, attack: 0.004, out: musicTone, send: 0.6 });
    tone({ when: t, type: 'sine', f0: mtof(midi) * 4, dur: 0.25, gain: 0.012, attack: 0.002, out: musicTone });
  },
};

// какая музыка играет: menu | lobby | game | over
export function setMusicMode(mode) {
  if (music.mode === mode) return;
  music.mode = mode;
  music.applyMode(false);
}

// временно приглушить музыку (вскрытие карт), потом вернуть уровень режима
export function duckMusic(level, seconds) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const back = (MODES[music.mode] || MODES.menu).level;
  for (const p of [musicDuck.gain, musicSend.gain]) {
    const on = p === musicDuck.gain || prefs.music;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(on ? level : 0, t, 0.15);
    p.setTargetAtTime(on ? back : 0, t + seconds, 0.8);
  }
}
