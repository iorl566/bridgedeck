import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserVideoHost } from '../../extension/src/video/host.js';

function harness({ has = true, idle = true } = {}) {
  const closed = [];
  let connectCount = 0;
  let disconnected = false;
  const port = {
    onMessage: { addListener(handler) { this.handler = handler; } },
    onDisconnect: { addListener(handler) { this.handler = handler; } },
    postMessage(message) {
      if (message.command.action === 'idle') this.onMessage.handler({ id: message.id, result: idle });
      else this.onMessage.handler({ id: message.id, result: { ok: true, action: message.command.action } });
    },
    disconnect() { disconnected = true; },
  };
  const runtime = {
    id: 'ext',
    connect() { connectCount += 1; return port; },
  };
  const offscreen = {
    async hasDocument() { return has; },
    async createDocument() { connectCount += 0; },
    async closeDocument() { closed.push(true); },
  };
  return { host: new BrowserVideoHost({ runtime, offscreen, timeoutMs: 100 }), closed, port, getConnectCount: () => connectCount, isDisconnected: () => disconnected };
}

test('BrowserVideoHost request connects and resolves', async () => {
  const { host, getConnectCount } = harness();
  const result = await host.request({ action: 'start', recording: {}, image: 'x' });
  assert.deepEqual(result, { ok: true, action: 'start' });
  assert.equal(getConnectCount(), 1);
});

test('BrowserVideoHost closeWhenIdle closes offscreen', async () => {
  const { host, closed, isDisconnected } = harness();
  await host.request({ action: 'stop', recording_id: 'r' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed.length, 1);
  assert.equal(isDisconnected(), true);
});

test('BrowserVideoHost reports timeout', async () => {
  const { host } = harness();
  await host.ensure();
  host.port.postMessage = () => {};
  await assert.rejects(() => host.send({ action: 'frame' }), /did not respond/);
});
