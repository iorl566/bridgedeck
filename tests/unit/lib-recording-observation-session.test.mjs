import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingObservationSession } from '../../extension/src/lib/recording/observation-session.js';

function captured() {
  return { rootFrameId: 'root', url: 'https://x', title: 'X', vomText: 'body', truncated: false, index: { ref: () => ({ line: 3 }) } };
}

test('capture registers state and updates cursor', async () => {
  const session = new RecordingObservationSession({ now: () => 100000, cursor: { lastSettled: null, lastCaptureAt: 0 }, deps: { capture: async () => captured() } });
  const observation = await session.capture({}, {}, 1);
  assert.equal(observation.stateId, 's1');
  assert.equal(session.registry.values()[0].url, 'https://x');
  assert.equal(session.cursor.lastSettled, observation);
});

test('bindDraft matches target and annotates fill', () => {
  const session = new RecordingObservationSession({
    cursor: { lastSettled: { stateId: 's1', rootFrameId: 'root', url: 'u', index: { ref: () => ({ line: 3 }), refs: () => [], candidates: () => [] } }, lastCaptureAt: 0 },
  });
  const draft = { op: 'fill', value: 'v', captureTarget: { tag: 'input', name: 'N' } };
  session.bindDraft(draft, 1);
  assert.equal(draft.preStateId, 's1');
  assert.equal(draft.matchedTarget.ref, undefined);
  assert.equal(session.annotations.length, 0);
});

test('unmatched pending draft does not bind state', () => {
  const session = new RecordingObservationSession({
    cursor: { lastSettled: { stateId: 's1', rootFrameId: 'root', url: 'u', index: { ref: () => undefined, refs: () => [], candidates: () => [] } }, lastCaptureAt: 0 },
  });
  const draft = { op: 'click', captureTarget: { tag: 'button' } };
  session.bindDraft(draft, 1, true);
  assert.equal(draft.preStateId, undefined);
  assert.equal(session.annotations.length, 0);
});
