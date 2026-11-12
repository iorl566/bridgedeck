import { INTERACTIVE_SELECTOR, describeEventTarget, describeTarget, resolveClickableElement, resolveHoverElement } from '../lib/describe-target.js';
import { evaluateHoverTrigger, hasDirectHoverInteractiveSignal, hasStrongHoverExpansionSignal } from '../lib/hover-trigger-policy.js';
import { RECORD_PASSWORD_ATTRIBUTE, sensitiveAutocomplete } from '../lib/sensitive-autocomplete.js';
import { shouldRecordPress } from '../lib/recording/draft-policy.js';
import { closestHoverSurfaceCandidate, collectHoverSurfaceStates, decideHoverSurfaceRelation, isLikelyHoverSurfaceOwner } from './record-hover-surface.js';

/**
 * User-action capture for the recording flow.
 *
 * Clicks, hovers, presses, selects, fills and navigation are turned into steps
 * that a later replay can re-identify from their target descriptor and
 * geometry. Overlay chrome is never captured, secret field values are
 * redacted, and a hover surface opened by a trigger attributes clicks inside
 * it back to that trigger.
 *
 * @typedef {{ dispose: () => void }} RecordCaptureController
 *
 * @typedef {object} FillSession
 * @property {FillableElement} element Field being edited.
 * @property {import('../lib/describe-target.js').CaptureTargetDescriptor} target Descriptor captured when the session opened.
 * @property {string} baselineValue Committed value the session started from.
 * @property {string} lastValue Latest sampled value.
 * @property {'enter' | 'suggestion' | 'blur'} [pendingCommit] How the session is being committed.
 *
 * @typedef {object} HoverCandidate
 * @property {Element} element Element that owns the hover.
 * @property {import('../lib/describe-target.js').CaptureTargetDescriptor} target Normalized descriptor emitted for the hover.
 * @property {number} recordedAt Epoch ms when the candidate was observed.
 * @property {number} score Policy score used to prefer stronger candidates.
 * @property {boolean} eligible Whether the trigger policy allows it to become a pending hover.
 *
 * @typedef {object} HoverSurfaceNode
 * @property {Element} element The surface element.
 * @property {string} signature Geometry and text fingerprint used to detect changes.
 * @property {HoverCandidate} owner Trigger candidate this surface belongs to.
 * @property {HoverSurfaceNode} [parent] Enclosing surface node, when one was inferred.
 *
 * @typedef {HTMLInputElement | HTMLTextAreaElement | HTMLElement} FillableElement
 *
 * @typedef {object} RecordCaptureOptions
 * @property {boolean} [captureNavigation] Observe URL and history changes;
 * child frames disable this because the root frame owns navigation. Defaults to true.
 *
 * @typedef {object} KeyboardActivation
 * @property {EventTarget | null} target Element the key press was attributed to.
 * @property {number} recordedAt Epoch ms when the key was pressed.
 */

const HOVER_BEFORE_CLICK_MAX_MS = 10_000;
const HOVER_SURFACE_CONTEXT_MAX_MS = 30_000;
const HOVER_REPLACE_SCORE_MARGIN = 50;
const HOVER_CANDIDATE_LIMIT = 24;
const HOVER_TRIGGER_LABEL_MAX = 48;
const OVERLAY_MARKER_ATTRIBUTE = 'data-bb-overlay';

/** Use the event's own path: a retargeted shadow event must keep its true target. */
function eventTarget(event) { return event.composedPath()[0] ?? event.target; }

/** Walk past shadow hosts so toolbar content is never captured as page activity. */
function isOverlayTarget(target) {
  if (!(target instanceof Node)) return false;
  const root = document.documentElement;
  let node = target;
  while (node && node !== root) {
    if (node instanceof Element && node.hasAttribute(OVERLAY_MARKER_ATTRIBUTE)) return true;
    const rootNode = node.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      if (rootNode.host.hasAttribute(OVERLAY_MARKER_ATTRIBUTE)) return true;
      node = rootNode.host;
    } else {
      node = node.parentNode;
    }
  }
  return false;
}

/**
 * Whether an element accepts text input rather than acting as a button,
 * checkbox, file picker or other non-text control.
 *
 * @param {Element} element
 * @returns {boolean}
 */
function isTextFillable(element) {
  if (element instanceof HTMLElement && (element.isContentEditable || element.contentEditable === 'true')) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden'].includes(element.type.toLowerCase());
}

/**
 * Resolve the editable field a click or focus event should be attributed to.
 * A click on a control inside a `contenteditable="false"` region stays a page
 * action instead of becoming an edit.
 *
 * @param {EventTarget | null} target
 * @returns {FillableElement | null}
 */
function fillableFromTarget(target) {
  if (!(target instanceof Element)) return null;
  if (isTextFillable(target)) return target;
  const element = target.closest('input,textarea,[contenteditable]:not([contenteditable="false"])');
  if (!element || !isTextFillable(element) || isControlInNonEditableRegion(target, element)) return null;
  return element;
}

/**
 * Buttons and links inside a `contenteditable="false"` region of an editor,
 * such as attachment or embed actions, are page actions rather than editor text.
 *
 * @param {Element} target
 * @param {Element} editor
 * @returns {boolean}
 */
function isControlInNonEditableRegion(target, editor) {
  const region = target.closest('[contenteditable="false"]');
  if (!region || !editor.contains(region)) return false;
  const control = resolveClickableElement(target);
  return control !== null && region.contains(control);
}

/**
 * Clicks on search chrome that only focus the nearby input should not become
 * record steps. Form actions remain clicks even when they sit beside a search
 * field; only the field's own wrapper counts as focus chrome.
 *
 * @param {Element} target
 * @returns {FillableElement | null}
 */
function nearbyFillableFromSearchChrome(target) {
  if (target.closest('button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]')) return null;
  const container = target.closest('[id*="chat-input"], [id*="search"], [class*="search"], form, [role="search"]');
  if (!container) return null;
  const fillable = container.querySelector('textarea, input[type="search"], input[name="q"], #chat-textarea');
  if (!(fillable instanceof HTMLElement) || !isTextFillable(fillable) || fillable === target || fillable.contains(target)) return null;
  const control = target.closest(INTERACTIVE_SELECTOR);
  if (control && !control.contains(fillable)) return null;
  return fillable;
}

/**
 * Current value of a fillable element: `value` for inputs and text areas,
 * rendered text for content-editable hosts.
 *
 * @param {FillableElement} element
 * @returns {string}
 */
function fillableValue(element) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  return element.textContent ?? '';
}

/**
 * Viewport box and tag used to re-find the element during replay.
 *
 * @param {Element} element
 * @returns {import('../lib/record-bridge.js').RecordStepPayload['geometry']}
 */
function captureGeometry(element) {
  const rect = element.getBoundingClientRect();
  return { rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, tag: element.tagName.toLowerCase() };
}

/**
 * @param {EventTarget | null} target
 * @returns {import('../lib/record-bridge.js').RecordStepPayload['geometry'] | undefined}
 */
function geometryForEventTarget(target) {
  if (!(target instanceof Element)) return undefined;
  return captureGeometry(resolveClickableElement(target) ?? target);
}

/**
 * Clicks that only pick an autocomplete or suggestion value — not a semantic
 * submit action. The pending fill session is committed with `suggestion`
 * instead of being emitted as a click step.
 *
 * @param {EventTarget | null} target
 * @param {FillSession | null} session
 * @returns {boolean}
 */
function isInputCompletionClick(target, session) {
  if (!session || !(target instanceof Element)) return false;
  if (session.element.contains(target)) return false;
  const option = target.closest('[role="option"]');
  if (option?.closest('[role="listbox"]')) return true;
  const root = target.closest(['[id*="Sug"]', '[id*="sug"]', '[class*="suggest"]', '[class*="autocomplete"]', '[class*="typeahead"]', '[data-autocomplete]'].join(', '));
  return !!root && !root.contains(session.element);
}

/**
 * Start capturing page activity as record steps.
 *
 * Every emitted step is stamped with the current `page_url`. Fill steps are
 * only emitted when the value changed, and a field that is or was a password
 * is emitted as `***` with `redacted: true`. The returned controller flushes the
 * pending fill session before detaching listeners.
 *
 * @param {string} _requestId Recording request this capture belongs to. Unused:
 * the transport already scopes steps to the request.
 * @param {(step: import('../lib/record-bridge.js').RecordStepPayload) => void} sendStep
 * Receives every captured step.
 * @param {RecordCaptureOptions} [options]
 * @returns {RecordCaptureController}
 */
export function startRecordCapture(_requestId, sendStep, options = {}) {
  const emitStep = (step) => sendStep({ page_url: location.href, ...step });
  /** @type {FillSession | null} Edit currently accumulating into one fill step. */
  let fillSession = null;
  /** True while an input-method composition is in progress; fills wait for it. */
  let composing = false;
  /** Last observed URL, used to emit navigation steps. */
  let lastUrl = location.href;
  /** @type {HoverCandidate | null} Hover the next click may belong to. */
  let pendingHover = null;
  /** @type {KeyboardActivation | undefined} Key press whose synthetic click must be ignored. */
  let keyboardActivation;
  /** @type {HTMLElement | null} Control opened by a label click; its synthetic click is skipped. */
  let generatedControlClick = null;
  /** True for one task after a page action so a resulting navigation is attributed to it. */
  let navigationActionPending = false;
  /** Incremented per page action; a stale timeout must not clear the newer flag. */
  let navigationActionVersion = 0;
  /** @type {WeakMap<FillableElement, string>} Value already committed per field. */
  const committedValues = new WeakMap();
  /** @type {Set<Element>} Fields that were password inputs at some point. */
  const formerPasswords = new Set();
  /** @type {WeakSet<Element>} Hover triggers already emitted for this recording. */
  const emittedHover = new WeakSet();
  /** @type {HoverCandidate[]} Recent hover candidates, oldest first. */
  const recentHover = [];
  /** @type {Map<Element, string>} Last signature per hover surface. */
  let hoverSurfaceStates = new Map(collectHoverSurfaceStates().map((state) => [state.element, state.signature]));
  /** @type {Map<Element, HoverSurfaceNode>} Surface ownership graph for the current document. */
  const hoverSurfaceNodes = new Map();

  /**
   * Remember fields that stop being password inputs so their values stay
   * redacted for the rest of the recording.
   *
   * @param {MutationRecord[]} records
   * @returns {void}
   */
  const markFormerPasswords = (records) => {
    for (const record of records) {
      if (record.oldValue?.toLowerCase() === 'password' && record.target instanceof Element) {
        formerPasswords.add(record.target);
        record.target.setAttribute(RECORD_PASSWORD_ATTRIBUTE, '');
      }
    }
  };
  /** Watches `type` changes so a field switched away from password stays redacted. */
  const typeObserver = new MutationObserver(markFormerPasswords);
  typeObserver.observe(document, { subtree: true, attributeFilter: ['type'], attributeOldValue: true });

  /** Arm a one-task flag so a navigation caused by the current action is attributed to it. */
  const markNavigationAction = () => {
    navigationActionPending = true;
    const version = ++navigationActionVersion;
    setTimeout(() => { if (navigationActionVersion === version) navigationActionPending = false; }, 0);
  };

  /**
   * Emit one fill step for a finished session, redacting anything that is or was
   * a password. Nothing is emitted when the value did not change.
   *
   * @param {FillSession} session
   * @returns {void}
   */
  const emitFill = (session) => {
    if (session.lastValue === session.baselineValue) return;
    markFormerPasswords(typeObserver.takeRecords());
    const isPassword = (session.element instanceof HTMLInputElement && session.element.type === 'password')
      || formerPasswords.has(session.element)
      || sensitiveAutocomplete(session.element.getAttribute('autocomplete'));
    emitStep({
      op: 'fill',
      target: session.target,
      geometry: captureGeometry(session.element),
      value: isPassword ? '***' : session.lastValue,
      commit: session.pendingCommit ?? 'blur',
      ...(isPassword ? { redacted: true } : {}),
    });
  };

  /**
   * Close the pending fill session and emit it under `commit`; a composition in
   * progress defers the commit until it ends.
   *
   * @param {'enter' | 'suggestion' | 'blur'} [commit] How the edit ended.
   * @returns {void}
   */
  const commitFillSession = (commit = 'blur') => {
    if (!fillSession || composing) return;
    const session = fillSession;
    session.pendingCommit = commit;
    fillSession = null;
    emitFill(session);
    committedValues.set(session.element, session.lastValue);
  };

  /**
   * Refresh the sampled value of the pending session when `element` owns it.
   *
   * @param {FillableElement} element
   * @returns {void}
   */
  const syncFillSessionValue = (element) => {
    if (!fillSession || fillSession.element !== element) return;
    fillSession.lastValue = fillableValue(element);
  };

  /**
   * Open a fill session for `element`, committing a session for another field
   * first. The baseline is the last committed value, so a field that is focused
   * and left unchanged emits nothing.
   *
   * @param {FillableElement} element
   * @returns {void}
   */
  const ensureFillSession = (element) => {
    if (fillSession?.element === element) return;
    if (fillSession) commitFillSession();
    const currentValue = fillableValue(element);
    fillSession = {
      element,
      target: describeTarget(element),
      baselineValue: committedValues.get(element) ?? currentValue,
      lastValue: currentValue,
    };
  };

  /**
   * Emit a navigate step when the URL changed since the previous observation,
   * flushing any pending fill first.
   *
   * @param {boolean} [causedByAction] True when the preceding page action caused
   * the navigation; omitted when the cause is unknown.
   * @returns {void}
   */
  const emitNavigateIfChanged = (causedByAction) => {
    if (location.href === lastUrl) return;
    commitFillSession();
    lastUrl = location.href;
    emitStep({ op: 'navigate', url: location.href, ...(causedByAction !== undefined ? { navigation_caused_by_action: causedByAction } : {}) });
  };

  /**
   * Remember one hover candidate, moving a repeat of the same element to the
   * newest position and keeping only the most recent candidates.
   *
   * @param {HoverCandidate} hover
   * @returns {void}
   */
  const rememberHover = (hover) => {
    const duplicate = recentHover.findIndex((candidate) => candidate.element === hover.element);
    if (duplicate >= 0) recentHover.splice(duplicate, 1);
    recentHover.push(hover);
    if (recentHover.length > HOVER_CANDIDATE_LIMIT) recentHover.splice(0, recentHover.length - HOVER_CANDIDATE_LIMIT);
  };

  /**
   * Attribute snapshot of a hover trigger for the pointer policy.
   *
   * @param {Element} element
   * @returns {Record<string, string | undefined>}
   */
  const hoverTriggerAttrs = (element) => ({
    id: element.id || undefined,
    class: typeof element.className === 'string' ? element.className || undefined : undefined,
    'data-testid': element.getAttribute('data-testid') ?? undefined,
    'data-test': element.getAttribute('data-test') ?? undefined,
    'data-cy': element.getAttribute('data-cy') ?? undefined,
    'aria-label': element.getAttribute('aria-label') ?? undefined,
    'aria-haspopup': element.getAttribute('aria-haspopup') ?? undefined,
    'aria-controls': element.getAttribute('aria-controls') ?? undefined,
    'aria-expanded': element.getAttribute('aria-expanded') ?? undefined,
    'aria-hidden': element.getAttribute('aria-hidden') ?? undefined,
    'aria-disabled': element.getAttribute('aria-disabled') ?? undefined,
    contenteditable: element.getAttribute('contenteditable') ?? undefined,
    disabled: element.hasAttribute('disabled') ? '' : undefined,
    hidden: element.hasAttribute('hidden') ? '' : undefined,
    inert: element.hasAttribute('inert') ? '' : undefined,
    onclick: element.getAttribute('onclick') ?? undefined,
    onmouseenter: element.getAttribute('onmouseenter') ?? undefined,
    onmouseover: element.getAttribute('onmouseover') ?? undefined,
    role: element.getAttribute('role') ?? undefined,
    tabindex: element.getAttribute('tabindex') ?? undefined,
    title: element.getAttribute('title') ?? undefined,
  });
  /**
   * Viewport box of a hover trigger.
   *
   * @param {Element} element
   * @returns {import('../lib/hover-trigger-policy.js').HoverTriggerRect}
   */
  const hoverTriggerRect = (element) => { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }; };
  /**
   * Whether a trigger paints a graphic child that the policy treats as an icon.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  const hasHoverGraphicDescendant = (element) => element.querySelector('img,svg,use,path,i') !== null;
  /**
   * Collapse whitespace and trim a label for comparison.
   *
   * @param {string} value
   * @returns {string}
   */
  const normalizeLabelText = (value) => value.replace(/\s+/g, ' ').trim();
  /**
   * Normalize a label and truncate it with an ellipsis to `max` characters.
   *
   * @param {string} value
   * @param {number} [max]
   * @returns {string}
   */
  const truncateLabel = (value, max = HOVER_TRIGGER_LABEL_MAX) => {
    const normalized = normalizeLabelText(value);
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}…`;
  };
  /**
   * Collect only the trigger's own text, skipping nested hover surfaces such as
   * a menu that opened inside the trigger.
   *
   * @param {Element} root
   * @returns {string}
   */
  const collectHoverTriggerLabelText = (root) => {
    let text = '';
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { text += ` ${node.textContent ?? ''}`; return; }
      if (!(node instanceof Element)) return;
      if (node !== root && isHoverSurfaceCandidate(node)) return;
      for (const child of node.childNodes) visit(child);
    };
    for (const child of root.childNodes) visit(child);
    return normalizeLabelText(text);
  };
  /**
   * Replace a descriptor name with a shorter prefix-only label when the shorter
   * text is a prefix of the full text, so long cards do not produce noisy names.
   *
   * @param {Element} element
   * @param {import('../lib/describe-target.js').CaptureTargetDescriptor} descriptor
   * @returns {import('../lib/describe-target.js').CaptureTargetDescriptor}
   */
  const compactHoverTargetName = (element, descriptor) => {
    if (!descriptor.name) return descriptor;
    const fullText = normalizeLabelText(element.textContent ?? '');
    const compact = collectHoverTriggerLabelText(element);
    if (!compact || compact === descriptor.name) return descriptor;
    const compactComparable = compact.replace(/\s+/g, '');
    const descComparable = descriptor.name.replace(/…$/, '').replace(/\s+/g, '');
    const fullTextComparable = fullText.replace(/\s+/g, '');
    if (descComparable.startsWith(compactComparable) && fullTextComparable.startsWith(descComparable) && compact.length < descriptor.name.length) {
      return { ...descriptor, name: truncateLabel(compact) };
    }
    return descriptor;
  };
  /**
   * A div with no role and no name carries too little evidence to describe a
   * hover on its own.
   *
   * @param {import('../lib/describe-target.js').CaptureTargetDescriptor} descriptor
   * @returns {boolean}
   */
  const isWeakHoverTarget = (descriptor) => !descriptor.role && !descriptor.name && descriptor.tag === 'div';
  /**
   * @param {Element} element
   * @returns {boolean}
   */
  const looksLikeAvatarElement = (element) => /\b(avatar|user-avatar)\b/i.test(typeof element.className === 'string' ? element.className : '');
  /**
   * Replace a weak or unnamed avatar/icon descriptor with a stable image
   * descriptor so replay can identify it.
   *
   * @param {Element} element
   * @param {import('../lib/describe-target.js').CaptureTargetDescriptor} descriptor
   * @param {import('../lib/hover-trigger-policy.js').HoverTriggerDecision} decision
   * @returns {import('../lib/describe-target.js').CaptureTargetDescriptor}
   */
  const normalizeHoverTarget = (element, descriptor, decision) => {
    if (descriptor.role === 'img' && !descriptor.name && looksLikeAvatarElement(element)) return { ...descriptor, name: 'image' };
    if (isWeakHoverTarget(descriptor) && (looksLikeAvatarElement(element) || (hasHoverGraphicDescendant(element) && decision.reasons.includes('icon-only')))) {
      return { tag: 'img', role: 'img', name: 'image' };
    }
    return descriptor;
  };
  /**
   * Build the policy signal bundle for a hover trigger.
   *
   * @param {Element} element
   * @param {import('../lib/describe-target.js').CaptureTargetDescriptor} descriptor
   * @returns {import('../lib/hover-trigger-policy.js').HoverTriggerSignals | null}
   */
  const hoverTriggerSignals = (element, descriptor) => {
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      role: descriptor.role,
      label: descriptor.name,
      attrs: hoverTriggerAttrs(element),
      rect: hoverTriggerRect(element),
      cursor: style.cursor,
      pointerEvents: style.pointerEvents,
      hasGraphicDescendant: hasHoverGraphicDescendant(element),
    };
  };
  /**
   * Resolve the hover trigger under `target` and score it. Returns null when the
   * element is not a usable trigger under the pointer policy.
   *
   * @param {EventTarget | null} target
   * @returns {HoverCandidate | null}
   */
  const hoverCandidate = (target) => {
    if (!(target instanceof Element)) return null;
    const element = resolveHoverElement(target);
    if (!element) return null;
    const descriptor = describeTarget(element);
    const signals = hoverTriggerSignals(element, descriptor);
    if (!signals) return null;
    const decision = evaluateHoverTrigger(signals);
    if (!decision.eligible && !hasStrongHoverExpansionSignal(signals) && !hasDirectHoverInteractiveSignal(signals)) return null;
    if (!decision.eligible && !descriptor.name && !descriptor.role) return null;
    const normalizedTarget = normalizeHoverTarget(element, compactHoverTargetName(element, descriptor), decision);
    const now = Date.now();
    return {
      element,
      target: normalizedTarget,
      recordedAt: now,
      score: decision.score,
      eligible: decision.eligible,
    };
  };
  /** @param {Element} element @returns {boolean} */
  const isHoverSurfaceCandidate = (element) => closestHoverSurfaceCandidate(element) !== null;
  /**
   * Decide whether a newer hover should replace the pending one: contained
   * children lose, containers win, and an unrelated candidate must outweigh the
   * pending one by the replacement margin or arrive after the click window.
   *
   * @param {HoverCandidate} current
   * @param {HoverCandidate} next
   * @param {number} [now]
   * @returns {boolean}
   */
  const shouldReplaceHoverCandidate = (current, next, now = Date.now()) => {
    if (next.element === current.element) return false;
    if (now - current.recordedAt > HOVER_BEFORE_CLICK_MAX_MS) return true;
    if (current.element.contains(next.element)) return false;
    if (next.element.contains(current.element)) return true;
    return next.score >= current.score + HOVER_REPLACE_SCORE_MARGIN;
  };

  /** @param {Element} element @returns {number} */
  const surfaceArea = (element) => { const rect = element.getBoundingClientRect(); return rect.width * rect.height; };
  /**
   * Pick the smallest item whose element contains `target`.
   *
   * @template T
   * @param {Element} target
   * @param {Iterable<T>} items
   * @param {(item: T) => Element} elementFor
   * @returns {T | undefined}
   */
  const smallestContaining = (target, items, elementFor) => {
    let best;
    for (const item of items) {
      const element = elementFor(item);
      if (!element.contains(target)) continue;
      if (!best || surfaceArea(element) < surfaceArea(elementFor(best))) best = item;
    }
    return best;
  };
  /** @param {Element} target @returns {HoverSurfaceNode | undefined} */
  const ownedSurfaceContaining = (target) => smallestContaining(target, hoverSurfaceNodes.values(), (node) => node.element);
  /**
   * @param {Element} target
   * @param {import('./record-hover-surface.js').HoverSurfaceState[]} states
   * @returns {import('./record-hover-surface.js').HoverSurfaceState | undefined}
   */
  const surfaceStateContaining = (target, states) => smallestContaining(target, states, (state) => state.element);
  /**
   * Find the most recent hover candidate that plausibly opened `surface`, using
   * geometry and the candidate time budget.
   *
   * @param {Element} surface
   * @param {number} now
   * @param {HoverCandidate} [before] Candidate that must be older than the owner.
   * @returns {HoverCandidate | undefined}
   */
  const inferOwnerForSurface = (surface, now, before) => {
    for (let index = recentHover.length - 1; index >= 0; index -= 1) {
      const candidate = recentHover[index];
      if (!candidate) continue;
      if (before && candidate.element === before.element) continue;
      if (before && candidate.recordedAt > before.recordedAt) continue;
      if (surface.contains(candidate.element)) continue;
      if (now - candidate.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      if (isLikelyHoverSurfaceOwner(candidate.element, surface)) return candidate;
    }
    return undefined;
  };
  /**
   * Find or create the surface node that encloses the owner, so nested popups
   * can be walked as a chain.
   *
   * @param {HoverCandidate} owner
   * @param {import('./record-hover-surface.js').HoverSurfaceState[]} currentStates
   * @param {number} now
   * @returns {HoverSurfaceNode | undefined}
   */
  const parentSurfaceNodeForOwner = (owner, currentStates, now) => {
    const ownedParent = ownedSurfaceContaining(owner.element);
    if (ownedParent) return ownedParent;
    const parentState = surfaceStateContaining(owner.element, currentStates);
    if (!parentState) return undefined;
    const parentOwner = inferOwnerForSurface(parentState.element, now, owner);
    if (!parentOwner) return undefined;
    const parentNode = { element: parentState.element, signature: parentState.signature, owner: parentOwner };
    hoverSurfaceNodes.set(parentState.element, parentNode);
    return parentNode;
  };
  /**
   * Bind one surface to its owner when the owner is recent enough and their
   * geometry is consistent, and remember the node.
   *
   * @param {import('./record-hover-surface.js').HoverSurfaceState} state
   * @param {HoverCandidate} owner
   * @param {import('./record-hover-surface.js').HoverSurfaceState[]} currentStates
   * @param {number} now
   * @returns {HoverSurfaceNode | undefined}
   */
  const createSurfaceNode = (state, owner, currentStates, now) => {
    const parent = parentSurfaceNodeForOwner(owner, currentStates, now);
    if (parent?.element === state.element) return undefined;
    if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) return undefined;
    if (!isLikelyHoverSurfaceOwner(owner.element, state.element)) return undefined;
    const node = { element: state.element, signature: state.signature, owner, ...(parent ? { parent } : {}) };
    hoverSurfaceNodes.set(state.element, node);
    return node;
  };
  /**
   * Create surface nodes for surfaces whose signature changed since the previous
   * snapshot and that have an inferable owner.
   *
   * @param {Map<Element, string>} previousStates
   * @param {import('./record-hover-surface.js').HoverSurfaceState[]} currentStates
   * @param {number} now
   * @returns {void}
   */
  const bindChangedHoverSurfaces = (previousStates, currentStates, now) => {
    for (const state of currentStates) {
      if (previousStates.get(state.element) === state.signature) continue;
      const owner = inferOwnerForSurface(state.element, now);
      if (!owner) continue;
      createSurfaceNode(state, owner, currentStates, now);
    }
  };
  /**
   * Drop surface nodes whose element disappeared from the current snapshot.
   *
   * @param {import('./record-hover-surface.js').HoverSurfaceState[]} currentStates
   * @returns {void}
   */
  const pruneGoneHoverSurfaces = (currentStates) => {
    const current = new Set(currentStates.map((state) => state.element));
    for (const element of hoverSurfaceNodes.keys()) if (!current.has(element)) hoverSurfaceNodes.delete(element);
  };
  /**
   * Re-scan the document, prune stale surface nodes, bind new or changed
   * surfaces, then advance the snapshot used for the next diff.
   *
   * @param {Map<Element, string>} [previousStates]
   * @returns {void}
   */
  const refreshHoverSurfaces = (previousStates = hoverSurfaceStates) => {
    const now = Date.now();
    const currentStates = collectHoverSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    bindChangedHoverSurfaces(previousStates, currentStates, now);
    hoverSurfaceStates = new Map(currentStates.map((state) => [state.element, state.signature]));
  };
  /**
   * Owner chain for a click inside a surface: innermost owner first, at most
   * four nested surfaces, skipping the clicked element and already emitted
   * owners.
   *
   * @param {HoverSurfaceNode} surface
   * @param {Element} actionElement
   * @param {number} now
   * @returns {HoverCandidate[]}
   */
  const surfaceOwnerChain = (surface, actionElement, now) => {
    const chain = [];
    const selected = new WeakSet();
    const surfaces = [];
    let node = surface;
    while (node && surfaces.length < 4) { surfaces.unshift(node); node = node.parent; }
    for (const owned of surfaces) {
      const owner = owned.owner;
      if (owner.element === actionElement || actionElement.contains(owner.element)) continue;
      if (selected.has(owner.element) || emittedHover.has(owner.element)) continue;
      if (now - owner.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      selected.add(owner.element);
      chain.push(owner);
    }
    return chain;
  };
  /**
   * Latest recent hover candidate that contains the action element, used when
   * no surface was recognized.
   *
   * @param {Element} actionElement
   * @param {number} now
   * @returns {HoverCandidate | undefined}
   */
  const containedHoverOwnerForAction = (actionElement, now) => {
    for (let index = recentHover.length - 1; index >= 0; index -= 1) {
      const candidate = recentHover[index];
      if (!candidate || candidate.element === actionElement) continue;
      if (!candidate.element.contains(actionElement)) continue;
      if (now - candidate.recordedAt > HOVER_SURFACE_CONTEXT_MAX_MS) continue;
      return candidate;
    }
    return undefined;
  };
  /**
   * Resolve the owned surface for a page action, creating an ownership node
   * from the current DOM state when the cached graph has none yet.
   *
   * @param {Element} target
   * @returns {HoverSurfaceNode | undefined}
   */
  const ownedSurfaceForAction = (target) => {
    const closestSurface = closestHoverSurfaceCandidate(target);
    if (closestSurface && hoverSurfaceNodes.has(closestSurface)) return hoverSurfaceNodes.get(closestSurface);
    const containing = ownedSurfaceContaining(target);
    if (containing) return containing;
    const now = Date.now();
    const currentStates = collectHoverSurfaceStates();
    pruneGoneHoverSurfaces(currentStates);
    const state = closestSurface ? currentStates.find((item) => item.element === closestSurface) : surfaceStateContaining(target, currentStates);
    hoverSurfaceStates = new Map(currentStates.map((item) => [item.element, item.signature]));
    if (!state) return undefined;
    const owner = inferOwnerForSurface(state.element, now);
    return owner ? createSurfaceNode(state, owner, currentStates, now) : undefined;
  };
  /**
   * Emit pending hover steps for the owners that led to an action.
   *
   * @param {EventTarget | null} actionTarget
   * @returns {void}
   */
  const emitHoverCandidateBeforeAction = (actionTarget) => {
    if (!(actionTarget instanceof Element)) return;
    const actionElement = resolveClickableElement(actionTarget) ?? actionTarget;
    const surface = ownedSurfaceForAction(actionElement);
    const now = Date.now();
    const contained = surface ? undefined : containedHoverOwnerForAction(actionElement, now);
    const chain = surface ? surfaceOwnerChain(surface, actionElement, now) : contained ? [contained] : [];
    for (const hover of chain) emitHoverStep(hover);
    pendingHover = null;
  };
  /**
   * Emit one hover step, at most once per element.
   *
   * @param {HoverCandidate} hover
   * @returns {void}
   */
  const emitHoverStep = (hover) => {
    if (emittedHover.has(hover.element)) return;
    emitStep({ op: 'hover', target: hover.target, geometry: captureGeometry(hover.element) });
    emittedHover.add(hover.element);
  };

  /**
   * Commit a fill session as a suggestion after the click task, so the chosen
   * option's value is visible in the field before it is sampled.
   *
   * @param {FillableElement} element
   * @returns {void}
   */
  const scheduleInputCompletionCommit = (element) => {
    const syncAndCommit = () => {
      if (fillSession?.element !== element) return;
      syncFillSessionValue(element);
      commitFillSession('suggestion');
    };
    syncFillSessionValue(element);
    queueMicrotask(syncAndCommit);
    setTimeout(syncAndCommit, 0);
  };

  /** @param {MouseEvent} event @returns {void} */
  const emitClick = (event) => {
    const target = describeEventTarget(eventTarget(event));
    if (!target) return;
    markNavigationAction();
    emitStep({ op: 'click', target, geometry: geometryForEventTarget(eventTarget(event)), expects_navigation: true });
  };

  /**
   * Track hover candidates and surface ownership as the pointer moves.
   *
   * @param {MouseEvent} event
   * @returns {void}
   */
  const onMouseOver = (event) => {
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    const now = Date.now();
    if (pendingHover && target instanceof Element && pendingHover.element.contains(target)) {
      if (now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) return;
      pendingHover = null;
    }
    const candidate = hoverCandidate(target);
    if (candidate) {
      const previousStates = new Map(hoverSurfaceStates);
      rememberHover(candidate);
      refreshHoverSurfaces(previousStates);
      setTimeout(() => refreshHoverSurfaces(previousStates), 0);
    }
    // Only a policy-eligible trigger may become the pending hover; weaker
    // expansion signals still feed the surface graph above.
    const hover = candidate?.eligible ? candidate : null;
    if (pendingHover && target instanceof Element) {
      const relation = decideHoverSurfaceRelation({ triggerElement: pendingHover.element }, target);
      if (relation.related && now - pendingHover.recordedAt <= HOVER_BEFORE_CLICK_MAX_MS) return;
    }
    if (!hover) return;
    if (pendingHover && !shouldReplaceHoverCandidate(pendingHover, hover, now)) return;
    pendingHover = hover;
  };

  /**
   * Classify a click as an edit, a suggestion completion, a select interaction
   * or a page click, and emit the matching step.
   *
   * @param {MouseEvent} event
   * @returns {void}
   */
  const onClick = (event) => {
    if (event.button !== 0) return;
    const target = eventTarget(event);
    if (isOverlayTarget(target)) return;
    if (event.detail === 0 && generatedControlClick !== null && target === generatedControlClick) {
      generatedControlClick = null;
      return;
    }
    if (event.detail === 0 && keyboardActivation?.target === target && Date.now() - keyboardActivation.recordedAt < 500) {
      keyboardActivation = undefined;
      return;
    }
    const label = target instanceof Element ? target.closest('label') : null;
    const nested = target instanceof Element ? target.closest('a,button,input,select,textarea') : null;
    if (label instanceof HTMLLabelElement && !nested) {
      commitFillSession();
      generatedControlClick = label.control;
      emitClick(event);
      return;
    }
    const fillable = fillableFromTarget(target);
    if (fillable) { emitHoverCandidateBeforeAction(fillable); ensureFillSession(fillable); return; }
    if (target instanceof Element) {
      const nearby = nearbyFillableFromSearchChrome(target);
      if (nearby) { emitHoverCandidateBeforeAction(nearby); ensureFillSession(nearby); return; }
    }
    if (isInputCompletionClick(target, fillSession)) {
      markNavigationAction();
      scheduleInputCompletionCommit(fillSession.element);
      return;
    }
    commitFillSession();
    if (target instanceof Element && target.closest('select')) return;
    emitHoverCandidateBeforeAction(target);
    emitClick(event);
  };

  /** @param {FocusEvent} event @returns {void} */
  const onFocusIn = (event) => {
    const target = fillableFromTarget(eventTarget(event));
    if (target) ensureFillSession(target);
  };
  /** @param {FocusEvent} event @returns {void} */
  const onFocusOut = (event) => {
    const target = fillableFromTarget(eventTarget(event));
    if (!target || fillSession?.element !== target) return;
    syncFillSessionValue(target);
    commitFillSession();
  };
  /** @param {Event} event @returns {void} */
  const onInput = (event) => {
    const raw = eventTarget(event);
    if (raw instanceof HTMLSelectElement && raw.getRootNode() instanceof ShadowRoot) { recordSelect(raw); return; }
    const target = fillableFromTarget(raw);
    if (!target || composing) return;
    ensureFillSession(target);
    syncFillSessionValue(target);
  };
  /** @returns {void} */
  const onCompositionStart = () => { composing = true; };
  /** @param {CompositionEvent} event @returns {void} */
  const onCompositionEnd = (event) => {
    composing = false;
    const target = fillableFromTarget(eventTarget(event));
    if (target) { ensureFillSession(target); syncFillSessionValue(target); }
  };

  /**
   * Emit a select step with every selected value and label.
   *
   * @param {HTMLSelectElement} target
   * @returns {void}
   */
  const recordSelect = (target) => {
    commitFillSession();
    emitHoverCandidateBeforeAction(target);
    const values = Array.from(target.selectedOptions).map((option) => option.value);
    const labels = Array.from(target.selectedOptions).map((option) => (option.label || option.textContent || option.value).trim());
    markNavigationAction();
    emitStep({ op: 'select', target: describeTarget(target), geometry: captureGeometry(target), values, labels, expects_navigation: true });
  };

  /** @param {Event} event @returns {void} */
  const onChange = (event) => {
    const target = eventTarget(event);
    if (target instanceof HTMLSelectElement) recordSelect(target);
    else commitFillSession();
  };

  /**
   * Emit a press step for recordable keys and arm keyboard activation tracking.
   *
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  const onKeyDown = (event) => {
    if (isOverlayTarget(eventTarget(event))) return;
    const target = eventTarget(event);
    const fillable = fillableFromTarget(target);
    if (fillable) { ensureFillSession(fillable); syncFillSessionValue(fillable); }
    const modifiers = [
      ...(event.altKey ? ['alt'] : []), ...(event.ctrlKey ? ['ctrl'] : []),
      ...(event.metaKey ? ['meta'] : []), ...(event.shiftKey ? ['shift'] : []),
    ];
    if (!shouldRecordPress(event.key, modifiers)) return;
    markNavigationAction();
    if (event.key === 'Enter' || event.key === ' ') {
      const submit = event.key === 'Enter' && fillable
        ? fillable.closest('form')?.querySelector('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]')
        : null;
      keyboardActivation = { target: submit ?? target, recordedAt: Date.now() };
    }
    if (fillable) commitFillSession(event.key === 'Enter' ? 'enter' : 'blur');
    const descriptor = describeEventTarget(target);
    if (!descriptor && !event.key) return;
    emitHoverCandidateBeforeAction(target);
    emitStep({
      op: 'press',
      key: event.key,
      ...(descriptor ? { target: descriptor, geometry: geometryForEventTarget(target) } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      expects_navigation: event.key === 'Enter',
    });
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('compositionstart', onCompositionStart, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('keydown', onKeyDown, true);

  const captureNavigation = options.captureNavigation ?? true;
  /** Observes DOM replacement so client-side route changes are noticed. */
  const urlObserver = captureNavigation ? new MutationObserver(() => emitNavigateIfChanged()) : null;
  urlObserver?.observe(document, { subtree: true, childList: true });
  const onUrlEvent = () => emitNavigateIfChanged();
  const onPageHide = () => commitFillSession();
  if (captureNavigation) {
    window.addEventListener('hashchange', onUrlEvent);
    window.addEventListener('popstate', onUrlEvent);
  }
  window.addEventListener('pagehide', onPageHide);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  if (captureNavigation) {
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      emitNavigateIfChanged(navigationActionPending ? true : undefined);
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      emitNavigateIfChanged(navigationActionPending ? true : undefined);
    };
  }

  return {
    /**
     * Flush the pending fill session, detach every listener and observer, and
     * restore patched history methods and password markers.
     *
     * @returns {void}
     */
    dispose() {
      commitFillSession();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKeyDown, true);
      urlObserver?.disconnect();
      typeObserver.disconnect();
      for (const element of formerPasswords) element.removeAttribute(RECORD_PASSWORD_ATTRIBUTE);
      formerPasswords.clear();
      if (captureNavigation) {
        window.removeEventListener('hashchange', onUrlEvent);
        window.removeEventListener('popstate', onUrlEvent);
      }
      window.removeEventListener('pagehide', onPageHide);
      if (captureNavigation) {
        history.pushState = originalPushState;
        history.replaceState = originalReplaceState;
      }
    },
  };
}
