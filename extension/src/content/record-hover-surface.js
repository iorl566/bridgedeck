/** Hover-surface recognition used by the record capture loop. */
/** @typedef {object} HoverSurfaceDecision */
/** @typedef {object} HoverSurfaceContext */
/** @typedef {object} HoverSurfaceState */
/**
 * @typedef {object} HoverSurfaceEnvironment
 * @property {Document} [document]
 * @property {Element} [body]
 * @property {Element} [documentElement]
 * @property {Element} [window]
 * @property {Function} [getComputedStyle]
 * @property {Function} [isHTMLElement]
 * @property {number} [innerWidth]
 * @property {number} [innerHeight]
 */

const HOVER_SURFACE_SELECTOR = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="tooltip"]',
  '[aria-modal="true"]',
  '[data-popper-placement]',
  '[data-floating-ui-placement]',
  '[data-headlessui-state]',
  '[data-radix-popper-content-wrapper]',
].join(',');

const HOVER_SURFACE_WORD_RE = /(^|[^a-z0-9])(dropdown-menu|drop-down-menu|menu-list|popover__(popper|content|content-body)|popover-content|popper|popup|flyout|submenu|submenu-wrapper|context-menu|account-menu|user-menu|avatar-menu)(?=[^a-z0-9]|$)/i;
const HOVER_SURFACE_ITEM_RE = /(^|[^a-z0-9])((dropdown|menu|submenu|context-menu)(-|__?)?(item|link)|item-(text|label|content)|item__?(text|label|content))(?=[^a-z0-9]|$)/i;
const HOVER_SURFACE_MAX_AXIS_GAP = 96;
const HOVER_SURFACE_MAX_DIAGONAL_GAP = 16;
const HOVER_SURFACE_MAX_VIEWPORT_AREA_RATIO = 0.5;
const HOVER_SURFACE_MAX_PARENT_DEPTH = 10;
const HOVER_SURFACE_SIGNATURE_TEXT_LIMIT = 512;

/**
 * Resolve the optional test/host environment into concrete globals so the
 * default (browser) path behaves exactly like the reference implementation:
 * parent walks stop at the body/root element and visibility requires a real
 * host element.
 *
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {Required<HoverSurfaceEnvironment>}
 */
function resolveEnvironment(env) {
  const provided = env ?? {};
  const documentApi = provided.document !== undefined
    ? provided.document
    : (typeof document === 'undefined' ? null : document);
  const windowApi = provided.window !== undefined
    ? provided.window
    : (typeof window === 'undefined' ? null : window);
  return {
    document: documentApi,
    body: provided.body !== undefined ? provided.body : (documentApi ? documentApi.body : null),
    documentElement: provided.documentElement !== undefined
      ? provided.documentElement
      : (documentApi ? documentApi.documentElement : null),
    window: windowApi,
    getComputedStyle: provided.getComputedStyle
      ?? (typeof windowApi?.getComputedStyle === 'function'
        ? (el) => windowApi.getComputedStyle(el)
        : (typeof getComputedStyle === 'function' ? getComputedStyle : () => ({}))),
    isHTMLElement: provided.isHTMLElement
      ?? (typeof HTMLElement === 'function' ? (el) => el instanceof HTMLElement : () => true),
    innerWidth: provided.innerWidth !== undefined
      ? provided.innerWidth
      : (typeof windowApi?.innerWidth === 'number' ? windowApi.innerWidth : 0),
    innerHeight: provided.innerHeight !== undefined
      ? provided.innerHeight
      : (typeof windowApi?.innerHeight === 'number' ? windowApi.innerHeight : 0),
  };
}

/**
 * Collect the identifying tokens of an element: id, class list, test ids,
 * accessible label and role.
 *
 * @param {Element} el
 * @returns {string}
 */
function elementTokenText(el) {
  return [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('data-cy'), el.getAttribute('aria-label'), el.getAttribute('role')]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ');
}

/**
 * Whether an element is a recognized hover surface by role, marker attribute or
 * container naming. Surface *items* are explicitly excluded.
 *
 * @param {Element} el
 * @returns {boolean}
 */
export function isRecognizedHoverSurfaceElement(el) {
  if (el.matches(HOVER_SURFACE_SELECTOR)) return true;
  const tokenText = elementTokenText(el);
  return HOVER_SURFACE_WORD_RE.test(tokenText) && !HOVER_SURFACE_ITEM_RE.test(tokenText);
}

/**
 * @param {Element} el
 * @returns {DOMRect | null} Null when the element has no rendered box.
 */
function rectFor(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

/**
 * Walk ancestors while staying inside the document and below the depth budget.
 *
 * @param {Element} element
 * @param {(node: Element) => boolean} predicate
 * @param {Required<HoverSurfaceEnvironment>} environment
 * @returns {Element | null}
 */
function walkParents(element, predicate, environment) {
  let node = element;
  let depth = 0;
  while (node && node !== environment.body && node !== environment.documentElement && depth < HOVER_SURFACE_MAX_PARENT_DEPTH) {
    if (predicate(node)) return node;
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/**
 * A surface is visible when it can receive pointer input and paints a box.
 *
 * @param {Element} el
 * @param {Required<HoverSurfaceEnvironment>} environment
 * @returns {boolean}
 */
function isVisibleSurfaceElement(el, environment) {
  if (!environment.isHTMLElement(el)) return false;
  const style = environment.getComputedStyle(el);
  if (style.pointerEvents === 'none' || style.visibility === 'hidden' || style.display === 'none') return false;
  return rectFor(el) !== null;
}

/**
 * Closest recognized surface, bounded by the document and the ancestor budget.
 *
 * @param {Element} element
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {Element | null}
 */
export function closestRecognizedHoverSurface(element, env) {
  return walkParents(element, (node) => isRecognizedHoverSurfaceElement(node), resolveEnvironment(env));
}

/**
 * A floating layer must be absolutely positioned, interactive, painted and
 * smaller than half of the viewport, so fixed page furniture and page-sized wrappers are
 * not mistaken for popups.
 *
 * @param {Element} el
 * @param {Required<HoverSurfaceEnvironment>} environment
 * @returns {boolean}
 */
function isPositionedFloatingIn(el, environment) {
  if (!environment.isHTMLElement(el)) return false;
  const style = environment.getComputedStyle(el);
  if (style.position !== 'absolute') return false;
  if (style.pointerEvents === 'none' || style.visibility === 'hidden' || style.display === 'none') return false;
  const rect = rectFor(el);
  if (!rect) return false;
  const viewportArea = environment.innerWidth * environment.innerHeight;
  const area = rect.width * rect.height;
  return area > 0 && (!viewportArea || area <= viewportArea * HOVER_SURFACE_MAX_VIEWPORT_AREA_RATIO);
}

/**
 * @param {Element} el
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {boolean}
 */
export function isPositionedFloatingElement(el, env = {}) {
  return isPositionedFloatingIn(el, resolveEnvironment(env));
}

/**
 * @param {Element} el
 * @param {Required<HoverSurfaceEnvironment>} environment
 * @returns {boolean}
 */
function isHoverSurfaceCandidateIn(el, environment) {
  return isRecognizedHoverSurfaceElement(el) || isPositionedFloatingIn(el, environment);
}

/**
 * Whether an element can own hover state: a recognized surface or a floating layer.
 *
 * @param {Element} el
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {boolean}
 */
export function isHoverSurfaceCandidateElement(el, env = {}) {
  return isHoverSurfaceCandidateIn(el, resolveEnvironment(env));
}

/**
 * @param {Element} element
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {Element | null}
 */
export function closestHoverSurfaceCandidate(element, env = {}) {
  const environment = resolveEnvironment(env);
  return walkParents(element, (node) => isHoverSurfaceCandidateIn(node, environment), environment);
}

/**
 * @param {Element} clickElement
 * @param {Required<HoverSurfaceEnvironment>} environment
 * @returns {Element | null}
 */
function closestFloatingSurface(clickElement, environment) {
  return walkParents(clickElement, (node) => isPositionedFloatingIn(node, environment), environment);
}

/**
 * @param {Element} el
 * @returns {string}
 */
function hoverSurfaceSignature(el) {
  const rect = rectFor(el);
  return [
    rect ? `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}` : '',
    (el.textContent ?? '').trim().slice(0, HOVER_SURFACE_SIGNATURE_TEXT_LIMIT),
  ].join('|');
}

/**
 * Snapshot every visible hover surface in the document so movement and content
 * changes can be detected between capture ticks.
 *
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {HoverSurfaceState[]}
 */
export function collectHoverSurfaceStates(env = {}) {
  const states = [];
  const environment = resolveEnvironment(env);
  const documentApi = environment.document;
  if (!documentApi || typeof documentApi.querySelectorAll !== 'function') return states;
  for (const el of documentApi.querySelectorAll('*')) {
    if (isHoverSurfaceCandidateIn(el, environment) && isVisibleSurfaceElement(el, environment)) states.push({ element: el, signature: hoverSurfaceSignature(el) });
  }
  return states;
}

/**
 * @param {Element} surface
 * @param {Element} trigger
 * @returns {null | { surfaceRect: DOMRect, triggerRect: DOMRect, horizontalOverlap: number, verticalOverlap: number, horizontalGap: number, verticalGap: number }}
 */
function surfaceRelationMetrics(surface, trigger) {
  const surfaceRect = rectFor(surface);
  const triggerRect = rectFor(trigger);
  if (!surfaceRect || !triggerRect) return null;
  const horizontalOverlap = Math.min(triggerRect.right, surfaceRect.right) - Math.max(triggerRect.left, surfaceRect.left);
  const verticalOverlap = Math.min(triggerRect.bottom, surfaceRect.bottom) - Math.max(triggerRect.top, surfaceRect.top);
  const horizontalGap = Math.max(0, triggerRect.left - surfaceRect.right, surfaceRect.left - triggerRect.right);
  const verticalGap = Math.max(0, triggerRect.top - surfaceRect.bottom, surfaceRect.top - triggerRect.bottom);
  return { surfaceRect, triggerRect, horizontalOverlap, verticalOverlap, horizontalGap, verticalGap };
}

/**
 * Loose proximity test: aligned on one axis within the axis gap, or adjacent on
 * both axes within the diagonal gap.
 *
 * @param {Element} surface
 * @param {Element} trigger
 * @returns {boolean}
 */
function isNearTrigger(surface, trigger) {
  const metrics = surfaceRelationMetrics(surface, trigger);
  if (!metrics) return true;
  const { horizontalOverlap, verticalOverlap, horizontalGap, verticalGap } = metrics;
  if (horizontalOverlap > 0 && verticalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  if (verticalOverlap > 0 && horizontalGap <= HOVER_SURFACE_MAX_AXIS_GAP) return true;
  return horizontalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP && verticalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP;
}

/**
 * Strict ownership test: the surface must open below/above, beside, or from the
 * corner of the trigger rather than covering it.
 *
 * @param {Element} trigger
 * @param {Element} surface
 * @returns {boolean}
 */
export function isLikelyHoverSurfaceOwner(trigger, surface) {
  const metrics = surfaceRelationMetrics(surface, trigger);
  if (!metrics) return true;
  const { surfaceRect, triggerRect, horizontalOverlap, verticalOverlap, horizontalGap, verticalGap } = metrics;
  const opensVertically = horizontalOverlap > 0 && verticalGap <= HOVER_SURFACE_MAX_AXIS_GAP && (triggerRect.bottom <= surfaceRect.top + 8 || surfaceRect.bottom <= triggerRect.top + 8);
  const opensSideways = verticalOverlap > 0 && horizontalGap <= HOVER_SURFACE_MAX_AXIS_GAP && (triggerRect.right <= surfaceRect.left + 8 || surfaceRect.right <= triggerRect.left + 8);
  const opensFromCorner = horizontalGap > 0 && verticalGap > 0 && horizontalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP && verticalGap <= HOVER_SURFACE_MAX_DIAGONAL_GAP;
  return opensVertically || opensSideways || opensFromCorner;
}

/**
 * Decide whether a click belongs to the hover session opened by the trigger.
 * Precedence: a recognized surface near the trigger, then a near floating layer,
 * then a descendant of the trigger itself.
 *
 * @param {HoverSurfaceContext} context
 * @param {Element} clickElement
 * @param {HoverSurfaceEnvironment} [env]
 * @returns {HoverSurfaceDecision}
 */
export function decideHoverSurfaceRelation(context, clickElement, env = {}) {
  const environment = resolveEnvironment(env);
  const clickSurface = closestRecognizedHoverSurface(clickElement, environment);
  if (clickSurface && isNearTrigger(clickSurface, context.triggerElement)) return { related: true, reason: 'click-inside-hover-surface', surface: clickSurface };
  const floatingSurface = closestFloatingSurface(clickElement, environment);
  if (floatingSurface && isNearTrigger(floatingSurface, context.triggerElement)) return { related: true, reason: 'click-inside-near-floating-surface', surface: floatingSurface };
  if (context.triggerElement.contains(clickElement) && clickElement !== context.triggerElement) return { related: true, reason: 'click-inside-trigger-contained-surface' };
  return { related: false, reason: 'click-outside-hover-surface' };
}
