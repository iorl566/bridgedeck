import test from 'node:test';
import assert from 'node:assert/strict';
import { attachVideoBridge, isVideoPage } from '../../extension/src/video/bridge.js';
import { VIDEO_HOST_EVENT, VIDEO_MESSAGE } from '../../extension/src/video/types.js';

function harness() {
  const listeners = [];
  const runtime = {
    id: 'ext',
    getURL: (path) => `chrome-extension://ext/${path}`,
    onMessage: { addListener: (h) => listeners.push(h), removeListener: (h) => { const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1); } },
  };
  const calls = [];
  const video = {
    async tasks() { return []; },
    async list() { return [{ recording_id: 'r', owner: 'o', capability: 'c', request_id: 'x' }]; },
    async start() { return { recording: { recording_id: 'r' } }; },
    async stop() { calls.push('stop'); return { recording_id: 'r' }; },
    async discard() { calls.push('discard'); },
    async finished() { calls.push('finished'); },
    async queryOverlay() { return null; },
    async suspend() { return 'r'; },
  };
  const host = { async request() { return 'url'; } };
  const downloads = { async save() { calls.push('save'); return { download_id: 1 }; } };
  const dispose = attachVideoBridge(video, host, async () => 'interrupted', { runtime, downloads, webNavigation: { async getFrame() { return { frameType: 'outermost_frame', documentLifecycle: 'active' }; } } });
  return { listeners, runtime, calls, dispose };
}

test('snapshot from video page returns public recordings', async () => {
  const { listeners, runtime } = harness();
  const response = await new Promise((resolve) => listeners[0]({ kind: VIDEO_MESSAGE, action: 'snapshot' }, { id: 'ext', url: runtime.getURL('video.html') }, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.data.recordings[0].recording_id, 'r');
  assert.equal(response.data.recordings[0].owner, undefined);
});

test('forbidden sender and stop action', async () => {
  const { listeners, runtime, calls } = harness();
  const forbidden = await new Promise((resolve) => listeners[0]({ kind: VIDEO_MESSAGE, action: 'snapshot' }, { id: 'ext', url: 'https://evil' }, resolve));
  assert.equal(forbidden.ok, false);
  const stopped = await new Promise((resolve) => listeners[0]({ kind: VIDEO_MESSAGE, action: 'stop' }, { id: 'ext', url: runtime.getURL('popup.html') }, resolve));
  assert.equal(stopped.ok, true);
  assert(calls.includes('stop'));
});

test('offscreen finished event is forwarded', async () => {
  const { listeners, runtime, calls } = harness();
  await listeners[0]({ kind: VIDEO_HOST_EVENT, recording_id: 'r' }, { id: 'ext', url: runtime.getURL('video-offscreen.html') }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(calls.includes('finished'));
});

test('isVideoPage validates sender', () => {
  const runtime = { id: 'ext', getURL: (p) => `chrome-extension://ext/${p}` };
  assert.equal(isVideoPage({ id: 'ext', url: runtime.getURL('video.html') }, runtime), true);
  assert.equal(isVideoPage({ id: 'other', url: runtime.getURL('video.html') }, runtime), false);
});
