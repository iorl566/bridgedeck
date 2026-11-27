// tests/unit/mcp-resource-index.test.mjs —— resources 索引层（种类/排序/过滤/分页/摘要）测试。
//
// 覆盖：URI→kind 派生（含未知形状）、key 派生、动态/静态判定、行装饰、索引去重、
// sort 白名单与四种排序、queryResources 的默认路径（保持历史输出）与过滤/分页路径、
// summarizeResources 的分布统计、resourceIndexSnapshot。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DYNAMIC_KINDS,
  INDEX_KINDS,
  KIND_PRIORITY,
  SORT_MODES,
  STATIC_KINDS,
  buildResourceIndex,
  decorateResourceRow,
  isDynamicResource,
  normalizeSort,
  queryResources,
  resourceIndexSnapshot,
  resourceKeyOf,
  resourceKindOf,
  resourcePriorityOf,
  sortResourceRows,
  summarizeResources,
} from '../../mcp/resource-index.mjs';
import { decodeCursor } from '../../mcp/cursor.mjs';
import { createResourceRegistry } from '../../mcp/resources.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-res-index-'));
}

const ROWS = [
  { uri: 'bridge://skill/SKILL.md', name: 'SKILL', title: '技能主文档', mimeType: 'text/markdown', annotations: { priority: 0.8 } },
  { uri: 'bridge://protocol/summary', name: 'protocol-summary', title: '协议摘要', mimeType: 'application/json', annotations: { priority: 0.6 } },
  { uri: 'bridge://observation/latest', name: 'latest-observation', title: '最近观察', mimeType: 'application/json', annotations: { priority: 0.9 } },
  { uri: 'bridge://debug/journal/s1', name: 'journal-s1', title: '会话 s1 时间线', mimeType: 'application/json', annotations: { priority: 0.7 } },
];

test('resourceKindOf：每种 URI 形状派生稳定 kind', () => {
  const cases = {
    'bridge://skill/SKILL.md': INDEX_KINDS.SKILL_MAIN,
    'bridge://skill/references/environment.md': INDEX_KINDS.SKILL_REFERENCE,
    'bridge://update/state': INDEX_KINDS.UPDATE_STATE,
    'bridge://protocol/summary': INDEX_KINDS.PROTOCOL_SUMMARY,
    'bridge://observation/latest': INDEX_KINDS.OBSERVATION,
    'bridge://observation/s1?limit=10': INDEX_KINDS.OBSERVATION,
    'bridge://debug/evidence/s1': INDEX_KINDS.EVIDENCE,
    'bridge://debug/journal/latest': INDEX_KINDS.JOURNAL,
    'bridge://nope': INDEX_KINDS.UNKNOWN,
    'https://example.test/': INDEX_KINDS.UNKNOWN,
    '': INDEX_KINDS.UNKNOWN,
    'bridge://skill/references/nested/deep.md': INDEX_KINDS.UNKNOWN,
    'bridge://debug/other/x': INDEX_KINDS.UNKNOWN,
  };
  for (const [uri, kind] of Object.entries(cases)) {
    assert.equal(resourceKindOf(uri), kind, uri);
  }
  assert.equal(DYNAMIC_KINDS.includes(INDEX_KINDS.OBSERVATION), true);
  assert.equal(STATIC_KINDS.includes(INDEX_KINDS.SKILL_MAIN), true);
  assert.equal(DYNAMIC_KINDS.includes(INDEX_KINDS.SKILL_MAIN), false);
});

test('resourceKeyOf / isDynamicResource / resourcePriorityOf', () => {
  assert.equal(resourceKeyOf('bridge://observation/s1?limit=5'), 's1');
  assert.equal(resourceKeyOf('bridge://observation/latest'), 'latest');
  assert.equal(resourceKeyOf('bridge://'), null);
  assert.equal(isDynamicResource('bridge://debug/journal/latest'), true);
  assert.equal(isDynamicResource('bridge://skill/SKILL.md'), false);

  assert.equal(resourcePriorityOf({ uri: 'bridge://observation/latest', annotations: { priority: 0.42 } }), 0.42);
  assert.equal(resourcePriorityOf({ uri: 'bridge://observation/latest' }), KIND_PRIORITY[INDEX_KINDS.OBSERVATION]);
  assert.equal(resourcePriorityOf({ uri: 'bridge://unknown/x' }), KIND_PRIORITY[INDEX_KINDS.UNKNOWN]);
  assert.equal(resourcePriorityOf(null) >= 0, true);
});

test('decorateResourceRow / buildResourceIndex：新增 kind/dynamic 字段且发现重复 URI', () => {
  const decorated = decorateResourceRow(ROWS[2]);
  assert.equal(decorated.kind, INDEX_KINDS.OBSERVATION);
  assert.equal(decorated.dynamic, true);
  assert.equal(decorated.uri, ROWS[2].uri);
  assert.equal(Object.isFrozen(decorated), true);
  assert.equal(decorateResourceRow(null), null);

  const index = buildResourceIndex(ROWS);
  assert.equal(index.total, 4);
  assert.equal(index.byUri.size, 4);
  assert.deepEqual(index.unknown, []);
  assert.deepEqual(index.duplicates, []);

  const withDuplicate = buildResourceIndex([...ROWS, ROWS[0], { uri: 'bridge://mystery/x' }]);
  assert.deepEqual(withDuplicate.duplicates, [ROWS[0].uri]);
  assert.deepEqual(withDuplicate.unknown, ['bridge://mystery/x']);
});

test('normalizeSort：白名单校验，默认 catalog', () => {
  assert.equal(normalizeSort(undefined), 'catalog');
  assert.equal(normalizeSort(''), 'catalog');
  for (const mode of SORT_MODES) assert.equal(normalizeSort(mode), mode);
  assert.throws(() => normalizeSort('nope'), (error) => error.code === 'E_BAD_ARG');
});

test('sortResourceRows：catalog 保序 / kind / uri / priority', () => {
  assert.deepEqual(sortResourceRows(ROWS, 'catalog').map((row) => row.uri), ROWS.map((row) => row.uri));
  const byUri = sortResourceRows(ROWS, 'uri');
  assert.deepEqual(byUri.map((row) => row.uri), [...byUri.map((row) => row.uri)].sort());
  const byKind = sortResourceRows(ROWS, 'kind');
  assert.equal(byKind[0].uri, 'bridge://debug/journal/s1');
  const byPriority = sortResourceRows(ROWS, 'priority');
  assert.equal(byPriority[0].uri, 'bridge://observation/latest');
  assert.equal(byPriority.at(-1).uri, 'bridge://protocol/summary');
});

test('queryResources 默认路径：无参数时原样返回（保持历史输出）', () => {
  const result = queryResources(ROWS);
  assert.deepEqual(result.page, ROWS);
  assert.equal(result.paged.total, 4);
  assert.equal(result.paged.returned, 4);
  assert.equal(result.paged.hasMore, false);
  assert.equal(result.paged.nextCursor, null);
  assert.equal(result.paged.defaulted, true);
  assert.equal(result.filtered, 4);
  assert.equal(result.sort, 'catalog');
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.dynamic, 2);
  assert.equal(result.summary.static, 2);
});

test('queryResources：过滤 + 分页 + 排序组合', () => {
  const pageOne = queryResources(ROWS, { limit: 2 });
  assert.equal(pageOne.page.length, 2);
  assert.equal(pageOne.paged.hasMore, true);
  assert.ok(pageOne.paged.nextCursor);
  assert.equal(decodeCursor(pageOne.paged.nextCursor, { label: 'resources' }).offset, 2);

  const pageTwo = queryResources(ROWS, { limit: 2, cursor: pageOne.paged.nextCursor });
  assert.equal(pageTwo.page.length, 2);
  assert.equal(pageTwo.paged.hasMore, false);

  const dynamicOnly = queryResources(ROWS, { kind: INDEX_KINDS.OBSERVATION });
  assert.equal(dynamicOnly.filtered, 1);
  assert.equal(dynamicOnly.page[0].uri, 'bridge://observation/latest');

  const markdown = queryResources(ROWS, { mimeType: 'text/markdown' });
  assert.equal(markdown.filtered, 1);
  assert.equal(markdown.page[0].uri, 'bridge://skill/SKILL.md');

  const searched = queryResources(ROWS, { query: '会话' });
  assert.equal(searched.filtered, 1);

  const sorted = queryResources(ROWS, { sort: 'priority', limit: 1 });
  assert.equal(sorted.page[0].uri, 'bridge://observation/latest');

  const empty = queryResources(ROWS, { query: 'no-such-row-anywhere' });
  assert.equal(empty.page.length, 0);
  assert.equal(empty.paged.total, 0);
});

test('queryResources：越界游标给空页；非法游标错误向上抛', () => {
  const page = queryResources(ROWS, { limit: 2 });
  const beyond = queryResources(ROWS, { limit: 2, cursor: page.paged.nextCursor, query: 'nothing' });
  assert.deepEqual(beyond.page, []);
  assert.equal(beyond.paged.hasMore, false);
  assert.throws(() => queryResources(ROWS, { cursor: 'garbage', label: 'resources' }), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => queryResources(ROWS, { limit: 0 }), (error) => error.code === 'E_BAD_ARG');
});

test('summary 统计：byKind/byMime/duplicates 与真实注册表对账', () => {
  const summary = summarizeResources(ROWS);
  assert.equal(summary.byKind[INDEX_KINDS.SKILL_MAIN], 1);
  assert.equal(summary.byKind[INDEX_KINDS.OBSERVATION], 1);
  assert.equal(summary.byMime['application/json'], 3);
  assert.equal(summary.byMime['text/markdown'], 1);
  assert.deepEqual(summary.duplicates, []);
  assert.equal(summarizeResources(undefined).total, 0);

  const registry = createResourceRegistry({ home: tempHome(), persist: false });
  registry.recordObservation('s1', { observation: '@e1', url: 'https://x.test/' });
  const liveSummary = summarizeResources(registry.list());
  assert.equal(liveSummary.total, registry.list().length);
  assert.equal(liveSummary.byKind[INDEX_KINDS.OBSERVATION] >= 2, true);
  assert.deepEqual(liveSummary.unknown, []);
});

test('resourceIndexSnapshot：声明 kinds/dynamic/static/sort/默认排序', () => {
  const snapshot = resourceIndexSnapshot({ templates: 4 });
  assert.equal(snapshot.templates, 4);
  assert.equal(snapshot.defaultSort, 'catalog');
  assert.equal(snapshot.uriScheme, 'bridge://');
  assert.deepEqual([...snapshot.sortModes], [...SORT_MODES]);
  assert.deepEqual([...snapshot.dynamicKinds], [...DYNAMIC_KINDS]);
  assert.deepEqual([...snapshot.staticKinds], [...STATIC_KINDS]);
});
