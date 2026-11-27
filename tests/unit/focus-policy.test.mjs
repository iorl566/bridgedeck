import test from 'node:test';
import assert from 'node:assert/strict';
import { focusRequested, legacyNoFocus, FOCUS_POLICY_NOTE } from '../../extension/src/lib/focus-policy.js';

test('focusRequested：只有显式 focus:true 才算前台', () => {
  assert.equal(focusRequested({ focus: true }), true);
  assert.equal(focusRequested({ focus: false }), false);
  assert.equal(focusRequested({}), false);
  assert.equal(focusRequested({ focus: 'true' }), false, '字符串 true 不算显式前台');
  assert.equal(focusRequested({ noFocus: false }), false, '旧 no-focus 不能当成前台');
  assert.equal(focusRequested(null), false);
});

test('legacyNoFocus：兼容旧参数，仅作诊断', () => {
  assert.equal(legacyNoFocus({ noFocus: true }), true);
  assert.equal(legacyNoFocus({ noFocus: false }), false);
  assert.equal(legacyNoFocus({}), false);
});

test('策略说明文案存在（CLI/文档共用）', () => {
  assert.match(FOCUS_POLICY_NOTE, /后台/);
  assert.match(FOCUS_POLICY_NOTE, /--focus/);
});
