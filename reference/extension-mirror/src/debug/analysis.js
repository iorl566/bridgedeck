import { matchesRequest } from './query.js';

/**
 * Deterministic re-reads of retained requests: endpoint aggregates and suspected
 * duplicate groups. Nothing here observes a page or changes stored evidence.
 *
 * Evidence shapes (`DebugRequest`, `DebugRecording`, `DebugParams`,
 * `DebugResult`, `DebugEndpoint`, `DebugDuplicate`, `DebugAnalysis`) are declared
 * in ./types.js; the bare names below refer to those declarations.
 */

/**
 * @param {DebugRequest} entry
 * @returns {boolean} True when the request was changed, mocked, blocked or replayed.
 */
const controlled = (entry) => !!(entry.intervention || entry.replay_id || entry.replay_from);
/**
 * @param {DebugRequest} entry
 * @returns {number | undefined} Captured duration in milliseconds, if usable.
 */
const duration = (entry) => (typeof entry.duration_ms === 'number' && Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0 ? entry.duration_ms : undefined);
/**
 * @param {string} value
 * @returns {boolean} True for absolute HTTP(S) URLs; unparsable input is false.
 */
function httpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
/**
 * @param {DebugRequest} entry Request with a parseable HTTP(S) URL.
 * @returns {string} Origin plus path, without query values or fragment.
 */
function endpoint(entry) {
  const url = new URL(entry.url);
  return `${url.origin}${url.pathname}`;
}
/**
 * Group requests by method and exact origin/path.
 *
 * Duration percentiles use nearest rank over captured samples only; requests
 * without a usable duration still count toward the group but not the timings.
 * Reference ids lead with failures and slow entries so a truncated list keeps
 * the interesting ones.
 *
 * @param {DebugRequest[]} entries Comparable requests.
 * @param {number} slow Threshold in milliseconds counted as slow.
 * @returns {DebugEndpoint[]} Aggregates, most frequent first.
 */
function aggregate(entries, slow) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.method} ${endpoint(entry)}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const samples = group.flatMap((e) => (duration(e) === undefined ? [] : [duration(e)])).sort((a, b) => a - b);
    const total = samples.reduce((sum, value) => sum + value, 0);
    const statuses = {};
    for (const e of group) if (e.status !== undefined) statuses[e.status] = (statuses[e.status] ?? 0) + 1;
    const refs = [...group].sort((a, b) => Number(b.state === 'failed' || (b.status ?? 0) >= 400) - Number(a.state === 'failed' || (a.status ?? 0) >= 400) || (duration(b) ?? 0) - (duration(a) ?? 0) || a.id.localeCompare(b.id));
    const bytes = group.filter((e) => typeof e.transfer_bytes === 'number' && Number.isFinite(e.transfer_bytes) && e.transfer_bytes >= 0);
    return {
      id: `aggregate:${group[0].id}`,
      method: group[0].method,
      endpoint: endpoint(group[0]),
      count: group.length,
      failed: group.filter((e) => e.state === 'failed').length,
      http_errors: group.filter((e) => (e.status ?? 0) >= 400).length,
      pending: group.filter((e) => e.state === 'pending').length,
      interrupted: group.filter((e) => e.state === 'interrupted').length,
      statuses,
      slow: samples.filter((ms) => ms >= slow).length,
      timing_samples: samples.length,
      ...(samples.length ? { duration_ms: { min: samples[0], mean: total / samples.length, p50: samples[Math.ceil(samples.length * 0.5) - 1], p95: samples[Math.ceil(samples.length * 0.95) - 1], max: samples.at(-1), total } } : {}),
      transfer_bytes: bytes.reduce((sum, e) => sum + e.transfer_bytes, 0),
      transfer_samples: bytes.length,
      cached: group.filter((e) => e.from_cache).length,
      service_worker: group.filter((e) => e.from_service_worker).length,
      controlled: group.filter((e) => e.intervention).length,
      replayed: group.filter((e) => e.replay_id || e.replay_from).length,
      request_ids: refs.slice(0, 50).map((e) => e.id),
      refs_truncated: group.length > 50,
    };
  }).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method) || a.endpoint.localeCompare(b.endpoint));
}
/**
 * Group requests that share method, retained URL, request body and document
 * identity inside one start-time window. Groups are suspected, not proven.
 *
 * @param {DebugRequest[]} entries Comparable requests.
 * @param {DebugRecording} record Supplies operations for correlation.
 * @param {DebugAnalysis} analysis Counters and coverage updated in place.
 * @returns {DebugDuplicate[]} Suspected duplicate groups, most extra requests first.
 */
function duplicates(entries, record, analysis) {
  const buckets = new Map();
  const result = [];
  for (const entry of entries) {
    const body = entry.request_body;
    if (!Number.isFinite(entry.started_at) || entry.url.length >= 2048 || /\[redacted\]|%5bredacted%5d/i.test(entry.url) || !['empty', 'available'].includes(body.state) || (body.state === 'available' && body.text === undefined) || /\[redacted\]|%5bredacted%5d/i.test(body.text ?? '')) {
      analysis.uncomparable += 1;
      continue;
    }
    if (!entry.loader_id || !entry.frame_id) {
      analysis.coverage.push('missing_document_identity');
      analysis.uncomparable += 1;
      continue;
    }
    const key = JSON.stringify([entry.method, entry.url, entry.frame_id ?? '', entry.loader_id ?? '', body.text ?? '']);
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  const emit = (group) => {
    if (group.length < 2) return;
    let overlap = 0;
    let lastFinish = -Infinity;
    for (const e of group) {
      if (e.started_at < lastFinish) overlap += 1;
      lastFinish = Math.max(lastFinish, e.finished_at ?? (e.state === 'pending' ? Infinity : e.started_at));
    }
    const operationIds = record.operations.filter((op) => group.some((e) => e.started_at >= op.started_at && e.started_at <= (op.window_end ?? op.finished_at ?? op.started_at))).map((op) => op.id);
    result.push({
      id: `duplicate:${group[0].id}`,
      method: group[0].method,
      url: group[0].url,
      count: group.length,
      extra_requests: group.length - 1,
      started_at: group[0].started_at,
      ended_at: group.at(-1).started_at,
      overlap_count: overlap,
      possible_retry: group.slice(0, -1).some((e) => e.state === 'failed' || (e.status ?? 0) >= 400),
      request_ids: group.slice(0, 50).map((e) => e.id),
      operation_ids: operationIds.slice(0, 10),
      refs_truncated: group.length > 50 || operationIds.length > 10,
    });
  };
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id));
    let group = [];
    for (const entry of bucket) {
      if (group.length && entry.started_at - group[0].started_at > analysis.window_ms) { emit(group); group = []; }
      group.push(entry);
    }
    emit(group);
  }
  return result.sort((a, b) => b.extra_requests - a.extra_requests || a.started_at - b.started_at || a.id.localeCompare(b.id));
}

/**
 * Recompute only on explicit analysis reads. Originals and bodies never enter summaries.
 *
 * Known browsers, redirects and retries make identical requests legitimate, so
 * a duplicate group is a suspicion, never a defect. Aggregate status codes are
 * transport facts, not business success. Both read paths exclude controlled
 * traffic unless the caller asks for it.
 *
 * @param {DebugRecording} record Retained recording; not modified.
 * @param {DebugParams} params `action` selects aggregate or duplicates; filters,
 *   `offset`, `limit`, `window_ms` and `slow_ms` are honoured.
 * @returns {DebugResult} Result with an `analysis` summary and one page of groups.
 */
export function analyzeRecording(record, params) {
  const matched = record.requests.filter((entry) => httpUrl(entry.url) && matchesRequest(entry, { ...params, kind: params.kind ?? 'business' }));
  const entries = params.include_controlled ? matched : matched.filter((e) => !controlled(e));
  const analysis = {
    retained: record.requests.length,
    matched: matched.length,
    included: entries.length,
    excluded_controlled: matched.length - entries.length,
    uncomparable: 0,
    groups: 0,
    suspected_extra_requests: 0,
    window_ms: params.window_ms ?? 1000,
    slow_ms: params.slow_ms ?? 1000,
    coverage: [
      'retained_requests_only',
      ...record.run.coverage.filter((s) => s.startsWith('evidence_') || s === 'initial_load_not_recorded'),
      ...(record.run.dropped_requests ? ['request_retention_limit'] : []),
    ],
    semantics: params.action === 'aggregate'
      ? 'method + exact origin/path; query values grouped; duration uses captured samples, p95 nearest rank; HTTP status is not business success'
      : 'suspected only: same method, retained URL, body and frame/document within a fixed start-time window; headers not compared; retries or deliberate calls may be valid',
  };
  const values = params.action === 'aggregate' ? aggregate(entries, analysis.slow_ms) : duplicates(entries, record, analysis);
  analysis.groups = values.length;
  if (params.action === 'duplicates') analysis.suspected_extra_requests = values.reduce((sum, g) => sum + g.extra_requests, 0);
  analysis.coverage = [...new Set(analysis.coverage)];
  const offset = params.offset ?? 0;
  const end = Math.min(values.length, offset + (params.limit ?? 30));
  return {
    session_id: record.run.session_id,
    run: record.run,
    analysis,
    [params.action === 'aggregate' ? 'aggregates' : 'duplicates']: values.slice(offset, end),
    ...(end < values.length ? { next_offset: end, truncated: true } : {}),
  };
}
