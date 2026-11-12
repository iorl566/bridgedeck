import test from 'node:test';
import assert from 'node:assert/strict';
import { completeFragmentLength } from '../../extension/src/video/encoder.js';

function box(type, payload = new Uint8Array()) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

test('completeFragmentLength returns 0 without complete fragment', async () => {
  assert.equal(await completeFragmentLength(new Blob([box('ftyp')])), 0);
  assert.equal(await completeFragmentLength(new Blob([])), 0);
});

test('completeFragmentLength includes complete moov/moof/mdat', async () => {
  const data = concat([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array([1, 2, 3]))]);
  assert.equal(await completeFragmentLength(new Blob([data])), data.length);
});

test('completeFragmentLength ignores truncated mdat', async () => {
  const first = concat([box('ftyp'), box('moov'), box('moof'), box('mdat', new Uint8Array([1, 2, 3]))]);
  const truncated = concat([first, box('moof')]).slice(0, first.length + 8 + 2);
  assert.equal(await completeFragmentLength(new Blob([truncated])), first.length);
});
