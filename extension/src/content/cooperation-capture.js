import { COOPERATION_ARM, COOPERATION_DISABLE, COOPERATION_MESSAGE, COOPERATION_OWNERS, COOPERATION_READ, COOPERATION_READY, COOPERATION_RESUME } from '../cooperation/types.js';
import { playbackProgressMedia } from '../cooperation/media-progress.js';
import { describeFrameOwners } from '../cooperation/hidden-frames.js';
import { OVERLAY_HOST_SELECTOR } from '../lib/overlay-bridge.js';
import { createRandomUuid } from '../lib/random-uuid.js';
import { sensitiveAutocomplete } from '../lib/sensitive-autocomplete.js';

/**
 * Isolated-world cooperation collector.
 *
 * The collector reports facts about page interaction — fields, human activity,
 * structural revision and whether a person is mid-gesture — never instructions
 * or inferred intent. It runs in every document, follows open and closed shadow
 * roots, and is driven by a lease-scoped message protocol.
 *
 * @typedef {object} InputExpectation
 * @property {'pointerdown' | 'keydown' | 'keypress' | 'wheel' | 'beforeinput' | 'clear'} type
 * Event type the dispatched input is expected to produce.
 * @property {number} [x] Expected visual-viewport X for pointer input.
 * @property {number} [y] Expected visual-viewport Y for pointer input.
 * @property {string} [key] Expected key for keyboard input.
 * @property {boolean} [keypress] This keydown also dispatches a keypress in the same native task.
 * @property {number} [timestamp] Native event time in epoch milliseconds.
 * @property {string} [text] One-shot `insertText` text; never reported.
 * @property {string} [id] Caller identity used to clear a stale expectation.
 *
 * @typedef {object} FieldChange
 * @property {string} id Collector-local element identity.
 * @property {string} label Accessible or textual label.
 * @property {string} value Sampled value, truncated to 500 characters.
 * @property {'media_progress'} [kind] A positively identified, non-submitted media timeline.
 *
 * @typedef {object} HumanActivityAttribution
 * @property {number} [expected_time] Expected event time, when one was armed.
 * @property {number} event_time Event time projected to epoch milliseconds.
 * @property {string} expected_type Event type the expectation was armed for.
 * @property {{ earliest: number, latest: number }} [expected_event_time] Native window the dispatch calibrated.
 * @property {number} event_timestamp Raw DOM event timestamp.
 *
 * @typedef {object} HumanActivity
 * @property {number} sequence Monotonic human-action counter.
 * @property {string} type DOM event type.
 * @property {string} label Labeled target, or `page` when there is no element.
 * @property {number} at Epoch ms when the activity was confirmed.
 * @property {HumanActivityAttribution} [attribution] Present only when native attribution did not match.
 * @property {string} [target_id] Collector-local target identity.
 * @property {string} [context] Nearest form, dialog or group label.
 *
 * @typedef {object} MediaState
 * @property {string} id Collector-local media identity.
 * @property {string | null} src Attribute source, when present.
 * @property {string} currentSrc Resolved source.
 * @property {string | null} srcObject Collector-local stream identity.
 * @property {string[]} tracks Stream track ids, sorted.
 * @property {{ id: string, src: string, type: string, media: string }[]} sources Source children.
 *
 * @typedef {object} PointerGesture
 * @property {boolean} agent True when the press was attributed to dispatched input.
 * @property {boolean} released True after the matching release event.
 * @property {boolean} confirmed True once the gesture became a click or edit.
 *
 * @typedef {object} InputSource
 * @property {EventTarget | null} target Element receiving the edit.
 * @property {boolean} agent True when the edit came from dispatched input.
 * @property {string} [before] Sampled value before the edit, for change detection.
 *
 * @typedef {object} ClockWindow
 * @property {number} earliest Earliest accepted native timestamp.
 * @property {number} latest Latest accepted native timestamp.
 *
 * @typedef {object} CooperationMessage
 * @property {string} [kind] Message kind: read, arm, resume, disable or owners.
 * @property {InputExpectation} [input] Expected input armed by the caller.
 * @property {string} [lease] Lease scoping the message to one agent session.
 *
 * @typedef {object} FrameState
 * @property {string} document Opaque document id, renewed after a route change.
 * @property {string} [focus] Collector-local identity of the deep active element.
 * @property {boolean} [focusIsDocument] True only for ordinary document focus.
 * @property {MediaState[]} [media] Media identity and source selection in this document.
 * @property {number} revision Monotonic counter advanced by every observable change.
 * @property {number} structure Counter advanced by DOM structure changes.
 * @property {number} human Monotonic counter of confirmed human actions.
 * @property {boolean} busy An interaction is in progress and still owns control.
 * @property {boolean} [pending] A gesture may still become a click or edit.
 * @property {boolean} [scrolling] Only coordinate-dependent input waits for scrolling.
 * @property {boolean} editing Whether a human is editing a field right now.
 * @property {number} lastInput Epoch ms of the latest confirmed human action.
 * @property {FieldChange[]} fields Sampled fields, at most 64.
 * @property {boolean} [fieldsComplete] False when fields were skipped or truncated.
 * @property {HumanActivity[]} events Recent human activity, oldest first, at most 64.
 *
 * @typedef {() => void} CooperationCapture Cleanup returned by {@link attachCooperationCapture}.
 */

const MAX_CHANGES = 64;
// Native dispatch and the DOM clock round independently. This bound is fixed;
// renderer or dispatch delay never widens input attribution.
const INPUT_CLOCK_PRECISION_MS = 1.5;
const OVERLAY_SELECTOR = [
  OVERLAY_HOST_SELECTOR,
  '[data-slot^="control-overlay"]',
  '[data-slot^="help-request"]',
  '[data-slot^="record-overlay"]',
  '[data-slot^="borrow-confirmation"]',
].join(', ');

/**
 * Attach the cooperation collector to this document.
 *
 * Isolated-world collection also covers frames; no page-world control API is
 * exposed. The returned cleanup detaches every listener and removes the runtime
 * listener, so a later collection starts from a clean document state.
 *
 * @returns {CooperationCapture}
 */
export function attachCooperationCapture() {
  let enabled = false;
  let lease;
  const retired = new Set();
  /** @type {FrameState} */
  const state = {
    document: createRandomUuid(),
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
  /** @type {InputExpectation | undefined} Input the current native dispatch should produce. */
  let expectation;
  /** @type {ClockWindow | undefined} Native clock window calibrated for the expectation. */
  let nativeTime;
  /** @type {number | undefined} Expectation time projected onto this document's clock. */
  let originTime;
  /** @type {HumanActivityAttribution | undefined} Why the last event missed its expectation. */
  let attribution;
  /** True while an input-method composition is in progress. */
  let composing = false;
  /** True while a page drag gesture is in progress. */
  let dragging = false;
  /** @type {boolean | undefined} Dispatch source of the drag, when known. */
  let dragAgent;
  /** @type {PointerGesture | undefined} Press gesture in flight. */
  let pointer;
  /** @type {Map<string, boolean>} Per-key dispatch source, false for human input. */
  const keys = new Map();
  /** @type {boolean | undefined} Dispatch source of the current event task. */
  let eventAgent;
  /** @type {Element | undefined} Field a human is currently editing. */
  let editingTarget;
  /** @type {InputSource | undefined} Edit whose input/change pair is still open. */
  let inputSource;
  /** @type {Element | null | undefined} Recipient of a one-shot insertText command. */
  let insertTarget;
  /** @type {Map<Element, FieldChange>} Sampled fields for the published state. */
  const fields = new Map();
  /** @type {WeakMap<Element, string>} Last sampled value per control. */
  const sampledValues = new WeakMap();
  /** @type {WeakMap<object, string>} Collector-local ids assigned to elements and streams. */
  const ids = new WeakMap();
  /** Monotonic collector-local id source. */
  let nextId = 0;
  /**
   * Stable collector-local id for one object, assigned on first use.
   *
   * @param {object} element
   * @returns {string}
   */
  const id = (element) => {
    let value = ids.get(element);
    if (!value) ids.set(element, (value = String(++nextId)));
    return value;
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} Debounced publish timer. */
  let timer;
  /** @type {ReturnType<typeof setTimeout> | undefined} Delayed focus-out settling. */
  let focusTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} Press gesture retirement. */
  let pointerTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} Per-task dispatch source retirement. */
  let eventTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} beforeinput source retirement. */
  let inputTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} Scroll activity retirement. */
  let scrollTimer;
  /** Overlay chrome never counts as page activity. */
  const overlay = (target) => target instanceof Element && !!target.closest(OVERLAY_SELECTOR);
  /** @type {WeakSet<Node>} Fields that were password inputs at some point. */
  const formerPasswords = new WeakSet();

  /**
   * Remember fields that stop being password inputs so their values stay
   * redacted.
   *
   * @param {MutationRecord[]} records
   * @returns {void}
   */
  const markFormerPasswords = (records) => {
    for (const record of records) if (record.oldValue?.toLowerCase() === 'password') formerPasswords.add(record.target);
  };
  /**
   * Field values that must never enter field state: passwords (including
   * fields switched away from password), file and hidden inputs, and sensitive
   * autocomplete hints. Such fields are dropped from the sample instead.
   */
  const secret = (target) => {
    if (target instanceof HTMLInputElement && target.type === 'password') {
      formerPasswords.add(target);
      return true;
    }
    return (target instanceof HTMLInputElement && ['file', 'hidden'].includes(target.type))
      || formerPasswords.has(target)
      || sensitiveAutocomplete(target.getAttribute('autocomplete'));
  };
  /**
   * Human-readable label for an event target, falling back to `page`.
   *
   * @param {EventTarget | null} target
   * @returns {string}
   */
  const label = (target) => {
    if (!(target instanceof Element)) return 'page';
    return (target.getAttribute('aria-label') || target.getAttribute('name') || target.getAttribute('placeholder') || target.textContent || target.tagName).trim().slice(0, 160);
  };
  /**
   * Whether an element is a field a person can currently edit.
   *
   * @param {EventTarget | null} target
   * @returns {boolean}
   */
  const editable = (target) => target instanceof Element
    && (target instanceof HTMLInputElement
      ? !target.readOnly && !target.disabled && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type)
      : target instanceof HTMLTextAreaElement
        ? !target.readOnly && !target.disabled
        : target instanceof HTMLElement && target.isContentEditable);
  /**
   * Value of a control, as a string; undefined for controls without a readable
   * value. File contents are never read.
   *
   * @param {EventTarget | null} target
   * @returns {string | undefined}
   */
  const inputValue = (target) => {
    if (target instanceof HTMLInputElement && target.type === 'file') return undefined;
    if (target instanceof HTMLInputElement) return ['checkbox', 'radio'].includes(target.type) ? String(target.checked) : target.value;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return target.value;
    if (target instanceof HTMLElement && target.isContentEditable) return target.innerHTML;
    return undefined;
  };

  /**
   * Derive the interaction flags from the gestures currently in flight.
   * `busy` means the person still owns control; `pending` means a gesture may
   * yet become a confirmed action.
   */
  const updateInteraction = () => {
    state.busy = dragging || (composing && state.editing) || !!(pointer?.confirmed && !pointer.released) || (state.editing && [...keys.values()].some((agent) => !agent));
    state.pending = !!(pointer && !pointer.agent && !pointer.confirmed) || (composing && !state.editing) || !!(inputSource && !inputSource.agent);
  };
  /**
   * Publish the current frame state now, cancelling a debounced publish.
   * Nothing is sent while collection is disabled.
   */
  const publish = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled) return;
    updateInteraction();
    state.fields = [...fields.values()];
    void chrome.runtime.sendMessage({ kind: COOPERATION_MESSAGE, lease, state: { ...state } }).catch(() => {});
  };
  /** Coalesce mutation bursts into one publish per 60 ms. */
  const schedule = () => { if (!timer) timer = setTimeout(publish, 60); };

  /** @param {MutationRecord[]} records */
  const mutations = (records) => {
    markFormerPasswords(records);
    if (!enabled || !records.some((record) => !overlay(record.target instanceof Element ? record.target : record.target.parentElement))) return;
    state.revision += 1;
    state.structure += 1;
    schedule();
  };
  /** Observes every root that has already been scanned for controls. */
  const observer = new MutationObserver(mutations);
  /** @type {Set<Document | ShadowRoot>} Roots already observed. */
  const roots = new Set();
  /** Page script cannot see closed roots, but the extension can. */
  const shadowRoot = (element) => element.shadowRoot ?? (element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot(element) ?? null : null);
  /**
   * Deepest focused element, following nested shadow roots.
   *
   * @returns {Element | null}
   */
  const activeElement = () => {
    let active = document.activeElement;
    while (active) {
      const nested = shadowRoot(active)?.activeElement;
      if (!nested) break;
      active = nested;
    }
    return active;
  };
  /** Observe each root once and yield its controls, including nested roots. */
  const controls = function* (root) {
    if (!roots.has(root)) {
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
      roots.add(root);
    }
    for (const element of root.querySelectorAll('*')) {
      if (overlay(element)) continue;
      if (element.matches('input,textarea,select,[contenteditable=true]')) yield element;
      const nested = shadowRoot(element);
      if (nested) yield* controls(nested);
    }
  };
  let documentUrl = location.href;
  /**
   * Read one consistent frame snapshot.
   *
   * Renews the document id on a route change, retires disconnected fields,
   * samples controls and media sources (including closed shadow roots), keeps
   * the revision counters current, and returns a detached copy.
   *
   * @returns {FrameState}
   */
  const read = () => {
    // SPA routes retain the DOM document but cannot retain its action authority.
    // This also covers child frames; root route events catch away-and-back.
    if (documentUrl !== location.href) {
      documentUrl = location.href;
      state.document = createRandomUuid();
      state.revision += 1;
    }
    mutations(observer.takeRecords());
    const active = activeElement();
    if (editingTarget && (active !== editingTarget || !editable(editingTarget))) {
      editingTarget = undefined;
      state.editing = false;
      composing = false;
      state.revision += 1;
    }
    state.focus = active ? id(active) : undefined;
    state.focusIsDocument = (active === document.body || active === document.documentElement)
      && !active?.matches('[tabindex],[role],[contenteditable]:not([contenteditable="false"])');
    // A detached shadow root can never yield controls again; observe from scratch.
    if ([...roots].some((root) => root instanceof ShadowRoot && !root.host.isConnected)) {
      observer.disconnect();
      roots.clear();
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    let fieldCount = 0;
    const mediaByRoot = new Map();
    state.fieldsComplete = true;
    for (const target of controls(document)) {
      if (overlay(target)) continue;
      const fullValue = target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)
        ? String(target.checked)
        : 'value' in target ? String(target.value) : (target.textContent ?? '');
      if (secret(target)) {
        fields.delete(target);
        if (target instanceof HTMLInputElement && target.type === 'file') sampledValues.delete(target);
        else sampledValues.set(target, fullValue);
        continue;
      }
      const value = fullValue.slice(0, 500);
      const name = label(target);
      let mediaProgress = false;
      if (target instanceof HTMLInputElement && target.type === 'range') {
        const root = target.getRootNode();
        let media = mediaByRoot.get(root);
        if (!media) {
          media = [...(root.querySelectorAll?.('video,audio') ?? [])].map((element) => ({ id: element.id }));
          mediaByRoot.set(root, media);
        }
        const labelledBy = (target.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id)?.textContent ?? '').join(' ');
        const labels = [...new Set(target.labels ?? [])].map((label) => label.textContent).join(' ');
        mediaProgress = !!playbackProgressMedia({
          tag: 'input',
          name: target.getAttribute('aria-label') || labelledBy || labels,
          attrs: Object.fromEntries([...target.attributes].map((attr) => [attr.name, attr.value])),
          inForm: target.form !== null,
        }, media);
      }
      fieldCount += 1;
      if (fieldCount > MAX_CHANGES || fullValue.length > 500) state.fieldsComplete = false;
      const sampled = sampledValues.get(target);
      if (sampled !== undefined && sampled !== fullValue) state.revision += 1;
      sampledValues.set(target, fullValue);
      const old = fields.get(target);
      if (fields.size < MAX_CHANGES || old) {
        fields.set(target, { id: id(target), label: name, value, ...(mediaProgress ? { kind: 'media_progress' } : {}) });
      }
    }
    for (const element of fields.keys()) if (!element.isConnected) fields.delete(element);
    const media = [...roots].flatMap((root) => [...root.querySelectorAll('video,audio')]).map((element) => {
      const stream = element.srcObject;
      return {
        id: id(element),
        src: element.getAttribute('src'),
        currentSrc: element.currentSrc,
        srcObject: stream ? id(stream) : null,
        tracks: typeof MediaStream !== 'undefined' && stream instanceof MediaStream ? stream.getTracks().map((track) => track.id).sort() : [],
        sources: [...element.children].filter((child) => child instanceof HTMLSourceElement).map((source) => ({
          id: id(source), src: source.src, type: source.type, media: source.media,
        })),
      };
    });
    // currentSrc/srcObject may change without a DOM mutation. Keep the source
    // evidence fresh even when the page's mutation counter did not advance.
    if (state.media && JSON.stringify(state.media) !== JSON.stringify(media)) state.revision += 1;
    state.media = media;
    updateInteraction();
    state.fields = [...fields.values()];
    return { ...state };
  };

  /**
   * Match one DOM event against the armed expectation.
   *
   * Compares in this document's monotonic clock and, for pointer input, against
   * visual-viewport coordinates. A match consumes the expectation, except that
   * a keydown which also produces a keypress is re-armed for the keypress. On a
   * miss, `attribution` records why the event could not be attributed.
   *
   * @param {Event} event
   * @returns {boolean}
   */
  const matches = (event) => {
    attribution = undefined;
    if (!expectation || expectation.type !== event.type) return false;
    const expected = expectation;
    const viewport = window.visualViewport;
    const matched = nativeTime !== undefined
      && ((event.timeStamp >= nativeTime.earliest && event.timeStamp <= nativeTime.latest)
        || (originTime !== undefined && Math.abs(event.timeStamp - originTime) <= INPUT_CLOCK_PRECISION_MS))
      && (event instanceof KeyboardEvent
        ? event.key === expected.key
        : event instanceof MouseEvent
          ? (window !== window.top || (Math.abs(event.clientX - (viewport?.offsetLeft ?? 0) - (expected.x ?? -1)) <= 2
            && Math.abs(event.clientY - (viewport?.offsetTop ?? 0) - (expected.y ?? -1)) <= 2))
          : true);
    attribution = matched ? undefined : {
      expected_time: expected.timestamp,
      event_time: event.timeStamp + performance.timeOrigin,
      expected_type: expected.type,
      expected_event_time: nativeTime,
      event_timestamp: event.timeStamp,
    };
    if (matched) expectation = expected.type === 'keydown' && expected.keypress ? { ...expected, type: 'keypress' } : undefined;
    return matched;
  };

  /**
   * Record one confirmed human action and publish it immediately.
   *
   * @param {Event} event
   * @param {EventTarget | null} target
   */
  const humanInput = (event, target) => {
    state.human += 1;
    state.revision += 1;
    state.lastInput = Date.now();
    state.events.push({
      sequence: state.human,
      type: event.type,
      label: label(target),
      at: state.lastInput,
      ...(attribution ? { attribution } : {}),
      ...(target instanceof Element ? { target_id: id(target), context: label(target.closest('fieldset,form,dialog,[role=dialog],[role=group]')).slice(0, 160) } : {}),
    });
    if (state.events.length > MAX_CHANGES) state.events.shift();
    publish();
  };
  /**
   * Classify one page event as dispatched input or human activity and update
   * the interaction flags. Only trusted human edits and actions are recorded;
   * a gesture that began on the page may finish on overlay chrome.
   *
   * @param {Event} event
   */
  const onEvent = (event) => {
    if (!enabled) return;
    // A gesture that started on the page must be allowed to finish even when the
    // release lands on toolbar chrome.
    const release = (dragging && ['dragend', 'drop'].includes(event.type))
      || (pointer && !pointer.released && ['pointerup', 'pointercancel'].includes(event.type))
      || (event.type === 'keyup' && keys.has(event.key));
    if (!release && event.composedPath().some(overlay)) return;
    let target = event.composedPath()[0] ?? event.target;
    // Closed shadow roots retarget editing events to their host. Resolve the same
    // deep focus used by collection and native text attribution.
    if (['beforeinput', 'input', 'change'].includes(event.type) && target instanceof Element && shadowRoot(target)) {
      target = activeElement() ?? target;
    }
    if (event.type === 'input' || event.type === 'change') {
      mutations(observer.takeRecords());
      const value = inputValue(target);
      let previous = target instanceof Element ? sampledValues.get(target) : undefined;
      // Rich editors compare their local markup during beforeinput, while the
      // observation's sampled value remains plain text.
      if (target instanceof HTMLElement && target.isContentEditable) previous = undefined;
      if (inputSource?.target === target) previous = inputSource.before;
      const source = inputSource?.target === target ? inputSource.agent : (eventAgent ?? pointer?.agent);
      const agent = eventAgent !== false && source === true;
      if (target instanceof Element && value !== undefined) {
        const fieldValue = target instanceof HTMLElement && target.isContentEditable ? (target.textContent ?? '') : value;
        sampledValues.set(target, fieldValue);
        if (secret(target)) {
          fields.delete(target);
        } else {
          fields.set(target, { id: id(target), label: label(target), value: fieldValue.slice(0, 500) });
          if (fields.size > MAX_CHANGES) {
            fields.clear();
            state.structure += 1;
          }
        }
      }
      state.revision += 1;
      if (event.isTrusted && !agent && value !== undefined && value !== previous) {
        editingTarget = editable(target) ? target : undefined;
        state.editing = !!editingTarget;
        if (pointer && !pointer.agent) {
          pointer.confirmed = true;
          if (target instanceof HTMLSelectElement) {
            pointer.released = true;
            clearTimeout(pointerTimer);
            pointerTimer = setTimeout(() => { pointer = undefined; state.revision += 1; publish(); }, 0);
          }
        }
        // An input/change pair describes one edit, including native select controls.
        if (inputSource?.target === target) inputSource.before = value;
        humanInput(event, target);
      } else schedule();
      return;
    }
    if (!event.isTrusted) return;
    if (event.type === 'dragend' || event.type === 'drop') {
      if (event.type === 'drop') {
        eventAgent = dragAgent;
        clearTimeout(eventTimer);
        eventTimer = setTimeout(() => { eventAgent = undefined; }, 0);
      }
      dragging = false;
      dragAgent = undefined;
      state.revision += 1;
      publish();
      return;
    }
    if (event.type === 'beforeinput') {
      const expected = expectation;
      // insertText has no native timestamp. Match this one command's literal text
      // and focused recipient, then retire it on input or native completion.
      const insert = expected?.type === 'beforeinput' && target === insertTarget && editable(target)
        && event.inputType === 'insertText' && event.data === expected.text;
      const human = eventAgent === false || pointer?.agent === false;
      const agent = !human && (insert || (eventAgent ?? pointer?.agent ?? false));
      if (insert && agent) expectation = undefined;
      inputSource = { target, agent, before: inputValue(target) };
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => { inputSource = undefined; publish(); }, 0);
      state.revision += 1;
      publish();
      return;
    }
    if (event.type === 'focusout') {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!enabled) return;
        if (editingTarget !== activeElement()) { editingTarget = undefined; state.editing = false; composing = false; }
        state.revision += 1;
        publish();
      }, 0);
      return;
    }
    if (event.type === 'pointerdown') {
      pointer = { agent: matches(event), released: false, confirmed: false };
      clearTimeout(pointerTimer);
      state.revision += 1;
      publish();
      return;
    }
    if (event.type === 'pointerup' || event.type === 'pointercancel') {
      if (pointer) pointer.released = true;
      clearTimeout(pointerTimer);
      // The default click follows pointerup in the same browser task.
      pointerTimer = setTimeout(() => { pointer = undefined; state.revision += 1; publish(); }, 0);
      if (event.type === 'pointercancel') pointer = undefined;
      state.revision += 1;
      publish();
      return;
    }
    if (event.type === 'wheel') {
      // Browsing never transfers control. Retain only the source for a native
      // control whose wheel handler actually changes its value in this task.
      eventAgent = matches(event);
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => { eventAgent = undefined; }, 0);
      return;
    }
    if (event.type === 'keydown' || event.type === 'keypress' || event.type === 'keyup') {
      const key = event.key;
      eventAgent = event.type === 'keyup' ? keys.get(key) : matches(event);
      if (event.type === 'keydown') keys.set(key, eventAgent ?? false);
      else if (event.type === 'keyup') keys.delete(key);
      let releasedPending = false;
      // Escape dismisses a native menu without a pointerup of its own.
      if (event.type === 'keydown' && key === 'Escape' && pointer && !pointer.agent && !pointer.confirmed) {
        pointer = undefined;
        clearTimeout(pointerTimer);
        state.revision += 1;
        releasedPending = true;
      }
      clearTimeout(eventTimer);
      const keypress = expectation?.keypress ? expectation : undefined;
      // beforeinput, input and keyboard activation inherit only this event task.
      eventTimer = setTimeout(() => {
        eventAgent = undefined;
        // A cancelled keydown may produce no keypress. Its expectation cannot
        // outlive the native task or authorize a later person's submission.
        if (keypress && expectation === keypress) expectation = undefined;
      }, 0);
      if (state.editing || releasedPending) publish();
      return;
    }
    if (event.type === 'compositionstart' || event.type === 'compositionend') {
      composing = event.type === 'compositionstart';
      state.revision += 1;
      publish();
      return;
    }
    // A native (Agent) submission is already described by its key or click.
    if (event.type === 'submit' && eventAgent !== false && pointer?.agent !== false) return;
    if (event.type === 'click' || event.type === 'auxclick' || event.type === 'dragstart' || event.type === 'submit') {
      const agent = event.detail === 0 ? (eventAgent ?? pointer?.agent ?? false) : (pointer?.agent ?? false);
      if (event.type === 'dragstart') dragAgent = agent;
      if (agent) return;
      if (event.type === 'dragstart') dragging = true;
      if (pointer) pointer.confirmed = true;
      if (editingTarget !== target && !(target instanceof Node && editingTarget?.contains(target) && editable(target))) {
        editingTarget = undefined;
        state.editing = false;
        composing = false;
      }
      humanInput(event, target);
    }
  };

  const events = ['pointerdown', 'pointerup', 'pointercancel', 'click', 'auxclick', 'dragstart', 'dragend', 'drop', 'submit', 'keydown', 'keyup', 'keypress', 'beforeinput', 'compositionstart', 'compositionend', 'focusout', 'input', 'change'];
  for (const event of events) document.addEventListener(event, onEvent, { capture: true, passive: true });
  /** @param {boolean} on Attach or detach the passive wheel listener. @returns {void} */
  const listenWheel = (on) => {
    if (on) window.addEventListener('wheel', onEvent, { capture: true, passive: true });
    else window.removeEventListener('wheel', onEvent, true);
  };
  /** Coordinate-dependent input waits for an actively scrolling viewport. */
  const onScroll = () => {
    if (!enabled) return;
    const started = !state.scrolling;
    state.scrolling = true;
    if (started) state.revision += 1;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { state.scrolling = false; publish(); }, 120);
    if (started) publish();
  };
  document.addEventListener('scroll', onScroll, true);
  /** A window blur ends every interaction in flight, so control is not held. */
  const onWindowBlur = () => {
    if (!enabled || (!pointer && !composing && !dragging && !state.editing && keys.size === 0 && !eventAgent && !inputSource)) return;
    clearTimeout(focusTimer);
    clearTimeout(pointerTimer);
    clearTimeout(eventTimer);
    clearTimeout(inputTimer);
    pointer = undefined;
    composing = false;
    dragging = false;
    dragAgent = undefined;
    state.editing = false;
    editingTarget = undefined;
    keys.clear();
    eventAgent = undefined;
    inputSource = undefined;
    state.revision += 1;
    publish();
  };
  window.addEventListener('blur', onWindowBlur);

  /**
   * Handle one lease-scoped cooperation message.
   *
   * Owns the read/arm/disable/resume lifecycle: a retired lease is ignored, a
   * read for a newer lease retires the previous one, and an arm without a
   * usable clock sample replies `undefined` so native dispatch can retry.
   *
   * @param {CooperationMessage} message
   * @param {unknown} _sender
   * @param {(value: unknown) => void} reply
   * @returns {false} Always false; every reply is sent synchronously.
   */
  const onMessage = (message, _sender, reply) => {
    // Layout facts for proving a child frame hidden. It grants nothing, so it
    // needs no lease and leaves collection state untouched.
    if (message.kind === COOPERATION_OWNERS) { reply(describeFrameOwners(document, shadowRoot)); return false; }
    if (typeof message.lease !== 'string') return false;
    if (message.kind === COOPERATION_READ) {
      if (retired.has(message.lease)) { reply(undefined); return false; }
      if (lease && lease !== message.lease) {
        retired.add(lease);
        expectation = undefined;
        insertTarget = undefined;
        inputSource = undefined;
      }
      lease = message.lease;
    } else if (message.kind === COOPERATION_DISABLE) {
      retired.add(message.lease);
      if (lease !== message.lease) { reply({ ...state }); return false; }
    } else if (!enabled || lease !== message.lease) return false;

    if (message.kind === COOPERATION_DISABLE) {
      enabled = false;
      listenWheel(false);
      clearTimeout(focusTimer);
      clearTimeout(pointerTimer);
      clearTimeout(eventTimer);
      clearTimeout(inputTimer);
      clearTimeout(scrollTimer);
      observer.disconnect();
      roots.clear();
      fields.clear();
      state.events = [];
      expectation = undefined;
      keys.clear();
      composing = false;
      dragging = false;
      dragAgent = undefined;
      pointer = undefined;
      state.editing = false;
      editingTarget = undefined;
      inputSource = undefined;
      eventAgent = undefined;
      insertTarget = undefined;
      state.pending = false;
      state.scrolling = false;
      reply({ ...state, busy: false, fields: [] });
    } else if (message.kind === COOPERATION_READ) {
      enabled = true;
      listenWheel(true);
      reply(read());
    } else if (message.kind === COOPERATION_ARM) {
      if (enabled && message.input?.type === 'clear') {
        if (expectation?.id === message.input.id) expectation = undefined;
      } else if (enabled && message.input) {
        expectation = message.input;
        insertTarget = expectation.type === 'beforeinput' ? activeElement() : undefined;
        nativeTime = undefined;
        originTime = undefined;
        if (expectation.timestamp !== undefined) {
          for (let attempt = 0; attempt < 3 && !nativeTime; attempt += 1) {
            const before = performance.now();
            const wallTime = Date.now();
            const after = performance.now();
            // Date.now() truncates to milliseconds; native conversion and DOM
            // timestamps add independent precision loss in either direction.
            if (after - before <= 0.5) {
              const offset = expectation.timestamp - wallTime;
              nativeTime = { earliest: before + offset - 1 - INPUT_CLOCK_PRECISION_MS, latest: after + offset + INPUT_CLOCK_PRECISION_MS };
              // Native and renderer wall clocks are sampled in different processes.
              // Use the epoch projection only within this calibration's budget: a
              // stale origin or delayed delivery must never create a distant window.
              const projected = expectation.timestamp - performance.timeOrigin;
              if (projected >= nativeTime.earliest - INPUT_CLOCK_PRECISION_MS && projected <= nativeTime.latest + INPUT_CLOCK_PRECISION_MS) originTime = projected;
            }
          }
          if (!nativeTime) {
            // The bridge can retry this read; native dispatch must wait for a
            // usable clock sample rather than create false human activity.
            expectation = undefined;
            reply(undefined);
            return false;
          }
        }
      }
      reply(read());
    } else if (message.kind === COOPERATION_RESUME) {
      // An explicit hand-back ends an editing lease, never a drag or composition.
      state.editing = false;
      editingTarget = undefined;
      state.revision += 1;
      publish();
      reply(read());
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);
  void chrome.runtime.sendMessage({ kind: COOPERATION_READY }).catch(() => {});

  /**
   * Detach every listener, observer and timer and stop collecting this
   * document.
   *
   * @returns {void}
   */
  return () => {
    clearTimeout(timer);
    clearTimeout(focusTimer);
    clearTimeout(pointerTimer);
    clearTimeout(eventTimer);
    clearTimeout(inputTimer);
    clearTimeout(scrollTimer);
    observer.disconnect();
    chrome.runtime.onMessage.removeListener(onMessage);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('scroll', onScroll, true);
    for (const event of events) document.removeEventListener(event, onEvent, true);
    listenWheel(false);
  };
}
