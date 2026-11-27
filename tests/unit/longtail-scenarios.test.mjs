// tests/unit/longtail-scenarios.test.mjs —— 四个预算场景在 smoke 规模下真实跑通（真实模块消费）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeBudget, evaluateBudget, resolveScale } from '../../tools/longtail/lib/budget.mjs';
import { isInsideRepo } from '../../tools/longtail/lib/tmpdir.mjs';
import * as pageScenario from '../../tools/longtail/scenarios/page-vom.mjs';
import * as harScenario from '../../tools/longtail/scenarios/har-merge.mjs';
import * as recordScenario from '../../tools/longtail/scenarios/record-program.mjs';
import * as videoScenario from '../../tools/longtail/scenarios/video-manifest.mjs';

const MODULES = [pageScenario, harScenario, recordScenario, videoScenario];
const SMOKE_SEED = 12345;
const CACHE = new Map();

async function smokeRun(module, overrides = {}) {
  const id = module.SCENARIO.id;
  if (!overrides.keepTmp && CACHE.has(id)) return CACHE.get(id);
  const result = await module.run({ scale: 'smoke', seed: SMOKE_SEED, ...overrides });
  if (!overrides.keepTmp) CACHE.set(id, result);
  return result;
}

test('SCENARIO 元数据与预算规格结构', () => {
  const ids = MODULES.map((module) => module.SCENARIO.id);
  assert.deepEqual(ids, ['page-vom', 'har-merge', 'record-program', 'video-manifest']);
  assert.equal(new Set(ids).size, ids.length);
  for (const module of MODULES) {
    assert.equal(typeof module.SCENARIO.title, 'string');
    assert.ok(module.SCENARIO.title.length > 4);
    assert.ok(Array.isArray(module.SCENARIO.requires) && module.SCENARIO.requires.length > 0);
    assert.ok(Array.isArray(module.REAL_MODULE_CALLS) && module.REAL_MODULE_CALLS.length >= 7);
    for (const call of module.REAL_MODULE_CALLS) {
      assert.match(call, /\.m?js#/);
    }
    assert.equal(typeof module.run, 'function');
    const budget = normalizeBudget(module.budgetFor(resolveScale('smoke')));
    assert.ok(budget.checks.length >= 15, module.SCENARIO.id + ' checks=' + budget.checks.length);
    assert.ok(budget.timeMs > 0);
    assert.ok(budget.memoryMb > 0);
    assert.match(budget.fingerprint, /^[0-9a-f]{16}$/);
    const defaultBudget = normalizeBudget(module.budgetFor(resolveScale('default')));
    assert.ok(defaultBudget.timeMs >= budget.timeMs, 'default 预算不应低于 smoke');
  }
});

test('smoke 全场景：内置预算判定通过 + tmpOnly + 确定性', async () => {
  for (const module of MODULES) {
    const result = await smokeRun(module);
    assert.equal(result.ok, true, module.SCENARIO.id + ' ok');
    assert.equal(result.scale, 'smoke');
    assert.equal(result.seed, String(SMOKE_SEED));
    assert.equal(result.metrics.tmpOnly, true, module.SCENARIO.id + ' tmpOnly');
    assert.equal(result.metrics.deterministic, true, module.SCENARIO.id + ' deterministic');
    assert.equal(result.metrics.evidenceCalls, module.REAL_MODULE_CALLS.length);
    assert.match(result.evidence.fixture.fingerprint, /^[0-9a-f]{16}$/);
    assert.ok(result.metrics.timeMs > 0);
    assert.ok(result.metrics.peakRssMb > 0);
    assert.ok(result.metrics.peakHeapUsedMb >= 0);
    const verdict = evaluateBudget({
      budget: module.budgetFor(resolveScale('smoke')),
      metrics: result.metrics,
      evidence: result.evidence,
    });
    assert.equal(verdict.level, 'pass', module.SCENARIO.id + ' failures=' + JSON.stringify(verdict.failures));
    assert.equal(verdict.ok, true);
  }
});

test('默认会清理 tmp 工作区（仓库无大文件）', async () => {
  for (const module of MODULES) {
    const result = await smokeRun(module);
    assert.equal(result.keptTmp, false);
    assert.equal(result.tmpDir, null);
    const tmp = result.evidence.fixture.tmp;
    assert.equal(isInsideRepo(tmp), false);
    assert.equal(fs.existsSync(tmp), false, module.SCENARIO.id + ' 的 tmp 工作区应被清理：' + tmp);
  }
});

test('同 seed 二次运行：夹具指纹一致（跨运行确定性）', async () => {
  for (const module of MODULES) {
    const first = await smokeRun(module);
    const second = await module.run({ scale: 'smoke', seed: SMOKE_SEED });
    assert.equal(second.evidence.fixture.fingerprint, first.evidence.fixture.fingerprint, module.SCENARIO.id);
    assert.deepEqual(second.evidence.fixture.files, first.evidence.fixture.files);
    assert.equal(second.metrics.tmpOnly, true);
  }
});

test('keepTmp 保留 tmp 目录且允许人工检查', async () => {
  const result = await pageScenario.run({ scale: 'smoke', seed: 999, keepTmp: true });
  try {
    assert.equal(result.keptTmp, true);
    assert.equal(typeof result.tmpDir, 'string');
    assert.equal(isInsideRepo(result.tmpDir), false);
    assert.ok(fs.existsSync(result.tmpDir));
    assert.ok(fs.existsSync(path.join(result.tmpDir, 'page', 'graph.json')));
    assert.equal(result.metrics.tmpOnly, true);
  } finally {
    fs.rmSync(result.tmpDir, { recursive: true, force: true });
  }
});

test('page-vom：元素/边/帧/预算证据', async () => {
  const result = await smokeRun(pageScenario);
  const scale = resolveScale('smoke');
  assert.ok(result.metrics.refs >= scale.page.refs);
  assert.ok(result.metrics.maxDepth >= scale.page.depth);
  assert.equal(result.metrics.frames, scale.page.frames);
  assert.ok(result.metrics.edges >= result.metrics.refs);
  assert.equal(result.metrics.graphTruncated, false, 'smoke 夹具小于 600 节点，不应截断');
  assert.ok(result.metrics.graphDefaultNodes >= scale.page.refs);
  assert.ok(result.metrics.relations >= Math.floor(scale.page.refs * 0.5));
  assert.ok(result.metrics.frameLinks >= scale.page.frames - 1);
  assert.equal(result.metrics.depthGaps, 0);
  assert.ok(result.metrics.depthMaxDepth >= 2);
  assert.ok(result.metrics.budgetTrimmed > 0);
  assert.ok(result.metrics.fixtureBytes > 0);
  assert.equal(result.evidence.moduleOutputs.relationStats.relations, result.metrics.relations);
  assert.equal(result.evidence.probes.overBudget.level, 'fail');
});

test('har-merge：合并/归因/往返/探针证据', async () => {
  const result = await smokeRun(harScenario);
  const scale = resolveScale('smoke');
  assert.ok(result.metrics.sourceBytes >= scale.har.minBytes);
  assert.equal(result.metrics.sourceCount, scale.har.sources);
  assert.ok(result.metrics.keptEntries > 0);
  assert.ok(result.metrics.duplicates > 0);
  assert.ok(result.metrics.conflicts > 0);
  assert.equal(result.metrics.validationErrors, 0);
  assert.ok(result.metrics.explainedIssues > 0);
  assert.ok(result.metrics.fullRows >= result.metrics.keptEntries * 0.5);
  assert.equal(result.metrics.auditOk, true);
  assert.equal(result.metrics.auditViolations, 0);
  assert.equal(result.metrics.roundTripEntryDiffs, 0);
  assert.ok(result.metrics.streamingCount > 0);
  assert.ok(result.metrics.frameCount >= 2);
  assert.equal(result.metrics.probesOk, true);
  assert.deepEqual(result.evidence.probes.har.map((probe) => probe.name), ['missing-request-url', 'bad-status', 'bad-timing', 'duplicate-page-id', 'timings-sum-mismatch']);
  assert.equal(result.evidence.probes.parse.code, 'unparsable-json');
  assert.equal(result.evidence.probes.nonHar[0].code, 'not-har');
  assert.ok(result.evidence.merge.conflictsByKind && Object.keys(result.evidence.merge.conflictsByKind).length > 0);
});

test('record-program：规模/校验/预检/探针证据', async () => {
  const result = await smokeRun(recordScenario);
  const scale = resolveScale('smoke');
  assert.ok(result.metrics.steps >= scale.record.steps);
  assert.ok(result.metrics.boundaries >= scale.record.boundaries);
  assert.ok(result.metrics.segments >= scale.record.boundaries + 1);
  assert.ok(result.metrics.loops >= scale.record.loops);
  assert.ok(result.metrics.humanGates >= scale.record.humanGates);
  assert.equal(result.metrics.validateErrors, 0);
  assert.equal(result.metrics.strictBlockersMatch, true);
  assert.equal(result.metrics.strictBlockerCodesOk, true);
  assert.equal(result.metrics.allowedBlockers, 0);
  assert.ok(result.metrics.allowedWarnings > 0);
  assert.equal(result.metrics.fingerprintStable, true);
  assert.ok(result.metrics.diffOps > 0);
  assert.equal(result.metrics.probesOk, true);
  assert.deepEqual(result.evidence.probes.record.map((probe) => probe.ok), [true, true, true, true, true]);
});

test('video-manifest：分片/校验和/seal/恢复/探针证据', async () => {
  const result = await smokeRun(videoScenario);
  const scale = resolveScale('smoke');
  assert.ok(result.metrics.segments >= scale.video.segments);
  assert.equal(result.metrics.checksumMatches, result.metrics.segments, '从磁盘重算的校验和必须全部一致');
  assert.equal(result.metrics.validateErrors, 0);
  assert.equal(result.metrics.digestValid, true);
  assert.ok(result.metrics.digestCount >= 2);
  assert.equal(result.metrics.durabilityVerified, true);
  assert.equal(result.metrics.recoveryCasesOk, true);
  assert.equal(result.metrics.completeKept, result.metrics.segments);
  assert.ok(result.metrics.partialKept > 0);
  assert.ok(result.metrics.truncatedKept > 0);
  assert.ok(result.metrics.corruptKept > 0);
  assert.equal(result.metrics.unlistedCompleteness, 'complete');
  assert.equal(result.metrics.noPartsCompleteness, 'failed');
  assert.equal(result.metrics.sealedAppendRejected, true);
  assert.equal(result.metrics.sealInvalidProbeOk, true);
  assert.equal(result.metrics.noPartsProbeOk, true);
  assert.equal(result.metrics.recordChunkCount, result.metrics.segments);
  assert.equal(result.metrics.recordFragments, result.metrics.segments);
  const caseNames = result.evidence.recovery.cases.map((item) => item.name);
  assert.deepEqual(caseNames, ['complete', 'missing-middle', 'truncated', 'checksum-mismatch', 'unlisted-part', 'no-parts']);
  assert.ok(result.evidence.recovery.cases.every((item) => item.ok));
});
