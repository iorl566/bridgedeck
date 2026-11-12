import { requestKind } from './evidence-model.js';

/**
 * Filter and projection contract shared by live reads, stored-history reads and
 * analysis. Evidence shapes (`DebugRequest`, `DebugParams`, `DebugResult`) are
 * declared in ./types.js; the bare names below refer to those declarations.
 *
 * @typedef {object} QueryLimit
 * @property {number} min Smallest accepted value.
 * @property {number} max Largest accepted value.
 * @property {number} [default] Applied when the parameter is omitted.
 */

/** Optional request fields; any that are not selected are dropped from the
 * projection while structural fields are always kept. */
export const DEBUG_FIELDS = [
  'resource_type', 'frame_id', 'loader_id', 'status', 'error', 'mime_type', 'duration_ms',
  'transfer_bytes', 'decoded_bytes', 'from_cache', 'from_service_worker', 'redirect_from',
  'initiator', 'finished_at',
];
/** Advertised numeric bounds for paging, body slices and the output budget; each
 * entry follows the `QueryLimit` contract. */
export const QUERY_LIMITS = {
  limit: { min: 1, max: 100, default: 30 },
  max_chars: { min: 1, max: 16384, default: 4096 },
  offset: { min: 0, max: 65536 },
  budget: { min: 4096, max: 262144, default: 65536 },
};

/**
 * Apply the exact filters accepted by `requests` and analysis reads.
 *
 * @param {DebugRequest} entry Retained request.
 * @param {DebugParams} params Filter fields; unset fields match everything.
 * @returns {boolean} True when every supplied filter matches.
 */
export function matchesRequest(entry, params) {
  return (
    (!params.url || entry.url.includes(params.url)) &&
    (!params.method || entry.method === params.method) &&
    (!params.resource_type || entry.resource_type === params.resource_type) &&
    (params.status === undefined || entry.status === params.status) &&
    (!params.state || entry.state === params.state) &&
    (!params.kind || params.kind === 'all' || requestKind(entry) === params.kind)
  );
}
/**
 * Drop every optional field the caller did not select; structural fields are
 * always kept.
 *
 * @param {DebugRequest} entry
 * @param {string[]} [fields] Selected descriptors; undefined keeps all fields.
 * @returns {DebugRequest} Projected copy, or the original when no selection is
 *   supplied.
 */
export function projectFields(entry, fields) {
  if (!fields) return entry;
  const result = { ...entry };
  for (const field of DEBUG_FIELDS) if (!fields.includes(field)) delete result[field];
  return result;
}
const prefix = (text, end) => text.slice(0,
  /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end)) ? end - 1 : end);
const compactUrl = (url) => url.startsWith('data:')
  ? `${prefix(url, Math.min(url.indexOf(',') < 0 ? 40 : url.indexOf(','), 80))},[inline content omitted]`
  : url;

/**
 * Trim only the response projection, never the stored recording. Always valid JSON.
 *
 * Lists shrink to whole entries so the returned continuation never skips a row;
 * `output.omitted` names every section that was dropped or shortened. Body text
 * is bisected on UTF-16 boundaries and its offset is adjusted, so a truncated
 * slice can still be continued without splitting a character.
 *
 * @param {DebugResult} value Result of a stored or live read.
 * @param {DebugParams} params `budget` and the fields needed to project entries.
 * @returns {DebugResult} Trimmed copy; exports are returned unchanged.
 * Throws when the budget cannot fit even a minimal projection.
 */
export function budgetResult(value, params) {
  if (params.action === 'export') return value;
  const result = structuredClone(value);
  const budget = params.budget ?? QUERY_LIMITS.budget.default;
  const output = { budget, truncated: false, omitted: [] };
  result.output = output;
  const omit = (path) => {
    output.truncated = true;
    if (!output.omitted.includes(path)) {
      if (output.omitted.length < 12) output.omitted.push(path);
      else output.omitted[11] = 'additional_fields';
    }
  };
  const integerCount = (value) => {
    if (typeof value === 'number') return Number.isInteger(value) ? 1 : 0;
    if (!value || typeof value !== 'object') return 0;
    return Object.values(value).reduce((sum, child) => sum + integerCount(child), 0);
  };
  const size = () => new TextEncoder().encode(JSON.stringify(result, null, 2)).byteLength
    + integerCount(result) * 2 + (params.action === 'capabilities' ? 1024 : 0);
  for (const request of [...(result.requests ?? []), ...(result.request ? [result.request] : [])]) {
    if (request.url.startsWith('data:')) { request.url = compactUrl(request.url); omit('inline_url_content'); }
    const projected = projectFields(request, params.fields);
    for (const key of DEBUG_FIELDS) if (!(key in projected)) delete request[key];
  }
  if (size() <= budget) return result;
  const shorten = (object, path) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, value] of Object.entries(object)) {
      const at = path ? `${path}.${key}` : key;
      if (typeof value === 'string' && value.length > 240 && !['id', 'run_id', 'session_id'].includes(key)) {
        object[key] = `${prefix(value, 200)}…`;
        omit(at);
      } else if (value && typeof value === 'object') shorten(value, at);
    }
  };
  if (params.action === 'requests' || params.action === 'operations') {
    const entries = params.action === 'requests' ? result.requests : result.operations;
    while (entries.length > 1 && size() > budget) { entries.pop(); omit(params.action); }
    if (output.omitted.includes(params.action)) {
      result.next_since = entries.at(-1)?.sequence ?? value.next_since;
      result.truncated = true;
    }
  }
  if (['pages', 'console', 'performance', 'aggregate', 'duplicates'].includes(params.action)) {
    const key = params.action === 'aggregate' ? 'aggregates' : params.action;
    const entries = result[key] ?? [];
    while (entries.length > 1 && size() > budget) { entries.pop(); omit(params.action); }
    if (output.omitted.includes(params.action)) {
      result.next_offset = (params.offset ?? 0) + entries.length;
      result.truncated = true;
    }
  }
  if (size() > budget) {
    shorten(result.run, 'run');
    for (const key of ['operation', 'operations', 'evidence', 'pages', 'console', 'rules', 'requests']) {
      if (size() <= budget) break;
      shorten(result[key], key);
    }
  }
  if (result.request && size() > budget) {
    const entry = result.request;
    for (const key of ['request_headers', 'response_headers', 'timing', 'initiator']) {
      if (size() <= budget) break;
      if (entry[key] !== undefined) { delete entry[key]; omit(`request.${key}`); }
    }
    if (entry.url.length > 200) { entry.url = prefix(entry.url, 200); omit('request.url'); }
    shorten(result.run, 'run');
    for (const key of ['request_body', 'response_body']) {
      const body = entry[key];
      if (body.text === undefined || size() <= budget) continue;
      const original = body.text;
      const originalNext = body.next_offset;
      omit(`request.${key}.text`);
      let low = 0;
      let high = original.length;
      body.next_offset = (body.offset ?? 0) + original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        body.text = original.slice(0, middle);
        if (size() <= budget) low = middle;
        else high = middle - 1;
      }
      if (!low && original.length) throw new Error('output budget too small for body slice; increase budget or select fewer fields');
      low = prefix(original, low).length;
      if (!low && original.length) throw new Error('increase budget for a complete Unicode character');
      body.text = original.slice(0, low);
      body.next_offset = low < original.length ? (body.offset ?? 0) + low : originalNext;
    }
  }
  for (const key of ['evidence', 'pages', 'console', 'rules', 'replays', 'requests', 'operations', 'runs']) {
    if (size() <= budget) break;
    if (key === params.action && ['requests', 'operations', 'pages', 'console', 'rules'].includes(params.action)) continue;
    if (result[key] !== undefined) { delete result[key]; omit(key); }
  }
  if (size() > budget && result.operation) {
    const op = result.operation;
    delete op.before;
    delete op.after;
    delete op.observations;
    op.request_ids = [];
    op.console_ids = [];
    omit('operation.details');
  }
  if (size() > budget && result.run) { delete result.run; omit('run'); }
  if (size() > budget) throw new Error('output budget too small; increase budget');
  return result;
}
