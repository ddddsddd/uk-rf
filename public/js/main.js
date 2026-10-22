import { ARTICLES, N, beatsList, losesList, drawWith, outcome } from '../shared/rules.js';
import { GameScene } from './scene.js';
import { Net } from './net.js';
import { sfx, initAudio, setMuted, isMuted } from './audio.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(k, d = null) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* приватный режим */
    }
  },
  sget(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  sset(k, v) {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

let token = store.get('ukrps.token');
if (!token) {
  token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  store.set('ukrps.token', token);
}

const isTouch = matchMedia('(pointer: coarse)').matches;

const S = {
  room: null,
  you: null,
  screen: 'loading',
  round: 0,
  myPick: null,
  queue: Promise.resolve(),
  deadlineAt: 0,
  lastTickSec: -1,
  pendingGains: null,
  animating: false,
  online: false,
  autoJoin: null,
  overShown: null,
  emoteAt: 0,
  pickRound: 0,
  pickSentAt: 0,
};

let scene;
const net = new Net(onMessage, onNetStatus);

const enqueue = (fn) => {
  S.queue = S.queue.then(fn).catch((e) => console.error(e));
  return S.queue;
};

// ---------------------------------------------------------------- загрузка

async function boot() {
  const fontLoads = [
    document.fonts.load('48px "Russo One"', 'КРАЖА 0123456789'),
    document.fonts.load('30px "PT Serif"', 'Кража'),
    document.fonts.load('italic 30px "PT Serif"', '«Кража»'),
    document.fonts.load('20px "PT Mono"', 'ч.1 — до 2 лет'),
  ];
  await Promise.race([Promise.allSettled(fontLoads), new Promise((r) => setTimeout(r, 5000))]);

  scene = new GameScene($('#gl'));
  try {
    await scene.init();
  } catch (e) {
    console.error(e);
    $('.loading-text').textContent = 'Не удалось запустить 3D (WebGL). Обновите браузер или включите аппаратное ускорение.';
    return;
  }
  scene.onPick = onCardPick;
  scene.onHover = onCardHover;
  scene.onFrame = onFrame;

  $('#nameInput').value = store.get('ukrps.name', '');
  buildCodex();
  buildEmotes();
  bindUI();

  const code = new URLSearchParams(location.search).get('room');
  if (code) {
    const c = code.toUpperCase().slice(0, 4);
    if (store.sget('ukrps.lastRoom') === c) S.autoJoin = c;
    $('#invite').hidden = false;
    $('#inviteCode').textContent = c;
    $('#codeInput').value = c;
  }
  showScreen('menu');
  setTimeout(() => $('#loading').classList.add('done'), 150);
  net.connect();
}

// ---------------------------------------------------------------- сеть

function onNetStatus(st) {
  S.online = st === 'online';
  const el = $('#netStatus');
  if (st === 'online') {
    el.hidden = true;
  } else if (S.screen !== 'loading') {
    el.hidden = false;
    el.textContent = st === 'connecting' ? 'Подключаемся к серверу…' : 'Нет связи с сервером — переподключаемся…';
  }
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      if (S.room) send({ t: 'join', room: S.room.code, name: myName(), token });
      else if (S.autoJoin) {
        send({ t: 'join', room: S.autoJoin, name: myName(), token });
        S.autoJoin = null;
      }
      break;
    case 'room':
      applyRoom(m.room, m.you);
      break;
    case 'reveal':
      onReveal(m);
      break;
    case 'notice':
      toast(m.text);
      break;
    case 'error':
      toast(m.text, true);
      // комнаты больше нет (например, сервер перезапускался) — возвращаемся в меню
      if (m.code === 'no_room' && S.room) goMenu();
      break;
    case 'kicked':
      toast(m.reason, true);
      goMenu();
      break;
    case 'left':
      goMenu();
      break;
    case 'emote':
      showEmote(m.id, m.e);
      break;
  }
}

function send(m) {
  if (!S.online) {
    toast('Нет связи с сервером', true);
    return false;
  }
  net.send(m);
  return true;
}

function myName() {
  const v = $('#nameInput').value.trim().slice(0, 16);
  return v || 'Подсудимый';
}

// ---------------------------------------------------------------- состояние комнаты

function applyRoom(room, you) {
  const firstJoin = !S.room || S.room.code !== room.code;
  S.room = room;
  S.you = you;
  store.sset('ukrps.lastRoom', room.code);
  if (firstJoin) history.replaceState(null, '', `?room=${room.code}`);
  if (room.phase === 'pick' && room.deadlineIn != null) S.deadlineAt = performance.now() + room.deadlineIn;

  renderScoreboard();
  switch (room.phase) {
    case 'lobby':
      enqueue(() => showLobby());
      break;
    case 'pick': {
      const r = room.round;
      if (r !== S.round) {
        S.round = r;
        enqueue(() => startRound());
      }
      enqueue(() => syncPicks());
      break;
    }
    case 'reveal':
      enqueue(() => {
        if (S.screen !== 'hud') enterGame();
        updateHud();
      });
      break;
    case 'over':
      enqueue(() => showOver());
      break;
  }
}

function me() {
  return S.room?.players.find((p) => p.id === S.you);
}

function isHost() {
  return S.room && S.room.hostId === S.you;
}

function playerById(id) {
  return S.room?.players.find((p) => p.id === id);
}

// ---------------------------------------------------------------- экраны

function showScreen(name) {
  S.screen = name;
  $('#menu').hidden = name !== 'menu';
  $('#lobby').hidden = name !== 'lobby';
  $('#hud').hidden = name !== 'hud';
  $('#over').hidden = name !== 'over';
  if (name !== 'hud') {
    $('#plates').innerHTML = '';
    plateEls.clear();
    hideCardInfo();
    $('#emoteBar').hidden = true;
  }
}

function goMenu() {
  S.room = null;
  S.you = null;
  S.round = 0;
  S.myPick = null;
  S.pendingGains = null;
  store.sset('ukrps.lastRoom', null);
  history.replaceState(null, '', '/');
  $('#invite').hidden = true;
  enqueue(() => {
    scene.setMode('menu');
    showScreen('menu');
  });
}

function showLobby() {
  const room = S.room;
  if (!room || room.phase !== 'lobby') return;
  S.round = 0;
  S.myPick = null;
  S.overShown = null;
  if (S.screen !== 'lobby') {
    scene.setMode('lobby');
    showScreen('lobby');
  }
  $('#lobbyCode').textContent = room.code;
  const link = `${location.origin}/?room=${room.code}`;
  $('#shareLink').value = link;
  $('#btnShare').hidden = !navigator.share;

  const host = isHost();
  const seats = [];
  for (let s = 0; s < 3; s++) {
    const p = room.players.find((x) => x.seat === s);
    if (!p) {
      seats.push(`<li class="seat seat-empty"><span class="seat-num">${s + 1}</span><span>Свободное место</span>${
        host ? '<button class="btn btn-small" data-addbot>+ бот</button>' : ''
      }</li>`);
      continue;
    }
    const tags = [];
    if (p.id === room.hostId) tags.push('<span class="seat-tag host">хозяин</span>');
    if (p.id === S.you) tags.push('<span class="seat-tag">вы</span>');
    if (!p.online) tags.push('<span class="seat-tag off">не в сети</span>');
    const kick = host && p.id !== S.you ? `<button class="seat-kick" data-kick="${p.id}" title="Убрать">✕</button>` : '';
    seats.push(
      `<li class="seat"><span class="seat-num">${s + 1}</span><span class="seat-dot" style="background:${p.color}"></span><span class="seat-name">${esc(p.name)}</span>${tags.join('')}${kick}</li>`,
    );
  }
  $('#seats').innerHTML = seats.join('');
  $('#hostControls').hidden = !host;
  $('#guestWait').hidden = host;
  $$('#targetSeg button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.target) === room.target);
    b.disabled = !host;
  });
  $('#btnStart').disabled = room.players.length < 2;
  $('#btnStart').textContent = room.players.length < 2 ? 'Нужен ещё игрок или бот' : 'Начать заседание';
}

function layoutPlayers() {
  const room = S.room;
  const mine = me();
  if (!room || !mine) return [];
  // соперники по часовой стрелке от нас
  const others = room.players.filter((p) => p.id !== S.you).sort((a, b) => ((a.seat - mine.seat + 3) % 3) - ((b.seat - mine.seat + 3) % 3));
  return [mine, ...others];
}

function enterGame() {
  showScreen('hud');
  scene.setMode('game');
  scene.setLayout(layoutPlayers(), S.you);
  $('#hudCode').textContent = S.room.code;
}

async function startRound() {
  if (!S.room || S.room.phase !== 'pick') return;
  if (S.screen !== 'hud') enterGame();
  S.myPick = null;
  S.lastTickSec = -1;
  scene.setLayout(layoutPlayers(), S.you);
  await scene.newRound();
  scene.setHandEnabled(S.room?.phase === 'pick');
  updateHud();
}

function syncPicks() {
  const room = S.room;
  if (!room || room.phase !== 'pick') return;
  scene.setLayout(layoutPlayers(), S.you);
  for (const p of room.players) {
    if (p.id !== S.you && p.picked) scene.opponentPicked(p.id);
  }
  updateHud();
}

// ---------------------------------------------------------------- HUD

function updateHud() {
  const room = S.room;
  if (!room) return;
  $('#roundLabel').textContent = `Заседание №${room.round}`;
  const phase = $('#phaseMsg');
  $('#timer').hidden = room.phase !== 'pick';
  if (room.phase === 'pick') {
    if (S.myPick === null) {
      phase.textContent = isTouch ? 'Выберите статью: коснитесь карты, затем ещё раз' : 'Выберите статью';
    } else {
      const waiting = room.players.filter((p) => p.id !== S.you && !p.picked).map((p) => p.name);
      phase.textContent = waiting.length ? `Ждём: ${waiting.join(', ')}` : 'Все выбрали!';
    }
  } else if (room.phase === 'reveal') {
    phase.textContent = 'Оглашение приговора';
  } else {
    phase.textContent = '';
  }
  renderScoreboard();
  renderPlates();
}

function shownScore(p) {
  return p.score - (S.pendingGains?.[p.id] || 0);
}

function renderScoreboard(bumpIds = []) {
  const room = S.room;
  if (!room) return;
  const rows = [...room.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      let st = '';
      if (!p.online) st = '📴';
      else if (room.phase === 'pick') st = p.picked || (p.id === S.you && S.myPick !== null) ? '✅' : '⏳';
      const crown = p.id === room.hostId ? ' 👑' : '';
      return `<div class="score-row${p.id === S.you ? ' me' : ''}${bumpIds.includes(p.id) ? ' bump' : ''}" data-id="${p.id}">
        <span class="dot" style="background:${p.color}"></span>
        <span class="nm">${esc(p.name)}${p.id === S.you ? ' (вы)' : ''}${crown}</span>
        <span class="st">${st}</span>
        <span class="sc">${shownScore(p)}<small style="opacity:.5">/${room.target}</small></span>
      </div>`;
    });
  $('#scoreboard').innerHTML = rows.join('');
  if (bumpIds.length) setTimeout(() => $$('.score-row.bump').forEach((e) => e.classList.remove('bump')), 500);
}

const plateEls = new Map();
function renderPlates() {
  const room = S.room;
  if (!room || S.screen !== 'hud') return;
  const box = $('#plates');
  const ids = new Set();
  for (const p of room.players) {
    if (p.id === S.you) continue;
    ids.add(p.id);
    let el = plateEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'plate';
      el.innerHTML = '<div class="pn"></div><div class="ps"></div>';
      box.appendChild(el);
      plateEls.set(p.id, el);
    }
    el.style.setProperty('--pc', p.color);
    el.querySelector('.pn').textContent = p.name;
    const ps = el.querySelector('.ps');
    ps.className = 'ps';
    if (!p.online) ps.textContent = 'не в сети';
    else if (room.phase === 'pick' && p.picked) {
      ps.textContent = '✓ выбрал статью';
      ps.classList.add('ok');
    } else if (room.phase === 'pick') {
      ps.textContent = 'думает';
      ps.classList.add('thinking');
    } else ps.textContent = `${shownScore(p)} очк.`;
  }
  for (const [id, el] of plateEls) {
    if (!ids.has(id)) {
      el.remove();
      plateEls.delete(id);
    }
  }
}

function onFrame() {
  if (S.screen !== 'hud') return;
  for (const [id, el] of plateEls) {
    const a = scene.anchor(id);
    if (!a) {
      el.style.opacity = 0;
      continue;
    }
    el.style.opacity = 1;
    el.style.left = `${Math.max(70, Math.min(innerWidth - 70, a.x))}px`;
    el.style.top = `${Math.max(150, a.y)}px`;
  }
  const room = S.room;
  if (room && room.phase === 'pick') {
    // выбор мог потеряться при обрыве связи — сервер его не видит, повторяем (только в том же раунде)
    const mine = me();
    if (S.myPick !== null && mine && !mine.picked && S.online && room.round === S.pickRound && performance.now() - S.pickSentAt > 2500) {
      S.pickSentAt = performance.now();
      net.send({ t: 'pick', card: S.myPick });
    }
    const rem = Math.max(0, S.deadlineAt - performance.now());
    const sec = Math.ceil(rem / 1000);
    $('#timerText').textContent = sec;
    $('#timerRing').style.strokeDashoffset = String(97.4 * (1 - rem / 30000));
    $('#timer').classList.toggle('low', sec <= 5);
    if (sec <= 5 && sec > 0 && sec !== S.lastTickSec && S.myPick === null) {
      S.lastTickSec = sec;
      sfx.tick();
    }
  }
}

// ---------------------------------------------------------------- выбор карты

function onCardPick(idx) {
  const room = S.room;
  if (!room || room.phase !== 'pick' || S.animating) return;
  initAudio();
  S.myPick = idx;
  S.pickRound = room.round;
  S.pickSentAt = performance.now();
  scene.pickLocal(idx);
  send({ t: 'pick', card: idx });
  hideCardInfo();
  updateHud();
}

function pill(i) {
  const a = ARTICLES[i];
  return `<span class="pill" style="background:${a.color}">${a.num}</span>`;
}

function onCardHover(idx) {
  const el = $('#cardInfo');
  if (idx === null || idx === undefined) {
    hideCardInfo();
    return;
  }
  const a = ARTICLES[idx];
  el.style.setProperty('--ic', a.color);
  el.innerHTML = `
    <div class="ci-head"><span class="ci-num">ст. ${a.num}</span><span class="ci-title">${a.title}</span><span class="ci-nick">«${a.nick}»</span></div>
    <div class="ci-full">${a.full} · ${a.term}</div>
    <div class="ci-row"><span>Бьёт</span>${beatsList(idx).map(pill).join('')}</div>
    <div class="ci-row"><span>Проигрывает</span>${losesList(idx).map(pill).join('')}</div>
    <div class="ci-row"><span>Ничья</span>${pill(drawWith(idx))}</div>
    ${isTouch ? '<div class="ci-hint">Коснитесь карты ещё раз, чтобы выбрать</div>' : ''}`;
  el.classList.add('show');
}

function hideCardInfo() {
  $('#cardInfo').classList.remove('show');
}

// ---------------------------------------------------------------- вскрытие

function onReveal(m) {
  S.pendingGains = m.gains;
  renderScoreboard();
  enqueue(async () => {
    if (!S.room) return;
    if (S.screen !== 'hud') enterGame();
    S.animating = true;
    hideCardInfo();
    $('#phaseMsg').textContent = 'Оглашение приговора';
    $('#timer').hidden = true;
    scene.setLayout(layoutPlayers(), S.you);
    if (m.late || !(S.you in m.picks)) {
      // подключились посреди вскрытия — просто ждём следующий раунд
      S.pendingGains = null;
      S.animating = false;
      renderScoreboard();
      send({ t: 'ready' });
      return;
    }
    await scene.reveal(m, S.you, {
      onPair: (pr) => showVerdict(pr, m),
    });
    hideVerdict();
    const bump = Object.entries(m.gains)
      .filter(([, g]) => g > 0)
      .map(([id]) => id);
    for (const id of bump) {
      const a = scene.slotAnchor(id);
      if (a) popGain(a, m.gains[id]);
    }
    S.pendingGains = null;
    renderScoreboard(bump);
    renderPlates();
    S.animating = false;
    send({ t: 'ready' });
  });
}

function showVerdict(pr, m) {
  const box = $('#verdict');
  const old = box.querySelector('.verdict-card');
  if (old) {
    old.classList.add('out');
    setTimeout(() => old.remove(), 340);
  }
  const A = playerById(pr.a);
  const B = playerById(pr.b);
  const name = (p) => (p ? (p.id === S.you ? 'вы' : esc(p.name)) : '?');
  const art = (id) => {
    const a = ARTICLES[m.picks[id]];
    return `<span class="art" style="background:${a.color}">ст. ${a.num}</span>`;
  };
  let line;
  let who;
  let stamp;
  if (pr.winner) {
    const W = playerById(pr.winner);
    const L = playerById(pr.loser);
    line = `${art(pr.winner)}<span class="vs">бьёт</span>${art(pr.loser)}`;
    who = `${name(W)} → ${name(L)}`;
    if (pr.winner === S.you) stamp = '<span class="verdict-stamp win">ПОБЕДА</span>';
    else if (pr.loser === S.you) stamp = '<span class="verdict-stamp lose">ПРОИГРЫШ</span>';
    else stamp = '<span class="verdict-stamp draw">РЕШЕНИЕ</span>';
  } else {
    line = `${art(pr.a)}<span class="vs">=</span>${art(pr.b)}`;
    who = `${name(A)} и ${name(B)}`;
    stamp = '<span class="verdict-stamp draw">НИЧЬЯ</span>';
  }
  const el = document.createElement('div');
  el.className = 'verdict-card';
  el.innerHTML = `${stamp}<div class="verdict-line">${line}</div><div class="verdict-who">${who}</div><div class="verdict-text">«${esc(pr.text)}»</div>`;
  box.appendChild(el);
}

function hideVerdict() {
  const old = $('#verdict .verdict-card');
  if (old) {
    old.classList.add('out');
    setTimeout(() => old.remove(), 340);
  }
}

function popGain(a, g) {
  const el = document.createElement('div');
  el.className = 'gain';
  el.textContent = `+${g}`;
  el.style.left = `${a.x}px`;
  el.style.top = `${a.y}px`;
  $('#plates').appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

// ---------------------------------------------------------------- приговор

const SENTENCES = [
  'приговорён к 15 суткам мытья посуды',
  'приговорён к 3 годам условно без интернета',
  'приговорён к пожизненному прослушиванию шансона',
  'приговорён к штрафу в размере одной шаурмы',
  'приговорён к 200 часам изучения Уголовного кодекса',
  'приговорён к исправительным работам на даче у тёщи',
  'приговорён к домашнему аресту без вай-фая',
  'приговорён к выносу мусора до конца недели',
];

function showOver() {
  const room = S.room;
  if (!room || room.phase !== 'over') return;
  const key = `${room.code}:${room.round}`;
  const first = S.overShown !== key;
  S.overShown = key;
  scene.setMode('over');
  showScreen('over');
  const ps = [...room.players].sort((a, b) => b.score - a.score);
  const winner = playerById(room.winners[0]);
  $('#overSub').textContent = winner
    ? winner.id === S.you
      ? 'Вы оправданы и освобождаетесь в зале суда'
      : `${winner.name} оправдан(а) и освобождается в зале суда`
    : 'Суд удалился на совещание';
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  $('#overList').innerHTML = ps
    .map((p, i) => {
      const won = room.winners.includes(p.id);
      const sent = won ? 'освобождён(а) в зале суда' : SENTENCES[(h + i * 7) % SENTENCES.length];
      return `<li class="over-item">
        <span class="oi-score">${p.score}</span>
        <div class="oi-name"><span class="seat-dot" style="display:inline-block;background:${p.color};margin-right:6px"></span>${esc(p.name)}${p.id === S.you ? ' (вы)' : ''}</div>
        <div class="oi-sent">${sent}</div>
        <span class="oi-stamp ${won ? 'win' : 'lose'}" style="animation-delay:${0.3 + i * 0.25}s">${won ? 'ОПРАВДАН' : 'ВИНОВЕН'}</span>
      </li>`;
    })
    .join('');
  const host = isHost();
  $('#overHost').hidden = !host;
  $('#overGuest').hidden = host;
  if (first) {
    if (room.winners.includes(S.you)) sfx.fanfare();
    else sfx.siren();
  }
}

// ---------------------------------------------------------------- реакции

const EMOTES = ['😂', '😎', '😡', '🤝', '👮', '⚖️', '🙏', '💸'];

function buildEmotes() {
  $('#emoteBar').innerHTML = EMOTES.map((e) => `<button data-emote="${e}">${e}</button>`).join('');
}

function showEmote(id, e) {
  if (S.screen !== 'hud') return;
  const a = id === S.you ? scene.slotAnchor(id) : scene.anchor(id);
  if (!a) return;
  const el = document.createElement('div');
  el.className = 'bubble';
  el.textContent = e;
  el.style.left = `${a.x}px`;
  el.style.top = `${a.y - (id === S.you ? 0 : 50)}px`;
  $('#plates').appendChild(el);
  sfx.emote();
  setTimeout(() => el.remove(), 2300);
}

// ---------------------------------------------------------------- кодекс

function buildCodex() {
  // круг
  const R = 140;
  const C = 170;
  let svg = `<svg viewBox="0 0 340 340" role="img" aria-label="Круг статей">`;
  svg += `<defs><marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7a4b12"/></marker></defs>`;
  svg += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="rgba(34,24,15,.25)" stroke-width="2"/>`;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2 - Math.PI / 2 + 0.2;
    const a1 = ((i + 1) / N) * Math.PI * 2 - Math.PI / 2 - 0.2;
    const x0 = C + Math.cos(a0) * R;
    const y0 = C + Math.sin(a0) * R;
    const x1 = C + Math.cos(a1) * R;
    const y1 = C + Math.sin(a1) * R;
    svg += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}" fill="none" stroke="#7a4b12" stroke-width="2" marker-end="url(#ar)"/>`;
  }
  ARTICLES.forEach((a, i) => {
    const t = (i / N) * Math.PI * 2 - Math.PI / 2;
    const x = C + Math.cos(t) * R;
    const y = C + Math.sin(t) * R;
    svg += `<g><circle cx="${x}" cy="${y}" r="24" fill="${a.color}" stroke="#22180f" stroke-width="2"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-family="Russo One" font-size="${a.num.length > 3 ? 11 : 13}" fill="#fff" stroke="#22180f" stroke-width="0.6">${a.num}</text></g>`;
  });
  svg += `<text x="${C}" y="${C - 8}" text-anchor="middle" font-family="PT Serif" font-style="italic" font-size="15" fill="#22180f">каждая бьёт</text>`;
  svg += `<text x="${C}" y="${C + 14}" text-anchor="middle" font-family="PT Serif" font-style="italic" font-size="15" fill="#22180f">4 следующие →</text>`;
  svg += `</svg>`;
  $('#codexCircle').innerHTML = svg;

  // матрица
  let t = '<tr><th></th>' + ARTICLES.map((a, i) => `<th>${pill(i)}</th>`).join('') + '</tr>';
  for (let r = 0; r < N; r++) {
    t += `<tr><th class="row">${ARTICLES[r].num} ${ARTICLES[r].title}</th>`;
    for (let c = 0; c < N; c++) {
      const o = outcome(r, c);
      const cls = o > 0 ? 'm-w' : o < 0 ? 'm-l' : 'm-d';
      t += `<td class="${cls}">${o > 0 ? '✔' : o < 0 ? '✖' : '='}</td>`;
    }
    t += '</tr>';
  }
  $('#codexMatrix').innerHTML = t;

  $('#codexList').innerHTML = ARTICLES.map(
    (a, i) => `<div class="codex-item" style="--ic:${a.color}">
      <b>ст. ${a.num} — ${a.title}</b> <i>«${a.nick}»</i>
      <div class="ci-line">${a.full}. ${a.term}</div>
      <div class="ci-line">Бьёт: ${beatsList(i).map((j) => ARTICLES[j].num).join(', ')}</div>
      <div class="ci-line">Проигрывает: ${losesList(i).map((j) => ARTICLES[j].num).join(', ')}</div>
    </div>`,
  ).join('');
}

// ---------------------------------------------------------------- UI

const CYR = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', З: '3' };

function bindUI() {
  addEventListener('pointerdown', () => initAudio(), { capture: true });

  $('#nameInput').addEventListener('change', () => {
    store.set('ukrps.name', $('#nameInput').value.trim());
    if (S.room) send({ t: 'rename', name: myName() });
  });
  $('#codeInput').addEventListener('input', (e) => {
    const v = e.target.value
      .toUpperCase()
      .split('')
      .map((c) => CYR[c] || c)
      .join('')
      .replace(/[^A-Z0-9]/g, '');
    e.target.value = v.slice(0, 4);
  });
  $('#codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btnJoin').click();
  });

  const remember = () => store.set('ukrps.name', $('#nameInput').value.trim());
  $('#btnCreate').onclick = () => {
    sfx.click();
    remember();
    send({ t: 'create', name: myName(), token });
  };
  $('#btnSolo').onclick = () => {
    sfx.click();
    remember();
    send({ t: 'solo', name: myName(), token });
  };
  $('#btnJoin').onclick = () => {
    sfx.click();
    remember();
    const code = $('#codeInput').value.trim();
    if (code.length < 4) return toast('Введите код комнаты из 4 символов', true);
    send({ t: 'join', room: code, name: myName(), token });
  };
  $('#btnInvite').onclick = () => {
    sfx.click();
    remember();
    send({ t: 'join', room: $('#inviteCode').textContent, name: myName(), token });
  };

  // лобби
  $('#seats').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kick]');
    if (k) {
      sfx.click();
      send({ t: 'kick', id: k.dataset.kick });
    }
    if (e.target.closest('[data-addbot]')) {
      sfx.click();
      send({ t: 'addBot' });
    }
  });
  $('#targetSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-target]');
    if (b && isHost()) {
      sfx.click();
      send({ t: 'settings', target: Number(b.dataset.target) });
    }
  });
  $('#btnStart').onclick = () => {
    sfx.click();
    send({ t: 'start' });
  };
  $('#btnCopy').onclick = async () => {
    sfx.click();
    const v = $('#shareLink').value;
    try {
      await navigator.clipboard.writeText(v);
    } catch {
      $('#shareLink').select();
      document.execCommand('copy');
    }
    toast('Ссылка скопирована');
  };
  $('#btnShare').onclick = () => {
    navigator.share?.({ title: 'Камень, ножницы, УК РФ', text: 'Заходи в зал суда!', url: $('#shareLink').value }).catch(() => {});
  };
  const leave = () => {
    if (!confirm('Покинуть зал заседаний?')) return;
    net.send({ t: 'leave' });
    goMenu();
  };
  $('#btnLeaveLobby').onclick = leave;
  $('#btnLeave').onclick = leave;
  $('#btnLeaveOver').onclick = () => {
    net.send({ t: 'leave' });
    goMenu();
  };
  $('#btnRematch').onclick = () => {
    sfx.click();
    send({ t: 'start' });
  };
  $('#btnToLobby').onclick = () => {
    sfx.click();
    send({ t: 'toLobby' });
  };

  // HUD
  $('#btnMute').textContent = isMuted() ? '🔇' : '🔊';
  $('#btnMute').onclick = () => {
    setMuted(!isMuted());
    $('#btnMute').textContent = isMuted() ? '🔇' : '🔊';
  };
  $('#btnEmote').onclick = () => {
    $('#emoteBar').hidden = !$('#emoteBar').hidden;
  };
  $('#emoteBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emote]');
    if (!b) return;
    const now = performance.now();
    if (now - S.emoteAt < 1200) return;
    S.emoteAt = now;
    send({ t: 'emote', e: b.dataset.emote });
    $('#emoteBar').hidden = true;
  });

  // кодекс
  $$('[data-open-codex]').forEach((b) =>
    b.addEventListener('click', () => {
      sfx.click();
      $('#codex').hidden = false;
    }),
  );
  $('#codexClose').onclick = () => ($('#codex').hidden = true);
  $('#codex').addEventListener('click', (e) => {
    if (e.target.id === 'codex') $('#codex').hidden = true;
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#codex').hidden = true;
    // цифры 1-0 — быстрый выбор карты
    if (S.screen === 'hud' && S.room?.phase === 'pick' && /^[0-9]$/.test(e.key) && document.activeElement?.tagName !== 'INPUT') {
      const idx = e.key === '0' ? 9 : Number(e.key) - 1;
      onCardPick(idx);
    }
  });
}

function toast(text, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

boot();
