import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LONGSHOT_MANIFEST_VERSION,
  LONGSHOT_MANIFEST_TTL_MS,
  hashLongshotBytes,
  buildLongshotManifest,
  appendSegment,
  sealManifest,
  validateManifest,
  missingSegmentIndexes,
  verifyLongshotSegment,
  resumeLongshotManifest,
  pruneLongshotManifests,
  parseLongshotManifest,
  manifestSummary,
  describeManifest,
} from '../../extension/src/lib/longshot-manifest.js';

const NOW = 1_700_000_000_000;
const H0 = hashLongshotBytes('seg0');
const H1 = hashLongshotBytes('seg1');

function fullManifest(overrides = {}) {
  return buildLongshotManifest({
    captureId: 'cap-1',
    tabId: 7,
    url: 'https://example.test/long',
    dpr: 1.5,
    width: 1862,
    height: 22500,
    total: 2,
    now: NOW,
    segments: [
      { index: 0, offset: 0, bytes: 10, hash: H0, width: 1862, height: 22500 },
    ],
    ...overrides,
  });
}

test('hashLongshotBytes：确定性、差异性与多输入类型', () => {
  assert.equal(hashLongshotBytes('abc'), '1a47e90b0b885c8b');
  assert.equal(hashLongshotBytes('abc'), hashLongshotBytes('abc'));
  assert.equal(hashLongshotBytes(new Uint8Array(0)), '811c9dc500001505');
  assert.notEqual(hashLongshotBytes('abc'), hashLongshotBytes('abd'));
  const bytes = new TextEncoder().encode('abc');
  assert.equal(hashLongshotBytes(bytes), hashLongshotBytes(bytes.buffer));
  assert.equal(hashLongshotBytes(bytes), hashLongshotBytes('abc'));
  assert.equal(hashLongshotBytes(null), '');
  assert.equal(hashLongshotBytes(42), '');
  assert.match(hashLongshotBytes('x'), /^[0-9a-f]{16}$/);
});

test('buildLongshotManifest：结构为 index.json 等价物', () => {
  const manifest = fullManifest();
  assert.equal(manifest.version, LONGSHOT_MANIFEST_VERSION);
  assert.equal(manifest.captureId, 'cap-1');
  assert.equal(manifest.tabId, 7);
  assert.equal(manifest.dpr, 1.5);
  assert.equal(manifest.width, 1862);
  assert.equal(manifest.height, 22500);
  assert.equal(manifest.total, 2);
  assert.equal(manifest.sealed, false);
  assert.equal(manifest.sealedAt, null);
  assert.equal(manifest.createdAt, new Date(NOW).toISOString());
  assert.equal(manifest.segments.length, 1);
  assert.deepEqual(manifest.segments[0], { index: 0, offset: 0, bytes: 10, hash: H0, width: 1862, height: 22500 });
  assert.throws(() => buildLongshotManifest({}), /captureId/);
});

test('buildLongshotManifest：total 从未知时由分片推断，分片按 index 排序', () => {
  const manifest = buildLongshotManifest({
    captureId: 'c',
    dpr: 1,
    width: 100,
    height: 1000,
    segments: [
      { index: 2, offset: 800, bytes: 3, hash: H1, width: 100, height: 200 },
      { index: 0, offset: 0, bytes: 1, hash: H0, width: 100, height: 600 },
    ],
  });
  assert.equal(manifest.total, 3);
  assert.deepEqual(manifest.segments.map((segment) => segment.index), [0, 2]);
});

test('appendSegment：不可变、同 index 覆盖、total 扩充', () => {
  const base = fullManifest();
  const appended = appendSegment(base, { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 });
  assert.equal(base.segments.length, 1, 'appendSegment 不能修改入参');
  assert.equal(appended.segments.length, 2);
  assert.equal(appended.total, 2);
  assert.deepEqual(appended.segments.map((segment) => segment.index), [0, 1]);
  const replaced = appendSegment(appended, { index: 0, offset: 0, bytes: 11, hash: hashLongshotBytes('new'), width: 1862, height: 22500 });
  assert.equal(replaced.segments.length, 2);
  assert.equal(replaced.segments[0].bytes, 11);
  const extended = appendSegment(appended, { index: 5, offset: 30000, bytes: 1, hash: H1 });
  assert.equal(extended.total, 6);
  assert.equal(extended.segments.length, 3);
});

test('sealManifest：分片不齐拒绝封版，齐了才能 sealed 并带 hashVerified', () => {
  const base = fullManifest();
  assert.throws(() => sealManifest(base, { now: NOW }), /不能封版/);
  const complete = appendSegment(base, { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 });
  const sealed = sealManifest(complete, { now: NOW + 500, hashVerified: true });
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.sealedAt, new Date(NOW + 500).toISOString());
  assert.equal(sealed.hashVerified, true);
  assert.equal(sealed.updatedAt, new Date(NOW + 500).toISOString());
  assert.equal(validateManifest(sealed).ok, true);
  assert.throws(() => sealManifest(null), /manifest/);
});

test('validateManifest：结构错误逐项报出', () => {
  const base = fullManifest();
  const cases = [
    [{ ...base, version: 9 }, 'version'],
    [{ ...base, captureId: '' }, 'captureId'],
    [{ ...base, dpr: 0.5 }, 'dpr'],
    [{ ...base, width: 0 }, 'width'],
    [{ ...base, height: -1 }, 'height'],
    [{ ...base, total: -1 }, 'total'],
    [{ ...base, createdAt: 'not-a-date' }, 'createdAt'],
    [{ ...base, sealed: 'yes' }, 'sealed'],
    [{ ...base, segments: 'x' }, 'segments'],
    [{ ...base, segments: [{ index: 0, offset: 0, bytes: 1, hash: 'zz', width: 10, height: 10 }] }, 'segment-hash'],
    [{ ...base, segments: [{ index: 0, offset: 0, bytes: 1, hash: H0, width: 10, height: 10 }, { index: 0, offset: 10, bytes: 1, hash: H0, width: 10, height: 10 }] }, 'segment-duplicate'],
    [{ ...base, total: 1, segments: [{ index: 3, offset: 0, bytes: 1, hash: H0, width: 10, height: 10 }] }, 'segment-overflow'],
  ];
  for (const [manifest, code] of cases) {
    const result = validateManifest(manifest);
    assert.equal(result.ok, false, '应失败：' + code);
    assert.ok(result.errors.some((error) => error.code === code), '缺少错误码 ' + code + '：' + JSON.stringify(result.errors));
  }
  assert.equal(validateManifest(null).errors[0].code, 'not-object');
  const notSealed = validateManifest(fullManifest(), { requireSealed: true });
  assert.ok(notSealed.errors.some((error) => error.code === 'not-sealed'));
});

test('validateManifest：sealed 必须段齐、hash 齐全、序号连续', () => {
  const base = fullManifest();
  const fakeSealed = { ...base, sealed: true, total: 2 };
  const result = validateManifest(fakeSealed);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'sealed-incomplete'));
  assert.ok(result.errors.some((error) => error.code === 'sealed-missing'));
  const noHash = {
    ...base,
    sealed: true,
    segments: [{ index: 0, offset: 0, bytes: 1, hash: '', width: 10, height: 10 }, { index: 1, offset: 10, bytes: 1, hash: '', width: 10, height: 10 }],
  };
  assert.ok(validateManifest(noHash).errors.some((error) => error.code === 'segment-hash'));
});

test('validateManifest：不连续 offset 只给 warning（允许重叠区）', () => {
  const manifest = buildLongshotManifest({
    captureId: 'c',
    dpr: 1,
    width: 100,
    height: 1000,
    total: 2,
    segments: [
      { index: 0, offset: 0, bytes: 1, hash: H0, width: 100, height: 600 },
      { index: 1, offset: 550, bytes: 1, hash: H1, width: 100, height: 450 },
    ],
  });
  const result = validateManifest(manifest);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === 'overlap'));
});

test('missingSegmentIndexes：未拍段/空 manifest', () => {
  assert.deepEqual(missingSegmentIndexes(fullManifest()), [1]);
  assert.deepEqual(missingSegmentIndexes(null), []);
  const sealedComplete = sealManifest(
    appendSegment(fullManifest(), { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 }),
    { now: NOW },
  );
  assert.deepEqual(missingSegmentIndexes(sealedComplete), []);
});

test('verifyLongshotSegment：匹配/缺失/字节不一致/hash 不一致/index 不一致/无 hash', () => {
  const expected = { index: 0, bytes: 10, hash: H0 };
  assert.deepEqual(verifyLongshotSegment(expected, { index: 0, bytes: 10, hash: H0 }), {
    ok: true,
    verified: true,
    reason: null,
    expected: { index: 0, bytes: 10, hash: H0 },
    actual: { index: 0, bytes: 10, hash: H0 },
  });
  assert.equal(verifyLongshotSegment(expected, null).reason, 'missing');
  assert.equal(verifyLongshotSegment(expected, null).ok, false);
  assert.equal(verifyLongshotSegment(expected, { index: 0, bytes: 11, hash: H0 }).reason, 'bytes-mismatch');
  assert.equal(verifyLongshotSegment(expected, { index: 0, bytes: 10, hash: H1 }).reason, 'hash-mismatch');
  assert.equal(verifyLongshotSegment(expected, { index: 1, bytes: 10, hash: H0 }).reason, 'index-mismatch');
  const noHash = verifyLongshotSegment({ index: 0, bytes: 10, hash: '' }, { index: 0, bytes: 10, hash: H0 });
  assert.equal(noHash.ok, true);
  assert.equal(noHash.verified, false);
  assert.equal(noHash.reason, 'hash-unrecorded');
});

test('resumeLongshotManifest：无 manifest/非法 manifest 不恢复', () => {
  assert.equal(resumeLongshotManifest(null).ok, false);
  assert.equal(resumeLongshotManifest(null).reason, 'no-manifest');
  const invalid = resumeLongshotManifest({ ...fullManifest(), version: 9 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-manifest');
  assert.ok(Array.isArray(invalid.errors) && invalid.errors.length > 0);
});

test('resumeLongshotManifest：已封版且分片 hash 一致 → action=sealed', () => {
  const sealed = sealManifest(
    appendSegment(fullManifest(), { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 }),
    { now: NOW },
  );
  const resume = resumeLongshotManifest(sealed, {
    available: [
      { index: 0, bytes: 10, hash: H0 },
      { index: 1, bytes: 20, hash: H1 },
    ],
    now: NOW + 1000,
  });
  assert.equal(resume.action, 'sealed');
  assert.equal(resume.sealed, true);
  assert.equal(resume.complete, true);
  assert.equal(resume.resumable, false, 'sealed 无需恢复');
  assert.equal(resume.reuse.length, 2);
  assert.deepEqual(resume.refetch, []);
  assert.deepEqual(resume.evidence, { now: NOW + 1000, ttlMs: LONGSHOT_MANIFEST_TTL_MS, checked: 2, available: 2 });
});

test('resumeLongshotManifest：未封版全部可复用 → action=reuse/resumable', () => {
  const manifest = appendSegment(fullManifest(), { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 });
  const resume = resumeLongshotManifest(manifest, {
    available: [
      { index: 0, bytes: 10, hash: H0 },
      { index: 1, bytes: 20, hash: H1 },
    ],
    now: NOW + 1000,
  });
  assert.equal(resume.action, 'reuse');
  assert.equal(resume.resumable, true);
  assert.equal(resume.complete, true);
  assert.equal(resume.reuse.length, 2);
  assert.equal(resume.nextIndex, 2);
});

test('resumeLongshotManifest：缺段/hash 不一致 → refetch 列表带原因', () => {
  const unsealed = fullManifest({ total: 3 });
  const resume = resumeLongshotManifest(unsealed, {
    available: [{ index: 0, bytes: 10, hash: H0 }],
    now: NOW + 1000,
  });
  assert.equal(resume.action, 'refetch');
  assert.equal(resume.resumable, false);
  assert.deepEqual(resume.missing, [1, 2]);
  assert.deepEqual(resume.refetch.map((item) => item.index), [1, 2]);
  assert.ok(resume.refetch.every((item) => item.reason === 'missing'));
  assert.equal(resume.nextIndex, 1);
  const mismatch = resumeLongshotManifest(fullManifest(), {
    available: [{ index: 0, bytes: 10, hash: H1 }],
    now: NOW + 1000,
  });
  assert.equal(mismatch.action, 'refetch');
  assert.equal(mismatch.refetch[0].reason, 'hash-mismatch');
  assert.equal(mismatch.refetch[0].expected.hash, H0);
  assert.equal(mismatch.refetch[0].actual.hash, H1);
  assert.equal(mismatch.resumable, false);
});

test('resumeLongshotManifest：过期未封版 → action=expired', () => {
  const resume = resumeLongshotManifest(fullManifest(), {
    available: [{ index: 0, bytes: 10, hash: H0 }],
    now: NOW + LONGSHOT_MANIFEST_TTL_MS + 1,
  });
  assert.equal(resume.expired, true);
  assert.equal(resume.action, 'expired');
  assert.equal(resume.resumable, false);
  const custom = resumeLongshotManifest(fullManifest(), { available: [], now: NOW + 50, ttlMs: 10 });
  assert.equal(custom.expired, true);
  assert.equal(custom.evidence.ttlMs, 10);
});

test('resumeLongshotManifest：孤儿分片（磁盘有、索引没有）单独列出', () => {
  const resume = resumeLongshotManifest(fullManifest(), {
    available: [
      { index: 0, bytes: 10, hash: H0 },
      { index: 9, bytes: 10, hash: H1 },
    ],
    now: NOW + 1000,
  });
  assert.deepEqual(resume.orphan, [9]);
});

test('pruneLongshotManifests：TTL 清理未封版/已封版、keep 保留、max 上限', () => {
  const old = buildLongshotManifest({ captureId: 'old', dpr: 1, width: 10, height: 10, total: 1, now: NOW - 1000 });
  const fresh = buildLongshotManifest({ captureId: 'fresh', dpr: 1, width: 10, height: 10, total: 1, now: NOW });
  const sealedOld = sealManifest(
    buildLongshotManifest({ captureId: 'sealed-old', dpr: 1, width: 10, height: 10, total: 0, now: NOW - 1000 }),
    { now: NOW - 1000 },
  );
  const pruned = pruneLongshotManifests([old, fresh], { now: NOW, ttlMs: 100 });
  assert.equal(pruned.removedCount, 1);
  assert.deepEqual(pruned.pruned.map((item) => item.captureId), ['old']);
  assert.deepEqual(pruned.pruned.map((item) => item.reason), ['expired-unsealed']);
  assert.deepEqual(pruned.kept.map((item) => item.captureId), ['fresh']);
  const kept = pruneLongshotManifests([old, fresh], { now: NOW, ttlMs: 100, keep: ['old'] });
  assert.deepEqual(kept.kept.map((item) => item.captureId).sort(), ['fresh', 'old']);
  assert.equal(kept.removedCount, 0);
  const sealedPruned = pruneLongshotManifests([sealedOld], { now: NOW, ttlMs: 10_000, sealedTtlMs: 100 });
  assert.deepEqual(sealedPruned.pruned.map((item) => item.reason), ['expired-sealed']);
  const capped = pruneLongshotManifests(
    [
      buildLongshotManifest({ captureId: 'a', dpr: 1, width: 10, height: 10, now: NOW - 300 }),
      buildLongshotManifest({ captureId: 'b', dpr: 1, width: 10, height: 10, now: NOW - 200 }),
      buildLongshotManifest({ captureId: 'c', dpr: 1, width: 10, height: 10, now: NOW - 100 }),
    ],
    { now: NOW, max: 2 },
  );
  assert.deepEqual(capped.kept.map((item) => item.captureId), ['c', 'b']);
  assert.deepEqual(capped.pruned.map((item) => ({ captureId: item.captureId, reason: item.reason })), [{ captureId: 'a', reason: 'max' }]);
  assert.deepEqual(pruneLongshotManifests(null, {}).kept, []);
  assert.equal(pruneLongshotManifests([null, { createdAt: new Date().toISOString() }], { now: NOW }).removedCount, 0);
});

test('parseLongshotManifest：JSON 字符串/对象/坏 JSON', () => {
  const sealed = sealManifest(
    appendSegment(fullManifest(), { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 }),
    { now: NOW },
  );
  const parsed = parseLongshotManifest(JSON.stringify(sealed));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.captureId, 'cap-1');
  assert.equal(parseLongshotManifest(sealed).ok, true);
  const broken = parseLongshotManifest('{oops');
  assert.equal(broken.ok, false);
  assert.equal(broken.errors[0].code, 'json');
  const invalid = parseLongshotManifest({ version: 3 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.manifest, null);
});

test('manifestSummary/describeManifest：字节与封版状态汇总', () => {
  const sealed = sealManifest(
    appendSegment(fullManifest(), { index: 1, offset: 22500, bytes: 20, hash: H1, width: 1862, height: 100 }),
    { now: NOW },
  );
  const summary = manifestSummary(sealed);
  assert.equal(summary.version, 1);
  assert.equal(summary.captureId, 'cap-1');
  assert.equal(summary.total, 2);
  assert.equal(summary.captured, 2);
  assert.equal(summary.sealed, true);
  assert.equal(summary.bytes, 30);
  assert.equal(summary.hashCount, 2);
  assert.equal(manifestSummary(null), null);
  assert.match(describeManifest(sealed), /2\/2 段 sealed/);
  assert.equal(describeManifest(null), '无 manifest');
});
