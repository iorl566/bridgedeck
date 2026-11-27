import { frameSignature, isStaleFrame } from './frame-freshness.js';
import { ScreenshotError } from './types.js';

/**
 * Arguments for one automatic capture pass.
 * @typedef {object} CaptureDeps
 * @property {(command: import('./types.js').PageCommand) => Promise<import('./types.js').PageMetrics>} page Page-side command.
 * @property {() => Promise<ImageBitmap>} screenshot Capture the current viewport.
 * @property {(bitmap: ImageBitmap, width: number, sourceY: number, targetY: number, height: number) => Promise<void>} write Store an image slice.
 * @property {AbortSignal} signal Cancels the pass.
 * @property {(phase: import('./types.js').CapturePhase, progress: number, frames: number) => void} progress Publishes progress.
 * @property {() => Promise<void>} [checkpoint] Pause and cancellation barrier.
 * @property {() => void} [prepared] Runs once the page task is prepared.
 * @property {() => boolean} [finished] Reports whether the user accepted the image.
 * @property {import('./types.js').CaptureScope} [scope] Capture extent.
 * @property {number} [loadingTimeoutMs] Budget for a stalled loading indicator.
 * @property {boolean} [checkFreshness] Verify exposures with signatures.
 * @property {(bitmap: ImageBitmap) => import('./frame-freshness.js').FrameSignature} [frameSignature] Signature builder override.
 * @property {string} label Progress label.
 * @property {string} cancelLabel Cancel button label.
 */

/** Round document boundaries once, so fractional zoom cannot accumulate seams.
 * @param {import('./types.js').PageMetrics} metrics Current geometry.
 * @param {number} covered Pixels already written.
 * @param {number} scale Image pixels per CSS pixel.
 * @returns {{ sourceY: number, targetY: number, height: number, end: number }} Slice to read and where it ends.
 */
export function sliceForFrame(metrics, covered, scale) {
  if (metrics.y > covered + 0.5) throw new ScreenshotError('changed');
  const end = Math.min(metrics.y + metrics.viewportHeight, metrics.height);
  const bottomPx = Math.round(end * scale);
  const footerStart = metrics.height - Math.min(metrics.viewportHeight, metrics.bottomOverlayHeight ?? 0);
  const start = bottomPx === Math.round(metrics.height * scale)
    ? Math.min(covered, Math.max(metrics.y, footerStart))
    : covered;
  const topPx = Math.round(start * scale);
  return { sourceY: topPx - Math.round(metrics.y * scale), targetY: topPx, height: bottomPx - topPx, end };
}

/**
 * @param {import('./types.js').PageMetrics} a Previous geometry.
 * @param {import('./types.js').PageMetrics} b Current geometry.
 * @param {boolean} [includePosition] Compare scroll position as well.
 * @returns {boolean} True when nothing that affects tiling changed.
 */
export function sameLayout(a, b, includePosition = true) {
  return a.width === b.width
    && a.height === b.height
    && a.viewportWidth === b.viewportWidth
    && a.viewportHeight === b.viewportHeight
    && a.innerWidth === b.innerWidth
    && a.innerHeight === b.innerHeight
    && a.dpr === b.dpr
    && (!includePosition || (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5));
}

/** Capture one viewport at a time. Height may grow as lazy content is appended.
 *
 * Only geometry that affects tiling must stay stable; each exposure is
 * validated independently. Growth above the current tail rolls the write
 * position back so newly inserted content is repainted instead of leaving a
 * seam. A provisional bottom is retried until its loading indicator settles or
 * the caller's budget expires.
 *
 * @param {CaptureDeps} deps Injected page, source and storage surfaces.
 * @returns {Promise<{ width: number, height: number }>} Stored image size.
 */
export async function capturePage(deps) {
  const { signal, page, progress } = deps;
  let covered = 0;
  let width = 0;
  let scale = 1;
  let frames = 0;
  let previousFrame;
  let bottomWait;
  let baseline;
  /** Abort-aware pause barrier checked between viewports and before writes.
   * @returns {Promise<void>} Resolves when capture may continue.
   */
  const checkpoint = async () => {
    signal.throwIfAborted();
    await deps.checkpoint?.();
    signal.throwIfAborted();
  };
  try {
    await checkpoint();
    let metrics = await page({ action: 'begin', label: deps.label, cancelLabel: deps.cancelLabel, ...(deps.scope ? { scope: deps.scope } : {}) });
    let previous = metrics;
    let repairThrough = 0;
    deps.prepared?.();
    let y = 0;
    let layoutFailures = 0;
    let staleFailures = 0;
    let final = false;
    while (true) {
      await checkpoint();
      if (covered && covered >= repairThrough && deps.finished?.()) break;
      metrics = await page({ action: 'move', y, capture: true, final });
      if (baseline && !sameLayout({ ...baseline, height: metrics.height }, metrics, false)) throw new ScreenshotError('changed');
      if (metrics.height < covered - 0.5) throw new ScreenshotError('changed');
      baseline ??= metrics;
      const tail = previous.tailStart ?? Math.max(0, previous.height - previous.viewportHeight);
      const grew = metrics.height > previous.height + 0.5;
      previous = grew ? metrics : { ...metrics, tailStart: Math.min(tail, metrics.tailStart ?? tail) };
      if (grew && covered > tail) {
        repairThrough = Math.max(repairThrough, covered);
        covered = tail;
        y = tail;
        final = false;
        continue;
      }
      if (final && metrics.bottomReady === false && covered >= metrics.height - 0.5) {
        if (!metrics.loading) bottomWait = undefined;
        else {
          if (!bottomWait || bottomWait.height !== metrics.height) bottomWait = { height: metrics.height, since: performance.now() };
          if (deps.loadingTimeoutMs !== undefined && performance.now() - bottomWait.since >= deps.loadingTimeoutMs) throw new ScreenshotError('timeout', 'loading_stalled');
        }
        continue;
      }
      bottomWait = undefined;
      const bitmap = await deps.screenshot();
      try {
        signal.throwIfAborted();
        const after = await page({ action: 'inspect' });
        if (final && after.bottomReady === false) continue;
        if (!sameLayout(metrics, after)) {
          staleFailures = 0;
          if (++layoutFailures >= 3) throw new ScreenshotError('changed');
          continue;
        }
        layoutFailures = 0;
        if (!frames) {
          const rounding = (metrics.dpr + 1) / 2;
          scale = Math.abs(bitmap.width - metrics.innerWidth * metrics.dpr) <= rounding && Math.abs(bitmap.height - metrics.innerHeight * metrics.dpr) <= rounding
            ? metrics.dpr
            : bitmap.width / metrics.innerWidth;
          width = Math.round(metrics.viewportWidth * scale);
        }
        const rounding = Math.max(1, (scale + 1) / 2);
        if (Math.abs(bitmap.width - metrics.innerWidth * scale) > rounding || Math.abs(bitmap.height - metrics.innerHeight * scale) > rounding) throw new ScreenshotError('changed');
        const pixels = deps.checkFreshness ? (deps.frameSignature ?? frameSignature)(bitmap) : undefined;
        if (pixels && previousFrame && isStaleFrame(previousFrame.pixels, pixels, Math.round((metrics.y - previousFrame.y) * scale))) {
          if (++staleFailures >= 3) throw new ScreenshotError('captureFailed', 'stale_frame');
          continue;
        }
        staleFailures = 0;
        const slice = sliceForFrame(metrics, covered, scale);
        if (slice.sourceY < 0 || slice.sourceY + slice.height > bitmap.height || slice.height < 0) throw new ScreenshotError('changed');
        if (slice.height) {
          await deps.write(bitmap, width, slice.sourceY, slice.targetY, slice.height);
          covered = slice.end;
          frames++;
        }
        if (pixels) previousFrame = { y: metrics.y, pixels };
        progress('capturing', Math.min(99, Math.round((covered / metrics.height) * 100)), frames);
      } finally {
        bitmap.close?.();
      }
      if (covered >= metrics.height - 0.5) {
        if (final) break;
        final = true;
        y = metrics.y;
      } else {
        final = false;
        y = Math.max(0, covered - Math.floor(metrics.viewportHeight * 0.15));
        if (y <= metrics.y && covered < metrics.height) throw new ScreenshotError('unsupported');
      }
    }
    return { width, height: Math.round(covered * scale) };
  } finally {
    await page({ action: 'finish' }).catch(() => {});
  }
}
