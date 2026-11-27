// tests/unit/protocol-planner-execution.test.mjs —— 迁移计划执行面测试（批次/对比/风险/矩阵自证）。
//
// 覆盖：
//   1) migrationBatches：按阶段切批、步骤守恒、阻断/条件分类；
//   2) compareMigrationPlans：同计划一致、不同目标/方向产生可读差异；
//   3) planRiskMethods：计划涉及方法的风险面；
//   4) validatePlannerMatrix：多组 (from,to) 的计划矩阵自证（含正反向 gained/lost 对称）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { proofOf } from '../../lib/method-catalog.mjs';
import {
  MIGRATION_PHASES,
  PLANNER_ABI,
  compareMigrationPlans,
  migrationBatches,
  migrationChecklist,
  planMigration,
  planRiskMethods,
  validateMigrationPlan,
  validatePlannerMatrix,
} from '../../lib/protocol-migration-planner.mjs';

const BASE = planMigration({ from: '1.8', to: '1.9' });

// ---------------------------------------------------------------------------
// 1. 执行批次
// ---------------------------------------------------------------------------

test('migrationBatches：覆盖所有有步骤的阶段，步骤数与计划一致', () => {
  const batches = migrationBatches(BASE);
  assert.equal(batches.from, '1.8');
  assert.equal(batches.to, '1.9');
  assert.equal(batches.verdict, 'upgrade-required');
  const expectedPhases = BASE.phases.filter((phase) => phase.steps.length > 0).map((phase) => phase.phase);
  assert.deepEqual(batches.batches.map((batch) => batch.phase), expectedPhases);
  // 1.8 → 1.9 没有需要降级的调用面，degrade 阶段为空 ⇒ 5 批
  assert.equal(batches.batches.length, 5);
  assert.equal(expectedPhases.includes('degrade'), false);
  const totalSteps = BASE.phases.reduce((sum, phase) => sum + phase.steps.length, 0);
  assert.equal(batches.counts.steps, totalSteps);
  assert.equal(batches.counts.steps, batches.batches.reduce((sum, batch) => sum + batch.steps.length, 0));
  for (let index = 0; index < batches.batches.length; index += 1) {
    assert.equal(batches.batches[index].batch, index + 1);
    assert.equal(typeof batches.batches[index].title, 'string');
    for (const entry of batches.batches[index].steps) {
      assert.equal(typeof entry.id, 'string');
      assert.ok(['blocking', 'conditional', 'informational'].includes(entry.kind));
      assert.equal(typeof entry.action, 'string');
    }
  }
  assert.equal(batches.counts.blocking, batches.batches.reduce((sum, batch) => sum + batch.blocking.length, 0));
  assert.equal(batches.counts.conditional, batches.batches.reduce((sum, batch) => sum + batch.conditional.length, 0));
  assert.match(batches.summary, /执行批次：5 批/);
});

test('migrationBatches：major 不兼容时 negotiate 批次含阻断步骤，降级批次给阻断', () => {
  const plan = planMigration({ from: '2.0', to: '1.9' });
  const batches = migrationBatches(plan);
  const negotiate = batches.batches.find((batch) => batch.phase === 'negotiate');
  assert.ok(negotiate);
  assert.ok(negotiate.blocking.length >= 1, 'major 不兼容没有阻断步骤');
  const upgrade = batches.batches.find((batch) => batch.phase === 'upgrade');
  assert.ok(upgrade);
  assert.ok(upgrade.blocking.length >= 1, '无法生成阶梯时应阻断');
});

test('migrationBatches：无步骤的阶段不出现（同版本计划）', () => {
  const plan = planMigration({ from: '1.9', to: '1.9' });
  const batches = migrationBatches(plan);
  assert.ok(batches.batches.length >= 3);
  assert.ok(batches.batches.every((batch) => batch.steps.length > 0));
  // 与 checklist 的步骤总量一致（两种摊平方式必须等价）
  const checklist = migrationChecklist(plan);
  assert.equal(batches.counts.steps, checklist.counts.total);
});

test('migrationBatches：每个批次的 verify 列表来自步骤且非空字符串', () => {
  const batches = migrationBatches(BASE);
  for (const batch of batches.batches) {
    for (const item of batch.verify) {
      assert.equal(typeof item, 'string');
      assert.ok(item.trim().length > 0);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. 计划对比
// ---------------------------------------------------------------------------

test('compareMigrationPlans：同一计划语义一致', () => {
  const again = planMigration({ from: '1.8', to: '1.9' });
  const diff = compareMigrationPlans(BASE, again);
  assert.equal(diff.same, true);
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.counts.fields, 0);
  assert.match(diff.summary, /语义一致/);
});

test('compareMigrationPlans：目标版本不同会报告字段与新增能力差异', () => {
  const plan198to110 = planMigration({ from: '1.8', to: '1.10' });
  const diff = compareMigrationPlans(BASE, plan198to110);
  assert.equal(diff.same, false);
  assert.ok(diff.changes.some((change) => change.field === 'to' && change.after === '1.10'));
  assert.equal(diff.counts.fields >= 1, true);
  // 1.10 目标与 1.9 目标的 gained 集合相同（所有 floor 都是 1.9），所以 feature 差异为空
  assert.deepEqual([...diff.gainedFeatures.added], []);
});

test('compareMigrationPlans：不可行计划会报告新阻断', () => {
  const major = planMigration({ from: '2.0', to: '1.9' });
  const diff = compareMigrationPlans(BASE, major);
  assert.equal(diff.same, false);
  assert.ok(diff.blockers.added.length >= 1, 'major 不兼容应报告新阻断');
  assert.ok(diff.changes.some((change) => change.field === 'verdict' && change.after === 'major-incompatible'));
  assert.match(diff.summary, /迁移计划差异/);
});

test('compareMigrationPlans：特性子集差异体现在 features 集合', () => {
  const full = planMigration({ from: '1.8', to: '1.9' });
  const subset = planMigration({ from: '1.8', to: '1.9', features: ['video'] });
  const diff = compareMigrationPlans(full, subset);
  assert.equal(diff.same, false);
  assert.equal(diff.gainedFeatures.added.length, 0);
  assert.ok(diff.gainedFeatures.removed.length > 0, '子集计划应报告减少的特性');
});

// ---------------------------------------------------------------------------
// 3. 计划风险面
// ---------------------------------------------------------------------------

test('planRiskMethods：19 个受 floor 约束方法的风险分桶与目录一致', () => {
  const risk = planRiskMethods(BASE);
  assert.equal(risk.counts.safe + risk.counts.guarded + risk.counts.risky, BASE.methods.length);
  for (const method of risk.safe) assert.equal(proofOf(method).replayable, true);
  for (const method of risk.guarded) {
    assert.equal(proofOf(method).replayable, false);
    assert.equal(proofOf(method).idempotent, true);
  }
  for (const method of risk.risky) assert.equal(proofOf(method).idempotent, false);
  assert.equal(risk.risky.includes('video.start'), true);
  assert.match(risk.note, /resolve/);
});

test('planRiskMethods：空计划安全', () => {
  const risk = planRiskMethods({});
  assert.deepEqual([...risk.safe], []);
  assert.deepEqual([...risk.risky], []);
  assert.equal(risk.counts.risky, 0);
});

// ---------------------------------------------------------------------------
// 4. 计划矩阵自证
// ---------------------------------------------------------------------------

test('validatePlannerMatrix：默认 9 组 (from,to) 全部通过', () => {
  const issues = validatePlannerMatrix();
  assert.deepEqual(issues, []);
});

test('validatePlannerMatrix：正反向 gained/lost 对称、同 major 判定一致', () => {
  const pairs = [
    ['1.7', '1.8'], ['1.8', '1.9'], ['1.9', '1.8'], ['1.8', '1.7'],
    ['2.0', '1.9'], ['1.9', '2.0'], ['x', '1.9'], ['1.9', 'x'],
  ];
  assert.deepEqual(validatePlannerMatrix(pairs), []);
});

test('validatePlannerMatrix：每份计划都通过单计划校验（无重复校验漏洞）', () => {
  const pairs = [['1.7', '1.9'], ['1.9', '1.7'], ['2.0', '2.0']];
  const issues = validatePlannerMatrix(pairs);
  assert.deepEqual(issues, []);
  for (const [from, to] of pairs) {
    assert.deepEqual(validateMigrationPlan(planMigration({ from, to })), [], from + '→' + to);
  }
});

test('PLANNER_ABI：暴露批次执行需要的常量', () => {
  assert.deepEqual([...PLANNER_ABI.phases], [...MIGRATION_PHASES]);
  assert.equal(PLANNER_ABI.verdicts.length, 5);
  assert.equal(PLANNER_ABI.stepKinds.length, 3);
  assert.ok(Object.isFrozen(PLANNER_ABI));
});
