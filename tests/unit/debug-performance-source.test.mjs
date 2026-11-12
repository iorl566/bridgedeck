import test from 'node:test';
import assert from 'node:assert/strict';
import { interruptPerformance, PERFORMANCE_METRICS, performanceSnapshot } from '../../extension/src/debug/performance.js';

const valid = {
  document_key: '1.5:1000', time_origin: 100, started_at: 100, observed_at: 200,
  url: 'https://site.test/?token=secret', navigation: 'navigate', state: 'capturing', early: true,
  metrics: { lcp_ms: { state: 'provisional', value: 120, reasons: ['early'] }, cls: { state: 'available', value: 0.1, reasons: [] } },
  visibility: [{ at: 100, state: 'visible' }, { at: 150, state: 'bad' }],
  long_tasks: [{ at: 120, duration_ms: 60 }], coverage: ['x'],
};

test('performanceSnapshot validates and redacts', () => {
  const snapshot = performanceSnapshot(valid);
  assert.equal(snapshot.scope, 'main_frame');
  assert.equal(snapshot.url.includes('secret'), false);
  assert.equal(snapshot.visibility.length, 1);
  assert.equal(snapshot.metrics.lcp_ms.state, 'provisional');
  assert.equal(snapshot.long_tasks.length, 1);
  assert.equal(PERFORMANCE_METRICS.length, 9);
  assert.equal(performanceSnapshot({ ...valid, url: 'file:///x' }), undefined);
  assert.equal(performanceSnapshot({ ...valid, document_key: 'bad' }), undefined);
});

test('interruptPerformance marks provisional metrics partial', () => {
  const entry = {
    state: 'capturing', coverage: [],
    metrics: { lcp_ms: { state: 'provisional', reasons: [] }, cls: { state: 'available', reasons: [] } },
  };
  interruptPerformance(entry, 'browser_restarted');
  assert.equal(entry.state, 'interrupted');
  assert.equal(entry.metrics.lcp_ms.state, 'partial');
  assert.equal(entry.metrics.lcp_ms.reasons.includes('browser_restarted'), true);
  assert.equal(entry.metrics.cls.state, 'available');
  assert.equal(entry.coverage.includes('browser_restarted'), true);
});
