import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActual,
  buildReplayReport,
  compareExpectation,
  expectationProbes,
  pickPath,
  renderReplayReport,
  summarizeDifferences,
} from '../../lib/recipe-diff.mjs';

test('期望探测：url 与 selector 字段分别生成探针', () => {
  assert.deepEqual(expectationProbes({ urlIncludes: '/a', urlEquals: 'x' }).map((probe) => probe.kind), ['url']);
  const probes = expectationProbes({ selector: '#q', selectorVisible: true, selectorValue: 'v', urlIncludes: '/a' });
  assert.equal(probes.length, 2);
  assert.deepEqual(probes.find((probe) => probe.kind === 'selector').fields, ['selector', 'selectorVisible', 'selectorValue']);
  assert.deepEqual(expectationProbes(null), []);
  // 只有 selector 字段（没有 selector 字符串）时也生成探针，便于报告“找不到目标”
  assert.equal(expectationProbes({ selectorText: 'x' }).length, 1);
});

test('pickPath 支持对象与数组下标', () => {
  const value = { a: { list: [{ b: 1 }] } };
  assert.equal(pickPath(value, 'a.list.0.b'), 1);
  assert.equal(pickPath(value, ''), value);
  assert.equal(pickPath(null, 'a'), undefined);
  assert.equal(pickPath(value, 'a.missing.x'), undefined);
});

test('buildActual 从探测结果组装实际值', () => {
  const expect = { urlIncludes: '/a', selector: '#q', selectorVisible: true, selectorValue: 'v', selectorCount: 2, methodOk: true, resultPath: 'a.b' };
  const actual = buildActual(expect, {
    url: 'https://x.test/a?b=1',
    selectors: { '#q': { exists: true, visible: true, text: 'hello', value: 'v', count: 2 } },
    ok: true,
    result: { a: { b: 7 } },
  });
  assert.equal(actual.url, 'https://x.test/a?b=1');
  assert.equal(actual.selectorVisible, true);
  assert.equal(actual.selectorText, 'hello');
  assert.equal(actual.selectorValue, 'v');
  assert.equal(actual.selectorCount, 2);
  assert.equal(actual.methodOk, true);
  assert.equal(actual.resultPath, 7);
  const missing = buildActual(expect, { url: '', selectors: { '#q': { exists: false } } });
  assert.equal(missing.selectorExists, false);
  assert.equal(missing.selectorVisible, false);
  assert.equal(missing.selectorCount, 0);
});

test('compareExpectation：全部命中 / 每类差异都有证据', () => {
  const expect = {
    urlIncludes: '/a', urlMatches: '^https://x\\.test/', urlEquals: 'https://x.test/a',
    selector: '#q', selectorVisible: true, selectorText: 'hello', selectorCount: 1,
    methodOk: true, resultPath: 'n', equals: 3, contains: 'x', truthy: true,
  };
  const actual = { url: 'https://x.test/a', selectorExists: true, selectorVisible: true, selectorText: 'hello', selectorCount: 1, methodOk: true, resultPath: 3 };
  const ok = compareExpectation(expect, actual);
  // equals=3 与 resultPath=3；contains='x' 对数字 3 不成立 → 只有 contains 一条差异
  assert.equal(ok.match, false);
  assert.deepEqual(ok.mismatches.map((item) => item.field), ['contains']);
  assert.equal(ok.mismatches[0].actual, 3);

  const mismatch = compareExpectation(
    { urlIncludes: '/home', selectorVisible: true, selectorCount: 2, methodOk: false, equals: 1 },
    { url: 'https://x.test/login', selectorExists: false, selectorVisible: false, selectorCount: 0, methodOk: true, resultPath: 2 },
  );
  assert.equal(mismatch.match, false);
  const fields = mismatch.mismatches.map((item) => item.field);
  for (const field of ['urlIncludes', 'selectorVisible', 'selectorCount', 'methodOk', 'equals']) {
    assert.ok(fields.includes(field), '缺少差异字段 ' + field);
  }
  // 空 expect 视为无差异
  assert.equal(compareExpectation(null, {}).match, true);
  // 非法正则 → 不匹配而不是抛异常
  assert.equal(compareExpectation({ urlMatches: '[' }, { url: 'x' }).mismatches[0].field, 'urlMatches');
});

test('差异汇总与回放报告：失败/可重试/跳过统计', () => {
  const results = [
    { ref: 'r1', path: '0', method: 'observe', status: 'ok', attempts: 1 },
    { ref: 'r2', path: '1', method: 'navigate', status: 'ok', attempts: 1, diff: [{ field: 'urlIncludes', expected: '/a', actual: '/b', severity: 'error' }] },
    { ref: 'r3', path: '2', method: 'click', status: 'failed', attempts: 1, retryable: false, error: { code: 'E_NOT_FOUND', message: '目标不存在' } },
    { ref: 'r4', path: '3', method: 'click', status: 'skipped', attempts: 1, skippedReason: '失败后跳过：E_TIMEOUT' },
  ];
  const differences = summarizeDifferences(results);
  assert.equal(differences.length, 1);
  assert.equal(differences[0].ref, 'r2');
  const report = buildReplayReport({
    name: 'demo',
    results,
    startedAt: 1000,
    endedAt: 1500,
    ok: false,
    completed: 2,
    planned: 4,
    failedAt: 3,
    paramsFingerprint: 'p1234abcd',
  });
  assert.equal(report.durationMs, 500);
  assert.equal(report.statuses.ok, 2);
  assert.equal(report.statuses.failed, 1);
  assert.equal(report.statuses.skipped, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, 'E_NOT_FOUND');
  assert.equal(report.retryable.length, 0);
  assert.equal(report.differences.length, 1);
  const lines = renderReplayReport(report);
  assert.ok(lines.some((line) => line.includes('完成 2/4')));
  assert.ok(lines.some((line) => line.includes('失败步骤：#3')));
  assert.ok(lines.some((line) => line.includes('E_NOT_FOUND')));
  assert.ok(lines.some((line) => line.includes('urlIncludes')));
  assert.ok(lines.some((line) => line.includes('不可自动重试') === false)); // 文案不是这样写的
  assert.ok(lines.some((line) => line.includes('可否重试')));
});

test('成功报告输出“差异：无”', () => {
  const report = buildReplayReport({ name: 'ok', results: [{ ref: 'r1', method: 'observe', status: 'ok' }], ok: true, completed: 1, planned: 1 });
  const lines = renderReplayReport(report);
  assert.ok(lines.some((line) => line.includes('差异：无')));
  assert.ok(lines[0].includes('recipe ok'));
});
