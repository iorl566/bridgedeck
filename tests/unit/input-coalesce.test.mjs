import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputClock } from '../../extension/src/lib/input-clock.js';
import { InputTransactions } from '../../extension/src/lib/input-transaction.js';
import { planHumanMove } from '../../extension/src/lib/human-input.js';

// pointer-primitives 依赖扩展 runtime（tabs/debugger 在模块顶层读 chrome.storage），
// 单测先装最小 chrome stub，再动态导入，保证测的就是运行时同一个实现。
const listener = () => ({ addListener() {}, removeListener() {} });
if (!globalThis.chrome) {
  globalThis.chrome = {
    runtime: { onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null, getManifest: () => ({ version: '0.1.2' }) },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: listener(),
    },
    alarms: { create: async () => {}, onAlarm: listener() },
    tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async () => ({ id: 1 }), create: async () => ({ id: 1 }), remove: async () => {}, update: async () => ({}), captureVisibleTab: async () => '' },
    windows: { getLastFocused: async () => ({ id: 1 }), get: async () => ({ id: 1 }), create: async () => ({ id: 1 }), update: async () => ({}), getAll: async () => [] },
    debugger: { onEvent: listener(), onDetach: listener(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
    offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    scripting: { executeScript: async () => [] },
    webRequest: { onBeforeRequest: listener(), onSendHeaders: listener(), onCompleted: listener(), onErrorOccurred: listener() },
    downloads: { onCreated: listener(), search: async () => [], download: async () => 1 },
    action: { openPopup: async () => {} },
    permissions: { contains: async () => true },
  };
}
const { coalescePointerMoves, pointerMoveSummary } = await import('../../extension/src/tools/pointer-primitives.js');

test('指针移动合并：过密点被丢弃，首末点与落点保持', () => {
  const plan = coalescePointerMoves([
    { x: 0, y: 0 },
    { x: 0.4, y: 0 },
    { x: 1.2, y: 0 },
    { x: 6, y: 0 },
    { x: 6.4, y: 0 },
    { x: 12, y: 4 },
  ], { minDistancePx: 2, maxEvents: 24 });
  assert.equal(plan.ok, true);
  assert.equal(plan.planned, 6);
  assert.deepEqual(plan.events.map((event) => [event.x, event.y]), [[0, 0], [6, 0], [12, 4]]);
  assert.equal(plan.kept, 3);
  assert.equal(plan.droppedReasons['too-close'], 3);
  assert.deepEqual(plan.last, { x: 12, y: 4 });
  assert.equal(plan.minDistancePx, 2);
  // 末点被篡改：合并后强制落回最后一个输入点（避免“终点没到”）。
  const snapped = coalescePointerMoves([
    { x: 0, y: 0 },
    { x: 5, y: 5 },
    { x: 100, y: 100 },
  ], { minDistancePx: 1, maxEvents: 2 });
  assert.deepEqual(snapped.events[snapped.events.length - 1].x, 100);
  assert.equal(snapped.events[snapped.events.length - 1].snappedToLast === true || snapped.events.length === 2, true);
});

test('指针移动合并：maxEvents 上限按等距抽稀，证据可复现', () => {
  const moves = [];
  for (let index = 0; index < 60; index += 1) moves.push({ x: index * 4, y: 0 });
  const plan = coalescePointerMoves(moves, { minDistancePx: 0, maxEvents: 10 });
  assert.equal(plan.kept <= 10, true, 'maxEvents 未生效：' + plan.kept);
  assert.equal(plan.events[0].x, 0, '首点丢失');
  assert.equal(plan.events[plan.events.length - 1].x, moves[moves.length - 1].x, '末点丢失');
  assert.equal((plan.droppedReasons['over-cap'] || 0) > 0, true);
  const summary = pointerMoveSummary(plan);
  assert.equal(summary.planned, 60);
  assert.equal(summary.kept, plan.kept);
  assert.equal(summary.dropped, plan.dropped.length);
  assert.equal(summary.min_distance_px, 0);
  assert.deepEqual(summary.last, { x: 236, y: 0 });
});

test('指针移动合并：非法点被拒绝且不产生事件', () => {
  const plan = coalescePointerMoves([{ x: 'bad', y: 1 }, null, { x: 1, y: 2 }, { x: 3, y: 4 }], { minDistancePx: 1 });
  assert.equal(plan.events.length, 2);
  assert.equal(plan.droppedReasons['bad-point'], 2);
  assert.deepEqual(plan.events.map((event) => [event.x, event.y]), [[1, 2], [3, 4]]);
  assert.equal(coalescePointerMoves(null).planned, 0);
  assert.equal(pointerMoveSummary(null), null);
});

test('人形移动轨迹合并：事件数显著下降但终点不变', () => {
  const target = { x: 400, y: 300 };
  const planned = planHumanMove({ x: 10, y: 10 }, target);
  assert.equal(planned.length > 3, true, '人形轨迹样本过少：' + planned.length);
  const withEnd = [...planned, target];
  const merged = coalescePointerMoves(withEnd, { minDistancePx: 4, maxEvents: 12 });
  assert.equal(merged.kept < withEnd.length, true, '合并没有减少事件：' + merged.kept + '/' + withEnd.length);
  assert.deepEqual(merged.last, { x: 400, y: 300 });
  assert.equal((merged.droppedReasons['too-close'] || 0) > 0 || (merged.droppedReasons['over-cap'] || 0) > 0, true);
});

test('时钟余项：相等读数结构化上报，重复 timestamp 仍单调合法', () => {
  let mono = 500;
  let wall = 1_000_000;
  const clock = createInputClock({ now: () => mono, wallNow: () => wall, epochMs: 0 });
  const tx = clock.begin(1, 'pointer');
  const first = clock.tick(tx);
  assert.equal(first.equal, false);
  const second = clock.tick(tx);
  assert.equal(second.ok, true);
  assert.equal(second.equal, true, '相等读数没有标记 equal');
  assert.equal(second.at, 500);
  assert.equal(second.timestamp, first.timestamp);
  const third = clock.tick(tx);
  assert.equal(third.equal, true);
  assert.equal(clock.snapshot().equalReadings, 2);
  mono = 501;
  clock.tick(tx);
  const equalAfterAdvance = clock.tick(tx);
  assert.equal(equalAfterAdvance.equal, true);
  assert.equal(clock.snapshot().globalSeq, 5);
});

test('时钟余项：休眠唤醒（墙钟跳变 >> 单调增量）被记录且不影响单调时间戳', () => {
  let mono = 100;
  let wall = 2_000_000;
  const clock = createInputClock({ now: () => mono, wallNow: () => wall, epochMs: 0, wakeThresholdMs: 2000 });
  const tx = clock.begin(7, 'pointer');
  const before = clock.tick(tx);
  // 系统休眠 60s：performance.now 停住（mono 不变），墙钟前进 60000ms。
  wall += 60_000;
  const woke = clock.tick(tx);
  assert.equal(woke.ok, true);
  assert.equal(woke.woke, true, '休眠唤醒未被检出');
  assert.equal(woke.equal, true);
  assert.equal(woke.wake.gapMs >= 59_000, true, '唤醒 gap 不合理：' + JSON.stringify(woke.wake));
  assert.equal(woke.wake.epoch, tx.epoch);
  assert.ok(woke.timestamp >= before.timestamp, '唤醒后 timestamp 倒退');
  assert.equal(clock.snapshot().wakeCount, 1);
  assert.equal(clock.snapshot().lastWake.gapMs >= 59_000, true);
  // 唤醒后继续正常采样，不再误报。
  mono += 5;
  wall += 5;
  const after = clock.tick(tx);
  assert.equal(after.woke, false);
  assert.ok(after.timestamp > woke.timestamp);
});

test('跨事务顺序：不同 tab 并行合法，同 tab 交错被判 violation', () => {
  let mono = 0;
  const clock = createInputClock({ now: () => mono, wallNow: () => mono, epochMs: 0 });
  const first = clock.begin(1, 'pointer');
  mono += 1;
  clock.tick(first);
  const parallel = clock.begin(2, 'key');
  mono += 1;
  clock.tick(parallel);
  mono += 1;
  clock.tick(first);
  const report = clock.transactionOrder();
  assert.equal(report.ok, true, '不同 tab 交错被误判：' + JSON.stringify(report.violations));
  assert.equal(report.parallel, true);
  assert.deepEqual(report.transactions.map((item) => item.epoch), [first.epoch, parallel.epoch]);
  assert.equal(report.globalSeq, 3);
  assert.deepEqual(report.violations, []);

  // 同一 tab 上人为制造两个并发事务 → tab-interleaved（真实 API 会先拒绝）。
  const clashA = clock.begin(3, 'pointer');
  mono += 1;
  clock.tick(clashA);
  const clashB = clock.begin(3, 'pointer');
  mono += 1;
  clock.tick(clashB);
  mono += 1;
  clock.tick(clashA);
  const clash = clock.transactionOrder();
  assert.equal(clash.ok, false);
  assert.equal(clash.violations[0].kind, 'tab-interleaved');
  assert.equal(clash.violations[0].tabId, 3);
});

test('InputTransactions 汇总：snapshot 暴露相等读数/唤醒/跨事务顺序', () => {
  let mono = 0;
  let wall = 0;
  const clock = createInputClock({ now: () => mono, wallNow: () => wall, epochMs: 0, wakeThresholdMs: 1000 });
  const transactions = new InputTransactions({ ttlMs: 1000, now: () => mono, clock });
  assert.equal(transactions.begin(1, 'pointer').ok, true);
  const first = transactions.stamp(1);
  assert.equal(typeof first.globalSeq, 'number');
  assert.equal(first.transaction.epoch, transactions.get(1).epoch);
  const equal = transactions.stamp(1);
  assert.equal(equal.equal, true);
  wall += 5000;
  const woke = transactions.stamp(1);
  assert.equal(woke.woke, true);
  assert.equal(transactions.get(1).wakes, 1);
  assert.equal(transactions.get(1).equalReadings, 2);

  assert.equal(transactions.begin(2, 'key').ok, true);
  mono += 1;
  transactions.stamp(2);
  const snapshot = transactions.snapshot();
  assert.equal(snapshot.counters.begins, 2);
  assert.equal(snapshot.counters.stamps, 4);
  assert.equal(snapshot.active.length, 2);
  assert.equal(snapshot.order.ok, true);
  assert.equal(snapshot.clock.globalSeq, 4);
  assert.equal(snapshot.active.find((item) => item.tabId === 1).wakes, 1);
  assert.equal(transactions.end(1, 'pointer'), true);
  assert.equal(transactions.order().ended >= 1, true);
  transactions.clear();
  assert.deepEqual(transactions.snapshot().active, []);
  assert.equal(transactions.snapshot().counters.begins, 0);
});
