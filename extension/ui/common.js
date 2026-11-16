// ui/common.js —— 扩展页面共享的轻量 UI 工具（不引入框架/构建步骤）。
export const $ = (id) => document.getElementById(id);

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
