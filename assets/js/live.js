// Блок Live: «сейчас играет» и статистика музыки из endpoint (worker/).
(() => {
  const cfg = window.FOLZY || {};
  const base = (cfg.musicEndpoint || '').replace(/\/+$/, '');
  const demo = !base && new URLSearchParams(location.search).has('demo');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const nowEl = $('#now');
  const statsEl = $('#stats');

  // ── Формат ──
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b > 1 && b < 5) return few;
    return many;
  };
  const tracks = (n) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;
  const duration = (sec) => {
    const m = Math.round(sec / 60);
    const h = Math.floor(m / 60);
    return h ? `${h}ч ${m % 60}м` : `${m}м`;
  };
  const ago = (ts) => {
    const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
    if (m < 1) return 'только что';
    if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
    const d = Math.round(h / 24);
    return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bg = (url) => (url ? `url("${encodeURI(url)}")` : '');

  // плавный счёт до значения при первой загрузке
  const countUp = (el, target, render) => {
    const from = Number(el.dataset.value || 0);
    el.dataset.value = target;
    if (reduced || from === target) { el.textContent = render(target); return; }
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 900);
      const eased = 1 - (1 - k) ** 3;
      el.textContent = render(Math.round(from + (target - from) * eased));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // ── Данные ──
  const demoData = () => {
    const t = Math.floor(Date.now() / 1000);
    const track = (i) => ({ title: `Название трека ${i}`, artist: 'Исполнитель', cover: null, link: 'https://soundcloud.com', duration: 174, position: 48 });
    return {
      now: { playing: true, track: track(1), last: { ...track(2), ts: t - 600 }, source: 'bot', updated: t, server_time: t },
      stats: {
        today: { tracks: 24, seconds: 4380 }, week: { tracks: 160, seconds: 30120 },
        month: { tracks: 410, seconds: 77400 }, avg_day: { tracks: 51, seconds: 9675 },
        estimated: true, updated: t,
        top: [1, 2, 3, 4, 5, 6].map((i) => ({ ...track(i), plays: 14 - i })),
      },
    };
  };

  const get = async (path) => {
    if (demo) { await new Promise((r) => setTimeout(r, 500)); return demoData()[path.slice(1)]; }
    const res = await fetch(base + path, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.status);
    return body;
  };

  // ── Ползунок: позиция от бота на server_time, дальше считаем сами по часам браузера ──
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  let progress = null;
  let progressTimer = 0;
  let endTimer = 0;
  const drawProgress = () => {
    if (!progress) return;
    const pos = Math.min(progress.dur, progress.pos + (performance.now() - progress.at) / 1000);
    $('#now-progress-fill').style.transform = `scaleX(${pos / progress.dur})`;
    $('#now-pos').textContent = clock(pos);
    if (pos >= progress.dur && !endTimer) {
      // трек доиграл — спросим следующий чуть позже, как пост канала «ищу актуальный трек…»
      endTimer = setTimeout(() => { endTimer = 0; loadNow(); }, 4000);
    }
  };
  const setProgress = (t) => {
    const ok = t && t.duration > 0 && typeof t.position === 'number';
    $('#now-progress').hidden = !ok;
    clearInterval(progressTimer);
    clearTimeout(endTimer);
    endTimer = 0;
    progress = ok ? { pos: t.position, dur: t.duration, at: performance.now() } : null;
    if (!ok) return;
    $('#now-dur').textContent = clock(t.duration);
    drawProgress();
    progressTimer = setInterval(drawProgress, 500);
  };

  // ── Сейчас играет ──
  let lastKey = '';
  const renderNow = (data) => {
    const t = data.playing ? data.track : null;
    const key = t ? `${t.artist}|${t.title}` : 'idle';
    const changed = key !== lastKey;
    lastKey = key;

    nowEl.dataset.state = t ? 'playing' : 'idle';
    if (changed && !reduced) {
      nowEl.classList.remove('is-swapping');
      void nowEl.offsetWidth;
      nowEl.classList.add('is-swapping');
    }

    const cover = $('#now-cover');
    cover.style.backgroundImage = t ? bg(t.cover) : '';
    cover.classList.toggle('has-img', Boolean(t && t.cover));
    cover.querySelector('use').setAttribute('href', t ? '#i-music' : '#i-music-off');
    $('#now-title').textContent = t ? t.title : 'Тишина';
    $('#now-artist').textContent = t ? t.artist : 'Сейчас ничего не играет';

    setProgress(t);

    const linkEl = $('#now-link');
    linkEl.hidden = !t;
    if (t) linkEl.href = t.link;

    const lastEl = $('#now-last');
    const last = data.last;
    lastEl.hidden = !last || Boolean(t && last.title === t.title && last.artist === t.artist);
    if (last) lastEl.innerHTML = `${t ? 'До этого' : 'Последний'}: <b>${esc(last.artist)} — ${esc(last.title)}</b>, ${ago(last.ts)}`;

    // полоска в hero
    const strip = $('#strip-music');
    strip.textContent = t ? `${t.artist} — ${t.title}` : 'Сейчас ничего не играет';
    strip.closest('.strip__item').classList.toggle('is-live', Boolean(t));

    // экран айфона
    $('#iphone-np-title').textContent = t ? t.title : 'Тишина';
    $('#iphone-np-artist').textContent = t ? t.artist : 'Сейчас ничего не играет';
    $('#iphone-np-cover').style.backgroundImage = t ? bg(t.cover) : '';
  };

  // ── Статистика ──
  const renderStats = (s) => {
    statsEl.dataset.state = 'ready';
    const approx = s.estimated ? '≈ ' : '';
    for (const name of ['today', 'week', 'month', 'avg_day']) {
      const block = s[name] || { tracks: 0, seconds: 0 };
      countUp($(`[data-stat="${name}"]`), block.seconds, (v) => (v ? approx : '') + duration(v));
      $(`[data-stat-tracks="${name}"]`).textContent = tracks(block.tracks);
    }
    $('#strip-today').textContent = `${s.today.seconds ? approx : ''}${duration(s.today.seconds)} · ${tracks(s.today.tracks)}`;
    $('#stats-note').textContent = s.estimated
      ? '≈ — длительность части треков ещё уточняется, время посчитано примерно.'
      : '';

    const list = $('#top-list');
    const top = s.top || [];
    $('#top-tracks').hidden = !top.length;
    list.innerHTML = top.map((t, i) => `
      <li><a href="${esc(t.link)}" target="_blank" rel="noopener">
        <span class="top__n">${i + 1}</span>
        <span class="top__cover" style="background-image:${esc(bg(t.cover))}">${t.cover ? '' : '<svg class="ico"><use href="#i-music"/></svg>'}</span>
        <span class="top__text"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></span>
        <span class="top__plays">${t.plays} ${plural(t.plays, 'раз', 'раза', 'раз')}</span>
      </a></li>`).join('');
  };

  // ── Ошибки и «не подключено» ──
  const failNow = (text) => {
    nowEl.dataset.state = 'error';
    $('#now-title').textContent = 'Нет данных';
    $('#now-artist').textContent = text;
    $('#now-link').hidden = true;
    $('#now-last').hidden = true;
    setProgress(null);
    $('#strip-music').textContent = 'Нет данных о музыке';
  };
  const failStats = (text) => {
    statsEl.dataset.state = 'error';
    $('#stats-note').textContent = text;
    $('#strip-today').textContent = '—';
  };

  const loadNow = async () => {
    try { renderNow(await get('/now')); } catch (e) { failNow('Last.fm не ответил. Попробую ещё раз через минуту.'); }
  };
  const loadStats = async () => {
    try { renderStats(await get('/stats')); } catch (e) { failStats('Статистика не загрузилась. Нажми «обновить» или зайди чуть позже.'); }
  };

  if (!base && !demo) {
    failNow('Endpoint музыки ещё не подключён.');
    failStats('Статистика появится, когда подключу endpoint.');
    $$('[data-refresh]').forEach((b) => { b.hidden = true; });
    return;
  }
  if (demo) $('#demo-note').hidden = false;

  $$('[data-refresh]').forEach((btn) => btn.addEventListener('click', () => {
    btn.classList.remove('is-spinning');
    void btn.offsetWidth;
    btn.classList.add('is-spinning');
    (btn.closest('#now') ? loadNow : loadStats)();
  }));

  loadNow();
  loadStats();
  // опрос только пока вкладка открыта
  let nowTimer;
  let statsTimer;
  const schedule = () => {
    clearInterval(nowTimer);
    clearInterval(statsTimer);
    if (document.hidden) return;
    nowTimer = setInterval(loadNow, (cfg.nowEvery || 20) * 1000);
    statsTimer = setInterval(loadStats, (cfg.statsEvery || 300) * 1000);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNow(); schedule(); });
  schedule();
})();
