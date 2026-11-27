// 虚拟列表 row facts 契约：normalize/比较/汇总，以及 payload 透传与统一 gate 接入。
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
  summarizeRowAnchors,
} from '../../extension/src/lib/vom-rows.js';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';
import { classifyVirtualRow } from '../../extension/src/lib/virtual-row-guard.js';

const RAW = {
  ariaRowIndex: '12',
  dataIndex: 3,
  transform: 'matrix(1, 0, 0, 1, 0, -480)',
  rowKey: 'user-42',
  rowText: '  张三  zhangsan@example.test  ',
  containerScrollTop: 480.456,
  recycled: true,
  role: 'ROW',
  tag: 'TR',
};

test('契约字段固定（七个主字段 + role/tag 辅助）', () => {
  assert.equal(VOM_ROW_ANCHOR_VERSION, 1);
  assert.deepEqual(ROW_ANCHOR_FIELDS, ['ariaRowIndex', 'dataIndex', 'transform', 'rowKey', 'rowText', 'containerScrollTop', 'recycled']);
  assert.deepEqual(ROW_ANCHOR_AUX_FIELDS, ['role', 'tag']);
});

test('normalizeRowAnchor：类型归一化、别名、截断、辅助字段小写', () => {
  const anchor = normalizeRowAnchor(RAW);
  assert.equal(anchor.ariaRowIndex, 12);
  assert.equal(anchor.dataIndex, 3);
  assert.equal(anchor.transform, 'matrix(1, 0, 0, 1, 0, -480)');
  assert.equal(anchor.rowKey, 'user-42');
  assert.equal(anchor.rowText, '张三 zhangsan@example.test');
  assert.equal(anchor.containerScrollTop, 480.5);
  assert.equal(anchor.recycled, true);
  assert.equal(anchor.role, 'row');
  assert.equal(anchor.tag, 'tr');
  // 归一化后仍是七字段 + 两个辅助字段。
  for (const field of ROW_ANCHOR_FIELDS) assert.ok(field in anchor, '缺少契约字段 ' + field);
  // 页面侧 snake_case / text 别名兼容。
  const alias = normalizeRowAnchor({ 'aria-rowindex': '4', 'data-index': '9', text: ' 行文本 ', role: 'row' });
  assert.equal(alias.ariaRowIndex, 4);
  assert.equal(alias.dataIndex, 9);
  assert.equal(alias.rowText, '行文本');
  assert.equal(alias.transform, null);
  // 非法值一律 null（但仍有 transform 这条有效事实，所以对象存在）。
  const bad = normalizeRowAnchor({ ariaRowIndex: 'x', dataIndex: 1.5, transform: 'translateY(5px)', rowKey: '', rowText: '  ', role: null, tag: 'TR' });
  assert.equal(bad.ariaRowIndex, null);
  assert.equal(bad.dataIndex, null);
  assert.equal(bad.rowKey, null);
  assert.equal(bad.rowText, null);
  assert.equal(bad.transform, 'translateY(5px)');
  assert.equal(bad.tag, 'tr');
  assert.equal(bad.role, undefined);
  // 全是空事实 -> 没有 anchor。
  assert.equal(normalizeRowAnchor({ transform: 'none', role: 'row', tag: 'tr' }), null);
  assert.equal(normalizeRowAnchor(null), null);
  assert.equal(normalizeRowAnchor('x'), null);
});

test('normalizeRowAnchor：rowText/transform/rowKey 截断，避免 payload 膨胀', () => {
  const long = normalizeRowAnchor({ rowText: 'x'.repeat(500), transform: 'm'.repeat(500), rowKey: 'k'.repeat(500) });
  assert.equal(long.rowText.length, 200);
  assert.equal(long.transform.length, 200);
  assert.equal(long.rowKey.length, 120);
});

test('rowAnchorChanged：文本/行键/索引/transform/滚动位移都会判定换行', () => {
  assert.equal(rowAnchorChanged(RAW, RAW), false);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, rowText: '李四' }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, rowKey: 'user-43' }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, ariaRowIndex: 13 }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, dataIndex: 4 }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, transform: 'matrix(1, 0, 0, 1, 0, -520)' }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, containerScrollTop: 520 }), true);
  assert.equal(rowAnchorChanged(RAW, { ...RAW, containerScrollTop: 480.2 }), false, '1px 内滚动抖动不算换行');
  // null 过渡：一边有事实另一边没有 -> 不稳定（fail-closed）。
  assert.equal(rowAnchorChanged(RAW, null), true);
  assert.equal(rowAnchorChanged(null, RAW), true);
  assert.equal(rowAnchorChanged(null, null), false);
  // 单边缺字段时不做虚假比较（页面可能只给了其中一部分）。
  assert.equal(rowAnchorChanged({ rowText: 'a' }, { rowText: 'a', rowKey: 'k' }), false);
});

test('rowAnchorSignature / describeRowAnchor / anchorOf', () => {
  const signature = rowAnchorSignature(RAW);
  assert.match(signature, /^12\u00003\u0000user-42\u0000张三/);
  assert.equal(rowAnchorSignature(null), '');
  assert.equal(rowAnchorSignature(RAW), rowAnchorSignature({ ...RAW, rowText: RAW.rowText }), '等价事实签名应稳定');
  const described = describeRowAnchor(RAW);
  assert.match(described, /ariaRowIndex=12/);
  assert.match(described, /rowKey=user-42/);
  assert.match(described, /transform=matrix/);
  assert.match(described, /recycled/);
  assert.equal(describeRowAnchor(null), '');
  assert.equal(anchorOf({ anchor: RAW }).ariaRowIndex, 12);
  assert.equal(anchorOf({ rowAnchor: RAW }).dataIndex, 3);
  assert.equal(anchorOf({}), null);
});

test('summarizeRowAnchors：节点级汇总（行/键/索引/滚动容器）', () => {
  const summary = summarizeRowAnchors([
    { ref: '@e1', anchor: { ariaRowIndex: 1, rowKey: 'k1', rowText: 'A', containerScrollTop: 0, role: 'row' } },
    { ref: '@e2', anchor: { dataIndex: 2, rowText: 'B', transform: 'translateY(40px)', containerScrollTop: 40, recycled: true, tag: 'tr' } },
    { ref: '@e3', name: 'no row facts' },
    { ref: '@e4', anchor: { transform: 'none' } },
  ]);
  assert.equal(summary.version, 1);
  assert.equal(summary.total, 4);
  assert.equal(summary.anchored, 2);
  assert.equal(summary.recycled, 1);
  assert.equal(summary.withRowKey, 1);
  assert.equal(summary.withIndex, 2);
  assert.equal(summary.transformed, 1);
  assert.equal(summary.containers, 2);
  assert.equal(summary.byRole.row, 1);
  assert.equal(summary.byRole.tr, 1);
  assert.equal(summarizeRowAnchors(null).anchored, 0);
});

test('page-lib row facts 与 classifyVirtualRow 契约一致：稳定行通过、回收行带证据拒绝', () => {
  const anchor = normalizeRowAnchor({
    ariaRowIndex: 7,
    dataIndex: 7,
    transform: 'none',
    rowKey: 'row-7',
    rowText: '第 7 行',
    containerScrollTop: 0,
    recycled: false,
    role: 'row',
    tag: 'tr',
  });
  const stable = classifyVirtualRow(anchor);
  assert.equal(stable.stable, true, '稳定行被判不稳定：' + stable.reason);
  assert.equal(stable.rowIndex, 7);
  assert.equal(stable.kind, 'row');
  const recycled = classifyVirtualRow({ ...anchor, recycled: true });
  assert.equal(recycled.stable, false);
  assert.equal(recycled.reason, 'row-recycled');
  assert.equal(recycled.evidence.check, 'row-recycled');
  const shifted = classifyVirtualRow({ ...anchor, previousRowIndex: 6 });
  assert.equal(shifted.stable, false);
  assert.equal(shifted.reason, 'index-shifted');
  const translated = classifyVirtualRow({ ...anchor, transform: 'translateY(-40px)' });
  assert.equal(translated.stable, false);
  assert.equal(translated.reason, 'translated');
});

test('payload 透传 anchor（normalize 后）+ 统一 visibility + 关系图 v3', () => {
  const nodes = [
    {
      ref: '@e1',
      role: 'button',
      tag: 'button',
      name: '保存',
      clickable: true,
      hitTest: 'self',
      bounds: { x: 10, y: 10, width: 80, height: 30 },
      ariaControls: 'panel',
      anchor: RAW,
    },
    {
      ref: '@e2',
      role: 'row',
      tag: 'tr',
      name: '',
      bounds: { x: 0, y: 0, width: 100, height: 40 },
      display: 'none',
      anchor: { rowText: '隐藏行', role: 'row' },
    },
  ];
  const payload = buildVomPayload({ nodes, documentId: 'https://example.test/', revision: 4 });
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.relations.relationTypes, ['contains', 'labels', 'controls', 'owns', 'describes']);
  assert.equal(payload.relations.version, 3);
  const button = payload.nodes.find((node) => node.ref === '@e1');
  assert.ok(button.anchor, 'payload 节点缺少 anchor');
  for (const field of ROW_ANCHOR_FIELDS) assert.ok(field in button.anchor, 'anchor 缺少 ' + field);
  assert.equal(button.anchor.ariaRowIndex, 12);
  assert.equal(button.anchor.rowText, '张三 zhangsan@example.test');
  assert.equal(button.anchor.recycled, true);
  assert.equal(button.visibility.reasons.includes('recycled-row'), true);
  assert.equal(button.visibility.interactive, false, '回收行不应判为可交互');
  const hidden = payload.nodes.find((node) => node.ref === '@e2');
  assert.equal(hidden.anchor.rowText, '隐藏行');
  assert.equal(hidden.visibility.paintable, false);
  assert.equal(hidden.visibility.reason, 'paint-hidden');
  // 汇总只做聚合，不改既有字段。
  assert.equal(payload.visibility.input, 2);
  assert.ok(payload.visibility.byReason['recycled-row'] >= 1);
  assert.ok(payload.visibility.byReason['paint-hidden'] >= 1);
  assert.equal(payload.stages.map((stage) => stage.stage).join(','), 'facts,identity,relations,layout,paint,interact');
});
