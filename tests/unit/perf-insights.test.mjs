import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePerformance } from '../../lib/perf-insights.mjs';

test('性能指标转成结论', () => {
  const findings = analyzePerformance({ ttfb: 1200, domContentLoaded: 2500, load: 4000, lcp: 3000, cls: 0.2, longTasks: { count: 7, maxMs: 120 }, resources: { count: 200, transferBytes: 3 * 1024 * 1024 } });
  const codes = findings.map((item) => item.code);
  for (const code of ['TTFB', 'DCL', 'LOAD', 'LCP', 'CLS', 'LONG_TASK', 'BYTES', 'REQUESTS']) assert.ok(codes.includes(code), code);
});

test('指标正常时给 ok', () => {
  const findings = analyzePerformance({ ttfb: 100, domContentLoaded: 300, load: 500, lcp: 800, cls: 0.01, longTasks: { count: 0, maxMs: 0 }, resources: { count: 5, transferBytes: 1000 } });
  assert.equal(findings[0].code, 'OK');
});
