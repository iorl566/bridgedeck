// tools/quality/lib/fixtures.mjs —— 门禁夹具的确定性生成（不读时钟、不读随机源）。
//
// 夹具必须满足两个条件，否则门禁的结果没有意义：
//   1) 同 seed 逐字节可复现（包括对象键顺序都由构造顺序固定）；
//   2) 覆盖真实模块的关键分支（重复请求/非幂等请求/未配对 trace 事件/敏感参数）。
// 夹具只描述输入，不预设期望输出——期望由门禁从真实模块行为推导。

import { createRng, deriveSeed, createFixedClock } from './prng.mjs';

export const FIXED_START_MS = 1700000000000;
export const FIXED_NOW_ISO = '2023-11-14T22:13:20.000Z';

const CONTENT_TYPES = ['application/json', 'text/html', 'text/css', 'application/javascript', 'image/png'];
const RESOURCE_TYPES = ['Document', 'Fetch', 'XHR', 'Script', 'Stylesheet', 'Image'];
const METHODS = ['GET', 'GET', 'GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'];

/** 固定方法/资源类型分布，供 HAR/规划器夹具使用。 */
export function fixtureRequestSeeds() {
  return METHODS.slice();
}

/**
 * 生成 HAR 1.2 夹具。
 * 刻意包含：重复 GET（同 url+body → 同 replayId）、同 url 不同 method、POST 带 body、
 * 缺失 url 的坏条目、带 error 的条目、不同 content-type。
 */
export function buildHarFixture(seed = 'quality', options = {}) {
  const rng = createRng(deriveSeed(seed, 'har'));
  const count = Math.max(1, Math.floor(Number(options.entries) || 14));
  const entries = [];
  const clock = createFixedClock(FIXED_START_MS);
  for (let index = 0; index < count; index += 1) {
    const method = index < METHODS.length ? METHODS[index] : rng.pick(METHODS);
    const resource = RESOURCE_TYPES[index % RESOURCE_TYPES.length];
    const contentType = CONTENT_TYPES[index % CONTENT_TYPES.length];
    // 每 4 条复用同一组 url（用于验证幂等去重），其余使用序号 url。
    const bucket = index % 4;
    const url = 'https://fixture.invalid/api/' + resource.toLowerCase() + '/' + bucket;
    const withBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    let body = withBody ? JSON.stringify({ op: 'write', seq: index % 3, tag: rng.hex(4) }) : null;
    let effectiveMethod = method;
    let effectiveContentType = contentType;
    let effectiveUrl = 'https://fixture.invalid/api/' + resource.toLowerCase() + '/' + bucket;
    // 每 5 条复用上一条的 method+url+content-type+body，制造"逻辑上重复"的请求，
    // 供幂等去重检查（replayId 相同）。注意 url 仍取自上一条（不是当前 bucket）。
    if (index > 0 && index % 5 === 0) {
      const previous = entries[index - 1];
      effectiveMethod = previous.request.method;
      effectiveUrl = previous.request.url;
      const previousContentType = (previous.request.headers || []).find((header) => String(header.name).toLowerCase() === 'content-type');
      effectiveContentType = previousContentType ? previousContentType.value : previous.request.postData ? previous.request.postData.mimeType : contentType;
      body = previous.request.postData ? previous.request.postData.text : null;
    }
    const at = clock.advance(17 + (index % 5));
    const requestHeaders = [
      { name: 'content-type', value: effectiveContentType },
      { name: 'accept', value: 'application/json' },
      ...(index % 2 === 0 ? [{ name: 'x-fixture', value: rng.hex(6) }] : []),
    ];
    const entry = {
      startedDateTime: new Date(at).toISOString(),
      time: 5 + (index % 7) * 3,
      request: {
        method: effectiveMethod,
        url: index === count - 1 && options.trailingBadEntry !== false ? '' : effectiveUrl,
        httpVersion: 'HTTP/1.1',
        headers: index % 3 === 0 ? requestHeaders.slice().reverse() : requestHeaders,
        queryString: [],
        ...(body ? { postData: { mimeType: effectiveContentType, text: body } } : {}),
        headersSize: -1,
        bodySize: body ? body.length : 0,
      },
      response: {
        status: 200 + (index % 3) * 100 === 400 ? 400 : 200,
        statusText: 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-type', value: contentType }],
        content: { size: 64 + index, mimeType: contentType },
        redirectURL: '',
        headersSize: -1,
        bodySize: 64 + index,
      },
      cache: {},
      timings: { send: 0.1, wait: 1 + (index % 5), receive: 0.2 },
      _resourceType: resource,
      _startedAt: at,
      _requestId: 'req-' + String(index + 1).padStart(3, '0'),
      ...(index === 2 ? { _error: 'net::ERR_FIXTURE' } : {}),
    };
    entries.push(entry);
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'quality-fixture', version: '1' },
      pages: [{ startedDateTime: FIXED_NOW_ISO, id: 'page_1', title: 'fixture', pageTimings: { onContentLoad: 12, onLoad: 34 } }],
      entries,
    },
  };
}

/** 生成原始重放条目（不包 HAR 外壳，直接喂 buildHarReplayPlan）。 */
export function buildRawReplayEntries(seed = 'quality', count = 12) {
  const har = buildHarFixture(seed, { entries: count });
  return har.log.entries.map((entry, index) => ({
    index,
    method: entry.request.method,
    url: entry.request.url,
    headers: entry.request.headers,
    ...(entry.request.postData ? { body: entry.request.postData.text } : {}),
    startedAt: entry._startedAt,
    resourceType: entry._resourceType,
  }));
}

/** 规划器的固定选项组合：门禁对每一种都要"重复 N 次指纹一致"。 */
export function replayPlanOptionVariants() {
  return [
    { name: 'sequential', options: { order: 'har', concurrency: 1 } },
    { name: 'idempotent-dedupe', options: { order: 'har', concurrency: 3, idempotent: true } },
    { name: 'time-order', options: { order: 'time', concurrency: 2, stopOnError: false } },
    { name: 'idempotent-first-limited', options: { order: 'idempotent-first', concurrency: 4, maxEntries: 6 } },
  ];
}

/**
 * 生成 trace 夹具：B/E 配对、X/I 事件、异步 S/T/F、未配对 begin、长 state、截图。
 * 结构安全采样必须保持 B/E 配对，这里把配对关系显式注入（begin 的 ts 与 end 对应）。
 */
export function buildTraceFixture(seed = 'quality', options = {}) {
  const rng = createRng(deriveSeed(seed, 'trace'));
  const pairs = Math.max(1, Math.floor(Number(options.pairs) || 24));
  const events = [];
  events.push({ name: 'trace-start', ph: 'M', ts: 1000, pid: 1, tid: 1, cat: 'meta' });
  for (let index = 0; index < pairs; index += 1) {
    const ts = 1000 + index * 50;
    const dur = 10 + rng.int(0, 30);
    const tid = 1 + (index % 2);
    events.push({ name: 'op-' + String(index).padStart(3, '0'), ph: 'B', ts, pid: 1, tid, cat: 'fixture' });
    if (index % 3 === 0) {
      events.push({ name: 'async-' + index, ph: 'S', ts: ts + 1, pid: 1, tid, cat: 'fixture', id: 'a' + index });
      events.push({ name: 'async-step-' + index, ph: 'T', ts: ts + 3, pid: 1, tid, cat: 'fixture', id: 'a' + index });
      events.push({ name: 'async-end-' + index, ph: 'F', ts: ts + dar(4, dur), pid: 1, tid, cat: 'fixture', id: 'a' + index });
    }
    events.push({ name: 'op-' + String(index).padStart(3, '0'), ph: 'E', ts: ts + dur, pid: 1, tid, cat: 'fixture' });
    if (index % 5 === 0) {
      events.push({ name: 'complete-' + index, ph: 'X', ts: ts + dur + 1, dur: 3, pid: 1, tid, cat: 'fixture' });
    }
    if (index % 7 === 0) {
      events.push({ name: 'marker-' + index, ph: 'I', ts: ts + dur + 2, pid: 1, tid, cat: 'fixture' });
    }
  }
  // 未配对 begin：采样时必须作为"输入被截断"的证据保留。
  events.push({ name: 'unpaired-begin', ph: 'B', ts: 9000, pid: 1, tid: 9, cat: 'fixture' });
  const steps = [];
  for (let index = 0; index < Math.max(4, Math.floor(pairs / 2)); index += 1) {
    steps.push({ action: 'click', ref: '@e' + (index + 1), at: FIXED_START_MS + index * 1000, ok: true });
  }
  const states = [];
  for (let index = 0; index < Math.max(2, Math.floor(pairs / 8)); index += 1) {
    states.push({ at: FIXED_START_MS + index * 1000, body: 'x'.repeat(200 + index * 120) });
  }
  states.push({ at: FIXED_START_MS + 9999, body: 'short' });
  const screenshots = [];
  for (let index = 0; index < 4; index += 1) {
    screenshots.push('data:image/png;base64,' + Buffer.from('fixture-' + index).toString('base64'));
  }
  return {
    version: 3,
    id: 'trace-' + seed,
    createdAt: FIXED_NOW_ISO,
    traceEvents: events,
    steps,
    states,
    screenshots,
  };
}

function dar(offset, dur) {
  return offset + dur;
}

/** 超大 trace：用于预算耗尽/降级终止性检查（默认 400 对 ≈ 1600 事件）。 */
export function buildHugeTraceFixture(seed = 'quality') {
  return buildTraceFixture(deriveSeed(seed, 'huge'), { pairs: 400 });
}

/** 采样策略选项：每种策略都必须确定。 */
export function samplingOptionVariants() {
  return [
    { name: 'duration-priority', options: { maxEvents: 120, strategy: 'duration-priority' } },
    { name: 'uniform-seed', options: { maxEvents: 120, strategy: 'uniform', seed: 'quality-seed' } },
    { name: 'head-tail', options: { maxEvents: 120, strategy: 'head-tail' } },
    { name: 'unlimited', options: { maxEvents: 0 } },
  ];
}

/** recipe 夹具（写入/审批路径用）。 */
export function buildRecipeFixture(seed = 'quality') {
  const rng = createRng(deriveSeed(seed, 'recipe'));
  const steps = [];
  for (let index = 0; index < 5; index += 1) {
    steps.push({ method: index % 2 === 0 ? 'observe' : 'click', params: { ref: '@e' + (index + 1), note: rng.hex(3) } });
  }
  return {
    name: 'fixture-recipe-' + seed,
    version: 2,
    steps,
    params: { target: 'fixture', page: 'https://fixture.invalid/form' },
    policy: { onFailure: 'stop', retrySafe: false },
    safety: { readOnly: false },
    description: 'quality fixture recipe',
    tags: ['quality', 'fixture'],
  };
}

/** 账本操作流：含敏感参数值（用于证明账本只存键名不存值）与只读方法。 */
export function buildLedgerOperations(seed = 'quality') {
  const rng = createRng(deriveSeed(seed, 'ledger'));
  return [
    { method: 'click', params: { ref: '@e1', selector: '#submit', label: 'submit' }, tabId: 11, sessionId: 'sess-1' },
    { method: 'fill', params: { ref: '@e2', value: 'secret-' + rng.hex(8), password: 'p@ss-' + rng.hex(8) }, tabId: 11, sessionId: 'sess-1' },
    { method: 'observe', params: { maxRows: 50 }, tabId: 11, sessionId: 'sess-1' },
    { method: 'navigate', params: { url: 'https://fixture.invalid/next', token: 'tok-' + rng.hex(8) }, tabId: 11, sessionId: 'sess-1' },
  ];
}

/** 错误码样本：排序取前 count 个（确定性），用于恢复建议/渲染检查。 */
export function buildErrorCodeSample(codes, count = 12) {
  const sorted = (Array.isArray(codes) ? codes.slice() : []).sort();
  return sorted.slice(0, Math.max(1, Math.floor(Number(count) || 12)));
}

/** HAR 重放计划的稳定序列化投影（只保留规划语义，不含任何时钟字段）。 */
export function projectReplayPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  return {
    version: plan.version,
    mode: plan.mode,
    concurrency: plan.concurrency,
    order: plan.order,
    stopOnError: plan.stopOnError,
    retryIdempotent: plan.retryIdempotent,
    entries: (plan.entries || []).map((entry) => ({
      index: entry.index,
      method: entry.method,
      url: entry.url,
      headers: entry.headers,
      body: entry.body,
      resourceType: entry.resourceType,
      startedAt: entry.startedAt,
      replayId: entry.replayId,
      order: entry.order,
      batch: entry.batch,
    })),
    batches: plan.batches,
    skipped: plan.skipped,
    summary: plan.summary,
  };
}

/** 固定时钟导出（门禁断言"重复调用不依赖真实时间"时用）。 */
export function fixtureClock() {
  return createFixedClock(FIXED_START_MS);
}
