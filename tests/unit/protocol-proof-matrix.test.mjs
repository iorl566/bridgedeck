// tests/unit/protocol-proof-matrix.test.mjs —— 165 方法 × 全场景的全矩阵不变量测试。
//
// protocol-proof-scenarios.test.mjs 校验“每个场景自己的语义”；
// 本文件校验“矩阵整体”：
//   1) 165 × 11 全矩阵结构完整、可 JSON 序列化、可确定性重放；
//   2) 跨场景不变量（理想场景不违反、反证场景必阻断、未知结果按目录 replayable 分类）；
//   3) 全方法下一阶段建议都能生成，且与硬结论一致；
//   4) 全方法恢复义务在“有错误”的场景下都能给出计划或明确报告缺失。
import test from 'node:test';
import assert from 'node:assert/strict';

import { METHOD_NAMES, proofOf } from '../../lib/method-catalog.mjs';
import {
  SCENARIO_IDS,
  explainRun,
  nextActions,
  runScenario,
  scenarioMatrix,
  stageDistribution,
} from '../../lib/protocol-proof.mjs';

const ALL_METHODS = [...METHOD_NAMES];
const MATRIX = scenarioMatrix(ALL_METHODS, SCENARIO_IDS);

// ---------------------------------------------------------------------------
// 1. 全矩阵结构
// ---------------------------------------------------------------------------

test('全矩阵：165 行 × 11 场景，单元格字段齐全', () => {
  assert.equal(MATRIX.rows.length, 165);
  for (const row of MATRIX.rows) {
    assert.equal(row.cells && typeof row.cells === 'object', true, row.method);
    assert.equal(Object.keys(row.cells).length, SCENARIO_IDS.length, row.method);
    for (const scenario of SCENARIO_IDS) {
      const cell = row.cells[scenario];
      assert.equal(typeof cell.verdict, 'string', row.method + '/' + scenario);
      assert.ok(['proven', 'partial', 'unknown', 'violated', 'inapplicable'].includes(cell.verdict), row.method + '/' + scenario);
      for (const key of ['canDispatch', 'canClaimSuccess', 'canAutoReplay', 'hasRecoveryPlan']) {
        assert.equal(typeof cell[key], 'boolean', row.method + '/' + scenario + ' ' + key);
      }
      assert.ok(Array.isArray([...cell.blockedBy]));
    }
  }
});

test('全矩阵：可 JSON 序列化且没有 undefined', () => {
  const wire = JSON.parse(JSON.stringify(MATRIX));
  assert.equal(wire.rows.length, 165);
  assert.equal(wire.scenarios.length, 11);
  const text = JSON.stringify(wire);
  assert.equal(text.includes('undefined'), false);
});

test('全矩阵：确定性重放（两次计算深度相等）', () => {
  const again = scenarioMatrix(ALL_METHODS, SCENARIO_IDS);
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(MATRIX)));
  // 小规模重算也必须一致
  const small = scenarioMatrix(['click', 'video.start'], ['blind', 'ideal']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(small.rows.map((row) => row.cells))),
    JSON.parse(JSON.stringify(MATRIX.rows.filter((row) => ['click', 'video.start'].includes(row.method))
      .map((row) => ({ blind: row.cells.blind, ideal: row.cells.ideal })))),
  );
});

test('全矩阵：每场景计数总和 = 165，且计数与行数据一致', () => {
  for (const scenario of SCENARIO_IDS) {
    const tally = MATRIX.counts[scenario];
    const total = Object.values(tally).reduce((sum, value) => sum + value, 0);
    assert.equal(total, 165, scenario);
    const recomputed = { proven: 0, partial: 0, unknown: 0, violated: 0, inapplicable: 0 };
    for (const row of MATRIX.rows) recomputed[row.cells[scenario].verdict] += 1;
    assert.deepEqual(tally, recomputed, scenario + ' 计数与行不一致');
  }
});

// ---------------------------------------------------------------------------
// 2. 跨场景不变量
// ---------------------------------------------------------------------------

test('跨场景：ideal 行必然可派发 + 可声明成功，且非 violated', () => {
  for (const row of MATRIX.rows) {
    const ideal = row.cells.ideal;
    assert.equal(ideal.canDispatch, true, row.method);
    assert.equal(ideal.canClaimSuccess, true, row.method);
    assert.notEqual(ideal.verdict, 'violated', row.method);
  }
});

test('跨场景：pre-violated 行必然禁止派发且 violated', () => {
  for (const row of MATRIX.rows) {
    const blocked = row.cells['pre-violated'];
    assert.equal(blocked.canDispatch, false, row.method);
    assert.equal(blocked.verdict, 'violated', row.method);
    assert.ok(blocked.blockedBy.length >= 1, row.method);
  }
});

test('跨场景：unknown-outcome 的自动重放结论与目录 replayable 逐方法一致', () => {
  for (const row of MATRIX.rows) {
    assert.equal(row.cells['unknown-outcome'].canAutoReplay, proofOf(row.method).replayable, row.method);
    assert.equal(row.cells['applied-retry'].canAutoReplay, proofOf(row.method).replayable, row.method);
    // 已证明未生效时所有方法都可重放
    assert.equal(row.cells['not-applied-failure'].canAutoReplay, true, row.method);
    assert.equal(row.cells['replay-safe'].canAutoReplay, true, row.method);
  }
});

test('跨场景：blind 行不违反、不禁止派发（缺证据 ≠ 反证）', () => {
  for (const row of MATRIX.rows) {
    assert.notEqual(row.cells.blind.verdict, 'violated', row.method);
    assert.equal(row.cells.blind.canDispatch, true, row.method);
    assert.equal(row.cells.blind.hasRecoveryPlan, true, row.method);
  }
});

test('跨场景：post-contradiction 行在构造出反证时禁止声明成功', () => {
  let checked = 0;
  for (const method of ALL_METHODS) {
    const result = runScenario(method, 'post-contradiction');
    const hasEvidence = result.evidence.result && Object.keys(result.evidence.result).length > 0;
    if (!hasEvidence) continue;
    const cell = MATRIX.rows.find((row) => row.method === method).cells['post-contradiction'];
    assert.equal(cell.canClaimSuccess, false, method);
    assert.equal(cell.verdict, 'violated', method);
    checked += 1;
  }
  assert.ok(checked > 80, '反证覆盖过窄：' + checked);
});

test('跨场景：unknown-code 行恢复义务必违反，not-applied 行恢复义务必满足', () => {
  for (const row of MATRIX.rows) {
    assert.equal(row.cells['unknown-code'].hasRecoveryPlan, false, row.method);
    assert.equal(row.cells['unknown-code'].verdict, 'violated', row.method);
    assert.equal(row.cells['not-applied-failure'].hasRecoveryPlan, true, row.method);
    assert.equal(row.cells.preflight.hasRecoveryPlan, true, row.method);
  }
});

test('跨场景：success-unverified 不失败（空结果不是矛盾）', () => {
  for (const row of MATRIX.rows) {
    assert.equal(row.cells['success-unverified'].canClaimSuccess, true, row.method);
    assert.notEqual(row.cells['success-unverified'].verdict, 'violated', row.method);
  }
});

// ---------------------------------------------------------------------------
// 3. 建议与解释的全量可用性
// ---------------------------------------------------------------------------

test('全方法 × 全场景：nextActions 至少给一条建议且结构合法', () => {
  for (const method of ALL_METHODS) {
    for (const scenario of SCENARIO_IDS) {
      const result = runScenario(method, scenario);
      const actions = nextActions(result.run);
      assert.ok(actions.length >= 1, method + '/' + scenario + ' 没有建议');
      for (const action of actions) {
        assert.equal(typeof action.obligation, 'string');
        assert.equal(typeof action.dimension, 'string');
        assert.equal(typeof action.action, 'string');
        assert.equal(typeof action.detail, 'string');
        assert.ok(Object.isFrozen(action));
      }
    }
  }
});

test('全方法 × 全场景：explainRun 至少两行且首行含方法名', () => {
  for (const method of ALL_METHODS) {
    for (const scenario of SCENARIO_IDS) {
      const run = runScenario(method, scenario).run;
      const lines = explainRun(run);
      assert.ok(lines.length >= 1, method + '/' + scenario);
      assert.ok(lines[0].includes(method), method + '/' + scenario + ' 首行缺少方法名');
      if (run.known) assert.ok(lines.length >= 2, method + '/' + scenario + ' 缺少阶段统计');
    }
  }
});

test('建议与硬结论一致：canDispatch=false 时建议必须提到前置/阻断', () => {
  for (const row of MATRIX.rows) {
    if (row.cells['pre-violated'].canDispatch) continue;
    const result = runScenario(row.method, 'pre-violated');
    const actions = nextActions(result.run);
    assert.ok(actions.some((item) => /前置/.test(item.action)), row.method + ' 未提示前置问题');
  }
});

// ---------------------------------------------------------------------------
// 4. 阶段分布（多种场景）
// ---------------------------------------------------------------------------

test('stageDistribution：ideal 场景下 settle 阶段无 violated/unknown', () => {
  const distribution = stageDistribution('ideal', ALL_METHODS);
  assert.equal(distribution.settle.violated, 0);
  assert.equal(distribution.settle.unknown, 0);
  assert.equal(distribution.preflight.violated, 0);
});

test('stageDistribution：unknown-outcome 场景下 replay 阶段 330 条义务全部有结论', () => {
  const distribution = stageDistribution('unknown-outcome', ALL_METHODS);
  // replay 阶段每个方法两条义务（幂等 + 可重放）⇒ 330 条
  const total = distribution.replay.violated + distribution.replay.satisfied
    + distribution.replay.unknown + distribution.replay.unverifiable + distribution.replay.inapplicable;
  assert.equal(total, 165 * 2);
  // 75 个不可重放方法的可重放义务被违反；其余违反来自非幂等义务（非阻断但计为 violated）
  assert.equal(MATRIX.counts['unknown-outcome'].violated, 75, '不可重放方法数量漂移');
  assert.ok(distribution.replay.violated >= 75);
  assert.ok(distribution.replay.satisfied >= 90);
  assert.equal(distribution.preflight.violated, 0);
});

test('stageDistribution：unknown-code 场景下 recovery 阶段 violated = 165', () => {
  const distribution = stageDistribution('unknown-code', ALL_METHODS);
  assert.equal(distribution.recovery.violated, 165);
  assert.equal(distribution.recovery.satisfied, 0);
});

test('stageDistribution：计数守恒（四阶段 verdict 总和 = 各方法义务数之和）', () => {
  const scenarios = ['blind', 'ideal', 'pre-violated', 'unknown-outcome'];
  const expectedTotal = ALL_METHODS.reduce((sum, method) => {
    const proof = proofOf(method);
    return sum + proof.pre.length + proof.post.length + 4;
  }, 0);
  for (const scenario of scenarios) {
    const distribution = stageDistribution(scenario, ALL_METHODS);
    const total = Object.values(distribution).reduce((sum, stage) => (
      sum + stage.violated + stage.unknown + stage.unverifiable + stage.satisfied + stage.inapplicable
    ), 0);
    assert.equal(total, expectedTotal, scenario + ' 阶段计数不守恒');
  }
});
