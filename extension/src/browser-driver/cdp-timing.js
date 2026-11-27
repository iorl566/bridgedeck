// src/browser-driver/cdp-timing.js —— CDP attach/detach 的等待边界（纯计时工具）。
export const CLEANUP_WAIT_MS = 1_000;

/** Wait for every task, but never past `deadline`. Returns false when time ran out. */
export async function settleBeforeDeadline(promises, deadline) {
  if (promises.length === 0) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer;
  const timedOut = await Promise.race([
    Promise.allSettled(promises).then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return !timedOut;
}

/** Caller-side cleanup budget; the underlying promise remains fenced and its
 * late completion is still observed. A deadline is not native cancellation. */
export async function cleanupWait(work, timeoutMs = CLEANUP_WAIT_MS) {
  let timer;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
