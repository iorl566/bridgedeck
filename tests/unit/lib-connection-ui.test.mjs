import test from 'node:test';
import assert from 'node:assert/strict';
import { watchDaemonConnection } from '../../extension/src/lib/daemon-connection-preference.js';
import { attachUiChannel } from '../../extension/src/lib/ui-channel.js';

function socketHarness() {
  let listener;
  const sent = [];
  const socket = { readyState: 1, addEventListener: (_type, fn) => { listener = fn; }, send: (text) => sent.push(JSON.parse(text)) };
  return { socket, sent, emit: (data) => { const event = { data: JSON.stringify(data), stopped: false, stopImmediatePropagation() { this.stopped = true; } }; listener(event); return event; } };
}

test('daemon connection uses local port without remote', async () => {
  const calls = [];
  const storage = { get: async () => ({ bb_daemon_port: 52901 }), onChanged: { addListener() {}, removeListener() {} } };
  const watcher = watchDaemonConnection((url, remote) => calls.push([url, remote]), () => {}, {
    storage, key: 'bb_daemon_port', normalizePort: (value) => Number(value), resolveWsUrl: (port) => 'ws://127.0.0.1:' + port, readRemoteConnection: async () => null,
  });
  await watcher.ready;
  assert.deepEqual(calls, [['ws://127.0.0.1:52901', null]]);
});

test('daemon connection prefers remote endpoint', async () => {
  const calls = [];
  const storage = { get: async () => ({ bb_daemon_port: 52901 }), onChanged: { addListener() {}, removeListener() {} } };
  const remote = { url: 'wss://gate.example/ws', token: 't' };
  const watcher = watchDaemonConnection((url, value) => calls.push([url, value]), () => {}, {
    storage, key: 'bb_daemon_port', normalizePort: Number, resolveWsUrl: (port) => String(port), readRemoteConnection: async () => remote,
  });
  await watcher.ready;
  assert.deepEqual(calls[0], ['wss://gate.example/ws', remote]);
});

test('ui channel answers focus and rejects missing session', async () => {
  const h = socketHarness();
  const calls = [];
  attachUiChannel(h.socket, { focus: async (id) => ['focused', id], preview: async (id) => ['preview', id] });
  h.emit({ id: '1', method: 'ui.task_focus', params: { session_id: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(h.sent[0], { id: '1', result: ['focused', 's1'] });
  h.emit({ id: '2', method: 'ui.task_preview', params: {} });
  assert.equal(h.sent[1].error.code, 'invalid_params');
});

test('ui channel ignores foreign methods and closed sockets', async () => {
  const h = socketHarness();
  attachUiChannel(h.socket, { focus: async () => 'x', preview: async () => 'y' });
  const foreign = h.emit({ id: '1', method: 'other', params: { session_id: 's1' } });
  assert.equal(foreign.stopped, false);
  h.socket.readyState = 3;
  h.emit({ id: '2', method: 'ui.task_focus', params: { session_id: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.sent.length, 0);
});
