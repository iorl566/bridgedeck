import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyRecording } from '../../extension/src/lib/video-verify.js';
import { createSegmentManifest, appendSegment } from '../../extension/src/lib/video-manifest.js';

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

function moov(timescale = 1000) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(timescale, 12);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1, 8);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(timescale, 12);
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8, 'ascii');
  return box('moov', Buffer.concat([
    box('mvhd', mvhd),
    box('trak', Buffer.concat([
      box('tkhd', tkhd),
      box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)])),
    ])),
  ]));
}

function moof({ baseTime = 0, durations = [500, 500] } = {}) {
  const tfhd = box('tfhd', Buffer.concat([u32(0), u32(1)]));
  const tfdt = box('tfdt', Buffer.concat([u32(0), u32(baseTime)]));
  const trun = box('trun', Buffer.concat([u32(0x000100), u32(durations.length), ...durations.map((item) => u32(item))]));
  return box('moof', box('traf', Buffer.concat([tfhd, tfdt, trun])));
}

function fmp4({ firstBaseTime = 0, secondBaseTime = 1000 } = {}) {
  const parts = [
    box('ftyp', Buffer.from('isom')),
    moov(),
    moof({ baseTime: firstBaseTime, durations: [500, 500] }),
    box('mdat', Buffer.alloc(32)),
    moof({ baseTime: secondBaseTime, durations: [500, 500] }),
    box('mdat', Buffer.alloc(32)),
  ];
  return Buffer.concat(parts);
}

function sha(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function recordOf(bytes, overrides = {}) {
  return {
    id: 'rec-v',
    mime: 'video/mp4',
    bytes: bytes.length,
    blob: new Blob([bytes], { type: 'video/mp4' }),
    fragments: [{ index: 0, at: 0, bytes: bytes.length, sha256: sha(bytes) }],
    ...overrides,
  };
}

test('verifyRecording：健康 fMP4 → 哈希/容器/分片日记/帧级/可 seek 分类', async () => {
  const buffer = fmp4();
  const report = await verifyRecording(recordOf(buffer));
  assert.equal(report.recordingId, 'rec-v');
  assert.equal(report.chunks, 1);
  assert.equal(report.verified, true);
  assert.equal(report.bytes, buffer.length);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.hash.complete, true);
  assert.equal(report.container.format, 'mp4');
  assert.equal(report.container.fragmented, true);
  assert.equal(report.journal.fragments, 2);
  assert.equal(report.journal_integrity.ok, true);
  assert.equal(report.integrity.ok, true);
  assert.equal(report.integrity.fragmented, true);
  assert.equal(report.frames.fragments, 2);
  assert.equal(report.frames.samples, 4);
  assert.equal(report.frames.durationMs, 2000);
  assert.equal(report.seek.seekable, false);
  assert.deepEqual(report.seek.missing, ['sidx']);
  assert.equal(report.ok, true);
  assert.equal(report.problems.some((item) => item.code === 'E_VIDEO_MP4_SIDX_MISSING' && item.scope === 'frames'), true);
});

test('verifyRecording：哈希篡改 / 时间戳回退 → ok=false', async () => {
  const buffer = fmp4();
  const tampered = recordOf(buffer, { fragments: [{ index: 0, at: 0, bytes: buffer.length, sha256: 'f'.repeat(64) }] });
  const report = await verifyRecording(tampered);
  assert.equal(report.verified, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, [{ index: 0, reason: 'mismatch' }]);
  assert.equal(report.problems.some((item) => item.code === 'E_VIDEO_FRAGMENT_HASH_MISMATCH' && item.scope === 'fragments'), true);

  const regressionBytes = fmp4({ firstBaseTime: 1000, secondBaseTime: 100 });
  const regression = await verifyRecording(recordOf(regressionBytes));
  assert.equal(regression.ok, false);
  assert.equal(regression.problems.some((item) => item.code === 'E_VIDEO_MP4_TIMESTAMP_REGRESSION' && item.severity === 'error'), true);
});

test('verifyRecording：strictFrames 把缺帧升级为 error', async () => {
  const gappedBytes = fmp4({ secondBaseTime: 3000 });
  const report = await verifyRecording(recordOf(gappedBytes), { strictFrames: true });
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((item) => item.code === 'E_VIDEO_MP4_FRAME_GAP' && item.severity === 'error'), true);
  assert.equal(report.frames.frameGaps, 1);
});

test('verifyRecording：无分片 / webm / 帧级分析跳过', async () => {
  const buffer = fmp4();
  const noFragments = await verifyRecording({ id: 'r', mime: 'video/mp4', bytes: buffer.length, blob: new Blob([buffer]) });
  assert.equal(noFragments.chunks, 0);
  assert.equal(noFragments.verified, false);
  assert.equal(noFragments.hash.complete, false);

  const webm = await verifyRecording({ id: 'w', mime: 'video/webm', bytes: 4, blob: new Blob([new Uint8Array([1, 2, 3, 4])]), fragments: [{ index: 0, bytes: 4, sha256: sha(new Uint8Array([1, 2, 3, 4])) }] });
  assert.equal(webm.container.format, 'webm');
  assert.equal(webm.integrity, null);
  assert.equal(webm.seek.seekable, false);
  assert.equal(webm.ok, true);

  const skipped = await verifyRecording(recordOf(buffer), { maxAnalyzeBytes: 1 });
  assert.equal(skipped.integrity.skipped, true);
  assert.equal(skipped.integrity.reason, 'size_limit');
  assert.equal(skipped.frames, null);
  assert.equal(skipped.ok, true);
});

test('verifyRecording：manifest 选项参与校验并进 problems', async () => {
  const buffer = fmp4();
  const manifest = createSegmentManifest({ recordingId: 'rec-v', codec: 'avc', now: 1 });
  const appended = appendSegment(manifest, { index: 0, atMs: 0, bytes: buffer.length, codec: 'avc', lastFrameAt: 1000, checksum: sha(buffer) });
  assert.equal(appended.ok, true);
  const report = await verifyRecording(recordOf(buffer), { manifest: appended.manifest });
  assert.equal(report.manifest.segments, 1);
  assert.equal(report.manifest.validation.ok, true);

  const brokenManifest = { ...appended.manifest, segments: [{ ...appended.manifest.segments[0], index: 1 }] };
  const broken = await verifyRecording(recordOf(buffer), { manifest: brokenManifest });
  assert.equal(broken.ok, false);
  assert.equal(broken.problems.some((item) => item.scope === 'manifest' && item.code === 'E_VIDEO_SEGMENT_INDEX_GAP'), true);
});

test('verifyRecording：记录缺 blob 抛错；纯 MP4 faststart 可 seek', async () => {
  await assert.rejects(() => verifyRecording({ id: 'x', bytes: 10 }), /录制缺少数据/);
  await assert.rejects(() => verifyRecording(null), /缺少录制记录/);

  const plain = Buffer.concat([box('ftyp', Buffer.from('isom')), moov(), box('mdat', Buffer.alloc(16))]);
  const report = await verifyRecording(recordOf(plain), { toleranceMs: 5 });
  assert.equal(report.container.fragmented, false);
  assert.equal(report.seek.seekable, true);
  assert.equal(report.seek.faststart, true);
  assert.equal(report.integrity.fragmented, false);
  assert.equal(report.ok, true);
});
