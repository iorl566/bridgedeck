#!/usr/bin/env node
// tools/overlay-dom-selftest.mjs —— 真实 Chromium DOM 里的内联浮层组件测试。
// 覆盖借用模态/Toast、Help（closed shadow）、Takeover，以及深色 token。
import { runOverlayDomTests } from './lib/overlay-dom-harness.mjs';

const result = await runOverlayDomTests();
if (!result.title.startsWith('OVERLAY_DOM_OK:')) {
  console.error(result.title || `exit ${result.code}`);
  console.error(result.stdout.slice(0, 2000));
  console.error(result.stderr.slice(0, 1000));
  process.exitCode = 1;
} else {
  console.log('overlay DOM selftest OK: ' + result.title);
}
