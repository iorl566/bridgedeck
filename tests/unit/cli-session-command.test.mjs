import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCommand } from '../../cli/commands/session.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler) {
  const printed = [];
  const cmd = createSessionCommand({
    callRpc: async (method, params) => handler(method, params),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
  });
  return { cmd, printed };
}

test('session start 打印会话/实例/tab/window；--focus 透传', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand((method, params) => {
    seen = { method, params };
    return { ok: true, result: { sessionId: 's1', instanceId: 'i1', tabId: 2, windowId: 3 } };
  });
  assert.equal(await cmd({ focus: true }, ['session', 'start']), 0);
  assert.equal(seen.method, 'session.start');
  assert.equal(seen.params.focus, true);
  assert.match(printed.join('\n'), /session s1 已创建（instance i1, tab 2, window 3）/);
});

test('session stop --all 打印停止数量', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { count: 2, failed: [] } }));
  assert.equal(await cmd({ all: true }, ['session', 'stop']), 0);
  assert.match(printed.join('\n'), /已停止 2 个会话/);
});

test('session list 空提示', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { sessions: [] } }));
  assert.equal(await cmd({}, ['session', 'list']), 0);
  assert.match(printed.join('\n'), /没有活动 session/);
});

test('session run-log 打印步骤表；control --mode 非法抛 ArgError', async () => {
  const { cmd, printed } = makeCommand((method) => (method === 'session.run_log'
    ? { ok: true, result: { steps: [{ kind: 'navigate', method: 'navigate', origin: 'https://x', path: '/', ok: true }], truncated: false } }
    : { ok: true, result: {} }));
  assert.equal(await cmd({}, ['session', 'run-log', 's1']), 0);
  assert.match(printed.join('\n'), /navigate/);
  await assert.rejects(() => cmd({ mode: 'bad' }, ['session', 'control', 's1']), ArgError);
});
