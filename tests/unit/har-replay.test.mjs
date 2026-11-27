import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHarReplayEntries, findHarReplayEntry } from '../../lib/har-replay.mjs';

const har = {
  log: {
    entries: [
      { request: { method: 'get', url: 'https://a/1', headers: [{ name: 'X-A', value: '1' }] } },
      { request: { method: 'POST', url: 'https://a/2', postData: { text: '{"x":1}' } } },
      { request: { method: 'GET', url: '' } },
    ],
  },
};

test('parseHarReplayEntries 提取可重放请求', () => {
  const entries = parseHarReplayEntries(har);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].method, 'GET');
  assert.deepEqual(entries[0].headers, { 'X-A': '1' });
  assert.equal(entries[1].body, '{"x":1}');
});

test('findHarReplayEntry 按索引/URL', () => {
  const entries = parseHarReplayEntries(har);
  assert.equal(findHarReplayEntry(entries, { index: 1 }).url, 'https://a/2');
  assert.equal(findHarReplayEntry(entries, { urlContains: '/2' }).method, 'POST');
  assert.equal(findHarReplayEntry(entries, {}).url, 'https://a/1');
  assert.equal(findHarReplayEntry([], {}), null);
});
