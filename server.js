// Сервер игры «Камень, ножницы, УК РФ».
// Отдаёт статику и держит игровые комнаты до 3 игроков.
// Транспорт: WebSocket (/ws), а если он недоступен (некоторые туннели и прокси) —
// HTTP long-polling (/api/connect, /api/send, /api/poll).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { N, outcome, winText, drawText } from './public/shared/rules.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// пустой HOST — слушаем все адреса, и IPv4, и IPv6
const HOST = process.env.HOST || undefined;

const MAX_PLAYERS = 3;
// защита публичного сервера от переполнения
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 1000;
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 5000;
const MAX_CLIENTS_PER_IP = Number(process.env.MAX_CLIENTS_PER_IP) || 30;
const ROOMS_PER_IP_PER_MIN = 10;
const PICK_TIME = 30_000;
const SEAT_COLORS = ['#e9b44c', '#4fd1c5', '#f472b6'];
const BOT_NAMES = ['Прокурор', 'Адвокат', 'Присяжный', 'Судья', 'Понятой', 'Следователь'];

// ---------------------------------------------------------------- статика

const STATIC_ROUTES = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/vendor/fonts/', path.join(ROOT, 'node_modules/@fontsource/')],
  ['/', path.join(ROOT, 'public/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  for (const [prefix, dir] of STATIC_ROUTES) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = decodeURIComponent(pathname.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) break;
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': prefix === '/' ? 'no-cache' : 'public, max-age=86400',
      });
      if (req.method === 'HEAD') return res.end();
      // pipeline закрывает файл и при оборванной загрузке, и при ошибке чтения
      pipeline(fs.createReadStream(file), res, () => {});
    });
    return;
  }
  notFound(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}

function sendJSON(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- клиенты

const clients = new Map(); // cid -> Client
const ipCount = new Map(); // ip -> число подключений

// IP игрока; за локальным прокси (Caddy, nginx, туннель) берём адрес из X-Forwarded-For —
// последний элемент дописал наш прокси, остальные мог подделать клиент
function clientIp(req) {
  const addr = req.socket.remoteAddress || '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && /^(::ffff:)?127\.|^::1$/.test(addr)) return String(fwd).split(',').pop().trim();
  return addr;
}

function canConnect(ip) {
  return clients.size < MAX_CLIENTS && (ipCount.get(ip) || 0) < MAX_CLIENTS_PER_IP;
}

class Client {
  constructor(ip) {
    this.cid = crypto.randomBytes(12).toString('hex');
    this.ip = ip;
    this.ws = null;
    this.queue = []; // для long-poll: [{seq, msg}]
    this.seq = 0;
    this.waiter = null;
    this.created = Date.now();
    this.lastSeen = this.created;
    this.polled = false;
    this.room = null;
    this.player = null;
    this.rate = { t: 0, n: 0 };
    clients.set(this.cid, this);
    ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  }

  send(msg) {
    if (this.ws) {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
      return;
    }
    this.queue.push({ seq: ++this.seq, msg });
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    this.flush();
  }

  flush() {
    if (!this.waiter || this.queue.length === 0) return;
    const { res, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    sendJSON(res, 200, { msgs: this.queue });
  }

  ack(seq) {
    if (!Number.isFinite(seq)) return;
    while (this.queue.length && this.queue[0].seq <= seq) this.queue.shift();
  }

  allowMessage() {
    const now = Date.now();
    if (now - this.rate.t > 1000) {
      this.rate.t = now;
      this.rate.n = 0;
    }
    return ++this.rate.n <= 30;
  }

  drop() {
    if (!clients.delete(this.cid)) return;
    const n = (ipCount.get(this.ip) || 1) - 1;
    if (n > 0) ipCount.set(this.ip, n);
    else ipCount.delete(this.ip);
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      sendJSON(this.waiter.res, 410, { error: 'gone' });
      this.waiter = null;
    }
    if (this.room && this.player) this.room.detach(this.player, this);
    this.room = null;
    this.player = null;
  }
}

// ---------------------------------------------------------------- комнаты

const rooms = new Map(); // code -> Room
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}

function cleanName(s) {
  const name = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 16);
  return name || 'Подсудимый';
}

class Room {
  constructor() {
    this.code = makeCode();
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | pick | reveal | over
    this.round = 0;
    this.target = 5;
    this.deadline = null;
    this.timer = null;
    this.botTimers = [];
    this.lastReveal = null;
    this.winners = [];
    this.emptySince = null;
    rooms.set(this.code, this);
  }

  // --- состав

  freeSeat() {
    for (let s = 0; s < MAX_PLAYERS; s++) if (!this.players.some((p) => p.seat === s)) return s;
    return -1;
  }

  addPlayer({ name, token, bot = false }) {
    const seat = this.freeSeat();
    if (seat < 0) return null;
    const p = {
      id: crypto.randomBytes(6).toString('hex'),
      token: bot ? null : token,
      name: bot ? this.botName() : cleanName(name),
      bot,
      seat,
      color: SEAT_COLORS[seat],
      score: 0,
      pick: null,
      ready: false,
      client: null,
      lastSeen: Date.now(),
    };
    this.players.push(p);
    this.players.sort((a, b) => a.seat - b.seat);
    if (!bot && !this.hostId) this.hostId = p.id;
    return p;
  }

  botName() {
    const used = new Set(this.players.map((p) => p.name));
    const free = BOT_NAMES.filter((n) => !used.has('🤖 ' + n));
    return '🤖 ' + (free[crypto.randomInt(free.length)] || 'Бот');
  }

  removePlayer(p) {
    this.players = this.players.filter((x) => x !== p);
    if (p.client) {
      p.client.room = null;
      p.client.player = null;
      p.client = null;
    }
    if (this.hostId === p.id) this.pickHost();
    if (this.phase === 'pick' || this.phase === 'reveal') {
      if (this.players.length < 2) this.toLobby('Недостаточно игроков — заседание прервано');
      else this.checkProgress();
    }
  }

  pickHost() {
    const h = this.players.find((p) => !p.bot && p.client) || this.players.find((p) => !p.bot);
    this.hostId = h ? h.id : null;
  }

  attach(p, client) {
    if (p.client && p.client !== client) {
      p.client.send({ t: 'kicked', reason: 'Вы открыли игру в другой вкладке' });
      p.client.room = null;
      p.client.player = null;
    }
    p.client = client;
    p.lastSeen = Date.now();
    client.room = this;
    client.player = p;
    if (!this.players.some((x) => x.id === this.hostId && x.client)) this.pickHost();
  }

  detach(p, client) {
    if (p.client !== client) return;
    p.client = null;
    p.lastSeen = Date.now();
    if (this.hostId === p.id) this.pickHost();
    this.broadcast();
    this.checkProgress();
  }

  humans() {
    return this.players.filter((p) => !p.bot);
  }

  // --- рассылка

  publicState() {
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      target: this.target,
      deadlineIn: this.deadline ? Math.max(0, this.deadline - Date.now()) : null,
      winners: this.winners,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        bot: p.bot,
        seat: p.seat,
        color: p.color,
        score: p.score,
        online: p.bot || !!p.client,
        picked: this.phase === 'pick' ? p.pick !== null : false,
        ready: p.ready,
      })),
    };
  }

  broadcast() {
    const room = this.publicState();
    for (const p of this.players) if (p.client) p.client.send({ t: 'room', room, you: p.id });
  }

  emit(msg) {
    for (const p of this.players) if (p.client) p.client.send(msg);
  }

  // --- ход игры

  clearTimers() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
  }

  start() {
    if (this.players.length < 2) return 'Нужно минимум 2 игрока (добавьте бота)';
    for (const p of this.players) p.score = 0;
    this.round = 0;
    this.winners = [];
    this.lastReveal = null;
    this.nextRound();
    return null;
  }

  toLobby(notice) {
    this.clearTimers();
    this.phase = 'lobby';
    this.deadline = null;
    for (const p of this.players) {
      p.pick = null;
      p.ready = false;
    }
    if (notice) this.emit({ t: 'notice', text: notice });
    this.broadcast();
  }

  nextRound() {
    this.clearTimers();
    this.round++;
    this.phase = 'pick';
    this.deadline = Date.now() + PICK_TIME;
    for (const p of this.players) {
      p.pick = null;
      p.ready = false;
      if (p.bot) {
        this.botTimers.push(
          setTimeout(() => {
            if (this.phase !== 'pick') return;
            p.pick = crypto.randomInt(N);
            this.broadcast();
            this.checkProgress();
          }, 900 + crypto.randomInt(3200)),
        );
      }
    }
    this.timer = setTimeout(() => this.forcePicks(), PICK_TIME);
    this.broadcast();
  }

  pick(p, card) {
    if (this.phase !== 'pick') return;
    if (!Number.isInteger(card) || card < 0 || card >= N) return;
    p.pick = card;
    this.broadcast();
    this.checkProgress();
  }

  forcePicks() {
    if (this.phase !== 'pick') return;
    for (const p of this.players) if (p.pick === null) p.pick = crypto.randomInt(N);
    this.reveal();
  }

  checkProgress() {
    if (this.phase === 'pick' && this.players.length >= 2 && this.players.every((p) => p.pick !== null)) {
      this.reveal();
    } else if (this.phase === 'reveal') {
      const waiting = this.players.filter((p) => !p.bot && p.client && !p.ready);
      if (waiting.length === 0) this.afterReveal();
    }
  }

  reveal() {
    this.clearTimers();
    this.phase = 'reveal';
    this.deadline = null;
    const ps = this.players;
    const picks = {};
    for (const p of ps) picks[p.id] = p.pick;
    const gains = Object.fromEntries(ps.map((p) => [p.id, 0]));
    const pairs = [];
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        const r = outcome(a.pick, b.pick);
        if (r === 0) {
          pairs.push({ a: a.id, b: b.id, winner: null, loser: null, text: drawText(a.pick, b.pick) });
        } else {
          const [w, l] = r > 0 ? [a, b] : [b, a];
          gains[w.id]++;
          pairs.push({ a: a.id, b: b.id, winner: w.id, loser: l.id, text: winText(w.pick, l.pick) });
        }
      }
    }
    // Сначала показываем решающие пары, ничьи — в конце
    pairs.sort((x, y) => (x.winner ? 0 : 1) - (y.winner ? 0 : 1));
    for (const p of ps) {
      p.score += gains[p.id];
      p.ready = false;
    }
    this.lastReveal = { round: this.round, picks, pairs, gains };
    // сначала вскрытие, потом новый счёт — клиент прячет очки до конца анимации
    this.emit({ t: 'reveal', ...this.lastReveal });
    this.broadcast();
    const wait = 4000 + pairs.length * 2400 + 2500;
    this.timer = setTimeout(() => this.afterReveal(), wait);
  }

  afterReveal() {
    if (this.phase !== 'reveal') return;
    this.clearTimers();
    const top = Math.max(...this.players.map((p) => p.score));
    const leaders = this.players.filter((p) => p.score === top);
    if (top >= this.target && leaders.length === 1) {
      this.phase = 'over';
      this.winners = leaders.map((p) => p.id);
      this.broadcast();
      return;
    }
    if (top >= this.target) this.emit({ t: 'notice', text: 'Ничья по очкам — дополнительное заседание!' });
    this.nextRound();
  }
}

// ---------------------------------------------------------------- протокол

const createLog = new Map(); // ip -> времена создания комнат за последнюю минуту

function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < 60_000);
  const ok = recent.length < ROOMS_PER_IP_PER_MIN;
  if (ok) recent.push(now);
  createLog.set(ip, recent);
  return ok;
}

function handle(client, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
  const room = client.room;
  const me = client.player;
  const isHost = room && me && room.hostId === me.id;
  const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : null;

  switch (msg.t) {
    case 'create':
    case 'solo': {
      if (rooms.size >= MAX_ROOMS) return client.send({ t: 'error', text: 'Сервер переполнен, попробуйте позже' });
      if (!allowCreate(client.ip)) return client.send({ t: 'error', text: 'Слишком много новых комнат, подождите минуту' });
      if (room && me) leave(client);
      const r = new Room();
      const p = r.addPlayer({ name: msg.name, token });
      r.attach(p, client);
      if (msg.t === 'solo') {
        r.addPlayer({ bot: true });
        r.addPlayer({ bot: true });
        r.start();
      }
      r.broadcast();
      return;
    }
    case 'join': {
      const code = String(msg.room || '').toUpperCase().slice(0, 8);
      const r = rooms.get(code);
      if (!r) return client.send({ t: 'error', code: 'no_room', text: `Комната ${code || '—'} не найдена` });
      let p = token && r.players.find((x) => !x.bot && x.token === token);
      // прежнее место освобождаем, если это не тот же игрок (иначе в комнате останется «призрак»)
      if (room && me && me !== p) leave(client);
      if (!p) {
        if (r.players.length >= MAX_PLAYERS) {
          // если есть бот — гость занимает его место
          const bot = r.players.find((x) => x.bot);
          if (!bot || r.phase !== 'lobby') return client.send({ t: 'error', text: 'В комнате уже 3 игрока' });
          r.removePlayer(bot);
        }
        p = r.addPlayer({ name: msg.name, token });
        if (r.phase !== 'lobby') r.emit({ t: 'notice', text: `${p.name} присоединяется к заседанию` });
      } else if (msg.name) {
        p.name = cleanName(msg.name);
      }
      r.attach(p, client);
      r.broadcast();
      if (r.phase === 'reveal' && r.lastReveal) client.send({ t: 'reveal', ...r.lastReveal, late: true });
      return;
    }
    case 'leave':
      leave(client);
      client.send({ t: 'left' });
      return;
    case 'rename':
      if (me) {
        me.name = cleanName(msg.name);
        room.broadcast();
      }
      return;
  }

  if (!room || !me) return;

  switch (msg.t) {
    case 'addBot':
      if (!isHost || room.phase !== 'lobby') return;
      if (!room.addPlayer({ bot: true })) return client.send({ t: 'error', text: 'Мест нет' });
      room.broadcast();
      return;
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return;
      const p = room.players.find((x) => x.id === msg.id);
      if (!p || p === me) return;
      if (p.client) p.client.send({ t: 'kicked', reason: 'Хозяин комнаты исключил вас' });
      room.removePlayer(p);
      room.broadcast();
      return;
    }
    case 'settings':
      if (!isHost || room.phase !== 'lobby') return;
      if ([3, 5, 7, 10].includes(msg.target)) room.target = msg.target;
      room.broadcast();
      return;
    case 'start': {
      if (!isHost || (room.phase !== 'lobby' && room.phase !== 'over')) return;
      const err = room.start();
      if (err) client.send({ t: 'error', text: err });
      return;
    }
    case 'toLobby':
      if (!isHost || room.phase !== 'over') return;
      for (const p of room.players) p.score = 0;
      room.winners = [];
      room.toLobby();
      return;
    case 'pick':
      room.pick(me, msg.card);
      return;
    case 'ready':
      if (room.phase === 'reveal') {
        me.ready = true;
        room.checkProgress();
      }
      return;
    case 'emote': {
      const e = String(msg.e || '').slice(0, 8);
      if (EMOTES.has(e)) room.emit({ t: 'emote', id: me.id, e });
      return;
    }
  }
}

const EMOTES = new Set(['😂', '😎', '😡', '🤝', '👮', '⚖️', '🙏', '💸']);

function leave(client) {
  const { room, player } = client;
  if (!room || !player) return;
  room.removePlayer(player);
  room.broadcast();
}

// ---------------------------------------------------------------- HTTP + WS

const server = http.createServer(async (req, res) => {
  // всё внутри try: даже разбор адреса (запрос «//» бросает исключение) не должен уронить сервер
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, rooms: rooms.size, clients: clients.size });
    if (p === '/api/connect' && req.method === 'POST') {
      const ip = clientIp(req);
      if (!canConnect(ip)) return sendJSON(res, 503, { error: 'busy' });
      const c = new Client(ip);
      return sendJSON(res, 200, { cid: c.cid });
    }
    if (p === '/api/send' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const c = clients.get(body.cid);
      if (!c) return sendJSON(res, 410, { error: 'gone' });
      c.lastSeen = Date.now();
      if (c.allowMessage()) handle(c, body.m);
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/poll' && req.method === 'GET') {
      const c = clients.get(url.searchParams.get('cid'));
      if (!c) return sendJSON(res, 410, { error: 'gone' });
      c.lastSeen = Date.now();
      c.polled = true;
      c.ack(Number(url.searchParams.get('ack')));
      if (c.waiter) {
        // повторный запрос: старый отпускаем пустым и забываем
        clearTimeout(c.waiter.timer);
        sendJSON(c.waiter.res, 200, { msgs: [] });
        c.waiter = null;
      }
      if (c.queue.length) return sendJSON(res, 200, { msgs: c.queue });
      const timer = setTimeout(() => {
        if (c.waiter && c.waiter.res === res) {
          c.waiter = null;
          sendJSON(res, 200, { msgs: [] });
        }
      }, 20_000);
      c.waiter = { res, timer };
      res.on('close', () => {
        if (c.waiter && c.waiter.res === res) {
          clearTimeout(timer);
          c.waiter = null;
        }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    serveStatic(req, res, p);
  } catch (e) {
    sendJSON(res, 400, { error: 'bad request' });
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  // без обработчика 'error' один кривой или слишком большой кадр роняет весь процесс
  ws.on('error', () => ws.terminate());
  const ip = clientIp(req);
  if (!canConnect(ip)) {
    ws.close(1013, 'busy');
    return;
  }
  const c = new Client(ip);
  c.ws = ws;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    c.lastSeen = Date.now();
    if (!c.allowMessage()) return;
    try {
      handle(c, JSON.parse(data));
    } catch {
      /* мусор игнорируем */
    }
  });
  ws.on('close', () => c.drop());
  c.send({ t: 'hello', cid: c.cid });
});

// Пинг вебсокетов, уборка отвалившихся long-poll клиентов и пустых комнат
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const c of clients.values()) {
    if (c.ws || c.waiter) continue;
    // long-poll клиент пропал, либо подключился и так ни разу не опросил сервер
    if (now - c.lastSeen > 45_000 || (!c.polled && now - c.created > 15_000)) c.drop();
  }
  for (const [ip, list] of createLog) {
    if (!list.some((t) => now - t < 60_000)) createLog.delete(ip);
  }
  for (const r of rooms.values()) {
    // Отвалившихся людей убираем: в лобби через минуту, во время игры через две
    const limit = r.phase === 'lobby' ? 60_000 : 120_000;
    for (const p of r.humans()) {
      if (!p.client && now - p.lastSeen > limit) {
        r.removePlayer(p);
        r.broadcast();
      }
    }
    const online = r.humans().some((p) => p.client);
    if (online) r.emptySince = null;
    else if (!r.emptySince) r.emptySince = now;
    else if (now - r.emptySince > 5 * 60_000 || r.humans().length === 0) {
      r.clearTimers();
      rooms.delete(r.code);
    }
  }
}, 10_000);

const onListen = () => console.log(`УК-RPS сервер: http://localhost:${PORT}`);
if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);
