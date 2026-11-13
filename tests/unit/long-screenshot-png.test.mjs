import test from 'node:test';
import assert from 'node:assert/strict';
import { pngChunk, streamPng } from '../../extension/src/long-screenshot/png.js';

const concat = (parts) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

test('pngChunk writes length/type/CRC', () => {
  const chunk = pngChunk('IEND', new Uint8Array());
  assert.equal(chunk.length, 12);
  assert.deepEqual([...chunk.slice(4, 8)], [...new TextEncoder().encode('IEND')]);
  assert.equal(new DataView(chunk.buffer).getUint32(0), 0);
});

test('streamPng emits signature, IHDR, IDAT, IEND', async () => {
  const parts = [];
  await streamPng(1, 1, (async function* () { yield new Uint8Array([255, 0, 0, 255]); })(), async (bytes) => parts.push(bytes));
  const bytes = concat(parts);
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), 'IHDR');
  assert.equal(new DataView(bytes.buffer).getUint32(16), 1);
  assert.equal(new TextDecoder().decode(bytes.slice(bytes.length - 8, bytes.length - 4)), 'IEND');
});

test('streamPng validates rows and dimensions', async () => {
  await assert.rejects(() => streamPng(0, 1, (async function* () {})(), async () => {}), /dimensions/);
  await assert.rejects(() => streamPng(1, 1, (async function* () {})(), async () => {}), /Missing PNG rows/);
  await assert.rejects(async () => {
    const parts = [];
    await streamPng(1, 1, (async function* () { yield new Uint8Array([1, 2, 3]); })(), async (bytes) => parts.push(bytes));
  }, /Incomplete PNG scanline/);
});
