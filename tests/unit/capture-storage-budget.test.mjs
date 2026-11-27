// tests/unit/capture-storage-budget.test.mjs
// 第十一批-E：采集产物存储预算/配额/淘汰（lib/capture-storage-budget.js）。
// 覆盖：预算归一化、kind 归一、足迹估算、用量汇总、压力等级、份额、淘汰选择
//       （保护未封版/pinned/新鲜）、决策 accept/warn/evict/reject、wire/describe。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_ACTIONS,
  STORAGE_BUDGET_VERSION,
  STORAGE_CODES,
  STORAGE_DEFAULTS,
  STORAGE_PRESSURE,
  captureFootprint,
  classifyStoragePressure,
  describeStorageBudget,
  estimateStorageUsage,
  kindAllowance,
  normalizeStorageKind,
  planStorageBudget,
  resolveStorageBudget,
  selectEvictions,
  storageBudgetWire,
} from '../../extension/src/lib/capture-storage-budget.js';

const MB = 1024 * 1024;

function capture(id, bytes, extra = {}) {
  return { id, kind: 'longshot', bytes, sealed: true, at: 1000, ...extra };
}

test('常量：动作/压力/默认值形状稳定', () => {
  assert.equal(STORAGE_BUDGET_VERSION, 1);
  assert.deepEqual([...STORAGE_ACTIONS], ['accept', 'warn', 'evict', 'reject']);
  assert.deepEqual([...STORAGE_PRESSURE], ['ok', 'warn', 'critical', 'full']);
  assert.ok(STORAGE_DEFAULTS.quotaBytes > STORAGE_DEFAULTS.reserveBytes);
  assert.ok(STORAGE_DEFAULTS.warnRatio < STORAGE_DEFAULTS.criticalRatio);
  assert.match(STORAGE_CODES.EVICT, /^storage\./);
});

test('normalizeStorageKind：长截图/视频/其它', () => {
  assert.equal(normalizeStorageKind('longshot'), 'longshot');
  assert.equal(normalizeStorageKind('screenshot'), 'longshot');
  assert.equal(normalizeStorageKind('video'), 'video');
  assert.equal(normalizeStorageKind('recording'), 'video');
  assert.equal(normalizeStorageKind('whatever'), 'other');
  assert.equal(normalizeStorageKind(null), 'other');
});

test('resolveStorageBudget：默认/覆盖/份额归一/非法回落', () => {
  const defaults = resolveStorageBudget();
  assert.equal(defaults.quotaBytes, STORAGE_DEFAULTS.quotaBytes);
  assert.deepEqual(Object.keys(defaults.shares).sort(), ['longshot', 'other', 'video']);
  const shareSum = defaults.shares.longshot + defaults.shares.video + defaults.shares.other;
  assert.ok(Math.abs(shareSum - 1) < 1e-6);
  const custom = resolveStorageBudget({ quotaBytes: 100 * MB, shares: { longshot: 0.8 }, minKeep: 2 });
  assert.equal(custom.quotaBytes, 100 * MB);
  assert.equal(custom.minKeep, 2);
  const customSum = custom.shares.longshot + custom.shares.video + custom.shares.other;
  assert.ok(Math.abs(customSum - 1) < 1e-6);
  const bad = resolveStorageBudget({ quotaBytes: 0, warnRatio: 2, criticalRatio: -1, reserveBytes: NaN });
  assert.equal(bad.quotaBytes, STORAGE_DEFAULTS.quotaBytes);
  assert.equal(bad.warnRatio, 1);
  assert.ok(bad.criticalRatio >= bad.warnRatio);
  assert.equal(bad.reserveBytes, STORAGE_DEFAULTS.reserveBytes, 'NaN 回落默认预留');
});

test('captureFootprint：直接字节/分段估算/无数据', () => {
  const direct = captureFootprint({ id: 'a', kind: 'longshot', bytes: 1234, segments: 2, sealed: true });
  assert.equal(direct.bytes, 1234);
  assert.equal(direct.segments, 2);
  assert.equal(direct.estimated, false);
  const estimated = captureFootprint({ id: 'b', kind: 'video', segments: 3, averageBytes: 100 });
  assert.equal(estimated.bytes, 300);
  assert.equal(estimated.estimated, true);
  const fromTotal = captureFootprint({ captureId: 'c', kind: 'longshot', totalBytes: 5000 });
  assert.equal(fromTotal.id, 'c');
  assert.equal(fromTotal.bytes, 5000);
  const missing = captureFootprint(null);
  assert.deepEqual(missing, { id: '', kind: 'other', bytes: 0, segments: 0, sealed: false, pinned: false, at: 0, estimated: false });
  assert.equal(captureFootprint({ id: 'd', pinned: true, keep: true }).pinned, true);
});

test('classifyStoragePressure：ok/warn/critical/full', () => {
  const budget = resolveStorageBudget({ quotaBytes: 1000, warnRatio: 0.8, criticalRatio: 0.9 });
  assert.equal(classifyStoragePressure(0, budget).pressure, 'ok');
  assert.equal(classifyStoragePressure(850, budget).pressure, 'warn');
  assert.equal(classifyStoragePressure(950, budget).pressure, 'critical');
  assert.equal(classifyStoragePressure(1200, budget).pressure, 'full');
  const low = classifyStoragePressure(500, budget);
  assert.equal(low.ratio, 0.5);
  assert.equal(low.remainingBytes, 500);
  assert.equal(classifyStoragePressure(-5, budget).usedBytes, 0);
  assert.equal(classifyStoragePressure(100, {}).quotaBytes, STORAGE_DEFAULTS.quotaBytes);
});

test('estimateStorageUsage：分 kind 汇总 + 压力 + 估算标记', () => {
  const usage = estimateStorageUsage([
    capture('a', 100 * MB),
    capture('b', 50 * MB, { kind: 'video' }),
    capture('c', 10 * MB, { kind: 'other' }),
    { id: 'd', kind: 'longshot', segments: 4, averageBytes: MB, sealed: true, at: 1000 },
  ]);
  assert.equal(usage.captures, 4);
  assert.equal(usage.totalBytes, 164 * MB);
  assert.equal(usage.byKind.longshot.bytes, 104 * MB);
  assert.equal(usage.byKind.longshot.captures, 2);
  assert.equal(usage.byKind.video.bytes, 50 * MB);
  assert.equal(usage.estimatedCaptures, 1);
  assert.equal(usage.pressure, 'ok');
  assert.ok(usage.codes.includes(STORAGE_CODES.OK));
  assert.ok(usage.codes.includes(STORAGE_CODES.UNKNOWN));
  assert.equal(estimateStorageUsage(null).captures, 0);
  assert.equal(estimateStorageUsage([{ id: 'x', bytes: 0 }]).captures, 1);
});

test('kindAllowance：按份额给剩余额度', () => {
  const budget = resolveStorageBudget({ quotaBytes: 1000, shares: { longshot: 0.5, video: 0.3, other: 0.2 } });
  const allowance = kindAllowance({ byKind: { longshot: { bytes: 200, captures: 1 } } }, 'screenshot', budget);
  assert.equal(allowance.kind, 'longshot');
  assert.equal(allowance.allowanceBytes, 500);
  assert.equal(allowance.usedBytes, 200);
  assert.equal(allowance.remainingBytes, 300);
  assert.equal(allowance.over, false);
  const over = kindAllowance({ byKind: { video: { bytes: 400 } } }, 'video', budget);
  assert.equal(over.over, true);
  assert.equal(over.remainingBytes, 0);
});

test('selectEvictions：优先过期/已封版/更旧；保护 pinned/未封版/新鲜', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const candidates = [
    capture('pinned', 10 * MB, { pinned: true, at: now - 10 * day }),
    capture('unsealed', 10 * MB, { sealed: false, at: now - day }),
    capture('fresh', 10 * MB, { at: now - 1000 }),
    capture('old-sealed', 10 * MB, { at: now - 3 * day }),
    capture('expired', 10 * MB, { at: now - 10 * day }),
  ];
  const result = selectEvictions(candidates, 10 * MB, { now, minAgeMs: 60 * 60 * 1000 });
  assert.equal(result.neededBytes, 10 * MB);
  assert.equal(result.freedBytes, 10 * MB);
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.evicted.map((item) => item.id), ['expired']);
  assert.ok(result.protected.some((item) => item.id === 'pinned' && item.protect === 'pinned'));
  assert.ok(result.protected.some((item) => item.id === 'unsealed' && item.protect === 'unsealed'));
  assert.ok(result.protected.some((item) => item.id === 'fresh' && item.protect === 'fresh'));
});

test('selectEvictions：需要更多空间时继续淘汰；受 minKeep 限制；不足则 shortfall', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const candidates = [
    capture('old1', 5 * MB, { at: now - 5 * day }),
    capture('old2', 5 * MB, { at: now - 4 * day }),
    capture('old3', 5 * MB, { at: now - 3 * day }),
  ];
  const result = selectEvictions(candidates, 12 * MB, { now, minKeep: 0 });
  assert.equal(result.freedBytes, 15 * MB);
  assert.equal(result.evicted.length, 3);
  const minKeep = selectEvictions(candidates, 100 * MB, { now, minKeep: 2 });
  assert.equal(minKeep.evicted.length, 1, '至少保留 minKeep 条');
  assert.equal(minKeep.satisfied, false);
  assert.ok(minKeep.shortfallBytes > 0);
  assert.deepEqual(selectEvictions([], 5).evicted, []);
  const unknownAge = selectEvictions([{ id: 'legacy', kind: 'longshot', bytes: 10 }], 10, { now });
  assert.deepEqual(unknownAge.evicted, [], '写入时间未知的产物不淘汰');
  assert.equal(unknownAge.protected[0].protect, 'unknown-age');
});

test('planStorageBudget：充足 → accept；接近水位 → warn；不够 → evict；放不下 → reject', () => {
  const day = 24 * 60 * 60 * 1000;
  const quota = 100 * MB;
  const accept = planStorageBudget({ captures: [], incomingBytes: 10 * MB, quotaBytes: quota });
  assert.equal(accept.action, 'accept');
  assert.equal(accept.ok, true);
  assert.equal(accept.code, STORAGE_CODES.OK);
  assert.equal(accept.projectedBytes, 10 * MB);

  const warn = planStorageBudget({ usedBytes: 88 * MB, incomingBytes: 1 * MB, quotaBytes: quota });
  assert.equal(warn.pressure.pressure, 'warn');
  assert.equal(warn.action, 'warn');
  assert.equal(warn.code, STORAGE_CODES.WARN);

  const now = 20 * day;
  const evict = planStorageBudget({
    usedBytes: 96 * MB,
    incomingBytes: 10 * MB,
    quotaBytes: quota,
    now,
    captures: [
      capture('expired', 20 * MB, { at: now - 10 * day }),
      capture('keep', 20 * MB, { at: now - day }),
    ],
  });
  assert.equal(evict.action, 'evict');
  assert.ok(evict.eviction.evicted.length >= 1);
  assert.ok(evict.eviction.freedBytes >= 20 * MB);
  assert.ok(evict.projectedBytes <= quota);

  const reject = planStorageBudget({ usedBytes: 0, incomingBytes: 80 * MB, quotaBytes: quota, maxCaptureRatio: 0.5 });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.code, STORAGE_CODES.REJECT);

  const impossible = planStorageBudget({
    usedBytes: 95 * MB,
    incomingBytes: 20 * MB,
    quotaBytes: quota,
    now,
    captures: [],
  });
  assert.equal(impossible.action, 'reject');
});

test('storageBudgetWire/describeStorageBudget：截断列表、文本可读', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 20 * day;
  const plan = planStorageBudget({
    usedBytes: 96 * MB,
    incomingBytes: 10 * MB,
    quotaBytes: 100 * MB,
    now,
    captures: [
      capture('expired', 20 * MB, { at: now - 10 * day }),
      capture('keep', 20 * MB, { at: now - day }),
    ],
  });
  const wire = storageBudgetWire(plan, { maxListed: 1 });
  assert.equal(wire.version, STORAGE_BUDGET_VERSION);
  assert.equal(wire.action, 'evict');
  assert.equal(wire.evicted.length, 1);
  assert.match(wire.text, /存储预算 evict/);
  assert.match(describeStorageBudget(plan), /淘汰 1 条/);
  assert.equal(storageBudgetWire(null).ok, false);
  assert.match(describeStorageBudget(null), /无/);
});
