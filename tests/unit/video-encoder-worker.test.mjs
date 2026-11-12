import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoWorkerHandler } from '../../extension/src/video/encoder-worker.js';

function harness() {
  const posted = [];
  const store = { values: new Map(), async get(id) { return this.values.get(id); }, async put(value) { this.values.set(value.recording_id, value); } };
  const pipeline = { started: 0, frames: [], stopped: [], async start() { this.started += 1; return { recording_id: 'r' }; }, async frame(image, elapsed) { this.frames.push([image, elapsed]); return 'frame'; }, async stop(reason) { this.stopped.push(reason); return { recording_id: 'r' }; }, async suspend() { return 'suspended'; } };
  const handler = createVideoWorkerHandler({ store, createPipeline: () => pipeline, finishVideo: async (value) => ({ ...value, state: 'ready' }), post: (message) => posted.push(message) });
  return { handler, pipeline, store, posted };
}

test('idle is true without active work', async () => {
  const { handler } = harness();
  assert.equal(await handler.execute({ action: 'idle' }), true);
});

test('start/frame/stop route to the pipeline', async () => {
  const { handler, pipeline, posted } = harness();
  const recording = { recording_id: 'r' };
  await handler.execute({ action: 'start', recording, image: 'x' });
  assert.equal(pipeline.started, 1);
  assert.equal(await handler.execute({ action: 'frame', recording_id: 'r', image: 'y', elapsed_ms: 5 }), 'frame');
  assert.deepEqual(pipeline.frames, [['y', 5]]);
  assert.deepEqual(await handler.execute({ action: 'stop', recording_id: 'r', reason: 'user_stopped' }), { recording_id: 'r' });
  assert.deepEqual(pipeline.stopped, ['user_stopped']);
  assert.equal(posted.length, 0);
});

test('stop without active recovers and posts finished', async () => {
  const { handler, store, posted } = harness();
  store.values.set('r', { recording_id: 'r', state: 'recording' });
  const result = await handler.execute({ action: 'stop', recording_id: 'r', reason: 'user_stopped' });
  assert.equal(result.state, 'ready');
  assert(posted.some((message) => message.event === 'finished' && message.recording_id === 'r'));
});
