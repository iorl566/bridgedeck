import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonPointer, parseJsonSource } from '../../extension/src/debug/json-source.js';
import { BODY_CHARS, redactBody, redactHeaders, redactRequestUrl } from '../../extension/src/debug/redact.js';

test('redacts vendor credential headers exactly', () => {
  const names = ['PRIVATE-TOKEN', 'x-goog-api-key', 'X-Amz-Security-Token', 'X-CSRFToken', 'X-Hasura-Admin-Secret'];
  for (const name of names) assert.deepEqual(redactHeaders({ [name]: 'secret' }), { [name.toLowerCase()]: '[redacted]' });
  assert.deepEqual(redactHeaders({ 'x-page-token': 'cursor-2' }), { 'x-page-token': 'cursor-2' });
});

test('preserves untouched JSON bytes including large numbers', () => {
  const samples = [
    '{"orderId":9007199254740993,"action":"cancel"}',
    ' { "id":18446744073709551615, "small":-9007199254740993, "n":1.234567890123456789 } ',
    '[1e400,1e-400,-0,1.00,true,false,null,"a\\u002fb",{"x":[]} ]',
    '{"id":1,"id":9007199254740993,"__proto__":{"value":1}}',
  ];
  for (const text of samples) {
    assert.deepEqual(redactBody(text, 'application/json'), { text, redacted: false, truncated: false, replay_safe: true });
  }
});

test('redacts nested JSON secrets without rounding neighbors', () => {
  const text = '{ "id":9007199254740993, "pass\\u0077ord":{"nested":42}, "password":"second", "label":"a\\u002fb", "data":[{"token":123}] }';
  const result = redactBody(text, 'application/json');
  assert.equal(result.text, '{ "id":9007199254740993, "pass\\u0077ord":"[redacted]", "password":"[redacted]", "label":"a\\u002fb", "data":[{"token":"[redacted]"}] }');
  assert.equal(result.redacted, true);
  assert.equal(result.replay_safe, false);
  assert.equal(jsonPointer(result.text, '/id'), '9007199254740993');
});

test('redacts HTML encoded password inputs and preserves non-secret bytes', () => {
  const text = '<p>Keep &amp;</p><input value="secret" type="pass&#x77;ord"><input name="nickname" value="Alice &amp; Bob">';
  const result = redactBody(text, 'text/html');
  assert.equal(result.text, '<p>Keep &amp;</p><input data-bb-redacted="true"><input name="nickname" value="Alice &amp; Bob">');
  assert.equal(result.redacted, true);
  assert.equal(result.replay_safe, false);
  const safe = '<input name="nick&#110;ame" value="Alice &amp; Bob">';
  assert.deepEqual(redactBody(safe, 'text/html'), { text: safe, redacted: false, truncated: false, replay_safe: true });
});

test('redacts form secrets preserving encoding and duplicates', () => {
  const text = 'password=example-secret&password=example-secret&name=Alice%20Smith';
  const result = redactBody(text, 'application/x-www-form-urlencoded');
  assert.equal(result.text, 'password=%5Bredacted%5D&password=%5Bredacted%5D&name=Alice%20Smith');
  assert.equal(result.replay_safe, false);
});

test('drops malformed or oversized structured bodies', () => {
  for (const text of ['{"user[password]":"private"', '{"password":"private",}', '['.repeat(100) + '"private"' + ']'.repeat(100)]) {
    assert.deepEqual(redactBody(text, 'application/json'), {
      text: '', truncated: true, redacted: true, replay_safe: false, reason: 'unparsed_json',
    });
  }
  assert.equal(redactBody('{"password":"' + 'x'.repeat(BODY_CHARS) + '"}', 'application/json').text, '');
  assert.throws(() => parseJsonSource('{"a":1,}'));
});

test('redacts URL credentials and secret query fields', () => {
  const result = redactRequestUrl('https://user:pass@site.test/?access_token=example-secret&page=2#x');
  assert.equal(result.text.includes('example-secret'), false);
  assert.equal(result.text.includes('user:pass'), false);
  assert.equal(result.state, 'redacted');
});
