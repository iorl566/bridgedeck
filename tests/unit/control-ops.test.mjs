import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlOps } from '../../daemon/control-ops.js';

function make(modeOk = true) {
  const calls = [];
  const tabControls = {
    syncTabControl: (tabId) => ({ tabId, holder: 's1' }),
    controlResult: (decision, session, extra) => ({ ok: true, sessionId: session.sessionId, ...extra, decision }),
    normalizeControlMode: (mode) => (mode === 'exclusive' || mode === 'open' ? mode : undefined),
    persistControlMode: (tabId, mode) => calls.push(['persist', tabId, mode]),
  };
  const tabControl = {
    claim: (tabId, sessionId, opts) => { calls.push(['claim', tabId, sessionId, opts]); return { ok: true, acquired: true }; },
    release: (tabId, sessionId) => ({ ok: true }),
    handoff: (tabId, from, to) => ({ ok: true }),
    setMode: (tabId, mode, sessionId) => ({ ok: modeOk }),
  };
  const api = createControlOps({
    resolveSession: (id) => ({ sessionId: id || 's1', tabId: 7 }),
    tabControls,
    tabControl,
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    log: (message) => calls.push(['log', message]),
  });
  return { api, calls };
}

test('claimControl 走 tabControl.claim', () => {
  const { api, calls } = make();
  const result = api.claimControl({ session: 's1', leaseMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'claim');
  assert.ok(calls.some(([kind]) => kind === 'claim'));
});

test('releaseControl 走 tabControl.release', () => {
  const { api } = make();
  const result = api.releaseControl({ session: 's1' });
  assert.equal(result.action, 'release');
});

test('setControlMode 持久化并拒绝非法模式', () => {
  const { api, calls } = make();
  const result = api.setControlMode({ session: 's1', mode: 'exclusive' });
  assert.equal(result.mode, 'exclusive');
  assert.ok(calls.some(([kind, , mode]) => kind === 'persist' && mode === 'exclusive'));
  assert.throws(() => api.setControlMode({ session: 's1', mode: 'bogus' }), (error) => error.code === 'E_BAD_ARG');
});
