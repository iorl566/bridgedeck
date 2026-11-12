import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageClient } from '../../extension/src/long-screenshot/page-client.js';

function harness({ failFirst = false, documentId = 'doc' } = {}) {
  const sent = [];
  const injected = [];
  let calls = 0;
  const api = {
    tabs: { async sendMessage(tabId, message, target) { calls += 1; sent.push([message, target]); if (failFirst && calls === 1) return { ok: false, error: 'unavailable' }; return { ok: true, metrics: { width: 10, height: 20 } }; } },
    webNavigation: { async getFrame() { return { documentId }; } },
    scripting: { async executeScript(details) { injected.push(details); } },
  };
  const client = createPageClient(7, 'cap1', new AbortController().signal, async () => {}, api);
  return { client, sent, injected };
}

test('prepare probes the document and commands target it', async () => {
  const { client, sent } = harness();
  await client.prepare();
  assert.equal(client.documentId, 'doc');
  assert.equal(sent[0][0].type, 'bb/long-screenshot-page');
  assert.equal(sent[0][1].documentId, 'doc');
  const metrics = await client.page({ action: 'move', y: 10, capture: true });
  assert.deepEqual(metrics, { width: 10, height: 20 });
});

test('prepare reinjects once when content script is unavailable', async () => {
  const { client, injected } = harness({ failFirst: true });
  await client.prepare();
  assert.equal(injected.length, 1);
  assert.deepEqual(injected[0].target.documentIds, ['doc']);
});

test('prepare fails with autoUnavailable without document id', async () => {
  const { client } = harness({ documentId: null });
  await assert.rejects(() => client.prepare(), (error) => error.code === 'autoUnavailable');
});
