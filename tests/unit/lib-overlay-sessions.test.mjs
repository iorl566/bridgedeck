import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_AGENT_STATE, OVERLAY_MSG_INTERRUPT, OverlayVersionGate, isOverlayAgentStateMessage, isOverlayHostNode } from '../../extension/src/lib/overlay-bridge.js';
import { sendInterrupt } from '../../extension/src/lib/overlay-interrupt-client.js';
import { attachSessionsLiveFlag, SESSIONS_LIVE_FLAG_KEY } from '../../extension/src/lib/sessions-live-flag.js';

test('overlay version gate drops stale and retired epochs', () => {
  const gate = new OverlayVersionGate();
  assert.equal(gate.admit({ epoch: 'e1', generation: 1 }), true);
  assert.equal(gate.admit({ epoch: 'e1', generation: 1 }), true);
  assert.equal(gate.admit({ epoch: 'e1', generation: 0 }), false);
  assert.equal(gate.admit({ epoch: 'e2', generation: 1 }), true);
  assert.equal(gate.admit({ epoch: 'e1', generation: 9 }), false);
});

test('overlay state validation and host node detection', () => {
  assert.equal(isOverlayAgentStateMessage({ type: OVERLAY_AGENT_STATE, sessionId: null, mode: 'hidden', epoch: 'e', generation: 1 }), true);
  assert.equal(isOverlayAgentStateMessage({ type: OVERLAY_AGENT_STATE, sessionId: null, mode: 'bad', epoch: 'e', generation: 1 }), false);
  assert.equal(isOverlayHostNode('bridge-deck-overlay'), true);
  assert.equal(isOverlayHostNode('div', ['data-bb-overlay']), true);
  assert.equal(isOverlayHostNode('div', ['class']), false);
});

test('sendInterrupt resolves only explicit ok', async () => {
  assert.deepEqual(await sendInterrupt(async (req) => (req.kind === OVERLAY_MSG_INTERRUPT ? { ok: true } : { ok: false }), 's1'), { ok: true });
  assert.deepEqual(await sendInterrupt(async () => undefined, 's1'), { ok: false });
  assert.deepEqual(await sendInterrupt(async () => { throw new Error('x'); }, 's1'), { ok: false });
  assert.deepEqual(await sendInterrupt(() => new Promise(() => {}), 's1', { timeoutMs: 5 }), { ok: false });
});

test('sessions live flag writes once and clears', async () => {
  const writes = [];
  const storage = {
    async setAccessLevel() {},
    async set(items) { writes.push(['set', items]); },
    async remove(key) { writes.push(['remove', key]); },
  };
  const manager = { list: () => [] };
  const flag = attachSessionsLiveFlag({ manager, storage });
  await flag.refresh();
  assert.deepEqual(writes, [['remove', SESSIONS_LIVE_FLAG_KEY]]);
  manager.list = () => [{ sessionId: 's1' }];
  await flag.syncFromManager();
  assert.deepEqual(writes[1], ['set', { [SESSIONS_LIVE_FLAG_KEY]: true }]);
  await flag.syncFromManager();
  assert.equal(writes.length, 2);
});
