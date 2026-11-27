import test from 'node:test';
import assert from 'node:assert/strict';
import {
  charWidth, textWidth, padEndWidth, truncateText, renderTable,
  formatUptime, formatTime, formatLease, formatBytes,
} from '../../cli/lib/format.mjs';

test('textWidth：中文/全角/emoji 记 2，ASCII 记 1', () => {
  assert.equal(charWidth('a'), 1);
  assert.equal(charWidth('中'), 2);
  assert.equal(charWidth('，'), 2);
  assert.equal(charWidth('😀'), 2);
  assert.equal(textWidth('a中'), 3);
});

test('padEndWidth 按显示宽度补齐', () => {
  assert.equal(padEndWidth('中', 4), '中  ');
  assert.equal(padEndWidth('ab', 4), 'ab  ');
});

test('truncateText 超长截断并加省略号', () => {
  assert.equal(truncateText('abcdef', 4), 'abc…');
  assert.equal(truncateText('abc', 4), 'abc');
  assert.equal(truncateText(null, 4), '');
});

test('renderTable 空行返回空串，非空按列宽对齐', () => {
  assert.equal(renderTable(['a'], []), '');
  const table = renderTable(['name', 'n'], [['中', '1']]);
  assert.ok(table.includes('name'));
  assert.ok(table.includes('中'));
  assert.ok(table.split('\n').length >= 3);
});

test('formatUptime / formatTime / formatLease 基础格式', () => {
  assert.equal(formatUptime(0), '0s');
  assert.equal(formatUptime(65_000), '1m 5s');
  assert.equal(formatUptime(3_600_000), '1h 0m');
  assert.equal(formatUptime(90_061_000), '1d 1h 1m');
  assert.match(formatTime(Date.UTC(2026, 0, 2, 3, 4, 5)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatLease(0), '0s');
  assert.equal(formatLease(500), '500ms');
  assert.equal(formatLease(1500), '1.5s');
  assert.equal(formatLease(65_000), '1m5s');
});

test('formatBytes 单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
