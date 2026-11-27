import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMp4 } from '../../extension/src/lib/mp4-boxes.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

test('解析 ftyp/moov/moof', () => {
  const bytes = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov'), box('moof'), box('mdat', Buffer.alloc(4))]);
  const out = analyzeMp4(bytes);
  assert.deepEqual(out.boxes, ['ftyp', 'moov', 'moof', 'mdat']);
  assert.equal(out.fragmented, true);
  assert.equal(out.hasFtyp, true);
});

test('普通 MP4 无 moof', () => {
  const out = analyzeMp4(Buffer.concat([box('ftyp'), box('moov'), box('mdat')]));
  assert.equal(out.fragmented, false);
});

test('截断/空输入不抛', () => {
  assert.equal(analyzeMp4(Buffer.alloc(0)).fragmented, false);
  assert.equal(analyzeMp4(Buffer.from([0, 0, 0])).boxes.length, 0);
});
