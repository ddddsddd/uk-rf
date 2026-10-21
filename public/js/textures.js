// Процедурные текстуры: всё рисуется на canvas, без внешних картинок.
import * as THREE from 'three';
import { ARTICLES } from '../shared/rules.js';

export const CARD_W = 512;
export const CARD_H = 716;

const INK = '#1c1510';
const PAPER = '#efe4c8';

// ---------------------------------------------------------------- шум

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const hash = (x, y) => perm[(perm[x & 255] + y) & 255] / 255;
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, oct = 4) => {
    let s = 0;
    let amp = 0.5;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      s += amp * noise(x * f, y * f);
      f *= 2.03;
      amp *= 0.5;
    }
    return s;
  };
  return { noise, fbm, rnd };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function fitFont(ctx, text, maxW, size, family, weight = '') {
  let s = size;
  do {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxW) break;
    s -= 2;
  } while (s > 8);
  return s;
}

function ringText(ctx, text, cx, cy, r, startAngle, font, color) {
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const total = chars.reduce((s, ch) => s + ctx.measureText(ch).width, 0);
  let a = startAngle - total / r / 2;
  for (const ch of chars) {
    const w = ctx.measureText(ch).width;
    a += w / r / 2;
    ctx.save();
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    a += w / r / 2;
  }
  ctx.restore();
}

// ---------------------------------------------------------------- бумага

let paperCache = null;
function paperLayer() {
  if (paperCache) return paperCache;
  const [c, ctx] = canvas(CARD_W, CARD_H);
  const { fbm, rnd } = makeNoise(7);
  const img = ctx.createImageData(CARD_W, CARD_H);
  const d = img.data;
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      const i = (y * CARD_W + x) * 4;
      const m = fbm(x * 0.012, y * 0.012, 4);
      const fiber = fbm(x * 0.15, y * 0.02, 2);
      let v = 0.86 + m * 0.16 + (fiber - 0.5) * 0.05 + (rnd() - 0.5) * 0.05;
      const ex = Math.min(x, CARD_W - x) / CARD_W;
      const ey = Math.min(y, CARD_H - y) / CARD_H;
      const edge = Math.min(ex, ey);
      v -= Math.max(0, 0.08 - edge) * 2.2;
      d[i] = 239 * v;
      d[i + 1] = 226 * v;
      d[i + 2] = 196 * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  paperCache = c;
  return c;
}

// ---------------------------------------------------------------- иконки

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const ICONS = {
  envelope(ctx, a) {
    // купюры
    const notes = [
      [-0.32, -18, '#c9562f'],
      [-0.08, 0, '#5f8f6a'],
      [0.2, 14, '#c9562f'],
    ];
    for (const [rot, dx, col] of notes) {
      ctx.save();
      ctx.translate(dx, -40);
      ctx.rotate(rot);
      rr(ctx, -52, -40, 104, 56, 4);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1.5;
      rr(ctx, -44, -33, 88, 42, 3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.font = 'bold 18px "Russo One"';
      ctx.textAlign = 'center';
      ctx.fillText('5000', 0, -5);
      ctx.restore();
    }
    // конверт
    rr(ctx, -84, -30, 168, 106, 6);
    ctx.fillStyle = '#f4ead3';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-84, -28);
    ctx.lineTo(0, 30);
    ctx.lineTo(84, -28);
    ctx.moveTo(-82, 74);
    ctx.lineTo(-14, 24);
    ctx.moveTo(82, 74);
    ctx.lineTo(14, 24);
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 28, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#a3201a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#f0c9a0';
    ctx.font = '14px "Russo One"';
    ctx.textAlign = 'center';
    ctx.fillText('₽', 0, 33);
  },

  phone(ctx, a) {
    ctx.save();
    ctx.rotate(-0.12);
    rr(ctx, -52, -92, 104, 184, 18);
    ctx.fillStyle = INK;
    ctx.fill();
    rr(ctx, -44, -78, 88, 146, 8);
    const g = ctx.createLinearGradient(0, -78, 0, 68);
    g.addColorStop(0, '#dfe9ff');
    g.addColorStop(1, '#9fb6e6');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.font = '11px "PT Mono"';
    ctx.fillText('входящий…', 0, -58);
    ctx.font = '15px "Russo One"';
    ctx.fillText('СЛУЖБА', 0, -30);
    ctx.fillText('БЕЗОПАСНОСТИ', 0, -12);
    ctx.fillText('БАНКА', 0, 6);
    ctx.beginPath();
    ctx.arc(-22, 42, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#26a65b';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(22, 42, 13, 0, Math.PI * 2);
    ctx.fillStyle = '#d63031';
    ctx.fill();
    ctx.restore();
    // пузырь
    ctx.save();
    ctx.translate(62, -70);
    ctx.rotate(0.12);
    rr(ctx, -10, -26, 84, 46, 12);
    ctx.fillStyle = '#fff8e6';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '13px "PT Serif"';
    ctx.textAlign = 'center';
    ctx.fillText('Назовите', 32, -6);
    ctx.fillText('код из СМС', 32, 10);
    ctx.restore();
  },

  wallet(ctx, a) {
    // леска с крючком
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-6, -104);
    ctx.lineTo(8, -46);
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(14, -40, 9, Math.PI * 1.1, Math.PI * 0.2, true);
    ctx.stroke();
    // кошелёк
    ctx.save();
    ctx.rotate(0.14);
    rr(ctx, -78, -32, 156, 104, 14);
    ctx.fillStyle = '#6e4122';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.setLineDash([7, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#d9b48a';
    rr(ctx, -68, -22, 136, 84, 9);
    ctx.stroke();
    ctx.setLineDash([]);
    rr(ctx, 20, -6, 66, 40, 10);
    ctx.fillStyle = '#4f2d16';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(62, 14, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#e9c46a';
    ctx.fill();
    ctx.stroke();
    // уголок купюры
    ctx.beginPath();
    ctx.moveTo(-60, -32);
    ctx.lineTo(-48, -52);
    ctx.lineTo(-6, -42);
    ctx.lineTo(-12, -32);
    ctx.fillStyle = '#5f8f6a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    // линии движения
    ctx.strokeStyle = 'rgba(28,21,16,.6)';
    ctx.lineWidth = 3;
    for (const x of [-96, -86]) {
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x + 2, 60);
      ctx.stroke();
    }
  },

  baggie(ctx, a) {
    ctx.save();
    ctx.rotate(-0.08);
    // пакет
    ctx.beginPath();
    ctx.moveTo(-60, -74);
    ctx.lineTo(60, -74);
    ctx.quadraticCurveTo(70, 10, 58, 82);
    ctx.lineTo(-58, 82);
    ctx.quadraticCurveTo(-70, 10, -60, -74);
    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // зип
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(-60, -66, 120, 9);
    ctx.strokeRect(-60, -66, 120, 9);
    // блики
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-44, -44);
    ctx.quadraticCurveTo(-52, 0, -44, 40);
    ctx.stroke();
    // бирка
    ctx.save();
    ctx.translate(4, 2);
    ctx.rotate(0.06);
    rr(ctx, -42, -26, 84, 52, 4);
    ctx.fillStyle = '#fbf3dc';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.font = '14px "Russo One"';
    ctx.fillText('ВЕЩДОК', 0, -4);
    ctx.font = '13px "PT Mono"';
    ctx.fillText('№ 228', 0, 15);
    ctx.restore();
    // «находка» на дне
    ctx.fillStyle = 'rgba(245,245,245,.95)';
    ctx.beginPath();
    ctx.ellipse(-8, 66, 36, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // вопросительный знак — «это не моё»
    ctx.fillStyle = INK;
    ctx.font = '54px "Russo One"';
    ctx.textAlign = 'center';
    ctx.fillText('?', 86, -40);
  },

  car(ctx, a) {
    // тормозной след
    ctx.strokeStyle = 'rgba(28,21,16,.55)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-104, 76);
    ctx.bezierCurveTo(-60, 60, -40, 90, 0, 72);
    ctx.stroke();
    ctx.save();
    ctx.rotate(-0.13);
    ctx.translate(-8, 6);
    // кузов
    ctx.beginPath();
    ctx.moveTo(-88, 30);
    ctx.lineTo(-86, 4);
    ctx.quadraticCurveTo(-80, -8, -56, -10);
    ctx.lineTo(-34, -40);
    ctx.quadraticCurveTo(-28, -46, -16, -46);
    ctx.lineTo(30, -46);
    ctx.quadraticCurveTo(40, -46, 48, -36);
    ctx.lineTo(64, -12);
    ctx.quadraticCurveTo(88, -8, 90, 8);
    ctx.lineTo(90, 30);
    ctx.closePath();
    ctx.fillStyle = '#e3e7ee';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // окна
    ctx.beginPath();
    ctx.moveTo(-46, -12);
    ctx.lineTo(-28, -36);
    ctx.lineTo(4, -36);
    ctx.lineTo(4, -12);
    ctx.closePath();
    ctx.moveTo(12, -12);
    ctx.lineTo(12, -36);
    ctx.lineTo(34, -36);
    ctx.lineTo(52, -12);
    ctx.closePath();
    ctx.fillStyle = '#7fb2d9';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.stroke();
    // полоса и фары
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(-84, 6, 172, 7);
    ctx.fillStyle = '#ffe08a';
    ctx.fillRect(80, -4, 9, 8);
    // колёса
    for (const x of [-52, 54]) {
      ctx.beginPath();
      ctx.arc(x, 32, 19, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, 32, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#b8bfc9';
      ctx.fill();
    }
    ctx.restore();
    // бутылка
    ctx.save();
    ctx.translate(-70, -62);
    ctx.rotate(-0.5);
    rr(ctx, -12, -8, 24, 48, 6);
    ctx.fillStyle = '#2f7d4a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    rr(ctx, -5, -26, 10, 20, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f4ead3';
    ctx.fillRect(-10, 6, 20, 16);
    ctx.restore();
    // промилле
    ctx.fillStyle = INK;
    ctx.font = '30px "Russo One"';
    ctx.textAlign = 'center';
    ctx.fillText('1,5‰', 56, -70);
  },

  chalk(ctx, a) {
    // асфальт
    ctx.beginPath();
    ctx.arc(0, 0, 112, 0, Math.PI * 2);
    ctx.fillStyle = '#2b2b30';
    ctx.fill();
    const { rnd } = makeNoise(105);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    for (let i = 0; i < 400; i++) {
      const r = Math.sqrt(rnd()) * 108;
      const t = rnd() * Math.PI * 2;
      ctx.fillRect(Math.cos(t) * r, Math.sin(t) * r, 2, 2);
    }
    // меловой контур
    ctx.strokeStyle = '#f2f2ee';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(-14, -58, 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-22, -42);
    ctx.lineTo(-60, -50); // рука
    ctx.lineTo(-84, -20);
    ctx.lineTo(-74, -16);
    ctx.lineTo(-54, -36);
    ctx.lineTo(-26, -24);
    ctx.lineTo(-30, 18); // бок
    ctx.lineTo(-58, 58); // нога
    ctx.lineTo(-48, 66);
    ctx.lineTo(-14, 30);
    ctx.lineTo(10, 74); // вторая нога
    ctx.lineTo(22, 68);
    ctx.lineTo(8, 14);
    ctx.lineTo(10, -26);
    ctx.lineTo(48, -10); // вторая рука
    ctx.lineTo(74, -34);
    ctx.lineTo(66, -42);
    ctx.lineTo(44, -24);
    ctx.lineTo(-2, -42);
    ctx.stroke();
    // маркер улики
    ctx.save();
    ctx.translate(60, 46);
    ctx.beginPath();
    ctx.moveTo(-16, 14);
    ctx.lineTo(0, -16);
    ctx.lineTo(16, 14);
    ctx.closePath();
    ctx.fillStyle = '#f4c430';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = '16px "Russo One"';
    ctx.textAlign = 'center';
    ctx.fillText('1', 0, 10);
    ctx.restore();
  },

  bandage(ctx, a) {
    for (const rot of [0.62, -0.62]) {
      ctx.save();
      ctx.rotate(rot);
      rr(ctx, -88, -24, 176, 48, 24);
      ctx.fillStyle = '#e8b48a';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
      rr(ctx, -26, -17, 52, 34, 6);
      ctx.fillStyle = '#f7dfc7';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(28,21,16,.35)';
      for (const x of [-64, -50, 50, 64]) {
        for (const y of [-8, 8]) {
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    // «звёздочки из глаз»
    ctx.fillStyle = '#ffd43b';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    for (const [x, y, s] of [
      [-74, -78, 15],
      [78, -70, 12],
      [84, 70, 10],
    ]) {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? s * 0.42 : s;
        const t = (i / 10) * Math.PI * 2 - Math.PI / 2;
        ctx.lineTo(x + Math.cos(t) * r, y + Math.sin(t) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  },

  window(ctx, a) {
    rr(ctx, -74, -84, 148, 168, 4);
    const g = ctx.createLinearGradient(-74, -84, 74, 84);
    g.addColorStop(0, '#bcd9f2');
    g.addColorStop(1, '#6f9bc4');
    ctx.fillStyle = g;
    ctx.fill();
    // дыра
    const hole = [
      [10, -30],
      [34, -44],
      [44, -14],
      [30, 6],
      [40, 22],
      [8, 16],
      [-6, -6],
      [-20, -20],
    ];
    ctx.beginPath();
    hole.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = '#1a2230';
    ctx.fill();
    // трещины
    ctx.strokeStyle = 'rgba(28,21,16,.85)';
    ctx.lineWidth = 2.5;
    const { rnd } = makeNoise(213);
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2 + rnd() * 0.3;
      let x = 16 + Math.cos(t) * 24;
      let y = -12 + Math.sin(t) * 24;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        const tt = t + (rnd() - 0.5) * 0.5;
        x += Math.cos(tt) * 26;
        y += Math.sin(tt) * 26;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;
    for (const r of [52, 80]) {
      ctx.beginPath();
      for (let i = 0; i <= 14; i++) {
        const t = (i / 14) * Math.PI * 2;
        const rr2 = r + (rnd() - 0.5) * 14;
        ctx.lineTo(16 + Math.cos(t) * rr2, -12 + Math.sin(t) * rr2);
      }
      ctx.stroke();
    }
    // рама поверх
    ctx.lineWidth = 7;
    ctx.strokeStyle = INK;
    rr(ctx, -74, -84, 148, 168, 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -84);
    ctx.lineTo(0, -40);
    ctx.moveTo(0, 30);
    ctx.lineTo(0, 84);
    ctx.moveTo(-74, 0);
    ctx.lineTo(-24, 0);
    ctx.moveTo(56, 0);
    ctx.lineTo(74, 0);
    ctx.stroke();
    // кирпич
    ctx.save();
    ctx.translate(-66, 70);
    ctx.rotate(-0.4);
    rr(ctx, -30, -14, 60, 28, 3);
    ctx.fillStyle = '#b5523b';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.restore();
  },

  mask(ctx, a) {
    // голова в балаклаве
    ctx.beginPath();
    ctx.moveTo(0, -96);
    ctx.bezierCurveTo(70, -96, 80, -30, 76, 20);
    ctx.bezierCurveTo(72, 70, 40, 96, 0, 96);
    ctx.bezierCurveTo(-40, 96, -72, 70, -76, 20);
    ctx.bezierCurveTo(-80, -30, -70, -96, 0, -96);
    ctx.fillStyle = '#232329';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // вязка
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 2;
    for (let x = -70; x <= 70; x += 9) {
      ctx.beginPath();
      ctx.moveTo(x, -90);
      ctx.lineTo(x, 92);
      ctx.stroke();
    }
    // прорезь для глаз
    rr(ctx, -56, -34, 112, 38, 19);
    ctx.fillStyle = '#e2b08a';
    ctx.fill();
    // глаза косят в сторону
    for (const x of [-26, 26]) {
      ctx.beginPath();
      ctx.ellipse(x, -15, 16, 11, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + 7, -14, 6, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
    }
    // брови
    ctx.strokeStyle = '#3b2a20';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-42, -30);
    ctx.lineTo(-12, -26);
    ctx.moveTo(42, -30);
    ctx.lineTo(12, -26);
    ctx.stroke();
    // рот
    ctx.beginPath();
    ctx.ellipse(0, 46, 18, 11, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#e2b08a';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-9, 47);
    ctx.lineTo(9, 47);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.stroke();
  },

  terminal(ctx, a) {
    rr(ctx, -94, -76, 188, 152, 10);
    ctx.fillStyle = '#07110d';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    rr(ctx, -94, -76, 188, 22, [10, 10, 0, 0]);
    ctx.fillStyle = '#1f2d27';
    ctx.fill();
    ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(-80 + i * 14, -65, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });
    ctx.fillStyle = '#39ff9c';
    ctx.textAlign = 'left';
    ctx.font = '14px "PT Mono"';
    const lines = ['$ ssh root@сервер', '> пароль: ******', '> подбор… ▓▓▓▓▓░', '> ДОСТУП ПОЛУЧЕН', '$ rm -rf /улики'];
    lines.forEach((l, i) => ctx.fillText(l, -84, -32 + i * 22));
    ctx.fillRect(48, 50, 10, 16);
    // свечение строк
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#39ff9c';
    for (let y = -52; y < 74; y += 4) ctx.fillRect(-92, y, 184, 1);
    ctx.globalAlpha = 1;
  },
};

// ---------------------------------------------------------------- герб «весы»

export function drawScales(ctx, cx, cy, s, color, lw = 3) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s / 100, s / 100);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -46);
  ctx.lineTo(0, 40);
  ctx.moveTo(-26, 44);
  ctx.lineTo(26, 44);
  ctx.moveTo(-44, -32);
  ctx.quadraticCurveTo(0, -42, 44, -32);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -50, 5, 0, Math.PI * 2);
  ctx.fill();
  for (const sx of [-1, 1]) {
    const x = 44 * sx;
    ctx.beginPath();
    ctx.moveTo(x, -32);
    ctx.lineTo(x - 16, 4);
    ctx.moveTo(x, -32);
    ctx.lineTo(x + 16, 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 20, 4);
    ctx.quadraticCurveTo(x, 22, x + 20, 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- лицо карты

export function makeCardFront(idx) {
  const art = ARTICLES[idx];
  const [c, ctx] = canvas(CARD_W, CARD_H);
  const acc = art.color;
  const { rnd } = makeNoise(1000 + idx * 17);

  ctx.drawImage(paperLayer(), 0, 0);

  // кофейное пятно на некоторых делах
  if (rnd() > 0.45) {
    const x = 60 + rnd() * 390;
    const y = 120 + rnd() * 480;
    const r = 40 + rnd() * 30;
    ctx.strokeStyle = 'rgba(120,70,30,.13)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(x, y, r, 0.3, Math.PI * 1.8);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 3, y - 2, r - 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // рамки
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  rr(ctx, 18, 18, CARD_W - 36, CARD_H - 36, 26);
  ctx.stroke();
  ctx.strokeStyle = shade(acc, -0.25);
  ctx.lineWidth = 2;
  rr(ctx, 28, 28, CARD_W - 56, CARD_H - 56, 20);
  ctx.stroke();

  // шапка
  ctx.fillStyle = shade(acc, -0.35);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '22px "Russo One"';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.fillText('СТАТЬЯ', 46, 72);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.fillStyle = INK;
  const ns = fitFont(ctx, art.num, 300, 96, '"Russo One"');
  ctx.fillText(art.num, 42, 72 + ns * 0.92);

  ctx.textAlign = 'right';
  ctx.font = 'italic 20px "PT Serif"';
  ctx.fillStyle = 'rgba(28,21,16,.75)';
  ctx.fillText('УК РФ', CARD_W - 46, 70);
  ctx.font = '15px "PT Mono"';
  ctx.fillText(`ДЕЛО № ${String(1000 + Math.floor(rnd() * 8999))}`, CARD_W - 46, 94);

  // медальон
  const cx = CARD_W / 2;
  const cy = 330;
  const R = 148;
  const g = ctx.createRadialGradient(cx - 40, cy - 50, 10, cx, cy, R);
  g.addColorStop(0, shade(acc, 0.55));
  g.addColorStop(0.7, acc);
  g.addColorStop(1, shade(acc, -0.35));
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  // лучи в медальоне
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 18; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const t0 = (i / 18) * Math.PI * 2;
    ctx.arc(cx, cy, R, t0, t0 + Math.PI / 36);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([3, 7]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, R - 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1.18, 1.18);
  ctx.lineJoin = 'round';
  ICONS[art.icon](ctx, acc);
  ctx.restore();

  // название
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  fitFont(ctx, art.title.toUpperCase(), CARD_W - 90, 46, '"Russo One"');
  ctx.fillText(art.title.toUpperCase(), cx, 540);
  ctx.font = 'italic 30px "PT Serif"';
  ctx.fillStyle = shade(acc, -0.45);
  ctx.fillText(`«${art.nick}»`, cx, 580);

  // срок
  ctx.font = '22px "PT Mono"';
  const tw = ctx.measureText(art.term).width + 36;
  rr(ctx, cx - tw / 2, 606, tw, 42, 8);
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.fillStyle = PAPER;
  ctx.fillText(art.term, cx, 635);

  // печать
  ctx.save();
  ctx.translate(398, 196);
  ctx.rotate(-0.32);
  ctx.globalAlpha = 0.62;
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(0, 0, 54, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 40, 0, Math.PI * 2);
  ctx.stroke();
  ringText(ctx, '★ ВЕЩЕСТВЕННОЕ ДОКАЗАТЕЛЬСТВО ★', 0, 0, 47, -Math.PI / 2, '10px "Russo One"', '#b3261e');
  ctx.fillStyle = '#b3261e';
  ctx.font = '19px "Russo One"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(art.num, 0, 1);
  // «потёртости» печати
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 60; i++) {
    ctx.fillRect(rnd() * 120 - 60, rnd() * 120 - 60, 2 + rnd() * 5, 1 + rnd() * 2);
  }
  ctx.restore();

  // нижний угол
  ctx.save();
  ctx.translate(CARD_W - 50, CARD_H - 48);
  ctx.rotate(Math.PI);
  ctx.fillStyle = 'rgba(28,21,16,.55)';
  ctx.font = '22px "Russo One"';
  ctx.textAlign = 'left';
  ctx.fillText(art.num, 0, 0);
  ctx.restore();
  ctx.fillStyle = 'rgba(28,21,16,.55)';
  ctx.font = '13px "PT Mono"';
  ctx.textAlign = 'left';
  ctx.fillText('ХРАНИТЬ ВЕЧНО', 48, CARD_H - 44);

  return toTexture(c);
}

// ---------------------------------------------------------------- рубашка

export function makeCardBack() {
  const [c, ctx] = canvas(CARD_W, CARD_H);
  const g = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, 40, CARD_W / 2, CARD_H / 2, CARD_H * 0.7);
  g.addColorStop(0, '#6a1420');
  g.addColorStop(1, '#22060b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const gold = '#e9b44c';
  // гильош
  const cx = CARD_W / 2;
  const cy = CARD_H / 2;
  ctx.lineWidth = 1;
  for (let k = 0; k < 36; k++) {
    ctx.strokeStyle = `rgba(233,180,76,${0.1 + 0.08 * Math.sin(k)})`;
    ctx.beginPath();
    for (let i = 0; i <= 720; i++) {
      const t = (i / 720) * Math.PI * 2;
      const r = 150 + 34 * Math.sin(12 * t + k * 0.17) + 14 * Math.sin(5 * t - k * 0.3);
      const x = cx + Math.cos(t) * r * 1.0;
      const y = cy + Math.sin(t) * r * 1.38;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  // волны по краям
  for (let k = 0; k < 10; k++) {
    ctx.strokeStyle = 'rgba(233,180,76,.16)';
    ctx.beginPath();
    for (let x = 30; x <= CARD_W - 30; x += 2) {
      const y = 60 + k * 3 + Math.sin(x * 0.06 + k * 0.6) * 8;
      x === 30 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let x = 30; x <= CARD_W - 30; x += 2) {
      const y = CARD_H - 60 - k * 3 + Math.sin(x * 0.06 + k * 0.6) * 8;
      x === 30 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // рамки
  ctx.strokeStyle = gold;
  ctx.lineWidth = 5;
  rr(ctx, 20, 20, CARD_W - 40, CARD_H - 40, 24);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  rr(ctx, 32, 32, CARD_W - 64, CARD_H - 64, 18);
  ctx.stroke();
  // медальон
  ctx.beginPath();
  ctx.arc(cx, cy, 108, 0, Math.PI * 2);
  ctx.fillStyle = '#2a070d';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 94, 0, Math.PI * 2);
  ctx.stroke();
  drawScales(ctx, cx, cy + 4, 120, gold, 4);
  ringText(ctx, 'УГОЛОВНЫЙ · КОДЕКС · ИГРЫ ·', cx, cy, 80, -Math.PI / 2, '13px "Russo One"', gold);
  ctx.fillStyle = gold;
  ctx.textAlign = 'center';
  ctx.font = '26px "Russo One"';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
  ctx.fillText('УК · РФ', cx, 128);
  ctx.font = '15px "Russo One"';
  ctx.fillText('КАМЕНЬ · НОЖНИЦЫ · СТАТЬЯ', cx, CARD_H - 112);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  return toTexture(c);
}

// ---------------------------------------------------------------- стол

export function makeWood() {
  const W = 1024;
  const H = 1024;
  const [c, ctx] = canvas(W, H);
  const { fbm, noise, rnd } = makeNoise(42);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const planks = 7;
  const ph = H / planks;
  const seeds = Array.from({ length: planks }, () => ({ o: rnd() * 100, tone: 0.85 + rnd() * 0.3, joint: rnd() * W }));
  for (let y = 0; y < H; y++) {
    const pi = Math.floor(y / ph);
    const ly = y - pi * ph;
    const s = seeds[pi];
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const warp = fbm(x * 0.003 + s.o, ly * 0.012, 4) * 6;
      const ring = 0.5 + 0.5 * Math.sin((ly / ph) * 18 + warp * 3.2);
      const fine = noise(x * 0.4, ly * 0.04 + s.o);
      let v = (0.55 + 0.45 * ring) * (0.85 + 0.15 * fine) * s.tone;
      if (ly < 3 || ly > ph - 3) v *= 0.35;
      if (Math.abs(x - s.joint) < 2) v *= 0.45;
      d[i] = 74 * v + 10;
      d[i + 1] = 36 * v + 5;
      d[i + 2] = 19 * v + 4;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(c, { repeat: true });
  return t;
}

export function makeLeather(slots) {
  const W = 1024;
  const H = 576;
  const [c, ctx] = canvas(W, H);
  const { fbm, rnd } = makeNoise(9);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = fbm(x * 0.05, y * 0.05, 3);
      const cell = fbm(x * 0.012 + 3, y * 0.012, 3);
      const ex = Math.min(x, W - x) / W;
      const ey = Math.min(y, H - y) / H;
      let v = 0.7 + n * 0.35 + cell * 0.2 + (rnd() - 0.5) * 0.04;
      v *= 0.65 + Math.min(1, Math.min(ex, ey) * 6) * 0.35;
      d[i] = 22 * v;
      d[i + 1] = 66 * v;
      d[i + 2] = 46 * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const gold = '#c89b3c';
  ctx.strokeStyle = gold;
  ctx.lineWidth = 6;
  rr(ctx, 22, 22, W - 44, H - 44, 14);
  ctx.stroke();
  ctx.lineWidth = 2;
  rr(ctx, 36, 36, W - 72, H - 72, 10);
  ctx.stroke();
  // уголки
  for (const [x, y, sx, sy] of [
    [36, 36, 1, 1],
    [W - 36, 36, -1, 1],
    [36, H - 36, 1, -1],
    [W - 36, H - 36, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x + 10 * sx, y + 60 * sy);
    ctx.quadraticCurveTo(x + 10 * sx, y + 10 * sy, x + 60 * sx, y + 10 * sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 22 * sx, y + 22 * sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = gold;
    ctx.fill();
  }
  // тиснёный герб
  const cx = W / 2;
  const cy = H / 2;
  ctx.globalAlpha = 0.35;
  drawScales(ctx, cx + 1.5, cy + 1.5, 230, '#062016', 5);
  ctx.globalAlpha = 0.18;
  drawScales(ctx, cx, cy, 230, '#9fe0bf', 5);
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#9fe0bf';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 170, 0, Math.PI * 2);
  ctx.stroke();
  ringText(ctx, '· ИМЕНЕМ ИГРЫ · СУД ИДЁТ · ВСТАТЬ, СУД ИДЁТ', cx, cy, 152, -Math.PI / 2, '22px "Russo One"', '#9fe0bf');
  ctx.globalAlpha = 1;
  return toTexture(c);
}

export function makeSlotMarker() {
  const [c, ctx] = canvas(256, 358);
  ctx.strokeStyle = 'rgba(233,180,76,1)';
  ctx.lineWidth = 6;
  ctx.setLineDash([18, 12]);
  rr(ctx, 10, 10, 236, 338, 22);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.5;
  drawScales(ctx, 128, 179, 90, 'rgba(233,180,76,1)', 4);
  return toTexture(c);
}

export function makeBlob() {
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return toTexture(c, { srgb: false });
}

// Тень от решётки окна (для прожектора)
export function makeBars() {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 512, 512);
  ctx.filter = 'blur(5px)';
  ctx.fillStyle = '#fff';
  ctx.fillRect(96, 70, 320, 372);
  ctx.fillStyle = '#000';
  for (let i = 1; i < 6; i++) ctx.fillRect(96 + i * (320 / 6) - 9, 60, 18, 400);
  ctx.fillRect(86, 236, 340, 20);
  ctx.filter = 'none';
  return toTexture(c);
}

export function makeFolder(seed) {
  const [c, ctx] = canvas(512, 700);
  const { rnd } = makeNoise(seed);
  ctx.fillStyle = ['#c9b48a', '#bfa57a', '#d2c098'][seed % 3];
  ctx.fillRect(0, 0, 512, 700);
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#000' : '#fff';
    ctx.fillRect(rnd() * 512, rnd() * 700, 2, 2);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.font = '64px "Russo One"';
  ctx.fillText('ДЕЛО', 256, 190);
  ctx.font = '40px "PT Serif"';
  ctx.fillText(`№ ${Math.floor(100 + rnd() * 899)}`, 256, 250);
  ctx.textAlign = 'left';
  ctx.font = '26px "PT Serif"';
  const lines = ['Начато «__» ______ 20__ г.', 'Окончено «__» ______ 20__ г.', 'На ____ листах'];
  lines.forEach((l, i) => ctx.fillText(l, 60, 360 + i * 50));
  ctx.textAlign = 'center';
  ctx.font = '34px "Russo One"';
  ctx.fillText('ХРАНИТЬ ВЕЧНО', 256, 610);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(30, 30, 452, 640);
  return toTexture(c);
}
