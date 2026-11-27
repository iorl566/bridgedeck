import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepairTracker } from '../../extension/src/lib/frame-repairs.js';

test('隐藏帧跳过，不消耗重试预算', () => {
  const tracker = createRepairTracker({ now: () => 1000 });
  assert.equal(tracker.plan(1, '0:doc', { hidden: true }), 'skip');
  assert.equal(tracker.summary().skippedHidden, 1);
  assert.equal(tracker.summary().attempted, 0);
});

test('同一帧 TTL 内只修一次', () => {
  let clock = 0;
  const tracker = createRepairTracker({ ttlMs: 4000, now: () => clock });
  assert.equal(tracker.plan(1, '5:doc'), 'repair');
  clock = 1000;
  assert.equal(tracker.plan(1, '5:doc'), 'cached');
  clock = 5000;
  assert.equal(tracker.plan(1, '5:doc'), 'repair');
  assert.equal(tracker.summary().attempted, 2);
  assert.equal(tracker.summary().cached, 1);
});

test('修复成功/失败计数', () => {
  const tracker = createRepairTracker({ now: () => 0 });
  tracker.plan(1, 'a');
  tracker.finish(true);
  tracker.plan(1, 'b');
  tracker.finish(false);
  assert.deepEqual({ repaired: tracker.summary().repaired, failed: tracker.summary().failed }, { repaired: 1, failed: 1 });
});

test('clear 只清理指定 tab', () => {
  const tracker = createRepairTracker({ now: () => 0 });
  tracker.plan(1, 'a');
  tracker.plan(2, 'b');
  tracker.clear(1);
  assert.equal(tracker.summary().tracked, 1);
});

test('reconcile：按 liveKeys 清理替换/消失的 document', () => {
  const tracker = createRepairTracker({ now: () => 0 });
  tracker.plan(1, '3:docA');
  tracker.plan(1, '4:docB');
  tracker.plan(2, '5:docC');
  const pruned = tracker.reconcile(1, new Set(['3:docA']));
  assert.equal(pruned, 1);
  assert.equal(tracker.summary().pruned, 1);
  assert.equal(tracker.summary().tracked, 2, '别的 tab 不受影响');
});
