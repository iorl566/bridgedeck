import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

test('dispose clears dialog, console, network and frame state', async () => {
  const listeners = new Set();
  const detachListeners = new Set();
  const api = {
    async attach() {},
    async detach() {},
    async sendCommand() { return {}; },
    onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    onDetach: { addListener: (fn) => detachListeners.add(fn), removeListener: (fn) => detachListeners.delete(fn) },
  };
  const cdp = new ChromiumCdp(api);
  await cdp.ensureAttached(7);
  // Observation is split across domain listeners: dispatch each event to all
  // of them instead of only the first registration.
  const emit = (method, params) => { for (const fn of [...listeners]) fn({ tabId: 7 }, method, params); };
  assert.equal(listeners.size, 4);
  assert.equal(detachListeners.size, 1);
  emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  emit('Runtime.consoleAPICalled', { type: 'log', args: [] });
  emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x' } });
  assert.equal(cdp.pendingDialogs(7).length, 1);
  cdp.dispose();
  assert.equal(cdp.pendingDialogs(7).length, 0);
  assert.equal(cdp.consoleEntriesSince(7, undefined, 10, 100, false).entries.length, 0);
  assert.equal(cdp.networkEntriesSince(7, undefined, 10, 100).entries.length, 0);
  assert.equal(listeners.size, 0);
  assert.equal(detachListeners.size, 0);
});
