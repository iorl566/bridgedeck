import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceV2 } from '../../extension/src/lib/recording/trace-reducer-v2.js';

test('collapses consecutive navigations and builds page registry', () => {
  const trace = buildTraceV2({
    startedAt: 'x',
    startUrl: 'https://a',
    steps: [
      { op: 'navigate', url: 'https://b' },
      { op: 'navigate', url: 'https://c' },
      { op: 'click', captureTarget: { tag: 'a' }, pageUrl: 'https://c', navigatedTo: 'https://d' },
    ],
  });
  assert.deepEqual(trace.pages.map((page) => page.url), ['https://a', 'https://c', 'https://d']);
  assert.equal(trace.steps.length, 2);
  assert.equal(trace.steps[0].to, 'https://c');
  assert.deepEqual(trace.steps[1].effect, { navigated_to: 'p3' });
});

test('fill and select keep their payloads', () => {
  const trace = buildTraceV2({
    startedAt: 'x',
    steps: [
      { op: 'fill', captureTarget: { tag: 'input' }, value: 'v', redacted: true },
      { op: 'select', captureTarget: { tag: 'select' }, values: ['a'], labels: ['A'] },
    ],
  });
  assert.equal(trace.steps[0].redacted, true);
  assert.deepEqual(trace.steps[1].selection, [{ value: 'a', label: 'A' }]);
});

test('hover/scroll/switch_tab are omitted from v2', () => {
  const trace = buildTraceV2({ startedAt: 'x', steps: [{ op: 'hover', captureTarget: {} }, { op: 'scroll' }, { op: 'switch_tab' }] });
  assert.equal(trace.steps.length, 0);
});

test('start url fallback and purpose', () => {
  const trace = buildTraceV2({ startedAt: 'x', purpose: 'p', steps: [{ op: 'click', captureTarget: {}, pageUrl: 'https://a' }] });
  assert.equal(trace.entry.start_url, 'https://a');
  assert.equal(trace.purpose, 'p');
  assert.equal(trace.pages[0].id, 'p1');
});
