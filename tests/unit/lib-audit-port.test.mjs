import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_MESSAGE, auditRequest, getAuditEnabled, openAuditPage } from '../../extension/src/lib/audit.js';
import { watchDaemonPort } from '../../extension/src/lib/daemon-port-preference.js';

test('auditRequest unwraps data and errors', async () => {
  assert.equal(await auditRequest('state', {}, { async sendMessage(msg) { assert.equal(msg.kind, AUDIT_MESSAGE); return { ok: true, data: 1 }; } }), 1);
  await assert.rejects(() => auditRequest('state', {}, { async sendMessage() { return { ok: false, error: 'no' }; } }), /no/);
});

test('getAuditEnabled and openAuditPage', async () => {
  assert.equal(await getAuditEnabled({ async get() { return { [('bb_audit_enabled')]: true }; } }), true);
  const created = [];
  openAuditPage('run1', { runtime: { getURL: (path) => `chrome-extension://x/${path}` }, tabs: { async create(opts) { created.push(opts.url); } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(created[0], /audit\.html\?id=run1/);
});

test('watchDaemonPort prefers a late change over the initial read', async () => {
  const listeners = [];
  const ports = [];
  let resolveRead;
  const storage = { onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => {} } };
  const watcher = watchDaemonPort((port) => ports.push(port), {
    storage,
    key: 'bb_daemon_port',
    normalizePort: (value) => Number(value) || 52900,
    getPort: () => new Promise((resolve) => { resolveRead = resolve; }),
  });
  listeners[0]({ bb_daemon_port: { newValue: '53001' } }, 'local');
  resolveRead(52900);
  await watcher.ready;
  assert.deepEqual(ports, [53001]);
  watcher.dispose();
});

test('watchDaemonPort uses initial read without changes', async () => {
  const ports = [];
  const storage = { onChanged: { addListener() {}, removeListener() {} } };
  const watcher = watchDaemonPort((port) => ports.push(port), {
    storage,
    key: 'bb_daemon_port',
    normalizePort: (value) => Number(value),
    getPort: async () => 52903,
  });
  await watcher.ready;
  assert.deepEqual(ports, [52903]);
});
