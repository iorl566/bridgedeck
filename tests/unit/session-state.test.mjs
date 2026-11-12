import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionState } from '../../lib/session-state.mjs';

test('session state follows starting -> active -> stopping -> gone', () => {
  const state = createSessionState();
  state.begin('s1');
  assert.equal(state.phase('s1'), 'starting');
  state.activate('s1');
  assert.equal(state.phase('s1'), 'active');
  assert.equal(state.requestStop('s1'), true);
  assert.equal(state.phase('s1'), 'stopping');
  assert.equal(state.requestStop('s1'), false);
  state.finish('s1');
  assert.equal(state.get('s1'), null);
});

test('duplicate start is rejected while starting or active', () => {
  const state = createSessionState();
  state.begin('s1');
  assert.throws(() => state.begin('s1'), (error) => error.code === 'E_SESSION_BUSY');
  state.activate('s1');
  assert.throws(() => state.begin('s1'), /E_SESSION_BUSY|已经在启动/);
  state.finish('s1');
  state.begin('s1');
  assert.equal(state.phase('s1'), 'starting');
});

test('recovering sessions can be activated and listed', () => {
  const state = createSessionState();
  state.recover('s2');
  assert.equal(state.phase('s2'), 'recovering');
  state.activate('s2');
  const list = state.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, 's2');
  assert.equal(list[0].phase, 'active');
});
