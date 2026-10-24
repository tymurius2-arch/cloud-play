'use strict';
// Передача нажатий клавиш и движений мыши от клиента в систему.
// В Windows работает через input-win.ps1 (SendInput). На других системах только пишет в лог.

const path = require('path');
const { spawn } = require('child_process');

// KeyboardEvent.code -> скан-код (набор 1). 0xE0xx - расширенные клавиши.
const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037,
  AltRight: 0xe038, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052,
  Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};

let proc = null;
let ready = false;
let warned = false;

function start() {
  if (process.platform !== 'win32') return;
  proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'input-win.ps1'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stdout.on('data', (d) => {
    if (!ready && String(d).includes('ready')) { ready = true; console.log('Управление мышью и клавиатурой готово.'); }
  });
  proc.stderr.on('data', (d) => console.log('[input]', String(d).trim()));
  proc.on('exit', (code) => {
    console.log('Помощник управления остановился (код ' + code + '), перезапускаю...');
    proc = null; ready = false;
    setTimeout(start, 2000);
  });
  proc.stdin.on('error', () => {});
}

function cmd(line) {
  if (proc && proc.stdin.writable) { proc.stdin.write(line + '\n'); return; }
  if (!warned && process.platform !== 'win32') {
    warned = true;
    console.log('Внимание: управление компьютером работает только в Windows. Здесь команды просто игнорируются.');
  }
  if (process.env.INPUT_DEBUG) console.log('[input]', line);
}

const int = (v) => Math.round(Number(v) || 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function move(dx, dy) {
  dx = clamp(int(dx), -4000, 4000); dy = clamp(int(dy), -4000, 4000);
  if (dx || dy) cmd(`m ${dx} ${dy}`);
}
function moveAbs(nx, ny) {
  const x = clamp(Math.round((Number(nx) || 0) * 65535), 0, 65535);
  const y = clamp(Math.round((Number(ny) || 0) * 65535), 0, 65535);
  cmd(`a ${x} ${y}`);
}
function button(b, down) {
  b = int(b);
  if (b < 0 || b > 4) return;
  cmd(`${down ? 'd' : 'u'} ${b}`);
}
function wheel(d, horizontal) {
  d = clamp(int(d), -2400, 2400);
  if (d) cmd(`${horizontal ? 'h' : 'w'} ${d}`);
}
function key(code, down) {
  const s = SCAN[code];
  if (!s) return false;
  cmd(`${down ? 'k' : 'K'} ${s}`);
  return true;
}

module.exports = { start, move, moveAbs, button, wheel, key, SCAN };
