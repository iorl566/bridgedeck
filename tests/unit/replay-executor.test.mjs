// tests/unit/replay-executor.test.mjs —— 回放执行器（第二轮）：确定性/副作用语义/失败解释。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../../extension/src/lib/replay-executor.js';
import { buildReplayPlan } from '../../extension/src/lib/replay-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function networkPlan(method = 'POST', extra = {}) {
  return {
    version: 1,
    source: 'network.replay',
    ok: true,
    token: 'rp1-test',
    fingerprint: 'fp-test',
    steps: [{
      index: 0,
      ref: 'network:r1',
      kind: 'network',
      sourceKind: 'network.replay',
      method: 'network.replay',
      params: { method, origin: 'https://a.test', path: '/api', url: 'https://a.test/api' },
      target: null,
      expect: null,
      fallback: { onError: 'stop', retries: 0, retryDelayMs: 0 },
      idempotent: false,
      boundary: null,
    }],
    boundaries: { plans: [{ index: 0, action: 'continue' }] },
    phases: [],
    checkpoints: [],
    blockers: [],
    warnings: [],
    budget: { steps: 1, actions: 0, branches: 0, waits: 0, humans: 0, waitMs: 0, retries: 0, overBudget: false },
    network: { method, sideEffect: true, crossOrigin: false, hasRecordedEntry: false, urlResolved: true },
    ...extra,
  };
}

function recordPlan(steps, extra = {}) {
  return {
    version: 1,
    source: 'record.export',
    ok: true,
    token: 'rp1-record',
    fingerprint: 'fp-record',
    steps: steps.map((step, index) => ({
      index,
      ref: step.ref || 'r' + index,
      kind: step.kind || 'action',
      method: step.method || 'click',
      params: step.params || {},
      target: step.target || null,
      expect: step.expect || null,
      fallback: step.fallback || { onError: 'stop', retries: 0, retryDelayMs: 0 },
      idempotent: step.idempotent === true,
      risk: step.risk || 'browser_mutation',
      boundary: null,
      humanGate: step.humanGate || null,
    })),
    boundaries: { plans: steps.map(() => ({ action: 'continue' })) },
    phases: [],
    checkpoints: [],
    blockers: [],
    warnings: [],
    budget: { steps: steps.length, actions: steps.length, branches: 0, waits: 0, humans: 0, waitMs: 0, retries: 0, overBudget: false },
    ...extra,
  };
}

function fixedProviders(result = { status: 200, body: 'ok', headers: { 'content-type': 'text/plain' }, url: 'https://a.test/api' }) {
  return { execute: async () => result };
}

// ---------------------------------------------------------------------------
// 常量 / 选项归一
// ---------------------------------------------------------------------------

test('执行器版本/结果码/上限形状稳定', () => {
  assert.equal(E.REPLAY_EXECUTOR_VERSION, 2);
  assert.equal(E.EXECUTOR_CODES.OK, 'REPLAY_EXEC_OK');
  assert.equal(E.EXECUTOR_CODES.NO_EXECUTOR, 'REPLAY_EXEC_NO_EXECUTOR');
  assert.deepEqual([...E.EXEC_STATUS], ['planned', 'passed', 'failed', 'skipped', 'blocked']);
  assert.equal(E.EXECUTOR_LIMITS.maxSteps, 4000);
  assert.equal(E.EXECUTOR_LIMITS.maxRetries, 5);
  assert.equal(E.EXECUTOR_CATALOG_CODES[E.EXECUTOR_CODES.TIMEOUT], 'REPLAY_TIMEOUT');
});

test('normalizeExecutionOptions：默认值安全、非法值回落、上限截断', () => {
  const defaults = E.normalizeExecutionOptions();
  assert.equal(defaults.validateExpectations, true);
  assert.equal(defaults.stopOnFailure, true);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.virtualClock, true);
  assert.equal(defaults.limits.maxSteps, 4000);

  const custom = E.normalizeExecutionOptions({
    limits: { maxSteps: 999999, maxRetries: -1, maxRetryDelayMs: 1e9, maxTotalVirtualMs: 1234 },
    maxSteps: 7,
    dryRun: true,
    ignoreBlockers: true,
    measureDurations: true,
  });
  assert.equal(custom.limits.maxSteps, 4000);
  assert.equal(custom.limits.maxRetries, 0);
  assert.equal(custom.limits.maxRetryDelayMs, 5000);
  assert.equal(custom.limits.maxTotalVirtualMs, 1234);
  assert.equal(custom.dryRun, true);
  assert.equal(custom.ignoreBlockers, true);
  assert.equal(custom.measureDurations, true);
  assert.deepEqual(E.normalizeExecutionOptions(null).limits, defaults.limits);
});

test('normalizeExecutionProviders：非函数降级为 null，不抛异常', () => {
  const providers = E.normalizeExecutionProviders({ execute: () => 1, sleep: 'x', now: 42, restoreBoundary: undefined });
  assert.equal(typeof providers.execute, 'function');
  assert.equal(providers.sleep, null);
  assert.equal(providers.now, null);
  assert.equal(providers.restoreBoundary, null);
  assert.equal(providers.isCancelled, null);
  assert.deepEqual(E.normalizeExecutionProviders(null).execute, null);
});

// ---------------------------------------------------------------------------
// 副作用语义 / 信封
// ---------------------------------------------------------------------------

test('sideEffectSemantics：GET 网络计划是只读，POST 是写；两次结果逐字节一致', () => {
  const get = E.sideEffectSemantics(networkPlan('GET'));
  assert.equal(get.mutating, false);
  assert.equal(get.risk, 'read_only');
  assert.equal(get.safeMethod, true);
  assert.equal(get.counts.networkSteps, 1);
  assert.equal(get.counts.mutating, 0);
  assert.equal(get.network.method, 'GET');

  const post = E.sideEffectSemantics(networkPlan('POST'));
  assert.equal(post.mutating, true);
  assert.equal(post.risk, 'browser_mutation');
  assert.equal(post.safeMethod, false);
  assert.equal(post.counts.mutating, 1);
  assert.equal(post.effects[0].effect, 'network-write');
  assert.equal(post.effects[0].mutating, true);

  const again = E.sideEffectSemantics(networkPlan('POST'));
  assert.equal(again.digest, post.digest);
  assert.deepEqual(again, post);
});

test('sideEffectSemantics：录制计划的动作/导航/人工点被确定性归类', () => {
  const plan = recordPlan([
    { method: 'click', idempotent: false },
    { method: 'read', kind: 'observe', idempotent: true },
    { kind: 'branch', method: 'navigate', idempotent: true },
    { kind: 'human', method: 'human-gate', humanGate: { reason: 'login', valueKind: 'text' } },
    { method: 'fill', idempotent: true },
  ]);
  const semantics = E.sideEffectSemantics(plan);
  assert.equal(semantics.counts.steps, 5);
  assert.equal(semantics.counts.navigations, 1);
  assert.equal(semantics.counts.humanGates, 1);
  assert.equal(semantics.counts.observes, 1);
  assert.equal(semantics.mutating, true);
  assert.equal(semantics.counts.mutating, 2); // click + navigate
  assert.equal(semantics.counts.readOnly, 3);
});

test('summarizeSideEffects：紧凑字段有界且稳定', () => {
  const summary = E.summarizeSideEffects(E.sideEffectSemantics(networkPlan('PATCH')));
  assert.equal(summary.mutating, true);
  assert.equal(summary.networkRequests, 1);
  assert.equal(summary.method, 'PATCH');
  assert.equal(summary.safeMethod, false);
  assert.equal(typeof summary.digest, 'string');
  assert.equal(summary.digest.length > 0, true);
  assert.equal(E.summarizeSideEffects(null).mutating, false);
});

test('buildExecutionEnvelope：同一输入两次 → 同指纹；不同计划 → 不同指纹', () => {
  const first = E.buildExecutionEnvelope(networkPlan('POST'));
  const second = E.buildExecutionEnvelope(networkPlan('POST'));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first, second);
  assert.equal(first.deterministic, true);
  assert.equal(first.hasWallClock, false);
  assert.equal(first.virtualClock, true);
  assert.equal(first.planToken, 'rp1-test');
  assert.equal(first.steps, 1);
  assert.equal(first.sideEffects.mutating, true);
  assert.equal(typeof first.checksum, 'string');

  const different = E.buildExecutionEnvelope(networkPlan('GET'));
  assert.notEqual(different.fingerprint, first.fingerprint);
  assert.equal(E.executionEnvelopeFingerprint(first), first.fingerprint);
  assert.notEqual(E.executionEnvelopeFingerprint(different), first.fingerprint);
});

test('buildExecutionEnvelope：blocked 计划显式标记，空计划也确定', () => {
  const blocked = E.buildExecutionEnvelope(networkPlan('GET', {
    blockers: [{ code: 'NETWORK_REPLAY_BAD_URL', index: -1, message: 'bad url' }],
  }));
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.blockerCodes, ['NETWORK_REPLAY_BAD_URL']);

  const empty = E.buildExecutionEnvelope({ steps: [], token: 'rp1-empty', fingerprint: 'fp-empty' });
  assert.equal(empty.steps, 0);
  assert.equal(empty.blocked, true);
});

// ---------------------------------------------------------------------------
// runReplayPlan：阻断 / 缺依赖 / dry-run
// ---------------------------------------------------------------------------

test('runReplayPlan：计划有 blocker 时 fail-closed，不调用 execute', async () => {
  let called = 0;
  const plan = networkPlan('GET', { blockers: [{ code: 'NETWORK_REPLAY_BAD_URL', index: -1, message: '需要绝对 http(s) URL' }] });
  const result = await E.runReplayPlan(plan, { execute: async () => { called += 1; return {}; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, E.EXECUTOR_CODES.BLOCKED);
  assert.equal(called, 0);
  assert.equal(result.entries.length, 0);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.explanation !== null, true);
  assert.equal(result.explanation.category, 'network');
  assert.equal(typeof result.digest, 'string');
});

test('runReplayPlan：ignoreBlockers 允许记账（真实命令路径用）', async () => {
  const plan = networkPlan('GET', { blockers: [{ code: 'NETWORK_REPLAY_MISSING_ENTRY', index: -1, message: '只有采集 id' }] });
  const result = await E.runReplayPlan(plan, fixedProviders(), { ignoreBlockers: true });
  assert.equal(result.ok, true);
  assert.equal(result.passed, 1);
  assert.equal(result.code, E.EXECUTOR_CODES.OK);
});

test('runReplayPlan：没有 execute provider → NO_EXECUTOR（绝不假装执行）', async () => {
  const result = await E.runReplayPlan(networkPlan('GET'), {});
  assert.equal(result.ok, false);
  assert.equal(result.code, E.EXECUTOR_CODES.NO_EXECUTOR);
  assert.equal(result.executed, 0);
  assert.equal(result.explanation.category, 'plan');
});

test('runReplayPlan：dry-run 只做计划，不调用 execute，也不产生副作用', async () => {
  let called = 0;
  const result = await E.runReplayPlan(networkPlan('POST'), { execute: async () => { called += 1; } }, { dryRun: true });
  assert.equal(called, 0);
  assert.equal(result.ok, true);
  assert.equal(result.code, E.EXECUTOR_CODES.PLANNED);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, 'planned');
  assert.equal(result.effects.length, 0);
});

// ---------------------------------------------------------------------------
// runReplayPlan：成功路径 / 副作用账本 / 确定性
// ---------------------------------------------------------------------------

test('runReplayPlan：POST 成功 → passed + network-write 副作用账本；两次执行语义指纹一致', async () => {
  const plan = networkPlan('POST');
  const first = await E.runReplayPlan(plan, fixedProviders());
  const second = await E.runReplayPlan(plan, fixedProviders());
  assert.equal(first.ok, true);
  assert.equal(first.code, E.EXECUTOR_CODES.OK);
  assert.equal(first.passed, 1);
  assert.equal(first.entries[0].status, 'passed');
  assert.equal(first.entries[0].result.status, 200);
  assert.equal(first.effects.length, 1);
  assert.equal(first.effects[0].effect, 'network-write');
  assert.equal(first.effects[0].index, 0);
  assert.equal(first.hasWallClock, false);
  assert.equal(first.deterministic, true);
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(E.compareExecutions(first, second).deterministic, true);
});

test('runReplayPlan：GET 成功 → 无副作用账本；响应语义进入条目', async () => {
  const result = await E.runReplayPlan(networkPlan('GET'), fixedProviders({
    status: 204,
    body: '',
    headers: { 'x-a': '1' },
    url: 'https://a.test/api',
  }));
  assert.equal(result.ok, true);
  assert.equal(result.effects.length, 0);
  const entry = result.entries[0];
  assert.equal(entry.result.status, 204);
  assert.equal(entry.result.statusClass, 200);
  assert.equal(entry.result.redirected, false);
  assert.equal(entry.result.bodyBytes, null);
});

test('runReplayPlan：结果含 url → 重定向事实可判（request 与 final 不同）', async () => {
  const result = await E.runReplayPlan(networkPlan('GET'), fixedProviders({
    status: 200,
    body: 'ok',
    url: 'https://b.test/landing',
  }));
  assert.equal(result.entries[0].result.redirected, true);
  assert.equal(result.entries[0].result.urlOrigin, 'https://b.test');
});

test('runReplayPlan：expect 不一致 → failed（DIFF 码）且不自动重试', async () => {
  const plan = networkPlan('GET');
  plan.steps[0].expect = { status: '2xx', textIncludes: 'hello' };
  plan.steps[0].fallback = { onError: 'retry', retries: 3, retryDelayMs: 10 };
  let calls = 0;
  const result = await E.runReplayPlan(plan, { execute: async () => { calls += 1; return { status: 200, body: 'nope', url: 'https://a.test/api' }; } });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.entries[0].status, 'failed');
  assert.equal(result.entries[0].code, 'DIFF_TEXT_MISMATCH');
  assert.equal(result.entries[0].attempts, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.explanation.category, 'diff');
});

// ---------------------------------------------------------------------------
// runReplayPlan：重试 / 超时 / 取消 / skip
// ---------------------------------------------------------------------------

test('runReplayPlan：可重试失败按 fallback 重试，第二次成功 → attempts=2 且只记一次副作用', async () => {
  const plan = networkPlan('POST');
  plan.steps[0].fallback = { onError: 'retry', retries: 2, retryDelayMs: 250 };
  let calls = 0;
  const sleeps = [];
  const result = await E.runReplayPlan(plan, {
    execute: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('timeout while replaying'), { code: 'E_TIMEOUT' });
      return { status: 201, body: 'created', url: 'https://a.test/api' };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].attempts, 2);
  assert.equal(result.effects.length, 1);
});

test('runReplayPlan：重试次数耗尽 → RETRY_EXHAUSTED 且 sideEffectAtRisk（请求可能已发出）', async () => {
  const plan = networkPlan('POST');
  plan.steps[0].fallback = { onError: 'retry', retries: 2, retryDelayMs: 1 };
  const result = await E.runReplayPlan(plan, {
    execute: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.entries[0].status, 'failed');
  assert.equal(result.sideEffectAtRisk, true);
  assert.equal(result.entries[0].attempts, 3);
  assert.equal(typeof result.explanation.code, 'string');
});

test('runReplayPlan：超时错误 → TIMEOUT + 目录解释 REPLAY_TIMEOUT', async () => {
  const plan = networkPlan('GET');
  const result = await E.runReplayPlan(plan, {
    execute: async () => { throw Object.assign(new Error('network replay 超时（15000ms）'), { code: 'E_TIMEOUT' }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.entries[0].code, E.EXECUTOR_CODES.TIMEOUT);
  assert.equal(result.explanation.code, 'REPLAY_TIMEOUT');
  assert.equal(result.explanation.retriable, true);
});

test('runReplayPlan：取消检查先于执行，取消后不再调用 execute', async () => {
  let calls = 0;
  let cancelled = false;
  const plan = recordPlan([{ method: 'click' }, { method: 'click', ref: 'r2' }]);
  const result = await E.runReplayPlan(plan, {
    execute: async () => { calls += 1; cancelled = true; return { ok: true }; },
    isCancelled: () => cancelled,
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelledAt, 1);
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.code, E.EXECUTOR_CODES.CANCELLED);
});

test('runReplayPlan：fallback skip 的失败步被跳过并继续执行后续步骤', async () => {
  const plan = recordPlan([
    { method: 'click', ref: 'r1', fallback: { onError: 'skip', retries: 0, retryDelayMs: 0 } },
    { method: 'read', kind: 'observe', ref: 'r2', idempotent: true },
  ]);
  const result = await E.runReplayPlan(plan, {
    execute: async (step) => {
      if (step.ref === 'r1') throw new Error('element detached');
      return { ok: true, text: 'hello' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.entries[0].status, 'skipped');
  assert.equal(result.entries[0].code, E.EXECUTOR_CODES.STEP_SKIPPED);
});

test('runReplayPlan：stopOnFailure=false 时失败后继续后续步骤', async () => {
  const plan = recordPlan([
    { method: 'click', ref: 'r1' },
    { method: 'read', kind: 'observe', ref: 'r2', idempotent: true },
  ]);
  const result = await E.runReplayPlan(plan, {
    execute: async (step) => {
      if (step.ref === 'r1') throw new Error('boom');
      return { ok: true };
    },
  }, { stopOnFailure: false });
  assert.equal(result.failed, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.entries.length, 2);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 边界动作执行
// ---------------------------------------------------------------------------

test('runReplayPlan：navigate 边界缺 restoreBoundary provider → fail-closed 阻断', async () => {
  const plan = networkPlan('GET');
  plan.boundaries = { plans: [{ index: 0, action: 'navigate', url: 'https://a.test/', reason: 'recorded-document-change' }] };
  const result = await E.runReplayPlan(plan, fixedProviders());
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 1);
  assert.equal(result.code, E.EXECUTOR_CODES.BOUNDARY_BLOCKED);
  assert.equal(result.entries[0].code, E.EXECUTOR_CODES.NO_BOUNDARY_EXECUTOR);
});

test('runReplayPlan：restoreBoundary 成功 → 条目记边界动作并继续执行', async () => {
  const plan = networkPlan('GET');
  plan.boundaries = { plans: [{ index: 0, action: 'navigate', url: 'https://a.test/', reason: 'recorded-document-change' }] };
  const calls = [];
  const result = await E.runReplayPlan(plan, {
    execute: async () => ({ status: 200, body: 'ok', url: 'https://a.test/' }),
    restoreBoundary: async (action) => {
      calls.push(action.action);
      return { ok: true, code: 'BOUNDARY_NAVIGATE_OK', reason: action.reason };
    },
  });
  assert.deepEqual(calls, ['navigate']);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].boundary.action, 'navigate');
  assert.equal(result.entries[0].boundary.ok, true);
});

test('runReplayPlan：restoreBoundary 返回 ok:false → 阻断并带边界证据', async () => {
  const plan = networkPlan('GET');
  plan.boundaries = { plans: [{ index: 0, action: 'frame-switch', frameId: 7, reason: 'frame-changed' }] };
  const result = await E.runReplayPlan(plan, {
    execute: async () => ({ status: 200 }),
    restoreBoundary: async () => ({ ok: false, reason: 'frame-missing', code: 'BOUNDARY_FRAME_UNAVAILABLE' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 1);
  assert.equal(result.entries[0].boundary.code, 'BOUNDARY_FRAME_UNAVAILABLE');
  assert.equal(result.entries[0].status, 'blocked');
});

test('runReplayPlan：边界计划要求 abort → 直接阻断，不调用 execute/restore', async () => {
  const plan = networkPlan('GET');
  plan.boundaries = { plans: [{ index: 0, action: 'abort', reason: 'url-missing' }] };
  let executeCalls = 0;
  let restoreCalls = 0;
  const result = await E.runReplayPlan(plan, {
    execute: async () => { executeCalls += 1; },
    restoreBoundary: async () => { restoreCalls += 1; },
  });
  assert.equal(executeCalls, 0);
  assert.equal(restoreCalls, 0);
  assert.equal(result.blocked, 1);
  assert.equal(result.entries[0].boundary.code, 'BOUNDARY_ABORT');
});

// ---------------------------------------------------------------------------
// recordExecutionOutcomes（真实命令路径记账）
// ---------------------------------------------------------------------------

test('recordExecutionOutcomes：成功结果 → passed，digest 两次一致', () => {
  const plan = networkPlan('GET');
  const first = E.recordExecutionOutcomes(plan, [{ value: { status: 200, body: 'ok', url: 'https://a.test/api' } }]);
  const second = E.recordExecutionOutcomes(plan, [{ value: { status: 200, body: 'ok', url: 'https://a.test/api' } }]);
  assert.equal(first.ok, true);
  assert.equal(first.passed, 1);
  assert.equal(first.entries[0].status, 'passed');
  assert.equal(first.digest, second.digest);
  const comparison = E.compareExecutions(first, second);
  assert.equal(comparison.deterministic, true);
});

test('recordExecutionOutcomes：错误结果 → failed + 目录解释；错误不抛', () => {
  const plan = networkPlan('POST');
  const execution = E.recordExecutionOutcomes(plan, [{ error: { code: 'E_JS_ERROR', message: 'fetch 失败：net::ERR_FAILED' } }]);
  assert.equal(execution.ok, false);
  assert.equal(execution.failed, 1);
  assert.equal(execution.entries[0].status, 'failed');
  assert.equal(execution.entries[0].error.message.includes('fetch 失败'), true);
  assert.equal(typeof execution.explanation.code, 'string');
});

test('recordExecutionOutcomes：显式 verdict 覆盖 expect 判决；未执行步骤记 planned', () => {
  const plan = recordPlan([
    { method: 'click', ref: 'r1', idempotent: true },
    { method: 'read', kind: 'observe', ref: 'r2', idempotent: true },
  ]);
  const execution = E.recordExecutionOutcomes(plan, [
    { value: { ok: true }, verdict: { ok: true, severity: 'pass', code: 'DIFF_OK', summary: { checked: 1, failed: 0, warnings: 0 } } },
  ]);
  assert.equal(execution.entries[0].status, 'passed');
  assert.equal(execution.entries[0].verdict.code, 'DIFF_OK');
  assert.equal(execution.entries[1].status, 'planned');
  assert.equal(execution.planned, 2);
});

// ---------------------------------------------------------------------------
// 比较 / 确定性验证 / 摘要
// ---------------------------------------------------------------------------

test('compareExecutions：状态不同 → 不确定，divergedAt 指向首个分叉', async () => {
  const plan = networkPlan('GET');
  const left = await E.runReplayPlan(plan, fixedProviders({ status: 200, body: 'ok', url: 'https://a.test/api' }));
  const right = await E.runReplayPlan(plan, fixedProviders({ status: 500, body: 'err', url: 'https://a.test/api' }));
  const comparison = E.compareExecutions(left, right);
  assert.equal(comparison.deterministic, false);
  assert.equal(comparison.sameStatus, true); // 两次执行都“成功完成”，但观测不同 → 语义不确定
  assert.equal(comparison.sameEntries, false);
  assert.equal(comparison.divergedAt, 0);
  assert.equal(comparison.differences.length > 0, true);
});

test('compareExecutions：条目缺失也算分叉（长度不同）', async () => {
  const plan = recordPlan([{ method: 'click', ref: 'r1' }, { method: 'click', ref: 'r2' }]);
  const left = E.recordExecutionOutcomes(plan, [{ value: { ok: true } }, { value: { ok: true } }]);
  const right = E.recordExecutionOutcomes(plan, [{ value: { ok: true } }]);
  const comparison = E.compareExecutions(left, right);
  assert.equal(comparison.deterministic, false);
  assert.equal(comparison.sameEntries, false);
});

test('comparePlanFingerprints：同输入两次构建 → same；不同输入 → 不同', () => {
  const input = [{ ref: 'r1', kind: 'action', method: 'click', params: { selector: '#a' }, target: { selector: '#a' }, idempotent: true }];
  const left = buildReplayPlan(input, { allowNonIdempotent: true });
  const right = buildReplayPlan(input, { allowNonIdempotent: true });
  assert.equal(E.comparePlanFingerprints(left, right).same, true);
  assert.equal(left.token, right.token);
  const changed = buildReplayPlan([{ ref: 'r1', kind: 'action', method: 'click', params: { selector: '#b' }, target: { selector: '#b' }, idempotent: true }], { allowNonIdempotent: true });
  assert.equal(E.comparePlanFingerprints(left, changed).same, false);
});

test('verifyDeterministicExecution：同输入两次 → 确定性通过；第二投影不同 → 判为不确定', async () => {
  const inputs = { tabId: 1, id: 7, overrides: { url: 'https://a.test/api', method: 'POST' } };
  let planCalls = 0;
  const planFactory = () => buildReplayPlan([{
    kind: 'network',
    ref: 'network:r1',
    method: 'network.replay',
    params: { method: 'POST', origin: 'https://a.test', path: '/api', url: 'https://a.test/api' },
    idempotent: false,
    fallback: { onError: 'stop' },
  }], { allowNonIdempotent: true, source: 'network.replay' });
  const providers = () => ({ execute: async () => ({ status: 200, body: 'ok', url: inputs.overrides.url }) });
  const stable = await E.verifyDeterministicExecution(planFactory, providers);
  assert.equal(stable.ok, true);
  assert.equal(stable.plan.same, true);
  assert.equal(stable.comparison.deterministic, true);
  assert.equal(stable.first.ok, true);
  assert.equal(typeof stable.digest, 'string');
  assert.equal(planCalls, 0);

  let run = 0;
  const flaky = await E.verifyDeterministicExecution(planFactory, () => ({
    execute: async () => {
      run += 1;
      return run === 1
        ? { status: 200, body: 'ok', url: 'https://a.test/api' }
        : { status: 503, body: 'busy', url: 'https://a.test/api' };
    },
  }));
  assert.equal(flaky.ok, false);
  assert.equal(flaky.comparison.deterministic, false);
  assert.equal(flaky.comparison.divergedAt, 0);
});

test('executionFingerprint / summarizeExecution / formatExecutionSummary 有界稳定', async () => {
  const execution = await E.runReplayPlan(networkPlan('GET'), fixedProviders());
  assert.equal(E.executionFingerprint(execution), execution.digest);
  assert.equal(E.executionFingerprint(null), '');
  const summary = E.summarizeExecution(execution);
  assert.equal(summary.ok, true);
  assert.equal(summary.version, 2);
  assert.equal(summary.envelopeFingerprint, execution.envelope.fingerprint);
  assert.equal(summary.entries.length, 1);
  const text = E.formatExecutionSummary(execution);
  assert.equal(text.includes('回放执行 成功'), true);
  assert.equal(text.split('\n').length <= 20, true);
  assert.equal(E.formatExecutionSummary(null), '回放执行：无结果');
});

test('explainExecutionResult：成功返回 null；失败带目录码 + 执行证据', async () => {
  const ok = await E.runReplayPlan(networkPlan('GET'), fixedProviders());
  assert.equal(E.explainExecutionResult(ok), null);
  const failed = await E.runReplayPlan(networkPlan('GET'), {
    execute: async () => { throw Object.assign(new Error('network replay 超时'), { code: 'E_TIMEOUT' }); },
  });
  const explanation = E.explainExecutionResult(failed);
  assert.equal(explanation.code, 'REPLAY_TIMEOUT');
  assert.equal(explanation.execution.sideEffectAtRisk, false);
  assert.equal(explanation.execution.stoppedAt, 0);
});

test('执行器源码确定性门禁：不含 Date.now / Math.random / 动态 import', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension/src/lib/replay-executor.js'), 'utf8');
  assert.equal(/Date\.now\s*\(/.test(source), false);
  assert.equal(/Math\.random\s*\(/.test(source), false);
  assert.equal(/await import\s*\(/.test(source), false);
  assert.equal(/import\s*\(\s*'/.test(source), false);
});

test('runReplayPlan：超过 maxSteps 的计划被截断并标记 truncated', async () => {
  const steps = [];
  for (let index = 0; index < 12; index += 1) steps.push({ method: 'read', kind: 'observe', ref: 'r' + index, idempotent: true });
  const plan = recordPlan(steps);
  const result = await E.runReplayPlan(plan, { execute: async () => ({ ok: true }) }, { limits: { maxSteps: 5 } });
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 5);
  assert.equal(result.ok, true);
});
