// 统一可见性/遮挡 gate：单一判定口径、paint-order 比较、几何遮挡、按模式过滤、权重兼容 flags。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_MODES,
  VISIBILITY_REASONS,
  VOM_VISIBILITY_VERSION,
  applyVisibilityGate,
  comparePaintOrder,
  evaluateVisibility,
  isFactVisible,
  isOffscreenNode,
  isPointerTransparent,
  paintHiddenReason,
  resolveOcclusion,
  summarizeVisibilityGate,
  visibilityFlags,
  visibilityPayload,
} from '../../extension/src/lib/vom-visibility.js';

const BUTTON = { id: '@e1', role: 'button', tag: 'button', clickable: true, hitTest: 'self', bounds: { x: 0, y: 0, width: 100, height: 40 } };

test('基础判定：默认按钮三态全通过', () => {
  assert.equal(VOM_VISIBILITY_VERSION, 1);
  assert.ok(VISIBILITY_REASONS.includes('paint-hidden'));
  const verdict = evaluateVisibility(BUTTON);
  assert.equal(verdict.paintable, true);
  assert.equal(verdict.visible, true);
  assert.equal(verdict.interactive, true);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.pointerEvents, null);
});

test('paint-hidden：display/visibility/opacity/paintVisible/visible:false 统一归因', () => {
  for (const node of [
    { ...BUTTON, display: 'none' },
    { ...BUTTON, styleVisibility: 'hidden' },
    { ...BUTTON, styleVisibility: 'collapse' },
    { ...BUTTON, styleOpacity: 0 },
    { ...BUTTON, paintVisible: false, hiddenReason: 'content-hidden' },
    { ...BUTTON, visible: false },
  ]) {
    const verdict = evaluateVisibility(node);
    assert.equal(verdict.paintable, false, JSON.stringify(node));
    assert.equal(verdict.visible, false);
    assert.equal(verdict.interactive, false);
    assert.equal(verdict.reason, 'paint-hidden');
    assert.ok(verdict.reasons.includes('paint-hidden'));
  }
  assert.equal(paintHiddenReason({ display: 'none' }), 'display-none');
  assert.equal(paintHiddenReason({ styleVisibility: 'hidden' }), 'visibility-hidden');
  assert.equal(paintHiddenReason({ styleOpacity: '0.0' }), 'opacity-zero');
  assert.equal(paintHiddenReason({ paintVisible: true }), null);
});

test('aria-hidden / detached 也是 paintable 级原因', () => {
  const aria = evaluateVisibility({ ...BUTTON, ariaHidden: true });
  assert.equal(aria.paintable, false);
  assert.equal(aria.reason, 'aria-hidden');
  const detached = evaluateVisibility({ ...BUTTON, detached: true });
  assert.equal(detached.paintable, false);
  assert.equal(detached.reason, 'detached');
});

test('offscreen：矩形越界 / inViewport=false / 页面 hitTest=offscreen', () => {
  const far = evaluateVisibility({ ...BUTTON, bounds: { x: -2000, y: 0, width: 10, height: 10 } });
  assert.equal(far.paintable, true);
  assert.equal(far.visible, false);
  assert.equal(far.reason, 'offscreen');
  assert.equal(evaluateVisibility({ ...BUTTON, inViewport: false }).visible, false);
  assert.equal(evaluateVisibility({ ...BUTTON, hitTest: 'offscreen' }).reason, 'offscreen');
  assert.equal(isOffscreenNode({ rect: { x: 0, y: 0, w: 0, h: 0 } }), true);
  assert.equal(isOffscreenNode({ rect: { x: 5, y: 5, w: 20, h: 20 } }), false);
  // 无 rect 的节点保持既有判断：零面积 -> offscreen。
  assert.equal(isOffscreenNode({}), true);
});

test('clipped / pointer-events-none / blocked / underBlockingLayer / recycled-row', () => {
  const clipped = evaluateVisibility({ ...BUTTON, clipped: true, clippedBy: 'scroll-box' });
  assert.equal(clipped.visible, false);
  assert.equal(clipped.reason, 'clipped');
  const pe = evaluateVisibility({ ...BUTTON, pointerEvents: 'none' });
  assert.equal(pe.visible, true);
  assert.equal(pe.interactive, false);
  assert.equal(pe.reason, 'pointer-events-none');
  const blocked = evaluateVisibility({ ...BUTTON, hitTest: 'blocked', clickable: false, occludedBy: { tag: 'div' } });
  assert.equal(blocked.interactive, false);
  assert.equal(blocked.occluded, true);
  assert.equal(blocked.reason, 'occluded');
  const blocking = evaluateVisibility({ ...BUTTON, underBlockingLayer: { role: 'dialog' } });
  assert.equal(blocking.reason, 'blocking-layer');
  assert.equal(blocking.interactive, false);
  const recycled = evaluateVisibility({ ...BUTTON, anchor: { recycled: true } });
  assert.equal(recycled.reason, 'recycled-row');
  assert.equal(recycled.paintable, true);
  assert.equal(recycled.visible, true);
  assert.equal(recycled.interactive, false);
});

test('isPointerTransparent / isFactVisible 兼容节点事实与 DOMSnapshot 事实', () => {
  assert.equal(isPointerTransparent({ pointerEvents: 'none' }), true);
  assert.equal(isPointerTransparent({ styles: { 'pointer-events': 'none' } }), true);
  assert.equal(isPointerTransparent({ hitTest: 'pointer-events-none' }), true);
  assert.equal(isPointerTransparent({ pointerEvents: 'auto' }), false);
  assert.equal(isFactVisible({ visible: true }), true);
  assert.equal(isFactVisible({ visible: false }), false);
  assert.equal(isFactVisible({}), false);
  assert.equal(isFactVisible(null), false);
});

test('visibilityFlags 与 vom-weights 既有打分口径一致（分值零漂移前提）', () => {
  assert.deepEqual(
    visibilityFlags({ rect: { x: -5000, y: 0, w: 10, h: 10 } }),
    { offscreen: true, hiddenBlocked: false, hiddenAria: false, occluded: false, pointerTransparent: false, paintHidden: false },
  );
  const blocked = visibilityFlags({ clickable: false, hitTest: 'blocked' });
  assert.equal(blocked.hiddenBlocked, true);
  assert.equal(blocked.occluded, true);
  const aria = visibilityFlags({ visible: false });
  assert.equal(aria.hiddenAria, true);
  assert.equal(visibilityFlags({}).offscreen, true, '无尺寸节点按既有口径算 offscreen');
  assert.equal(visibilityFlags({ rect: { x: 1, y: 1, w: 10, h: 10 } }).offscreen, false);
});

test('comparePaintOrder：层种类 → z-index → paintOrder', () => {
  const base = { layerKind: 'base', paintOrder: 9 };
  const floating = { layerKind: 'floating', zIndex: 10, paintOrder: 1 };
  const blocking = { layerKind: 'blocking', zIndex: 1, paintOrder: 2 };
  assert.ok(comparePaintOrder(base, floating) < 0);
  assert.ok(comparePaintOrder(floating, blocking) < 0);
  assert.ok(comparePaintOrder({ layerKind: 'floating', zIndex: 50 }, { layerKind: 'floating', zIndex: 10 }) > 0);
  assert.ok(comparePaintOrder({ paintOrder: 1 }, { paintOrder: 2 }) < 0);
  assert.equal(comparePaintOrder({ layerKind: 'floating', zIndex: 5 }, { layerKind: 'floating', zIndex: 5 }), 0);
});

test('resolveOcclusion：阻挡层覆盖则被遮挡，祖先覆盖不算，覆盖率不足不算', () => {
  const dialog = {
    id: '@dialog',
    role: 'dialog',
    blocking: true,
    layerKind: 'top-layer',
    paintOrder: 10,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  const button = { ...BUTTON, paintOrder: 1 };
  const outside = { id: '@outside', role: 'button', clickable: true, hitTest: 'self', paintOrder: 2, bounds: { x: 500, y: 500, width: 50, height: 20 } };
  const insideDialog = { id: '@inside', role: 'button', clickable: true, hitTest: 'self', paintOrder: 11, bounds: { x: 10, y: 10, width: 60, height: 20 }, ancestorIds: ['@dialog'] };
  const result = resolveOcclusion([dialog, button, outside, insideDialog], { threshold: 0.85 });
  assert.equal(result.byId.get('@e1').occluderId, '@dialog');
  assert.equal(result.byId.get('@e1').coverage, 1);
  assert.equal(result.byId.has('@outside'), false);
  // 祖先 dialog 覆盖子按钮是正常包含关系，不算遮挡。
  assert.equal(result.byId.has('@inside'), false);
  assert.ok(result.checked > 0);

  // 小阻挡层只覆盖 10%：覆盖率不足，不算遮挡。
  const partialBlocker = { id: '@partial', role: 'button', blocking: true, layerKind: 'blocking', bounds: { x: 0, y: 0, width: 20, height: 20 } };
  const target = { ...BUTTON, paintOrder: 2 };
  const partial = resolveOcclusion([partialBlocker, target], { threshold: 0.85 });
  assert.equal(partial.byId.has('@e1'), false);
});

test('resolveOcclusion：层模型里的阻挡层也参与遮挡', () => {
  const layer = { id: 'layer-mask', role: 'overlay', blocking: true, bounds: { x: 0, y: 0, width: 300, height: 200 } };
  const button = { ...BUTTON, paintOrder: 1 };
  const result = resolveOcclusion([button], { layers: [layer] });
  assert.equal(result.byId.get('@e1').occluderId, 'layer-mask');
});

test('applyVisibilityGate：三种模式的丢弃原因与计数', () => {
  const nodes = [
    { ...BUTTON, id: '@ok' },
    { ...BUTTON, id: '@display', display: 'none' },
    { ...BUTTON, id: '@aria', ariaHidden: true },
    { ...BUTTON, id: '@ocr', hitTest: 'blocked', clickable: false },
    { ...BUTTON, id: '@pe', pointerEvents: 'none' },
    { ...BUTTON, id: '@recycled', anchor: { recycled: true } },
  ];
  const paintable = applyVisibilityGate(nodes, { mode: 'paintable' });
  assert.equal(paintable.counts.input, 6);
  assert.equal(paintable.kept, 4);
  assert.equal(paintable.counts.byReason['paint-hidden'], 1);
  assert.equal(paintable.counts.byReason['aria-hidden'], 1);
  assert.ok(paintable.dropped.every((item) => typeof item.reason === 'string' && item.reasons.length > 0));
  assert.deepEqual(GATE_MODES.paintable, ['detached', 'paint-hidden', 'aria-hidden']);

  const visible = applyVisibilityGate(nodes, { mode: 'visible' });
  assert.equal(visible.counts.input, 6);
  const interactable = applyVisibilityGate(nodes, { mode: 'interactable' });
  assert.equal(interactable.kept, 1);
  assert.deepEqual(interactable.nodes.map((node) => node.id), ['@ok']);
  assert.equal(interactable.counts.byReason.occluded, 1);
  assert.equal(interactable.counts.byReason['pointer-events-none'], 1);
  assert.equal(interactable.counts.byReason['recycled-row'], 1);

  const summary = summarizeVisibilityGate(interactable);
  assert.equal(summary.version, 1);
  assert.equal(summary.mode, 'interactable');
  assert.equal(summary.kept, 1);
  assert.equal(summary.dropped, 5);
  assert.equal(applyVisibilityGate([], {}).kept, 0);
});

test('visibilityPayload：紧凑字段 + 遮挡者证据', () => {
  const blockedNode = visibilityPayload({ ...BUTTON, underBlockingLayer: { role: 'dialog' } });
  assert.equal(blockedNode.version, 1);
  assert.equal(blockedNode.paintable, true);
  assert.equal(blockedNode.interactive, false);
  assert.equal(blockedNode.reason, 'blocking-layer');
  const occludedNode = visibilityPayload({ ...BUTTON, hitTest: 'blocked' }, { occluder: { occluderId: 'layer-1', coverage: 0.92 } });
  assert.equal(occludedNode.reason, 'occluded');
  assert.deepEqual(occludedNode.occluder, { id: 'layer-1', coverage: 0.92 });
  assert.equal(occludedNode.paint.kind, null);
  const clean = visibilityPayload(BUTTON);
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.occluder, undefined);
});
