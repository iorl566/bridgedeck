// tests/unit/mcp-cursor.test.mjs —— MCP 列表游标分页原语的测试。
//
// 覆盖：limit 归一化边界、游标编码/解码往返与不透明性、标签/版本/偏移非法拒绝、
// paginateList 的分页语义（首/中/尾/越界/空集合）、filterRows（query/kind/mimeType/
// 自定义字段）、countBy 计数顺序、listResponse 的 nextCursor 与 _meta、cursorSnapshot。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_LIMITS,
  CURSOR_VERSION,
  CursorError,
  assertCursorLabel,
  countBy,
  cursorSnapshot,
  decodeCursor,
  encodeCursor,
  filterRows,
  listResponse,
  matchQuery,
  normalizeLimit,
  paginateList,
} from '../../mcp/cursor.mjs';

test('normalizeLimit：默认/数字字符串/边界', () => {
  assert.equal(normalizeLimit(undefined), CURSOR_LIMITS.defaultLimit);
  assert.equal(normalizeLimit(null), CURSOR_LIMITS.defaultLimit);
  assert.equal(normalizeLimit(''), CURSOR_LIMITS.defaultLimit);
  assert.equal(normalizeLimit(7), 7);
  assert.equal(normalizeLimit('12'), 12);
  assert.equal(normalizeLimit(CURSOR_LIMITS.maxLimit), CURSOR_LIMITS.maxLimit);
  for (const bad of [0, -1, 1.5, 'abc', CURSOR_LIMITS.maxLimit + 1, true]) {
    assert.throws(() => normalizeLimit(bad), (error) => error instanceof CursorError && error.code === 'E_BAD_ARG', String(bad));
  }
  const custom = normalizeLimit(null, { defaultLimit: 5, maxLimit: 9 });
  assert.equal(custom, 5);
});

test('游标编码：不透明、可往返、偏移用 36 进制', () => {
  const cursor = encodeCursor(120, { label: 'resources' });
  assert.match(cursor, new RegExp('^' + CURSOR_VERSION + '\\.resources\\.'));
  assert.doesNotMatch(cursor, /120/);
  const decoded = decodeCursor(cursor, { label: 'resources' });
  assert.equal(decoded.offset, 120);
  assert.equal(decoded.label, 'resources');
  assert.equal(encodeCursor(0, { label: 'prompts' }), CURSOR_VERSION + '.prompts.0');
});

test('游标解码：格式/版本/标签/偏移非法一律 E_BAD_ARG', () => {
  const cases = [
    ['', /非空字符串/],
    [123, /非空字符串/],
    ['nope', /格式非法/],
    ['v0.resources.5', /版本不匹配/],
    [CURSOR_VERSION + '.prompts.5', /不能用于/],
    [CURSOR_VERSION + '.resources.zz-z', /偏移非法/],
    [CURSOR_VERSION + '.resources.' + '9'.repeat(300), /偏移非法/],
    [CURSOR_VERSION + '.bad-label.1', /不能用于|标签非法/],
  ];
  for (const [cursor, pattern] of cases) {
    assert.throws(
      () => decodeCursor(cursor, { label: 'resources' }),
      (error) => error instanceof CursorError && error.code === 'E_BAD_ARG' && pattern.test(error.message),
      JSON.stringify(cursor).slice(0, 40),
    );
  }
  assert.throws(() => decodeCursor('x'.repeat(CURSOR_LIMITS.maxCursorLength + 1), { label: 'resources' }), /超长/);
  assert.throws(() => assertCursorLabel('Bad_Label'), CursorError);
  assert.throws(() => encodeCursor(-1, { label: 'resources' }), CursorError);
});

test('paginateList：首/中/尾页与 nextCursor', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: index }));
  const first = paginateList(items, { limit: 4, label: 'resources' });
  assert.deepEqual(first.page.map((row) => row.id), [0, 1, 2, 3]);
  assert.equal(first.total, 10);
  assert.equal(first.returned, 4);
  assert.equal(first.offset, 0);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.equal(decodeCursor(first.nextCursor, { label: 'resources' }).offset, 4);

  const middle = paginateList(items, { limit: 4, cursor: first.nextCursor, label: 'resources' });
  assert.deepEqual(middle.page.map((row) => row.id), [4, 5, 6, 7]);
  assert.equal(middle.offset, 4);
  assert.equal(middle.hasMore, true);

  const tail = paginateList(items, { limit: 4, cursor: middle.nextCursor, label: 'resources' });
  assert.deepEqual(tail.page.map((row) => row.id), [8, 9]);
  assert.equal(tail.returned, 2);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.nextCursor, null);
  assert.equal(tail.cursor, middle.nextCursor);
  assert.equal(Object.isFrozen(tail.page), true);
  assert.equal(Object.isFrozen(tail), true);
});

test('paginateList：默认一页上限 50；越界游标给空页不报错；空集合', () => {
  const many = Array.from({ length: CURSOR_LIMITS.defaultLimit + 5 }, (_, index) => index);
  const defaulted = paginateList(many, { label: 'resources' });
  assert.equal(defaulted.returned, CURSOR_LIMITS.defaultLimit);
  assert.equal(defaulted.hasMore, true);

  const beyond = paginateList([1, 2, 3], { cursor: encodeCursor(99, { label: 'resources' }), label: 'resources' });
  assert.deepEqual(beyond.page, []);
  assert.equal(beyond.hasMore, false);
  assert.equal(beyond.nextCursor, null);
  assert.equal(beyond.offset, 99);

  const empty = paginateList([], { label: 'resources' });
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
  assert.throws(() => paginateList(null, { label: 'resources' }), /需要数组/);
});

test('matchQuery / filterRows：大小写不敏感子串 + kind/mimeType 精确匹配', () => {
  const rows = [
    { uri: 'bridge://observation/latest', name: 'latest-observation', title: '最近观察', description: '页面快照', kind: 'observation', mimeType: 'application/json' },
    { uri: 'bridge://skill/SKILL.md', name: 'skill', title: '技能', description: 'Markdown 文档', kind: 'skill-main', mimeType: 'text/markdown' },
    { uri: 'bridge://protocol/summary', name: 'protocol', title: '协议', description: '方法目录', kind: 'protocol-summary', mimeType: 'application/json' },
  ];
  assert.equal(matchQuery(rows[0], ''), true);
  assert.equal(matchQuery(rows[0], 'OBSERVATION'), true);
  assert.equal(matchQuery(rows[0], '页面快照'), true);
  assert.equal(matchQuery(rows[0], 'missing-needle'), false);

  assert.equal(filterRows(rows, { query: 'skill' }).length, 1);
  assert.equal(filterRows(rows, { kind: 'observation' }).length, 1);
  assert.equal(filterRows(rows, { mimeType: 'APPLICATION/JSON' }).length, 2);
  assert.equal(filterRows(rows, { query: '协议', kind: 'protocol-summary' }).length, 1);
  assert.equal(filterRows(rows, { query: '协议', kind: 'observation' }).length, 0);
  assert.equal(filterRows(rows, { fields: ['uri'], query: 'bridge://skill' }).length, 1);
  assert.equal(filterRows(rows, { fields: ['uri'], query: '最近观察' }).length, 0);
  assert.throws(() => filterRows(null, {}), CursorError);
});

test('countBy：保持首次出现顺序且不把 undefined 变字符串', () => {
  const counts = countBy([{ k: 'a' }, { k: 'b' }, { k: 'a' }], (row) => row.k);
  assert.deepEqual(Object.keys(counts), ['a', 'b']);
  assert.equal(counts.a, 2);
  assert.equal(counts.b, 1);
  const empty = countBy([], (row) => row.k);
  assert.deepEqual(empty, {});
});

test('listResponse：nextCursor 只在有下一页时出现，分页信息进 _meta', () => {
  const base = { resources: [{ uri: 'a' }, { uri: 'b' }] };
  const paged = paginateList([1, 2, 3, 4], { limit: 2, label: 'resources' });
  const withNext = listResponse(base, paged);
  assert.equal(withNext.resources.length, 2);
  assert.equal(typeof withNext.nextCursor, 'string');
  assert.equal(withNext._meta['browser-bridge/pagination'].total, 4);
  assert.equal(withNext._meta['browser-bridge/pagination'].hasMore, true);
  assert.equal(withNext._meta['browser-bridge/pagination'].cursorParam, 'cursor');

  const tail = paginateList([1, 2], { limit: 2, label: 'resources' });
  const withoutNext = listResponse({ prompts: [] }, tail, { metaKey: 'browser-bridge/prompts' });
  assert.equal('nextCursor' in withoutNext, false);
  assert.equal(withoutNext._meta['browser-bridge/prompts'].pagination.hasMore, false);
});

test('cursorSnapshot：方法清单/上限/不透明声明', () => {
  const snapshot = cursorSnapshot();
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.version, CURSOR_VERSION);
  assert.equal(snapshot.cursorParam, 'cursor');
  assert.equal(snapshot.opaque, true);
  assert.equal(snapshot.labelScoped, true);
  assert.deepEqual([...snapshot.methods], ['resources/list', 'resources/templates/list', 'prompts/list']);
  assert.equal(snapshot.maxLimit, CURSOR_LIMITS.maxLimit);
});
