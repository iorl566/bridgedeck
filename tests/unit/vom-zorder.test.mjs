// VOM z-order：绘制栈 / 遮挡链 / 命中测试 / 缺失证据（纯函数层）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZORDER_MISSING,
  VOM_ZORDER_VERSION,
  buildZOrderModel,
  compareZorder,
  describeZOrder,
  normalizeZorderItem,
  occlusionChainFor,
  paintOrderBetween,
  resolveHitTest,
  summarizeZOrder,
  zorderId,
  zorderRect,
} from '../../extension/src/lib/vom-zorder.js';

function fullModel() {
  return buildZOrderModel({
    viewport: { x: 0, y: 0, width: 1000, height: 800 },
    layers: [
      { id: 'mask', rect: { x: 0, y: 0, width: 1000, height: 800 }, blocking: true, layerKind: 'blocking', role: 'overlay' },
      { id: 'dialog', role: 'dialog', topLayer: 'modal-dialog', bounds: { x: 100, y: 100, width: 300, height: 200 } },
    ],
    nodes: [
      { id: 'btn', rect: { x: 120, y: 120, width: 80, height: 30 }, pointerEvents: 'auto', paintOrder: 1 },
      { id: 'under', rect: { x: 110, y: 110, width: 60, height: 20 }, paintOrder: 2 },
      { id: 'scroll', rect: { x: 600, y: 600, width: 100, height: 40 }, pointerEvents: 'auto', paintOrder: 3 },
    ],
  });
}

test('空输入：available=false，缺失证据逐条标注而不是补造', () => {
  const model = buildZOrderModel({});
  assert.equal(model.version, VOM_ZORDER_VERSION);
  assert.equal(model.available, false);
  assert.equal(model.stack.length, 0);
  const missingReasons = model.missing.map((item) => item.reason);
  for (const expected of [ZORDER_MISSING.geometry, ZORDER_MISSING.layers, ZORDER_MISSING.paintOrder, ZORDER_MISSING.hitTest, ZORDER_MISSING.viewport]) {
    assert.ok(missingReasons.includes(expected), '缺少缺失原因 ' + expected);
  }
  const summary = summarizeZOrder(model);
  assert.equal(summary.available, false);
  assert.equal(summary.counts.stack, 0);
  assert.ok(summary.missing.some((item) => item.evidence === 'layers'));
});

test('绘制栈：层与节点合并去重、按 rank/zIndex/paintOrder 排序，paintIndex 递增', () => {
  const model = fullModel();
  assert.equal(model.available, true);
  const ids = model.stack.map((item) => item.id);
  assert.deepEqual(ids, ['btn', 'under', 'scroll', 'mask', 'dialog']);
  for (let index = 1; index < model.stack.length; index += 1) {
    assert.equal(model.stack[index].paintIndex, model.stack[index - 1].paintIndex + 1);
  }
  assert.equal(model.byId.get('mask').blocking, true);
  assert.equal(model.byId.get('mask').kind, 'blocking');
  assert.equal(model.byId.get('dialog').kind, 'top-layer');
  assert.deepEqual(model.topBlocking.map((item) => item.id), ['mask', 'dialog']);
  // 同 id 同时出现在层与节点事实里时合并且以节点几何为准。
  const merged = buildZOrderModel({
    layers: [{ id: 'x', layerKind: 'floating', blocking: false }],
    nodes: [{ id: 'x', rect: { x: 1, y: 2, width: 3, height: 4 }, paintOrder: 2 }],
  });
  assert.equal(merged.stack.length, 1);
  assert.deepEqual(merged.stack[0].rect, { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(merged.stack[0].paintOrder, 2);
});

test('遮挡链：覆盖目标的靠前元素全部入链（front→back），祖先不算遮挡', () => {
  const model = fullModel();
  const chain = occlusionChainFor(model, 'btn');
  assert.deepEqual(chain.map((item) => item.id), ['dialog', 'mask', 'under'], 'under 与 btn 有 25% 重叠，也应入链');
  assert.equal(chain[0].coverage, 1);
  assert.equal(chain[0].blocking, true);
  assert.equal(model.counts.chains, 3);
  // 遮罩覆盖整个视口，滚动区同样被它遮挡。
  assert.deepEqual(occlusionChainFor(model, 'scroll').map((item) => item.id), ['mask']);
  // 祖先（dialog 是 btn 的祖先）不判遮挡；没有其它遮挡者时链为空。
  const ancestorModel = buildZOrderModel({
    layers: [{ id: 'dialog', role: 'dialog', topLayer: 'modal-dialog', rect: { x: 100, y: 100, width: 300, height: 200 } }],
    nodes: [{ id: 'btn', rect: { x: 120, y: 120, width: 80, height: 30 }, ancestorIds: ['dialog'] }],
  });
  assert.deepEqual(occlusionChainFor(ancestorModel, 'btn'), []);
});

test('命中测试：视口采样点取最前元素，pointer-events:none 可穿透', () => {
  const model = fullModel();
  const center = resolveHitTest(model, { x: 150, y: 150 });
  assert.equal(center.inside, true);
  assert.equal(center.hitId, 'dialog');
  assert.equal(center.blockingHit, true);
  assert.deepEqual(center.candidates.map((item) => item.id), ['dialog', 'mask', 'btn']);
  // dialog 穿透后命中最上层非穿透元素。
  const transparent = buildZOrderModel({
    viewport: { x: 0, y: 0, width: 200, height: 200 },
    layers: [{ id: 'pop', topLayer: 'popover', rect: { x: 0, y: 0, width: 200, height: 200 }, pointerEvents: 'none' }],
    nodes: [{ id: 'base-btn', rect: { x: 50, y: 50, width: 100, height: 40 } }],
  });
  const point = resolveHitTest(transparent, { x: 100, y: 70 });
  assert.equal(point.candidates[0].id, 'pop');
  assert.equal(point.candidates[0].passThrough, true);
  assert.equal(point.hitId, 'base-btn');
  // 视口外：inside=false，不猜命中。
  assert.equal(resolveHitTest(model, { x: 2000, y: 2000 }).inside, false);
  assert.equal(resolveHitTest(model, { x: 2000, y: 2000 }).hitId, null);
  assert.equal(model.counts.points, 3, '默认给视口中心 + 两个四分点');
  assert.equal(model.hit.length, 3);
});

test('几何缺失/层缺失/无 paint-order：进入 missing，节点数量仍如实统计', () => {
  const model = buildZOrderModel({ nodes: [{ id: 'no-rect', paintOrder: null }], layers: [] });
  assert.equal(model.available, false);
  assert.equal(model.counts.nodes, 1);
  // 无几何项仍在栈里（可表达层身份），但 available=false 且进 missing。
  assert.equal(model.counts.stack, 1);
  const reasons = model.missing.map((item) => item.reason);
  assert.ok(reasons.includes(ZORDER_MISSING.geometry));
  assert.ok(reasons.includes(ZORDER_MISSING.layers));
  assert.ok(reasons.includes(ZORDER_MISSING.paintOrder));
  assert.equal(model.evidence.geometry.available, false);
});

test('paintOrderBetween / compareZorder / zorderId / zorderRect 边界', () => {
  const model = fullModel();
  assert.ok(paintOrderBetween(model, 'btn', 'mask') < 0, 'btn 先画（更靠后）');
  assert.ok(paintOrderBetween(model, 'dialog', 'mask') > 0);
  assert.equal(paintOrderBetween(model, 'btn', 'missing'), null);
  assert.equal(compareZorder({ rank: 2, zIndex: 1, paintOrder: 0, sourceIndex: 0 }, { rank: 2, zIndex: 2, paintOrder: 0, sourceIndex: 0 }), -1);
  assert.equal(zorderId({ ref: '@e2' }), '@e2');
  assert.equal(zorderId({ stableRef: 's-1' }), 's-1');
  assert.equal(zorderId({}, -1), null);
  assert.deepEqual(zorderRect({ bounds: { x: 1, y: 2, w: 3, h: 4 } }), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(zorderRect({ rect: { x: 1, y: 2 } }), null);
  const item = normalizeZorderItem({ role: 'dialog', zIndex: '10', styles: { 'z-index': '9' } }, { sourceIndex: 4 });
  assert.equal(item.role, 'dialog');
  assert.equal(item.zIndex, 10);
  assert.equal(item.blocking, true);
  assert.equal(item.sourceIndex, 4);
});

test('上限与摘要：truncated 标记，summary 可 JSON 序列化', () => {
  const nodes = [];
  for (let index = 0; index < 20; index += 1) nodes.push({ id: 'n' + index, rect: { x: 0, y: 0, width: 10, height: 10 }, paintOrder: index });
  const model = buildZOrderModel({ nodes, limits: { stack: 5, chains: 2 } });
  assert.equal(model.stack.length, 5);
  assert.equal(model.counts.items, 20);
  assert.equal(model.truncated, true);
  const summary = summarizeZOrder(model, { stack: 3, chains: 1, points: 2 });
  assert.equal(summary.stack.length, 3);
  assert.equal(summary.occluded.length, 1);
  assert.ok(summary.truncated);
  const roundTrip = JSON.parse(JSON.stringify(summary));
  assert.deepEqual(roundTrip.counts, summary.counts);
  assert.ok(!(roundTrip.byId instanceof Map));
  const text = describeZOrder(summary);
  assert.match(text, /zorder stack=5/);
  assert.match(text, /missing=/);
});
