import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugNetworkStore, bodySlice, requestProjection } from '../../extension/src/debug/network-store.js';

function makeStore(cdp = async () => ({ body: '{"ok":true}' })) {
  let seq = 0;
  const store = new DebugNetworkStore('run', cdp, () => ++seq, () => 1000);
  return store;
}

const source = { sessionId: 'root', tabId: 1 };
const base = (requestId = '1') => ({
  requestId,
  timestamp: 100,
  type: 'XHR',
  frameId: 'f1',
  loaderId: 'l1',
  request: { url: 'https://site.test/api?token=secret', method: 'POST', headers: { 'content-type': 'application/json' }, postData: '{"password":"secret"}' },
});

test('network store captures request/response and redacts bodies', async () => {
  const store = makeStore();
  store.onEvent(source, 'Network.requestWillBeSent', base());
  assert.equal(store.size, 1);
  store.onEvent(source, 'Network.responseReceived', {
    requestId: '1',
    timestamp: 110,
    response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } },
  });
  store.onEvent(source, 'Network.loadingFinished', { requestId: '1', timestamp: 120, encodedDataLength: 20 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const entry = store.list()[0];
  assert.equal(entry.status, 200);
  assert.equal(entry.url.includes('secret'), false);
  assert.equal(entry.state, 'complete');
  assert.equal(entry.request_body.redacted, true);
});

test('network store follows redirects and keeps redirect_from', () => {
  const store = makeStore();
  store.onEvent(source, 'Network.requestWillBeSent', base());
  store.onEvent(source, 'Network.requestWillBeSent', {
    ...base(),
    redirectResponse: { status: 302, headers: {} },
  });
  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].redirect_from, entries[0].id);
  assert.equal(entries[0].state, 'redirected');
  assert.deepEqual(entries[0].response_body, { state: 'unavailable', reason: 'redirect' });
});

test('network store annotation applies effective url/mock', () => {
  const store = makeStore();
  store.annotate(source, '2', {
    effective: { url: 'https://site.test/mock?token=secret', method: 'GET', headers: { 'content-type': 'text/plain' } },
    mock: { status: 201, headers: { 'content-type': 'text/plain' }, body: 'hi' },
  });
  store.onEvent(source, 'Network.requestWillBeSent', { ...base('2'), request: { url: 'https://site.test/original', method: 'GET', headers: {} } });
  const entry = store.list()[0];
  assert.equal(entry.status, 201);
  assert.equal(entry.url.includes('secret'), false);
  assert.equal(entry.response_body.text, 'hi');
});

test('bodySlice and requestProjection preserve unicode boundaries', () => {
  const body = { state: 'available', text: 'a😀b', chars: 4 };
  assert.deepEqual(bodySlice(body, 0, 2), { state: 'available', text: 'a', chars: 4, offset: 0, next_offset: 1 });
  assert.throws(() => bodySlice(body, 1, 1));
  const projected = requestProjection({ ...base(), id: 'n1', request_body: body, response_body: { state: 'empty' } }, 'request', 0, 10);
  assert.equal(projected.request_body.text, 'a😀b');
  assert.equal(projected.response_body.text, undefined);
});
