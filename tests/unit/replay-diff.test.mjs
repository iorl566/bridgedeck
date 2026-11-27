// tests/unit/replay-diff.test.mjs —— 回放差异校验：expect/观测/快照/判决聚合。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../../extension/src/lib/replay-diff.js';

test('toleranceProfile / normalizeComparableText', () => {
  assert.equal(D.toleranceProfile('fuzzy').profile, 'fuzzy');
  assert.equal(D.toleranceProfile('missing').profile, 'normalized');
  const custom = D.toleranceProfile({ profile: 'fuzzy', numeric: { rel: 0.5 }, minRatio: 0.8 });
  assert.equal(custom.numeric.rel, 0.5);
  assert.equal(custom.minRatio, 0.8);
  assert.equal(D.normalizeComparableText('  a \n b  ', 'exact'), '  a \n b  ');
  assert.equal(D.normalizeComparableText('  a \n b  ', 'normalized'), 'a b');
  assert.equal(D.normalizeComparableText('ABC', 'fuzzy'), 'abc');
});

test('boundedLevenshtein / textSimilarity', () => {
  assert.equal(D.boundedLevenshtein('kitten', 'sitting'), 3);
  assert.equal(D.boundedLevenshtein('', 'abc'), 3);
  assert.equal(D.boundedLevenshtein('abc', 'abc'), 0);
  assert.equal(D.boundedLevenshtein('a'.repeat(50), 'b'.repeat(50), 5), 6);
  assert.equal(D.textSimilarity('hello', 'hello'), 1);
  assert.equal(D.textSimilarity('hello', 'helo') > 0.7, true);
  assert.equal(D.textSimilarity('', ''), 1);
});

test('compareText：exact/normalized/fuzzy 的 equal 与 tolerated', () => {
  assert.equal(D.compareText('a b', 'a  b', 'normalized').equal, true);
  assert.equal(D.compareText('A', 'a', 'exact').equal, false);
  const fuzzy = D.compareText('hello world', 'hello wor1d', 'fuzzy');
  assert.equal(fuzzy.equal, true);
  assert.equal(fuzzy.tolerated, true);
  const strict = D.compareText('hello world', 'hello wor1d', 'normalized');
  assert.equal(strict.equal, false);
  assert.equal(strict.similarity > 0.8, true);
  assert.equal(D.compareText('a', 'a', 'normalized').tolerated, false);
});

test('compareNumber：精确/容差/非法', () => {
  assert.equal(D.compareNumber(10, 10).equal, true);
  assert.equal(D.compareNumber(10, 10.0001, 'normalized').equal, false);
  const tolerated = D.compareNumber(10, 10.0001, 'fuzzy');
  assert.equal(tolerated.equal, true);
  assert.equal(tolerated.tolerated, true);
  assert.equal(D.compareNumber(10, 'x').equal, false);
  assert.equal(D.compareNumber(10, 'x').kind, 'not-number');
});

test('deepDiff：缺失/多余/类型/值/容差/深度限制', () => {
  const differences = D.deepDiff({ a: 1, b: [1, 2], c: 'x' }, { a: 2, b: [1, 3], d: true });
  const paths = differences.map((item) => item.path);
  assert.equal(paths.includes('a'), true);
  assert.equal(paths.includes('b[1]'), true);
  assert.equal(paths.includes('c'), true);
  assert.equal(paths.includes('d'), true);
  const typeDifference = D.deepDiff({ a: 1 }, { a: '1' });
  assert.equal(typeDifference[0].kind, 'type');
  const tolerated = D.deepDiff({ a: 10 }, { a: 10.0001 }, { tolerance: 'fuzzy' });
  assert.equal(tolerated[0].severity, 'warning');
  const deep = D.deepDiff({ a: { b: { c: { d: 1 } } } }, { a: { b: { c: { d: 2 } } } }, { maxDepth: 1 });
  assert.equal(deep.some((item) => item.kind === 'depth-limit'), true);
});

test('statusMatches / countMatches / attributeMatches / urlIncludes', () => {
  assert.equal(D.statusMatches('2xx', 204).ok, true);
  assert.equal(D.statusMatches('2xx', 404).ok, false);
  assert.equal(D.statusMatches('ok', 404).ok, false);
  assert.equal(D.statusMatches(200, 200).ok, true);
  assert.equal(D.statusMatches({ min: 200, max: 299 }, 204).ok, true);
  assert.equal(D.statusMatches({ min: 200, max: 299 }, 500).ok, false);
  assert.equal(D.statusMatches({ oneOf: [200, 201] }, 201).ok, true);
  assert.equal(D.statusMatches('2xx', 'x').ok, false);

  assert.equal(D.countMatches(3, 3).ok, true);
  assert.equal(D.countMatches([1, 2, 3], 3).ok, true);
  assert.equal(D.countMatches({ min: 2, max: 4 }, 3).ok, true);
  assert.equal(D.countMatches({ equals: 5 }, 3).ok, false);
  assert.equal(D.countMatches({}, 3).ok, false);

  const attributes = { 'data-id': '7', disabled: 'true' };
  assert.equal(D.attributeMatches({ name: 'data-id', value: '7' }, attributes).ok, true);
  assert.equal(D.attributeMatches('data-id=7', attributes).ok, true);
  assert.equal(D.attributeMatches({ name: 'data-id', includes: '7' }, attributes).ok, true);
  assert.equal(D.attributeMatches({ name: 'missing', exists: true }, attributes).ok, false);
  assert.equal(D.attributeMatches({ name: '' }, attributes).ok, false);

  assert.equal(D.urlIncludes('https://a.test/x?y=1#h', '/x?y=1').ok, true);
  assert.equal(D.urlIncludes('https://a.test/x', '/y').ok, false);
  assert.equal(D.urlIncludes('https://a.test/x', '').ok, true);
});

test('checkExpect：全部受支持键 + 未知键 warning + 容差', () => {
  const actual = {
    url: 'https://a.test/next?x=1#frag',
    status: 201,
    selectorValue: 'v',
    text: 'Hello World',
    title: 'Done',
    count: 2,
    exists: true,
    visible: true,
    enabled: true,
    disabled: false,
    checked: true,
    selected: false,
    className: 'btn primary',
    attributes: { 'data-id': '7' },
    html: '<button>go</button>',
    changed: true,
    values: ['a', 'b'],
    rows: 2,
  };
  const expect = {
    urlIncludes: '/next',
    url: 'https://a.test/next?x=1',
    urlStartsWith: 'https://a.test/',
    selectorValue: 'v',
    textIncludes: 'hello',
    text: 'hello world',
    title: 'done',
    status: '2xx',
    count: { min: 1, max: 3 },
    exists: true,
    visible: true,
    enabled: true,
    disabled: false,
    checked: true,
    selected: false,
    classIncludes: 'primary',
    attribute: { name: 'data-id', value: '7' },
    htmlIncludes: 'go',
    changed: true,
    values: ['a', 'b'],
  };
  const result = D.checkExpect(expect, actual, { tolerance: 'fuzzy' });
  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
  assert.equal(result.checked, Object.keys(expect).length);
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.differences.length, 0);

  const failing = D.checkExpect({ text: 'nope', status: 500 }, { text: 'hello', status: 200 });
  assert.equal(failing.ok, false);
  assert.equal(failing.failed, 2);
  assert.equal(failing.differences.length, 2);

  const unsupported = D.checkExpect({ somethingNew: true }, actual);
  assert.equal(unsupported.ok, true);
  assert.equal(unsupported.unsupported.includes('somethingNew'), true);
  assert.equal(unsupported.warnings, 1);
  assert.equal(D.checkExpect(null, actual).ok, true);
});

test('diffTextLines / diffObservation：行级增删与相似度', () => {
  const diff = D.diffTextLines('a\nb\nc', 'a\nc\nd');
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.unchanged, 2);
  assert.equal(diff.similarity <= 1, true);
  assert.equal(diff.operations.some((operation) => operation.op === 'del' && operation.line === 'b'), true);

  const observation = D.diffObservation('line1\nline2', 'line1\nline2\nline3');
  assert.equal(observation.changed, true);
  assert.equal(observation.counts.added, 1);
  assert.equal(observation.counts.removed, 0);
  assert.equal(observation.hunks.length, 1);
  assert.equal(observation.code, 'DIFF_OBSERVATION_CHANGED');

  const same = D.diffObservation('a\nb', 'a\nb');
  assert.equal(same.changed, false);
  assert.equal(same.code, 'DIFF_OK');

  // 大文本走“前缀/后缀近似”分支，仍要有界。
  const many = Array.from({ length: 700 }, (_, index) => 'row-' + index).join('\n');
  const changedMany = many.replace('row-350', 'row-X');
  const bounded = D.diffTextLines(many, changedMany);
  assert.equal(bounded.added.length >= 1, true);
  assert.equal(bounded.removed.length >= 1, true);
});

test('diffSnapshots：added/removed/changed 与节点签名', () => {
  const before = [
    { key: 'a', text: 'x', visible: true },
    { key: 'b', text: 'y', visible: true },
  ];
  const after = [
    { key: 'a', text: 'x', visible: true },
    { key: 'c', text: 'z', visible: true },
    { key: 'b', text: 'y2', visible: true },
  ];
  const diff = D.diffSnapshots(before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.counts.before, 2);
  assert.equal(diff.counts.after, 3);
  assert.equal(diff.code, 'DIFF_SNAPSHOT_CHANGED');
  assert.equal(D.diffSnapshots(before, before).code, 'DIFF_OK');
  assert.equal(D.snapshotNodeKey({ selector: '#a' }).startsWith('k'), true);
  assert.equal(D.snapshotNodeSignature({ visible: false, role: 'button', name: 'x' }).includes('hidden'), true);
});

test('validateStepOutcome：缺失/报错/预期失败/观测变化/成功', () => {
  const missing = D.validateStepOutcome({}, null);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DIFF_MISSING_ACTUAL');

  const errored = D.validateStepOutcome({}, { ok: false, error: 'boom' });
  assert.equal(errored.ok, false);
  assert.equal(errored.checks.some((check) => check.code === 'DIFF_OUTCOME_ERROR'), true);

  const expectFail = D.validateStepOutcome({ expect: { text: 'hi' } }, { ok: true, text: 'bye' });
  assert.equal(expectFail.ok, false);
  assert.equal(expectFail.severity, 'fail');
  assert.equal(expectFail.differences[0].path, 'expect.text');

  const observe = D.validateStepOutcome({ kind: 'observe', method: 'observe-text' }, { ok: true, before: 'a\nb', after: 'a\nc' });
  assert.equal(observe.ok, true);
  assert.equal(observe.observation.changed, true);
  assert.equal(observe.checks.some((check) => check.code === 'DIFF_OBSERVATION_CHANGED'), true);

  const passed = D.validateStepOutcome({ expect: { text: 'hi' } }, { ok: true, text: 'hi' });
  assert.equal(passed.ok, true);
  assert.equal(passed.severity, 'pass');
  assert.equal(passed.code, 'DIFF_OK');
});

test('aggregateOutcomes / verdictForPlan：统计、首次失败与分叉位置', () => {
  const aggregate = D.aggregateOutcomes([
    { index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' },
    { index: 1, ok: false, severity: 'fail', code: 'DIFF_VALUE_MISMATCH' },
    { index: 2, ok: true, severity: 'warning', code: 'DIFF_UNSUPPORTED_EXPECTATION' },
  ]);
  assert.equal(aggregate.total, 3);
  assert.equal(aggregate.passed, 1);
  assert.equal(aggregate.warned, 1);
  assert.equal(aggregate.failed, 1);
  assert.equal(aggregate.firstFailureIndex, 1);
  assert.equal(aggregate.severity, 'fail');
  assert.equal(aggregate.byCode.DIFF_VALUE_MISMATCH, 1);
  assert.equal(D.aggregateOutcomes([]).ok, true);

  const plan = { steps: [{ index: 0, ref: 'r0', kind: 'action' }, { index: 1, ref: 'r1', kind: 'action' }, { index: 2, ref: 'r2', kind: 'action' }] };
  const verdict = D.verdictForPlan(plan, [{ index: 0, ok: true, severity: 'pass', code: 'DIFF_OK' }, { index: 1, ok: false, severity: 'fail', code: 'X' }]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.divergedAt, 1);
  assert.equal(verdict.missing, 1);
  assert.equal(verdict.verdicts[2].status, 'missing');
  assert.equal(verdict.aggregate.total, 3);
  const strict = D.verdictForPlan(plan, [], { requireAll: true });
  assert.equal(strict.ok, false);
  assert.equal(D.verdictForPlan(plan, [], {}).missing, 3);
});

test('maxSeverity / isAcceptableDifference / summarizeDifferences / 签名与相似度', () => {
  assert.equal(D.maxSeverity(['pass', 'warning', 'fail']), 'fail');
  assert.equal(D.maxSeverity(['pass', 'info']), 'info');
  assert.equal(D.maxSeverity([]), 'pass');
  assert.equal(D.isAcceptableDifference({ kind: 'truncated' }), true);
  assert.equal(D.isAcceptableDifference({ severity: 'warning' }), true);
  assert.equal(D.isAcceptableDifference({ expected: 10, actual: 10.0001, severity: 'fail' }, 'fuzzy'), true);
  assert.equal(D.isAcceptableDifference({ expected: 'a', actual: 'b', severity: 'fail' }, 'fuzzy'), false);

  const summary = D.summarizeDifferences([
    { path: 'b', kind: 'value', severity: 'fail', expected: 'x'.repeat(300), actual: 2 },
    { path: 'a', kind: 'missing', severity: 'warning' },
  ], 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.severity, 'fail');
  assert.equal(summary.top.length, 1);
  assert.equal(summary.counts.fail, 1);
  assert.equal(summary.top[0].expected.length <= 120, true);

  assert.equal(D.diffSignature([{ path: 'a', kind: 'value', severity: 'fail' }]).length, 8);
  assert.equal(D.observationSimilarity('abc', 'abc'), 1);
  assert.equal(D.observationSimilarity('abc', 'xyz') < 0.5, true);
});
