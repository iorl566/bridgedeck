// tests/unit/longshot-shard-recover.test.mjs
// 第十一批-E：长截图分片恢复强化（lib/longshot-shard-recover.js）。
// 覆盖：完整性扫描（missing/hash/torn/duplicate/extra/stale/sealed-mismatch）、残片打捞、
//       恢复决策（complete/recover-partial/rebuild/restart/nothing）、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARD_ACTIONS,
  SHARD_CODES,
  SHARD_RECOVERY_VERSION,
  describeShardRecovery,
  planShardRecovery,
  salvageShardIndex,
  scanShardIntegrity,
  shardRecoveryWire,
} from '../../extension/src/lib/longshot-shard-recover.js';

const H0 = 'aaaaaaaaaaaaaaaa';
const H1 = 'bbbbbbbbbbbbbbbb';
const H2 = 'cccccccccccccccc';

function manifest(segments, extra = {}) {
  return {
    version: 1,
    captureId: 'cap-1',
    total: segments.length,
    dpr: 1,
    width: 800,
    height: segments.reduce((sum, segment) => sum + Number(segment.height || 0), 0),
    sealed: false,
    updatedAt: new Date(1_000_000).toISOString(),
    segments,
    ...extra,
  };
}

function segments() {
  return [
    { index: 0, offset: 0, bytes: 100, hash: H0, width: 800, height: 100 },
    { index: 1, offset: 100, bytes: 100, hash: H1, width: 800, height: 100 },
    { index: 2, offset: 200, bytes: 100, hash: H2, width: 800, height: 100 },
  ];
}

function tiles() {
  return [
    { index: 0, bytes: 100, hash: H0, width: 800, height: 100, at: 999_000 },
    { index: 1, bytes: 100, hash: H1, width: 800, height: 100, at: 999_000 },
    { index: 2, bytes: 100, hash: H2, width: 800, height: 100, at: 999_000 },
  ];
}

test('常量：动作/问题码形状稳定', () => {
  assert.equal(SHARD_RECOVERY_VERSION, 1);
  assert.deepEqual([...SHARD_ACTIONS], ['complete', 'recover-partial', 'rebuild', 'restart', 'nothing']);
  for (const code of Object.values(SHARD_CODES)) assert.match(code, /^longshot\.shard\./);
});

test('scanShardIntegrity：全部完整 → ok，无 findings', () => {
  const scan = scanShardIntegrity(manifest(segments()), tiles(), { now: 1_000_001 });
  assert.equal(scan.ok, true);
  assert.equal(scan.total, 3);
  assert.deepEqual(scan.usable, [0, 1, 2]);
  assert.deepEqual(scan.findings, []);
  assert.deepEqual(scan.codes, [SHARD_CODES.OK]);
  assert.equal(scan.severity, 'none');
});

test('scanShardIntegrity：缺片/hash 不一致/半写 分别归因', () => {
  const scan = scanShardIntegrity(manifest(segments()), [
    { index: 0, bytes: 100, hash: H0, width: 800, height: 100 },
    { index: 1, bytes: 100, hash: H1, width: 800, height: 100 },
  ], { now: 1_000_001 });
  assert.equal(scan.ok, false);
  assert.equal(scan.total, 3);
  assert.ok(scan.findings.some((finding) => finding.code === SHARD_CODES.MISSING && finding.index === 2));
  assert.deepEqual(scan.usable, [0, 1]);
  const wrongHash = scanShardIntegrity(manifest(segments()), [
    { index: 0, bytes: 100, hash: 'ffffffffffffffff', width: 800, height: 100 },
  ], { now: 1_000_001 });
  assert.ok(wrongHash.findings.some((finding) => finding.code === SHARD_CODES.HASH_MISMATCH));
  const torn = scanShardIntegrity(manifest(segments()), [
    { index: 0, bytes: 10, hash: H0, width: 800, height: 100 },
  ], { now: 1_000_001 });
  assert.ok(torn.findings.some((finding) => finding.code === SHARD_CODES.TORN));
  assert.deepEqual(torn.usable, [], 'torn 的分片不可用');
  assert.ok(torn.findings.some((finding) => finding.code === SHARD_CODES.MISSING));
});

test('scanShardIntegrity：重复分片/多出来的旧段/旧分片 stale', () => {
  const scan = scanShardIntegrity(manifest(segments()), [
    ...tiles(),
    { index: 0, bytes: 100, hash: H0, width: 800, height: 100, at: 999_999 },
    { index: 9, bytes: 50, hash: 'dddddddddddddddd', width: 800, height: 100, at: 999_000 },
  ], { now: 1_000_001, staleMs: 1 });
  assert.ok(scan.findings.some((finding) => finding.code === SHARD_CODES.DUPLICATE && finding.index === 0));
  assert.ok(scan.findings.some((finding) => finding.code === SHARD_CODES.EXTRA && finding.index === 9));
  assert.ok(scan.findings.some((finding) => finding.code === SHARD_CODES.STALE));
  assert.equal(scan.ok, true, '重复/多余/stale 不翻转 ok');
  assert.equal(scan.severity, 'warn');
});

test('scanShardIntegrity：manifest 已封版但不完整 → sealed-mismatch', () => {
  const scan = scanShardIntegrity(manifest(segments(), { sealed: true }), [
    { index: 0, bytes: 100, hash: H0, width: 800, height: 100 },
  ], { now: 1_000_001 });
  assert.ok(scan.findings.some((finding) => finding.code === SHARD_CODES.SEALED_MISMATCH));
  assert.equal(scan.ok, false);
});

test('scanShardIntegrity：空输入稳定；非法 tile 进 invalid', () => {
  const empty = scanShardIntegrity(null, null);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.usable, []);
  const invalid = scanShardIntegrity({ total: 1, segments: [] }, [{ index: 0 }]);
  assert.ok(invalid.findings.some((finding) => finding.code === SHARD_CODES.INVALID));
});

test('salvageShardIndex：最长连续前缀与覆盖比例', () => {
  const salvage = salvageShardIndex({
    total: 4,
    usable: [0, 1, 3],
    findings: [],
  });
  assert.equal(salvage.prefix, 2);
  assert.deepEqual(salvage.missing, [2]);
  assert.equal(salvage.cursor, 2);
  assert.equal(salvage.complete, false);
  assert.equal(salvage.coverage, 0.75);
  const complete = salvageShardIndex({ total: 2, usable: [0, 1] });
  assert.equal(complete.complete, true);
  assert.equal(complete.prefix, 2);
  assert.equal(complete.coverage, 1);
  const empty = salvageShardIndex(null);
  assert.equal(empty.total, 0);
  assert.equal(empty.complete, false);
  const withBytes = salvageShardIndex({ total: 2, usable: [0, 1] }, {
    tiles: [{ index: 0, bytes: 10 }, { index: 1, bytes: 20 }, { index: 2, bytes: 30 }],
  });
  assert.equal(withBytes.usableBytes, 30);
});

test('planShardRecovery：完整 → complete；可打捞 → recover-partial/rebuild；全坏 → restart', () => {
  const complete = planShardRecovery({ manifest: manifest(segments()), tiles: tiles(), now: 1_000_001 });
  assert.equal(complete.action, 'complete');
  assert.equal(complete.ok, true);
  assert.deepEqual(complete.refetch, []);

  const partial = planShardRecovery({
    manifest: manifest(segments()),
    tiles: [tiles()[0]],
    now: 1_000_001,
  });
  assert.equal(partial.action, 'recover-partial');
  assert.equal(partial.prefix, 1);
  assert.deepEqual(partial.refetch.map((item) => item.index), [1, 2]);
  assert.ok(partial.reasons.some((reason) => /残片/.test(reason)));

  const sealed = planShardRecovery({
    manifest: manifest(segments(), { sealed: true }),
    tiles: [tiles()[0]],
    now: 1_000_001,
  });
  assert.equal(sealed.action, 'rebuild');

  const restart = planShardRecovery({
    manifest: manifest(segments()),
    tiles: [{ index: 0, bytes: 100, hash: 'ffffffffffffffff', width: 800, height: 100 }],
    now: 1_000_001,
  });
  assert.equal(restart.action, 'restart');
  assert.equal(restart.ok, false);
  assert.equal(restart.salvage.usableCount, 0);
});

test('planShardRecovery：nothing（无 manifest/无分片）、torn 重取原因', () => {
  const nothing = planShardRecovery({});
  assert.equal(nothing.action, 'nothing');
  assert.equal(nothing.ok, false);
  assert.deepEqual(planShardRecovery(null).refetch, []);
  const torn = planShardRecovery({
    manifest: manifest(segments()),
    tiles: [{ index: 0, bytes: 10, hash: H0, width: 800, height: 100 }],
    now: 1_000_001,
  });
  assert.equal(torn.refetch[0].reason, 'torn');
  assert.ok(torn.reasons.some((reason) => /半写/.test(reason)));
});

test('shardRecoveryWire/describeShardRecovery：截断列表、文本与计数', () => {
  const plan = planShardRecovery({
    manifest: manifest(segments()),
    tiles: [{ index: 0, bytes: 100, hash: H0, width: 800, height: 100 }],
    now: 1_000_001,
  });
  const wire = shardRecoveryWire(plan, { maxListed: 1 });
  assert.equal(wire.version, SHARD_RECOVERY_VERSION);
  assert.equal(wire.action, 'recover-partial');
  assert.equal(wire.usable, 1);
  assert.equal(wire.missing, 2);
  assert.equal(wire.findings.length, 1);
  assert.match(wire.text, /分片恢复/);
  assert.match(describeShardRecovery(plan), /可用 1\/3/);
  assert.equal(shardRecoveryWire(null).action, 'nothing');
  assert.match(describeShardRecovery(null), /无/);
});
