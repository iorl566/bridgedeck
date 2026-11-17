import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePageDiagnostics } from '../../lib/diagnostics.mjs';

test('正常真实浏览器标记', () => {
  const result = summarizePageDiagnostics({ webdriver: false, mainWorldBB: false, overlay: true, chrome: true, plugins: 5, languages: 'zh-CN,en' });
  assert.equal(result.ok, true);
  assert.ok(result.findings.some((item) => item.code === 'OVERLAY'));
  assert.ok(result.findings.some((item) => item.code === 'WEBDRIVER' && item.level === 'ok'));
});

test('webdriver=true 或主世界泄漏时失败', () => {
  assert.equal(summarizePageDiagnostics({ webdriver: true }).ok, false);
  assert.equal(summarizePageDiagnostics({ webdriver: false, mainWorldBB: true }).ok, false);
});
