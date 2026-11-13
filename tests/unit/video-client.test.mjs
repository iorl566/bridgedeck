import test from 'node:test';
import assert from 'node:assert/strict';
import { videoRequest, videoTime } from '../../extension/src/video/client.js';

test('videoRequest unwraps response and errors', async () => {
  const sent = [];
  const value = await videoRequest('snapshot', { a: 1 }, async (message) => { sent.push(message); return { ok: true, data: { tasks: [] } }; });
  assert.deepEqual(value, { tasks: [] });
  assert.equal(sent[0].kind, 'bb/video');
  assert.equal(sent[0].action, 'snapshot');
  await assert.rejects(() => videoRequest('start', {}, async () => ({ ok: false, error: 'busy' })), /busy/);
});

test('videoTime formats minutes/seconds', () => {
  assert.equal(videoTime(0), '0:00');
  assert.equal(videoTime(65_000), '1:05');
  assert.equal(videoTime(-1), '0:00');
});
