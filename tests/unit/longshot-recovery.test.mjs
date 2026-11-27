import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecoveryTiles,
  planLongshotRecovery,
  applyRecoveryVerification,
  buildRecoveryResult,
  describeRecovery,
} from '../../extension/src/lib/longshot-recovery.js';
import { buildLongshotManifest, appendSegment, sealManifest, hashLongshotBytes } from '../../extension/src/lib/longshot-manifest.js';

const NOW = 1_700_000_000_000;
const H0 = hashLongshotBytes('tile-0');
const H1 = hashLongshotBytes('tile-1');

function tile(index, overrides = {}) {
  return { index, x: 0, y: index * 1000, drawY: index * 1000, width: 100, height: 1000, bytes: 10 + index, hash: index === 0 ? H0 : H1, at: NOW, ...overrides };
}

function manifestWith(segments, overrides = {}) {
  return buildLongshotManifest({
    captureId: 'cap-r',
    tabId: 5,
    dpr: 1,
    width: 100,
    height: segments.length * 1000,
    total: segments.length,
    now: NOW,
    segments,
    ...overrides,
  });
}

test('normalizeRecoveryTiles：排序、去重保留更晚写入、丢弃非法记录', () => {
  const normalized = normalizeRecoveryTiles([
    tile(2, { at: 10 }),
    null,
    tile(0),
    { index: -1, width: 10, height: 10, blob: {} },
    { index: 3, width: 0, height: 10, blob: {} },
    { index: 4, width: 10, height: 10 },
    tile(2, { at: 99, bytes: 999 }),
  ]);
  assert.deepEqual(normalized.tiles.map((item) => item.index), [0, 2]);
  assert.deepEqual(normalized.duplicates, [2]);
  assert.equal(normalized.reordered, true);
  assert.deepEqual(normalized.invalid.map((item) => item.reason).sort(), ['bad-index', 'bad-size', 'no-bytes', 'not-object']);
  assert.equal(normalized.tiles[1].bytes, 999, '同 index 保留更晚写入的记录');
  assert.equal(normalizeRecoveryTiles(null).tiles.length, 0);
});

test('planLongshotRecovery：没有分片返回 E_NOT_FOUND', () => {
  const plan = planLongshotRecovery({ tiles: [] });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'E_NOT_FOUND');
  assert.equal(plan.tiles, 0);
  assert.equal(plan.action, 'nothing');
});

test('planLongshotRecovery：无 manifest 时保持旧 gaps 语义（位置缺口）', () => {
  const plan = planLongshotRecovery({ tiles: [tile(0), tile(2)] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.present, [0, 2]);
  assert.deepEqual(plan.gaps, [1]);
  assert.deepEqual(plan.missing, [1]);
  assert.equal(plan.complete, false);
  assert.equal(plan.action, 'rebuild-partial');
  assert.equal(plan.recovered, true);
  assert.equal(plan.sealed, false);
  assert.equal(plan.width, 100);
  assert.equal(plan.height, 3000);
  assert.deepEqual(plan.segments.map((segment) => segment.offset), [0, 2000]);
});

test('planLongshotRecovery：manifest 已封版且段齐 → already-sealed/complete', () => {
  const manifest = sealManifest(manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
    { index: 1, offset: 1000, bytes: 11, hash: H1, width: 100, height: 1000 },
  ]), { now: NOW });
  const plan = planLongshotRecovery({ manifest, tiles: [tile(0), tile(1)] });
  assert.equal(plan.sealed, true);
  assert.equal(plan.recovered, false);
  assert.equal(plan.complete, true);
  assert.equal(plan.action, 'already-sealed');
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.manifestSummary.captureId, 'cap-r');
});

test('planLongshotRecovery：未封版 manifest 缺段 → missing 来自 total', () => {
  const manifest = manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
    { index: 1, offset: 1000, bytes: 11, hash: H1, width: 100, height: 1000 },
  ], { total: 3 });
  const plan = planLongshotRecovery({ manifest, tiles: [tile(0), tile(1)] });
  assert.deepEqual(plan.missing, [2]);
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.complete, false);
  assert.equal(plan.action, 'rebuild-partial');
  assert.equal(plan.nextIndex, 2);
  assert.equal(plan.recovered, true);
});

test('applyRecoveryVerification：hash 全对 → hashVerified=true 且无 refetch', () => {
  const manifest = manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
    { index: 1, offset: 1000, bytes: 11, hash: H1, width: 100, height: 1000 },
  ]);
  const tiles = [tile(0), tile(1)];
  const plan = planLongshotRecovery({ manifest, tiles });
  const applied = applyRecoveryVerification(plan, { manifest, tiles });
  assert.equal(applied.verification.hashVerified, true);
  assert.equal(applied.verification.checked, 2);
  assert.deepEqual(applied.verification.mismatched, []);
  assert.deepEqual(applied.plan.refetch, []);
  assert.equal(applied.plan.segments.every((segment) => segment.verified === true), true);
  assert.equal(applied.plan.hashVerified, true);
});

test('applyRecoveryVerification：hash 不一致 → refetch hash-mismatch 且 complete=false', () => {
  const manifest = manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
    { index: 1, offset: 1000, bytes: 11, hash: H1, width: 100, height: 1000 },
  ]);
  const corrupted = [tile(0), tile(1, { hash: hashLongshotBytes('corrupted') })];
  const plan = planLongshotRecovery({ manifest, tiles: corrupted });
  const applied = applyRecoveryVerification(plan, { manifest, tiles: corrupted });
  assert.equal(applied.verification.hashVerified, false);
  assert.deepEqual(applied.verification.mismatched.map((item) => item.index), [1]);
  assert.equal(applied.verification.mismatched[0].reason, 'hash-mismatch');
  assert.deepEqual(applied.plan.refetch.map((item) => ({ index: item.index, reason: item.reason })), [{ index: 1, reason: 'hash-mismatch' }]);
  assert.equal(applied.plan.complete, false);
  assert.equal(applied.plan.segments[1].verified, false);
});

test('applyRecoveryVerification：缺失段进 refetch（reason=missing）', () => {
  const manifest = manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
    { index: 1, offset: 1000, bytes: 11, hash: H1, width: 100, height: 1000 },
  ], { total: 3 });
  const tiles = [tile(0)];
  const plan = planLongshotRecovery({ manifest, tiles });
  const applied = applyRecoveryVerification(plan, { manifest, tiles });
  assert.deepEqual(applied.plan.refetch.map((item) => ({ index: item.index, reason: item.reason })), [
    { index: 1, reason: 'missing' },
    { index: 2, reason: 'missing' },
  ]);
  assert.equal(applied.plan.hashVerified, true, '已存在的段校验通过，缺段只影响 complete');
  assert.equal(applied.plan.complete, false);
});

test('applyRecoveryVerification：无 manifest 时不算通过（hashVerified=null）', () => {
  const tiles = [tile(0)];
  const plan = planLongshotRecovery({ tiles });
  const applied = applyRecoveryVerification(plan, { tiles });
  assert.equal(applied.verification.hashVerified, null);
  assert.equal(applied.verification.reason, 'no-manifest');
  assert.equal(applied.plan, plan);
  const noPlan = applyRecoveryVerification(null, {});
  assert.equal(noPlan.verification.reason, 'no-plan');
});

test('buildRecoveryResult：兼容旧字段并带 recovered/sealed/manifest/recovery', () => {
  const manifest = manifestWith([
    { index: 0, offset: 0, bytes: 10, hash: H0, width: 100, height: 1000 },
  ]);
  const tiles = [tile(0)];
  const plan = planLongshotRecovery({ manifest, tiles });
  const applied = applyRecoveryVerification(plan, { manifest, tiles }).plan;
  const result = buildRecoveryResult({
    captureId: 'cap-r',
    plan: applied,
    width: 100,
    height: 1000,
    bytes: 4321,
    dataUrl: 'data:image/png;base64,AAA',
    gaps: [0],
  });
  assert.equal(result.ok, true);
  assert.equal(result.longshotId, 'cap-r');
  assert.equal(result.width, 100);
  assert.equal(result.height, 1000);
  assert.equal(result.tiles, 1);
  assert.equal(result.bytes, 4321);
  assert.equal(result.dataUrl, 'data:image/png;base64,AAA');
  assert.deepEqual(result.gaps, [0], '显式 gaps 优先');
  assert.equal(result.recovered, true);
  assert.equal(result.sealed, false);
  assert.equal(result.complete, true);
  assert.equal(result.manifest.captureId, 'cap-r');
  assert.equal(result.recovery.action, 'rebuild');
  assert.deepEqual(result.recovery.present, [0]);
  assert.equal(result.recovery.hashVerified, true);
  assert.equal(buildRecoveryResult({}).dataUrl, '');
});

test('describeRecovery：可恢复/不可恢复/hash 状态', () => {
  assert.equal(describeRecovery(null), '无恢复计划');
  assert.match(describeRecovery({ ok: false, error: '没有分块' }), /不可恢复：没有分块/);
  const plan = planLongshotRecovery({ tiles: [tile(0), tile(1)] });
  assert.match(describeRecovery(plan), /恢复 \?：2 块/);
  const verified = { ...plan, hashVerified: true };
  assert.match(describeRecovery(verified), /hash=ok/);
  const mismatched = { ...plan, hashVerified: false };
  assert.match(describeRecovery(mismatched), /hash=mismatch/);
});
