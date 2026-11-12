import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness(options = {}) {
  const sent = [];
  const detached = [];
  const eventListeners = new Set();
  const detachListeners = new Set();
  const api = {
    attachCalls: 0,
    commandImpl: null,
    async attach() { api.attachCalls += 1; },
    async detach(target) { detached.push(target.tabId); },
    async sendCommand(target, method, params) {
      sent.push([target, method, params]);
      if (api.commandImpl) return api.commandImpl(target, method, params);
      return {};
    },
    onEvent: {
      addListener(fn) { eventListeners.add(fn); },
      removeListener(fn) { eventListeners.delete(fn); },
    },
    onDetach: {
      addListener(fn) { detachListeners.add(fn); },
      removeListener(fn) { detachListeners.delete(fn); },
    },
  };
  const cdp = new ChromiumCdp(api, options);
  return {
    api,
    cdp,
    sent,
    detached,
    emit: (source, method, params) => { for (const fn of [...eventListeners]) fn(source, method, params); },
    fireDetach: (source, reason) => { for (const fn of [...detachListeners]) fn(source, reason); },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('send attaches lazily and normalizes a non-Error debugger failure', async () => {
  const h = harness();
  h.api.commandImpl = (_target, method) => {
    if (method === 'DOM.getDocument') throw 'frame got detached';
    return {};
  };
  await assert.rejects(
    h.cdp.send(9, 'DOM.getDocument'),
    (error) => error instanceof Error && /frame got detached/.test(error.message),
  );
  assert.equal(h.cdp.isAttached(9), true);
  assert.equal(h.api.attachCalls, 1);
  assert.deepEqual(h.sent.find(([, method]) => method === 'Page.enable')[0], { tabId: 9 });
  h.cdp.dispose();
});

test('send refuses an already aborted signal without attaching', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.cdp.send(9, 'DOM.getDocument', {}, controller.signal),
    (error) => error.name === 'AbortError',
  );
  assert.equal(h.api.attachCalls, 0);
  assert.equal(h.cdp.isAttached(9), false);
  h.cdp.dispose();
});

test('syncSessions releases dead owners and detaches unowned attachments', async () => {
  const h = harness();
  await h.cdp.ensureAttached(1);
  await h.cdp.ensureAttached(2);
  await h.cdp.ensureAttached(3);
  h.cdp.trackSessionTab('aa11', 1);
  h.cdp.trackSessionTab('bb22', 2);

  await h.cdp.syncSessions(new Set(['bb22']));
  assert.equal(h.cdp.isAttached(1), false);
  assert.equal(h.cdp.isAttached(2), true);
  assert.equal(h.cdp.isAttached(3), false);
  assert.ok(h.detached.includes(1));
  assert.ok(h.detached.includes(3));
  assert.equal(h.detached.includes(2), false);

  await h.cdp.syncSessions(new Set());
  assert.equal(h.cdp.isAttached(2), false);
  assert.ok(h.detached.includes(2));
  h.cdp.dispose();
});

test('syncSessions keeps a tab claimed by a newer session while an earlier sync runs', async () => {
  const h = harness();
  let finishDetach;
  h.api.detach = async (target) => {
    h.detached.push(target.tabId);
    if (!finishDetach) await new Promise((resolve) => { finishDetach = resolve; });
  };
  await h.cdp.ensureAttached(1);
  h.cdp.trackSessionTab('aa11', 1);
  const firstSync = h.cdp.syncSessions(new Set());
  for (let i = 0; i < 50 && !finishDetach; i += 1) await tick();
  assert.equal(typeof finishDetach, 'function');

  h.cdp.trackSessionTab('bb22', 2);
  await h.cdp.ensureAttached(2);
  const secondSync = h.cdp.syncSessions(new Set(['bb22']));

  finishDetach();
  await Promise.all([firstSync, secondSync]);
  assert.equal(h.cdp.isAttached(1), false);
  assert.equal(h.cdp.isAttached(2), true);
  assert.equal(h.detached.includes(2), false);
  h.cdp.dispose();
});

test('detachSession only detaches tabs no other session owns', async () => {
  const h = harness();
  await h.cdp.ensureAttached(1);
  await h.cdp.ensureAttached(2);
  h.cdp.trackSessionTab('aa11', 1);
  h.cdp.trackSessionTab('bb22', 1);
  h.cdp.trackSessionTab('aa11', 2);

  await h.cdp.detachSession('aa11');
  assert.deepEqual(h.detached, [2]);
  assert.equal(h.cdp.isAttached(1), true);
  assert.equal(h.cdp.isAttached(2), false);

  await h.cdp.detachSession('bb22');
  assert.deepEqual(h.detached, [2, 1]);
  assert.equal(h.cdp.isAttached(1), false);
  h.cdp.dispose();
});

test('a failed acquisition releases the claim it created', async () => {
  const h = harness();
  h.api.commandImpl = (_target, method) => {
    if (method === 'Page.enable') throw new Error('denied');
    return {};
  };
  await assert.rejects(h.cdp.acquireBackgroundExecution('aa11', 7), /denied/);
  assert.equal(h.cdp.ownsBackgroundExecution('aa11', 7), false);
  assert.equal(h.cdp.getSessionClaimId('aa11', 7), undefined);
  assert.equal(h.cdp.isAttached(7), false);
  h.cdp.dispose();
});

test('forgetClosedTab clears ownership and fences the attachment', async () => {
  const h = harness();
  await h.cdp.acquireBackgroundExecution('aa11', 4);
  assert.equal(h.cdp.isAttached(4), true);
  assert.equal(h.cdp.ownsBackgroundExecution('aa11', 4), true);

  h.cdp.forgetClosedTab(4);
  assert.equal(h.cdp.isAttached(4), false);
  assert.equal(h.cdp.ownsBackgroundExecution('aa11', 4), false);
  assert.equal(h.cdp.getSessionClaimId('aa11', 4), undefined);
  assert.deepEqual(h.detached, [4]);
  h.cdp.dispose();
});

test('an auto-detach clears observation state and honors target_closed', async () => {
  const changed = [];
  const h = harness({ onDocumentChanged: (tabId) => changed.push(tabId) });
  await h.cdp.acquireBackgroundExecution('aa11', 7);
  h.emit({ tabId: 7 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'x' }] });
  h.emit({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'r1', request: { url: 'https://one.test/' } });
  assert.equal(h.cdp.consoleEntriesSince(7, undefined, 10, 100, false).entries.length, 1);

  h.fireDetach({ tabId: 7 }, 'target_closed');
  assert.equal(h.cdp.isAttached(7), false);
  assert.equal(h.cdp.getAttachmentId(7), undefined);
  assert.equal(h.cdp.ownsBackgroundExecution('aa11', 7), false);
  assert.equal(h.cdp.getSessionClaimId('aa11', 7), undefined);
  assert.deepEqual(changed, [7]);
  assert.equal(h.cdp.consoleEntriesSince(7, undefined, 10, 100, false).entries.length, 0);
  assert.equal(h.cdp.networkEntriesSince(7, undefined, 10, 100).entries.length, 0);

  // A delayed event for the released attachment still reaches observers, but
  // the cached console/network buffers stay empty until a new capture.
  h.emit({ tabId: 7 }, 'Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_ABORTED' });
  assert.equal(h.cdp.networkEntriesSince(7, 0, 10, 100).entries[0].url, undefined);
  h.cdp.dispose();
});

test('loadingFinished consumes cached request metadata', async () => {
  const h = harness();
  await h.cdp.ensureAttached(31);
  h.emit({ tabId: 31 }, 'Network.requestWillBeSent', {
    requestId: 'r',
    request: { url: 'https://one.test/api', method: 'GET' },
    type: 'Fetch',
  });
  h.emit({ tabId: 31 }, 'Network.responseReceived', { requestId: 'r', response: { status: 200 }, type: 'Fetch' });
  h.emit({ tabId: 31 }, 'Network.loadingFinished', { requestId: 'r' });
  h.emit({ tabId: 31 }, 'Network.loadingFailed', { requestId: 'r', errorText: 'net::ERR_FAILED' });

  const entries = h.cdp.networkEntriesSince(31, 0, 10, 1000).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, 'https://one.test/api');
  assert.equal(entries[0].method, 'GET');
  assert.equal(entries[1].url, undefined);
  assert.equal(entries[1].error_text, 'net::ERR_FAILED');
  h.cdp.dispose();
});

test('console capture stays usable when only the log domain fails', async () => {
  const h = harness();
  h.api.commandImpl = (_target, method) => {
    if (method === 'Log.enable') throw new Error('restricted');
    return {};
  };
  await h.cdp.ensureConsoleCapture(12);
  await h.cdp.ensureConsoleCapture(12);
  assert.equal(h.sent.filter(([, method]) => method === 'Runtime.enable').length, 2);
  assert.equal(h.sent.filter(([, method]) => method === 'Log.enable').length, 2);
  h.cdp.dispose();
});

test('a root frame tree reply seeds the document root once', async () => {
  const changed = [];
  const h = harness({ onDocumentChanged: (tabId) => changed.push(tabId) });
  await h.cdp.ensureAttached(4);
  h.api.commandImpl = (_target, method) => (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'root' } } } : {});

  await h.cdp.send(4, 'Page.getFrameTree');
  h.emit({ tabId: 4 }, 'Page.navigatedWithinDocument', { frameId: 'root' });
  assert.deepEqual(changed, [4]);
  h.cdp.dispose();
});

test('a delayed tree reply cannot overwrite a newer root navigation', async () => {
  const changed = [];
  const h = harness({ onDocumentChanged: (tabId) => changed.push(tabId) });
  await h.cdp.ensureAttached(4);
  let finish;
  h.api.commandImpl = (_target, method) => {
    if (method === 'Page.getFrameTree') return new Promise((resolve) => { finish = resolve; });
    return {};
  };
  const tree = h.cdp.sendGuarded({ tabId: 4 }, 'Page.getFrameTree', {}, { attachmentId: h.cdp.getAttachmentId(4) });
  h.emit({ tabId: 4 }, 'Page.frameNavigated', { frame: { id: 'new-root' } });
  assert.equal(typeof finish, 'function');
  finish({ frameTree: { frame: { id: 'retired-root' } } });
  await tree;

  changed.length = 0;
  h.emit({ tabId: 4 }, 'Page.navigatedWithinDocument', { frameId: 'retired-root' });
  assert.deepEqual(changed, []);
  h.emit({ tabId: 4 }, 'Page.navigatedWithinDocument', { frameId: 'new-root' });
  assert.deepEqual(changed, [4]);
  h.cdp.dispose();
});
