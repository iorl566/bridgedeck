import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureStore, CAPTURE_TTL_MS } from '../../extension/src/lib/capture-stream.js';

const dataUrl = (base64) => 'data:image/png;base64,' + base64;

test('put 返回 captureId/bytes/宽高；read 分块可拼回原图', () => {
  const store = createCaptureStore();
  const base64 = Buffer.from('hello capture stream!').toString('base64');
  const stored = store.put({ dataUrl: dataUrl(base64), width: 120, height: 80, via: 'cdp' });
  assert.match(stored.captureId, /^cap_/);
  assert.equal(stored.bytes, Buffer.from(base64, 'base64').length);
  assert.equal(stored.width, 120);
  const chunks = [];
  let offset = 0;
  let guard = 0;
  for (;;) {
    const chunk = store.read(stored.captureId, { offset, length: 8 });
    assert.ok(chunk, '分块读取失败');
    chunks.push(chunk.dataBase64);
    offset = chunk.nextOffset;
    guard += 1;
    if (chunk.eof) break;
    assert.ok(guard < 50);
  }
  assert.equal(chunks.join(''), base64);
  assert.equal(Buffer.from(chunks.join(''), 'base64').toString(), 'hello capture stream!');
});

test('offset 越界返回空块且 eof', () => {
  const store = createCaptureStore();
  const base64 = Buffer.from('abc').toString('base64');
  const stored = store.put({ dataUrl: dataUrl(base64) });
  const chunk = store.read(stored.captureId, { offset: 9999, length: 10 });
  assert.equal(chunk.dataBase64, '');
  assert.equal(chunk.eof, true);
});

test('release 后不可读；未知 id 返回 null', () => {
  const store = createCaptureStore();
  const stored = store.put({ dataUrl: dataUrl(Buffer.from('x').toString('base64')) });
  assert.equal(store.release(stored.captureId), true);
  assert.equal(store.read(stored.captureId), null);
  assert.equal(store.release('nope'), false);
  assert.equal(store.read('nope'), null);
});

test('TTL 过期后不可读', () => {
  let now = 1000;
  const store = createCaptureStore({ now: () => now, ttlMs: 1000 });
  const stored = store.put({ dataUrl: dataUrl(Buffer.from('ttl').toString('base64')) });
  assert.ok(store.read(stored.captureId));
  now += CAPTURE_TTL_MS + 1;
  assert.equal(store.read(stored.captureId), null);
});

test('CAPTURE_MAX：超出后淘汰最早的一条', () => {
  const store = createCaptureStore({ maxCaptures: 2 });
  const first = store.put({ dataUrl: dataUrl(Buffer.from('1').toString('base64')) });
  const second = store.put({ dataUrl: dataUrl(Buffer.from('2').toString('base64')) });
  assert.equal(store.size(), 2);
  const third = store.put({ dataUrl: dataUrl(Buffer.from('3').toString('base64')) });
  assert.equal(store.size(), 2);
  assert.equal(store.read(first.captureId), null, '最早的 capture 应被淘汰');
  assert.ok(store.read(second.captureId));
  assert.ok(store.read(third.captureId));
});

test('非图片 dataUrl 拒绝入栈', () => {
  const store = createCaptureStore();
  assert.equal(store.put({ dataUrl: 'data:text/plain;base64,aGk=' }), null);
  assert.equal(store.put({ dataUrl: 'not-a-data-url' }), null);
  assert.equal(store.put({}), null);
  assert.equal(store.size(), 0);
});
