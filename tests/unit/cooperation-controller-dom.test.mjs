// 真实 Chromium DOM：controller 状态机 + 浮层抑制（真实 visibility 变化）+ 只读快照聚合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

test('协作 controller 真实 DOM：浮层抑制/状态机/快照', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/cooperation-controller.html', { timeoutMs: 15000 });
  assert.match(result.title, /^COOP_CTRL_OK:\d+$/, result.title + '\n' + String(result.stderr || '').slice(0, 800));
});
