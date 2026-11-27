// tests/vom-diff.test.ts —— TS（packages/vom）↔ JS（extension/src/lib/vom-*.js）语义差分。
//
// 差分口径（不做“差不多”）：
// 1) 输入：tests/fixtures/vom-facts/*.json（从真实 DOM 流程抽取的页面事实，冻结后逐字段 review）；
// 2) TS 侧：vom-facts.projectVomFacts → packages/vom（affordance/relations/context）；
// 3) JS 侧：tests/support/vom-js-reference.mjs 的独立投影 → extension/src/lib/vom-*.js；
// 4) 断言：entries/graph/frames 投影逐字段相等；每节点 affordance 逐字段相等；
//    relations 图、context 模型逐字段相等；groups 摘要与 JS context.stats/组列表一致。
//
// 已知差异（不是“差不多”，而是明确的边界）写在 KNOWN_DIFFERENCES 里，每项都有可执行断言
// 证明它真实存在；除这些项之外不允许有差异。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildVomSummary, type VomUnifiedSummary } from '../src/content/vom-summary.ts';
import { projectVomFacts, type VomPageFacts } from '../src/content/vom-facts.ts';
import { VOM_GROUP_DIGEST_LIMIT } from '../src/content/vom-summary.ts';
import { VOM_FIXTURE_DIR } from './support/write-vom-fixtures.ts';
import { buildVomGraph, mergeAxIntoGraph, buildFrameVomGraphs, deriveLayers } from '../../../packages/vom/src/index.ts';
import type { VomGraphObservedNode, VomGraphRawFacts } from '../../../packages/vom/src/index.ts';
import { buildVisualObjects } from '../src/content/vom-visual.ts';
import { buildAxProjection, buildPageGraph } from '../src/content/vom-page-graph.ts';
import { buildLayerFacts } from '../src/content/vom-layers.ts';
import { createCanvasColorParser } from '../src/content/vom-deep.ts';
import { createFakeDom } from './support/fake-dom.ts';
import { assignRichElementIds, collectElements } from '../src/content/rich.ts';
import { parseCssColor } from '../../../packages/vom/src/color.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

/**
 * JS 兼容目标（产品代码只读引用；动态 import 避免 tsc 需要 allowJs）。
 * 辅助投影文件同样是 JS（.mjs），保证差分对照不走 TS 编译产物。
 */
const jsRefPromise = import(pathToFileURL(path.join(HERE, 'support', 'vom-js-reference.mjs')).href) as Promise<{
  limitSetOfJs: (input: unknown) => Record<string, number>;
  projectVomFactsJs: (facts: unknown) => JsProjection;
}>;

const jsLibsPromise = Promise.all([
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-affordance.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-relations.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-context.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-groups.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-graph.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'ax-graph.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'vom-layers.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'frame-vom.js')).href),
  import(pathToFileURL(path.join(REPO, 'extension', 'src', 'lib', 'visual-objects.js')).href),
]) as Promise<[
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
]>;

interface JsProjection {
  entries: Array<Record<string, unknown>>;
  graph: Record<string, unknown>;
  frames: Array<Record<string, unknown>> | null;
  limits: { relations: number; groups: number; contexts: number; chainDepth: number };
}

interface JsReference {
  limitSetOfJs: (input: unknown) => Record<string, number>;
  projectVomFactsJs: (facts: unknown) => JsProjection;
}

interface JsLibs {
  jsAffordance: Record<string, unknown>;
  jsRelations: Record<string, unknown>;
  jsContext: Record<string, unknown>;
  jsGroups: Record<string, unknown>;
  jsGraph: Record<string, unknown>;
  jsAxGraph: Record<string, unknown>;
  jsLayers: Record<string, unknown>;
  jsFrameVom: Record<string, unknown>;
  jsVisual: Record<string, unknown>;
}

async function loadJs(): Promise<{ reference: JsReference; libs: JsLibs }> {
  const [reference, [jsAffordance, jsRelations, jsContext, jsGroups, jsGraph, jsAxGraph, jsLayers, jsFrameVom, jsVisual]] = await Promise.all([jsRefPromise, jsLibsPromise]);
  return { reference, libs: { jsAffordance, jsRelations, jsContext, jsGroups, jsGraph, jsAxGraph, jsLayers, jsFrameVom, jsVisual } };
}

type JsFn = (...args: unknown[]) => unknown;

function fnOf(lib: Record<string, unknown>, name: string): JsFn {
  const fn = lib[name];
  assert.equal(typeof fn, 'function', 'JS 参考库缺少函数：' + name);
  return fn as JsFn;
}

const FIXTURES = fs.readdirSync(VOM_FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

function readFixture(name: string): VomPageFacts {
  return JSON.parse(fs.readFileSync(path.join(VOM_FIXTURE_DIR, name + '.json'), 'utf8')) as VomPageFacts;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 找到前 N 个差异路径（失败信息里直接给出字段，不让人猜）。 */
function diffPaths(expected: unknown, actual: unknown, limit = 8): string[] {
  const diffs: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (diffs.length >= limit) return;
    if (left === right) return;
    if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') {
      diffs.push(path + ': ' + JSON.stringify(left) + ' ≠ ' + JSON.stringify(right));
      return;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) {
        diffs.push(path + ': 数组/非数组不一致');
        return;
      }
      if (left.length !== right.length) diffs.push(path + '.length: ' + left.length + ' ≠ ' + right.length);
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        walk(left[index], right[index], path + '[' + String(index) + ']');
      }
      return;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    for (const key of keys) walk(leftRecord[key], rightRecord[key], path + '.' + key);
  };
  walk(expected, actual, '$');
  return diffs;
}

function assertSameJson(expected: unknown, actual: unknown, label: string): void {
  const left = clone(expected);
  const right = clone(actual);
  const diffs = diffPaths(left, right);
  assert.equal(diffs.length, 0, label + '\n' + diffs.join('\n'));
  assert.deepEqual(right, left);
}

interface DiffBundle {
  facts: VomPageFacts;
  tsSummary: VomUnifiedSummary;
  tsProjection: ReturnType<typeof projectVomFacts>;
  jsProjection: JsProjection;
  jsRelations: Record<string, unknown>;
  jsContext: Record<string, unknown>;
  jsAffordances: unknown[];
  jsAffordanceSummary: unknown;
}

async function diffBundle(name: string): Promise<DiffBundle> {
  const { reference, libs } = await loadJs();
  const jsAffordanceForNode = fnOf(libs.jsAffordance, 'affordanceForNode');
  const jsSummarizeAffordances = fnOf(libs.jsAffordance, 'summarizeAffordances');
  const jsBuildRelations = fnOf(libs.jsRelations, 'buildVomRelationGraph');
  const jsBuildContext = fnOf(libs.jsContext, 'buildVomContext');
  const facts = readFixture(name);
  const tsProjection = projectVomFacts(facts);
  const jsProjection = reference.projectVomFactsJs(facts);
  const relationInput = {
    entries: jsProjection.entries,
    graph: jsProjection.graph,
    ...(jsProjection.frames ? { frames: jsProjection.frames } : {}),
    limits: reference.limitSetOfJs(facts.limits),
  };
  const jsRelationGraph = jsBuildRelations(relationInput) as Record<string, unknown>;
  const jsFrameNodes = Array.isArray(jsRelationGraph.frames) ? jsRelationGraph.frames : [];
  const contextInput = {
    entries: jsProjection.entries,
    graph: jsProjection.graph,
    ...(jsFrameNodes.length ? { frames: jsFrameNodes } : {}),
    limits: {
      groups: jsProjection.limits.groups,
      contexts: jsProjection.limits.contexts,
      depth: jsProjection.limits.chainDepth,
    },
  };
  const jsContextModel = jsBuildContext(contextInput) as Record<string, unknown>;
  const affordanceInputs = facts.nodes.map((node) => affordanceInputOf(node));
  const jsAffordances = affordanceInputs.map((input) => jsAffordanceForNode(input));
  const jsAffordanceSummary = jsSummarizeAffordances(affordanceInputs);
  return {
    facts,
    tsSummary: buildVomSummary(facts),
    tsProjection,
    jsProjection,
    jsRelations: jsRelationGraph,
    jsContext: jsContextModel,
    jsAffordances,
    jsAffordanceSummary,
  };
}

/** JS 侧 affordance 的输入投影（与 tests/support/vom-js-reference.mjs 的 affordanceInputJs 等同）。 */
function affordanceInputOf(node: VomPageFacts['nodes'][number]): Record<string, unknown> {
  const ancestors = Array.isArray(node.ancestors) ? node.ancestors : [];
  return {
    role: node.role || undefined,
    tag: node.tag || undefined,
    name: node.name || undefined,
    inputType: node.inputType || undefined,
    contentEditable: node.contentEditable,
    draggable: node.draggable,
    dragHint: node.dragHint || undefined,
    overflowY: node.overflowY || undefined,
    scrollable: node.scrollable,
    ariaHasPopup: node.ariaHasPopup || undefined,
    hoverable: node.hoverable,
    href: node.href || undefined,
    clickable: node.clickable,
    cursor: node.cursor || undefined,
    tabIndex: node.tabIndex ?? undefined,
    ariaPressed: node.ariaPressed ?? undefined,
    expanded: node.expanded ?? undefined,
    ancestors: ancestors.map((ancestor) => ({ role: ancestor.role, tag: ancestor.tag })),
  };
}

// ---------------------------------------------------------------------------
// 逐页逐字段差分
// ---------------------------------------------------------------------------

for (const name of FIXTURES) {
  test('差分[' + name + ']：投影 + affordance + relations + context 与 JS 逐字段相等', async () => {
    const bundle = await diffBundle(name);
    // 1) 投影（facts → packages/vom / vom-*.js 输入）必须逐字段一致。
    assertSameJson(bundle.jsProjection.entries, bundle.tsProjection.entries, name + ' entries 投影不一致');
    assertSameJson(bundle.jsProjection.graph, bundle.tsProjection.graph, name + ' graph 投影不一致');
    assertSameJson(bundle.jsProjection.frames, bundle.tsProjection.frames, name + ' frames 投影不一致');
    assertSameJson(bundle.jsProjection.limits, bundle.tsProjection.limits, name + ' limits 投影不一致');
    // 2) 每节点 affordance。
    assert.equal(bundle.tsSummary.nodes.length, bundle.facts.nodes.length);
    for (let index = 0; index < bundle.facts.nodes.length; index += 1) {
      const node = bundle.facts.nodes[index];
      assert.ok(node);
      const view = bundle.tsSummary.nodes.find((item) => item.id === node.id);
      assert.ok(view, name + ' 摘要缺少节点：' + node.id);
      assertSameJson(bundle.jsAffordances[index], view.affordance, name + ' 节点 ' + node.id + ' affordance 不一致');
    }
    assertSameJson(bundle.jsAffordanceSummary, bundle.tsSummary.affordance, name + ' affordance 汇总不一致');
    // 3) relations 图整图逐字段（含 stats/groups/contexts/frames/frameStats）。
    assertSameJson(bundle.jsRelations, bundle.tsSummary.relations, name + ' relations 图不一致');
    // 4) context 模型整图逐字段（含 groups/contexts/frames/stats）。
    assertSameJson(bundle.jsContext, bundle.tsSummary.context, name + ' context 模型不一致');
    // 5) groups 摘要与 JS context 的统计/组列表一致（摘要只是压缩视图，不能改数）。
    const jsContextStats = (bundle.jsContext as { stats?: Record<string, number> }).stats ?? {};
    const groups = bundle.tsSummary.groups;
    assert.equal(groups.total, jsContextStats.groups);
    assert.equal(groups.byKind.landmark ?? 0, jsContextStats.landmarks ?? 0);
    assert.equal(groups.byKind.form ?? 0, jsContextStats.forms ?? 0);
    assert.equal(groups.byKind.table ?? 0, jsContextStats.tables ?? 0);
    assert.equal(groups.parented, jsContextStats.parented);
    assert.equal(groups.framed, jsContextStats.framed);
    assert.equal(groups.tableHeaders, jsContextStats.tableHeaders);
    const jsGroups = (bundle.jsContext as { groups?: Array<{ id?: unknown; members?: unknown }> }).groups ?? [];
    const expectedDigestIds = jsGroups
      .slice()
      .sort((left, right) => (Number(right.members) || 0) - (Number(left.members) || 0)
        || String(left.id).localeCompare(String(right.id)))
      .slice(0, VOM_GROUP_DIGEST_LIMIT)
      .map((group) => String(group.id));
    assert.deepEqual(groups.groups.map((group) => group.id), expectedDigestIds, name + ' groups 摘要顺序/成员不一致');
  });
}

// 每页差分至少要有实质内容（防止夹具退化成空页导致“差分全过”）。
/* 每页差分至少要有实质内容（防止夹具退化成空页导致“差分全过”）。 */
test('差分夹具覆盖度：每页都有 affordance/relations/context 实质输出', async () => {
  assert.ok(FIXTURES.length >= 3, '差分夹具不足：' + FIXTURES.join(','));
  for (const name of FIXTURES) {
    const bundle = await diffBundle(name);
    assert.ok(bundle.facts.nodes.length >= 4, name + ' 节点太少');
    assert.ok(bundle.tsSummary.affordance.total >= 1, name + ' 没有 affordance 判定');
    assert.ok(bundle.tsSummary.relations.relations.length >= 1, name + ' 没有关系');
    assert.ok(bundle.tsSummary.context.groups.length >= 1, name + ' 没有上下文组');
  }
});

// ---------------------------------------------------------------------------
// 关系/上下文语义硬断言（不依赖 JS，避免“两边一起错”）
// ---------------------------------------------------------------------------

test('关系语义硬断言：labels/controls/describes/owns/invalidates 的方向与证据', async () => {
  const bundle = await diffBundle('basic-form');
  const relations = bundle.tsSummary.relations.relations;
  const find = (type: string, from: string, to: string) => relations.find((relation) => relation.type === type && relation.from === from && relation.to === to);
  const label = find('labels', 'user-label', 'username');
  assert.ok(label, 'label[for] 应产生 labels 边');
  assert.equal(label?.source, 'html-for');
  assert.ok((label?.confidence ?? 0) >= 0.9);
  const described = find('describes', 'user-hint', 'username');
  assert.ok(described, 'aria-describedby 应产生 describes 边');
  assert.equal(described?.text, '至少 8 位');
  const invalidates = find('invalidates', 'user-error', 'username');
  assert.ok(invalidates, 'aria-errormessage 应产生 invalidates 边');
  assert.equal(invalidates?.sources.includes('aria-errormessage'), true);
  const controls = find('controls', 'city', 'city-list');
  assert.ok(controls);
  assert.equal(controls?.source, 'aria-controls');
});

test('上下文语义硬断言：table>form>landmark 链与表格结构来自页面事实', async () => {
  const bundle = await diffBundle('basic-form');
  const context = bundle.tsSummary.context;
  const formGroup = context.groups.find((group) => group.anchorId === 'login-form');
  assert.ok(formGroup);
  assert.ok(formGroup?.memberIds.includes('username'));
  const tableGroup = context.groups.find((group) => group.anchorId === 'people');
  assert.ok(tableGroup?.table);
  assert.equal(tableGroup?.table?.source, 'page-facts');
  assert.deepEqual(tableGroup?.table?.headers.map((header) => header.name), ['姓名', '城市']);
  assert.equal(tableGroup?.table?.rowCount, 1);
  const ctx = context.contexts.find((item) => item.node === 'people-name');
  assert.ok(ctx?.kinds.includes('table'));
});

test('跨 frame 差分：frame 关系/上下文与 JS 一致，且 frame 节点作为端点', async () => {
  const bundle = await diffBundle('frames');
  assert.ok(bundle.tsSummary.relations.stats.frameRelations >= 1);
  assert.equal(bundle.tsSummary.relations.frames.length, 3);
  assertSameJson(bundle.jsRelations, bundle.tsSummary.relations, 'frames relations 不一致');
  assertSameJson(bundle.jsContext, bundle.tsSummary.context, 'frames context 不一致');
  for (const relation of bundle.tsSummary.relations.relations) {
    if (relation.frame !== true) continue;
    assert.ok(String(relation.from).length > 0 && String(relation.to).length > 0);
  }
});

// ---------------------------------------------------------------------------
// VOM 深水区差分：图 / AX 并入 / layers / frame-vom / visualObjects
// ---------------------------------------------------------------------------

/** 页面侧原始图夹具（key/parentKey 形状与 JS page-lib snapshotGraph 一致）。 */
function rawGraphFixture(): VomGraphRawFacts {
  return {
    available: true,
    nodes: [
      { key: 'n1', ref: null, tag: 'html', domId: null, role: null, parentKey: null, frameIndex: null, srcUrl: null },
      { key: 'n2', ref: null, tag: 'body', domId: null, role: null, parentKey: 'n1', frameIndex: null, srcUrl: null },
      { key: 'n3', ref: null, tag: 'form', domId: 'login-form', role: 'form', parentKey: 'n2', frameIndex: null, srcUrl: null },
      { key: 'n4', ref: null, tag: 'label', domId: 'user-label', role: null, parentKey: 'n3', frameIndex: null, srcUrl: null },
      { key: 'n5', ref: '@e1', tag: 'input', domId: 'username', role: 'textbox', parentKey: 'n3', frameIndex: null, srcUrl: null },
      { key: 'n6', ref: '@e2', tag: 'button', domId: 'submit', role: 'button', parentKey: 'n3', frameIndex: null, srcUrl: null },
      { key: 'n7', ref: null, tag: 'div', domId: 'frame-box', role: null, parentKey: 'n2', frameIndex: null, srcUrl: null },
      { key: 'n8', ref: '@e3', tag: 'iframe', domId: 'x-frame', role: 'iframe', parentKey: 'n7', frameIndex: 0, srcUrl: 'https://frame.test/x.html' },
    ],
    edges: [
      { type: 'child', from: 'n1', to: 'n2' },
      { type: 'child', from: 'n2', to: 'n3' },
      { type: 'child', from: 'n3', to: 'n4' },
      { type: 'child', from: 'n3', to: 'n5' },
      { type: 'child', from: 'n3', to: 'n6' },
      { type: 'child', from: 'n2', to: 'n7' },
      { type: 'child', from: 'n7', to: 'n8' },
      { type: 'html-for', from: 'n4', to: 'n5' },
      { type: 'controls', from: 'n6', to: 'n3' },
      { type: 'form', from: 'n3', to: 'n5' },
      { type: 'labelledby', from: 'n4', to: 'n6' },
      { type: 'unknown-endpoint', from: 'n3', to: 'ghost' },
    ],
    truncated: false,
  };
}

function observedGraphNodes(): VomGraphObservedNode[] {
  return [
    { graphKey: 'n5', ref: '@e1', tag: 'input', role: 'textbox', name: '用户名', anchor: { 'aria-rowindex': 2 } },
    { graphKey: 'n6', ref: '@e2', tag: 'button', role: 'button', name: '提交' },
    { graphKey: 'n8', ref: '@e3', tag: 'iframe', role: 'iframe', stableRef: 's-frame' },
    { graphKey: 'n4', ref: null, stableRef: null, tag: 'label', role: null, name: '用户名' },
  ];
}

test('差分（深水区）：buildVomGraph 与 JS vom-graph.js 逐字段相等（图 + info 映射）', async () => {
  const { libs } = await loadJs();
  const jsBuild = fnOf(libs.jsGraph, 'buildVomGraph');
  const graph = rawGraphFixture();
  const tsObserved = observedGraphNodes();
  const jsObserved = observedGraphNodes();
  const ts = buildVomGraph({ graph, nodes: tsObserved });
  const js = jsBuild({ graph, nodes: jsObserved }) as {
    available: boolean;
    payload: Record<string, unknown>;
    info: Map<object, { id: string; parentId: string; ancestorIds: string[] }>;
  };
  assert.equal(ts.available, js.available);
  assertSameJson(js.payload, ts.payload, 'buildVomGraph payload 不一致');
  for (let index = 0; index < tsObserved.length; index += 1) {
    const tsInfo = ts.info.get(tsObserved[index]!);
    const jsInfo = js.info.get(jsObserved[index]!);
    assertSameJson(jsInfo ?? null, tsInfo ?? null, 'buildVomGraph info 不一致：' + String(index));
  }
});

test('差分（深水区）：buildVomGraph 上限/截断与空图分支与 JS 一致', async () => {
  const { libs } = await loadJs();
  const jsBuild = fnOf(libs.jsGraph, 'buildVomGraph');
  const cases: Array<{ graph: VomGraphRawFacts; nodes: VomGraphObservedNode[]; limits?: { nodes?: number; edges?: number } }> = [
    { graph: rawGraphFixture(), nodes: observedGraphNodes(), limits: { nodes: 3, edges: 2 } },
    { graph: { available: true, nodes: [], edges: [], truncated: false }, nodes: [] },
    { graph: { available: true, nodes: rawGraphFixture().nodes, edges: rawGraphFixture().edges, truncated: true }, nodes: [] },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index]!;
    const ts = buildVomGraph({ graph: item.graph, nodes: item.nodes, ...(item.limits ? { limits: item.limits } : {}) });
    const js = jsBuild({ graph: item.graph, nodes: item.nodes, ...(item.limits ? { limits: item.limits } : {}) }) as { payload: Record<string, unknown> };
    assertSameJson(js.payload, ts.payload, 'buildVomGraph 分支不一致：case ' + String(index));
  }
});

test('差分（深水区）：mergeAxIntoGraph 与 JS ax-graph.js 逐字段相等', async () => {
  const { libs } = await loadJs();
  const jsBuild = fnOf(libs.jsGraph, 'buildVomGraph');
  const jsMerge = fnOf(libs.jsAxGraph, 'mergeAxIntoGraph');
  const graph = rawGraphFixture();
  const axNodes = [
    { nodeId: 'a1', parentId: null, role: 'RootWebArea' },
    { nodeId: 'a2', parentId: 'a1', role: 'generic' },
    { nodeId: 'a3', parentId: 'a2', role: 'button' },
    { nodeId: 'a4', parentId: 'a99', role: 'heading' },
  ];
  const observedForTs = observedGraphNodes();
  observedForTs[1] = { ...(observedForTs[1] ?? {}), ax: { nodeId: 'a3' } };
  const observedForJs = observedGraphNodes();
  observedForJs[1] = { ...(observedForJs[1] ?? {}), ax: { nodeId: 'a3' } };
  const tsBase = buildVomGraph({ graph, nodes: observedForTs });
  const jsBase = jsBuild({ graph, nodes: observedForJs }) as {
    payload: Record<string, unknown>;
    info: Map<object, { id: string; parentId: string; ancestorIds: string[] }>;
  };
  const tsMerged = mergeAxIntoGraph(tsBase.payload, { axNodes, nodes: observedForTs, info: tsBase.info });
  const jsMerged = jsMerge(jsBase.payload, { axNodes, nodes: observedForJs, info: jsBase.info }) as {
    graph: Record<string, unknown>;
    addedEdges: number;
    addedNodes: number;
    dropped: number;
  };
  assertSameJson(jsMerged.graph, tsMerged.graph, 'mergeAxIntoGraph graph 不一致');
  assert.equal(tsMerged.addedEdges, jsMerged.addedEdges);
  assert.equal(tsMerged.addedNodes, jsMerged.addedNodes);
  assert.equal(tsMerged.dropped, jsMerged.dropped);
  // 上限：edges=1 时超出的 AX 边计入 dropped。
  const limitedTs = mergeAxIntoGraph(tsBase.payload, { axNodes, nodes: observedForTs, info: tsBase.info, limits: { edges: 1, nodes: 1 } });
  const limitedJs = jsMerge(jsBase.payload, { axNodes, nodes: observedForJs, info: jsBase.info, limits: { edges: 1, nodes: 1 } }) as { graph: Record<string, unknown>; dropped: number };
  assertSameJson(limitedJs.graph, limitedTs.graph, 'mergeAxIntoGraph 上限分支不一致');
  assert.equal(limitedTs.dropped, limitedJs.dropped);
});

test('差分（深水区）：deriveLayers 与 JS vom-layers.js 逐字段相等', async () => {
  const { libs } = await loadJs();
  const jsDerive = fnOf(libs.jsLayers, 'deriveLayers');
  const facts = [
    { role: 'dialog', name: '确认', rect: { x: 100, y: 80, width: 400, height: 300 }, coverage: 0.12, zIndex: '11', position: 'fixed' },
    { role: 'overlay', name: '遮罩', rect: { x: 0, y: 0, width: 1280, height: 800 }, coverage: 1, zIndex: '10', position: 'fixed' },
    { role: null, name: 'popover', rect: { x: 10, y: 10, w: 120, h: 90 }, topLayer: 'popover', blocking: false },
    { role: null, name: 'toast', position: 'sticky', coverage: 0.05 },
    { role: 'alertdialog', name: '告警', styles: { 'z-index': 'auto', position: 'absolute' }, coverage: 0.3 },
    null,
  ];
  for (const options of [{}, { includeBase: false, limit: 2 }, { limit: 100 }]) {
    const ts = deriveLayers(facts as unknown as Parameters<typeof deriveLayers>[0], options);
    const js = jsDerive(facts, options) as Record<string, unknown>;
    assertSameJson(js, ts, 'deriveLayers 不一致：' + JSON.stringify(options));
  }
});

test('差分（深水区）：buildFrameVomGraphs 与 JS frame-vom.js 逐字段相等（含 owner 自动匹配）', async () => {
  const { libs } = await loadJs();
  const jsFrameVom = fnOf(libs.jsFrameVom, 'buildFrameVomGraphs');
  const childGraph: VomGraphRawFacts = {
    available: true,
    nodes: [
      { key: 'c1', ref: null, tag: 'html', domId: null, role: null, parentKey: null },
      { key: 'c2', ref: '@e1', tag: 'button', domId: 'child-btn', role: 'button', parentKey: 'c1' },
    ],
    edges: [{ type: 'child', from: 'c1', to: 'c2' }],
    truncated: false,
  };
  const entries = [
    { frameId: 0, url: 'https://host.test/root.html', parentFrameId: -1, graph: rawGraphFixture() },
    { frameId: 3, url: 'https://frame.test/x.html', parentFrameId: 0, graph: childGraph },
    { frameId: 7, url: 'https://frame.test/missing.html', parentFrameId: 3, graph: { available: true, nodes: [], edges: [] } },
  ];
  const options = {
    childFrames: [
      { frameId: 0, url: 'https://host.test/root.html', parentFrameId: -1 },
      { frameId: 3, url: 'https://frame.test/x.html', parentFrameId: 0, hidden: false },
      { frameId: 7, url: 'https://frame.test/hidden.html', parentFrameId: 3, hidden: true },
    ],
    limits: { frames: 16 },
  };
  const ts = buildFrameVomGraphs(entries, options);
  const js = jsFrameVom(entries, options) as Record<string, unknown>;
  assertSameJson(js, ts, 'buildFrameVomGraphs 不一致');
  // 帧上限分支。
  const limitedOptions = { ...options, limits: { frames: 1 } };
  assertSameJson(jsFrameVom(entries, limitedOptions) as Record<string, unknown>, buildFrameVomGraphs(entries, limitedOptions), 'buildFrameVomGraphs 上限分支不一致');
});

test('差分（深水区）：buildVisualObjects 与 JS visual-objects.js 逐字段相等', async () => {
  const { libs } = await loadJs();
  const jsBuild = fnOf(libs.jsVisual, 'buildVisualObjects');
  const regions = [
    { kind: 'region' as const, index: 1, tag: 'canvas', id: 'viz', rect: { x: 0, y: 0, width: 240, height: 120 } },
    { kind: 'region' as const, index: 2, tag: 'img', id: null, rect: { x: 0, y: 140, width: 120, height: 80 } },
  ];
  const refs = [
    { ref: '@e1', role: 'button', name: '视觉按钮', rect: { x: 0, y: 240, width: 120, height: 32 } },
    { ref: '@e2', role: null, name: null, rect: { x: 10, y: 300, width: 40, height: 40 } },
  ];
  const jsRegions = {
    candidates: regions.map((region) => ({ index: region.index, tag: region.tag, id: region.id, rect: region.rect })),
  };
  const jsRefs = {
    refs: refs.map((ref) => ({ ref: ref.ref, role: ref.role, name: ref.name, x: ref.rect.x, y: ref.rect.y, width: ref.rect.width, height: ref.rect.height })),
  };
  assertSameJson(jsBuild({ regions: jsRegions, refs: jsRefs }), buildVisualObjects(regions, refs), 'visualObjects 不一致');
  assertSameJson(jsBuild({ regions: null, refs: null }), buildVisualObjects(null, null), 'visualObjects 空输入不一致');
});

// ---------------------------------------------------------------------------
// 已知差异清单：每项必须有可执行断言，不能只写注释
// ---------------------------------------------------------------------------

interface KnownDifference {
  id: string;
  detail: string;
}

/**
 * TS apps 层与 JS 扩展的**已知**差异（均为有意边界，不是实现偏差）：
 * - 差分测试要求除这些项外零差异；新增差异必须先在这里登记并给出断言。
 */
const KNOWN_DIFFERENCES: readonly KnownDifference[] = Object.freeze([
  {
    id: 'groups-shape',
    detail: 'JS 遗留 groups={sections,rows,forms}（section/row/form 锚点）；TS groups=packages/vom context groups（landmark/form/table）。语义源不同，故不与 JS buildVomGroups 对拍；与 JS buildVomContext 已逐字段对拍。',
  },
  {
    id: 'backend-node-id',
    detail: 'JS 用 CDP backendNodeId；TS 无 debugger，backendNodeId 是 DOM 顺序号（backendNodeSource=dom-order）。不影响关系/上下文端点（端点用节点 id）。',
  },
  {
    id: 'vom-weights-billing',
    detail: 'JS observe 输出 vomWeights/billing/六阶段评分；TS 摘要不含计费账本/预算裁剪（vomScore 仍是 rich.ts 启发式）。这是本切片明确不做的面。',
  },
  {
    id: 'cross-frame-background-aggregation',
    detail: 'TS 内容脚本只产出本帧 facts；跨 frame 汇总需要 background 收集各帧 facts（本切片只支持把 frames 子图作为输入传入，background 未聚合）。',
  },
  {
    id: 'graph-public-id',
    detail: 'TS 内容脚本用 rich 节点 id 作为公开图 id（原始图节点带 vomId 扩展字段），JS 基线用 @eN ref/stableRef；差分测试在同一输入形状（无 vomId）下逐字段相等。',
  },
  {
    id: 'ax-projection-dom',
    detail: 'TS 没有 CDP AX 树：AX 边由 DOM 祖先投影并补 ax-root 上下文节点；JS 的 ax 边来自真实 Accessibility.getFullAXTree。',
  },
  {
    id: 'layer-scan-dom',
    detail: 'TS 的 L2 带直接扫 DOM + computed style；JS computeLayerBands 用 AX + DOMSnapshot 事实。字段形状（kind modal/mask）一致，但候选来源不同。',
  },
  {
    id: 'color-pure-parse',
    detail: 'TS 颜色解析优先纯算法（oklch/color-mix），浏览器里 canvas 钩子作为兜底；与浏览器归一化的 8bit 量化可能有 ±1 差，对比度保留两位小数。',
  },
]);

test('已知差异清单：key 唯一、非空，且每项都有可执行断言证明', async () => {
  assert.ok(KNOWN_DIFFERENCES.length > 0);
  assert.equal(new Set(KNOWN_DIFFERENCES.map((item) => item.id)).size, KNOWN_DIFFERENCES.length);
  for (const difference of KNOWN_DIFFERENCES) assert.ok(difference.detail.length >= 20, difference.id + ' 的说明太短');

  const { libs } = await loadJs();
  const jsBuildGroups = fnOf(libs.jsGroups, 'buildVomGroups');

  // groups-shape：JS 遗留 groups 结构与 TS context groups 结构确实不同。
  const bundle = await diffBundle('basic-form');
  const projection = bundle.jsProjection;
  const legacyGroups = jsBuildGroups(projection.entries) as Record<string, unknown>;
  assert.ok(Array.isArray(legacyGroups.sections) && Array.isArray(legacyGroups.rows) && Array.isArray(legacyGroups.forms));
  assert.equal('sections' in bundle.tsSummary.groups, false, 'TS groups 不应伪装成 JS legacy groups');
  assert.equal(typeof bundle.tsSummary.groups.byKind, 'object');

  // backend-node-id：facts 的 backendNodeId 全是整数且限制说明写明 DOM 顺序号。
  for (const node of bundle.facts.nodes) assert.equal(Number.isInteger(node.backendNodeId), true);
  assert.ok(bundle.facts.limitations.some((line) => line.includes('DOM 顺序号')));

  // vom-weights-billing：TS 摘要没有 billing 字段，限制说明写明不含账本。
  assert.equal('billing' in bundle.tsSummary.stats, false);
  assert.ok(bundle.tsSummary.limitations.some((line) => line.includes('计费账本')));

  // cross-frame-background-aggregation：单文档 facts 的 frames 为空，frames 夹具需要显式传入。
  assert.deepEqual(readFixture('basic-form').frames, []);
  assert.equal(readFixture('frames').frames.length, 3);
  assert.ok(bundle.tsSummary.limitations.some((line) => line.includes('本帧')));

  // graph-public-id：TS 页面图节点带 vomId（公开 id 用 rich 节点 id），JS 基线没有这个字段。
  const graphFake = createFakeDom([
    { tag: 'button', id: 'b', type: 'button', text: '按钮' },
    { tag: 'label', id: 'l', attrs: { for: 'b' }, text: '标签' },
  ], { url: 'https://example.test/graph.html' });
  const graphCollected = collectElements(graphFake.env).collected;
  const graphElementById = assignRichElementIds(graphCollected);
  const rawGraph = buildPageGraph({
    url: 'https://example.test/graph.html',
    collected: graphCollected,
    elementById: graphElementById,
    refByNodeId: new Map([['b', '@e1']]),
  });
  assert.ok((rawGraph.nodes ?? []).length > 0);
  assert.equal((rawGraph.nodes ?? []).every((node) => typeof (node as { vomId?: unknown }).vomId === 'string'), true, 'TS 原始图节点应带 vomId');
  assert.equal('vomId' in ((rawGraph.nodes ?? [])[0] as object), true);
  // 去掉 vomId 后（JS 输入形状）buildVomGraph 与 JS 逐字段相等——见上面的深水区差分用例。
  assert.equal('key' in ((rawGraph.nodes ?? [])[0] as object), true);

  // ax-projection-dom：DOM 投影必然补 ax-root 上下文节点（没有真实 AX 根）。
  const axButton = graphFake.document.getElementById?.('b') ?? null;
  const axProjection = buildAxProjection([{ axId: 'ax1', element: axButton, role: 'button' }]);
  assert.ok(axProjection.some((node) => node.nodeId === 'ax-root' && node.parentId === null));
  assert.ok(axProjection.some((node) => node.nodeId === 'ax1' && node.parentId === 'ax-root'));

  // layer-scan-dom：TS 直接从 DOM 事实产出 L2 带（kind 只可能是 modal/mask）。
  const layerFake = createFakeDom([
    { tag: 'div', id: 'mask', style: { position: 'fixed', zIndex: '10' }, rect: { left: 0, top: 0, width: 1280, height: 800 } },
    { tag: 'div', id: 'dlg', attrs: { role: 'dialog' }, style: { position: 'fixed', zIndex: '11' }, rect: { left: 100, top: 80, width: 400, height: 300 } },
  ], { url: 'https://example.test/layers.html' });
  const layerCollected = collectElements(layerFake.env).collected;
  const layers = buildLayerFacts(layerFake.env, layerCollected);
  assert.ok(layers.length >= 1);
  for (const layer of layers) assert.ok(layer.kind === 'modal' || layer.kind === 'mask', 'layer.kind 越界：' + layer.kind);
  assert.ok(layers.every((layer) => Number.isInteger(layer.paintOrder)));

  // color-pure-parse：无 canvas 时纯解析器仍然给出确定数值（浏览器里 canvas 只是兜底）。
  assert.equal(createCanvasColorParser(layerFake.env), undefined, 'fake DOM 没有 canvas，canvas 解析器应为 undefined');
  const pureOklch = parseCssColor('oklch(0.2 0.05 240)');
  assert.ok(pureOklch && Number.isFinite(pureOklch.r) && Number.isFinite(pureOklch.b));
});

test('差分口径自检：投影实现确实独立（JS 参考不使用 TS 模块）', () => {
  // JS 参考文件不应 import 任何 apps/extension 源码；否则差分变成自己和自己比。
  const reference = fs.readFileSync(path.join(HERE, 'support', 'vom-js-reference.mjs'), 'utf8');
  assert.equal(/from ['"].*src\/content/.test(reference), false, 'JS 参考投影不得 import TS 实现');
  assert.equal(/from ['"].*packages\/vom/.test(reference), false, 'JS 参考投影不得 import packages/vom');
});
