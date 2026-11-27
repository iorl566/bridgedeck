import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowCommand } from '../../cli/commands/window.mjs';
import { createDialogCommand } from '../../cli/commands/dialog.mjs';
import { ArgError, intFlag, requirePos } from '../../cli/lib/args.mjs';
import { renderTable, truncateText } from '../../cli/lib/format.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeWindow(handler) {
  const printed = [];
  return {
    printed,
    cmd: createWindowCommand({
      callRpc: async (method, params) => handler(method, params),
      timeoutOf: () => 5000,
      outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
      outputJsonBody: () => 0,
      isJson: () => false,
      print: (line) => printed.push(line),
      renderTable,
      requirePos,
      intFlag,
      ArgError,
    }),
  };
}

test('window list 空列表；focus 需整数', async () => {
  const { cmd, printed } = makeWindow(() => ({ ok: true, result: { windows: [] } }));
  assert.equal(await cmd({}, ['window', 'list']), 0);
  assert.match(printed.join('\n'), /没有窗口/);
  await assert.rejects(() => cmd({}, ['window', 'focus', 'abc']), ArgError);
});

test('window resize 缺宽高抛 ArgError；正常时发 window.resize', async () => {
  let seen = null;
  const { cmd, printed } = makeWindow((method, params) => {
    seen = { method, params };
    return { ok: true, result: {} };
  });
  await assert.rejects(() => cmd({ width: '100' }, ['window', 'resize']), ArgError);
  assert.equal(await cmd({ width: '800', height: '600' }, ['window', 'resize']), 0);
  assert.equal(seen.method, 'window.resize');
  assert.equal(seen.params.width, 800);
  assert.equal(printed.join('\n'), 'ok');
});

test('window ensure 打印复用/新建', async () => {
  const { cmd, printed } = makeWindow(() => ({ ok: true, result: { windowId: 1, tabId: 2, created: true } }));
  assert.equal(await cmd({}, ['window', 'ensure']), 0);
  assert.match(printed.join('\n'), /window 1，tab 2（新建）/);
});

function makeDialog(handler) {
  const printed = [];
  return {
    printed,
    cmd: createDialogCommand({
      withControl: (flags, base) => ({ session: 's1', ...base }),
      dialogPolicy: () => ({ accept: true }),
      callRpc: async (method, params) => handler(method, params),
      timeoutOf: () => 5000,
      outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
      outputJsonBody: () => 0,
      renderPageBody: (body, render) => { render(); return 0; },
      isJson: () => false,
      print: (line) => printed.push(line),
      renderTable,
      truncateText,
      requirePos,
      ArgError,
    }),
  };
}

test('dialog status 空提示', async () => {
  const { cmd, printed } = makeDialog(() => ({ ok: true, result: { dialogs: [] } }));
  assert.equal(await cmd({}, ['dialog', 'status']), 0);
  assert.match(printed.join('\n'), /没有对话框记录/);
});

test('dialog accept/dismiss 打印动作', async () => {
  let seen = null;
  const { cmd, printed } = makeDialog((method, params) => {
    seen = { method, params };
    return { ok: true, result: {} };
  });
  assert.equal(await cmd({}, ['dialog', 'accept', '7']), 0);
  assert.equal(seen.method, 'dialog.accept');
  assert.equal(seen.params.id, 7);
  assert.match(printed.join('\n'), /已接受对话框 7/);
});

test('dialog handle 需要 --accept/--dismiss', async () => {
  const { cmd } = makeDialog(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd({}, ['dialog', 'handle', '7']), ArgError);
});
