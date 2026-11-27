// packages/vom/test/rows-diff.test.ts —— row facts（normalizeRowAnchor 等）JS ↔ TS 差分测试。
//
// 输入覆盖边界：null/undefined/空对象/只有 recycled 的空事实、旧字段名
// （aria-rowindex / data-index / text）、布尔与数字字符串、小数/负数/NaN、
// transform 原始字符串与 200 截断、rowText 空白折叠与 200 截断、rowKey 120 截断、
// containerScrollTop 的一位小数与 ''→0、role/tag 小写化、meaningful 判定等。
// 另外对 rowAnchorChanged / rowAnchorSignature / describeRowAnchor / summarizeRowAnchors
// / anchorOf 逐项对拍。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROW_ANCHOR_AUX_FIELDS,
  ROW_ANCHOR_FIELDS,
  VOM_ROW_ANCHOR_VERSION,
  anchorOf,
  describeRowAnchor,
  normalizeRowAnchor,
  rowAnchorChanged,
  rowAnchorSignature,
  rowAnchorVersion,
  summarizeRowAnchors,
} from '../src/index.ts';
import type { RowAnchorInput } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-rows.js');

function asAnchor(value: unknown): RowAnchorInput {
  return value as RowAnchorInput;
}

const TRANSFORM_MATRIX = 'matrix(1, 0, 0, 1, 0, ' + '12'.repeat(60) + ')';

const CASES: readonly { label: string; raw: unknown }[] = [
  { label: 'null', raw: null },
  { label: 'undefined', raw: undefined },
  { label: '空对象', raw: {} },
  { label: '非对象', raw: 'anchor' },
  { label: '只有 recycled:false', raw: { recycled: false } },
  { label: '只有 recycled:true', raw: { recycled: true } },
  { label: '只有 role/tag（不算 meaningful）', raw: { role: 'row', tag: 'tr' } },
  { label: 'ariaRowIndex 数字字符串', raw: { ariaRowIndex: '3' } },
  { label: 'ariaRowIndex 布尔 true（Number(true)=1）', raw: { ariaRowIndex: true } },
  { label: 'ariaRowIndex 小数（整数校验拒绝）', raw: { ariaRowIndex: 1.5 } },
  { label: '旧字段 aria-rowindex', raw: { 'aria-rowindex': '7' } },
  { label: 'dataIndex 零字符串', raw: { dataIndex: '0' } },
  { label: '旧字段 data-index', raw: { 'data-index': '5' } },
  { label: 'transform=none（不算 meaningful）', raw: { transform: 'none' } },
  { label: 'transform 矩阵', raw: { transform: 'matrix(1,0,0,1,0,12)' } },
  { label: 'transform 超长（200 截断）', raw: { transform: TRANSFORM_MATRIX } },
  { label: 'rowText 空白折叠', raw: { rowText: '  hello   world  ' } },
  { label: 'rowText 超长（200 截断）', raw: { rowText: 'x'.repeat(250) } },
  { label: 'text 回退字段', raw: { text: 'fallback text' } },
  { label: 'rowKey 超长（120 截断）', raw: { rowKey: 'k'.repeat(130) } },
  { label: 'containerScrollTop 负数小数', raw: { containerScrollTop: -12.34 } },
  { label: 'containerScrollTop 空串→0', raw: { containerScrollTop: '' } },
  { label: 'containerScrollTop NaN 字符串', raw: { containerScrollTop: 'abc' } },
  { label: 'containerScrollTop 小数', raw: { containerScrollTop: 3.14159 } },
  { label: 'containerScrollTop null', raw: { containerScrollTop: null } },
  { label: 'recycled 字符串 true 不算', raw: { recycled: 'true' } },
  { label: 'role/tag 大写小写化', raw: { rowKey: 'r1', role: 'ROW', tag: 'TR' } },
  { label: 'role 数字', raw: { dataIndex: 2, role: 42 } },
  { label: '全字段综合', raw: {
    ariaRowIndex: '3', dataIndex: 'x', rowKey: '  key  ', rowText: ' a  b ',
    transform: 'matrix(1,0,0,1,0,10)', containerScrollTop: '2.345', recycled: true, role: 'ROW', tag: 'tr',
  } },
];

test('normalizeRowAnchor：全部用例逐字段相等', () => {
  for (const { label, raw } of CASES) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(normalizeRowAnchor(asAnchor(raw)))),
      JSON.parse(JSON.stringify(js.normalizeRowAnchor(asAnchor(raw) as unknown))),
      label + ' 的 anchor 归一不一致',
    );
  }
});

test('normalizeRowAnchor：关键硬断言（空事实/meaningful/截断/归一）', () => {
  assert.equal(normalizeRowAnchor(null), null);
  assert.equal(normalizeRowAnchor({}), null);
  assert.equal(normalizeRowAnchor({ transform: 'none' }), null, 'transform=none 不算有效事实');
  assert.equal(normalizeRowAnchor({ role: 'row', tag: 'tr' }), null, '辅助字段不算 meaningful');
  const anchor = normalizeRowAnchor(asAnchor({
    ariaRowIndex: '3', dataIndex: 'x', rowKey: '  key  ', rowText: ' a  b ',
    transform: 'matrix(1,0,0,1,0,10)', containerScrollTop: '2.345', recycled: true, role: 'ROW', tag: 'tr',
  }));
  assert.deepEqual(anchor, {
    ariaRowIndex: 3,
    dataIndex: null,
    transform: 'matrix(1,0,0,1,0,10)',
    rowKey: 'key',
    rowText: 'a b',
    containerScrollTop: 2.3,
    recycled: true,
    role: 'row',
    tag: 'tr',
  });
  const long = normalizeRowAnchor({ rowText: 'x'.repeat(250), rowKey: 'k'.repeat(130), transform: 'y'.repeat(300) });
  assert.ok(long);
  assert.equal(long.rowText?.length, 200);
  assert.equal(long.rowKey?.length, 120);
  assert.equal(long.transform?.length, 200);
  // 空串 scrollTop 归一成 0；NUL 字节签名分隔符不能出现在文本里。
  assert.equal(normalizeRowAnchor({ rowText: 'x', containerScrollTop: '' })?.containerScrollTop, 0);
  assert.equal(normalizeRowAnchor({ rowText: 'x', recycled: 'true' })?.recycled, false);
  assert.equal(VOM_ROW_ANCHOR_VERSION, 1);
  assert.deepEqual([...ROW_ANCHOR_FIELDS], [
    'ariaRowIndex', 'dataIndex', 'transform', 'rowKey', 'rowText', 'containerScrollTop', 'recycled',
  ]);
  assert.deepEqual([...ROW_ANCHOR_AUX_FIELDS], ['role', 'tag']);
  assert.equal(rowAnchorVersion(), js.rowAnchorVersion());
});

const CHANGED_PAIRS: readonly { label: string; before: unknown; after: unknown }[] = [
  { label: '双 null', before: null, after: null },
  { label: '一边 null', before: { rowKey: 'a' }, after: null },
  { label: '文本相同', before: { rowKey: 'a', rowText: 'x' }, after: { rowKey: 'a', rowText: 'x' } },
  { label: '文本变化', before: { rowText: 'x' }, after: { rowText: 'y' } },
  { label: 'rowKey 变化', before: { rowKey: 'a' }, after: { rowKey: 'b' } },
  { label: 'rowKey 只有一侧', before: { rowKey: 'a' }, after: { rowKey: null, rowText: 'x' } },
  { label: 'ariaRowIndex 变化', before: { ariaRowIndex: 1 }, after: { ariaRowIndex: 2 } },
  { label: 'dataIndex 变化', before: { dataIndex: 1 }, after: { dataIndex: 2 } },
  { label: 'transform 变化', before: { transform: 'none' }, after: { transform: 'matrix(1,0,0,1,0,5)' } },
  { label: '滚动位移 > 1', before: { rowText: 'x', containerScrollTop: 0 }, after: { rowText: 'x', containerScrollTop: 1.5 } },
  { label: '滚动位移 = 1（不算动）', before: { rowText: 'x', containerScrollTop: 0 }, after: { rowText: 'x', containerScrollTop: 1 } },
  { label: '滚动位移 0.9', before: { rowText: 'x', containerScrollTop: 10 }, after: { rowText: 'x', containerScrollTop: 10.9 } },
];

test('rowAnchorChanged / rowAnchorSignature / describeRowAnchor：逐项对拍', () => {
  for (const { label, before, after } of CHANGED_PAIRS) {
    assert.equal(
      rowAnchorChanged(asAnchor(before), asAnchor(after)),
      js.rowAnchorChanged(before, after),
      label + ' 的变更判定不一致',
    );
    assert.equal(
      rowAnchorSignature(asAnchor(before)),
      js.rowAnchorSignature(before),
      label + ' 的签名不一致',
    );
    assert.equal(
      describeRowAnchor(asAnchor(before)),
      js.describeRowAnchor(before),
      label + ' 的描述不一致',
    );
  }
  // 硬断言：签名用 NUL 分隔 5 个字段；描述省略 transform=none。
  const signature = rowAnchorSignature({ ariaRowIndex: 1, dataIndex: 2, rowKey: 'k', rowText: 't', transform: 'matrix()' });
  assert.equal(signature, ['1', '2', 'k', 't', 'matrix()'].join('\u0000'));
  assert.ok(!signature.includes(' '), '签名不应用空格分隔');
  assert.equal(rowAnchorSignature(null), '');
  assert.equal(describeRowAnchor(null), '');
  const described = describeRowAnchor({
    ariaRowIndex: 1, dataIndex: 2, rowKey: 'k', rowText: 'hello "world"', transform: 'none',
    containerScrollTop: 5, recycled: true,
  });
  assert.equal(described, 'ariaRowIndex=1 dataIndex=2 rowKey=k scrollTop=5 text="hello \\"world\\"" recycled');
});

test('anchorOf / summarizeRowAnchors：节点投影逐字段相等', () => {
  const nodes = [
    { anchor: { rowKey: 'a', rowText: 'x' } },
    { rowAnchor: { dataIndex: 1, role: 'ROW' } },
    { anchor: null, rowAnchor: { ariaRowIndex: '4' } },
    null,
    42,
    {},
    { anchor: { transform: 'none' } },
    { anchor: { rowKey: null } },
    { anchor: { rowKey: 'a', recycled: true, transform: 'translateY(4px)', containerScrollTop: 1 } },
    { anchor: { rowKey: 'b', recycled: false, role: 'gridcell' } },
  ];
  for (const node of nodes) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(anchorOf(node))),
      JSON.parse(JSON.stringify(js.anchorOf(node))),
      'anchorOf 不一致：' + JSON.stringify(node),
    );
  }
  const summary = summarizeRowAnchors(nodes);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), JSON.parse(JSON.stringify(js.summarizeRowAnchors(nodes))));
  assert.equal(summary.total, nodes.length);
  // summary 只读 node.anchor（与 anchorOf 的 rowAnchor 兼容字段不同）：10 条里 3 条带 anchor。
  assert.equal(summary.anchored, 3);
  assert.equal(summary.recycled, 1);
  assert.equal(summary.withRowKey, 3);
  assert.equal(summary.withIndex, 0);
  assert.equal(summary.transformed, 1);
  assert.equal(summary.containers, 1);
  assert.equal(summary.byRole['row'], undefined);
  assert.equal(summary.byRole['gridcell'], 1);
  assert.equal(summary.byRole['unknown'], 2);
  assert.equal(summary.version, VOM_ROW_ANCHOR_VERSION);
  assert.deepEqual(JSON.parse(JSON.stringify(summarizeRowAnchors('nope'))), { version: 1, total: 0, anchored: 0, recycled: 0, withRowKey: 0, withIndex: 0, transformed: 0, containers: 0, byRole: {} });
});
