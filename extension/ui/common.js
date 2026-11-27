// ui/common.js —— 扩展页面共享的轻量 UI 工具（不引入框架/构建步骤）。
import { describeError } from './error-hints.js';
import { getLang } from './i18n.js';

export const $ = (id) => document.getElementById(id);

/** 把协议错误/字符串转成当前语言的用户可读提示（错误码不再只显示英文）。 */
export function errorText(value) {
  return describeError(value, getLang()).text;
}

export function toast(text, duration = 1600) {
  const node = $('toast');
  if (!node) return;
  node.textContent = text;
  node.className = 'toast show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, duration);
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '?';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

export function send(message) {
  return chrome.runtime.sendMessage(message);
}
