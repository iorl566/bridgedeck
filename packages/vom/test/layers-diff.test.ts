// packages/vom/test/layers-diff.test.ts —— layers JS ↔ TS 差分测试。
//
// 输入覆盖边界：空数组/空对象/非数组/非对象、{layers} 包装、zIndex 字符串与负数与小数、
// 'auto'/'10px'/空串、position 与 styles.position 两套来源、fixed+coverage 阻挡阈值、
// dialog/alertdialog/modal 的 top-layer 提升、popover top-layer 不阻挡、rect 两套字段名
// 与非法几何、backendNodeId 字符串/小数/负数、limit 越界钳制、includeBase=false、
// 未知 kind、coverage=null（Number(null)=0 的 JS 语义）等。
//
// 除逐字段 deepEqual 外，另断言层模型自身不变量：index 连续、base 恒为第 0 层、
// kind 单调不减、backendNodeId 为正整数或 null。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYER_KINDS,
  VOM_LAYERS_VERSION,
  deriveLayers,
  describeLayer,
  normalizeLayer,
} from '../src/index.ts';
import type { DeriveLayersOptions, LayerFact, LayerInput, LayerKind } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-layers.js');

function asInput(value: unknown): LayerInput {
  return value as LayerInput;
}

const LONG_NAME = 'x'.repeat(100);

const CASES: readonly { label: string; input: unknown }[] = [
  { label: '空数组', input: [] },
  { label: 'null', input: null },
  { label: 'undefined', input: undefined },
  { label: '空对象', input: {} },
  { label: '{layers: []}', input: { layers: [] } },
  { label: '{layers: null}', input: { layers: null } },
  { label: '非数组非对象', input: 'layers' },
  { label: 'dialog + zIndex', input: [{ role: 'dialog', zIndex: 1000 }] },
  { label: 'popover top-layer（不阻挡）', input: [{ topLayer: 'popover' }] },
  { label: '负 zIndex 字符串', input: [{ zIndex: '-5' }] },
  { label: '非法 zIndex 字符串', input: [{ zIndex: '10px' }] },
  { label: '零 zIndex 字符串', input: [{ zIndex: '0' }] },
  { label: '小数 zIndex', input: [{ zIndex: 2.5 }] },
  { label: 'styles.position + z-index', input: [{ styles: { position: 'fixed', 'z-index': '30' } }] },
  { label: 'sticky + 零 zIndex', input: [{ position: 'sticky', zIndex: 0 }] },
  { label: 'rect 两套字段名 + 小数', input: [{ rect: { x: 1.4, y: 2.6, w: 300.5, h: 100.4 } }] },
  { label: 'bounds + width/height', input: [{ bounds: { x: 0, y: 0, width: 10, height: 20 } }] },
  { label: '非法 rect', input: [{ rect: { x: 'nope', y: 1 } }] },
  { label: 'fixed + coverage 0.95', input: [{ role: 'overlay', coverage: 0.95, position: 'fixed' }] },
  { label: 'fixed + coverage 0.5', input: [{ position: 'fixed', coverage: 0.5 }] },
  { label: 'coverage=null（Number(null)=0）', input: [{ role: 'alertdialog', coverage: null }] },
  { label: 'coverage=undefined', input: [{ coverage: undefined }] },
  { label: 'blocking 字符串 true 不算', input: [{ blocking: 'true' }] },
  { label: 'kind=modal 提升 top-layer', input: [{ kind: 'modal' }] },
  { label: 'layerKind=mask 阻挡', input: [{ layerKind: 'mask' }] },
  { label: '未知 topLayer 值', input: [{ topLayer: 'TOTAL-GARBAGE', position: 'fixed', coverage: 0.5 }] },
  { label: 'backendNodeId 混合', input: [{ backendNodeId: 5.0 }, { backendNodeId: '7' }, { backendNodeId: -1 }, { backendNodeId: 1.5 }] },
  { label: '长 name/id/tag/level/pointerEvents', input: [{ name: LONG_NAME, id: 123, tag: 'DIV', level: 3, pointerEvents: 0, paintOrder: 2 }] },
  { label: 'paintOrder 排序', input: [{ zIndex: 10, paintOrder: 5 }, { zIndex: 10, paintOrder: 1 }] },
  { label: '重复 kind 计数', input: [{ zIndex: 1 }, { zIndex: 2 }, { position: 'fixed' }] },
  { label: '未知 kind 文本', input: [{ kind: 'weird-kind', zIndex: 2 }] },
  { label: '非对象数组项', input: [null, 42, 'x', {}] },
  { label: '空事实对象', input: [{}] },
  { label: '混合全量', input: [
    { role: 'dialog', zIndex: 2000, rect: { x: 10.6, y: 20.4, width: 800, height: 600 } },
    { position: 'fixed', coverage: 0.92, role: 'backdrop' },
    { zIndex: 100, topLayer: 'popover' },
    { zIndex: -1, pointerEvents: 'none' },
    { position: 'sticky', zIndex: 5 },
  ] },
];

test('deriveLayers：全部用例默认选项逐字段相等', () => {
  for (const { label, input } of CASES) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(deriveLayers(asInput(input)))),
      JSON.parse(JSON.stringify(js.deriveLayers(asInput(input) as unknown))),
      label + ' 的层模型不一致',
    );
  }
});

test('deriveLayers：includeBase/limit 选项矩阵逐字段相等', () => {
  const optionsList: DeriveLayersOptions[] = [
    { includeBase: false },
    { includeBase: true, limit: 1 },
    { includeBase: true, limit: 0 },
    { includeBase: false, limit: -5 },
    { includeBase: true, limit: 3 },
    { includeBase: true, limit: 100 },
    { includeBase: true, limit: 101 },
  ];
  for (const options of optionsList) {
    for (const { label, input } of CASES) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(deriveLayers(asInput(input), options))),
        JSON.parse(JSON.stringify(js.deriveLayers(asInput(input) as unknown, options))),
        label + ' / ' + JSON.stringify(options) + ' 的层模型不一致',
      );
    }
  }
});

test('normalizeLayer / describeLayer：逐项逐字段相等', () => {
  for (const { label, input } of CASES) {
    const list: readonly unknown[] = Array.isArray(input)
      ? input
      : (input && Array.isArray((input as { layers?: unknown }).layers)
        ? (input as { layers: readonly unknown[] }).layers
        : []);
    list.forEach((item, sourceIndex) => {
      const tsLayer = normalizeLayer(item as LayerFact, sourceIndex);
      const jsLayer = js.normalizeLayer(item, sourceIndex);
      assert.deepEqual(JSON.parse(JSON.stringify(tsLayer)), JSON.parse(JSON.stringify(jsLayer)),
        label + ' #' + sourceIndex + ' normalizeLayer 不一致');
      assert.equal(describeLayer(tsLayer), js.describeLayer(jsLayer), label + ' #' + sourceIndex + ' describeLayer 不一致');
    });
  }
  assert.equal(describeLayer(null), '');
  assert.equal(js.describeLayer(null), '');
  assert.equal(describeLayer({ kind: 'top-layer', zIndex: 1000, blocking: true } as never), 'top-layer z=1000 blocking');
  assert.equal(describeLayer({ kind: 'base', zIndex: 0, blocking: false } as never), '');
});

test('层模型不变量：index 连续、base 首层、kind 单调不减、backendNodeId 合法', () => {
  const rank = new Map<LayerKind, number>(LAYER_KINDS.map((kind, index) => [kind, index] as const));
  for (const { label, input } of CASES) {
    const model = deriveLayers(asInput(input));
    assert.equal(model.version, VOM_LAYERS_VERSION);
    model.layers.forEach((layer, index) => {
      assert.equal(layer.index, index, label + ' index 必须连续');
      assert.ok(layer.backendNodeId === null || (Number.isInteger(layer.backendNodeId) && layer.backendNodeId > 0),
        label + ' backendNodeId 必须为正整数或 null');
      if (index > 0) {
        const previous = model.layers[index - 1];
        assert.ok(previous);
        assert.ok((rank.get(previous.kind) ?? 0) <= (rank.get(layer.kind) ?? 0), label + ' kind 必须单调不减');
      }
    });
    if (model.layers.length) {
      assert.equal(model.layers[0]?.kind, 'base', label + ' 首层必须是 base');
    }
    const total = Object.values(model.counts.byKind).reduce<number>((sum, count) => sum + (count ?? 0), 0);
    assert.equal(total, model.counts.total, label + ' byKind 计数总和必须等于 total');
    assert.equal(model.counts.total, model.layers.length);
  }
});

test('关键排序与截断硬断言（不依赖 JS 对照）', () => {
  const input = [
    { role: 'dialog', zIndex: 1000 },
    { position: 'fixed' },
    { zIndex: 0 },
  ];
  const model = deriveLayers(input);
  assert.deepEqual(model.layers.map((layer) => layer.kind), ['base', 'fixed-sticky', 'floating', 'top-layer']);
  assert.equal(model.counts.total, 4);
  assert.equal(model.truncated, false);

  const limited = deriveLayers(input, { limit: 3 });
  assert.equal(limited.layers.length, 3);
  assert.equal(limited.truncated, true, '候选 3 + base 1 > limit 3');
  assert.deepEqual(limited.layers.map((layer) => layer.kind), ['base', 'fixed-sticky', 'floating']);

  const noBase = deriveLayers(input, { includeBase: false, limit: 2 });
  assert.equal(noBase.layers.length, 2);
  assert.equal(noBase.layers[0]?.kind, 'fixed-sticky', '不插 base 时第一层就是最低候选');
  assert.equal(noBase.truncated, true, '候选 3 + 0 > limit 2');

  // popover 是 top-layer，但不阻挡指针。
  const popover = deriveLayers([{ topLayer: 'popover' }]);
  assert.equal(popover.layers[1]?.kind, 'top-layer');
  assert.equal(popover.layers[1]?.blocking, false);
  // dialog 是 top-layer 且阻挡指针。
  const dialog = deriveLayers([{ role: 'dialog' }]);
  assert.equal(dialog.layers[1]?.blocking, true);
  // coverage=null 走 Number(null)=0，因此 fixed 不构成阻挡。
  const nullCoverage = deriveLayers([{ position: 'fixed', coverage: null }]);
  assert.equal(nullCoverage.layers[1]?.blocking, false);
  assert.equal(nullCoverage.layers[1]?.coverage, 0);
  // 非法 rect 归 null（候选仍存在，但几何为 null），不产生半截几何。
  assert.equal(normalizeLayer({ rect: { x: 1, y: 2, width: Number.NaN, height: 3 } })?.rect, null);
  assert.equal(normalizeLayer(null), null);
  assert.equal(normalizeLayer(42 as never), null);
});
