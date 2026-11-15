// AX 备用采集器节点构建：可见性过滤、字段形态、limit。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAxNodes } from '../../extension/src/lib/ax-pipeline.js';

const facts = new Map([
  [7, { bounds: { x: 1, y: 2, width: 30, height: 20 }, visible: true, clickable: true }],
  [8, { bounds: null, visible: false, clickable: false }],
]);

const axNodes = [
  { role: 'RootWebArea', name: 'page', backendNodeId: 1 },
  { role: 'button', name: '提交', backendNodeId: 7 },
  { role: 'button', name: '隐藏', backendNodeId: 8 },
  { role: 'InlineTextBox', name: 'x', backendNodeId: 9 },
];

test('构建节点：跳过隐藏/InlineTextBox，保留几何与 interactive', () => {
  const nodes = buildAxNodes(axNodes, facts);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[1], {
    role: 'button',
    name: '提交',
    value: '',
    backendNodeId: 7,
    bounds: { x: 1, y: 2, width: 30, height: 20 },
    visible: true,
    clickable: true,
    interactive: true,
  });
});

test('limit 与无 facts 输入', () => {
  const nodes = buildAxNodes(axNodes, null, { limit: 1 });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].visible, true);
  assert.equal(buildAxNodes(null, facts).length, 0);
});
