import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function fakeApi() {
  const events = [];
  const detached = [];
  const commands = [];
  const listeners = new Set();
  const api = {
    async attach(target) { events.push(['attach', target.tabId]); },
    async detach(target) { events.push(['detach', target.tabId]); },
    async sendCommand(target, method, params) { commands.push([target.tabId, method, params]); },
    onEvent: {
      addListener: (fn) => { listeners.add(fn); events.push(['onEvent', fn]); },
      removeListener: (fn) => { listeners.delete(fn); },
    },
    onDetach: {
      addListener: (fn) => detached.push(fn),
      removeListener: (fn) => { const index = detached.indexOf(fn); if (index >= 0) detached.splice(index, 1); },
    },
  };
  // Observation is split across domain listeners, so every event must be
  // delivered to all of them instead of only the first registration.
  const emit = (source, method, params) => { for (const fn of [...listeners]) fn(source, method, params); };
  const fireDetach = (source, reason) => { for (const fn of [...detached]) fn(source, reason); };
  return { api, events, detached, commands, emit, fireDetach, listenerCount: () => listeners.size };
}

test('ensureAttached coalesces concurrent attach', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await Promise.all([cdp.ensureAttached(7), cdp.ensureAttached(7)]);
  assert.equal(h.events.filter((event) => event[0] === 'attach').length, 1);
  assert.equal(cdp.isAttached(7), true);
  assert.match(cdp.getAttachmentId(7), /[0-9a-f-]{36}/);
});

test('send and detach lifecycle', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureAttached(7);
  await cdp.send(7, 'Runtime.evaluate', { expression: '1' });
  assert.deepEqual(h.commands.find((command) => command[1] === 'Runtime.evaluate'), [7, 'Runtime.evaluate', { expression: '1' }]);
  await cdp.detach(7);
  assert.equal(cdp.isAttached(7), false);
  assert.equal(cdp.getAttachmentId(7), undefined);
  assert(h.events.some((event) => event[0] === 'detach'));
});

test('events dispatch and detach cleanup', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  const seen = [];
  cdp.onEvent((source, method) => seen.push([source.tabId, method]));
  await cdp.ensureAttached(7);
  h.emit({ tabId: 7 }, 'Page.loadEventFired', {});
  assert.deepEqual(seen, [[7, 'Page.loadEventFired']]);
  // A domain event also handled internally still reaches a public subscriber
  // exactly once: splitting the listeners must not duplicate the callback.
  h.emit({ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'once' }] });
  assert.deepEqual(seen, [[7, 'Page.loadEventFired'], [7, 'Runtime.consoleAPICalled']]);
  h.fireDetach({ tabId: 7 }, 'target_closed');
  assert.equal(cdp.isAttached(7), false);
});

test('background execution retains and releases focus override', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureAttached(7);
  await cdp.acquireBackgroundExecution('s1', 7);
  assert.equal(cdp.ownsBackgroundExecution('s1', 7), true);
  assert.deepEqual(h.commands.at(-1), [7, 'Emulation.setFocusEmulationEnabled', { enabled: true }]);
  await cdp.releaseBackgroundExecution('s1', 7);
  assert.equal(cdp.ownsBackgroundExecution('s1', 7), false);
  assert.deepEqual(h.commands.at(-1), [7, 'Emulation.setFocusEmulationEnabled', { enabled: false }]);
});

test('console capture enables domains and projects entries', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureConsoleCapture(7);
  assert.deepEqual(h.commands.filter((command) => ['Runtime.enable', 'Log.enable', 'Runtime.evaluate'].includes(command[1])).map((command) => command[1]), ['Runtime.enable', 'Log.enable', 'Runtime.evaluate']);
  h.emit({ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }] });
  h.emit({ tabId: 7 }, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'Error: bad' } });
  const result = cdp.consoleEntriesSince(7, undefined, 10, 3, false);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].text, 'hel');
  assert.equal(result.entries[0].truncated, true);
  assert.equal(result.next_since, 2);
  assert.equal('stack_trace' in result.entries[0], false);
});

test('console cursor only returns newer entries', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureConsoleCapture(7);
  h.emit({ tabId: 7 }, 'Log.entryAdded', { entry: { text: 'one', level: 'info' } });
  h.emit({ tabId: 7 }, 'Log.entryAdded', { entry: { text: 'two', level: 'info' } });
  const result = cdp.consoleEntriesSince(7, 1, 10, 100, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].text, 'two');
  assert.equal(result.next_since, 2);
});

test('network capture records response and failure', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureNetworkCapture(7);
  assert.ok(h.commands.some((command) => command[1] === 'Network.enable'));
  h.emit({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://x', method: 'GET' }, type: 'Document' });
  h.emit({ tabId: 7 }, 'Network.responseReceived', { requestId: 'r1', type: 'Document', response: { url: 'https://x', status: 200, statusText: 'OK', mimeType: 'text/html' } });
  h.emit({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://y', method: 'POST' }, type: 'XHR' });
  h.emit({ tabId: 7 }, 'Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED', type: 'XHR' });
  const result = cdp.networkEntriesSince(7, undefined, 10, 100);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].kind, 'response');
  assert.equal(result.entries[0].status, 200);
  assert.equal(result.entries[1].kind, 'failure');
  assert.equal(result.entries[1].error_text, 'net::ERR_FAILED');
  assert.equal(result.next_since, 2);
});

test('dialog opening/resolve records handled action', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.ensureAttached(7);
  h.emit({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'sure?', url: 'https://x' });
  const pending = cdp.pendingDialogs(7);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message, 'sure?');
  assert.equal(cdp.dialogCursor(7), 1);
  const resolving = cdp.resolveDialog(pending[0].id, true);
  h.emit({ tabId: 7 }, 'Page.javascriptDialogClosed', { result: true });
  await resolving;
  assert.equal(cdp.pendingDialogs(7).length, 0);
  const records = cdp.dialogsSince(7, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].handled, 'accepted');
  assert.deepEqual(h.commands.at(-1), [7, 'Page.handleJavaScriptDialog', { accept: true }]);
});

test('dialog closed event records dismissed', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  h.emit({ tabId: 7 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  h.emit({ tabId: 7 }, 'Page.javascriptDialogClosed', { result: false });
  assert.equal(cdp.pendingDialogs(7).length, 0);
  assert.equal(cdp.dialogsSince(7, 0)[0].handled, 'dismissed');
});

test('emulation methods forward their payloads', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.setDeviceMetricsOverride(7, { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await cdp.clearDeviceMetricsOverride(7);
  await cdp.setUserAgentOverride(7, { userAgent: 'UA', acceptLanguage: 'zh' });
  await cdp.setTouchEmulationEnabled(7, true);
  assert.deepEqual(h.commands.filter((command) => command[1].startsWith('Emulation.')), [
    [7, 'Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }],
    [7, 'Emulation.clearDeviceMetricsOverride', {}],
    [7, 'Emulation.setUserAgentOverride', { userAgent: 'UA', acceptLanguage: 'zh' }],
    [7, 'Emulation.setTouchEmulationEnabled', { enabled: true }],
  ]);
});

test('touch emulation includes maxTouchPoints only when provided', async () => {
  const h = fakeApi();
  const cdp = new ChromiumCdp(h.api);
  await cdp.setTouchEmulationEnabled(7, false, 5);
  assert.deepEqual(h.commands.at(-1), [7, 'Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 5 }]);
});

test('getFrameGraph builds from Page.getFrameTree', async () => {
  const h = fakeApi();
  h.api.sendCommand = async (target, method) => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'root', url: 'https://x' }, childFrames: [{ frame: { id: 'child', parentId: 'root', url: 'https://y' } }] } };
    }
    return {};
  };
  const cdp = new ChromiumCdp(h.api);
  const graph = await cdp.getFrameGraph(7);
  assert.equal(graph.rootFrameId, 'root');
  assert.deepEqual(graph.frames.map((frame) => frame.frameId), ['root', 'child']);
  assert.equal(graph.frames[1].parentFrameId, 'root');
});
