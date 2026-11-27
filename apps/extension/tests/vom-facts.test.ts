// tests/vom-facts.test.ts —— VOM 页面事实抽取/投影（纯 JSON 层，不依赖浏览器）。
//
// 覆盖：
// 1) 夹具一致性：tests/fixtures/vom-facts/*.json 必须等于「用运行时同一套 DOM 流程重新抽取」
//    的结果（防止夹具漂移，差分测试的输入因此可信）；
// 2) 抽取语义：ARIA 关系、祖先链、label/form 归属、表格结构、affordance 输入事实；
// 3) 投影：facts → packages/vom 的 entries/graph（边类型/方向/去重/端点）；
// 4) 上限与截断：nodes/edges 超限时如实 truncated，不静默丢内容；
// 5) 异常输入：空 facts / 缺字段的旧 facts 不抛异常。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VOM_FACTS_LIMITS,
  projectVomFacts,
  relationInputOf,
  contextInputOf,
  type VomPageFacts,
} from '../src/content/vom-facts.ts';
import { vomFixturePages } from './support/vom-fixture-pages.ts';
import { VOM_FIXTURE_DIR, extractVomFixtureFacts } from './support/write-vom-fixtures.ts';

const FIXTURE_DIR = VOM_FIXTURE_DIR;
const PAGE_BY_NAME = new Map(vomFixturePages().map((page) => [page.name, page]));

function readFixture(name: string): VomPageFacts {
  const file = path.join(FIXTURE_DIR, name + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as VomPageFacts;
}

function fixtureNames(): string[] {
  return fs.readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface PlainGraph {
  nodes: Array<{ id: string; domId: string | null }>;
  edges: Array<{ type: string; from: string; to: string }>;
  roots: string[];
  truncated: boolean;
}

/** 把 packages/vom 的宽松图形状收窄成断言里好用的结构（运行时字段仍是 unknown 才安全）。 */
function plainGraph(projection: ReturnType<typeof projectVomFacts>): PlainGraph {
  const raw = (projection.graph ?? {}) as {
    nodes?: Array<{ id?: unknown; domId?: unknown }>;
    edges?: Array<{ type?: unknown; from?: unknown; to?: unknown }>;
    roots?: unknown[];
    truncated?: unknown;
  };
  return {
    nodes: (raw.nodes ?? []).map((node) => ({ id: String(node.id ?? ''), domId: node.domId == null ? null : String(node.domId) })),
    edges: (raw.edges ?? []).map((edge) => ({ type: String(edge.type ?? ''), from: String(edge.from ?? ''), to: String(edge.to ?? '') })),
    roots: (raw.roots ?? []).map((root) => String(root)),
    truncated: raw.truncated === true,
  };
}

function emptyFacts(overrides: Partial<VomPageFacts> = {}): VomPageFacts {
  return {
    version: 1,
    url: 'https://example.test/empty.html',
    title: '空页',
    frameId: 0,
    nodes: [],
    frames: [],
    limits: { ...VOM_FACTS_LIMITS },
    truncated: false,
    limitations: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 夹具一致性
// ---------------------------------------------------------------------------

test('夹具 facts 与运行时抽取逐字段一致（防止夹具漂移）', () => {
  const names = fixtureNames();
  assert.deepEqual(names.sort(), [...PAGE_BY_NAME.keys()].sort(), '夹具文件与夹具页定义必须一一对应');
  for (const name of names) {
    const page = PAGE_BY_NAME.get(name.replace(/\.json$/, ''));
    assert.ok(page, '缺少夹具页定义：' + name);
    const committed = readFixture(name.replace(/\.json$/, ''));
    const extracted = JSON.parse(JSON.stringify(extractVomFixtureFacts(page))) as VomPageFacts;
    assert.deepEqual(extracted, committed, name + ' 的 facts 与已提交夹具不一致（请重跑 write-vom-fixtures.ts）');
  }
});

// ---------------------------------------------------------------------------
// 2) 抽取语义
// ---------------------------------------------------------------------------

test('basic-form：ARIA 关系 / 祖先链 / label-for / form 归属全部落到 facts', () => {
  const facts = readFixture('basic-form');
  assert.equal(facts.version, 1);
  assert.ok(facts.nodes.length >= 25, '事实节点太少：' + facts.nodes.length);
  const byId = new Map(facts.nodes.map((node) => [node.id, node]));
  const username = byId.get('username');
  assert.ok(username);
  assert.equal(username.role, 'textbox');
  assert.equal(username.domId, 'username');
  assert.equal(username.invalid, true, 'aria-invalid=true 应标记 invalid');
  assert.deepEqual(username.relations.labelledBy, []);
  assert.deepEqual(username.relations.describedBy, ['user-hint']);
  assert.deepEqual(username.relations.errorMessage, ['user-error']);
  assert.deepEqual(username.relations.labelIds, ['user-label'], 'label[for] 应进入 labelIds');
  assert.deepEqual(username.relations.form, ['login-form']);
  // 祖先链近 → 远，只记录能解析到 rich 节点的祖先。
  assert.deepEqual(username.ancestorIds.slice(0, 2), ['login-form', 'app']);
  assert.equal(username.ancestors[0]?.tag, 'form');

  const city = byId.get('city');
  assert.deepEqual(city?.relations.controls, ['city-list'], 'aria-controls 原值保留为 DOM id');
  assert.equal(city?.ariaHasPopup, 'listbox');
  assert.equal(city?.expanded, false);

  const dialogClose = byId.get('dialog-close');
  assert.deepEqual(dialogClose?.ancestorIds.slice(0, 1), ['profile-dialog'], 'dialog 内按钮的祖先链应包含 dialog');

  // 每个 DOM id 在 facts 里最多出现一次（节点 id 唯一性由 rich.ts 保证）。
  const domIds = facts.nodes.map((node) => node.domId).filter((value): value is string => Boolean(value));
  assert.equal(new Set(domIds).size, domIds.length, 'facts 里 DOM id 不应重复');
  const ids = facts.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, '节点 id 必须唯一');
});

test('basic-form：表格结构 / affordance 输入事实来自页面属性', () => {
  const facts = readFixture('basic-form');
  const byId = new Map(facts.nodes.map((node) => [node.id, node]));
  const table = byId.get('people');
  assert.ok(table?.table);
  assert.deepEqual(table.table.headers.map((header) => header.name), ['姓名', '城市']);
  assert.deepEqual(table.table.headers.map((header) => header.id), ['people-name', 'people-city']);
  assert.equal(table.table.dataRows, 1);
  assert.equal(table.table.caption, '用户表');
  assert.equal(table.role, 'table');

  const avatar = byId.get('avatar');
  assert.equal(avatar?.inputType, 'file');
  assert.equal(avatar?.tag, 'input');

  const scrollBox = byId.get('scroll-box');
  assert.equal(scrollBox?.scrollable, true);
  assert.equal(scrollBox?.overflowY, 'auto');

  const slider = byId.get('slider');
  assert.equal(slider?.draggable, true);
  assert.equal(slider?.dragHint, 'draggable');
  assert.equal(slider?.tabIndex, 0);
  assert.equal(slider?.cursor, 'pointer');

  const toggle = byId.get('toggle');
  assert.equal(toggle?.ariaPressed, true);

  const logo = byId.get('logo');
  assert.equal(logo?.alt, '公司 Logo');
  assert.equal(logo?.title, '公司标志');

  const dragHandle = byId.get('drag-handle');
  assert.equal(dragHandle?.dragHint, 'drag-handle');
});

test('app-shell：landmark/form/table 结构事实完整（上下文锚点依赖它们）', () => {
  const facts = readFixture('app-shell');
  const byId = new Map(facts.nodes.map((node) => [node.id, node]));
  for (const id of ['topbar', 'sidebar', 'content', 'page-footer', 'filter-form', 'orders-table']) {
    assert.ok(byId.has(id), '缺少结构节点：' + id);
  }
  assert.equal(byId.get('sidebar')?.role, 'navigation');
  assert.equal(byId.get('page-footer')?.role, 'contentinfo');
  assert.equal(byId.get('content')?.role, 'main');
  assert.deepEqual(byId.get('filter-kw')?.relations.labelIds, ['filter-label']);
  assert.deepEqual(byId.get('detail-pane')?.relations.labelledBy, ['detail-title']);
  assert.deepEqual(byId.get('detail-pane')?.relations.describedBy, ['detail-hint']);
  assert.equal(byId.get('orders-table')?.table?.dataRows, 2);
});

test('frames：frame 子图事实原样保留（跨 frame 关系/上下文的输入）', () => {
  const facts = readFixture('frames');
  assert.equal(facts.frames.length, 3);
  const byFrame = new Map(facts.frames.map((frame) => [frame.frameId, frame]));
  assert.equal(byFrame.get(5)?.ownerNodeId, 'frame-x');
  assert.equal(byFrame.get(9)?.parentFrameId, 5);
  assert.ok((byFrame.get(5)?.graph?.nodes as Array<{ id?: unknown }> | undefined)?.some((node) => String(node.id) === 'f5:btn'));
  assert.ok(facts.nodes.some((node) => node.id === 'frame-x'), '主文档 iframe owner 节点必须在 facts 里');
});

// ---------------------------------------------------------------------------
// 3) 投影（facts → packages/vom 输入）
// ---------------------------------------------------------------------------

test('projectVomFacts：graph 节点/边方向正确、端点存在、无重复边', () => {
  const facts = readFixture('basic-form');
  const projection = projectVomFacts(facts);
  assert.equal(projection.entries.length, facts.nodes.length);
  assert.equal(projection.graph.available, true);
  const graph = plainGraph(projection);
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const entry of projection.entries) assert.ok(ids.has(String(entry.id)), 'entry 不在 graph 节点里：' + String(entry.id));
  const edges = graph.edges;
  const key = (edge: { type: string; from: string; to: string }): string => edge.type + '|' + edge.from + '|' + edge.to;
  assert.equal(new Set(edges.map(key)).size, edges.length, 'graph 边必须去重');
  for (const edge of edges) {
    assert.ok(ids.has(edge.from), '边起点不存在：' + edge.from);
    assert.ok(ids.has(edge.to), '边终点不存在：' + edge.to);
    assert.notEqual(edge.from, edge.to, '普通边不应自环：' + edge.type);
  }
  const has = (type: string, from: string, to: string): boolean => edges.some((edge) => edge.type === type && edge.from === from && edge.to === to);
  // DOM 包含链：form → 控件；main → form。
  assert.ok(has('child', 'login-form', 'username'));
  assert.ok(has('child', 'app', 'login-form'));
  // label[for] → 控件（html-for）；aria-describedby/errormessage 方向是“证据 → 目标”。
  assert.ok(has('html-for', 'user-label', 'username'));
  assert.ok(has('describedby', 'user-hint', 'username'));
  assert.ok(has('errormessage', 'user-error', 'username'));
  // aria-controls 方向是“控件 → 被控区域”。
  assert.ok(has('controls', 'city', 'city-list'));
  // form 归属边：form → 控件（即使控件没有 aria 关系）。
  assert.ok(has('form', 'login-form', 'submit'));
  // 父子 roots：app 没有祖先 → root。
  assert.ok(graph.roots.includes('app'));
});

test('projectVomFacts：tablist 的 aria-controls 同时产生 controls 与 tab-controls 边', () => {
  const graph = plainGraph(projectVomFacts(readFixture('app-shell')));
  const has = (type: string, from: string, to: string): boolean => graph.edges.some((edge) => edge.type === type && edge.from === from && edge.to === to);
  assert.ok(has('controls', 'tab-info', 'panel-info'));
  assert.ok(has('tab-controls', 'tab-info', 'panel-info'));
  assert.ok(has('labels', 'detail-title', 'detail-pane') || has('labelledby', 'detail-title', 'detail-pane'));
});

test('projectVomFacts：关系输入与上下文输入共用同一份投影（单一事实源）', () => {
  const facts = readFixture('app-shell');
  const projection = projectVomFacts(facts);
  const relationInput = relationInputOf(projection);
  const contextInput = contextInputOf(projection);
  assert.equal(relationInput.entries, projection.entries);
  assert.equal(relationInput.graph, projection.graph);
  assert.equal(contextInput.entries, projection.entries);
  assert.equal(contextInput.graph, projection.graph);
  assert.equal(relationInput.limits?.relations, facts.limits.relations);
  assert.equal(contextInput.limits?.groups, facts.limits.groups);
});

test('projectVomFacts：frames 投影成 frame 子图输入（含 owner link）', () => {
  const facts = readFixture('frames');
  const projection = projectVomFacts(facts);
  assert.ok(Array.isArray(projection.frames));
  assert.equal(projection.frames?.length, 3);
  const frame5 = (projection.frames ?? []).find((frame) => Number(frame.frameId) === 5) as
    | { parentFrameId?: number; graph?: { nodes?: Array<{ id?: unknown }>; edges?: Array<{ type?: unknown; from?: unknown; to?: unknown }> } | null }
    | undefined;
  assert.ok(frame5);
  assert.equal(frame5?.parentFrameId, 0);
  const graph = frame5?.graph ?? null;
  assert.ok(graph && Array.isArray(graph.nodes) && graph.nodes.some((node) => String(node.id) === 'f5:btn'));
  assert.ok(Array.isArray(graph?.edges) && graph?.edges.some((edge) => edge.type === 'frame' && edge.from === 'frame:5' && edge.to === 'f5:root'));
  // 主文档图包含 frame 节点与 iframe owner → frame 边。
  const mainGraph = plainGraph(projection);
  assert.ok(mainGraph.edges.some((edge) => edge.type === 'frame' && edge.from === 'frame-x' && edge.to === 'frame:5'));
});

// ---------------------------------------------------------------------------
// 4) 上限与截断
// ---------------------------------------------------------------------------

test('nodes/edges 超限：facts 与 projection 都如实标记 truncated', () => {
  const page = PAGE_BY_NAME.get('basic-form');
  assert.ok(page);
  const limitedFacts = extractVomFixtureFacts(page, { nodes: 4, edges: 2 });
  assert.equal(limitedFacts.nodes.length, 4);
  assert.equal(limitedFacts.truncated, true);
  assert.equal(limitedFacts.limits.nodes, 4);
  assert.equal(limitedFacts.limits.edges, 2);
  const graph = plainGraph(projectVomFacts(limitedFacts));
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.truncated, true);
});

// ---------------------------------------------------------------------------
// 5) 异常输入
// ---------------------------------------------------------------------------

test('空 facts / 缺字段旧 facts 不抛异常（前向兼容）', () => {
  const empty = projectVomFacts(emptyFacts());
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.graph.nodes, []);
  assert.deepEqual(empty.graph.edges, []);
  assert.equal(empty.frames, null);

  const legacy = emptyFacts({
    nodes: [{
      id: 'legacy',
      ref: null,
      domId: null,
      tag: 'button',
      role: 'button',
      name: '旧节点',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      visible: true,
      interactive: true,
      clickable: true,
      inForm: false,
      disabled: false,
      invalid: false,
      inputState: null,
      paintOrder: 0,
      backendNodeId: 1,
      ancestorIds: [],
      ancestors: [],
      // relations / table 故意缺失（旧 payload 形状）
      inputType: null,
      contentEditable: false,
      draggable: false,
      dragHint: null,
      overflowY: null,
      scrollable: false,
      ariaHasPopup: null,
      hoverable: false,
      href: null,
      cursor: null,
      tabIndex: null,
      ariaPressed: null,
      expanded: null,
      alt: null,
      title: null,
    }],
  } as unknown as Partial<VomPageFacts>);
  const projection = projectVomFacts(legacy);
  assert.equal(projection.entries.length, 1);
  assert.equal(plainGraph(projection).nodes.length, 1);
});

test('clone 后的 facts 与原始投影一致（纯 JSON 层可安全跨进程）', () => {
  const facts = readFixture('app-shell');
  const cloned = clone(facts);
  assert.deepEqual(projectVomFacts(cloned), projectVomFacts(facts));
  assert.equal(JSON.stringify(cloned), JSON.stringify(facts));
});
