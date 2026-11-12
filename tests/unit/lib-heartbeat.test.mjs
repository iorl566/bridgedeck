import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_EVENT, HEARTBEAT_INTERVAL_MS, startHeartbeat } from '../../extension/src/lib/heartbeat.js';

function harness() {
  let intervalCb;
  let cleared = 0;
  let setCalls = 0;
  let activeCb;
  let unsubscribed = false;
  const frames = [];
  const handle = startHeartbeat({
    send: (frame) => frames.push(frame),
    onActiveChange: (cb) => { activeCb = cb; cb(false); return () => { unsubscribed = true; }; },
    intervalMs: 123,
    timers: {
      setInterval: (cb) => { intervalCb = cb; setCalls += 1; return 1; },
      clearInterval: () => { cleared += 1; },
    },
  });
  return { handle, frames, activate: () => activeCb(true), deactivate: () => activeCb(false), beat: () => intervalCb(), setCalls: () => setCalls, cleared: () => cleared, unsubscribed: () => unsubscribed };
}

test('heartbeat only runs while active', () => {
  const h = harness();
  assert.equal(h.setCalls(), 0);
  h.activate();
  assert.equal(h.setCalls(), 1);
  h.beat();
  assert.deepEqual(h.frames[0], { event: HEARTBEAT_EVENT, payload: {} });
  h.deactivate();
  assert.equal(h.cleared(), 1);
});

test('heartbeat is idempotent while active', () => {
  const h = harness();
  h.activate();
  h.activate();
  assert.equal(h.setCalls(), 1);
});

test('dispose unsubscribes and clears', () => {
  const h = harness();
  h.activate();
  h.handle.dispose();
  assert.equal(h.unsubscribed(), true);
  assert.equal(h.cleared(), 1);
});

test('send failure does not throw', () => {
  const frames = [];
  const handle = startHeartbeat({
    send: () => { throw new Error('closed'); },
    onActiveChange: (cb) => { cb(true); return () => {}; },
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  assert.doesNotThrow(() => handle.beatForTest());
  assert.deepEqual(frames, []);
  handle.dispose();
  assert.equal(HEARTBEAT_INTERVAL_MS, 20000);
});
