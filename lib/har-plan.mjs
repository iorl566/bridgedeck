// lib/har-plan.mjs —— HAR 重放计划：顺序 / 可选并发 / 幂等去重 / 执行器。
//
// 为什么单独一层：`network replay-har` 既要支持"一条一条按 HAR 顺序重放"（默认），
// 又要在受控场景下并发加速，还要避免把同一个幂等请求（同 method+url+body）重复打多次。
// 计划层是纯函数（可离线审计），执行器只依赖注入的 send(request)：
//   * 计划：排序（har/time/idempotent-first）、maxEntries 截断、非幂等跳过（默认拒绝）、
//     幂等去重、批（batch）划分；
//   * 执行：顺序 / worker 池并发、幂等请求失败重试一次、stopOnError、结果保持计划顺序；
//   * 审计：summarizeHarReplayPlan + compareReplayRuns（两次重放的耗时无关等价性）。
//
// 被 lib/har-replay.mjs 消费（parseHarReplayEntries 用它给条目标注 order/idempotent/skip，
// CLI `network replay-har` 的 --all 循环直接按这个顺序执行）。

export const REPLAY_PLAN_VERSION = 1;
export const MAX_CONCURRENCY = 16;
export const IDEMPOTENT_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text == null ? '' : text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function headersToObject(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const header of headers) {
      if (!header || header.name == null) continue;
      out[String(header.name)] = String(header.value == null ? '' : header.value);
    }
    return out;
  }
  if (typeof headers !== 'object') return {};
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[String(name)] = String(value == null ? '' : value);
  return out;
}

function bodyOf(entry) {
  if (typeof entry.body === 'string') return entry.body;
  if (entry.postData && typeof entry.postData.text === 'string') return entry.postData.text;
  if (entry.request && entry.request.postData && typeof entry.request.postData.text === 'string') return entry.request.postData.text;
  return null;
}

function methodOf(entry) {
  return String(entry.method || (entry.request && entry.request.method) || 'GET').toUpperCase();
}

function urlOf(entry) {
  return String(entry.url || (entry.request && entry.request.url) || '');
}

function headersOf(entry) {
  return headersToObject(entry.headers || (entry.request && entry.request.headers));
}

function startedAtOf(entry) {
  const value = entry.startedAt ?? entry._startedAt ?? entry.startedDateTime;
  if (Number.isFinite(Number(value))) {
    const number = Number(value);
    return number >= 1e12 ? number : number >= 1e9 ? number * 1000 : number;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 稳定重放标识：method + url + body + content-type；同一逻辑请求得到同一个 id。 */
export function replayIdOf(entry = {}) {
  const headers = headersOf(entry);
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const body = bodyOf(entry) || '';
  return fnv1a([methodOf(entry), urlOf(entry), contentType, body].join('\u0000'));
}

/** 幂等判定：只有安全方法默认算幂等（POST/PATCH 等即使语义幂等也不自动重放）。 */
export function isIdempotentRequest(method) {
  return IDEMPOTENT_METHODS.includes(String(method || '').toUpperCase());
}

/** 把 HAR entry / replay entry / 档案 request 统一成计划输入。 */
export function normalizeReplayEntry(raw, index = 0) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const method = methodOf(entry);
  const url = urlOf(entry);
  const body = bodyOf(entry);
  const headers = headersOf(entry);
  return {
    index,
    method,
    url,
    headers,
    body,
    contentType: headers['content-type'] || headers['Content-Type'] || '',
    resourceType: String(entry._resourceType || entry.resourceType || entry.type || ''),
    idempotent: isIdempotentRequest(method),
    startedAt: startedAtOf(entry),
    replayId: replayIdOf({ method, url, headers, body }),
    error: entry._error || entry.error || null,
  };
}

function clampConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(number));
}

function orderEntries(entries, order) {
  const list = entries.slice();
  if (order === 'time') {
    list.sort((a, b) => {
      if (a.startedAt == null && b.startedAt == null) return a.index - b.index;
      if (a.startedAt == null) return 1;
      if (b.startedAt == null) return -1;
      return a.startedAt - b.startedAt || a.index - b.index;
    });
  } else if (order === 'idempotent-first') {
    list.sort((a, b) => (a.idempotent === b.idempotent ? a.index - b.index : a.idempotent ? -1 : 1));
  }
  return list;
}

/**
 * 构建重放计划。
 * options:
 *   concurrency        1..16，默认 1（顺序）
 *   idempotent         true = 只重放幂等请求 + 按 replayId 去重
 *   allowNonIdempotent idempotent 模式下也允许非幂等方法（默认 false）
 *   order              'har' | 'time' | 'idempotent-first'
 *   maxEntries         0 = 不限
 *   skipMethods/skipTypes 显式跳过
 *   includeErrors      是否把已带 error 的 entry 也排进计划（默认 true，便于复现失败）
 */
export function buildHarReplayPlan(input, options = {}) {
  const list = Array.isArray(input) ? input : [];
  const opts = options && typeof options === 'object' ? options : {};
  const idempotent = opts.idempotent === true;
  const allowNonIdempotent = opts.allowNonIdempotent === true;
  const concurrency = clampConcurrency(opts.concurrency);
  const order = ['har', 'time', 'idempotent-first'].includes(opts.order) ? opts.order : 'har';
  const maxEntries = Math.max(0, Number(opts.maxEntries) || 0);
  const skipMethods = new Set((Array.isArray(opts.skipMethods) ? opts.skipMethods : []).map((method) => String(method).toUpperCase()));
  const skipTypes = new Set((Array.isArray(opts.skipTypes) ? opts.skipTypes : []).map((type) => String(type).toLowerCase()));
  const includeErrors = opts.includeErrors !== false;

  const normalized = list.map((raw, index) => normalizeReplayEntry(raw, index));
  const byIndex = new Map(normalized.map((entry) => [entry.index, entry]));
  const ordered = orderEntries(normalized, order);
  const seen = new Map(); // replayId -> first planned index
  const skipped = [];
  const scheduled = [];
  for (const entry of ordered) {
    let skip = null;
    if (!entry.url) skip = { reason: 'missing-url' };
    else if (skipMethods.has(entry.method)) skip = { reason: 'method-skipped', method: entry.method };
    else if (skipTypes.has(entry.resourceType.toLowerCase())) skip = { reason: 'type-skipped', type: entry.resourceType };
    else if (!includeErrors && entry.error) skip = { reason: 'error-entry' };
    else if (idempotent && !entry.idempotent && !allowNonIdempotent) skip = { reason: 'non-idempotent', method: entry.method };
    else if (idempotent && seen.has(entry.replayId)) skip = { reason: 'duplicate', duplicateOf: seen.get(entry.replayId) };
    else if (maxEntries > 0 && scheduled.length >= maxEntries) skip = { reason: 'limit', maxEntries };
    if (skip) {
      skipped.push({ index: entry.index, replayId: entry.replayId, method: entry.method, url: entry.url, ...skip });
      continue;
    }
    if (idempotent) seen.set(entry.replayId, entry.index);
    scheduled.push({
      ...entry,
      order: scheduled.length,
      batch: Math.floor(scheduled.length / concurrency),
    });
  }
  const batches = [];
  for (const entry of scheduled) {
    if (!batches[entry.batch]) batches[entry.batch] = { batch: entry.batch, indexes: [] };
    batches[entry.batch].indexes.push(entry.index);
  }
  const plan = {
    version: REPLAY_PLAN_VERSION,
    mode: idempotent ? 'idempotent' : 'sequential',
    concurrency,
    order,
    stopOnError: opts.stopOnError !== false,
    retryIdempotent: opts.retryIdempotent !== false,
    entries: scheduled,
    batches,
    skipped,
    source: {
      total: normalized.length,
      byIndex: Object.fromEntries([...byIndex.entries()]),
    },
  };
  plan.summary = summarizeHarReplayPlan(plan);
  return plan;
}

/** 计划摘要（数量/方法分布/批数/跳过原因）。 */
export function summarizeHarReplayPlan(plan) {
  const entries = plan && Array.isArray(plan.entries) ? plan.entries : [];
  const skipped = plan && Array.isArray(plan.skipped) ? plan.skipped : [];
  const methods = {};
  const skipReasons = {};
  for (const entry of entries) methods[entry.method] = (methods[entry.method] || 0) + 1;
  for (const item of skipped) skipReasons[item.reason] = (skipReasons[item.reason] || 0) + 1;
  return {
    scheduled: entries.length,
    skipped: skipped.length,
    batches: plan && Array.isArray(plan.batches) ? plan.batches.length : 0,
    concurrency: plan ? plan.concurrency : 1,
    idempotent: plan ? plan.mode === 'idempotent' : false,
    methods,
    skipReasons,
  };
}

async function attempt(send, entry, { retryIdempotent }) {
  const request = {
    method: entry.method,
    url: entry.url,
    headers: { ...entry.headers },
    ...(entry.body != null ? { body: entry.body } : {}),
  };
  const startedAt = Date.now();
  let attempts = 0;
  let lastError = null;
  const maxAttempts = 1 + (retryIdempotent && entry.idempotent ? 1 : 0);
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const result = await send(request);
      const body = result && (typeof result.body === 'string' ? result.body
        : typeof result.responseBody === 'string' ? result.responseBody : '');
      return {
        index: entry.index,
        replayId: entry.replayId,
        ok: true,
        status: result && result.status != null ? Number(result.status) : null,
        durationMs: Date.now() - startedAt,
        bodyHash: fnv1a(body),
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        attempts,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    index: entry.index,
    replayId: entry.replayId,
    ok: false,
    status: null,
    durationMs: Date.now() - startedAt,
    bodyHash: null,
    bodyBytes: 0,
    attempts,
    error: String((lastError && lastError.message) || lastError || 'unknown error'),
    errorCode: lastError && lastError.code ? String(lastError.code) : null,
  };
}

/**
 * 执行计划。send(request) 返回 {status, body?...} 或抛错。
 * 结果按计划顺序返回（`results[i]` 对应 `plan.entries[i]`），skip 项也占位。
 */
export async function executeHarReplayPlan(plan, send, options = {}) {
  if (!plan || plan.version !== REPLAY_PLAN_VERSION || !Array.isArray(plan.entries)) {
    throw new Error('无效的重放计划');
  }
  if (typeof send !== 'function') throw new Error('executeHarReplayPlan 需要 send(request) 函数');
  const concurrency = clampConcurrency(options.concurrency ?? plan.concurrency);
  const stopOnError = options.stopOnError ?? plan.stopOnError;
  const retryIdempotent = options.retryIdempotent ?? plan.retryIdempotent;
  const signal = options.signal || null;
  const onResult = typeof options.onResult === 'function' ? options.onResult : null;
  const startedAt = Date.now();
  const total = plan.entries.length;
  const results = new Array(total).fill(null);
  let stopped = false;
  let failureSeen = false;
  let nextIndex = 0;

  const record = (result) => {
    results[result.index] = result;
    if (onResult) {
      try {
        onResult(result);
      } catch {
        // 回调异常不影响执行
      }
    }
    if (result.ok === false) failureSeen = true;
  };

  const worker = async () => {
    while (!stopped) {
      if (signal && signal.aborted) {
        stopped = true;
        return;
      }
      if (stopOnError && failureSeen) {
        stopped = true;
        return;
      }
      const position = nextIndex;
      nextIndex += 1;
      if (position >= total) return;
      const entry = plan.entries[position];
      const result = await attempt(send, entry, { retryIdempotent });
      record(result);
    }
  };

  const workers = [];
  for (let index = 0; index < Math.min(concurrency, total || 1); index += 1) workers.push(worker());
  await Promise.all(workers);

  const orderedResults = [];
  for (const entry of plan.entries) {
    if (results[entry.index]) orderedResults.push(results[entry.index]);
    else {
      orderedResults.push({
        index: entry.index,
        replayId: entry.replayId,
        ok: false,
        status: null,
        durationMs: 0,
        bodyHash: null,
        bodyBytes: 0,
        attempts: 0,
        notExecuted: true,
        error: stopped ? 'not-executed:stopped' : 'not-executed',
        errorCode: null,
      });
    }
  }
  const attempted = orderedResults.filter((result) => result.attempts > 0).length;
  const failed = orderedResults.filter((result) => result.ok === false && result.attempts > 0).length;
  const skippedResults = [];
  for (const item of plan.skipped) {
    skippedResults.push({ index: item.index, replayId: item.replayId, ok: false, skipped: true, reason: item.reason });
  }
  const summary = {
    scheduled: total,
    attempted,
    succeeded: attempted - failed,
    failed,
    skipped: plan.skipped.length,
    notExecuted: total - attempted,
    batches: plan.batches.length,
    concurrency,
    stoppedEarly: stopped,
    totalMs: Date.now() - startedAt,
  };
  return {
    ok: failed === 0 && summary.notExecuted === 0,
    plan: { version: plan.version, mode: plan.mode, concurrency, order: plan.order },
    results: orderedResults,
    skipped: skippedResults,
    summary,
  };
}

/**
 * 两次重放的等价性（幂等证据）：只看 成功/状态码/body 哈希，忽略耗时与重试次数。
 * 用于证明"同一 HAR 重放两次结果一致"或"幂等去重没有改变结果集合"。
 */
export function compareReplayRuns(before, after) {
  const listOf = (run) => (run && Array.isArray(run.results) ? run.results : []);
  const normalize = (results) => {
    const occurrences = new Map();
    const out = [];
    for (const result of results) {
      const key = String(result.replayId || result.index);
      const occurrence = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, occurrence);
      out.push({
        key: key + '#' + occurrence,
        replayId: result.replayId,
        ok: result.ok === true,
        status: result.status == null ? null : Number(result.status),
        bodyHash: result.bodyHash || null,
      });
    }
    return out;
  };
  const beforeList = normalize(listOf(before));
  const afterList = normalize(listOf(after));
  const afterMap = new Map(afterList.map((item) => [item.key, item]));
  const differences = [];
  for (const item of beforeList) {
    const other = afterMap.get(item.key);
    if (!other) {
      differences.push({ key: item.key, field: 'missing-after' });
      continue;
    }
    if (item.ok !== other.ok) differences.push({ key: item.key, field: 'ok', before: item.ok, after: other.ok });
    if (item.status !== other.status) differences.push({ key: item.key, field: 'status', before: item.status, after: other.status });
    if (item.bodyHash !== other.bodyHash) differences.push({ key: item.key, field: 'bodyHash', before: item.bodyHash, after: other.bodyHash });
  }
  for (const item of afterList) {
    if (!beforeList.some((candidate) => candidate.key === item.key)) {
      differences.push({ key: item.key, field: 'missing-before' });
    }
  }
  return { identical: differences.length === 0, differences, before: beforeList.length, after: afterList.length };
}
