// tests/unit/daemon-cli-schema.test.mjs —— CLI JSON schema 注册表/校验（cli/lib/json-schema.mjs）。
//
// 覆盖：
// - 注册表 id 稳定、describe/schemaTable 元信息正确；
// - 用**真实模块产出的结果**做正向校验（batch plan/start、quota snapshot、arbitration plan、
//   status views），确保 schema 与 daemon 字段同步；
// - 反向用例：缺字段、枚举错误、类型错误、越界、嵌套错误路径；
// - 校验器子集：nullable/oneOf/const/pattern/长度/数量/additionalProperties；
// - assertSchema 错误升级（默认 Error 与自定义 BridgeError 风格）；
// - stableStringify/schemaDigest/compactShape/diffShape 的确定性与"只增字段"语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_IDS,
  SCHEMAS,
  SCHEMA_TYPES,
  assertSchema,
  compactShape,
  describeSchema,
  diffShape,
  getSchema,
  listSchemas,
  schemaDigest,
  schemaTable,
  stableStringify,
  validateAgainstSchema,
  validateSchema,
} from '../../cli/lib/json-schema.mjs';
import { createSessionQuota } from '../../daemon/session-quota.js';
import { createBatchSessions } from '../../daemon/batch-sessions.js';
import { arbitrateLeaseConflicts } from '../../daemon/lease-arbitration.js';
import { createStatusViews } from '../../daemon/status-views.js';

const NOW = 1_700_000_000_000;

function baseStatus() {
  return {
    service: 'browser-bridge',
    version: '0.3.0',
    protocol: '1.9',
    pid: 1234,
    port: 52900,
    uptimeMs: 1000,
    browsers: [],
    sessions: [],
    inflight: [],
    queues: [],
    auth: { tracked: 0, blocked: [] },
    recovery: { at: 1 },
    compatibility: { daemon: {}, browsers: [] },
  };
}

function makeBatchEnv() {
  const quota = createSessionQuota({ policy: { maxSessions: 6, maxPerBatch: 3 }, liveSessions: () => 0, now: () => NOW });
  const batch = createBatchSessions({
    quota,
    startSession: async () => ({ sessionId: 'sess-1' }),
    stopSession: async () => ({ ok: true }),
    navigate: async () => ({ ok: true }),
    now: () => NOW,
    idFactory: () => 'schema-batch',
  });
  return { quota, batch };
}

function realBatchResult() {
  // 同步 fixture：与 batch.start 的输出同构（避免单测 async 依赖，同时覆盖所有字段）。
  return {
    schema: 1,
    kind: 'bridge/session-batch',
    batchId: 'schema-batch',
    state: 'completed',
    outcome: 'ok',
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 5,
    durationMs: 5,
    group: null,
    onError: 'continue',
    concurrency: 2,
    retries: 0,
    timeoutMs: 60_000,
    max: null,
    priority: 0,
    policy: { maxSessions: 6, maxPerBatch: 3, maxConcurrentStarts: 2 },
    quota: { requested: 2, granted: 2, committed: 2, released: 0, denied: 0, finalized: { ok: true } },
    summary: { total: 2, admitted: 2, denied: 0, attempted: 2, pending: 0, starting: 0, succeeded: 2, failed: 0, cancelled: 0, skipped: 0, rolledBack: 0, retried: 0, sessionsCreated: 2, navigated: 2 },
    items: [
      { index: 0, key: null, url: 'https://a.example/', browser: null, share: false, tab: null, priority: 0, group: null, retries: null, timeoutMs: null, state: 'succeeded', admission: 'admitted', attempts: 1, sessionId: 'sess-1', navigated: true, cleanup: null, startedAt: NOW, finishedAt: NOW + 5, durationMs: 5, error: null },
      { index: 1, key: 'k2', url: null, browser: 'edge', share: true, tab: 7, priority: 3, group: 'g', retries: 1, timeoutMs: 5000, state: 'failed', admission: 'admitted', attempts: 2, sessionId: null, navigated: false, cleanup: 'stopped', startedAt: NOW, finishedAt: NOW + 1, durationMs: 1, error: { code: 'E_TIMEOUT', message: '超时', data: { tabId: 7 } } },
    ],
    cancelled: false,
    rollback: null,
    warnings: [],
    reused: false,
    at: NOW,
  };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('SCHEMA_IDS / SCHEMAS：五个 schema 稳定登记且元信息完整', () => {
  assert.deepEqual(SCHEMA_IDS, [
    'bb.session-batch/1',
    'bb.session-batch-plan/1',
    'bb.session-quota/1',
    'bb.lease-arbitration/1',
    'bb.status-views/1',
  ]);
  assert.deepEqual(Object.keys(SCHEMAS), [...SCHEMA_IDS]);
  for (const id of SCHEMA_IDS) {
    const entry = getSchema(id);
    assert.ok(entry, id);
    assert.equal(entry.id, id);
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.title.length > 0);
    assert.equal(entry.schema.type, 'object');
    assert.ok(Array.isArray(entry.schema.required) && entry.schema.required.length > 0);
  }
  assert.equal(SCHEMA_TYPES.includes('integer'), true);
});

test('listSchemas / schemaTable / describeSchema：CLI schema 子命令的数据源', () => {
  const list = listSchemas();
  assert.equal(list.length, SCHEMA_IDS.length);
  assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'title']);
  const table = schemaTable();
  assert.equal(table.length, SCHEMA_IDS.length);
  assert.equal(table.find((row) => row.id === 'bb.session-batch/1').required, 'batchId,state,items,summary,quota');
  const described = describeSchema('bb.session-quota/1');
  assert.equal(described.id, 'bb.session-quota/1');
  assert.equal(describeSchema('nope'), null);
  assert.equal(getSchema('nope'), null);
});

// ---------------------------------------------------------------------------
// 正向：真实模块产出必须通过 schema
// ---------------------------------------------------------------------------

test('bb.session-batch/1：接受 batch.start / batch.status 的报告形状', () => {
  const result = validateSchema('bb.session-batch/1', realBatchResult());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.schemaId, 'bb.session-batch/1');
});

test('bb.session-batch/1：接受真实 createBatchSessions() 的产出（集成）', async () => {
  const { batch } = makeBatchEnv();
  const report = await batch.start({ items: [{ url: 'https://a.example/' }] });
  const checked = validateSchema('bb.session-batch/1', report);
  assert.deepEqual(checked.problems, []);
  const reuse = await batch.start({ items: [{ url: 'https://a.example/' }], batchId: 'schema-batch' });
  assert.equal(validateSchema('bb.session-batch/1', reuse).ok, true);
});

test('bb.session-batch-plan/1：接受真实 batch.plan() 的产出', async () => {
  const { batch } = makeBatchEnv();
  const plan = batch.plan({ items: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] });
  const checked = validateSchema('bb.session-batch-plan/1', plan);
  assert.deepEqual(checked.problems, []);
  assert.equal(plan.dryRun, true);
});

test('bb.session-quota/1：接受真实 quota.snapshot() 的产出', () => {
  const { quota } = makeBatchEnv();
  quota.reserve('b1', 2);
  const snapshot = quota.snapshot();
  assert.deepEqual(validateSchema('bb.session-quota/1', snapshot).problems, []);
});

test('bb.lease-arbitration/1：接受真实 arbitrateLeaseConflicts() 的产出', () => {
  const plan = arbitrateLeaseConflicts({
    leases: [{
      tabId: 1, holder: 'dead', epoch: 1, ttlMs: 60_000, expiresAt: NOW + 1000, remainingMs: 1000,
      participants: [{ sessionId: 'dead', attachedAt: NOW - 100 }, { sessionId: 's2', attachedAt: NOW - 50 }],
    }],
    sessions: [{ sessionId: 's2', tabId: 1, startedAt: NOW - 50 }],
    conflicts: [{ code: 'lease-holder-missing', severity: 'high', message: 'holder 失联', evidence: { tabId: 1, holder: 'dead' } }],
    now: NOW,
    isAlive: (sessionId) => sessionId === 's2',
  });
  const checked = validateSchema('bb.lease-arbitration/1', plan);
  assert.deepEqual(checked.problems, []);
  assert.equal(plan.kind, 'bridge/lease-arbitration');
});

test('bb.status-views/1：接受带新视图的 daemon.status 结果', () => {
  const views = createStatusViews({
    baseStatus,
    batchSessions: { snapshot: () => ({ quota: { policy: { maxSessions: 6, maxPerBatch: 3, maxConcurrentStarts: 2, maxPerInstance: 4, maxBatchItems: 20, reservationTtlMs: 60_000 }, live: 0, reserved: 0, available: 6 }, recent: [], totals: {} }) },
    leaseArbiter: { report: () => ({ kind: 'bridge/lease-arbitration', verdicts: [], steps: [], summary: { verdicts: 0, actionable: 0, reportOnly: 0, conflicts: 0 } }) },
  });
  const result = views.buildStatus({ views: ['batch', 'arbitration'] });
  assert.deepEqual(validateSchema('bb.status-views/1', result).problems, []);
  // 默认 status（没有 views 字段）不应被当成 views 信封。
  assert.equal(validateSchema('bb.status-views/1', baseStatus()).ok, false);
});

// ---------------------------------------------------------------------------
// 反向：字段漂移必须被指出（带路径）
// ---------------------------------------------------------------------------

function problemsOf(schemaId, value) {
  return validateSchema(schemaId, value).problems;
}

test('bb.session-batch/1：缺 batchId/items/summary 与非法枚举/越界都被指出', () => {
  const broken = realBatchResult();
  delete broken.batchId;
  delete broken.items;
  broken.state = 'exploded';
  broken.summary.total = -1;
  const problems = problemsOf('bb.session-batch/1', broken);
  assert.ok(problems.some((item) => item.includes('$.batchId') && item.includes('缺少必填')));
  assert.ok(problems.some((item) => item.includes('$.items') && item.includes('缺少必填')));
  assert.ok(problems.some((item) => item.includes('$.state') && item.includes('不在枚举')));
  assert.ok(problems.some((item) => item.includes('$.summary.total') && item.includes('< 0')));
});

test('bb.session-batch/1：条目内部错误带数组下标路径', () => {
  const broken = realBatchResult();
  broken.items[1].state = 'unknown-state';
  broken.items[1].attempts = 9;
  broken.items[1].error = { message: '缺 code' };
  const problems = problemsOf('bb.session-batch/1', broken);
  assert.ok(problems.some((item) => item.startsWith('$.items[1].state')));
  assert.ok(problems.some((item) => item.startsWith('$.items[1].attempts')));
  assert.ok(problems.some((item) => item.startsWith('$.items[1].error.code')));
});

test('bb.session-batch/1：kind 常量不符与 quota 缺失被指出', () => {
  const broken = realBatchResult();
  broken.kind = 'bridge/wrong';
  delete broken.quota;
  const problems = problemsOf('bb.session-batch/1', broken);
  assert.ok(problems.some((item) => item.includes('$.kind') && item.includes('常量')));
  assert.ok(problems.some((item) => item.includes('$.quota')));
});

test('bb.session-batch-plan/1：dryRun 必须为 true、admission 枚举受限', () => {
  const broken = {
    schema: 1,
    kind: 'bridge/session-batch-plan',
    dryRun: false,
    items: [{ index: 0, admission: 'maybe' }],
    summary: { total: 1, admissable: 1, denied: 0 },
    quota: { decisions: [], totals: {} },
  };
  const problems = problemsOf('bb.session-batch-plan/1', broken);
  assert.ok(problems.some((item) => item.includes('$.dryRun') && item.includes('常量')));
  assert.ok(problems.some((item) => item.includes('$.items[0].admission') && item.includes('不在枚举')));
});

test('bb.session-quota/1：policy 必填、可用量负数被拒绝', () => {
  const broken = {
    policy: { maxSessions: 0, maxPerBatch: 1, maxConcurrentStarts: 1 },
    live: 0,
    reserved: 0,
    available: -1,
  };
  const problems = problemsOf('bb.session-quota/1', broken);
  assert.ok(problems.some((item) => item.includes('$.policy.maxSessions') && item.includes('< 1')));
  assert.ok(problems.some((item) => item.includes('$.available') && item.includes('< 0')));
  assert.ok(problems.some((item) => item.includes('$.policy.maxPerInstance') === false), '缺失可选字段不报错');
});

test('bb.lease-arbitration/1：非法 action/severity/strategy 与缺失 summary 被指出', () => {
  const broken = {
    kind: 'bridge/lease-arbitration',
    policy: { strategy: 'winner-takes-all', limit: 500 },
    verdicts: [{ tabId: 1, action: 'steal', severity: 'critical', conflictCodes: ['x'] }],
    steps: [],
    // summary 缺失
  };
  const problems = problemsOf('bb.lease-arbitration/1', broken);
  assert.ok(problems.some((item) => item.includes('$.policy.strategy') && item.includes('不在枚举')));
  assert.ok(problems.some((item) => item.includes('$.policy.limit') && item.includes('> 200')));
  assert.ok(problems.some((item) => item.includes('$.verdicts[0].action') && item.includes('不在枚举')));
  assert.ok(problems.some((item) => item.includes('$.verdicts[0].severity') && item.includes('不在枚举')));
  assert.ok(problems.some((item) => item.includes('$.summary') && item.includes('缺少必填')));
});

test('bb.status-views/1：views 必须是字符串数组，batch 缺 quota 被指出', () => {
  const broken = {
    service: 'browser-bridge',
    version: '0.3.0',
    browsers: [],
    sessions: [],
    views: 'batch',
    batch: { recent: [], totals: {} },
  };
  const problems = problemsOf('bb.status-views/1', broken);
  assert.ok(problems.some((item) => item.includes('$.views') && item.includes('类型应为 array')));
  assert.ok(problems.some((item) => item.includes('$.batch.quota') && item.includes('缺少必填')));
});

test('validateSchema：未知 schema id 返回失败而不是抛错', () => {
  const result = validateSchema('bb.unknown/9', {});
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /未登记/);
});

// ---------------------------------------------------------------------------
// 校验器子集能力
// ---------------------------------------------------------------------------

test('validateAgainstSchema：type/nullable/const/enum/pattern/长度/区间/oneOf', () => {
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      kind: { type: 'string', const: 'fixed' },
      mode: { type: 'string', enum: ['a', 'b'] },
      optional: { type: 'string', nullable: true },
      choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      list: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer' } },
    },
    additionalProperties: false,
  };
  assert.deepEqual(validateAgainstSchema(schema, {
    name: 'abc', count: 2, kind: 'fixed', mode: 'a', optional: null, choice: 5, list: [1, 2],
  }), []);
  const problems = validateAgainstSchema(schema, {
    name: 'TOOLONG', count: 9, kind: 'nope', mode: 'c', choice: true, list: [1, 2, 3], extra: true,
  });
  assert.ok(problems.some((item) => item.includes('$.name') && item.includes('长度')));
  assert.ok(problems.some((item) => item.includes('$.count') && item.includes('> 3')));
  assert.ok(problems.some((item) => item.includes('$.kind') && item.includes('常量')));
  assert.ok(problems.some((item) => item.includes('$.mode') && item.includes('不在枚举')));
  assert.ok(problems.some((item) => item.includes('$.choice') && item.includes('oneOf')));
  assert.ok(problems.some((item) => item.includes('$.list') && item.includes('长度 > 2')));
  assert.ok(problems.some((item) => item.includes('$.extra') && item.includes('additionalProperties')));
});

test('validateAgainstSchema：整数与 number 的兼容、null 拒绝、根类型错误', () => {
  assert.deepEqual(validateAgainstSchema({ type: 'number' }, 3), []);
  assert.deepEqual(validateAgainstSchema({ type: 'integer' }, 3.5), ['$: 类型应为 integer，实际 number（number(3.5)）']);
  assert.deepEqual(validateAgainstSchema({ type: 'string' }, null), ['$: 不允许为 null']);
  assert.deepEqual(validateAgainstSchema({ type: 'object' }, []).length, 1);
  assert.deepEqual(validateAgainstSchema({}, 'anything'), []);
});

test('validateAgainstSchema：oneOf 需要恰好匹配一个分支', () => {
  const schema = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  const problems = validateAgainstSchema(schema, 3);
  assert.ok(problems.some((item) => item.includes('恰好匹配 1 个分支')));
});

// ---------------------------------------------------------------------------
// assertSchema / stableStringify / digest / shape
// ---------------------------------------------------------------------------

test('assertSchema：默认 Error 带 code=E_INTERNAL 与 problems；自定义 Error 类被使用', () => {
  const value = { kind: 'bridge/session-batch' };
  assert.throws(() => assertSchema('bb.session-batch/1', value), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'E_INTERNAL');
    assert.equal(error.schemaId, 'bb.session-batch/1');
    assert.ok(Array.isArray(error.problems) && error.problems.length > 0);
    return true;
  });
  class BridgeError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  assert.throws(() => assertSchema('bb.session-batch/1', value, { ErrorType: BridgeError, code: 'E_BAD_SHAPE' }), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'E_BAD_SHAPE');
    return true;
  });
  // 合规时返回校验结果而不是抛错。
  const ok = assertSchema('bb.session-batch/1', realBatchResult());
  assert.equal(ok.ok, true);
});

test('stableStringify：对象键排序、数组保序、函数被替换、循环引用安全', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
  assert.equal(stableStringify({ fn: () => 1 }), '{"fn":"[fn]"}');
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.match(stableStringify(cyclic), /<cycle>/);
});

test('schemaDigest：确定性（键序无关）且对值敏感', () => {
  const a = schemaDigest({ b: 2, a: 1, nested: { z: true, y: [1, 2] } });
  const b = schemaDigest({ nested: { y: [1, 2], z: true }, a: 1, b: 2 });
  const c = schemaDigest({ b: 3, a: 1, nested: { z: true, y: [1, 2] } });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('compactShape：保留类型与键名、数组截断、深度限制', () => {
  const shape = compactShape({ a: 1, b: [true, 'x'], c: { d: null } });
  assert.equal(shape.a, 'number');
  assert.deepEqual(shape.b, ['boolean', 'string']);
  assert.deepEqual(shape.c, { d: 'null', __keys: 1 });
  assert.equal(shape.__keys, 3);
  const deep = compactShape({ a: { b: { c: { d: 1 } } } }, { depth: 2 });
  assert.equal(typeof deep.a, 'object');
  const small = compactShape({ a: 1, b: 2, c: 3 }, { maxKeys: 2 });
  assert.equal(small.__keys, 3);
  assert.equal(Object.keys(small).filter((key) => key !== '__keys').length, 2);
});

test('diffShape：报告缺失字段与类型变化，新增字段不算问题', () => {
  const expected = compactShape({ a: 1, b: { c: true }, list: [{ name: 'x' }] });
  const missing = diffShape(expected, compactShape({ a: 1, b: {}, list: [{ name: 'x' }] }));
  assert.ok(missing.some((item) => item.path === '$.b.c' && item.actual === 'missing'));
  const changed = diffShape(expected, compactShape({ a: '1', b: { c: true }, list: [{ name: 'x' }] }));
  assert.ok(changed.some((item) => item.path === '$.a' && item.expected === 'number' && item.actual === 'string'));
  const additive = diffShape(expected, compactShape({ a: 1, b: { c: true, extra: 2 }, list: [{ name: 'x' }], newField: 1 }));
  assert.deepEqual(additive, []);
  assert.deepEqual(diffShape('a', 1), [{ path: '$', expected: 'a', actual: 1 }]);
});

test('schema 校验器对真实 daemon status（默认载荷）也保持宽容（不要求 views）', () => {
  // bb.status-views/1 只用于"显式 views 请求"的结果；默认 status 不该被误判为合规。
  const plain = baseStatus();
  assert.equal(validateSchema('bb.status-views/1', plain).ok, false);
  // 但默认 status 的既有字段可以被任意 schema 的 additionalProperties 宽容处理。
  const tolerant = validateAgainstSchema({ type: 'object', required: ['service'] }, plain);
  assert.deepEqual(tolerant, []);
});
