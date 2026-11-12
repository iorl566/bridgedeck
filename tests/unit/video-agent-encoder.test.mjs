import test from 'node:test';
import assert from 'node:assert/strict';
import { completeFragmentLength } from '../../extension/src/video/encoder.js';

const ascii = (text) => new TextEncoder().encode(text);

function box(type, payload = new Uint8Array()) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function largeBox(type, payload = new Uint8Array()) {
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  out.set(ascii(type), 4);
  view.setBigUint64(8, BigInt(out.length));
  out.set(payload, 16);
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test('completeFragmentLength accepts 64-bit box sizes', async () => {
  const data = concat([
    box('ftyp'),
    box('moov'),
    largeBox('moof'),
    largeBox('mdat', new Uint8Array([1, 2, 3])),
  ]);
  assert.equal(await completeFragmentLength(new Blob([data])), data.length);
});

test('completeFragmentLength ignores a fragment that starts before moov', async () => {
  const data = concat([box('ftyp'), box('moof'), box('mdat', new Uint8Array([1]))]);
  assert.equal(await completeFragmentLength(new Blob([data])), 0);
});

test('completeFragmentLength ignores mdat outside a fragment', async () => {
  const data = concat([box('ftyp'), box('moov'), box('mdat', new Uint8Array([1]))]);
  assert.equal(await completeFragmentLength(new Blob([data])), 0);
});

test('completeFragmentLength stops before a truncated 64-bit header', async () => {
  const complete = concat([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array([1]))]);
  const data = concat([complete, largeBox('mdat', new Uint8Array([1]))]).slice(0, complete.length + 10);
  assert.equal(await completeFragmentLength(new Blob([data])), complete.length);
});

test('completeFragmentLength stops before a truncated 64-bit body', async () => {
  const complete = concat([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array([1]))]);
  const data = concat([complete, largeBox('mdat', new Uint8Array([1, 2, 3, 4]))])
    .slice(0, complete.length + 16 + 2);
  assert.equal(await completeFragmentLength(new Blob([data])), complete.length);
});
