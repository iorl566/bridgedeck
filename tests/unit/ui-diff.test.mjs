// tests/unit/ui-diff.test.mjs —— extension/ui/lib/diff.js 差异算法单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareCaptureRuns,
  compareEventSequences,
  diffLines,
  diffSequences,
  diffStats,
  diffWords,
  keyedDiff,
  lineRangeLabel,
  sideBySide,
  splitLines,
  splitWords,
  stripCommon,
  unifiedHunks,
} from '../../extension/ui/lib/diff.js';

test('splitLines / splitWords：换行与 CJK 切分', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines(null), []);
  assert.deepEqual(splitWords('a b'), ['a', 'b'], '空白不是单词 token');
  assert.deepEqual(splitWords('a, b'), ['a', ',', 'b']);
  assert.deepEqual(splitWords('你好'), ['你', '好']);
  assert.deepEqual(splitWords(''), []);
});

test('stripCommon：公共前后缀', () => {
  assert.deepEqual(stripCommon(['a', 'b', 'c'], ['a', 'x', 'c']), {
    prefix: 1,
    suffix: 1,
    leftMiddle: ['b'],
    rightMiddle: ['x'],
  });
  assert.deepEqual(stripCommon([], ['x']), { prefix: 0, suffix: 0, leftMiddle: [], rightMiddle: ['x'] });
  assert.deepEqual(stripCommon(['a'], ['a']), { prefix: 1, suffix: 0, leftMiddle: [], rightMiddle: [] });
});

test('diffSequences：等/删/增与索引', () => {
  const ops = diffSequences(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(ops.map((op) => op.type), ['equal', 'delete', 'equal']);
  assert.deepEqual(ops[1], { type: 'delete', aIndex: 1, bIndex: null, text: 'b' });
  assert.equal(ops[2].aIndex, 2);
  assert.equal(ops[2].bIndex, 1);

  const insert = diffSequences([], ['x', 'y']);
  assert.deepEqual(insert.map((op) => op.type), ['insert', 'insert']);

  const allDelete = diffSequences(['x'], []);
  assert.deepEqual(allDelete.map((op) => op.type), ['delete']);

  const replace = diffSequences(['a', 'b'], ['c', 'd']);
  assert.equal(replace.length, 4);
  assert.equal(diffStats(replace).changed, 4);
  assert.deepEqual(diffSequences(['a'], ['a']).map((op) => op.type), ['equal']);
});

test('diffLines / diffWords / diffStats', () => {
  const ops = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
  const stats = diffStats(ops);
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 1);
  assert.equal(stats.unchanged, 2);
  assert.equal(stats.identical, false);
  assert.deepEqual(diffStats(diffLines('x', 'x')), { added: 0, removed: 0, unchanged: 1, total: 1, changed: 0, identical: true });
  assert.deepEqual(diffStats([]), { added: 0, removed: 0, unchanged: 0, total: 0, changed: 0, identical: true });

  const words = diffWords('hello world', 'hello brave world');
  assert.ok(words.some((op) => op.type === 'insert' && op.text === 'brave'));
  const wordStats = diffStats(words);
  assert.equal(wordStats.identical, false);
});

test('unifiedHunks：上下文合并成 hunk', () => {
  const ops = diffSequences(
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    ['1', '2', 'X', '4', '5', '6', '7', 'Y', '9'],
  );
  const hunks = unifiedHunks(ops, { context: 1 });
  assert.equal(hunks.length, 2, '两个相隔较远的改动应分成两个 hunk：' + JSON.stringify(hunks.map((hunk) => [hunk.aStart, hunk.bStart])));
  assert.ok(hunks[0].aCount >= 1 && hunks[0].bCount >= 1);
  assert.deepEqual(unifiedHunks(diffLines('a', 'a')), [], '没有差异时没有 hunk');
  assert.ok(Array.isArray(unifiedHunks(null)));
  const merged = unifiedHunks(diffSequences(['a', 'b', 'c'], ['a', 'X', 'Y', 'c']), { context: 3 });
  assert.equal(merged.length, 1, '相近改动合并成一个 hunk');
});

test('sideBySide：删除/新增成对显示', () => {
  const ops = diffSequences(['a', 'b'], ['a', 'c']);
  const rows = sideBySide(ops);
  assert.deepEqual(rows.map((row) => row.type), ['equal', 'change']);
  assert.equal(rows[0].left.aIndex, 0);
  assert.equal(rows[1].left.text, 'b');
  assert.equal(rows[1].right.text, 'c');

  const insertOnly = sideBySide(diffSequences(['a'], ['a', 'b', 'c']));
  assert.deepEqual(insertOnly.map((row) => row.type), ['equal', 'insert', 'insert']);
  const deleteOnly = sideBySide(diffSequences(['a', 'b'], ['a']));
  assert.deepEqual(deleteOnly.map((row) => row.type), ['equal', 'delete']);
});

test('lineRangeLabel', () => {
  assert.equal(lineRangeLabel(0, 0), '');
  assert.equal(lineRangeLabel(0, 1), '1');
  assert.equal(lineRangeLabel(4, 1), '5');
  assert.equal(lineRangeLabel(11, 7), '12–18');
  assert.equal(lineRangeLabel(null, 2), '1–2');
});

test('keyedDiff：新增/移除/变化/相同', () => {
  const left = [{ id: 'a', status: 200 }, { id: 'b', status: 500 }, { id: 'c', status: 200 }];
  const right = [{ id: 'b', status: 500 }, { id: 'c', status: 404 }, { id: 'd', status: 200 }];
  const diff = keyedDiff(left, right, { keyOf: (row) => row.id, valueOf: (row) => row.status });
  assert.deepEqual(diff.added.map((item) => item.key), ['d']);
  assert.deepEqual(diff.removed.map((item) => item.key), ['a']);
  assert.deepEqual(diff.changed.map((item) => item.key), ['c']);
  assert.deepEqual(diff.same.map((item) => item.key), ['b']);
  assert.equal(diff.matched, 2);
  assert.equal(diff.left, 3);
  assert.equal(diff.right, 3);

  const identical = keyedDiff([{ id: 'a', x: 1 }], [{ id: 'a', x: 1 }], { keyOf: (row) => row.id });
  assert.equal(identical.same.length, 1);
  assert.equal(identical.added.length, 0);
  assert.deepEqual(keyedDiff(null, null).added, []);
});

test('compareCaptureRuns：请求集合差异 + 控制台多重集', () => {
  const base = {
    id: 'run-1',
    requests: [
      { method: 'GET', url: '/api/ping', status: 200, durationMs: 10 },
      { method: 'GET', url: '/api/old', status: 200 },
    ],
    console: [{ level: 'log', text: 'hello' }, { level: 'error', text: 'boom' }],
  };
  const other = {
    id: 'run-2',
    requests: [
      { method: 'GET', url: '/api/ping', status: 500, durationMs: 20 },
      { method: 'POST', url: '/api/new', status: 201 },
    ],
    console: [{ level: 'log', text: 'hello' }, { level: 'warn', text: 'careful' }],
  };
  const result = compareCaptureRuns(base, other);
  assert.equal(result.requests.added.length, 1);
  assert.equal(result.requests.added[0].row.url, '/api/new');
  assert.equal(result.requests.removed.length, 1);
  assert.equal(result.requests.removed[0].row.url, '/api/old');
  assert.equal(result.requests.changed.length, 1, '同 URL 但状态变化算 changed');
  assert.equal(result.requests.same.length, 0);
  assert.deepEqual(result.console.added.map((item) => item.key), ['warn: careful']);
  assert.deepEqual(result.console.removed.map((item) => item.key), ['error: boom']);
  assert.deepEqual(result.console.same.map((item) => item.key), ['log: hello']);
  assert.equal(result.summary.identical, false);
  assert.equal(result.requestStats.added, 1);
  assert.equal(result.requestStats.removed, 1);

  const same = compareCaptureRuns(base, base);
  assert.equal(same.summary.identical, true);
  assert.equal(same.requests.added.length, 0);
  assert.equal(compareCaptureRuns(null, null).summary.identical, true);
});

test('compareEventSequences：步骤序列差异', () => {
  const left = [{ type: 'click', selector: '#a' }, { type: 'input', selector: '#b' }, { type: 'click', selector: '#c' }];
  const right = [{ type: 'click', selector: '#a' }, { type: 'click', selector: '#c' }];
  const result = compareEventSequences(left, right);
  assert.equal(result.stats.removed, 1);
  assert.equal(result.stats.identical, false);
  assert.equal(result.leftCount, 3);
  assert.equal(result.rightCount, 2);
  assert.ok(result.hunks.length >= 1);
  const identical = compareEventSequences(left, left);
  assert.equal(identical.identical, true);
  assert.deepEqual(identical.hunks, []);

  const custom = compareEventSequences([{ type: 'a' }], [{ type: 'a' }], { summarize: () => 'same' });
  assert.equal(custom.identical, true);
  assert.equal(compareEventSequences(null, null).identical, true);
});
