import { ScreenshotError } from './types.js';
import { frameSignature } from './frame-freshness.js';

/**
 * Arguments for one manual capture pass.
 * @typedef {object} ManualCaptureDeps
 * @property {() => Promise<ImageBitmap>} screenshot Capture the current viewport.
 * @property {(bitmap: ImageBitmap, width: number, sourceY: number, targetY: number, height: number) => Promise<void>} write Store an image slice.
 * @property {() => Promise<void>} checkpoint Pause and cancellation barrier.
 * @property {() => boolean} finished Reports whether the user accepted the image.
 * @property {AbortSignal} signal Cancels the pass.
 * @property {boolean} visible True for visible-mode captures that stop after one frame.
 * @property {(frames: number, notice?: 'alignment') => void} progress Publishes progress.
 */

/** Reference-compatible name for the downsampled frame signature. */
export const signature = frameSignature;

/** Image-only alignment. Textured patches vote on one vertical displacement;
 * an animated ad or stationary sidebar cannot spoil the other patches' votes.
 * A competing displacement still rejects the frame instead of guessing.
 * @param {import('./frame-freshness.js').FrameSignature} a Previous exposure.
 * @param {import('./frame-freshness.js').FrameSignature} b Current exposure.
 * @returns {{ offset: number, footer: number } | null} Displacement to append, or null when ambiguous.
 */
export function alignFrames(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new ScreenshotError('changed');
  const h = a.height;
  const difference = (ay, by) => {
    let total = 0;
    for (let x = 6; x < 90; x += 3) {
      const at = (ay * 96 + x) * 4;
      const bt = (by * 96 + x) * 4;
      for (let c = 0; c < 3; c += 1) total += Math.abs(a.pixels[at + c] - b.pixels[bt + c]);
    }
    return total / 84;
  };
  let stationary = 0;
  for (let y = 0; y < h; y += 8) stationary += difference(y, y);
  if (stationary / Math.ceil(h / 8) < 0.15) return { offset: 0, footer: 0 };
  let top = 0;
  let footer = 0;
  while (top < h * 0.35 && difference(top, top) < 0.5) top += 1;
  while (footer < h * 0.35 && difference(h - footer - 1, h - footer - 1) < 0.5) footer += 1;
  const end = h - footer;
  const bands = 7;
  const texture = (frame) => {
    const result = new Uint8Array(h * bands);
    for (let y = 0; y < h; y += 1) {
      for (let band = 0; band < bands; band += 1) {
        const x = 6 + band * 12;
        const reference = (Math.max(0, y - 2) * 96 + x) * 4;
        for (let dx = 0; dx < 12; dx += 3) {
          for (let c = 0; c < 3; c += 1) {
            if (Math.abs(frame.pixels[(y * 96 + x + dx) * 4 + c] - frame.pixels[reference + c]) >= 2) result[y * bands + band] = 1;
          }
        }
      }
    }
    return result;
  };
  const texturedA = texture(a);
  const texturedB = texture(b);
  const patchError = (ay, by, band) => {
    let error = 0;
    for (let x = 6 + band * 12; x < 18 + band * 12; x += 3) {
      const at = (ay * 96 + x) * 4;
      const bt = (by * 96 + x) * 4;
      for (let c = 0; c < 3; c += 1) error += Math.abs(a.pixels[at + c] - b.pixels[bt + c]);
    }
    return error / 12;
  };
  const stationaryBands = new Set();
  for (let band = 0; band < bands; band += 1) {
    let count = 0;
    let unchanged = 0;
    for (let y = top; y < end; y += 4) {
      if (!texturedA[y * bands + band] && !texturedB[y * bands + band]) continue;
      count += 1;
      if (patchError(y, y, band) < 0.5) unchanged += 1;
    }
    if (count >= 8 && unchanged / count >= 0.9) stationaryBands.add(band);
  }
  if (stationaryBands.size === bands) return { offset: 0, footer: 0 };
  const scores = [];
  const seam = Math.max(top, Math.floor(h * 0.1));
  const minimumOverlap = Math.max(48, seam - top + 8);
  const maximum = end - top - minimumOverlap;
  for (let offset = 0; offset <= maximum; offset += 1) {
    let quality = 0;
    let matches = 0;
    let rows = 0;
    const votes = new Uint8Array(bands);
    const stride = Math.max(1, Math.ceil((end - top - offset) / 64));
    for (let y = top; y < end - offset; y += stride) {
      rows += 1;
      for (let band = 0; band < bands; band += 1) {
        if (stationaryBands.has(band)) continue;
        if (!texturedA[(y + offset) * bands + band] || !texturedB[y * bands + band]) continue;
        const error = patchError(y + offset, y, band);
        if (error > 8) continue;
        matches += 1;
        votes[band] += 1;
        quality += 1 / (1 + error / 2);
      }
    }
    if (matches >= 16 && votes.filter((count) => count >= 4).length >= 2) scores.push({ offset, quality: quality / (rows * (bands - stationaryBands.size)) });
  }
  scores.sort((x, y) => y.quality - x.quality);
  const best = scores[0];
  if (!best || best.quality < 0.08) return null;
  const alternative = scores.find((candidate) => Math.abs(candidate.offset - best.offset) > 3);
  if (alternative && best.quality <= alternative.quality * 1.15 + 0.01) return null;
  if (!best.offset) return { offset: 0, footer: 0 };
  return { offset: best.offset, footer: h - seam - best.offset };
}

/**
 * Extend the image on every exposure until the user accepts it or a
 * single-frame mode ends.
 *
 * A rejected alignment is retried against the last accepted exposure, so a
 * frame caught mid-scroll never enters the image.
 *
 * @param {ManualCaptureDeps} deps Injected source and storage surfaces.
 * @returns {Promise<{ width: number, height: number }>} Stored image size.
 */
export async function captureManual(deps) {
  let previous;
  let height = 0;
  let width = 0;
  let frames = 0;
  let misses = 0;
  do {
    await deps.checkpoint();
    deps.signal.throwIfAborted();
    if (height && deps.finished()) break;
    const bitmap = await deps.screenshot();
    try {
      deps.signal.throwIfAborted();
      const current = bitmap.signature ?? frameSignature(bitmap);
      if (!previous) {
        width = bitmap.width;
        await deps.write(bitmap, width, 0, 0, bitmap.height);
        height = bitmap.height;
      } else {
        const match = alignFrames(previous, current);
        if (!match) {
          deps.progress(frames, ++misses >= 2 ? 'alignment' : undefined);
          continue;
        }
        misses = 0;
        if (!match.offset) { deps.progress(frames); continue; }
        await deps.write(bitmap, width, bitmap.height - match.footer - match.offset, height - match.footer, match.offset + match.footer);
        height += match.offset;
      }
      previous = current;
      deps.progress(++frames);
    } finally {
      bitmap.close?.();
    }
  } while (!deps.visible);
  return { width, height };
}
