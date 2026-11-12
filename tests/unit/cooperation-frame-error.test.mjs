import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameCollectionError, FrameUnresponsiveError } from '../../extension/src/cooperation/frame-error.js';

const frames = [{ frame_id: 1, url: 'https://a' }, { frame_id: 2, url: 'https://b' }];

test('FrameCollectionError maps reason, frames and effect', () => {
  const error = new FrameCollectionError('frame_unobservable', frames);
  const rpc = error.toRpcError('unknown');
  assert.equal(rpc.code, 'permission_denied');
  assert.equal(rpc.data.reason, 'frame_unobservable');
  assert.equal(rpc.data.effect_state, 'unknown');
  assert.deepEqual(rpc.data.frames, frames);
  assert.match(rpc.data.recovery, /Never replay/);
  assert.match(rpc.message, /1 \(https:\/\/a\)/);
});

test('page load failure and unresponsive frames have distinct messages', () => {
  assert.match(new FrameCollectionError('page_load_failed', frames).message, /main page failed/);
  assert.match(new FrameUnresponsiveError(frames).message, /not responding/);
});
