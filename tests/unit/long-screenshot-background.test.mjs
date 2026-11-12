import test from 'node:test';
import assert from 'node:assert/strict';
import { createLongScreenshotController } from '../../extension/src/long-screenshot/background.js';

function harness(overrides = {}) {
  const values = new Map();
  const storage = { async get(key) { return { [key]: values.get(key) }; }, async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, value); } };
  const tabs = { async query() { return [{ id: 7, windowId: 1, url: 'https://x', title: 'X' }]; } };
  const calls = [];
  const controller = createLongScreenshotController({
    storage,
    tabs,
    runtime: { getURL: (path) => (path === '/' ? 'chrome-extension://x/' : `chrome-extension://x/${path}`) },
    isTabBusy: () => false,
    capture: async (options) => { calls.push(['capture', options.mode]); options.progress(50, 1); return { width: 100, height: 200 }; },
    preview: async (id) => calls.push(['preview', id]),
    ...overrides,
  });
  return { controller, values, calls, sender: { url: 'chrome-extension://x/longshot.html' } };
}

test('start captures and publishes complete state', async () => {
  const h = harness();
  await h.controller.restore();
  const result = await h.controller.handle({ action: 'start', mode: 'auto' }, h.sender);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.ok, true);
  assert.equal(h.controller.state.phase, 'complete');
  assert.equal(h.controller.state.height, 200);
  assert.deepEqual(h.calls[0], ['capture', 'auto']);
});

test('busy tab is rejected', async () => {
  const h = harness({ isTabBusy: () => true });
  const result = await h.controller.handle({ action: 'start', mode: 'auto' }, h.sender);
  assert.deepEqual(result, { ok: false, error: 'busy' });
});

test('cancel aborts a running capture', async () => {
  let signal;
  const h = harness({ capture: ({ signal: captureSignal }) => { signal = captureSignal; return new Promise((_, reject) => captureSignal.addEventListener('abort', () => reject(new Error('aborted')))); } });
  await h.controller.handle({ action: 'start', mode: 'auto' }, h.sender);
  const id = h.controller.state.id;
  assert.equal(await h.controller.handle({ action: 'cancel', id }, h.sender).then((r) => r.ok), true);
  assert.equal(signal.aborted, true);
});

test('forbidden sender and preview validation', async () => {
  const h = harness();
  assert.deepEqual(await h.controller.handle({ action: 'start' }, { url: 'https://evil' }), { ok: false, error: 'unsupported' });
  assert.deepEqual(await h.controller.handle({ action: 'preview', id: 'missing' }, h.sender), { ok: false, error: 'unavailable' });
});
