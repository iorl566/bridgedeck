// packages/vom/test/query-diff.test.ts —— 关系图查询（过滤/分页/摘要）JS ↔ TS 差分测试。
//
// 覆盖边界：空/非数组图、kind/type/types 三种类型过滤写法、source/role/name 过滤、置信度
// 区间、from/to/direction、self、crossFrame（frame: / f<id>: / frame 标记）、五种排序、
// 分页与越界、非法/非对象 query，以及端点节点池补全角色与名字。
//
// 除逐字段 deepEqual 外，还断言分页与摘要自身的不变量（offset ≤ total、分桶合计 = total、
// kinds 按计数降序），避免“两边一起错”也能过。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUERY_DEFAULTS,
  VOM_QUERY_VERSION,
  normalizeRelationQuery,
  queryVomRelations,
  summarizeRelationQuery,
} from '../src/index.ts';
import type { VomRelationQueryGraph } from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-query.js');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function graph(value: unknown): VomRelationQueryGraph {
  return value as VomRelationQueryGraph;
}

function rel(
  type: unknown,
  from: unknown,
  to: unknown,
  confidence: unknown,
  source: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, from, to, confidence, source, ...extra };
}

const NODES: readonly Record<string, unknown>[] = [
  { id: '@a', role: 'button', name: '提交' },
  { id: '@b', role: 'textbox', name: '用户名' },
  { id: '@lbl', role: 'label', name: '用户名标签' },
  { id: '@tab', role: 'tab', name: '选项卡' },
  { id: '@panel', role: 'region', name: '面板' },
  { id: 'frame:2', role: 'document', name: '子帧' },
  { id: 'f3:@e7', role: 'button', name: '三级子帧按钮' },
];

const RELATIONS: readonly Record<string, unknown>[] = [
  rel('labels', '@lbl', '@a', 0.95, 'aria-labelledby', { fromRole: 'label', fromName: '提交按钮' }),
  rel('controls', '@tab', '@panel', 0.96, 'tab-controls', { depth: 1 }),
  rel('contains', '@panel', 'f3:@e7', 0.9, 'frame-edge', { frame: true }),
  rel('invalidates', '@b', '@b', 0.8, 'invalid-flag', { self: true }),
  rel('describes', '@lbl', '@b', 0.9, 'aria-describedby', { text: '用户名必填' }),
  rel('owns', 'frame:2', '@a', 0.8, 'composite-owner', { chain: ['frame:2', '@a'] }),
  rel('labels', '@lbl', '@b', 0.72, 'label-for', { toName: '输入框' }),
  rel('contains', '@a', '@b', 0.7, 'semantic-group'),
  rel('controls', '@tab', '@a', 0.85, 'aria-controls'),
];

const ARRAY_GRAPH: readonly Record<string, unknown>[] = RELATIONS;

const OBJECT_GRAPH: Record<string, unknown> = { relations: RELATIONS, nodes: NODES };

const CASES: readonly { label: string; graph: unknown; nodes?: unknown }[] = [
  { label: '关系数组', graph: ARRAY_GRAPH },
  { label: '{relations,nodes} 图', graph: OBJECT_GRAPH },
  { label: '只有 nodes 的图', graph: { nodes: NODES } },
  { label: '空数组', graph: [] },
  { label: '空对象', graph: {} },
  { label: '非对象图', graph: 'nope' },
  {
    label: '异常关系项',
    graph: [
      {},
      { type: '', from: '', to: '' },
      { type: 42, from: 7, to: null, confidence: 'x' },
      { type: 'labels', from: '@a', to: '@b', sources: ['a', 'b'] },
      { type: 'labels', from: '@a', to: '@c', source: 'html-for', sources: 'not-array' },
      { type: 'owns', from: '@a', to: '@d', confidence: 2, text: 5, depth: 'x', chain: 'nope' },
      { type: 'owns', from: '@a', to: '@e', self: 'true', frame: 1, text: '' },
      { type: 'labels', from: '@a', to: '@f', source: 42 },
    ],
  },
  {
    label: '节点池补全角色/名字',
    graph: ARRAY_GRAPH,
    nodes: NODES,
  },
  {
    label: '重复节点 id 的节点池',
    graph: ARRAY_GRAPH,
    nodes: [...NODES, { id: '@a', role: 'link', name: '重复节点' }],
  },
  {
    label: '关系项带 chain/depth/sources 数组',
    graph: [rel('labels', '@a', '@b', 0.9, 'aria-labelledby', {
      chain: ['@a', '@b'],
      depth: 2,
      sources: ['aria-labelledby', 'html-for'],
    })],
  },
  {
    label: '节点池为空 + 图自带的 nodes 被忽略（数组图）',
    graph: { relations: RELATIONS },
    nodes: [],
  },
];

/** query 参数矩阵（含非法值与别名写法）。 */
const QUERIES: readonly { label: string; query: unknown }[] = [
  { label: '默认 {}', query: {} },
  { label: 'kind 单值', query: { kind: 'labels' } },
  { label: 'kind 数组 + 大小写', query: { kind: ['LABELS', 'Controls'] } },
  { label: 'type 别名', query: { type: 'contains' } },
  { label: 'types + source', query: { types: 'labels', source: 'aria-labelledby' } },
  { label: 'sources 数组', query: { sources: ['aria-labelledby', 'label-for'] } },
  { label: 'role 过滤', query: { role: 'button' } },
  { label: 'roles 数组', query: { roles: ['textbox', 'region'] } },
  { label: 'name 过滤', query: { name: '提交' } },
  { label: 'names 数组', query: { names: ['用户名', '必填'] } },
  { label: 'confidence 区间', query: { minConfidence: 0.8, maxConfidence: 0.95 } },
  { label: 'confidence 越界归一', query: { minConfidence: -5, maxConfidence: 5 } },
  { label: 'from/to', query: { from: '@a', to: '@b' } },
  { label: 'direction out + from', query: { direction: 'out', from: '@a' } },
  { label: 'direction in', query: { direction: 'in', from: '@a' } },
  { label: 'self=true', query: { self: true } },
  { label: 'self=false', query: { self: false } },
  { label: 'crossFrame', query: { crossFrame: true } },
  { label: 'sort=confidence', query: { sort: 'confidence' } },
  { label: 'sort=type', query: { sort: 'type' } },
  { label: 'sort=name', query: { sort: 'name' } },
  { label: 'sort=source', query: { sort: 'source' } },
  { label: 'sort 非法值', query: { sort: 'bogus' } },
  { label: '分页 offset=2 limit=2', query: { offset: 2, limit: 2 } },
  { label: '分页越界 offset=9999 limit=1000', query: { offset: 9999, limit: 1000 } },
  { label: '分页非法值', query: { offset: -5, limit: 'abc' } },
  { label: 'direction 非法 + 未知键', query: { direction: 'x', unknownKey: 1 } },
  { label: '非对象 query', query: 'nope' },
  { label: 'null query', query: null },
  { label: '数组 query', query: [1, 2] },
];

test('normalizeRelationQuery：query 矩阵逐字段相等', () => {
  for (const { label, query } of QUERIES) {
    assert.deepEqual(
      clone(normalizeRelationQuery(query === null ? null : query)),
      clone(js.normalizeRelationQuery(query === null ? null : query)),
      label + ' 的归一化结果不一致',
    );
  }
  assert.deepEqual(clone(QUERY_DEFAULTS), clone(js.QUERY_DEFAULTS));
  const defaults = normalizeRelationQuery();
  assert.equal(defaults.limit, 25);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.sort, 'insertion');
  assert.equal(defaults.direction, 'both');
  assert.equal(defaults.self, null);
  assert.equal(defaults.crossFrame, false);
});

test('queryVomRelations：全部图 × query 矩阵逐字段相等', () => {
  for (const { label, graph: graphInput, nodes } of CASES) {
    for (const { label: queryLabel, query } of QUERIES) {
      assert.deepEqual(
        clone(queryVomRelations(graph(graphInput), query === null ? null : query, nodes)),
        clone(js.queryVomRelations(graphInput, query === null ? null : query, nodes)),
        label + ' / ' + queryLabel + ' 的查询结果不一致',
      );
    }
  }
});

test('queryVomRelations：图/节点池省略与 null 的默认行为一致', () => {
  for (const value of [undefined, null]) {
    assert.deepEqual(
      clone(queryVomRelations(graph(value))),
      clone(js.queryVomRelations(value)),
      'graph=' + String(value) + ' 的默认查询不一致',
    );
    assert.deepEqual(
      clone(queryVomRelations(graph(value), {}, null)),
      clone(js.queryVomRelations(value, {}, null)),
      'graph=' + String(value) + ' / nodes=null 的默认查询不一致',
    );
  }
  assert.equal(queryVomRelations(graph(ARRAY_GRAPH)).version, VOM_QUERY_VERSION);
});

test('分页不变量：offset ≤ total、items ≤ limit、nextOffset 衔接', () => {
  for (const { label, graph: graphInput, nodes } of CASES) {
    const base = queryVomRelations(graph(graphInput), {}, nodes);
    const total = base.page.total;
    const pages: readonly { offset: number; limit: number }[] = [
      { offset: 0, limit: 1 },
      { offset: 0, limit: 3 },
      { offset: 2, limit: 2 },
      { offset: Math.max(0, total - 1), limit: 5 },
      { offset: 9999, limit: 25 },
      { offset: -3, limit: 1000 },
    ];
    for (const { offset, limit } of pages) {
      const result = queryVomRelations(graph(graphInput), { offset, limit }, nodes);
      assert.equal(result.page.total, total, label + ' 分页改变了 total');
      assert.ok(result.page.offset <= total, label + ' offset 超过 total');
      assert.ok(result.items.length <= result.page.limit, label + ' 返回条数超过 limit');
      assert.equal(result.page.returned, result.items.length, label + ' returned 与 items 不符');
      assert.equal(result.page.hasMore, result.page.offset + result.items.length < total, label + ' hasMore 判定不符');
      if (result.page.hasMore) {
        assert.equal(result.page.nextOffset, result.page.offset + result.items.length, label + ' nextOffset 不衔接');
      } else {
        assert.equal(result.page.nextOffset, null, label + ' 无下一页时 nextOffset 必须为 null');
      }
    }
  }
});

test('排序不变量：confidence 降序 / type 升序 / name 排列稳定', () => {
  const conf = queryVomRelations(graph(ARRAY_GRAPH), { sort: 'confidence', limit: 200 });
  const values = conf.items.map((item) => item.confidence);
  assert.deepEqual(clone(values), clone(values.slice().sort((a, b) => b - a)), 'confidence 未降序');
  const typed = queryVomRelations(graph(ARRAY_GRAPH), { sort: 'type', limit: 200 });
  const types = typed.items.map((item) => item.type);
  assert.deepEqual(clone(types), clone(types.slice().sort((a, b) => a.localeCompare(b))), 'type 未升序');
  const insertion = queryVomRelations(graph(ARRAY_GRAPH), { limit: 200 });
  assert.deepEqual(
    clone(insertion.items.map((item) => item.from + '→' + item.to)),
    clone(RELATIONS.map((item) => String(item.from) + '→' + String(item.to))),
    'insertion 排序应保持关系插入顺序',
  );
  // 类型过滤与排序组合：只保留 labels，且仍有序。
  const labels = queryVomRelations(graph(ARRAY_GRAPH), { kind: 'labels', sort: 'source', limit: 200 });
  assert.ok(labels.items.every((item) => item.type === 'labels'));
});

test('摘要不变量：byType/byRole/分桶合计自洽、kinds 按计数降序', () => {
  for (const { label, graph: graphInput, nodes } of CASES) {
    for (const { label: queryLabel, query } of QUERIES) {
      const result = queryVomRelations(graph(graphInput), query === null ? null : query, nodes);
      const summary = result.summary;
      assert.equal(
        Object.values(summary.byType).reduce((sum, count) => sum + count, 0),
        summary.total,
        label + ' / ' + queryLabel + ' byType 合计与 total 不符',
      );
      const buckets = summary.confidenceBuckets;
      assert.equal(buckets.high + buckets.medium + buckets.low, summary.total, label + ' / ' + queryLabel + ' 分桶合计不符');
      assert.equal(summary.returned, result.page.returned, label + ' / ' + queryLabel + ' summary.returned 与 page 不符');
      for (const count of [...Object.values(summary.byType), ...Object.values(summary.byRole), ...Object.values(summary.bySource)]) {
        assert.ok(Number.isInteger(count) && count > 0, label + ' / ' + queryLabel + ' 直方图计数非法：' + count);
      }
      const kindsSorted = Object.entries(summary.byType).sort((a, b) => b[1] - a[1]).map(([type]) => type);
      assert.deepEqual(clone(summary.kinds), clone(kindsSorted), label + ' / ' + queryLabel + ' kinds 顺序不符');
      assert.ok(summary.averageConfidence >= 0 && summary.averageConfidence <= 1, label + ' / ' + queryLabel + ' 平均置信度越界');
    }
  }
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  // 默认查询：全部关系、25 条上限、insertion 顺序。
  const all = queryVomRelations(graph(ARRAY_GRAPH));
  assert.equal(all.summary.total, RELATIONS.length);
  assert.equal(all.page.limit, 25);
  assert.equal(all.page.offset, 0);
  assert.equal(all.page.hasMore, false);
  assert.equal(all.items[0]?.type, 'labels');

  // kind 过滤大小写不敏感。
  assert.equal(queryVomRelations(graph(ARRAY_GRAPH), { kind: 'LABELS' }).summary.total, 2);
  // 置信度分桶阈值：>=0.85 high，>=0.7 medium，其余 low。
  const buckets = queryVomRelations(graph(ARRAY_GRAPH)).summary.confidenceBuckets;
  assert.deepEqual(clone(buckets), { high: 5, medium: 4, low: 0 });
  // 自指关系过滤。
  const selfs = queryVomRelations(graph(ARRAY_GRAPH), { self: true });
  assert.equal(selfs.summary.total, 1);
  assert.equal(selfs.items[0]?.from, selfs.items[0]?.to);
  // crossFrame：frame: 节点、f<id>: 前缀、frame 标记都算跨帧。
  const cross = queryVomRelations(graph(ARRAY_GRAPH), { crossFrame: true });
  assert.equal(cross.summary.total, 2);
  assert.equal(cross.summary.crossFrame, 2);
  // 端点角色/名字来自关系记录；缺省时用节点池补。
  const fromFields = queryVomRelations(graph(ARRAY_GRAPH)).items.find((item) => item.type === 'labels');
  assert.equal(fromFields?.fromRole, 'label');
  assert.equal(fromFields?.fromName, '提交按钮');
  const fromPool = queryVomRelations(graph(ARRAY_GRAPH), {}, NODES).items.find((item) => item.type === 'describes');
  assert.equal(fromPool?.toRole, 'textbox');
  assert.equal(fromPool?.toName, '用户名');
  // text 参与 name 过滤的 haystack。
  assert.equal(queryVomRelations(graph(ARRAY_GRAPH), { name: '必填' }).summary.total, 1);
  // 空图结果形状。
  assert.deepEqual(clone(queryVomRelations(graph([]))), {
    version: 1,
    query: {
      types: [],
      sources: [],
      roles: [],
      names: [],
      minConfidence: null,
      maxConfidence: null,
      from: null,
      to: null,
      direction: 'both',
      self: null,
      crossFrame: false,
      sort: 'insertion',
      offset: 0,
      limit: 25,
    },
    items: [],
    page: { offset: 0, limit: 25, total: 0, returned: 0, hasMore: false, nextOffset: null },
    summary: {
      total: 0,
      returned: 0,
      byType: {},
      bySource: {},
      byRole: {},
      confidenceBuckets: { high: 0, medium: 0, low: 0 },
      averageConfidence: 0,
      self: 0,
      crossFrame: 0,
      kinds: [],
    },
  });
});

test('summarizeRelationQuery：结果/异常输入逐字符相等', () => {
  const result = queryVomRelations(graph(ARRAY_GRAPH), { limit: 2 });
  const inputs: readonly unknown[] = [
    result,
    null,
    undefined,
    {},
    { page: null, summary: null },
    { page: result.page, summary: result.summary },
    { page: { ...result.page, hasMore: true, nextOffset: 2 }, summary: result.summary },
    'nope',
  ];
  for (const item of inputs) {
    assert.equal(
      summarizeRelationQuery(item as never),
      js.summarizeRelationQuery(item),
      'summary 输入 ' + JSON.stringify(item) + ' 不一致',
    );
  }
  assert.match(summarizeRelationQuery(result), /^relations 1-2\/9 limit=2 avg-confidence=/);
  assert.match(summarizeRelationQuery(result), /types\[/);
});

test('null 关系项：JS 与 TS 都按同一契约抛错（不静默跳过）', () => {
  const nullGraph: readonly unknown[] = [null];
  assert.throws(() => js.queryVomRelations(nullGraph));
  assert.throws(() => queryVomRelations(nullGraph as unknown as VomRelationQueryGraph));
});
