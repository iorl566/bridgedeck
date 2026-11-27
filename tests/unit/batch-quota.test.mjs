// tests/unit/batch-quota.test.mjs —— 批处理会话配额分配器（daemon/session-quota.js）纯逻辑。
//
// 覆盖：
// - 环境变量策略读取（合法/非法/夹取）与归一化；
// - "请求只能收紧、不能抬高"的覆盖规则；
// - 纯函数准入规划：优先级 + 先来先服务、单批上限、全局上限、部分批准/拒绝；
// - 运行期账本：reserve/commit/release/finalize/expire、幂等、计数器、快照结构与实例用量；
// - 失败路径：bad batchId、无预约 commit/release、liveSessions 抛错、tighten 只收紧。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_QUOTA_BOUNDS,
  SESSION_QUOTA_DEFAULTS,
  SESSION_QUOTA_KIND,
  SESSION_QUOTA_POLICY_KEYS,
  SESSION_QUOTA_SCHEMA,
  createSessionQuota,
  describeQuotaUsage,
  normalizeSessionQuotaPolicy,
  planQuotaAdmission,
  quotaPolicyFromEnv,
  tightenSessionQuotaPolicy,
} from '../../daemon/session-quota.js';

const NOW = 1_700_000_000_000;

function fixedClock(start = NOW) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  now.set = (value) => { current = value; };
  return now;
}

function makeQuota({ policy = {}, live = 0, now = fixedClock(), instances = null } = {}) {
  return createSessionQuota({
    policy: { ...SESSION_QUOTA_DEFAULTS, ...policy },
    liveSessions: typeof live === 'function' ? live : () => live,
    liveInstances: instances === null ? null : (typeof instances === 'function' ? instances : () => instances),
    now,
  });
}

// ---------------------------------------------------------------------------
// 策略归一化
// ---------------------------------------------------------------------------

test('SESSION_QUOTA_DEFAULTS：默认值保守且自洽（单批 <= 全局，并发 <= 单批）', () => {
  const policy = SESSION_QUOTA_DEFAULTS;
  assert.equal(policy.maxSessions, 12);
  assert.equal(policy.maxPerBatch, 4);
  assert.equal(policy.maxConcurrentStarts, 2);
  assert.ok(policy.maxPerBatch <= policy.maxSessions);
  assert.ok(policy.maxConcurrentStarts <= policy.maxPerBatch);
  assert.ok(policy.maxPerInstance <= policy.maxSessions);
  assert.ok(policy.maxBatchItems >= policy.maxPerBatch);
  assert.ok(policy.reservationTtlMs >= 1000);
  assert.deepEqual(SESSION_QUOTA_POLICY_KEYS, Object.keys(policy));
});

test('normalizeSessionQuotaPolicy：缺失键回退默认、非法数字回退或夹取', () => {
  const { policy, clamped } = normalizeSessionQuotaPolicy({ maxSessions: 4 });
  assert.equal(policy.maxSessions, 4);
  assert.equal(policy.maxPerBatch, SESSION_QUOTA_DEFAULTS.maxPerBatch);
  assert.deepEqual(clamped, []);

  const low = normalizeSessionQuotaPolicy({ maxSessions: 0 });
  assert.equal(low.policy.maxSessions, SESSION_QUOTA_BOUNDS.maxSessions.min);
  assert.deepEqual(low.clamped.map((item) => item.key), ['maxSessions']);
  assert.equal(low.clamped[0].direction, 'min');

  const high = normalizeSessionQuotaPolicy({ maxConcurrentStarts: 999 });
  assert.equal(high.policy.maxConcurrentStarts, SESSION_QUOTA_BOUNDS.maxConcurrentStarts.max);
  assert.equal(high.clamped[0].direction, 'max');

  const nonNumeric = normalizeSessionQuotaPolicy({ maxSessions: 'abc' });
  assert.equal(nonNumeric.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
});

test('normalizeSessionQuotaPolicy：base 参数生效，非对象输入安全回退', () => {
  const { policy } = normalizeSessionQuotaPolicy({ maxPerBatch: 9 }, { base: { maxPerBatch: 3, maxSessions: 5 } });
  assert.equal(policy.maxPerBatch, 9);
  assert.equal(policy.maxSessions, 5);
  assert.equal(policy.maxBatchItems, SESSION_QUOTA_DEFAULTS.maxBatchItems);
  const nullInput = normalizeSessionQuotaPolicy(null);
  assert.equal(nullInput.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
  const scalar = normalizeSessionQuotaPolicy(42);
  assert.equal(scalar.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
});

test('tightenSessionQuotaPolicy：只能收紧、未知键与 daemon 保留键被忽略', () => {
  const base = { maxSessions: 8, maxPerBatch: 4, maxConcurrentStarts: 2, maxPerInstance: 6, maxBatchItems: 20, reservationTtlMs: 60_000 };
  const loosened = tightenSessionQuotaPolicy(base, { maxSessions: 99, maxPerBatch: 99, maxConcurrentStarts: 1 });
  assert.equal(loosened.policy.maxSessions, 8, '不能抬高全局上限');
  assert.equal(loosened.policy.maxPerBatch, 4, '不能抬高单批上限');
  assert.equal(loosened.policy.maxConcurrentStarts, 1, '可以调小并发');
  assert.deepEqual(loosened.ignored, []);

  const ignored = tightenSessionQuotaPolicy(base, {
    maxSessions: -1,
    reservationTtlMs: 5,
    unknownKey: 1,
    maxPerInstance: 'x',
  });
  assert.equal(ignored.policy.maxSessions, 8);
  assert.equal(ignored.policy.reservationTtlMs, 60_000);
  assert.deepEqual(ignored.ignored.map((item) => item.reason).sort(), ['daemon-owned', 'not-positive-number', 'not-positive-number', 'unknown-key'].sort());
});

test('tightenSessionQuotaPolicy：小于下限的值被夹到下限而不是拒绝', () => {
  const result = tightenSessionQuotaPolicy({ maxSessions: 8 }, { maxSessions: 0, maxConcurrentStarts: 0 });
  // 0 非法 → ignored；负数/0 不会变成下限（只接受正数）。
  assert.equal(result.policy.maxSessions, 8);
  assert.ok(result.ignored.some((item) => item.key === 'maxSessions'));
});

test('quotaPolicyFromEnv：读取环境变量、非法值记录 ignored、越界记录 clamped', () => {
  const parsed = quotaPolicyFromEnv({
    BB_SESSION_QUOTA: '6',
    BB_BATCH_QUOTA: '3',
    BB_BATCH_CONCURRENCY: '2',
    BB_INSTANCE_QUOTA: '5',
    BB_BATCH_MAX_ITEMS: '15',
    BB_BATCH_RESERVATION_TTL_MS: '45000',
  });
  assert.equal(parsed.policy.maxSessions, 6);
  assert.equal(parsed.policy.maxPerBatch, 3);
  assert.equal(parsed.policy.maxConcurrentStarts, 2);
  assert.equal(parsed.policy.maxPerInstance, 5);
  assert.equal(parsed.policy.maxBatchItems, 15);
  assert.equal(parsed.policy.reservationTtlMs, 45_000);
  assert.deepEqual(parsed.ignored, []);
  assert.equal(parsed.source.BB_SESSION_QUOTA, '6');

  const bad = quotaPolicyFromEnv({ BB_SESSION_QUOTA: 'abc', BB_BATCH_QUOTA: '0' });
  assert.equal(bad.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
  assert.equal(bad.policy.maxPerBatch, SESSION_QUOTA_BOUNDS.maxPerBatch.min);
  assert.ok(bad.ignored.some((item) => item.reason === 'not-integer' && item.key === 'maxSessions'));
  assert.ok(bad.ignored.some((item) => item.reason === 'clamped-min' && item.key === 'maxPerBatch'));

  const empty = quotaPolicyFromEnv({});
  assert.equal(empty.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
  assert.deepEqual(empty.source, {});
});

// ---------------------------------------------------------------------------
// 纯函数准入规划
// ---------------------------------------------------------------------------

test('planQuotaAdmission：空请求与零请求不产生批准', () => {
  const empty = planQuotaAdmission({ requests: [] });
  assert.equal(empty.decisions.length, 0);
  assert.deepEqual(empty.totals, {
    requests: 0, requested: 0, granted: 0, denied: 0, fullyGranted: 0, partiallyGranted: 0, rejected: 0,
  });
  const zero = planQuotaAdmission({ policy: { maxSessions: 4 }, requests: [{ batchId: 'b', requested: 0 }] });
  assert.equal(zero.decisions[0].granted, 0);
  assert.equal(zero.decisions[0].reason, 'empty');
});

test('planQuotaAdmission：优先级降序 → createdAt 升序 → batchId 字典序（完全确定性）', () => {
  const policy = { maxSessions: 5, maxPerBatch: 2, maxConcurrentStarts: 1, maxPerInstance: 5, maxBatchItems: 10, reservationTtlMs: 1000 };
  const result = planQuotaAdmission({
    policy,
    requests: [
      { batchId: 'zzz', requested: 2, priority: 1, createdAt: 100 },
      { batchId: 'aaa', requested: 2, priority: 1, createdAt: 100 },
      { batchId: 'late', requested: 2, priority: 0, createdAt: 100 },
      { batchId: 'early', requested: 2, priority: 1, createdAt: 50 },
    ],
  });
  assert.deepEqual(result.decisions.map((item) => item.batchId), ['early', 'aaa', 'zzz', 'late']);
  assert.deepEqual(result.decisions.map((item) => item.granted), [2, 2, 1, 0]);
  assert.deepEqual(result.decisions.map((item) => item.reason), ['granted', 'granted', 'quota-partial', 'quota-exhausted']);
  assert.equal(result.totals.requested, 8);
  assert.equal(result.totals.granted, 5);
  assert.equal(result.totals.denied, 3);
  assert.equal(result.totals.rejected, 1);
  assert.equal(result.availableAfter, 0);
});

test('planQuotaAdmission：单批上限与全局上限双重裁剪，reserved/live 计入可用量', () => {
  const policy = { maxSessions: 6, maxPerBatch: 3, maxConcurrentStarts: 2, maxPerInstance: 6, maxBatchItems: 10, reservationTtlMs: 1000 };
  const result = planQuotaAdmission({ policy, live: 2, reserved: 1, requests: [{ batchId: 'b1', requested: 10 }] });
  assert.equal(result.availableBefore, 3);
  assert.equal(result.decisions[0].granted, 3);
  assert.equal(result.decisions[0].deniedCount, 7);
  assert.equal(result.availableAfter, 0);
  assert.equal(result.policy.maxPerBatch, 3);

  const exhausted = planQuotaAdmission({ policy, live: 6, requests: [{ batchId: 'b2', requested: 1 }] });
  assert.equal(exhausted.availableBefore, 0);
  assert.equal(exhausted.decisions[0].granted, 0);
  assert.equal(exhausted.decisions[0].reason, 'quota-exhausted');
});

test('planQuotaAdmission：相同输入重复调用结果完全一致（无隐藏状态）', () => {
  const input = {
    policy: { maxSessions: 4 },
    live: 1,
    requests: [
      { batchId: 'b', requested: 3, priority: 2, createdAt: 2 },
      { batchId: 'a', requested: 3, priority: 2, createdAt: 2 },
      { batchId: 'c', requested: 3, priority: -1, createdAt: 1 },
    ],
  };
  assert.deepEqual(planQuotaAdmission(input), planQuotaAdmission(input));
});

test('planQuotaAdmission：负数/非法 live 与 requested 被安全归一化', () => {
  const result = planQuotaAdmission({ policy: { maxSessions: 3 }, live: -5, reserved: 'x', requests: [{ batchId: 'b', requested: -2 }] });
  assert.equal(result.live, 0);
  assert.equal(result.reserved, 0);
  assert.equal(result.decisions[0].requested, 0);
  assert.equal(result.availableBefore, 3);
});

// ---------------------------------------------------------------------------
// 运行期账本：reserve / commit / release
// ---------------------------------------------------------------------------

test('reserve：批准数量受全局/单批上限约束，并记录计数器', () => {
  const quota = makeQuota({ policy: { maxSessions: 5, maxPerBatch: 2 } });
  const first = quota.reserve('b1', 4);
  assert.equal(first.ok, true);
  assert.equal(first.granted, 2);
  assert.equal(first.partial, true);
  assert.equal(first.denied, false);
  assert.equal(first.reused, false);
  assert.equal(first.available, 3);
  const snapshot = quota.snapshot();
  assert.equal(snapshot.counters.reserveCalls, 1);
  assert.equal(snapshot.counters.partialReservations, 1);
  assert.equal(snapshot.totals.granted, 2);
  assert.equal(snapshot.reserved, 2);
  assert.equal(snapshot.available, 3);
});

test('reserve：同一 batchId 幂等（不重复扣额度），且返回 reused=true', () => {
  const quota = makeQuota({ policy: { maxSessions: 4, maxPerBatch: 4 } });
  const first = quota.reserve('same', 3);
  const second = quota.reserve('same', 3);
  assert.equal(first.granted, 3);
  assert.equal(second.granted, 3);
  assert.equal(second.reused, true);
  assert.equal(quota.outstanding(), 3);
  assert.equal(quota.snapshot().counters.reserveCalls, 1);
});

test('reserve：额度耗尽时 granted=0 / denied=true，并累计 deniedReservations', () => {
  const quota = makeQuota({ policy: { maxSessions: 2, maxPerBatch: 2 } });
  quota.reserve('hold', 2);
  const denied = quota.reserve('late', 1);
  assert.equal(denied.granted, 0);
  assert.equal(denied.denied, true);
  assert.equal(denied.available, 0);
  assert.equal(quota.snapshot().counters.deniedReservations, 1);
  assert.equal(quota.available(), 0);
});

test('reserve：空 batchId 返回结构化错误；priority/meta 被记录', () => {
  const quota = makeQuota();
  const bad = quota.reserve('', 1);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_BAD_ARG');
  const good = quota.reserve('b', 1, { priority: 3, meta: { group: 'g', nested: { a: 1 } } });
  assert.equal(quota.get('b').priority, 3);
  assert.deepEqual(quota.get('b').meta, { group: 'g', nested: { a: 1 } });
  assert.equal(good.position, 1);
});

test('commit：按名额从预约转 used（live 增长时总量不变），超量被夹取', () => {
  const clock = fixedClock();
  const quota = makeQuota({ policy: { maxSessions: 4, maxPerBatch: 4 }, now: clock });
  quota.reserve('b', 3);
  const first = quota.commit('b', 1);
  assert.deepEqual({ committed: first.committed, granted: first.granted, used: first.used }, { committed: 1, granted: 2, used: 1 });
  clock.advance(10);
  const extra = quota.commit('b', 99);
  assert.equal(extra.committed, 2);
  assert.equal(extra.granted, 0);
  assert.equal(extra.used, 3);
  const afterFull = quota.commit('b', 1);
  assert.equal(afterFull.committed, 0);
  assert.equal(quota.snapshot().counters.commits, 3);
});

test('commit/release：没有预约或已 finalize 的记录返回 E_INTERNAL', () => {
  const quota = makeQuota();
  const noReservation = quota.commit('nope', 1);
  assert.equal(noReservation.ok, false);
  assert.equal(noReservation.code, 'E_INTERNAL');
  quota.reserve('b', 2);
  quota.finalize('b');
  const afterFinalize = quota.release('b', 1);
  assert.equal(afterFinalize.ok, false);
});

test('release：释放未用额度（全部或部分），释放后可用额度恢复', () => {
  const quota = makeQuota({ policy: { maxSessions: 5, maxPerBatch: 5 } });
  quota.reserve('b', 4);
  assert.equal(quota.available(), 1);
  const partial = quota.release('b', 2);
  assert.equal(partial.released, 2);
  assert.equal(quota.available(), 3);
  const rest = quota.release('b');
  assert.equal(rest.released, 2);
  assert.equal(quota.available(), 5);
  assert.equal(quota.snapshot().counters.releases, 4);
});

test('finalize：释放残余预约、状态落库、重复调用幂等', () => {
  const quota = makeQuota({ policy: { maxSessions: 5, maxPerBatch: 5 } });
  quota.reserve('b', 3);
  quota.commit('b', 1);
  const finalized = quota.finalize('b', { state: 'completed' });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.released, 2);
  assert.equal(finalized.used, 1);
  assert.equal(quota.available(), 5);
  const again = quota.finalize('b');
  assert.equal(again.alreadyFinalized, true);
  assert.equal(again.released, 0);
  assert.equal(quota.get('b').state, 'completed');
  assert.equal(quota.get('b').granted, 0);
});

test('expireReservations：超时预约被回收，未到期的不动', () => {
  const clock = fixedClock();
  const quota = makeQuota({ policy: { maxSessions: 4, maxPerBatch: 4, reservationTtlMs: 1000 }, now: clock });
  quota.reserve('old', 2);
  clock.advance(600);
  quota.reserve('new', 1);
  clock.advance(500);
  const expired = quota.expireReservations();
  assert.deepEqual(expired.expired.map((item) => item.batchId), ['old']);
  assert.equal(expired.expired[0].released, 2);
  assert.equal(quota.get('old').state, 'expired');
  assert.equal(quota.get('new').state, 'reserved');
  assert.equal(quota.available(), 3);
  assert.equal(quota.snapshot().counters.expiredReservations, 1);
});

test('usage：百分比/饱和/实例用量（Map 或数组都支持）', () => {
  const quota = makeQuota({
    policy: { maxSessions: 4 },
    live: 2,
    instances: new Map([['edge-1', 2], ['chrome-2', 0]]),
  });
  const usage = quota.usage();
  assert.equal(usage.live, 2);
  assert.equal(usage.used, 2);
  assert.equal(usage.available, 2);
  assert.equal(usage.usagePercent, 50);
  assert.equal(usage.saturated, false);
  assert.deepEqual(usage.instances, [{ instanceId: 'chrome-2', live: 0 }, { instanceId: 'edge-1', live: 2 }]);
  assert.equal(usage.maxPerInstance, SESSION_QUOTA_DEFAULTS.maxPerInstance);

  const saturated = makeQuota({
    policy: { maxSessions: 2 },
    live: 2,
    instances: [{ instanceId: 'edge-1', count: 2 }],
  }).usage();
  assert.equal(saturated.saturated, true);
  assert.equal(saturated.usagePercent, 100);
});

test('snapshot：结构稳定（schema/kind/policy/totals/counters/batches）且 limit 截断', () => {
  const quota = makeQuota({ policy: { maxSessions: 10, maxPerBatch: 10 } });
  quota.reserve('b1', 1);
  quota.reserve('b2', 1);
  quota.reserve('b3', 1);
  const snapshot = quota.snapshot({ limit: 2 });
  assert.equal(snapshot.schema, SESSION_QUOTA_SCHEMA);
  assert.equal(snapshot.kind, SESSION_QUOTA_KIND);
  assert.equal(snapshot.policy.maxSessions, 10);
  assert.equal(snapshot.batches.length, 2);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.totals.reservations, 3);
  assert.equal(snapshot.totals.requested, 3);
  assert.ok(snapshot.at > 0);
  assert.equal(typeof snapshot.counters.reserveCalls, 'number');
  assert.equal(snapshot.reserved, 3);
  assert.equal(snapshot.available, 7);
});

test('snapshot：includeFinalized=false 只返回仍活跃的预约', () => {
  const quota = makeQuota({ policy: { maxSessions: 10, maxPerBatch: 10 } });
  quota.reserve('done', 1);
  quota.finalize('done');
  quota.reserve('live', 1);
  const active = quota.snapshot({ includeFinalized: false });
  assert.deepEqual(active.batches.map((item) => item.batchId), ['live']);
  const all = quota.snapshot();
  assert.equal(all.batches.length, 2);
});

test('tighten：运行期只收紧策略并返回差异；reset 清空账本但保留策略', () => {
  const quota = makeQuota({ policy: { maxSessions: 8, maxPerBatch: 4 } });
  quota.reserve('b', 2);
  const tightened = quota.tighten({ maxSessions: 99, maxPerBatch: 2 });
  assert.equal(tightened.before.maxSessions, 8);
  assert.equal(tightened.after.maxSessions, 8);
  assert.equal(tightened.after.maxPerBatch, 2);
  assert.ok(Array.isArray(tightened.ignored));
  const reset = quota.reset();
  assert.equal(reset.policy.maxSessions, 8);
  assert.equal(quota.outstanding(), 0);
  assert.equal(quota.snapshot().counters.reserveCalls, 0);
  assert.equal(quota.get('b'), null);
});

test('liveSessions：回调抛错时按 0 处理（视图不能被打挂）', () => {
  const quota = createSessionQuota({
    policy: { maxSessions: 3 },
    liveSessions: () => { throw new Error('boom'); },
    now: () => NOW,
  });
  assert.equal(quota.live(), 0);
  assert.equal(quota.available(), 3);
  assert.equal(quota.usage().live, 0);
});

test('describeQuotaUsage：人类摘要与饱和语义', () => {
  const summary = describeQuotaUsage({
    policy: { maxSessions: 5, maxPerBatch: 2, maxConcurrentStarts: 1 },
    live: 2,
    reserved: 1,
    available: 2,
  });
  assert.match(summary.text, /存活 2\/5/);
  assert.match(summary.text, /预约 1/);
  assert.equal(summary.saturated, false);
  const saturated = describeQuotaUsage({ policy: { maxSessions: 2 }, live: 2, reserved: 0, available: 0 });
  assert.equal(saturated.saturated, true);
});

test('createSessionQuota：缺省参数可用（不传 policy/live），policy getter 返回副本', () => {
  const quota = createSessionQuota();
  assert.equal(quota.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
  const copy = quota.policy;
  copy.maxSessions = 999;
  assert.equal(quota.policy.maxSessions, SESSION_QUOTA_DEFAULTS.maxSessions);
});

test('planAdmission：实例方法使用当前 live/outstanding（与 reserve 结果一致）', () => {
  const quota = makeQuota({ policy: { maxSessions: 3, maxPerBatch: 3 } });
  quota.reserve('occupied', 1);
  const plan = quota.planAdmission([{ batchId: 'next', requested: 3 }]);
  assert.equal(plan.live, 0);
  assert.equal(plan.reserved, 1);
  assert.equal(plan.decisions[0].granted, 2);
});
