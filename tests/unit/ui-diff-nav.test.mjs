// tests/unit/ui-diff-nav.test.mjs —— 差异导航模型（extension/ui/lib/diff-nav.js）单测。
//
// 覆盖：折叠行构造、hunk 列表、导航器（循环/跳转/只看差异/上下文）、行内词级差异、
// 位置/摘要文本、快捷入口（两份文本直接建导航器）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, diffSequences, diffStats } from '../../extension/ui/lib/diff.js';
import {
  DEFAULT_CONTEXT,
  FOLD_MIN_LINES,
  buildDiffHunks,
  buildDiffRows,
  buildInlineRows,
  createDiffNavigator,
  diffSummaryText,
  foldCountOrZero,
  foldLabel,
  inlineWordSegments,
  isIdenticalText,
  navigatorForTexts,
  positionOf,
} from '../../extension/ui/lib/diff-nav.js';

const LEFT = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const RIGHT = ['alpha', 'beta', 'GAMMA', 'delta', 'epsilon', 'zeta', 'eta', 'THETA'];
const OPS = diffSequences(LEFT, RIGHT);

test('buildDiffRows：完整模式逐行保留，行号随源行', () => {
  const rows = buildDiffRows(OPS, { onlyChanges: false });
  assert.equal(rows.length, OPS.length);
  assert.deepEqual(rows.map((row) => row.type).filter((type) => type !== 'equal'), ['delete', 'insert', 'delete', 'insert']);
  assert.equal(rows[0].aIndex, 0);
});

test('buildDiffRows：只看差异时折叠未变行，上下文行保留', () => {
  const rows = buildDiffRows(OPS, { onlyChanges: true, context: 1 });
  const types = rows.map((row) => row.type);
  assert.ok(types.includes('fold'));
  const folds = rows.filter((row) => row.type === 'fold');
  assert.ok(folds.every((row) => row.count >= FOLD_MIN_LINES));
  // 变化行一定存在。
  assert.ok(types.includes('insert'));
  assert.ok(types.includes('delete'));
  // 折叠行不带文本。
  assert.ok(folds.every((row) => row.text === ''));
});

test('buildDiffHunks：hunk 序号、统计、行（与 unified 形状一致）', () => {
  const hunks = buildDiffHunks(OPS, { context: 1 });
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].index, 0);
  assert.equal(hunks[1].index, 1);
  for (const hunk of hunks) {
    assert.ok(hunk.aCount > 0 && hunk.bCount > 0);
    assert.equal(hunk.rows.length, hunk.ops.length);
    assert.match(hunk.label, /^hunk \d/);
    const stats = diffStats(hunk.ops);
    assert.equal(hunk.added, stats.added);
    assert.equal(hunk.removed, stats.removed);
  }
  assert.equal(buildDiffHunks([], { context: 2 }).length, 0);
});

test('导航器：初始位置、next/prev 循环、goto 夹取', () => {
  const nav = createDiffNavigator(OPS, { context: 1 });
  assert.equal(nav.total, 2);
  assert.equal(nav.current, 0);
  const first = nav.snapshot();
  assert.equal(first.position.index, 1);
  assert.equal(first.position.total, 2);
  assert.equal(nav.next().current, 1);
  assert.equal(nav.next().current, 0, '尾部循环');
  assert.equal(nav.prev().current, 1, '头部循环');
  assert.equal(nav.goto(5).current, 1);
  assert.equal(nav.goto(-3).current, 0);
  assert.equal(nav.total, 2);
  // 监听：每次导航都会通知。
  const seen = [];
  const off = nav.subscribe((snapshot) => seen.push(snapshot.current));
  nav.next();
  nav.next();
  off();
  nav.next();
  assert.equal(seen.length, 2);
});

test('导航器：只看差异切换重算行，上下文变化重算 hunk 并夹取当前位置', () => {
  const nav = createDiffNavigator(OPS, { context: 0 });
  assert.equal(nav.onlyChanges, false);
  const folded = nav.setOnlyChanges(true);
  assert.equal(folded.onlyChanges, true);
  assert.ok(folded.rows.some((row) => row.type === 'fold'));
  nav.goto(1);
  const withContext = nav.setContext(1);
  assert.equal(withContext.context, 1);
  assert.ok(withContext.total >= 1);
  assert.ok(nav.current < withContext.total);
  // 相同值不触发变化（幂等）。
  assert.equal(nav.setContext(1).context, 1);
});

test('导航器：空差异（相同文本）与位置文本', () => {
  const nav = navigatorForTexts('a\nb', 'a\nb');
  assert.equal(nav.total, 0);
  assert.equal(nav.snapshot().position.index, 0);
  assert.match(nav.positionText('zh'), /0 \/ 0/);
  assert.equal(nav.next().current, 0);
  assert.equal(nav.prev().current, 0);
  assert.ok(isIdenticalText('a', 'a'));
  assert.equal(isIdenticalText('a', 'b'), false);
});

test('navigatorForTexts：真实文本差异可导航', () => {
  const left = '{"a":1,"b":2}';
  const right = '{"a":1,"b":3}';
  const nav = navigatorForTexts(left, right);
  assert.ok(nav.total >= 1);
  const snapshot = nav.snapshot();
  assert.ok(snapshot.stats.changed >= 1);
  assert.ok(snapshot.rows.some((row) => row.type === 'delete'));
});

test('行内词级差异：变化词高亮、相同片段合并', () => {
  const segments = inlineWordSegments('/api/v1/users', '/api/v2/users');
  const changed = segments.filter((segment) => segment.type !== 'same').map((segment) => segment.text);
  assert.ok(changed.includes('v1'));
  assert.ok(changed.includes('v2'));
  // 连续 same 字符合并成一个片段（不会出现一个字符一个 span）。
  const same = segments.filter((segment) => segment.type === 'same');
  assert.ok(same.length <= 2);
  // 片段拼接可还原变化侧文本（delete 侧 + same 侧 / insert 侧 + same 侧）。
  const leftText = segments.filter((segment) => segment.type !== 'insert').map((segment) => segment.text).join('');
  const rightText = segments.filter((segment) => segment.type !== 'delete').map((segment) => segment.text).join('');
  assert.equal(leftText, '/api/v1/users');
  assert.equal(rightText, '/api/v2/users');
  // 中文逐字：错误相同，信/提 与 息/示 成对。
  const zh = inlineWordSegments('错误信息', '错误提示');
  assert.deepEqual(zh.filter((segment) => segment.type !== 'same').map((segment) => segment.text), ['信息', '提示']);
  assert.deepEqual(inlineWordSegments('', ''), []);
});

test('buildInlineRows：左右成对与单侧行', () => {
  const ops = diffSequences(['a'], ['b']);
  const rows = buildInlineRows(ops);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'change');
  assert.equal(rows[0].left, 'a');
  assert.equal(rows[0].right, 'b');
  assert.ok(rows[0].leftSegments.length > 0);
  assert.ok(rows[0].rightSegments.length > 0);
  assert.deepEqual(buildInlineRows([]), []);
});

test('文本：折叠阈值、位置、摘要、折叠标签', () => {
  assert.equal(foldCountOrZero(1), 0);
  assert.equal(foldCountOrZero(2), 2);
  assert.equal(foldCountOrZero('3'), 3);
  assert.deepEqual(positionOf(0, 0), { index: 0, total: 0 });
  assert.deepEqual(positionOf(3, 1), { index: 2, total: 3 });
  assert.deepEqual(positionOf(3, 99), { index: 3, total: 3 });
  assert.match(foldLabel(12, 'zh'), /折叠 12 行/);
  assert.match(foldLabel(12, 'en'), /Fold 12 unchanged/);
  assert.match(diffSummaryText(diffStats(OPS), 2, 'zh'), /行变化/);
  assert.equal(diffSummaryText({ identical: true }, 0, 'zh'), '没有差异');
  assert.equal(DEFAULT_CONTEXT, 3);
  // buildDiffRows 对非数组输入返回空数组（页面安全）。
  assert.deepEqual(buildDiffRows(null), []);
});
