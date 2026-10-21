// Синтезированные звуки (WebAudio), без аудиофайлов.

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try {
  muted = localStorage.getItem('ukrps.muted') === '1';
} catch {
  /* приватный режим */
}

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.7;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem('ukrps.muted', m ? '1' : '0');
  } catch {
    /* ignore */
  }
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.7, ctx.currentTime, 0.05);
}

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone({ type = 'sine', f0, f1 = f0, dur = 0.2, gain = 0.2, at = 0, attack = 0.005 }) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  env(g, t, attack, gain, dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + attack + dur + 0.05);
}

function noise({ dur = 0.2, gain = 0.2, at = 0, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, attack = 0.004 }) {
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain();
  env(g, t, attack, gain, dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5);
  s.stop(t + attack + dur + 0.05);
}

export const sfx = {
  hover() {
    tone({ type: 'triangle', f0: 1400, f1: 1100, dur: 0.05, gain: 0.03 });
  },
  click() {
    tone({ type: 'square', f0: 520, f1: 380, dur: 0.06, gain: 0.05 });
    noise({ dur: 0.03, gain: 0.05, f0: 3000, q: 2 });
  },
  card() {
    noise({ dur: 0.22, gain: 0.18, f0: 700, f1: 3200, q: 0.8 });
  },
  flip() {
    noise({ dur: 0.12, gain: 0.2, f0: 2500, f1: 900, q: 1.2 });
    noise({ dur: 0.1, gain: 0.15, f0: 1800, f1: 4000, q: 1.2, at: 0.12 });
  },
  gavel() {
    tone({ type: 'sine', f0: 140, f1: 48, dur: 0.45, gain: 0.55 });
    tone({ type: 'triangle', f0: 420, f1: 300, dur: 0.09, gain: 0.3 });
    noise({ dur: 0.07, gain: 0.35, type: 'lowpass', f0: 2200, q: 0.7 });
    tone({ type: 'sine', f0: 120, f1: 60, dur: 0.25, gain: 0.18, at: 0.16 });
    noise({ dur: 0.05, gain: 0.12, type: 'lowpass', f0: 1800, at: 0.16 });
  },
  hit() {
    noise({ dur: 0.35, gain: 0.3, f0: 4000, f1: 300, q: 0.6 });
    tone({ type: 'sawtooth', f0: 220, f1: 55, dur: 0.35, gain: 0.12 });
  },
  clash() {
    tone({ type: 'triangle', f0: 1200, dur: 0.25, gain: 0.08 });
    tone({ type: 'triangle', f0: 1270, dur: 0.3, gain: 0.07, at: 0.02 });
    noise({ dur: 0.12, gain: 0.15, f0: 3500, q: 1 });
  },
  burn() {
    noise({ dur: 1.6, gain: 0.12, type: 'lowpass', f0: 900, f1: 300, attack: 0.2 });
    for (let i = 0; i < 14; i++) noise({ dur: 0.02, gain: 0.08 + Math.random() * 0.1, f0: 2000 + Math.random() * 3000, q: 4, at: Math.random() * 1.5 });
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.3, gain: 0.12, at: i * 0.09 }));
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone({ type: 'sawtooth', f0: f, f1: f * 0.97, dur: 0.28, gain: 0.05, at: i * 0.14 }));
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
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.05);
    g.gain.setValueAtTime(0.06, t + 1.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
    o.connect(f).connect(g).connect(master);
    o.start(t);
    o.stop(t + 2.05);
  },
  tick() {
    tone({ type: 'square', f0: 1800, dur: 0.03, gain: 0.04 });
  },
  fanfare() {
    [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) =>
      tone({ type: 'triangle', f0: f, dur: i === 6 ? 0.6 : 0.16, gain: 0.12, at: i * 0.13 }),
    );
  },
  emote() {
    tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.12, gain: 0.06 });
  },
};
