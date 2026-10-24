'use strict';
// Чтение библиотеки Steam с диска и запуск игр.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

// Служебные пакеты Steam, которые не являются играми.
const HIDDEN_APPS = new Set([
  '228980',  // Steamworks Common Redistributables
  '250820',  // SteamVR
  '1070560', // Steam Linux Runtime 1.0
  '1391110', // Steam Linux Runtime 2.0
  '1628350', // Steam Linux Runtime 3.0
  '1493710', // Proton Experimental
  '2180100', // Proton Hotfix
  '1826330', // Proton EasyAntiCheat Runtime
  '1161040', // Proton BattlEye Runtime
]);
const HIDDEN_NAME = /redistributable|steamworks common|^proton|steam linux runtime|^steamvr|dedicated server|soundtrack|sdk$/i;

function findSteamPath() {
  if (process.env.STEAM_PATH) return process.env.STEAM_PATH;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
      try {
        const out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
        const m = out.match(/(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)/i);
        if (m) candidates.push(m[1].trim().replace(/\//g, '\\'));
      } catch { /* ключа нет */ }
    }
    candidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library/Application Support/Steam'));
  } else {
    candidates.push(
      path.join(os.homedir(), '.steam/steam'),
      path.join(os.homedir(), '.local/share/Steam'),
      path.join(os.homedir(), '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
    );
  }
  return candidates.find((p) => fs.existsSync(path.join(p, 'steamapps'))) || null;
}

// Простой парсер формата Valve KeyValues (.vdf / .acf).
function parseVDF(text) {
  let i = 0;
  const n = text.length;
  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
      else if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; }
      else break;
    }
  }
  function str() {
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { i++; s += text[i] === 'n' ? '\n' : text[i] === 't' ? '\t' : text[i]; }
        else s += text[i];
        i++;
      }
      i++;
      return s;
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return s;
  }
  function obj() {
    const o = {};
    for (;;) {
      skip();
      if (i >= n) return o;
      if (text[i] === '}') { i++; return o; }
      const key = str();
      skip();
      if (text[i] === '{') { i++; o[key] = obj(); }
      else o[key] = str();
    }
  }
  return obj();
}

function readVDF(file) {
  try { return parseVDF(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function getKey(obj, name) {
  if (!obj) return undefined;
  const k = Object.keys(obj).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

function libraryPaths(steamPath) {
  const set = new Set([steamPath]);
  const vdf = readVDF(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
  const root = getKey(vdf, 'libraryfolders') || {};
  for (const v of Object.values(root)) {
    if (typeof v === 'string') set.add(v); // старый формат
    else if (v && v.path) set.add(v.path);
  }
  return [...set].map((p) => p.replace(/\\\\/g, '\\'));
}

function listGames() {
  const steamPath = findSteamPath();
  if (!steamPath) return { steamFound: false, games: [] };
  const games = new Map();
  for (const lib of libraryPaths(steamPath)) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      const st = getKey(readVDF(path.join(dir, f)), 'AppState');
      if (!st) continue;
      const appid = String(getKey(st, 'appid') || '');
      const name = String(getKey(st, 'name') || '');
      if (!/^\d+$/.test(appid) || !name) continue;
      if (HIDDEN_APPS.has(appid) || HIDDEN_NAME.test(name)) continue;
      const flags = Number(getKey(st, 'StateFlags') || 0);
      games.set(appid, {
        appid,
        name,
        lastPlayed: Number(getKey(st, 'LastPlayed') || 0),
        size: Number(getKey(st, 'SizeOnDisk') || 0),
        installed: (flags & 4) === 4,
      });
    }
  }
  const list = [...games.values()].sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));
  return { steamFound: true, steamPath, games: list };
}

// Ищет обложку игры в кэше Steam. Возвращает путь к файлу или null.
function findCover(appid) {
  if (!/^\d+$/.test(appid)) return null;
  const steamPath = findSteamPath();
  if (!steamPath) return null;
  const cache = path.join(steamPath, 'appcache', 'librarycache');
  const direct = [
    path.join(cache, `${appid}_library_600x900.jpg`),
    path.join(cache, appid, 'library_600x900.jpg'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;
  // Новые версии Steam кладут картинки в подпапки с хешем.
  const dir = path.join(cache, appid);
  const stack = [dir];
  let depth = 0;
  while (stack.length && depth < 50) {
    depth++;
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^library_600x900/i.test(e.name) && /\.(jpg|png)$/i.test(e.name)) return full;
    }
  }
  return null;
}

function openUri(uri) {
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd', ['/c', 'start', '""', uri], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [uri], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [uri], { detached: true, stdio: 'ignore' });
  }
  child.on('error', (e) => console.log('Не удалось открыть', uri, e.message));
  child.unref();
}

function launch(appid) {
  if (!/^\d+$/.test(String(appid))) return false;
  openUri(`steam://rungameid/${appid}`);
  return true;
}

function openBigPicture() {
  openUri('steam://open/bigpicture');
}

module.exports = { listGames, launch, openBigPicture, findCover, findSteamPath, parseVDF };
