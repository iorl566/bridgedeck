import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../../extension/src/settings.js';

test('settings reject remote plaintext websocket and credentials', () => {
  assert.equal(normalizeSettings({ daemonUrl: 'ws://example.com:9000/ws' }).daemonUrl, '');
  assert.equal(normalizeSettings({ daemonUrl: 'wss://example.com/ws' }).daemonUrl, 'wss://example.com/ws');
  assert.equal(normalizeSettings({ daemonUrl: 'ws://user:pass@127.0.0.1:52900/ws' }).daemonUrl, '');
  assert.equal(normalizeSettings({ daemonUrl: 'ws://127.0.0.1:52900/ws' }).daemonUrl, 'ws://127.0.0.1:52900/ws');
  assert.equal(normalizeSettings({ daemonUrl: 'http://127.0.0.1:52900' }).daemonUrl, '');
});

test('settings clamp labels and default booleans safely', () => {
  const out = normalizeSettings({ instanceLabel: 'x'.repeat(100), borrowConfirm: false, allowHelp: false });
  assert.equal(out.instanceLabel.length, 48);
  assert.equal(out.borrowConfirm, false);
  assert.equal(out.allowHelp, false);
  assert.equal(out.pageGuard, true);
});
