/**
 * Compile capture drafts into record-only v2 trace steps.
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
 */

import { resolveDraftStartUrl, shouldIncludeDraft } from './draft-policy.js';

/**
 * Collapse consecutive navigations to the last hop.
 *
 * @param {RecordingDraftStep[]} steps
 * @returns {RecordingDraftStep[]}
 */
function collapseNavigations(steps) {
  const out = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (step.op === 'navigate' && prev?.op === 'navigate') {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

/**
 * @param {RecordingDraftStep[]} steps
 * @param {string} [startUrl]
 * @returns {string[]}
 */
function collectUrls(steps, startUrl) {
  const urls = [];
  if (startUrl) urls.push(startUrl);
  for (const step of steps) {
    if (step.op === 'navigate') { urls.push(step.url); continue; }
    if (step.pageUrl) urls.push(step.pageUrl);
    if (step.navigatedTo) urls.push(step.navigatedTo);
  }
  const seen = new Set();
  return urls.filter((url) => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/**
 * @param {RecordingDraftStep[]} steps
 * @param {string} [startUrl]
 * @returns {{ pages: object[], urlToId: Map<string, string> }}
 */
function buildPageRegistry(steps, startUrl) {
  const urls = collectUrls(steps, startUrl);
  const urlToId = new Map();
  const pages = urls.map((url, index) => {
    const id = `p${index + 1}`;
    urlToId.set(url, id);
    return { id, url };
  });
  return { pages, urlToId };
}

/**
 * @param {string} [url]
 * @param {Map<string, string>} urlToId
 * @param {string} [fallbackUrl]
 * @returns {string}
 */
function pageIdFor(url, urlToId, fallbackUrl) {
  if (url && urlToId.has(url)) return urlToId.get(url);
  if (fallbackUrl && urlToId.has(fallbackUrl)) return urlToId.get(fallbackUrl);
  return urlToId.values().next().value ?? 'p1';
}

/**
 * @param {RecordingDraftStep} step
 * @param {string} [fallbackUrl]
 * @returns {string | undefined}
 */
function pageUrlForDraft(step, fallbackUrl) {
  if (step.op === 'navigate') return step.pageUrl ?? step.url;
  if (step.pageUrl) return step.pageUrl;
  return fallbackUrl;
}

/**
 * @param {string} [navigatedTo]
 * @param {Map<string, string>} urlToId
 * @returns {object | undefined}
 */
function effectForNavigation(navigatedTo, urlToId) {
  if (!navigatedTo) return undefined;
  const pageId = urlToId.get(navigatedTo);
  return pageId ? { navigated_to: pageId } : undefined;
}

/**
 * @param {object} step
 * @param {object} [effect]
 * @returns {object}
 */
function withEffect(step, effect) { return effect ? { ...step, effect } : step; }

/**
 * @param {string[]} values
 * @param {string[]} [labels]
 * @returns {object[]}
 */
function toSelection(values, labels) {
  return values.map((value, index) => ({ value, ...(labels?.[index] ? { label: labels[index] } : {}) }));
}

/**
 * @param {RecordingDraftStep} step
 * @param {number} id
 * @param {Map<string, string>} urlToId
 * @param {string} [fallbackUrl]
 * @returns {object | null}
 */
function toV2Step(step, id, urlToId, fallbackUrl) {
  if (!shouldIncludeDraft(step)) return null;
  const pageUrl = pageUrlForDraft(step, fallbackUrl);
  const page = pageIdFor(pageUrl, urlToId, fallbackUrl);
  switch (step.op) {
    case 'navigate': return { op: 'navigate', id, page: pageIdFor(step.url, urlToId, fallbackUrl), to: step.url };
    case 'click':
      if (!step.captureTarget) return null;
      return withEffect({ op: 'click', id, page, target: step.captureTarget }, effectForNavigation(step.navigatedTo, urlToId));
    case 'fill':
      if (!step.captureTarget) return null;
      return { op: 'fill', id, page, target: step.captureTarget, value: step.value, ...(step.redacted ? { redacted: true } : {}) };
    case 'press':
      return withEffect({ op: 'press', id, page, key: step.key, ...(step.captureTarget ? { target: step.captureTarget } : {}), ...(step.modifiers?.length ? { modifiers: step.modifiers } : {}) }, effectForNavigation(step.navigatedTo, urlToId));
    case 'select':
      if (!step.captureTarget) return null;
      return withEffect({ op: 'select', id, page, target: step.captureTarget, selection: toSelection(step.values, step.labels) }, effectForNavigation(step.navigatedTo, urlToId));
    case 'hover':
    case 'scroll':
    case 'switch_tab':
      return null;
    default:
      return null;
  }
}

/**
 * @param {RecordingDraftStep[]} steps
 * @param {string} [startUrl]
 * @returns {{ pages: object[], steps: object[] }}
 */
function reduceTraceSteps(steps, startUrl) {
  const collapsed = collapseNavigations(steps);
  const { pages, urlToId } = buildPageRegistry(collapsed, startUrl);
  const out = [];
  let id = 1;
  let lastUrl = startUrl;
  for (const draft of collapsed) {
    if (draft.op === 'navigate') lastUrl = draft.url;
    else if (draft.navigatedTo) lastUrl = draft.navigatedTo;
    else if (draft.pageUrl) lastUrl = draft.pageUrl;
    const step = toV2Step(draft, id, urlToId, lastUrl);
    if (!step) continue;
    out.push(step);
    id += 1;
  }
  return { pages, steps: out };
}

/**
 * @param {RecordingDraftStep[]} drafts
 * @param {string} [startUrl]
 * @param {object[]} [pages]
 * @returns {string}
 */
function resolveTraceStartUrl(drafts, startUrl, pages) {
  return resolveDraftStartUrl(drafts, startUrl, pages?.[0]?.url);
}

/**
 * @param {{ steps: RecordingDraftStep[], startedAt: string, startUrl?: string, purpose?: string }} input
 * @returns {object}
 */
export function buildTraceV2(input) {
  const { pages, steps } = reduceTraceSteps(input.steps, input.startUrl);
  return {
    recorded_at: new Date().toISOString(),
    started_at: input.startedAt,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    entry: { start_url: resolveTraceStartUrl(input.steps, input.startUrl, pages) },
    pages,
    steps,
  };
}
