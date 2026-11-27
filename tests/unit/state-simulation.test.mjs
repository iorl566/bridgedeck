// tests/unit/state-simulation.test.mjs —— 调用模拟器（preflight → settle 状态机）单测。
//
// simulateCall 是“无 I/O 的 dry-run”：CLI/MCP 可以用它在真正派发前判断
// “前置条件是否本地已证伪 / 失败是否可重试 / 成功能否证明”，测试用它把 165 个方法
// 走一遍确定性路径，防止六面规则与恢复计划互相矛盾。
import test from 'node:test';
import assert from 'node:assert/strict';

import { METHOD_NAMES, METHOD_PROOF, proofOf } from '../../lib/method-catalog.mjs';
import {
  SIMULATION_OUTCOMES,
  describeMethodProof,
  recoveryPlan,
  replayDecision,
  simulateBatch,
  simulateCall,
  verifyPostconditions,
  checkPreconditions,
} from '../../lib/method-state-machine.mjs';

const FULL_CONTEXT = Object.freeze({
  daemon: true,
  instanceConnected: true,
  browserReady: true,
  session: Object.freeze({ sessionId: 's1', active: true, paused: false, tabId: 7 }),
  tabId: 7,
  controlHeld: true,
  target: Object.freeze({ ref: '@e1' }),
  observationFresh: true,
  recording: true,
  debuggerIdle: true,
  dialogPending: true,
  transferOpen: true,
  networkCapturing: true,
  traceActive: true,
  planApproved: true,
  pairAvailable: true,
  artifactPresent: true,
  cooperationAligned: true,
  uiAttached: true,
  transportLocal: true,
});

const EVIDENCE_RESULT = Object.freeze({
  ok: true, tabId: 1, sessionId: 's', windowId: 1, removed: true, closed: true,
  created: true, updated: true, stopped: true, path: '/tmp/x', saved: true, artifact: 'a',
  image: 'img', dataUrl: 'data:', base64: 'AA', bytes: 1, captureId: 'c',
  recording: true, videoId: 'v', recordingId: 'r', attached: true, detached: true,
  capturing: true, started: true, armed: true, accepted: true, dismissed: true, handled: true,
  committed: true, receipt: {}, state: 'done', mode: 'shared', planId: 'p', focused: true,
  scrollX: 0, scrollY: 1, emulated: true, changed: true,
});

// ---------------------------------------------------------------------------
// 结论枚举与基本路径
// ---------------------------------------------------------------------------

test('SIMULATION_OUTCOMES：七种确定性结论', () => {
  assert.deepEqual([...SIMULATION_OUTCOMES], [
    'blocked-precondition',
    'succeeded-verified',
    'succeeded-unverified',
    'succeeded-contradiction',
    'failed-known',
    'failed-unknown',
    'dispatched-pending',
  ]);
});

test('simulateCall：成功路径区分 verified / unverified / contradiction', () => {
  const verified = simulateCall('observe', { context: FULL_CONTEXT, result: { items: [1], partial: false } });
  assert.equal(verified.known, true);
  assert.equal(verified.outcome, 'succeeded-verified');
  assert.equal(verified.post.proven, true);
  assert.equal(verified.replay, null);
  assert.deepEqual(verified.phases.map((phase) => phase.phase), ['preflight', 'settle-success']);

  const unverified = simulateCall('tab.new', { context: FULL_CONTEXT, result: { tabId: 3 } });
  assert.equal(unverified.outcome, 'succeeded-unverified', 'session.updated 只能靠后续观察');
  assert.deepEqual(unverified.post.violated, []);
  assert.ok(unverified.post.unverifiable.includes('session.updated'));

  const contradiction = simulateCall('tab.close', { context: FULL_CONTEXT, result: { removed: false } });
  assert.equal(contradiction.outcome, 'succeeded-contradiction');
  assert.equal(contradiction.post.ok, false);
  assert.ok(contradiction.post.violated.includes('tab.removed'));
});

test('simulateCall：前置条件被证伪时在 preflight 阶段短路（不派发、不给恢复计划）', () => {
  const blocked = simulateCall('click', { context: { session: { active: false } } });
  assert.equal(blocked.outcome, 'blocked-precondition');
  assert.equal(blocked.pre.ok, false);
  assert.deepEqual(blocked.pre.violations, ['session.active']);
  assert.equal(blocked.recovery, null);
  assert.equal(blocked.replay, null);
  assert.deepEqual(blocked.phases.map((phase) => phase.phase), ['preflight']);
  assert.equal(blocked.phases[0].ok, false);
  assert.equal(blocked.effectState, 'page');
});

test('simulateCall：失败路径区分 known / unknown，并带恢复计划与重放判定', () => {
  const known = simulateCall('click', { context: FULL_CONTEXT, error: { code: 'E_STALE_REF' } });
  assert.equal(known.outcome, 'failed-known');
  assert.equal(known.recovery.action, 'reobserve');
  assert.equal(known.replay.allowed, true);
  assert.equal(known.phases[1].phase, 'settle-failure');
  assert.equal(known.phases[1].codeProvesNoEffect, true);

  const unknown = simulateCall('click', { context: FULL_CONTEXT, error: { code: 'E_TIMEOUT' } });
  assert.equal(unknown.outcome, 'failed-unknown');
  assert.equal(unknown.replay.allowed, false);
  assert.equal(unknown.recovery.requiresResolve, true);
  assert.equal(unknown.phases[1].requiresResolve, true);

  const notApplied = simulateCall('click', { context: FULL_CONTEXT, error: { code: 'E_TIMEOUT' }, effectState: 'none' });
  assert.equal(notApplied.outcome, 'failed-known', '已证明未生效的失败应归为 known');
  assert.equal(notApplied.recovery.retryAllowed, true);
});

test('simulateCall：无结果无错误 → dispatched-pending；未知方法安全', () => {
  const pending = simulateCall('click', { context: FULL_CONTEXT });
  assert.equal(pending.outcome, 'dispatched-pending');
  assert.equal(pending.post, null);
  assert.equal(pending.replay, null);
  assert.deepEqual(pending.phases.map((phase) => phase.phase), ['preflight', 'dispatch']);

  const unknown = simulateCall('no.such.method', { context: FULL_CONTEXT });
  assert.equal(unknown.known, false);
  assert.equal(unknown.outcome, 'blocked-precondition');
  assert.deepEqual(unknown.phases, []);
  assert.equal(unknown.effectState, null);
});

// ---------------------------------------------------------------------------
// 165 方法全量
// ---------------------------------------------------------------------------

test('165 方法：理想上下文 + 全证据结果 → 不出现 blocked/contradiction', () => {
  for (const method of METHOD_NAMES) {
    const simulated = simulateCall(method, { context: FULL_CONTEXT, result: EVIDENCE_RESULT });
    assert.equal(simulated.known, true, method);
    assert.equal(simulated.outcome.startsWith('succeeded-'), true, method + ' 结果异常：' + simulated.outcome);
    assert.notEqual(simulated.outcome, 'succeeded-contradiction', method + ' 全证据结果不应矛盾');
    assert.equal(simulated.pre.proven, true, method);
  }
});

test('165 方法：E_TIMEOUT 的 known/unknown 分类与 replayable 完全一致', () => {
  for (const method of METHOD_NAMES) {
    const simulated = simulateCall(method, { context: FULL_CONTEXT, error: { code: 'E_TIMEOUT' } });
    const canReplay = describeMethodProof(method).replayable;
    assert.equal(simulated.outcome, canReplay ? 'failed-known' : 'failed-unknown', method + ' 超时分类漂移');
    assert.equal(simulated.replay.allowed, canReplay, method);
    assert.equal(simulated.recovery.code, 'E_TIMEOUT');
  }
});

test('165 方法：派发前错误码（E_STALE_REF/E_NO_SESSION/E_BAD_ARG）一律 failed-known', () => {
  for (const method of METHOD_NAMES) {
    for (const code of ['E_STALE_REF', 'E_NO_SESSION', 'E_BAD_ARG']) {
      const simulated = simulateCall(method, { context: FULL_CONTEXT, error: { code } });
      assert.equal(simulated.outcome, 'failed-known', method + ' × ' + code);
      assert.equal(simulated.replay.allowed, true, method + ' × ' + code);
      assert.equal(simulated.recovery.codeProvesNoEffect, true);
    }
  }
});

test('165 方法：simulateCall 与 checkPreconditions/verifyPostconditions 结果一致', () => {
  for (const method of METHOD_NAMES) {
    const pre = checkPreconditions(method, FULL_CONTEXT);
    const post = verifyPostconditions(method, EVIDENCE_RESULT);
    const simulated = simulateCall(method, { context: FULL_CONTEXT, result: EVIDENCE_RESULT });
    assert.equal(simulated.pre.proven, pre.proven, method);
    assert.deepEqual(simulated.pre.violations, pre.violations, method);
    assert.equal(simulated.post.ok, post.ok, method);
    assert.deepEqual(simulated.post.violated, post.violated, method);
    assert.deepEqual(simulated.post.unverifiable, post.unverifiable, method);
  }
});

test('165 方法：模拟结论与 recoveryPlan/replayDecision 在失败路径上不矛盾', () => {
  for (const method of METHOD_NAMES) {
    const error = { code: 'E_DISCONNECTED' };
    const simulated = simulateCall(method, { context: FULL_CONTEXT, error });
    const plan = recoveryPlan(method, 'E_DISCONNECTED');
    const decision = replayDecision(method, { code: 'E_DISCONNECTED' });
    assert.equal(simulated.outcome, decision.allowed ? 'failed-known' : 'failed-unknown', method);
    assert.equal(simulated.recovery.action, plan.action, method);
    assert.equal(simulated.recovery.retryAllowed, plan.retryAllowed, method);
  }
});

// ---------------------------------------------------------------------------
// 批量模拟
// ---------------------------------------------------------------------------

test('simulateBatch：按结论分组，计数总和正确', () => {
  const batch = simulateBatch([
    { method: 'click', input: { context: FULL_CONTEXT, error: { code: 'E_STALE_REF' } } },
    { method: 'click', input: { context: FULL_CONTEXT, error: { code: 'E_TIMEOUT' } } },
    { method: 'observe', input: { context: FULL_CONTEXT, result: { items: [1] } } },
    { method: 'click', input: { context: { session: { active: false } } } },
    { method: 'tab.new', input: { context: FULL_CONTEXT } },
  ]);
  assert.equal(batch.total, 5);
  assert.equal(batch.results.length, 5);
  assert.equal(Object.values(batch.counts).reduce((sum, value) => sum + value, 0), 5);
  assert.equal(batch.counts['failed-known'], 1);
  assert.equal(batch.counts['failed-unknown'], 1);
  assert.equal(batch.counts['succeeded-verified'], 1);
  assert.equal(batch.counts['blocked-precondition'], 1);
  assert.equal(batch.counts['dispatched-pending'], 1);
  assert.equal(batch.blocked.length, 1);
  assert.equal(batch.unknown.length, 1);
  assert.equal(batch.retryable.length, 1, '只有 E_STALE_REF 的点击可重试');
});

test('simulateBatch：空批次与未知方法批次安全', () => {
  const empty = simulateBatch([]);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.results, []);
  for (const count of Object.values(empty.counts)) assert.equal(count, 0);

  const ghost = simulateBatch([{ method: 'no.such.method' }, { method: '' }]);
  assert.equal(ghost.total, 2);
  assert.equal(ghost.counts['blocked-precondition'], 2);
  assert.equal(ghost.blocked.length, 2);
});

test('simulateBatch：每个方法的输入独立（不共享上下文副作用）', () => {
  const calls = METHOD_NAMES.slice(0, 20).map((method) => ({ method, input: { context: FULL_CONTEXT, error: { code: 'E_BAD_ARG' } } }));
  const batch = simulateBatch(calls);
  assert.equal(batch.total, 20);
  assert.equal(batch.counts['failed-known'], 20);
  assert.equal(batch.counts['blocked-precondition'], 0);
  for (const result of batch.results) {
    assert.equal(result.recovery.code, 'E_BAD_ARG');
    assert.equal(result.recovery.severity, 'fatal');
    assert.equal(result.recovery.retryAllowed, false);
  }
});

test('模拟器纯函数：同一输入重复调用结果深度相等，且不修改输入', () => {
  const input = { context: { ...FULL_CONTEXT }, result: { tabId: 3 } };
  const snapshot = JSON.stringify(input);
  const first = simulateCall('tab.new', input);
  const second = simulateCall('tab.new', input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot, '模拟器不得修改输入');
  assert.equal(JSON.stringify(first).includes('undefined'), false);
  assert.ok(METHOD_PROOF['tab.new'].post.length >= 1 || proofOf('tab.new') === null);
});
