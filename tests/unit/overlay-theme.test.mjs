import test from 'node:test';
import assert from 'node:assert/strict';
import { AA_CONTRAST, contrastRatio } from '../../lib/color-contrast.mjs';
import {
  OVERLAY_THEME,
  overlayThemeCssText,
  overlayThemeMode,
  overlayThemeTokens,
} from '../../extension/src/overlay-theme.js';

const rgb = (hex) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

const PAIRS = [
  ['--bb-fg', '--bb-surface'],
  ['--bb-fg', '--bb-surface-raised'],
  ['--bb-muted', '--bb-surface'],
  ['--bb-body', '--bb-surface'],
  ['--bb-accent-fg', '--bb-accent'],
  ['--bb-accent-strong', '--bb-accent-soft'],
  ['--bb-warn-fg', '--bb-warn-bg'],
];

test('light/dark 使用同一组 token 名', () => {
  assert.deepEqual(Object.keys(OVERLAY_THEME.light).sort(), Object.keys(OVERLAY_THEME.dark).sort());
  assert.ok(Object.keys(OVERLAY_THEME.light).every((key) => key.startsWith('--bb-')));
});

test('浮层文字 token 在浅色/深色下都满足 WCAG AA', () => {
  for (const mode of ['light', 'dark']) {
    const tokens = overlayThemeTokens(OVERLAY_THEME, mode);
    for (const [foreground, background] of PAIRS) {
      const ratio = contrastRatio(rgb(tokens[foreground]), rgb(tokens[background]));
      assert.ok(ratio >= AA_CONTRAST, `${mode} ${foreground} on ${background} = ${ratio.toFixed(2)} < ${AA_CONTRAST}`);
    }
  }
});

test('主题模式支持页面强制覆盖，否则跟随系统偏好', () => {
  const root = (value) => ({ getAttribute: (name) => (name === 'data-bb-theme' ? value : null) });
  assert.equal(overlayThemeMode(root('dark'), { matches: false }), 'dark');
  assert.equal(overlayThemeMode(root('light'), { matches: true }), 'light');
  assert.equal(overlayThemeMode(root(null), { matches: true }), 'dark');
  assert.equal(overlayThemeMode(root(null), { matches: false }), 'light');
  assert.equal(overlayThemeMode(root(null), null), 'light');
});

test('token 表可序列化为页面 inline style', () => {
  const css = overlayThemeCssText(OVERLAY_THEME.dark);
  assert.match(css, /--bb-surface:#1c2230/);
  assert.match(css, /--bb-accent:#5b8cff/);
});
