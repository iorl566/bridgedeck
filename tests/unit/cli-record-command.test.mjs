import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecordCommand } from '../../cli/commands/record.mjs';
import { ArgError } from '../../cli/lib/args.mjs';
import { formatTime, renderTable, truncateText } from '../../cli/lib/format.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-record-cmd-'));
  const printed = [];
  const cmd = createRecordCommand({
    withControl: () => ({ session: 's1' }),
    callRpc: async (method, params, timeout) => handler(method, params, timeout),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    emitJson: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    BridgeError: TestBridgeError,
    ArgError,
    writeFileAtomic: (file, content) => fs.writeFileSync(file, content, 'utf8'),
    renderTable,
    formatTime,
    truncateText,
  });
  return { dir, cmd, printed };
}

test('record start 打印 tab', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { tabId: 7 } }));
  assert.equal(await cmd({}, ['record', 'start']), 0);
  assert.match(printed.join('\n'), /已开始记录用户操作（tab 7）/);
});

test('record status 空活动', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { active: [] } }));
  assert.equal(await cmd({}, ['record', 'status']), 0);
  assert.match(printed.join('\n'), /没有进行中的记录/);
});

test('record list 表格输出', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { recordings: [{ id: 'r1', events: [1, 2], startedAt: 1, title: 't' }] } }));
  assert.equal(await cmd({}, ['record', 'list']), 0);
  assert.match(printed.join('\n'), /r1/);
});

test('record export 写 trace.json 与 states', async () => {
  const { dir, cmd } = makeCommand((method) => {
    if (method === 'record.list') return { ok: true, result: { recordings: [{ id: 'r1', title: 't', url: 'https://x', startedAt: 1, steps: [], states: [], events: [] }] } };
    return { ok: true, result: {} };
  });
  try {
    const out = path.join(dir, 'trace-out');
    assert.equal(await cmd({ out }, ['record', 'export']), 0);
    assert.ok(fs.existsSync(path.join(out, 'trace.json')));
    assert.ok(fs.existsSync(path.join(out, 'states')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
