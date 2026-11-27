import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoCommand } from '../../cli/commands/video.mjs';
import { ArgError, requirePos, parseDurationMs } from '../../cli/lib/args.mjs';
import { formatBytes, formatTime, renderTable, truncateText } from '../../cli/lib/format.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler) {
  const printed = [];
  const cmd = createVideoCommand({
    withControl: () => ({ session: 's1' }),
    callRpc: async (method, params, timeout) => handler(method, params, timeout),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    emitJson: () => 0,
    expectOkBody: (body) => body.result,
    isJson: () => false,
    print: (line) => printed.push(line),
    BridgeError: TestBridgeError,
    ArgError,
    requirePos,
    parseDurationMs,
    writeVideoFile: () => ({ target: 'out.mp4', buffer: Buffer.from('x') }),
    formatBytes,
    formatTime,
    renderTable,
    truncateText,
  });
  return { cmd, printed };
}

test('video start 打印录制信息', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { recordingId: 'r1', mime: 'video/mp4', mode: 'cdp' } }));
  assert.equal(await cmd({}, ['video', 'start']), 0);
  assert.match(printed.join('\n'), /开始录制：r1（MP4，cdp）/);
});

test('video list 空列表提示', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { recordings: [] } }));
  assert.equal(await cmd({}, ['video', 'list']), 0);
  assert.match(printed.join('\n'), /没有录制/);
});

test('video verify 输出分片结果', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { verified: true, chunks: 3, bytes: 10 } }));
  assert.equal(await cmd({}, ['video', 'verify', 'r1']), 0);
  assert.match(printed.join('\n'), /分片校验通过：3 片/);
});

test('video save 缺 --out 抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: { base64: 'x' } }));
  await assert.rejects(() => cmd({}, ['video', 'save', 'r1']), ArgError);
});
