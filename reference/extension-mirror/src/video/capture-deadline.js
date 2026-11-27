import { VideoError } from './errors.js';

/** Chrome cannot cancel an already dispatched screenshot. Stop waiting for it
 * on cancellation/deadline and ignore its late result before opening an encoder. */
export async function captureReply(promise, signal) {
  let timer;
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? new Error('Video capture cancelled'));
        timer = setTimeout(() => reject(new VideoError({ code: 'timeout', message: 'Video capture did not respond within 10s' })), 10000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
