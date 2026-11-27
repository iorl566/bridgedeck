import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartRequests } from '../../daemon/start-requests.js';

function fakeJournal() {
  const store = new Map();
  return {
    store,
    get: (id) => store.get(id),
    prepare: (id, meta) => { const entry = { requestId: id, state: 'prepared', meta }; store.set(id, entry); return entry; },
    setState: (id, state, patch) => { const entry = { ...(store.get(id) || {}), state, ...patch }; store.set(id, entry); return entry; },
  };
}

function make() {
  const journal = fakeJournal();
  const api = createStartRequests({
    startJournal: journal,
    normalizeStartToken: (value) => {
      if (!value || value.length < 2) throw new Error('bad token');
      return value;
    },
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
  });
  return { journal, api };
}

test('prepareStartRequest 预登记', async () => {
  const { api, journal } = make();
  const result = await api.prepareStartRequest({ requestId: 'req1' });
  assert.equal(result.requestId, 'req1');
  assert.equal(journal.get('req1').state, 'prepared');
});

test('claimStartRequest 只允许 ready/claimed', async () => {
  const { api, journal } = make();
  journal.setState('req2', 'prepared');
  await assert.rejects(() => api.claimStartRequest({ requestId: 'req2' }), (error) => error.code === 'E_START_NOT_READY');
  journal.setState('req2', 'ready');
  const claimed = await api.claimStartRequest({ requestId: 'req2' });
  assert.equal(claimed.entry.state, 'claimed');
});

test('cancelStartRequest 拒绝 starting', async () => {
  const { api, journal } = make();
  journal.setState('req3', 'starting');
  await assert.rejects(() => api.cancelStartRequest({ requestId: 'req3' }), (error) => error.code === 'E_START_PENDING');
});

test('非法 requestId 转 E_BAD_ARG', async () => {
  const { api } = make();
  await assert.rejects(() => api.prepareStartRequest({ requestId: '' }), (error) => error.code === 'E_BAD_ARG');
});
