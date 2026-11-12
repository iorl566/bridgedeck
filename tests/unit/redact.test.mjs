import test from 'node:test';
import assert from 'node:assert/strict';
import { redactBody, redactHeaders, redactUrl } from '../../extension/src/redact.js';

test('redactHeaders hides credential headers case-insensitively', () => {
  const out = redactHeaders({ Authorization: 'Bearer x', Cookie: 'a=b', 'Content-Type': 'text/plain' });
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out['Content-Type'], 'text/plain');
});

test('redactUrl hides secret query values but keeps other params', () => {
  const out = redactUrl('https://x.test/p?token=abc&page=2');
  assert.match(out, /token=%5Bredacted%5D|token=\[redacted\]/);
  assert.match(out, /page=2/);
});

test('redactBody handles JSON and form text', () => {
  const json = redactBody(JSON.stringify({ user: 'a', password: 'p', nested: { access_token: 't' } }));
  assert.deepEqual(JSON.parse(json), { user: 'a', password: '[redacted]', nested: { access_token: '[redacted]' } });
  assert.match(redactBody('username=a&password=p&x=1'), /password=\[redacted\]/);
  assert.match(redactBody('{"token":"abc"}'), /\[redacted\]/);
});
