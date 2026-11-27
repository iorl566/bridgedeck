import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTRACT_CURSOR_TTL_MS,
  encodeExtractCursor,
  decodeExtractCursor,
  verifyExtractCursor,
} from '../../extension/src/lib/extract-cursor.js';

const base = {
  tabId: 12,
  frameId: 0,
  kind: 'table',
  offset: 3,
  revision: 42,
  target: { selector: '#tbl', fields: [{ name: 'x', selector: 'td' }] },
};

test('cursor 编解码往返：字段完整、前缀 x1.', () => {
  const token = encodeExtractCursor(base);
  assert.match(token, /^x1\./);
  const decoded = decodeExtractCursor(token);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.cursor.tabId, 12);
  assert.equal(decoded.cursor.frameId, 0);
  assert.equal(decoded.cursor.kind, 'table');
  assert.equal(decoded.cursor.offset, 3);
  assert.equal(decoded.cursor.revision, 42);
  assert.deepEqual(decoded.cursor.target, base.target);
});

test('非 ASCII selector 也能安全往返', () => {
  const token = encodeExtractCursor({ ...base, target: { selector: '#表格·中文' } });
  const decoded = decodeExtractCursor(token);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.cursor.target.selector, '#表格·中文');
});

test('非法 cursor：前缀/JSON/版本/offset', () => {
  assert.equal(decodeExtractCursor('bogus').ok, false);
  assert.equal(decodeExtractCursor('x1.bm90LWpzb24=').ok, false);
  const badVersion = 'x1.' + Buffer.from(JSON.stringify({ v: 2, offset: 0 }), 'utf8').toString('base64url');
  assert.equal(decodeExtractCursor(badVersion).ok, false);
  const badOffset = 'x1.' + Buffer.from(JSON.stringify({ v: 1, offset: -1 }), 'utf8').toString('base64url');
  assert.equal(decodeExtractCursor(badOffset).ok, false);
});

test('超过 10 分钟视为过期', () => {
  const token = encodeExtractCursor({ ...base, at: Date.now() - EXTRACT_CURSOR_TTL_MS - 1000 });
  const decoded = decodeExtractCursor(token);
  assert.equal(decoded.ok, false);
  assert.match(decoded.reason, /10 分钟/);
});

test('verify：同 tab/frame/kind/revision 可用', () => {
  const decoded = decodeExtractCursor(encodeExtractCursor(base));
  assert.equal(decoded.ok, true);
  assert.equal(verifyExtractCursor(decoded.cursor, { tabId: 12, frameId: 0, kind: 'table', revision: 42 }), null);
});

test('verify：跨 tab/frame、类型不符、revision 变化都拒绝', () => {
  const decoded = decodeExtractCursor(encodeExtractCursor(base));
  assert.match(verifyExtractCursor(decoded.cursor, { tabId: 13 }), /另一个 tab/);
  assert.match(verifyExtractCursor(decoded.cursor, { frameId: 2 }), /另一个 frame/);
  assert.match(verifyExtractCursor(decoded.cursor, { kind: 'list' }), /类型不匹配/);
  assert.match(verifyExtractCursor(decoded.cursor, { revision: 43 }), /DOM 代/);
  assert.match(verifyExtractCursor(null, {}), /为空/);
});
