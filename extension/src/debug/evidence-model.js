import { parseJsonSource } from './json-source.js';

/**
 * Read-only projections over retained evidence: request classification, console
 * origin, operation windows and the field/payload evidence attached to an
 * operation. Every association is derived from the same retained recording.
 *
 * Evidence shapes (`DebugRequest`, `DebugRecording`, `DebugOperation`,
 * `DebugConsole`, `DebugPage`, `DebugField`, `DebugValue`, `DebugEvidence`) are
 * declared in ./types.js; the bare names below refer to those declarations.
 *
 * @typedef {object} OperationContext
 * @property {DebugRequest[]} requests Requests started inside the operation window.
 * @property {(DebugConsole & { relation: 'window' | 'delayed' })[]} console Console
 *   messages in the window, tagged by their relation to the immediate boundary.
 * @property {{ request_id: string, relation: 'window' | 'delayed' }[]} links
 *   Request-to-operation links; correlation only, never causation.
 * @property {DebugOperation} operation Copy of the operation with correlated ids.
 */

/**
 * One bounded leaf projected from a requested or responded body.
 *
 * Leaves are produced only for text bodies that parse as an object; arrays and
 * deeper structures stop descent and mark the projection incomplete.
 *
 * @typedef {object} PayloadLeaf
 * @property {string} path Field path with `~0`/`~1` escapes.
 * @property {string} name Field name of the leaf.
 * @property {string} value Text value, capped at 256 characters.
 * @property {boolean} truncated True when the value was shortened.
 */

/**
 * @param {DebugRequest} request
 * @returns {'business' | 'resource' | 'extension'} Request kind used by filters
 *   and analysis defaults.
 */
export function requestKind(request) {
  const url = request.url ?? '';
  const initiator = request.initiator ?? '';
  if (/^(?:chrome|moz)-extension:/.test(url) || /(?:chrome|moz)-extension:\/\//.test(initiator)) return 'extension';
  if (
    ['Fetch', 'XHR', 'Document'].includes(request.resource_type ?? '') ||
    !['GET', 'HEAD'].includes(request.method) ||
    /json/.test(request.mime_type ?? '')
  ) return 'business';
  return 'resource';
}

/**
 * @param {string | undefined} url Message source URL, when the browser reports one.
 * @param {string | undefined} browserSource Browser-reported message category.
 * @returns {'extension' | 'browser' | 'website' | 'unknown'} Most likely origin;
 *   `unknown` means the source could not be established.
 */
export function consoleSource(url, browserSource) {
  if (/^(?:chrome|moz)-extension:/.test(url ?? '')) return 'extension';
  if (browserSource && ['deprecation', 'intervention', 'violation', 'security'].includes(browserSource)) return 'browser';
  if (/^https?:/.test(url ?? '')) return 'website';
  return 'unknown';
}

/**
 * Bound one operation's association window by the next operation, an
 * observation limit and the end of capture.
 *
 * @param {DebugRecording} recording
 * @param {DebugOperation} operation
 * @returns {{ immediate: number, end: number, next_start: number }} Epoch
 *   milliseconds; `end` and `next_start` may be Infinity.
 */
export function operationWindow(recording, operation) {
  const index = recording.operations.findIndex((item) => item.id === operation.id);
  const next = index >= 0 ? recording.operations[index + 1] : undefined;
  const immediate = operation.window_end ?? operation.finished_at ?? (operation.state === 'running' ? recording.saved_at : operation.started_at);
  const end = Math.min(
    operation.observation_end ?? immediate,
    next?.started_at ?? Infinity,
    recording.run?.stopped_at ?? Infinity,
  );
  return { immediate, end, next_start: next?.started_at ?? Infinity };
}

/**
 * Derive all associations from the same retained evidence, never the hot cache.
 *
 * @param {DebugRecording} recording
 * @param {DebugOperation} operation
 * @returns {OperationContext}
 */
export function operationContext(recording, operation) {
  const { immediate, end, next_start } = operationWindow(recording, operation);
  const contains = (at) => at >= operation.started_at && at <= end && at < next_start;
  const relation = (at) => (at <= immediate ? 'window' : 'delayed');
  const requests = recording.requests.filter((request) => contains(request.started_at));
  const messages = recording.console.filter((entry) => contains(entry.at)).map((entry) => ({ ...entry, relation: relation(entry.at) }));
  return {
    requests,
    console: messages,
    links: requests.map((request) => ({ request_id: request.id, relation: relation(request.started_at) })),
    operation: {
      ...operation,
      request_ids: requests.map((request) => request.id),
      console_ids: messages.map((entry) => entry.id),
      truncated: recording.run.dropped_requests > 0 || recording.run.dropped_console > 0,
    },
  };
}

/**
 * @param {DebugPage | undefined} page
 * @returns {DebugField[]} Captured fields, or an empty list when none exist.
 */
function fields(page) { return page?.fields ?? []; }
/**
 * Only an unambiguous field can be traced; duplicates are treated as unknown.
 *
 * @param {DebugPage | undefined} page
 * @param {string} key Stable field key.
 * @returns {DebugField | undefined} The single matching field, if unique.
 */
function uniqueField(page, key) {
  const matches = fields(page).filter((field) => field.key === key);
  return matches.length === 1 ? matches[0] : undefined;
}
/**
 * @param {DebugField | undefined} field
 * @param {DebugPage | undefined} page Page the value was read from.
 * @param {string} source Label naming where the value came from.
 * @returns {DebugValue} Explicit `not_recorded` state when the field is absent.
 */
function value(field, page, source) {
  return field ? { state: field.state, value: field.value, source, at: page?.at } : { state: 'not_recorded' };
}

/**
 * Flatten one retained body into bounded path/value leaves. Large or non-text
 * bodies produce no leaves and report `complete: false`.
 *
 * @param {DebugRequest} request
 * @param {'request' | 'response'} part Body to read.
 * @returns {{ leaves: { path: string, name: string, value: string, truncated: boolean }[],
 *   complete: boolean }} Leaves in document order and whether the body was fully
 *   represented.
 */
function payload(request, part) {
  const body = part === 'request' ? request.request_body : request.response_body;
  if (body.state !== 'available' || !body.text || body.text.length > 65536) return { leaves: [], complete: body.state === 'empty' };
  const result = [];
  let complete = true;
  const text = body.text;
  const visit = (data, path, name, depth) => {
    if (depth > 5 || result.length >= 32) { complete = false; return; }
    if (data.children) {
      if (data.kind === 'array') {
        if (data.children.length) complete = false;
        return;
      }
      if (data.children.length > 32) complete = false;
      for (const { key, value: child } of data.children.slice(0, 32)) {
        visit(child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, key, depth + 1);
      }
    } else {
      const raw = text.slice(data.start, data.end);
      const val = data.kind === 'string' ? JSON.parse(raw) : raw;
      result.push({ path, name, value: val.slice(0, 256), truncated: val.length > 256 });
    }
  };
  try {
    visit(parseJsonSource(text), '', '', 0);
  } catch {
    if (part === 'request' && /x-www-form-urlencoded/.test(request.request_headers?.['content-type'] ?? '')) {
      for (const [name, raw] of new URLSearchParams(body.text)) {
        if (result.length === 32) { complete = false; break; }
        result.push({ name, path: name, value: raw.slice(0, 256), truncated: raw.length > 256 });
      }
    } else complete = false;
  }
  return { leaves: result, complete };
}

/**
 * Conservative, deterministic projections of retained facts; no semantic/causal inference.
 *
 * @param {DebugRecording} record
 * @param {DebugOperation} operation
 * @param {OperationContext} [context] Precomputed context for the same pair.
 * @returns {DebugEvidence} Field traces, payload leaves, links, gaps, text diff
 *   and observations; payload leaves are capped at 96 entries.
 */
export function operationEvidence(record, operation, context = operationContext(record, operation)) {
  const { links, requests } = context;
  const gaps = new Set(record.run.coverage.filter((item) => item.startsWith('evidence_')));
  if (operation.state === 'running') gaps.add('operation_running');
  if (operation.state === 'interrupted') gaps.add('operation_interrupted');
  if (record.run.dropped_requests || record.run.dropped_operations || record.run.dropped_console) gaps.add('capacity_limit');
  if (record.run.coverage.includes('initial_load_not_recorded')) gaps.add('initial_load_not_recorded');
  if (record.run.coverage.includes('manual_capture_unavailable')) gaps.add('manual_capture_unavailable');
  if (record.run.coverage.includes('interrupted_checkpoint')) gaps.add('interrupted_checkpoint');
  if (operation.observation_limited) gaps.add('observation_limit');
  if (operation.before?.state !== 'available') gaps.add('before_unavailable');
  if (!operation.before?.fields || operation.before.fields_partial) gaps.add('fields_partial');
  if (!operation.after || operation.after.state !== 'available') gaps.add('after_unavailable');
  if (operation.before?.truncated || operation.after?.truncated) gaps.add('page_truncated');
  for (const request of requests.filter((item) => requestKind(item) === 'business')) {
    if (request.intervention) gaps.add(`control_${request.intervention.type}`);
    if (request.intervention?.state === 'pending') gaps.add('control_pending');
    if (request.intervention && ['failed', 'cancelled'].includes(request.intervention.state)) gaps.add('control_failed');
    if (request.replay_from) gaps.add('request_replayed');
    if (request.state === 'pending') gaps.add('request_pending');
    if (request.state === 'interrupted') gaps.add('request_interrupted');
    for (const body of [request.request_body, request.response_body]) {
      if (!['empty', 'available'].includes(body.state)) gaps.add(`body_${body.state}`);
    }
  }
  const prior = record.operations.slice(0, Math.max(0, record.operations.findIndex((item) => item.id === operation.id)));
  let boundary = -1;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    if (!['tool.fill', 'tool.select'].includes(prior[index].method)) { boundary = index; break; }
  }
  const inputs = prior.slice(boundary + 1);
  if (['tool.fill', 'tool.select'].includes(operation.method)) inputs.push(operation);
  const inputPage = [operation.before, ...inputs.flatMap((item) => [item.before, item.after])]
    .filter(Boolean).sort((a, b) => a.at - b.at).at(-1) ?? operation.before;
  const nextLoad = record.pages.find((page) => page.at > operation.started_at && !!page.navigation && fields(page).some((field) => fields(inputPage).some((input) => input.key === field.key)));
  if (nextLoad && record.operations.some((item) => item.started_at > operation.started_at && item.started_at < nextLoad.at && !['tool.navigate', 'tool.reload'].includes(item.method))) gaps.add('intervening_operations');
  if (fields(inputPage).some((field) => field.state === 'truncated' || fields(inputPage).filter((item) => item.key === field.key).length > 1)) gaps.add('fields_partial');
  let navigation;
  if (nextLoad) {
    for (let index = record.operations.length - 1; index >= 0; index -= 1) {
      const item = record.operations[index];
      if (item.started_at > operation.started_at && item.started_at <= nextLoad.at && ['tool.navigate', 'tool.reload'].includes(item.method)) { navigation = item; break; }
    }
  }
  const loadedPage = nextLoad && navigation?.after?.state === 'available' && navigation.after.at >= nextLoad.at
    ? { ...navigation.after, navigation: nextLoad.navigation } : nextLoad;
  const observations = [...(operation.observations ?? []), ...(loadedPage ? [loadedPage] : [])].sort((a, b) => a.at - b.at).slice(-9);
  const laterPage = loadedPage ?? observations.at(-1) ?? operation.after;
  const leaves = requests
    .filter((item) => requestKind(item) === 'business' && !item.replay_from && (!item.intervention || (item.intervention.state === 'applied' && item.intervention.type !== 'block')))
    .slice(0, 12)
    .flatMap((request) => ['request', 'response'].map((part) => ({ request, part, ...payload(request, part) })));
  if (leaves.some((item) => !item.complete && (item.part === 'request' ? item.request.request_body : item.request.response_body).state === 'available')) gaps.add('payload_partial');
  const payloads = leaves.flatMap(({ request, part, leaves: items }) => items.map((leaf) => ({
    request_id: request.id, part, path: leaf.path, value: leaf.value, ...(leaf.truncated ? { truncated: true } : {}),
  }))).slice(0, 96);
  const traces = fields(inputPage)
    .filter((field, _index, all) => all.filter((item) => item.key === field.key).length === 1)
    .slice(0, 16)
    .map((field) => {
      const originalPage = inputs.find((item) => uniqueField(item.before, field.key))?.before ?? operation.before;
      const exact = (part) => leaves.filter((item) => item.part === part).flatMap((item) => {
        const matches = item.leaves.filter((leaf) => leaf.name === field.name);
        const body = part === 'request' ? item.request.request_body : item.request.response_body;
        if (!['available', 'empty'].includes(body.state)) return [{ state: `body_${body.state}`, source: item.request.id }];
        if (!item.complete) return [{ state: 'payload_partial', source: item.request.id }];
        return matches.length === 1 ? [{
          state: matches[0].value === '[redacted]' ? 'redacted' : matches[0].truncated ? 'truncated' : 'available',
          value: matches[0].value,
          source: `${item.request.id} ${matches[0].path}`,
          at: part === 'request' ? item.request.started_at : item.request.finished_at,
        }] : [];
      });
      return {
        key: field.key,
        label: field.label,
        before: value(uniqueField(originalPage, field.key), originalPage, 'before'),
        input: value(field, inputPage, 'input'),
        submitted: exact('request'),
        response: exact('response'),
        later: value(uniqueField(laterPage, field.key), laterPage, nextLoad ? `page:${nextLoad.navigation}` : 'after'),
      };
    });
  const comparable = operation.before?.state === 'available' && operation.after?.state === 'available' && typeof operation.before.text === 'string' && typeof operation.after.text === 'string';
  const before = (comparable ? (operation.before?.text ?? '') : '').split('\n').filter(Boolean);
  const after = (comparable ? (operation.after?.text ?? '') : '').split('\n').filter(Boolean);
  const added = after.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !after.includes(line));
  return {
    fields: traces,
    payloads,
    links,
    gaps: [...gaps],
    changes: {
      added: added.slice(0, 16),
      removed: removed.slice(0, 16),
      truncated: added.length > 16 || removed.length > 16 || !!operation.before?.truncated || !!operation.after?.truncated,
    },
    observations,
  };
}
