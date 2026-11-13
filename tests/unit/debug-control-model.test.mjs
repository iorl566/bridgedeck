import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editRequest, publicRule, replayRequest, urlMatcher, validateEdit, validateReplay, validateRule,
} from '../../extension/src/debug/control-model.js';

test('validateRule normalizes wildcard URL and rejects unsafe effects', () => {
  const rule = validateRule({ match: { url: 'https://site.test/api/*' }, effect: { type: 'block' } });
  assert.equal(rule.match.url, 'https://site.test/api/*');
  assert.throws(() => validateRule({ match: { url: 'https://*.site.test/' }, effect: { type: 'block' } }));
  assert.throws(() => validateRule({ match: { url: 'https://site.test/' }, effect: { type: 'mock', status: 302, body: '' } }));
  assert.throws(() => validateRule({ match: { url: 'https://site.test/' }, effect: { type: 'mock', status: 204, body: 'x' } }));
});

test('urlMatcher supports wildcards', () => {
  const matcher = urlMatcher('https://site.test/api/*/item?x=*');
  assert.equal(matcher.test('https://site.test/api/1/item?x=2'), true);
  assert.equal(matcher.test('https://site.test/api/1/other?x=2'), false);
});

test('editRequest preserves JSON number text and applies rename/remove/set', () => {
  const request = {
    url: 'https://site.test/api', method: 'POST',
    headers: { 'content-type': 'application/json' },
    postData: '{"id":9007199254740993,"old":"x","drop":1}',
  };
  const edited = editRequest(request, { json: { rename: { old: 'new' }, remove: ['drop'], set: { ok: true } } });
  assert.equal(edited.postData, '{"id":9007199254740993,"new":"x","ok":true}');
  assert.throws(() => validateEdit({ body: 'x', json: { set: { a: 1 } } }));
});

test('replayRequest requires complete metadata and strips forbidden headers', () => {
  const source = {
    url: 'https://site.test/api', method: 'POST',
    integrity: { url: 'complete', metadata: 'complete' },
    truncated: false,
    request_headers: { cookie: 'a', 'content-type': 'application/json' },
    request_body: { state: 'available', text: '{"a":1}', replay_safe: true, redacted: false },
  };
  const request = replayRequest(source, { key: 'r1' }, 'https://site.test/page');
  assert.equal(request.headers.cookie, undefined);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.throws(() => replayRequest({ ...source, integrity: { url: 'truncated', metadata: 'complete' } }, { key: 'r1' }, 'https://site.test/page'));
  assert.equal(validateReplay({ key: 'saved-1' }).key, 'saved-1');
});

test('publicRule redacts names, urls, headers and body', () => {
  const rule = {
    name: 'token=secret',
    match: { url: 'https://site.test/api?token=secret' },
    effect: { type: 'mock', status: 200, headers: { 'content-type': 'text/plain' }, body: 'password=secret' },
  };
  const safe = publicRule(rule);
  assert.equal(safe.match.url.includes('secret'), false);
  assert.equal(safe.effect.body.includes('secret'), false);
  assert.equal(safe.name.includes('secret'), false);
});
