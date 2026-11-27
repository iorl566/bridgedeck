import { ScreenshotError } from './types.js';

/** Browser APIs cannot be aborted, but a stuck call must not strand a page/job.
 * @template T
 * @param {Promise<T>} promise Reply to await.
 * @param {AbortSignal} [signal] Cancels the wait.
 * @param {number} [timeoutMs] Budget before a timeout failure.
 * @returns {Promise<T>}
 */
export function waitForReply(promise, signal, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new ScreenshotError('interrupted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ScreenshotError('timeout'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
