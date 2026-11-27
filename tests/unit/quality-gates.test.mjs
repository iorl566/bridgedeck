// tests/unit/quality-gates.test.mjs —— 四个门禁 gate 的直接行为测试。
//
// 这里不经过 CLI，直接调用 gate.run(ctx)：
// 1) 每个 gate 在真实模块上都应 PASS（否则产品/门禁回归）；
// 2) 关键检查项必须存在（防止检查被删掉后仍然"PASS"）；
// 3) 负控制必须有效（flaky 样本被抓、坏 finding 被审计）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATE as DETERMINISM_GATE, FINGERPRINT_TARGETS, buildFingerprintSuite, evaluateTarget } from '../../tools/quality/gates/determinism.mjs';
import { GATE as IDEMPOTENCY_GATE } from '../../tools/quality/gates/idempotency.mjs';
import { GATE as EXPLAINABILITY_GATE } from '../../tools/quality/gates/explainability.mjs';
import { GATE as ANTIFRAGILITY_GATE } from '../../tools/quality/gates/antifragility.mjs';
import { buildHarFixture, buildRawReplayEntries, replayPlanOptionVariants, buildTraceFixture } from '../../tools/quality/lib/fixtures.mjs';
import { buildHarReplayPlan, compareReplayRuns, executeHarReplayPlan } from '../../lib/har-plan.mjs';
import { compactTrace, planTraceExport } from '../../lib/trace-budget.mjs';
import { fingerprint } from '../../tools/quality/lib/canonical.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CTX = { root: ROOT, seed: 'quality-test', repeats: 3, timeoutMs: 20000 };

function summarize(findings) {
  const blocking = findings.filter((finding) => finding.ok === false && finding.severity === 'blocking');
  return { blocking, count: findings.length, ids: findings.map((finding) => finding.id) };
}

test('gate 元数据：四个 gate 的 id/title/consumes/run 合法且唯一', () => {
  const gates = [DETERMINISM_GATE, IDEMPOTENCY_GATE, EXPLAINABILITY_GATE, ANTIFRAGILITY_GATE];
  assert.deepEqual(gates.map((gate) => gate.id), ['determinism', 'idempotency', 'explainability', 'antifragility']);
  for (const gate of gates) {
    assert.equal(typeof gate.title, 'string');
    assert.ok(gate.title.length >= 6);
    assert.equal(typeof gate.run, 'function');
    assert.ok(Array.isArray(gate.consumes) && gate.consumes.length >= 2, gate.id + ' 的 consumes 过少');
    for (const item of gate.consumes) assert.match(item, /\.mjs$/);
  }
});

test('确定性 gate：真实模块上全部通过，且跨进程/探测器负控制都在', async () => {
  const findings = await DETERMINISM_GATE.run({ ...CTX, repeats: 3 });
  const summary = summarize(findings);
  assert.deepEqual(summary.blocking, [], '确定性门禁出现阻断：' + JSON.stringify(summary.blocking, null, 2));
  assert.ok(summary.count >= FINGERPRINT_TARGETS.length + 5, '检查项过少：' + summary.count);
  for (const target of FINGERPRINT_TARGETS) {
    assert.ok(summary.ids.includes('determinism/target-' + target.name), '缺少目标检查：' + target.name);
  }
  assert.ok(summary.ids.includes('determinism/cross-process'));
  assert.ok(summary.ids.includes('determinism/detector-control'));
  assert.ok(summary.ids.includes('determinism/replay-id-semantics'));
  assert.ok(summary.ids.includes('determinism/executor-equivalence'));
  const crossProcess = findings.find((finding) => finding.id === 'determinism/cross-process');
  assert.equal(crossProcess.ok, true);
  assert.ok(crossProcess.evidence.targets >= FINGERPRINT_TARGETS.length);
  const detector = findings.find((finding) => finding.id === 'determinism/detector-control');
  assert.equal(detector.evidence.flakyDistinct >= 2, true);
});

test('evaluateTarget/buildFingerprintSuite：flaky 被抓、同 seed 稳定、alt seed 夹具不同', () => {
  let counter = 0;
  const flaky = evaluateTarget({ name: 'flaky', build: () => ({ tick: counter += 1 }) }, { repeats: 3 });
  assert.equal(flaky.stable, false);
  assert.ok(flaky.distinctFingerprints.length >= 2);
  const stable = evaluateTarget({ name: 'stable', build: () => ({ v: 1 }) }, { repeats: 3 });
  assert.equal(stable.stable, true);
  assert.equal(stable.distinctFingerprints.length, 1);

  const first = buildFingerprintSuite({ seed: 'suite-a', repeats: 3 });
  const again = buildFingerprintSuite({ seed: 'suite-a', repeats: 3 });
  assert.equal(first.schema, 'bb.quality-fingerprint/1');
  assert.equal(first.seed, 'suite-a');
  assert.equal(first.repeats, 3);
  assert.match(first.digest, /^[0-9a-f]{16}$/);
  assert.equal(first.digest, again.digest);
  assert.deepEqual(Object.keys(first.targets).sort(), FINGERPRINT_TARGETS.map((entry) => entry.name).sort());
  for (const entry of Object.values(first.targets)) assert.equal(entry.stable, true);
  const alt = buildFingerprintSuite({ seed: 'suite-b', repeats: 3 });
  assert.notEqual(fingerprint(alt.fixtures), fingerprint(first.fixtures));
  assert.equal(Object.values(alt.targets).every((entry) => entry.stable === true), true);
});

test('幂等 gate：真实模块上全部通过，且覆盖 replay/账本/DAO/跨进程 token', async () => {
  const findings = await IDEMPOTENCY_GATE.run(CTX);
  const summary = summarize(findings);
  assert.deepEqual(summary.blocking, [], '幂等门禁出现阻断：' + JSON.stringify(summary.blocking, null, 2));
  const ids = new Set(summary.ids);
  for (const required of [
    'idempotency/replay-plan-dedupe',
    'idempotency/replay-repeat-execution',
    'idempotency/ledger-token-scope',
    'idempotency/ledger-repeat-semantics',
    'idempotency/ledger-recovery-gate',
    'idempotency/ledger-wal-replay',
    'idempotency/recipe-dao-write',
    'idempotency/recipe-lock-idempotency',
    'idempotency/run-report-idempotent',
    'idempotency/write-token-model',
    'idempotency/cross-process-token',
    'idempotency/no-effect-classification',
  ]) {
    assert.ok(ids.has(required), '缺少幂等检查：' + required);
  }
  const dedupe = findings.find((finding) => finding.id === 'idempotency/replay-plan-dedupe');
  assert.ok(dedupe.evidence.duplicateSkips >= 1, '夹具没有制造出重复请求：' + JSON.stringify(dedupe.evidence));
  const crossProcess = findings.find((finding) => finding.id === 'idempotency/cross-process-token');
  assert.ok(crossProcess.evidence.tokens >= 2);
});

test('可解释性 gate：真实模块上全部通过，且覆盖分类/信封/真实 CLI/审计负控制', async () => {
  const findings = await EXPLAINABILITY_GATE.run(CTX);
  const summary = summarize(findings);
  assert.deepEqual(summary.blocking, [], '可解释性门禁出现阻断：' + JSON.stringify(summary.blocking, null, 2));
  const ids = new Set(summary.ids);
  for (const required of [
    'explainability/taxonomy-coverage',
    'explainability/quality-codes',
    'explainability/retry-consistency',
    'explainability/cli-envelope',
    'explainability/cli-render-real',
    'explainability/renderable-findings',
    'explainability/gate-codes-registered',
    'explainability/audit-control',
    'explainability/quality-code-render',
  ]) {
    assert.ok(ids.has(required), '缺少可解释性检查：' + required);
  }
  const cli = findings.find((finding) => finding.id === 'explainability/cli-render-real');
  assert.equal(cli.ok, true);
  assert.equal(cli.evidence.code, 'E_ARG_USAGE');
});

test('反脆弱 gate：真实模块上全部通过，且覆盖超时/取消/预算/降级/清理', async () => {
  const findings = await ANTIFRAGILITY_GATE.run(CTX);
  const summary = summarize(findings);
  assert.deepEqual(summary.blocking, [], '反脆弱门禁出现阻断：' + JSON.stringify(summary.blocking, null, 2));
  const ids = new Set(summary.ids);
  for (const required of [
    'antifragility/harness-timeout',
    'antifragility/harness-cancel',
    'antifragility/harness-budget',
    'antifragility/harness-failure-control',
    'antifragility/harness-leak-control',
    'antifragility/replay-cancellation',
    'antifragility/replay-structured-failure',
    'antifragility/trace-budget-exhaustion',
    'antifragility/ledger-degraded-write',
    'antifragility/temp-dir-cleanup',
    'antifragility/structured-failure-limits',
    'antifragility/budget-meter',
    'antifragility/zombie-handles',
  ]) {
    assert.ok(ids.has(required), '缺少反脆弱检查：' + required);
  }
});

test('replay 计划：幂等模式去重且两次执行等价（门禁语义的独立复核）', async () => {
  const entries = buildRawReplayEntries('quality-test', 12);
  const plan = buildHarReplayPlan(entries, replayPlanOptionVariants()[1].options);
  assert.equal(plan.entries.length, new Set(plan.entries.map((entry) => entry.replayId)).size);
  assert.ok(plan.skipped.some((item) => item.reason === 'non-idempotent' || item.reason === 'duplicate'));
  const sent = [];
  const send = async (request) => {
    sent.push(request.url);
    return { status: 200, body: 'ok' };
  };
  const first = await executeHarReplayPlan(plan, send);
  const firstCount = sent.length;
  const second = await executeHarReplayPlan(plan, send);
  assert.equal(sent.length - firstCount, firstCount);
  assert.equal(compareReplayRuns(first, second).identical, true);
});

test('trace 预算：极小预算仍终止、有证据、输入不变（独立复核）', () => {
  const trace = buildTraceFixture('quality-test');
  const before = fingerprint(trace);
  const plan = planTraceExport(trace, { maxEvents: 40, maxSpans: 4, maxSteps: 3, maxBytes: 8 * 1024 });
  assert.ok(Array.isArray(plan.actions));
  const compacted = compactTrace(trace, { maxEvents: 40, maxSpans: 4, maxSteps: 3, maxBytes: 8 * 1024, force: true });
  assert.ok(['full', 'compact', 'sampled', 'minimal'].includes(compacted.plan.level));
  assert.equal(fingerprint(trace), before, 'compactTrace 修改了输入 trace');
});

test('夹具：同 seed 逐字节一致，不同 seed 不同', () => {
  assert.equal(fingerprint(buildHarFixture('a')), fingerprint(buildHarFixture('a')));
  assert.notEqual(fingerprint(buildHarFixture('a')), fingerprint(buildHarFixture('b')));
  assert.equal(fingerprint(buildTraceFixture('a')), fingerprint(buildTraceFixture('a')));
  assert.notEqual(fingerprint(buildTraceFixture('a')), fingerprint(buildTraceFixture('b')));
});
