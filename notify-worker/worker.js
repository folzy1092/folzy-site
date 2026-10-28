// Cloudflare Worker: принимает «заход на сайт» и шлёт уведомление в Telegram.
// Секреты (Settings -> Variables and Secrets): BOT_TOKEN, CHAT_ID

const ALLOWED_ORIGINS = [
  'https://folzy.ru',
  'https://www.folzy.ru',
  'https://folzy.is-a.dev',
];
const DEDUPE_SECONDS = 30 * 60; // одно уведомление с одного IP на сайт не чаще раза в 30 мин
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|telegram|whatsapp|discord|curl|wget|python|headless|lighthouse|monitor|uptime/i;

const esc = (s, max = 200) =>
  String(s ?? '').slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden', { status: 403 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: cors(origin) });
    }

    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_UA.test(ua)) {
      return new Response('ok', { status: 200, headers: cors(origin) });
    }

    // дедупликация по IP + сайту через Cache API
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const cache = caches.default;
    const key = new Request(`https://dedupe.invalid/${encodeURIComponent(origin)}/${encodeURIComponent(ip)}`);
    if (await cache.match(key)) {
      return new Response('ok', { status: 200, headers: cors(origin) });
    }
    ctx.waitUntil(
      cache.put(key, new Response('1', { headers: { 'Cache-Control': `max-age=${DEDUPE_SECONDS}` } }))
    );

    let data = {};
    try {
      data = JSON.parse(await request.text());
    } catch (_) {}

    const cf = request.cf || {};
    const place = [cf.country, cf.city].filter(Boolean).join(', ') || '—';
    const text =
      `👀 <b>Заход на ${esc(origin.replace('https://', ''))}</b>\n` +
      `Страница: ${esc(data.page)}\n` +
      `Откуда: ${esc(data.referrer || 'напрямую')}\n` +
      `Гео: ${esc(place)}\n` +
      `IP: <code>${esc(ip)}</code>\n` +
      `Язык: ${esc(data.lang, 20)} · Экран: ${esc(data.screen, 20)} · TZ: ${esc(data.tz, 40)}\n` +
      `UA: ${esc(ua, 150)}`;

    const tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    return new Response(tg.ok ? 'ok' : 'tg error', { status: tg.ok ? 200 : 502, headers: cors(origin) });
  },
};
