import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('控制呼吸框保留外层环 + 呼吸层，且动画无限循环', () => {
  const source = fs.readFileSync('extension/src/overlay-ui.js', 'utf8');
  assert.match(source, /\.glow\{[^}]*inset 0 0 20px 4px rgba\(249,115,22,\.25\)/, '缺少 0.1.7 外层光晕');
  assert.match(source, /\.glow::after\{[^}]*inset 0 0 40px 8px rgba\(249,115,22,\.5\)/, '缺少 0.1.7 呼吸光晕');
  assert.match(source, /animation:bbp 3s ease-in-out infinite/, '呼吸动画不是无限循环');
  assert.match(source, /prefers-reduced-motion/, '缺少 reduced-motion 关闭');
});
