// Установка folzy-music одной командой:  cd worker && node setup.mjs
//
// 1. Создаёт PUSH_TOKEN (общий секрет сайта и selfbot), находит LASTFM_API_KEY и показывает оба.
// 2. Вход в Cloudflare (откроется браузер, если ещё не вошёл).
// 3. KV CACHE: создаёт и вписывает id в wrangler.toml.
// 4. Деплой воркера, секреты LASTFM_API_KEY и PUSH_TOKEN, проверка /now и /stats.
// 5. Адрес воркера — в assets/js/config.js сайта, коммит и пуш (GitHub Pages обновит folzy.ru).
// 6. .env контейнера selfbot через API панели Pterodactyl: SITE_NOW_URL и SITE_PUSH_TOKEN
//    (до записи — копия /.env.site-backup), затем по твоему «y» — перезапуск сервера.
//
// Ключи берутся из переменных окружения, затем из ../../selfbot/code/.env и ../../lengu/.env,
// затем из .env на сервере; чего нет — спросит. На диск секреты не пишутся (временный файл
// для `wrangler secret bulk` удаляется сразу).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const PROJECTS = join(SITE, '..');
const WRANGLER_TOML = join(HERE, 'wrangler.toml');
const CONFIG_JS = join(SITE, 'assets', 'js', 'config.js');
const LOCAL_ENVS = [join(PROJECTS, 'selfbot', 'code', '.env'), join(PROJECTS, 'lengu', '.env')];
const PANEL_DEFAULT = 'https://p.host.rooni.dev';
const SERVER_DEFAULT = 'b77aca45';
const REMOTE_ENV = '/.env';
const REMOTE_BACKUP = '/.env.site-backup';

// ── Чистые помощники (их проверяет test/setup.test.mjs) ─────────────────

export function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// Меняет только строки нужных ключей (повторы — тоже), отсутствующие дописывает в конец.
// Переносы строк файла (\n или \r\n) сохраняются.
export function mergeEnv(text, updates) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text).length ? String(text).split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.hasOwn(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  while (next.length && next[next.length - 1] === '') next.pop();
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) next.push(`${key}=${value}`);
  return next.join(eol) + eol;
}

export function setKvId(toml, id) {
  const block = `[[kv_namespaces]]\nbinding = "CACHE"\nid = "${id}"`;
  if (/^\[\[kv_namespaces\]\][\s\S]*?^id = ".*"$/m.test(toml)) {
    return toml.replace(/^\[\[kv_namespaces\]\]\nbinding = "CACHE"\nid = ".*"$/m, block);
  }
  if (toml.includes('# [[kv_namespaces]]')) {
    return toml.replace(/# \[\[kv_namespaces\]\]\n# binding = "CACHE"\n# id = "\.\.\."/, block);
  }
  return `${toml.trimEnd()}\n\n${block}\n`;
}

export function kvIdFromToml(toml) {
  const m = toml.match(/^\[\[kv_namespaces\]\]\nbinding = "CACHE"\nid = "([0-9a-f]{32})"$/m);
  return m ? m[1] : null;
}

export function setEndpoint(configJs, url) {
  return configJs.replace(/musicEndpoint: '[^']*'/, `musicEndpoint: '${url}'`);
}

export function workersUrl(output) {
  const m = String(output).match(/https:\/\/folzy-music\.[a-z0-9-]+\.workers\.dev/i);
  return m ? m[0] : null;
}

export function kvIdFromOutput(output) {
  const m = String(output).match(/id"?\s*[:=]\s*"([0-9a-f]{32})"/i);
  return m ? m[1] : null;
}

// ── Ввод-вывод ──────────────────────────────────────────────────────────

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` };
const step = (n, text) => console.log(`\n${c.b(`[${n}/6]`)} ${text}`);
const ok = (text) => console.log(`  ${c.g('✓')} ${text}`);
const warn = (text) => console.log(`  ${c.y('!')} ${text}`);

let rl;
const ask = async (question) => {
  rl = rl || createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(`  ${question} `)).trim();
};

// Команда с выводом на экран и в строку. stdin — у пользователя (вход, подтверждения wrangler).
function run(cmd, args, { input = 'inherit', quiet = false, cwd = HERE } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: process.platform === 'win32', stdio: [input, 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; if (!quiet) process.stderr.write(d); });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const wrangler = (args, opts) => run('npx', ['--yes', 'wrangler', ...args], opts);

function fail(text) {
  console.log(`\n  ${c.r('✗')} ${text}`);
  if (rl) rl.close();
  process.exit(1);
}

// ── Панель Pterodactyl ──────────────────────────────────────────────────

function panel(keys) {
  const url = (keys.PTERO_PANEL_URL || PANEL_DEFAULT).replace(/\/+$/, '');
  const server = keys.PTERO_SERVER_ID || SERVER_DEFAULT;
  const headers = { Authorization: `Bearer ${keys.PTERO_API_KEY}`, Accept: 'application/json' };
  const files = `${url}/api/client/servers/${server}/files`;
  return {
    async read(path) {
      const res = await fetch(`${files}/contents?file=${encodeURIComponent(path)}`, { headers });
      if (!res.ok) throw new Error(`панель: чтение ${path} — код ${res.status}`);
      return res.text();
    },
    async write(path, text) {
      const res = await fetch(`${files}/write?file=${encodeURIComponent(path)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: text,
      });
      if (res.status !== 204) throw new Error(`панель: запись ${path} — код ${res.status}`);
    },
    async restart() {
      const res = await fetch(`${url}/api/client/servers/${server}/power`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ signal: 'restart' }),
      });
      if (res.status !== 204) throw new Error(`панель: перезапуск — код ${res.status}`);
    },
  };
}

// ── Шаги ────────────────────────────────────────────────────────────────

async function main() {
  console.log(c.b('folzy-music: установка endpoint «сейчас играет» для folzy.ru'));

  // 1. Ключи
  step(1, 'Ключи');
  const keys = {};
  for (const file of LOCAL_ENVS) {
    if (!existsSync(file)) continue;
    const found = parseEnv(readFileSync(file, 'utf8'));
    for (const name of ['LASTFM_API_KEY', 'PTERO_API_KEY', 'PTERO_PANEL_URL', 'PTERO_SERVER_ID']) {
      if (!keys[name] && found[name]) keys[name] = found[name];
    }
  }
  for (const name of ['LASTFM_API_KEY', 'PTERO_API_KEY', 'PTERO_PANEL_URL', 'PTERO_SERVER_ID']) {
    if (process.env[name]) keys[name] = process.env[name];
  }
  if (!keys.PTERO_API_KEY) {
    keys.PTERO_API_KEY = await ask('Клиентский ключ панели (ptlc_…, Account → API Credentials; Enter — пропустить шаг с сервером):');
  }

  let remoteEnv = null;
  if (keys.PTERO_API_KEY) {
    try {
      remoteEnv = await panel(keys).read(REMOTE_ENV);
      ok(`.env на сервере прочитан (${remoteEnv.split(/\r?\n/).length} строк)`);
      const remote = parseEnv(remoteEnv);
      if (!keys.LASTFM_API_KEY && remote.LASTFM_API_KEY) keys.LASTFM_API_KEY = remote.LASTFM_API_KEY;
    } catch (e) {
      warn(`${e.message}. Шаг с сервером пропущу — строки для .env покажу в конце.`);
    }
  }
  if (!keys.LASTFM_API_KEY) {
    keys.LASTFM_API_KEY = await ask('Ключ Last.fm (last.fm/api/account/create):');
  }
  if (!/^[0-9a-f]{32}$/i.test(keys.LASTFM_API_KEY || '')) fail('Ключ Last.fm — 32 символа 0-9a-f. Проверь и запусти снова.');

  const pushToken = randomBytes(32).toString('base64url');
  console.log(`
  ${c.b('Сохрани себе — эти значения нужны воркеру и боту:')}
    LASTFM_API_KEY  = ${keys.LASTFM_API_KEY}
    PUSH_TOKEN      = ${pushToken}      ${c.y('(новый, создан сейчас)')}`);

  // 2. Cloudflare
  step(2, 'Вход в Cloudflare');
  const who = await wrangler(['whoami'], { quiet: true });
  if (who.code !== 0 || /not authenticated|You are not/i.test(who.out)) {
    warn('Не вошёл — открываю браузер для входа.');
    const login = await wrangler(['login']);
    if (login.code !== 0) fail('Вход в Cloudflare не удался.');
  }
  ok('Cloudflare: вошёл');

  // 3. KV
  step(3, 'KV для кэша длительностей и статистики');
  let toml = readFileSync(WRANGLER_TOML, 'utf8');
  let kvId = kvIdFromToml(toml);
  if (kvId) {
    ok(`уже есть: ${kvId}`);
  } else {
    const created = await wrangler(['kv', 'namespace', 'create', 'folzy-music-cache', '--binding', 'CACHE'], { input: 'ignore' });
    kvId = kvIdFromOutput(created.out);
    if (!kvId) {
      const list = await wrangler(['kv', 'namespace', 'list'], { quiet: true, input: 'ignore' });
      const json = list.out.slice(list.out.indexOf('['), list.out.lastIndexOf(']') + 1);
      try {
        const found = JSON.parse(json).find((n) => /folzy-music/i.test(n.title) && /cache/i.test(n.title));
        kvId = found && found.id;
      } catch (_) { /* не JSON — ниже понятная ошибка */ }
    }
    if (!kvId) fail('Не удалось создать или найти KV CACHE. Вывод wrangler выше.');
    toml = setKvId(toml, kvId);
    writeFileSync(WRANGLER_TOML, toml);
    ok(`KV CACHE: ${kvId} — записал в wrangler.toml`);
  }

  // 4. Деплой и секреты
  step(4, 'Деплой воркера и секреты');
  const deploy = await wrangler(['deploy']);
  if (deploy.code !== 0) fail('Деплой не прошёл. Вывод wrangler выше.');
  const url = workersUrl(deploy.out);
  if (!url) fail('Деплой прошёл, но адрес *.workers.dev не нашёлся в выводе. Включи workers.dev в настройках воркера.');
  ok(`воркер: ${url}`);

  const tmp = mkdtempSync(join(tmpdir(), 'folzy-music-'));
  const secretsFile = join(tmp, 'secrets.json');
  try {
    writeFileSync(secretsFile, JSON.stringify({ LASTFM_API_KEY: keys.LASTFM_API_KEY, PUSH_TOKEN: pushToken }));
    const bulk = await wrangler(['secret', 'bulk', secretsFile], { input: 'ignore' });
    if (bulk.code !== 0) fail('Секреты не записались. Вывод wrangler выше.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  ok('секреты LASTFM_API_KEY и PUSH_TOKEN записаны');

  console.log('  проверяю endpoint…');
  await new Promise((r) => setTimeout(r, 4000));      // секреты применяются за пару секунд
  for (const path of ['/now', '/stats']) {
    try {
      const res = await fetch(url + path);
      const body = await res.json();
      if (!res.ok) warn(`${path}: код ${res.status} — ${body.error || ''}`);
      else if (path === '/now') ok(`/now: ${body.playing ? `играет «${body.track.artist} — ${body.track.title}»` : 'сейчас ничего не играет'} (источник: ${body.source})`);
      else ok(`/stats: сегодня ${body.today.tracks} треков, за месяц ${body.month.tracks}`);
    } catch (e) {
      warn(`${path}: ${e.message}`);
    }
  }

  // 5. Сайт
  step(5, 'Адрес воркера — на сайт');
  const config = readFileSync(CONFIG_JS, 'utf8');
  const nextConfig = setEndpoint(config, url);
  if (nextConfig !== config) writeFileSync(CONFIG_JS, nextConfig);
  const git = (args) => run('git', args, { cwd: SITE, quiet: true, input: 'ignore' });
  await git(['add', 'assets/js/config.js', 'worker/wrangler.toml']);
  const staged = await git(['diff', '--cached', '--quiet']);
  if (staged.code === 0) {
    ok('config.js уже с этим адресом — коммитить нечего');
  } else {
    const commit = await git(['commit', '-m', 'Connect folzy-music worker endpoint']);
    const push = commit.code === 0 ? await git(['push', 'origin', 'main']) : commit;
    if (push.code === 0) ok('закоммитил и запушил — folzy.ru обновится через минуту');
    else warn(`git: ${push.out.trim().split('\n').pop()} — закоммить и запушь сам`);
  }

  // 6. Бот
  step(6, 'Selfbot: .env на сервере');
  const updates = { SITE_NOW_URL: `${url}/now`, SITE_PUSH_TOKEN: pushToken };
  if (remoteEnv === null) {
    warn('Панель недоступна — добавь в .env контейнера сам и перезапусти сервер:');
    for (const [k, v] of Object.entries(updates)) console.log(`    ${k}=${v}`);
  } else {
    const api = panel(keys);
    await api.write(REMOTE_BACKUP, remoteEnv);
    const merged = mergeEnv(remoteEnv, updates);
    await api.write(REMOTE_ENV, merged);
    const check = parseEnv(await api.read(REMOTE_ENV));
    if (check.SITE_NOW_URL !== updates.SITE_NOW_URL || check.SITE_PUSH_TOKEN !== updates.SITE_PUSH_TOKEN) {
      await api.write(REMOTE_ENV, remoteEnv);
      fail('После записи .env не совпал — вернул как было. Добавь строки руками.');
    }
    ok(`.env обновлён (копия до правки — ${REMOTE_BACKUP})`);
    const answer = await ask('Перезапустить сервер сейчас? Ляжет и LenguBot на ~минуту. [y/N]');
    if (/^y(es)?$|^д(а)?$/i.test(answer)) {
      await api.restart();
      ok('сервер перезапускается — через минуту бот начнёт слать трек на сайт');
    } else {
      warn('Не перезапускаю. Бот подхватит переменные при следующем рестарте.');
    }
  }

  if (rl) rl.close();
  console.log(`\n${c.g(c.b('Готово.'))} Endpoint: ${url}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => fail(e.stack || e.message));
}
