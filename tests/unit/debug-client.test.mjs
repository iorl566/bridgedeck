import test from 'node:test';
import assert from 'node:assert/strict';
import { debugHistory, debugRequest, deleteRecording, openDebugPage } from '../../extension/src/debug/client.js';

function runtime() {
  const sent = [];
  return {
    sent,
    async sendMessage(message) { sent.push(message); return { ok: true, data: message.action }; },
  };
}

test('debug requests include the action envelope', async () => {
  const r = runtime();
  assert.equal(await debugRequest({ action: 'start' }, { runtime: r }), 'debug');
  assert.deepEqual(r.sent[0], { kind: 'bb_debug', action: 'debug', params: { action: 'start' } });
  assert.equal(await debugHistory({ runtime: r }), 'history');
});

test('errors are surfaced', async () => {
  await assert.rejects(() => debugHistory({ runtime: { async sendMessage() { return { ok: false, error: 'no' }; } } }), /no/);
});

test('deleteRecording sends run_id and openDebugPage builds URL', async () => {
  const r = runtime();
  await deleteRecording('d123', { runtime: r });
  assert.deepEqual(r.sent[0], { kind: 'bb_debug', action: 'delete', run_id: 'd123' });
  const created = [];
  openDebugPage('s1', 'd1', { runtime: { getURL: (path) => `chrome-extension://x/${path}` }, tabs: { async create(opts) { created.push(opts.url); } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(created[0], /debug\.html\?session=s1&run=d1/);
});
