// Запуск сервера + публичная ссылка через бесплатный туннель (без регистрации).
// Использование: npm run share
import { spawn } from 'node:child_process';
import os from 'node:os';

const PORT = process.env.PORT || '3000';
process.env.PORT = PORT;
await import('./server.js');

const TUNNELS = [
  {
    name: 'tunnelmole',
    args: ['--yes', 'tunnelmole@2.4.0', PORT],
    re: /https:\/\/[a-z0-9-]+\.tunnelmole\.net/i,
  },
  {
    name: 'cloudflared',
    args: ['--yes', 'cloudflared@0.7.3', 'tunnel', '--url', `http://localhost:${PORT}`],
    re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    // ссылка печатается раньше, чем туннель реально подключился
    ready: /Registered tunnel connection/i,
  },
];

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

function banner(url) {
  const lines = ['Ссылка для друзей:', url, '', 'В одной Wi-Fi сети можно и так:', ...lanUrls()];
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  console.log('\n╔' + '═'.repeat(w) + '╗');
  for (const l of lines) console.log('║  ' + l.padEnd(w - 2) + '║');
  console.log('╚' + '═'.repeat(w) + '╝\n');
  console.log('Не закрывайте это окно, пока идёт игра. Остановить — Ctrl+C.\n');
}

let child = null;

function tryTunnel(t) {
  return new Promise((resolve) => {
    console.log(`Открываю туннель через ${t.name}…`);
    child = spawn('npx', t.args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const finish = (url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(url);
    };
    let url = null;
    let log = '';
    const onData = (buf) => {
      log += String(buf);
      if (!url) url = log.match(t.re)?.[0] || null;
      if (url && (!t.ready || t.ready.test(log))) finish(url);
      if (log.length > 20000) log = log.slice(-5000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(null));
    child.on('error', () => finish(null));
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 60_000);
  });
}

process.on('SIGINT', () => {
  child?.kill();
  process.exit(0);
});

let shared = false;
for (const t of TUNNELS) {
  const url = await tryTunnel(t);
  if (url) {
    shared = true;
    banner(url);
    child.on('exit', () => {
      console.log('Туннель закрылся. Перезапустите: npm run share');
      process.exit(1);
    });
    break;
  }
  console.log(`${t.name} не ответил, пробую следующий вариант…`);
}

if (!shared) {
  console.log('\nНе удалось открыть публичный туннель. Игра всё равно доступна:');
  console.log(`  на этом компьютере: http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  в локальной сети:   ${u}`);
}
