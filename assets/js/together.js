// «Слушать вместе» и «сейчас на сайте».
//
// Музыка: официальный встраиваемый плеер SoundCloud (Widget API). Звук идёт с SoundCloud прямо к посетителю —
// через сервер и воркер ничего не проходит, поэтому трансляция ничего не стоит и без слушателей не существует.
// Включается кнопкой (без клика браузеры звук не дают), встаёт на ту же секунду, что у владельца, сам
// переходит на следующий трек и поправляется, если разошёлся больше чем на DRIFT секунд. Закрыл вкладку — тишина.
//
// Онлайн: вкладка, пока видна (или пока в ней играет музыка), раз в 30 с шлёт воркеру свой случайный id;
// при уходе — «ушёл» через sendBeacon. Воркер считает id, отметившиеся за последние 75 с.
(() => {
  const cfg = window.FOLZY || {};
  const base = (cfg.musicEndpoint || '').replace(/\/+$/, '');
  const $ = (s) => document.querySelector(s);
  const DRIFT = 4;

  // ── Слушать вместе ──
  const btn = $('#listen-btn');
  const label = $('#listen-label');
  const box = $('#now-player');
  let widget = null;
  let listening = false;
  let track = null;            // что играет у владельца сейчас
  let loadedLink = '';         // что загружено в плеер
  let position = () => 0;
  let apiLoading = null;

  const isPermalink = (url) => /^https:\/\/soundcloud\.com\/(?!search\b)[^/?#]+\/[^/?#]+/.test(url || '');
  const api = () => {
    apiLoading = apiLoading || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://w.soundcloud.com/player/api.js';
      s.onload = () => resolve(window.SC);
      s.onerror = () => { apiLoading = null; reject(new Error('SoundCloud Widget API не загрузился')); };
      document.head.append(s);
    });
    return apiLoading;
  };
  const playerSrc = (url) => `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true`
    + '&visual=false&show_artwork=false&show_comments=false&show_user=true&show_reposts=false&show_teaser=false'
    + '&hide_related=true&buying=false&sharing=false&download=false&color=%23d0d0d0';
  const seekNow = () => { if (widget) widget.seekTo(Math.max(0, position() * 1000)); };

  const render = () => {
    const canListen = Boolean(track && isPermalink(track.link));
    btn.hidden = !canListen && !listening;
    btn.classList.toggle('is-on', listening);
    label.textContent = listening ? (track ? 'Не слушать' : 'Жду следующий трек…') : 'Слушать вместе';
    box.hidden = !listening;
  };

  const loadTrack = () => {
    if (!widget || !track || !isPermalink(track.link)) return;
    if (loadedLink === track.link) return;
    loadedLink = track.link;
    widget.load(track.link, { auto_play: true, callback: () => { widget.play(); seekNow(); } });
  };

  const start = async () => {
    if (!track || !isPermalink(track.link)) return;
    listening = true;
    render();
    const SC = await api().catch(() => null);
    if (!SC) { listening = false; render(); window.toast && toast('Плеер SoundCloud не загрузился'); return; }
    box.innerHTML = `<iframe title="Плеер SoundCloud" allow="autoplay; encrypted-media" scrolling="no" src="${playerSrc(track.link)}"></iframe>`;
    loadedLink = track.link;
    widget = SC.Widget(box.querySelector('iframe'));
    widget.bind(SC.Widget.Events.READY, () => { widget.play(); seekNow(); });
    // после буферизации и после паузы — снова на секунду владельца
    widget.bind(SC.Widget.Events.PLAY, () => setTimeout(seekNow, 250));
    presenceStart();
  };

  const stop = () => {
    listening = false;
    if (widget) widget.pause();
    widget = null;
    loadedLink = '';
    box.innerHTML = '';
    render();
    if (document.hidden) presenceStop();
  };

  btn.addEventListener('click', () => (listening ? stop() : start()));

  document.addEventListener('folzy:now', (e) => {
    track = e.detail.track && isPermalink(e.detail.track.link) ? e.detail.track : (e.detail.track || null);
    position = e.detail.position;
    if (listening && widget) {
      if (!track) {
        widget.pause();
      } else if (loadedLink !== track.link) {
        loadTrack();
      } else {
        widget.isPaused((paused) => {
          if (paused) return;
          widget.getPosition((ms) => { if (Math.abs(ms / 1000 - position()) > DRIFT) seekNow(); });
        });
      }
    }
    render();
  });

  // ── Сейчас на сайте ──
  const onlineEl = $('#online');
  const onlineN = $('#online-n');
  const id = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 16);
  let presenceTimer = 0;

  const ping = () => fetch(`${base}/presence`, {
    method: 'POST', body: JSON.stringify({ id }), headers: { 'Content-Type': 'text/plain' }, keepalive: true,
  }).then((r) => r.json()).then((d) => {
    onlineN.textContent = d.online;
    onlineEl.hidden = !d.online;
  }).catch(() => {});

  function presenceStart() {
    if (!base || presenceTimer) return;
    ping();
    presenceTimer = setInterval(ping, 30000);
  }
  function presenceStop() {
    if (!base) return;
    clearInterval(presenceTimer);
    presenceTimer = 0;
    navigator.sendBeacon(`${base}/presence`, new Blob([JSON.stringify({ id, leave: true })], { type: 'text/plain' }));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) presenceStart();
    else if (!listening) presenceStop();       // музыка в фоновой вкладке — человек всё ещё «на сайте»
  });
  addEventListener('pagehide', presenceStop);
  if (!document.hidden) presenceStart();
  render();
})();
