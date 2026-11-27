import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_SCHEMA,
  REQUIRED_AREAS,
  buildReport,
  buildReportBody,
  buildRuntimeTable,
  renderMarkdown,
  renderSummary,
  reportDigest,
  verifyDigest,
  verifyReport,
} from '../../tools/eval/lib/report.mjs';
import { stableStringify } from '../../tools/eval/lib/shrink.mjs';

const CONSUME = {
  file: 'lib/session-queue.mjs',
  symbol: 'createSessionQueue',
  line: 15,
  location: 'lib/session-queue.mjs:15',
  text: 'export function createSessionQueue(...)',
};

function result(overrides = {}) {
  return {
    id: 'session-queue/probe',
    area: 'session-queue',
    title: 'probe',
    status: 'passed',
    source: 'tools/eval/corpus/session-queue.mjs:10',
    generator: { kind: 'integer', name: 'integer(0..1)' },
    checksRun: 10,
    examples: 0,
    failureCount: 0,
    tags: [],
    failures: [],
    consumes: [CONSUME],
    ...overrides,
  };
}

function areasInput() {
  return [
    { area: 'eval-kernel', title: 'kernel', source: 'k', properties: 0 },
    ...REQUIRED_AREAS.map((area) => ({ area, title: area, source: 's', properties: 1 })),
  ];
}

function reportInput(overrides = {}) {
  return {
    seed: 0x0b12d6e5,
    cases: 10,
    results: [result()],
    areas: areasInput(),
    determinism: { verified: true, mismatches: [] },
    audits: { filesScanned: 2, forbiddenCalls: [] },
    gate: { mode: 'check', ok: true },
    ...overrides,
  };
}

test('buildReport：schema/digest/summary/runtime 均成型且 digest 可校验', () => {
  const report = buildReport(reportInput());
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.seed, 0x0b12d6e5);
  assert.equal(report.cases, 10);
  assert.equal(typeof report.digest, 'number');
  assert.equal(verifyDigest(report).ok, true);
  assert.equal(report.summary.properties, 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.checks, 10);
  assert.equal(report.summary.runtimeSymbols, 1);
  assert.equal(report.summary.runtimeModules, 1);
  assert.equal(report.runtime[0].location, 'lib/session-queue.mjs:15');
  assert.deepEqual(report.runtime[0].properties, ['session-queue/probe']);
  assert.equal(report.runtime[0].checks, 10);
  assert.equal(report.properties[0].id, 'session-queue/probe');
});

test('报告确定性：同输入两次 digest 相同、键顺序不敏感', () => {
  const first = buildReport(reportInput());
  const second = buildReport(reportInput());
  assert.equal(first.digest, second.digest);
  assert.equal(stableStringify(first), stableStringify(second));
  const reordered = buildReport({
    ...reportInput(),
    determinism: { mismatches: [], verified: true },
  });
  assert.equal(reordered.digest, first.digest, '对象键顺序改变了 digest');
});

test('verifyReport：结构完好时无 issue，篡改后能定位问题', () => {
  const report = buildReport(reportInput());
  assert.deepEqual(verifyReport(report), []);
  const tampered = { ...report, digest: report.digest + 1 };
  assert(verifyReport(tampered).some((issue) => issue.code === 'E_REPORT_DIGEST'));
  const missingArea = buildReport(reportInput({ areas: [{ area: 'session-queue', title: 'x', source: 's', properties: 1 }] }));
  const areaIssues = verifyReport(missingArea).filter((issue) => issue.code === 'E_REPORT_AREA_MISSING');
  assert.ok(areaIssues.length >= REQUIRED_AREAS.length - 1);
  const failed = buildReport(reportInput({ results: [result({ status: 'failed', failureCount: 1, failed: 1 })] }));
  assert(verifyReport(failed).some((issue) => issue.code === 'E_REPORT_FAILED'));
  const minimal = buildReport(reportInput({
    results: [result({
      status: 'failed',
      failureCount: 1,
      failures: [{ kind: 'case', caseIndex: 0, caseSeed: 1, error: { message: 'x' }, minimalVerified: false, original: null, minimal: null }],
    })],
  }));
  assert(verifyReport(minimal).some((issue) => issue.code === 'E_REPORT_MINIMALITY'));
  const noRuntime = buildReport(reportInput({ results: [result({ consumes: [] })] }));
  assert(verifyReport(noRuntime).some((issue) => issue.code === 'E_REPORT_NO_RUNTIME'));
  const notDeterministic = buildReport(reportInput({ determinism: { verified: false, mismatches: [{ property: 'a/b' }] } }));
  assert(verifyReport(notDeterministic).some((issue) => issue.code === 'E_REPORT_DETERMINISM'));
  const duplicate = buildReport(reportInput({ results: [result(), result()] }));
  assert(verifyReport(duplicate).some((issue) => issue.code === 'E_REPORT_DUPLICATE'));
});

test('runtime 聚合：同 symbol 多 property 合并计数，按 file/line 排序', () => {
  const results = [
    result({ id: 'a/one', area: 'observe-diff', checksRun: 3 }),
    result({ id: 'a/two', area: 'observe-diff', checksRun: 4 }),
    result({
      id: 'a/three',
      area: 'observe-diff',
      checksRun: 1,
      consumes: [{ file: 'lib/observation-delta.mjs', symbol: 'diffObservation', line: 39, location: 'lib/observation-delta.mjs:39', text: '' }],
    }),
  ];
  const table = buildRuntimeTable(results);
  assert.equal(table.length, 2);
  assert.equal(table[0].file, 'lib/observation-delta.mjs');
  assert.equal(table[1].file, 'lib/session-queue.mjs');
  assert.equal(table[1].propertyCount, 2);
  assert.equal(table[1].checks, 7);
  assert.deepEqual(table[1].properties, ['a/one', 'a/two']);
});

test('renderMarkdown：含摘要/覆盖/运行时/property 表与失败反例段', () => {
  const failure = {
    kind: 'case',
    caseIndex: 3,
    caseSeed: 42,
    example: null,
    error: { name: 'EvalAssertionError', code: 'E_EVAL_ASSERT', message: '断链' },
    original: { before: ['a', 'b'], after: ['a'] },
    originalSize: 10,
    minimal: ['a'],
    minimalSize: 3,
    shrinks: 2,
    candidatesTested: 5,
    minimalVerified: true,
    replay: { seed: 1, caseSeed: 42, caseIndex: 3 },
  };
  const report = buildReport(reportInput({
    results: [result({ id: 'observe-diff/probe', area: 'observe-diff', status: 'failed', failureCount: 1, failures: [failure] })],
  }));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# BridgeDeck eval property report/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Area coverage/);
  assert.match(markdown, /## Runtime consumption points \(file:line\)/);
  assert.match(markdown, /## Properties/);
  assert.match(markdown, /## Failures/);
  assert.match(markdown, /## Determinism/);
  assert.match(markdown, /lib\/session-queue\.mjs:15/);
  assert.match(markdown, /observe-diff\/probe/);
  assert.match(markdown, /E_EVAL_ASSERT/);
  assert.match(markdown, /node tools\/eval\/run\.mjs --property observe-diff\/probe/);
  assert.match(markdown, /```json/);
  assert.equal(renderMarkdown(report), renderMarkdown(report), 'Markdown 渲染不稳定');
  const summary = renderSummary(report);
  assert.match(summary, /\[eval\] verdict=FAIL/);
  assert.match(summary, /runtime=/);
});

test('buildReportBody / reportDigest：body 无 digest 字段，digest 是 body 的稳定哈希', () => {
  const body = buildReportBody(reportInput());
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'digest'), false);
  assert.equal(reportDigest(body), reportDigest(buildReportBody(reportInput())));
  assert.equal(REQUIRED_AREAS.includes('vom-geometry'), true);
  assert.equal(REQUIRED_AREAS.length, 5);
});

test('summary 计数：跨 area 汇总与 minimalityViolations', () => {
  const results = [
    result({ id: 'vom-geometry/a', area: 'vom-geometry', checksRun: 5 }),
    result({ id: 'observe-diff/b', area: 'observe-diff', checksRun: 6, examples: 2 }),
    result({
      id: 'intent-ledger/c',
      area: 'intent-ledger',
      status: 'failed',
      checksRun: 7,
      failureCount: 1,
      failures: [{ kind: 'case', caseIndex: 0, caseSeed: 1, error: {}, original: null, minimal: null, minimalVerified: false, minimalized: true }],
    }),
  ];
  const report = buildReport(reportInput({ results }));
  assert.equal(report.summary.properties, 3);
  assert.equal(report.summary.checks, 18);
  assert.equal(report.summary.examples, 2);
  assert.equal(report.summary.failures, 1);
  assert.equal(report.summary.minimalityViolations, 1);
  assert.equal(report.areas.length, 6);
  const area = report.areas.find((item) => item.area === 'intent-ledger');
  assert.equal(area.properties, 1);
  assert.equal(area.failed, 1);
});
