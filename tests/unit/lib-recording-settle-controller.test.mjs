import test from 'node:test';
import assert from 'node:assert/strict';
import { inferMissingPostStates, SettleController } from '../../extension/src/lib/recording/settle-controller.js';

function harness() {
  const marks = [];
  const session = {
    cursor: { lastSettled: { stateId: 's1', url: 'https://a' }, lastCaptureAt: 0 },
    registry: { markStep: (state, id) => marks.push([state, id]) },
    async capture() { return { stateId: 's2' }; },
  };
  const controller = new SettleController({
    session,
    cdp: {},
    tabsApi: { async get() { return { url: 'https://b' }; } },
    tabId: 7,
    deps: { waitForSettle: async () => 'quiet' },
  });
  return { controller, session, marks };
}

test('inferMissingPostStates fills gaps', () => {
  const drafts = [{ preStateId: 's1' }, { preStateId: 's2', postStateId: 's3' }, { preStateId: 's3' }];
  inferMissingPostStates(drafts);
  assert.equal(drafts[0].postStateId, 's2');
  assert.equal(drafts[1].postStateId, 's3');
});

test('schedule captures post state', async () => {
  const h = harness();
  const drafts = [{ preStateId: 's1' }];
  h.controller.schedule(drafts, 0);
  await h.controller.flush();
  assert.equal(drafts[0].postStateId, 's2');
  assert.equal(h.controller.hasPending, false);
});

test('newer schedule cancels older and backfills landing', async () => {
  const h = harness();
  const drafts = [{ preStateId: 's1' }, { preStateId: 's2' }];
  h.controller.schedule(drafts, 0);
  h.controller.schedule(drafts, 1);
  await h.controller.flush();
  assert.equal(drafts[0].postStateId, 's2');
  assert.equal(drafts[1].postStateId, 's2');
});

test('redirect schedules a navigate draft', async () => {
  const h = harness();
  const drafts = [];
  h.controller.scheduleRedirect(drafts, 'https://b');
  await h.controller.flushRedirects();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].op, 'navigate');
  assert.equal(drafts[0].url, 'https://b');
  assert.deepEqual(h.marks[0], ['s1', 1]);
});
