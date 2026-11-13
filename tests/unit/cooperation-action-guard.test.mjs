import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedRunner } from '../../extension/src/cooperation/action-guard.js';

function fakeCdp() {
  const commands = [];
  const cdp = {
    attachment: 'a1',
    getAttachmentId() { return this.attachment; },
    async send(tabId, method, params) { commands.push([tabId, method, params]); return { ok: true }; },
    async sendToTarget(target, method, params) { commands.push([target, method, params]); return { ok: true }; },
  };
  return { cdp, commands };
}

test('without prepare, browser input is refused', async () => {
  const { cdp } = fakeCdp();
  const runner = guardedRunner(cdp);
  await assert.rejects(runner.send(7, 'Input.dispatchMouseEvent', { type: 'mousePressed' }), /cannot dispatch/);
});

test('prepare and dispatch fence run before input', async () => {
  const { cdp, commands } = fakeCdp();
  const events = [];
  const runner = guardedRunner(cdp, {
    prepare: async (input, method) => events.push(['prepare', input?.type, method]),
    dispatch: (startsInput, method) => events.push(['dispatch', startsInput, method]),
  });
  await runner.send(7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left' });
  assert.deepEqual(events[0], ['prepare', 'pointerdown', 'Input.dispatchMouseEvent']);
  assert.deepEqual(events[1], ['dispatch', true, 'Input.dispatchMouseEvent']);
  assert.equal(typeof commands[0][2].timestamp, 'number');
});

test('resourceCleanup only allows object cleanup', async () => {
  const { cdp } = fakeCdp();
  const runner = guardedRunner(cdp, { prepare: async () => {} });
  await runner.send(7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left' });
  await assert.rejects(async () => runner.resourceCleanup.send(7, 'Input.dispatchMouseEvent', {}), /cannot dispatch/);
  assert.deepEqual(await runner.resourceCleanup.send(7, 'Runtime.releaseObjectGroup', { objectGroup: 'g' }), { ok: true });
});
