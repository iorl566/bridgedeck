/**
 * tools/eval/corpus/vom-geometry.mjs -- invariants for the VOM geometry and
 * visibility pipeline:
 *
 *   extension/src/lib/vom-visibility.js  rect math, visibility gate, occlusion
 *   extension/src/lib/vom-zorder.js      paint order, occluder chains, hit test
 *   extension/src/lib/vom-weights.js     scoring, ranking, token estimate
 *   extension/src/lib/vom-frames-depth.js frame ownership chains
 *
 * These are pure functions over observed facts, which makes them a good match
 * for property-based testing: the generators synthesize rectangles, layer
 * stacks and frame trees, and the properties assert the *documented* invariants
 * (gate nesting, partition, occluder ordering, stack monotonicity, hit-test
 * pass-through, frame-chain acyclicity) rather than duplicating the runtime's
 * implementation line by line.
 */

import { defineProperty } from '../lib/property.mjs';
import { array, boolean, constant, integer, map, natural, oneOf, optional, record, string } from '../lib/gen.mjs';
import { assert, assertBetween, assertDeepEqual, assertEqual, assertIn, assertJsonSafe, assertUnique } from '../lib/assert.mjs';
import {
  GATE_MODES,
  VISIBILITY_REASONS,
  VOM_VISIBILITY_VERSION,
  applyVisibilityGate,
  comparePaintOrder,
  evaluateVisibility,
  isOffscreenNode,
  paintHiddenReason,
  rectArea,
  resolveOcclusion,
  summarizeVisibilityGate,
  visibilityFlags,
  visibilityPayload,
} from '../../../extension/src/lib/vom-visibility.js';
import {
  ZORDER_LIMITS,
  buildZOrderModel,
  compareZorder,
  normalizeZorderItem,
  occlusionChainFor,
  paintOrderBetween,
  resolveHitTest,
  summarizeZOrder,
  zorderArea,
  zorderRect,
} from '../../../extension/src/lib/vom-zorder.js';
import {
  DEFAULT_VOM_WEIGHTS,
  attachVomScores,
  estimateTextTokens,
  estimateVomTokens,
  rankVomNodes,
  scoreVomNode,
  selectVomNodes,
} from '../../../extension/src/lib/vom-weights.js';
import {
  buildFrameDepthReport,
  frameChainOf,
  summarizeFrameDepth,
} from '../../../extension/src/lib/vom-frames-depth.js';

const FILES = Object.freeze({
  visibility: 'extension/src/lib/vom-visibility.js',
  zorder: 'extension/src/lib/vom-zorder.js',
  weights: 'extension/src/lib/vom-weights.js',
  frames: 'extension/src/lib/vom-frames-depth.js',
});

const VISIBILITY = { file: FILES.visibility, symbol: 'evaluateVisibility' };
const VISIBILITY_GATE = { file: FILES.visibility, symbol: 'applyVisibilityGate' };
const VISIBILITY_OCCLUSION = { file: FILES.visibility, symbol: 'resolveOcclusion' };
const VISIBILITY_FLAGS = { file: FILES.visibility, symbol: 'visibilityFlags' };
const VISIBILITY_AREA = { file: FILES.visibility, symbol: 'rectArea' };
const VISIBILITY_PAYLOAD = { file: FILES.visibility, symbol: 'visibilityPayload' };
const ZORDER_BUILD = { file: FILES.zorder, symbol: 'buildZOrderModel' };
const ZORDER_HIT = { file: FILES.zorder, symbol: 'resolveHitTest' };
const ZORDER_SUMMARY = { file: FILES.zorder, symbol: 'summarizeZOrder' };
const WEIGHTS_SCORE = { file: FILES.weights, symbol: 'scoreVomNode' };
const WEIGHTS_RANK = { file: FILES.weights, symbol: 'rankVomNodes' };
const WEIGHTS_TOKENS = { file: FILES.weights, symbol: 'estimateVomTokens' };
const FRAMES_CHAIN = { file: FILES.frames, symbol: 'frameChainOf' };
const FRAMES_REPORT = { file: FILES.frames, symbol: 'buildFrameDepthReport' };

const coord = integer({ min: -1500, max: 1500 });
const size = natural({ max: 700 });
const smallText = string({ minLength: 0, maxLength: 8, alphabet: 'abcXYZ 012' });

const rectSpecGen = record({ x: coord, y: coord, width: size, height: size });

const nodeSpecGen = record({
  x: coord,
  y: coord,
  width: size,
  height: size,
  rectStyle: oneOf([constant('bounds'), constant('w'), constant('rect')]),
  tag: oneOf([constant('button'), constant('div'), constant('input'), constant('a'), constant('h1')]),
  role: oneOf([constant(null), constant('button'), constant('textbox'), constant('dialog'), constant('mask'), constant('link')]),
  name: smallText,
  depth: natural({ max: 8 }),
  interactive: boolean(),
  clickable: oneOf([constant(true), constant(false)]),
  disabled: boolean(),
  hitTest: oneOf([constant(null), constant('blocked'), constant('offscreen'), constant('pointer-events-none'), constant('hit')]),
  pointerEvents: oneOf([constant(null), constant('none'), constant('auto')]),
  layerKind: oneOf([constant(null), constant('base'), constant('floating'), constant('blocking'), constant('top-layer'), constant('fixed-sticky')]),
  zIndex: oneOf([constant(null), integer({ min: -3, max: 5 })]),
  paintOrder: oneOf([constant(null), integer({ min: 0, max: 20 })]),
  blocking: boolean(),
  underBlockingLayer: boolean(),
  detached: boolean(),
  ariaHidden: boolean(),
  visible: oneOf([constant(true), constant(false)]),
  clipped: boolean(),
  paintsVisible: boolean(),
  stylePointer: oneOf([constant(null), constant('none'), constant('auto')]),
});

function rectOfSpec(spec) {
  if (spec.rectStyle === 'w') return { x: spec.x, y: spec.y, w: spec.width, h: spec.height };
  if (spec.rectStyle === 'rect') return { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
  return { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
}

function nodeFromSpec(spec, index, { ancestorIndexes = [] } = {}) {
  const geometry = rectOfSpec(spec);
  const node = {
    id: 'n' + index,
    ref: '@e' + (index + 1),
    tag: spec.tag,
    role: spec.role,
    name: spec.name,
    depth: spec.depth,
    interactive: spec.interactive,
    clickable: spec.clickable,
    disabled: spec.disabled,
    paintVisible: spec.paintsVisible,
    visible: spec.visible,
    ...(spec.rectStyle === 'bounds' ? { bounds: geometry } : {}),
    ...(spec.rectStyle === 'w' ? { rect: geometry } : {}),
    ...(spec.rectStyle === 'rect' ? { rect: geometry } : {}),
    ...(spec.hitTest ? { hitTest: spec.hitTest } : {}),
    ...(spec.pointerEvents ? { pointerEvents: spec.pointerEvents } : {}),
    ...(spec.layerKind ? { layerKind: spec.layerKind } : {}),
    ...(spec.zIndex !== null ? { zIndex: spec.zIndex } : {}),
    ...(spec.paintOrder !== null ? { paintOrder: spec.paintOrder } : {}),
    ...(spec.blocking ? { blocking: true } : {}),
    ...(spec.underBlockingLayer ? { underBlockingLayer: true } : {}),
    ...(spec.detached ? { detached: true } : {}),
    ...(spec.ariaHidden ? { ariaHidden: true } : {}),
    ...(spec.clipped ? { clipped: true } : {}),
    ...(spec.stylePointer ? { styles: { 'pointer-events': spec.stylePointer } } : {}),
    ...(ancestorIndexes.length ? { ancestorIds: ancestorIndexes.map((item) => 'n' + item) } : {}),
  };
  return node;
}

const nodesGen = array(nodeSpecGen, { minLength: 0, maxLength: 5 });

const occlusionNodesGen = record({
  specs: nodesGen,
  ancestors: array(boolean(), { maxLength: 5 }),
});

function buildOcclusionNodes(value) {
  return value.specs.map((spec, index) => nodeFromSpec(spec, index, {
    ancestorIndexes: index > 0 && value.ancestors[index - 1] ? [index - 1] : [],
  }));
}

const layerSpecGen = record({
  x: coord,
  y: coord,
  width: size,
  height: size,
  layerKind: oneOf([constant(null), constant('base'), constant('fixed-sticky'), constant('floating'), constant('blocking'), constant('top-layer')]),
  zIndex: oneOf([constant(null), integer({ min: -2, max: 4 })]),
  paintOrder: oneOf([constant(null), integer({ min: 0, max: 9 })]),
  role: oneOf([constant(null), constant('dialog'), constant('button')]),
  blocking: boolean(),
  pointerEvents: oneOf([constant(null), constant('none'), constant('auto')]),
  ancestorFlag: boolean(),
});

function zorderLayers(value) {
  return value.layers.map((spec, index) => ({
    id: 'l' + index,
    rect: { x: spec.x, y: spec.y, width: spec.width, height: spec.height },
    layerKind: spec.layerKind,
    zIndex: spec.zIndex,
    paintOrder: spec.paintOrder,
    role: spec.role,
    blocking: spec.blocking,
    pointerEvents: spec.pointerEvents,
  }));
}

function zorderNodes(value) {
  return value.nodes.map((spec, index) => ({
    id: 'n' + index,
    rect: { x: spec.x, y: spec.y, width: spec.width, height: spec.height },
    kind: spec.layerKind,
    zIndex: spec.zIndex,
    paintOrder: spec.paintOrder,
    role: spec.role,
    blocking: spec.blocking,
    pointerEvents: spec.pointerEvents,
    ...(index > 0 && spec.ancestorFlag ? { ancestorIds: ['l0'] } : {}),
  }));
}

const zorderGen = record({
  layers: array(layerSpecGen, { minLength: 1, maxLength: 4 }),
  nodes: array(layerSpecGen, { maxLength: 4 }),
  viewport: record({
    x: integer({ min: 0, max: 100 }),
    y: integer({ min: 0, max: 100 }),
    width: integer({ min: 1, max: 1200 }),
    height: integer({ min: 1, max: 900 }),
  }),
});

const weightNodeGen = record({
  name: string({ minLength: 0, maxLength: 12, alphabet: 'abcXYZ' }),
  role: oneOf([constant(null), constant('button'), constant('textbox'), constant('heading')]),
  tag: oneOf([constant('div'), constant('button'), constant('h1'), constant('h3')]),
  interactive: boolean(),
  disabled: boolean(),
  focused: boolean(),
  visible: boolean(),
  ariaHidden: boolean(),
  width: size,
  height: size,
  depth: natural({ max: 8 }),
});

function weightNode(spec, index) {
  const rectWidth = spec.width > 600 ? 0 : spec.width;
  return {
    id: 'w' + index,
    name: spec.name,
    role: spec.role,
    tag: spec.tag,
    interactive: spec.interactive,
    disabled: spec.disabled,
    focused: spec.focused,
    visible: spec.visible,
    ariaHidden: spec.ariaHidden,
    depth: spec.depth,
    rect: { x: 0, y: 0, w: rectWidth, h: spec.height },
  };
}

const frameSpecGen = record({
  parent: integer({ min: -1, max: 5 }),
  hidden: boolean(),
  hasGraph: boolean(),
  graphNodes: natural({ max: 8 }),
  edgesTo: array(natural({ max: 5 }), { maxLength: 2 }),
  graphAvailable: boolean(),
});

function buildFrames(value) {
  const frames = value.frames.map((spec, index) => {
    const frameId = index;
    const parentFrameId = index === 0 ? null : (spec.parent < 0 || spec.parent >= index ? 0 : spec.parent);
    if (!spec.hasGraph) return { frameId, parentFrameId, url: 'about:blank#' + frameId, hidden: spec.hidden };
    return {
      frameId,
      parentFrameId,
      url: 'https://frame.test/' + frameId,
      hidden: spec.hidden,
      vom: {
        available: spec.graphAvailable,
        frameNodeId: 'frame:' + frameId,
        nodes: Array.from({ length: spec.graphNodes }, (_, item) => ({ id: 'f' + item })),
        edges: spec.edgesTo.map((child) => ({ type: 'frame', from: '@e' + child, to: 'frame:' + child })),
        counts: { nodes: spec.graphNodes, edges: spec.edgesTo.length, byType: {} },
        truncated: false,
      },
    };
  });
  return frames;
}

export const area = {
  area: 'vom-geometry',
  title: 'VOM 几何/可见性/绘制栈/权重/跨帧归属不变量',
  properties: [
    defineProperty({
      id: 'vom-geometry/rect-area',
      title: 'rectArea 恒非负，零/负宽高面积为 0，且随尺寸单调',
      area: 'vom-geometry',
      gen: record({ base: rectSpecGen, delta: natural({ max: 100 }) }),
      consumes: [VISIBILITY_AREA],
      check: ({ base, delta }) => {
        const area = rectArea({ x: base.x, y: base.y, width: base.width, height: base.height });
        assert(area >= 0 && Number.isFinite(area), 'rectArea 不是非负有限数', { actual: area });
        assertEqual(rectArea({ x: 0, y: 0, width: 0, height: base.height }), 0, '零宽度面积不为 0');
        assertEqual(rectArea({ x: 0, y: 0, width: -Math.abs(base.width) - 1, height: base.height }), 0, '负宽度面积不为 0');
        const bigger = rectArea({ x: 0, y: 0, width: base.width + delta, height: base.height });
        assert(bigger >= area, '面积没有随宽度单调不减', { expected: '>=' + area, actual: bigger });
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/visibility-flags-consistency',
      title: 'visibilityFlags 与 isOffscreenNode / paintHiddenReason / pointer 判定一致',
      area: 'vom-geometry',
      gen: record({ spec: nodeSpecGen }),
      consumes: [VISIBILITY_FLAGS, { file: FILES.visibility, symbol: 'isOffscreenNode' }],
      check: ({ spec }) => {
        const node = nodeFromSpec(spec, 0);
        const flags = visibilityFlags(node);
        assertEqual(flags.offscreen, isOffscreenNode(node), 'offscreen 口径不一致');
        assertEqual(flags.paintHidden, paintHiddenReason(node) !== null, 'paintHidden 口径不一致');
        assertEqual(flags.hiddenAria, node.visible === false || node.ariaHidden === true, 'hiddenAria 口径不一致');
        assertEqual(flags.hiddenBlocked, node.clickable === false && node.hitTest === 'blocked', 'hiddenBlocked 口径不一致');
        assertEqual(flags.occluded, node.hitTest === 'blocked', 'occluded 口径不一致');
        const pointerNone = String(node.pointerEvents || '').toLowerCase() === 'none'
          || node.hitTest === 'pointer-events-none'
          || Boolean(node.styles && String(node.styles['pointer-events'] || '').toLowerCase() === 'none');
        assertEqual(flags.pointerTransparent, pointerNone, 'pointerTransparent 口径不一致');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/visibility-reasons-ordered',
      title: 'evaluateVisibility 的 reasons ⊆ 枚举且按固定优先级排序、去重',
      area: 'vom-geometry',
      gen: record({ spec: nodeSpecGen, occluder: optional(record({ occluderId: string({ maxLength: 4, alphabet: 'abc' }), coverage: natural({ max: 100 }) })) }),
      consumes: [VISIBILITY],
      check: ({ spec, occluder }) => {
        const node = nodeFromSpec(spec, 0);
        const verdict = evaluateVisibility(node, { occluder });
        assertEqual(verdict.version, VOM_VISIBILITY_VERSION, 'version 不符');
        assertUnique(verdict.reasons, 'reasons 出现重复项');
        for (const reason of verdict.reasons) assertIn(VISIBILITY_REASONS, reason, 'reasons 含未登记项');
        const order = verdict.reasons.map((reason) => VISIBILITY_REASONS.indexOf(reason));
        for (let index = 1; index < order.length; index += 1) {
          assert(order[index - 1] < order[index], 'reasons 未按优先级排序', { actual: verdict.reasons });
        }
        assertEqual(verdict.reason, verdict.reasons[0] || null, 'reason 不是第一个原因');
        if (spec.detached) assert(verdict.reasons.includes('detached'), 'detached 节点缺少 detached 原因');
        if (node.visible === false) assert(verdict.reasons.includes('paint-hidden'), 'visible=false 缺少 paint-hidden');
        if (spec.ariaHidden) assert(verdict.reasons.includes('aria-hidden'), 'ariaHidden 缺少 aria-hidden');
        if (spec.hitTest === 'blocked') {
          assert(verdict.reasons.includes('occluded'), 'hitTest=blocked 缺少 occluded');
          assert(verdict.blocked === true, 'hitTest=blocked 未标记 blocked');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/visibility-gate-nesting',
      title: 'paintable ⊇ visible ⊇ interactable（gate 模式单调嵌套）',
      area: 'vom-geometry',
      gen: record({ spec: nodeSpecGen, occluder: optional(record({ occluderId: string({ maxLength: 4, alphabet: 'abc' }), coverage: natural({ max: 100 }) })) }),
      consumes: [VISIBILITY],
      check: ({ spec, occluder }) => {
        const node = nodeFromSpec(spec, 0);
        const verdict = evaluateVisibility(node, { occluder });
        const reasons = new Set(verdict.reasons);
        const fieldOf = { paintable: 'paintable', visible: 'visible', interactable: 'interactive' };
        for (const mode of Object.keys(GATE_MODES)) {
          const failed = GATE_MODES[mode].some((reason) => reasons.has(reason));
          assertEqual(verdict[fieldOf[mode]], !failed, mode + ' 判定与 reasons 不一致');
        }
        if (verdict.interactive) assert(verdict.visible, 'interactive=true 但 visible=false');
        if (verdict.visible) assert(verdict.paintable, 'visible=true 但 paintable=false');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/gate-partition',
      title: 'applyVisibilityGate 对输入做完整划分，计数与原因分布自洽',
      area: 'vom-geometry',
      gen: record({ specs: nodesGen, mode: oneOf([constant('paintable'), constant('visible'), constant('interactable'), constant('bogus-mode')]) }),
      consumes: [VISIBILITY_GATE],
      check: ({ specs, mode }) => {
        const nodes = specs.map((spec, index) => nodeFromSpec(spec, index));
        const gate = applyVisibilityGate(nodes, { mode });
        const rules = GATE_MODES[mode] || GATE_MODES.paintable;
        assertEqual(gate.counts.input, nodes.length, 'input 计数不符');
        assertEqual(gate.counts.kept, gate.kept, 'kept 计数不符');
        assertEqual(gate.counts.dropped, gate.dropped.length, 'dropped 计数不符');
        assertEqual(gate.counts.kept + gate.counts.dropped, nodes.length, '保留+丢弃不等于输入');
        const byReasonTotal = Object.values(gate.counts.byReason).reduce((sum, value) => sum + value, 0);
        assertEqual(byReasonTotal, gate.dropped.length, 'byReason 计数总和与 dropped 不符');
        const inputIds = new Set(nodes.map((node) => node.id));
        const keptIds = new Set(gate.nodes.map((node) => node.id));
        for (const dropped of gate.dropped) {
          assert(inputIds.has(dropped.id), '丢弃项不在输入里', { actual: dropped.id });
          assert(!keptIds.has(dropped.id), '同一项既保留又丢弃', { actual: dropped.id });
          assert(rules.includes(dropped.reason), '丢弃原因不在当前 gate 规则里', { actual: dropped.reason });
          assert(Array.isArray(dropped.reasons) && dropped.reasons.every((reason) => rules.includes(reason)), 'dropped.reasons 含非触发原因');
        }
        for (const node of gate.nodes) {
          const verdict = evaluateVisibility(node, { occluder: null });
          assertEqual(verdict.reasons.some((reason) => rules.includes(reason)), false, '保留节点仍含触发原因');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/gate-nesting-sets',
      title: '同一批节点：interactable 保留集 ⊆ visible 保留集 ⊆ paintable 保留集',
      area: 'vom-geometry',
      gen: record({ specs: nodesGen }),
      consumes: [VISIBILITY_GATE],
      check: ({ specs }) => {
        const nodes = specs.map((spec, index) => nodeFromSpec(spec, index));
        const occlusion = resolveOcclusion(nodes, {});
        const ids = (mode) => new Set(applyVisibilityGate(nodes, { mode, occlusion }).nodes.map((node) => node.id));
        const paintable = ids('paintable');
        const visible = ids('visible');
        const interactable = ids('interactable');
        for (const id of interactable) assert(visible.has(id), 'interactable 保留集不是 visible 的子集', { actual: id });
        for (const id of visible) assert(paintable.has(id), 'visible 保留集不是 paintable 的子集', { actual: id });
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/occlusion-evidence',
      title: '遮挡证据：覆盖率在阈值内、遮挡者不是自身/祖先、计数自洽',
      area: 'vom-geometry',
      gen: occlusionNodesGen,
      consumes: [VISIBILITY_OCCLUSION],
      check: (value) => {
        const nodes = buildOcclusionNodes(value);
        const result = resolveOcclusion(nodes, {});
        assertEqual(result.count, result.byId.size, '遮挡计数与 byId 不符');
        assert(result.checked <= nodes.length, 'checked 超过输入节点数');
        const threshold = 0.85;
        for (const [id, entry] of result.byId) {
          assert(entry.occluderId !== id, '节点被自己遮挡', { actual: id });
          assertBetween(entry.coverage, threshold, 1, '遮挡覆盖率越过阈值', { actual: entry.coverage });
          const node = nodes.find((item) => item.id === id);
          assert(node, '遮挡记录的节点不在输入里', { actual: id });
          const ancestors = new Set(node.ancestorIds || []);
          assert(!ancestors.has(entry.occluderId), '祖先被当成遮挡者', { actual: entry.occluderId });
          const occluder = nodes.find((item) => item.id === entry.occluderId);
          assert(occluder, '遮挡者不在输入里', { actual: entry.occluderId });
          const eligible = occluder.blocking === true
            || occluder.layerKind === 'blocking'
            || occluder.layerKind === 'top-layer'
            || ['dialog', 'alertdialog', 'overlay', 'mask', 'backdrop'].includes(String(occluder.role || '').toLowerCase());
          assert(eligible, '非阻挡节点被当成遮挡者', { actual: entry.occluderId });
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/occlusion-full-cover',
      title: '完全覆盖的阻挡层必然成为遮挡者；祖先不遮挡后代',
      area: 'vom-geometry',
      gen: record({ rect: rectSpecGen, ancestor: boolean() }),
      consumes: [VISIBILITY_OCCLUSION],
      check: ({ rect, ancestor }) => {
        const target = {
          id: 'target',
          bounds: { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
          ancestorIds: ancestor ? ['blocker'] : [],
        };
        const blocker = { id: 'blocker', blocking: true, layerKind: 'blocking', bounds: target.bounds };
        const result = resolveOcclusion([target, blocker], {});
        if (ancestor) {
          assertEqual(result.byId.has('target'), false, '祖先节点被误判为遮挡');
          return true;
        }
        const entry = result.byId.get('target');
        assert(entry, '完全覆盖的阻挡层没有形成遮挡', { actual: [...result.byId.keys()] });
        assertEqual(entry.occluderId, 'blocker', '遮挡者 id 不符');
        assertEqual(entry.coverage, 1, '完全覆盖的覆盖率不为 1');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/paint-order-total-order',
      title: 'comparePaintOrder 构成全序：反对称、传递、自反为 0',
      area: 'vom-geometry',
      gen: record({
        a: layerSpecGen,
        b: layerSpecGen,
        c: layerSpecGen,
      }),
      consumes: [{ file: FILES.visibility, symbol: 'comparePaintOrder' }],
      check: ({ a, b, c }) => {
        const toNode = (spec, id) => ({ id, layerKind: spec.layerKind, zIndex: spec.zIndex, paintOrder: spec.paintOrder });
        const left = toNode(a, 'a');
        const middle = toNode(b, 'b');
        const right = toNode(c, 'c');
        const sign = (value) => (value > 0 ? 1 : value < 0 ? -1 : 0);
        if (sign(comparePaintOrder(left, middle)) === 0) {
          assertEqual(sign(comparePaintOrder(middle, left)), 0, '比较器不反对称');
        } else {
          assertEqual(sign(comparePaintOrder(left, middle)), -sign(comparePaintOrder(middle, left)), '比较器不反对称');
        }
        assertEqual(comparePaintOrder(left, left), 0, '自反比较不为 0');
        assertEqual(comparePaintOrder(middle, middle), 0, '自反比较不为 0');
        const ab = sign(comparePaintOrder(left, middle));
        const bc = sign(comparePaintOrder(middle, right));
        const ac = sign(comparePaintOrder(left, right));
        if (ab < 0 && bc < 0) assert(ac < 0, '比较器不传递（a<b<c 但 a!<c）', { actual: { ab, bc, ac } });
        if (ab === 0 && bc === 0) assertEqual(ac, 0, '等价关系不传递');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/zorder-stack-sorted',
      title: '绘制栈按 compareZorder 升序，paintIndex 连续，计数自洽',
      area: 'vom-geometry',
      gen: zorderGen,
      consumes: [ZORDER_BUILD, { file: FILES.zorder, symbol: 'compareZorder' }],
      check: (value) => {
        const model = buildZOrderModel({ layers: zorderLayers(value), nodes: zorderNodes(value), viewport: value.viewport });
        for (let index = 0; index < model.stack.length; index += 1) {
          const item = model.stack[index];
          assertEqual(item.paintIndex, index, 'paintIndex 不连续');
          if (index > 0) {
            assert(compareZorder(model.stack[index - 1], item) <= 0, '绘制栈未按 compareZorder 排序', { actual: [model.stack[index - 1].id, item.id] });
          }
        }
        assertEqual(model.counts.stack, model.stack.length, 'stack 计数不符');
        assertEqual(model.counts.layers, value.layers.length, 'layers 计数不符');
        assertEqual(model.counts.nodes, value.nodes.length, 'nodes 计数不符');
        const uniqueIds = new Set([...zorderLayers(value), ...zorderNodes(value)].map((item) => item.id));
        assertEqual(model.counts.items, uniqueIds.size, 'items 计数不是唯一 id 数');
        assert(model.stack.length <= model.limits.stack, 'stack 超过上限');
        assertEqual(model.available, model.stack.some((item) => Boolean(item.rect)), 'available 与带几何项不一致');
        assertUnique(model.stack.map((item) => item.id), 'draw 栈出现重复 id');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/zorder-chains',
      title: '遮挡链：目标有几何、遮挡者在前、覆盖率达标、无祖先互遮',
      area: 'vom-geometry',
      gen: zorderGen,
      consumes: [ZORDER_BUILD, { file: FILES.zorder, symbol: 'occlusionChainFor' }],
      check: (value) => {
        const model = buildZOrderModel({ layers: zorderLayers(value), nodes: zorderNodes(value), viewport: value.viewport });
        for (const chain of model.chains) {
          const target = model.byId.get(chain.id);
          assert(target, '遮挡链目标不在栈里', { actual: chain.id });
          assert(target.rect, '遮挡链目标没有几何');
          assert(zorderArea(target.rect) > 0, '遮挡链目标面积为 0');
          assertEqual(chain.top, chain.occluders[0].id, 'top 不是第一个遮挡者');
          assertEqual(chain.maxCoverage, chain.occluders[0].coverage, 'maxCoverage 不是第一个遮挡者的覆盖率');
          assert(chain.occluders.length <= model.limits.chainDepth, '遮挡链超过深度上限');
          for (const occluder of chain.occluders) {
            assert(occluder.id !== chain.id, '遮挡链包含自身');
            const item = model.byId.get(occluder.id);
            assert(item, '遮挡者不在栈里', { actual: occluder.id });
            assert(occluder.paintIndex > target.paintIndex, '遮挡者不在目标之后绘制', { actual: occluder.id });
            assert(occluder.coverage >= model.limits.threshold - 1e-9, '遮挡覆盖率低于阈值', { actual: occluder.coverage });
            assert(occluder.coverage <= 1, '遮挡覆盖率超过 1');
            assert(!target.ancestorIds.has(occluder.id), '祖先出现在遮挡链');
            assert(!item.ancestorIds.has(target.id), '后代出现在遮挡链');
          }
          assertDeepEqual(occlusionChainFor(model, chain.id), chain.occluders, 'occlusionChainFor 与模型不一致');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/zorder-hit-test',
      title: '命中测试：最前面的非穿透候选中选，pointer-events:none 穿透',
      area: 'vom-geometry',
      gen: zorderGen,
      consumes: [ZORDER_BUILD, ZORDER_HIT],
      check: (value) => {
        const model = buildZOrderModel({ layers: zorderLayers(value), nodes: zorderNodes(value), viewport: value.viewport });
        const points = [
          { x: value.viewport.x + Math.floor(value.viewport.width / 2), y: value.viewport.y + Math.floor(value.viewport.height / 2) },
          { x: 0, y: 0 },
          { x: 10000, y: 10000 },
        ];
        for (const point of points) {
          const hit = resolveHitTest(model, point);
          assertEqual(hit.x, point.x, '命中结果 x 不符');
          assertEqual(hit.y, point.y, '命中结果 y 不符');
          assertEqual(hit.inside, hit.candidates.length > 0, 'inside 与候选数不一致');
          assert(hit.candidates.length <= ZORDER_LIMITS.candidates, '候选数超过上限');
          assertUnique(hit.candidates.map((item) => item.id), '命中候选出现重复 id');
          for (let index = 1; index < hit.candidates.length; index += 1) {
            assert(hit.candidates[index - 1].paintIndex > hit.candidates[index].paintIndex, '候选中没有按绘制倒序排列');
          }
          const candidate = hit.candidates.find((item) => item.passThrough !== true) || null;
          assertEqual(hit.hitId, candidate ? candidate.id : null, 'hitId 不是最前面非穿透候选');
          for (const entry of hit.candidates) {
            const item = model.byId.get(entry.id);
            assert(item, '命中候选不在绘制栈里', { actual: entry.id });
            const pointer = item.pointerEvents == null ? null : String(item.pointerEvents).toLowerCase();
            assertEqual(entry.passThrough, pointer === 'none', 'passThrough 与 pointer-events 不一致', { actual: entry.id });
          }
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/zorder-summary-json-safe',
      title: 'summarizeZOrder 输出 JSON 安全、按上限截断、无 Map 泄漏',
      area: 'vom-geometry',
      gen: zorderGen,
      consumes: [ZORDER_SUMMARY],
      check: (value) => {
        const model = buildZOrderModel({ layers: zorderLayers(value), nodes: zorderNodes(value), viewport: value.viewport });
        const summary = summarizeZOrder(model, { stack: 6, chains: 5, points: 2 });
        assertJsonSafe(summary, 'zorder 摘要不是 JSON 安全值');
        assert(Array.isArray(summary.stack) && summary.stack.length <= 6, 'stack 截断失效');
        assert(Array.isArray(summary.occluded) && summary.occluded.length <= 5, 'occluded 截断失效');
        assert(Array.isArray(summary.hit) && summary.hit.length <= 2, 'hit 截断失效');
        assertEqual(typeof summary.available, 'boolean', 'available 不是布尔');
        assert(Array.isArray(summary.missing), 'missing 不是数组');
        for (const item of summary.stack) assertJsonSafe(item, 'stack 项不是 JSON 安全值');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/weights-hidden-delta',
      title: '权重：visible=false 相对 true 恰好扣 hidden 权重；宽度 0 扣 offscreen 权重',
      area: 'vom-geometry',
      gen: record({ spec: weightNodeGen }),
      consumes: [WEIGHTS_SCORE],
      check: ({ spec }) => {
        const base = weightNode(spec, 0);
        const visible = { ...base, visible: true, ariaHidden: false };
        const hidden = { ...visible, visible: false };
        const visibleScore = scoreVomNode(visible).score;
        const hiddenScore = scoreVomNode(hidden).score;
        assertEqual(visibleScore - hiddenScore, -DEFAULT_VOM_WEIGHTS.hidden, 'hidden 权重差值不符');
        // Offscreen delta: keep the same geometric area (weight area factor equal),
        // only move the rect outside the viewport.
        const inside = { ...visible, rect: { x: 0, y: 0, w: Math.max(1, spec.width), h: Math.max(1, spec.height) } };
        const outside = { ...inside, rect: { x: -2000, y: 0, w: inside.rect.w, h: inside.rect.h } };
        assertEqual(scoreVomNode(inside).score - scoreVomNode(outside).score, -DEFAULT_VOM_WEIGHTS.offscreen, 'offscreen 权重差值不符');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/weights-ranking-stable',
      title: 'rankVomNodes 分数降序、同分保持原序、结果可复现',
      area: 'vom-geometry',
      gen: array(weightNodeGen, { minLength: 0, maxLength: 6 }),
      consumes: [WEIGHTS_RANK, { file: FILES.weights, symbol: 'attachVomScores' }],
      check: (specs) => {
        const nodes = specs.map((spec, index) => weightNode(spec, index));
        const scored = attachVomScores(nodes);
        assertEqual(scored.length, nodes.length, 'attachVomScores 改变了长度');
        for (let index = 0; index < scored.length; index += 1) {
          assertEqual(scored[index].vomScore, scoreVomNode(nodes[index]).score, 'vomScore 与 scoreVomNode 不一致');
          assertEqual(scored[index].id, nodes[index].id, 'attachVomScores 改变了顺序');
        }
        const first = rankVomNodes(scored);
        const second = rankVomNodes(scored);
        assertDeepEqual(first.map((node) => node.id), second.map((node) => node.id), '排序结果不可复现');
        const positions = new Map(nodes.map((node, index) => [node.id, index]));
        for (let index = 1; index < first.length; index += 1) {
          assert(first[index - 1].vomScore >= first[index].vomScore, '排序不是分数降序');
          if (first[index - 1].vomScore === first[index].vomScore) {
            assert(positions.get(first[index - 1].id) < positions.get(first[index].id), '同分未保持原序');
          }
        }
        const limited = rankVomNodes(scored, { limit: 3 });
        assert(limited.length <= Math.min(3, scored.length), 'limit 未生效');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/token-estimate',
      title: 'token 估算：结构开销固定、文本估算随长度单调不减',
      area: 'vom-geometry',
      gen: customTokenTextGen(),
      consumes: [WEIGHTS_TOKENS, { file: FILES.weights, symbol: 'estimateTextTokens' }],
      check: (value) => {
        const shortText = 'a'.repeat(value.length);
        const longText = shortText + 'b';
        const shortTokens = estimateVomTokens({ name: shortText, role: '' });
        const longTokens = estimateVomTokens({ name: longText, role: '' });
        assert(longTokens >= shortTokens, 'token 估算没有随名字变长而单调');
        assertEqual(shortTokens, 8 + estimateTextTokens(shortText), '节点 token 未包含固定结构开销');
        assert(estimateTextTokens('') === 0, '空文本 token 不为 0');
        assert(estimateTextTokens(shortText) >= 0, '文本 token 为负');
        const selected = selectVomNodes([{ id: 'a', name: shortText }, { id: 'b', name: longText }], { maxNodes: 1 });
        assertEqual(selected.nodes.length, 1, 'selectVomNodes maxNodes 未生效');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/frame-chain-forest',
      title: 'frameChainOf 在森林上无环、路径递增、深度自洽',
      area: 'vom-geometry',
      gen: record({ frames: array(frameSpecGen, { minLength: 1, maxLength: 5 }), probe: natural({ max: 4 }) }),
      consumes: [FRAMES_CHAIN, FRAMES_REPORT],
      check: ({ frames: specs, probe }) => {
        const frames = buildFrames({ frames: specs });
        const parentById = new Map(frames.map((frame) => [frame.frameId, frame.parentFrameId]));
        const probeId = Math.min(probe, frames.length - 1);
        const chain = frameChainOf(probeId, parentById, { maxChain: 8 });
        assertEqual(chain.frameId, probeId, 'chain.frameId 不符');
        assert(chain.path[0] === probeId, 'chain.path 不以起点开头');
        assertUnique(chain.path, 'chain.path 出现重复节点');
        assertEqual(chain.depth, chain.path.length - 1, 'chain.depth 与路径长度不符');
        assertEqual(chain.cycle, false, '森林出现了环');
        assertEqual(chain.missingParent, false, '森林出现了缺失父帧');
        if (probeId !== 0) assert(chain.path[chain.path.length - 1] === 0, '非根 chain 没有到达根 0');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/frame-depth-report',
      title: 'buildFrameDepthReport：帧数/图节点/links 自洽，缺口有结构化证据',
      area: 'vom-geometry',
      gen: record({ frames: array(frameSpecGen, { minLength: 1, maxLength: 6 }) }),
      consumes: [FRAMES_REPORT],
      check: ({ frames: specs }) => {
        const frames = buildFrames({ frames: specs });
        const report = buildFrameDepthReport({ frames });
        assertEqual(report.stats.frames, frames.length, 'stats.frames 不符');
        assertEqual(report.frames.length, frames.length, 'frames 条目数不符');
        const expectedNodes = frames.reduce((sum, frame) => sum + (frame.vom ? frame.vom.counts.nodes : 0), 0);
        assertEqual(report.stats.nodes, expectedNodes, 'stats.nodes 不符');
        const expectedLinks = frames.reduce((sum, frame) => sum + (frame.vom ? frame.vom.edges.length : 0), 0);
        assertEqual(report.stats.links, expectedLinks, 'stats.links 不符');
        for (const entry of report.frames) {
          assert(entry.chain.path[0] === entry.frameId, '条目 chain 起点不符');
          assertEqual(entry.chain.cycle, false, '合法帧树出现环');
          const hasGraph = Boolean(frames.find((frame) => frame.frameId === entry.frameId).vom);
          if (!hasGraph) assert(report.gaps.some((gap) => gap.frameId === entry.frameId), '缺失图的帧没有结构化缺口');
        }
        for (const link of report.links) {
          const owner = frames.find((frame) => frame.frameId === link.fromFrameId);
          assert(owner && owner.vom, 'frame link 的 owner 帧缺少子图');
          assert(owner.vom.edges.some((edge) => edge.from === link.ownerId && edge.to === 'frame:' + link.toFrameId), 'frame link 在子图里没有对应边');
        }
        const summary = summarizeFrameDepth(report, { frames: 3, gaps: 3 });
        assertJsonSafe(summary, 'frameDepth 摘要不是 JSON 安全值');
        assert(summary.frames.length <= 3, 'frames 截断失效');
        assert(summary.gaps.length <= 3, 'gaps 截断失效');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/visibility-payload-shape',
      title: 'visibilityPayload 字段与 evaluateVisibility 一致且可 JSON 序列化',
      area: 'vom-geometry',
      gen: record({ spec: nodeSpecGen, occluder: optional(record({ occluderId: string({ maxLength: 3, alphabet: 'abc' }), coverage: natural({ max: 100 }) })) }),
      consumes: [VISIBILITY_PAYLOAD, VISIBILITY],
      check: ({ spec, occluder }) => {
        const node = nodeFromSpec(spec, 0);
        const verdict = evaluateVisibility(node, { occluder });
        const payload = visibilityPayload(node, { occluder });
        assertJsonSafe(payload, 'visibilityPayload 不是 JSON 安全值');
        assertEqual(payload.version, verdict.version, 'version 不一致');
        assertEqual(payload.paintable, verdict.paintable, 'paintable 不一致');
        assertEqual(payload.visible, verdict.visible, 'visible 不一致');
        assertEqual(payload.interactive, verdict.interactive, 'interactive 不一致');
        assertEqual(payload.reason, verdict.reason, 'reason 不一致');
        assertDeepEqual(payload.reasons, verdict.reasons, 'reasons 不一致');
        assertDeepEqual(payload.paint, verdict.paint, 'paint 证据不一致');
        if (occluder && occluder.occluderId != null && verdict.occluded) {
          assert(payload.occluder, '遮挡时 payload 缺少 occluder 证据');
          assertEqual(payload.occluder.id, String(occluder.occluderId), 'occluder id 不符');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/normalize-zorder-item',
      title: 'normalizeZorderItem：id 优先级、rect 归一化、blocking 推导稳定',
      area: 'vom-geometry',
      gen: record({
        spec: layerSpecGen,
        preferRef: boolean(),
        index: natural({ max: 20 }),
      }),
      consumes: [{ file: FILES.zorder, symbol: 'normalizeZorderItem' }, { file: FILES.zorder, symbol: 'zorderRect' }],
      check: ({ spec, preferRef, index }) => {
        const item = {
          ref: preferRef ? '@e' + index : undefined,
          stableRef: preferRef ? undefined : 's' + index,
          rect: { x: spec.x, y: spec.y, width: Math.max(0, spec.width), height: Math.max(0, spec.height) },
          layerKind: spec.layerKind,
          zIndex: spec.zIndex,
          paintOrder: spec.paintOrder,
          role: spec.role,
          blocking: spec.blocking,
          pointerEvents: spec.pointerEvents,
        };
        const normalized = normalizeZorderItem(item, { sourceIndex: index });
        assert(normalized, '合法层事实没有归一化结果');
        assertEqual(normalized.id, preferRef ? '@e' + index : 's' + index, 'id 优先级不符');
        const rect = zorderRect(item);
        assertEqual(zorderArea(normalized.rect), zorderArea(rect), 'zorderArea 与 rect 不一致');
        if (spec.blocking || spec.layerKind === 'blocking' || spec.layerKind === 'top-layer' || ['dialog', 'alertdialog', 'overlay', 'mask', 'backdrop'].includes(String(spec.role || '').toLowerCase())) {
          assertEqual(normalized.blocking, true, '阻挡语义没有推导出来');
        }
        if (normalized.paintOrder !== null) assert(Number.isFinite(normalized.paintOrder), 'paintOrder 不是有限数');
        return true;
      },
    }),
    defineProperty({
      id: 'vom-geometry/paint-order-between-neighbors',
      title: 'paintOrderBetween 与栈顺序一致（相邻元素负/零，未知返回 null）',
      area: 'vom-geometry',
      gen: zorderGen,
      consumes: [{ file: FILES.zorder, symbol: 'paintOrderBetween' }],
      check: (value) => {
        const model = buildZOrderModel({ layers: zorderLayers(value), nodes: zorderNodes(value), viewport: value.viewport });
        for (let index = 1; index < model.stack.length; index += 1) {
          const left = model.stack[index - 1].id;
          const right = model.stack[index].id;
          const order = paintOrderBetween(model, left, right);
          assert(Number.isFinite(order), '已知元素的比较结果不是数字', { actual: { left, right, order } });
          assert(order <= 0, '相邻元素的绘制顺序不单调', { actual: { left, right, order } });
        }
        assertEqual(paintOrderBetween(model, 'missing-a', 'missing-b'), null, '未知元素返回了非 null');
        return true;
      },
    }),
  ],
};

/** Token-length-only generator (defined after helpers to keep the file readable). */
function customTokenTextGen() {
  return map(integer({ min: 0, max: 40 }), (length) => length);
}

export default area;

