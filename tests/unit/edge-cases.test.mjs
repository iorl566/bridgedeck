import test from 'node:test';
import assert from 'node:assert/strict';
import { effectOf, isAllowedWhilePaused, compareProtocol } from '../../lib/protocol.mjs';
import { estimateTokens, takeTokenChunk } from '../../extension/src/tokens.js';
import { redactBody, redactHeaders, redactUrl } from '../../extension/src/redact.js';
import { normalizeSettings } from '../../extension/src/settings.js';
import { parseProtocol, protocolSkew } from '../../extension/src/protocol-version.js';

test('transfer methods are control-plane and survive pause', () => {
  for (const method of ['transfer.begin', 'transfer.chunk', 'transfer.finish', 'transfer.read', 'transfer.release']) {
    assert.equal(effectOf(method), 'control_plane');
    assert.equal(isAllowedWhilePaused(method), true);
  }
});

test('protocol comparison is numeric, not lexical', () => {
  assert.equal(compareProtocol('1.10', '1.9'), 1);
  assert.equal(compareProtocol('1.9', '1.10'), -1);
  assert.equal(compareProtocol(' 1.8 ', '1.8'), 0);
});

test('token chunk handles empty, end and oversized offsets', () => {
  assert.deepEqual(takeTokenChunk('', 0, 100), { text: '', next: null });
  const text = 'abc\ndef';
  const end = takeTokenChunk(text, text.length, 100);
  assert.equal(end.text, '');
  assert.equal(end.next, null);
  const beyond = takeTokenChunk(text, 999, 100);
  assert.equal(beyond.text, '');
  assert.equal(beyond.next, null);
});

test('token estimate counts CJK and clamps zero budget', () => {
  assert.ok(estimateTokens('你好世界') >= estimateTokens('hello'));
  const chunk = takeTokenChunk('one line\ntwo line\nthree line', 0, 1);
  assert.ok(chunk.text.length > 0);
  assert.ok(chunk.next === null || chunk.next > 0);
});

test('redactBody walks nested arrays and objects', () => {
  const body = JSON.stringify({
    user: { name: 'a', password: 'p' },
    items: [{ token: 't', ok: 1 }, { api_key: 'k' }],
  });
  const out = JSON.parse(redactBody(body));
  assert.equal(out.user.password, '[redacted]');
  assert.equal(out.items[0].token, '[redacted]');
  assert.equal(out.items[0].ok, 1);
  assert.equal(out.items[1].api_key, '[redacted]');
});

test('redactHeaders and redactUrl leave non-secret data alone', () => {
  assert.equal(redactHeaders({ 'x-api-key': 'k', accept: 'json' }).accept, 'json');
  assert.equal(redactHeaders({ 'x-api-key': 'k' })['x-api-key'], '[redacted]');
  const url = redactUrl('https://x.test/p?session=abc&q=1');
  assert.match(url, /session=%5Bredacted%5D|session=\[redacted\]/);
  assert.match(url, /q=1/);
});

test('settings defaults are safe and token is clamped', () => {
  const out = normalizeSettings({ longShotMode: 'weird', daemonToken: 't'.repeat(200) });
  assert.equal(out.longShotMode, 'auto');
  assert.equal(out.daemonToken.length, 128);
  assert.equal(out.connectionEnabled, true);
  assert.equal(out.auditEnabled, false);
});

test('protocol parse rejects malformed versions and reports skew', () => {
  assert.equal(parseProtocol('1.8.1'), null);
  assert.equal(parseProtocol('-1.0'), null);
  assert.equal(parseProtocol(' 1.8 ').minor, 8);
  assert.equal(protocolSkew('1.9'), 'daemon_newer');
  assert.equal(protocolSkew('0.9'), 'major');
  assert.equal(protocolSkew(null), 'missing');
});
