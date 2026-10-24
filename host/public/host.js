'use strict';
// Окно трансляции: захватывает экран и звук ПК и отправляет их клиенту по WebRTC.

const TEST = new URLSearchParams(location.search).has('test');
const $ = (id) => document.getElementById(id);

let ws = null;
let stream = null;
let pc = null;
let settings = {};
let waitingGesture = null;

function setStatus(text, state, detail) {
  $('status').textContent = text;
  $('dot').className = 'dot' + (state ? ' ' + state : '');
  $('detail').textContent = detail || '';
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    send({ type: 'hello', role: 'host' });
    setStatus('Готов. Жду подключения устройства', 'ok');
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handle(m).catch((err) => {
      console.error(err);
      send({ type: 'host-error', text: 'Ошибка на компьютере: ' + (err && err.message || err) });
    });
  };
  ws.onclose = () => {
    setStatus('Нет связи с сервером. Переподключаюсь…');
    closePeer();
    stopFallback();
    setTimeout(connect, 1500);
  };
}

async function handle(m) {
  switch (m.type) {
    case 'info':
      $('pin').textContent = m.pin.slice(0, 3) + ' ' + m.pin.slice(3);
      $('urls').innerHTML = '';
      for (const u of m.urls) {
        const li = document.createElement('li');
        const c = document.createElement('code');
        c.textContent = u;
        li.appendChild(c);
        $('urls').appendChild(li);
      }
      break;
    case 'start':
      settings = m.settings || {};
      await startSession();
      break;
    case 'answer':
      if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: fastStart(m.sdp) });
      break;
    case 'ice':
      if (pc && m.candidate) { try { await pc.addIceCandidate(m.candidate); } catch (e) { console.warn(e); } }
      break;
    case 'settings':
      settings = Object.assign(settings, m.settings || {});
      await applyEncoding();
      break;
    case 'stop':
      closePeer();
      stopFallback();
      setStatus('Готов. Жду подключения устройства', 'ok');
      break;
    case 'fallback':
      settings = Object.assign(settings, m.settings || {});
      closePeer();
      await startFallback();
      break;
    case 'keyframe':
      if (wsv) wsv.keyframe();
      break;
  }
}

// ---------- Захват экрана ----------
function testStream() {
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const g = c.getContext('2d');
  let x = 0;
  (function draw() {
    x = (x + 6) % c.width;
    g.fillStyle = '#10204a'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#6ee7ff'; g.fillRect(x, 300, 120, 120);
    g.fillStyle = '#fff'; g.font = 'bold 48px sans-serif';
    g.fillText('Cloud Play test ' + new Date().toLocaleTimeString(), 40, 80);
    requestAnimationFrame(draw);
  })();
  return c.captureStream(60);
}

async function captureScreen() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    monitorTypeSurfaces: 'include',
    preferCurrentTab: false,
  });
}

function streamAlive() {
  return stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

async function getStream() {
  if (streamAlive()) return stream;
  if (TEST) {
    stream = testStream();
  } else {
    try {
      stream = await captureScreen();
    } catch (e) {
      // Если браузер требует нажатия — показываем кнопку и ждём.
      if (e && (e.name === 'NotAllowedError' || e.name === 'InvalidStateError')) {
        send({ type: 'host-status', text: 'Подойди к компьютеру и нажми «Разрешить показ экрана» в окне Cloud Play.' });
        setStatus('Нужно разрешение', '', 'Нажми кнопку ниже и выбери «Весь экран».');
        stream = await new Promise((resolve, reject) => {
          const btn = $('startBtn');
          btn.classList.remove('hidden');
          waitingGesture = btn.onclick = async () => {
            btn.classList.add('hidden');
            try { resolve(await captureScreen()); } catch (err) { reject(err); }
          };
        });
      } else {
        throw e;
      }
    }
  }
  for (const t of stream.getVideoTracks()) {
    t.contentHint = 'motion';
    t.addEventListener('ended', () => {
      setStatus('Показ экрана остановлен', '', 'Он включится снова при следующем подключении.');
      stream = null;
    });
  }
  for (const t of stream.getAudioTracks()) t.contentHint = 'music';
  const v = $('preview');
  v.srcObject = stream;
  v.style.display = 'block';
  v.play().catch(() => {});
  return stream;
}

// ---------- WebRTC ----------
function closePeer() {
  if (pc) { try { pc.close(); } catch { /* уже закрыт */ } }
  pc = null;
}

function encodingFor(track) {
  const s = track.getSettings ? track.getSettings() : {};
  const height = s.height || 1080;
  const maxH = Number(settings.maxHeight) || 0;
  const scale = maxH && height > maxH ? height / maxH : 1;
  return {
    maxBitrate: Math.round((Number(settings.bitrate) || 20) * 1e6),
    maxFramerate: Number(settings.fps) || 60,
    scaleResolutionDownBy: scale,
  };
}

async function applyEncoding() {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    Object.assign(p.encodings[0], encodingFor(sender.track));
    p.degradationPreference = 'maintain-framerate';
    try { await sender.setParameters(p); } catch (e) {
      delete p.degradationPreference;
      try { await sender.setParameters(p); } catch (e2) { console.warn('setParameters', e2); }
    }
  }
}

function preferCodecs(transceiver, kind) {
  if (!RTCRtpSender.getCapabilities || !transceiver.setCodecPreferences) return;
  const caps = RTCRtpSender.getCapabilities(kind);
  if (!caps) return;
  const want = String(settings.codec || 'h264').toLowerCase();
  const rank = (c) => {
    const mt = c.mimeType.toLowerCase();
    if (mt.endsWith('/' + want)) return 0;
    if (mt.endsWith('/h264')) return 1;
    if (mt.endsWith('/vp8')) return 2;
    if (mt.endsWith('/vp9')) return 3;
    return 4;
  };
  const sorted = caps.codecs.slice().sort((a, b) => rank(a) - rank(b));
  try { transceiver.setCodecPreferences(sorted); } catch (e) { console.warn(e); }
}

function stereoOpus(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (line, pt, params) => {
    if (/stereo=1/.test(params)) return line;
    return `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`;
  });
}

// Сразу начинаем с хорошего качества, а не разгоняемся с 0,3 Мбит/с.
function fastStart(sdp) {
  const kbps = Math.round((Number(settings.bitrate) || 20) * 1000);
  const startK = Math.min(Math.round(kbps * 0.6), 15000);
  const minK = Math.min(1500, Math.round(kbps / 4));
  const video = sdp.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith('m=video')) return section;
    return section.replace(/^a=fmtp:(\d+) (.*)$/gm, (line, pt, params) => {
      if (/apt=/.test(params) || /x-google-/.test(params)) return line;
      return `a=fmtp:${pt} ${params};x-google-start-bitrate=${startK};x-google-min-bitrate=${minK};x-google-max-bitrate=${kbps}`;
    });
  });
  return video.join('');
}

async function startSession() {
  closePeer();
  stopFallback();
  setStatus('Включаю показ экрана…');
  const s = await getStream();

  pc = new RTCPeerConnection({ iceServers: settings.stun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] });
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const st = pc.connectionState;
    if (st === 'connected') setStatus('Идёт трансляция', 'live');
    else if (st === 'failed') setStatus('Соединение не удалось', '', 'Проверь, что устройства в одной сети.');
    else if (st === 'disconnected' || st === 'closed') setStatus('Готов. Жду подключения устройства', 'ok');
  };

  const video = s.getVideoTracks()[0];
  const vt = pc.addTransceiver(video, { direction: 'sendonly', streams: [s], sendEncodings: [encodingFor(video)] });
  preferCodecs(vt, 'video');
  for (const a of s.getAudioTracks()) pc.addTransceiver(a, { direction: 'sendonly', streams: [s] });

  const offer = await pc.createOffer();
  offer.sdp = stereoOpus(offer.sdp);
  await pc.setLocalDescription(offer);
  await applyEncoding();
  send({ type: 'offer', sdp: pc.localDescription.sdp });
  setStatus('Соединяюсь с устройством…');
}

// ---------- Запасной режим ----------
// Если прямое видео (WebRTC по UDP) не проходит через брандмауэр или роутер,
// сжимаем экран сами (WebCodecs) и шлём кадры через то же соединение, что и управление.
let wsv = null;

function stopFallback() {
  if (wsv) { wsv.stop(); wsv = null; }
}

async function pickEncoderConfig(w, h, fps, bitrate) {
  const base = { width: w, height: h, framerate: fps, bitrate, latencyMode: 'realtime' };
  const options = [
    { ...base, codec: 'avc1.42E033', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' },
    { ...base, codec: 'avc1.42E033', avc: { format: 'annexb' } },
    { ...base, codec: 'avc1.42E02A', avc: { format: 'annexb' } },
    { ...base, codec: 'vp8' },
  ];
  for (const c of options) {
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch { /* пробуем следующий */ }
  }
  return null;
}

async function startFallback() {
  stopFallback();
  if (!('VideoEncoder' in window) || !('MediaStreamTrackProcessor' in window)) {
    send({ type: 'wsv-error', text: 'Браузер на компьютере слишком старый для запасного режима. Обнови Chrome или Edge.' });
    return;
  }
  const s = await getStream();
  const track = s.getVideoTracks()[0].clone();
  const st = track.getSettings();
  let w = st.width || 1280;
  let h = st.height || 720;
  const maxH = Math.min(Number(settings.maxHeight) || 1080, 1080);
  if (h > maxH) { w = Math.round((w * maxH) / h); h = maxH; }
  w -= w % 2; h -= h % 2;
  const fps = Number(settings.fps) || 60;
  const bitrate = Math.min(Number(settings.bitrate) || 20, 15) * 1e6;
  const cfg = await pickEncoderConfig(w, h, fps, bitrate);
  if (!cfg) {
    track.stop();
    send({ type: 'wsv-error', text: 'На компьютере не нашлось подходящего видеокодека.' });
    return;
  }

  let running = true;
  let forceKey = true;
  let lastKey = 0;
  let lastFrame = 0;
  let canvas = null;
  let ctx = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      if (!ws || ws.readyState !== 1) return;
      const buf = new Uint8Array(chunk.byteLength + 9);
      buf[0] = chunk.type === 'key' ? 1 : 0;
      new DataView(buf.buffer).setFloat64(1, chunk.timestamp);
      chunk.copyTo(buf.subarray(9));
      ws.send(buf);
    },
    error: (e) => {
      send({ type: 'wsv-error', text: 'Ошибка сжатия видео на компьютере: ' + e.message });
      stopFallback();
    },
  });
  encoder.configure(cfg);
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  wsv = {
    stop() {
      running = false;
      try { reader.cancel(); } catch { /* уже */ }
      try { track.stop(); } catch { /* уже */ }
      try { if (encoder.state !== 'closed') encoder.close(); } catch { /* уже */ }
    },
    keyframe() { forceKey = true; },
  };
  send({ type: 'wsv-config', codec: cfg.codec, width: w, height: h });
  setStatus('Идёт трансляция (запасной режим)', 'live', 'Видео идёт через основное соединение.');

  const gap = 1000 / fps - 3;
  while (running) {
    let res;
    try { res = await reader.read(); } catch { break; }
    const frame = res.value;
    if (res.done || !frame) break;
    const now = performance.now();
    // Не копим очередь: если сеть или кодировщик не успевают, кадр пропускаем.
    if (!running || encoder.state !== 'configured' || encoder.encodeQueueSize > 2 || ws.bufferedAmount > 400000 || now - lastFrame < gap) {
      frame.close();
      continue;
    }
    let out = frame;
    if (frame.displayWidth !== w || frame.displayHeight !== h) {
      if (!canvas) { canvas = new OffscreenCanvas(w, h); ctx = canvas.getContext('2d'); }
      ctx.drawImage(frame, 0, 0, w, h);
      out = new VideoFrame(canvas, { timestamp: frame.timestamp });
      frame.close();
    }
    const key = forceKey || now - lastKey > 3000;
    if (key) { forceKey = false; lastKey = now; }
    try { encoder.encode(out, { keyFrame: key }); } catch (e) { console.warn(e); }
    out.close();
    lastFrame = now;
  }
}

connect();
