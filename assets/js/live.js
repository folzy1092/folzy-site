// Блок Live: «сейчас играет» и статистика музыки из endpoint (worker/), плюс виджет на экране айфона.
(() => {
  const cfg = window.FOLZY || {};
  const base = (cfg.musicEndpoint || '').replace(/\/+$/, '');
  const demo = new URLSearchParams(location.search).has('demo');
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
  const scSearch = (q) => `https://soundcloud.com/search?q=${encodeURIComponent(q)}`;
  const artistHref = (t) => t.artist_link || `https://soundcloud.com/search/people?q=${encodeURIComponent(t.artist || '')}`;
  const setLink = (el, href) => { if (href) el.href = href; else el.removeAttribute('href'); };

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
    if (demo || !base) { await new Promise((r) => setTimeout(r, 400)); return demoData()[path.slice(1)]; }
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
    const k = pos / progress.dur;
    $('#now-progress-fill').style.transform = `scaleX(${k})`;
    $('#now-pos').textContent = clock(pos);
    $('#now-left').textContent = `−${clock(progress.dur - pos)}`;
    $('#iphone-np-fill').style.transform = `scaleX(${k})`;
    $('#iphone-np-pos').textContent = clock(pos);
    $('#iphone-np-left').textContent = `−${clock(progress.dur - pos)}`;
    if (pos >= progress.dur && !endTimer) {
      // трек доиграл — спросим следующий чуть позже, как пост канала «ищу актуальный трек…»
      endTimer = setTimeout(() => { endTimer = 0; loadNow(); }, 4000);
    }
  };
  const setProgress = (t) => {
    const ok = t && t.duration > 0 && typeof t.position === 'number';
    $('#now-progress').hidden = !ok;
    $('#iphone-np-progress').hidden = !ok;
    clearInterval(progressTimer);
    clearTimeout(endTimer);
    endTimer = 0;
    progress = ok ? { pos: t.position, dur: t.duration, at: performance.now() } : null;
    if (!ok) return;
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
    setLink(cover, t && t.link);
    $('#now-backdrop').style.backgroundImage = t ? bg(t.cover) : '';
    $('#now-label').textContent = t ? 'Сейчас играет' : 'Тишина';

    const title = $('#now-title');
    title.textContent = t ? t.title : 'Сейчас ничего не играет';
    setLink(title, t && (t.link || scSearch(`${t.artist} ${t.title}`)));
    const artist = $('#now-artist');
    artist.textContent = t ? t.artist : 'Включу что-нибудь — появится здесь';
    setLink(artist, t && artistHref(t));

    setProgress(t);
    document.dispatchEvent(new CustomEvent('folzy:now', {
      detail: { track: t, position: () => (progress ? Math.min(progress.dur, progress.pos + (performance.now() - progress.at) / 1000) : 0) },
    }));

    const last = data.last;
    const lastEl = $('#now-last');
    lastEl.hidden = !last || Boolean(t && last.title === t.title && last.artist === t.artist);
    if (last) {
      setLink(lastEl, last.link || scSearch(`${last.artist} ${last.title}`));
      $('#now-last-cover').style.backgroundImage = bg(last.cover);
      $('#now-last-title').textContent = `${last.artist} — ${last.title}`;
      $('#now-last-meta').textContent = `${t ? 'До этого' : 'Последний'} · ${ago(last.ts)}`;
    }

    // полоска в hero
    const strip = $('#strip-music');
    strip.textContent = t ? `${t.artist} — ${t.title}` : 'Сейчас ничего не играет';
    strip.closest('.strip__item').classList.toggle('is-live', Boolean(t));
    const stripIco = $('#strip-music-ico');
    stripIco.style.backgroundImage = t ? bg(t.cover) : '';
    stripIco.classList.toggle('has-cover', Boolean(t && t.cover));

    // экран айфона: виджет плеера только пока трек играет, как на настоящем экране блокировки
    $('#iphone-np').hidden = !t;
    if (t) {
      $('#iphone-np-title').textContent = t.title;
      $('#iphone-np-artist').textContent = t.artist;
      $('#iphone-np-cover').style.backgroundImage = bg(t.cover);
    }
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

    const top = s.top || [];
    $('#top-tracks').hidden = !top.length;
    $('#top-list').innerHTML = top.map((t, i) => `
      <li class="top__row">
        <span class="top__n">${i + 1}</span>
        <span class="top__cover" style="background-image:${esc(bg(t.cover))}">${t.cover ? '' : '<svg class="ico"><use href="#i-music"/></svg>'}</span>
        <span class="top__text">
          <a class="top__title" href="${esc(t.link || scSearch(`${t.artist} ${t.title}`))}" target="_blank" rel="noopener">${esc(t.title)}</a>
          <a class="top__artist" href="${esc(artistHref(t))}" target="_blank" rel="noopener">${esc(t.artist)}</a>
        </span>
        <span class="top__plays">${t.plays}<small>${plural(t.plays, 'раз', 'раза', 'раз')}</small></span>
      </li>`).join('');
  };

  // ── Ошибки ──
  const failNow = (text) => {
    nowEl.dataset.state = 'error';
    $('#now-label').textContent = 'Нет связи';
    $('#now-title').textContent = 'Нет данных';
    $('#now-title').removeAttribute('href');
    $('#now-artist').textContent = text;
    $('#now-artist').removeAttribute('href');
    $('#now-last').hidden = true;
    $('#iphone-np').hidden = true;
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

  if (demo || !base) $('#demo-note').hidden = false;

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
