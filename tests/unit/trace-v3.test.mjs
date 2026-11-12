import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceV3 } from '../../lib/trace-v3.mjs';

test('buildTraceV3 emits v3 envelope and before/after states', () => {
  const trace = buildTraceV3({
    id: 'r1',
    url: 'https://example.com/',
    title: 'Example',
    startedAt: 1700000000000,
    endedAt: 1700000005000,
    events: [
      { kind: 'click', seq: 1, ts: 1700000001000, selector: '#a', tag: 'button', text: 'Go', observation: 'button "Go" [@e1]' },
      { kind: 'input', seq: 2, ts: 1700000002000, selector: '#kw', tag: 'input', value: 'hello', observation: 'textbox "kw" [@e2]' },
    ],
    finalObservation: { text: 'button "Done" [@e3]', url: 'https://example.com/done', at: 1700000004000 },
  });
  assert.equal(trace.version, 3);
  assert.equal(trace.entry.start_url, 'https://example.com/');
  assert.equal(trace.steps.length, 2);
  assert.equal(trace.steps[0].op, 'click');
  assert.equal(trace.steps[0].target.ref, undefined);
  assert.equal(trace.steps[0].target.role, 'button');
  assert.equal(trace.steps[0].target.name, 'Go');
  assert.equal(trace.steps[1].op, 'fill');
  assert.equal(trace.steps[1].commit, 'blur');
  assert.equal(trace.steps[0].state, 's1');
  assert.equal(trace.steps[0].result.state, 's2');
  assert.equal(trace.steps[1].state, 's2');
  assert.ok(trace.states.length >= 3);
  assert.equal(trace.steps[1].result.state, trace.states[trace.states.length - 1].id);
});

test('buildTraceV3 maps tab/window switch to switch_tab', () => {
  const trace = buildTraceV3({
    url: 'https://example.com/',
    events: [
      { kind: 'tab-switch', ts: 1, url: 'about:blank' },
      { kind: 'window-switch', ts: 2, url: 'about:blank' },
    ],
  });
  assert.deepEqual(trace.steps.map((step) => step.op), ['switch_tab', 'switch_tab']);
});

test('buildTraceV3 marks redacted fill', () => {
  const trace = buildTraceV3({
    url: 'https://example.com/',
    events: [{ kind: 'input', seq: 1, ts: 1, tag: 'input', value: '***', sensitive: true }],
  });
  assert.equal(trace.steps[0].redacted, true);
  assert.equal(trace.steps[0].value, '***');
});
