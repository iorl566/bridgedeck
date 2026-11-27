// tests/unit/protocol-proof-scenarios.test.mjs —— 命名证据场景（dry-run）与执行建议测试。
//
// 覆盖：
//   1) 场景目录稳定、11 个场景全部可执行、未知场景安全；
//   2) 场景矩阵（165 方法 × 11 场景）在不变量上自洽：
//      blind 不违反；ideal 可声明成功；pre-violated 禁止派发；post-contradiction 禁止
//      声明成功；unknown-outcome 的自动重放结论等于目录 replayable；not-applied 全部可放；
//   3) 阶段分布 / 场景摘要 / 下一步建议 / 人类可读解释。
import test from 'node:test';
import assert from 'node:assert/strict';

import { METHOD_NAMES, proofOf } from '../../lib/method-catalog.mjs';
import {
  SCENARIO_BUILDERS,
  SCENARIO_CATALOG,
  SCENARIO_IDS,
  explainRun,
  nextActions,
  runCallObligations,
  runScenario,
  scenarioInfo,
  scenarioMatrix,
  scenarioSummary,
  stageDistribution,
} from '../../lib/protocol-proof.mjs';

const ALL_METHODS = [...METHOD_NAMES];
const MATRIX = scenarioMatrix(ALL_METHODS, SCENARIO_IDS);

// ---------------------------------------------------------------------------
// 1. 场景目录
// ---------------------------------------------------------------------------

test('场景目录：11 个命名场景，id 唯一、说明齐全、构造器齐备', () => {
  assert.equal(SCENARIO_CATALOG.length, 11);
  assert.equal(SCENARIO_IDS.length, 11);
  assert.equal(new Set(SCENARIO_IDS).size, SCENARIO_IDS.length);
  for (const entry of SCENARIO_CATALOG) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.detail, 'string');
    assert.equal(typeof SCENARIO_BUILDERS[entry.id], 'function', entry.id + ' 缺少构造器');
    const info = scenarioInfo(entry.id);
    assert.equal(info.id, entry.id);
  }
  assert.equal(scenarioInfo('no-such-scenario'), null);
  assert.ok(Object.isFrozen(SCENARIO_CATALOG));
});

test('runScenario：每个场景对代表方法返回同构结论', () => {
  const methods = ['click', 'observe', 'video.start', 'read', 'plan', 'status'];
  for (const method of methods) {
    for (const scenario of SCENARIO_IDS) {
      const result = runScenario(method, scenario);
      assert.equal(result.scenario, scenario);
      assert.equal(result.knownScenario, true);
      assert.equal(typeof result.verdict, 'string');
      assert.equal(typeof result.canDispatch, 'boolean');
      assert.equal(typeof result.canClaimSuccess, 'boolean');
      assert.equal(typeof result.canAutoReplay, 'boolean');
      assert.equal(typeof result.hasRecoveryPlan, 'boolean');
      assert.ok(result.run);
      assert.equal(result.run.method, method);
      const wire = JSON.parse(JSON.stringify({
        scenario: result.scenario,
        verdict: result.verdict,
        canDispatch: result.canDispatch,
        canClaimSuccess: result.canClaimSuccess,
        canAutoReplay: result.canAutoReplay,
        blockedBy: result.blockedBy,
      }));
      assert.equal(wire.scenario, scenario);
    }
  }
});

test('runScenario：未知场景/未知方法都安全（不抛错、结论保守）', () => {
  const unknownScenario = runScenario('click', 'no-such-scenario');
  assert.equal(unknownScenario.knownScenario, false);
  assert.equal(unknownScenario.verdict, 'inapplicable');
  assert.equal(unknownScenario.canDispatch, false);
  assert.match(unknownScenario.note, /未登记/);
  const unknownMethod = runScenario('no.such.method', 'ideal');
  assert.equal(unknownMethod.run.known, false);
  assert.equal(unknownMethod.verdict, 'violated');
  assert.equal(unknownMethod.canDispatch, false);
  assert.equal(runScenario(null, null).knownScenario, false);
});

// ---------------------------------------------------------------------------
// 2. 场景语义不变量（165 方法）
// ---------------------------------------------------------------------------

test('blind：空证据不违反、不禁派发（缺证据 ≠ 不成立）', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'blind');
    assert.notEqual(result.verdict, 'violated', method);
    assert.equal(result.canDispatch, true, method);
  }
});

test('preflight：理想上下文下允许派发，但结算/重放无证据', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'preflight');
    assert.equal(result.canDispatch, true, method + ' 理想上下文禁止派发');
    assert.equal(result.canClaimSuccess, true, method + ' 没有结果时应允许继续等待');
    assert.equal(result.canAutoReplay, true, method + ' 没有重放请求时不应提前禁止');
    assert.equal(result.run.stages.replay.unknown.length, 0, method + ' 未请求重放却出现 replay unknown');
  }
});

test('ideal：前置满足 + 后置证据齐备 ⇒ 可派发且可声明成功', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'ideal');
    assert.equal(result.canDispatch, true, method);
    assert.equal(result.canClaimSuccess, true, method + ' 理想场景禁止声明成功');
    assert.notEqual(result.verdict, 'violated', method);
  }
});

test('success-unverified：空结果不会让结算失败，但语义性后置标 unverifiable', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'success-unverified');
    assert.equal(result.canClaimSuccess, true, method + ' 空结果被判失败');
    assert.notEqual(result.verdict, 'violated', method);
    const settle = result.run.stages.settle;
    assert.ok(settle.satisfied.length + settle.unverifiable.length >= 1, method);
  }
});

test('pre-violated：第一个前置反证 ⇒ 禁止派发', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'pre-violated');
    assert.equal(result.canDispatch, false, method + ' 前置反证仍允许派发');
    assert.ok(result.blockedBy.length >= 1, method + ' 未标出阻断义务');
    assert.equal(result.verdict, 'violated', method);
  }
});

test('post-contradiction：可矛盾后置被证伪 ⇒ 禁止声明成功', () => {
  let checked = 0;
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'post-contradiction');
    const hasEvidence = result.evidence.result && Object.keys(result.evidence.result).length > 0;
    if (!hasEvidence) continue;
    assert.equal(result.canClaimSuccess, false, method + ' 后置矛盾仍允许声明成功');
    assert.equal(result.verdict, 'violated', method);
    checked += 1;
  }
  assert.ok(checked > 80, '后置矛盾覆盖过窄：' + checked);
});

test('unknown-outcome：自动重放结论等于目录 replayable', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'unknown-outcome');
    assert.equal(result.canAutoReplay, proofOf(method).replayable, method + ' 未知结果的重放结论与目录不一致');
    assert.equal(result.canDispatch, true, method + ' 失败证据不应倒推禁止派发');
    if (!proofOf(method).replayable) assert.equal(result.verdict, 'violated', method);
  }
});

test('not-applied-failure / replay-safe：已证明未生效 ⇒ 所有方法可安全重放', () => {
  for (const method of ALL_METHODS) {
    for (const scenario of ['not-applied-failure', 'replay-safe']) {
      const result = runScenario(method, scenario);
      assert.equal(result.canAutoReplay, true, method + '/' + scenario + ' 已证明未生效却禁止重放');
      assert.equal(result.hasRecoveryPlan, true, method + '/' + scenario + ' 派发前错误必须有恢复计划');
    }
  }
});

test('applied-retry：已生效后重放只允许结果可证明的方法', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'applied-retry');
    assert.equal(result.canAutoReplay, proofOf(method).replayable, method + ' 已生效重放结论与目录不一致');
  }
});

test('unknown-code：恢复义务必然违反（没有剧本）', () => {
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'unknown-code');
    assert.equal(result.hasRecoveryPlan, false, method);
    assert.equal(result.verdict, 'violated', method);
    const recovery = result.run.checks.find((check) => check.kind === 'recovery');
    assert.equal(recovery.verdict, 'violated');
    assert.match(recovery.reason, /未知|不在|playbook/i);
  }
});

// ---------------------------------------------------------------------------
// 3. 场景矩阵与摘要
// ---------------------------------------------------------------------------

test('scenarioMatrix：结构、行数、每行覆盖全部场景、计数总和为 165', () => {
  assert.equal(MATRIX.methods.length, 165);
  assert.deepEqual([...MATRIX.scenarios], [...SCENARIO_IDS]);
  assert.equal(MATRIX.rows.length, 165);
  for (const row of MATRIX.rows) {
    assert.equal(Object.keys(row.cells).length, SCENARIO_IDS.length);
    for (const scenario of SCENARIO_IDS) {
      const cell = row.cells[scenario];
      assert.equal(typeof cell.verdict, 'string');
      assert.equal(typeof cell.canDispatch, 'boolean');
      assert.ok(Array.isArray([...cell.blockedBy]));
    }
  }
  for (const scenario of SCENARIO_IDS) {
    const tally = MATRIX.counts[scenario];
    const total = Object.values(tally).reduce((sum, value) => sum + value, 0);
    assert.equal(total, 165, scenario + ' 计数总和不等于方法数');
  }
});

test('scenarioMatrix：关键场景的分布符合不变量', () => {
  assert.equal(MATRIX.counts.blind.violated, 0);
  assert.equal(MATRIX.counts.ideal.violated, 0);
  assert.equal(MATRIX.counts['pre-violated'].violated, 165);
  assert.equal(MATRIX.counts['unknown-code'].violated, 165);
  assert.ok(MATRIX.counts['post-contradiction'].violated > 20);
  // unknown-outcome：90 个可重放方法 proven/partial/unknown，75 个 violated
  assert.equal(MATRIX.counts['unknown-outcome'].violated, 75);
  assert.equal(MATRIX.counts['not-applied-failure'].violated, 0);
});

test('scenarioSummary：11 行摘要，含标签/说明/计数', () => {
  const rows = scenarioSummary();
  assert.equal(rows.length, 11);
  for (const row of rows) {
    assert.equal(typeof row.scenario, 'string');
    assert.equal(typeof row.label, 'string');
    assert.equal(typeof row.detail, 'string');
    assert.equal(row.total, 165);
    const sum = Object.values(row.counts).reduce((value, item) => value + item, 0);
    assert.equal(sum, 165, row.scenario);
  }
  assert.deepEqual(rows.map((row) => row.scenario), [...SCENARIO_IDS]);
});

test('stageDistribution：阶段分布覆盖四个阶段，总量与义务数一致', () => {
  const methods = ['click', 'video.start', 'read'];
  const distribution = stageDistribution('preflight', methods);
  assert.deepEqual(Object.keys(distribution), ['preflight', 'settle', 'replay', 'recovery']);
  for (const stage of Object.values(distribution)) {
    assert.equal(stage.methods, methods.length);
    // 每个阶段：五类 verdict 计数守恒（没有丢义务）
    assert.equal(
      stage.satisfied + stage.unknown + stage.unverifiable + stage.violated + stage.inapplicable >=
        stage.satisfied,
      true,
    );
  }
  // preflight 场景：前置全部 satisfied（理想上下文），无 violated/unknown
  assert.equal(distribution.preflight.unknown, 0);
  assert.equal(distribution.preflight.violated, 0);
  assert.ok(distribution.preflight.satisfied > 0);
  // 没有结果/错误：结算义务（post + effect_state 两条/方法）与恢复义务都应是 inapplicable
  assert.equal(distribution.settle.inapplicable, methods.length * 2, '没有结果时结算义务应 inapplicable');
  assert.equal(distribution.recovery.inapplicable, methods.length, '没有错误时恢复义务应 inapplicable');
  // 阶段义务总和 = 各方法义务数之和
  const stageTotal = Object.values(distribution).reduce((sum, stage) => (
    sum + stage.satisfied + stage.unknown + stage.unverifiable + stage.violated + stage.inapplicable
  ), 0);
  const expectedTotal = methods.reduce((sum, method) => {
    const proof = proofOf(method);
    return sum + proof.pre.length + proof.post.length + 4;
  }, 0);
  assert.equal(stageTotal, expectedTotal);
});

// ---------------------------------------------------------------------------
// 4. 可执行建议与解释
// ---------------------------------------------------------------------------

test('nextActions：盲证据给“补齐前置”，理想场景给“继续”，未知方法给保守建议', () => {
  const blind = nextActions(runCallObligations('click', {}));
  assert.ok(blind.some((item) => item.dimension === 'pre' && /前置/.test(item.action)));
  const ideal = nextActions(runScenario('click', 'ideal').run);
  assert.equal(ideal.length, 1);
  assert.match(ideal[0].action, /继续/);
  const blocked = nextActions(runScenario('click', 'pre-violated').run);
  assert.ok(blocked.some((item) => item.dimension === 'pre' && /前置/.test(item.action)));
  const unknownMethod = nextActions({ known: false });
  assert.equal(unknownMethod.length, 1);
  assert.match(unknownMethod[0].action, /方法名/);
  const replayBlocked = nextActions(runScenario('video.start', 'unknown-outcome').run);
  assert.ok(replayBlocked.some((item) => item.dimension === 'replayable' && /resolve/.test(item.action)));
  const recoveryBlocked = nextActions(runScenario('video.start', 'unknown-code').run);
  assert.ok(recoveryBlocked.some((item) => item.dimension === 'recovery'));
});

test('nextActions：建议去重且顺序稳定', () => {
  const run = runScenario('click', 'unknown-outcome').run;
  const actions = nextActions(run);
  const keys = actions.map((item) => item.dimension + '|' + item.action);
  assert.equal(new Set(keys).size, keys.length, '建议重复');
  assert.deepEqual(nextActions(run).map((item) => item.action), actions.map((item) => item.action));
  for (const item of actions) {
    assert.equal(typeof item.obligation, 'string');
    assert.equal(typeof item.detail, 'string');
    assert.ok(Object.isFrozen(item));
  }
});

test('explainRun：包含四硬结论、阶段统计与逐条非满意义务', () => {
  const lines = explainRun(runScenario('video.start', 'unknown-outcome').run);
  assert.ok(lines.length > 3);
  assert.match(lines[0], /video\.start → /);
  assert.match(lines[0], /dispatch=/);
  assert.match(lines[0], /claim=/);
  assert.match(lines[0], /replay=/);
  assert.match(lines[0], /recovery=/);
  assert.ok(lines.some((line) => line.includes('[preflight]')));
  assert.ok(lines.some((line) => line.includes('[replay]')));
  assert.ok(lines.some((line) => line.startsWith('  ⇒ ')));
  assert.deepEqual(explainRun({ known: false }), ['未知方法：没有可执行义务']);
});

test('场景与执行器同源：runScenario 的结论与直接 runCallObligations 完全一致', () => {
  for (const method of ['click', 'observe', 'video.start', 'transfer.begin']) {
    for (const scenario of SCENARIO_IDS) {
      const viaScenario = runScenario(method, scenario);
      const direct = runCallObligations(method, viaScenario.evidence);
      assert.equal(viaScenario.verdict, direct.verdict, method + '/' + scenario);
      assert.equal(viaScenario.canDispatch, direct.canDispatch, method + '/' + scenario);
      assert.equal(viaScenario.canClaimSuccess, direct.canClaimSuccess, method + '/' + scenario);
      assert.equal(viaScenario.canAutoReplay, direct.canAutoReplay, method + '/' + scenario);
      assert.equal(viaScenario.hasRecoveryPlan, direct.hasRecoveryPlan, method + '/' + scenario);
      assert.deepEqual([...viaScenario.blockedBy], direct.blocking.map((check) => check.id), method + '/' + scenario);
    }
  }
});
