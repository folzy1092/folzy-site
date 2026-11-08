// Навигация, появление блоков, табы, часы, копирование, дождь в hero и айфон.
(() => {
  const cfg = window.FOLZY || {};
  const TZ = cfg.timezone || 'Europe/Riga';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // ── Тост ──
  const toastEl = $('#toast');
  let toastTimer;
  window.toast = (text) => {
    toastEl.textContent = text;
    toastEl.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-shown'), 2200);
  };

  // ── Навигация: фон при скролле + плашка под активным разделом ──
  const nav = $('#nav');
  const links = $$('.nav__links a');
  const pill = $('.nav__pill');
  const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const movePill = (link) => {
    links.forEach((a) => a.classList.toggle('is-active', a === link));
    if (!link) { pill.style.opacity = 0; return; }
    pill.style.opacity = 1;
    pill.style.width = `${link.offsetWidth}px`;
    pill.style.transform = `translateX(${link.offsetLeft}px)`;
  };
  const sections = links.map((a) => $(a.getAttribute('href')));
  const spy = () => {
    const line = innerHeight * 0.35;
    let current = null;
    sections.forEach((s, i) => { if (s.getBoundingClientRect().top < line) current = links[i]; });
    if (innerHeight + scrollY >= document.body.scrollHeight - 4) current = links[links.length - 1];
    movePill(current);
  };
  addEventListener('scroll', spy, { passive: true });
  addEventListener('resize', spy);
  spy();

  // ── Появление при скролле: соседи в одной сетке выходят лесенкой ──
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  $$('.reveal').forEach((el) => {
    const siblings = [...el.parentElement.children].filter((c) => c.classList.contains('reveal'));
    el.style.setProperty('--d', `${Math.min(siblings.indexOf(el), 5) * 0.07}s`);
    io.observe(el);
  });

  // ── Табы проектов ──
  const tabs = $$('.tab');
  const tabPill = $('.tabs__pill');
  const placeTabPill = (tab) => {
    tabPill.style.width = `${tab.offsetWidth}px`;
    tabPill.style.height = `${tab.offsetHeight}px`;
    tabPill.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
  };
  const selectTab = (tab, focus) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    });
    $$('[data-panel]').forEach((p) => {
      const on = p.dataset.panel === tab.dataset.tab;
      p.hidden = !on;
      if (on) {
        p.classList.remove('is-entering');
        void p.offsetWidth;
        p.classList.add('is-entering');
      }
    });
    placeTabPill(tab);
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (step) selectTab(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
  addEventListener('resize', () => placeTabPill($('.tab.is-active')));
  document.fonts.ready.then(() => { placeTabPill($('.tab.is-active')); spy(); });
  placeTabPill($('.tab.is-active'));

  // ── Часы по Риге ──
  const fmt = (opts) => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, ...opts });
  const hm = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const hms = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const dateFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
  const offset = () => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
    return name.replace('GMT', 'UTC');
  };
  const tick = () => {
    const now = new Date();
    $$('[data-clock="short"]').forEach((el) => { el.textContent = `${hm.format(now)} · Рига, ${offset()}`; });
    $$('[data-clock="full"]').forEach((el) => { el.textContent = hms.format(now); });
    $$('[data-clock="lock"]').forEach((el) => { el.textContent = hm.format(now); });
    const d = $('#iphone-date');
    if (d) d.textContent = dateFmt.format(now);
  };
  tick();
  setInterval(tick, 1000);

  // ── Копирование адресов ──
  $$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(`${btn.dataset.copyLabel} скопирован`);
  }));

  // ── Дождь в hero: фирменная деталь старого сайта, тише и только пока hero на экране ──
  const canvas = $('#rain');
  if (canvas && !reduced) {
    const ctx = canvas.getContext('2d');
    let drops = [];
    let raf = 0;
    let visible = true;
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(canvas.offsetWidth / 9);
      drops = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.offsetWidth,
        y: Math.random() * canvas.offsetHeight,
        len: 8 + Math.random() * 16,
        speed: 4 + Math.random() * 6,
        alpha: 0.05 + Math.random() * 0.12,
      }));
    };
    const frame = () => {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 1;
      for (const d of drops) {
        ctx.strokeStyle = `rgba(220,220,230,${d.alpha})`;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len * 0.12, d.y + d.len);
        ctx.stroke();
        d.y += d.speed;
        d.x -= d.speed * 0.12;
        if (d.y > h) { d.y = -d.len; d.x = Math.random() * (w + 40); }
      }
      raf = visible ? requestAnimationFrame(frame) : 0;
    };
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    }).observe(canvas);
    addEventListener('resize', resize);
    resize();
    raf = requestAnimationFrame(frame);
  }

  // ── iPhone: наклон за курсором, поворот по клику, один разворот при первом показе ──
  const phone = $('#iphone');
  if (phone) {
    let flipped = false;
    const setFlip = (deg) => phone.style.setProperty('--flip', `${deg}deg`);
    const flip = () => { flipped = !flipped; setFlip(flipped ? 180 : 0); };
    phone.addEventListener('click', flip);
    phone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    $('#phone-flip').addEventListener('click', flip);

    if (!reduced) {
      const stage = phone.closest('.phone-stage');
      stage.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = stage.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        phone.classList.add('is-tracking');
        phone.style.setProperty('--ry', `${x * 26}deg`);
        phone.style.setProperty('--rx', `${-y * 18}deg`);
      });
      stage.addEventListener('pointerleave', () => {
        phone.classList.remove('is-tracking');
        phone.style.setProperty('--ry', '0deg');
        phone.style.setProperty('--rx', '0deg');
      });
      // при первом появлении телефон стоит спиной и разворачивается экраном к тебе
      setFlip(-180);
      new IntersectionObserver(([e], obs) => {
        if (!e.isIntersecting) return;
        setTimeout(() => setFlip(0), 250);
        obs.disconnect();
      }, { threshold: 0.5 }).observe(phone);
    }
  }
})();
