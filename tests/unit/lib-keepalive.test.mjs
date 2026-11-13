import test from 'node:test';
import assert from 'node:assert/strict';
import { KEEPALIVE_ALARM_NAME, KEEPALIVE_PERIOD_MIN, startKeepalive } from '../../extension/src/lib/keepalive.js';

function harness({ state = 'disconnected', shouldConnect } = {}) {
  const events = [];
  let handler;
  const alarms = {
    create: (name, info) => events.push(['create', name, info.periodInMinutes]),
    clear: (name) => events.push(['clear', name]),
    onAlarm: { addListener: (cb) => { handler = cb; }, removeListener: () => events.push(['removed']) },
  };
  const transport = { state, async connect() { events.push(['connect']); } };
  const handle = startKeepalive({ transport, alarms, shouldConnect });
  return { handle, events, transport, fire: (name = KEEPALIVE_ALARM_NAME) => handler({ name }) };
}

test('creates alarm and reconnects on tick', async () => {
  const h = harness();
  assert.deepEqual(h.events[0], ['create', KEEPALIVE_ALARM_NAME, KEEPALIVE_PERIOD_MIN]);
  h.fire();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.events[1], ['connect']);
});

test('does not reconnect when already connected', async () => {
  const h = harness({ state: 'connected' });
  await h.handle.tickForTest();
  assert.equal(h.events.some((event) => event[0] === 'connect'), false);
});

test('shouldConnect false skips reconnect', async () => {
  const h = harness({ shouldConnect: () => false });
  await h.handle.tickForTest();
  assert.equal(h.events.some((event) => event[0] === 'connect'), false);
});

test('handles other alarm names and dispose', async () => {
  const h = harness();
  h.fire('other');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events.some((event) => event[0] === 'connect'), false);
  h.handle.dispose();
  assert(h.events.some((event) => event[0] === 'removed'));
  assert(h.events.some((event) => event[0] === 'clear'));
});
