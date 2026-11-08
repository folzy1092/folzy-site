// folzy-music: endpoint «сейчас слушаю» + статистика прослушиваний для folzy.ru.
//
// «Сейчас играет» — тот же трек, что selfbot ставит в пост канала: бот сам шлёт его сюда
// (POST /now с токеном PUSH_TOKEN) при смене трека и раз в минуту «пульсом». Состояние лежит
// в Durable Object NOW — он отдаёт свежее сразу, без задержки KV. Если пульса нет дольше
// PUSH_FRESH секунд (бот лежит, сервер перезапускается) — «сейчас играет» берётся из Last.fm.
//
// Статистика — из Last.fm (туда скробблит Dotify). Ключ LASTFM_API_KEY лежит в секретах воркера,
// в браузер не уходит. Сутки, неделя и месяц считаются по времени TIMEZONE (по умолчанию МСК).
//
//   GET  /       → { now, stats }
//   GET  /now    → что играет сейчас; у трека от бота есть duration и position (секунда на server_time)
//   GET  /stats  → сегодня / неделя / месяц / в среднем за день + топ треков месяца (кэш 10 мин)
//   POST /now    → от selfbot: { playing, track: { title, artist, cover, link, duration, position, at } }
//
// Длительности треков Last.fm отдаёт только через track.getInfo, поэтому они копятся в KV (CACHE):
// за один запрос дотягивается не больше DURATION_BUDGET штук, остальные считаются по медиане известных,
// и тогда в ответе estimated: true.

const API = 'https://ws.audioscrobbler.com/2.0/';
const PLACEHOLDER_IMAGE = '2a96cbd8b46e442fc41c2b86b821562f';
const DEFAULT_DURATION = 180;
const MAX_PAGES = 8;            // 8 × 200 = 1600 скробблов за месяц, хватает с запасом
const DURATION_BUDGET = 30;     // лимит воркера — 50 подзапросов, страницы скробблов тоже считаются
const NOW_TTL = 15;
const STATS_TTL = 600;
const TOP_LIMIT = 6;
const PUSH_FRESH = 180;         // бот шлёт пульс раз в минуту; три пропуска — считаем, что он лежит

const memory = new Map();       // запасной кэш, если KV не привязан

// Хранилище «что играет» от бота: один объект на весь сайт, читается и пишется сразу.
export class NowState {
  constructor(state) {
    this.state = state;
    this.value = undefined;
  }

  async fetch(request) {
    if (request.method === 'PUT') {
      this.value = await request.text();
      await this.state.storage.put('now', this.value);
      return new Response('ok');
    }
    if (this.value === undefined) this.value = (await this.state.storage.get('now')) || null;
    return new Response(this.value || 'null', { headers: { 'Content-Type': 'application/json' } });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'POST' && path === '/now') return receivePush(request, env);
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!env.LASTFM_API_KEY || !env.LASTFM_USER) {
      return json({ error: 'LASTFM_API_KEY или LASTFM_USER не заданы' }, 500);
    }
    try {
      if (path === '/now') return json(await now(env), 200, 5);
      if (path === '/stats') return json(await cached(env, 'stats:v1', STATS_TTL, () => stats(env, ctx)), 200, 60);
      if (path === '/') {
        const [n, st] = await Promise.all([
          now(env),
          cached(env, 'stats:v1', STATS_TTL, () => stats(env, ctx)),
        ]);
        return json({ now: n, stats: st }, 200, 5);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
  },
};

// ── «Сейчас играет» от бота ─────────────────────────────────────────────

function nowStub(env) {
  return env.NOW ? env.NOW.get(env.NOW.idFromName('folzy')) : null;
}

function text(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ссылки только на SoundCloud и song.link; обложка — только https
export function cleanTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title);
  const artist = text(raw.artist);
  if (!title) return null;
  const link = text(raw.link, 600);
  const cover = text(raw.cover, 600);
  return {
    title,
    artist,
    cover: /^https:\/\//.test(cover) ? cover : null,
    link: /^https:\/\/(soundcloud\.com|song\.link|on\.soundcloud\.com)\//.test(link) ? link : linkFor(artist, title),
    duration: Math.round(number(raw.duration)),
    position: number(raw.position),
    at: number(raw.at),
  };
}

async function receivePush(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.PUSH_TOKEN || token !== env.PUSH_TOKEN) return json({ error: 'unauthorized' }, 401);
  const stub = nowStub(env);
  if (!stub) return json({ error: 'Durable Object NOW не привязан' }, 500);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.playing !== 'boolean') return json({ error: 'bad payload' }, 400);
  const track = body.playing ? cleanTrack(body.track) : null;
  const last = cleanTrack(body.last);
  const state = {
    playing: Boolean(track),
    track,
    last: last ? { ...last, ts: Math.round(number(body.last.ts)) } : null,
    received: Math.floor(Date.now() / 1000),
  };
  await stub.fetch('https://now/', { method: 'PUT', body: JSON.stringify(state) });
  return json({ ok: true });
}

async function pushed(env) {
  const stub = nowStub(env);
  if (!stub) return null;
  const res = await stub.fetch('https://now/');
  return res.json().catch(() => null);
}

// позицию переводим на время ответа: браузер дальше считает сам от server_time, без часов бота
export function fromPush(state, nowTs) {
  const track = state.track ? { ...state.track } : null;
  if (track) {
    const position = track.position + Math.max(0, nowTs - (track.at || nowTs));
    track.position = track.duration ? Math.min(position, track.duration) : position;
    delete track.at;
  }
  return { playing: Boolean(track), track, last: state.last, source: 'bot', updated: state.received, server_time: nowTs };
}

async function now(env) {
  const nowTs = Date.now() / 1000;
  const state = await pushed(env).catch(() => null);
  if (state && nowTs - state.received <= PUSH_FRESH) {
    const answer = fromPush(state, nowTs);
    if (!answer.last && !answer.playing) {
      const lastfm = await cached(env, `now:${env.LASTFM_USER}`, NOW_TTL, () => nowPlaying(env)).catch(() => null);
      answer.last = lastfm && lastfm.last;
    }
    return answer;
  }
  const lastfm = await cached(env, `now:${env.LASTFM_USER}`, NOW_TTL, () => nowPlaying(env));
  return { ...lastfm, source: 'lastfm', server_time: nowTs };
}

// ── Last.fm ─────────────────────────────────────────────────────────────

async function lfm(env, method, params) {
  const url = new URL(API);
  url.search = new URLSearchParams({ method, api_key: env.LASTFM_API_KEY, format: 'json', ...params });
  const res = await fetch(url, { headers: { 'User-Agent': 'folzy-music/1.0' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Last.fm ${method}: ${data.message || res.status}`);
  return data;
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function cover(images) {
  const list = asList(images);
  const pick = list.find((i) => i.size === 'extralarge') || list[list.length - 1];
  const src = pick && pick['#text'];
  return src && !src.includes(PLACEHOLDER_IMAGE) ? src : null;
}

export function linkFor(artist, title) {
  return `https://soundcloud.com/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`;
}

export function toTrack(item) {
  const artist = (item.artist && (item.artist['#text'] || item.artist.name)) || '';
  const title = item.name || '';
  return {
    title,
    artist,
    album: (item.album && item.album['#text']) || '',
    cover: cover(item.image),
    link: linkFor(artist, title),
  };
}

async function nowPlaying(env) {
  const data = await lfm(env, 'user.getrecenttracks', { user: env.LASTFM_USER, limit: '1' });
  const items = asList(data.recenttracks && data.recenttracks.track);
  const live = items.find((i) => i['@attr'] && i['@attr'].nowplaying === 'true');
  const last = items.find((i) => i.date && i.date.uts);
  return {
    playing: Boolean(live),
    track: live ? toTrack(live) : null,
    last: last ? { ...toTrack(last), ts: Number(last.date.uts) } : null,
    updated: Math.floor(Date.now() / 1000),
  };
}

async function fetchScrobbles(env, since) {
  const out = [];
  let page = 1;
  let pages = 1;
  while (page <= Math.min(pages, MAX_PAGES)) {
    const data = await lfm(env, 'user.getrecenttracks', {
      user: env.LASTFM_USER, limit: '200', page: String(page), from: String(since),
    });
    const block = data.recenttracks || {};
    pages = Number((block['@attr'] || {}).totalPages || 1);
    for (const item of asList(block.track)) {
      if (!item.date || !item.date.uts) continue;      // «сейчас играет» ещё не скроббл
      out.push({ ...toTrack(item), ts: Number(item.date.uts) });
    }
    page += 1;
  }
  return out;
}

export function trackKey(artist, title) {
  return `${(artist || '').toLowerCase().trim()}|${(title || '').toLowerCase().trim()}`;
}

async function durations(env, scrobbles) {
  const keys = [...new Map(scrobbles.map((s) => [trackKey(s.artist, s.title), s])).entries()];
  const known = {};
  const missing = [];
  await Promise.all(keys.map(async ([key, s]) => {
    const value = await kvGet(env, `dur:${key}`);
    if (value !== null) known[key] = Number(value);
    else missing.push([key, s]);
  }));
  // чаще играемые — первыми: они сильнее влияют на сумму
  const plays = {};
  for (const s of scrobbles) plays[trackKey(s.artist, s.title)] = (plays[trackKey(s.artist, s.title)] || 0) + 1;
  missing.sort((a, b) => plays[b[0]] - plays[a[0]]);
  await Promise.all(missing.slice(0, DURATION_BUDGET).map(async ([key, s]) => {
    let seconds = 0;
    try {
      const info = await lfm(env, 'track.getInfo', { artist: s.artist, track: s.title, autocorrect: '1' });
      seconds = Math.round(Number((info.track && info.track.duration) || 0) / 1000);
    } catch (_) { /* трека нет в базе Last.fm — запомним 0, считаем по медиане */ }
    known[key] = seconds;
    await kvPut(env, `dur:${key}`, String(seconds), 60 * 60 * 24 * 60);
  }));
  return known;
}

// ── Время ───────────────────────────────────────────────────────────────

function zoned(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
  }).formatToParts(new Date(ts * 1000));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')),
  };
}

// unix-время полуночи даты (year, month, day) в часовом поясе tz
function midnight(year, month, day, tz) {
  const guess = Date.UTC(year, month - 1, day) / 1000;
  const z = zoned(guess, tz);
  const offset = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) / 1000 - guess;
  return guess - offset;
}

export function boundaries(nowTs, tz) {
  const z = zoned(nowTs, tz);
  const today = midnight(z.year, z.month, z.day, tz);
  const weekDate = new Date(Date.UTC(z.year, z.month - 1, z.day - z.weekday));
  const week = midnight(weekDate.getUTCFullYear(), weekDate.getUTCMonth() + 1, weekDate.getUTCDate(), tz);
  const month = midnight(z.year, z.month, 1, tz);
  return { today, week, month, dayOfMonth: z.day };
}

// ── Подсчёт (чистая функция, её проверяют тесты) ─────────────────────────

export function computeStats(scrobbles, known, nowTs, tz) {
  const values = Object.values(known).filter((v) => v > 0).sort((a, b) => a - b);
  const median = values.length ? values[Math.floor(values.length / 2)] : DEFAULT_DURATION;
  let estimated = false;
  const length = (s) => {
    const v = known[trackKey(s.artist, s.title)];
    if (v > 0) return v;
    estimated = true;
    return median;
  };
  const b = boundaries(nowTs, tz);
  const windows = { today: b.today, week: b.week, month: b.month };
  const result = {};
  for (const [name, since] of Object.entries(windows)) {
    const list = scrobbles.filter((s) => s.ts >= since && s.ts <= nowTs);
    result[name] = { tracks: list.length, seconds: list.reduce((sum, s) => sum + length(s), 0) };
  }
  result.avg_day = {
    tracks: Math.round(result.month.tracks / b.dayOfMonth),
    seconds: Math.round(result.month.seconds / b.dayOfMonth),
  };

  const counter = new Map();
  for (const s of scrobbles) {
    if (s.ts < b.month) continue;
    const key = trackKey(s.artist, s.title);
    const entry = counter.get(key) || { title: s.title, artist: s.artist, cover: null, link: s.link, plays: 0 };
    entry.plays += 1;
    entry.cover = entry.cover || s.cover;
    counter.set(key, entry);
  }
  result.top = [...counter.values()].sort((a, b2) => b2.plays - a.plays).slice(0, TOP_LIMIT);
  result.estimated = estimated;
  result.tz = tz;
  result.updated = nowTs;
  return result;
}

async function stats(env) {
  const tz = env.TIMEZONE || 'Europe/Moscow';
  const nowTs = Math.floor(Date.now() / 1000);
  const b = boundaries(nowTs, tz);
  const scrobbles = await fetchScrobbles(env, Math.min(b.week, b.month));
  const known = await durations(env, scrobbles);
  return computeStats(scrobbles, known, nowTs, tz);
}

// ── Кэш и ответы ────────────────────────────────────────────────────────

async function kvGet(env, key) {
  if (env.CACHE) return env.CACHE.get(key);
  const hit = memory.get(key);
  return hit && hit.until > Date.now() ? hit.value : null;
}

async function kvPut(env, key, value, ttl) {
  if (env.CACHE) return env.CACHE.put(key, value, { expirationTtl: Math.max(60, ttl) });
  memory.set(key, { value, until: Date.now() + ttl * 1000 });
}

async function cached(env, key, ttl, build) {
  const hit = memory.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  if (env.CACHE && ttl >= 60) {
    const stored = await env.CACHE.get(key, 'json');
    if (stored && stored.updated + ttl > Date.now() / 1000) {
      memory.set(key, { value: stored, until: (stored.updated + ttl) * 1000 });
      return stored;
    }
  }
  const value = await build();
  memory.set(key, { value, until: Date.now() + ttl * 1000 });
  if (env.CACHE && ttl >= 60) await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl * 6 });
  return value;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
      ...cors(),
    },
  });
}
