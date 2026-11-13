import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame } from '../../lib/ws.mjs';

test('encodeFrame emits short payload header', () => {
  const frame = encodeFrame(0x1, 'hi', false);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 2);
  assert.equal(frame.subarray(2).toString(), 'hi');
});

test('encodeFrame uses 16-bit length for 126..65535 bytes', () => {
  const frame = encodeFrame(0x2, Buffer.alloc(126), false);
  assert.equal(frame[0], 0x82);
  assert.equal(frame[1], 126);
  assert.equal(frame.readUInt16BE(2), 126);
  assert.equal(frame.length, 4 + 126);
});

test('encodeFrame uses 64-bit length for >=65536 bytes', () => {
  const frame = encodeFrame(0x2, Buffer.alloc(70000), false);
  assert.equal(frame[1], 127);
  assert.equal(Number(frame.readBigUInt64BE(2)), 70000);
  assert.equal(frame.length, 10 + 70000);
});

test('encodeFrame masks payload when requested', () => {
  const frame = encodeFrame(0x1, 'abcd', true);
  assert.equal(frame[1] & 0x80, 0x80);
  const key = frame.subarray(2, 6);
  const data = frame.subarray(6);
  const decoded = Buffer.from(data.map((byte, index) => byte ^ key[index & 3]));
  assert.equal(decoded.toString(), 'abcd');
});

test('encodeFrame handles empty payload', () => {
  const frame = encodeFrame(0x8, Buffer.alloc(0), false);
  assert.equal(frame[0], 0x88);
  assert.equal(frame[1], 0);
  assert.equal(frame.length, 2);
});
