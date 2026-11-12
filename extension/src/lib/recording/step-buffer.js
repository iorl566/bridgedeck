import { hasRedirectQualifier } from './navigation-policy.js';

/**
 * Append-only buffer of recording drafts plus its navigation cursor.
 *
 * @typedef {object} RecordingNavigationCursor
 * @property {string} [currentUrl]
 * @property {boolean} pendingNavigation
 * @property {number} [pendingNavigationDeadline]
 *
 * @typedef {object} RecordingStepBuffer
 * @property {object[]} steps
 * @property {RecordingNavigationCursor} navigation
 *
 * @typedef {{ kind: 'noop' } | { kind: 'annotated', index: number }
 *   | { kind: 'appended', index: number }
 *   | { kind: 'coalesce_redirect', url: string }} NavigationObserveResult
 */

const NAVIGATION_TRIGGER_WINDOW_MS = 3_000;

function toDraftStep(payload, targetHint) {
  const pageUrl = payload.page_url;
  const common = { ...(pageUrl ? { pageUrl } : {}), ...(targetHint ? { targetHint } : {}) };
  switch (payload.op) {
    case 'click': return payload.target ? { op: 'click', captureTarget: payload.target, ...common } : null;
    case 'hover': return payload.target ? { op: 'hover', captureTarget: payload.target, ...common } : null;
    case 'fill':
      return payload.target ? { op: 'fill', captureTarget: payload.target, value: payload.value ?? '', ...(payload.commit ? { commit: payload.commit } : {}), ...(payload.redacted ? { redacted: true } : {}), ...common } : null;
    case 'press':
      return payload.key ? { op: 'press', key: payload.key, ...(payload.target ? { captureTarget: payload.target } : {}), ...(payload.modifiers?.length ? { modifiers: payload.modifiers } : {}), ...common } : null;
    case 'select':
      return payload.target && payload.values ? { op: 'select', captureTarget: payload.target, values: payload.values, ...(payload.labels?.length ? { labels: payload.labels } : {}), ...common } : null;
    case 'navigate': return null;
    default: return null;
  }
}

function annotateLastStepNavigation(buffer, url) {
  for (let index = buffer.steps.length - 1; index >= 0; index -= 1) {
    const step = buffer.steps[index];
    if (!step) continue;
    if (step.op === 'click' || step.op === 'press' || step.op === 'select' || step.op === 'fill') {
      step.navigatedTo = url;
      return index;
    }
    break;
  }
  return -1;
}

/**
 * @param {RecordingStepBuffer} buffer
 * @param {string} url
 * @param {boolean} [causedByAction]
 * @param {string} [transitionType]
 * @param {string[]} [transitionQualifiers]
 * @returns {NavigationObserveResult}
 */
export function observeRecordedNavigation(buffer, url, causedByAction, transitionType, transitionQualifiers) {
  const navigation = buffer.navigation;
  const isReload = transitionType === 'reload';
  if (!url || (url === navigation.currentUrl && !isReload)) return { kind: 'noop' };
  navigation.currentUrl = url;
  const pendingIsCurrent = navigation.pendingNavigation && (navigation.pendingNavigationDeadline === undefined || navigation.pendingNavigationDeadline >= Date.now());
  if (causedByAction === true || (causedByAction === undefined && pendingIsCurrent)) {
    navigation.pendingNavigation = false;
    navigation.pendingNavigationDeadline = undefined;
    const annotatedIndex = annotateLastStepNavigation(buffer, url);
    if (annotatedIndex >= 0) return { kind: 'annotated', index: annotatedIndex };
  } else {
    navigation.pendingNavigation = false;
    navigation.pendingNavigationDeadline = undefined;
  }
  if (hasRedirectQualifier(transitionQualifiers)) return { kind: 'coalesce_redirect', url };
  buffer.steps.push({ op: 'navigate', url, pageUrl: url, transitionType, transitionQualifiers });
  return { kind: 'appended', index: buffer.steps.length - 1 };
}

/**
 * @param {RecordingStepBuffer} buffer
 * @param {object} payload
 * @param {object} [targetHint]
 * @returns {number | null}
 */
export function appendRecordedPayload(buffer, payload, targetHint) {
  if (payload.op === 'navigate') {
    if (!payload.url) return null;
    const result = observeRecordedNavigation(buffer, payload.url, payload.navigation_caused_by_action, payload.transitionType, payload.transitionQualifiers);
    return result.kind === 'appended' ? result.index : null;
  }
  const step = toDraftStep({ ...payload, page_url: payload.page_url ?? buffer.navigation.currentUrl }, targetHint);
  if (!step) return null;
  buffer.steps.push(step);
  if (step.op === 'click' || step.op === 'press' || step.op === 'select' || step.op === 'fill') {
    buffer.navigation.pendingNavigation = payload.expects_navigation === true;
    buffer.navigation.pendingNavigationDeadline = buffer.navigation.pendingNavigation ? Date.now() + NAVIGATION_TRIGGER_WINDOW_MS : undefined;
  }
  return buffer.steps.length - 1;
}
