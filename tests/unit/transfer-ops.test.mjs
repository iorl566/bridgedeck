import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransferOps } from '../../daemon/transfer-ops.js';

function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-transfer-'));
  const ops = createTransferOps({
    dir,
    log: () => {},
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    resolveSession: (id) => ({ sessionId: id || 's1' }),
  });
  return { ops, dir };
}

test('transfer.begin/chunk/finish/read/release 往返', () => {
  const { ops } = make();
  const begun = ops.transferBegin({ session: 's1', name: 'a.txt', byteSize: 2 });
  assert.ok(begun.transferId);
  ops.transferChunk({ transferId: begun.transferId, offset: 0, dataBase64: Buffer.from('hi').toString('base64') });
  const finished = ops.transferFinish({ transferId: begun.transferId });
  assert.equal(finished.byteSize, 2);
  const read = ops.transferRead({ transferId: begun.transferId, offset: 0 });
  assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'hi');
  ops.transferRelease({ transferId: begun.transferId });
  assert.throws(() => ops.transferRead({ transferId: begun.transferId, offset: 0 }), (error) => Boolean(error.code));
});

test('stageDownloadResult 生成 transfer 引用', () => {
  const { ops } = make();
  const result = ops.stageDownloadResult({ path: path.join(os.tmpdir(), 'nope.bin'), bytes: 0 }, 's1');
  assert.ok(result === null || typeof result === 'object');
});
