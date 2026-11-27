// VOM layers 模型：base/fixed-sticky/floating/blocking/top-layer 有序分层与既有输出接入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_KINDS,
  VOM_LAYERS_VERSION,
  deriveLayers,
  describeLayer,
  normalizeLayer,
} from '../../extension/src/lib/vom-layers.js';
import { computeBlockingLayers, computeLayerBands } from '../../extension/src/lib/blocking-layers.js';
import { formatLayerSummary } from '../../extension/src/lib/layer-summary.js';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';

test('deriveLayers：空输入只有 base，version/kinds 稳定', () => {
  const model = deriveLayers([]);
  assert.equal(model.version, VOM_LAYERS_VERSION);
  assert.equal(model.layers.length, 1);
  assert.equal(model.layers[0].kind, 'base');
  assert.equal(model.layers[0].index, 0);
  assert.equal(model.layers[0].blocking, false);
  assert.equal(model.layers[0].rect, null);
  assert.ok(LAYER_KINDS.includes('top-layer') && LAYER_KINDS.includes('floating'));
  assert.equal(deriveLayers(null).layers.length, 1);
  assert.equal(deriveLayers({ layers: [] }).layers.length, 1);
});

test('z-index 分层顺序：floating 按 zIndex 升序，fixed-sticky 先于 floating', () => {
  const model = deriveLayers([
    { id: 'z500', position: 'fixed', zIndex: 500, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'z1', position: 'fixed', zIndex: 1, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'z50', position: 'fixed', zIndex: 50, rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'hdr', position: 'sticky', zIndex: null, rect: { x: 0, y: 0, width: 100, height: 30 } },
  ]);
  const ids = model.layers.map((layer) => layer.id);
  assert.deepEqual(ids, [null, 'hdr', 'z1', 'z50', 'z500']);
  assert.equal(model.layers[0].kind, 'base');
  assert.equal(model.layers[1].kind, 'fixed-sticky');
  assert.equal(model.layers[2].kind, 'floating');
  assert.ok(model.layers[2].index < model.layers[3].index && model.layers[3].index < model.layers[4].index);
  assert.equal(model.layers[4].zIndex, 500);
  assert.equal(model.layers[1].zIndex, null, 'z-index:auto 应保留 null 而不是 0');
  assert.equal(model.counts.byKind.floating, 3);
});

test('top-layer：modal dialog / popover / fullscreen 识别，blocking 语义区分', () => {
  const model = deriveLayers([
    { role: 'dialog', kind: 'modal', topLayer: 'modal-dialog', bounds: { x: 5, y: 6, width: 300, height: 200 } },
    { topLayer: 'popover', position: 'fixed', name: 'pop' },
    { topLayer: 'fullscreen', position: 'fixed', name: 'video' },
    { role: 'dialog', name: '未标注 topLayer 的对话框' },
  ]);
  const dialog = model.layers.find((layer) => layer.name === null && layer.kind === 'top-layer');
  assert.ok(dialog, 'role=dialog 应进入 top-layer');
  assert.equal(dialog.blocking, true, 'dialog 默认阻挡');
  assert.deepEqual(dialog.rect, { x: 5, y: 6, width: 300, height: 200 });
  const popover = model.layers.find((layer) => layer.name === 'pop');
  assert.equal(popover.kind, 'top-layer');
  assert.equal(popover.topLayer, 'popover');
  assert.equal(popover.blocking, false, 'popover 不阻挡指针');
  const fullscreen = model.layers.find((layer) => layer.name === 'video');
  assert.equal(fullscreen.kind, 'top-layer');
  assert.equal(fullscreen.topLayer, 'fullscreen');
  // top-layer 永远排在 floating 之后。
  const model2 = deriveLayers([
    { position: 'fixed', zIndex: 9999, id: 'top-z' },
    { role: 'dialog', id: 'dlg' },
  ]);
  assert.ok(model2.layers.find((layer) => layer.id === 'dlg').index > model2.layers.find((layer) => layer.id === 'top-z').index);
});

test('blocking：遮罩层与覆盖视口的固定层', () => {
  const model = deriveLayers([
    { kind: 'mask', coverage: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
    { position: 'fixed', coverage: 0.95, rect: { x: 0, y: 0, width: 1000, height: 800 }, name: '遮罩' },
    { kind: 'overlay', coverage: 0.2, name: '小浮层' },
  ]);
  const mask = model.layers.find((layer) => layer.name === null && layer.kind === 'blocking');
  assert.ok(mask, 'kind=mask 应归为 blocking');
  assert.equal(mask.blocking, true);
  const fixedCover = model.layers.find((layer) => layer.name === '遮罩');
  assert.equal(fixedCover.blocking, true);
  const overlay = model.layers.find((layer) => layer.name === '小浮层');
  assert.equal(overlay.kind, 'blocking');
});

test('normalizeLayer：矩形/z-index 兼容 rect/bounds 与 styles，未知值保留 null', () => {
  const fromRect = normalizeLayer({ position: 'fixed', zIndex: 7, rect: { x: 1, y: 2, width: 3, height: 4 }, pointerEvents: 'auto' }, 0);
  assert.deepEqual(fromRect.rect, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(fromRect.zIndex, 7);
  assert.equal(fromRect.sourceIndex, 0);
  const fromFacts = normalizeLayer({ bounds: { x: 10, y: 20, width: 30, height: 40 }, styles: { position: 'fixed', 'z-index': '12' } }, 3);
  assert.deepEqual(fromFacts.rect, { x: 10, y: 20, width: 30, height: 40 });
  assert.equal(fromFacts.zIndex, 12);
  assert.equal(fromFacts.position, 'fixed');
  assert.equal(fromFacts.kind, 'floating');
  assert.equal(normalizeLayer(null), null);
  assert.equal(normalizeLayer({ zIndex: 'auto' }).zIndex, null);
});

test('computeLayerBands 接入层模型：保留 mask/modal 旧 kind，并补 layerKind/zIndex/index/blocking', () => {
  const facts = new Map([
    [1, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 0, styles: { position: 'static' } }],
    [2, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 5, styles: { position: 'fixed', 'pointer-events': 'auto' } }],
    [3, { bounds: { x: 100, y: 100, width: 800, height: 600 }, visible: true, paintOrder: 7, styles: { position: 'fixed', 'pointer-events': 'auto' } }],
    [4, { bounds: { x: 0, y: 0, width: 1000, height: 800 }, visible: true, paintOrder: 9, styles: { position: 'fixed', 'pointer-events': 'none' } }],
  ]);
  const axNodes = [
    { role: 'RootWebArea', name: 'page', backendNodeId: 1 },
    { role: 'dialog', name: '确认', backendNodeId: 3 },
  ];
  const bands = computeLayerBands(axNodes, facts, { minCoverage: 0.2 });
  assert.equal(bands.length, 2);
  assert.equal(bands[0].kind, 'mask');
  assert.equal(bands[1].kind, 'modal');
  assert.ok(LAYER_KINDS.includes(bands[0].layerKind));
  assert.equal(bands[0].layerKind, 'blocking');
  assert.equal(bands[1].layerKind, 'top-layer');
  assert.equal(bands[1].blocking, true);
  assert.equal(bands[1].topLayer, null, 'AX dialog 由 role 判定 top-layer，不必伪造 topLayer');
  assert.ok(bands[0].index < bands[1].index);

  const blockers = computeBlockingLayers(axNodes, facts);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].layerKind, 'top-layer');
  assert.equal(blockers[0].blocking, true);
  assert.equal(typeof blockers[0].index, 'number');
});

test('formatLayerSummary：既有格式不变，有层模型时追加 [kind z blocking]', () => {
  assert.equal(formatLayerSummary('https://example.test/', []), '');
  const plain = formatLayerSummary('https://example.test/', [
    { level: 'L2', role: 'dialog', name: '确认', coverage: 0.42, bounds: { x: 10, y: 20, width: 300, height: 200 } },
  ]);
  assert.match(plain, /L1 "https:\/\/example\.test\/"/);
  assert.match(plain, /L2 dialog "确认" \(42%\)/);
  assert.match(plain, /@ 10,20 300x200/);
  assert.doesNotMatch(plain, /\[/, '没有层模型事实时不追加后缀');
  const enriched = formatLayerSummary('https://example.test/', [
    { level: 'L2', role: 'dialog', name: '确认', coverage: 0.42, layerKind: 'top-layer', zIndex: 1000, blocking: true },
  ]);
  assert.match(enriched, /\[top-layer z=1000 blocking\]/);
  assert.equal(describeLayer({ kind: 'floating', zIndex: 50, blocking: false }), 'floating z=50');
  assert.equal(describeLayer({ kind: 'base', zIndex: 0, blocking: false }), '');
});

test('vom payload layers：非 base 层带 index/kind/zIndex/blocking/topLayer，既有字段保留', () => {
  const payload = buildVomPayload({
    nodes: [{ ref: '@e1', role: 'button', tag: 'button', name: 'ok' }],
    layers: [
      { level: 'L2', role: 'dialog', name: '确认', coverage: 0.6, bounds: { x: 1, y: 2, width: 30, height: 40 } },
      { level: 'L2', role: 'overlay', name: 'mask', coverage: 1, bounds: { x: 0, y: 0, width: 100, height: 80 } },
    ],
    documentId: 'https://x',
    revision: 3,
  });
  assert.equal(payload.layers.length, 2);
  const dialog = payload.layers.find((layer) => layer.role === 'dialog');
  const mask = payload.layers.find((layer) => layer.name === 'mask');
  assert.ok(dialog && mask, 'payload.layers 缺少 dialog/mask：' + JSON.stringify(payload.layers));
  assert.equal(dialog.level, 'L2');
  assert.equal(dialog.kind, 'top-layer');
  assert.equal(dialog.blocking, true);
  assert.ok(dialog.index > 0);
  assert.deepEqual(dialog.bounds, { x: 1, y: 2, width: 30, height: 40 });
  assert.equal(mask.kind, 'blocking');
  assert.ok(dialog.index > mask.index, 'dialog 应在遮罩之上');
});
