'use strict';
// Cloud Play: сервер, который запускается на игровом ПК.
// Раздаёт приложение-клиент, показывает библиотеку Steam, запускает игры,
// передаёт сигналы WebRTC между окном трансляции и клиентом и принимает управление.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const steam = require('./steam');
const input = require('./input');

const PUBLIC = path.join(__dirname, 'public');
// Папка, откуда телефон забирает файлы ретро-игр.
const ROMS_DIR = process.env.ROMS_DIR || path.join(__dirname, '..', 'Игры для телефона');
try { fs.mkdirSync(ROMS_DIR, { recursive: true }); } catch { /* нет прав */ }
// Сайт-приложение, которому разрешено забирать игры с этого ПК.
const APP_ORIGINS = ['https://tymurius2-arch.github.io', ...(process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : [])];
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- Настройки ----------
const CONFIG_FILE = path.join(DATA, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* первый запуск */ }
if (!/^\d{6}$/.test(String(config.pin || ''))) config.pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
if (process.env.PIN) config.pin = String(process.env.PIN);
let HTTPS_PORT = Number(process.env.HTTPS_PORT || config.httpsPort || 8443);
let HTTP_PORT = Number(process.env.HTTP_PORT || config.httpPort || 8080);
const NO_BROWSER = !!process.env.NO_BROWSER;
const TEST_SOURCE = !!process.env.TEST_SOURCE; // тестовая картинка вместо экрана

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth/i.test(name)) continue;
      list.push(a.address);
    }
  }
  return list;
}

// ---------- Сертификат для HTTPS ----------
function loadCert() {
  const ips = lanAddresses();
  const keyFile = path.join(DATA, 'key.pem');
  const certFile = path.join(DATA, 'cert.pem');
  const ipKey = ips.slice().sort().join(',');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && config.certIps === ipKey) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Cloud Play' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  config.certIps = ipKey;
  return { key: pems.private, cert: pems.cert };
}

// ---------- Раздача файлов ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function listRoms() {
  let names = [];
  try { names = fs.readdirSync(ROMS_DIR); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (name.startsWith('.') || name === 'README.txt') continue;
    try {
      const st = fs.statSync(path.join(ROMS_DIR, name));
      if (st.isFile()) files.push({ name, size: st.size, modified: st.mtimeMs });
    } catch { /* файл пропал */ }
  }
  return files.sort((a, b) => b.modified - a.modified);
}

function handleRomsApi(req, res, url, p) {
  const origin = req.headers.origin;
  const headers = { 'Cache-Control': 'no-store' };
  if (origin && (APP_ORIGINS.includes(origin) || origin === `https://${req.headers.host}`)) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'X-PIN',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Expose-Headers': 'Content-Length',
      'Vary': 'Origin',
    });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

  const ip = req.socket.remoteAddress || '';
  const f = failedLogins.get(ip);
  if (f && f.until > Date.now()) { res.writeHead(429, headers); return res.end(); }
  const pin = String(req.headers['x-pin'] || url.searchParams.get('pin') || '');
  if (pin !== config.pin) {
    const cnt = f && f.until && f.until <= Date.now() ? 1 : (f ? f.count : 0) + 1;
    failedLogins.set(ip, { count: cnt, until: cnt >= 5 ? Date.now() + 60000 : 0 });
    res.writeHead(401, headers); return res.end();
  }
  failedLogins.delete(ip);

  if (p === '/api/roms') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ folder: ROMS_DIR, files: listRoms().map(({ name, size }) => ({ name, size })) }));
  }
  // /api/roms/file?name=...
  const name = url.searchParams.get('name') || '';
  if (!name || name !== path.basename(name) || name.startsWith('.')) { res.writeHead(400, headers); return res.end(); }
  const file = path.join(ROMS_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, headers); return res.end(); }
    res.writeHead(200, {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    console.log('Отправляю на телефон:', name);
    fs.createReadStream(file).pipe(res);
  });
}

function handleRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/api/roms' || p === '/api/roms/file') return handleRomsApi(req, res, url, p);

  const cover = p.match(/^\/cover\/(\d+)$/);
  if (cover) {
    const file = steam.findCover(cover[1]);
    if (file) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(302, { Location: `https://cdn.cloudflare.steamstatic.com/steam/apps/${cover[1]}/library_600x900.jpg` });
    return res.end();
  }

  let rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------- WebSocket: связь с окном трансляции и клиентами ----------
let hostWs = null;       // окно трансляции на этом ПК
let activeClient = null; // клиент, который сейчас играет
let pendingStart = null; // запрос старта, ждущий окно трансляции
const failedLogins = new Map(); // ip -> { count, until }

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function isLocal(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function releaseAll(ws) {
  if (!ws || !ws.pressed) return;
  for (const k of ws.pressed) {
    if (k.startsWith('b')) input.button(Number(k.slice(1)), false);
    else input.key(k, false);
  }
  ws.pressed.clear();
}

function stopSession(reason) {
  if (!activeClient) return;
  releaseAll(activeClient);
  if (reason) send(activeClient, { type: 'stopped', reason });
  activeClient = null;
  pendingStart = null;
  send(hostWs, { type: 'stop' });
}

function handleInput(ws, m) {
  switch (m.a) {
    case 'm': input.move(m.x, m.y); break;
    case 'p': input.moveAbs(m.x, m.y); break;
    case 'bd': input.button(m.b, true); ws.pressed.add('b' + (m.b | 0)); break;
    case 'bu': input.button(m.b, false); ws.pressed.delete('b' + (m.b | 0)); break;
    case 'w': input.wheel(m.d, false); break;
    case 'hw': input.wheel(m.d, true); break;
    case 'kd': if (input.key(String(m.c), true)) ws.pressed.add(String(m.c)); break;
    case 'ku': input.key(String(m.c), false); ws.pressed.delete(String(m.c)); break;
    case 'release': releaseAll(ws); break;
  }
}

function onHostMessage(ws, m) {
  switch (m.type) {
    case 'offer':
    case 'ice':
    case 'host-error':
    case 'host-status':
      send(activeClient, m);
      break;
  }
}

function onClientMessage(ws, m) {
  switch (m.type) {
    case 'games':
      send(ws, { type: 'games', ...steam.listGames() });
      break;
    case 'launch':
      if (steam.launch(m.appid)) console.log('Запуск игры', m.appid, m.name || '');
      break;
    case 'bigpicture':
      steam.openBigPicture();
      break;
    case 'start': {
      if (activeClient && activeClient !== ws) {
        send(activeClient, { type: 'stopped', reason: 'Подключилось другое устройство.' });
        releaseAll(activeClient);
      }
      activeClient = ws;
      const settings = m.settings || {};
      if (hostWs) {
        send(hostWs, { type: 'start', settings });
      } else {
        pendingStart = settings;
        send(ws, { type: 'host-status', text: 'Открываю окно трансляции на компьютере…' });
        openHostWindow();
      }
      break;
    }
    case 'answer':
    case 'ice':
    case 'settings':
      if (ws === activeClient) send(hostWs, m);
      break;
    case 'stop':
      if (ws === activeClient) stopSession();
      break;
    case 'i':
      if (ws === activeClient) handleInput(ws, m);
      break;
    case 'ping':
      send(ws, { type: 'pong', t: m.t });
      break;
  }
}

function onConnection(ws, req) {
  const ip = req.socket.remoteAddress || '';
  ws.role = null;
  ws.pressed = new Set();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!ws.role) {
      if (m.type !== 'hello') return;
      if (m.role === 'host') {
        if (!isLocal(ip)) return ws.close();
        if (hostWs && hostWs !== ws) hostWs.close();
        hostWs = ws;
        ws.role = 'host';
        console.log('Окно трансляции подключено.');
        send(ws, { type: 'info', pin: config.pin, urls: clientUrls(), test: TEST_SOURCE });
        if (pendingStart && activeClient) {
          send(ws, { type: 'start', settings: pendingStart });
          pendingStart = null;
        }
        return;
      }
      const f = failedLogins.get(ip);
      if (f && f.until > Date.now()) {
        send(ws, { type: 'hello-fail', reason: 'Слишком много попыток. Подожди минуту.' });
        return ws.close();
      }
      if (String(m.pin || '') !== config.pin) {
        const cnt = f && f.until && f.until <= Date.now() ? 1 : (f ? f.count : 0) + 1;
        failedLogins.set(ip, { count: cnt, until: cnt >= 5 ? Date.now() + 60000 : 0 });
        send(ws, { type: 'hello-fail', reason: 'Неверный PIN-код.' });
        return ws.close();
      }
      failedLogins.delete(ip);
      ws.role = 'client';
      console.log('Подключилось устройство', ip.replace('::ffff:', ''));
      send(ws, { type: 'hello-ok', name: os.hostname(), platform: process.platform, hostReady: !!hostWs });
      return;
    }

    if (ws.role === 'host') onHostMessage(ws, m);
    else onClientMessage(ws, m);
  });

  ws.on('close', () => {
    if (ws.role === 'host' && hostWs === ws) {
      hostWs = null;
      console.log('Окно трансляции закрыто.');
      if (activeClient) send(activeClient, { type: 'host-lost' });
    }
    if (ws.role === 'client') {
      if (ws === activeClient) stopSession();
      releaseAll(ws);
      console.log('Устройство отключилось', ip.replace('::ffff:', ''));
    }
  });
  ws.on('error', () => {});
}

// ---------- Окно трансляции (Chrome или Edge) ----------
let browserProc = null;
let browserOpenedAt = 0;

function findBrowser() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const list = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    list.push(
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.find((p) => p && fs.existsSync(p)) || null;
}

function openHostWindow() {
  if (NO_BROWSER) return;
  if (browserProc && Date.now() - browserOpenedAt < 15000) return;
  const exe = findBrowser();
  if (!exe) {
    console.log('Не найден Chrome или Edge. Открой вручную: https://localhost:' + HTTPS_PORT + '/host.html');
    return;
  }
  const url = `https://localhost:${HTTPS_PORT}/host.html${TEST_SOURCE ? '?test=1' : ''}`;
  const args = [
    `--app=${url}`,
    `--user-data-dir=${path.join(DATA, 'browser')}`,
    '--lang=en-US',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--auto-select-desktop-capture-source=Entire screen',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
    '--window-size=460,620',
    '--window-position=40,40',
  ];
  browserOpenedAt = Date.now();
  browserProc = spawn(exe, args, { stdio: 'ignore', detached: false });
  browserProc.on('error', (e) => console.log('Не удалось открыть браузер:', e.message));
  browserProc.on('exit', () => { browserProc = null; });
  console.log('Открываю окно трансляции…');
}

function clientUrls() {
  return lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}/`);
}

// ---------- Запуск ----------
function main() {
  saveConfig();
  const tls = loadCert();
  saveConfig();

  const httpsServer = https.createServer(tls, handleRequest);
  const httpServer = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  wss.on('connection', onConnection);
  for (const srv of [httpsServer, httpServer]) {
    srv.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws')) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* закрыт */ }
    }
  }, 5000);

  start(httpsServer, httpServer).catch((e) => {
    console.log('Не удалось запустить сервер:', e.message);
    process.exit(1);
  });
}

// Слушает первый свободный порт начиная с нужного.
function listenFree(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && p < port + 20) tryPort(p + 1);
        else reject(e);
      };
      server.once('error', onError);
      server.listen(p, () => { server.off('error', onError); resolve(p); });
    };
    tryPort(port);
  });
}

// Проверяет, не запущен ли уже Cloud Play на этом порту.
function cloudPlayAlreadyRunning(port) {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 5000) res.destroy(); });
      res.on('end', () => resolve(body.includes('Cloud Play')));
      res.on('close', () => resolve(body.includes('Cloud Play')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function start(httpsServer, httpServer) {
  const wanted = HTTPS_PORT;
  if (await cloudPlayAlreadyRunning(wanted)) {
    console.log('');
    console.log('  Cloud Play уже запущен в другом окне.');
    console.log('  Закрой старое чёрное окно Cloud Play и запусти start.bat ещё раз.');
    console.log('  Если старого окна не видно: Ctrl+Shift+Esc (Диспетчер задач) ->');
    console.log('  найди «Node.js JavaScript Runtime» -> «Снять задачу».');
    console.log('');
    process.exit(1);
  }
  HTTPS_PORT = await listenFree(httpsServer, wanted);
  try { HTTP_PORT = await listenFree(httpServer, HTTP_PORT); } catch (e) { console.log('HTTP-сервер не запустился:', e.message); }
  httpsServer.on('error', (e) => console.log('Ошибка HTTPS-сервера:', e.message));
  httpServer.on('error', (e) => console.log('Ошибка HTTP-сервера:', e.message));
  if (HTTPS_PORT !== wanted) {
    console.log(`Порт ${wanted} занят другой программой, поэтому Cloud Play работает на порту ${HTTPS_PORT}.`);
    console.log(`В адресе на телефоне обязательно указывай :${HTTPS_PORT}`);
  }
  input.start();
  printBanner();
  openHostWindow();
}

function printBanner() {
  const urls = clientUrls();
  const games = steam.listGames();
  console.log('');
  console.log('==============================================');
  console.log('  CLOUD PLAY запущен');
  console.log('==============================================');
  console.log(games.steamFound
    ? `  Steam найден: ${games.games.length} игр(ы)`
    : '  Steam не найден (можно играть в режиме «Рабочий стол»)');
  console.log('');
  console.log('  PIN-код для подключения:  ' + config.pin.slice(0, 3) + ' ' + config.pin.slice(3));
  console.log('');
  if (urls.length) {
    console.log('  Открой на телефоне, планшете или ноутбуке');
    console.log('  (устройство должно быть в той же сети Wi-Fi):');
    for (const u of urls) console.log('     ' + u);
    console.log('  Если iPhone ругается на https, попробуй:');
    for (const ip of lanAddresses()) console.log(`     http://${ip}:${HTTP_PORT}/`);
    try {
      console.log('');
      require('qrcode-terminal').generate(urls[0], { small: true }, (q) => console.log(q));
    } catch { /* без QR */ }
  } else {
    console.log('  Компьютер не подключён к сети.');
  }
  console.log('');
  console.log('  Ретро-игры для телефона клади в папку:');
  console.log('     ' + ROMS_DIR);
  console.log('  На телефоне: Cloud Play → Ретро → «Загрузить с компьютера».');
  console.log('  Не закрывай это окно, пока играешь.');
  console.log('==============================================');
}

function shutdown() {
  if (browserProc) try { browserProc.kill(); } catch { /* уже закрыт */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
