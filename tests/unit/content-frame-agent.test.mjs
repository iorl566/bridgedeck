import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordFrameAgent, registerPort } from '../../extension/src/content/recording/frame-agent.js';

function fakePort() {
  const listeners = new Map();
  const sent = [];
  let disconnected = false;
  return {
    sent,
    postMessage(message) {
      sent.push(message);
      if (message.type === 'ready') queueMicrotask(() => this.emit({ type: 'ready_ack', requestId: message.requestId, producerId: message.producerId }));
    },
    onMessage: {
      addListener(handler) { const list = listeners.get('message') ?? []; list.push(handler); listeners.set('message', list); },
      removeListener(handler) { listeners.set('message', (listeners.get('message') ?? []).filter((item) => item !== handler)); },
    },
    onDisconnect: {
      addListener(handler) { listeners.set('disconnect', handler); },
      removeListener() { listeners.delete('disconnect'); },
    },
    emit(message) { for (const handler of [...(listeners.get('message') ?? [])]) handler(message); },
    disconnect() { disconnected = true; listeners.get('disconnect')?.(); },
    isDisconnected: () => disconnected,
  };
}

function harness() {
  const port = fakePort();
  const steps = [];
  let disposed = 0;
  const agent = new RecordFrameAgent({
    connect: () => port,
    waitForRoot: async () => ({ kind: 'root' }),
    mark: () => ({ ensure() {}, restore() {} }),
    startCapture: (_requestId, emit) => ({ dispose() { disposed += 1; }, emit, push(step) { emit(step); } }),
    sendStep: async (message) => { steps.push(message); return { ok: true, sequence: message.sequence }; },
    createUuid: () => '123e4567-e89b-42d3-a456-426614174000',
  });
  return { agent, port, steps, getDisposed: () => disposed };
}

test('RecordFrameAgent registers and starts capture', async () => {
  const { agent, port } = harness();
  const result = await agent.start({ requestId: 'r1', startedAtMs: 1 });
  assert.deepEqual(result, { ok: true });
  assert(port.sent.some((message) => message.type === 'ready' && message.producerId === '123e4567-e89b-42d3-a456-426614174000'));
  assert.equal(agent.active.requestId, 'r1');
});

test('RecordFrameAgent stop flushes delivery and posts stopped', async () => {
  const { agent, port, steps } = harness();
  await agent.start({ requestId: 'r1' });
  port.emit({ type: 'stop', requestId: 'r1', commandId: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(port.sent.some((message) => message.type === 'stopped' && message.commandId === 'c1' && message.ok === true));
  assert.equal(agent.active, null);
});

test('RecordFrameAgent cancel disposes and registerPort validates ack', async () => {
  const { agent, port, getDisposed } = harness();
  await agent.start({ requestId: 'r1' });
  agent.cancel('r1');
  assert.equal(getDisposed(), 1);
  assert.equal(port.isDisconnected(), true);
  const p = fakePort();
  const result = registerPort(p, 'r', 'p', 50).then(() => 'ok');
  p.emit({ type: 'ready_ack', requestId: 'r', producerId: 'wrong' });
  p.emit({ type: 'ready_ack', requestId: 'r', producerId: 'p' });
  assert.equal(await result, 'ok');
});
