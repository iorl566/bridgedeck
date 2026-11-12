/**
 * Build a semantic capture descriptor for an interacted element.
 *
 * Recorded steps are read as a narrative: each click must say what to look for
 * on screen, usually a short visible name. Tag-only noise such as a bare
 * `div` target is useless and must not be produced, so every resolver here
 * refuses to fall back to an anonymous layout element.
 *
 * @typedef {object} CaptureTargetDescriptor
 * @property {string} [role]  Effective role, explicit or inferred from the tag.
 * @property {string} [name]  Visible accessible name, truncated for display.
 * @property {string} tag  Lowercase tag name.
 * @property {string} [name_attr]  Form control name, when the element has one.
 * @property {string} [placeholder]  Placeholder text of a text field, when present.
 * @property {string} [nearby_label]  Label text near a form control, when it adds information.
 */

/** Max length for a label that is still a useful “find this on screen” hint. */
const ACTIONABLE_LABEL_MAX = 48;

/**
 * Collapse all runs of whitespace and trim the result.
 *
 * @param {string} value  Raw text.
 * @returns {string} Single-spaced, trimmed text.
 */
function normalizeWhitespace(value) { return value.replace(/\s+/g, ' ').trim(); }

/**
 * Normalize and shorten text for display, adding an ellipsis when cut.
 *
 * @param {string} value  Raw text.
 * @param {number} [max]  Maximum output length including the ellipsis; defaults to 80.
 * @returns {string} Display-safe text no longer than `max`.
 */
function truncate(value, max = 80) {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Whether text is a short, human hint that can later be found in a snapshot.
 *
 * Rejects blank text, text longer than the cap, and bare URLs, because a URL is
 * not something a reader can locate on screen.
 *
 * @param {string} name  Candidate label.
 * @param {number} [max]  Maximum length; defaults to {@link ACTIONABLE_LABEL_MAX}.
 * @returns {boolean} True when the label is actionable.
 */
export function isActionableLabel(name, max = ACTIONABLE_LABEL_MAX) {
  const trimmed = normalizeWhitespace(name);
  if (!trimmed) return false;
  if (trimmed.length > max) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return true;
}

/**
 * Read the text of the elements named by `aria-labelledby`.
 *
 * The attribute is a whitespace-separated list of ids; missing ids contribute
 * nothing and the remaining texts are joined in order.
 *
 * @param {Element} el  Element carrying the attribute.
 * @returns {string | null} Joined label text, or null when nothing is found.
 */
function labelledByText(el) {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return null;
  const parts = ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').map(normalizeWhitespace).filter(Boolean);
  return parts.length ? truncate(parts.join(' ')) : null;
}

/**
 * Read the text of a label associated through the `for` attribute.
 *
 * Only HTMLElements with an id can have such a label.
 *
 * @param {Element} el  Form control.
 * @returns {string | null} Label text, or null when there is none.
 */
function associatedLabelText(el) {
  if (!(el instanceof HTMLElement) || !el.id) return null;
  const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  if (!label) return null;
  const text = normalizeWhitespace(label.textContent ?? '');
  return text ? truncate(text) : null;
}

/**
 * Read the text of a label that wraps the control.
 *
 * A clone is used so the control's own value or text is removed before reading;
 * otherwise a wrapped input would contribute its current value as its label.
 *
 * @param {Element} el  Form control inside a label.
 * @returns {string | null} Label text, or null when there is none.
 */
function wrappingLabelText(el) {
  const label = el.closest('label');
  if (!label) return null;
  const clone = label.cloneNode(true);
  for (const control of clone.querySelectorAll('input,textarea,select,button')) control.remove();
  const text = normalizeWhitespace(clone.textContent ?? '');
  return text ? truncate(text) : null;
}

/**
 * Read a text field's placeholder, or any element's title.
 *
 * @param {Element} el  Candidate element.
 * @returns {string | null} Placeholder or title text, or null when absent.
 */
function placeholderOrTitle(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = normalizeWhitespace(el.placeholder);
    if (ph) return truncate(ph);
  }
  const title = normalizeWhitespace(el.getAttribute('title') ?? '');
  return title ? truncate(title) : null;
}

/**
 * Read an element's own text content.
 *
 * Text fields are excluded because their text is whatever the user typed, which
 * is not a name.
 *
 * @param {Element} el  Candidate element.
 * @returns {string | null} Truncated text, or null when there is none.
 */
function ownText(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return null;
  const text = normalizeWhitespace(el.textContent ?? '');
  return text ? truncate(text) : null;
}

/**
 * Pick a compact name for a link, preferring a heading or image alt.
 *
 * A link's full text can include citations, scripts and URLs. The clone removes
 * those, and any remaining URL is stripped so the name is readable text.
 *
 * @param {Element} el  Link element.
 * @returns {string | null} Compact link name, or null when nothing remains.
 */
function compactLinkName(el) {
  const heading = el.querySelector('h1, h2, h3, h4');
  if (heading) {
    const text = normalizeWhitespace(heading.textContent ?? '');
    if (text) return truncate(text);
  }
  const img = el.querySelector('img[alt]');
  if (img instanceof HTMLImageElement) {
    const alt = normalizeWhitespace(img.alt);
    if (alt) return truncate(alt);
  }
  const clone = el.cloneNode(true);
  for (const junk of clone.querySelectorAll('cite, script, style, svg, noscript')) junk.remove();
  const text = normalizeWhitespace(clone.textContent ?? '');
  if (!text) return null;
  const withoutUrl = text.replace(/https?:\/\/\S+/g, '').trim();
  return truncate(withoutUrl || text);
}

/**
 * Visible accessible name, in preference order for a readable target hint.
 *
 * The order mirrors how assistive technology resolves names: explicit aria
 * label, then labelledby references, then an associated label, then a wrapping
 * label, then image alt text, then placeholder or title, then a compact name for
 * links, then the element's own text, and finally a button's value. The first
 * non-empty result wins.
 *
 * @param {Element} el  Element to name.
 * @returns {string | undefined} Display name, or undefined when none is visible.
 */
export function accessibleName(el) {
  const ariaLabel = normalizeWhitespace(el.getAttribute('aria-label') ?? '');
  if (ariaLabel) return truncate(ariaLabel);
  const labelledBy = labelledByText(el);
  if (labelledBy) return labelledBy;
  const forLabel = associatedLabelText(el);
  if (forLabel) return forLabel;
  const wrapLabel = wrappingLabelText(el);
  if (wrapLabel) return wrapLabel;
  const alt = el instanceof HTMLImageElement ? normalizeWhitespace(el.alt) : normalizeWhitespace(el.getAttribute('alt') ?? '');
  if (alt) return truncate(alt);
  const ph = placeholderOrTitle(el);
  if (ph) return ph;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || el.getAttribute('role') === 'link') {
    const linkName = compactLinkName(el);
    if (linkName) return linkName;
  }
  const text = ownText(el);
  if (text) return text;
  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
    const value = normalizeWhitespace(el.value);
    if (value && (el instanceof HTMLButtonElement || el.type === 'submit' || el.type === 'reset' || el.type === 'button')) return truncate(value);
  }
  return undefined;
}

/**
 * CSS selector matching elements that are natively interactive.
 *
 * This is the fast path for target resolution; elements that only look
 * clickable are handled by heuristic checks afterwards.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'summary', 'select', 'input:not([type="hidden"])', 'textarea',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="treeitem"]',
  '[role="combobox"]', '[contenteditable]:not([contenteditable="false"])',
].join(',');

/** Roles that imply interactivity even without a matching tag. */
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'combobox', 'textbox', 'searchbox', 'slider']);

/**
 * Heuristically decide whether an element can be clicked or focused.
 *
 * Besides native interactive elements, a non-negative tab index, a pointer
 * cursor, or a class containing a button/link-ish word is enough. A failed
 * style lookup (for example on a detached node) is ignored rather than treated
 * as non-interactive.
 *
 * @param {Element} el  Candidate element.
 * @returns {boolean} True when the element looks clickable.
 */
function looksClickable(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.matches(INTERACTIVE_SELECTOR)) return true;
  const role = normalizeWhitespace(el.getAttribute('role') ?? '').toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.tabIndex >= 0) return true;
  try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch { /* detached */ }
  const cls = typeof el.className === 'string' ? el.className : '';
  return /\b(btn|button|link|clickable|action)\b/i.test(cls);
}

/**
 * Resolve the element a click should describe. Never falls back to an
 * anonymous layout element.
 *
 * The nearest native interactive ancestor wins. Otherwise the tree is walked up
 * to eight levels looking for the first ancestor that both has an actionable
 * name and looks clickable, which covers controls built from plain elements.
 *
 * @param {Element} target  Event target.
 * @returns {Element | null} Element to describe, or null when none qualifies.
 */
export function resolveClickableElement(target) {
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  if (interactive instanceof Element) return interactive;
  let node = target;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 8) {
    const name = accessibleName(node);
    if (name && isActionableLabel(name) && looksClickable(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Resolve the element a hover should describe.
 *
 * A hover has the same target rules as a click, but does not require a name: an
 * unnamed clickable ancestor is still a useful hover target.
 *
 * @param {Element} target  Event target.
 * @returns {Element | null} Element to hover, or null when none qualifies.
 */
export function resolveHoverElement(target) {
  const clickable = resolveClickableElement(target);
  if (clickable) return clickable;
  let node = target;
  let depth = 0;
  while (node && node !== document.body && node !== document.documentElement && depth < 8) {
    if (looksClickable(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * Teachable clicks need a visible name, or at least a form field name for
 * checkbox, radio and input targets.
 *
 * @param {CaptureTargetDescriptor} target  Descriptor to judge.
 * @returns {boolean} True when the descriptor identifies something findable.
 */
export function isMeaningfulClickTarget(target) {
  const name = target.name?.trim();
  if (name && isActionableLabel(name)) return true;
  if ((target.role === 'checkbox' || target.role === 'radio' || target.tag === 'input') && target.name_attr) return true;
  return false;
}

/**
 * Infer an ARIA-like role for an element.
 *
 * An explicit role always wins. Otherwise common tags map to their conventional
 * roles, contenteditable regions count as textboxes, and inputs map by type.
 *
 * @param {Element} el  Element to classify.
 * @returns {string | undefined} Role name, or undefined when none applies.
 */
export function inferRole(el) {
  const explicit = normalizeWhitespace(el.getAttribute('role') ?? '').toLowerCase();
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (tag === 'summary') return 'button';
  if (el instanceof HTMLElement && (el.isContentEditable || el.contentEditable === 'true')) return 'textbox';
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return undefined;
}

/**
 * Find label text near a fillable control.
 *
 * Only fillable controls are considered; for a button or link a previous layout
 * sibling would describe the neighbour rather than the control. Label lookup
 * tries the `for` attribute, then a wrapping label, then a preceding text-like
 * sibling short enough to be a label.
 *
 * @param {Element} el  Candidate form control.
 * @returns {string | undefined} Nearby label text, or undefined.
 */
function nearbyLabelText(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return undefined;
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = byFor ? normalizeWhitespace(byFor.textContent ?? '') : '';
    if (text) return truncate(text, ACTIONABLE_LABEL_MAX);
  }
  const wrapped = el.closest('label');
  if (wrapped) {
    const clone = wrapped.cloneNode(true);
    for (const control of clone.querySelectorAll('input, textarea, select, button')) control.remove();
    const text = normalizeWhitespace(clone.textContent ?? '');
    if (text) return truncate(text, ACTIONABLE_LABEL_MAX);
  }
  const prev = el.previousElementSibling;
  if (prev && /^(LABEL|SPAN|DIV|P|DT)$/i.test(prev.tagName)) {
    const text = normalizeWhitespace(prev.textContent ?? '');
    if (text && text.length <= ACTIONABLE_LABEL_MAX) return text;
  }
  return undefined;
}

/**
 * Describe one element for a captured step.
 *
 * Optional fields are omitted rather than set to undefined, so the descriptor
 * serializes compactly. `nearby_label` is only added when it says something the
 * accessible name does not, which keeps the two from duplicating each other.
 *
 * @param {Element} el  Element to describe.
 * @returns {CaptureTargetDescriptor} Semantic descriptor.
 */
export function describeTarget(el) {
  const tag = el.tagName.toLowerCase();
  const role = inferRole(el);
  const name = accessibleName(el);
  const nameAttr = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement
    ? normalizeWhitespace(el.name) || undefined
    : normalizeWhitespace(el.getAttribute('name') ?? '') || undefined;
  const placeholder = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? normalizeWhitespace(el.placeholder) || undefined
    : normalizeWhitespace(el.getAttribute('placeholder') ?? '') || undefined;
  const nearby = nearbyLabelText(el);
  return {
    tag,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(nameAttr ? { name_attr: nameAttr } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(nearby && nearby !== name ? { nearby_label: nearby } : {}),
  };
}

/**
 * Describe the element behind an event for a recorded click.
 *
 * A meaningful descriptor is returned directly. Otherwise a natively
 * interactive element with any non-URL name is still accepted: a control's own
 * long name, such as a headline link, identifies it even when it exceeds the
 * short-label cap. Everything else yields null, so an anonymous click is not
 * recorded as a step.
 *
 * @param {EventTarget | null} target  Raw event target.
 * @returns {CaptureTargetDescriptor | null} Descriptor, or null when unusable.
 */
export function describeEventTarget(target) {
  if (!(target instanceof Element)) return null;
  const clickable = resolveClickableElement(target);
  if (!clickable) return null;
  const desc = describeTarget(clickable);
  if (isMeaningfulClickTarget(desc)) return desc;
  // The length cap keeps layout text from naming a guessed target. A control's own long
  // name, such as a headline link or a step-by-step button, still identifies it.
  return clickable.matches(INTERACTIVE_SELECTOR) && isActionableLabel(desc.name ?? '', Infinity) ? desc : null;
}
