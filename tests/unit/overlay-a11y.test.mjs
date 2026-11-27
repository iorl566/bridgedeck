// tests/unit/overlay-a11y.test.mjs —— 无障碍浮层开关：设置默认值、注入模式、12 语言词条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../extension/src/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('overlayA11y 默认关闭，normalize 严格布尔', () => {
  assert.equal(DEFAULT_SETTINGS.overlayA11y, false);
  assert.equal(normalizeSettings({}).overlayA11y, false);
  assert.equal(normalizeSettings({ overlayA11y: true }).overlayA11y, true);
  assert.equal(normalizeSettings({ overlayA11y: 'yes' }).overlayA11y, false);
});

test('接管浮层：a11y 模式使用开放 shadow + ARIA，默认 closed', () => {
  const overlay = read('extension/src/overlay-ui.js');
  assert.match(overlay, /a11yAccessible/);
  assert.match(overlay, /mode: a11yAccessible \? 'open' : 'closed'/);
  assert.match(overlay, /aria-live/);
  const takeover = read('extension/src/takeover.js');
  assert.match(takeover, /overlayA11y/);
  assert.match(takeover, /mode: settings && settings\.overlayA11y/);
});

test('设置页与 12 语言词条齐全', () => {
  assert.match(read('extension/ui/options.html'), /id="overlayA11y"/);
  const label = '无障碍浮层（读屏可访问）';
  for (const lang of ['ar', 'de', 'es', 'fr', 'he', 'it', 'ja', 'ko', 'pt', 'zh-TW']) {
    const map = JSON.parse(read('translation/' + lang + '.json'));
    assert.ok(map[label], lang + ' 缺少词条');
  }
  assert.ok(read('extension/ui/i18n.js').includes(label));
  assert.ok(read('extension/ui/locales.js').includes(label));
});
