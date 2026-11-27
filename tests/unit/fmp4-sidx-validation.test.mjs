import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDX_PROBLEM_CODES,
  buildSegmentIndex,
  parseSegmentIndex,
  scanTopBoxes,
  validateSegmentIndex,
} from '../../extension/src/lib/fmp4-sidx.js';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

test('parseSegmentIndex：v0 头字段与 reference 明细', () => {
  const { bytes, count } = buildSegmentIndex({
    trackId: 2,
    timescale: 90000,
    earliest: 3600,
    fragments: [{ bytes: 111, duration: 3000 }, { bytes: 222, duration: 3000 }],
  });
  const info = parseSegmentIndex(bytes);
  assert.equal(count, 2);
  assert.equal(info.version, 0);
  assert.equal(info.trackId, 2);
  assert.equal(info.timescale, 90000);
  assert.equal(info.earliest, 3600);
  assert.equal(info.firstOffset, 0);
  assert.equal(info.count, 2);
  assert.equal(info.headerBytes, 24);
  assert.equal(info.references.length, 2);
  assert.deepEqual(info.references.map((item) => [item.type, item.size, item.duration]), [[0, 111, 3000], [0, 222, 3000]]);
  assert.equal(info.references[0].startsWithSap, true);
  assert.equal(info.references[0].sapType, 1);
  assert.equal(info.complete, true);
});

test('validateSegmentIndex：合法/截断/缺失/空 reference 分类', () => {
  const { bytes } = buildSegmentIndex({ trackId: 1, timescale: 1000, fragments: [{ bytes: 100, duration: 500 }, { bytes: 200, duration: 500 }] });
  const ok = validateSegmentIndex(bytes);
  assert.equal(ok.ok, true);
  assert.equal(ok.mediaBytes, 300);
  assert.equal(ok.totalDuration, 1000);
  assert.equal(ok.problems.length, 0);

  const truncated = validateSegmentIndex(bytes.subarray(0, bytes.length - 8));
  assert.equal(truncated.ok, false);
  assert.equal(truncated.problems[0].code, SIDX_PROBLEM_CODES.SIDX_TRUNCATED);

  const empty = buildSegmentIndex({ trackId: 1, timescale: 1000, fragments: [] });
  const emptyReport = validateSegmentIndex(empty.bytes);
  assert.equal(emptyReport.ok, false);
  assert.equal(emptyReport.problems[0].code, SIDX_PROBLEM_CODES.SIDX_EMPTY);

  const missing = validateSegmentIndex(box('ftyp', Buffer.from('isom')));
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].code, SIDX_PROBLEM_CODES.SIDX_MISSING);
  assert.equal(validateSegmentIndex(null).ok, false);
});

test('scanTopBoxes：顶层 box 偏移/大小可用于定位 sidx', () => {
  const ftyp = box('ftyp', Buffer.from('isom'));
  const { bytes: sidx } = buildSegmentIndex({ trackId: 1, timescale: 1000, fragments: [{ bytes: 10, duration: 10 }] });
  const moof = box('moof');
  const boxes = scanTopBoxes(Buffer.concat([ftyp, sidx, moof]));
  assert.deepEqual(boxes.map((item) => item.type), ['ftyp', 'sidx', 'moof']);
  assert.equal(boxes[1].offset, ftyp.length);
  assert.equal(boxes[1].size, sidx.length);
});

test('validateSegmentIndex：minReferences 与非法 timescale 只产生 warning', () => {
  const { bytes } = buildSegmentIndex({ trackId: 1, timescale: 1000, fragments: [{ bytes: 10, duration: 10 }] });
  const report = validateSegmentIndex(bytes, { minReferences: 3 });
  assert.equal(report.ok, true);
  assert.equal(report.problems[0].code, SIDX_PROBLEM_CODES.SIDX_COUNT_MISMATCH);
  assert.equal(report.problems[0].severity, 'warning');
});
