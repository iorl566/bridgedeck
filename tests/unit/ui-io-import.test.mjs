// tests/unit/ui-io-import.test.mjs —— 导入模型（extension/ui/lib/io-import.js）单测。
//
// 覆盖真实脏输入：BOM/CRLF/TSV/引号里的换行、JSON 信封、NDJSON 坏行、重复表头、
// 类型校验（逐行报错）、合并策略（追加/替换/按 key）、版本迁移、上限与截断。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMPORT_FORMATS,
  IMPORT_LIMITS,
  IMPORT_MIGRATIONS,
  IMPORT_SCHEMA_VERSION,
  IMPORT_TYPES,
  buildImportPreview,
  coerceValue,
  csvToObjects,
  dedupeRows,
  detectImportFormat,
  extensionOf,
  formatFromFileName,
  formatLabelText,
  inferHeaders,
  inferTypes,
  mergeImported,
  migrateImportPayload,
  normalizeSchema,
  parseCsvRows,
  parseImport,
  parseJsonRows,
  parseNdjson,
  scanSecrets,
  sniffFormat,
  unwrapJsonArray,
  validateImport,
} from '../../extension/ui/lib/io-import.js';

test('格式识别：扩展名优先、其次内容嗅探、最后回退 json', () => {
  assert.equal(formatFromFileName('a.JSON'), 'json');
  assert.equal(formatFromFileName('a.csv'), 'csv');
  assert.equal(formatFromFileName('a.tsv'), 'csv');
  assert.equal(formatFromFileName('a.ndjson'), 'ndjson');
  assert.equal(formatFromFileName('a.jsonl'), 'ndjson');
  assert.equal(formatFromFileName('a.txt'), '');
  assert.equal(sniffFormat('{"a":1}'), 'json');
  assert.equal(sniffFormat('[{"a":1}]'), 'json');
  assert.equal(sniffFormat('{"a":1}\n{"a":2}'), 'ndjson');
  assert.equal(sniffFormat('a,b\n1,2'), 'csv');
  assert.equal(sniffFormat('a\tb\n1\t2'), 'csv');
  assert.equal(sniffFormat('   '), '');
  assert.deepEqual(detectImportFormat('a,b', { fileName: 'x.json' }), { format: 'json', by: 'file-name' });
  assert.deepEqual(detectImportFormat('a,b', { format: 'csv' }), { format: 'csv', by: 'explicit' });
  assert.deepEqual(detectImportFormat('{"a":1}', {}), { format: 'json', by: 'content' });
  assert.deepEqual(detectImportFormat('???', {}), { format: 'json', by: 'fallback' });
  assert.deepEqual([...IMPORT_FORMATS], ['json', 'ndjson', 'csv']);
  assert.deepEqual([...IMPORT_TYPES], ['string', 'number', 'boolean', 'timestamp', 'json']);
});

test('CSV 解析：BOM、CRLF、引号转义、引号内换行、TSV 自动识别', () => {
  const crlf = parseCsvRows('\ufeffa,b\r\n1,"x,y"\r\n2,"line1\nline2"\r\n');
  assert.equal(crlf.cells.length, 3);
  assert.deepEqual(crlf.cells[0], ['a', 'b']);
  assert.deepEqual(crlf.cells[1], ['1', 'x,y']);
  assert.deepEqual(crlf.cells[2], ['2', 'line1\nline2']);
  assert.equal(crlf.errors.length, 0);

  const quoted = parseCsvRows('a,b\n"say ""hi""",2');
  assert.deepEqual(quoted.cells[1], ['say "hi"', '2']);

  const tsv = parseCsvRows('a\tb\n1\t2');
  assert.equal(tsv.delimiter, '\t');
  assert.deepEqual(tsv.cells[1], ['1', '2']);

  const unclosed = parseCsvRows('a,b\n"unterminated');
  assert.ok(unclosed.errors.some((error) => error.code === 'E_CSV_UNCLOSED_QUOTE'));

  // 末尾空行被去掉（Excel 常见）。
  const trailing = parseCsvRows('a,b\n1,2\n\n\n');
  assert.equal(trailing.cells.length, 2);
});

test('CSV → 对象：表头去重、缺列补空、列数不符记错误', () => {
  const parsed = parseCsvRows('name,name,,x\n1,2,3,4\nshort');
  const converted = csvToObjects(parsed.cells);
  assert.deepEqual(converted.headers, ['name', 'name_2', 'column3', 'x']);
  assert.deepEqual(converted.objects[0], { name: '1', name_2: '2', column3: '3', x: '4' });
  assert.deepEqual(converted.objects[1], { name: 'short', name_2: '', column3: '', x: '' });
  assert.ok(converted.errors.some((error) => error.code === 'E_CSV_COLUMN_COUNT'));
  // 无表头模式生成 c1..cN。
  const headerless = csvToObjects([['1', '2']], { header: false });
  assert.deepEqual(headerless.objects, [{ c1: '1', c2: '2' }]);
});

test('NDJSON：坏行带真实行号；JSON 解析失败时降级按行解析', () => {
  const nd = parseNdjson('{"a":1}\n\nnot json\n{"b":2}\n[1,2]');
  assert.equal(nd.objects.length, 2);
  assert.equal(nd.errors.length, 2);
  assert.equal(nd.errors[0].line, 3);
  assert.equal(nd.errors[0].code, 'E_NDJSON_BAD_JSON');
  assert.equal(nd.errors[1].code, 'E_NDJSON_NOT_OBJECT');

  const fallback = parseJsonRows('{"a":1}\n{"a":2}');
  assert.equal(fallback.objects.length, 2);
  assert.equal(fallback.path, 'ndjson-fallback');

  const broken = parseJsonRows('{oops');
  assert.equal(broken.objects.length, 0);
  assert.equal(broken.errors[0].code, 'E_JSON_PARSE');
});

test('JSON 解包：数组 / rows / entries / data / result / 单对象', () => {
  assert.deepEqual(unwrapJsonArray([1, 2]).rows, [1, 2]);
  assert.deepEqual(unwrapJsonArray({ rows: [1] }).rows, [1]);
  assert.deepEqual(unwrapJsonArray({ entries: [2] }).rows, [2]);
  assert.deepEqual(unwrapJsonArray({ data: [3] }).rows, [3]);
  assert.deepEqual(unwrapJsonArray({ result: { rows: [4] } }).rows, [4]);
  const single = unwrapJsonArray({ id: 1 });
  assert.deepEqual(single.rows, [{ id: 1 }]);
  assert.deepEqual(unwrapJsonArray({}).rows, []);
  assert.deepEqual(unwrapJsonArray(null).rows, []);
  const withMeta = unwrapJsonArray({ meta: { schema: 2 }, rows: [{ a: 1 }] });
  assert.deepEqual(withMeta.meta, { schema: 2 });
});

test('类型推断：数字/布尔/时间戳/JSON/字符串', () => {
  const types = inferTypes([
    { n: '1', b: 'true', t: '1700000000000', t2: '2026-11-26T03:47:12Z', s: 'abc', j: { x: 1 } },
    { n: '2', b: 'false', t: '1700000000001', t2: '2026-11-26T03:47:13Z', s: '1', j: { x: 2 } },
  ]);
  assert.equal(types.n, 'number');
  assert.equal(types.b, 'boolean');
  assert.equal(types.t, 'timestamp');
  assert.equal(types.t2, 'timestamp');
  assert.equal(types.j, 'json');
  assert.equal(types.s, 'string');
  assert.deepEqual(inferHeaders([{ a: 1 }, { b: 2, a: 3 }]), ['a', 'b']);
  assert.ok(inferHeaders(Array.from({ length: 100 }, (_v, i) => ({ ['k' + i]: i })), 8).length <= 8);
});

test('coerceValue：数字/布尔/时间戳/JSON 的边界', () => {
  assert.deepEqual(coerceValue('12', 'number'), { ok: true, value: 12 });
  assert.equal(coerceValue('12x', 'number').ok, false);
  assert.deepEqual(coerceValue('1.5', 'number'), { ok: true, value: 1.5 });
  assert.deepEqual(coerceValue('', 'number'), { ok: true, value: null });
  assert.deepEqual(coerceValue('yes', 'boolean'), { ok: true, value: true });
  assert.deepEqual(coerceValue('0', 'boolean'), { ok: true, value: false });
  assert.equal(coerceValue('maybe', 'boolean').ok, false);
  assert.deepEqual(coerceValue('1700000000000', 'timestamp'), { ok: true, value: 1700000000000 });
  assert.deepEqual(coerceValue('2026-11-26T03:47:12Z', 'timestamp'), { ok: true, value: Date.parse('2026-11-26T03:47:12Z') });
  assert.equal(coerceValue('not-a-date', 'timestamp').ok, false);
  assert.deepEqual(coerceValue('{"a":1}', 'json'), { ok: true, value: { a: 1 } });
  assert.equal(coerceValue('{bad', 'json').ok, false);
  assert.deepEqual(coerceValue(1, 'string'), { ok: true, value: '1' });
});

test('schema 校验：必填/类型/枚举/正则/长度/重复 key，错误带行号', () => {
  const schema = normalizeSchema({
    fields: [
      { key: 'method', type: 'string', required: true, oneOf: ['GET', 'POST'] },
      { key: 'status', type: 'number', required: true },
      { key: 'url', type: 'string', pattern: '^https?://', maxLength: 30 },
      { key: 'durationMs', type: 'number' },
    ],
  });
  assert.equal(schema.length, 4);
  assert.equal(schema[2].pattern instanceof RegExp, true);

  const result = validateImport([
    { method: 'GET', status: '200', url: 'https://a' },
    { method: 'PUT', status: 'abc', url: 'ftp://x', durationMs: '5' },
    { status: '500', url: 'https://b' },
  ], schema, { keyField: 'url' });
  assert.equal(result.rows.length, 3);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 2);
  const codes = result.errors.map((error) => error.code).sort();
  assert.ok(codes.includes('E_ENUM'));
  assert.ok(codes.includes('E_TYPE'));
  assert.ok(codes.includes('E_PATTERN'));
  assert.ok(codes.includes('E_REQUIRED'));
  const requiredError = result.errors.find((error) => error.code === 'E_REQUIRED');
  assert.equal(requiredError.field, 'method');
  // 第 3 行数据（0 基 index 2）对应文件第 4 行（含表头时的口径）。
  assert.equal(requiredError.line, 4);
  // 保留 schema 之外的原始字段。
  assert.equal(result.rows[0].url, 'https://a');
});

test('schema 校验：dropInvalid 丢弃坏行；类型转换成功值写回', () => {
  const schema = [{ key: 'n', type: 'number', required: true }];
  const result = validateImport([{ n: '1' }, { n: 'x' }, { n: '3' }], schema, { dropInvalid: true });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => row.n), [1, 3]);
  assert.equal(result.invalid, 1);
});

test('去重：按 key 保留首行；默认按整行 JSON', () => {
  const deduped = dedupeRows([{ id: 1 }, { id: 2 }, { id: 1 }], { keyOf: (row) => row.id });
  assert.equal(deduped.unique.length, 2);
  assert.equal(deduped.duplicates.length, 1);
  assert.equal(deduped.duplicates[0].key, '1');
  const whole = dedupeRows([{ a: 1 }, { a: 1 }, { a: 2 }]);
  assert.equal(whole.unique.length, 2);
  // keyOf 抛错也不能中断。
  const broken = dedupeRows([{ a: 1 }, { a: 2 }], { keyOf: () => { throw new Error('x'); } });
  assert.equal(broken.unique.length, 2);
});

test('合并策略：append / replace / merge（新增-替换-不变统计）', () => {
  const existing = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
  const appended = mergeImported(existing, [{ id: 'c' }], { strategy: 'append' });
  assert.equal(appended.rows.length, 3);
  assert.deepEqual(appended.stats, { existing: 2, imported: 1, appended: 1, replaced: 0, unchanged: 0, result: 3 });

  const replaced = mergeImported(existing, [{ id: 'c' }], { strategy: 'replace' });
  assert.deepEqual(replaced.rows, [{ id: 'c' }]);
  assert.equal(replaced.stats.replaced, 2);

  const merged = mergeImported(existing, [{ id: 'a', v: 9 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }], { strategy: 'merge', keyOf: (row) => row.id });
  assert.equal(merged.rows.length, 3);
  assert.deepEqual(merged.rows[0], { id: 'a', v: 9 });
  assert.deepEqual(merged.stats, { existing: 2, imported: 3, appended: 1, replaced: 1, unchanged: 1, result: 3 });
  // 未知策略按 append 处理（HTTP 参数脏值不致丢数据）。
  assert.equal(mergeImported(existing, [{ id: 'z' }], { strategy: 'bogus' }).rows.length, 3);
});

test('parseImport：统一入口的 ok/warnings/上限/空输入', () => {
  const empty = parseImport('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.errors[0].code, 'E_IMPORT_EMPTY');

  const csv = parseImport('a,b\n1,2\n3,4', { format: 'csv' });
  assert.equal(csv.ok, true);
  assert.equal(csv.objects.length, 2);
  assert.deepEqual(csv.headers, ['a', 'b']);

  const json = parseImport('[{"a":1},{"a":2}]');
  assert.equal(json.format, 'json');
  assert.equal(json.objects.length, 2);

  const nd = parseImport('{"a":1}\n{"a":2}\nbad');
  assert.equal(nd.format, 'ndjson');
  assert.equal(nd.objects.length, 2);
  assert.equal(nd.ok, false);

  const tooLarge = parseImport('x'.repeat(100), { limits: { maxBytes: 10 } });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.errors[0].code, 'E_IMPORT_TOO_LARGE');

  const truncated = parseImport(Array.from({ length: 5 }, (_v, i) => JSON.stringify({ i })).join('\n'), { limits: { maxRows: 3 } });
  assert.equal(truncated.objects.length, 3);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.warnings.includes('row-limit'));

  const longCell = parseImport(JSON.stringify([{ v: 'y'.repeat(50) }]), { limits: { maxCellLength: 10 } });
  assert.equal(longCell.objects[0].v.length, 10);
  assert.ok(longCell.warnings.some((warning) => warning.startsWith('cell-truncated')));
  assert.ok(IMPORT_LIMITS.maxRows >= 1000);
});

test('预览：列/类型/前 N 行/截断标记', () => {
  const parsed = parseImport(JSON.stringify(Array.from({ length: 30 }, (_v, i) => ({ id: 'r' + i, n: i }))));
  const preview = buildImportPreview(parsed, { limit: 5 });
  assert.equal(preview.rows.length, 5);
  assert.equal(preview.total, 30);
  assert.equal(preview.truncated, true);
  assert.deepEqual(preview.headers, ['id', 'n']);
  assert.equal(preview.types.n, 'number');
  const small = buildImportPreview(parseImport('a\n1'));
  assert.equal(small.truncated, false);
});

test('版本迁移：v1 数组 → v2 信封；未来版本给警告', () => {
  assert.equal(IMPORT_SCHEMA_VERSION, 2);
  assert.equal(typeof IMPORT_MIGRATIONS[1], 'function');
  const fromArray = migrateImportPayload([{ a: 1 }]);
  assert.equal(fromArray.ok, true);
  assert.deepEqual(fromArray.applied, [1]);
  assert.deepEqual(fromArray.payload, { meta: { schema: 1 }, rows: [{ a: 1 }] });
  assert.equal(fromArray.version, 2);

  const fromEnvelope = migrateImportPayload({ meta: { schema: 2 }, rows: [] });
  assert.deepEqual(fromEnvelope.applied, []);
  assert.equal(fromEnvelope.ok, true);

  const future = migrateImportPayload({ meta: { schema: 9 }, rows: [] });
  assert.equal(future.ok, false);
  assert.ok(future.warnings.includes('future-version:9'));
});

test('敏感值扫描：导入文件里出现令牌时提示', () => {
  const result = scanSecrets([{ token: 'abcdefghijklmnopqrstuvwxyz012345' }, { name: 'ok' }]);
  assert.equal(result.hits, 1);
  assert.equal(result.warning, true);
  assert.equal(scanSecrets([{ name: 'ok' }]).hits, 0);
  assert.equal(scanSecrets(null).hits, 0);
});

test('工具：扩展名与格式显示名', () => {
  assert.equal(extensionOf('a.b.CSV'), 'csv');
  assert.equal(extensionOf('a'), '');
  assert.equal(extensionOf('a.'), '');
  assert.equal(formatLabelText('csv'), 'CSV');
  assert.equal(formatLabelText('ndjson'), 'NDJSON');
  assert.equal(formatLabelText('json'), 'JSON');
  assert.equal(formatLabelText('xml'), 'JSON');
});
