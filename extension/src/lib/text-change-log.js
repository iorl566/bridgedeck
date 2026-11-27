// 有界文本变更日志：协作 frameState.texts 的纯函数部分。
export function appendTextChange(log, entry, { limit = 20 } = {}) {
  const list = Array.isArray(log) ? log.slice() : [];
  const max = Math.max(1, Number(limit) || 20);
  list.push({ at: Number(entry && entry.at) || Date.now(), ...entry });
  let dropped = 0;
  while (list.length > max) {
    list.shift();
    dropped += 1;
  }
  return { texts: list, dropped };
}
