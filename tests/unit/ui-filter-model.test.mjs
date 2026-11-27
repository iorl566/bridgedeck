// tests/unit/ui-filter-model.test.mjs —— 过滤模型（extension/ui/lib/filter-model.js）单测。
//
// 覆盖：查询串切词/语法、字段目录、比较操作符、裸词、chips（删除后查询串）、
// 字段/值补全、分面计数、常用过滤、URL 编解码与错误（未知字段/非法数值）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILTER_FIELDS,
  FILTER_OPERATORS,
  SAVED_FILTERS,
  activeChips,
  appendRawToken,
  compileFilter,
  decodeFilterQuery,
  encodeFilterQuery,
  facetCounts,
  fieldsForSurface,
  filterRows,
  filterSummary,
  isFilteredEmpty,
  matchToken,
  normalizeFilterQuery,
  operatorLabel,
  parseFilterQuery,
  removeRawToken,
  savedFiltersFor,
  suggestFields,
  suggestValues,
  textOfRow,
  tokenizeQuery,
} from '../../extension/ui/lib/filter-model.js';

const DEBUG_FIELDS = fieldsForSurface('debug');
const ROWS = [
  { method: 'GET', status: 200, url: 'https://api.example/a', durationMs: 20, level: 'log', text: 'ok' },
  { method: 'POST', status: 500, url: 'https://api.example/b', durationMs: 1300, level: 'error', text: 'boom' },
  { method: 'GET', status: 404, url: 'https://cdn.example/c.js', durationMs: 800, level: 'warn', text: 'missing' },
  { method: 'DELETE', status: 204, url: 'https://api.example/d', durationMs: 5, level: 'log', text: 'gone' },
];

test('字段目录：按表面返回，未知表面回退 workspace', () => {
  assert.equal(fieldsForSurface('debug').some((field) => field.key === 'status'), true);
  assert.equal(fieldsForSurface('audit').some((field) => field.key === 'result'), true);
  assert.equal(fieldsForSurface('nope'), FILTER_FIELDS.workspace);
  assert.ok(FILTER_OPERATORS.includes('gte'));
  assert.ok(FILTER_OPERATORS.includes('contains'));
});

test('切词：空格分隔 + 双引号保留空格 + 转义引号', () => {
  assert.deepEqual(tokenizeQuery('a b c').map((item) => item.text), ['a', 'b', 'c']);
  assert.deepEqual(tokenizeQuery('url:"foo bar" status:200').map((item) => item.text), ['url:foo bar', 'status:200']);
  assert.deepEqual(tokenizeQuery('"bare phrase"').map((item) => item.text), ['bare phrase']);
  assert.deepEqual(tokenizeQuery('  ').length, 0);
  assert.deepEqual(tokenizeQuery('a\\"b').map((item) => item.text), ['a"b']);
});

test('查询解析：操作符前缀、否定、裸词、空值错误', () => {
  const parsed = parseFilterQuery('status:>=400 method:GET -url:/api/ "free text" url:~"a b" level:!log');
  assert.equal(parsed.errors.length, 0);
  const byField = Object.fromEntries(parsed.tokens.filter((token) => token.field !== 'url').map((token) => [token.field, token]));
  assert.equal(byField.status.op, 'gte');
  assert.equal(byField.status.value, '400');
  assert.equal(byField.method.op, 'equals');
  assert.equal(byField.level.op, 'not-equals');
  const urls = parsed.tokens.filter((token) => token.field === 'url');
  assert.equal(urls[0].negated, true);
  assert.equal(urls[0].value, '/api/');
  assert.equal(urls[1].op, 'contains');
  assert.equal(urls[1].value, 'a b');
  assert.deepEqual(parsed.freeText, ['free text']);
  // 无冒号或以冒号开头 → 错误/裸词边界
  const empty = parseFilterQuery('url:');
  assert.ok(empty.errors.some((error) => error.code === 'E_FILTER_EMPTY_VALUE'));
  const bare = parseFilterQuery('hello');
  assert.deepEqual(bare.freeText, ['hello']);
  const starts = parseFilterQuery('url:^https');
  assert.equal(starts.tokens[0].op, 'starts');
  const ends = parseFilterQuery('url:$js');
  assert.equal(ends.tokens[0].op, 'ends');
  const strict = parseFilterQuery('method:=GET');
  assert.equal(strict.tokens[0].op, 'equals');
});

test('编译与匹配：字符串/数字/否定/前缀后缀/空值不匹配', () => {
  const compiled = compileFilter({ query: 'status:>=400', fields: DEBUG_FIELDS });
  assert.equal(compiled.errors.length, 0);
  assert.equal(ROWS.filter(compiled.predicate).length, 2);
  assert.equal(ROWS.filter(compileFilter({ query: 'method:GET', fields: DEBUG_FIELDS }).predicate).length, 2);
  assert.equal(ROWS.filter(compileFilter({ query: 'method:!GET', fields: DEBUG_FIELDS }).predicate).length, 2);
  assert.equal(ROWS.filter(compileFilter({ query: 'url:^https://api', fields: DEBUG_FIELDS }).predicate).length, 3);
  assert.equal(ROWS.filter(compileFilter({ query: 'url:$js', fields: DEBUG_FIELDS }).predicate).length, 1);
  assert.equal(ROWS.filter(compileFilter({ query: 'status:<300', fields: DEBUG_FIELDS }).predicate).length, 2);
  assert.equal(ROWS.filter(compileFilter({ query: 'durationMs:>1000', fields: DEBUG_FIELDS }).predicate).length, 1);
  // 所有比较都不应抛错。
  for (const token of parseFilterQuery('status:>=x url:~foo').tokens) {
    const field = DEBUG_FIELDS.find((item) => item.key === token.field);
    assert.equal(typeof matchToken(ROWS[0], token, field), 'boolean');
  }
});

test('未知字段：报错、芯片仍可见、该 token 不参与匹配', () => {
  const compiled = compileFilter({ query: 'nope:1 status:200', fields: DEBUG_FIELDS });
  assert.ok(compiled.unknownFields.includes('nope'));
  assert.ok(compiled.errors.some((error) => error.code === 'E_FILTER_UNKNOWN_FIELD'));
  assert.equal(ROWS.filter(compiled.predicate).length, 1);

  const badNumber = compileFilter({ query: 'status:>abc', fields: DEBUG_FIELDS });
  assert.ok(badNumber.errors.some((error) => error.code === 'E_FILTER_BAD_NUMBER'));
  assert.equal(ROWS.filter(badNumber.predicate).length, 4, '非法数值不应过滤掉任何行');
});

test('裸词：对文本列包含匹配，多词 AND，大小写不敏感', () => {
  const result = filterRows(ROWS, 'api', { fields: DEBUG_FIELDS });
  assert.equal(result.matched, 3);
  assert.equal(filterRows(ROWS, 'api error', { fields: DEBUG_FIELDS }).matched, 1);
  assert.equal(filterRows(ROWS, 'API', { fields: DEBUG_FIELDS }).matched, 3);
  assert.equal(filterRows(ROWS, '', { fields: DEBUG_FIELDS }).matched, 4);
  assert.equal(filterRows(ROWS, 'zzz', { fields: DEBUG_FIELDS }).matched, 0);
});

test('filterRows：返回新数组、统计字段、空查询不复制引用', () => {
  const result = filterRows(ROWS, 'status:>=400', { fields: DEBUG_FIELDS });
  assert.equal(result.total, 4);
  assert.equal(result.matched, 2);
  assert.equal(result.rejected, 2);
  assert.notEqual(result.rows, ROWS);
  assert.equal(result.rows.length, 2);
  assert.equal(filterRows([], 'x').empty, true);
  assert.equal(filterRows(ROWS, '').matching, true);
});

test('芯片：字段/操作符/值渲染，删除后查询串只移除该 token', () => {
  const query = 'status:>=400 method:GET "free text"';
  const chips = activeChips(query, { fields: DEBUG_FIELDS });
  assert.ok(chips.length >= 3);
  const statusChip = chips.find((chip) => chip.field === 'status');
  assert.match(statusChip.label, /状态/);
  assert.match(statusChip.label, /不小于/);
  assert.equal(statusChip.removeQuery, 'method:GET "free text"');
  assert.equal(removeRawToken(query, 'method:GET'), 'status:>=400 "free text"');
  assert.equal(removeRawToken('a b', 'c'), 'a b');
  assert.equal(removeRawToken('', 'x'), '');
  // 否定芯片带 − 前缀。
  const negated = activeChips('-method:GET', { fields: DEBUG_FIELDS });
  assert.match(negated[0].label, /^− /);
  // 追加 token：带空格自动加引号。
  assert.equal(appendRawToken('a', 'url:foo bar'), 'a "url:foo bar"');
  assert.equal(appendRawToken('', 'status:200'), 'status:200');
  assert.equal(appendRawToken('', ''), '');
});

test('操作符本地化：中英都有，未知回退', () => {
  assert.equal(operatorLabel('gte', 'zh'), '不小于');
  assert.equal(operatorLabel('gte', 'en'), '>=');
  assert.equal(operatorLabel('contains', 'zh'), '包含');
  assert.equal(operatorLabel('nope', 'zh'), '等于');
});

test('补全：字段前缀与某列出现值的频次', () => {
  const suggestions = suggestFields('st', { fields: DEBUG_FIELDS });
  assert.equal(suggestions[0].field, 'status');
  assert.equal(suggestions[0].label, '状态');
  assert.equal(suggestFields('', { fields: DEBUG_FIELDS }).length, DEBUG_FIELDS.length);
  const values = suggestValues(ROWS, 'method');
  assert.deepEqual(values.map((item) => item.value).sort(), ['DELETE', 'GET', 'POST']);
  const top = values[0];
  assert.equal(top.count, 2);
  assert.deepEqual(suggestValues(ROWS, 'missing'), []);
});

test('分面计数：忽略空值，保留计数', () => {
  const counts = facetCounts(ROWS, 'method');
  assert.equal(counts.get('GET'), 2);
  assert.equal(counts.get('POST'), 1);
  assert.equal(facetCounts([], 'x').size, 0);
  assert.equal(facetCounts([{ a: '' }, { a: null }], 'a').size, 0);
});

test('常用过滤：按表面给预设，未知字段的预设标记不可用', () => {
  const saved = savedFiltersFor('debug', { fields: DEBUG_FIELDS });
  assert.ok(saved.length >= 3);
  assert.ok(saved.every((item) => item.text.length > 0));
  assert.ok(saved.every((item) => item.available === true));
  assert.deepEqual(SAVED_FILTERS.longshot, []);
  const workspacePresets = savedFiltersFor('workspace', { fields: [] });
  assert.ok(workspacePresets.length >= 2);
});

test('摘要 / 空判定 / 规范化 / URL 编解码', () => {
  assert.match(filterSummary({ matched: 2, total: 4, query: 'x' }, 'zh'), /2 \/ 4/);
  assert.match(filterSummary({ matched: 0, total: 4, query: 'x' }, 'zh'), /没有匹配/);
  assert.equal(isFilteredEmpty({ matched: 0, total: 4 }, 4), true);
  assert.equal(isFilteredEmpty({ matched: 0, total: 0 }, 0), false);
  assert.equal(isFilteredEmpty({ matched: 3, total: 3 }, 3), false);
  assert.equal(normalizeFilterQuery('  a   b  '), 'a b');
  assert.equal(normalizeFilterQuery('x'.repeat(600)).length, 500);
  assert.equal(decodeFilterQuery(encodeFilterQuery('status:>=400 a b')), 'status:>=400 a b');
  assert.equal(decodeFilterQuery('%E0%A4%A'), '%E0%A4%A', '坏百分号编码不抛错');
  assert.equal(decodeFilterQuery(''), '');
});

test('textOfRow：优先目录字段，无目录时拼接全部值', () => {
  assert.match(textOfRow(ROWS[0], DEBUG_FIELDS), /api\.example/);
  const plain = textOfRow({ a: 'x', b: { nested: 1 } });
  assert.match(plain, /x/);
  assert.match(plain, /nested/);
  assert.equal(textOfRow(null), '');
  // 自定义 value 函数优先。
  const custom = [{ key: 'x', type: 'string', value: (row) => row.peak }];
  assert.equal(compileFilter({ query: 'x:9', fields: custom }).predicate({ peak: 9 }), true);
});
