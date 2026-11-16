// lib/input-mode.mjs —— 默认使用原生（可信）输入，合成事件仅显式降级。
export function defaultInputMode(params = {}, flags = {}) {
  const next = { ...(params || {}) };
  if (flags.synthetic === true) {
    next.synthetic = true;
    next.trusted = false;
    return next;
  }
  next.trusted = true;
  delete next.synthetic;
  return next;
}
