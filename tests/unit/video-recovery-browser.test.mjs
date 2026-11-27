// tests/unit/video-recovery-browser.test.mjs —— 真实 Chromium 的视频崩溃恢复回归。
// 真实 MediaRecorder WebM 字节 → 分片 manifest seal → 末片截断 → partial 可播放前缀审计；
// 断言在浏览器页面内执行，本测试校验断言数与可读 JSON 摘要。
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

test('真实 Chromium：视频恢复（真实 WebM 字节 / 截断→partial 可播放 / 失败分类）', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/video-recovery-pipeline.html', { timeoutMs: 45000 });
  assert.match(
    result.title,
    /^VIDEO_RECOVERY_OK:\d+$/,
    result.title + '\n' + String(result.stderr || '').slice(0, 800),
  );
  const assertions = Number(/^VIDEO_RECOVERY_OK:(\d+)$/.exec(result.title)[1]);
  assert.ok(assertions >= 30, '浏览器内断言数应 >= 30，实际 ' + assertions);

  const match = /<pre id="recovery-summary-json"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout);
  assert.ok(match, '页面应输出 recovery-summary-json');
  const summary = JSON.parse(decodeEntities(match[1]));
  assert.equal(summary.scenario, 'video-crash-recovery');
  assert.match(summary.mimeType, /webm/);
  assert.ok(summary.bytes > 200, '真实录制字节应大于 200');
  assert.ok(summary.recoveredBytes > 0 && summary.recoveredBytes < summary.bytes, '恢复前缀应小于原始录制');
  assert.notEqual(summary.canPlayType, '');
  assert.equal(summary.recovery.state, 'recovered');
  assert.equal(summary.recovery.completeness, 'partial');
  assert.equal(summary.recovery.plan.truncated, 1);
  assert.equal(summary.scan.recordings[0].plan.completeness, 'partial');
  assert.equal(summary.patch.recording_state, 'recovered');
  assert.equal(summary.scenarios.truncated.byCategory['truncated-segment'], 1);
  assert.ok(summary.scenarios.firstMissing.byCategory['no-playable-prefix'] >= 1);
  assert.equal(summary.scenarios.corrupt.byCategory['corrupt-segment'], 1);
  assert.equal(summary.scenarios.scanUnavailable.byCategory['scan-unavailable'], 1);
});
