/**
 * Caller-supplied display labels; these never establish control authority.
 *
 * The controller name shown in the overlay and the session list is presentation
 * data only. Authority remains the session id and the transport credentials;
 * anything accepted here is untrusted text that is length-bounded and stripped
 * of control characters before it is stored or rendered.
 *
 * @typedef {object} ControllerInfo
 * @property {string} name  Non-empty label, at most 80 code points.
 * @property {string | null} [project]  Optional project label, at most 120 code points.
 * @property {string | null} [color]  Optional `#rrggbb` accent for the session.
 */

/**
 * Validate an untrusted label object.
 *
 * Rejects non-objects, arrays, blank or over-long labels, labels containing
 * C0/C1 control characters, and colors that are not a six-digit hex triplet.
 * `project` and `color` may be absent or `null`.
 *
 * @param {unknown} value  Candidate controller info from a peer or storage.
 * @returns {boolean} True when `value` is a valid {@link ControllerInfo}.
 */
export function isControllerInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const label = (text, max) => typeof text === 'string' && text.trim().length > 0 && Array.from(text).length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  return label(value.name, 80)
    && (value.project == null || label(value.project, 120))
    && (value.color == null || (typeof value.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.color)));
}

// Color complements the visible session ID; it is never the only identifier.
const COLORS = ['#2563eb', '#9333ea', '#0f766e', '#be185d', '#b45309', '#4d7c0f'];

/**
 * Pick a stable color for the session, preferring the caller's valid color and
 * avoiding colors already in use.
 *
 * The session id is hashed into the palette so the same session always starts
 * at the same entry; the palette is then walked in order and the first color not
 * already taken is returned. When every color is taken, the hashed entry is
 * reused rather than failing, so a color is always produced.
 *
 * @param {string} sessionId  Stable per-session identifier used for hashing.
 * @param {ControllerInfo} [controller]  Caller labels; a valid `color` wins.
 * @param {Iterable<string | null | undefined>} [usedColors]  Colors already assigned.
 * @returns {string} Lowercase-insensitive `#rrggbb` accent for this session.
 */
export function controllerColor(sessionId, controller, usedColors = []) {
  if (controller?.color && /^#[0-9a-fA-F]{6}$/.test(controller.color)) return controller.color;
  let hash = 0;
  for (const char of sessionId) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  const used = new Set(Array.from(usedColors, (color) => color?.toLowerCase()));
  const start = hash % COLORS.length;
  return Array.from({ length: COLORS.length }, (_, offset) => COLORS[(start + offset) % COLORS.length]).find((color) => !used.has(color)) ?? COLORS[start];
}
