import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARD_DEFAULTS,
  SHARD_STATE_LIST,
  SHARD_VERSION,
  describeShards,
  locateShard,
  mergeShards,
  missingShardSegments,
  normalizeShardSegment,
  parseShardIndex,
  planShards,
  pruneShaderPlan,
  shardDigest,
  shardIndexWire,
  shardSignature,
  validateShards,
} from '../../extension/src/lib/longshot-shard.js';

function manifestOf(count, extra = {}) {
  return {
    version: 1,
    captureId: 'cap-1',
    url: 'https://example.com/long',
    dpr: 1.5,
    width: 1862,
    height: 33750,
    total: count,
    sealed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    segments: Array.from({ length: count }, (_, index) => ({
      index,
      offset: index * 750,
      bytes: 1000 + index,
      hash: ('abcdef' + index.toString(16)).padEnd(16, '0'),
      width: 1862,
      height: 750,
    })),
    ...extra,
  };
}

test('planShards：按段数上限切片，片内序号连续且首尾相接', () => {
  const plan = planShards(manifestOf(30), { maxSegmentsPerShard: 8 });
  assert.equal(plan.ok, true);
  assert.equal(plan.version, SHARD_VERSION);
  assert.equal(plan.shards.length, 4);
  assert.deepEqual(plan.shards.map((shard) => [shard.from, shard.to]), [[0, 7], [8, 15], [16, 23], [24, 29]]);
  assert.ok(plan.shards.every((shard) => shard.contiguous === true));
  assert.ok(plan.shards.every((shard) => shard.complete === true));
  assert.equal(plan.coveredSegments, 30);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.totalBytes, plan.shards.reduce((sum, shard) => sum + shard.bytes, 0));
  assert.equal(typeof plan.shards[0].digest, 'string');
  assert.equal(plan.shards[0].digest.length, 16);
});

test('planShards：按字节上限切片（单片至少一段，超大片不会无限切）', () => {
  // minBytesPerShard 是 64KB 下限，所以每段 50KB 才能观察到字节切分。
  const segments = Array.from({ length: 10 }, (_, index) => ({
    index,
    offset: index * 750,
    bytes: 50 * 1024,
    hash: ('abcdef' + index.toString(16)).padEnd(16, '0'),
    width: 1862,
    height: 750,
  }));
  const plan = planShards({ ...manifestOf(10), segments }, { maxSegmentsPerShard: 99, maxBytesPerShard: 128 * 1024 });
  assert.ok(plan.shards.length >= 3, JSON.stringify(plan.shards.map((shard) => shard.bytes)));
  assert.ok(plan.shards.every((shard) => shard.segmentCount >= 1 && shard.bytes <= 128 * 1024));
  const huge = planShards({
    ...manifestOf(2),
    total: 2,
    segments: [
      { index: 0, offset: 0, bytes: 999_999_999, hash: 'aaaaaaaaaaaa', width: 1, height: 1 },
      { index: 1, offset: 1, bytes: 999_999_999, hash: 'bbbbbbbbbbbb', width: 1, height: 1 },
    ],
  }, { maxBytesPerShard: SHARD_DEFAULTS.minBytesPerShard });
  assert.equal(huge.shards.length, 2);
});

test('planShards：manifest 缺段 → missing 与 shard.complete=false', () => {
  const manifest = manifestOf(6);
  manifest.segments = manifest.segments.filter((segment) => segment.index !== 2);
  const plan = planShards(manifest, { maxSegmentsPerShard: 2 });
  assert.deepEqual(plan.missing, [2]);
  assert.ok(plan.shards.some((shard) => shard.complete === false));
  assert.ok(plan.notes.some((note) => note.includes('缺 1 段')));
});

test('planShards：分片数上限截断并说明；空 manifest 安全', () => {
  const plan = planShards(manifestOf(40), { maxSegmentsPerShard: 1, maxShards: 3 });
  assert.equal(plan.shards.length, 3);
  assert.equal(plan.coveredSegments, 3);
  assert.equal(plan.manifestSegments, 40);
  assert.ok(plan.notes.some((note) => note.includes('上限')));
  const empty = planShards(null);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.shards, []);
  assert.equal(empty.notes[0], 'manifest 缺失');
});

test('planShards：已封版 → 分片 state=sealed', () => {
  const plan = planShards(manifestOf(4, { sealed: true }), { maxSegmentsPerShard: 2 });
  assert.equal(plan.sealed, true);
  assert.ok(plan.shards.every((shard) => shard.state === 'sealed'));
  assert.deepEqual(SHARD_STATE_LIST, ['partial', 'sealed', 'stale']);
});

test('shardDigest：确定性且对字段变化敏感', () => {
  const entries = [normalizeShardSegment({ index: 0, offset: 0, bytes: 10, hash: 'aa', width: 1, height: 1 }, 0)];
  assert.equal(shardDigest(entries), shardDigest([{ ...entries[0] }]));
  assert.notEqual(shardDigest(entries), shardDigest([{ ...entries[0], bytes: 11 }]));
  assert.notEqual(shardDigest(entries), shardDigest([{ ...entries[0], index: 1 }]));
  assert.equal(shardDigest([]), '');
  assert.equal(shardDigest(null), '');
});

test('validateShards：合法分片通过；篡改摘要/重叠/缺口被抓住', () => {
  const plan = planShards(manifestOf(9), { maxSegmentsPerShard: 3 });
  const ok = validateShards(plan.shards, manifestOf(9));
  assert.equal(ok.ok, true);
  assert.equal(ok.covered, 9);
  assert.equal(ok.errors.length, 0);

  const tampered = plan.shards.map((shard, index) => (index === 0 ? { ...shard, digest: 'deadbeefdeadbeef' } : shard));
  const bad = validateShards(tampered, manifestOf(9));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.code === 'digest'));

  // 去掉中间一片：与上一片之间出现缺口
  const gapped = [plan.shards[0], plan.shards[2]];
  const gap = validateShards(gapped, manifestOf(9));
  assert.ok(gap.errors.some((error) => error.code === 'gap'));
  assert.deepEqual(gap.missing, [3, 4, 5]);
});

test('validateShards：非数组与坏分片结构', () => {
  const notArray = validateShards('x', null);
  assert.equal(notArray.ok, false);
  assert.equal(notArray.errors[0].code, 'not-array');
  const bad = validateShards([null, { from: 5, to: 3, segments: [] }], { total: 6, sealed: false });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => error.code === 'bad-shard'));
  assert.ok(bad.errors.some((error) => error.code === 'bad-range'));
});

test('validateShards：已封版 manifest 缺段 → missing 证据', () => {
  const manifest = manifestOf(4, { sealed: true });
  manifest.segments = manifest.segments.slice(0, 3);
  const plan = planShards(manifest, { maxSegmentsPerShard: 2 });
  const result = validateShards(plan.shards, manifest);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [3]);
  assert.ok(result.errors.some((error) => error.code === 'missing'));
});

test('mergeShards：还原有序 segments；重复段以先出现者为准', () => {
  const plan = planShards(manifestOf(6), { maxSegmentsPerShard: 3 });
  const merged = mergeShards(plan.shards);
  assert.equal(merged.ok, true);
  assert.equal(merged.count, 6);
  assert.deepEqual(merged.segments.map((segment) => segment.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(merged.bytes, plan.totalBytes);
  const withDup = mergeShards([plan.shards[0], plan.shards[0]]);
  assert.deepEqual(withDup.duplicates, [0, 1, 2]);
  assert.equal(withDup.count, 3);
  assert.equal(mergeShards(null).ok, false);
});

test('locateShard / missingShardSegments：定位与缺口', () => {
  const plan = planShards(manifestOf(6), { maxSegmentsPerShard: 3 });
  assert.equal(locateShard(plan.shards, 4).index, 1);
  assert.equal(locateShard(plan.shards, 4).offset, 1);
  assert.equal(locateShard(plan.shards, 99), null);
  assert.deepEqual(missingShardSegments([plan.shards[0]], 6), [3, 4, 5]);
  assert.deepEqual(missingShardSegments(plan.shards, 6), []);
  assert.deepEqual(missingShardSegments([], 2), [0, 1]);
});

test('shardIndexWire / parseShardIndex：index.json 等价物往返', () => {
  const plan = planShards(manifestOf(6), { maxSegmentsPerShard: 3 });
  const wire = shardIndexWire(plan);
  assert.equal(wire.version, SHARD_VERSION);
  assert.equal(wire.captureId, 'cap-1');
  assert.equal(wire.shardCount, 2);
  assert.equal(wire.covered, 6);
  assert.equal(wire.sealed, false);
  assert.equal(wire.shards[0].segments, 3);
  const parsed = parseShardIndex(wire);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.index.shardCount, 2);
  const asJson = parseShardIndex(JSON.stringify(wire));
  assert.equal(asJson.ok, true);
});

test('parseShardIndex：坏 JSON/版本/摘要/封版要求', () => {
  assert.equal(parseShardIndex('{bad').ok, false);
  assert.equal(parseShardIndex('{bad').errors[0].code, 'json');
  assert.equal(parseShardIndex(null).ok, false);
  assert.equal(parseShardIndex({ version: 99, shards: [] }).errors[0].code, 'version');
  const plan = planShards(manifestOf(2), { maxSegmentsPerShard: 1 });
  const wire = shardIndexWire(plan);
  const tampered = { ...wire, shards: wire.shards.map((shard, index) => (index === 0 ? { ...shard, digest: 'ffffffffffffffff' } : shard)) };
  const parsed = parseShardIndex(tampered);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((error) => error.code === 'index-sha'));
  const requireSealed = parseShardIndex(wire, { requireSealed: true });
  assert.ok(requireSealed.errors.some((error) => error.code === 'unsealed'));
});

test('pruneShaderPlan：按数量/字节保留最新分片', () => {
  const plan = planShards(manifestOf(20), { maxSegmentsPerShard: 2 });
  const pruned = pruneShaderPlan(plan, { maxShards: 3 });
  assert.equal(pruned.shards.length, 3);
  assert.ok(pruned.pruned.length > 0);
  assert.ok(pruned.pruned.every((item) => item.reason === 'max-shards' || item.reason === 'max-bytes'));
  const tinyBytes = pruneShaderPlan(plan, { maxBytes: 1500 });
  assert.ok(tinyBytes.pruned.some((item) => item.reason === 'max-bytes'));
  assert.ok(tinyBytes.bytes <= 1500);
});

test('describeShards / shardSignature：日志与签名', () => {
  const plan = planShards(manifestOf(6), { maxSegmentsPerShard: 3 });
  assert.match(describeShards(plan), /^分片 2 片 \/ 6 段 \/ 0\.0MB \/ partial$/);
  assert.match(shardSignature(plan), /^shards:2:0-2#/);
  assert.equal(describeShards(null), '分片索引 空');
  assert.equal(shardSignature(null), 'shards:none');
});

test('默认常量：段数/字节/分片上限', () => {
  assert.equal(SHARD_DEFAULTS.maxSegmentsPerShard, 16);
  assert.equal(SHARD_DEFAULTS.maxBytesPerShard, 32 * 1024 * 1024);
  assert.equal(SHARD_DEFAULTS.maxShards, 64);
});
