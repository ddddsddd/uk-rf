// 3D-сцена: зал суда с фиксированной камерой, карты-статьи, шейдеры и постобработка.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ARTICLES, N } from '../shared/rules.js';
import * as TX from './textures.js';
import { sfx } from './audio.js';

const CW = 1.0;
const CH = 1.4;
const V3 = THREE.Vector3;
const tmpV = new V3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const UP = new V3(0, 1, 0);

// ---------------------------------------------------------------- GLSL

const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1.,0.)), u.x), mix(hash12(i+vec2(0.,1.)), hash12(i+vec2(1.,1.)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
`;

const CARD_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CARD_FS = /* glsl */ `
uniform sampler2D uFront; uniform sampler2D uBack;
uniform vec3 uAccent; uniform vec3 uLightPos; uniform vec3 uPolice;
uniform float uTime, uHover, uSelect, uBurn, uWin, uDim, uFlash, uFoil, uSeed;
varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;
${NOISE}
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main(){
  vec2 p = (vUv - 0.5) * vec2(1.0, 1.4);
  float d = sdRound(p, vec2(0.5, 0.7), 0.065);
  float aa = fwidth(d) * 1.2;
  float alpha = 1.0 - smoothstep(-aa, aa, d);
  if (alpha < 0.01) discard;

  // сгорание: шум + направление снизу вверх
  float bn = fbm(vUv * vec2(4.0, 5.6) + uSeed) * 0.7 + vUv.y * 0.3;
  float bt = uBurn * 1.3 - 0.15;
  float b = bn - bt;
  if (uBurn > 0.0 && b < 0.0) discard;

  bool front = gl_FrontFacing;
  vec2 tuv = front ? vUv : vec2(1.0 - vUv.x, vUv.y);
  vec3 col = front ? texture2D(uFront, tuv).rgb : texture2D(uBack, tuv).rgb;

  vec3 N = normalize(vN) * (front ? 1.0 : -1.0);
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 L = normalize(uLightPos - vWPos);
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, normalize(L + V)), 0.0), 48.0);
  col *= 0.52 + 0.6 * diff;
  col += spec * 0.1;

  // голографическая фольга: медальон и рамка лица, вся рубашка
  float medal = 1.0 - smoothstep(0.27, 0.29, length((vUv - vec2(0.5, 0.539)) * vec2(1.0, 1.4)));
  float frame = 1.0 - smoothstep(0.0, 0.035, abs(d + 0.03));
  float mask = front ? max(medal * 0.55, frame) : 0.45;
  float ang = dot(N, V);
  vec3 irid = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + ang * 1.7 + vUv.x * 0.9 + vUv.y * 0.7 + uTime * 0.06));
  float s = fract((vUv.x + vUv.y) * 0.5 - uTime * 0.32 + uSeed);
  float band = smoothstep(0.1, 0.0, abs(s - 0.5));
  float act = max(uHover, uSelect);
  col += irid * mask * uFoil * (0.12 + 0.5 * act) * 0.6;
  col += band * mask * uFoil * (0.1 + 0.5 * act);

  // свечение кромки
  float rim = exp(-abs(d) * 55.0);
  col += uAccent * rim * (uHover * 1.4 + uSelect * 2.2);
  float pulse = 0.65 + 0.35 * sin(uTime * 7.0);
  col += vec3(1.0, 0.72, 0.28) * (rim * 3.5 + band * 0.6 + 0.12) * uWin * pulse;

  col += uPolice * (0.25 + 0.75 * pow(1.0 - abs(ang), 2.0)) * 0.5;
  col = mix(col, col * 0.45, uDim);
  col += vec3(1.0, 0.92, 0.85) * uFlash * 1.6;

  if (uBurn > 0.0) {
    float ember = 1.0 - smoothstep(0.0, 0.035, b);
    float charr = 1.0 - smoothstep(0.0, 0.14, b);
    col = mix(col, vec3(0.03, 0.015, 0.01), charr * 0.9);
    col += vec3(5.0, 1.6, 0.3) * ember;
  }
  gl_FragColor = vec4(col, alpha);
}`;

const BG_FS = /* glsl */ `
uniform float uTime, uSiren; varying vec2 vUv;
${NOISE}
void main(){
  vec2 uv = vUv;
  float sm = fbm(uv * vec2(3.0, 2.0) + vec2(uTime * 0.015, -uTime * 0.01));
  float sm2 = fbm(uv * vec2(7.0, 3.0) - vec2(uTime * 0.025, uTime * 0.006));
  vec3 col = vec3(0.02, 0.015, 0.018) + vec3(0.07, 0.05, 0.045) * sm * sm2 * 1.6;
  float px = fract(uv.x * 16.0);
  col *= 0.75 + 0.25 * smoothstep(0.0, 0.04, px) * smoothstep(1.0, 0.96, px);
  float ph = uTime * 3.4;
  float red = pow(max(0.0, sin(ph)), 3.0);
  float blue = pow(max(0.0, sin(ph + 3.14159)), 3.0);
  float rg = exp(-length((uv - vec2(0.12, 0.3)) * vec2(1.4, 2.2)) * 2.6);
  float bg = exp(-length((uv - vec2(0.88, 0.3)) * vec2(1.4, 2.2)) * 2.6);
  col += (vec3(1.0, 0.06, 0.08) * red * rg + vec3(0.08, 0.25, 1.0) * blue * bg) * uSiren * (0.5 + sm);
  col += vec3(0.07, 0.045, 0.02) * smoothstep(0.55, 0.0, uv.y);
  gl_FragColor = vec4(col, 1.0);
}`;

const SIMPLE_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BEAM_FS = /* glsl */ `
uniform vec3 uColor; uniform float uProgress, uFade, uTime; varying vec2 vUv;
void main(){
  float along = vUv.x;
  if (along > uProgress) discard;
  float across = abs(vUv.y - 0.5) * 2.0;
  float core = exp(-across * across * 40.0);
  float glow = exp(-across * 3.0) * 0.45;
  float chev = smoothstep(0.3, 0.0, abs(fract(along * 6.0 - uTime * 3.5 - across * 0.35) - 0.5)) * (1.0 - across);
  float head = smoothstep(0.12, 0.0, uProgress - along) * 2.0;
  float tail = smoothstep(0.0, 0.12, along);
  vec3 c = uColor * (core * 3.0 + glow + chev * 1.1 + head * (1.0 - across)) * tail * (1.0 - uFade);
  gl_FragColor = vec4(c, 1.0);
}`;

const RING_FS = /* glsl */ `
uniform vec3 uColor; uniform float uT; varying vec2 vUv;
void main(){
  float r = length(vUv - 0.5) * 2.0;
  float w = 0.06 + uT * 0.1;
  float ring = smoothstep(w, 0.0, abs(r - uT));
  float fill = smoothstep(uT, 0.0, r) * 0.25;
  vec3 c = uColor * (ring * 2.5 + fill) * (1.0 - uT);
  gl_FragColor = vec4(c, 1.0);
}`;

const CONE_FS = /* glsl */ `
uniform float uTime, uI; varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;
${NOISE}
void main(){
  vec3 V = normalize(cameraPosition - vWPos);
  float f = pow(abs(dot(normalize(vN), V)), 1.5);
  float h = vUv.y;
  float n = fbm(vec2(vUv.x * 8.0 + uTime * 0.05, h * 3.0 - uTime * 0.12));
  float a = f * smoothstep(0.0, 0.5, h) * (0.5 + n) * uI;
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a, 1.0);
}`;

const CONE_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vWPos;
void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz; vN = mat3(modelMatrix) * normal; gl_Position = projectionMatrix * viewMatrix * wp; }`;

const PARTICLE_VS = /* glsl */ `
attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
uniform float uPx; varying vec3 vColor; varying float vAlpha;
void main(){
  vColor = aColor; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPx / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = /* glsl */ `
varying vec3 vColor; varying float vAlpha;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

const DUST_VS = /* glsl */ `
attribute float aSeed; uniform float uTime, uPx; varying float vA;
void main(){
  vec3 p = position;
  p.y = 0.2 + mod(p.y + uTime * (0.04 + aSeed * 0.05), 5.0);
  p.x += sin(uTime * 0.3 + aSeed * 40.0) * 0.35;
  p.z += cos(uTime * 0.23 + aSeed * 31.0) * 0.35;
  float lit = smoothstep(3.6, 0.6, length(p.xz - vec2(0.0, 0.3)));
  vA = lit * (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 1.7 + aSeed * 60.0))) * smoothstep(0.2, 0.8, p.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (0.025 + aSeed * 0.03) * uPx / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const DUST_FS = /* glsl */ `
varying float vA;
void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA * 0.7; gl_FragColor = vec4(vec3(1.0, 0.85, 0.6) * a, 1.0); }`;

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberr: { value: 0 },
    uFlash: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: SIMPLE_VS,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse; uniform float uTime, uAberr, uFlash; uniform vec2 uRes; varying vec2 vUv;
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 c = vUv - 0.5;
  float k = (0.0015 + uAberr * 0.012) * (0.4 + dot(c, c) * 3.0);
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + c * k).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - c * k).b;
  float vig = smoothstep(0.95, 0.25, length(c * vec2(1.0, 1.15)));
  col *= mix(0.35, 1.0, vig);
  col += (h(vUv * uRes + fract(uTime * 7.0) * 100.0) - 0.5) * 0.045;
  col += vec3(1.0, 0.95, 0.88) * uFlash;
  gl_FragColor = vec4(col, 1.0);
}`,
};

// ---------------------------------------------------------------- твины

const ease = {
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
  in: (k) => k * k * k,
  outBack: (k) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  },
  lin: (k) => k,
};

const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

// ---------------------------------------------------------------- частицы

class Particles {
  constructor(max, px) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPx: px },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  spawn(at, color, count, o = {}) {
    const c = new THREE.Color(color);
    const speed = o.speed ?? 3;
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const spread = o.spread ?? 0.05;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * spread * (o.sx ?? 1);
      this.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * spread * (o.sy ?? 1);
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * spread * (o.sz ?? 1);
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this.vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * (o.upBias ?? 1) + (o.up ?? 0);
      this.vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      const hueJit = o.white && Math.random() < 0.35 ? 1 : 0;
      this.col[i * 3] = hueJit ? 3 : c.r * 3;
      this.col[i * 3 + 1] = hueJit ? 2.6 : c.g * 3;
      this.col[i * 3 + 2] = hueJit ? 2.2 : c.b * 3;
      this.maxLife[i] = this.life[i] = (o.life ?? 0.8) * (0.6 + Math.random() * 0.6);
      this.size[i] = (o.size ?? 0.07) * (0.5 + Math.random());
      this.grav[i] = o.gravity ?? -7;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] += this.grav[i] * dt;
      const drag = Math.exp(-dt * 1.8);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02) {
        this.pos[i * 3 + 1] = 0.02;
        this.vel[i * 3 + 1] *= -0.35;
      }
      this.alpha[i] = k;
    }
    for (const a of ['position', 'aColor', 'aAlpha', 'aSize']) this.geo.attributes[a].needsUpdate = true;
  }
}

// ---------------------------------------------------------------- карта

class Card {
  constructor(sc, idx) {
    this.sc = sc;
    this.idx = idx;
    this.u = {
      uFront: { value: idx >= 0 ? sc.fronts[idx] : sc.backTex },
      uBack: { value: sc.backTex },
      uAccent: { value: new THREE.Color(idx >= 0 ? ARTICLES[idx].color : '#e9b44c') },
      uTime: sc.uTime,
      uLightPos: sc.uLightPos,
      uPolice: sc.uPolice,
      uHover: { value: 0 },
      uSelect: { value: 0 },
      uBurn: { value: 0 },
      uWin: { value: 0 },
      uDim: { value: 0 },
      uFlash: { value: 0 },
      uFoil: { value: 1 },
      uSeed: { value: Math.random() * 50 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: CARD_VS,
      fragmentShader: CARD_FS,
      side: THREE.DoubleSide,
      alphaToCoverage: true,
    });
    this.mesh = new THREE.Mesh(sc.cardGeo, this.mat);
    this.mesh.userData.card = this;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    sc.scene.add(this.group);
    this.shadow = new THREE.Mesh(sc.blobGeo, sc.blobMat.clone());
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    sc.scene.add(this.shadow);

    this.poseFn = null;
    this.follow = true;
    this.speed = 9;
    this.flip = 0;
    this.lift = 0;
    this.offset = new V3();
    this.spin = 0;
    this.hover = 0;
    this.hoverTarget = 0;
    this.select = 0;
    this.selectTarget = 0;
    this.dim = 0;
    this.dimTarget = 0;
    this.scaleMul = 1;
    this.target = { pos: new V3(), quat: new THREE.Quaternion(), scale: 1 };
  }

  setIdx(idx) {
    this.idx = idx;
    this.u.uFront.value = idx >= 0 ? this.sc.fronts[idx] : this.sc.backTex;
    this.u.uAccent.value.set(idx >= 0 ? ARTICLES[idx].color : '#e9b44c');
  }

  computeTarget(t) {
    if (!this.poseFn) return;
    const p = this.poseFn(this, t);
    this.target.pos.copy(p.pos).add(this.offset);
    this.target.pos.y += this.lift;
    this.target.quat.copy(p.quat);
    this.target.scale = p.scale * this.scaleMul;
  }

  snap(t = 0) {
    this.computeTarget(t);
    this.group.position.copy(this.target.pos);
    this.group.quaternion.copy(this.target.quat);
    this.group.scale.setScalar(this.target.scale);
  }

  // перелёт по дуге в позу poseFn
  flyTo(poseFn, dur = 0.6, arc = 0.8) {
    const from = {
      pos: this.group.position.clone(),
      quat: this.group.quaternion.clone(),
      scale: this.group.scale.x,
    };
    this.poseFn = poseFn;
    this.follow = false;
    const token = (this.flyToken = {});
    return this.sc.tween(dur, ease.inOut, (k) => {
      if (this.flyToken !== token) return;
      this.computeTarget(this.sc.time);
      this.group.position.lerpVectors(from.pos, this.target.pos, k);
      this.group.position.y += Math.sin(k * Math.PI) * arc;
      this.group.quaternion.slerpQuaternions(from.quat, this.target.quat, k);
      this.group.scale.setScalar(THREE.MathUtils.lerp(from.scale, this.target.scale, k));
    }).then(() => {
      if (this.flyToken === token) this.follow = true;
    });
  }

  update(dt, t) {
    const k = 1 - Math.exp(-dt * this.speed);
    if (this.follow && this.poseFn) {
      this.computeTarget(t);
      this.group.position.lerp(this.target.pos, k);
      this.group.quaternion.slerp(this.target.quat, k);
      const s = THREE.MathUtils.lerp(this.group.scale.x, this.target.scale, k);
      this.group.scale.setScalar(s);
    }
    this.mesh.rotation.y = this.flip + this.spin;
    const kk = 1 - Math.exp(-dt * 10);
    this.hover += (this.hoverTarget - this.hover) * kk;
    this.select += (this.selectTarget - this.select) * kk;
    this.dim += (this.dimTarget - this.dim) * kk;
    this.u.uHover.value = this.hover;
    this.u.uSelect.value = this.select;
    this.u.uDim.value = this.dim;

    const y = this.group.position.y;
    const near = y < 2.2 && this.mesh.visible;
    this.shadow.visible = near;
    if (near) {
      this.shadow.position.set(this.group.position.x, 0.012, this.group.position.z + 0.05);
      const s = this.group.scale.x * (1.25 + y * 0.35);
      this.shadow.scale.set(s, s * 1.2, 1);
      this.shadow.material.opacity = Math.max(0, 0.75 - y * 0.32) * (1 - this.u.uBurn.value);
    }
  }

  dispose() {
    this.sc.scene.remove(this.group);
    this.sc.scene.remove(this.shadow);
    this.mat.dispose();
    this.shadow.material.dispose();
    this.flyToken = null;
  }
}

// ---------------------------------------------------------------- сцена

export class GameScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = 0;
    this.tweens = new Set();
    this.uTime = { value: 0 };
    this.uLightPos = { value: new V3(0.3, 10, 1.2) };
    this.uPolice = { value: new THREE.Color(0, 0, 0) };
    this.uPx = { value: 800 };
    this.mode = 'menu';
    this.handEnabled = false;
    this.hovered = null;
    this.focused = null;
    this.pointer = new THREE.Vector2(-10, -10);
    this.pointerInside = false;
    this.siren = 0.06;
    this.sirenTarget = 0.06;
    this.shake = 0;
    this.aberr = 0;
    this.flash = 0;
    this.layout = { players: [], myId: null };
    this.slots = new Map(); // id -> {pos, deck}
    this.slotCards = new Map(); // id -> Card
    this.decks = new Map(); // id -> Group
    this.onPick = () => {};
    this.onHover = () => {};
    this.onFrame = () => {};
  }

  tween(dur, easing, fn, delay = 0) {
    return new Promise((resolve) => {
      this.tweens.add({ t: -delay, dur, easing, fn, resolve });
    });
  }

  async init() {
    const isMobile = matchMedia('(pointer: coarse)').matches;
    this.isMobile = isMobile;
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    // тени отбрасывают только неподвижные предметы и молоток — перерисовываем по требованию
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    this.renderer = r;
    this.maxPR = Math.min(devicePixelRatio, isMobile ? 1.5 : 2);
    // ?q=low — минимум эффектов, ?q=high — максимум без автоснижения
    const qp = new URLSearchParams(location.search).get('q');
    this.quality = qp === 'low' ? 0 : 2;
    this.adaptive = qp !== 'low' && qp !== 'high';
    this.perf = { t: 0, frames: 0 };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x050405);
    scene.fog = new THREE.Fog(0x050405, 16, 34);
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.22;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
    this.camRest = new V3(0, 8.4, 8.2);
    this.camLook = new V3(0, 0, 0.35);
    this.camera.position.copy(this.camRest);
    this.camera.lookAt(this.camLook);

    // текстуры
    this.fronts = ARTICLES.map((_, i) => TX.makeCardFront(i));
    this.backTex = TX.makeCardBack();
    this.cardGeo = new THREE.PlaneGeometry(CW, CH);
    this.blobGeo = new THREE.PlaneGeometry(CW, CH);
    this.blobMat = new THREE.MeshBasicMaterial({ map: TX.makeBlob(), transparent: true, depthWrite: false, color: 0x000000 });
    const maxAniso = r.capabilities.getMaxAnisotropy();
    for (const t of [...this.fronts, this.backTex]) t.anisotropy = maxAniso;

    this.buildRoom();
    this.buildProps();

    this.particles = new Particles(900, this.uPx);
    scene.add(this.particles.points);

    // карты в руке
    this.handCards = ARTICLES.map((_, i) => {
      const c = new Card(this, i);
      c.handIndex = i;
      c.poseFn = (card, t) => this.ringPose(card.handIndex, t);
      c.snap(0);
      return c;
    });

    // постобработка
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(r, rt);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.88);
    this.composer.addPass(this.bloom);
    this.applyQuality();
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);

    this.raycaster = new THREE.Raycaster();
    this.bindPointer();
    this.resize();
    addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------ окружение

  buildRoom() {
    const scene = this.scene;
    // свет
    scene.add(new THREE.HemisphereLight(0x8d9cc0, 0x1a0f08, 0.55));

    const key = new THREE.SpotLight(0xffdcb0, 380, 30, 0.6, 0.6, 1.5);
    key.position.copy(this.uLightPos.value);
    key.target.position.set(0, 0, 0.3);
    key.castShadow = true;
    key.shadow.mapSize.set(this.isMobile ? 1024 : 2048, this.isMobile ? 1024 : 2048);
    key.shadow.bias = -0.0005;
    key.shadow.camera.near = 3;
    key.shadow.camera.far = 16;
    scene.add(key, key.target);
    this.key = key;

    const moon = new THREE.SpotLight(0x86a8ff, 260, 40, 0.36, 0.35, 1.4);
    moon.position.set(-8.5, 10, -7);
    moon.target.position.set(0.8, 0, 0.8);
    moon.map = TX.makeBars();
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    scene.add(moon, moon.target);

    this.policeR = new THREE.PointLight(0xff1a2a, 0, 16, 1.4);
    this.policeR.position.set(-7, 2.4, -1.2);
    this.policeB = new THREE.PointLight(0x1f4dff, 0, 16, 1.4);
    this.policeB.position.set(7, 2.4, -1.2);
    scene.add(this.policeR, this.policeB);

    // стол
    const wood = TX.makeWood();
    wood.repeat.set(1.3, 1);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.5, 8.6),
      new THREE.MeshStandardMaterial({ map: wood, roughness: 0.42, metalness: 0.0, bumpMap: wood, bumpScale: 1.2 }),
    );
    top.position.set(0, -0.25, 0.2);
    top.receiveShadow = true;
    scene.add(top);

    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(14.1, 0.08, 8.7),
      new THREE.MeshStandardMaterial({ color: 0xb08a3c, metalness: 1, roughness: 0.35 }),
    );
    trim.position.set(0, -0.48, 0.2);
    scene.add(trim);

    const leather = new THREE.Mesh(
      new THREE.PlaneGeometry(9.4, 5.3),
      new THREE.MeshStandardMaterial({ map: TX.makeLeather(), roughness: 0.78, metalness: 0.0 }),
    );
    leather.rotation.x = -Math.PI / 2;
    leather.position.set(0, 0.004, 0.0);
    leather.receiveShadow = true;
    scene.add(leather);

    // пол и задник
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x0a0807, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3.2;
    scene.add(floor);

    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uSiren: { value: 0.06 } },
      vertexShader: SIMPLE_VS,
      fragmentShader: BG_FS,
      depthWrite: false,
      fog: false,
    });
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(60, 26), this.bgMat);
    bg.position.set(0, 4, -9);
    scene.add(bg);

    // световой конус от лампы допроса
    this.coneMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uI: { value: 0.05 } },
      vertexShader: CONE_VS,
      fragmentShader: CONE_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 4.2, 10, 48, 1, true), this.coneMat);
    cone.position.set(0.15, 5, 0.75);
    scene.add(cone);

    // пыль в луче
    const n = this.isMobile ? 160 : 320;
    const dp = new Float32Array(n * 3);
    const ds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 8;
      dp[i * 3 + 1] = Math.random() * 5;
      dp[i * 3 + 2] = (Math.random() - 0.5) * 6;
      ds[i] = Math.random();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(ds, 1));
    const dust = new THREE.Points(
      dg,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.uTime, uPx: this.uPx },
        vertexShader: DUST_VS,
        fragmentShader: DUST_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    dust.frustumCulled = false;
    scene.add(dust);

    // маркер слота
    this.slotTex = TX.makeSlotMarker();
  }

  buildProps() {
    const scene = this.scene;
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1, roughness: 0.3 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x3a1c0e, roughness: 0.45 });
    const shadowAll = (o) =>
      o.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });

    // банковская лампа
    const lamp = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.1, 40), brass);
    base.position.y = 0.05;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.0, 16), brass);
    stem.position.y = 0.6;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 12), brass);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, 1.08, 0.2);
    const shadeGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.1, 32, 1, true, 0, Math.PI);
    shadeGeo.rotateZ(Math.PI / 2);
    const shade = new THREE.Mesh(
      shadeGeo,
      new THREE.MeshStandardMaterial({
        color: 0x0c5a2c,
        emissive: 0x0b6a2a,
        emissiveIntensity: 0.55,
        roughness: 0.18,
        metalness: 0.1,
        side: THREE.DoubleSide,
      }),
    );
    shade.position.set(0, 1.15, 0.42);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 2.8, 1.4) }));
    bulb.position.set(0, 1.08, 0.42);
    lamp.add(base, stem, arm, shade, bulb);
    shadowAll(lamp);
    bulb.castShadow = false;
    lamp.position.set(-5.2, 0, -2.4);
    lamp.rotation.y = 0.5;
    scene.add(lamp);
    const lampLight = new THREE.PointLight(0xffc27a, 4.5, 6, 1.6);
    lampLight.position.set(-5.0, 0.9, -2.0);
    scene.add(lampLight);

    // молоток судьи и подставка
    const block = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.12, 40), darkWood);
    block.position.set(4.75, 0.06, -0.55);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.018, 8, 48), brass);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(4.75, 0.1, -0.55);
    scene.add(block, ring);
    shadowAll(block);

    const gavel = new THREE.Group();
    const swing = new THREE.Group();
    gavel.add(swing);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.2, 16), darkWood);
    handle.rotation.z = -Math.PI / 2;
    handle.position.set(0.6, 0.0, 0);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.56, 28), darkWood);
    head.rotation.x = Math.PI / 2;
    head.position.set(1.2, 0.0, 0);
    swing.add(handle, head);
    for (const z of [-0.2, 0.2]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.172, 0.018, 8, 32), brass);
      band.position.set(1.2, 0, z);
      swing.add(band);
    }
    shadowAll(gavel);
    const dir = new V3(0.62, 0, 0.78).normalize();
    gavel.position.set(4.75 + dir.x * 1.2, 0.29, -0.55 + dir.z * 1.2);
    gavel.rotation.y = Math.atan2(dir.z, -dir.x);
    swing.rotation.z = 0.02;
    scene.add(gavel);
    this.gavelSwing = swing;

    // наручники
    const steel = new THREE.MeshStandardMaterial({ color: 0xc4c8d0, metalness: 1, roughness: 0.22 });
    const cuffs = new THREE.Group();
    for (const x of [-0.36, 0.36]) {
      const c = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 12, 40), steel);
      c.rotation.x = Math.PI / 2;
      c.position.set(x, 0.04, 0);
      cuffs.add(c);
    }
    for (let i = 0; i < 3; i++) {
      const l = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 8, 16), steel);
      l.position.set(-0.1 + i * 0.1, 0.04, 0);
      l.rotation.set(i % 2 ? 0 : Math.PI / 2, 0, 0);
      cuffs.add(l);
    }
    shadowAll(cuffs);
    cuffs.position.set(4.9, 0, 1.55);
    cuffs.rotation.y = -0.5;
    scene.add(cuffs);

    // стопка дел
    const card = new THREE.MeshStandardMaterial({ color: 0xb59c70, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const top = new THREE.MeshStandardMaterial({ map: TX.makeFolder(i + 3), roughness: 0.85 });
      const f = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 2.05), [card, card, top, card, card, card]);
      f.position.set(-5.0 + (Math.random() - 0.5) * 0.12, 0.03 + i * 0.065, 0.9);
      f.rotation.y = 0.18 + (Math.random() - 0.5) * 0.25;
      f.castShadow = f.receiveShadow = true;
      scene.add(f);
    }
  }

  // ------------------------------------------------------------ раскладка

  setLayout(players, myId) {
    this.layout = { players, myId };
    const others = players.filter((p) => p.id !== myId);
    const slotsPos = {};
    if (myId) slotsPos[myId] = { slot: new V3(0, 0, 1.15), deck: null };
    if (others.length === 1) {
      slotsPos[others[0].id] = { slot: new V3(0, 0, -1.15), deck: new V3(0, 0, -2.75), side: 0 };
    } else if (others.length >= 2) {
      slotsPos[others[0].id] = { slot: new V3(-2.05, 0, -0.85), deck: new V3(-3.55, 0, -2.25), side: -1 };
      slotsPos[others[1].id] = { slot: new V3(2.05, 0, -0.85), deck: new V3(3.55, 0, -2.25), side: 1 };
    }
    this.slots = new Map(Object.entries(slotsPos));

    // карты ушедших игроков убираем со стола
    for (const [id, c] of this.slotCards) {
      if (slotsPos[id]) continue;
      this.slotCards.delete(id);
      if (c.handIndex === undefined) c.dispose();
    }

    // колоды соперников
    for (const [id, g] of this.decks) {
      if (!slotsPos[id]?.deck) {
        this.scene.remove(g);
        this.decks.delete(id);
      }
    }
    for (const p of others) {
      const s = slotsPos[p.id];
      if (!s?.deck) continue;
      let g = this.decks.get(p.id);
      if (!g) {
        g = this.makeDeck(p.color);
        this.decks.set(p.id, g);
        this.scene.add(g);
      }
      g.position.copy(s.deck);
      g.rotation.y = (s.side || 0) * -0.35;
    }

    // маркеры слотов
    if (!this.markers) this.markers = new Map();
    for (const [id, m] of this.markers) {
      if (!slotsPos[id]) {
        this.scene.remove(m);
        this.markers.delete(id);
      }
    }
    for (const [id, s] of this.slots) {
      let m = this.markers.get(id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.PlaneGeometry(CW * 1.3, CH * 1.3),
          new THREE.MeshBasicMaterial({ map: this.slotTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3 }),
        );
        m.rotation.x = -Math.PI / 2;
        this.markers.set(id, m);
        this.scene.add(m);
      }
      m.position.set(s.slot.x, 0.01, s.slot.z + 0.15);
      const p = players.find((x) => x.id === id);
      m.material.color.set(p?.color || '#e9b44c');
    }
  }

  makeDeck(color) {
    const g = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(
        this.cardGeo,
        new THREE.MeshStandardMaterial({ map: this.backTex, roughness: 0.5, metalness: 0.1 }),
      );
      c.rotation.set(-Math.PI / 2, 0, (Math.random() - 0.5) * 0.12);
      c.position.set((Math.random() - 0.5) * 0.04, 0.012 + i * 0.012, (Math.random() - 0.5) * 0.04);
      c.castShadow = c.receiveShadow = true;
      g.add(c);
    }
    g.scale.setScalar(0.85);
    return g;
  }

  // поза карты в руке (в координатах камеры, переведённых в мир)
  computeHandLayout() {
    const aspect = this.width / this.height;
    const portrait = aspect < 0.95;
    const D = 5;
    const vH = 2 * D * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const vW = vH * aspect;
    const out = [];
    if (!portrait) {
      const s = Math.min((vH * 0.27) / CH, 1);
      const cw = CW * s;
      const spacing = Math.min(cw * 1.04, (vW * 0.95 - cw) / 9);
      for (let i = 0; i < N; i++) {
        const u = i - 4.5;
        out.push({
          x: u * spacing,
          y: -vH / 2 + CH * s * 0.5 + vH * 0.025 - u * u * 0.0035 * vH,
          z: -D + i * 0.004,
          rz: -u * 0.03,
          s,
        });
      }
    } else {
      const s = Math.min((vW * 0.95) / 5 / CW, (vH * 0.15) / CH);
      const cw = CW * s;
      const ch = CH * s;
      for (let i = 0; i < N; i++) {
        const row = i < 5 ? 1 : 0;
        const col = i % 5;
        out.push({
          x: (col - 2) * cw * 1.02,
          y: -vH / 2 + ch * 0.5 + vH * 0.02 + row * ch * 1.04,
          z: -D + i * 0.004,
          rz: 0,
          s,
        });
      }
    }
    this.handLayout = out;
    this.handVH = vH;
  }

  handPose(i) {
    const L = this.handLayout[i];
    const c = this.handCards[i];
    const h = c.hover;
    // во время вскрытия рука уходит вниз, освобождая место под вердикт
    const dimDrop = c.dim * CH * L.s * (this.revealing ? 0.62 : 0.12);
    tmpV.set(L.x, L.y + h * CH * L.s * 0.22 - dimDrop, L.z + h * 0.4);
    const pos = tmpV.clone().applyMatrix4(this.camMatrix);
    tmpE.set(-0.06, 0, L.rz * (1 - h));
    const quat = this.camQuat.clone().multiply(tmpQ.setFromEuler(tmpE));
    return { pos, quat, scale: L.s * (1 + h * 0.16) };
  }

  ringPose(i, t) {
    const aspect = this.width / this.height || 1.6;
    const R = aspect < 0.95 ? 2.1 : 3.6;
    const a = (i / N) * Math.PI * 2 + t * 0.16;
    const pos = new V3(Math.cos(a) * R, 1.7 + Math.sin(t * 1.2 + i) * 0.12, Math.sin(a) * R * 0.55 + 0.2);
    const o = new THREE.Object3D();
    o.position.copy(pos);
    o.lookAt(pos.x * 2, pos.y + 2.4, pos.z * 2 + 2.2);
    return { pos, quat: o.quaternion.clone(), scale: aspect < 0.95 ? 0.8 : 1.05 };
  }

  slotPose(id, card, t) {
    const s = this.slots.get(id);
    const base = s ? s.slot : new V3(0, 0, 0);
    const bob = Math.sin(t * 1.6 + (card.u.uSeed.value % 6)) * 0.03;
    const pos = new V3(base.x, 0.55 + bob, base.z);
    tmpE.set(-Math.PI / 2 + 0.85, 0, 0);
    const quat = new THREE.Quaternion().setFromEuler(tmpE);
    return { pos, quat, scale: 1.15 };
  }

  deckPose(id) {
    const s = this.slots.get(id);
    const pos = s?.deck ? s.deck.clone() : new V3(0, 0, -3);
    pos.y = 0.1;
    tmpE.set(-Math.PI / 2, 0, 0);
    return { pos, quat: new THREE.Quaternion().setFromEuler(tmpE), scale: 0.85 };
  }

  // ------------------------------------------------------------ режимы

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'game') {
      this.sirenTarget = 0.06;
      this.handCards.forEach((c, i) => {
        if (this.isInSlot(c)) return;
        c.flip = 0;
        c.spin = 0;
        c.flyTo(() => this.handPose(i), 0.7 + i * 0.04, 0.3);
      });
    } else {
      this.clearTable(true);
      this.handCards.forEach((c, i) => {
        c.hoverTarget = 0;
        c.selectTarget = 0;
        c.dimTarget = 0;
        c.u.uBurn.value = 0;
        c.u.uWin.value = 0;
        c.offset.set(0, 0, 0);
        c.lift = 0;
        c.flyTo((card, t) => this.ringPose(i, t), 0.9 + i * 0.03, 0.5);
      });
      this.setLayout([], null);
      this.sirenTarget = mode === 'over' ? 0.6 : 0.06;
    }
  }

  isInSlot(card) {
    for (const c of this.slotCards.values()) if (c === card) return true;
    return false;
  }

  setHandEnabled(on) {
    this.handEnabled = on;
    for (const c of this.handCards) {
      if (!this.isInSlot(c)) c.dimTarget = on ? 0 : 1;
    }
    if (!on) {
      this.setHovered(null);
      this.focused = null;
    }
    for (const [id, m] of this.markers || []) m.userData.pulse = on;
  }

  // ------------------------------------------------------------ выбор

  pickLocal(idx) {
    const myId = this.layout.myId;
    const prev = this.slotCards.get(myId);
    if (prev === this.handCards[idx]) return;
    if (prev) this.returnToHand(prev);
    const c = this.handCards[idx];
    c.hoverTarget = 0;
    c.selectTarget = 1;
    c.dimTarget = 0;
    this.slotCards.set(myId, c);
    c.flyTo((card, t) => this.slotPose(myId, card, t), 0.55, 0.9);
    sfx.card();
  }

  returnToHand(c) {
    c.selectTarget = 0;
    c.u.uWin.value = 0;
    c.offset.set(0, 0, 0);
    c.lift = 0;
    c.dimTarget = this.handEnabled ? 0 : 1;
    if (c.u.uBurn.value > 0) {
      const from = c.u.uBurn.value;
      this.tween(0.8, ease.out, (k) => (c.u.uBurn.value = from * (1 - k)));
    }
    c.flyTo(() => this.handPose(c.handIndex), 0.6, 0.6);
  }

  opponentPicked(id) {
    if (this.slotCards.has(id) || !this.slots.has(id)) return;
    const c = new Card(this, -1);
    c.flip = Math.PI;
    c.poseFn = () => this.deckPose(id);
    c.snap();
    this.slotCards.set(id, c);
    c.flyTo((card, t) => this.slotPose(id, card, t), 0.6, 1.0);
    sfx.card();
  }

  // ------------------------------------------------------------ вскрытие

  async reveal(data, myId, hooks = {}) {
    this.revealing = true;
    this.setHandEnabled(false);
    const ids = Object.keys(data.picks).filter((id) => this.slots.has(id));
    for (const id of ids) {
      const idx = data.picks[id];
      let card = this.slotCards.get(id);
      if (id === myId) {
        if (!card || card.idx !== idx) {
          if (card) this.returnToHand(card);
          card = this.handCards[idx];
          card.selectTarget = 1;
          card.dimTarget = 0;
          this.slotCards.set(id, card);
          card.flyTo((cd, t) => this.slotPose(id, cd, t), 0.4, 0.6);
        }
      } else {
        if (!card) {
          card = new Card(this, idx);
          card.flip = Math.PI;
          card.poseFn = (cd, t) => this.slotPose(id, cd, t);
          card.snap(this.time);
          this.slotCards.set(id, card);
        } else {
          card.setIdx(idx);
        }
      }
    }
    this.sirenTarget = 0.85;
    await wait(0.45);

    // переворот карт соперников
    sfx.flip();
    const flips = [];
    for (const id of ids) {
      const c = this.slotCards.get(id);
      if (!c || c.flip === 0) continue;
      flips.push(
        this.tween(0.75, ease.inOut, (k) => {
          c.flip = Math.PI * (1 - k);
          c.lift = Math.sin(k * Math.PI) * 0.7;
        }),
      );
    }
    await Promise.all(flips);
    for (const id of ids) {
      const c = this.slotCards.get(id);
      if (c) c.u.uFlash.value = 0.6;
    }
    this.fadeUniform(ids.map((id) => this.slotCards.get(id)?.u.uFlash).filter(Boolean), 0.5);
    await wait(0.7);

    const tally = Object.fromEntries(ids.map((id) => [id, { w: 0, l: 0 }]));
    for (let i = 0; i < data.pairs.length; i++) {
      const pr = data.pairs[i];
      const a = this.slotCards.get(pr.a);
      const b = this.slotCards.get(pr.b);
      hooks.onPair?.(pr, i);
      if (!a || !b) {
        await wait(1.4);
        continue;
      }
      if (pr.winner) {
        tally[pr.winner].w++;
        tally[pr.loser].l++;
        await this.animateWin(this.slotCards.get(pr.winner), this.slotCards.get(pr.loser), pr.winner === myId, pr.loser === myId);
      } else {
        await this.animateDraw(a, b);
      }
      await wait(0.75);
    }
    hooks.onSummary?.();

    // итог раунда для каждой карты
    for (const id of ids) {
      const c = this.slotCards.get(id);
      const t = tally[id];
      if (!c || !t) continue;
      if (t.w > 0 && t.l === 0) {
        this.tween(0.5, ease.out, (k) => (c.u.uWin.value = k));
        this.tween(0.6, ease.outBack, (k) => (c.lift = k * 0.35));
        if (id === myId) sfx.win();
      } else if (t.l > 0 && t.w === 0) {
        this.burn(c);
        if (id === myId) sfx.lose();
      }
    }
    await wait(1.8);
    this.sirenTarget = 0.06;
    this.revealing = false;
  }

  fadeUniform(list, dur) {
    const from = list.map((u) => u.value);
    this.tween(dur, ease.out, (k) => list.forEach((u, i) => (u.value = from[i] * (1 - k))));
  }

  async animateWin(w, l, iWon, iLost) {
    const color = new THREE.Color(ARTICLES[w.idx]?.color || '#ffd27a');
    // победитель поднимается и наклоняется
    const dir = new V3().subVectors(l.group.position, w.group.position).setY(0).normalize();
    this.tween(0.35, ease.out, (k) => {
      w.lift = k * 0.55;
      w.offset.copy(dir).multiplyScalar(k * 0.25);
    });
    this.swingGavel(0.25);
    await wait(0.25);
    const beam = this.makeBeam(w.group.position, l.group.position, color);
    await this.tween(0.32, ease.in, (k) => (beam.material.uniforms.uProgress.value = k));
    // удар
    sfx.hit();
    this.impact(l.group.position, color, iLost ? 1.4 : 1);
    l.u.uFlash.value = 1;
    this.fadeUniform([l.u.uFlash], 0.6);
    this.tween(0.5, ease.lin, (k) => {
      const s = (1 - k) * 0.12;
      l.offset.set(Math.sin(k * 60) * s, 0, Math.cos(k * 47) * s * 0.5);
    }).then(() => l.offset.set(0, 0, 0));
    await this.tween(0.5, ease.out, (k) => (beam.material.uniforms.uFade.value = k));
    this.scene.remove(beam);
    beam.material.dispose();
    this.tween(0.4, ease.inOut, (k) => {
      w.lift = 0.55 * (1 - k) + 0.1 * k;
      w.offset.copy(dir).multiplyScalar(0.25 * (1 - k));
    });
  }

  async animateDraw(a, b) {
    const pa = a.group.position.clone();
    const pb = b.group.position.clone();
    const mid = pa.clone().lerp(pb, 0.5);
    const da = new V3().subVectors(pb, pa).setY(0);
    await this.tween(0.35, ease.in, (k) => {
      a.offset.copy(da).multiplyScalar(k * 0.22);
      b.offset.copy(da).multiplyScalar(-k * 0.22);
      a.lift = b.lift = k * 0.3;
    });
    sfx.clash();
    this.particles.spawn(mid.setY(0.8), '#cfd6e6', 40, { speed: 3.5, life: 0.6, size: 0.06, white: true });
    this.aberr = Math.max(this.aberr, 0.6);
    this.shake = Math.max(this.shake, 0.06);
    await this.tween(0.5, ease.outBack, (k) => {
      a.offset.copy(da).multiplyScalar((1 - k) * 0.22);
      b.offset.copy(da).multiplyScalar(-(1 - k) * 0.22);
      a.lift = b.lift = (1 - k) * 0.3;
    });
    a.offset.set(0, 0, 0);
    b.offset.set(0, 0, 0);
  }

  makeBeam(from, to, color) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color.clone().multiplyScalar(1.2) }, uProgress: { value: 0 }, uFade: { value: 0 }, uTime: this.uTime },
      vertexShader: SIMPLE_VS,
      fragmentShader: BEAM_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    m.renderOrder = 10;
    const a = from.clone();
    const b = to.clone();
    const len = a.distanceTo(b);
    const mid = a.clone().lerp(b, 0.5);
    const x = new V3().subVectors(b, a).normalize();
    const toCam = new V3().subVectors(this.camera.position, mid).normalize();
    const z = toCam.sub(x.clone().multiplyScalar(toCam.dot(x))).normalize();
    const y = new V3().crossVectors(z, x);
    const mtx = new THREE.Matrix4().makeBasis(x, y, z);
    m.quaternion.setFromRotationMatrix(mtx);
    m.position.copy(mid);
    m.scale.set(len, 0.55, 1);
    this.scene.add(m);
    return m;
  }

  impact(pos, color, power = 1) {
    this.particles.spawn(pos, color, 70, { speed: 5 * power, life: 0.9, size: 0.08, white: true, up: 1.5 });
    this.shake = Math.max(this.shake, 0.12 * power);
    this.aberr = Math.max(this.aberr, 1.0 * power);
    this.flash = Math.max(this.flash, 0.08 * power);
    // ударная волна
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(1.5) }, uT: { value: 0 } },
      vertexShader: SIMPLE_VS,
      fragmentShader: RING_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.03, pos.z);
    this.scene.add(ring);
    this.tween(0.7, ease.out, (k) => (mat.uniforms.uT.value = k)).then(() => {
      this.scene.remove(ring);
      mat.dispose();
    });
  }

  burn(c) {
    sfx.burn();
    c.u.uWin.value = 0;
    const p0 = c.group.position;
    let acc = 0;
    return this.tween(1.7, ease.inOut, (k) => {
      c.u.uBurn.value = k;
      acc += 1;
      if (acc % 2 === 0) {
        const s = c.group.scale.x;
        tmpV.set((Math.random() - 0.5) * CW * s, (k * 1.3 - 0.65) * CH * s * 0.9, 0).applyQuaternion(c.group.quaternion).add(p0);
        this.particles.spawn(tmpV, '#ff8a2a', 3, { speed: 0.6, up: 1.4, gravity: 1.2, life: 1.2, size: 0.06 });
      }
    });
  }

  swingGavel(delay = 0) {
    const s = this.gavelSwing;
    this.gavelMoving = true;
    this.tween(0.22, ease.out, (k) => (s.rotation.z = 0.02 + k * 0.85), delay)
      .then(() => this.tween(0.12, ease.in, (k) => (s.rotation.z = 0.87 - k * 0.87)))
      .then(() => {
        sfx.gavel();
        this.shake = Math.max(this.shake, 0.08);
        tmpV.set(4.75, 0.2, -0.55);
        this.particles.spawn(tmpV, '#ffd9a0', 18, { speed: 2, life: 0.5, size: 0.05 });
        return this.tween(0.3, ease.lin, (k) => (s.rotation.z = Math.sin(k * Math.PI) * 0.12 * (1 - k) + 0.02));
      })
      .then(() => {
        this.gavelMoving = false;
        this.renderer.shadowMap.needsUpdate = true;
      });
  }

  // очистка стола перед новым раундом
  async newRound() {
    const tasks = [];
    for (const [id, c] of this.slotCards) {
      if (c.handIndex !== undefined) {
        this.returnToHand(c);
      } else if (c.u.uBurn.value >= 0.99) {
        c.dispose();
      } else {
        const deck = this.deckPose(id);
        tasks.push(
          c.flyTo(() => deck, 0.55, 0.6).then(() => c.dispose()),
        );
        this.tween(0.5, ease.in, (k) => (c.u.uWin.value *= 1 - k));
      }
    }
    this.slotCards.clear();
    await Promise.all(tasks);
  }

  clearTable(instant) {
    for (const [, c] of this.slotCards) {
      if (c.handIndex === undefined) c.dispose();
      else {
        c.u.uBurn.value = 0;
        c.u.uWin.value = 0;
        c.selectTarget = 0;
      }
    }
    this.slotCards.clear();
  }

  setSiren(v) {
    this.sirenTarget = v;
  }

  // ------------------------------------------------------------ ввод

  bindPointer() {
    const el = this.canvas;
    const setP = (e) => {
      const r = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      setP(e);
      this.pointerInside = true;
    });
    el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.pointer.set(-10, -10);
    });
    el.addEventListener('pointerdown', (e) => {
      setP(e);
      const hit = this.raycastHand();
      if (this.mode !== 'game') {
        if (hit) this.spinCard(hit);
        return;
      }
      if (!this.handEnabled || !hit) {
        if (e.pointerType === 'touch') {
          this.focused = null;
          this.setHovered(null);
        }
        return;
      }
      if (e.pointerType === 'touch') {
        if (this.focused === hit) {
          this.focused = null;
          this.onPick(hit.handIndex);
        } else {
          this.focused = hit;
          this.setHovered(hit);
          sfx.hover();
        }
      } else {
        this.onPick(hit.handIndex);
      }
    });
  }

  spinCard(c) {
    if (c.spinning) return;
    c.spinning = true;
    sfx.flip();
    this.tween(0.9, ease.inOut, (k) => (c.spin = k * Math.PI * 2)).then(() => {
      c.spin = 0;
      c.spinning = false;
    });
  }

  raycastHand() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.handCards.filter((c) => !this.isInSlot(c)).map((c) => c.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      // пропускаем скруглённые прозрачные углы
      const uv = h.uv;
      if (!uv) continue;
      const px = Math.abs(uv.x - 0.5) - 0.44;
      const py = Math.abs(uv.y - 0.5) - 0.455;
      if (px > 0 && py > 0) continue;
      return h.object.userData.card;
    }
    return null;
  }

  setHovered(c) {
    if (this.hovered === c) return;
    if (this.hovered) this.hovered.hoverTarget = 0;
    this.hovered = c;
    if (c) c.hoverTarget = 1;
    this.onHover(c ? c.handIndex : null);
  }

  // ------------------------------------------------------------ качество

  applyQuality() {
    const q = this.quality;
    this.renderer.setPixelRatio(q === 2 ? this.maxPR : q === 1 ? Math.min(1, this.maxPR) : 0.75);
    this.bloom.enabled = q > 0;
    if (this.width) this.resize();
  }

  // если кадров мало — снижаем качество (2 → 1 → 0)
  measure(dt) {
    if (!this.adaptive || this.quality === 0) return;
    const p = this.perf;
    p.t += dt;
    p.frames++;
    if (p.t < 3) return;
    const fps = p.frames / p.t;
    p.t = 0;
    p.frames = 0;
    if (fps < 26) {
      this.quality--;
      this.applyQuality();
    }
  }

  // ------------------------------------------------------------ экран

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.width = w;
    this.height = h;
    const aspect = w / h;
    this.camera.aspect = aspect;
    // по горизонтали должен помещаться стол
    const dist = this.camRest.distanceTo(this.camLook);
    const needHalfW = aspect < 0.95 ? 3.7 : 5.6;
    const hfov = 2 * Math.atan(needHalfW / dist);
    const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
    this.camera.fov = Math.max(40, Math.min(78, vfov));
    this.camera.position.copy(this.camRest);
    this.camera.lookAt(this.camLook);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.camMatrix = this.camera.matrixWorld.clone();
    this.camQuat = this.camera.quaternion.clone();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    const pr = this.renderer.getPixelRatio();
    this.final.uniforms.uRes.value.set(w * pr, h * pr);
    this.uPx.value = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.computeHandLayout();
  }

  // экранные координаты якоря над колодой игрока
  anchor(id) {
    const s = this.slots.get(id);
    if (!s) return null;
    const p = (s.deck || s.slot).clone();
    p.y += 0.2;
    if (s.deck) p.z -= 0.75;
    p.project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.width, y: (-p.y * 0.5 + 0.5) * this.height };
  }

  slotAnchor(id) {
    const c = this.slotCards.get(id);
    const s = this.slots.get(id);
    if (!s) return null;
    const p = c ? c.group.position.clone() : s.slot.clone();
    p.y += 1.0;
    p.project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.width, y: (-p.y * 0.5 + 0.5) * this.height };
  }

  frame() {
    const raw = this.clock.getDelta();
    const dt = Math.min(0.1, raw);
    if (raw < 1) this.measure(raw);
    this.time += dt;
    const t = this.time;
    this.uTime.value = t;

    for (const tw of this.tweens) {
      tw.t += dt;
      if (tw.t < 0) continue;
      const k = Math.min(1, tw.t / tw.dur);
      tw.fn(tw.easing(k));
      if (k >= 1) {
        this.tweens.delete(tw);
        tw.resolve();
      }
    }

    if (this.mode === 'game' && this.handEnabled && this.pointerInside) {
      this.setHovered(this.raycastHand());
    }

    for (const c of this.handCards) c.update(dt, t);
    for (const c of this.slotCards.values()) if (c.handIndex === undefined) c.update(dt, t);
    this.particles.update(dt);

    // маркеры слотов пульсируют, пока карта не выбрана
    for (const [id, m] of this.markers || []) {
      const empty = !this.slotCards.has(id);
      const target = m.userData.pulse && empty ? 0.35 + 0.25 * Math.sin(t * 4) : 0.12;
      m.material.opacity += (target - m.material.opacity) * Math.min(1, dt * 6);
    }

    // мигалки
    this.siren += (this.sirenTarget - this.siren) * Math.min(1, dt * 3);
    this.bgMat.uniforms.uSiren.value = this.siren;
    const ph = t * 3.4;
    const red = Math.pow(Math.max(0, Math.sin(ph)), 3);
    const blue = Math.pow(Math.max(0, Math.sin(ph + Math.PI)), 3);
    this.policeR.intensity = red * this.siren * 60;
    this.policeB.intensity = blue * this.siren * 60;
    this.uPolice.value.setRGB(red * 0.5 * this.siren, 0.02 * this.siren, blue * 0.6 * this.siren);
    this.coneMat.uniforms.uI.value = 0.045 + Math.sin(t * 13) * 0.003 + Math.sin(t * 2.1) * 0.006;
    this.key.intensity = 380 * (1 + Math.sin(t * 17) * 0.008);

    // тряска и аберрация
    this.shake *= Math.exp(-dt * 7);
    this.aberr *= Math.exp(-dt * 4);
    this.flash *= Math.exp(-dt * 9);
    this.camera.position.set(
      this.camRest.x + (Math.random() - 0.5) * this.shake,
      this.camRest.y + (Math.random() - 0.5) * this.shake,
      this.camRest.z + (Math.random() - 0.5) * this.shake,
    );
    this.final.uniforms.uTime.value = t;
    this.final.uniforms.uAberr.value = 0.15 + this.aberr;
    this.final.uniforms.uFlash.value = this.flash;

    if (this.gavelMoving) this.renderer.shadowMap.needsUpdate = true;
    this.composer.render(dt);
    this.onFrame();
  }
}
