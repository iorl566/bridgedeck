import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugCommand } from '../../cli/commands/debug.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler) {
  const printed = [];
  const cmd = createDebugCommand({
    withControl: (flags, base) => ({ session: 's1', ...base }),
    callRpc: async (method, params) => handler(method, params),
    timeoutOf: () => 5000,
    renderPageBody: (body, render) => { render(); return 0; },
    emitJson: () => 0,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    parseSince: (text) => (text ? Date.parse(String(text)) : 0),
    writeFileAtomic: () => {},
    pathOfUrl: (url) => String(url || ''),
    pickJsonPointer: () => null,
    filterDebugEntries: (entries) => entries,
    HOME_DIR: '.',
  });
  return { cmd, printed };
}

test('debug start 打印名称与正文开关', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand((method, params) => {
    seen = { method, params };
    return { ok: true, result: {} };
  });
  assert.equal(await cmd({ name: 'n1', bodies: true }, ['debug', 'start']), 0);
  assert.equal(seen.method, 'debug.start');
  assert.equal(seen.params.name, 'n1');
  assert.equal(seen.params.bodies, true);
  assert.match(printed.join('\n'), /调试采集已开始：n1（含正文）/);
});

test('debug stop 打印请求/控制台计数', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { requests: 3, console: 2 } }));
  assert.equal(await cmd({}, ['debug', 'stop']), 0);
  assert.match(printed.join('\n'), /已停止：3 请求 \/ 2 条控制台输出/);
});

test('debug status 无采集时回退历史', async () => {
  const { cmd, printed } = makeCommand((method) => {
    if (method === 'debug.current') return { ok: false, error: { code: 'E_NOT_FOUND', message: 'none' } };
    if (method === 'debug.history') return { ok: true, result: { history: [{ id: 'abcdef123456', name: 'old' }] } };
    return { ok: true, result: {} };
  });
  assert.equal(await cmd({}, ['debug', 'status']), 0);
  const text = printed.join('\n');
  assert.match(text, /当前没有进行中的调试采集/);
  assert.match(text, /abcdef12\(old\)/);
});

test('debug 未知子命令抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd({}, ['debug', 'nope']), ArgError);
});
