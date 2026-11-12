// lib/auth-guard.mjs —— 远程 WS 握手的速率限制与首帧大小上限（零依赖）。
//
// 目的：未配对/暴力尝试不应无限消耗 daemon 资源；首帧 hello 必须在
// 5s 内到达，且不超过 64KiB（本地配对握手同样适用）。

export const DEFAULT_MAX_HELLO_BYTES = 64 * 1024;
export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_ATTEMPT_WINDOW_MS = 60_000;
export const DEFAULT_BLOCK_MS = 60_000;

export function createAuthGuard(options = {}) {
  const maxHelloBytes = Number(options.maxHelloBytes) > 0 ? Number(options.maxHelloBytes) : DEFAULT_MAX_HELLO_BYTES;
  const maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_ATTEMPT_WINDOW_MS;
  const blockMs = Number(options.blockMs) > 0 ? Number(options.blockMs) : DEFAULT_BLOCK_MS;
  const attempts = new Map(); // key -> number[] timestamps
  const blocked = new Map(); // key -> until

  const keyOf = (key) => String(key || 'unknown');

  function isBlocked(key, now = Date.now()) {
    const k = keyOf(key);
    const until = blocked.get(k);
    if (!until) return false;
    if (until > now) return true;
    blocked.delete(k);
    attempts.delete(k);
    return false;
  }

  function checkHello(key, bytes, now = Date.now()) {
    const k = keyOf(key);
    if (isBlocked(k, now)) return { ok: false, code: 'E_RATE_LIMITED' };
    if (Number(bytes) > maxHelloBytes) return { ok: false, code: 'E_TOO_LARGE' };
    return { ok: true };
  }

  function fail(key, now = Date.now()) {
    const k = keyOf(key);
    if (isBlocked(k, now)) return true;
    const list = (attempts.get(k) || []).filter((ts) => now - ts <= windowMs);
    list.push(now);
    attempts.set(k, list);
    if (list.length >= maxAttempts) {
      blocked.set(k, now + blockMs);
      return true;
    }
    return false;
  }

  function success(key) {
    const k = keyOf(key);
    attempts.delete(k);
    blocked.delete(k);
  }

  function snapshot(now = Date.now()) {
    return {
      tracked: attempts.size,
      blocked: [...blocked.entries()].filter(([, until]) => until > now).map(([key, until]) => ({ key, until })),
    };
  }

  return { maxHelloBytes, maxAttempts, windowMs, blockMs, isBlocked, checkHello, fail, success, snapshot };
}
