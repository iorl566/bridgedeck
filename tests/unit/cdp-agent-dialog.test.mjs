import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness(options = {}) {
  const sent = [];
  const eventListeners = new Set();
  const detachListeners = new Set();
  const api = {
    commandImpl: null,
    async attach() {},
    async detach() {},
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
    emit: (source, method, params) => { for (const fn of [...eventListeners]) fn(source, method, params); },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a dialog opening is ignored when the tab is not agent controlled', async () => {
  const changes = [];
  const h = harness({ canControlDialog: async () => false });
  h.cdp.onDialogChanged((tabId, dialog) => changes.push([tabId, dialog]));
  await h.cdp.ensureAttached(3);

  h.emit({ tabId: 3 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Decide' });
  await tick();
  assert.deepEqual(h.cdp.pendingDialogs(3), []);
  assert.deepEqual(h.cdp.dialogsSince(3, 0), []);
  assert.deepEqual(h.cdp.pendingDialogs(), []);
  assert.deepEqual(changes, []);
  h.cdp.dispose();
});

test('a delayed eligibility check cannot record a dialog on a detached tab', async () => {
  let release;
  let calls = 0;
  const h = harness({
    canControlDialog: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  await h.cdp.ensureAttached(1);
  h.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  await tick();
  await h.cdp.detach(1);
  release(true);
  await tick();

  h.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'late' });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(h.cdp.pendingDialogs(), []);
  assert.deepEqual(h.cdp.dialogsSince(1, 0), []);
  h.cdp.dispose();
});

test('a closed event for a detached tab records nothing', async () => {
  const h = harness();
  await h.cdp.ensureAttached(1);
  h.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  assert.equal(h.cdp.pendingDialogs(1).length, 1);
  await h.cdp.detach(1);
  h.emit({ tabId: 1 }, 'Page.javascriptDialogClosed', { result: true });

  assert.deepEqual(h.cdp.pendingDialogs(1), []);
  assert.deepEqual(h.cdp.dialogsSince(1, 0), []);
  h.cdp.dispose();
});

test('a dialog decision never reconnects a released attachment', async () => {
  const h = harness();
  await h.cdp.ensureAttached(11);
  h.emit({ tabId: 11 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Old' });
  const [dialog] = h.cdp.pendingDialogs(11);
  await h.cdp.detach(11);
  const before = h.sent.length;

  await assert.rejects(h.cdp.resolveDialog(dialog.id, true), /no longer pending/);
  assert.equal(h.sent.length, before);
  assert.deepEqual(h.cdp.pendingDialogs(11), []);
  assert.equal(h.cdp.dialogCursor(11), 0);
  h.cdp.dispose();
});

test('the full prompt default is preserved while the preview stays bounded', async () => {
  const h = harness();
  const fullDefault = 'x'.repeat(10_000);
  h.api.commandImpl = (_target, method) => {
    if (method === 'Page.handleJavaScriptDialog') {
      h.emit({ tabId: 3 }, 'Page.javascriptDialogClosed', { result: true });
    }
    return {};
  };
  await h.cdp.ensureAttached(3);
  h.emit({ tabId: 3 }, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name', defaultPrompt: fullDefault });
  const [dialog] = h.cdp.pendingDialogs(3);
  assert.ok(dialog.default_prompt.length < fullDefault.length);

  const info = await h.cdp.resolveDialog(dialog.id, true);
  const dispatched = h.sent.find(([, method]) => method === 'Page.handleJavaScriptDialog');
  assert.equal(dispatched[2].promptText, fullDefault);
  assert.equal(info.handled, 'accepted');
  assert.equal(info.default_prompt, dialog.default_prompt);
  h.cdp.dispose();
});

test('the browser handler flag is recorded on close, not on the pending dialog', async () => {
  const h = harness();
  await h.cdp.ensureAttached(5);
  h.emit({ tabId: 5 }, 'Page.javascriptDialogOpening', {
    type: 'beforeunload',
    message: 'leave?',
    hasBrowserHandler: false,
  });
  const [dialog] = h.cdp.pendingDialogs(5);
  assert.equal('has_browser_handler' in dialog, false);

  h.emit({ tabId: 5 }, 'Page.javascriptDialogClosed', { result: false });
  const [record] = h.cdp.dialogsSince(5, 0);
  assert.equal(record.has_browser_handler, false);
  assert.equal(record.handled, 'dismissed');
  h.cdp.dispose();
});

test('a second decision is refused while the first is in flight', async () => {
  const h = harness({ canControlDialog: async () => true });
  await h.cdp.ensureAttached(3);
  h.emit({ tabId: 3 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Decide' });
  await tick();
  const [dialog] = h.cdp.pendingDialogs(3);

  const first = h.cdp.resolveDialog(dialog.id, true);
  await assert.rejects(h.cdp.resolveDialog(dialog.id, false), /already in progress/);
  h.emit({ tabId: 3 }, 'Page.javascriptDialogClosed', { result: false });
  assert.equal((await first).handled, 'dismissed');
  assert.equal(h.sent.filter(([, method]) => method === 'Page.handleJavaScriptDialog').length, 1);
  h.cdp.dispose();
});
