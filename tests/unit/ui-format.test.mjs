// tests/unit/ui-format.test.mjs —— extension/ui/lib/format.js 纯格式化单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  formatClock,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatHttpStatus,
  formatMethod,
  formatPercent,
  formatRate,
  formatRatio,
  formatRelative,
  formatThousands,
  formatTimeOfDay,
  formatTimestamp,
  formatUrlShort,
  formatValue,
  durationBucket,
  percentile,
  safeJson,
  sanitizeId,
  statusClass,
  summarizeNumbers,
  toFiniteNumber,
  truncateEnd,
  truncateMiddle,
  urlPath,
} from '../../extension/ui/lib/format.js';

test('toFiniteNumber：只接受有限数字/数字串', () => {
  assert.equal(toFiniteNumber(12), 12);
  assert.equal(toFiniteNumber('12.5'), 12.5);
  assert.equal(toFiniteNumber('  '), null);
  assert.equal(toFiniteNumber('abc'), null);
  assert.equal(toFiniteNumber(Infinity), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
});

test('formatThousands 与 formatBytes', () => {
  assert.equal(formatThousands(0), '0');
  assert.equal(formatThousands(999), '999');
  assert.equal(formatThousands(1234567), '1,234,567');
  assert.equal(formatThousands(-1234), '-1,234');
  assert.equal(formatThousands('abc'), '?');

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.00 GB');
  assert.equal(formatBytes(-1), '?');
  assert.equal(formatBytes('nope'), '?');
});

test('formatDuration / formatClock 边界', () => {
  assert.equal(formatDuration(0), '0.0ms');
  assert.equal(formatDuration(0.5), '0.5ms');
  assert.equal(formatDuration(42), '42ms');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(12000), '12s');
  assert.equal(formatDuration(60000), '1m00s');
  assert.equal(formatDuration(61000), '1m01s');
  assert.equal(formatDuration(3600000), '1h00m');
  assert.equal(formatDuration(3725000), '1h02m');
  assert.equal(formatDuration(-5), '?');

  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(75), '01:15');
  assert.equal(formatClock(600), '10:00');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(null), '?');
});

test('时间戳格式化使用本地时间且可对齐', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5, 678).getTime();
  assert.equal(formatTimestamp(at), '01-02 03:04:05');
  assert.equal(formatDateTime(at), '2026-01-02 03:04');
  assert.equal(formatTimeOfDay(at), '03:04:05');
  assert.equal(formatTimeOfDay(at, { millis: true }), '03:04:05.678');
  assert.equal(formatTimestamp(null), '?');
  assert.equal(formatTimestamp('not-a-time'), '?');
});

test('相对时间：中英文、过去/未来', () => {
  const now = new Date(2026, 5, 1, 12, 0, 0).getTime();
  assert.equal(formatRelative(now - 1000, now, 'zh'), '刚刚');
  assert.equal(formatRelative(now - 1000, now, 'en'), 'just now');
  assert.equal(formatRelative(now - 5000, now, 'zh'), '5s前');
  assert.equal(formatRelative(now - 5000, now, 'en'), '5s ago');
  assert.equal(formatRelative(now - 120000, now, 'zh'), '2m前');
  assert.equal(formatRelative(now - 7200000, now, 'zh'), '2h前');
  assert.equal(formatRelative(now - 86400000, now, 'zh'), '1d前');
  assert.equal(formatRelative(now + 5000, now, 'zh'), '5s后');
  assert.equal(formatRelative(now + 5000, now, 'en'), 'in 5s');
  assert.equal(formatRelative('bad', now), '?');
});

test('百分比/比率/速率/增量', () => {
  assert.equal(formatPercent(0.256), '25.6%');
  assert.equal(formatPercent(0.5), '50%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(25.6, { ratio: false }), '25.6%');
  assert.equal(formatPercent(0.333, { digits: 2 }), '33.3%');
  assert.equal(formatPercent('nope'), '?');
  assert.equal(formatRatio(3, 8), '3/8');
  assert.equal(formatRatio(0, 0), '—');
  assert.equal(formatRate(12, 1000), '12.0/s');
  assert.equal(formatRate(6, 2000), '3.0/s');
  assert.equal(formatRate(1, 0), '?');
  assert.equal(formatDelta(3), '+3');
  assert.equal(formatDelta(-2), '-2');
  assert.equal(formatDelta(0), '0');
  assert.equal(formatDelta('x'), '?');
});

test('状态分类与 HTTP 文本', () => {
  assert.equal(statusClass(200), 'ok');
  assert.equal(statusClass(204), 'ok');
  assert.equal(statusClass(304), 'redirect');
  assert.equal(statusClass(404), 'client-error');
  assert.equal(statusClass(503), 'server-error');
  assert.equal(statusClass(101), 'info');
  assert.equal(statusClass(null), 'unknown');
  assert.equal(statusClass(500, { error: true }), 'error');
  assert.equal(formatHttpStatus(200), 'HTTP 200');
  assert.equal(formatHttpStatus(null), 'HTTP ?');
});

test('截断/URL/方法名', () => {
  assert.equal(truncateMiddle('abcdefghij', 5), 'abc…j');
  assert.equal(truncateMiddle('abc', 10), 'abc');
  assert.equal(truncateEnd('abcdefghij', 5), '…ghij');
  assert.equal(truncateMiddle('', 5), '');
  assert.equal(formatUrlShort('https://www.example.com/a?b=1'), 'example.com/a?b=1');
  assert.equal(formatUrlShort(''), '');
  assert.equal(urlPath('https://example.com/x/y?z=1'), '/x/y');
  assert.equal(urlPath('not a url'), '');
  assert.equal(urlPath('chrome-extension://abc/ui/debug.html'), '/ui/debug.html');
  assert.equal(formatMethod(' post '), 'POST');
  assert.equal(formatMethod(null), '');
});

test('formatValue / safeJson 对异常输入稳健', () => {
  assert.equal(formatValue(null), '—');
  assert.equal(formatValue(''), '—');
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(false), 'false');
  assert.equal(formatValue([1, 2, 3]), '[3]');
  assert.equal(formatValue({ a: 1 }), '{"a":1}');
  assert.equal(safeJson({ a: 1 }), '{\n  "a": 1\n}');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof safeJson(cyclic), 'string', '循环引用不能抛错');
  assert.equal(safeJson(undefined), undefined);
});

test('durationBucket / percentile / summarizeNumbers', () => {
  assert.equal(durationBucket(10), 'fast');
  assert.equal(durationBucket(50), 'ok');
  assert.equal(durationBucket(500), 'slow');
  assert.equal(durationBucket(5000), 'very-slow');
  assert.equal(durationBucket('x'), 'unknown');

  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.9), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([4, 1, 3, 2], 0), 1);
  assert.equal(percentile([4, 1, 3, 2], 1), 4);
  assert.ok(Math.abs(percentile([1, 2, 3], 0.95) - 2.9) < 1e-9);

  const summary = summarizeNumbers([1, 2, 3]);
  assert.equal(summary.count, 3);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 3);
  assert.equal(summary.median, 2);
  assert.ok(Math.abs(summary.p95 - 2.9) < 1e-9, 'p95=' + summary.p95);
  assert.equal(summary.sum, 6);
  assert.deepEqual(summarizeNumbers([]), { count: 0, min: null, max: null, median: null, p95: null, sum: 0 });
  assert.deepEqual(summarizeNumbers([2, 'x', null, 4], { p95: false }), { count: 2, min: 2, max: 4, median: 3, p95: null, sum: 6 });
});

test('sanitizeId 生成稳定 id', () => {
  assert.equal(sanitizeId('tab 12/x'), 'tab-12-x');
  assert.equal(sanitizeId('a--b'), 'a-b');
  assert.equal(sanitizeId(null), '');
});
