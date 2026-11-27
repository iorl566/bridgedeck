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
 * from the same color; callers that need distinct colors for a window pass the
 * colors already taken and the next free slot is used instead.
 *
 * @param {string} sessionId
 * @param {{ color?: string | null } | null} [controller]
 * @param {string[]} [used]
 * @returns {string} `#rrggbb`
 */
export function controllerColor(sessionId, controller = null, used = []) {
  const explicit = controller && typeof controller.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(controller.color)
    ? controller.color
    : '';
  if (explicit) return explicit;
  const text = String(sessionId || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  const usedColors = new Set((Array.isArray(used) ? used : []).map((item) => String(item).toLowerCase()));
  const start = hash % COLORS.length;
  for (let offset = 0; offset < COLORS.length; offset += 1) {
    const candidate = COLORS[(start + offset) % COLORS.length];
    if (!usedColors.has(candidate)) return candidate;
  }
  return COLORS[start];
}
