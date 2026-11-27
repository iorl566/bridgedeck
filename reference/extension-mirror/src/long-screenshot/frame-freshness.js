/**
 * Downsampled image used for frame comparison.
 * @typedef {object} FrameSignature
 * @property {number} width Source pixel width.
 * @property {number} height Source pixel height.
 * @property {Uint8ClampedArray} pixels 96-pixel-wide RGBA rows.
 */

/** Reject positive evidence of a stale exposure, not ambiguous/blank content.
 * Compare the known document displacement against stationary textured patches.
 * Keep signatures only; no full-image buffers or offset search are needed.
 * @param {FrameSignature} a Previous exposure.
 * @param {FrameSignature} b Current exposure.
 * @param {number} offset Known document displacement in signature rows.
 * @returns {boolean} True when the current exposure shows the previous viewport.
 */
export function isStaleFrame(a, b, offset) {
  if (a.width !== b.width || a.height !== b.height || offset < 4 || offset > a.height - 32) return false;
  let stale = 0;
  let scrolling = 0;
  const bands = new Set();
  const error = (ay, by, x) => {
    let sum = 0;
    for (let dx = 0; dx < 8; dx += 1) {
      for (let c = 0; c < 3; c += 1) {
        sum += Math.abs(a.pixels[(ay * 96 + x + dx) * 4 + c] - b.pixels[(by * 96 + x + dx) * 4 + c]);
      }
    }
    return sum / 24;
  };
  for (let y = 8; y < a.height - offset - 8; y += 4) {
    for (let x = 24; x <= 64; x += 8) {
      const stationary = error(y, y, x);
      const shifted = error(y + offset, y, x);
      if (shifted < 3 && stationary > 12) scrolling += 1;
      else if (stationary < 0.5 && shifted > 12) {
        stale += 1;
        bands.add(x);
      }
    }
  }
  return stale >= 24 && bands.size >= 2 && scrolling === 0;
}

/**
 * @param {number} width Source pixel width.
 * @param {number} height Source pixel height.
 * @param {Uint8ClampedArray} [pixels] Precomputed rows; defaults to transparent black.
 * @returns {FrameSignature}
 */
export function signature(width, height, pixels) {
  return { width, height, pixels: pixels ?? new Uint8ClampedArray(width * height * 4) };
}

/**
 * @param {ImageBitmap} bitmap Captured exposure.
 * @param {{ OffscreenCanvas?: typeof OffscreenCanvas }} [deps] Canvas override for tests.
 * @returns {FrameSignature}
 */
export function frameSignature(bitmap, deps = {}) {
  const Canvas = deps.OffscreenCanvas ?? globalThis.OffscreenCanvas;
  if (!Canvas) {
    if (bitmap.pixels) return signature(bitmap.width, bitmap.height, bitmap.pixels);
    throw new Error('OffscreenCanvas is unavailable');
  }
  const pixels = new Uint8ClampedArray(96 * bitmap.height * 4);
  const canvas = new Canvas(96, Math.min(512, bitmap.height));
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('captureFailed');
    for (let y = 0; y < bitmap.height; y += canvas.height) {
      const height = Math.min(canvas.height, bitmap.height - y);
      ctx.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, 96, height);
      pixels.set(ctx.getImageData(0, 0, 96, height).data, y * 96 * 4);
    }
    return { width: bitmap.width, height: bitmap.height, pixels };
  } finally {
    canvas.width = canvas.height = 1;
  }
}
