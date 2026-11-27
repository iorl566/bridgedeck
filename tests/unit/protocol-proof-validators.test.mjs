// tests/unit/protocol-proof-validators.test.mjs —— 派生校验器（derived validators）测试。
//
// 目标不是“再抄一遍实现”，而是证明校验器**真的会失败**：
//   1) 夹具层：注入错误证据夹具时，validatePreconditionFixtures /
//      validatePostconditionFixtures 必须报出具体码；
//   2) 结构层：注入篡改的义务/义务表时，validateObligation /
//      validateObligationTable 必须报出 id 与原因；
//   3) 行为层：validateEngineBehavior 对真实 165 方法零问题，对未知方法报错；
//   4) auditObligations / obligationSnapshot 汇总通过，且全部数据可 JSON 序列化。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METHOD_NAMES,
  PROOF_POSTCONDITIONS,
  PROOF_PRECONDITIONS,
  PROOF_EFFECT_STATES,
  proofOf,
} from '../../lib/method-catalog.mjs';
import { isIdempotent, isReplayable, effectStateOf, checkPrecondition, verifyPostcondition } from '../../lib/method-state-machine.mjs';
import {
  METHOD_OBLIGATIONS,
  OBLIGATION_DIMENSIONS,
  POSTCONDITION_CONTRADICTION,
  POSTCONDITION_EVIDENCE,
  PRECONDITION_SATISFIED_CONTEXT,
  PRECONDITION_VIOLATED_CONTEXT,
  PROOF_ABI,
  auditObligations,
  buildObligationsFor,
  expectedObligationIds,
  obligationsFor,
  obligationSnapshot,
  validateEngineBehavior,
  validateObligation,
  validateObligationTable,
  validatePostconditionFixtures,
  validatePreconditionFixtures,
} from '../../lib/protocol-proof.mjs';

const ALL_METHODS = [...METHOD_NAMES];
const PRE_CODES = Object.keys(PROOF_PRECONDITIONS);
const POST_CODES = Object.keys(PROOF_POSTCONDITIONS);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scopes(issues) {
  return [...new Set(issues.map((item) => item.scope))].sort();
}

function cloneTable() {
  const table = {};
  for (const method of ALL_METHODS) table[method] = clone(obligationsFor(method));
  return table;
}

// ---------------------------------------------------------------------------
// 1. 汇总审计
// ---------------------------------------------------------------------------

test('auditObligations：默认全量审计零问题（夹具 + 结构 + 行为三层）', () => {
  const errors = auditObligations();
  assert.deepEqual(errors, []);
  assert.ok(Object.isFrozen(errors));
  assert.deepEqual(auditObligations(['click', 'observe', 'video.start', 'status']), []);
});

test('obligationSnapshot：形状、计数、夹具覆盖与 ok 标记', () => {
  const snapshot = obligationSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.methods, 165);
  assert.equal(snapshot.obligations.methods, 165);
  assert.equal(snapshot.obligations.obligations, ALL_METHODS.reduce((sum, method) => sum + obligationsFor(method).length, 0));
  assert.equal(snapshot.fixtures.preSatisfied, PRE_CODES.length);
  assert.equal(snapshot.fixtures.preViolated, PRE_CODES.length);
  assert.equal(snapshot.fixtures.postSatisfied, POST_CODES.length);
  assert.ok(snapshot.fixtures.postContradiction > 20);
  assert.equal(snapshot.risks.counts.safe + snapshot.risks.counts.guarded + snapshot.risks.counts.risky, 165);
  assert.equal(snapshot.features.length, 15);
  assert.deepEqual([...snapshot.dimensions], [...OBLIGATION_DIMENSIONS]);
  assert.deepEqual([...snapshot.stages], ['preflight', 'settle', 'replay', 'recovery']);
  assert.deepEqual(snapshot.auditErrors, []);
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.equal(wire.methods, 165);
  assert.deepEqual(wire.auditErrors, []);
});

test('PROOF_ABI 暴露维度/种类/阶段/verdict 常量', () => {
  assert.deepEqual([...PROOF_ABI.dimensions], [...OBLIGATION_DIMENSIONS]);
  assert.equal(PROOF_ABI.kinds.length, 6);
  assert.equal(PROOF_ABI.stages.length, 4);
  assert.equal(PROOF_ABI.verdicts.length, 5);
  assert.ok(Object.isFrozen(PROOF_ABI));
});

test('夹具常量冻结且覆盖全部登记的前置/后置码', () => {
  for (const code of PRE_CODES) {
    assert.ok(PRECONDITION_SATISFIED_CONTEXT[code], code + ' 缺满足夹具');
    assert.ok(PRECONDITION_VIOLATED_CONTEXT[code], code + ' 缺反证夹具');
  }
  for (const code of POST_CODES) {
    assert.ok(POSTCONDITION_EVIDENCE[code] !== undefined, code + ' 缺满足夹具');
  }
  assert.ok(Object.isFrozen(PRECONDITION_SATISFIED_CONTEXT));
  assert.ok(Object.isFrozen(PRECONDITION_VIOLATED_CONTEXT));
  assert.ok(Object.isFrozen(POSTCONDITION_EVIDENCE));
  assert.ok(Object.isFrozen(POSTCONDITION_CONTRADICTION));
});

// ---------------------------------------------------------------------------
// 2. 夹具层校验器（注入负例）
// ---------------------------------------------------------------------------

test('validatePreconditionFixtures：默认零问题', () => {
  assert.deepEqual(validatePreconditionFixtures(), []);
});

test('validatePreconditionFixtures 负例：缺少夹具 / 夹具判错 / 多出未登记码', () => {
  const missing = { ...PRECONDITION_SATISFIED_CONTEXT };
  delete missing['session.active'];
  const missingIssues = validatePreconditionFixtures({ satisfied: missing });
  assert.ok(missingIssues.some((item) => item.scope === 'fixture.pre.satisfied' && item.code === 'session.active'));
  assert.match(missingIssues.find((item) => item.code === 'session.active').message, /缺少满足夹具/);

  const wrongSatisfied = { ...PRECONDITION_SATISFIED_CONTEXT, 'session.active': { sessionActive: false } };
  const wrongIssues = validatePreconditionFixtures({ satisfied: wrongSatisfied });
  const wrong = wrongIssues.find((item) => item.code === 'session.active' && item.scope === 'fixture.pre.satisfied');
  assert.ok(wrong);
  assert.equal(wrong.actual, 'violated');

  const wrongViolated = { ...PRECONDITION_VIOLATED_CONTEXT, 'tab.bound': { tabId: 5 } };
  const violatedIssues = validatePreconditionFixtures({ violated: wrongViolated });
  const badViolated = violatedIssues.find((item) => item.code === 'tab.bound' && item.scope === 'fixture.pre.violated');
  assert.ok(badViolated);
  assert.equal(badViolated.actual, 'satisfied');

  const extra = { ...PRECONDITION_SATISFIED_CONTEXT, 'not.a.real.pre': {} };
  const extraIssues = validatePreconditionFixtures({ satisfied: extra });
  assert.ok(extraIssues.some((item) => item.scope === 'fixture.pre.extra' && item.code === 'not.a.real.pre'));
});

test('validatePreconditionFixtures：夹具判据与状态机逐码一致（派生而非手写）', () => {
  for (const code of PRE_CODES) {
    assert.equal(checkPrecondition(code, PRECONDITION_SATISFIED_CONTEXT[code]).state, 'satisfied', code);
    assert.equal(checkPrecondition(code, PRECONDITION_VIOLATED_CONTEXT[code]).state, 'violated', code);
  }
});

test('validatePostconditionFixtures：默认零问题', () => {
  assert.deepEqual(validatePostconditionFixtures(), []);
});

test('validatePostconditionFixtures 负例：缺满足夹具 / 满足夹具判错 / 矛盾夹具判错', () => {
  const missing = { ...POSTCONDITION_EVIDENCE };
  delete missing['artifact.created'];
  const missingIssues = validatePostconditionFixtures({ satisfied: missing });
  assert.ok(missingIssues.some((item) => item.scope === 'fixture.post.satisfied' && item.code === 'artifact.created'));

  const wrong = { ...POSTCONDITION_EVIDENCE, 'tab.created': { created: false } };
  const wrongIssues = validatePostconditionFixtures({ satisfied: wrong });
  const wrongEntry = wrongIssues.find((item) => item.scope === 'fixture.post.satisfied' && item.code === 'tab.created');
  assert.ok(wrongEntry);
  assert.equal(wrongEntry.actual, 'violated');

  const weakContradiction = { ...POSTCONDITION_CONTRADICTION, 'page.mutated': { changed: 'maybe' } };
  // changed:'maybe' 是非空值 ⇒ 被判 satisfied，不能算反证
  const contradictionIssues = validatePostconditionFixtures({ contradiction: weakContradiction });
  assert.ok(contradictionIssues.some((item) => item.scope === 'fixture.post.contradiction' && item.code === 'page.mutated'));

  const extra = { ...POSTCONDITION_EVIDENCE, 'not.a.real.post': { ok: true } };
  const extraIssues = validatePostconditionFixtures({ satisfied: extra });
  assert.ok(extraIssues.some((item) => item.scope === 'fixture.post.extra' && item.code === 'not.a.real.post'));
});

// ---------------------------------------------------------------------------
// 3. 结构层校验器：单条义务
// ---------------------------------------------------------------------------

test('validateObligation：表内每条义务都自洽（165 方法全量）', () => {
  for (const method of ALL_METHODS) {
    for (const obligation of obligationsFor(method)) {
      assert.deepEqual(validateObligation(obligation), [], obligation.id);
    }
  }
  assert.ok(validateObligation(null).length > 0);
  assert.ok(validateObligation(42).length > 0);
});

test('validateObligation 负例：维度/种类/阶段/说明/blocking 非法', () => {
  const base = clone(obligationsFor('click').find((item) => item.dimension === 'pre'));
  const badDimension = validateObligation({ ...base, dimension: 'bogus' });
  assert.ok(badDimension.some((item) => item.scope === 'obligation.dimension'));
  const badKind = validateObligation({ ...base, kind: 'bogus' });
  assert.ok(badKind.some((item) => item.scope === 'obligation.kind'));
  const badStage = validateObligation({ ...base, stage: 'bogus' });
  assert.ok(badStage.some((item) => item.scope === 'obligation.stage'));
  const badRequirement = validateObligation({ ...base, requirement: '   ' });
  assert.ok(badRequirement.some((item) => item.scope === 'obligation.requirement'));
  const badBlocking = validateObligation({ ...base, blocking: 'yes' });
  assert.ok(badBlocking.some((item) => item.scope === 'obligation.blocking'));
  const badMethod = validateObligation({ ...base, method: 'no.such.method' });
  assert.ok(badMethod.some((item) => item.scope === 'obligation.method'));
});

test('validateObligation 负例：code/value 与目录不一致', () => {
  const pre = clone(obligationsFor('click').find((item) => item.kind === 'precondition'));
  pre.code = 'not.a.pre';
  assert.ok(validateObligation(pre).some((item) => item.scope === 'obligation.code'));

  const post = clone(obligationsFor('click').find((item) => item.kind === 'postcondition'));
  post.code = 'not.a.post';
  assert.ok(validateObligation(post).some((item) => item.scope === 'obligation.code'));

  const effect = clone(obligationsFor('click').find((item) => item.kind === 'effect-state'));
  effect.code = 'bogus-state';
  assert.ok(validateObligation(effect).some((item) => item.scope === 'obligation.code'));
  const effectValue = clone(obligationsFor('click').find((item) => item.kind === 'effect-state'));
  effectValue.value = 'bogus-state';
  assert.ok(validateObligation(effectValue).some((item) => item.scope === 'obligation.value'));

  const idem = clone(obligationsFor('click').find((item) => item.kind === 'idempotency'));
  idem.value = !idem.value;
  assert.ok(validateObligation(idem).some((item) => item.scope === 'obligation.value'));

  const replay = clone(obligationsFor('click').find((item) => item.kind === 'replayability'));
  replay.value = !replay.value;
  assert.ok(validateObligation(replay).some((item) => item.scope === 'obligation.value'));

  const recovery = clone(obligationsFor('click').find((item) => item.kind === 'recovery'));
  recovery.codes = [];
  assert.ok(validateObligation(recovery).some((item) => item.scope === 'obligation.codes'));

  const badRecoveryCode = clone(obligationsFor('click').find((item) => item.kind === 'recovery'));
  badRecoveryCode.codes = ['E_NOT_REGISTERED'];
  assert.ok(validateObligation(badRecoveryCode).some((item) => item.scope === 'obligation.codes'));
});

// ---------------------------------------------------------------------------
// 4. 结构层校验器：义务表
// ---------------------------------------------------------------------------

test('expectedObligationIds：独立推导序列与义务表逐方法一致', () => {
  for (const method of ALL_METHODS) {
    const expected = expectedObligationIds(method);
    const actual = obligationsFor(method).map((item) => item.id);
    assert.deepEqual(actual, [...expected], method);
    const proof = proofOf(method);
    assert.equal(expected.length, proof.pre.length + proof.post.length + 4);
    assert.equal(expected[0], 'pre:' + proof.pre[0]);
    assert.equal(expected[expected.length - 1], 'recovery');
  }
  assert.deepEqual(expectedObligationIds('no.such.method'), []);
});

test('validateObligationTable：默认零问题、冻结与目录同步', () => {
  assert.deepEqual(validateObligationTable(), []);
  assert.ok(Object.isFrozen(METHOD_OBLIGATIONS));
});

test('validateObligationTable 负例：缺方法 / 多方法 / id 篡改 / 重复 / 维度缺失 / blocking 篡改', () => {
  const missing = cloneTable();
  delete missing.click;
  const missingIssues = validateObligationTable(missing);
  assert.ok(missingIssues.some((item) => item.scope === 'table.missing' && item.code === 'click'));
  assert.ok(missingIssues.some((item) => item.scope === 'table.size'));

  const extra = cloneTable();
  extra['no.such.method'] = clone(obligationsFor('click'));
  const extraIssues = validateObligationTable(extra);
  assert.ok(extraIssues.some((item) => item.scope === 'table.extra' && item.code === 'no.such.method'));

  const badId = cloneTable();
  badId.click[0].id = 'pre:wrong';
  assert.ok(validateObligationTable(badId).some((item) => item.scope === 'table.ids' && item.code === 'click'));

  const duplicate = cloneTable();
  duplicate.click[1].id = duplicate.click[0].id;
  assert.ok(validateObligationTable(duplicate).some((item) => item.scope === 'table.dup' && item.code === 'click'));

  const missingDimension = cloneTable();
  missingDimension.click = missingDimension.click.filter((item) => item.dimension !== 'recovery');
  assert.ok(validateObligationTable(missingDimension).some((item) => item.scope === 'table.dimension' && item.code === 'click'));

  const badBlocking = cloneTable();
  badBlocking.click.find((item) => item.dimension === 'pre').blocking = false;
  assert.ok(validateObligationTable(badBlocking).some((item) => item.scope === 'table.blocking' && item.code === 'click'));

  const noReplayBlocking = cloneTable();
  noReplayBlocking.click.find((item) => item.kind === 'replayability').blocking = false;
  assert.ok(validateObligationTable(noReplayBlocking).some((item) => item.scope === 'table.blocking' && item.code === 'click'));
});

// ---------------------------------------------------------------------------
// 5. 行为层校验器
// ---------------------------------------------------------------------------

test('validateEngineBehavior：真实 165 方法零问题', () => {
  const issues = validateEngineBehavior();
  assert.deepEqual(issues, []);
  assert.deepEqual(validateEngineBehavior(['click', 'observe', 'video.start']), []);
});

test('validateEngineBehavior：未知方法会被报出（负例注入）', () => {
  const issues = validateEngineBehavior(['no.such.method']);
  assert.ok(issues.some((item) => item.scope === 'behavior.method' && item.code === 'no.such.method'));
});

test('义务值与状态机快照逐项同源（pre/post/effectState/idempotent/replayable/recovery）', () => {
  for (const method of ALL_METHODS) {
    const proof = proofOf(method);
    const list = obligationsFor(method);
    const pre = list.filter((item) => item.dimension === 'pre').map((item) => item.code);
    const post = list.filter((item) => item.dimension === 'post').map((item) => item.code);
    assert.deepEqual(pre, [...proof.pre], method + ' 前置码漂移');
    assert.deepEqual(post, [...proof.post], method + ' 后置码漂移');
    assert.equal(list.find((item) => item.dimension === 'effectState').value, effectStateOf(method));
    assert.equal(list.find((item) => item.dimension === 'idempotent').value, isIdempotent(method));
    assert.equal(list.find((item) => item.dimension === 'replayable').value, isReplayable(method));
    assert.deepEqual([...list.find((item) => item.dimension === 'recovery').codes], [...proof.recovery]);
  }
});

test('派生校验器与构建器互证：重新构建的 165 行全部通过结构校验', () => {
  for (const method of ALL_METHODS) {
    const rebuilt = buildObligationsFor(method);
    for (const obligation of rebuilt) assert.deepEqual(validateObligation(obligation), [], method + ':' + obligation.id);
  }
  const rebuiltTable = {};
  for (const method of ALL_METHODS) rebuiltTable[method] = clone(buildObligationsFor(method));
  assert.deepEqual(validateObligationTable(rebuiltTable), []);
});

test('校验器输出可 JSON 序列化（错误可进错误帧/日志）', () => {
  const issues = [
    ...validateObligation({ ...clone(obligationsFor('click')[0]), dimension: 'bogus' }),
    ...validatePreconditionFixtures({ satisfied: { ...PRECONDITION_SATISFIED_CONTEXT, 'session.active': {} } }),
  ];
  assert.ok(issues.length > 0);
  for (const item of issues) {
    const wire = JSON.parse(JSON.stringify(item));
    assert.equal(typeof wire.scope, 'string');
    assert.equal(typeof wire.code, 'string');
    assert.equal(typeof wire.message, 'string');
    assert.ok(Object.prototype.hasOwnProperty.call(wire, 'expected'));
    assert.ok(Object.prototype.hasOwnProperty.call(wire, 'actual'));
  }
});

test('post 证据夹具与 verifyPostcondition 同源：34 个后置码逐项 satisfied', () => {
  for (const code of POST_CODES) {
    assert.equal(verifyPostcondition(code, POSTCONDITION_EVIDENCE[code]).state, 'satisfied', code);
  }
  const effectStates = new Set(ALL_METHODS.map((method) => proofOf(method).effectState));
  for (const state of effectStates) assert.ok(Object.prototype.hasOwnProperty.call(PROOF_EFFECT_STATES, state));
  assert.ok(scopes([]).length === 0);
});
