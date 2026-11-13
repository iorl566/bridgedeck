import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoError, videoError } from '../../extension/src/video/errors.js';
import { captureReply } from '../../extension/src/video/capture-deadline.js';

test('VideoError preserves protocol code/data', () => {
  const error = new VideoError({ code: 'busy', message: 'x', data: { a: 1 } });
  assert.equal(error.code, 'busy');
  assert.deepEqual(error.data, { a: 1 });
  assert.deepEqual(videoError(error), { code: 'busy', message: 'x', data: { a: 1 } });
});

test('videoError falls back for unknown errors', () => {
  assert.deepEqual(videoError(new Error('boom'), 'capture_failed'), { code: 'capture_failed', message: 'boom' });
  assert.deepEqual(videoError('x'), { code: 'cdp_failed', message: 'x' });
});

test('captureReply resolves and aborts', async () => {
  assert.equal(await captureReply(Promise.resolve(1), new AbortController().signal), 1);
  const controller = new AbortController();
  const pending = captureReply(new Promise(() => {}), controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(() => pending, /cancelled/);
});
