/**
 * @typedef {object} RecordingDraftStep
 * @property {string} op
 * @property {string} [key]
 * @property {Array<'alt' | 'ctrl' | 'meta' | 'shift'>} [modifiers]
 * @property {string} [url]
 * @property {string} [pageUrl]
 */

const CLIPBOARD_KEYS = new Set(['a', 'c', 'v', 'x', 'A', 'C', 'V', 'X']);
const MODIFIER_ONLY_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS', 'Hyper', 'Super']);

/**
 * @param {string} key
 * @param {Array<'alt' | 'ctrl' | 'meta' | 'shift'>} [modifiers]
 * @returns {boolean}
 */
export function shouldRecordPress(key, modifiers) {
  if (MODIFIER_ONLY_KEYS.has(key)) return false;
  const mods = modifiers ?? [];
  const hasCtrlOrMeta = mods.includes('ctrl') || mods.includes('meta');
  if (hasCtrlOrMeta && CLIPBOARD_KEYS.has(key)) return false;
  if (key === 'Enter' || key === 'Escape') return true;
  return false;
}

/**
 * @param {RecordingDraftStep} step
 * @returns {boolean}
 */
export function shouldIncludeDraft(step) {
  return step.op !== 'press' || shouldRecordPress(step.key, step.modifiers);
}

/**
 * @param {RecordingDraftStep[]} drafts
 * @param {string} [explicitStartUrl]
 * @param {string} [fallbackUrl]
 * @returns {string}
 */
export function resolveDraftStartUrl(drafts, explicitStartUrl, fallbackUrl) {
  if (explicitStartUrl) return explicitStartUrl;
  const navigation = drafts.find((step) => step.op === 'navigate');
  if (navigation) return navigation.url;
  return drafts.find((step) => step.pageUrl)?.pageUrl ?? fallbackUrl ?? 'about:blank';
}
