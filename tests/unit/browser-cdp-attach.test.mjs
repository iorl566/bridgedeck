import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

test('domain setup failure rolls back the raw attach', async () => {
  const commands = [];
  let detached = 0;
  const api = {
    async attach() {},
    async detach() { detached += 1; },
    async sendCommand(_target, method) {
      commands.push(method);
      if (method === 'Page.enable') throw new Error('Page.enable failed');
      return {};
    },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  };
  const cdp = new ChromiumCdp(api);
  await assert.rejects(cdp.ensureAttached(7), /Page.enable failed/);
  assert.equal(cdp.isAttached(7), false);
  assert.equal(detached, 1);
  assert.deepEqual(commands, ['Page.enable']);
});

test('ensureAttached enables page, network and frame discovery', async () => {
  const commands = [];
  const api = {
    async attach() {},
    async detach() {},
    async sendCommand(_target, method) { commands.push(method); return { frameTree: { frame: { id: 'f1' } } }; },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  };
  const cdp = new ChromiumCdp(api);
  await cdp.ensureAttached(7);
  assert.ok(commands.includes('Page.enable'));
  assert.ok(commands.includes('Network.enable'));
  assert.ok(commands.includes('Target.setAutoAttach'));
});
