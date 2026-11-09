// Навигация, появление блоков, табы, часы, копирование, дождь в hero и айфон.
(() => {
  const cfg = window.FOLZY || {};
  const TZ = cfg.timezone || 'Europe/Moscow';
  const TZ_LABEL = cfg.timezoneLabel || '';
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
  const tabLinks = $$('.tabbar a');
  const pill = $('.nav__pill');
  const onScroll = () => nav.classList.toggle('is-scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const movePill = (link) => {
    links.forEach((a) => a.classList.toggle('is-active', a === link));
    tabLinks.forEach((a) => a.classList.toggle('is-active', Boolean(link) && a.getAttribute('href') === link.getAttribute('href')));
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
  const dateFmt = { format: (d) => `${fmt({ weekday: 'short' }).format(d)} ${fmt({ day: 'numeric' }).format(d)} ${fmt({ month: 'short' }).format(d)}` };
  const offset = () => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
    return name.replace('GMT', 'UTC');
  };
  const tick = () => {
    const now = new Date();
    $$('[data-clock="short"]').forEach((el) => { el.textContent = `${hm.format(now)} · ${TZ_LABEL || offset()}`; });
    $$('[data-clock="full"]').forEach((el) => { el.textContent = `${hms.format(now)}${TZ_LABEL ? ` ${TZ_LABEL}` : ''}`; });
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

  // ── Фон: обои + стеклянная линза за курсором (WebGL) ──
  // Обои затемнены, чтобы читался текст; линза — «капля» Liquid Glass: внутри обои ярче и чуть ближе,
  // у края — преломление с радужной кромкой и блик. Кадры идут, только пока линза движется.
  // Без WebGL или на тач-экране — просто картинка (фон canvas в CSS).
  const fx = $('#fx');
  const gl = fx && fx.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (gl) {
    const VS = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
    const FS = `
      precision mediump float;
      uniform vec2 uRes, uImg, uMouse, uHalf;
      uniform float uOn, uDim;
      uniform sampler2D uTex;
      vec2 coverUV(vec2 f) {
        vec2 uv = f / uRes;
        float rs = uRes.x / uRes.y, ri = uImg.x / uImg.y;
        vec2 k = rs > ri ? vec2(1.0, ri / rs) : vec2(rs / ri, 1.0);
        uv = (uv - 0.5) * k + 0.5;
        return vec2(uv.x, 1.0 - uv.y);
      }
      vec3 bg(vec2 f) { return texture2D(uTex, coverUV(f)).rgb; }
      void main() {
        vec2 f = gl_FragCoord.xy;
        vec3 base = bg(f) * uDim;
        vec2 q = (f - uMouse) / uHalf;
        float rb = pow(abs(q.x), 4.0) + pow(abs(q.y), 4.0);          // squircle, как у иконок iOS
        float inside = (1.0 - smoothstep(0.9, 1.0, rb)) * uOn;
        if (inside < 0.002) { gl_FragColor = vec4(base, 1.0); return; }
        float edge = smoothstep(0.3, 1.0, rb);
        vec2 d = f - uMouse;
        float k = 0.84 - 0.24 * edge;                                  // к краю стекло «стягивает» картинку
        float ca = 0.014 * edge;                                       // радужная кромка
        vec3 col = vec3(bg(uMouse + d * (k - ca)).r, bg(uMouse + d * k).g, bg(uMouse + d * (k + ca)).b);
        vec2 c = uMouse + d * k;
        vec3 soft = (bg(c + vec2(1.6, 0.0)) + bg(c - vec2(1.6, 0.0)) + bg(c + vec2(0.0, 1.6)) + bg(c - vec2(0.0, 1.6))) * 0.25;
        col = mix(col, soft, 0.45) * 0.95;
        float rim = smoothstep(0.6, 0.93, rb) * (1.0 - smoothstep(0.93, 1.0, rb));
        float light = clamp(0.5 + 0.5 * dot(normalize(q + 0.0001), normalize(vec2(-0.55, 0.85))), 0.0, 1.0);
        col += rim * (0.12 + 0.5 * light * light);
        col *= 1.0 - 0.18 * smoothstep(0.2, 1.0, -q.y) * edge;        // лёгкая тень снизу внутри капли
        gl_FragColor = vec4(mix(base, col, inside), 1.0);
      }`;
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VS);
    const fs = shader(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    if (vs && fs) {
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
    }
    if (vs && fs && gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const u = Object.fromEntries(['uRes', 'uImg', 'uMouse', 'uHalf', 'uOn', 'uDim', 'uTex'].map((n) => [n, gl.getUniformLocation(prog, n)]));
      const tex = gl.createTexture();
      const img = new Image();
      const pointer = !reduced && matchMedia('(pointer: fine)').matches;
      const m = { x: innerWidth * 0.62, y: innerHeight * 0.38, tx: 0, ty: 0, on: 0, ton: 0, s: 1, ts: 1 };
      m.tx = m.x; m.ty = m.y;
      let dpr = 1;
      let ready = false;
      let raf = 0;
      const HALF = 64;

      const draw = () => {
        if (!ready) return;
        gl.viewport(0, 0, fx.width, fx.height);
        gl.uniform2f(u.uRes, fx.width, fx.height);
        gl.uniform2f(u.uImg, img.naturalWidth, img.naturalHeight);
        gl.uniform2f(u.uMouse, m.x * dpr, (innerHeight - m.y) * dpr);
        gl.uniform2f(u.uHalf, HALF * m.s * dpr, HALF * m.s * dpr);
        gl.uniform1f(u.uOn, m.on);
        gl.uniform1f(u.uDim, 0.5);
        gl.uniform1i(u.uTex, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      const resize = () => {
        dpr = Math.min(devicePixelRatio || 1, 1.5);
        fx.width = Math.round(innerWidth * dpr);
        fx.height = Math.round(innerHeight * dpr);
        draw();
      };
      const frame = () => {
        raf = 0;
        m.x += (m.tx - m.x) * 0.2;
        m.y += (m.ty - m.y) * 0.2;
        m.on += (m.ton - m.on) * 0.14;
        m.s += (m.ts - m.s) * 0.18;
        draw();
        const moving = Math.abs(m.tx - m.x) + Math.abs(m.ty - m.y) > 0.3 || Math.abs(m.ton - m.on) > 0.005 || Math.abs(m.ts - m.s) > 0.003;
        if (moving) raf = requestAnimationFrame(frame);
      };
      const wake = () => { if (!raf) raf = requestAnimationFrame(frame); };

      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        ready = true;
        fx.classList.add('is-ready');
        resize();
      };
      img.src = '/assets/media/bg-home.webp';
      addEventListener('resize', resize);
      fx.addEventListener('webglcontextlost', () => fx.classList.remove('is-ready'));

      if (pointer) {
        addEventListener('pointermove', (e) => {
          if (e.pointerType !== 'mouse') return;
          if (m.on < 0.02) { m.x = e.clientX; m.y = e.clientY; }
          m.tx = e.clientX;
          m.ty = e.clientY;
          m.ton = 1;
          wake();
        }, { passive: true });
        document.documentElement.addEventListener('pointerleave', () => { m.ton = 0; wake(); });
        addEventListener('pointerdown', () => { m.ts = 1.3; wake(); }, { passive: true });
        addEventListener('pointerup', () => { m.ts = 1; wake(); }, { passive: true });
      }
    }
  }

  // ── Блик на стекле: светлая дуга по кромке идёт за курсором ──
  const GLASS = '.panel, .card, .strip, .spec, .tabs';
  let lit = null;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest(GLASS);
    if (lit && lit !== el) { lit.style.removeProperty('--lx'); lit.style.removeProperty('--ly'); }
    lit = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--lx', `${(e.clientX - r.left).toFixed(0)}px`);
    el.style.setProperty('--ly', `${(e.clientY - r.top).toFixed(0)}px`);
  }, { passive: true });

  // ── Рябь от нажатия на всём кликабельном ──
  const RIPPLE = '.btn, .card--link, .tab, .icon-btn, a.strip__item, .top__row, .now__last, .chip';
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(RIPPLE);
    if (!el || reduced) return;
    el.classList.add('has-ripple');
    const r = el.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    el.append(dot);
    dot.addEventListener('animationend', () => dot.remove());
  });

  // ── Погода в Петербурге для виджета на экране блокировки (open-meteo, без ключа) ──
  fetch('https://api.open-meteo.com/v1/forecast?latitude=59.94&longitude=30.31&current=temperature_2m'
    + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=Europe%2FMoscow')
    .then((r) => r.json())
    .then((d) => {
      const cur = Math.round(d.current.temperature_2m);
      const lo = Math.round(d.daily.temperature_2m_min[0]);
      const hi = Math.round(d.daily.temperature_2m_max[0]);
      $('#iphone-temp').textContent = cur;
      $('#iphone-tmin').textContent = lo;
      $('#iphone-tmax').textContent = hi;
      // точка на дуге 270°: от минимума (слева снизу) к максимуму (справа снизу)
      const k = hi > lo ? Math.min(1, Math.max(0, (cur - lo) / (hi - lo))) : 0.5;
      $('#iphone-temp-dot').setAttribute('transform', `rotate(${-135 + k * 270 - 90} 20 20)`);
    })
    .catch(() => { $('#iphone-temp').textContent = '—'; });

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
