import { shouldIncludeDraft } from './draft-policy.js';
import { hasRedirectQualifier } from './navigation-policy.js';
/**
 * Compile capture drafts into state-linked v3 trace steps.
 *
 * @typedef {object} RecordingDraftStep
 * @property {string} op
 * @property {string} [pageUrl]
 * @property {string} [navigatedTo]
 * @property {string} [url]
 * @property {object} [captureTarget]
 * @property {string} [value]
 * @property {boolean} [redacted]
 * @property {string} [key]
 * @property {string[]} [modifiers]
 * @property {string[]} [values]
 * @property {string[]} [labels]
 *
 * @typedef {object} ReducedTraceV3
 * @property {object[]} steps
 * @property {Map<number, number>} stepIdByDraftId
 */

import { unmatchedTarget } from './target-matcher.js';

const TRANSITION_CAUSES = {
  typed: 'user_typed',
  generated: 'user_typed',
  keyword: 'user_typed',
  keyword_generated: 'user_typed',
  link: 'link',
  form_submit: 'form_submit',
  reload: 'reload',
  auto_bookmark: 'browser',
  start_page: 'browser',
};

/**
 * @param {RecordingDraftStep} step
 * @returns {boolean}
 */
function isRedirect(step) { return hasRedirectQualifier(step.transitionQualifiers); }

/**
 * @param {RecordingDraftStep[]} steps
 * @returns {{ draft: RecordingDraftStep, draftIds: number[] }[]}
 */
function collapseRedirects(steps) {
  const output = [];
  steps.forEach((step, index) => {
    const previous = output[output.length - 1];
    if (step.op === 'navigate' && previous?.draft.op === 'navigate' && isRedirect(step)) {
      previous.draft = { ...previous.draft, url: step.url, postStateId: step.postStateId ?? previous.draft.postStateId };
      previous.draftIds.push(index + 1);
      return;
    }
    output.push({ draft: { ...step }, draftIds: [index + 1] });
  });
  return output;
}

/**
 * @param {RecordingDraftStep} step
 * @returns {string}
 */
function navigationCause(step) {
  if (step.cause) return step.cause;
  const qualifiers = step.transitionQualifiers ?? [];
  if (qualifiers.includes('forward_back')) return 'history';
  if (qualifiers.includes('from_address_bar')) return 'user_typed';
  return TRANSITION_CAUSES[step.transitionType ?? ''] ?? 'browser';
}

/**
 * @param {string[]} values
 * @param {string[]} [labels]
 * @returns {object[]}
 */
function selection(values, labels) {
  return values.map((value, index) => ({ value, ...(labels?.[index] ? { label: labels[index] } : {}) }));
}

/**
 * @param {RecordingDraftStep} draft
 * @param {number} id
 * @param {{ includeTabSwitches: boolean, redactValues: boolean }} options
 * @returns {object | null}
 */
function reduceDraft(draft, id, options) {
  if (!shouldIncludeDraft(draft)) return null;
  if (draft.op === 'switch_tab') {
    if (!options.includeTabSwitches || !draft.preStateId || !draft.postStateId) return null;
    return { op: 'switch_tab', id, state: draft.preStateId, result: { state: draft.postStateId } };
  }
  const state = draft.preStateId ?? draft.postStateId;
  const resultState = draft.postStateId ?? draft.preStateId;
  if (!state || !resultState) return null;
  const common = { id, state, result: { state: resultState } };
  switch (draft.op) {
    case 'navigate': return { op: 'navigate', ...common, to: draft.url, cause: navigationCause(draft) };
    case 'click': return { op: 'click', ...common, target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) };
    case 'hover': return { op: 'hover', ...common, target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) };
    case 'fill': {
      const redacted = options.redactValues || draft.redacted === true;
      return { op: 'fill', ...common, target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget), value: redacted ? '***' : draft.value, commit: draft.commit ?? 'blur', ...(redacted ? { redacted: true } : {}) };
    }
    case 'press': return { op: 'press', ...common, key: draft.key, ...(draft.captureTarget || draft.matchedTarget ? { target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget) } : {}), ...(draft.modifiers?.length ? { modifiers: draft.modifiers } : {}) };
    case 'select': return { op: 'select', ...common, target: draft.matchedTarget ?? unmatchedTarget(draft.captureTarget), ...(!options.redactValues ? { selection: selection(draft.values, draft.labels) } : {}) };
    case 'scroll': return { op: 'scroll', ...common };
    default: return null;
  }
}

/**
 * @param {RecordingDraftStep[]} steps
 * @param {{ includeTabSwitches?: boolean, redactValues?: boolean }} [options]
 * @returns {ReducedTraceV3}
 */
export function reduceTraceStepsV3(steps, options = {}) {
  const output = [];
  const stepIdByDraftId = new Map();
  for (const { draft, draftIds } of collapseRedirects(steps)) {
    const step = reduceDraft(draft, output.length + 1, { includeTabSwitches: options.includeTabSwitches === true, redactValues: options.redactValues === true });
    if (!step) continue;
    output.push(step);
    for (const draftId of draftIds) stepIdByDraftId.set(draftId, step.id);
  }
  return { steps: output, stepIdByDraftId };
}
