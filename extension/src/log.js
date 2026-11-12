// src/log.js —— 带时间戳的日志（service worker 控制台，chrome://extensions 里可查看）
export function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

export function log(...args) {
  console.log(`[bb ${formatTimestamp()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[bb ${formatTimestamp()}]`, ...args);
}
