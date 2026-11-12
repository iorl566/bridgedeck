import test from 'node:test';
import assert from 'node:assert/strict';
import { isCapturing, LONG_SCREENSHOT, LONG_SCREENSHOT_PAGE, ScreenshotError } from '../../extension/src/long-screenshot/types.js';
import { waitForReply } from '../../extension/src/long-screenshot/wait.js';

test('capture state and neutral constants', () => {
  assert.equal(isCapturing({ phase: 'capturing' }), true);
  assert.equal(isCapturing({ phase: 'complete' }), false);
  assert.equal(isCapturing(null), false);
  assert.equal(LONG_SCREENSHOT, 'bb/long-screenshot');
  assert.equal(LONG_SCREENSHOT_PAGE, 'bb/long-screenshot-page');
});

test('waitForReply resolves and rejects underlying errors', async () => {
  assert.equal(await waitForReply(Promise.resolve(7), undefined, 100), 7);
  await assert.rejects(() => waitForReply(Promise.reject(new Error('x')), undefined, 100), /x/);
});

test('waitForReply times out', async () => {
  await assert.rejects(() => waitForReply(new Promise(() => {}), undefined, 5), (error) => error instanceof ScreenshotError && error.code === 'timeout');
});

test('waitForReply aborts', async () => {
  const controller = new AbortController();
  const pending = waitForReply(new Promise(() => {}), controller.signal, 1000);
  controller.abort(new ScreenshotError('interrupted'));
  await assert.rejects(() => pending, (error) => error instanceof ScreenshotError && error.code === 'interrupted');
});
