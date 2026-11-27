// 关系查询：kind/role/name/source/confidence 过滤 + 分页 + 摘要 + 排序。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERY_DEFAULTS,
  VOM_QUERY_VERSION,
  normalizeRelationQuery,
  queryVomRelations,
  summarizeRelationQuery,
} from '../../extension/src/lib/vom-query.js';

function fixtureRelations() {
  return [
    { type: 'labels', from: '@lbl', to: '@btn', confidence: 0.95, source: 'aria-labelledby', sources: ['aria-labelledby'] },
    { type: 'labels', from: '@lbl2', to: '@btn2', confidence: 0.9, source: 'label-for', sources: ['label-for'] },
    { type: 'controls', from: '@btn', to: '@panel', confidence: 0.95, source: 'aria-controls', sources: ['aria-controls'] },
    {
      type: 'invalidates',
      from: '@err',
      to: '@input',
      confidence: 0.95,
      source: 'aria-errormessage',
      sources: ['aria-errormessage'],
      text: '必填',
    },
    { type: 'describes', from: '@btn', to: '@btn', confidence: 0.6, source: 'title-attribute', sources: ['title-attribute'], self: true, text: '保存当前草稿' },
    { type: 'contains', from: 'frame:0', to: 'f1:@e1', confidence: 0.95, source: 'frame-edge', sources: ['frame-edge'], frame: true },
  ];
}

function fixtureNodes() {
  return [
    { id: '@lbl', role: 'span', name: '提交按钮' },
    { id: '@btn', role: 'button', name: '提交' },
    { id: '@lbl2', role: 'label', name: '邮箱' },
    { id: '@btn2', role: 'textbox', name: '邮箱' },
    { id: '@panel', role: 'menu', name: '选项面板' },
    { id: '@err', role: 'alert', name: '请输入有效邮箱' },
    { id: '@input', role: 'textbox', name: '邮箱' },
  ];
}

const graph = { relations: fixtureRelations(), nodes: fixtureNodes() };

test('查询契约：默认分页/上限常量与 normalize 容错', () => {
  assert.equal(VOM_QUERY_VERSION, 1);
  assert.equal(QUERY_DEFAULTS.limit, 25);
  assert.equal(QUERY_DEFAULTS.maxLimit, 200);
  const normalized = normalizeRelationQuery({ kind: 'LABELS', role: ['Button'], name: '提交', limit: 0, offset: -5, sort: 'bogus' });
  assert.deepEqual(normalized.types, ['labels']);
  assert.deepEqual(normalized.roles, ['button']);
  assert.deepEqual(normalized.names, ['提交']);
  assert.equal(normalized.limit, 1, 'limit 0 应夹到 1');
  assert.equal(normalized.offset, 0);
  assert.equal(normalized.sort, 'insertion');
  const clamped = normalizeRelationQuery({ limit: 9999, offset: 999999 });
  assert.equal(clamped.limit, QUERY_DEFAULTS.maxLimit);
  assert.equal(clamped.offset, QUERY_DEFAULTS.maxOffset);
  const invalid = normalizeRelationQuery(null);
  assert.deepEqual(invalid.types, []);
  assert.equal(invalid.limit, 25);
});

test('默认查询：分页字段与摘要', () => {
  const result = queryVomRelations(graph, { limit: 2 });
  assert.equal(result.version, 1);
  assert.equal(result.page.total, 6);
  assert.equal(result.page.returned, 2);
  assert.equal(result.page.offset, 0);
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextOffset, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].type, 'labels');
  assert.equal(result.summary.total, 6);
  assert.equal(result.summary.returned, 2);
  assert.equal(result.summary.byType.labels, 2);
  assert.equal(result.summary.bySource['aria-labelledby'], 1);
  assert.equal(result.summary.byRole.button, 4, 'labels(to) + controls(from) + describes 自描述两端');
  assert.equal(result.summary.self, 1);
  assert.equal(result.summary.crossFrame, 1);
  assert.equal(result.summary.confidenceBuckets.high, 5);
  assert.equal(result.summary.confidenceBuckets.low, 1);
  assert.ok(result.summary.averageConfidence > 0.8);
  assert.deepEqual(result.summary.kinds, ['labels', 'controls', 'invalidates', 'describes', 'contains']);
});

test('按 kind/type 过滤', () => {
  const labels = queryVomRelations(graph, { kind: 'labels' }, fixtureNodes());
  assert.equal(labels.page.total, 2);
  assert.ok(labels.items.every((item) => item.type === 'labels'));
  const multi = queryVomRelations(graph, { types: ['invalidates', 'contains'] });
  assert.equal(multi.page.total, 2);
  assert.deepEqual(multi.summary.byType, { invalidates: 1, contains: 1 });
});

test('按端点 role 过滤（大小写不敏感）', () => {
  const buttons = queryVomRelations(graph, { role: 'BUTTON' });
  assert.equal(buttons.page.total, 3);
  assert.ok(buttons.items.every((item) => item.fromRole === 'button' || item.toRole === 'button'));
  assert.equal(buttons.items.find((item) => item.type === 'controls').fromRole, 'button');
  const textboxes = queryVomRelations(graph, { roles: ['textbox'] });
  assert.equal(textboxes.page.total, 2);
});

test('按 name 过滤（含关系 text 证据）', () => {
  const byName = queryVomRelations(graph, { name: '邮箱' });
  assert.equal(byName.page.total, 2);
  assert.ok(byName.items.every((item) => /邮箱/.test(String(item.fromName) + String(item.toName) + String(item.text))));
  const byText = queryVomRelations(graph, { name: '必填' });
  assert.equal(byText.page.total, 1);
  assert.equal(byText.items[0].type, 'invalidates');
  // 角色名（label/alert）不会污染 name 过滤。
  assert.equal(queryVomRelations(graph, { name: '提交按钮' }).page.total, 1);
});

test('按 source/confidence/from/to/direction/self 过滤', () => {
  assert.equal(queryVomRelations(graph, { source: 'aria-controls' }).page.total, 1);
  assert.equal(queryVomRelations(graph, { minConfidence: 0.9 }).page.total, 5);
  assert.equal(queryVomRelations(graph, { maxConfidence: 0.7 }).page.total, 1);
  assert.equal(queryVomRelations(graph, { from: '@btn' }).page.total, 2);
  assert.equal(queryVomRelations(graph, { to: '@btn' }).page.total, 2);
  assert.equal(queryVomRelations(graph, { self: true }).page.total, 1);
  assert.equal(queryVomRelations(graph, { self: false }).page.total, 5);
  assert.equal(queryVomRelations(graph, { from: '@lbl', direction: 'out' }).page.total, 1);
});

test('跨 frame 过滤：frame 节点参与的边', () => {
  const cross = queryVomRelations(graph, { crossFrame: true });
  assert.equal(cross.page.total, 1);
  assert.equal(cross.items[0].type, 'contains');
  assert.equal(cross.items[0].frame, true);
  assert.equal(cross.summary.crossFrame, 1);
});

test('分页：offset/limit/hasMore/nextOffset 边界', () => {
  const page2 = queryVomRelations(graph, { offset: 4, limit: 2 });
  assert.equal(page2.page.offset, 4);
  assert.equal(page2.page.returned, 2);
  assert.equal(page2.page.hasMore, false);
  assert.equal(page2.page.nextOffset, null);
  const past = queryVomRelations(graph, { offset: 999 });
  assert.equal(past.page.offset, 6);
  assert.equal(past.page.returned, 0);
  assert.equal(past.page.hasMore, false);
  const first = queryVomRelations(graph, { limit: 200 });
  assert.equal(first.page.returned, 6);
});

test('排序：confidence / type / name / source', () => {
  const byConfidence = queryVomRelations(graph, { sort: 'confidence' });
  assert.equal(byConfidence.items[byConfidence.items.length - 1].confidence, 0.6);
  const byType = queryVomRelations(graph, { sort: 'type' });
  assert.deepEqual(byType.items.map((item) => item.type), ['contains', 'controls', 'describes', 'invalidates', 'labels', 'labels']);
  const byName = queryVomRelations(graph, { sort: 'name' });
  assert.ok(byName.items.length === 6);
  const bySource = queryVomRelations(graph, { sort: 'source' });
  assert.equal(bySource.items[0].source, 'aria-controls');
});

test('输入容错：关系数组/空输入/无节点池时用关系自身角色', () => {
  const arrayInput = queryVomRelations(fixtureRelations(), { kind: 'labels' });
  assert.equal(arrayInput.page.total, 2);
  assert.equal(arrayInput.items[0].fromRole, null, '没有节点池时端点角色应为 null');
  const withRoles = queryVomRelations([
    { type: 'labels', from: 'x', to: 'y', confidence: 0.9, source: 'aria-labelledby', fromRole: 'span', toRole: 'button' },
  ], { role: 'button' });
  assert.equal(withRoles.page.total, 1);
  assert.equal(withRoles.items[0].toRole, 'button');
  assert.equal(queryVomRelations(null, {}).page.total, 0);
  assert.deepEqual(queryVomRelations(null, {}).items, []);
  assert.deepEqual(queryVomRelations({ relations: [] }, {}).summary.kinds, []);
});

test('summarizeRelationQuery：分页/置信度/类型摘要', () => {
  const result = queryVomRelations(graph, { kind: 'labels', limit: 1 });
  const text = summarizeRelationQuery(result);
  assert.match(text, /relations 1-1\/2/);
  assert.match(text, /limit=1/);
  assert.match(text, /avg-confidence=0\.925/);
  assert.match(text, /types\[labels=2\]/);
  assert.match(text, /next=1/);
  assert.equal(summarizeRelationQuery(null), 'query: n/a');
});
