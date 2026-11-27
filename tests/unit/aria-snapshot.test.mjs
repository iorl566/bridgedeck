import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAriaSnapshot } from '../../extension/src/lib/aria-snapshot.js';

test('ARIA 快照输出角色/名称树', () => {
  const text = renderAriaSnapshot([
    { role: 'dialog', name: '登录', depth: 0 },
    { role: 'textbox', name: '用户名', depth: 1 },
    { tag: 'button', name: '提交', depth: 1 },
  ]);
  assert.equal(text, '- dialog "登录"\n  - textbox "用户名"\n  - button "提交"');
});

test('ARIA 快照遵守字符预算', () => {
  const text = renderAriaSnapshot([
    { role: 'button', name: 'a'.repeat(120), depth: 0 },
    { role: 'button', name: 'b'.repeat(120), depth: 0 },
  ], { maxChars: 50 });
  assert.ok(text.length <= 50);
  assert.equal(text.split('\n').length, 1);
});

test('ARIA 快照跳过空节点', () => {
  assert.equal(renderAriaSnapshot([null, {}, { role: '', name: '' }]), '');
});
