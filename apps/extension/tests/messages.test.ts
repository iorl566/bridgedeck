import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatus, parseMessage } from '../shared/messages.ts';
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings.ts';

test('parseMessage 接受已知消息并拒绝未知输入', () => {
  assert.deepEqual(parseMessage({ type: 'bb.status' }), { type: 'bb.status' });
  assert.deepEqual(parseMessage({ type: 'bb.ping', nonce: 'abc' }), { type: 'bb.ping', nonce: 'abc' });
  assert.deepEqual(parseMessage({ type: 'bb.settings.get' }), { type: 'bb.settings.get' });
  assert.equal(parseMessage({ type: 'bb.unknown' }), null);
  assert.equal(parseMessage({ type: 'bb.ping' }), null, 'ping 必须有非空 nonce');
  assert.equal(parseMessage({ type: 'bb.ping', nonce: '' }), null);
  assert.equal(parseMessage(null), null);
  assert.equal(parseMessage('bb.status'), null);
  assert.equal(parseMessage({ type: 42 }), null);
});

test('buildStatus 输出协议/体量常量与运行时长', () => {
  const status = buildStatus(3, Date.now() - 1500, '0.3.0');
  assert.equal(status.name, 'BridgeDeck');
  assert.equal(status.version, '0.3.0');
  assert.equal(status.protocol, '1.9');
  assert.equal(status.canonicalMethods, 165);
  assert.equal(status.mcpTools, 67);
  assert.equal(status.openTabs, 3);
  assert.equal(status.runtime, 'ts');
  assert.ok(status.uptimeMs >= 1400, 'uptime 应约等于传入的起始时间差：' + status.uptimeMs);
});

test('normalizeSettings 缺省补齐且拒绝非法值', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const partial = normalizeSettings({ controlHint: false, daemonPort: -1, language: '' });
  assert.equal(partial.controlHint, false);
  assert.equal(partial.daemonPort, DEFAULT_SETTINGS.daemonPort, '非法端口回落到默认');
  assert.equal(partial.language, DEFAULT_SETTINGS.language);
  assert.equal(partial.recordOverlay, DEFAULT_SETTINGS.recordOverlay);
  const custom = normalizeSettings({ daemonPort: 53001, language: 'ar', borrowRequireConfirm: false });
  assert.equal(custom.daemonPort, 53001);
  assert.equal(custom.language, 'ar');
  assert.equal(custom.borrowRequireConfirm, false);
});
