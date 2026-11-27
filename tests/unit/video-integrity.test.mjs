import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MP4_INTEGRITY_CODES,
  analyzeMp4Integrity,
  classifySeekReadiness,
  summarizeIntegrity,
} from '../../extension/src/lib/mp4-integrity.js';
import { analyzeMp4 } from '../../extension/src/lib/mp4-boxes.js';
import { buildSegmentIndex, insertSegmentIndex } from '../../extension/src/lib/fmp4-sidx.js';
import { fragmentJournalFromBlob } from '../../extension/src/lib/mp4-fragments.js';

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

function moov(timescale = 1000) {
  const mdia = box('mdia', Buffer.concat([mdhd(timescale), hdlr('vide')]));
  return box('moov', Buffer.concat([mvhd(timescale), box('trak', Buffer.concat([tkhd(1), mdia]))]));
}

function moof({ baseTime = 0, durations = [500, 500] } = {}) {
  const tfhd = box('tfhd', Buffer.concat([u32(0), u32(1)]));
  const tfdt = box('tfdt', Buffer.concat([u32(0), u32(baseTime)]));
  const trunPayload = Buffer.concat([u32(0x000100), u32(durations.length), ...durations.map((value) => u32(value))]);
  const traf = box('traf', Buffer.concat([tfhd, tfdt, box('trun', trunPayload)]));
  return box('moof', Buffer.concat([box('mfhd', Buffer.concat([u32(0), u32(1)])), traf]));
}

function fmp4(fragments = [{ baseTime: 0 }, { baseTime: 1000 }], between = []) {
  const parts = [box('ftyp', Buffer.from('isom')), moov()];
  fragments.forEach((fragment, index) => {
    if (index === 1) parts.push(...between);
    parts.push(moof(fragment), box('mdat', Buffer.alloc(64)));
  });
  return Buffer.concat(parts);
}

test('analyzeMp4Integrity：健康 fMP4 → 帧数/时长/sidx 缺失分类', () => {
  const bytes = fmp4();
  const report = analyzeMp4Integrity(bytes);
  assert.equal(report.ok, true);
  assert.equal(report.fragmented, true);
  assert.equal(report.stats.fragments, 2);
  assert.equal(report.stats.samples, 4);
  assert.equal(report.stats.timescale, 1000);
  assert.equal(report.stats.durationMs, 2000);
  assert.equal(report.seek.seekable, false);
  assert.deepEqual(report.seek.missing, ['sidx']);
  assert.equal(report.problems.some((item) => item.code === MP4_INTEGRITY_CODES.SIDX_MISSING && item.severity === 'warning'), true);
  assert.equal(report.problems.some((item) => item.severity === 'error'), false);
});

test('analyzeMp4Integrity + 插入 sidx：可 seek，sidx 结构校验通过', async () => {
  const bytes = fmp4();
  const mp4 = new Uint8Array(bytes);
  const fragmentInfo = analyzeMp4(mp4);
  assert.equal(fragmentInfo.faststart, true);
  const { bytes: sidx } = buildSegmentIndex({
    trackId: 1,
    timescale: 1000,
    fragments: [{ bytes: 100, duration: 1000 }, { bytes: 100, duration: 1000 }],
  });
  const withSidx = insertSegmentIndex(new Blob([mp4]), sidx, fragmentInfo.firstMoofOffset);
  const report = analyzeMp4Integrity(new Uint8Array(await withSidx.arrayBuffer()));
  assert.equal(report.seek.hasSidx, true);
  assert.equal(report.seek.seekable, true);
  assert.equal(report.problems.some((item) => item.code === MP4_INTEGRITY_CODES.SIDX_MISSING), false);
  assert.equal(report.problems.some((item) => item.scope === 'sidx' && item.severity === 'error'), false);
  assert.ok(sidx.length > 0);
});

test('analyzeMp4Integrity：时间戳回退是 error', () => {
  const bytes = fmp4([{ baseTime: 1000, durations: [500] }, { baseTime: 500, durations: [500] }]);
  const report = analyzeMp4Integrity(bytes);
  assert.equal(report.ok, false);
  const regression = report.problems.find((item) => item.code === MP4_INTEGRITY_CODES.TIMESTAMP_REGRESSION);
  assert.equal(regression.severity, 'error');
  assert.deepEqual({ index: regression.index, baseTime: regression.baseTime, previous: regression.previous }, { index: 1, baseTime: 500, previous: 1000 });
});

test('analyzeMp4Integrity：缺帧（时间戳空洞）warning / strictFrames error', () => {
  const bytes = fmp4([{ baseTime: 0, durations: [500] }, { baseTime: 1500, durations: [500] }]);
  const report = analyzeMp4Integrity(bytes);
  assert.equal(report.ok, true);
  const gap = report.problems.find((item) => item.code === MP4_INTEGRITY_CODES.FRAME_GAP);
  assert.equal(gap.severity, 'warning');
  assert.equal(gap.missingFrameTicks, 1000);
  assert.equal(gap.missingMs, 1000);
  assert.equal(report.stats.frameGaps, 1);
  assert.equal(report.stats.missingFrameTicks, 1000);

  const strict = analyzeMp4Integrity(bytes, { strictFrames: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.problems.find((item) => item.code === MP4_INTEGRITY_CODES.FRAME_GAP).severity, 'error');
});

test('analyzeMp4Integrity：零时长分片与空样本分片分类', () => {
  const zero = analyzeMp4Integrity(fmp4([{ baseTime: 0, durations: [0] }]));
  assert.equal(zero.ok, true);
  assert.equal(zero.problems.some((item) => item.code === MP4_INTEGRITY_CODES.ZERO_DURATION_FRAGMENT && item.severity === 'warning'), true);

  const empty = analyzeMp4Integrity(fmp4([{ baseTime: 0, durations: [] }]));
  assert.equal(empty.ok, false);
  assert.equal(empty.problems.some((item) => item.code === MP4_INTEGRITY_CODES.EMPTY_FRAGMENT && item.severity === 'error'), true);
});

test('analyzeMp4Integrity：无分片/空输入/纯 MP4 faststart 分类', () => {
  const noFragments = analyzeMp4Integrity(Buffer.concat([box('ftyp', Buffer.from('isom')), moov(), box('moof')]));
  assert.equal(noFragments.ok, false);
  assert.equal(noFragments.problems.some((item) => item.code === MP4_INTEGRITY_CODES.NO_FRAGMENTS), true);

  const empty = analyzeMp4Integrity(new Uint8Array(0));
  assert.equal(empty.ok, false);
  assert.equal(empty.problems[0].code, MP4_INTEGRITY_CODES.EMPTY_CONTAINER);

  const plain = analyzeMp4Integrity(Buffer.concat([box('ftyp', Buffer.from('isom')), moov(), box('mdat', Buffer.alloc(16))]));
  assert.equal(plain.fragmented, false);
  assert.equal(plain.ok, true);
  assert.equal(plain.seek.seekable, true);
  assert.equal(plain.seek.faststart, true);

  const notFaststart = analyzeMp4Integrity(Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', Buffer.alloc(16)), moov()]));
  assert.equal(notFaststart.seek.faststart, false);
  assert.equal(notFaststart.problems.some((item) => item.code === MP4_INTEGRITY_CODES.FASTSTART_MISSING), true);
});

test('analyzeMp4Integrity：分片间 free box 视为已知字节（不报 byte_gap）', () => {
  const bytes = fmp4([{ baseTime: 0, durations: [500] }, { baseTime: 500, durations: [500] }], [box('free', Buffer.alloc(12))]);
  const report = analyzeMp4Integrity(bytes);
  assert.equal(report.ok, true);
  assert.equal(report.problems.some((item) => item.code === MP4_INTEGRITY_CODES.BYTE_GAP), false);
  assert.equal(report.stats.byteGaps, 0);
});

test('analyzeMp4Integrity：expectedFrames 缺帧定量 + journal 证据合并且不重复字节检查', async () => {
  const bytes = fmp4();
  const journal = await fragmentJournalFromBlob(new Blob([bytes]));
  const report = analyzeMp4Integrity(bytes, { journal, expectedFrames: 10 });
  assert.equal(report.ok, true);
  assert.equal(report.journal.stats.fragments, 2);
  assert.equal(report.problems.some((item) => item.code === MP4_INTEGRITY_CODES.MISSING_FRAMES), true);
  assert.equal(report.problems.some((item) => item.code === MP4_INTEGRITY_CODES.BYTE_GAP), false);

  const truncatedBytes = Buffer.concat([bytes, Buffer.from([0, 0, 0, 1])]);
  const truncatedJournal = await fragmentJournalFromBlob(new Blob([truncatedBytes]));
  const truncated = analyzeMp4Integrity(truncatedBytes, { journal: truncatedJournal });
  assert.equal(truncated.problems.some((item) => item.code === MP4_INTEGRITY_CODES.TRUNCATED), true);
});

test('classifySeekReadiness / summarizeIntegrity 输出稳定', () => {
  assert.deepEqual(classifySeekReadiness(null), { seekable: false, faststart: false, hasSidx: false, moovFirst: false, missing: ['container'], format: 'unknown' });
  const fmp4Container = analyzeMp4(fmp4());
  assert.deepEqual(classifySeekReadiness(fmp4Container).missing, ['sidx']);
  const plain = analyzeMp4(Buffer.concat([box('ftyp', Buffer.from('isom')), moov(), box('mdat', Buffer.alloc(8))]));
  assert.equal(classifySeekReadiness(plain).seekable, true);

  const summary = summarizeIntegrity(analyzeMp4Integrity(fmp4()));
  assert.equal(summary.ok, true);
  assert.equal(summary.fragmented, true);
  assert.equal(summary.seekable, false);
  assert.equal(summary.stats.fragments, 2);
  assert.equal(Array.isArray(summary.problems), true);
  assert.equal(summary.warnings >= 1, true);
  assert.equal(summarizeIntegrity(null), null);
});
