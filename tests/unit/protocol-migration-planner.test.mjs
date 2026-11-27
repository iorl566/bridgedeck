// tests/unit/protocol-migration-planner.test.mjs —— 协议迁移规划器的行为面测试。
//
// 覆盖：
//   1) 迁移阶梯（同 major 有阶梯、跨 major 明确拒绝、降级反向）；
//   2) planMigration 六阶段结构、verdict 规则、blockers/warnings、指纹；
//   3) 调用面降级分析（可降级 vs 不可降级）；
//   4) 派生校验器 validateMigrationPlan 的正例与注入错误负例；
//   5) 可执行 checklist / 快照 / 闸门用紧凑计划（planUpgradeFrom）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  proofOf,
} from '../../lib/method-catalog.mjs';
import { protocolBand } from '../../lib/protocol.mjs';
import { methodGateAt } from '../../lib/protocol-compat-runner.mjs';
import {
  MIGRATION_DIRECTIONS,
  MIGRATION_PHASES,
  MIGRATION_PLAN_VERSION,
  MIGRATION_STEP_KINDS,
  MIGRATION_VERDICTS,
  PHASE_TITLES,
  PLANNER_ABI,
  explainMigration,
  migrationChecklist,
  migrationLadder,
  migrationSnapshot,
  nextMigrationSteps,
  normalizePlanOptions,
  planFingerprint,
  planMigration,
  planUpgradeFrom,
  requiredVersionForFeatures,
  requiredVersionForMethod,
  validateMigrationPlan,
} from '../../lib/protocol-migration-planner.mjs';

const ALL_FEATURES = [...FEATURE_NAMES];

// ---------------------------------------------------------------------------
// 1. 常量与输入归一化
// ---------------------------------------------------------------------------

test('迁移常量：方向/阶段/步骤种类/结论稳定且冻结', () => {
  assert.deepEqual([...MIGRATION_PHASES], ['assess', 'negotiate', 'upgrade', 'degrade', 'verify', 'rollback']);
  assert.deepEqual([...MIGRATION_DIRECTIONS], ['upgrade', 'downgrade', 'same', 'unknown']);
  assert.deepEqual([...MIGRATION_STEP_KINDS], ['blocking', 'conditional', 'informational']);
  assert.deepEqual([...MIGRATION_VERDICTS], ['compatible', 'upgrade-required', 'downgrade-blocked', 'major-incompatible', 'unknown']);
  assert.equal(MIGRATION_PLAN_VERSION, 1);
  for (const phase of MIGRATION_PHASES) assert.equal(typeof PHASE_TITLES[phase], 'string');
  assert.deepEqual([...PLANNER_ABI.phases], [...MIGRATION_PHASES]);
  assert.ok(Object.isFrozen(PLANNER_ABI));
});

test('normalizePlanOptions：默认目标当前协议、源未知、调用过滤、冻结', () => {
  const defaults = normalizePlanOptions();
  assert.equal(defaults.from, 'unknown');
  assert.equal(defaults.to, PROTOCOL_CURRENT);
  assert.deepEqual([...defaults.calls], []);
  assert.equal(defaults.features, null);
  assert.equal(defaults.methods, null);
  assert.equal(typeof defaults.compare, 'function');
  assert.equal(defaults.featuresForCall, null);
  const custom = normalizePlanOptions({
    from: '1.8',
    to: '1.9',
    calls: [{ method: 'video.start', params: { a: 1 } }, { params: {} }, null],
    features: ['video', 'video'],
    methods: ['click'],
  });
  assert.equal(custom.from, '1.8');
  assert.equal(custom.calls.length, 1);
  assert.deepEqual({ ...custom.calls[0].params }, { a: 1 });
  assert.deepEqual([...custom.features], ['video']);
  assert.ok(Object.isFrozen(custom));
});

// ---------------------------------------------------------------------------
// 2. 迁移阶梯
// ---------------------------------------------------------------------------

test('migrationLadder：1.8 → 1.9 两级阶梯，1.9 获得全部 15 个特性', () => {
  const ladder = migrationLadder(PROTOCOL_BASELINE, PROTOCOL_CURRENT);
  assert.equal(ladder.ok, true);
  assert.equal(ladder.sameMajor, true);
  assert.equal(ladder.direction, 'upgrade');
  assert.deepEqual(ladder.rungs.map((rung) => rung.version), ['1.8', '1.9']);
  assert.deepEqual([...ladder.rungs[0].gainedFeatures], []);
  assert.deepEqual([...ladder.rungs[1].gainedFeatures], ALL_FEATURES);
  assert.equal(ladder.rungs[1].acquiredMethods.length, 29);
  assert.equal(ladder.rungs[1].band, 'current');
  assert.match(ladder.reason, /1\.8 → 1\.9/);
});

test('migrationLadder：1.7 → 1.10 只插入真实 floor（1.9），端点保留', () => {
  const ladder = migrationLadder('1.7', '1.10');
  assert.equal(ladder.ok, true);
  assert.deepEqual(ladder.rungs.map((rung) => rung.version), ['1.7', '1.9', '1.10']);
  assert.deepEqual([...ladder.floors], ['1.9']);
  assert.deepEqual([...ladder.rungs.find((rung) => rung.version === '1.9').gainedFeatures], ALL_FEATURES);
  assert.deepEqual([...ladder.rungs.find((rung) => rung.version === '1.10').gainedFeatures], []);
});

test('migrationLadder：降级方向反向、同版本单级、major 不同拒绝', () => {
  const down = migrationLadder('1.9', '1.8');
  assert.equal(down.direction, 'downgrade');
  assert.deepEqual(down.rungs.map((rung) => rung.version), ['1.9', '1.8']);
  const same = migrationLadder('1.9', '1.9');
  assert.equal(same.direction, 'same');
  assert.deepEqual(same.rungs.map((rung) => rung.version), ['1.9']);
  assert.match(same.reason, /同一版本/);
  const major = migrationLadder('2.0', '1.9');
  assert.equal(major.ok, false);
  assert.equal(major.sameMajor, false);
  assert.match(major.reason, /major 不同/);
  const unknown = migrationLadder('x', '1.9');
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /不可解析/);
});

test('migrationLadder：特性子集只生成相关 floor', () => {
  const ladder = migrationLadder('1.8', '1.9', { features: ['video'] });
  assert.deepEqual([...ladder.rungs.find((rung) => rung.version === '1.9').gainedFeatures], ['video']);
  const noFloor = migrationLadder('1.9', '1.10', { features: ['video'] });
  assert.deepEqual([...noFloor.floors], []);
});

// ---------------------------------------------------------------------------
// 3. 最低版本查询
// ---------------------------------------------------------------------------

test('requiredVersionForFeatures：取最高 floor，未知/空输入安全', () => {
  assert.equal(requiredVersionForFeatures(ALL_FEATURES), '1.9');
  assert.equal(requiredVersionForFeatures(['video']), '1.9');
  assert.equal(requiredVersionForFeatures([]), null);
  assert.equal(requiredVersionForFeatures(['no-such-feature']), null);
  for (const feature of ALL_FEATURES) assert.equal(requiredVersionForFeatures([feature]), FEATURE_FLOORS[feature]);
});

test('requiredVersionForMethod：gated 方法 1.9、无门方法 null', () => {
  assert.equal(requiredVersionForMethod('video.start'), '1.9');
  assert.equal(requiredVersionForMethod('click'), null);
  assert.equal(requiredVersionForMethod('no.such.method'), null);
});

// ---------------------------------------------------------------------------
// 4. planMigration 主流程
// ---------------------------------------------------------------------------

test('planMigration 1.8 → 1.9：upgrade-required、六阶段齐全、可执行', () => {
  const plan = planMigration({ from: PROTOCOL_BASELINE, to: PROTOCOL_CURRENT });
  assert.equal(plan.planVersion, MIGRATION_PLAN_VERSION);
  assert.equal(plan.from, '1.8');
  assert.equal(plan.to, '1.9');
  assert.equal(plan.direction, 'upgrade');
  assert.equal(plan.sameMajor, true);
  assert.equal(plan.feasible, true);
  assert.equal(plan.verdict, 'upgrade-required');
  assert.equal(plan.bandFrom, 'baseline');
  assert.equal(plan.bandTo, 'current');
  assert.equal(plan.handshake.severity, 'warn');
  assert.equal(plan.delta.counts.gainedFeatures, 15);
  assert.equal(plan.delta.counts.gainedMethods, 29);
  assert.deepEqual(plan.phases.map((item) => item.phase), [...MIGRATION_PHASES]);
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.steps.length > 10);
  assert.ok(plan.verification.length >= 1);
  assert.ok(plan.rollback.length >= 2);
  assert.match(plan.fingerprint, /^[0-9a-f]{8}$/);
  assert.match(plan.summary, /需要升级/);
  const wire = JSON.parse(JSON.stringify(plan));
  assert.equal(wire.verdict, plan.verdict);
  assert.equal(wire.phases.length, 6);
  assert.equal(wire.features.length, 15);
  assert.equal(wire.methods.length, 29);
});

test('planMigration：特性行 gained/lost 与 floor 数量正确', () => {
  const plan = planMigration({ from: '1.8', to: '1.9' });
  assert.equal(plan.features.length, 15);
  for (const row of plan.features) {
    assert.equal(row.gained, true, row.feature + ' 应标记 gained');
    assert.equal(row.lost, false);
    assert.equal(row.availableFrom, false);
    assert.equal(row.availableTo, true);
    assert.equal(row.floor, '1.9');
    assert.equal(row.degradable, FEATURE_FALLBACKS[row.feature].kind !== 'none');
  }
});

test('planMigration 1.9 → 1.9：compatible、无升级步骤、可验证', () => {
  const plan = planMigration({ from: '1.9', to: '1.9' });
  assert.equal(plan.verdict, 'compatible');
  assert.equal(plan.direction, 'same');
  assert.equal(plan.feasible, true);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.delta.counts.gainedFeatures, 0);
  assert.match(plan.summary, /无需迁移/);
  assert.deepEqual(validateMigrationPlan(plan), []);
});

test('planMigration 1.9 → 1.8：downgrade-blocked、记录丢失能力', () => {
  const plan = planMigration({ from: '1.9', to: '1.8' });
  assert.equal(plan.verdict, 'downgrade-blocked');
  assert.equal(plan.direction, 'downgrade');
  assert.equal(plan.feasible, true);
  assert.equal(plan.delta.counts.lostFeatures, 15);
  assert.equal(plan.delta.counts.lostMethods, 29);
  assert.ok(plan.warnings.some((text) => text.includes('丢失特性')));
  assert.ok(plan.warnings.some((text) => text.includes('丢失方法')));
  assert.match(plan.summary, /降级会丢失能力/);
  assert.deepEqual(validateMigrationPlan(plan), []);
});

test('planMigration 2.0 → 1.9：major-incompatible、blocked 且阶段说明阻断', () => {
  const plan = planMigration({ from: '2.0', to: '1.9' });
  assert.equal(plan.verdict, 'major-incompatible');
  assert.equal(plan.sameMajor, false);
  assert.equal(plan.feasible, false);
  assert.ok(plan.blockers.some((text) => /major/.test(text)));
  const negotiate = plan.phases.find((item) => item.phase === 'negotiate');
  assert.ok(negotiate.steps.some((step) => step.kind === 'blocking'));
  assert.match(plan.summary, /迁移不可行/);
  assert.deepEqual(validateMigrationPlan(plan), []);
});

test("planMigration 'x' → 1.9：unknown、blocked、评估阶段有阻断步骤", () => {
  const plan = planMigration({ from: 'x', to: '1.9' });
  assert.equal(plan.verdict, 'unknown');
  assert.equal(plan.feasible, false);
  assert.ok(plan.blockers.some((text) => /不可解析/.test(text)));
  const assess = plan.phases.find((item) => item.phase === 'assess');
  assert.ok(assess.steps.some((step) => step.id === 'assess.source' && step.kind === 'blocking'));
  assert.equal(protocolBand(plan.from), 'unknown');
  assert.deepEqual(validateMigrationPlan(plan), []);
});

test('planMigration：调用面分析区分可降级与不可降级', () => {
  const plan = planMigration({
    from: '1.8',
    calls: [
      { method: 'video.start' },
      { method: 'screenshot', params: { stream: true } },
      { method: 'click' },
    ],
    featuresForCall: (method, params) => {
      if (method === 'screenshot' && params && params.stream) return ['capture.stream'];
      if (method === 'video.start') return ['video'];
      return methodGateAt(method, '1.8').feature ? [methodGateAt(method, '1.8').feature] : [];
    },
  });
  assert.equal(plan.calls.length, 3);
  const video = plan.calls.find((row) => row.method === 'video.start');
  assert.deepEqual([...video.blockedAtFrom], ['video']);
  assert.deepEqual([...video.degradableAtFrom], []);
  const screenshot = plan.calls.find((row) => row.method === 'screenshot');
  assert.deepEqual([...screenshot.blockedAtFrom], ['capture.stream']);
  assert.deepEqual([...screenshot.degradableAtFrom], ['capture.stream']);
  const click = plan.calls.find((row) => row.method === 'click');
  assert.deepEqual([...click.blockedAtFrom], []);
  // video 没有可执行降级 ⇒ 必须有阻断
  assert.ok(plan.blockers.some((text) => /video/.test(text)));
  // capture.stream 有降级 ⇒ 降级阶段出现条件步骤
  const degrade = plan.phases.find((item) => item.phase === 'degrade');
  assert.ok(degrade.steps.some((step) => step.feature === 'capture.stream' && step.kind === 'conditional'));
  assert.ok(degrade.steps.some((step) => step.feature === 'video' && step.kind === 'blocking'));
});

test('planMigration：显式特性子集只评估这些特性', () => {
  const plan = planMigration({ from: '1.8', to: '1.9', features: ['video'] });
  assert.equal(plan.features.length, 1);
  assert.equal(plan.features[0].feature, 'video');
  assert.equal(plan.delta.counts.gainedFeatures, 15, 'delta 仍是全量事实，features 行是评估子集');
  assert.deepEqual(validateMigrationPlan(plan), []);
});

test('planMigration：源版本低于基线（1.7）仍可行但握手等级说明旧', () => {
  const plan = planMigration({ from: '1.7', to: '1.9' });
  assert.equal(plan.feasible, true);
  assert.equal(plan.verdict, 'upgrade-required');
  assert.equal(plan.bandFrom, 'legacy');
  assert.ok(plan.ladder.rungs.map((rung) => rung.version).includes('1.9'));
  assert.deepEqual(validateMigrationPlan(plan), []);
});

// ---------------------------------------------------------------------------
// 5. 派生校验器负例
// ---------------------------------------------------------------------------

test('validateMigrationPlan 负例：篡改 verdict / feasible / fingerprint', () => {
  const base = planMigration({ from: '1.8', to: '1.9' });
  const badVerdict = JSON.parse(JSON.stringify(base));
  badVerdict.verdict = 'compatible';
  assert.ok(validateMigrationPlan(badVerdict).some((issue) => issue.scope === 'plan.verdict'));
  const badFeasible = JSON.parse(JSON.stringify(base));
  badFeasible.feasible = false;
  assert.ok(validateMigrationPlan(badFeasible).some((issue) => issue.scope === 'plan.feasible'));
  const badFingerprint = JSON.parse(JSON.stringify(base));
  badFingerprint.fingerprint = 'deadbeef';
  assert.ok(validateMigrationPlan(badFingerprint).some((issue) => issue.scope === 'plan.fingerprint'));
  const badSummary = JSON.parse(JSON.stringify(base));
  badSummary.summary = '';
  assert.ok(validateMigrationPlan(badSummary).some((issue) => issue.scope === 'plan.summary'));
});

test('validateMigrationPlan 负例：阶段缺失/顺序错/重复步骤 id', () => {
  const base = planMigration({ from: '1.8', to: '1.9' });
  const missingPhase = JSON.parse(JSON.stringify(base));
  missingPhase.phases = missingPhase.phases.filter((item) => item.phase !== 'rollback');
  assert.ok(validateMigrationPlan(missingPhase).some((issue) => issue.scope === 'plan.phases'));
  const reordered = JSON.parse(JSON.stringify(base));
  reordered.phases = [reordered.phases[1], reordered.phases[0], ...reordered.phases.slice(2)];
  assert.ok(validateMigrationPlan(reordered).some((issue) => issue.scope === 'plan.phases'));
  const duplicated = JSON.parse(JSON.stringify(base));
  duplicated.phases[0].steps.push({ ...duplicated.phases[0].steps[0] });
  assert.ok(validateMigrationPlan(duplicated).some((issue) => issue.scope === 'plan.step.dup'));
});

test('validateMigrationPlan 负例：篡改特性/方法行与阶梯', () => {
  const base = planMigration({ from: '1.8', to: '1.9' });
  const badFeature = JSON.parse(JSON.stringify(base));
  badFeature.features[0].gained = false;
  assert.ok(validateMigrationPlan(badFeature).some((issue) => issue.scope === 'plan.feature.gained'));
  const badFloor = JSON.parse(JSON.stringify(base));
  badFloor.features[0].floor = '1.7';
  assert.ok(validateMigrationPlan(badFloor).some((issue) => issue.scope === 'plan.feature.floor'));
  const badMethod = JSON.parse(JSON.stringify(base));
  badMethod.methods[0].allowedTo = !badMethod.methods[0].allowedTo;
  assert.ok(validateMigrationPlan(badMethod).some((issue) => issue.scope === 'plan.method.to'));
  const badLadder = JSON.parse(JSON.stringify(base));
  badLadder.ladder.rungs = badLadder.ladder.rungs.filter((rung) => rung.version !== '1.9');
  assert.ok(validateMigrationPlan(badLadder).some((issue) => issue.scope === 'plan.ladder.endpoint'));
});

test('validateMigrationPlan 负例：major 不兼容却给可行、major 不兼容却生成阶梯', () => {
  const base = planMigration({ from: '2.0', to: '1.9' });
  const bad = JSON.parse(JSON.stringify(base));
  bad.feasible = true;
  assert.ok(validateMigrationPlan(bad).some((issue) => issue.scope === 'plan.feasible'));
  const badLadder = JSON.parse(JSON.stringify(base));
  badLadder.ladder = { ok: true, rungs: [{ version: '2.0', gainedFeatures: [] }, { version: '1.9', gainedFeatures: [] }] };
  assert.ok(validateMigrationPlan(badLadder).some((issue) => issue.scope === 'plan.ladder'));
});

test('validateMigrationPlan：随机生成的合法计划全部通过', () => {
  const pairs = [
    ['1.7', '1.7'], ['1.7', '1.8'], ['1.7', '1.9'], ['1.7', '1.10'],
    ['1.8', '1.7'], ['1.8', '1.8'], ['1.8', '1.9'], ['1.8', '1.10'],
    ['1.9', '1.7'], ['1.9', '1.8'], ['1.9', '1.9'], ['1.9', '1.10'],
    ['1.10', '1.8'], ['1.10', '1.9'], ['1.10', '1.10'], ['2.0', '2.0'],
  ];
  for (const [from, to] of pairs) {
    const plan = planMigration({ from, to });
    const issues = validateMigrationPlan(plan);
    assert.deepEqual(issues.map((issue) => issue.scope + ':' + issue.message), [], from + '→' + to + ' 校验失败');
    assert.ok(MIGRATION_VERDICTS.includes(plan.verdict));
    assert.equal(plan.fingerprint, planFingerprint(plan));
  }
});

// ---------------------------------------------------------------------------
// 6. checklist / 快照 / 紧凑计划
// ---------------------------------------------------------------------------

test('migrationChecklist：扁平清单与计划步骤一一对应，可过滤', () => {
  const plan = planMigration({ from: '1.8', to: '1.9' });
  const checklist = migrationChecklist(plan);
  assert.equal(checklist.from, plan.from);
  assert.equal(checklist.to, plan.to);
  assert.equal(checklist.verdict, plan.verdict);
  const totalSteps = plan.phases.reduce((sum, item) => sum + item.steps.length, 0);
  assert.equal(checklist.items.length, totalSteps);
  assert.equal(checklist.counts.total, totalSteps);
  assert.equal(checklist.items[0].order, 1);
  assert.equal(checklist.items[checklist.items.length - 1].order, totalSteps);
  for (const item of checklist.items) {
    assert.ok(MIGRATION_PHASES.includes(item.phase));
    assert.ok(MIGRATION_STEP_KINDS.includes(item.kind));
    assert.equal(typeof item.action, 'string');
    assert.equal(item.status, 'todo');
  }
  const compact = migrationChecklist(plan, { includeInformational: false });
  assert.ok(compact.items.length < checklist.items.length);
  assert.ok(compact.items.every((item) => item.kind !== 'informational'));
  const onlyAssess = migrationChecklist(plan, { phases: ['assess'] });
  assert.ok(onlyAssess.items.every((item) => item.phase === 'assess'));
});

test('migrationChecklist：major 不兼容时阻断步骤标 blocked', () => {
  const checklist = migrationChecklist(planMigration({ from: '2.0', to: '1.9' }));
  assert.ok(checklist.counts.blocked >= 1);
  assert.ok(checklist.items.some((item) => item.status === 'blocked' && item.kind === 'blocking'));
});

test('migrationSnapshot：基线 → 当前的标准剧本', () => {
  const snapshot = migrationSnapshot();
  assert.equal(snapshot.from, PROTOCOL_BASELINE);
  assert.equal(snapshot.to, PROTOCOL_CURRENT);
  assert.equal(snapshot.verdict, 'upgrade-required');
  assert.equal(snapshot.feasible, true);
  assert.equal(snapshot.direction, 'upgrade');
  assert.equal(snapshot.gainedFeatures.length, 15);
  assert.equal(snapshot.gainedMethods.length, 29);
  assert.equal(snapshot.batches.length, 2);
  assert.equal(snapshot.phases.length, 6);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{8}$/);
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.equal(wire.gainedFeatures.length, 15);
});

test('planUpgradeFrom：闸门拒绝用的紧凑计划，JSON 安全且含批次', () => {
  const plan = planUpgradeFrom({ protocol: '1.8' }, { features: ['video'] });
  assert.equal(plan.from, '1.8');
  assert.equal(plan.to, PROTOCOL_CURRENT);
  assert.equal(plan.verdict, 'upgrade-required');
  assert.equal(plan.feasible, true);
  assert.equal(plan.upgradeRequired, true);
  assert.deepEqual([...plan.gainedFeatures], ['video']);
  assert.equal(plan.requiredVersion, '1.9');
  assert.ok(plan.batches.length >= 3);
  assert.ok(plan.steps.length <= 10);
  assert.match(plan.fingerprint, /^[0-9a-f]{8}$/);
  const wire = JSON.parse(JSON.stringify(plan));
  assert.equal(wire.gainedFeatures[0], 'video');
  assert.equal(typeof wire.summary, 'string');
  // 已满足的对端：不需要升级
  const satisfied = planUpgradeFrom({ protocol: '1.9' }, { features: ['video'] });
  assert.equal(satisfied.verdict, 'compatible');
  assert.equal(satisfied.upgradeRequired, false);
  // 字符串/数字/空输入都安全
  assert.equal(planUpgradeFrom('1.8', { features: ['video'] }).from, '1.8');
  assert.equal(planUpgradeFrom(null, { features: ['video'] }).verdict, 'unknown');
});

test('explainMigration / nextMigrationSteps：面向执行面的文本与下一步', () => {
  const plan = planMigration({ from: '1.8', to: '1.9' });
  const lines = explainMigration(plan);
  assert.ok(lines.length > 6);
  assert.match(lines[0], /1\.8 → 1\.9/);
  assert.ok(lines.some((line) => line.includes('评估现状')));
  const next = nextMigrationSteps(plan, 3);
  assert.equal(next.length, 3);
  for (const item of next) assert.notEqual(item.status, 'done');
  const allNext = nextMigrationSteps(plan, 1000);
  assert.ok(allNext.every((item) => item.kind !== 'informational'));
});

test('计划冻结性与确定性：同输入同指纹、结构冻结', () => {
  const first = planMigration({ from: '1.8', to: '1.9' });
  const second = planMigration({ from: '1.8', to: '1.9' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.phases));
  assert.ok(Object.isFrozen(first.features));
  assert.ok(Object.isFrozen(first.methods));
  assert.ok(Object.isFrozen(first.blockers));
  const proof = proofOf('video.start');
  const row = first.methods.find((entry) => entry.method === 'video.start');
  assert.equal(row.risk, 'risky');
  assert.equal(row.replayable, proof.replayable);
  assert.deepEqual([...row.postconditions], [...proof.post]);
});
