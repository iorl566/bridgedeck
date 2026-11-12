// src/command-cancel.js —— 记录正在执行的命令 id，支持 daemon 转发 cancel。
const active = new Set();
const cancelled = new Set();

export function registerCommand(id) {
  if (id) active.add(String(id));
}

export function unregisterCommand(id) {
  if (!id) return;
  active.delete(String(id));
  cancelled.delete(String(id));
}

export function cancelCommand(id) {
  const key = String(id || '');
  if (!key || !active.has(key)) return false;
  cancelled.add(key);
  return true;
}

export function isCommandCancelled(id) {
  return Boolean(id) && cancelled.has(String(id));
}
