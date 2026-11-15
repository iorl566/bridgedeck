// 阻挡层识别：dialog/alertdialog 的可见面积占视口比例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBlockingLayers } from '../../extension/src/lib/blocking-layers.js';

const facts = new Map([
  [1, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true }],
  [2, { bounds: { x: 100, y: 100, width: 800, height: 600 }, visible: true }],
  [3, { bounds: { x: 900, y: 700, width: 50, height: 50 }, visible: true }],
  [4, { bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false }],
]);

const axNodes = [
  { role: 'RootWebArea', name: 'page', backendNodeId: 1 },
  { role: 'dialog', name: '登录', backendNodeId: 2 },
  { role: 'dialog', name: '小提示', backendNodeId: 3 },
  { role: 'alertdialog', name: '隐藏弹窗', backendNodeId: 4 },
];

test('识别覆盖视口 ≥25% 的可见 dialog', () => {
  const layers = computeBlockingLayers(axNodes, facts);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].role, 'dialog');
  assert.equal(layers[0].name, '登录');
  assert.equal(layers[0].coverage, 0.6);
});

test('minCoverage / limit 与缺失输入', () => {
  assert.equal(computeBlockingLayers(axNodes, facts, { minCoverage: 0.9 }).length, 0);
  assert.deepEqual(computeBlockingLayers([], facts), []);
  assert.deepEqual(computeBlockingLayers(axNodes, null), []);
});
