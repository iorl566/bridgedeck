import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreencastCoordinator, screencasts, shareScreencasts } from '../../extension/src/browser-driver/screencast-coordinator.js';

function harness() {
  const calls = [];
  const frames = [];
  const cdp = {
    attachment: 'a',
    getAttachmentId() { return this.attachment; },
    onEvent(callback) { this.emit = callback; return { dispose() {} }; },
    async send(tabId, method, params) { calls.push({ tabId, method, params }); return {}; },
  };
  return { cdp, calls, frames };
}

test('acquire starts screencast, routes frame and ACKs', async () => {
  const { cdp, calls, frames } = harness();
  const coordinator = new ScreencastCoordinator(cdp);
  const lease = await coordinator.acquire(7, { maxWidth: 800, maxHeight: 600, format: 'jpeg', quality: 70, frame: (frame) => frames.push(frame) });
  assert(calls.some((call) => call.method === 'Page.startScreencast' && call.params.maxWidth === 800));
  cdp.emit({ tabId: 7, sessionId: undefined }, 'Page.screencastFrame', { data: 'x', metadata: { timestamp: 1 }, sessionId: 3 });
  assert.equal(frames.length, 1);
  assert(calls.some((call) => call.method === 'Page.screencastFrameAck' && call.params.sessionId === 3));
  await lease.release();
  assert(calls.some((call) => call.method === 'Page.stopScreencast'));
});

test('largest request config wins and reconfigure stops first', async () => {
  const { cdp, calls } = harness();
  const coordinator = new ScreencastCoordinator(cdp);
  const a = await coordinator.acquire(7, { maxWidth: 400, maxHeight: 300, format: 'png' });
  const b = await coordinator.acquire(7, { maxWidth: 1600, maxHeight: 1200, format: 'jpeg' });
  assert(calls.some((call) => call.method === 'Page.startScreencast' && call.params.maxWidth === 1600));
  assert(calls.filter((call) => call.method === 'Page.stopScreencast').length >= 1);
  await a.release();
  await b.release();
});

test('screencasts caches per runner and shareScreencasts aliases', () => {
  const owner = harness().cdp;
  const wrapper = harness().cdp;
  assert.equal(screencasts(owner), screencasts(owner));
  shareScreencasts(owner, wrapper);
  assert.equal(screencasts(wrapper), screencasts(owner));
});
