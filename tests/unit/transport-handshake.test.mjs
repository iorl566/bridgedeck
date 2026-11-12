import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBrowserMeta, performHandshake, PROTOCOL_VERSION } from '../../extension/src/transport/handshake.js';

function transport(reply) {
  let listener;
  const sent = [];
  return {
    sent,
    send(message) { sent.push(message); queueMicrotask(() => listener(reply(message))); },
    onMessage(handler) { listener = handler; return { dispose() {} }; },
  };
}

test('performHandshake sends mandatory params and resolves', async () => {
  const t = transport((message) => ({ id: message.id, result: { ok: true } }));
  const outcome = await performHandshake(t, { instanceId: 'i', browser: { name: 'edge', version: '1' }, label: 'L', rpcId: 'hs-test' }, { timeoutMs: 100 });
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].method, 'system.handshake');
  assert.equal(t.sent[0].params.protocol_version, PROTOCOL_VERSION);
  assert.equal(t.sent[0].params.client, 'bridge-deck-extension');
  assert.deepEqual(outcome.result, { ok: true });
});

test('performHandshake surfaces rejection with onRejected', async () => {
  let rejected;
  const t = transport((message) => ({ id: message.id, error: { code: 'incompatible', message: 'bad' } }));
  await assert.rejects(
    () => performHandshake(t, { instanceId: 'i', browser: {}, label: 'L' }, { onRejected: (error) => { rejected = error; } }),
    /daemon rejected handshake/,
  );
  assert.equal(rejected.code, 'incompatible');
});

test('detectBrowserMeta recognizes browsers', () => {
  assert.deepEqual(detectBrowserMeta('Mozilla Edg/120.0'), { name: 'edge', version: '120.0' });
  assert.deepEqual(detectBrowserMeta('Chrome/121.0'), { name: 'chrome', version: '121.0' });
  assert.deepEqual(detectBrowserMeta('curl'), { name: 'chromium', version: 'unknown' });
});
