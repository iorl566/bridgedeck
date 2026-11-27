import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionRecord, markSessionDisconnected, markSessionRestored, rebindSessionRecord, setSessionPaused,
} from '../../lib/session-lifecycle.mjs';

test('createSessionRecord normalizes defaults', () => {
  const session = createSessionRecord({ sessionId: 's1', instanceId: 'i1', tabId: 1, startedAt: 1000 });
  assert.equal(session.sessionId, 's1');
  assert.equal(session.borrowed, false);
  assert.equal(session.connected, true);
  assert.equal(session.paused, false);
  assert.equal(session.startedAt, 1000);
  // 共享 tab 的控制模式默认 open，且只有合法值会被保留。
  assert.equal(session.controlMode, 'open');
  assert.equal(createSessionRecord({ sessionId: 's2', instanceId: 'i1', tabId: 1, controlMode: 'exclusive' }).controlMode, 'exclusive');
  assert.equal(createSessionRecord({ sessionId: 's3', instanceId: 'i1', tabId: 1, controlMode: 'nope' }).controlMode, 'open');
});

test('disconnect and restore update connection state', () => {
  const session = createSessionRecord({ sessionId: 's1', instanceId: 'i1', tabId: 1 });
  markSessionDisconnected(session, 2000);
  assert.equal(session.connected, false);
  assert.equal(session.disconnectedAt, 2000);
  markSessionRestored(session);
  assert.equal(session.connected, true);
  assert.equal(session.restored, true);
});

test('rebind and pause update fields', () => {
  const session = createSessionRecord({ sessionId: 's1', instanceId: 'i1', tabId: 1 });
  rebindSessionRecord(session, { instanceId: 'i2', tabId: 2, windowId: 3, url: 'https://x/', title: 'x' });
  assert.equal(session.instanceId, 'i2');
  assert.equal(session.tabId, 2);
  assert.equal(session.borrowed, true);
  assert.equal(session.disconnectedAt, 0);
  assert.equal(setSessionPaused(session, true), true);
  assert.equal(session.paused, true);
});
