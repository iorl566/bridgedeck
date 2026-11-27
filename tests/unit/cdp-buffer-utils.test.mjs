import test from 'node:test';
import assert from 'node:assert/strict';
import { appendBounded, readBufferedEntries, truncateOptional, truncateText } from '../../extension/src/browser-driver/cdp-buffer-utils.js';

test('appendBounded 按上限丢掉最旧条目', () => {
  const buffers = new Map();
  for (let i = 1; i <= 5; i += 1) appendBounded(buffers, 7, { sequence: i }, 3);
  assert.deepEqual(buffers.get(7).map((item) => item.sequence), [3, 4, 5]);
  appendBounded(buffers, 8, { sequence: 1 }, 2);
  assert.deepEqual(buffers.get(8).map((item) => item.sequence), [1]);
});

test('readBufferedEntries 无游标返回最新 limit 条并标记截断', () => {
  const buffer = [1, 2, 3, 4].map((sequence) => ({ sequence, text: 't' + sequence }));
  const read = readBufferedEntries(buffer, 4, undefined, 2, (entry) => entry);
  assert.deepEqual(read.entries.map((item) => item.sequence), [3, 4]);
  assert.equal(read.nextSince, 4);
  assert.equal(read.truncated, true);
  const all = readBufferedEntries(buffer, 4, undefined, 10, (entry) => entry);
  assert.equal(all.truncated, false);
});

test('readBufferedEntries 游标推进并识别缺口', () => {
  const buffer = [{ sequence: 3 }, { sequence: 4 }, { sequence: 5 }];
  const read = readBufferedEntries(buffer, 5, 2, 10, (entry) => entry);
  assert.deepEqual(read.entries.map((item) => item.sequence), [3, 4, 5]);
  assert.equal(read.nextSince, 5);
  assert.equal(read.truncated, false);
  const gap = readBufferedEntries(buffer, 5, 0, 10, (entry) => entry);
  assert.equal(gap.truncated, true, '游标早于缓冲区最旧条目时应标记截断');
  const limited = readBufferedEntries(buffer, 5, 2, 1, (entry) => entry);
  assert.deepEqual(limited.entries.map((item) => item.sequence), [3]);
  assert.equal(limited.truncated, true);
});

test('truncateText/truncateOptional 保留截断标记', () => {
  assert.deepEqual(truncateText('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(truncateText('abc', 3), { text: 'abc', truncated: false });
  assert.deepEqual(truncateOptional('abcdef', 2), { text: 'ab', truncated: true });
  assert.equal(truncateOptional(undefined, 2), undefined);
});
