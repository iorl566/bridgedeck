import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_DEFAULTS,
  STALE_KINDS,
  addStaleCost,
  classifyStale,
  classifyStaleChange,
  describeStaleRetry,
  planStaleRetry,
  staleBudgetGate,
  staleRetryWire,
  staleSignature,
  staleWave,
  summarizeStaleRetries,
} from '../../extension/src/lib/longshot-stale.js';
import { planLongshotSegments } from '../../extension/src/lib/longshot-segments.js';

test('staleSignature：含 dpr/固定带，不含 scrollY', () => {
  const base = { scrollHeight: 15000, scrollWidth: 1241, innerWidth: 1241, innerHeight: 800, dpr: 1.5, fixedTopHeight: 56, fixedBottomHeight: 80, revision: 3 };
  assert.equal(staleSignature(base), staleSignature({ ...base, scrollY: 9999 }));
  assert.notEqual(staleSignature(base), staleSignature({ ...base, dpr: 2 }));
  assert.notEqual(staleSignature(base), staleSignature({ ...base, fixedTopHeight: 0 }));
  assert.equal(staleSignature(null), 'stale:none');
});

test('classifyStaleChange：逐字段归因与代价', () => {
  const growth = classifyStaleChange({ field: 'scrollHeight', before: 15000, after: 18000 });
  assert.equal(growth.kind, 'growth');
  assert.equal(growth.costs, 'extend');
  assert.equal(growth.delta, 3000);
  assert.equal(classifyStaleChange({ field: 'scrollHeight', before: 15000, after: 12000 }).kind, 'shrink');
  assert.equal(classifyStaleChange({ field: 'scrollWidth', before: 1241, after: 1300 }).kind, 'width');
  assert.equal(classifyStaleChange({ field: 'innerHeight', before: 800, after: 700 }).kind, 'viewport');
  assert.equal(classifyStaleChange({ field: 'dpr', before: 1, after: 1.5 }).kind, 'dpr');
  assert.equal(classifyStaleChange({ field: 'fixedTopHeight', before: 56, after: 20 }).kind, 'bands');
  assert.equal(classifyStaleChange({ field: 'fixedTopHeight', before: 56, after: 20 }).costs, 'rewrite');
  assert.equal(classifyStaleChange({ field: 'revision', before: 1, after: 2 }).kind, 'revision');
  assert.equal(classifyStaleChange({ field: 'unknownField' }).kind, 'unknown');
  assert.equal(classifyStaleChange(null).kind, 'unknown');
});

test('classifyStale：主导原因/严重度/建议动作', () => {
  const grow = classifyStale([{ field: 'scrollHeight', before: 100, after: 4000 }]);
  assert.deepEqual(grow.kinds, ['growth']);
  assert.equal(grow.suggestion, 'extend-tail');
  assert.equal(grow.dominant, 'growth');
  const width = classifyStale([{ field: 'scrollHeight', before: 100, after: 200 }, { field: 'scrollWidth', before: 100, after: 200 }]);
  assert.equal(width.suggestion, 'retry-full');
  assert.equal(width.severity, 3);
  const revisionOnly = classifyStale([{ field: 'revision', before: 1, after: 2 }]);
  assert.equal(revisionOnly.revisionOnly, true);
  assert.equal(revisionOnly.suggestion, 'rewrite-regions');
  const none = classifyStale([]);
  assert.equal(none.suggestion, 'accept');
  assert.deepEqual(none.kinds, []);
  assert.deepEqual(STALE_KINDS.slice(0, 3), ['growth', 'shrink', 'width']);
});

test('staleWave：extend 只重画尾段，full 重画全部，rewrite 按区间', () => {
  const plan = planLongshotSegments({ deviceWidth: 1241, deviceHeight: 45000, dpr: 1 });
  const tail = staleWave(plan, classifyStale([{ field: 'scrollHeight', before: 100, after: 200 }]));
  assert.equal(tail.wave, 'tail');
  assert.deepEqual(tail.segmentIndexes, [1]);
  assert.equal(tail.cost, 1);
  const full = staleWave(plan, classifyStale([{ field: 'dpr', before: 1, after: 2 }]));
  assert.equal(full.wave, 'all');
  assert.deepEqual(full.segmentIndexes, [0, 1]);
  const rewrite = staleWave(plan, classifyStale([{ field: 'revision', before: 1, after: 2 }]));
  assert.equal(rewrite.wave, 'all');
  assert.equal(rewrite.reason, 'rewrite-no-range');
  const ranged = staleWave(plan, classifyStale([{ field: 'revision', before: 1, after: 2 }]), {
    affected: [{ pageY: 0, pageHeight: 100 }],
  });
  assert.equal(ranged.wave, 'partial');
  assert.deepEqual(ranged.segmentIndexes, [0]);
  // 没有段规划时安全返回
  assert.equal(staleWave(null, null).wave, 'none');
});

test('staleBudgetGate：三维预算耗尽判定', () => {
  const ok = staleBudgetGate({ tiles: 1, bytes: 10, elapsedMs: 10 }, { maxRetryTiles: 10, maxRetryBytes: 100, maxRetryMs: 1000 });
  assert.equal(ok.exhausted, false);
  assert.equal(ok.tilesLeft, 9);
  assert.equal(ok.bytesLeft, 90);
  assert.equal(ok.msLeft, 990);
  assert.equal(ok.reason, '');
  assert.equal(staleBudgetGate({ tiles: 10 }, { maxRetryTiles: 10 }).reason, 'tiles');
  assert.equal(staleBudgetGate({ bytes: 100 }, { maxRetryBytes: 100 }).reason, 'bytes');
  assert.equal(staleBudgetGate({ elapsedMs: 500 }, { maxRetryMs: 500 }).reason, 'time');
  const unlimited = staleBudgetGate({}, { maxRetryTiles: 0, maxRetryBytes: 0, maxRetryMs: 0 });
  assert.equal(unlimited.tilesLeft, -1);
});

test('planStaleRetry：第一次重试带退避阶梯；用尽后降级接受', () => {
  const classification = classifyStale([{ field: 'scrollHeight', before: 100, after: 200 }]);
  const first = planStaleRetry({ action: 'extend', classification, attempt: 0, waveCost: 1 });
  assert.equal(first.retry, true);
  assert.equal(first.action, 'extend');
  assert.equal(first.attempt, 1);
  assert.equal(first.backoffMs, 0);
  assert.equal(first.degrade, false);
  assert.ok(first.reasons[0].includes('第 1 次'));
  const second = planStaleRetry({ action: 'extend', classification, attempt: 1, waveCost: 1 });
  assert.equal(second.backoffMs, 200);
  const third = planStaleRetry({ action: 'extend', classification, attempt: 2 });
  assert.equal(third.retry, false);
  assert.equal(third.degrade, true);
  assert.ok(third.reasons[0].includes('用尽'));
});

test('planStaleRetry：accept 直接接受；预算耗尽降级；revisionOnly 走 rewrite', () => {
  const accepted = planStaleRetry({ action: 'accept' });
  assert.equal(accepted.retry, false);
  assert.equal(accepted.action, 'accept');
  assert.equal(accepted.reasons[0], '没有 stale，直接接受');
  const broke = planStaleRetry({
    action: 'retry',
    attempt: 0,
    waveCost: 100,
    budget: { maxRetryTiles: 10 },
  });
  assert.equal(broke.retry, false);
  assert.equal(broke.degrade, true);
  assert.ok(broke.reasons[0].includes('预算耗尽'));
  const revision = planStaleRetry({
    action: 'rewrite',
    classification: classifyStale([{ field: 'revision', before: 1, after: 2 }]),
    attempt: 0,
  });
  assert.equal(revision.action, 'rewrite');
  assert.equal(revision.discardFrames, false);
  const full = planStaleRetry({ action: 'retry', attempt: 0 });
  assert.equal(full.discardFrames, true);
});

test('summarizeStaleRetries：汇总次数/降级/原因', () => {
  const classification = classifyStale([{ field: 'scrollHeight', before: 100, after: 200 }]);
  const attempts = [
    planStaleRetry({ action: 'extend', classification, attempt: 0 }),
    planStaleRetry({ action: 'extend', classification, attempt: 1 }),
    planStaleRetry({ action: 'extend', classification, attempt: 2 }),
  ];
  attempts[0].classification = classification;
  const summary = summarizeStaleRetries(attempts, { maxAttempts: 2 });
  assert.equal(summary.attempts, 3);
  assert.equal(summary.retried, 2);
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.kinds, ['growth']);
  assert.equal(summary.lastBackoffMs, 0);
  const empty = summarizeStaleRetries(null);
  assert.equal(empty.attempts, 0);
  assert.equal(empty.degraded, false);
});

test('staleRetryWire/describeStaleRetry：协议与日志', () => {
  const classification = classifyStale([{ field: 'scrollWidth', before: 100, after: 200 }]);
  const decision = planStaleRetry({ action: 'retry', classification, attempt: 1, waveCost: 2 });
  const wire = staleRetryWire(decision);
  assert.equal(wire.retry, true);
  assert.equal(wire.action, 'retry');
  assert.equal(wire.attempt, 2);
  assert.equal(wire.backoff_ms, 200);
  assert.equal(wire.budget.exhausted, false);
  assert.match(describeStaleRetry({ ...decision, classification }), /stale 重试 2\/2 次（retry（width）/);
  assert.match(describeStaleRetry(planStaleRetry({ action: 'accept' })), /stale 不重试/);
  assert.match(describeStaleRetry(null), /stale 无决策/);
  assert.equal(staleRetryWire(null).retry, false);
});

test('addStaleCost：累加已用预算', () => {
  assert.deepEqual(addStaleCost({ tiles: 1, bytes: 2, elapsedMs: 3 }, { tiles: 1, bytes: 1, elapsedMs: 1 }), {
    tiles: 2, bytes: 3, elapsedMs: 4,
  });
  assert.deepEqual(addStaleCost(null, null), { tiles: 0, bytes: 0, elapsedMs: 0 });
});

test('默认常量：重试上限/退避表/预算', () => {
  assert.equal(STALE_DEFAULTS.maxAttempts, 2);
  assert.deepEqual(STALE_DEFAULTS.backoffMs.slice(), [0, 200, 600]);
  assert.equal(STALE_DEFAULTS.maxRetryTiles, 96);
});
