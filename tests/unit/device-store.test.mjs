import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDeviceStore, deviceIdForToken } from '../../lib/device-store.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-device-store-'));
  return { dir, file: path.join(dir, 'devices.json') };
}

test('remember 后 verify/touch/list，token 不进入 list', () => {
  const { dir, file } = tempFile();
  const store = createDeviceStore(file);
  const saved = store.remember('token-a', { label: 'Work', browser: 'edge', instanceId: 'aaa', scope: 'read' });
  assert.equal(saved.deviceId, deviceIdForToken('token-a'));
  assert.equal(store.verify('token-a'), true);
  assert.equal(saved.scope, 'read');
  assert.equal(store.scopeForToken('token-a'), 'read');
  assert.equal(store.verify('token-b'), false);
  assert.equal(store.secretForKeyId(saved.deviceId + '0000'), null);
  store.touch('token-a', { instanceId: 'bbb', label: 'Work 2' });
  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].instanceId, 'bbb');
  assert.equal(list[0].label, 'Work 2');
  assert.equal(list[0].scope, 'read');
  assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'token'), false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /token-a/); // 文件内是恢复 HMAC 必需的明文，list 不外泄
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重启后仍能 verify，同一 token 更新而不是重复', () => {
  const { dir, file } = tempFile();
  const a = createDeviceStore(file);
  a.remember('token-a', { label: 'A', instanceId: 'one' });
  const b = createDeviceStore(file);
  assert.equal(b.verify('token-a'), true);
  b.remember('token-a', { label: 'A2', instanceId: 'two' });
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].instanceId, 'two');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('secretForKeyId 只对已记住 token 生效，撤销后失效', () => {
  const { dir, file } = tempFile();
  const store = createDeviceStore(file);
  const saved = store.remember('token-a', {});
  const keyId = crypto.createHash('sha256').update('token-a').digest('hex').slice(0, 32);
  assert.equal(store.secretForKeyId(keyId), 'token-a');
  assert.equal(store.revoke(saved.deviceId).revoked, true);
  assert.equal(store.verify('token-a'), false);
  assert.equal(store.secretForKeyId(keyId), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏文件按空设备表处理', () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, '{not json', 'utf8');
  const store = createDeviceStore(file);
  assert.equal(store.list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
