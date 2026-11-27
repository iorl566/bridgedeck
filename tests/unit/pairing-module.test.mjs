import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authKeyId } from '../../lib/auth-challenge.mjs';
import { createDeviceStore } from '../../lib/device-store.mjs';
import { createPairingModule } from '../../daemon/pairing.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-pairing-unit-'));
  const deviceStore = createDeviceStore(path.join(dir, 'devices.json'));
  const instances = new Map();
  const module = createPairingModule({
    deviceStore,
    getInstances: () => instances.values(),
    dropInstance: (instance) => instances.delete(instance.instanceId),
    log: () => {},
    BridgeError: TestBridgeError,
    wsUrlFor: (host) => 'ws://' + (host || '127.0.0.1') + ':52900/ws',
    authKeyId,
    pairTtlMs: 60_000,
  });
  return { dir, module, deviceStore, instances };
}

test('pair create/list/redeem 基本流程', () => {
  const { dir, module } = makeModule();
  try {
    const created = module.create({ label: 'unit', ttlMs: 60_000 });
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    assert.match(created.token, /^[0-9a-f]{32}$/);
    assert.equal(created.link, created.url + '#' + created.token);
    const listed = module.list({ bind: '127.0.0.1', strict: false });
    assert.equal(listed.pairings.length, 1);
    assert.equal(listed.bind, '127.0.0.1');
    const redeemed = module.redeem({ code: created.code });
    assert.equal(redeemed.token, created.token);
    assert.match(redeemed.proof, /^[0-9a-f]{64}$/);
    assert.equal(module.findByToken(created.token).code, created.code);
    assert.equal(module.scopeForToken(created.token), 'control');
    assert.equal(module.validToken(created.token), true);
    assert.equal(module.consume(created.code), true);
    assert.equal(module.findByToken(created.token), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redeem 无效码抛 E_PAIR_INVALID，连续 5 次清空 pending', () => {
  const { dir, module } = makeModule();
  try {
    const created = module.create({ ttlMs: 60_000 });
    assert.throws(() => module.redeem({ code: 'ZZZZZZ' }), (error) => error.code === 'E_PAIR_INVALID');
    for (let index = 0; index < 4; index += 1) assert.throws(() => module.redeem({ code: 'ZZZZZZ' }));
    assert.equal(module.findByToken(created.token), null, '5 次失败后应清空 pending 码');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renew 返回 pending rotation；revoke 按设备踢连接', () => {
  const { dir, module, deviceStore, instances } = makeModule();
  try {
    const token = 'a'.repeat(32);
    deviceStore.remember(token, { label: 'dev', browser: 'edge', browserId: 'bid-1', instanceId: 'i1', scope: 'control' });
    const device = deviceStore.list()[0];
    const renewed = module.renew({ deviceId: device.deviceId });
    assert.equal(renewed.pending, true);
    assert.match(renewed.txn, /^[0-9a-f]{16}$/);
    assert.equal(renewed.link, renewed.url + '#' + renewed.token);
    deviceStore.commitRotation(renewed.token, renewed.txn);
    const instance = { instanceId: 'i1', remote: true, pairToken: renewed.token, browser: 'edge', connectedAt: 1, scope: 'control', conn: { close: () => {} } };
    instances.set('i1', instance);
    const revoked = module.revoke({ deviceId: device.deviceId });
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.kicked, 1);
    assert.equal(instances.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list 只暴露 remote 实例与设备公开字段', () => {
  const { dir, module, deviceStore, instances } = makeModule();
  try {
    deviceStore.remember('b'.repeat(32), { label: 'dev2', browser: 'chrome', instanceId: 'i2' });
    instances.set('i-local', { instanceId: 'i-local', remote: false });
    instances.set('i-remote', { instanceId: 'i-remote', remote: true, browser: 'edge', browserVersion: '1', connectedAt: 2, scope: 'read' });
    const listed = module.list({ bind: '0.0.0.0', strict: true });
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].localAuth, 'remote-paired');
    assert.equal(listed.strict, true);
    assert.equal(listed.knownDevices.length, 1);
    assert.equal(listed.knownDevices[0].token, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
