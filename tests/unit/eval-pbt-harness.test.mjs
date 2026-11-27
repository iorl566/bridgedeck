import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCode,
  createDeferred,
  createLedgerHarness,
  createManualClock,
  createQueueHarness,
  difference,
  flushMicrotasks,
  idsOf,
  jsonClone,
  ledgerEntryProjection,
  parseWalFrames,
  settleAll,
  stableKey,
} from '../../tools/eval/lib/harness.mjs';
import { createSessionQueue } from '../../lib/session-queue.mjs';

test('手动时钟：advance/set/iso/advances 确定且拒绝非法值', () => {
  const clock = createManualClock(1000);
  assert.equal(clock.now(), 1000);
  assert.equal(clock.advance(500), 1500);
  assert.equal(clock.now(), 1500);
  assert.equal(clock.advances(), 1);
  assert.equal(clock.set(42), 42);
  assert.equal(clock.value(), 42);
  assert.equal(clock.iso(), '1970-01-01T00:00:00.042Z');
  assert.throws(() => clock.advance('x'), TypeError);
  assert.equal(clock.advances(), 1);
});

test('Deferred：手动 resolve/reject，标签保留', async () => {
  const deferred = createDeferred('unit');
  assert.equal(deferred.label, 'unit');
  const pending = deferred.promise.then((value) => value * 2);
  deferred.resolve(21);
  await flushMicrotasks();
  assert.equal(await pending, 42);
  const failing = createDeferred('fail');
  const observed = failing.promise.catch((error) => error.message);
  failing.reject(new Error('boom'));
  assert.equal(await observed, 'boom');
});

test('captureCode / jsonClone / stableKey / idsOf / difference', () => {
  assert.equal(captureCode(() => 1).ok, true);
  const captured = captureCode(() => { const error = new Error('x'); error.code = 'E_X'; throw error; });
  assert.equal(captured.ok, false);
  assert.equal(captured.code, 'E_X');
  assert.equal(captured.message, 'x');
  assert.deepEqual(jsonClone(undefined), null);
  assert.deepEqual(jsonClone({ a: [1] }), { a: [1] });
  assert.equal(stableKey({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.deepEqual(idsOf([{ id: 'a' }, { id: 'b' }]), ['a', 'b']);
  assert.deepEqual(idsOf([{ ref: 'r' }], 'ref'), ['r']);
  assert.deepEqual(difference([1, 2, 3], [2]), [1, 3]);
});

test('parseWalFrames：合法/损坏/空行分别处理', () => {
  const frames = parseWalFrames('{"a":1}\n\nnot-json\n{"b":2}\n');
  assert.equal(frames.length, 3);
  assert.equal(frames[0].frame.a, 1);
  assert.equal(frames[1].error !== null, true);
  assert.equal(frames[2].frame.b, 2);
  assert.deepEqual(parseWalFrames(''), []);
  assert.deepEqual(parseWalFrames(null), []);
});

test('队列夹具：提交/释放/结算/快照', async () => {
  const harness = createQueueHarness(createSessionQueue, { capacity: 3 });
  const first = harness.submit('s', { tag: 'first' });
  const second = harness.submit('s', { tag: 'second' });
  await flushMicrotasks(4);
  assert.equal(harness.snapshot()[0].pending, 2);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  const outcomes = await releaseAndSettle(harness, [first, second]);
  assert.deepEqual(harness.order, ['first', 'second']);
  assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, true]);
  assert.equal(harness.snapshot()[0].pending, 0);
});

async function releaseAndSettle(harness, tokens) {
  for (const token of tokens) token.deferred.resolve(token.value);
  await flushMicrotasks(16);
  return Promise.all(tokens.map((token) => token.promise));
}

test('队列夹具：失败任务回传错误码，settleAll 清理挂起任务', async () => {
  const harness = createQueueHarness(createSessionQueue, { capacity: 4 });
  const failing = harness.submit('s', { tag: 'fail', hold: false, succeed: false });
  const outcome = await failing.promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'E_TASK');
  const held = harness.submit('s', { tag: 'held' });
  await settleAll(harness);
  assert.equal(held.started, true);
  assert.deepEqual(await settleAll(null), undefined);
});

test('账本夹具：begin/finish/flush 与 WAL/快照视图', () => {
  const harness = createLedgerHarness({ start: 5000, staleMs: 1000 });
  const entry = harness.begin('click', { ref: '@e1' }, { tabId: 7, sessionId: 's1' });
  assert.equal(entry.state, 'active');
  assert.equal(harness.walFrames().length, 1);
  harness.finish(entry, 'done');
  assert.equal(harness.walFrames().length, 2);
  assert.equal(harness.flush().entries.total, 1);
  assert.equal(harness.snapshotEntries().length, 1);
  assert.equal(harness.walText(), '');
  const projection = ledgerEntryProjection(entry);
  assert.equal(projection.state, 'done');
  assert.equal(projection.method, 'click');
  assert.equal(projection.tabId, 7);
  assert.deepEqual(projection.keys, ['ref']);
  assert.equal(ledgerEntryProjection(null), null);
});

test('账本夹具：手动时钟推进驱动 stale 判定', () => {
  const harness = createLedgerHarness({ staleMs: 1000 });
  harness.begin('click', {}, { tabId: 1 });
  harness.clock.advance(500);
  assert.equal(harness.ledger.status().pending.length, 1);
  assert.equal(harness.ledger.status().pending[0].state, 'active');
  harness.clock.advance(501);
  const status = harness.ledger.status();
  assert.equal(status.pending[0].state, 'stale');
  assert.equal(harness.flushStats().entries.total, 1);
});
