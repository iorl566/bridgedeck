import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumCdp } from '../../extension/src/browser-driver/chromium-cdp.js';

function harness() {
  let detached = 0;
  const api = {
    async attach() {},
    async detach() { detached += 1; },
    async sendCommand() { return {}; },
    onEvent: { addListener() {}, removeListener() {} },
    onDetach: { addListener() {}, removeListener() {} },
  };
  return { cdp: new ChromiumCdp(api), detached: () => detached };
}

test('session claims guard release and detach when last owner leaves', async () => {
  const h = harness();
  await h.cdp.ensureAttached(7);
  h.cdp.trackSessionTab('s1', 7);
  const claim = h.cdp.getSessionClaimId('s1', 7);
  assert.deepEqual(claim, { sessionId: 's1', tabId: 7 });
  await h.cdp.releaseSessionTab('s1', 7, { ifClaim: {} });
  assert.equal(h.cdp.getSessionClaimId('s1', 7), claim);
  await h.cdp.releaseSessionTab('s1', 7, { ifClaim: claim });
  assert.equal(h.cdp.getSessionClaimId('s1', 7), undefined);
  assert.equal(h.cdp.isAttached(7), false);
  assert.equal(h.detached(), 1);
});

test('sendAttached refuses a detached tab', async () => {
  const h = harness();
  await assert.rejects(h.cdp.sendAttached({ tabId: 7 }, 'Runtime.evaluate', {}), /debugger detached/);
});
