import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHar } from '../../lib/har.mjs';

function detail(overrides = {}) {
  return {
    entry: {
      id: 1, method: 'GET', url: 'https://x.test/a?q=1', status: 200, mime: 'application/json',
      startedAt: 1700000000000, durationMs: 12, responseBytes: 8,
    },
    requestHeaders: { 'content-type': 'application/json' },
    responseHeaders: { 'x-test': '1' },
    responseBody: '{"ok":1}',
    ...overrides,
  };
}

test('buildHar 生成 HAR 1.2 基本结构', () => {
  const har = buildHar([detail()], { pageUrl: 'https://x.test', pageTitle: 'X' });
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.creator.name, 'BridgeDeck');
  assert.equal(har.log.entries.length, 1);
  const entry = har.log.entries[0];
  assert.equal(entry.request.url, 'https://x.test/a?q=1');
  assert.deepEqual(entry.request.queryString, [{ name: 'q', value: '1' }]);
  assert.equal(entry.response.status, 200);
  assert.equal(entry.response.content.text, '{"ok":1}');
  assert.equal(entry.timings.wait, 12);
  assert.ok(har.log.pages.length === 1);
});

test('buildHar 处理 postData/错误/空列表', () => {
  const har = buildHar([detail({ postData: '{"a":1}', entry: { ...detail().entry, method: 'POST', error: 'failed', durationMs: null } })]);
  const entry = har.log.entries[0];
  assert.equal(entry.request.method, 'POST');
  assert.equal(entry.request.postData.text, '{"a":1}');
  assert.equal(entry._error, 'failed');
  assert.equal(entry.timings.wait, 0);
  assert.equal(buildHar([]).log.entries.length, 0);
});
