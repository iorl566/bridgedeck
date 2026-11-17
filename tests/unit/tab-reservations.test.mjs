import test from 'node:test';
import assert from 'node:assert/strict';
import { TabReservations } from '../../lib/tab-reservations.mjs';

test('tab reservations reject a second owner until release/transfer', () => {
  const tabs = new TabReservations();
  assert.deepEqual(tabs.reserve(7, 'request-a'), { ok: true, owner: 'request-a' });
  const conflict = tabs.reserve(7, 'request-b');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.owner, 'request-a');
  assert.equal(tabs.transfer(7, 'request-a', 'session-a'), true);
  assert.equal(tabs.owner(7), 'session-a');
  assert.equal(tabs.release(7, 'request-b'), false);
  assert.equal(tabs.release(7, 'session-a'), true);
  assert.equal(tabs.owner(7), undefined);
  assert.equal(tabs.reserve(7, 'request-b').ok, true);
});

test('bad tab ids never create a reservation', () => {
  const tabs = new TabReservations();
  assert.deepEqual(tabs.reserve('nope', 'x'), { ok: false, reason: 'bad_tab' });
  assert.deepEqual(tabs.snapshot(), []);
});
