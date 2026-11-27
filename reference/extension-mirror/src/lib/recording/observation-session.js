import { captureRecordingObservation } from './observation-capture.js';
import { RecordingStateRegistry } from './state-registry.js';
import { matchObservationTarget, unmatchedTarget } from './target-matcher.js';

/**
 * Per-tab observation state shared by recording.
 *
 * @typedef {object} TabObservationCursor
 * @property {object | null} lastSettled
 * @property {number} lastCaptureAt
 *
 * @typedef {object} RecordingObservationSessionOptions
 * @property {object} [registry]
 * @property {TabObservationCursor} [cursor]
 * @property {object[]} [annotations]
 * @property {number} [maxTokens]
 * @property {boolean} [redactValues]
 * @property {object} [deps]
 * @property {() => number} [now]
 */

const DEFAULT_MAX_PAGE_TOKENS = 3_000;
const MIN_CAPTURE_INTERVAL_MS = 200;

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function isTargeted(draft) {
  return draft.op === 'click' || draft.op === 'hover' || draft.op === 'fill' || draft.op === 'press' || draft.op === 'select';
}

/** Tracks the last settled observation, its state and target annotations. */
export class RecordingObservationSession {
  /** @param {RecordingObservationSessionOptions} [options] */
  constructor(options = {}) {
    this.registry = options.registry ?? new RecordingStateRegistry();
    this.cursor = options.cursor ?? { lastSettled: null, lastCaptureAt: 0 };
    this.annotations = options.annotations ?? [];
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_PAGE_TOKENS;
    this.redactValues = options.redactValues ?? false;
    this.deps = options.deps ?? {};
    this.now = options.now ?? Date.now;
  }

  /**
   * @param {object} cdp
   * @param {object} tabsApi
   * @param {number} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async capture(cdp, tabsApi, tabId, signal) {
    const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (this.now() - this.cursor.lastCaptureAt));
    if (waitMs > 0) await abortableDelay(waitMs, signal);
    if (signal?.aborted) throw new DOMException('observation aborted', 'AbortError');
    const captured = await (this.deps.capture ?? captureRecordingObservation)({
      cdp,
      tabsApi,
      tabId,
      maxTokens: this.maxTokens,
      redactValues: this.redactValues,
      signal,
    }, this.deps.captureDeps);
    const state = this.registry.register({
      url: captured.url,
      title: captured.title,
      vomText: captured.vomText,
      truncated: captured.truncated,
    });
    const observation = { stateId: state.id, rootFrameId: captured.rootFrameId, index: captured.index, url: captured.url };
    this.cursor.lastSettled = observation;
    this.cursor.lastCaptureAt = this.now();
    return observation;
  }

  /**
   * @param {object} draft
   * @param {number} draftId
   * @param {boolean} [previousActionPending]
   * @returns {void}
   */
  bindDraft(draft, draftId, previousActionPending = false) {
    const observation = this.cursor.lastSettled;
    if (isTargeted(draft)) {
      draft.matchedTarget = observation
        ? matchObservationTarget({ observation, hint: draft.targetHint, fallback: draft.captureTarget })
        : unmatchedTarget(draft.captureTarget);
    }
    if (!observation) return;
    const unmatched = isTargeted(draft) && draft.matchedTarget?.unmatched === true;
    if (previousActionPending && unmatched) return;
    draft.preStateId = observation.stateId;
    this.registry.markStep(observation.stateId, draftId);
    if (!isTargeted(draft) || !draft.matchedTarget?.ref) return;
    const ref = observation.index.ref(draft.matchedTarget.ref);
    if (!ref) return;
    this.annotations.push({
      draftId,
      op: draft.op,
      line: ref.line,
      stateId: observation.stateId,
      ...(draft.op === 'fill' && !this.redactValues && !draft.redacted ? { detail: JSON.stringify(draft.value) } : {}),
    });
  }
}
