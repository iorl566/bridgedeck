import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingObservationRuntime } from '../../extension/src/lib/recording/recording-runtime.js';

function harness() {
  const calls = [];
  const session = {
    cursor: { lastSettled: null, lastCaptureAt: 0 },
    registry: { markStep: (...args) => calls.push(['mark', ...args]) },
    async capture() { calls.push(['capture']); session.cursor.lastSettled = { stateId: 's1', url: 'u', index: { documentScope: () => undefined } }; return session.cursor.lastSettled; },
    bindDraft(draft, id, pending) { calls.push(['bind', draft.op, id, pending]); },
  };
  const settle = {
    hasPending: false,
    schedule(drafts, index) { calls.push(['schedule', index]); },
    cancel() {},
    async flush() {},
    async flushRedirects() {},
    async settleTrailing() {},
  };
  const runtime = new RecordingObservationRuntime({
    cdp: {},
    tabsApi: {},
    deps: { createSession: () => session, createSettle: () => settle },
  });
  return { runtime, session, settle, calls };
}

test('captureInitial captures once', async () => {
  const h = harness();
  await h.runtime.captureInitial(7);
  await h.runtime.captureInitial(7);
  assert.equal(h.calls.filter((call) => call[0] === 'capture').length, 1);
});

test('processDraft binds and schedules', async () => {
  const h = harness();
  const drafts = [{ op: 'click' }];
  await h.runtime.processDraft(7, drafts, 0);
  assert(h.calls.some((call) => call[0] === 'bind' && call[1] === 'click' && call[2] === 1));
  assert.deepEqual(h.calls.find((call) => call[0] === 'schedule'), ['schedule', 0]);
});

test('cancel blocks further capture authorization', async () => {
  let allowed = true;
  const h = harness();
  const runtime = new RecordingObservationRuntime({ cdp: {}, tabsApi: {}, isTabAllowed: () => allowed, deps: { createSession: () => h.session, createSettle: () => h.settle } });
  allowed = false;
  assert.throws(() => runtime.check(7), /no longer authorized/);
  runtime.cancel();
  assert.throws(() => runtime.check(7), /no longer authorized/);
});
