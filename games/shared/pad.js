'use strict';
// Общее управление для встроенных игр Cloud Play:
// стики и кнопки на экране (телефон), геймпад и клавиатура.
//
// Pad.init({
//   left: true, right: false,                 // какие стики нужны
//   buttons: [{ id: 'fire', label: '🔥', keys: ['Space'], gp: [0, 7] }],
//   keys: { lx: [['KeyA','ArrowLeft'], ['KeyD','ArrowRight']], ly: [...], rx: [...], ry: [...] },
// });
// В каждом кадре: Pad.update(); затем Pad.axis('lx'), Pad.down('fire'), Pad.pressed('fire').

window.Pad = (function () {
  const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const keys = new Set();
  const tapped = new Set(); // нажатия, которые успели начаться и закончиться между кадрами
  const touchTapped = {};
  const touchBtn = {};
  const touchAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  let cfg = { buttons: [], keys: {} };
  let axes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  let now = {};
  let prev = {};
  let lastSource = isTouch ? 'touch' : 'keyboard';

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') return;
    keys.add(e.code);
    tapped.add(e.code);
    lastSource = 'keyboard';
    if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  function css() {
    const s = document.createElement('style');
    s.textContent = `
      .pad-zone { position: fixed; bottom: 0; top: 30%; z-index: 20; touch-action: none; }
      .pad-zone.l { left: 0; width: 50%; } .pad-zone.r { right: 0; width: 50%; }
      .pad-base { position: fixed; width: 120px; height: 120px; margin: -60px 0 0 -60px; border-radius: 50%;
        border: 2px solid #ffffff40; background: #ffffff10; z-index: 21; pointer-events: none; display: none; }
      .pad-knob { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px; margin: -27px 0 0 -27px;
        border-radius: 50%; background: #ffffff55; border: 2px solid #ffffffaa; }
      .pad-hint { position: fixed; bottom: 22px; width: 120px; height: 120px; border-radius: 50%;
        border: 2px dashed #ffffff25; z-index: 19; pointer-events: none; display: grid; place-items: center;
        color: #ffffff40; font: 600 12px system-ui; }
      .pad-btns { position: fixed; right: 18px; bottom: 18px; z-index: 22; display: flex; flex-direction: column-reverse;
        gap: 12px; align-items: flex-end; }
      .pad-btns.with-right { bottom: 170px; }
      .pad-row { display: flex; gap: 12px; }
      .pad-btn { width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; touch-action: none;
        background: #ffffff18; border: 2px solid #ffffff50; color: #fff; font: 800 22px system-ui; user-select: none;
        -webkit-user-select: none; }
      .pad-btn.small { width: 56px; height: 56px; font-size: 18px; }
      .pad-btn.on { background: #6ee7ff88; border-color: #6ee7ff; }
    `;
    document.head.appendChild(s);
  }

  function makeStick(side) {
    const zone = document.createElement('div');
    zone.className = 'pad-zone ' + (side === 'left' ? 'l' : 'r');
    const base = document.createElement('div');
    base.className = 'pad-base';
    base.innerHTML = '<div class="pad-knob"></div>';
    const knob = base.firstChild;
    const hint = document.createElement('div');
    hint.className = 'pad-hint';
    hint.style[side === 'left' ? 'left' : 'right'] = '22px';
    hint.textContent = side === 'left' ? 'двигай' : 'целься';
    document.body.append(zone, base, hint);
    const ax = side === 'left' ? ['lx', 'ly'] : ['rx', 'ry'];
    let id = null;
    let ox = 0;
    let oy = 0;
    const R = 55;
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault();
      id = e.pointerId;
      zone.setPointerCapture(id);
      ox = e.clientX; oy = e.clientY;
      base.style.left = ox + 'px'; base.style.top = oy + 'px';
      base.style.display = 'block';
      hint.style.display = 'none';
      knob.style.transform = '';
      lastSource = 'touch';
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let x = (e.clientX - ox) / R;
      let y = (e.clientY - oy) / R;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      touchAxes[ax[0]] = x; touchAxes[ax[1]] = y;
      knob.style.transform = `translate(${x * R}px, ${y * R}px)`;
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      touchAxes[ax[0]] = 0; touchAxes[ax[1]] = 0;
      base.style.display = 'none';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  function makeButtons() {
    const list = cfg.buttons.filter((b) => b.touch !== false);
    if (!list.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'pad-btns' + (cfg.right ? ' with-right' : '');
    let row = null;
    list.forEach((b, i) => {
      if (i % 2 === 0) { row = document.createElement('div'); row.className = 'pad-row'; wrap.appendChild(row); }
      const el = document.createElement('div');
      el.className = 'pad-btn' + (b.small ? ' small' : '');
      el.textContent = b.label || b.id;
      const set = (on) => { touchBtn[b.id] = on; if (on) touchTapped[b.id] = true; el.classList.toggle('on', on); };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        set(true);
        lastSource = 'touch';
        if (navigator.vibrate) navigator.vibrate(8);
      });
      el.addEventListener('pointerup', () => set(false));
      el.addEventListener('pointercancel', () => set(false));
      row.appendChild(el);
    });
    document.body.appendChild(wrap);
  }

  function init(c) {
    cfg = Object.assign({ left: false, right: false, buttons: [], keys: {} }, c);
    if (isTouch) {
      css();
      if (cfg.left) makeStick('left');
      if (cfg.right) makeStick('right');
      makeButtons();
    }
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function dz(v) {
    return Math.abs(v) < 0.18 ? 0 : v;
  }

  function update() {
    prev = now;
    now = {};
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const gp = { lx: 0, ly: 0, rx: 0, ry: 0 };
    const gpBtn = new Set();
    for (const p of pads) {
      ['lx', 'ly', 'rx', 'ry'].forEach((k, i) => { const v = dz(p.axes[i] || 0); if (Math.abs(v) > Math.abs(gp[k])) gp[k] = v; });
      p.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) gpBtn.add(i); });
      // Крестовина работает как левый стик.
      if (gpBtn.has(14)) gp.lx = -1;
      if (gpBtn.has(15)) gp.lx = 1;
      if (gpBtn.has(12)) gp.ly = -1;
      if (gpBtn.has(13)) gp.ly = 1;
    }
    if (gpBtn.size || gp.lx || gp.ly || gp.rx || gp.ry) lastSource = 'gamepad';

    axes = {};
    for (const k of ['lx', 'ly', 'rx', 'ry']) {
      let v = touchAxes[k] || gp[k];
      const km = cfg.keys[k];
      if (km) {
        if (km[0].some((c) => keys.has(c))) v = -1;
        if (km[1].some((c) => keys.has(c))) v = 1;
      }
      axes[k] = v;
    }
    // Диагональ с клавиатуры не должна быть быстрее.
    for (const [x, y] of [['lx', 'ly'], ['rx', 'ry']]) {
      const len = Math.hypot(axes[x], axes[y]);
      if (len > 1) { axes[x] /= len; axes[y] /= len; }
    }
    for (const b of cfg.buttons) {
      now[b.id] = !!touchBtn[b.id] || !!touchTapped[b.id] || (b.keys || []).some((c) => keys.has(c) || tapped.has(c)) || (b.gp || []).some((i) => gpBtn.has(i));
    }
    tapped.clear();
    for (const k in touchTapped) delete touchTapped[k];
  }

  return {
    init,
    update,
    isTouch,
    axis: (k) => axes[k] || 0,
    down: (id) => !!now[id],
    pressed: (id) => !!now[id] && !prev[id],
    source: () => lastSource,
  };
})();

// Небольшие звуки без файлов.
window.Sfx = (function () {
  let ctx = null;
  let muted = false;
  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => ac(), { once: true }));
  function tone(freq, dur, type, vol, slide) {
    if (muted) return;
    const c = ac();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), c.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.08, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  }
  function noise(dur, vol) {
    if (muted) return;
    const c = ac();
    if (!c) return;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = vol || 0.15;
    s.buffer = buf;
    s.connect(g).connect(c.destination);
    s.start();
  }
  return {
    tone, noise,
    setMuted: (m) => { muted = m; },
  };
})();

// Рекорды в памяти устройства.
window.Best = {
  get(game) { try { return Number(localStorage.getItem('cp.best.' + game)) || 0; } catch { return 0; } },
  set(game, v) { try { if (v > this.get(game)) localStorage.setItem('cp.best.' + game, String(v)); } catch { /* приватный режим */ } },
};
