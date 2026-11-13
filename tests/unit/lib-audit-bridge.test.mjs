import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAuditBridge, auditRpc, isAuditPage } from '../../extension/src/lib/audit-bridge.js';
import { AUDIT_MESSAGE } from '../../extension/src/lib/audit.js';

function transportHarness(mode = 'ok') {
  const listeners = [];
  const stateListeners = [];
  let sent;
  return {
    sent: () => sent,
    transport: {
      send(message) {
        sent = message;
        if (mode === 'throw') throw new Error('closed');
        if (mode === 'ok') queueMicrotask(() => listeners.forEach((fn) => fn({ id: message.id, result: 42 })));
        if (mode === 'error') queueMicrotask(() => listeners.forEach((fn) => fn({ id: message.id, error: { code: 'x' } })));
        if (mode === 'disconnect') queueMicrotask(() => stateListeners.forEach((fn) => fn('disconnected')));
      },
      onMessage(fn) { listeners.push(fn); return { dispose: () => listeners.splice(listeners.indexOf(fn), 1) }; },
      onConnectionStateChange(fn) { stateListeners.push(fn); return { dispose: () => stateListeners.splice(stateListeners.indexOf(fn), 1) }; },
    },
  };
}

test('auditRpc resolves matching result', async () => {
  const h = transportHarness();
  const value = await auditRpc(h.transport, { action: 'state' });
  assert.equal(value, 42);
  assert.equal(h.sent().method, 'audit.request');
});

test('auditRpc maps error frames to request_failed', async () => {
  await assert.rejects(() => auditRpc(transportHarness('error').transport, {}), /request_failed/);
});

test('auditRpc rejects disconnected or throw', async () => {
  await assert.rejects(() => auditRpc(transportHarness('disconnect').transport, {}), /disconnected/);
  await assert.rejects(() => auditRpc(transportHarness('throw').transport, {}), /disconnected/);
});

test('isAuditPage validates extension origin and paths', () => {
  const runtime = { id: 'ext', getURL: (path) => `chrome-extension://ext${path}` };
  assert.equal(isAuditPage({ id: 'ext', url: 'chrome-extension://ext/audit.html' }, runtime), true);
  assert.equal(isAuditPage({ id: 'ext', url: 'chrome-extension://ext/popup.html' }, runtime), true);
  assert.equal(isAuditPage({ id: 'ext', url: 'chrome-extension://ext/options.html' }, runtime), false);
  assert.equal(isAuditPage({ id: 'other', url: 'chrome-extension://ext/audit.html' }, runtime), false);
});

test('attachAuditBridge answers state and removes its listener', async () => {
  const previous = globalThis.chrome;
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      id: 'ext',
      getURL: (path) => `chrome-extension://ext${path}`,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
      },
    },
    storage: { local: { async get() { return { bb_audit_enabled: true }; }, async set() {}, async remove() {} } },
  };
  const controller = {
    handshake: null,
    subscribe(fn) { this.listener = fn; },
    snapshot() { return { handshake: { audit_version: 1 }, connectionEnabled: true }; },
    setAuditEnabled(enabled) { this.enabled = enabled; },
  };
  const transport = {
    send() {},
    onMessage() { return { dispose() {} }; },
    onConnectionStateChange() { return { dispose() {} }; },
  };
  try {
    const dispose = attachAuditBridge(controller, transport);
    const reply = await new Promise((resolve) => {
      listeners[0]({ kind: AUDIT_MESSAGE, action: 'state' }, { id: 'ext', url: 'chrome-extension://ext/audit.html' }, resolve);
    });
    assert.deepEqual(reply, { ok: true, data: { enabled: true } });
    dispose();
    assert.equal(listeners.length, 0);
  } finally {
    globalThis.chrome = previous;
  }
});
