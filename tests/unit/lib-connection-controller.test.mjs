import test from 'node:test';
import assert from 'node:assert/strict';
import { computeConnectedState, ConnectionController } from '../../extension/src/lib/connection-controller.js';

test('computeConnectedState handles compatible, skew and rejected peers', () => {
  assert.deepEqual(computeConnectedState({ protocol_version: '1.9', min_compatible_protocol: '1.6' }), { kind: 'connected' });
  assert.deepEqual(computeConnectedState({ protocol_version: '1.8', min_compatible_protocol: '1.6' }), { kind: 'version_skew' });
  assert.equal(computeConnectedState({ protocol_version: '2.0' }).kind, 'rejected');
  assert.equal(computeConnectedState({ protocol_version: '1.5' }).kind, 'rejected');
});

test('snapshot and subscribe deliver current state', () => {
  const controller = new ConnectionController();
  const seen = [];
  const off = controller.subscribe((snapshot) => seen.push(snapshot.state));
  assert.deepEqual(seen, ['disconnected']);
  controller.setAuditEnabled(true);
  off();
  controller.setLocalAuth({ state: 'paired' });
  assert.equal(seen.length, 1);
  assert.equal(controller.snapshot().extensionVersion.length > 0, true);
});

test('disabling connection updates the snapshot', async () => {
  const controller = new ConnectionController();
  await controller.setConnectionEnabled(false);
  assert.equal(controller.snapshot().connectionEnabled, false);
  assert.equal(controller.isConnectionEnabled, false);
  await controller.setConnectionEnabled(true);
  assert.equal(controller.snapshot().connectionEnabled, true);
});

test('reconfigure stores only the latest configuration', async () => {
  const controller = new ConnectionController();
  const calls = [];
  await controller.reconfigureTransport('a', () => calls.push('a'));
  await controller.reconfigureTransport('a', () => calls.push('a2'));
  assert.deepEqual(calls, []);
  assert.equal(controller.configurationKey, 'a');
});
