// tests/unit/longshot-compress.test.mjs
// 第十一批-E：长截图分片/索引压缩与体积预算（lib/longshot-compress.js）。
// 覆盖：体积估算（熵/格式/质量）、编码选择（fits/degrade/reject）、去重、整体压缩计划、
//       manifest 瘦身、配额联动、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPRESS_ACTIONS,
  COMPRESS_DEFAULTS,
  COMPRESS_FORMATS,
  LONGSHOT_COMPRESS_VERSION,
  chooseFrameEncoding,
  compactManifest,
  compressionWire,
  dedupeFrames,
  describeCompression,
  estimateEncodedBytes,
  estimateManifestBytes,
  estimatePngBytes,
  planCompressionStorage,
  planLongshotCompression,
} from '../../extension/src/lib/longshot-compress.js';

test('常量：格式/动作/默认值形状稳定', () => {
  assert.equal(LONGSHOT_COMPRESS_VERSION, 1);
  assert.deepEqual([...COMPRESS_FORMATS], ['png', 'webp', 'jpeg']);
  assert.deepEqual([...COMPRESS_ACTIONS], ['fits', 'shrink', 'degrade', 'reject', 'dedupe']);
  assert.ok(COMPRESS_DEFAULTS.maxFrameBytes > 0);
  assert.ok(COMPRESS_DEFAULTS.maxTotalBytes > COMPRESS_DEFAULTS.maxFrameBytes);
  assert.equal(COMPRESS_DEFAULTS.qualitySteps.length, 4);
});

test('estimatePngBytes：像素/熵/dpr 单调；零输入不炸', () => {
  const lowEntropy = estimatePngBytes({ width: 800, height: 400, entropy: 0.1, dpr: 1 });
  const highEntropy = estimatePngBytes({ width: 800, height: 400, entropy: 0.9, dpr: 1 });
  assert.ok(highEntropy > lowEntropy);
  const doubled = estimatePngBytes({ width: 800, height: 400, entropy: 0.1, dpr: 2 });
  assert.ok(doubled > lowEntropy * 3, 'dpr 2 → 4 倍像素');
  assert.ok(estimatePngBytes({}) >= 128);
  assert.ok(estimatePngBytes(null) >= 128);
});

test('estimateEncodedBytes：格式/质量影响每像素字节；未知格式回落 png', () => {
  const png = estimateEncodedBytes({ width: 1000, height: 1000, format: 'png', entropy: 0.5 });
  const webp = estimateEncodedBytes({ width: 1000, height: 1000, format: 'webp', quality: 0.8, entropy: 0.5 });
  const jpegLow = estimateEncodedBytes({ width: 1000, height: 1000, format: 'jpeg', quality: 0.6, entropy: 0.5 });
  const jpegHigh = estimateEncodedBytes({ width: 1000, height: 1000, format: 'jpeg', quality: 0.92, entropy: 0.5 });
  assert.equal(png.format, 'png');
  assert.equal(webp.format, 'webp');
  assert.ok(webp.bytes < png.bytes);
  assert.ok(jpegLow.bytes < jpegHigh.bytes, '质量越低体积越小');
  assert.equal(estimateEncodedBytes({ width: 10, height: 10, format: 'unknown' }).format, 'png');
  assert.equal(estimateEncodedBytes({ width: 10, height: 10, format: 'jpg' }).format, 'jpeg');
  assert.equal(estimateEncodedBytes({ width: 10, height: 10 }).pixels, 100);
});

test('chooseFrameEncoding：宽松预算保留首选格式；紧预算逐档降级；不可能时 fits=false', () => {
  const loose = chooseFrameEncoding({ width: 400, height: 300, prefer: 'png', maxBytes: 10 * 1024 * 1024 });
  assert.equal(loose.fits, true);
  assert.equal(loose.format, 'png');
  assert.equal(loose.degraded, false);
  const tight = chooseFrameEncoding({ width: 1000, height: 1000, prefer: 'png', maxBytes: 200_000, entropy: 0.4 });
  assert.equal(tight.fits, true);
  assert.notEqual(tight.format, 'png');
  assert.equal(tight.degraded, true);
  assert.ok(tight.attempts > 1);
  const impossible = chooseFrameEncoding({ width: 4000, height: 4000, prefer: 'png', maxBytes: 1000, entropy: 0.9 });
  assert.equal(impossible.fits, false);
  assert.ok(impossible.bytes > 1000);
  assert.ok(impossible.candidates.length > 1);
});

test('dedupeFrames：同 hash 只留一份并累计节省；无 hash 不参与', () => {
  const result = dedupeFrames([
    { index: 0, hash: 'aa', bytes: 100 },
    { index: 1, hash: 'aa', bytes: 100 },
    { index: 2, hash: 'bb', bytes: 200 },
    { index: 3, bytes: 300 },
    { index: 4, hash: '', bytes: 400 },
  ]);
  assert.equal(result.unique.length, 4);
  assert.deepEqual(result.duplicates.map((item) => item.index), [1]);
  assert.equal(result.savedBytes, 100);
  assert.equal(result.ratio, 0.2);
  assert.deepEqual(dedupeFrames(null).unique, []);
});

test('planLongshotCompression：去重优先、超总量降档、全超限 reject', () => {
  const frames = [
    { index: 0, width: 800, height: 1000, bytes: 900_000, hash: 'aa' },
    { index: 1, width: 800, height: 1000, bytes: 900_000, hash: 'aa' },
    { index: 2, width: 800, height: 1000, bytes: 800_000, hash: 'bb' },
  ];
  const dedupe = planLongshotCompression(frames, { maxTotalBytes: 64 * 1024 * 1024 });
  assert.equal(dedupe.action, 'dedupe');
  assert.equal(dedupe.frames, 3);
  assert.equal(dedupe.uniqueFrames, 2);
  assert.equal(dedupe.dedupeSavedBytes, 900_000);
  assert.ok(dedupe.issues.includes('longshot.compress.dedupe'));

  const degrade = planLongshotCompression(frames, { maxTotalBytes: 250_000, maxFrameBytes: 200_000 });
  assert.equal(degrade.ok, true);
  assert.ok(['shrink', 'degrade'].includes(degrade.action), '总量略超时降档而不是拒绝：' + degrade.action);

  const reject = planLongshotCompression(frames, { maxTotalBytes: 1000, maxFrameBytes: 1000 });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.ok, false);
  assert.equal(reject.rejectedFrames, 2);
});

test('planLongshotCompression：空输入稳定；perFrame 带格式与估算', () => {
  const empty = planLongshotCompression(null, {});
  assert.equal(empty.action, 'fits');
  assert.equal(empty.frames, 0);
  assert.deepEqual(empty.issues, ['longshot.compress.ok']);
  const plan = planLongshotCompression([
    { index: 0, width: 800, height: 200, bytes: 200_000, hash: 'cc', pageY: 0 },
    { index: 1, width: 800, height: 200, bytes: 200_000, hash: 'dd', pageY: 200 },
  ], { prefer: 'webp', maxTotalBytes: 10 * 1024 * 1024 });
  assert.equal(plan.perFrame.length, 2);
  assert.equal(plan.perFrame[0].format, 'webp');
  assert.ok(plan.perFrame[0].estimateBytes > 0);
  assert.equal(plan.evidence.frames, 2);
  assert.equal(plan.ratios.compression <= 1, true);
});

test('compactManifest：瘦身去掉大字段、保留恢复必需键、可断言字节减少', () => {
  const manifest = {
    version: 1,
    captureId: 'cap-1',
    dpr: 1.5,
    width: 1862,
    height: 45000,
    total: 2,
    sealed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    extra: 'should-be-dropped',
    segments: [
      { index: 0, offset: 0, bytes: 1000, hash: 'aaaa', width: 1862, height: 40000, dataUrl: 'x'.repeat(500) },
      { index: 1, offset: 40000, bytes: 1000, hash: 'bbbb', width: 1862, height: 5000, debug: { huge: 'y'.repeat(500) } },
    ],
  };
  const compacted = compactManifest(manifest);
  assert.equal(compacted.segments, 2);
  assert.equal(compacted.manifest.captureId, 'cap-1');
  assert.equal(compacted.manifest.extra, undefined);
  assert.deepEqual(Object.keys(compacted.manifest.segments[0]).sort(), ['bytes', 'hash', 'height', 'index', 'offset', 'width']);
  assert.ok(compacted.savedBytes > 0);
  assert.equal(compacted.compacted, true);
  assert.equal(compactManifest(null).manifest, null);
  assert.equal(compactManifest({}).segments, 0);
});

test('estimateManifestBytes：固定开销 + 每段开销', () => {
  assert.equal(estimateManifestBytes(0), COMPRESS_DEFAULTS.manifestFixedBytes);
  assert.ok(estimateManifestBytes(10) > estimateManifestBytes(1));
  assert.equal(estimateManifestBytes(3, { fixedBytes: 10, perSegmentBytes: 20 }), 70);
});

test('planCompressionStorage：压缩结论 + 配额决策联动 capture-storage-budget', () => {
  const plan = planLongshotCompression([
    { index: 0, width: 800, height: 200, bytes: 100_000, hash: 'aa' },
  ], {});
  const combined = planCompressionStorage(plan, {
    usedBytes: 0,
    captures: [],
    quotaBytes: 512 * 1024 * 1024,
  });
  assert.equal(combined.ok, true);
  assert.equal(combined.incomingBytes, plan.totalBytes);
  assert.equal(combined.storage.action, 'accept');
  assert.match(combined.storageWire.text, /存储预算/);
  const rejected = planCompressionStorage({ action: 'reject', totalBytes: 10 }, { quotaBytes: 1024 });
  assert.equal(rejected.ok, false);
});

test('compressionWire/describeCompression：列表截断、文本与计数', () => {
  const plan = planLongshotCompression([
    { index: 0, width: 800, height: 200, bytes: 100_000, hash: 'aa' },
    { index: 1, width: 800, height: 200, bytes: 100_000, hash: 'aa' },
  ], {});
  const wire = compressionWire(plan, { maxListed: 1 });
  assert.equal(wire.version, LONGSHOT_COMPRESS_VERSION);
  assert.equal(wire.frames, 2);
  assert.equal(wire.uniqueFrames, 1);
  assert.equal(wire.framesPreview.length, 1);
  assert.equal(wire.duplicates.length, 1);
  assert.match(wire.text, /长截图压缩/);
  assert.match(describeCompression(plan), /去重省/);
  assert.equal(compressionWire(null).action, 'fits');
  assert.match(describeCompression(null), /无/);
});
