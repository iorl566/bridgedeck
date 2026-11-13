import test from 'node:test';
import assert from 'node:assert/strict';
import { EXT_METHODS } from '../../lib/methods.mjs';
import { METHOD_SCHEMAS, validateMethodParams } from '../../lib/schemas.mjs';

test('每个扩展方法都有显式参数 schema', () => {
  const missing = [...EXT_METHODS].filter((method) => !METHOD_SCHEMAS[method]).sort();
  assert.deepEqual(missing, []);
});

test('tab.* / dialog.disarm 允许 daemon 注入 tabId，但不接受错误类型', () => {
  for (const method of ['tab.close', 'tab.select', 'tab.borrow', 'tab.return', 'tab.move', 'dialog.disarm']) {
    assert.equal(validateMethodParams(method, {}).length, 0, method);
    assert.equal(validateMethodParams(method, { tabId: 7 }).length, 0, method);
    assert.ok(validateMethodParams(method, { tabId: '7' }).length > 0, method);
  }
});

test('dialog.arm 接受策略字段', () => {
  assert.equal(validateMethodParams('dialog.arm', { alert: 'accept', confirm: 'dismiss', queue: true }).length, 0);
});

test('network.list 使用 filter 对象，debug.rule_import 使用 rules 数组', () => {
  assert.equal(validateMethodParams('network.list', { filter: { urlContains: '/api/ping', status: 200 }, limit: 10 }).length, 0);
  assert.ok(validateMethodParams('network.list', { filter: '/api/ping' }).length > 0);
  assert.equal(validateMethodParams('debug.rule_import', { rules: [{ id: 1 }] }).length, 0);
  assert.ok(validateMethodParams('debug.rule_import', { rules: { id: 1 } }).length > 0);
});

test('record.start 接受 screenshots 布尔值', () => {
  assert.equal(validateMethodParams('record.start', { screenshots: true }).length, 0);
  assert.ok(validateMethodParams('record.start', { screenshots: 'yes' }).length > 0);
});

test('debug.rule_enable/disable/remove 接受 id', () => {
  for (const method of ['debug.rule_enable', 'debug.rule_disable', 'debug.rule_remove']) {
    assert.equal(validateMethodParams(method, { id: 3 }).length, 0, method);
    assert.ok(validateMethodParams(method, { id: '3' }).length > 0, method + ' 应拒绝字符串 id');
  }
});

test('emulate.geolocation 是对象而不是字符串', () => {
  assert.equal(validateMethodParams('emulate', { geolocation: { latitude: 31.2, longitude: 121.5 } }).length, 0);
  assert.ok(validateMethodParams('emulate', { geolocation: '31.2,121.5' }).length > 0);
});

test('video.fetch / video.discard 使用 recording 字段', () => {
  assert.equal(validateMethodParams('video.fetch', { recording: 'vid_1' }).length, 0);
  assert.equal(validateMethodParams('video.discard', { recording: 'vid_1' }).length, 0);
  assert.ok(METHOD_SCHEMAS['video.fetch'].properties.recording);
});

test('click-point 接受 capture / imageX / imageY', () => {
  assert.equal(validateMethodParams('click-point', { capture: 'cap_1', imageX: 10, imageY: 20 }).length, 0);
  assert.ok(validateMethodParams('click-point', { imageX: '10' }).length > 0);
});

test('step 接受 action 对象与等待字段', () => {
  assert.equal(validateMethodParams('step', { action: { method: 'click', params: {} }, waitTimeoutMs: 3000 }).length, 0);
  assert.ok(validateMethodParams('step', { action: 'click' }).length > 0);
});
