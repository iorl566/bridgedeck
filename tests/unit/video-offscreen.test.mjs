import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVideoOffscreen } from '../../extension/src/video/offscreen.js';

function harness() {
  const connectHandlers = [];
  const runtime = {
    id: 'ext',
    onConnect: {
      addListener(handler) { connectHandlers.push(handler); },
      removeListener() {},
    },
    async sendMessage() {},
  };
  const workerListeners = new Map();
  const sent = [];
  const worker = {
    addEventListener(type, handler) { workerListeners.set(type, handler); },
    removeEventListener() {},
    postMessage(message) {
      sent.push(message);
      if (message.command.action === 'frame' || message.command.action === 'stop' || message.command.action === 'idle') {
        queueMicrotask(() => workerListeners.get('message')?.({ data: { id: message.id, result: message.command.action === 'idle' ? true : { ok: true } } }));
      }
    },
    terminate() {},
  };
  const store = {
    async get() { return { state: 'ready' }; },
    async file() { return new Blob(['x']); },
  };
  const urlApi = { createObjectURL: () => 'blob:video', revokeObjectURL() {} };
  const messageHandlers = [];
  const replies = [];
  const port = {
    name: 'bb/video-host',
    sender: { id: 'ext' },
    onMessage: { addListener(handler) { messageHandlers.push(handler); }, removeListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) { replies.push(message); },
  };
  const cleanup = attachVideoOffscreen({ runtime, createWorker: () => worker, store, urlApi });
  connectHandlers[0](port);
  return { worker, sent, replies, handler: messageHandlers[0], cleanup };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('download_url and revoke_url manage object URLs', async () => {
  const { handler, replies } = harness();
  handler({ id: '1', command: { action: 'download_url', recording_id: 'r' } });
  await tick();
  assert.equal(replies[0].result, 'blob:video');
  handler({ id: '2', command: { action: 'idle' } });
  await tick();
  assert.equal(replies[1].result, false);
  handler({ id: '3', command: { action: 'revoke_url', url: 'blob:video' } });
  await tick();
  handler({ id: '4', command: { action: 'idle' } });
  await tick();
  assert.equal(replies.find((reply) => reply.id === '4').result, true);
});

test('worker command forwards and replies', async () => {
  const { handler, replies, sent } = harness();
  handler({ id: '5', command: { action: 'frame', recording_id: 'r', image: 'x', elapsed_ms: 1 } });
  await tick();
  assert(sent.some((message) => message.command.action === 'frame'));
  assert.deepEqual(replies[0].result, { ok: true });
});
