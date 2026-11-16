import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlGlow } from '../../extension/src/content/ControlGlow.js';
import { ControlInputBlocker } from '../../extension/src/content/ControlInputBlocker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ControlGlow renders both shadow layers', () => {
  const html = renderToStaticMarkup(React.createElement(ControlGlow));
  assert.match(html, /data-slot="control-overlay"/);
  assert.match(html, /data-slot="control-overlay-pulse"/);
  assert.match(html, /bb-breathe/);
});

test('呼吸动画必须无限循环，且不会停在低透明度', () => {
  const html = renderToStaticMarkup(React.createElement(ControlGlow));
  assert.doesNotMatch(html, /bb-breathe 3s ease-in-out 2\b/, '有限次数动画会在几秒后停在末帧');
  assert.match(html, /animation:\s*bb-breathe 3s ease-in-out infinite/, '呼吸效果要持续到浮层关闭');
  assert.doesNotMatch(html, /0%,\s*100%\s*\{\s*opacity:\s*0\s*\}/, '末帧不能回到全透明，否则看起来像"不再呼吸"');
  assert.match(html, /prefers-reduced-motion/, '减少动效偏好下要有静态可见效果');
});

test('接管浮层呼吸边框同样无限循环，暂停时停止', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'takeover.js'), 'utf8');
  assert.match(source, /animation:bbp 3s ease-in-out infinite/, '接管边框呼吸要持续');
  assert.doesNotMatch(source, /animation:bbp 3s ease-in-out 2/, '有限次数会让边框几十秒后变淡');
  assert.match(source, /\.glow\.paused::after\{animation:none/, '暂停态要停掉呼吸');
  assert.match(source, /classList\.toggle\('paused', paused\)/, '暂停状态要同步到光晕');
});

test('ControlInputBlocker toggles pointer events', () => {
  const blocked = renderToStaticMarkup(React.createElement(ControlInputBlocker, { automationBypass: false }));
  const bypassed = renderToStaticMarkup(React.createElement(ControlInputBlocker, { automationBypass: true }));
  assert.match(blocked, /pointer-events:auto/);
  assert.match(bypassed, /pointer-events:none/);
});
