// 阻挡层识别：dialog/alertdialog 的可见面积占视口比例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBlockingLayers, computeLayerBands } from '../../extension/src/lib/blocking-layers.js';

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

test('paint-order 分层：固定遮罩 + dialog，按覆盖/paintOrder 排序', () => {
  const layerFacts = new Map([
    [1, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 0, styles: { position: 'static' } }],
    [2, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 5, styles: { position: 'fixed', 'pointer-events': 'auto' } }],
    [3, { bounds: { x: 100, y: 100, width: 800, height: 600 }, visible: true, paintOrder: 7, styles: { position: 'fixed', 'pointer-events': 'auto' } }],
    [4, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 9, styles: { position: 'fixed', 'pointer-events': 'none' } }],
  ]);
  const bandAx = [
    { role: 'RootWebArea', name: 'page', backendNodeId: 1 },
    { role: 'dialog', name: '确认', backendNodeId: 3 },
  ];
  const layers = computeLayerBands(bandAx, layerFacts, { minCoverage: 0.2 });
  assert.equal(layers.length, 2);
  assert.equal(layers[0].kind, 'mask');
  assert.equal(layers[0].coverage, 1);
  assert.equal(layers[0].members, 2);
  assert.equal(layers[1].role, 'dialog');
  assert.equal(layers[1].kind, 'modal');
  assert.equal(layers[1].coverage, 0.6);
  assert.equal(layers[1].paintOrder, 7);
  assert.equal(layers[1].members, 1);
  assert.equal(computeLayerBands([], layerFacts).length, 0);
  assert.deepEqual(computeLayerBands(bandAx, null), []);
});
