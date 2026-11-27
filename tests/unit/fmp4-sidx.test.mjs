import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInit,
  parseFragments,
  buildSegmentIndex,
  segmentIndexForBlob,
  insertSegmentIndex,
} from '../../extension/src/lib/fmp4-sidx.js';
import { analyzeMp4 } from '../../extension/src/lib/mp4-boxes.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function mvhd(timescale) {
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(timescale, 12);
  return box('mvhd', payload);
}

function tkhd(trackId) {
  const payload = Buffer.alloc(84);
  payload.writeUInt32BE(trackId, 8);
  return box('tkhd', payload);
}

function mdhd(timescale) {
  const payload = Buffer.alloc(24);
  payload.writeUInt32BE(timescale, 12);
  return box('mdhd', payload);
}

function hdlr(handler) {
  const payload = Buffer.alloc(24);
  payload.write(handler, 8, 'ascii');
  return box('hdlr', payload);
}

function moov() {
  const mdia = box('mdia', Buffer.concat([mdhd(1000), hdlr('vide')]));
  return box('moov', Buffer.concat([mvhd(1000), box('trak', Buffer.concat([tkhd(1), mdia]))]));
}

function moof({ baseTime = 0, durations = [500, 500] } = {}) {
  const tfhd = box('tfhd', Buffer.concat([u32(0), u32(1)]));
  const tfdt = box('tfdt', Buffer.concat([u32(0), u32(baseTime)]));
  const trunPayload = Buffer.concat([u32(0x000100), u32(durations.length), ...durations.map((d) => u32(d))]);
  const traf = box('traf', Buffer.concat([tfhd, tfdt, box('trun', trunPayload)]));
  return box('moof', Buffer.concat([box('mfhd', Buffer.concat([u32(0), u32(1)])), traf]));
}

function sampleMp4({ fragments = 1 } = {}) {
  const parts = [box('ftyp', Buffer.from('isom')), moov()];
  for (let i = 0; i < fragments; i += 1) {
    parts.push(moof({ baseTime: i * 1000 }), box('mdat', Buffer.alloc(64)));
  }
  return Buffer.concat(parts);
}

test('parseInit：mvhd/tkhd/mdhd/hdlr 解析出 timescale 与 trackId', () => {
  const bytes = sampleMp4();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const init = parseInit(view);
  assert.equal(init.timescale, 1000);
  assert.equal(init.trackId, 1);
  assert.equal(init.firstMoof, box('ftyp', Buffer.from('isom')).length + moov().length);
  assert.equal(init.hasSidx, false);
});

test('parseFragments：moof+mdat 字节与 trun duration 汇总', () => {
  const bytes = sampleMp4({ fragments: 2 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fragments = parseFragments(view);
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].duration, 1000);
  assert.equal(fragments[1].baseTime, 1000);
  assert.equal(fragments[0].bytes, moof().length + box('mdat', Buffer.alloc(64)).length);
});

test('buildSegmentIndex：sidx 头/引用数/引用大小正确', () => {
  const { bytes, count } = buildSegmentIndex({
    trackId: 1,
    timescale: 1000,
    earliest: 0,
    fragments: [{ bytes: 100, duration: 500 }, { bytes: 200, duration: 500 }],
  });
  assert.equal(count, 2);
  assert.equal(bytes.length, 32 + 2 * 12);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0), bytes.length);
  assert.equal(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]), 'sidx');
  assert.equal(view.getUint32(12), 1);
  assert.equal(view.getUint32(16), 1000);
  assert.equal(view.getUint16(30), 2);
  assert.equal(view.getUint32(32), 100);
  assert.equal(view.getUint32(36), 500);
});

test('segmentIndexForBlob + insertSegmentIndex：插入 sidx 后可解析', async () => {
  const bytes = sampleMp4();
  const blob = new Blob([bytes], { type: 'video/mp4' });
  const info = await segmentIndexForBlob(blob);
  assert.ok(info && info.sidx && info.insertAt > 0);
  const indexed = insertSegmentIndex(blob, info.sidx, info.insertAt);
  assert.equal(indexed.size, blob.size + info.sidx.byteLength);
  const result = analyzeMp4(new Uint8Array(await indexed.arrayBuffer()));
  assert.deepEqual(result.boxes, ['ftyp', 'moov', 'sidx', 'moof', 'mdat']);
});

test('segmentIndexForBlob：非 fMP4/无 moof 返回 null', async () => {
  const blob = new Blob([Buffer.concat([box('ftyp'), box('moov')])], { type: 'video/mp4' });
  assert.equal(await segmentIndexForBlob(blob), null);
});
