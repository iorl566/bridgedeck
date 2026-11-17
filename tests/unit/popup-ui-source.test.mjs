import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../../extension/ui/popup.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../extension/ui/popup.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../extension/ui/popup.css', import.meta.url), 'utf8');

test('Popup 有版本不兼容提示和复制命令入口', () => {
  assert.match(html, /id="upgradeNotice"/);
  assert.match(html, /id="upgradeCommand"/);
  assert.match(html, /id="copyUpgrade"/);
  assert.match(js, /state\.protocolSkew/);
  assert.match(js, /\$\('copyUpgrade'\)\.addEventListener/);
});

test('Popup 显示本地配对验证状态', () => {
  assert.match(js, /auth\.state === 'unverified_local'/);
  assert.match(js, /auth\.state === 'pairing_required'/);
  assert.match(js, /localAuthBadge/);
});
