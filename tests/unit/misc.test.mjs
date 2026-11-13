import test from 'node:test';
import assert from 'node:assert/strict';
import { effectOf, isAllowedWhilePaused, compareProtocol } from '../../lib/protocol.mjs';
import { estimateTokens, takeTokenChunk } from '../../extension/src/tokens.js';
import { redactBody, redactUrl } from '../../extension/src/redact.js';
import { normalizeSettings } from '../../extension/src/settings.js';

test('redactUrl redacts secrets even for malformed URLs', () => {
  const out = redactUrl('not a url?token=abc&x=1');
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /x=1/);
});

test('redactBody handles quoted form-like text', () => {
  const out = redactBody('"password": "p", "safe": "ok"');
  assert.match(out, /password.*\[redacted\]/);
  assert.match(out, /safe.*ok/);
});

test('settings accepts loopback ws and rejects wss credentials', () => {
  assert.equal(normalizeSettings({ daemonUrl: 'ws://localhost:52900/ws' }).daemonUrl, 'ws://localhost:52900/ws');
  assert.equal(normalizeSettings({ daemonUrl: 'wss://user:pass@example.com/ws' }).daemonUrl, '');
  assert.equal(normalizeSettings({ daemonUrl: 'wss://example.com/ws' }).daemonUrl, 'wss://example.com/ws');
});

test('method effects keep read/mutation/control boundaries', () => {
  assert.equal(effectOf('hover'), 'transient_input');
  assert.equal(effectOf('click'), 'browser_mutation');
  assert.equal(effectOf('observe'), 'passive_read');
  assert.equal(effectOf('transfer.read'), 'control_plane');
  assert.equal(isAllowedWhilePaused('transfer.read'), true);
  assert.equal(isAllowedWhilePaused('drag'), false);
});

test('protocol compare rejects three-part versions', () => {
  assert.equal(compareProtocol('1.8', '1.8.0'), null);
  assert.equal(compareProtocol('1.0', '1.0'), 0);
});

test('token estimate handles empty and whitespace', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('   ') >= 0);
  assert.ok(estimateTokens('你好') > 0);
});

test('token chunk stops at end without returning a cursor', () => {
  const text = 'a\nb\nc';
  const chunk = takeTokenChunk(text, 0, 20000);
  assert.equal(chunk.text, text);
  assert.equal(chunk.next, null);
});
