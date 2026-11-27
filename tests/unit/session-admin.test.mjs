import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAdmin } from '../../daemon/session-admin.js';

function make() {
  const session = { sessionId: 's1', instanceId: 'i1', tabId: 7, paused: false };
  const sessions = new Map([['s1', session]]);
  const calls = [];
  const admin = createSessionAdmin({
    resolveSession: () => session,
    instances: new Map([['i1', {}]]),
    sendInstanceEvent: (instance, event) => calls.push(['event', event]),
    log: () => {},
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    sessions,
    sessionStop: { stopSession: async () => { sessions.delete('s1'); calls.push(['stop']); } },
  });
  return { admin, session, sessions, calls };
}

test('pauseSession 设置人工暂停并广播', async () => {
  const { admin, session, calls } = make();
  const result = await admin.pauseSession({ paused: true }, 1000);
  assert.equal(result.paused, true);
  assert.equal(session.pausedBy, 'manual');
  assert.ok(calls.some(([kind, event]) => kind === 'event' && event === 'takeover.state'));
});

test('pauseSession 拒绝 auto 恢复人工暂停', async () => {
  const { admin } = make();
  await admin.pauseSession({ paused: true }, 1000);
  await assert.rejects(() => admin.pauseSession({ paused: false, auto: true }, 1000), (error) => error.code === 'E_PAUSED_MANUAL');
});

test('stopAllSessions 汇总停止结果', async () => {
  const { admin, sessions } = make();
  const result = await admin.stopAllSessions({}, 1000);
  assert.deepEqual(result.stopped, ['s1']);
  assert.equal(sessions.has('s1'), false);
});
