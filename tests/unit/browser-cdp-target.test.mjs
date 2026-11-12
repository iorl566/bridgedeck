import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness() {
  const commands = [];
  const api = {
    async attach() {},
    async detach() {},
    async sendCommand(target, method, params) { commands.push([target, method, params]); return { ok: true }; },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  };
  return { cdp: new ChromiumCdp(api), commands };
}

test('sendToTarget forwards the session target', async () => {
  const h = harness();
  const result = await h.cdp.sendToTarget({ tabId: 7, sessionId: 's1' }, 'Runtime.evaluate', { expression: '1' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.commands.find((command) => command[1] === 'Runtime.evaluate')[0], { tabId: 7, sessionId: 's1' });
});

test('sendGuarded checks the attachment before dispatch', async () => {
  const h = harness();
  await h.cdp.ensureAttached(7);
  let dispatched = false;
  await h.cdp.sendGuarded({ tabId: 7 }, 'Page.handleJavaScriptDialog', {}, {
    attachmentId: h.cdp.getAttachmentId(7),
    onDispatch: () => { dispatched = true; },
  });
  assert.equal(dispatched, true);
  await assert.rejects(
    h.cdp.sendGuarded({ tabId: 7 }, 'Page.handleJavaScriptDialog', {}, { attachmentId: 'other' }),
    /attachment changed/,
  );
});
