import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputClock } from '../../extension/src/lib/input-clock.js';
import { InputTransactions } from '../../extension/src/lib/input-transaction.js';

function makeClock(start = 1000, options = {}) {
  let now = start;
  return {
    clock: createInputClock({ now: () => now, epochMs: 0, ...options }),
    set(value) { now = value; },
    value() { return now; },
  };
}

test('单调时钟：timestamp 只增不减，per-transaction epoch + 序号', () => {
  const { clock, set } = makeClock(1000);
  const first = clock.begin(1, 'pointer');
  const second = clock.begin(2, 'key');
  assert.equal(first.ok, true);
  assert.ok(second.epoch > first.epoch, 'epoch 没有单调递增');

  const a = clock.tick(first);
  assert.equal(a.ok, true);
  assert.equal(a.seq, 1);
  assert.equal(a.at, 1000);
  assert.equal(a.timestamp, 1); // epochMs=0：毫秒 → 秒
  assert.equal(a.clamped, false);

  set(1005);
  const b = clock.tick(second);
  assert.equal(b.ok, true);
  assert.equal(b.seq, 1); // 每个事务独立序号
  assert.equal(b.epoch, second.epoch);
  assert.ok(b.timestamp >= a.timestamp);

  set(1010);
  const c = clock.tick(first);
  assert.equal(c.seq, 2);
  assert.ok(c.timestamp > b.timestamp);
  assert.deepEqual(clock.snapshot().active.map((tx) => tx.epoch), [first.epoch, second.epoch]);
});

test('时间回退返回结构化错误（code + 证据），且不推进时钟', () => {
  const { clock, set } = makeClock(1000);
  const tx = clock.begin(1, 'pointer');
  assert.equal(clock.tick(tx).ok, true);
  set(900);
  const regression = clock.tick(tx);
  assert.equal(regression.ok, false);
  assert.equal(regression.code, 'E_INTERNAL');
  assert.equal(regression.cause, 'clock_regression');
  assert.match(regression.message, /回退/);
  assert.equal(regression.evidence.clock, 'input');
  assert.equal(regression.evidence.epoch, tx.epoch);
  assert.equal(regression.evidence.seq, 1);
  assert.equal(regression.evidence.previousAt, 1000);
  assert.equal(regression.evidence.observedAt, 900);
  assert.equal(regression.evidence.deltaMs, 100);
  // 回退被拒绝后 lastAt 不倒退，后续读数正常。
  set(1002);
  const next = clock.tick(tx);
  assert.equal(next.ok, true);
  assert.equal(next.seq, 2);
});

test('相等读数不报回退；容差内的抖动夹住并标记 clamped', () => {
  const { clock, set } = makeClock(1000);
  const tx = clock.begin(1, 'pointer');
  clock.tick(tx);
  const equal = clock.tick(tx);
  assert.equal(equal.ok, true);
  assert.equal(equal.at, 1000);
  assert.equal(equal.clamped, false);

  set(1000);
  const tolerant = makeClock(1000, { toleranceMs: 5 });
  const tolerantTx = tolerant.clock.begin(1, 'key');
  tolerant.clock.tick(tolerantTx);
  tolerant.set(998);
  const jitter = tolerant.clock.tick(tolerantTx);
  assert.equal(jitter.ok, true);
  assert.equal(jitter.clamped, true);
  assert.equal(jitter.at, 1000);
  tolerant.set(990);
  const tooFar = tolerant.clock.tick(tolerantTx);
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.cause, 'clock_regression');
});

test('事务结束/不存在时 tick 返回 clock_stale', () => {
  const { clock } = makeClock(10);
  const tx = clock.begin(7, 'drag');
  clock.tick(tx);
  const ended = clock.end(tx);
  assert.equal(ended.ok, true);
  assert.equal(ended.events, 1);
  assert.equal(ended.lastAt, 10);
  assert.equal(ended.lastTimestamp, 0.01);

  const stale = clock.tick(tx);
  assert.equal(stale.ok, false);
  assert.equal(stale.cause, 'clock_stale');
  assert.equal(stale.evidence.epoch, tx.epoch);

  const missing = clock.tick(9999);
  assert.equal(missing.ok, false);
  assert.equal(missing.cause, 'clock_stale');
  assert.equal(missing.evidence.epoch, 9999);
});

test('clear 清空事务，之后不能再派发', () => {
  const { clock } = makeClock(0);
  const tx = clock.begin(1, 'pointer');
  clock.clear();
  assert.deepEqual(clock.snapshot().active, []);
  assert.equal(clock.tick(tx).cause, 'clock_stale');
});

test('InputTransactions 接入：begin 分配 epoch，stamp 单调且回退被拒绝', () => {
  let now = 0;
  const clock = createInputClock({ now: () => now, epochMs: 0 });
  const transactions = new InputTransactions({ ttlMs: 1000, now: () => now, clock });

  const begun = transactions.begin(1, 'pointer');
  assert.equal(begun.ok, true);
  assert.ok(Number.isInteger(begun.active.epoch), 'begin 没有分配 epoch');

  now = 10;
  const first = transactions.stamp(1);
  assert.equal(first.ok, true);
  assert.equal(first.epoch, begun.active.epoch);
  assert.equal(first.seq, 1);
  assert.equal(first.timestamp, 0.01);

  now = 12;
  const second = transactions.stamp(1);
  assert.equal(second.seq, 2);
  assert.ok(second.timestamp > first.timestamp);
  assert.equal(transactions.get(1).seq, 2, '事务账本没有记录序号');

  now = 5;
  const regressed = transactions.stamp(1);
  assert.equal(regressed.ok, false);
  assert.equal(regressed.cause, 'clock_regression');
  assert.equal(regressed.evidence.previousAt, 12);
  assert.equal(regressed.evidence.observedAt, 5);
  assert.equal(regressed.evidence.deltaMs, 7);

  now = 13;
  assert.equal(transactions.stamp(1).ok, true, '回退后事务不应被锁死');
  assert.equal(transactions.end(1, 'pointer'), true);
  const stale = transactions.stamp(1);
  assert.equal(stale.ok, false);
  assert.equal(stale.cause, 'clock_stale');
});

test('InputTransactions 过期回收会结束旧时钟事务', () => {
  let now = 0;
  const clock = createInputClock({ now: () => now, epochMs: 0 });
  const transactions = new InputTransactions({ ttlMs: 100, now: () => now, clock });
  const old = transactions.begin(1, 'pointer');
  now = 101;
  const replacement = transactions.begin(1, 'key');
  assert.equal(replacement.ok, true);
  assert.ok(replacement.active.epoch > old.active.epoch);
  assert.equal(clock.tick(old.active.epoch).cause, 'clock_stale', '过期事务的时钟没有释放');
  assert.equal(transactions.stamp(1).ok, true);
});

test('InputTransactions 可注入单调时钟源（clockNow）', () => {
  let now = 100;
  const transactions = new InputTransactions({ ttlMs: 1000, now: () => 0, clockNow: () => now });
  assert.equal(transactions.begin(1, 'fill').ok, true);
  now = 150;
  const stamp = transactions.stamp(1);
  assert.equal(stamp.ok, true);
  assert.equal(stamp.at, 150);
  assert.equal(stamp.seq, 1);
  assert.ok(stamp.timestamp > 1e9, 'timestamp 应是 TimeSinceEpoch 秒：' + stamp.timestamp);
});

test('InputTransactions 未被 stamp 时保持原有 begin/end 语义', () => {
  const transactions = new InputTransactions({ ttlMs: 1000, now: () => 0 });
  assert.equal(transactions.begin(1, 'pointer').ok, true);
  assert.equal(transactions.begin(1, 'key').code, 'E_INPUT_BUSY');
  assert.equal(transactions.end(1, 'key'), false);
  assert.equal(transactions.end(1, 'pointer'), true);
  assert.equal(transactions.get(1), null);
});
