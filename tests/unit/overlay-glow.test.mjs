import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('控制呼吸框保留高对比外环 + 高亮呼吸层，且动画无限循环', () => {
  const source = fs.readFileSync('extension/src/overlay-ui.js', 'utf8');
  assert.doesNotMatch(source, /\.glow\{[^}]*inset 0 0 0 [0-9]+px/, '不应有包裹线');
  assert.match(source, /\.glow\{[^}]*inset 0 0 28px 8px rgba\(122,167,255,\.55\)/, '缺少柔和外发光');
  assert.match(source, /\.glow::after\{[^}]*inset 0 0 80px 20px rgba\(122,167,255,\.55\)/, '缺少高亮呼吸层');
  assert.match(source, /animation:bbp 3s ease-in-out infinite/, '呼吸动画不是无限循环');
  assert.match(source, /prefers-reduced-motion/, '缺少 reduced-motion 关闭');
});
