// tests/unit/state-preconditions.test.mjs —— 前置/后置条件判定器的运行时单测。
//
// 覆盖目标：
//   1. 21 个前置条件码各有 satisfied/violated/unknown 三态判定，未知码安全；
//   2. 165 个方法在“全满足上下文”下都能 proven；缺证据时是 unknown 而不是 violated；
//   3. 34 个后置条件码都有显式判定，未知码不冒充“已登记”；
//   4. verifyPostconditions / proofObligations 在真实 RPC 结果形态下给出诚实结论
//      （RPC 证明不了的语义性后置条件必须 unverifiable）；
//   5. 入参不合法/上下文畸形时不抛错（纯函数、可被 CLI/MCP 直接调用）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECK_STATES,
  EFFECT_STATES,
  PRECONDITIONS,
  POSTCONDITIONS,
  PROOF_DIMENSIONS,
  VERIFY_STATES,
  checkPrecondition,
  checkPreconditions,
  describeEffectState,
  effectStateOf,
  effectStateSummary,
  listMethodProofs,
  normalizeContext,
  proofObligations,
  verifyPostcondition,
  verifyPostconditions,
} from '../../lib/method-state-machine.mjs';
import { METHOD_NAMES, METHOD_PROOF } from '../../lib/method-catalog.mjs';

/**
 * 满足所有前置条件的“理想上下文”：每个事实都给 true/具体值。
 * 用途：证明 165 个方法用到的每个前置码都有可满足语义（不是永远 unknown 的死码）。
 */
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

const PRE_CASES = Object.freeze({
  'daemon.local': { satisfied: {}, violated: { daemon: false }, unknown: null },
  'instance.connected': { satisfied: { instanceConnected: true }, violated: { instanceConnected: false }, unknown: {} },
  'browser.ready': { satisfied: { browserReady: true }, violated: { browserReady: false } },
  'session.active': { satisfied: { session: { active: true } }, violated: { session: { active: false } }, unknown: {} },
  'session.unpaused': { satisfied: { session: { paused: false } }, violated: { session: { paused: true } } },
  'tab.bound': { satisfied: { tabId: 3 }, violated: { tabId: null }, unknown: {} },
  'tab.controlled': { satisfied: { controlHeld: true }, violated: { controlHeld: false } },
  'target.resolved': { satisfied: { params: { ref: '@e1' } }, violated: { target: false }, unknown: {} },
  'observation.fresh': { satisfied: { observationFresh: true }, violated: { observationFresh: false } },
  'recording.active': { satisfied: { recording: true }, violated: { recording: false } },
  'debugger.idle': { satisfied: { debuggerIdle: true }, violated: { debuggerIdle: false } },
  'dialog.pending': { satisfied: { dialogPending: true }, violated: { dialogPending: false } },
  'transfer.open': { satisfied: { transferOpen: true }, violated: { transferOpen: false } },
  'network.capturing': { satisfied: { networkCapturing: true }, violated: { networkCapturing: false } },
  'trace.active': { satisfied: { traceActive: true }, violated: { traceActive: false } },
  'plan.approved': { satisfied: { planApproved: true }, violated: { planApproved: false } },
  'pair.available': { satisfied: { pairAvailable: true }, violated: { pairAvailable: false } },
  'artifact.present': { satisfied: { artifactPresent: true }, violated: { artifactPresent: false } },
  'cooperation.aligned': { satisfied: { cooperationAligned: true }, violated: { cooperationAligned: false } },
  'ui.attached': { satisfied: { uiAttached: true }, violated: { uiAttached: false } },
  'transport.local': { satisfied: { transportLocal: true }, violated: { remote: true } },
});

// ---------------------------------------------------------------------------
// 常量与登记
// ---------------------------------------------------------------------------

test('判定三态常量：前置 satisfied/violated/unknown，后置多一个 unverifiable', () => {
  assert.deepEqual([...CHECK_STATES], ['satisfied', 'violated', 'unknown']);
  assert.deepEqual([...VERIFY_STATES], ['satisfied', 'violated', 'unverifiable']);
  assert.deepEqual([...PROOF_DIMENSIONS], ['pre', 'post', 'effectState', 'idempotent', 'replayable', 'recovery']);
  assert.equal(Object.keys(PRECONDITIONS).length, 21);
  assert.equal(Object.keys(POSTCONDITIONS).length, 34);
});

test('每个登记的前置码都有显式判定器（不会落到“未登记”分支）', () => {
  for (const code of Object.keys(PRECONDITIONS)) {
    const result = checkPrecondition(code, {});
    assert.notEqual(result.reason, '未登记的前置条件码', code + ' 缺少判定器');
    assert.ok(CHECK_STATES.includes(result.state), code + ' 状态非法：' + result.state);
    assert.equal(result.code, code);
    assert.ok(result.label.length >= 2);
    assert.ok(Object.isFrozen(result));
  }
  const unknown = checkPrecondition('ghost.precondition', {});
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.reason, /未登记/);
});

test('每个登记的后置码都有显式判定器（不会落到“未登记”分支）', () => {
  for (const code of Object.keys(POSTCONDITIONS)) {
    const result = verifyPostcondition(code, {});
    assert.notEqual(result.reason, '未登记的后置条件码', code + ' 缺少判定器');
    assert.ok(VERIFY_STATES.includes(result.state), code + ' 状态非法：' + result.state);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'label', 'reason', 'state']);
  }
  const unknown = verifyPostcondition('ghost.postcondition', { handled: true });
  assert.equal(unknown.state, 'unverifiable');
  assert.match(unknown.reason, /未登记/);
});

// ---------------------------------------------------------------------------
// 前置条件三态
// ---------------------------------------------------------------------------

test('21 个前置码：satisfied / violated / unknown 三态逐项成立', () => {
  let checked = 0;
  for (const [code, cases] of Object.entries(PRE_CASES)) {
    assert.ok(PRECONDITIONS[code], code + ' 不在登记表');
    if (cases.satisfied) {
      assert.equal(checkPrecondition(code, cases.satisfied).state, 'satisfied', code + ' satisfied 判定错误');
      checked += 1;
    }
    if (cases.violated) {
      assert.equal(checkPrecondition(code, cases.violated).state, 'violated', code + ' violated 判定错误：' + JSON.stringify(cases.violated));
      checked += 1;
    }
    if (cases.unknown === null) continue;
    const unknown = checkPrecondition(code, cases.unknown || {});
    assert.equal(unknown.state, 'unknown', code + ' unknown 判定错误：' + JSON.stringify(cases.unknown || {}));
    checked += 1;
  }
  const expectedChecks = Object.values(PRE_CASES).reduce((sum, cases) => sum
    + 1 + (cases.violated ? 1 : 0) + (cases.unknown === null ? 0 : 1), 0);
  assert.equal(checked, expectedChecks);
  assert.equal(checked, Object.keys(PRE_CASES).length * 3 - 1, 'daemon.local 按构造恒满足，没有 unknown 用例');
  assert.deepEqual(Object.keys(PRE_CASES).sort(), Object.keys(PRECONDITIONS).sort());
});

test('normalizeContext：领域对象与直接事实两种形态等价', () => {
  const fromObjects = normalizeContext({
    session: { active: true, paused: false, tabId: 5 },
    instance: { id: 'i1' },
    params: { ref: '@e2' },
    control: { held: false },
    transfer: { open: true },
    cooperation: { aligned: true },
    ui: { attached: true },
    artifact: { path: '/tmp/a' },
    remote: false,
  });
  assert.equal(fromObjects.sessionActive, true);
  assert.equal(fromObjects.sessionUnpaused, true);
  assert.equal(fromObjects.tabBound, true);
  assert.equal(fromObjects.instanceConnected, true);
  assert.deepEqual({ ...fromObjects.target }, { ref: '@e2' });
  assert.equal(fromObjects.controlHeld, false);
  assert.equal(fromObjects.transferOpen, true);
  assert.equal(fromObjects.cooperationAligned, true);
  assert.equal(fromObjects.uiAttached, true);
  assert.equal(fromObjects.artifactPresent, true);
  assert.equal(fromObjects.transportLocal, true);

  const direct = normalizeContext({ sessionActive: true, tabId: 5, target: { selector: '#x' }, controlHeld: true });
  assert.equal(direct.sessionActive, true);
  assert.equal(direct.tabBound, true);
  assert.equal(hasTargetLike(direct.target), true);
  assert.equal(direct.controlHeld, true);
  assert.ok(Object.isFrozen(direct));
});

function hasTargetLike(value) {
  return Boolean(value && typeof value === 'object' && (value.ref != null || value.selector != null));
}

test('normalizeContext：畸形输入不抛错，事实保持 undefined（unknown）', () => {
  for (const context of [undefined, null, 0, '', [], 'abc', { session: 'x' }, { params: null }, { session: { tabId: undefined } }]) {
    assert.doesNotThrow(() => normalizeContext(context));
    const facts = normalizeContext(context);
    assert.equal(typeof facts, 'object');
    for (const value of Object.values(facts)) assert.ok(value === undefined || typeof value === 'boolean' || typeof value === 'object');
  }
});

// ---------------------------------------------------------------------------
// checkPreconditions
// ---------------------------------------------------------------------------

test('checkPreconditions：理想上下文下 165 个方法全部 proven', () => {
  for (const method of METHOD_NAMES) {
    const result = checkPreconditions(method, FULL_CONTEXT);
    assert.equal(result.known, true, method);
    assert.deepEqual(result.violations, [], method + ' 理想上下文不应有违反：' + result.violations.join(','));
    assert.deepEqual(result.unknowns, [], method + ' 理想上下文不应有未知：' + result.unknowns.join(','));
    assert.equal(result.proven, true, method);
    assert.equal(result.ok, true, method);
    assert.equal(result.checks.length, METHOD_PROOF[method].pre.length, method);
    for (const check of result.checks) assert.equal(check.state, 'satisfied', method + ' ' + check.code);
  }
});

test('checkPreconditions：缺证据是 unknown（ok=true）而不是 violated', () => {
  const click = checkPreconditions('click', {});
  assert.equal(click.known, true);
  assert.equal(click.ok, true, '没有反证不应阻断');
  assert.equal(click.proven, false);
  assert.deepEqual(click.violations, []);
  assert.deepEqual([...click.unknowns].sort(), [...METHOD_PROOF.click.pre].sort());
  for (const check of click.checks) assert.equal(check.state, 'unknown', check.code);
});

test('checkPreconditions：有反证时 violated 且 ok=false', () => {
  const noSession = checkPreconditions('click', { session: { active: false }, tabId: 7, params: { ref: '@e1' }, observationFresh: true });
  assert.equal(noSession.ok, false);
  assert.deepEqual(noSession.violations, ['session.active']);
  assert.equal(noSession.checks.find((item) => item.code === 'session.active').state, 'violated');

  const noTarget = checkPreconditions('click', { session: { active: true, paused: false, tabId: 7 }, observationFresh: true, target: false });
  assert.equal(noTarget.ok, false);
  assert.deepEqual(noTarget.violations, ['target.resolved']);

  const paused = checkPreconditions('plan', { session: { active: true, paused: true } });
  assert.equal(paused.ok, false);
  assert.ok(paused.violations.includes('session.unpaused'));

  const remote = checkPreconditions('transfer.begin', { transportLocal: false, transferOpen: true });
  assert.equal(remote.ok, false);
  assert.ok(remote.violations.includes('transport.local'));
});

test('checkPreconditions：未知方法返回 known=false / ok=false 的安全结构', () => {
  const result = checkPreconditions('no.such.method', FULL_CONTEXT);
  assert.equal(result.known, false);
  assert.equal(result.ok, false);
  assert.equal(result.proven, false);
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.pre, []);
});

test('checkPreconditions：每个前置码都能被某个方法真实使用（无死码）', () => {
  const used = new Set();
  for (const method of METHOD_NAMES) for (const code of METHOD_PROOF[method].pre) used.add(code);
  assert.deepEqual([...used].sort(), Object.keys(PRECONDITIONS).sort(), '存在只登记不使用的前置码');
});

// ---------------------------------------------------------------------------
// 后置条件核验
// ---------------------------------------------------------------------------

test('verifyPostcondition：结构性后置条件能从真实 RPC 结果证明', () => {
  const cases = [
    ['result.returned', { ok: true }, 'satisfied'],
    ['result.returned', undefined, 'unverifiable'],
    ['read.available', { items: [] }, 'satisfied'],
    ['read.available', [1, 2], 'satisfied'],
    ['read.available', {}, 'unverifiable'],
    ['tab.created', { tabId: 9 }, 'satisfied'],
    ['tab.created', { created: false }, 'violated'],
    ['tab.removed', { removed: true }, 'satisfied'],
    ['tab.removed', { removed: false }, 'violated'],
    ['session.created', { sessionId: 's1' }, 'satisfied'],
    ['session.removed', { stopped: true }, 'satisfied'],
    ['window.created', { windowId: 3 }, 'satisfied'],
    ['artifact.created', { path: '/tmp/a.png' }, 'satisfied'],
    ['artifact.created', { saved: false }, 'violated'],
    ['artifact.removed', { pruned: true }, 'satisfied'],
    ['capture.available', { dataUrl: 'data:image/png;base64,AA' }, 'satisfied'],
    ['capture.available', { bytes: 10 }, 'satisfied'],
    ['recording.active', { recording: true }, 'satisfied'],
    ['recording.inactive', { recording: false }, 'satisfied'],
    ['debugger.attached', { attached: true }, 'satisfied'],
    ['debugger.detached', { detached: true }, 'satisfied'],
    ['network.capturing', { capturing: true }, 'satisfied'],
    ['network.idle', { capturing: false }, 'satisfied'],
    ['dialog.armed', { armed: true }, 'satisfied'],
    ['dialog.resolved', { accepted: true }, 'satisfied'],
    ['ledger.committed', { committed: true }, 'satisfied'],
    ['ledger.committed', { committed: false }, 'violated'],
    ['policy.updated', { updated: true }, 'satisfied'],
  ];
  for (const [code, result, expected] of cases) {
    assert.equal(verifyPostcondition(code, result).state, expected, code + ' ' + JSON.stringify(result));
  }
});

test('verifyPostcondition：语义性后置条件保持 unverifiable（不假装成功）', () => {
  for (const code of ['page.mutated', 'navigation.committed', 'focus.updated', 'scroll.updated', 'emulation.updated', 'coordination.updated', 'transfer.updated', 'plan.updated', 'control.updated']) {
    const result = verifyPostcondition(code, { ok: true });
    assert.equal(result.state, 'unverifiable', code + ' 不应从 RPC 结果假装证明');
    assert.match(result.reason, /无法|需要/);
  }
  // 但如果结果显式带证据，语义性后置条件也能被证明。
  assert.equal(verifyPostcondition('page.mutated', { changed: true }).state, 'satisfied');
  assert.equal(verifyPostcondition('navigation.committed', { committed: true }).state, 'satisfied');
  assert.equal(verifyPostcondition('focus.updated', { focused: true }).state, 'satisfied');
  assert.equal(verifyPostcondition('scroll.updated', { scrollY: 300 }).state, 'satisfied');
  assert.equal(verifyPostcondition('emulation.updated', { emulated: true }).state, 'satisfied');
});

test('verifyPostconditions：真实方法结果下的结论诚实且 ok=无违反', () => {
  const observe = verifyPostconditions('observe', { items: [{ ref: '@e1' }], partial: true });
  assert.equal(observe.known, true);
  assert.deepEqual(observe.violated, []);
  assert.deepEqual(observe.satisfied, ['read.available']);
  assert.equal(observe.ok, true);
  assert.equal(observe.proven, true);

  const tabNew = verifyPostconditions('tab.new', { tabId: 9 });
  assert.deepEqual(tabNew.satisfied, ['tab.created']);
  assert.deepEqual(tabNew.unverifiable, ['session.updated']);
  assert.equal(tabNew.ok, true);
  assert.equal(tabNew.proven, false);

  const dialogAccept = verifyPostconditions('dialog.accept', { accepted: true });
  assert.deepEqual(dialogAccept.satisfied, ['dialog.resolved']);
  assert.equal(dialogAccept.proven, true);

  const failedEvidence = verifyPostconditions('tab.close', { removed: false });
  assert.equal(failedEvidence.ok, false, '结果与后置条件矛盾必须 violated');
  assert.ok(failedEvidence.violated.includes('tab.removed'));

  const unknownMethod = verifyPostconditions('no.such.method', { anything: true });
  assert.equal(unknownMethod.known, false);
  assert.deepEqual(unknownMethod.checks, []);
});

test('verifyPostconditions：165 个方法在空结果/全证据结果下都不抛错', () => {
  const evidence = Object.freeze({
    ok: true, tabId: 1, sessionId: 's', windowId: 1, removed: true, closed: true,
    created: true, updated: true, stopped: true, path: '/tmp/x', saved: true, artifact: 'a',
    image: 'img', dataUrl: 'data:', base64: 'AA', bytes: 1, captureId: 'c',
    recording: true, videoId: 'v', recordingId: 'r', attached: true, detached: true,
    capturing: true, started: true, armed: true, accepted: true, dismissed: true, handled: true,
    committed: true, receipt: {}, state: 'done', mode: 'shared', planId: 'p', focused: true,
    scrollX: 0, scrollY: 1, emulated: true, changed: true,
  });
  for (const method of METHOD_NAMES) {
    assert.doesNotThrow(() => verifyPostconditions(method, {}), method);
    assert.doesNotThrow(() => verifyPostconditions(method, evidence), method);
    assert.doesNotThrow(() => verifyPostconditions(method, undefined), method);
    const withEvidence = verifyPostconditions(method, evidence);
    assert.equal(withEvidence.known, true, method);
    assert.equal(withEvidence.ok, true, method + ' 全证据结果不应违背后置条件');
    assert.ok(withEvidence.satisfied.length >= 1, method + ' 全证据结果至少应证明一个后置条件');
  }
});

// ---------------------------------------------------------------------------
// effect_state 解释
// ---------------------------------------------------------------------------

test('effectStateOf / describeEffectState：20 类全部可解释，未知安全', () => {
  for (const code of Object.keys(EFFECT_STATES)) {
    const described = describeEffectState(code);
    assert.equal(described.known, true, code);
    assert.equal(described.label, EFFECT_STATES[code]);
  }
  const unknown = describeEffectState('ghost.state');
  assert.equal(unknown.known, false);
  assert.equal(unknown.label, null);
  assert.equal(effectStateOf('click'), 'page');
  assert.equal(effectStateOf('observe'), 'none');
  assert.equal(effectStateOf('video.start'), 'video');
  assert.equal(effectStateOf('dialog.accept'), 'dialog');
  assert.equal(effectStateOf('no.such.method'), null);
});

test('effectStateSummary：165 方法与六面表一致', () => {
  const summary = effectStateSummary();
  assert.equal(summary.total, 165);
  assert.equal(Object.values(summary.counts).reduce((sum, value) => sum + value, 0), 165);
  for (const [state, count] of Object.entries(summary.counts)) {
    assert.ok(EFFECT_STATES[state], state + ' 未登记');
    assert.equal(count, METHOD_NAMES.filter((method) => METHOD_PROOF[method].effectState === state).length, state);
  }
  assert.deepEqual([...summary.states], Object.keys(EFFECT_STATES));
});

// ---------------------------------------------------------------------------
// proofObligations 综合
// ---------------------------------------------------------------------------

test('proofObligations：六面 + 证据状态（前置已证 / 后置部分证 / 恢复计划）', () => {
  const obligations = proofObligations('tab.new', {
    context: { instanceConnected: true, browserReady: true, controlHeld: true },
    result: { tabId: 4 },
  });
  assert.equal(obligations.known, true);
  assert.deepEqual(Object.keys(obligations.dimensions).sort(), ['effectState', 'idempotent', 'post', 'pre', 'recovery', 'replayable']);
  assert.equal(obligations.dimensions.pre.state, 'proven');
  assert.equal(obligations.dimensions.post.state, 'partial');
  assert.equal(obligations.dimensions.effectState.value, 'tab');
  assert.equal(obligations.dimensions.idempotent, false);
  assert.equal(obligations.dimensions.replayable, false);
  assert.equal(obligations.dimensions.recovery.profile, 'tab-control');
  assert.equal(obligations.replay, null);
  assert.equal(obligations.recovery, null);
});

test('proofObligations：错误输入时同时给出重放判定与恢复计划', () => {
  const failed = proofObligations('click', { error: { code: 'E_STALE_REF' } });
  assert.equal(failed.dimensions.pre.state, 'partial');
  assert.equal(failed.dimensions.post.state, 'not-observed');
  assert.equal(failed.replay.allowed, true);
  assert.equal(failed.recovery.action, 'reobserve');
  assert.equal(failed.recovery.code, 'E_STALE_REF');

  const unknownOutcome = proofObligations('click', { error: { code: 'E_TIMEOUT' } });
  assert.equal(unknownOutcome.replay.allowed, false);
  assert.equal(unknownOutcome.replay.requiresResolve, true);
  assert.equal(unknownOutcome.recovery.requiresResolve, true);
});

test('listMethodProofs：165 条且与目录同序（判定器消费的快照结构）', () => {
  const rows = listMethodProofs();
  assert.equal(rows.length, 165);
  assert.deepEqual(rows.map((row) => row.method), METHOD_NAMES);
  for (const row of rows) {
    assert.equal(row.effectState, METHOD_PROOF[row.method].effectState);
    assert.equal(row.idempotent, METHOD_PROOF[row.method].idempotent);
    assert.deepEqual(row.pre, METHOD_PROOF[row.method].pre);
    assert.deepEqual(row.post, METHOD_PROOF[row.method].post);
  }
});

// ---------------------------------------------------------------------------
// 健壮性：任何方法 × 任何畸形输入都不抛
// ---------------------------------------------------------------------------

test('健壮性：165 方法 × 畸形上下文/结果 不抛错', () => {
  const weirdContexts = [undefined, null, 0, '', [], 'x', { session: 1 }, { params: [] }, { target: 'x' }, FULL_CONTEXT];
  const weirdResults = [undefined, null, 0, '', [], 'x', {}, { removed: 'yes' }, { tabId: 0 }, { committed: 1 }];
  for (const method of METHOD_NAMES) {
    for (const context of weirdContexts) {
      assert.doesNotThrow(() => checkPreconditions(method, context), method + '@' + JSON.stringify(context));
    }
    for (const result of weirdResults) {
      assert.doesNotThrow(() => verifyPostconditions(method, result), method + '@' + JSON.stringify(result));
      assert.doesNotThrow(() => verifyPostconditions(method, result), method);
    }
  }
});
