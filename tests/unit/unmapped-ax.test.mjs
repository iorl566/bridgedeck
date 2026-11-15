// AX 未映射交互元素：筛选、可见性、几何与渲染。
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectUnmappedAx, isInteractiveAxRole, renderUnmappedAx } from '../../extension/src/lib/unmapped-ax.js';

const facts = new Map([
  [10, { bounds: { x: 10, y: 20, width: 80, height: 30 }, visible: true }],
  [11, { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }],
]);

const axNodes = [
  { role: 'button', name: '登录', backendNodeId: 10 },
  { role: 'button', name: '隐藏按钮', backendNodeId: 11 },
  { role: 'link', name: '已映射', backendNodeId: 12 },
  { role: 'paragraph', name: '普通文本', backendNodeId: 13 },
  { role: 'textbox', name: '无 backend' },
  { role: 'tab', name: '标签', backendNodeId: 14 },
  { role: 'button', name: '暂停 Agent', backendNodeId: 15 },
];

test('只保留未映射、可见、有 backendNodeId 的交互角色', () => {
  const list = collectUnmappedAx(axNodes, new Set([12]), facts, { limit: 20 });
  assert.deepEqual(list.map((item) => item.name), ['登录', '标签']);
  assert.deepEqual(list[0].bounds, { x: 10, y: 20, width: 80, height: 30 });
  assert.equal(list[1].bounds, null);
});

test('limit 与角色判断', () => {
  assert.equal(isInteractiveAxRole('button'), true);
  assert.equal(isInteractiveAxRole('paragraph'), false);
  const list = collectUnmappedAx(axNodes, new Set(), facts, { limit: 1 });
  assert.equal(list.length, 1);
});

test('渲染带几何与“仅供定位”提示', () => {
  const text = renderUnmappedAx(collectUnmappedAx(axNodes, new Set([12]), facts));
  assert.match(text, /- button "登录" \(@10,20 80x30\) {2}\[仅供定位，无 ref\]/);
  assert.match(text, /- tab "标签" {2}\[仅供定位，无 ref\]/);
  assert.equal(renderUnmappedAx([]), '');
});
