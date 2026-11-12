import { redactUrl } from './redact.js';

/** Retained performance records per document visit. */
export const PERFORMANCE_LIMIT = 20;
/** Metrics advertised with per-state validity and reasons. */
export const PERFORMANCE_METRICS = [
  'ttfb_ms', 'dom_content_loaded_ms', 'load_ms', 'fcp_ms', 'lcp_ms', 'cls',
  'long_task_count', 'long_task_total_ms', 'long_task_max_ms',
];
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const strings = (value) => Array.isArray(value)
  ? value.filter((s) => typeof s === 'string').slice(0, 16).map((s) => s.slice(0, 80))
  : [];

/** Bindings are isolated, but still validate lengths/types before persistent storage.
 *
 * Invalid documents are dropped rather than repaired: a partial record could
 * be mistaken for a completed measurement. Only recognized metric states are
 * retained, and every list is bounded before it reaches storage.
 *
 * @param {unknown} value Raw snapshot reported by the page binding.
 * @returns {object | undefined} Sanitized record, or undefined when invalid.
 */
export function performanceSnapshot(value) {
  if (!value || typeof value !== 'object') return undefined;
  const data = value;
  if (
    typeof data.document_key !== 'string' ||
    !/^\d+(?:\.\d+)?:\d+$/.test(data.document_key) ||
    data.document_key.length > 64 ||
    !finite(data.started_at) || !finite(data.time_origin) || !finite(data.observed_at) ||
    typeof data.url !== 'string' || !/^https?:/.test(data.url)
  ) return undefined;
  const metrics = {};
  for (const key of PERFORMANCE_METRICS) {
    const entry = data.metrics?.[key];
    if (!entry || !['available', 'provisional', 'partial', 'unavailable', 'unsupported'].includes(entry.state)) continue;
    metrics[key] = { ...(finite(entry.value) ? { value: entry.value } : {}), state: entry.state, reasons: strings(entry.reasons) };
  }
  return {
    document_key: data.document_key,
    time_origin: data.time_origin,
    started_at: data.started_at,
    observed_at: data.observed_at,
    url: redactUrl(data.url),
    navigation: typeof data.navigation === 'string' ? data.navigation.slice(0, 40) : 'unknown',
    state: data.state === 'completed' ? 'completed' : 'capturing',
    early: data.early === true,
    scope: 'main_frame',
    metrics,
    visibility: Array.isArray(data.visibility)
      ? data.visibility.slice(0, 64).filter((v) => v && finite(v.at) && ['hidden', 'visible'].includes(v.state)).map((v) => ({ at: v.at, state: v.state }))
      : [],
    visibility_truncated: !!data.visibility_truncated,
    long_tasks: Array.isArray(data.long_tasks)
      ? data.long_tasks.slice(0, 50).filter((t) => t && finite(t.at) && finite(t.duration_ms)).map((t) => ({ at: t.at, duration_ms: t.duration_ms }))
      : [],
    long_tasks_truncated: !!data.long_tasks_truncated,
    coverage: strings(data.coverage),
  };
}

/**
 * Close a capturing record without pretending its metrics are final.
 *
 * Provisional values become partial and gain the interruption reason, while
 * terminal states are left untouched.
 *
 * @param {object} entry Retained performance record, updated in place.
 * @param {string} reason Coverage reason such as `navigation` or `stopped`.
 * @returns {void}
 */
export function interruptPerformance(entry, reason) {
  if (entry.state !== 'capturing') return;
  entry.state = 'interrupted';
  entry.coverage = [...new Set([...entry.coverage, reason])];
  for (const metric of Object.values(entry.metrics)) {
    if (metric.state === 'provisional') {
      metric.state = 'partial';
      metric.reasons = [...new Set([...metric.reasons, reason])];
    }
  }
}
