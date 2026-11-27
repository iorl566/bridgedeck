// packages/vom/test/frame-relations-diff.test.ts —— 跨 frame 关系图 JS ↔ TS 差分测试。
//
// 覆盖边界：三种输入形态（{graphs} 包装 / frame 列表 / 直接子图数组）、frameId 与
// frameNodeId 两种命名、父帧归一（-1 / 自身 / 未知）、roots 两种来源（roots 数组 /
// frame 节点出边）、iframe 元素 → 子帧的 owns 边、frames/relations 双上限、异常事实。
//
// 除逐字段 deepEqual 外，还断言不变量（无自环、端点存在、confidence 与 sources 合法、
// 统计与列表自洽、深度不超过 8 层）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_RELATION_CONFIDENCE,
  FRAME_RELATION_LIMITS,
  VOM_FRAME_RELATIONS_VERSION,
  buildCrossFrameRelations,
  collectFrameGraphs,
  frameNodeIdOf,
  summarizeCrossFrameRelations,
} from '../src/index.ts';
import type { FrameRelationsInput, FrameRelationsOptions } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-frame-relations.js');

function asInput(value: unknown): FrameRelationsInput {
  return value as FrameRelationsInput;
}

function asOptions(value: unknown): FrameRelationsOptions {
  return value as FrameRelationsOptions;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ROOT_GRAPH = {
  nodes: [
    { id: 'frame:0', role: 'document' },
    { id: '@main', role: 'main' },
    { id: '@btn', role: 'button' },
  ],
  roots: ['@main'],
  edges: [
    { type: 'frame', from: 'frame:0', to: '@main' },
    { type: 'frame', from: '@btn', to: 'frame:5' },
    { type: 'child', from: '@main', to: '@btn' },
  ],
};

const CHILD_GRAPH = {
  nodes: [{ id: 'frame:5', role: 'frame', url: 'https://example.test/child' }, { id: '@c1', role: 'textbox' }],
  roots: ['@c1'],
  edges: [
    { type: 'frame', from: 'frame:5', to: '@c1' },
    { type: 'frame', from: 'frame:5', to: 'frame:9' },
  ],
};

const CASES: readonly { label: string; input: unknown }[] = [
  { label: '空输入', input: {} },
  { label: 'undefined', input: undefined },
  { label: '非对象输入', input: 'nope' },
  { label: 'null', input: null },
  {
    label: '{graphs} 包装：两帧 + 父帧归一',
    input: {
      graphs: [
        { frameId: 0, url: 'https://example.test/', graph: ROOT_GRAPH },
        { frameId: 5, parentFrameId: 0, graph: CHILD_GRAPH },
      ],
    },
  },
  {
    label: 'frame 列表：graph 与 vom 两种字段',
    input: [
      { frameId: 0, url: 'https://example.test/', graph: ROOT_GRAPH },
      { frameId: 5, vom: CHILD_GRAPH, url: 'https://example.test/child' },
      { frameId: 9, parentFrameId: 5, vom: { nodes: [], edges: [] } },
    ],
  },
  {
    label: '直接子图数组（图本身就是列表项）',
    input: [
      { frameId: 0, nodes: ROOT_GRAPH.nodes, roots: ROOT_GRAPH.roots, edges: ROOT_GRAPH.edges },
      { frameId: 5, nodes: CHILD_GRAPH.nodes, roots: CHILD_GRAPH.roots, edges: CHILD_GRAPH.edges },
    ],
  },
  {
    label: 'frameNodeId 命名 + 父帧异常值',
    input: {
      graphs: [
        { frameNodeId: 'frame:0', graph: { nodes: [{ id: 'frame:0' }], edges: [] } },
        { frameNodeId: 'frame:7', parentFrameId: -1, graph: { nodes: [{ id: 'frame:7' }], edges: [] } },
        { frameNodeId: 'frame:8', parentFrameId: 8, graph: { nodes: [{ id: 'frame:8' }], edges: [] } },
        { frameNodeId: 'frame:x', graph: { nodes: [], edges: [] } },
        { frameNodeId: 12, graph: { nodes: [], edges: [] } },
      ],
    },
  },
  {
    label: 'roots 来自 frame 节点出边 + 嵌套子帧',
    input: {
      graphs: [
        {
          frameId: 0,
          graph: {
            nodes: [{ id: 'frame:0', role: 'document' }],
            edges: [
              { type: 'frame', from: 'frame:0', to: '@x' },
              { type: 'frame', from: 'frame:0', to: '@y' },
              { type: 'frame', from: 'frame:0', to: 'frame:2' },
              { type: 'child', from: '@x', to: '@y' },
              { type: 'frame', from: '@x', to: 'frame:3' },
              { type: 'other', from: 'frame:0', to: '@z' },
            ],
          },
        },
      ],
    },
  },
  {
    label: 'limits：frames=1 / relations=1',
    input: {
      graphs: [
        { frameId: 0, graph: ROOT_GRAPH },
        { frameId: 5, parentFrameId: 0, graph: CHILD_GRAPH },
      ],
    },
    options: { limits: { frames: 1, relations: 1 } },
  },
  {
    label: '异常事实：非对象项 / 非对象图 / frameId 非法',
    input: {
      graphs: [
        null,
        'nope',
        { frameId: 'x', graph: { nodes: [], edges: [] } },
        { frameId: 1.5, graph: { nodes: [], edges: [] } },
        { frameId: 2, graph: 'not-a-graph' },
        { frameId: 3, graph: { nodes: 'nope', edges: 'nope', roots: 'nope' } },
        { frameId: 4, graph: { nodes: [null, {}, { id: null }], edges: [null, {}, { type: 'frame' }] } },
        { frameId: 4, graph: { nodes: [{ id: 'frame:4' }], edges: [] } },
        { frameId: 6, parentFrameId: 'x', graph: { nodes: [{ id: 'frame:6', parentId: 'frame:4' }], edges: [] } },
      ],
    },
  },
] as unknown as readonly { label: string; input: unknown; options?: unknown }[];

function optionsOf(item: { label: string; input: unknown; options?: unknown }): unknown {
  return item.options === undefined ? {} : item.options;
}

test('buildCrossFrameRelations：全部用例逐字段相等', () => {
  for (const item of CASES) {
    const inputValue = item.input === undefined ? {} : item.input;
    assert.deepEqual(
      clone(buildCrossFrameRelations(asInput(inputValue), asOptions(optionsOf(item)))),
      clone(js.buildCrossFrameRelations(inputValue, optionsOf(item))),
      item.label + ' 的跨 frame 关系图不一致',
    );
  }
});

test('collectFrameGraphs：三种输入形态归一结果逐字段相等', () => {
  for (const item of CASES) {
    const inputValue = item.input === undefined ? {} : item.input;
    assert.deepEqual(
      clone(collectFrameGraphs(asInput(inputValue))),
      clone(js.collectFrameGraphs(inputValue)),
      item.label + ' 的归一结果不一致',
    );
  }
  assert.deepEqual(clone(collectFrameGraphs(asInput([{ frameId: 0, graph: { nodes: [] } }]))), [
    { frameId: 0, url: null, parentFrameId: null, graph: { nodes: [] } },
  ]);
  assert.deepEqual(clone(collectFrameGraphs(asInput([{ frameId: 0, parentFrameId: 2.5, graph: {} }]))), [
    { frameId: 0, url: null, parentFrameId: null, graph: {} },
  ]);
});

test('frameNodeIdOf / summarizeCrossFrameRelations：矩阵逐项相等', () => {
  const IDS: readonly unknown[] = [0, 3, -2, 1.5, '5', 'x', null, undefined, NaN, 'frame:3'];
  for (const id of IDS) {
    assert.equal(frameNodeIdOf(id), js.frameNodeIdOf(id), 'frameNodeIdOf(' + String(id) + ') 不一致');
  }
  assert.equal(frameNodeIdOf(3), 'frame:3');
  for (const item of CASES) {
    const inputValue = item.input === undefined ? {} : item.input;
    const graph = buildCrossFrameRelations(asInput(inputValue), asOptions(optionsOf(item)));
    assert.equal(
      summarizeCrossFrameRelations(graph),
      js.summarizeCrossFrameRelations(js.buildCrossFrameRelations(inputValue, optionsOf(item))),
      item.label + ' 的单行摘要不一致',
    );
  }
  assert.equal(summarizeCrossFrameRelations(null), js.summarizeCrossFrameRelations(null));
  assert.equal(summarizeCrossFrameRelations({}), js.summarizeCrossFrameRelations({}));
});

test('输出不变量：无自环、端点存在、confidence/sources 合法、统计自洽', () => {
  for (const item of CASES) {
    const inputValue = item.input === undefined ? {} : item.input;
    const graph = buildCrossFrameRelations(asInput(inputValue), asOptions(optionsOf(item)));
    assert.equal(graph.version, VOM_FRAME_RELATIONS_VERSION, item.label + ' 版本不符');
    const frameIds = new Set(graph.frames.map((node) => node.id));
    const knownEndpoints = new Set([...frameIds, 'x', '@main', '@btn', '@c1', '@x', '@y', '@z']);
    for (const relation of graph.relations) {
      assert.notEqual(relation.from, relation.to, item.label + ' 出现自环');
      assert.ok(relation.confidence >= 0 && relation.confidence <= 1, item.label + ' confidence 越界');
      assert.ok(relation.sources.length >= 1, item.label + ' sources 为空');
      assert.equal(relation.frame, true, item.label + ' 跨 frame 关系必须标 frame');
      assert.ok(knownEndpoints.has(relation.from), item.label + ' 未知来源端点：' + relation.from);
      assert.ok(knownEndpoints.has(relation.to), item.label + ' 未知目标端点：' + relation.to);
    }
    assert.equal(graph.stats.frames, graph.frames.length, item.label + ' stats.frames 不符');
    assert.equal(graph.stats.relations, graph.relations.length, item.label + ' stats.relations 不符');
    assert.equal(
      Object.values(graph.stats.bySource).reduce((sum, count) => sum + count, 0),
      graph.relations.length,
      item.label + ' bySource 合计不符',
    );
    assert.equal(graph.stats.roots, graph.frames.reduce((sum, node) => sum + (Number(node.roots) || 0), 0), item.label + ' roots 合计不符');
    for (const node of graph.frames) {
      assert.ok(node.depth !== undefined && node.depth >= 0 && node.depth <= 8, item.label + ' frame 深度非法');
      assert.equal(node.role, node.frameId === 0 ? 'document' : 'frame', item.label + ' frame 角色不符');
    }
    assert.equal(graph.limits.frames <= 200, true);
    assert.equal(graph.limits.relations <= 5000, true);
  }
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  const input = CASES.find((item) => item.label === '{graphs} 包装：两帧 + 父帧归一')?.input;
  const graph = buildCrossFrameRelations(asInput(input));
  // frame:9 是子帧图里声明的孙帧（只有 frame 边引用，没有自己的子图）。
  assert.deepEqual(clone(graph.frames.map((node) => node.id)), ['frame:0', 'frame:5', 'frame:9']);
  const root = graph.frames[0];
  assert.equal(root?.role, 'document');
  assert.equal(root?.url, 'https://example.test/');
  assert.equal(root?.parentFrameId, null);
  assert.equal(root?.depth, 0);
  const child = graph.frames[1];
  assert.equal(child?.parentFrameId, 0);
  assert.equal(child?.depth, 1);
  assert.equal(child?.url, 'https://example.test/child');
  assert.equal(child?.available, true);
  assert.equal(child?.placeholder, false);
  const grandchild = graph.frames[2];
  assert.equal(grandchild?.parentFrameId, 5);
  assert.equal(grandchild?.depth, 2);
  assert.equal(grandchild?.available, false, '只有 frame 边引用、没有子图的 frame 是占位节点');
  const edge = graph.relations.find((relation) => relation.source === 'frame-edge');
  assert.equal(edge?.confidence, FRAME_RELATION_CONFIDENCE['frame-edge']);
  assert.equal(edge?.type, 'contains');
  const owner = graph.relations.find((relation) => relation.source === 'frame-owner');
  assert.equal(owner?.confidence, FRAME_RELATION_CONFIDENCE['frame-owner']);
  assert.equal(owner?.from, '@btn');
  assert.equal(owner?.to, 'frame:5');
  const parent = graph.relations.find((relation) => relation.source === 'parent-frame');
  assert.equal(parent?.confidence, FRAME_RELATION_CONFIDENCE['parent-frame']);
  assert.equal(parent?.from, 'frame:0');
  assert.equal(parent?.to, 'frame:5');
  assert.equal(graph.stats.crossFrame, graph.relations.length);
  assert.equal(graph.stats.linked, 2);
  assert.equal(graph.stats.orphan, 0);
  assert.deepEqual(clone(FRAME_RELATION_LIMITS), { frames: 16, relations: 400 });

  // 上限：frames=1 只保留第一帧的子图，但该子图里的 frame 边仍会注册子帧节点（frame:5）。
  const limited = buildCrossFrameRelations(asInput(input), { limits: { frames: 1, relations: 1 } });
  assert.equal(limited.frames.length, 2);
  assert.equal(limited.relations.length, 1);
  assert.equal(limited.stats.truncated, true);
  assert.deepEqual(clone(limited.limits), { frames: 1, relations: 1 });

  // -1 / 自身都归一为根帧；未知父帧 99 会补一个占位父节点并建立 parent-frame 边。
  const normalizing = buildCrossFrameRelations(asInput({
    graphs: [
      { frameId: 0, graph: { nodes: [], edges: [] } },
      { frameId: 3, parentFrameId: -1, graph: { nodes: [], edges: [] } },
      { frameId: 4, parentFrameId: 4, graph: { nodes: [], edges: [] } },
      { frameId: 5, parentFrameId: 99, graph: { nodes: [], edges: [] } },
    ],
  }));
  assert.deepEqual(clone(normalizing.frames.map((node) => node.id)), ['frame:0', 'frame:3', 'frame:4', 'frame:5', 'frame:99']);
  assert.deepEqual(clone(normalizing.frames.map((node) => node.parentFrameId)), [null, null, null, 99, null]);
  assert.deepEqual(clone(normalizing.frames.map((node) => node.depth)), [0, 0, 0, 1, 0]);
  assert.equal(normalizing.relations.filter((relation) => relation.source === 'parent-frame').length, 1);
  assert.equal(normalizing.relations[0]?.from, 'frame:99');
  assert.equal(normalizing.relations[0]?.to, 'frame:5');
  assert.equal(normalizing.stats.orphan, 3);
  assert.equal(normalizing.stats.linked, 1);

  // 空输入是合法的空图。
  assert.deepEqual(clone(buildCrossFrameRelations()), {
    version: 1,
    frames: [],
    nodes: [],
    relations: [],
    stats: { frames: 0, linked: 0, orphan: 0, relations: 0, crossFrame: 0, bySource: {}, roots: 0, truncated: false },
    limits: { frames: 16, relations: 400 },
  });
  assert.equal(summarizeCrossFrameRelations(buildCrossFrameRelations()), 'frames=0 linked=0 relations=0 cross-frame=0');
});
