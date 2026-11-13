// src/command-context.js —— 当前 tab 正在执行的命令 id。
// 用于把网络请求/调试记录精确归因到 commandId，而不是时间窗。
const active = new Map();
let latest = null;
let latestAt = 0;
const GRACE_MS = 2000;

export function beginCommand(tabId, commandId) {
  if (!Number.isInteger(tabId) || !commandId) return;
  active.set(tabId, String(commandId));
  latest = String(commandId);
  latestAt = Date.now();
}

export function endCommand(tabId, commandId) {
  if (commandId && latest === String(commandId)) latestAt = Date.now();
  if (!Number.isInteger(tabId)) return;
  if (!commandId || active.get(tabId) === String(commandId)) active.delete(tabId);
}

export function currentCommand(tabId) {
  if (Number.isInteger(tabId) && active.has(tabId)) return active.get(tabId);
  if (latest && Date.now() - latestAt <= GRACE_MS) return latest;
  return null;
}
