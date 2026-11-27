// tests/unit/mcp-resource-paging.test.mjs —— MCP resources 分页/截断协议测试。
//
// 覆盖：字符分页切段、cursor/nextUri 续读、offset 越界、limit 归一化、
// 未分页时的 256 KiB 字节截断、技能文档分页、JSON 资源分页可还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PAGE_CHARS,
  MAX_PAGE_CHARS,
  MAX_RESOURCE_BYTES,
  createResourceRegistry,
  pageResourceText,
  parsePagingQuery,
} from '../../mcp/resources.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-resource-paging-'));
}

function stripPagedMarker(text) {
  return String(text).replace(/\n\n…\[paged\][\s\S]*$/, '');
}

test('pageResourceText：未分页时整段返回，超 256 KiB 才字节截断', () => {
  const small = pageResourceText('hello', parsePagingQuery(''), 'bridge://x');
  assert.equal(small.text, 'hello');
  assert.equal(small.meta.paged, false);
  assert.equal(small.meta.totalChars, 5);
  assert.equal(small.meta.returnedChars, 5);
  assert.equal(small.meta.truncatedBytes, false);
  assert.equal(small.meta.nextCursor, null);

  const huge = 'x'.repeat(MAX_RESOURCE_BYTES + 10);
  const clipped = pageResourceText(huge, parsePagingQuery(''), 'bridge://big');
  assert.equal(clipped.meta.paged, false);
  assert.equal(clipped.meta.truncatedBytes, true);
  assert.ok(clipped.text.endsWith('请用 CLI 读取完整内容。'));
  assert.ok(clipped.text.length <= MAX_RESOURCE_BYTES + 200);
});

test('pageResourceText：按 limit/cursor 切段并给出 nextUri', () => {
  const text = 'abcdefghij';
  const first = pageResourceText(text, parsePagingQuery('limit=4'), 'bridge://observation/s1');
  assert.equal(first.text.startsWith('abcd'), true);
  assert.equal(first.meta.paged, true);
  assert.equal(first.meta.offset, 0);
  assert.equal(first.meta.returnedChars, 4);
  assert.equal(first.meta.totalChars, 10);
  assert.equal(first.meta.nextCursor, '4');
  assert.equal(first.meta.hasMore, true);
  assert.equal(first.meta.nextUri, 'bridge://observation/s1?limit=4&cursor=4');
  assert.ok(first.text.includes('本段字符 0–4 / 10'));

  const middle = pageResourceText(text, parsePagingQuery('limit=4&cursor=4'), 'bridge://observation/s1');
  assert.equal(middle.text.startsWith('efgh'), true);
  assert.equal(middle.meta.nextCursor, '8');

  const tail = pageResourceText(text, parsePagingQuery('limit=4&cursor=8'), 'bridge://observation/s1');
  assert.equal(tail.text, 'ij');
  assert.equal(tail.meta.hasMore, false);
  assert.equal(tail.meta.nextCursor, null);
  assert.equal(tail.meta.nextUri, null);
  assert.equal(tail.meta.returnedChars, 2);
});

test('pageResourceText：offset 越界/limit 边界', () => {
  assert.throws(
    () => pageResourceText('abc', parsePagingQuery('cursor=4'), 'bridge://observation/s1'),
    (error) => error.code === 'E_BAD_ARG' && error.message.includes('超过内容长度'),
  );
  const emptyTail = pageResourceText('abc', parsePagingQuery('cursor=3'), 'bridge://observation/s1');
  assert.equal(emptyTail.text, '');
  assert.equal(emptyTail.meta.hasMore, false);
  assert.throws(
    () => pageResourceText('abc', parsePagingQuery('limit=' + (MAX_PAGE_CHARS + 1)), 'bridge://observation/s1'),
    (error) => error.code === 'E_BAD_ARG',
  );
  const defaultPaged = pageResourceText('x'.repeat(DEFAULT_PAGE_CHARS + 5), parsePagingQuery('limit=' + DEFAULT_PAGE_CHARS), 'bridge://observation/s1');
  assert.equal(defaultPaged.meta.returnedChars, DEFAULT_PAGE_CHARS);
  assert.equal(defaultPaged.meta.hasMore, true);
});

test('JSON 资源分页可逐段还原（拼接去掉分页标记）', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  registry.recordObservation('p1', { url: 'https://paging.test/', title: 'P', observation: 'y'.repeat(5000) });
  const full = registry.read('bridge://observation/p1').contents[0].text;
  const chunks = [];
  let uri = 'bridge://observation/p1?limit=700';
  let pages = 0;
  while (uri && pages < 40) {
    const result = registry.read(uri);
    const meta = result._meta['browser-bridge/resource'];
    assert.equal(meta.paged, true);
    assert.ok(meta.returnedChars <= 700);
    chunks.push(stripPagedMarker(result.contents[0].text));
    uri = meta.nextUri;
    pages += 1;
  }
  assert.ok(pages >= 8, 'record 文本应分成多页：' + pages);
  assert.equal(chunks.join(''), full);
  assert.doesNotThrow(() => JSON.parse(full));
});

test('技能文档也支持分页，且 last page 无续读标记', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const full = registry.read('bridge://skill/SKILL.md').contents[0].text;
  let uri = 'bridge://skill/SKILL.md?limit=2048';
  const chunks = [];
  let pages = 0;
  while (uri && pages < 100) {
    const result = registry.read(uri);
    const meta = result._meta['browser-bridge/resource'];
    chunks.push(stripPagedMarker(result.contents[0].text));
    uri = meta.nextUri;
    pages += 1;
  }
  assert.equal(chunks.join(''), full);
  const tail = registry.read('bridge://skill/SKILL.md?limit=' + full.length + '&cursor=0');
  assert.equal(tail._meta['browser-bridge/resource'].hasMore, false);
  assert.equal(stripPagedMarker(tail.contents[0].text), full);
});

test('分页 _meta 与 contents 内容一致，且带 capabilities', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  registry.recordEvidence('e1', { ok: true, requests: 3 });
  const result = registry.read('bridge://debug/evidence/e1?limit=10');
  const meta = result._meta['browser-bridge/resource'];
  assert.equal(result.contents[0]._meta['browser-bridge/resource'].nextCursor, meta.nextCursor);
  assert.equal(meta.kind, 'evidence');
  assert.equal(meta.capabilities.subscribe, true);
  assert.equal(typeof meta.totalChars, 'number');
  assert.ok(meta.hasMore === false || typeof meta.nextUri === 'string');
});
