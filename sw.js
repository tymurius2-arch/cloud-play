// Cloud Play: быстрое открытие и работа без интернета.
// Всё приложение отдаётся сразу из памяти телефона, а свежая версия
// тихо скачивается в фоне и появится при следующем открытии.
const VERSION = 'v3';
const APP = 'cloud-play-app-' + VERSION;
const EMU = 'cloud-play-emu-4.2.3'; // файлы эмулятора не меняются внутри версии
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'games/retro/db.js',
];
const LATER = [
  'icon-512.png', 'games/shared/pad.js', 'games/shared/game.css',
  'games/racer/', 'games/arena/', 'games/blocks/', 'games/retro/play.html',
];
const EMU_PREFIX = 'https://cdn.emulatorjs.org/4.2.3/data/';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(SHELL);
    // Игры докачиваем без ожидания: если не успеет, скачается при первом запуске.
    c.addAll(LATER).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== APP && k !== EMU).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => {});
    await self.clients.claim();
  })());
});

// Сразу из кэша, а в фоне обновляем.
async function staleWhileRevalidate(e, request) {
  const cache = await caches.open(APP);
  const cached = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  });
  if (cached) {
    e.waitUntil(fresh.catch(() => {}));
    return cached;
  }
  try { return await fresh; } catch {
    if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
    return Response.error();
  }
}

// Файлы эмулятора: один раз скачали — дальше всегда из памяти.
async function cacheFirst(request) {
  const cache = await caches.open(EMU);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(e, req));
  } else if (req.url.startsWith(EMU_PREFIX) && !/\/cores\/[^/]+\.data$/.test(url.pathname)) {
    // Ядра консолей (.data, до 20 МБ) эмулятор сам хранит у себя, второй копии не нужно.
    e.respondWith(cacheFirst(req));
  }
});
