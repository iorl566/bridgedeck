import test from 'node:test';
import assert from 'node:assert/strict';
import { WSTransport } from '../../extension/src/transport/ws-transport.js';

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  emit(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler(event); }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.closed = true; this.emit('close', { code: 1000 }); }
  message(data) { this.emit('message', { data }); }
}

function harness() {
  const sockets = [];
  const transport = new WSTransport({
    url: 'ws://x',
    webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
  });
  return { transport, sockets };
}

test('connect resolves after open and send serializes frames', async () => {
  const h = harness();
  const states = [];
  h.transport.onConnectionStateChange((state) => states.push(state));
  const pending = h.transport.connect();
  h.sockets[0].open();
  await pending;
  assert.equal(h.transport.state, 'connected');
  assert.deepEqual(states, ['connecting', 'connected']);
  h.transport.send({ type: 'hello', value: 1 });
  assert.deepEqual(JSON.parse(h.sockets[0].sent[0]), { type: 'hello', value: 1 });
});

test('send before connected throws', () => {
  const h = harness();
  assert.throws(() => h.transport.send({ type: 'x' }), /cannot send/);
});

test('inbound frames dispatch and auth frames are rejected', async () => {
  const h = harness();
  const received = [];
  h.transport.onMessage((frame) => received.push(frame));
  const pending = h.transport.connect();
  h.sockets[0].open();
  await pending;
  h.sockets[0].message(JSON.stringify({ type: 'tick' }));
  h.sockets[0].message('not json');
  assert.deepEqual(received, [{ type: 'tick' }]);
  h.sockets[0].message(JSON.stringify({ type: 'local.auth.challenge' }));
  assert.equal(h.sockets[0].closed, true);
  await h.transport.disconnect();
});

test('disconnect rejects a pending connect', async () => {
  const h = harness();
  const pending = h.transport.connect();
  await h.transport.disconnect();
  await assert.rejects(pending, /disconnect during connect/);
  assert.equal(h.transport.state, 'disconnected');
});
