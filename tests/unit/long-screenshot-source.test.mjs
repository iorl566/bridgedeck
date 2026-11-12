import test from 'node:test';
import assert from 'node:assert/strict';
import { openScreenshotSource } from '../../extension/src/long-screenshot/source.js';
import { ScreenshotError } from '../../extension/src/long-screenshot/types.js';

const signal = () => new AbortController().signal;

test('openScreenshotSource prefers visible-tab capture', async () => {
  let shots = 0;
  const api = {
    tabs: { async captureVisibleTab() { shots += 1; return 'data:image/png;base64,x'; } },
    debugger: {},
  };
  const source = await openScreenshotSource(1, 2, signal(), async () => {}, true, undefined, api);
  assert.equal(await source.capture(), 'data:image/png;base64,x');
  assert.equal(shots, 2);
  await source.close();
});

test('openScreenshotSource falls back to debugger', async () => {
  const api = {
    tabs: { async captureVisibleTab() { throw new Error('no surface'); } },
    debugger: {
      async attach() {},
      async sendCommand(_target, method) { return method === 'Page.captureScreenshot' ? { data: 'abc' } : {}; },
      async detach() {},
    },
  };
  const source = await openScreenshotSource(1, 2, signal(), async () => {}, true, undefined, api);
  assert.equal(await source.capture(), 'data:image/png;base64,abc');
  await source.close();
});

test('openScreenshotSource reports unavailable when debugger disallowed', async () => {
  const api = {
    tabs: { async captureVisibleTab() { throw new Error('no surface'); } },
    debugger: {},
  };
  await assert.rejects(
    () => openScreenshotSource(1, 2, signal(), async () => {}, false, undefined, api),
    (error) => error instanceof ScreenshotError && error.code === 'unavailable',
  );
});
