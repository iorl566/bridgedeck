import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('控制呼吸框保留外层环 + 呼吸层，且动画无限循环', () => {
  const source = fs.readFileSync('extension/src/overlay-ui.js', 'utf8');
  assert.match(source, /\.glow\{[^}]*inset 0 0 0 3px/, '缺少常驻内环');
  assert.match(source, /\.glow::after\{[^}]*inset 0 0 48px 10px/, '缺少呼吸光晕');
  assert.match(source, /animation:bbp 3s ease-in-out infinite/, '呼吸动画不是无限循环');
  assert.match(source, /prefers-reduced-motion/, '缺少 reduced-motion 关闭');
});
