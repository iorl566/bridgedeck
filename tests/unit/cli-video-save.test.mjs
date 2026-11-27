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

function makeCommand(handler, writer, remux) {
  const printed = [];
  const cmd = createVideoCommand({
    withControl: () => ({ session: 's1' }),
    callRpc: async (method, params) => handler(method, params),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    emitJson: (payload) => printed.push(JSON.stringify(payload)),
    expectOkBody: (body) => body.result,
    isJson: () => false,
    print: (line) => printed.push(line),
    BridgeError: TestBridgeError,
    ArgError,
    requirePos,
    parseDurationMs,
    writeVideoFile: writer,
    remuxFaststartBase64: remux || (async () => null),
    formatBytes,
    formatTime,
    renderTable,
    truncateText,
  });
  return { cmd, printed };
}

test('video save：fMP4 尾部不完整时把 complete_bytes 传给写文件', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand(
    () => ({
      ok: true,
      result: {
        mime: 'video/mp4',
        base64: 'AAAA',
        journal: { trailing_bytes: 12, complete_bytes: 90, complete_frames: false },
      },
    }),
    (base64, out, overwrite, options) => {
      seen = { base64, out, overwrite, options };
      return { target: 'out.mp4', buffer: Buffer.alloc(90), trimmedBytes: 12 };
    },
  );
  assert.equal(await cmd({ out: 'out.mp4' }, ['video', 'save', 'r1']), 0);
  assert.equal(seen.options.completeBytes, 90);
  assert.match(printed.join('\n'), /已截到完整分片（丢弃/);
});

test('video save：fMP4 重封装 faststart 时写 remux 结果', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand(
    () => ({
      ok: true,
      result: { mime: 'video/mp4', base64: 'RAW', journal: { fragmented: true, trailing_bytes: 12, complete_bytes: 90 } },
    }),
    (base64, out, overwrite, options) => {
      seen = { base64, out, overwrite, options };
      return { target: 'out.mp4', buffer: Buffer.alloc(120), trimmedBytes: 0 };
    },
    async () => ({ base64: 'REMUXED', bytes: 120, packets: 3, codec: 'avc' }),
  );
  assert.equal(await cmd({ out: 'out.mp4' }, ['video', 'save', 'r1']), 0);
  assert.equal(seen.base64, 'REMUXED');
  assert.equal(seen.options.completeBytes, undefined);
  assert.match(printed.join('\n'), /已重封装 faststart/);
});

test('video save：完整录制不裁剪', async () => {
  let seen = null;
  const { cmd, printed } = makeCommand(
    () => ({
      ok: true,
      result: { mime: 'video/mp4', base64: 'AAAA', journal: { trailing_bytes: 0, complete_bytes: 100, complete_frames: true } },
    }),
    (base64, out, overwrite, options) => {
      seen = { options };
      return { target: 'out.mp4', buffer: Buffer.alloc(100), trimmedBytes: 0 };
    },
  );
  assert.equal(await cmd({ out: 'out.mp4' }, ['video', 'save', 'r1']), 0);
  assert.equal(seen.options.completeBytes, undefined);
  assert.match(printed.join('\n'), /已保存：out\.mp4/);
});
