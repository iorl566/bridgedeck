import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness() {
  const listeners = new Set();
  const detach = new Set();
  const sent = [];
  const api = {
    async attach() {},
    async detach() {},
    async sendCommand(target, method, params) { sent.push([target, method, params]); return {}; },
    onEvent: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    onDetach: { addListener: (fn) => detach.add(fn), removeListener: (fn) => detach.delete(fn) },
  };
  const cdp = new ChromiumCdp(api);
  const emit = (method, params) => { for (const fn of listeners) fn({ tabId: 7 }, method, params); };
  return { cdp, emit, sent };
}

test('dialog opening is pending and buffered when closed', async () => {
  const { cdp, emit } = harness();
  await cdp.ensureAttached(7);
  emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi', url: 'u' });
  const [dialog] = cdp.pendingDialogs(7);
  assert.equal(dialog.message, 'hi');
  assert.equal(cdp.dialogCursor(7), 1);
  emit('Page.javascriptDialogClosed', { result: true });
  assert.equal(cdp.pendingDialogs(7).length, 0);
  assert.equal(cdp.dialogsSince(7, 0)[0].handled, 'accepted');
});

test('resolveDialog waits for native close confirmation', async () => {
  const { cdp, emit, sent } = harness();
  await cdp.ensureAttached(7);
  emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'name', defaultPrompt: 'x' });
  const id = cdp.pendingDialogs(7)[0].id;
  const pending = cdp.resolveDialog(id, true, 'y');
  await Promise.resolve();
  emit('Page.javascriptDialogClosed', { result: true });
  const result = await pending;
  assert.equal(result.handled, 'accepted');
  assert.deepEqual(sent.at(-1)[2], { accept: true, promptText: 'y' });
});

test('text is rejected for non-prompt dialogs', async () => {
  const { cdp, emit } = harness();
  await cdp.ensureAttached(7);
  emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  const id = cdp.pendingDialogs(7)[0].id;
  await assert.rejects(cdp.resolveDialog(id, true, 'text'), /only valid/);
});

test('detach clears pending and rejects waiter', async () => {
  const { cdp, emit } = harness();
  await cdp.ensureAttached(7);
  emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' });
  const id = cdp.pendingDialogs(7)[0].id;
  const pending = cdp.resolveDialog(id, false);
  await Promise.resolve();
  cdp.clearDialogState(7);
  await assert.rejects(pending, /outcome is unknown/);
});
