import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceTraceStepsV3 } from '../../extension/src/lib/recording/trace-reducer-v3.js';
import { buildTraceV3 } from '../../extension/src/lib/recording/trace-builder-v3.js';
import { RecordingStateRegistry } from '../../extension/src/lib/recording/state-registry.js';

test('reducer maps causes and collapses redirects', () => {
  const result = reduceTraceStepsV3([
    { op: 'navigate', url: 'https://a', preStateId: 's1', postStateId: 's2', transitionType: 'link' },
    { op: 'navigate', url: 'https://b', preStateId: 's2', postStateId: 's3', transitionType: 'link', transitionQualifiers: ['server_redirect'] },
  ]);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].to, 'https://b');
  assert.equal(result.steps[0].cause, 'link');
  assert.equal(result.stepIdByDraftId.get(1), 1);
  assert.equal(result.stepIdByDraftId.get(2), 1);
});

test('reducer redacts fill/select values', () => {
  const result = reduceTraceStepsV3([
    { op: 'fill', preStateId: 's1', postStateId: 's2', value: 'secret', captureTarget: { tag: 'input' } },
    { op: 'select', preStateId: 's2', postStateId: 's3', values: ['a'], labels: ['A'], captureTarget: { tag: 'select' } },
  ], { redactValues: true });
  assert.equal(result.steps[0].value, '***');
  assert.equal(result.steps[0].redacted, true);
  assert.equal('selection' in result.steps[1], false);
});

test('press and switch_tab options', () => {
  const result = reduceTraceStepsV3([
    { op: 'press', preStateId: 's1', postStateId: 's2', key: 'Enter' },
    { op: 'switch_tab', preStateId: 's2', postStateId: 's3' },
  ], { includeTabSwitches: true });
  assert.equal(result.steps[0].op, 'press');
  assert.equal(result.steps[1].op, 'switch_tab');
});

test('builder publishes referenced states and remaps step ids', () => {
  const registry = new RecordingStateRegistry();
  const s1 = registry.register({ url: 'https://a', vomText: 'a' });
  const s2 = registry.register({ url: 'https://b', vomText: 'b' });
  registry.markStep(s1.id, 1);
  const trace = buildTraceV3({
    registry,
    drafts: [
      { op: 'click', preStateId: s1.id, postStateId: s2.id, captureTarget: { tag: 'button', name: 'Go' } },
      { op: 'navigate', url: 'https://b', preStateId: s2.id, postStateId: s2.id, transitionType: 'link' },
    ],
    annotations: [{ stateId: s1.id, draftId: 1, line: 0, op: 'click', detail: 'Go' }],
    startedAt: '2026-01-01T00:00:00.000Z',
    startUrl: 'https://a',
    stoppedBy: 'user',
    cliVersion: '0.1',
  });
  assert.equal(trace.version, 3);
  assert.equal(trace.entry.start_url, 'https://a');
  assert.equal(trace.states.length, 2);
  assert.equal(trace.steps[0].state, 's1');
  assert.equal(trace.steps[0].result.state, 's2');
  assert.match(trace.states[0].body, /↳ step 1: click: Go/);
});

test('builder with no steps keeps the first state', () => {
  const registry = new RecordingStateRegistry();
  registry.register({ url: 'https://a', vomText: 'a' });
  registry.register({ url: 'https://b', vomText: 'b' });
  const trace = buildTraceV3({ registry, drafts: [], startedAt: 'x', stoppedBy: 'user', cliVersion: '0.1' });
  assert.equal(trace.states.length, 1);
  assert.equal(trace.steps.length, 0);
  assert.equal(trace.entry.start_url, 'https://a');
});
