import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutePolicy } from '../../daemon/route-policy.js';

function make() {
  const sleeps = [];
  return {
    sleeps,
    policy: createRoutePolicy({
      BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
      isMutating: (method) => ['click', 'navigate'].includes(method),
      domainAllowed: (allow, deny, url) => ({ allowed: !String(url).includes('blocked'), reason: 'deny' }),
      sleep: async (ms) => sleeps.push(ms),
    }),
  };
}

test('只读 scope 拒绝变更动作', async () => {
  const { policy } = make();
  await assert.rejects(() => policy.enforceSessionPolicy({ session: { scope: 'read' } }, 'click', {}), (error) => error.code === 'E_READ_ONLY');
});

test('域名策略拒绝 blocked', async () => {
  const { policy } = make();
  await assert.rejects(
    () => policy.enforceSessionPolicy({ session: { allowDomains: [], denyDomains: [] } }, 'navigate', { url: 'https://blocked.example' }),
    (error) => error.code === 'E_FORBIDDEN',
  );
});

test('最小间隔写入 lastActionAt 并 sleep', async () => {
  const { policy, sleeps } = make();
  const session = { minIntervalMs: 1000, lastActionAt: Date.now() };
  await policy.enforceSessionPolicy({ session }, 'click', {});
  assert.ok(session.lastActionAt > 0);
  assert.equal(sleeps.length, 1);
});
