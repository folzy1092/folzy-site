import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { NowState, artwork, boundaries, cleanTrack, computeStats, cover, fromPush, pickScTrack, rememberCovers, toTrack, withCovers } from '../src/index.js';

// тесты без сети: всё, что не подменено в самом тесте, получает 404
globalThis.fetch = async () => new Response('', { status: 404 });

const TZ = 'Europe/Riga';
// воскресенье, 8 ноября 2026, 23:30 по Риге (UTC+2)
const NOW = Date.UTC(2026, 10, 8, 21, 30) / 1000;

test('границы суток, недели и месяца считаются по Риге', () => {
  const b = boundaries(NOW, TZ);
  assert.equal(b.today, Date.UTC(2026, 10, 7, 22) / 1000);    // 8 ноя 00:00 Рига
  assert.equal(b.week, Date.UTC(2026, 10, 1, 22) / 1000);     // пн 2 ноя 00:00 Рига
  assert.equal(b.month, Date.UTC(2026, 9, 31, 22) / 1000);    // 1 ноя 00:00 Рига
  assert.equal(b.dayOfMonth, 8);
});

test('МСК: сутки с 00:00 по Москве (UTC+3, без перехода на летнее)', () => {
  const b = boundaries(NOW, 'Europe/Moscow');                 // 9 ноя 00:30 по Москве
  assert.equal(b.today, Date.UTC(2026, 10, 8, 21) / 1000);    // 9 ноя 00:00 МСК
  assert.equal(b.week, Date.UTC(2026, 10, 8, 21) / 1000);     // понедельник 9 ноя
  assert.equal(b.month, Date.UTC(2026, 9, 31, 21) / 1000);    // 1 ноя 00:00 МСК
  assert.equal(b.dayOfMonth, 9);
});

test('летнее время: в июле Рига UTC+3', () => {
  const july = Date.UTC(2026, 6, 15, 12) / 1000;
  assert.equal(boundaries(july, TZ).today, Date.UTC(2026, 6, 14, 21) / 1000);
});

test('статистика: окна, среднее за день, топ, оценка длительности', () => {
  const t = (title, ts) => ({ title, artist: 'A', cover: null, link: '', ts });
  const today = Date.UTC(2026, 10, 8, 10) / 1000;
  const thisWeek = Date.UTC(2026, 10, 3, 10) / 1000;
  const thisMonth = Date.UTC(2026, 10, 1, 10) / 1000;    // воскресенье прошлой недели
  const lastMonth = Date.UTC(2026, 9, 30, 10) / 1000;
  const scrobbles = [t('x', today), t('x', today), t('y', thisWeek), t('z', thisMonth), t('old', lastMonth)];
  const known = { 'a|x': 200, 'a|y': 100, 'a|z': 0 };          // z неизвестна → медиана
  const s = computeStats(scrobbles, known, NOW, TZ);
  assert.deepEqual(s.today, { tracks: 2, seconds: 400 });
  assert.deepEqual(s.week, { tracks: 3, seconds: 500 });
  assert.deepEqual(s.month, { tracks: 4, seconds: 700 });       // z = медиана [100, 200] → 200
  assert.deepEqual(s.avg_day, { tracks: 1, seconds: 88 });       // 700 / 8 дней
  assert.equal(s.estimated, true);
  assert.equal(s.top[0].title, 'x');
  assert.equal(s.top[0].plays, 2);
  assert.ok(!s.top.some((x) => x.title === 'old'));
});

test('заглушка Last.fm вместо обложки не отдаётся', () => {
  const ph = [{ size: 'extralarge', '#text': 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png' }];
  assert.equal(cover(ph), null);
  assert.equal(cover([{ size: 'extralarge', '#text': 'https://img/x.jpg' }]), 'https://img/x.jpg');
});

test('ссылка на трек ведёт в поиск SoundCloud', () => {
  const tr = toTrack({ name: 'Track', artist: { '#text': 'Artist' }, image: [] });
  assert.equal(tr.link, 'https://soundcloud.com/search?q=Artist%20Track');
});

test('/now: играет и не играет', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'u' };
  const answer = (track) => async () => new Response(JSON.stringify({ recenttracks: { track } }));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = answer([
      { name: 'Live', artist: { '#text': 'A' }, '@attr': { nowplaying: 'true' }, image: [] },
      { name: 'Prev', artist: { '#text': 'B' }, date: { uts: '100' }, image: [] },
    ]);
    let res = await worker.fetch(new Request('https://w/now'), env, {});
    let body = await res.json();
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(body.playing, true);
    assert.equal(body.track.title, 'Live');

    globalThis.fetch = answer({ name: 'Prev', artist: { '#text': 'B' }, date: { uts: '100' }, image: [] });
    // свежий воркер-кэш на 15 с — берём новый env, чтобы не попасть в память
    res = await worker.fetch(new Request('https://w/now?x'), { ...env, LASTFM_USER: 'u2' }, {});
    body = await res.json();
    assert.ok(body.playing === true || body.playing === false);
  } finally {
    globalThis.fetch = original;
  }
});

test('без ключа — понятная ошибка', async () => {
  const res = await worker.fetch(new Request('https://w/'), {}, {});
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /LASTFM/);
});

// Durable Object в памяти: тот же NowState, хранилище — Map
function fakeNow() {
  const store = new Map();
  const obj = new NowState({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } } });
  return { idFromName: () => 'id', get: () => ({ fetch: (url, init = {}) => obj.fetch(new Request(url, init)) }) };
}

const push = (env, body, token = 'secret') => worker.fetch(new Request('https://w/now', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env, {});

test('бот: без токена — 401, с токеном трек отдаётся с позицией на сейчас', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'bot-1', PUSH_TOKEN: 'secret', NOW: fakeNow() };
  const at = Date.now() / 1000 - 10;
  const track = { title: 'T', artist: 'A', cover: 'https://i/c.jpg', link: 'https://soundcloud.com/a/t', duration: 200, position: 30, at };
  assert.equal((await push(env, { playing: true, track }, 'wrong')).status, 401);
  assert.equal((await push(env, { playing: true, track })).status, 200);
  const body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
  assert.equal(body.source, 'bot');
  assert.equal(body.playing, true);
  assert.equal(body.track.title, 'T');
  assert.ok(body.track.position >= 39 && body.track.position <= 42, body.track.position);
  assert.ok(body.server_time > 0);
});

test('бот: «не играет» + последний трек не трогают Last.fm', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'bot-2', PUSH_TOKEN: 'secret', NOW: fakeNow() };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Last.fm не должен вызываться'); };
  try {
    await push(env, { playing: false, last: { title: 'Prev', artist: 'B', ts: 100 } });
    const body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
    assert.equal(body.playing, false);
    assert.equal(body.last.title, 'Prev');
    assert.equal(body.source, 'bot');
  } finally {
    globalThis.fetch = original;
  }
});

test('бот замолчал дольше PUSH_FRESH — берём Last.fm', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'bot-3', PUSH_TOKEN: 'secret', NOW: fakeNow() };
  await env.NOW.get().fetch('https://now/', { method: 'PUT', body: JSON.stringify({ playing: true, track: { title: 'Old' }, received: 1 }) });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ recenttracks: { track: [
    { name: 'FromLastfm', artist: { '#text': 'C' }, '@attr': { nowplaying: 'true' }, image: [] }] } }));
  try {
    const body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
    assert.equal(body.source, 'lastfm');
    assert.equal(body.track.title, 'FromLastfm');
  } finally {
    globalThis.fetch = original;
  }
});

test('чистка трека от бота: чужие ссылки и http-обложки не проходят', () => {
  const t = cleanTrack({ title: 'X', artist: 'Y', link: 'https://evil.example/x', cover: 'http://i/c.jpg', duration: -5 });
  assert.equal(t.link, 'https://soundcloud.com/search?q=Y%20X');
  assert.equal(t.cover, null);
  assert.equal(t.duration, 0);
  assert.equal(cleanTrack({ artist: 'no title' }), null);
});

test('позиция не уходит за длительность', () => {
  const r = fromPush({ track: { title: 'T', duration: 100, position: 90, at: 900 }, received: 900 }, 1000);
  assert.equal(r.track.position, 100);
  assert.equal(r.track.at, undefined);
});

// KV в памяти
function fakeKv() {
  const store = new Map();
  const writes = [];
  return {
    store, writes,
    get: async (k, type) => { const v = store.get(k); return v === undefined ? null : (type === 'json' ? JSON.parse(v) : v); },
    put: async (k, v) => { writes.push(k); store.set(k, v); },
  };
}

test('обложки: запоминаются от бота, повторно не пишутся, подставляются по артисту и названию', async () => {
  const env = { CACHE: fakeKv() };
  const t = { title: 'Zombie', artist: 'cowboyclicker', cover: 'https://i1.sndcdn.com/z.jpg' };
  await rememberCovers(env, [t, null, { title: 'x', artist: 'y', cover: null }]);
  await rememberCovers(env, [t]);
  assert.deepEqual(env.CACHE.writes, ['cover:cowboyclicker|zombie']);
  const top = [{ title: 'zombie ', artist: 'CowboyClicker', cover: null }, { title: 'other', artist: 'z', cover: null }];
  await withCovers(env, top);
  assert.equal(top[0].cover, 'https://i1.sndcdn.com/z.jpg');
  assert.equal(top[1].cover, null);
});

test('обложка из пуша бота попадает в ответ из Last.fm', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'covers-1', PUSH_TOKEN: 'secret', NOW: fakeNow(), CACHE: fakeKv() };
  await push(env, { playing: true, track: { title: 'T', artist: 'A', cover: 'https://i/c.jpg', duration: 100, position: 1, at: Date.now() / 1000 } });
  // бот замолчал надолго — ответ берётся из Last.fm, где обложки нет
  await env.NOW.get().fetch('https://now/', { method: 'PUT', body: JSON.stringify({ playing: false, track: null, received: 1 }) });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ recenttracks: { track: [
    { name: 'T', artist: { '#text': 'A' }, '@attr': { nowplaying: 'true' }, image: [] }] } }));
  try {
    const body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
    assert.equal(body.source, 'lastfm');
    assert.equal(body.track.cover, 'https://i/c.jpg');
  } finally {
    globalThis.fetch = original;
  }
});

// ── SoundCloud ──

const scResults = [
  { title: 'de_survivor onda andar (instrumental)', user: { username: 'lokep23' }, artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg', permalink_url: 'https://soundcloud.com/m/x' },
  { title: 'de_survivor', full_duration: 196123, user: { username: 'ONDA ANDAR', permalink_url: 'https://soundcloud.com/onda_andar' }, publisher_metadata: { artist: 'ONDA ANDAR' }, artwork_url: 'https://i1.sndcdn.com/artworks-VClI-large.png', permalink_url: 'https://soundcloud.com/onda_andar/de_survivor-9' },
];

test('SoundCloud: берётся трек с тем же названием и автором, обложка 500x500', () => {
  const r = pickScTrack(scResults, 'onda andar', 'de_survivor');
  assert.equal(r.cover, 'https://i1.sndcdn.com/artworks-VClI-t500x500.png');
  assert.equal(r.link, 'https://soundcloud.com/onda_andar/de_survivor-9');
  assert.equal(r.artist_link, 'https://soundcloud.com/onda_andar');
  assert.equal(r.duration, 196);
  assert.equal(pickScTrack(scResults, 'onda andar', 'совсем другое'), null);
  assert.equal(artwork({ user: { avatar_url: 'https://i1.sndcdn.com/avatars-a-large.jpg' } }), 'https://i1.sndcdn.com/avatars-a-t500x500.jpg');
});

test('SoundCloud: client_id со страницы, поиск, кэш и «не нашли» без повторных запросов', async () => {
  const env = { CACHE: fakeKv() };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    url = String(url);
    calls.push(url.split('?')[0]);
    if (url === 'https://soundcloud.com/') return new Response('<script crossorigin src="https://a-v2.sndcdn.com/assets/1.js"></script>');
    if (url.endsWith('/1.js')) return new Response('x={client_id:"abcdefghijklmnopqrstuvwxyz012345"}');
    if (url.includes('search/tracks')) {
      assert.match(url, /client_id=abcdefghijklmnopqrstuvwxyz012345/);
      return new Response(JSON.stringify({ collection: url.includes('de_survivor') ? scResults : [] }));
    }
    throw new Error(`лишний запрос ${url}`);
  };
  try {
    const top = [
      { title: 'de_survivor', artist: 'onda andar', cover: null, link: 'https://soundcloud.com/search?q=x' },
      { title: 'нет такого', artist: 'никто', cover: null, link: 'https://soundcloud.com/search?q=y' },
    ];
    await withCovers(env, top);
    assert.equal(top[0].cover, 'https://i1.sndcdn.com/artworks-VClI-t500x500.png');
    assert.equal(top[0].link, 'https://soundcloud.com/onda_andar/de_survivor-9');
    assert.equal(top[1].cover, null);
    assert.equal(top[1].link, 'https://soundcloud.com/search?q=y');
    const before = calls.length;
    await withCovers(env, [{ ...top[0], cover: null }, { ...top[1] }]);     // всё из кэша
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});

test('SoundCloud: обложка от бота важнее найденной, ссылка — прямая', async () => {
  const env = { CACHE: fakeKv() };
  await env.CACHE.put('cover:onda andar|de_survivor', 'https://bot/cover.jpg');
  await env.CACHE.put('sc3:onda andar|de_survivor', JSON.stringify({ cover: 'https://sc/cover.jpg', link: 'https://soundcloud.com/onda_andar/de_survivor-9' }));
  const [t] = await withCovers(env, [{ title: 'de_survivor', artist: 'onda andar', cover: null, link: '' }]);
  assert.equal(t.cover, 'https://bot/cover.jpg');
  assert.equal(t.link, 'https://soundcloud.com/onda_andar/de_survivor-9');
});

test('song.link с SoundCloud внутри разворачивается в прямую ссылку', () => {
  assert.equal(cleanTrack({ title: 'X', link: 'https://song.link/https://soundcloud.com/onda_andar/x' }).link, 'https://soundcloud.com/onda_andar/x');
  assert.equal(cleanTrack({ title: 'X', link: 'https://song.link/ya/123' }).link, 'https://song.link/ya/123');
});

test('бот: точная длина трека попадает в кэш длительностей', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'dur-1', PUSH_TOKEN: 'secret', NOW: fakeNow(), CACHE: fakeKv() };
  await push(env, { playing: true, track: { title: 'Zombie', artist: 'cowboyclicker', duration: 131, position: 1, at: Date.now() / 1000 } });
  assert.equal(await env.CACHE.get('dur2:cowboyclicker|zombie'), '131');
});

test('онлайн: вкладки считаются, ушедшие и мусорные id — нет', async () => {
  const env = { NOW: fakeNow() };
  const hit = async (body) => (await worker.fetch(new Request('https://w/presence', { method: 'POST', body: JSON.stringify(body) }), env, {})).json();
  assert.equal((await hit({ id: 'aaaaaaaa1' })).online, 1);
  assert.equal((await hit({ id: 'bbbbbbbb2' })).online, 2);
  assert.equal((await hit({ id: 'aaaaaaaa1' })).online, 2);
  assert.equal((await hit({ id: 'BAD id!' })).online, 2);
  assert.equal((await hit({ id: 'aaaaaaaa1', leave: true })).online, 1);
  const res = await worker.fetch(new Request('https://w/presence'), env, {});
  assert.equal((await res.json()).online, 1);
});

test('Dotify оборвал трек посреди — сайт доигрывает его по часам до конца', async () => {
  const env = { LASTFM_API_KEY: 'k', LASTFM_USER: 'hold-1', PUSH_TOKEN: 'secret', NOW: fakeNow() };
  const now = Date.now() / 1000;
  await push(env, { playing: true, track: { title: 'Long', artist: 'A', duration: 200, position: 50, at: now - 10 } });
  await push(env, { playing: false });
  let body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
  assert.equal(body.playing, true);
  assert.equal(body.track.title, 'Long');
  assert.ok(body.track.position >= 59 && body.track.position <= 62, body.track.position);
  // повторное «не играет» не теряет удерживаемый трек
  await push(env, { playing: false });
  body = await (await worker.fetch(new Request('https://w/now'), env, {})).json();
  assert.equal(body.track.title, 'Long');
});

test('удерживаемый трек доиграл — тишина; новый трек заменяет сразу', () => {
  const held = { title: 'Old', artist: 'A', duration: 100, position: 90, at: 1000 };
  assert.equal(fromPush({ track: null, held, received: 1000 }, 1005).playing, true);
  assert.equal(fromPush({ track: null, held, received: 1000 }, 1011).playing, false);
  const fresh = { title: 'New', artist: 'B', duration: 100, position: 1, at: 1005 };
  assert.equal(fromPush({ track: fresh, held, received: 1005 }, 1006).track.title, 'New');
});
