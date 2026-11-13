import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness() {
  const commands = [];
  let detach = 0;
  const api = {
    async attach() {},
    async detach() { detach += 1; },
    async sendCommand(_target, method, params) { commands.push([method, params]); return {}; },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  };
  return { cdp: new ChromiumCdp(api), commands, detach: () => detach };
}

test('background execution is acquired, retained and released', async () => {
  const h = harness();
  await h.cdp.acquireBackgroundExecution('s1', 7);
  assert.equal(h.cdp.ownsBackgroundExecution('s1', 7), true);
  const claim = h.cdp.getSessionClaimId('s1', 7);
  assert.equal(typeof claim, 'object');
  await h.cdp.acquireBackgroundExecution('s1', 7);
  assert.notEqual(h.cdp.getSessionClaimId('s1', 7), claim);
  await h.cdp.releaseBackgroundExecution('s1', 7);
  assert.equal(h.cdp.ownsBackgroundExecution('s1', 7), false);
  assert.ok(h.commands.some(([method]) => method === 'Emulation.setFocusEmulationEnabled'));
});

test('restore rejects a session without ownership', async () => {
  const h = harness();
  await assert.rejects(h.cdp.restoreBackgroundExecution('s1', 7), /not owned/);
});
