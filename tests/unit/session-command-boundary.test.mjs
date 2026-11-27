// tests/unit/session-command-boundary.test.mjs —— 命令超时/取消/幂等边界矩阵：
// 分类、超时钳制、取消语义、结果判定、矩阵不变量、运行时计数与 status 增量视图。
import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_NAMES } from '../../lib/method-catalog.mjs';
import {
  BOUNDARY_KIND,
  BOUNDARY_SCHEMA,
  CANCEL_REASONS,
  IDEMPOTENCY_CLASSES,
  TIMEOUT_CLASSES,
  buildBoundaryMatrix,
  canCancel,
  cancelEvidence,
  classifyOutcome,
  createCommandBoundary,
  describeMethodBoundary,
  profileMethod,
  summarizeBoundaryMatrix,
  timeoutFor,
  validateBoundaryMatrix,
} from '../../daemon/command-boundary.js';
import { createStatusViews } from '../../daemon/status-views.js';

// 只从单一目录里取样，避免测试自己维护方法名清单导致漂移。
function pickMethod(predicate) {
  return METHOD_NAMES.find(predicate);
}

test('buildBoundaryMatrix：覆盖单一目录全部方法，不变量为空，分类计数自洽', () => {
  const matrix = buildBoundaryMatrix({ now: 1 });
  assert.equal(matrix.schema, BOUNDARY_SCHEMA);
  assert.equal(matrix.kind, BOUNDARY_KIND);
  assert.equal(matrix.entries.length, METHOD_NAMES.length);
  assert.equal(matrix.counts.total, METHOD_NAMES.length);
  assert.equal(matrix.counts.known, METHOD_NAMES.length);
  assert.deepEqual(matrix.invariants, [], JSON.stringify(matrix.invariants.slice(0, 5)));
  const idempotencySum = Object.values(matrix.counts.byIdempotency).reduce((sum, value) => sum + value, 0);
  assert.equal(idempotencySum, METHOD_NAMES.length);
  const timeoutSum = Object.values(matrix.counts.byTimeoutClass).reduce((sum, value) => sum + value, 0);
  assert.equal(timeoutSum, METHOD_NAMES.length);
  for (const name of Object.keys(matrix.counts.byIdempotency)) assert.equal(IDEMPOTENCY_CLASSES.includes(name), true);
  for (const name of Object.keys(matrix.counts.byTimeoutClass)) assert.equal(Object.prototype.hasOwnProperty.call(TIMEOUT_CLASSES, name), true);
});

test('profileMethod：只读/变异/本地控制面的幂等性、超时类别与队列属性', () => {
  const readMethod = pickMethod((method) => profileMethod(method).effect === 'passive_read' && profileMethod(method).owner === 'session');
  const read = profileMethod(readMethod);
  assert.equal(read.known, true);
  assert.equal(read.idempotency, 'read-only');
  assert.equal(read.cancel.allowed, true);
  assert.equal(read.cancel.requiresResolve, false);
  assert.equal(read.owner, 'session');
  assert.equal(read.queue.serial, true);
  assert.equal(read.reconcile.strategy, 'none');

  const mutation = profileMethod(pickMethod((method) => profileMethod(method).nonIdempotent && profileMethod(method).owner === 'session'));
  assert.equal(mutation.idempotency, 'non-idempotent');
  assert.equal(mutation.mutating, true);
  assert.equal(mutation.cancel.allowed, true);
  assert.equal(mutation.cancel.reason, 'requires-resolve');
  assert.equal(mutation.cancel.requiresResolve, true);

  // 本地控制面：不可取消（没有扩展 inflight）。
  const local = profileMethod(pickMethod((method) => profileMethod(method).owner === 'local' && !profileMethod(method).queue.bypass));
  assert.equal(local.cancel.allowed, false);
  assert.equal(local.cancel.reason, 'local-control-plane');

  // 未知方法：保守 unknown。
  const unknown = profileMethod('no.such.method');
  assert.equal(unknown.known, false);
  assert.equal(unknown.idempotency, 'unknown');
  assert.equal(unknown.timeout.class, 'unknown');
  assert.equal(unknown.cancel.allowed, false);
  assert.equal(unknown.cancel.reason, 'unknown-method');
});

test('timeoutFor：默认值/请求值/上下限钳制/capped 证据', () => {
  const readMethod = pickMethod((method) => profileMethod(method).timeoutClass === 'read');
  const defaults = timeoutFor({ method: readMethod });
  assert.equal(defaults.reason, 'default');
  assert.equal(defaults.ms, TIMEOUT_CLASSES.read.defaultMs);
  assert.equal(defaults.capped, false);
  const requested = timeoutFor({ method: readMethod, requestedMs: 5_000 });
  assert.equal(requested.ms, 5_000);
  assert.equal(requested.reason, 'requested');
  const capped = timeoutFor({ method: readMethod, requestedMs: 999_999 });
  assert.equal(capped.ms, TIMEOUT_CLASSES.read.maxMs);
  assert.equal(capped.capped, true);
  assert.equal(capped.reason, 'capped-max');
  const raised = timeoutFor({ method: readMethod, requestedMs: 1 });
  assert.equal(raised.ms, TIMEOUT_CLASSES.read.minMs);
  assert.equal(raised.clamped, true);
  assert.equal(raised.reason, 'raised-min');
  // 显式 defaultTimeoutMs 覆盖类别默认值。
  const overridden = timeoutFor({ method: readMethod, defaultTimeoutMs: 60_000 });
  assert.equal(overridden.ms, 60_000);
  // 非法请求值退回默认。
  assert.equal(timeoutFor({ method: readMethod, requestedMs: 'x' }).reason, 'default');
  assert.equal(timeoutFor({ method: readMethod, requestedMs: 0 }).reason, 'default');
});

test('canCancel / cancelEvidence：非幂等"只转发"，本地控制面拒绝，证据字段完整', () => {
  const mutation = pickMethod((method) => profileMethod(method).nonIdempotent && profileMethod(method).owner === 'session');
  const decision = canCancel({ method: mutation });
  assert.equal(decision.allowed, true);
  assert.equal(decision.forward, true);
  assert.equal(decision.requiresResolve, true);
  assert.equal(CANCEL_REASONS.includes(decision.reason), true);
  const read = canCancel({ method: pickMethod((method) => profileMethod(method).idempotency === 'read-only' && profileMethod(method).owner === 'session') });
  assert.equal(read.reason, 'discard-result');
  const local = canCancel({ method: pickMethod((method) => profileMethod(method).owner === 'local' && profileMethod(method).idempotency === 'non-idempotent') || 'no.such.method' });
  assert.equal(local.allowed, false);
  const evidence = cancelEvidence({ id: 'c1', method: mutation, startedAt: 1_000, now: 3_500, result: { cancelled: true } });
  assert.equal(evidence.id, 'c1');
  assert.equal(evidence.elapsedMs, 2_500);
  assert.equal(evidence.forwarded, true);
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.requiresResolve, true);
  assert.equal(evidence.effectState, 'unknown');
  assert.equal(cancelEvidence({ id: 'c2', method: mutation, now: 5 }).elapsedMs, null);
});

test('classifyOutcome：成功/未生效/失败/UNKNOWN，非幂等 UNKNOWN 禁止重放', () => {
  const mutation = pickMethod((method) => profileMethod(method).nonIdempotent && profileMethod(method).owner === 'session');
  const read = pickMethod((method) => profileMethod(method).idempotency === 'read-only');
  const success = classifyOutcome({ method: mutation, result: { ok: true } });
  assert.equal(success.effectState, 'done');
  assert.equal(success.settled, true);
  assert.equal(success.replayBlocked, false);
  const noEffect = classifyOutcome({ method: mutation, error: Object.assign(new Error('bad'), { code: 'E_BAD_ARG' }) });
  assert.equal(noEffect.effectState, 'none');
  assert.equal(noEffect.retrySafe, true);
  assert.equal(noEffect.replayBlocked, false);
  const unknown = classifyOutcome({ method: mutation, error: Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' }) });
  assert.equal(unknown.effectState, 'unknown');
  assert.equal(unknown.settled, false);
  assert.equal(unknown.replayBlocked, true);
  assert.equal(unknown.requiresResolve, true);
  const failed = classifyOutcome({ method: mutation, error: Object.assign(new Error('boom'), { code: 'E_INTERNAL' }) });
  assert.equal(failed.effectState, 'failed');
  assert.equal(failed.retrySafe, false, '非幂等动作失败也不应自动重试');
  const readUnknown = classifyOutcome({ method: read, error: Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' }) });
  assert.equal(readUnknown.effectState, 'unknown');
  assert.equal(readUnknown.replayBlocked, false, '只读动作未知结果不阻断');
  const readFailed = classifyOutcome({ method: read, error: Object.assign(new Error('boom'), { code: 'E_INTERNAL' }) });
  assert.equal(readFailed.retrySafe, true);
  assert.equal(classifyOutcome({ method: read, error: Object.assign(new Error('x'), { code: 'E_BAD_ARG' }) }).effectState, 'none');
});

test('validateBoundaryMatrix：识别坏条目/目录外方法/非幂等与 effect 漂移/本地可取消', () => {
  const bad = validateBoundaryMatrix(null);
  assert.equal(bad.length, 0);
  const issues = validateBoundaryMatrix([
    null,
    { method: 'x', known: false },
    {
      method: 'm1', known: true, mutating: false, idempotency: 'non-idempotent',
      cancel: { allowed: true }, owner: 'session', queue: { serial: true },
      timeout: { defaultMs: 10_000, minMs: 1_000, maxMs: 60_000 },
    },
    {
      method: 'm2', known: true, mutating: true, idempotency: 'retry-safe',
      cancel: { allowed: true }, owner: 'local', queue: { serial: false },
      timeout: { defaultMs: 1, minMs: 1_000, maxMs: 60_000 },
    },
    {
      method: 'm3', known: true, mutating: true, idempotency: 'retry-safe',
      cancel: { allowed: true }, owner: 'session', queue: { serial: false },
      timeout: { defaultMs: 10_000, minMs: 1_000, maxMs: 60_000 },
    },
  ]);
  const codes = issues.map((item) => item.code);
  assert.equal(codes.includes('bad-entry'), true);
  assert.equal(codes.includes('unknown-method'), true);
  assert.equal(codes.includes('non-idempotent-not-mutating'), true);
  assert.equal(codes.includes('local-cancelable'), true);
  assert.equal(codes.includes('session-not-serial'), true);
  assert.equal(codes.includes('bad-timeout-bounds'), true);
});

test('createCommandBoundary：运行时计数、决策环、矩阵缓存与 summary/describe/stats', () => {
  const boundary = createCommandBoundary({ now: () => 1_700_000_000_000, defaultTimeoutMs: 30_000, decisionLimit: 5 });
  const read = pickMethod((method) => profileMethod(method).idempotency === 'read-only');
  const mutation = pickMethod((method) => profileMethod(method).nonIdempotent && profileMethod(method).owner === 'session');
  assert.equal(boundary.classify(read).idempotency, 'read-only');
  assert.equal(boundary.timeout({ method: read }).ms, 30_000);
  assert.equal(boundary.timeout({ method: read, requestedMs: 999_999 }).capped, true);
  assert.equal(boundary.cancel({ method: mutation }).allowed, true);
  assert.equal(boundary.cancel({ method: 'no.such.method' }).allowed, false);
  assert.equal(boundary.outcome({ method: mutation, error: Object.assign(new Error('t'), { code: 'E_TIMEOUT' }) }).replayBlocked, true);
  assert.equal(boundary.outcome({ method: read }).effectState, 'done');
  const first = boundary.matrix();
  assert.equal(boundary.matrix(), first, '默认矩阵带缓存');
  const refreshed = boundary.matrix({ refresh: true });
  assert.notEqual(refreshed, first);
  const summary = boundary.summary({ limit: 3 });
  assert.equal(summary.counts.total, METHOD_NAMES.length);
  assert.equal(summary.invariantOk, true);
  assert.equal(TIMEOUT_CLASSES[summary.timeoutClasses.read.class] === undefined, true);
  assert.equal(summary.timeoutClasses.read.defaultMs, TIMEOUT_CLASSES.read.defaultMs);
  assert.equal(summary.runtime.counters.classifications, 1);
  assert.equal(summary.runtime.counters.cappedTimeouts, 1);
  assert.equal(summary.runtime.counters.unknownOutcomes >= 1, true);
  assert.equal(summary.runtime.decisions.length <= 3, true);
  assert.match(boundary.describe(mutation), /幂等性=non-idempotent/);
  const stats = boundary.stats();
  assert.equal(stats.counters.timeouts, 2);
  assert.equal(stats.decisions > 0, true);
  const reset = boundary.reset();
  assert.equal(reset.counters.timeouts, 0);
  assert.equal(reset.decisions, 0);
});

test('summarizeBoundaryMatrix / describeMethodBoundary：样本、类别表与解释', () => {
  const matrix = buildBoundaryMatrix({ now: 1 });
  const summary = summarizeBoundaryMatrix(matrix, { limit: 2 });
  assert.equal(summary.counts.total, METHOD_NAMES.length);
  assert.deepEqual(summary.idempotencyClasses, IDEMPOTENCY_CLASSES);
  assert.deepEqual(summary.cancelReasons, CANCEL_REASONS);
  for (const name of Object.keys(TIMEOUT_CLASSES)) assert.equal(typeof summary.timeoutClasses[name].defaultMs, 'number');
  const samplesTotal = Object.values(summary.samples).reduce((sum, list) => sum + list.length, 0);
  assert.equal(samplesTotal <= 4 * 2, true);
  assert.equal(summary.invariantOk, true);
  const text = describeMethodBoundary(pickMethod((method) => profileMethod(method).idempotency === 'non-idempotent' && profileMethod(method).owner === 'session'));
  assert.match(text, /不可自动重放/);
  assert.match(text, /cancel 可转发/);
});

test('status views=boundary：注入 commandBoundary 才出现字段，异常降级', () => {
  const baseStatus = () => ({ service: 'browser-bridge', version: '0.3.0', browsers: [], sessions: [], inflight: [], queues: [] });
  const boundary = createCommandBoundary({ now: () => 1 });
  const views = createStatusViews({ baseStatus, commandBoundary: boundary });
  const plain = views.buildStatus({});
  assert.equal(Object.prototype.hasOwnProperty.call(plain, 'boundary'), false);
  const result = views.buildStatus({ views: ['boundary'], limit: 2 });
  assert.deepEqual(result.views, ['boundary']);
  assert.equal(result.boundary.counts.total, METHOD_NAMES.length);
  assert.equal(result.boundary.invariantOk, true);
  assert.equal(result.service, 'browser-bridge');
  const broken = createStatusViews({ baseStatus, commandBoundary: { summary: () => { throw new Error('boundary boom'); } } });
  const degraded = broken.buildStatus({ views: ['boundary'] });
  assert.equal(degraded.boundary.ok, false);
  assert.equal(degraded.boundary.error, 'E_INTERNAL');
});
