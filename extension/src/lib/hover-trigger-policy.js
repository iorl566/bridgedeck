/**
 * Heuristics that decide whether hovering an element is likely to reveal a
 * surface (menu, popover or tooltip) worth probing during capture.
 *
 * The policy is deliberately conservative: hovering almost anything can change
 * the page, so a candidate must both look interactive and carry evidence that a
 * surface is attached to it. Unhoverable controls (text fields, selects,
 * contenteditable regions) are rejected outright, as are elements that are not
 * actually visible. Surviving candidates are scored; the score and its reasons
 * are returned so callers can log why a hover was or was not attempted.
 *
 * @typedef {object} HoverTriggerRect
 * @property {number} x  Left edge in viewport coordinates.
 * @property {number} y  Top edge in viewport coordinates.
 * @property {number} w  Width in pixels.
 * @property {number} h  Height in pixels.
 *
 * @typedef {object} HoverTriggerSignals
 * @property {string} tag  Lowercase tag name of the candidate.
 * @property {string} [role]  Explicit ARIA role, if any.
 * @property {string} [label]  Accessible name or text content.
 * @property {Record<string, string | undefined>} [attrs]  Attribute names to values.
 * @property {HoverTriggerRect | null} [rect]  Viewport rectangle; required for eligibility.
 * @property {string} [cursor]  Computed cursor value.
 * @property {string} [pointerEvents]  Computed pointer-events value.
 * @property {boolean} [hasGraphicDescendant]  Whether the candidate contains an image or icon.
 * @property {boolean} [cssHoverMatch]  Whether the candidate itself declares a hover style.
 *
 * @typedef {object} HoverTriggerDecision
 * @property {boolean} eligible  True when the score reaches the threshold.
 * @property {number} score  Accumulated signal score.
 * @property {string[]} reasons  Human-readable signal names, in the order scored.
 */

/** Minimum score for a hover probe. */
const HOVER_TRIGGER_MIN_SCORE = 45;
/** Attribute text that suggests a popup surface is attached. */
const HOVER_POPUP_SIGNAL_RE = /(menu|dropdown|popover|popup|avatar|profile|account|user|more|ellipsis|caret)/;
/** Class text that identifies a text navigation item rather than a surface trigger. */
const HOVER_TEXT_ITEM_RE = /(^|[\s_-])(dropdown-item|menu-item|context-menu-item|option)($|[\s_-])/;

/**
 * Read one attribute, case-insensitively.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @param {string} name  Attribute name without case requirements.
 * @returns {string | undefined} Attribute value when present.
 */
function attr(signals, name) { return signals.attrs?.[name.toLowerCase()]; }

/**
 * Reject controls where a hover would be meaningless or destructive.
 *
 * Text fields, selects and options are rejected because hovering them can
 * trigger autocomplete or value commitment. Contenteditable regions, disabled,
 * inert and aria-disabled elements are rejected because they either accept
 * text input or cannot open a surface at all.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @returns {boolean} True when hovering must not be attempted.
 */
export function isUnsafeHoverTrigger(signals) {
  const tag = signals.tag.toLowerCase();
  if (['input', 'textarea', 'select', 'option'].includes(tag)) return true;
  if ((attr(signals, 'contenteditable') ?? '').toLowerCase() === 'true') return true;
  if (attr(signals, 'disabled') !== undefined || attr(signals, 'inert') !== undefined) return true;
  return (attr(signals, 'aria-disabled') ?? '').toLowerCase() === 'true';
}

/**
 * Whether any attribute text suggests a popup surface.
 *
 * Ids, classes, test hooks, labels, popup wiring attributes, titles and the
 * label of a button role are concatenated and matched against a small keyword
 * set. The match is intentionally fuzzy: it only contributes evidence, it never
 * makes a candidate eligible on its own.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @returns {boolean} True when a popup-related keyword appears.
 */
export function hasHoverPopupSignal(signals) {
  const attrs = signals.attrs ?? {};
  const haystack = [attrs.id, attrs.class, attrs['data-testid'], attrs['data-test'], attrs['data-cy'], attrs['aria-label'], attrs['aria-haspopup'], attrs['aria-controls'], attrs.title, signals.role === 'button' ? signals.label : undefined]
    .filter(Boolean).join(' ').toLowerCase();
  return HOVER_POPUP_SIGNAL_RE.test(haystack);
}

/**
 * Whether the element declares a strong "opens something" signal.
 *
 * A matching hover style, an aria-haspopup attribute, or an explicitly
 * collapsed aria-expanded state are all treated as strong evidence, because
 * each one is usually authored on purpose.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @returns {boolean} True when a strong expansion signal is present.
 */
export function hasStrongHoverExpansionSignal(signals) {
  return signals.cssHoverMatch === true || attr(signals, 'aria-haspopup') !== undefined || (attr(signals, 'aria-expanded') ?? '').toLowerCase() === 'false';
}

/**
 * Whether the element itself behaves like an interactive control.
 *
 * Native interactive tags and roles are accepted, as are tab stops, a pointer
 * cursor, inline click/hover handlers, and the popup wiring attributes. This
 * says the element can be interacted with, not that it opens a surface.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @returns {boolean} True when the element looks directly interactive.
 */
export function hasDirectHoverInteractiveSignal(signals) {
  const tag = signals.tag.toLowerCase();
  const role = (signals.role ?? '').toLowerCase();
  return ['button', 'a', 'summary'].includes(tag)
    || ['button', 'link', 'menuitem', 'tab', 'combobox'].includes(role)
    || attr(signals, 'tabindex') !== undefined
    || signals.cursor === 'pointer'
    || attr(signals, 'onclick') !== undefined
    || attr(signals, 'onmouseenter') !== undefined
    || attr(signals, 'onmouseover') !== undefined
    || attr(signals, 'aria-haspopup') !== undefined
    || attr(signals, 'aria-expanded') === 'false';
}

/**
 * Score one hover candidate.
 *
 * Hard exclusions run first and produce `eligible: false` with a zero score and
 * no reasons: missing or degenerate rectangle, oversized area, transparent
 * pointer events, hidden/inert/aria-hidden state, or an unsafe control. A
 * candidate must then be both directly interactive and carry surface evidence;
 * otherwise it is rejected with no score.
 *
 * Scoring weights: aria-haspopup 80, collapsed 55, popup keyword 45, CSS hover
 * 40, icon-only 40, button 30, pointer cursor 25, top bar 25, compact 20.
 * Eligibility requires the total to reach the module threshold.
 *
 * @param {HoverTriggerSignals} signals  Candidate signals.
 * @returns {HoverTriggerDecision} Eligibility, score and contributing reasons.
 */
export function evaluateHoverTrigger(signals) {
  const rect = signals.rect;
  // Hard exclusions: anything not visible and hoverable is skipped unscore.
  if (!rect || rect.w <= 0 || rect.h <= 0 || signals.pointerEvents === 'none' || attr(signals, 'hidden') !== undefined || attr(signals, 'inert') !== undefined || (attr(signals, 'aria-hidden') ?? '').toLowerCase() === 'true' || isUnsafeHoverTrigger(signals)) {
    return { eligible: false, score: 0, reasons: [] };
  }
  const area = rect.w * rect.h;
  // Very large regions are page chrome, not triggers; they would also make the
  // hover probe land on an arbitrary point inside them.
  if (area <= 0 || area > 160_000) return { eligible: false, score: 0, reasons: [] };

  const reasons = [];
  let score = 0;
  const tag = signals.tag.toLowerCase();
  const role = (signals.role ?? '').toLowerCase();
  const label = signals.label?.trim();
  const graphic = signals.hasGraphicDescendant === true;
  const directInteractive = hasDirectHoverInteractiveSignal(signals);
  const popupSignal = hasHoverPopupSignal(signals);
  // Text navigation items (menu entries, links) do not open a surface; a popup
  // keyword on them is coincidental.
  const isTextNavigationItem = (tag === 'a' || tag === 'li' || role === 'link' || role === 'option' || role.startsWith('menuitem') || HOVER_TEXT_ITEM_RE.test(attr(signals, 'class') ?? '')) && !graphic && !!label && label.toLowerCase() !== 'image';
  // A graphic control in the top bar is usually a menu or account trigger.
  const compactTopbarIcon = (role === 'button' || role === 'link' || tag === 'button' || tag === 'a') && graphic && rect.y < 120 && rect.w <= 96 && rect.h <= 96 && (!label || label.toLowerCase() === 'image');
  const surfaceTriggerEvidence = (popupSignal && !isTextNavigationItem) || compactTopbarIcon || hasStrongHoverExpansionSignal(signals);
  if (!directInteractive || !surfaceTriggerEvidence) return { eligible: false, score: 0, reasons: [] };

  if (attr(signals, 'aria-haspopup') !== undefined) { score += 80; reasons.push('aria-haspopup'); }
  if ((attr(signals, 'aria-expanded') ?? '').toLowerCase() === 'false') { score += 55; reasons.push('collapsed'); }
  if (popupSignal) { score += 45; reasons.push('popup-signal'); }
  if (tag === 'button' || role === 'button') { score += 30; reasons.push('button'); }
  if (signals.cursor === 'pointer') { score += 25; reasons.push('pointer'); }
  if (graphic && (!label || label.toLowerCase() === 'image')) { score += 40; reasons.push('icon-only'); }
  if (rect.y < 120) { score += 25; reasons.push('topbar'); }
  if (rect.w <= 80 && rect.h <= 80) { score += 20; reasons.push('compact'); }
  if (signals.cssHoverMatch) { score += 40; reasons.push('css-hover'); }
  return { eligible: score >= HOVER_TRIGGER_MIN_SCORE, score, reasons };
}
