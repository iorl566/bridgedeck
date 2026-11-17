import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runOverlayDomTests } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

test('真实内联浮层 DOM 组件测试（借用/Help/Takeover/深色）', { skip: !browser }, async () => {
  const result = await runOverlayDomTests({ timeoutMs: 15000 });
  assert.match(result.title, /^OVERLAY_DOM_OK:\d+$/, result.title);
});
