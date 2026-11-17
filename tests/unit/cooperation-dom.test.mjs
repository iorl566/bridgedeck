import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrowser, runHeadlessPage } from '../../tools/lib/overlay-dom-harness.mjs';

const browser = findBrowser();

test('协作输入层真实 DOM：输入锁/passthrough/read', { skip: !browser }, async () => {
  const result = await runHeadlessPage('tests/browser/cooperation-dom.html', { timeoutMs: 15000 });
  assert.match(result.title, /^COOP_DOM_OK:\d+$/, result.title);
});
