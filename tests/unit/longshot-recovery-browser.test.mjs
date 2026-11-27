// tests/unit/longshot-recovery-browser.test.mjs —— 真实 Chromium 的长截图崩溃恢复回归。
// 分片 hash 篡改 → refetch、未 sealed → rebuild-partial、补齐 seal → already-sealed；
// 断言全部在浏览器页面内执行，本测试只校验标题断言数与可读 JSON 摘要。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('真实 Chromium：长截图恢复（hash 篡改→refetch / 未 sealed→recover / 补齐 seal）', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/longshot-recovery-pipeline.html', { timeoutMs: 45000 });
  assert.match(
    result.title,
    /^LONGSHOT_RECOVERY_OK:\d+$/,
    result.title + '\n' + String(result.stderr || '').slice(0, 800),
  );
  const assertions = Number(/^LONGSHOT_RECOVERY_OK:(\d+)$/.exec(result.title)[1]);
  assert.ok(assertions >= 30, '浏览器内断言数应 >= 30，实际 ' + assertions);

  // 页面同时输出机器可读恢复摘要（JSON），用于回归“可读摘要/失败原因分类”。
  const match = /<pre id="recovery-summary-json"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout);
  assert.ok(match, '页面应输出 recovery-summary-json');
  const summary = JSON.parse(decodeEntities(match[1]));
  assert.equal(summary.scenario, 'crash-recovery');
  assert.equal(summary.repaired.action, 'rebuild-partial');
  assert.equal(summary.repaired.sealed, false);
  assert.equal(summary.repaired.refetch[0].reason, 'missing');
  assert.equal(summary.repaired.refetch[0].category, 'missing-segment');
  assert.equal(summary.tampered.mismatched[0].reason, 'hash-mismatch');
  assert.equal(summary.tampered.mismatched[0].category, 'stale-or-corrupted');
  assert.equal(summary.tampered.byReason['stale-or-corrupted'], 1);
  assert.match(summary.repaired.text, /恢复 cap-crash/);
});
