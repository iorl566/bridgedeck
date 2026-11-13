import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DEBUGGER_IDLE_MS, LONG_LIVED_DEBUGGER_FEATURES, shouldIdleDetach } from '../../extension/src/debugger-idle.js';

const NOW = 1_000_000;

function base(extra = {}) {
  return {
    attached: true,
    tabActive: false,
    lastActivity: NOW - DEFAULT_DEBUGGER_IDLE_MS - 1,
    now: NOW,
    activeFeatures: [],
    ...extra,
  };
}

test('默认空闲阈值是 75s', () => {
  assert.equal(DEFAULT_DEBUGGER_IDLE_MS, 75000);
});

test('只有 attached + 非活动 + 超过阈值才建议 detach', () => {
  assert.equal(shouldIdleDetach(base()), true);
  assert.equal(shouldIdleDetach(base({ attached: false })), false);
  assert.equal(shouldIdleDetach(base({ tabActive: true })), false);
  assert.equal(shouldIdleDetach(base({ tabActive: undefined })), false);
  assert.equal(shouldIdleDetach(base({ lastActivity: NOW - 1000 })), false);
});

test('刚好到阈值算空闲', () => {
  assert.equal(shouldIdleDetach(base({ lastActivity: NOW - DEFAULT_DEBUGGER_IDLE_MS })), true);
});

test('长生命周期 feature 持有调试器时不分离', () => {
  for (const feature of LONG_LIVED_DEBUGGER_FEATURES) {
    assert.equal(shouldIdleDetach(base({ activeFeatures: [feature] })), false, feature);
  }
  assert.equal(shouldIdleDetach(base({ activeFeatures: ['input', 'screenshot'] })), true);
});

test('可覆盖 idleMs，非法值回退默认', () => {
  assert.equal(shouldIdleDetach(base({ idleMs: 5000, lastActivity: NOW - 6000 })), true);
  assert.equal(shouldIdleDetach(base({ idleMs: 5000, lastActivity: NOW - 4000 })), false);
  assert.equal(shouldIdleDetach(base({ idleMs: -1, lastActivity: NOW - 1000 })), false);
  assert.equal(shouldIdleDetach(base({ idleMs: 'x', lastActivity: NOW - 1000 })), false);
});

test('缺少 lastActivity 时不分离', () => {
  assert.equal(shouldIdleDetach(base({ lastActivity: 0 })), false);
  assert.equal(shouldIdleDetach(base({ lastActivity: undefined })), false);
});
