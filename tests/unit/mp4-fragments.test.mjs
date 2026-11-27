import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scanBoxesFromBlob,
  fragmentJournalFromBlob,
  completeFragmentBlob,
  completeFragmentPackage,
} from '../../extension/src/lib/mp4-fragments.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function blobOf(...parts) {
  return new Blob(parts, { type: 'video/mp4' });
}

test('分片日记：ftyp/moov + 两个 moof/mdat 对', async () => {
  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')]);
  const first = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(16))]);
  const second = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(24))]);
  const blob = blobOf(init, first, second);
  const journal = await fragmentJournalFromBlob(blob);
  assert.equal(journal.fragmented, true);
  assert.equal(journal.hasFtyp, true);
  assert.equal(journal.hasMoov, true);
  assert.equal(journal.fragments.length, 2);
  assert.equal(journal.initBytes, init.length);
  assert.equal(journal.completeBytes, blob.size);
  assert.equal(journal.trailingBytes, 0);
  assert.equal(journal.completeFrames, true);
  assert.equal(journal.fragments[0].moofOffset, init.length);
  assert.equal(journal.fragments[0].mdatBytes, 24);
  assert.equal(journal.fragments[1].bytes, second.length);
});

test('分片日记：截断尾部不算完帧', async () => {
  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')]);
  const full = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(32))]);
  const second = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(40))]);
  const truncated = second.subarray(0, second.length - 10);
  const blob = blobOf(init, full, truncated);
  const journal = await fragmentJournalFromBlob(blob);
  assert.equal(journal.fragments.length, 1);
  assert.equal(journal.trailingBytes > 0, true);
  assert.equal(journal.completeFrames, false);
  assert.equal(journal.completeBytes, init.length + full.length);
  assert.equal(journal.completeBytes < blob.size, true);
});

test('分片日记：只有 moof 没有 mdat（open fragment）', async () => {
  const init = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov')]);
  const blob = blobOf(init, box('moof'));
  const journal = await fragmentJournalFromBlob(blob);
  assert.equal(journal.fragments.length, 0);
  assert.equal(journal.openFragment, true);
  assert.equal(journal.completeFrames, false);
  assert.equal(journal.completeBytes, init.length);
});

test('分片日记：普通 MP4（无 moof）视为完整容器', async () => {
  const blob = blobOf(box('ftyp', Buffer.from('isom')), box('moov'), box('mdat', Buffer.alloc(8)));
  const journal = await fragmentJournalFromBlob(blob);
  assert.equal(journal.fragmented, false);
  assert.equal(journal.fragments.length, 0);
  assert.equal(journal.completeFrames, true);
  assert.equal(journal.completeBytes, blob.size);
});

test('scanBoxesFromBlob 返回 box 类型/偏移；completeFragmentBlob 截到完整边界', async () => {
  const init = Buffer.concat([box('ftyp'), box('moov')]);
  const full = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(8))]);
  const blob = blobOf(init, full, Buffer.from([0, 0, 0, 1]));
  const scan = await scanBoxesFromBlob(blob);
  assert.deepEqual(scan.boxes.map((item) => item.type), ['ftyp', 'moov', 'moof', 'mdat']);
  assert.equal(scan.trailingBytes, 4);
  const journal = await fragmentJournalFromBlob(blob);
  const trimmed = completeFragmentBlob(blob, journal);
  assert.equal(trimmed.size, journal.completeBytes);
  assert.equal(trimmed.size, init.length + full.length);
});

test('完帧重封装：裁剪到 completeBytes 并丢弃跨界分片', async () => {
  const init = Buffer.concat([box('ftyp'), box('moov')]);
  const first = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(16))]);
  const second = Buffer.concat([box('moof'), box('mdat', Buffer.alloc(32))]);
  const tail = Buffer.alloc(10);
  const blob = blobOf(init, first, second, tail);
  const journal = await fragmentJournalFromBlob(blob);
  const fragmentLog = [
    { index: 0, bytes: init.length },
    { index: 1, bytes: first.length },
    { index: 2, bytes: second.length },
    { index: 3, bytes: tail.length },
  ];
  const packaged = completeFragmentPackage(blob, journal, fragmentLog);
  assert.equal(packaged.trimmedBytes, tail.length);
  assert.equal(packaged.blob.size, journal.completeBytes);
  assert.equal(packaged.chunkCount, 3);
  assert.deepEqual(packaged.fragments.map((item) => item.index), [0, 1, 2]);
  const sum = packaged.fragments.reduce((total, item) => total + item.bytes, 0);
  assert.equal(sum, packaged.blob.size);
});

test('完帧重封装：完整录制不裁剪', async () => {
  const blob = blobOf(box('ftyp'), box('moov'), box('moof'), box('mdat', Buffer.alloc(8)));
  const journal = await fragmentJournalFromBlob(blob);
  const packaged = completeFragmentPackage(blob, journal, [{ index: 0, bytes: blob.size }]);
  assert.equal(packaged.trimmedBytes, 0);
  assert.equal(packaged.blob.size, blob.size);
  assert.equal(packaged.chunkCount, 1);
});
