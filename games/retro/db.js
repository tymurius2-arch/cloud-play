'use strict';
// Библиотека ретро-игр: файлы хранятся внутри приложения (IndexedDB),
// поэтому открываются только в Cloud Play и работают без интернета.

window.RetroDB = (function () {
  const DB_NAME = 'cloudplay-retro';
  const STORE = 'roms';

  // Консоли, которые хорошо работают в браузере телефона.
  const SYSTEMS = {
    nes: { name: 'NES / Денди', emoji: '🕹️', ext: ['nes', 'fds', 'unf', 'unif'], color: '#b91c1c' },
    snes: { name: 'Super Nintendo', emoji: '🎮', ext: ['smc', 'sfc', 'fig', 'swc'], color: '#6d28d9' },
    gb: { name: 'Game Boy / Color', emoji: '🟩', ext: ['gb', 'gbc', 'dmg'], color: '#4d7c0f' },
    gba: { name: 'Game Boy Advance', emoji: '🟪', ext: ['gba'], color: '#4338ca' },
    segaMD: { name: 'Sega Mega Drive', emoji: '🦔', ext: ['md', 'gen', 'smd'], color: '#1d4ed8' },
    segaMS: { name: 'Sega Master System', emoji: '🔷', ext: ['sms'], color: '#0369a1' },
    segaGG: { name: 'Sega Game Gear', emoji: '🔹', ext: ['gg'], color: '#0f766e' },
    psx: { name: 'PlayStation 1', emoji: '💿', ext: ['pbp', 'chd'], color: '#334155' },
    n64: { name: 'Nintendo 64', emoji: '⭐', ext: ['n64', 'z64', 'v64'], color: '#15803d' },
    nds: { name: 'Nintendo DS', emoji: '📱', ext: ['nds'], color: '#475569' },
    pce: { name: 'PC Engine', emoji: '🟠', ext: ['pce'], color: '#c2410c' },
    atari2600: { name: 'Atari 2600', emoji: '👾', ext: ['a26'], color: '#92400e' },
    ngp: { name: 'Neo Geo Pocket', emoji: '🟡', ext: ['ngp', 'ngc'], color: '#a16207' },
    ws: { name: 'WonderSwan', emoji: '🌀', ext: ['ws', 'wsc'], color: '#0e7490' },
    lynx: { name: 'Atari Lynx', emoji: '🐆', ext: ['lnx'], color: '#78350f' },
    arcade: { name: 'Аркадные автоматы', emoji: '🕹', ext: [], color: '#9d174d' },
  };
  // Расширения, по которым нельзя понять консоль: спросим у пользователя.
  const AMBIGUOUS = ['zip', '7z', 'bin', 'iso', 'img', 'rom'];
  const UNSUPPORTED = { cso: 'PSP', pbp_psp: 'PSP', xci: 'Switch', nsp: 'Switch', wbfs: 'Wii', rvz: 'GameCube/Wii', gcm: 'GameCube', '3ds': 'Nintendo 3DS', cia: 'Nintendo 3DS' };

  function ext(name) {
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }
  function detect(name) {
    const e = ext(name);
    if (!e || AMBIGUOUS.includes(e)) return null;
    for (const [id, s] of Object.entries(SYSTEMS)) if (s.ext.includes(e)) return id;
    if (e === 'cue') return 'psx-cue';
    if (UNSUPPORTED[e]) return 'unsupported:' + UNSUPPORTED[e];
    return null;
  }
  function prettyName(fileName) {
    return String(fileName)
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s*[[(][^\])]*[\])]/g, '') // убираем пометки вроде (USA) [!]
      .replace(/\s+/g, ' ')
      .trim() || fileName;
  }

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Не хватает места на устройстве'));
    }));
  }
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  async function add({ fileName, system, blob, name }) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const item = { id, fileName, system, name: name || prettyName(fileName), size: blob.size, added: Date.now(), lastPlayed: 0, blob };
    await tx('readwrite', (st) => st.put(item));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return id;
  }
  // Список без самих файлов (они бывают большими).
  async function list() {
    const all = await tx('readonly', (st) => req(st.getAll()));
    return all.map(({ blob, ...rest }) => rest).sort((a, b) => (b.lastPlayed - a.lastPlayed) || (b.added - a.added));
  }
  const get = (id) => tx('readonly', (st) => req(st.get(id)));
  const remove = (id) => tx('readwrite', (st) => st.delete(id));
  async function update(id, patch) {
    const item = await get(id);
    if (!item) return;
    Object.assign(item, patch);
    await tx('readwrite', (st) => st.put(item));
  }

  return { SYSTEMS, detect, ext, prettyName, add, list, get, remove, update };
})();
