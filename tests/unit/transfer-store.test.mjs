import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTransferStore, TRANSFER_CHUNK_BYTES, TRANSFER_MAX_BYTES } from '../../daemon/transfer.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-transfer-test-'));
  const store = createTransferStore({ dir, log: () => {}, BridgeError: TestBridgeError });
  return { dir, store };
}

test('begin/chunk/finish/read/release 基本闭环', () => {
  const { dir, store } = makeStore();
  try {
    const begun = store.begin({ sessionId: 's1', name: 'a.txt', byteSize: 5 });
    assert.match(begun.transferId, /^tr_/);
    assert.equal(begun.chunkSize, TRANSFER_CHUNK_BYTES);
    const chunk = store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: Buffer.from('hello').toString('base64') });
    assert.deepEqual(chunk, { nextOffset: 5, eof: true });
    const finished = store.finish({ transferId: begun.transferId });
    assert.equal(finished.byteSize, 5);
    const read = store.read({ transferId: begun.transferId, offset: 0 });
    assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'hello');
    assert.equal(read.eof, true);
    assert.equal(store.release({ transferId: begun.transferId }).released, true);
    assert.throws(() => store.read({ transferId: begun.transferId, offset: 0 }), (error) => error.code === 'E_TRANSFER_NOT_FOUND');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('begin 校验文件名与 byteSize', () => {
  const { dir, store } = makeStore();
  try {
    assert.throws(() => store.begin({ sessionId: 's1', name: '../x', byteSize: 1 }), (error) => error.code === 'E_BAD_ARG');
    assert.throws(() => store.begin({ sessionId: 's1', name: 'x', byteSize: 0 }), (error) => error.code === 'E_BAD_ARG');
    assert.throws(() => store.begin({ sessionId: 's1', name: 'x', byteSize: TRANSFER_MAX_BYTES + 1 }), (error) => error.code === 'E_BAD_ARG');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chunk 校验 offset/块大小/超写', () => {
  const { dir, store } = makeStore();
  try {
    const begun = store.begin({ sessionId: 's1', name: 'b.bin', byteSize: 4 });
    assert.throws(() => store.chunk({ transferId: begun.transferId, offset: 1, dataBase64: 'aGk=' }), (error) => error.code === 'E_TRANSFER_OFFSET');
    const big = Buffer.alloc(TRANSFER_CHUNK_BYTES + 1).toString('base64');
    assert.throws(() => store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: big }), (error) => error.code === 'E_TRANSFER_LIMIT');
    store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: Buffer.from('ab').toString('base64') });
    assert.throws(() => store.chunk({ transferId: begun.transferId, offset: 2, dataBase64: Buffer.from('cde').toString('base64') }), (error) => error.code === 'E_TRANSFER_LIMIT');
    assert.throws(() => store.finish({ transferId: begun.transferId }), (error) => error.code === 'E_TRANSFER_INCOMPLETE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('injectPaths 绑定会话并写入 stagedPath', () => {
  const { dir, store } = makeStore();
  try {
    const begun = store.begin({ sessionId: 's1', name: 'u.txt', byteSize: 1 });
    store.chunk({ transferId: begun.transferId, offset: 0, dataBase64: Buffer.from('x').toString('base64') });
    store.finish({ transferId: begun.transferId });
    const params = store.injectPaths({ sessionId: 's1', files: [{ transferId: begun.transferId }], paths: [] });
    assert.equal(params.paths.length, 1);
    assert.ok(fs.existsSync(params.files[0].stagedPath));
    assert.throws(() => store.injectPaths({ sessionId: 's2', files: [{ transferId: begun.transferId }] }), (error) => error.code === 'E_TRANSFER_STATE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseForSession 清理该会话的 transfer', () => {
  const { dir, store } = makeStore();
  try {
    const a = store.begin({ sessionId: 's1', name: 'a', byteSize: 1 });
    const b = store.begin({ sessionId: 's2', name: 'b', byteSize: 1 });
    assert.equal(store.size, 2);
    store.releaseForSession('s1');
    assert.equal(store.size, 1);
    assert.throws(() => store.read({ transferId: a.transferId, offset: 0 }), (error) => error.code === 'E_TRANSFER_NOT_FOUND');
    assert.ok(store.read({ transferId: b.transferId, offset: 0 }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stageDownload 导入文件并可按 transfer 读取', () => {
  const { dir, store } = makeStore();
  try {
    const src = path.join(dir, 'download.txt');
    fs.writeFileSync(src, 'downloaded', 'utf8');
    const staged = store.stageDownload({ filename: src, ok: true }, 's1');
    assert.match(staged.transferId, /^tr_/);
    assert.equal(staged.transferBytes, 10);
    const read = store.read({ transferId: staged.transferId, offset: 0 });
    assert.equal(Buffer.from(read.dataBase64, 'base64').toString(), 'downloaded');
    assert.equal(store.release({ transferId: staged.transferId }).released, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
