// src/tools/keyboard.js —— 键盘事务与 CDP 按键映射。
import { bridgeError } from '../errors.js';
import { send as cdpSend } from '../debugger.js';
import { inputTransactions } from '../lib/input-transaction.js';

export function beginInput(tabId, kind) {
  const result = inputTransactions.begin(tabId, kind);
  if (!result.ok) {
    throw bridgeError('E_INPUT_BUSY', '标签页已有输入事务进行中（' + (result.active && result.active.kind) + '），请稍后再试');
  }
  return () => inputTransactions.end(tabId, kind);
}

const KEY_CODES = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

// US 布局标点的物理键码：快捷键处理器常检查 event.code（Ctrl+/、Ctrl+[ 等），
// 只给 key 不够。Shifted 符号映射到基础键位并自动补 shift 修饰。
const PUNCTUATION = {
  '`': ['Backquote', 192], '~': ['Backquote', 192, true],
  '-': ['Minus', 189], '_': ['Minus', 189, true],
  '=': ['Equal', 187], '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219, true],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220], '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186, true],
  "'": ['Quote', 222], '"': ['Quote', 222, true],
  ',': ['Comma', 188], '<': ['Comma', 188, true],
  '.': ['Period', 190], '>': ['Period', 190, true],
  '/': ['Slash', 191], '?': ['Slash', 191, true],
};

function punctuationInfo(ch) {
  const entry = PUNCTUATION[ch];
  if (!entry) return null;
  return { key: ch, code: entry[0], vk: entry[1], shift: entry[2] === true };
}

function parseKeySpec(spec) {
  const parts = String(spec || '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw bridgeError('E_BAD_ARG', 'press 需要 key');
  const keyName = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token === 'ctrl' || token === 'control') modifiers |= 2;
    else if (token === 'alt' || token === 'option') modifiers |= 1;
    else if (token === 'shift') modifiers |= 8;
    else if (token === 'meta' || token === 'cmd' || token === 'win') modifiers |= 4;
  }
  let info = KEY_CODES[keyName] || KEY_CODES[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
  if (!info && keyName.length === 1) {
    const ch = keyName;
    const upper = ch.toUpperCase();
    const isDigit = /[0-9]/.test(ch);
    const punct = punctuationInfo(ch);
    info = punct
      ? { key: punct.key, code: punct.code, vk: punct.vk, text: punct.shift ? undefined : ch }
      : {
        key: ch,
        code: isDigit ? 'Digit' + ch : (/[a-zA-Z]/.test(ch) ? 'Key' + upper : ''),
        vk: isDigit ? ch.charCodeAt(0) : (upper.charCodeAt(0) || 0),
        text: ch,
      };
    if (punct && punct.shift) modifiers |= 8;
  }
  if (!info) throw bridgeError('E_BAD_ARG', '不支持的按键：' + spec);
  return { ...info, modifiers };
}

export async function trustedKey(tabId, spec) {
  const endInput = beginInput(tabId, 'key');
  try {
    const info = parseKeySpec(spec);
    const base = {
      modifiers: info.modifiers,
      key: info.key,
      code: info.code || '',
      windowsVirtualKeyCode: info.vk || 0,
      nativeVirtualKeyCode: info.vk || 0,
    };
    const withText = info.text !== undefined && (info.modifiers & (2 | 4)) === 0;
    await pipeCdp(tabId, [
      ['Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(withText ? { text: info.text } : {}) }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
    ]);
  } finally {
    endInput();
  }
}


export function pipeCdp(tabId, commands) {
  return Promise.all(commands.map(([method, params]) => cdpSend(tabId, method, params)));
}

