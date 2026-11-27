// tests/unit/eval-e2e.test.mjs —— E2E eval 派生链路：结果解析、元数据归一化、127 兼容、指标门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_E2E_METADATA,
  buildE2EMetadataPayload,
  loadE2EManifest,
  normalizeE2ECase,
  parseE2EResults,
  summarizeCases,
} from '../../lib/eval-e2e.mjs';
import { CAPABILITIES } from '../../lib/eval-e2e-corpus.mjs';
import {
  printMetadata,
  runE2EEvaluation,
} from '../../tools/eval-from-e2e.mjs';

const ROOT = process.cwd();

test('E2E 结果解析 + 缺失 case 为 unverified', () => {
  const results = parseE2EResults('  PASS  23p3. OOPIF — ok\n  FAIL  35d. replaced — bad\n');
  assert.equal(results.get('23p3').ok, true);
  assert.equal(results.get('35d').ok, false);
  const summary = summarizeCases(['23p3', '35d', 'missing'], results);
  assert.equal(summary.checks.length, 2);
  assert.equal(summary.unverified[0].id, 'missing');
});

test('normalizeE2ECase：显式元数据优先，缺失时确定性推导（capability/oracle/expected/evidence）', () => {
  const explicit = normalizeE2ECase({ id: '20d6', title: 'record iframe 事件' }, {
    capability: 'e2e.record',
    oracleLevel: 'e2e-real',
    expectedStatus: 'passed',
    evidenceRule: 'PASS 行必须带 detail',
    adversarial: true,
  });
  assert.equal(explicit.capability, 'e2e.record');
  assert.equal(explicit.evidenceRule, 'PASS 行必须带 detail');
  assert.equal(explicit.adversarial, true);
  assert.equal(explicit.metadataDeclared, true);

  const inferred = normalizeE2ECase({ id: '29d', title: 'ar/he RTL 界面真实渲染' });
  assert.equal(inferred.capability, 'e2e.rtl');
  assert.equal(inferred.oracleLevel, 'e2e-real');
  assert.equal(inferred.expectedStatus, 'passed');
  assert.equal(inferred.metadataDeclared, false);
  assert.ok(inferred.evidenceRule.includes('PASS'));

  const bad = normalizeE2ECase({ id: 'x', title: 'x' }, { capability: 'e2e.unknown', oracleLevel: 'unit' });
  assert.equal(bad.problems.length, 2);
  assert.throws(() => normalizeE2ECase({ title: '无 id' }), /缺少 id/);
});

test('loadE2EManifest：默认 127 条 list 全部带 capability/oracleLevel/expectedStatus/evidence 规则', () => {
  const manifest = loadE2EManifest({ root: ROOT });
  assert.equal(manifest.total, 127);
  assert.equal(manifest.fallbacks, 0, '元数据文件应覆盖全部 127 条');
  assert.ok(manifest.metadataPath);
  assert.ok(manifest.metadataPath.endsWith('e2e-metadata.json'));
  assert.deepEqual(manifest.warnings, []);
  const ids = new Set();
  for (const item of manifest.cases) {
    assert.ok(item.id && item.title, 'case 缺少 id/title');
    ids.add(item.id);
    assert.ok(CAPABILITIES[item.capability], item.id + ' capability 未登记：' + item.capability);
    assert.equal(item.oracleLevel, 'e2e-real');
    assert.equal(item.expectedStatus, 'passed');
    assert.ok(item.evidenceRule.length > 20, item.id + ' evidenceRule 太短');
    assert.equal(item.layer, 'e2e');
  }
  assert.equal(ids.size, 127);
  assert.ok(manifest.cases.filter((item) => item.adversarial).length >= 20, 'adversarial 标记丢失');
});

test('loadE2EManifest：元数据缺失/多余/非法都能被发现（127 兼容不靠静默）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-eval-e2e-'));
  const manifestPath = path.join(dir, 'manifest.json');
  const metadataPath = path.join(dir, 'metadata.json');
  fs.writeFileSync(manifestPath, JSON.stringify([{ id: 'a', title: '记录 iframe 事件' }, { id: 'b', title: '未知标题' }]), 'utf8');
  fs.writeFileSync(metadataPath, JSON.stringify({
    schema: 'bdeval-e2e-metadata/1',
    cases: {
      a: { capability: 'e2e.record', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'rule-a' },
      ghost: { capability: 'e2e.general', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'rule-ghost' },
    },
  }), 'utf8');
  const partial = loadE2EManifest({ root: dir, manifestPath, metadataPath });
  assert.equal(partial.total, 2);
  assert.equal(partial.fallbacks, 1);
  assert.equal(partial.cases[0].capability, 'e2e.record');
  assert.equal(partial.cases[1].capability, 'e2e.general');
  assert.ok(partial.warnings.some((warning) => warning.includes('ghost')));

  // 元数据文件不存在 → 全部回退推导，但仍能加载（向后兼容）。
  const noMetadata = loadE2EManifest({ root: dir, manifestPath, metadataPath: path.join(dir, 'missing.json') });
  assert.equal(noMetadata.fallbacks, 2);
  assert.equal(noMetadata.metadataPath, null);

  // 非法元数据必须抛错，不静默接受。
  fs.writeFileSync(metadataPath, JSON.stringify({ cases: { a: { capability: 'e2e.nope', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'r' } } }), 'utf8');
  assert.throws(() => loadE2EManifest({ root: dir, manifestPath, metadataPath }), /校验失败/);
  fs.writeFileSync(manifestPath, JSON.stringify([{ id: 'a' }, { id: 'a' }]), 'utf8');
  assert.throws(() => loadE2EManifest({ root: dir, manifestPath, metadataPath: path.join(dir, 'missing.json') }), /id 重复/);
});

test('summarizeCases：checks/entries 携带元数据，缺失行仍为 unverified', () => {
  const results = parseE2EResults('  PASS  20b. console ok\n  FAIL  23p3. oopif bad\n');
  const cases = [
    { id: '20b', title: 'console', capability: 'e2e.network', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'rule' },
    { id: '23p3', title: 'oopif', capability: 'e2e.iframe', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'rule' },
    { id: 'missing', title: 'm', capability: 'e2e.general', oracleLevel: 'e2e-real', expectedStatus: 'passed', evidenceRule: 'rule' },
  ];
  const summary = summarizeCases(cases, results);
  assert.equal(summary.checks.length, 2);
  assert.equal(summary.checks[0].capability, 'e2e.network');
  assert.equal(summary.checks[1].ok, false);
  assert.equal(summary.unverified[0].id, 'missing');
  assert.equal(summary.unverified[0].capability, 'e2e.general');
  assert.equal(summary.entries.length, 3);
  assert.deepEqual(summary.entries.map((entry) => entry.status), ['passed', 'failed', 'unverified']);
  assert.equal(summary.entries[2].expectedStatus, 'passed');
  assert.equal(summary.entries[0].evidence.detail, 'console ok');
});

test('buildE2EMetadataPayload：可把派生结果固化成元数据文件（127 条 + e2e-real）', () => {
  const manifest = loadE2EManifest({ root: ROOT });
  const payload = buildE2EMetadataPayload(manifest);
  assert.equal(payload.schema, 'bdeval-e2e-metadata/1');
  assert.equal(payload.count, 127);
  assert.equal(payload.oracleLevel, 'e2e-real');
  assert.equal(Object.keys(payload.cases).length, 127);
  for (const meta of Object.values(payload.cases)) {
    assert.ok(CAPABILITIES[meta.capability]);
    assert.equal(meta.oracleLevel, 'e2e-real');
    assert.equal(meta.expectedStatus, 'passed');
    assert.ok(meta.evidenceRule.length > 20);
  }
  // 固化结果与仓库里的元数据文件保持一致（防止手工漂移）。
  const stored = JSON.parse(fs.readFileSync(path.join(ROOT, DEFAULT_E2E_METADATA), 'utf8'));
  assert.deepEqual(Object.keys(payload.cases).sort(), Object.keys(stored.cases).sort());
  for (const id of Object.keys(stored.cases)) {
    assert.deepEqual(payload.cases[id], stored.cases[id], id + ' 元数据与推导不一致，需要重新 --print-metadata');
  }
});

function passLines(manifest) {
  return manifest.cases.map((item) => '  PASS  ' + item.id + '. detail for ' + item.id).join('\n');
}

test('runE2EEvaluation：全 PASS → 127/127、三态 passed、门禁 PASS（不跑真实 E2E）', async () => {
  const manifest = loadE2EManifest({ root: ROOT });
  const lines = passLines(manifest);
  const { payload, attempts } = await runE2EEvaluation({
    root: ROOT,
    runner: async () => ({ status: 0, stdout: lines, stderr: '' }),
    retries: 0,
  });
  assert.equal(attempts.length, 1);
  assert.equal(payload.status, 'passed');
  assert.equal(payload.ok, true);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.attempts, 1);
  assert.equal(payload.flakyFirstRun, false);
  assert.equal(payload.metadata.total, 127);
  assert.equal(payload.metadata.fallbacks, 0);
  assert.equal(payload.metrics.counts.truePositives, 127);
  assert.equal(payload.metrics.precision, 1);
  assert.equal(payload.metrics.recall, 1);
  assert.equal(payload.metrics.skipRate, 0);
  assert.equal(payload.gate.ok, true, JSON.stringify(payload.gate.failures));
  assert.equal(payload.cases.length, 127);
  assert.ok(payload.cases.every((item) => item.capability && item.oracleLevel && item.evidenceRule));
});

test('runE2EEvaluation：单条 FAIL → 三态 failed、fn 分类 e2e-fail-line、门禁 FAIL', async () => {
  const manifest = loadE2EManifest({ root: ROOT });
  const lines = passLines(manifest).replace('  PASS  20b.', '  FAIL  20b.');
  const { payload } = await runE2EEvaluation({
    root: ROOT,
    runner: async () => ({ status: 1, stdout: lines, stderr: '' }),
    retries: 0,
  });
  assert.equal(payload.status, 'failed');
  assert.equal(payload.ok, false);
  assert.equal(payload.exitCode, 1);
  assert.equal(payload.gate.ok, false);
  assert.ok(payload.gate.failures.includes('false-negatives'));
  assert.ok(payload.gate.failures.includes('unexpected'));
  const fn = payload.metrics.classification.falseNegatives;
  assert.equal(fn.length, 1);
  assert.equal(fn[0].id, '20b');
  assert.equal(fn[0].category, 'e2e-fail-line');
  assert.equal(fn[0].capability, 'e2e.network');
  assert.equal(fn[0].oracleLevel, 'e2e-real');
});

test('runE2EEvaluation：首轮失败、重试通过 → flakyFirstRun 标记且最终 ok', async () => {
  const manifest = loadE2EManifest({ root: ROOT });
  const good = passLines(manifest);
  const bad = good.replace('  PASS  23p3.', '  FAIL  23p3.');
  let call = 0;
  const { payload } = await runE2EEvaluation({
    root: ROOT,
    retries: 1,
    runner: async () => {
      call += 1;
      return call === 1 ? { status: 1, stdout: bad, stderr: '' } : { status: 0, stdout: good, stderr: '' };
    },
  });
  assert.equal(payload.attempts, 2);
  assert.equal(payload.flakyFirstRun, true);
  assert.equal(payload.status, 'passed');
  assert.equal(payload.ok, true);
  assert.equal(payload.firstRunFailures.length, 1);
  assert.equal(payload.firstRunFailures[0].id, '23p3');
});

test('printMetadata：派生 127 条且 fallbacks=0（不执行 E2E 的审计路径）', () => {
  const { payload } = printMetadata({ root: ROOT });
  assert.equal(payload.count, 127);
  assert.equal(payload.fallbacks, 0);
  assert.equal(payload.oracleLevel, 'e2e-real');
  assert.ok(payload.metadataFile.endsWith('e2e-metadata.json'));
  assert.equal(Object.keys(payload.cases).length, 127);
});
