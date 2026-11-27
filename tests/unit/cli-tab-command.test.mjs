import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabCommand } from '../../cli/commands/tab.mjs';
import { ArgError, requirePos, parseDurationMs } from '../../cli/lib/args.mjs';
import { renderTable, truncateText } from '../../cli/lib/format.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler) {
  const printed = [];
  const cmd = createTabCommand({
    withSession: (flags, base) => ({ session: 's1', ...base }),
    callRpc: async (method, params, timeout) => handler(method, params, timeout),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    renderTable,
    truncateText,
    parseDurationMs,
    requirePos,
    ArgError,
  });
  return { cmd, printed };
}

test('tab list 空列表', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { tabs: [] } }));
  assert.equal(await cmd({}, ['tab', 'list']), 0);
  assert.match(printed.join('\n'), /没有 tab/);
});

test('tab new 打印 tab/window 与 focus 参数', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand((method, params) => {
    seen = params;
    return { ok: true, result: { tabId: 9, windowId: 3 } };
  });
  assert.equal(await cmd({ focus: true, window: true }, ['tab', 'new', 'https://x']), 0);
  assert.equal(seen.focus, true);
  assert.equal(seen.newWindow, true);
  assert.equal(seen.url, 'https://x');
  assert.match(printed.join('\n'), /tab 9 已创建（window 3）/);
});

test('tab move 缺 --to-window 抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd({}, ['tab', 'move', '9']), ArgError);
});

test('tab alias clear 只清 alias', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand((method, params) => {
    seen = params;
    return { ok: true, result: {} };
  });
  assert.equal(await cmd({ clear: true }, ['tab', 'alias', '9', 'docs']), 0);
  assert.equal(seen.action, 'clear');
  assert.equal(seen.alias, 'docs');
  assert.equal(seen.tabId, undefined);
  assert.match(printed.join('\n'), /已清除 alias docs/);
});
