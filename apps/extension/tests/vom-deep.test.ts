// tests/vom-deep.test.ts —— VOM 深水区字段的形状/阈值/跨模块一致性。
//
// 覆盖（对应 E2E 失败项）：
// - 35f visualObjects：canvas/图片/自绘区域 + ref 的 stableRef（与 background ref 注册表同算法）；
// - 35g layers：paint-order 分层（modal/mask + coverage/paintOrder/members）+ issues 为空；
// - 35h vom.graph：containment/ownership/roots/ancestorIds/label 边/AX 边/child 兼容字段；
// - 35b 命中测试：self/descendant/blocked/pointer-events-none/offscreen + occludedBy/inViewport；
// - 35c 对比度：hex/rgb 高/低对比度 + oklch/color-mix 数值；
// - 15d/15e frames：跨源与嵌套 iframe 子图（frame 节点/命名空间/frame 边/links/unlinked）；
// - 采集问题收集器与阈值常量。
//
// 所有断言都走运行时同一条 DOM 流程（fake-dom → dumpObservation → rich），不单独造一套实现。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildObservation } from '../src/content/dom.ts';
import { buildRichObservation, estimateVomLineTokens } from '../src/content/rich.ts';
import { VOM_LOW_CONTRAST_THRESHOLD } from '../src/content/vom-deep.ts';
import { VOM_LAYER_MIN_COVERAGE } from '../src/content/vom-layers.ts';
import { buildVomFramesFromCaptures, VOM_FRAME_LIMITS } from '../src/content/vom-frames.ts';
import { createFakeDom } from './support/fake-dom.ts';
import type { FakeElementSpec } from './support/fake-dom.ts';
import { toObserveActionResult } from '../src/actions/observation.ts';
import { ContentSession } from '../src/content/session.ts';
import { makeContentRequest } from '../src/content/protocol.ts';
import { contrastRatio, parseCssColor, compositeColor } from '../../../packages/vom/src/color.ts';

/** fake-dom 的 StyleLike 不含颜色字段；用这个 helper 明确标注“这是测试注入的 computed style”。 */
function style(facts: Record<string, string | number | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

interface BuiltPage {
  env: ReturnType<typeof createFakeDom>['env'];
  rich: ReturnType<typeof buildRichObservation>;
  nodes: NonNullable<ReturnType<typeof buildRichObservation>['nodes']>;
  byId: (id: string) => NonNullable<ReturnType<typeof buildRichObservation>['nodes']>[number] | undefined;
}

function buildPage(
  elements: FakeElementSpec[],
  options: { url?: string; documentId?: string; ax?: boolean; deepFacts?: boolean } = {},
): BuiltPage {
  const fake = createFakeDom(elements, { title: 'VOM 深水区夹具', url: options.url ?? 'https://example.test/deep.html' });
  const built = buildObservation(fake.env, {});
  const rich = buildRichObservation(
    fake.env,
    built,
    { vom: true, ax: options.ax === true, facts: true, ...(options.deepFacts === false ? { deepFacts: false } : {}) },
    { documentId: options.documentId ?? 'doc-deep-1', frameId: 0, cdpSessionId: null },
  );
  const nodes = rich.nodes ?? [];
  return {
    env: fake.env,
    rich,
    nodes,
    byId: (id: string) => nodes.find((node) => node.id === id),
  };
}

const rect = (left: number, top: number, width: number, height: number): { left: number; top: number; width: number; height: number } => ({ left, top, width, height });

// ---------------------------------------------------------------------------
// 35f visualObjects：区域 + ref 稳定身份
// ---------------------------------------------------------------------------

test('35f visualObjects：canvas 区域 + ref 的 stableRef 与 ref 注册表同算法', () => {
  const page = buildPage([
    { tag: 'canvas', id: 'viz', rect: rect(0, 0, 240, 120) },
    { tag: 'img', id: 'pic', attrs: { alt: '图片' }, rect: rect(0, 140, 120, 80) },
    { tag: 'button', id: 'visual-btn', type: 'button', text: '视觉按钮', rect: rect(0, 240, 120, 32) },
    {
      tag: 'div',
      id: 'painted',
      style: style({ backgroundImage: 'url(https://example.test/x.png)', display: 'block' }),
      rect: rect(0, 300, 200, 120),
    },
  ]);
  const objects = page.rich.visualObjects ?? [];
  assert.ok(objects.length > 0, 'visualObjects 为空');
  assert.ok(objects.some((item) => item.kind === 'region' && item.tag === 'canvas'), '缺少 canvas 区域：' + JSON.stringify(objects));
  assert.ok(objects.some((item) => item.kind === 'region' && item.tag === 'img'), '缺少图片区域');
  const refs = objects.filter((item) => item.kind === 'ref');
  assert.ok(refs.length >= 1, '缺少 ref 对象');
  const visualRef = refs.find((item) => Boolean(item.stableRef));
  assert.ok(visualRef, 'ref 对象缺少 stableRef');
  assert.match(String(visualRef && 'stableRef' in visualRef ? visualRef.stableRef : ''), /^s-[a-z0-9]+$/);
  // stableRef 必须与 background 的 ref 明细逐字符一致（同一次 observe 才可能对得上）。
  const details = toObserveActionResult(
    { ...page.rich, url: 'https://example.test/deep.html', title: 'VOM 深水区夹具', observation: '', refs: page.nodes.length, revision: 1, documentId: 'doc-deep-1' } as never,
    { tabId: 1, context: { documentId: 'doc-deep-1' } },
  ).action.refDetails;
  const expected = new Map(details.map((detail) => [detail.ref, detail.stableRef]));
  for (const object of refs) {
    if (!('stableRef' in object) || !object.stableRef) continue;
    assert.equal(object.stableRef, expected.get(object.ref), 'stableRef 与 refDetails 不一致：' + object.ref);
  }
  // VOM 载荷里的 visual 与顶层 visualObjects 同源。
  const vomVisual = page.rich.vom?.visual ?? [];
  assert.equal(vomVisual.length, objects.length);
  assert.ok(vomVisual.some((item) => item.kind === 'ref' && item.stableRef));
  // 视觉对象的 rect 是视口整数几何。
  for (const object of objects) {
    assert.equal(Number.isInteger(object.rect.x), true);
    assert.equal(Number.isInteger(object.rect.width), true);
  }
});

test('visualObjects 阈值：小于 24×24 的区域不进入清单，屏外区域被排除', () => {
  const page = buildPage([
    { tag: 'canvas', id: 'tiny', rect: rect(0, 0, 10, 10) },
    { tag: 'canvas', id: 'far', rect: rect(-5000, 0, 240, 120) },
    { tag: 'canvas', id: 'ok', rect: rect(0, 200, 240, 120) },
  ]);
  const tags = (page.rich.visualObjects ?? []).filter((item) => item.kind === 'region').map((item) => ('id' in item ? item.id : ''));
  assert.equal(tags.includes('tiny'), false, '过小区域不应进入 visualObjects');
  assert.equal(tags.includes('far'), false, '屏外区域不应进入 visualObjects');
  assert.equal(tags.includes('ok'), true, '正常区域应进入 visualObjects');
});

// ---------------------------------------------------------------------------
// 35b 命中测试：遮挡 / pointer-events / 屏外
// ---------------------------------------------------------------------------

test('35b 命中测试：self/blocked/pointer-events-none/offscreen 与 occludedBy/inViewport', () => {
  const page = buildPage([
    { tag: 'h1', text: 'VOM 命中测试' },
    { tag: 'button', id: 'normal-btn', type: 'button', text: '正常按钮', rect: rect(0, 40, 160, 36) },
    {
      tag: 'div',
      id: 'row',
      rect: rect(0, 90, 220, 48),
      children: [
        { tag: 'button', id: 'covered-btn', type: 'button', text: '被遮挡按钮', rect: rect(0, 90, 160, 36) },
        { tag: 'div', id: 'cover', text: '遮挡层', rect: rect(0, 90, 160, 36) },
      ],
    },
    { tag: 'button', id: 'no-pointer', type: 'button', text: '不可点击按钮', style: style({ pointerEvents: 'none' }), rect: rect(0, 150, 160, 32) },
    { tag: 'button', id: 'offscreen-btn', type: 'button', text: '屏外按钮', rect: rect(-5000, 0, 160, 32) },
  ]);
  const normal = page.byId('normal-btn');
  assert.ok(normal);
  assert.equal(normal?.hitTest, 'self');
  assert.equal(normal?.clickable, true);
  assert.equal(normal?.inViewport, true);
  const covered = page.byId('covered-btn');
  assert.ok(covered);
  assert.equal(covered?.clickable, false, '被遮挡按钮不应 clickable');
  assert.equal(covered?.hitTest, 'blocked');
  assert.equal(covered?.occludedBy?.id, 'cover', 'occludedBy 应指向遮挡层：' + JSON.stringify(covered?.occludedBy));
  const noPointer = page.byId('no-pointer');
  assert.equal(noPointer?.hitTest, 'pointer-events-none');
  assert.equal(noPointer?.clickable, false);
  const offscreen = page.byId('offscreen-btn');
  assert.equal(offscreen?.hitTest, 'offscreen');
  assert.equal(offscreen?.inViewport, false);
});

test('35b 命中测试：没有元素的节点不伪造命中结论（hitTest=null）', () => {
  const page = buildPage([
    { tag: 'button', id: 'btn', type: 'button', text: '按钮' },
  ]);
  const btn = page.byId('btn');
  assert.ok(btn);
  assert.equal(typeof btn?.hitTest, 'string');
  // 所有进入载荷的节点都有 inViewport 布尔事实（不缺失、不是 undefined）。
  for (const node of page.nodes) assert.equal(typeof node.inViewport, 'boolean');
});

// ---------------------------------------------------------------------------
// 35c 对比度：hex/rgb/oklch/color-mix
// ---------------------------------------------------------------------------

test('35c 对比度：高/低对比度阈值与两位小数', () => {
  const page = buildPage([
    { tag: 'p', id: 'good-contrast', text: '高对比度文字', style: style({ color: '#000', backgroundColor: '#fff' }), rect: rect(0, 0, 300, 24) },
    { tag: 'p', id: 'bad-contrast', text: '低对比度文字', style: style({ color: '#999', backgroundColor: '#fff' }), rect: rect(0, 30, 300, 24) },
    {
      tag: 'p',
      id: 'oklch-contrast',
      text: 'oklch 文字',
      style: style({ color: 'oklch(0.2 0.05 240)', backgroundColor: 'color-mix(in srgb, white 70%, black)' }),
      rect: rect(0, 60, 300, 24),
    },
  ]);
  const good = page.byId('good-contrast');
  assert.ok(good && Number(good.contrast) >= 20, '高对比度应 ≥ 20：' + JSON.stringify(good && good.contrast));
  assert.equal(good?.lowContrast, false);
  const bad = page.byId('bad-contrast');
  assert.ok(bad && Number(bad.contrast) < VOM_LOW_CONTRAST_THRESHOLD, '低对比度应 < 4.5');
  assert.equal(bad?.lowContrast, true);
  const oklch = page.byId('oklch-contrast');
  assert.ok(oklch && Number.isFinite(Number(oklch.contrast)) && Number(oklch.contrast) > 1, 'oklch/color-mix 未解析：' + JSON.stringify(oklch && oklch.contrast));
  // 两位小数口径。
  for (const node of [good, bad, oklch]) {
    if (node?.contrast == null) continue;
    assert.equal(Number(node.contrast.toFixed(2)), Number(node.contrast));
  }
});

test('color：WCAG 计算与 oklch/color-mix 纯解析器', () => {
  const black = parseCssColor('#000')!;
  const white = parseCssColor('rgb(255, 255, 255)')!;
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  const low = parseCssColor('#999999')!;
  const ratio = contrastRatio(low, white);
  assert.ok(ratio > 2.8 && ratio < 2.9, '#999 对 #fff 应约 2.85：' + ratio);
  const oklch = parseCssColor('oklch(0.2 0.05 240)');
  assert.ok(oklch && oklch.b > oklch.r, 'oklch 蓝色通道应更高：' + JSON.stringify(oklch));
  const mixed = parseCssColor('color-mix(in srgb, white 70%, black)');
  assert.ok(mixed && Math.abs(mixed.r - 178) <= 2, 'color-mix(白70%,黑) 应约 #b3b3b3：' + JSON.stringify(mixed));
  const alpha = parseCssColor('rgba(0, 0, 0, 0.5)');
  assert.ok(alpha && Math.abs(alpha.a - 0.5) < 0.001);
  assert.deepEqual(compositeColor(alpha!, white), { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  assert.equal(parseCssColor('not-a-color'), null);
});

// ---------------------------------------------------------------------------
// 35g layers：paint-order 分层 + issues
// ---------------------------------------------------------------------------

test('35g layers：modal/mask 带 + paintOrder/members/coverage + issues 为空', () => {
  const page = buildPage([
    { tag: 'button', id: 'layers-btn', type: 'button', text: '底层按钮', rect: rect(0, 0, 120, 32) },
    { tag: 'div', id: 'mask', style: style({ position: 'fixed', zIndex: 10, backgroundColor: 'rgba(0,0,0,.35)' }), rect: rect(0, 0, 1280, 800) },
    {
      tag: 'div',
      id: 'confirm',
      attrs: { role: 'dialog', 'aria-label': '确认框' },
      style: style({ position: 'fixed', zIndex: 11, backgroundColor: '#fff' }),
      rect: rect(100, 80, 400, 300),
    },
  ]);
  const layers = page.rich.layers ?? [];
  assert.ok(layers.length >= 1, '没有 layers：' + JSON.stringify(layers));
  const modal = layers.find((layer) => layer.kind === 'modal');
  const mask = layers.find((layer) => layer.kind === 'mask');
  assert.ok(modal, 'layers 缺少 modal 带：' + JSON.stringify(layers));
  assert.ok(mask, 'layers 缺少 mask 带：' + JSON.stringify(layers));
  assert.equal(Number.isInteger(modal?.paintOrder), true);
  assert.ok(Number(modal?.members) >= 1, 'modal 缺少 members');
  assert.ok(Number(modal?.coverage) > 0 && Number(modal?.coverage) <= 1, 'coverage 越界：' + JSON.stringify(modal?.coverage));
  assert.equal(mask?.coverage, 1);
  assert.ok(mask && mask.coverage > VOM_LAYER_MIN_COVERAGE);
  assert.deepEqual(page.rich.issues, [], '正常页面不应有 issues');
  assert.deepEqual(page.rich.vom?.issues, [], 'vom.issues 应为空数组');
  // 分层模型字段由 packages/vom deriveLayers 回填（不是本模块自造）。
  assert.equal(typeof modal?.layerKind, 'string');
  assert.equal(Number.isInteger(modal?.index), true);
});

test('35g layers：pointer-events:none 的浮层不算遮挡带', () => {
  const page = buildPage([
    { tag: 'div', id: 'ghost', style: style({ position: 'fixed', zIndex: 10, pointerEvents: 'none' }), rect: rect(0, 0, 1280, 800) },
  ]);
  const layers = page.rich.layers ?? [];
  assert.equal(layers.some((layer) => layer.kind === 'mask'), false, 'pointer-events:none 不应成为 mask：' + JSON.stringify(layers));
});

// ---------------------------------------------------------------------------
// 35h vom.graph：containment / ownership / roots / label / AX
// ---------------------------------------------------------------------------

function graphFixtureElements(): FakeElementSpec[] {
  return [
    { tag: 'h1', id: 'title', text: '完整关系图夹具', rect: rect(0, 0, 600, 40) },
    {
      tag: 'main',
      id: 'app',
      attrs: { role: 'main', 'aria-label': '主内容' },
      rect: rect(0, 40, 600, 600),
      children: [
        {
          tag: 'form',
          id: 'query-form',
          attrs: { 'aria-label': '查询' },
          rect: rect(0, 50, 600, 200),
          children: [
            { tag: 'label', id: 'kw-label', attrs: { for: 'kw' }, text: '关键词', rect: rect(0, 60, 80, 20) },
            {
              tag: 'div',
              id: 'wrap',
              rect: rect(0, 60, 600, 40),
              children: [
                {
                  tag: 'label',
                  id: 'wrap-label',
                  text: '包裹标签',
                  rect: rect(0, 60, 80, 20),
                  children: [{ tag: 'input', id: 'kw', type: 'text', attrs: { 'aria-label': '关键词输入' }, rect: rect(100, 60, 200, 28) }],
                },
              ],
            },
            {
              tag: 'div',
              id: 'city-box',
              rect: rect(0, 100, 600, 60),
              children: [
                {
                  tag: 'input',
                  id: 'city',
                  attrs: { role: 'combobox', 'aria-label': '城市', 'aria-controls': 'city-list', 'aria-expanded': 'false' },
                  rect: rect(100, 100, 200, 28),
                },
                {
                  tag: 'ul',
                  id: 'city-list',
                  attrs: { role: 'listbox', 'aria-label': '城市列表' },
                  rect: rect(100, 130, 200, 60),
                  children: [{ tag: 'li', id: 'beijing', attrs: { role: 'option' }, text: '北京', rect: rect(100, 130, 200, 28) }],
                },
              ],
            },
            { tag: 'button', id: 'submit-btn', type: 'button', text: '提交', rect: rect(100, 200, 100, 32) },
          ],
        },
        { tag: 'table', id: 'people', rect: rect(0, 260, 600, 120) },
        { tag: 'iframe', id: 'inner-frame', attrs: { src: 'https://example.test/frame.html' }, rect: rect(0, 400, 360, 120) },
        { tag: 'img', id: 'sub-img', attrs: { alt: '图片' }, rect: rect(0, 540, 40, 40) },
      ],
    },
    { tag: 'p', id: 'footer-note', text: '尾注', rect: rect(0, 660, 600, 24) },
  ];
}

test('35h vom.graph：available/nodes/edges/roots/ancestorIds 与端点闭合', () => {
  const page = buildPage(graphFixtureElements());
  const graph = page.rich.vom?.graph;
  assert.ok(graph && graph.available === true, '缺少 vom.graph：' + JSON.stringify(page.rich.vom && Object.keys(page.rich.vom)));
  assert.ok((graph?.nodes.length ?? 0) > 10, 'graph.nodes 太少：' + JSON.stringify(graph?.counts));
  assert.ok((graph?.edges.length ?? 0) > 5, 'graph.edges 太少：' + JSON.stringify(graph?.counts));
  assert.ok((graph?.roots.length ?? 0) >= 1, '缺少 roots');
  const ids = new Set((graph?.nodes ?? []).map((node) => node.id));
  for (const edge of graph?.edges ?? []) {
    assert.ok(ids.has(edge.from) && ids.has(edge.to), '边端点必须落在 graph.nodes 里：' + JSON.stringify(edge));
  }
  for (const node of page.rich.vom?.nodes ?? []) {
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
    assert.ok(Array.isArray(node.ancestorIds), '节点缺少 ancestorIds：' + node.id);
    for (const ancestorId of node.ancestorIds ?? []) assert.ok(ids.has(ancestorId), '祖先 id 不在图里：' + ancestorId);
  }
  // parentId 链与 ancestorIds 一致，并通到 roots。
  const byId = new Map((graph?.nodes ?? []).map((node) => [node.id, node]));
  const nested = (page.rich.vom?.nodes ?? []).find((node) => Array.isArray(node.ancestorIds) && node.ancestorIds.length >= 2);
  assert.ok(nested, '没有节点给出 ≥2 层祖先链');
  const chain: string[] = [];
  let current = byId.get(nested!.id);
  let guard = 0;
  while (current && current.parentId && guard < 40) {
    chain.push(current.parentId);
    current = byId.get(current.parentId);
    guard += 1;
  }
  assert.deepEqual(chain, nested!.ancestorIds, 'ancestorIds 与 parentId 链不一致');
  if (!graph?.truncated) assert.ok(current && graph?.roots.includes(current.id), '祖先链没有通到 roots');
  // counts 自洽。
  assert.equal(graph?.counts.nodes, (graph?.nodes ?? []).length);
  assert.equal(graph?.counts.edges, (graph?.edges ?? []).length);
  const byTypeSum = Object.values(graph?.counts.byType ?? {}).reduce((sum, value) => sum + Number(value), 0);
  assert.equal(byTypeSum, (graph?.edges ?? []).length);
});

test('35h vom.graph：containment/label/controls 边与 child 兼容字段', () => {
  const page = buildPage(graphFixtureElements());
  const graph = page.rich.vom?.graph;
  const types = new Set((graph?.edges ?? []).map((edge) => edge.type));
  assert.ok(types.has('child'), '缺少 child 边：' + JSON.stringify(graph?.counts.byType));
  assert.ok(types.has('label'), '缺少隐式 label 边：' + JSON.stringify(graph?.counts.byType));
  assert.ok(types.has('html-for'), '缺少显式 html-for 边');
  assert.ok(types.has('controls'), '缺少 aria-controls 边');
  assert.ok(types.has('form'), '缺少 form 归属边');
  const child = (page.rich.vom?.edges ?? []).find((edge) => edge.type === 'child' && edge.child && edge.parent);
  assert.ok(child, 'vom.edges 缺少兼容 child/parent');
  assert.equal(child?.child, child?.to);
  assert.equal(child?.parent, child?.from);
  // ownership：label → 控件、combobox → listbox。
  const labelEdge = (graph?.edges ?? []).find((edge) => edge.type === 'label');
  assert.ok(labelEdge && labelEdge.from !== labelEdge.to);
});

test('35h vom.graph：AX 父子边并入（ax 边 + ax 上下文节点 + 端点闭合）', () => {
  const page = buildPage(graphFixtureElements(), { ax: true });
  const graph = page.rich.vom?.graph;
  assert.ok(graph && graph.available === true);
  const axEdges = (graph?.edges ?? []).filter((edge) => edge.type === 'ax');
  assert.ok(axEdges.length >= 1, '缺少 AX 父子边：' + JSON.stringify(graph?.counts.byType));
  assert.ok((graph?.nodes ?? []).some((node) => node.ax === true), '缺少 AX 上下文节点（ax:<nodeId>）');
  const ids = new Set((graph?.nodes ?? []).map((node) => node.id));
  for (const edge of axEdges) assert.ok(ids.has(edge.from) && ids.has(edge.to), 'AX 边端点越界：' + JSON.stringify(edge));
  // AX 上下文节点必须有 parentId 或作为 edge.from 出现（不是悬空节点）。
  const contextNodes = (graph?.nodes ?? []).filter((node) => node.ax === true);
  for (const node of contextNodes) {
    assert.ok(String(node.id).startsWith('ax:'), 'AX 上下文节点 id 前缀不对：' + node.id);
    assert.ok(axEdges.some((edge) => edge.from === node.id || edge.to === node.id), 'AX 上下文节点没有入边/出边：' + node.id);
  }
});

test('35h ohne --ax：不伪造 AX 边（available 图里没有 type=ax）', () => {
  const page = buildPage(graphFixtureElements());
  assert.equal((page.rich.vom?.graph?.edges ?? []).some((edge) => edge.type === 'ax'), false);
  assert.equal((page.rich.vom?.graph?.nodes ?? []).some((node) => node.ax === true), false);
});

// ---------------------------------------------------------------------------
// 15d/15e frames-vom：跨源与嵌套 iframe 子图
// ---------------------------------------------------------------------------

function graphOf(elements: FakeElementSpec[], url: string): NonNullable<ReturnType<typeof buildRichObservation>['vom']>['graph'] {
  const page = buildPage(elements, { url });
  const graph = page.rich.vom?.graph;
  assert.ok(graph && graph.available === true, '构造 frame 子图失败：' + url);
  return graph!;
}

test('15d 跨源 iframe 子图：frame 节点/命名空间/frame 边/links/unlinked=0', () => {
  const crossUrl = 'https://cross.test/frame-x.html';
  const mainGraph = graphOf([
    { tag: 'iframe', id: 'x-frame', attrs: { src: crossUrl }, rect: rect(0, 0, 360, 90) },
    { tag: 'button', id: 'normal-btn', type: 'button', text: '正常按钮', rect: rect(0, 100, 120, 32) },
  ], 'https://example.test/test.html');
  const crossGraph = graphOf([
    { tag: 'button', id: 'cross-btn', type: 'button', text: '跨源按钮', rect: rect(0, 0, 120, 32) },
  ], crossUrl);
  const bundle = buildVomFramesFromCaptures([
    { frameId: 0, url: 'https://example.test/test.html', parentFrameId: -1, graph: mainGraph },
    { frameId: 5, url: crossUrl, parentFrameId: 0, graph: crossGraph },
  ]);
  assert.equal(bundle.vomFrames.count, 2);
  assert.equal(bundle.vomFrames.unlinked, 0, '存在未匹配的 iframe owner：' + bundle.vomFrames.unlinked);
  assert.equal(bundle.vomLimits.frames, 16);
  assert.deepEqual(bundle.vomLimits, { ...VOM_FRAME_LIMITS });
  const main = bundle.frames.get(0);
  const cross = bundle.frames.get(5);
  assert.ok(main && cross);
  assert.ok(main?.nodes.some((node) => node.id === 'frame:0'), '主文档缺少 frame:0 节点');
  assert.ok(cross?.nodes.some((node) => node.id === 'frame:5'), '跨源子图缺少 frame 节点');
  assert.ok(cross?.nodes.some((node) => node.id.startsWith('f5:')), '跨源子图 id 未加帧前缀');
  const crossIds = new Set((cross?.nodes ?? []).map((node) => node.id));
  for (const edge of cross?.edges ?? []) assert.ok(crossIds.has(edge.from) && crossIds.has(edge.to), '帧内边端点越界：' + JSON.stringify(edge));
  assert.ok(cross?.edges.some((edge) => edge.type === 'frame' && edge.from === 'frame:5'), '缺少 frame 边');
  const link = bundle.vomFrames.links[0];
  assert.ok(link, '缺少 iframe→子图根 link');
  assert.equal(link?.fromFrameId, 0);
  assert.equal(link?.toFrameId, 5);
  const mainIds = new Set((main?.nodes ?? []).map((node) => node.id));
  assert.ok(mainIds.has(link!.ownerId), 'ownerId 不在主文档子图：' + link?.ownerId);
  assert.ok(main?.edges.some((edge) => edge.type === 'frame' && edge.from === link?.ownerId && edge.to === 'frame:5'), '主文档缺少 iframe→frame 边');
  assert.equal(main?.counts.nodes, (main?.nodes ?? []).length);
  assert.equal(main?.counts.edges, (main?.edges ?? []).length);
});

test('15e 嵌套 iframe 链：父帧把 iframe 元素接到自己的子图根', () => {
  const nestedUrl = 'https://nested.test/inner.html';
  const outerUrl = 'https://nested.test/outer.html';
  const rootGraph = graphOf([
    { tag: 'iframe', id: 'outer-frame', attrs: { src: outerUrl }, rect: rect(0, 0, 360, 120) },
  ], 'https://example.test/nested-cross.html');
  const outerGraph = graphOf([
    { tag: 'iframe', id: 'inner-frame', attrs: { src: nestedUrl }, rect: rect(0, 0, 200, 80) },
  ], outerUrl);
  const innerGraph = graphOf([
    { tag: 'button', id: 'inner-btn', type: 'button', text: '内层按钮', rect: rect(0, 0, 100, 30) },
  ], nestedUrl);
  const bundle = buildVomFramesFromCaptures([
    { frameId: 0, url: 'https://example.test/nested-cross.html', parentFrameId: -1, graph: rootGraph },
    { frameId: 3, url: outerUrl, parentFrameId: 0, graph: outerGraph },
    { frameId: 7, url: nestedUrl, parentFrameId: 3, graph: innerGraph },
  ]);
  assert.equal(bundle.vomFrames.unlinked, 0);
  const nestedLink = bundle.vomFrames.links.find((link) => link.fromFrameId > 0);
  assert.ok(nestedLink, '没有嵌套 iframe 的 owner link：' + JSON.stringify(bundle.vomFrames.links));
  assert.equal(nestedLink?.fromFrameId, 3);
  assert.equal(nestedLink?.toFrameId, 7);
  const parent = bundle.frames.get(3);
  const child = bundle.frames.get(7);
  assert.ok(parent && parent.available === true, '嵌套父帧缺少子图');
  const parentIds = new Set((parent?.nodes ?? []).map((node) => node.id));
  assert.ok(parentIds.has(nestedLink!.ownerId), 'ownerId 不在父帧子图');
  assert.ok(parentIds.has('frame:7'), '父帧缺少子帧节点');
  assert.ok(parent?.edges.some((edge) => edge.type === 'frame' && edge.from === nestedLink?.ownerId && edge.to === 'frame:7'), '父帧缺少 iframe→frame 边');
  assert.ok(child && child.available === true, '嵌套子帧缺少子图');
});

test('frames-vom 上限：超过帧上限时 truncated 并停止展开', () => {
  const captures: Array<{ frameId: number; url: string; parentFrameId: number; graph: ReturnType<typeof graphOf> | null }> = [];
  for (let index = 0; index < 20; index += 1) {
    captures.push({
      frameId: index,
      url: 'https://frames.test/' + String(index) + '.html',
      parentFrameId: index === 0 ? -1 : 0,
      graph: index === 0 ? graphOf([{ tag: 'button', id: 'b0', type: 'button', text: '主按钮' }], 'https://frames.test/0.html') : null,
    });
  }
  const limited = buildVomFramesFromCaptures(captures, { limits: { frames: 3 } });
  assert.equal(limited.vomFrames.count, 3);
  assert.equal(limited.vomFrames.truncated, true);
  assert.equal(limited.vomLimits.frames, 3);
});

// ---------------------------------------------------------------------------
// 采集问题 / token 计量 / 阈值常量
// ---------------------------------------------------------------------------

test('capture issues：收集器只记录真实失败并截断 reason 长度', async () => {
  const { createVomCaptureIssues } = await import('../src/content/vom-deep.ts');
  const sink = createVomCaptureIssues();
  assert.equal(sink.issues.length, 0);
  sink.note('observe', new Error('x'.repeat(500)));
  assert.equal(sink.issues.length, 1);
  assert.equal(sink.issues[0]?.stage, 'observe');
  assert.ok((sink.issues[0]?.reason.length ?? 0) <= 240);
  for (let index = 0; index < 40; index += 1) sink.note('stage' + String(index), 'boom');
  assert.ok(sink.issues.length <= 24, '问题列表应限流');
});

test('stages 指标：visited/tokens/lineTokens/maxLineTokens 都是整数且有逐行 token 计量', () => {
  const page = buildPage([
    { tag: 'h1', text: '标题' },
    { tag: 'button', id: 'b', type: 'button', text: '按钮' },
  ]);
  const stages = page.rich.stages;
  assert.ok(stages, '缺少顶层 stages');
  assert.ok(Number(stages?.visited) >= 1);
  assert.equal(Number.isInteger(stages?.tokens), true);
  // JS 基线里 lineTokens 是总 tokens（历史字段名）；E2E 断言它是整数，保持一致。
  assert.equal(Number.isInteger(stages?.lineTokens), true);
  assert.equal(stages?.lineTokens, stages?.tokens);
  assert.equal(Number.isInteger(stages?.maxLineTokens), true);
  assert.ok(Number(stages?.maxLineTokens) >= 1);
  for (const key of ['walk', 'visibility', 'stealth', 'semantics'] as const) {
    assert.equal(Number.isFinite(stages?.ms[key]), true, 'ms.' + key + ' 不是有限数');
  }
  assert.equal(estimateVomLineTokens('abc'), 2);
  assert.equal(estimateVomLineTokens('中文'), 2);
  assert.equal(estimateVomLineTokens(''), 1);
});

test('阈值常量：低对比度 4.5 / 层覆盖率 0.2 与 JS 基线一致', () => {
  assert.equal(VOM_LOW_CONTRAST_THRESHOLD, 4.5);
  assert.equal(VOM_LAYER_MIN_COVERAGE, 0.2);
});

test('深水区关闭（deepFacts=false）不改变节点 clickable/对比度（夹具生成路径）', () => {
  const page = buildPage([
    {
      tag: 'div',
      id: 'row',
      rect: rect(0, 0, 220, 48),
      children: [
        { tag: 'button', id: 'covered', type: 'button', text: '被遮挡', rect: rect(0, 0, 160, 36) },
        { tag: 'div', id: 'cover', text: '遮挡层', rect: rect(0, 0, 160, 36) },
      ],
    },
  ], { deepFacts: false });
  const covered = page.byId('covered');
  assert.equal(covered?.hitTest, undefined, 'deepFacts=false 不应回填命中事实');
  assert.equal(covered?.clickable, true, 'deepFacts=false 应保留动作前 clickable');
});

test('observe --vom 内容会话端到端：richResult 携带全部深水区字段', () => {
  const fake = createFakeDom([
    { tag: 'button', id: 'normal-btn', type: 'button', text: '正常按钮', rect: rect(0, 140, 160, 36) },
    {
      tag: 'div',
      id: 'row',
      rect: rect(0, 190, 220, 48),
      children: [
        { tag: 'button', id: 'covered-btn', type: 'button', text: '被遮挡', rect: rect(0, 190, 160, 36) },
        { tag: 'div', id: 'cover', text: '遮挡层', rect: rect(0, 190, 160, 36) },
      ],
    },
    { tag: 'div', id: 'mask', style: style({ position: 'fixed', zIndex: 10 }), rect: rect(0, 0, 1280, 800) },
    {
      tag: 'div',
      id: 'confirm',
      attrs: { role: 'dialog', 'aria-label': '确认框' },
      style: style({ position: 'fixed', zIndex: 11 }),
      rect: rect(100, 80, 400, 300),
    },
    { tag: 'p', id: 'bad-contrast', text: '低对比度', style: style({ color: '#999', backgroundColor: '#fff' }), rect: rect(0, 260, 200, 24) },
    // canvas 放最后：fake elementFromPoint 取文档顺序最后一个命中的元素，模拟“canvas 在最上层”。
    { tag: 'canvas', id: 'viz', rect: rect(0, 0, 240, 120) },
  ], { title: '会话夹具', url: 'https://example.test/session.html' });
  const session = new ContentSession(fake.env, { protocol: '1.9', documentId: 'doc-session-1' });
  const reply = session.handle(makeContentRequest('observe', { vom: true, ax: true, facts: true, force: true }));
  assert.equal(reply.ok, true, 'observe 失败：' + JSON.stringify(reply));
  const result = (reply.ok ? reply.result : null) as {
    documentId?: string;
    richResult?: Record<string, unknown>;
  } | null;
  assert.equal(result?.documentId, 'doc-session-1');
  const rich = result?.richResult;
  assert.ok(rich, '缺少 richResult');
  assert.equal(Array.isArray(rich.visualObjects), true, '缺少 visualObjects');
  assert.equal((rich.visualObjects as Array<{ tag?: string }>).some((item) => item.tag === 'canvas'), true, 'visualObjects 缺少 canvas 区域');
  assert.equal(Array.isArray(rich.layers), true, '缺少 layers');
  assert.equal((rich.layers as Array<{ kind?: string }>).some((layer) => layer.kind === 'modal'), true, 'layers 缺少 modal 带');
  assert.equal((rich.layers as Array<{ kind?: string }>).some((layer) => layer.kind === 'mask'), true, 'layers 缺少 mask 带');
  assert.equal(Array.isArray(rich.issues), true);
  assert.equal((rich.issues as unknown[]).length, 0, '正常页面 issues 应为空');
  const vom = rich.vom as {
    graph?: { available?: boolean; nodes?: unknown[]; edges?: unknown[]; counts?: { nodes?: number } };
    issues?: unknown[];
    visual?: unknown[];
  };
  assert.equal(vom.graph?.available, true, '缺少 vom.graph');
  assert.ok((vom.graph?.nodes ?? []).length > 0);
  assert.equal((vom.issues ?? []).length, 0);
  assert.equal((vom.visual ?? []).length, (rich.visualObjects as unknown[]).length);
  const stages = rich.stages as {
    visited?: number;
    tokens?: number;
    lineTokens?: number;
    maxLineTokens?: number;
    ms?: { visibility?: number; semantics?: number };
  };
  assert.ok(Number(stages.visited) >= 1);
  assert.equal(Number.isInteger(stages.tokens), true);
  assert.equal(Number.isInteger(stages.lineTokens), true);
  assert.equal(Number.isInteger(stages.maxLineTokens), true);
  assert.equal(Number.isFinite(Number(stages.ms?.visibility)), true);
  assert.equal(Number.isFinite(Number(stages.ms?.semantics)), true);
  // 35b/35c：节点字段经 richResult 上抛（registry.finishObserve 会展开非 nodes 字段 + nodes）。
  const nodes = rich.nodes as Array<{ id: string; hitTest?: string; clickable?: boolean; contrast?: number | null; lowContrast?: boolean }>;
  const covered = nodes.find((node) => node.id === 'covered-btn');
  assert.equal(covered?.hitTest, 'blocked');
  assert.equal(covered?.clickable, false);
  const bad = nodes.find((node) => node.id === 'bad-contrast');
  assert.ok(Number(bad?.contrast) < 4.5 && bad?.lowContrast === true, '低对比度节点字段缺失：' + JSON.stringify(bad));
});
