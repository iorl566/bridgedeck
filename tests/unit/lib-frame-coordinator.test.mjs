import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordFrameCoordinator } from '../../extension/src/lib/recording/frame-coordinator.js';
import { RECORD_FRAME_QUERY } from '../../extension/src/lib/recording/frame-bridge.js';

function harness() {
  const sent = [];
  const coordinator = new RecordFrameCoordinator({
    async getAllFrames() { return [{ frameId: 0 }, { frameId: 1, documentId: 'd1' }]; },
    async sendToDocument(tabId, message, target) { sent.push([tabId, message, target]); return { ok: true }; },
    subscribeFrameNavigation() { return () => {}; },
  });
  return { coordinator, sent };
}

test('armTab starts every frame and reports root', async () => {
  const { coordinator, sent } = harness();
  coordinator.begin('r1', 100, 7);
  assert.equal(await coordinator.armTab('r1', 7), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][2].frameId, 0);
  assert.equal(sent[1][2].documentId, 'd1');
  assert.deepEqual(coordinator.query(7), { active: true, requestId: 'r1', startedAtMs: 100 });
});

test('registerAgent/sourceFor validates producer and sender', () => {
  const { coordinator } = harness();
  coordinator.begin('r1', 100, 7);
  const agent = { tabId: 7, documentId: 'd1', browserFrameId: 1, producerId: 'p1', port: { postMessage() {} }, stopWaiters: new Map() };
  assert.equal(coordinator.registerAgent('r1', agent), true);
  assert.deepEqual(coordinator.sourceFor('r1', 'p1', { tab: { id: 7 }, documentId: 'd1', frameId: 1 }), { tabId: 7, documentId: 'd1', browserFrameId: 1, producerId: 'p1' });
  assert.equal(coordinator.sourceFor('r1', 'bad', { tab: { id: 7 }, documentId: 'd1', frameId: 1 }), null);
  assert.equal(coordinator.sourceFor('r1', 'p1', { tab: { id: 8 }, documentId: 'd1', frameId: 1 }), null);
});

test('stop/cancel manage recording lifecycle', async () => {
  const { coordinator } = harness();
  coordinator.begin('r1', 100, 7);
  assert.equal(await coordinator.stop('r1'), true);
  assert.equal(coordinator.query(7).active, false);
  coordinator.begin('r2', 100, 7);
  coordinator.cancel('r2');
  assert.equal(coordinator.query(7).active, false);
});

test('query messages answer for the sending tab only', () => {
  const { coordinator } = harness();
  coordinator.begin('r1', 100, 7);
  let response;
  assert.equal(coordinator.onMessage({ type: RECORD_FRAME_QUERY }, { tab: { id: 7 } }, (value) => { response = value; }), false);
  assert.deepEqual(response, { active: true, requestId: 'r1', startedAtMs: 100 });
  coordinator.onMessage({ type: RECORD_FRAME_QUERY }, { tab: { id: 8 } }, (value) => { response = value; });
  assert.deepEqual(response, { active: false });
  assert.equal(coordinator.onMessage({ type: 'other' }, { tab: { id: 7 } }, () => {}), false);
});
