'use strict';
// Cloud Play: приложение-клиент (телефон, планшет, ноутбук, ТВ).

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('cp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cp.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
const isTouch = matchMedia('(pointer: coarse)').matches;
const settings = Object.assign({
  bitrate: 20, maxHeight: 0, fps: 60, codec: 'h264',
  touch: 'touchpad', vpad: isTouch, lock: !isTouch, stats: false,
}, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);

const video = $('video');
const layer = $('touchLayer');
let ws = null;
let authed = false;
let pc = null;
let streaming = false;
let games = [];
let rtt = 0;

// ---------- Общие функции интерфейса ----------
function show(name) {
  for (const s of ['login', 'library', 'stream']) $(s).classList.toggle('hidden', s !== name);
}
let toastTimer = 0;
function toast(text, ms = 3000) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function loading(text) {
  if (text === false) { $('loading').classList.add('hidden'); return; }
  $('loading').classList.remove('hidden');
  $('loadingText').textContent = text;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Связь с компьютером ----------
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect(pin) {
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* закрыт */ } }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => send({ type: 'hello', role: 'client', pin, token: store.get('token', null) });
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { onVideoChunk(e.data); return; }
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m, pin).catch((err) => { console.error(err); toast('Ошибка: ' + err.message); });
  };
  ws.onclose = () => {
    if (authed) {
      if (streaming) loading('Связь с компьютером потеряна. Переподключаюсь…');
      else toast('Связь с компьютером потеряна. Переподключаюсь…');
      setTimeout(() => connect(pin), 1500);
    } else if (!$('login').classList.contains('hidden')) {
      $('loginBtn').disabled = false;
    } else {
      show('login');
      $('loginError').textContent = 'Не удалось подключиться к компьютеру. Сервер Cloud Play запущен?';
      setTimeout(() => connect(pin), 3000);
    }
  };
}

async function onMessage(m, pin) {
  switch (m.type) {
    case 'hello-ok':
      authed = true;
      // Устройство запомнено: дальше входим без кода.
      if (m.token) store.set('token', m.token);
      store.set('pin', null);
      pin = '';
      $('pcName').textContent = '🖥️ ' + m.name;
      $('loginError').textContent = '';
      if (streaming) send({ type: 'start', settings: streamSettings() });
      else { show('library'); send({ type: 'games' }); }
      break;
    case 'hello-fail':
      authed = false;
      store.set('pin', null);
      store.set('token', null);
      show('login');
      $('loginError').textContent = m.reason;
      $('loginBtn').disabled = false;
      break;
    case 'games':
      games = m.games || [];
      renderGames(m.steamFound);
      break;
    case 'offer':
      await onOffer(m.sdp);
      break;
    case 'ice':
      if (pc && m.candidate) { try { await pc.addIceCandidate(m.candidate); } catch (e) { console.warn(e); } }
      break;
    case 'host-status':
      if (streaming) loading(m.text);
      break;
    case 'host-error':
      if (streaming) loading(m.text);
      else toast(m.text, 6000);
      break;
    case 'host-lost':
      if (streaming) {
        loading('Окно трансляции на компьютере закрылось. Открываю заново…');
        setTimeout(() => { if (streaming) send({ type: 'start', settings: streamSettings() }); }, 1500);
      }
      break;
    case 'stopped':
      if (streaming) { toast(m.reason || 'Трансляция остановлена', 5000); leaveStream(false); }
      break;
    case 'pong':
      rtt = performance.now() - m.t;
      break;
    case 'wsv-config':
      if (streaming) setupDecoder(m);
      break;
    case 'wsv-error':
      if (streaming) loading(m.text);
      break;
  }
}
setInterval(() => { if (authed) send({ type: 'ping', t: performance.now() }); }, 2000);

// ---------- Вход ----------
function doLogin() {
  const pin = $('pinInput').value.replace(/\D/g, '');
  if (pin.length !== 6) { $('loginError').textContent = 'PIN-код — это 6 цифр с экрана компьютера.'; return; }
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  connect(pin);
}
$('loginBtn').onclick = doLogin;
$('pinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('pinInput').addEventListener('input', () => {
  const d = $('pinInput').value.replace(/\D/g, '').slice(0, 6);
  $('pinInput').value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
  if (d.length === 6) doLogin();
});

// ---------- Библиотека ----------
function renderGames(steamFound) {
  const q = $('search').value.trim().toLowerCase();
  const list = games.filter((g) => !q || g.name.toLowerCase().includes(q));
  const grid = $('games');
  grid.innerHTML = '';
  $('libTitle').textContent = games.length ? `Мои игры (${games.length})` : 'Мои игры';
  for (const g of list) {
    const b = document.createElement('button');
    b.className = 'game';
    b.title = g.name;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = `cover/${g.appid}`;
    let tries = 0;
    img.onerror = () => {
      tries++;
      if (tries === 1) img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`;
      else { img.remove(); b.classList.add('noimg'); }
    };
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = g.name;
    b.append(img, name);
    b.onclick = () => startStream(g);
    grid.appendChild(b);
  }
  const empty = $('libEmpty');
  if (steamFound === false) {
    empty.textContent = 'Steam не найден на компьютере. Можно играть через «Рабочий стол».';
    empty.classList.remove('hidden');
  } else if (!games.length && steamFound !== undefined) {
    empty.textContent = 'В Steam пока нет установленных игр. Установи игру на компьютере, и она появится здесь.';
    empty.classList.remove('hidden');
  } else if (!list.length && q) {
    empty.textContent = 'Ничего не найдено.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
}
$('search').addEventListener('input', () => renderGames());
$('desktopBtn').onclick = () => startStream(null);
$('bigPictureBtn').onclick = () => { send({ type: 'bigpicture' }); startStream(null); };

// ---------- Настройки ----------
const settingFields = [
  ['setBitrate', 'bitrate', Number], ['setHeight', 'maxHeight', Number], ['setFps', 'fps', Number],
  ['setCodec', 'codec', String], ['setTouch', 'touch', String],
];
const settingChecks = [['setVpad', 'vpad'], ['setLock', 'lock'], ['setStats', 'stats']];
function fillSettings() {
  for (const [id, key] of settingFields) $(id).value = String(settings[key]);
  for (const [id, key] of settingChecks) $(id).checked = !!settings[key];
}
for (const [id, key, conv] of settingFields) {
  $(id).addEventListener('change', () => {
    settings[key] = conv($(id).value);
    saveSettings();
    if (streaming && ['bitrate', 'maxHeight', 'fps'].includes(key)) send({ type: 'settings', settings: streamSettings() });
  });
}
for (const [id, key] of settingChecks) {
  $(id).addEventListener('change', () => { settings[key] = $(id).checked; saveSettings(); applyStreamUI(); });
}
$('settingsBtn').onclick = () => { fillSettings(); $('settings').classList.remove('hidden'); };
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').classList.add('hidden'); });
$('logoutBtn').onclick = () => {
  store.set('pin', null);
  store.set('token', null);
  authed = false;
  if (ws) { ws.onclose = null; ws.close(); }
  $('settings').classList.add('hidden');
  $('pinInput').value = '';
  $('loginBtn').disabled = false;
  show('login');
};

function streamSettings() {
  return { bitrate: settings.bitrate, fps: settings.fps, maxHeight: settings.maxHeight, codec: settings.codec };
}

// ---------- Трансляция ----------
function enterFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement || document.webkitFullscreenElement) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.then) {
      p.then(() => {
        if (isTouch && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
        if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
      }).catch(() => {});
    }
  } catch { /* не поддерживается */ }
}

function startStream(game) {
  enterFullscreen();
  video.muted = false;
  video.play().catch(() => {}); // «разблокирует» звук на iPhone, пока есть нажатие
  if (game) {
    send({ type: 'launch', appid: game.appid, name: game.name });
    toast('Запускаю ' + game.name + '…');
  }
  streaming = true;
  stopWsv();
  show('stream');
  $('menu').classList.add('hidden');
  loading(game ? `Запускаю «${game.name}»…` : 'Подключаюсь к компьютеру…');
  applyStreamUI();
  send({ type: 'start', settings: streamSettings() });
}

function closePc() {
  if (pc) { try { pc.close(); } catch { /* закрыт */ } }
  pc = null;
}

function leaveStream(sendStop = true) {
  if (sendStop) send({ type: 'stop' });
  releaseAllLocal();
  closePc();
  stopWsv();
  streaming = false;
  video.srcObject = null;
  $('soundBtn').classList.add('hidden');
  $('menu').classList.add('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  show('library');
  send({ type: 'games' });
}

function stereoOpus(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, params) =>
    /stereo=1/.test(params) ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1`);
}

function playVideo() {
  video.play().catch(() => {
    video.muted = true;
    video.play().catch(() => {});
    $('soundBtn').classList.remove('hidden');
  });
}
$('soundBtn').onclick = () => { video.muted = false; video.play().catch(() => {}); $('soundBtn').classList.add('hidden'); };
video.addEventListener('playing', () => { if (pc && pc.connectionState === 'connected') loading(false); });

// ---------- Запасной режим ----------
// Если прямое видео (WebRTC) не дошло за несколько секунд, просим компьютер слать
// сжатые кадры через то же соединение, что и управление, и рисуем их сами.
const wsvCanvas = $('wsvCanvas');
const wsvCtx = wsvCanvas.getContext('2d');
let wsvMode = false;
let wsvTimer = 0;
let decoder = null;
let decoderCfg = null;
let gotKey = false;
const wsvStats = { frames: 0, bytes: 0 };

function videoArrived() {
  return video.videoWidth > 0 && video.readyState >= 2 && !video.paused;
}
function armFallback(ms) {
  clearTimeout(wsvTimer);
  wsvTimer = setTimeout(() => {
    if (streaming && !wsvMode && !videoArrived()) startWsv();
  }, ms);
}
function startWsv() {
  if (!('VideoDecoder' in window)) {
    loading('Видео не проходит напрямую, а этот браузер не умеет запасной режим. Обнови iOS / браузер или попробуй Chrome.');
    return;
  }
  clearTimeout(wsvTimer);
  closePc();
  wsvMode = true;
  loading('Включаю запасной режим видео…');
  send({ type: 'fallback', settings: streamSettings() });
}
function stopWsv() {
  clearTimeout(wsvTimer);
  wsvMode = false;
  gotKey = false;
  if (decoder) { try { decoder.close(); } catch { /* уже */ } }
  decoder = null;
  wsvCanvas.classList.add('hidden');
  video.classList.remove('hidden');
}
function makeDecoder() {
  decoder = new VideoDecoder({
    output: (frame) => {
      if (wsvCanvas.width !== frame.displayWidth || wsvCanvas.height !== frame.displayHeight) {
        wsvCanvas.width = frame.displayWidth; wsvCanvas.height = frame.displayHeight;
      }
      wsvCtx.drawImage(frame, 0, 0);
      frame.close();
      wsvStats.frames++;
      if (!$('loading').classList.contains('hidden')) loading(false);
    },
    error: (e) => {
      console.warn('decoder', e);
      gotKey = false;
      send({ type: 'keyframe' });
      setTimeout(() => { if (wsvMode && decoderCfg) makeDecoder(); }, 50);
    },
  });
  decoder.configure(decoderCfg);
}
function setupDecoder(m) {
  wsvMode = true;
  gotKey = false;
  decoderCfg = { codec: m.codec, optimizeForLatency: true };
  if (decoder) { try { decoder.close(); } catch { /* уже */ } }
  makeDecoder();
  wsvCanvas.width = m.width; wsvCanvas.height = m.height;
  wsvCanvas.classList.remove('hidden');
  video.classList.add('hidden');
  loading('Запасной режим: жду картинку… (без звука)');
  toast('Видео идёт в запасном режиме, без звука', 4000);
}
function onVideoChunk(buf) {
  if (!wsvMode || !decoder || decoder.state !== 'configured') return;
  const u = new Uint8Array(buf);
  const key = u[0] === 1;
  if (!gotKey && !key) return;
  if (decoder.decodeQueueSize > 6) {
    // Телефон не успевает: ждём следующий ключевой кадр.
    gotKey = false;
    send({ type: 'keyframe' });
    return;
  }
  gotKey = true;
  wsvStats.bytes += u.length;
  const ts = new DataView(buf).getFloat64(1);
  try {
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: u.subarray(9) }));
  } catch (e) { console.warn(e); gotKey = false; }
}

async function onOffer(sdp) {
  if (!streaming) return;
  closePc();
  pc = new RTCPeerConnection({ iceServers: [] });
  const myPc = pc;
  pc.ontrack = (e) => {
    const s = e.streams[0] || new MediaStream([e.track]);
    if (video.srcObject !== s) video.srcObject = s;
    try { e.receiver.jitterBufferTarget = 0; } catch { /* старый браузер */ }
    try { e.receiver.playoutDelayHint = 0; } catch { /* старый браузер */ }
    playVideo();
  };
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (pc !== myPc) return;
    const st = pc.connectionState;
    if (st === 'connected') { loading(false); playVideo(); }
    else if (st === 'failed') startWsv();
    else if (st === 'disconnected') loading('Соединение прервалось. Жду…');
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  answer.sdp = stereoOpus(answer.sdp);
  await pc.setLocalDescription(answer);
  send({ type: 'answer', sdp: pc.localDescription.sdp });
  loading('Соединяюсь…');
  armFallback(settings.forceFallback ? 0 : 6000);
}

function applyStreamUI() {
  $('vpad').classList.toggle('hidden', !settings.vpad);
  $('stats').classList.toggle('hidden', !settings.stats);
  $('touchModeName').textContent = settings.touch === 'direct' ? 'прямое' : 'тачпад';
}

// ---------- Отправка управления ----------
const pressedKeys = new Set();
const pressedButtons = new Set();
let fracX = 0;
let fracY = 0;

function sendInput(o) {
  if (!streaming || !ws || ws.readyState !== 1) return;
  o.type = 'i';
  ws.send(JSON.stringify(o));
}
function keyDown(code) { pressedKeys.add(code); sendInput({ a: 'kd', c: code }); }
function keyUp(code) { pressedKeys.delete(code); sendInput({ a: 'ku', c: code }); }
function btnDown(b) { pressedButtons.add(b); sendInput({ a: 'bd', b }); }
function btnUp(b) { pressedButtons.delete(b); sendInput({ a: 'bu', b }); }
function click(b) { btnDown(b); setTimeout(() => btnUp(b), 30); }
function moveRel(dx, dy) {
  fracX += dx; fracY += dy;
  const ix = Math.trunc(fracX);
  const iy = Math.trunc(fracY);
  fracX -= ix; fracY -= iy;
  if (ix || iy) sendInput({ a: 'm', x: ix, y: iy });
}
function videoPoint(cx, cy) {
  const el = wsvMode ? wsvCanvas : video;
  const r = el.getBoundingClientRect();
  const vw = (wsvMode ? wsvCanvas.width : video.videoWidth) || 16;
  const vh = (wsvMode ? wsvCanvas.height : video.videoHeight) || 9;
  const k = Math.min(r.width / vw, r.height / vh);
  const w = vw * k;
  const h = vh * k;
  return { x: clamp((cx - r.left - (r.width - w) / 2) / w, 0, 1), y: clamp((cy - r.top - (r.height - h) / 2) / h, 0, 1) };
}
function moveAbs(cx, cy) {
  const p = videoPoint(cx, cy);
  sendInput({ a: 'p', x: +p.x.toFixed(5), y: +p.y.toFixed(5) });
}
function releaseAllLocal() {
  sendInput({ a: 'release' });
  pressedKeys.clear();
  pressedButtons.clear();
  gpPrev = {};
}

// Очередь для набора текста, чтобы нажатия не перепутались.
const typeQueue = [];
let typing = false;
function queueKeys(steps) {
  typeQueue.push(...steps);
  if (!typing) runQueue();
}
function runQueue() {
  const s = typeQueue.shift();
  if (!s) { typing = false; return; }
  typing = true;
  if (s[0] === 'd') keyDown(s[1]); else keyUp(s[1]);
  setTimeout(runQueue, 12);
}
function tapKey(code, shift) {
  const steps = [];
  if (shift) steps.push(['d', 'ShiftLeft']);
  steps.push(['d', code], ['u', code]);
  if (shift) steps.push(['u', 'ShiftLeft']);
  queueKeys(steps);
}
function combo(codes) {
  queueKeys([...codes.map((c) => ['d', c]), ...codes.slice().reverse().map((c) => ['u', c])]);
}

// Символ -> [код клавиши, нужен Shift]
const CHAR_MAP = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(97 + i);
    m[c] = ['Key' + c.toUpperCase(), false];
    m[c.toUpperCase()] = ['Key' + c.toUpperCase(), true];
  }
  for (let i = 0; i < 10; i++) m[String(i)] = ['Digit' + i, false];
  const plain = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
    ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote', '\n': 'Enter', '\t': 'Tab' };
  for (const [ch, code] of Object.entries(plain)) m[ch] = [code, false];
  const shifted = { '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7',
    '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
    '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash', '~': 'Backquote' };
  for (const [ch, code] of Object.entries(shifted)) m[ch] = [code, true];
  // Русская раскладка ЙЦУКЕН по положению клавиш (на ПК должна быть включена русская раскладка).
  const ru = 'йцукенгшщзхъфывапролджэячсмитьбюё';
  const pos = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight',
    'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote',
    'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Backquote'];
  [...ru].forEach((ch, i) => { m[ch] = [pos[i], false]; m[ch.toUpperCase()] = [pos[i], true]; });
  // Украинские буквы на своих местах.
  Object.assign(m, { і: ['KeyS', false], І: ['KeyS', true], ї: ['BracketRight', false], Ї: ['BracketRight', true],
    є: ['Quote', false], Є: ['Quote', true], ґ: ['Backslash', false], Ґ: ['Backslash', true] });
  return m;
})();
function typeChar(ch) {
  const k = CHAR_MAP[ch];
  if (k) tapKey(k[0], k[1]);
}

// ---------- Клавиатура ----------
const kbd = $('kbd');
const SENTINEL = '  ';
window.addEventListener('keydown', (e) => {
  if (!streaming || e.target === kbd || !e.code) return;
  if (!$('menu').classList.contains('hidden')) return;
  e.preventDefault();
  keyDown(e.code);
});
window.addEventListener('keyup', (e) => {
  if (!streaming || e.target === kbd || !e.code) return;
  e.preventDefault();
  if (pressedKeys.has(e.code)) keyUp(e.code);
});
window.addEventListener('blur', () => { if (streaming) releaseAllLocal(); });
document.addEventListener('visibilitychange', () => { if (streaming && document.hidden) releaseAllLocal(); });

function openKeyboard() {
  kbd.value = SENTINEL;
  kbd.focus();
  try { kbd.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* нет */ }
}
kbd.addEventListener('input', () => {
  const v = kbd.value;
  if (v.length < SENTINEL.length) {
    for (let i = 0; i < SENTINEL.length - v.length; i++) tapKey('Backspace');
  } else {
    for (const ch of v.slice(SENTINEL.length)) typeChar(ch);
  }
  kbd.value = SENTINEL;
  try { kbd.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch { /* нет */ }
});
kbd.addEventListener('keydown', (e) => {
  const special = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  if (special[e.key]) { e.preventDefault(); tapKey(special[e.key]); }
});

// ---------- Мышь и касания ----------
const MOUSE_BTN = { 0: 0, 1: 2, 2: 1, 3: 3, 4: 4 }; // кнопка браузера -> кнопка Windows
const touches = new Map();
let gesture = null;
let wheelAcc = 0;

layer.addEventListener('contextmenu', (e) => e.preventDefault());
video.addEventListener('contextmenu', (e) => e.preventDefault());

layer.addEventListener('pointerdown', (e) => {
  if (!streaming) return;
  $('menu').classList.add('hidden');
  if (e.pointerType === 'touch') touchDown(e);
});
layer.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') touchUp(e); });
layer.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') touchUp(e, true); });
layer.addEventListener('pointermove', (e) => {
  if (!streaming) return;
  if (e.pointerType === 'touch') return touchMove(e);
  if (document.pointerLockElement === layer) moveRel(e.movementX, e.movementY);
  else moveAbs(e.clientX, e.clientY);
});
// Кнопки мыши ловим через mousedown/mouseup: pointer-события не сообщают о второй кнопке, нажатой вместе с первой.
layer.addEventListener('mousedown', (e) => {
  if (!streaming || (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents)) return;
  e.preventDefault();
  if (settings.lock && document.pointerLockElement !== layer && layer.requestPointerLock) {
    try {
      const p = layer.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { layer.requestPointerLock(); } catch { /* нет */ } });
    } catch { try { layer.requestPointerLock(); } catch { /* нет */ } }
    return;
  }
  if (document.pointerLockElement !== layer) moveAbs(e.clientX, e.clientY);
  const b = MOUSE_BTN[e.button];
  if (b !== undefined) btnDown(b);
});
window.addEventListener('mouseup', (e) => {
  if (!streaming) return;
  const b = MOUSE_BTN[e.button];
  if (b !== undefined && pressedButtons.has(b)) btnUp(b);
});
document.addEventListener('pointerlockchange', () => {
  if (streaming && !document.pointerLockElement) {
    for (const b of [...pressedButtons]) btnUp(b);
  }
});
layer.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 120 : 1.2;
  if (e.deltaY) sendInput({ a: 'w', d: Math.round(-e.deltaY * k) });
  if (e.deltaX) sendInput({ a: 'hw', d: Math.round(e.deltaX * k) });
}, { passive: false });

function touchDown(e) {
  e.preventDefault();
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = performance.now();
  if (touches.size === 1) {
    gesture = { n: 1, start: now, moved: false, dragging: false, sx: e.clientX, sy: e.clientY };
    if (settings.touch === 'direct') {
      moveAbs(e.clientX, e.clientY);
      btnDown(0);
    } else {
      gesture.timer = setTimeout(() => {
        if (gesture && gesture.n === 1 && !gesture.moved) {
          gesture.dragging = true;
          btnDown(0);
          if (navigator.vibrate) navigator.vibrate(20);
        }
      }, 450);
    }
  } else if (touches.size === 2 && gesture) {
    clearTimeout(gesture.timer);
    if (settings.touch === 'direct' && pressedButtons.has(0)) btnUp(0);
    gesture.n = 2;
    gesture.start2 = now;
    gesture.moved2 = false;
    wheelAcc = 0;
  }
}

function touchMove(e) {
  const t = touches.get(e.pointerId);
  if (!t || !gesture) return;
  e.preventDefault();
  const dx = e.clientX - t.x;
  const dy = e.clientY - t.y;
  t.x = e.clientX; t.y = e.clientY;
  if (gesture.n === 1) {
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 8) {
      if (!gesture.moved) clearTimeout(gesture.timer);
      gesture.moved = true;
    }
    if (settings.touch === 'direct') moveAbs(e.clientX, e.clientY);
    else {
      const speed = Math.hypot(dx, dy);
      const k = 1.3 + Math.min(speed / 10, 2.2);
      moveRel(dx * k, dy * k);
    }
  } else if (touches.size >= 2) {
    if (Math.abs(dy) > 1 || Math.abs(dx) > 1) gesture.moved2 = true;
    wheelAcc += dy / touches.size;
    if (Math.abs(wheelAcc) >= 10) {
      sendInput({ a: 'w', d: Math.round(wheelAcc * 6) });
      wheelAcc = 0;
    }
  }
}

function touchUp(e, cancelled) {
  if (!touches.has(e.pointerId)) return;
  touches.delete(e.pointerId);
  if (!gesture || touches.size) return;
  clearTimeout(gesture.timer);
  const now = performance.now();
  if (gesture.n === 1) {
    if (settings.touch === 'direct') { if (pressedButtons.has(0)) btnUp(0); }
    else if (gesture.dragging) btnUp(0);
    else if (!cancelled && !gesture.moved && now - gesture.start < 300) click(0);
  } else if (gesture.n === 2 && !cancelled && !gesture.moved2 && now - gesture.start2 < 350) {
    click(1);
  }
  gesture = null;
}

// ---------- Геймпад ----------
// Кнопки стандартного геймпада -> клавиши/мышь на компьютере.
const GP_KEYS = { 0: 'Space', 1: 'KeyC', 2: 'KeyR', 3: 'KeyE', 4: 'KeyQ', 5: 'KeyF', 8: 'Tab', 9: 'Escape',
  10: 'ShiftLeft', 11: 'KeyV', 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', 16: 'Enter' };
const GP_MOUSE = { 6: 1, 7: 0 }; // LT - правая кнопка мыши, RT - левая
const vstate = { buttons: new Array(17).fill(false), axes: [0, 0, 0, 0] };
let gpPrev = {};
let gpNavPrev = {};

function curve(v) {
  const dz = 0.12;
  const a = Math.abs(v);
  if (a < dz) return 0;
  const t = (a - dz) / (1 - dz);
  return Math.sign(v) * t * t;
}

function readPads() {
  const b = vstate.buttons.slice();
  const ax = vstate.axes.slice();
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    gp.buttons.forEach((x, i) => { if (i < 17 && (x.pressed || x.value > 0.5)) b[i] = true; });
    gp.axes.forEach((v, i) => { if (i < 4 && Math.abs(v) > Math.abs(ax[i])) ax[i] = v; });
  }
  return { b, ax };
}

function gpLoop() {
  requestAnimationFrame(gpLoop);
  const { b, ax } = readPads();
  if (!streaming) { libraryNav(b, ax); return; }
  const out = {};
  for (const [i, code] of Object.entries(GP_KEYS)) if (b[i]) out['k' + code] = 1;
  for (const [i, mb] of Object.entries(GP_MOUSE)) if (b[i]) out['b' + mb] = 1;
  const DZ = 0.4;
  if (ax[1] < -DZ) out.kKeyW = 1;
  if (ax[1] > DZ) out.kKeyS = 1;
  if (ax[0] < -DZ) out.kKeyA = 1;
  if (ax[0] > DZ) out.kKeyD = 1;
  for (const k in out) if (!gpPrev[k]) gpSet(k, true);
  for (const k in gpPrev) if (!out[k]) gpSet(k, false);
  gpPrev = out;
  const rx = curve(ax[2]);
  const ry = curve(ax[3]);
  if (rx || ry) moveRel(rx * 22, ry * 22);
}
function gpSet(k, down) {
  const v = k.slice(1);
  if (k[0] === 'k') { if (down) keyDown(v); else keyUp(v); }
  else { if (down) btnDown(Number(v)); else btnUp(Number(v)); }
}
requestAnimationFrame(gpLoop);

// Управление библиотекой с геймпада.
function libraryNav(b, ax) {
  if ($('library').classList.contains('hidden') || !$('settings').classList.contains('hidden')) { gpNavPrev = {}; return; }
  const now = {
    up: b[12] || ax[1] < -0.6, down: b[13] || ax[1] > 0.6, left: b[14] || ax[0] < -0.6, right: b[15] || ax[0] > 0.6,
    a: b[0], y: b[3],
  };
  const pressed = (k) => now[k] && !gpNavPrev[k];
  const items = [...document.querySelectorAll('#library .tile-btn, #games .game')];
  if (items.length) {
    let i = items.indexOf(document.activeElement);
    const move = (dir) => {
      if (i < 0) { items[0].focus(); return; }
      const r = items[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let best = -1;
      let bestD = Infinity;
      items.forEach((el, j) => {
        if (j === i) return;
        const q = el.getBoundingClientRect();
        const x = q.left + q.width / 2 - cx;
        const y = q.top + q.height / 2 - cy;
        const ok = dir === 'left' ? x < -5 && Math.abs(y) < q.height / 2
          : dir === 'right' ? x > 5 && Math.abs(y) < q.height / 2
            : dir === 'up' ? y < -5 : y > 5;
        if (!ok) return;
        const d = Math.abs(x) + Math.abs(y) * (dir === 'up' || dir === 'down' ? 1 : 3);
        if (d < bestD) { bestD = d; best = j; }
      });
      if (best >= 0) { items[best].focus(); items[best].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    };
    for (const d of ['up', 'down', 'left', 'right']) if (pressed(d)) move(d);
    if (pressed('a') && i >= 0) items[i].click();
  }
  if (pressed('y')) $('search').focus();
  gpNavPrev = now;
}
window.addEventListener('gamepadconnected', (e) => {
  toast('Геймпад подключён: ' + (e.gamepad.id || '').split('(')[0].trim());
  if (streaming && settings.vpad) { settings.vpad = false; saveSettings(); applyStreamUI(); }
});

// Геймпад на экране.
for (const stick of document.querySelectorAll('.stick')) {
  const axis = Number(stick.dataset.axis);
  const knob = stick.querySelector('.knob');
  let id = null;
  const update = (e) => {
    const r = stick.getBoundingClientRect();
    const rad = r.width / 2;
    let x = (e.clientX - r.left - rad) / rad;
    let y = (e.clientY - r.top - rad) / rad;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    vstate.axes[axis] = x;
    vstate.axes[axis + 1] = y;
    knob.style.transform = `translate(${x * rad * 0.6}px, ${y * rad * 0.6}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { e.preventDefault(); id = e.pointerId; stick.setPointerCapture(id); update(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === id) update(e); });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    vstate.axes[axis] = 0; vstate.axes[axis + 1] = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
}
for (const btn of document.querySelectorAll('#vpad .pbtn')) {
  const i = Number(btn.dataset.b);
  const set = (on) => { vstate.buttons[i] = on; btn.classList.toggle('on', on); };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    set(true);
    if (navigator.vibrate) navigator.vibrate(10);
  });
  btn.addEventListener('pointerup', () => set(false));
  btn.addEventListener('pointercancel', () => set(false));
}

// ---------- Меню во время игры ----------
$('menuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (document.pointerLockElement) document.exitPointerLock();
  $('menu').classList.toggle('hidden');
});
$('menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  const close = () => $('menu').classList.add('hidden');
  switch (act) {
    case 'keyboard': close(); openKeyboard(); break;
    case 'vpad': settings.vpad = !settings.vpad; saveSettings(); applyStreamUI(); close(); break;
    case 'touch':
      settings.touch = settings.touch === 'direct' ? 'touchpad' : 'direct';
      saveSettings(); applyStreamUI();
      toast(settings.touch === 'direct' ? 'Касание = нажатие в этой точке' : 'Касание работает как тачпад');
      break;
    case 'esc': close(); tapKey('Escape'); break;
    case 'alttab': close(); combo(['AltLeft', 'Tab']); break;
    case 'win': close(); tapKey('MetaLeft'); break;
    case 'fullscreen': close(); enterFullscreen(); break;
    case 'fallback': close(); if (!wsvMode) startWsv(); break;
    case 'stats': settings.stats = !settings.stats; saveSettings(); applyStreamUI(); close(); break;
    case 'altf4':
      if (confirm('Закрыть игру на компьютере (Alt+F4)?')) { close(); combo(['AltLeft', 'F4']); }
      break;
    case 'exit': close(); leaveStream(true); break;
  }
});

// ---------- Статистика ----------
let lastBytes = 0;
let lastTs = 0;
setInterval(async () => {
  if (streaming && settings.stats && wsvMode) {
    $('stats').textContent = [
      `${wsvCanvas.width}×${wsvCanvas.height}  ${wsvStats.frames} FPS  (запасной режим)`,
      `${(wsvStats.bytes * 8 / 1e6).toFixed(1)} Мбит/с  ${decoderCfg ? decoderCfg.codec : ''}`,
      `сеть ${rtt.toFixed(0)} мс`,
    ].join('\n');
  }
  wsvStats.frames = 0; wsvStats.bytes = 0;
  if (!streaming || !settings.stats || !pc) return;
  let stats;
  try { stats = await pc.getStats(); } catch { return; }
  let inb = null;
  let pair = null;
  const codecs = {};
  stats.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
    if (r.type === 'codec') codecs[r.id] = r.mimeType;
  });
  if (!inb) return;
  const mbps = lastTs ? ((inb.bytesReceived - lastBytes) * 8) / ((inb.timestamp - lastTs) * 1000) : 0;
  lastBytes = inb.bytesReceived; lastTs = inb.timestamp;
  const jb = inb.jitterBufferEmittedCount ? (inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000 : 0;
  const dec = inb.framesDecoded ? (inb.totalDecodeTime / inb.framesDecoded) * 1000 : 0;
  const net = pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : rtt;
  $('stats').textContent = [
    `${inb.frameWidth || '?'}×${inb.frameHeight || '?'}  ${Math.round(inb.framesPerSecond || 0)} FPS`,
    `${mbps.toFixed(1)} Мбит/с  ${(codecs[inb.codecId] || '').replace('video/', '')}`,
    `сеть ${net.toFixed(0)} мс  буфер ${jb.toFixed(0)} мс  декод ${dec.toFixed(1)} мс`,
    `потеряно пакетов: ${inb.packetsLost || 0}`,
  ].join('\n');
}, 1000);

// ---------- Старт ----------
fillSettings();
const savedPin = store.get('pin', null);
if (store.get('token', null) || savedPin) { show('library'); connect(savedPin || ''); }
else show('login');
