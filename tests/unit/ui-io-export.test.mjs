// tests/unit/ui-io-export.test.mjs —— 导出模型（extension/ui/lib/io-export.js）单测。
//
// 覆盖真实会出事的点：文件名在 Windows/中文下的安全、CSV 公式注入与引号、
// URL/请求头脱敏、体积截断与分片、下载描述符。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_FORMATS,
  MAX_EXPORT_BYTES,
  MIME_BY_FORMAT,
  REDACTED,
  SENSITIVE_HEADER_NAMES,
  buildDownloadDescriptor,
  buildExportPayload,
  csvEscape,
  exportFileName,
  exportPresetFor,
  formatStamp,
  inferColumns,
  looksSecret,
  neutralizeFormula,
  normalizeFormat,
  redactHeaders,
  redactRow,
  redactRows,
  redactUrl,
  sanitizeFileName,
  splitExport,
  summarizeExport,
  toCsv,
  toNdjson,
  utf8Bytes,
} from '../../extension/ui/lib/io-export.js';

test('格式归一化：未知/空值回退 json，大小写不敏感', () => {
  assert.deepEqual([...EXPORT_FORMATS], ['json', 'csv', 'ndjson']);
  assert.equal(normalizeFormat('JSON'), 'json');
  assert.equal(normalizeFormat('csv'), 'csv');
  assert.equal(normalizeFormat('  NdJson '), 'ndjson');
  assert.equal(normalizeFormat('xml'), 'json');
  assert.equal(normalizeFormat(''), 'json');
  assert.equal(normalizeFormat(null), 'json');
  assert.match(MIME_BY_FORMAT.json, /application\/json/);
  assert.match(MIME_BY_FORMAT.csv, /text\/csv/);
  assert.match(MIME_BY_FORMAT.ndjson, /ndjson/);
});

test('UTF-8 字节估算：ASCII/中文/emoji 与真实编码一致', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('中'), 3);
  assert.equal(utf8Bytes('😀'), 4);
  assert.equal(utf8Bytes('a中'), 4);
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes(null), 0);
  // 与 Node 的 Buffer.byteLength 对照（防止估算漂移影响截断阈值）。
  const sample = 'a中😀\n{"k":"v"}';
  assert.equal(utf8Bytes(sample), Buffer.byteLength(sample, 'utf8'));
});

test('文件名：时间戳格式 / 目录分隔符 / 保留名 / 长度都安全', () => {
  assert.match(formatStamp(new Date('2026-11-26T03:47:12Z'), { utc: true }), /^20261126-034712$/);
  assert.equal(sanitizeFileName('a/b:c*?.txt'), 'a-b-c-.txt');
  assert.equal(sanitizeFileName('  hello   world  '), 'hello-world');
  assert.equal(sanitizeFileName('con'), '_con');
  assert.equal(sanitizeFileName('NUL.json'), '_NUL.json');
  assert.equal(sanitizeFileName('...'), '');
  assert.equal(sanitizeFileName('', { maxLength: 5 }), '');
  // 中文保留（用户可读），但长度受控。
  assert.equal(sanitizeFileName('审计记录'), '审计记录');
  assert.ok([...sanitizeFileName('很长的名字'.repeat(30), { maxLength: 10 })].length <= 10);
  const name = exportFileName({ surface: 'audit', format: 'csv', stamp: '20261126-034712' });
  assert.match(name, /^bridge-audit-20261126-034712\.csv$/);
  assert.match(exportFileName({ surface: 'debug', format: 'ndjson', stamp: 'x' }), /\.ndjson$/);
  assert.match(exportFileName({}), /^bridge-export-.*\.json$/);
});

test('CSV 转义：引号翻倍、含分隔符/换行/首尾空格加引号', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(' padded '), '" padded "');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape('a\tb', { delimiter: '\t' }), '"a\tb"');
});

test('CSV 公式注入中和：= + - @ 与制表符开头加前缀单引号', () => {
  assert.equal(neutralizeFormula('=HYPERLINK("x")'), "'=HYPERLINK(\"x\")");
  assert.equal(neutralizeFormula('+1'), "'+1");
  assert.equal(neutralizeFormula('-2'), "'-2");
  assert.equal(neutralizeFormula('@SUM(1)'), "'@SUM(1)");
  assert.equal(neutralizeFormula('normal'), 'normal');
  const csv = toCsv([{ key: 'a' }, { key: 'b' }], [{ a: '=1+1', b: 'ok' }, { a: '2', b: 'x,y' }]);
  assert.match(csv, /'=1\+1/);
  assert.match(csv, /"x,y"/);
  assert.ok(csv.includes('\r\n'), 'CSV 默认 CRLF');
  const noHeader = toCsv([{ key: 'a' }], [{ a: 1 }], { includeHeader: false });
  assert.equal(noHeader, '1');
  const bom = toCsv([{ key: 'a' }], [{ a: '中' }], { bom: true });
  assert.equal(bom.charCodeAt(0), 0xfeff);
});

test('CSV：列取值优先 text()，对象值 JSON 化，异常值不炸', () => {
  const columns = [
    { key: 'a', label: 'A', text: (row) => (row.a ? row.a.toUpperCase() : '') },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C', text: () => { throw new Error('bad'); } },
  ];
  const csv = toCsv(columns, [{ a: 'x', b: { nested: 1 } }, { a: null, b: 2 }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'A,B,C');
  assert.equal(lines[1], 'X,"{""nested"":1}",?');
  assert.equal(lines[2], ',2,?');
});

test('NDJSON：每行一个 JSON，空数组为空串，不可序列化时降级', () => {
  assert.equal(toNdjson([]), '');
  assert.equal(toNdjson([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
  const circular = {};
  circular.self = circular;
  const text = toNdjson([circular]);
  assert.equal(text, '{"error":"unserializable"}\n');
});

test('URL 脱敏：默认整段 query 抹掉；keepQuery 只抹敏感参数', () => {
  const dropped = redactUrl('https://api.example/a?token=abc&x=1#frag');
  assert.equal(dropped.redacted >= 1, true);
  assert.equal(dropped.url, 'https://api.example/a?[redacted]#frag');

  const kept = redactUrl('https://api.example/a?token=abc&page=2&api_key=x', { keepQuery: true });
  assert.equal(kept.redacted, 2);
  assert.match(kept.url, /page=2/);
  assert.match(kept.url, /token=%5Bredacted%5D/);
  assert.match(kept.url, /api_key=%5Bredacted%5D/);

  const plain = redactUrl('https://api.example/a');
  assert.deepEqual(plain, { url: 'https://api.example/a', redacted: 0 });
  assert.deepEqual(redactUrl(''), { url: '', redacted: 0 });
  // 非标准 scheme / 相对地址也不能抛错。
  assert.equal(redactUrl('chrome-extension://x/y?token=1').redacted, 1);
  assert.equal(redactUrl('not a url?token=1').redacted, 1);
});

test('请求头脱敏：命名大小写/前缀命中，其余原样', () => {
  const result = redactHeaders({
    Authorization: 'Bearer abc',
    Cookie: 'sid=1',
    'X-Api-Key': 'k',
    'Content-Type': 'application/json',
    'Set-Cookie': 'a=b',
  });
  const map = Object.fromEntries(result.headers);
  assert.equal(result.redacted, 4);
  for (const name of SENSITIVE_HEADER_NAMES) {
    const matched = Object.keys(map).find((key) => key.toLowerCase() === name);
    if (matched) assert.equal(map[matched], REDACTED);
  }
  assert.equal(map['Content-Type'], 'application/json');
  // 数组入参（协议里常见）也能处理。
  const array = redactHeaders([['authorization', 'x'], ['accept', '*/*']]);
  assert.deepEqual(array.headers, [['authorization', REDACTED], ['accept', '*/*']]);
});

test('行级脱敏：URL 保留结构、原始文本命中敏感值时整段替换', () => {
  const row = {
    url: 'https://x/api?token=abc',
    requestHeaders: { Authorization: 'Bearer 1234567890abcdef' },
    raw: 'Bearer 1234567890abcdef',
    method: 'GET',
  };
  const result = redactRow(row, { keepQuery: true });
  assert.ok(result.redacted >= 2);
  assert.match(result.row.url, /redacted/);
  assert.equal(result.row.method, 'GET');
  assert.ok(result.fields.includes('url'));
  // 不修改入参。
  assert.match(row.url, /token=abc/);

  const batch = redactRows([{ url: 'https://a?token=1' }, { url: 'https://b' }]);
  assert.equal(batch.rows.length, 2);
  assert.equal(batch.redacted, 1);
  assert.deepEqual(batch.fields, ['url']);
});

test('looksSecret：像令牌的才算，短文本/普通单词不算', () => {
  assert.equal(looksSecret('Bearer 1234567890abcdef'), true);
  assert.equal(looksSecret('abcdefghijklmnopqrstuvwxyz012345'), true);
  assert.equal(looksSecret('short'), false);
  assert.equal(looksSecret('hello world'), false);
  assert.equal(looksSecret(''), false);
});

test('payload：JSON 带 meta、CSV 带表头、NDJSON 行数正确', () => {
  const rows = [{ ts: 1, method: 'GET', status: 200, url: 'https://a?token=x' }, { ts: 2, method: 'POST', status: 500, url: 'https://b' }];
  const json = buildExportPayload({ surface: 'audit', rows, format: 'json', stamp: new Date('2026-11-26T03:47:12Z') });
  assert.equal(json.ok, true);
  assert.equal(json.rowCount, 2);
  assert.match(json.fileName, /^bridge-audit-.*\.json$/);
  assert.equal(json.mime, MIME_BY_FORMAT.json);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.meta.surface, 'audit');
  assert.equal(parsed.meta.rowCount, 2);
  assert.equal(parsed.rows.length, 2);
  assert.ok(json.redacted >= 1, 'URL token 应被脱敏');

  const csv = buildExportPayload({ surface: 'audit', format: 'csv', rows, columns: inferColumns(rows) });
  assert.match(csv.text, /ts,method,status,url/);
  assert.match(csv.text, /GET/);

  const ndjson = buildExportPayload({ surface: 'audit', format: 'ndjson', rows });
  assert.equal(ndjson.text.trim().split('\n').length, 2);
});

test('payload：redact:false 关闭脱敏；空数据给 warning 且仍是合法导出', () => {
  const rows = [{ url: 'https://a?token=secret' }];
  const raw = buildExportPayload({ rows, redact: false });
  assert.match(raw.text, /token=secret/);
  assert.equal(raw.redacted, 0);
  const empty = buildExportPayload({ rows: [] });
  assert.equal(empty.rowCount, 0);
  assert.ok(empty.warnings.includes('no-rows'));
  assert.doesNotThrow(() => JSON.parse(empty.text));
});

test('payload：超过 maxBytes 时截断成合法 JSON/CSV，并报告 truncated', () => {
  const rows = Array.from({ length: 500 }, (_value, index) => ({ index, text: 'x'.repeat(80) }));
  const payload = buildExportPayload({ rows, format: 'json', maxBytes: 16 * 1024 });
  assert.equal(payload.truncated, true);
  assert.ok(payload.warnings.includes('size-limit'));
  assert.ok(payload.bytes <= 16 * 1024, '截断后体积应回落到上限内：' + payload.bytes);
  const parsed = JSON.parse(payload.text);
  assert.ok(parsed.meta.truncated === true || parsed.rows.length <= rows.length);
  assert.ok(payload.rowCount < 500);

  const csv = buildExportPayload({ rows, format: 'csv', maxBytes: 16 * 1024 });
  assert.equal(csv.truncated, true);
  assert.ok(csv.text.split('\r\n').length < rows.length);
});

test('payload：导出列固定顺序、CSV 预设列、自定义格式化', () => {
  const columns = [{ key: 'b', label: 'B' }, { key: 'a', label: 'A' }];
  const payload = buildExportPayload({ format: 'csv', columns, rows: [{ a: 1, b: 2 }] });
  assert.equal(payload.text.split('\r\n')[0], 'B,A');
  assert.equal(payload.text.split('\r\n')[1], '2,1');
});

test('分片：小文本单片、大文本按行切且每片完整', () => {
  assert.deepEqual(splitExport(''), []);
  const single = splitExport('a\nb\nc', { maxBytes: 1024 });
  assert.equal(single.length, 1);
  assert.equal(single[0].total, 1);
  const big = Array.from({ length: 400 }, (_value, index) => 'line-' + index + '-' + 'x'.repeat(100)).join('\n');
  const parts = splitExport(big, { maxBytes: 4096 });
  assert.ok(parts.length > 1);
  assert.equal(parts[0].index, 1);
  assert.equal(parts[parts.length - 1].total, parts.length);
  for (const part of parts) assert.ok(part.bytes <= 4096 + 200, '单片超限：' + part.bytes);
  // 拼接后不丢行（末尾换行差异允许）。
  assert.equal(parts.map((part) => part.text).join('\n').split('\n').filter(Boolean).length, 400);
});

test('下载描述符 / 摘要 / 预设', () => {
  const payload = buildExportPayload({ surface: 'audit', format: 'csv', rows: [{ a: 1 }] });
  const descriptor = buildDownloadDescriptor(payload);
  assert.equal(descriptor.name, payload.fileName);
  assert.equal(descriptor.mime, payload.mime);
  assert.equal(descriptor.revoke, true);
  assert.equal(descriptor.text, payload.text);
  assert.equal(buildDownloadDescriptor({ text: 'x' }).name.length > 0, true);

  const summary = summarizeExport({ rowCount: 3, bytes: 10, redacted: 2, truncated: true, warnings: ['size-limit'] });
  assert.deepEqual(summary, { rows: 3, bytes: 10, redacted: 2, truncated: true, warnings: ['size-limit'] });
  assert.equal(summarizeExport(null).rows, 0);

  assert.equal(exportPresetFor('audit').format, 'csv');
  assert.equal(exportPresetFor('debug').format, 'json');
  assert.equal(exportPresetFor('nope').surface, 'workspace');
  assert.ok(MAX_EXPORT_BYTES >= 1024 * 1024);
});
