// cooperate 引用计数抑制：真实 capture-suppression + suppression-scope 接线（2 帧 ack/嵌套/看门狗）。
import test from 'node:test';
import assert from 'node:assert/strict';

const listener = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.3.0' }), onMessage: listener(), onConnect: listener(), onInstalled: listener(), onStartup: listener(), sendMessage: async () => ({}), getURL: (p) => 'chrome-extension://stub/' + p, lastError: null },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: listener(),
  },
  alarms: { create: async () => {}, onAlarm: listener() },
  tabs: { onRemoved: listener(), onUpdated: listener(), onCreated: listener(), onActivated: listener(), query: async () => [], get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://example.test/', title: 'p', index: 0 }), sendMessage: async () => ({ ok: true }) },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
};

const {
  createCooperationCoordinator,
  cooperationCoordinator,
  LEASE_KINDS,
} = await import('../../extension/src/lib/cooperate.js');
const { createCaptureSuppression, captureSuppression } = await import('../../extension/src/lib/capture-suppression.js');
const { createSuppressionScope, suppressionScope, SUPPRESSION_OUTCOMES, SUPPRESSION_KINDS } = await import('../../extension/src/lib/suppression-scope.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');

/** 可手动推进的 rAF 队列：一帧一帧 flush，验证 2 帧 ack。 */
function createFrameQueue() {
  const queue = [];
  const raf = (callback) => { queue.push(callback); };
  const flush = (frames = 1) => {
    for (let index = 0; index < frames; index += 1) {
      const batch = queue.splice(0, queue.length);
      for (const callback of batch) callback();
    }
  };
  return { raf, flush, queued: () => queue.length };
}

/** 可手动触发的定时器：验证抑制作用域看门狗（fail closed）。 */
function createTimerQueue() {
  const timers = [];
  let sequence = 0;
  return {
    timers,
    setTimeout: (fn, ms) => {
      sequence += 1;
      const handle = { id: sequence, fn, ms };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
    },
    flush: () => {
      const batch = timers.splice(0, timers.length);
      for (const handle of batch) handle.fn();
      return batch.length;
    },
  };
}

/**
 * 真实抑制栈世界：capture-suppression（引用计数 + 2 帧 ack）→ suppression-scope（看门狗）
 * → cooperation coordinator（passthrough 租约）。
 */
function world(options = {}) {
  let clock = options.start || 1000;
  const now = () => clock;
  const advance = (ms) => { clock += ms; return clock; };
  const frames = createFrameQueue();
  const timer = createTimerQueue();
  const capture = createCaptureSuppression({ raf: frames.raf, now });
  const scope = createSuppressionScope({ suppression: capture, now, maxHoldMs: options.maxHoldMs || 180000, timers: timer });
  const tokens = createPassthroughTokens({ now });
  const human = createHumanGate({ now });
  const controller = createControllerStateMachine({ now });
  const coordinator = createCooperationCoordinator({ now, tokens, human, controller, suppression: scope, capture });
  return { now, advance, frames, timer, capture, scope, tokens, human, controller, coordinator };
}

test('2 帧 ack：acquire 后尚未生效，两帧渲染后才 effective', () => {
  const w = world();
  const lease = w.coordinator.acquire(1, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  assert.equal(lease.ok, true);
  assert.equal(lease.suppression.kind, SUPPRESSION_KINDS.NATIVE_INPUT);
  assert.equal(lease.suppression.ok, true);
  assert.equal(lease.suppression.count, 1);
  const snapshot = w.capture.snapshot(1);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.effective, false, '2 帧 ack 前不应生效');
  assert.equal(snapshot.pending.length, 1);
  w.frames.flush(1);
  assert.equal(w.capture.snapshot(1).effective, false, '一帧后还不应生效');
  w.frames.flush(1);
  assert.equal(w.capture.snapshot(1).effective, true, '两帧后生效');
  assert.equal(w.capture.snapshot(1).acked, 1);
  w.coordinator.release(lease.handle, { outcome: SUPPRESSION_OUTCOMES.OK });
  assert.equal(w.capture.snapshot(1).count, 0);
  assert.equal(w.capture.snapshot(1).active, false);
});

test('嵌套引用计数：两层租约 → 计数 2；释放一层仍生效，最后归零', () => {
  const w = world();
  const native = w.coordinator.acquire(2, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'fill' });
  const shot = w.coordinator.acquire(2, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  assert.equal(w.capture.snapshot(2).count, 2);
  w.frames.flush(2);
  assert.equal(w.capture.snapshot(2).effective, true);
  const releasedOne = w.coordinator.release(native.handle);
  assert.equal(releasedOne.suppression.released, true);
  assert.equal(w.capture.snapshot(2).count, 1, '还有一层引用时不解除');
  assert.equal(w.capture.snapshot(2).effective, true);
  const releasedLast = w.coordinator.release(shot.handle);
  assert.equal(releasedLast.suppression.released, true);
  assert.equal(w.capture.snapshot(2).count, 0);
  assert.equal(w.capture.snapshot(2).effective, false);
});

test('多类别并行：capture/native-input/record-shot 三个作用域同时持有', () => {
  const w = world();
  const first = w.coordinator.acquire(3, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  const second = w.coordinator.acquire(3, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  const third = w.coordinator.acquire(3, { kind: LEASE_KINDS.RECORD_SHOT, method: 'record' });
  assert.deepEqual([first.suppression.kind, second.suppression.kind, third.suppression.kind], ['native-input', 'capture', 'record-shot']);
  const snapshot = w.scope.snapshot(3);
  assert.equal(snapshot.live.length, 3);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.count, 3);
  assert.deepEqual(snapshot.counters.begun, 3);
  assert.equal(snapshot.counters.peakCount, 3);
  w.coordinator.release(first.handle);
  w.coordinator.release(second.handle);
  w.coordinator.release(third.handle);
  assert.equal(w.scope.snapshot(3).live.length, 0);
  assert.equal(w.scope.snapshot(3).count, 0);
  assert.equal(w.scope.snapshot(3).counters.ended, 3);
});

test('释放证据：heldMs/outcome/scope 结果与 coordinator 快照一致', () => {
  const w = world();
  const lease = w.coordinator.acquire(4, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  w.advance(250);
  const released = w.coordinator.release(lease.handle, { outcome: SUPPRESSION_OUTCOMES.ERROR });
  assert.equal(released.evidence.heldMs, 250);
  assert.equal(released.evidence.suppression.outcome, 'error');
  assert.equal(released.evidence.suppression.released, true);
  assert.equal(released.evidence.suppression.evidence.outcome, 'error');
  const recent = w.scope.recent(4);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].outcome, 'error');
  assert.equal(recent[0].kind, 'native-input' === recent[0].kind ? recent[0].kind : 'capture');
  assert.equal(released.evidence.revisions.stale, false);
});

test('看门狗：超过 maxHoldMs 自动释放作用域，随后 coordinator 释放不抛异常', () => {
  const w = world({ maxHoldMs: 1000 });
  const lease = w.coordinator.acquire(5, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  assert.equal(w.timer.timers.length, 1, 'begin 时登记看门狗');
  w.advance(1500);
  const fired = w.timer.flush();
  assert.equal(fired, 1);
  const afterWatchdog = w.capture.snapshot(5);
  assert.equal(afterWatchdog.count, 0, '看门狗已释放引用');
  const history = w.scope.snapshot(5).history;
  assert.equal(history.some((entry) => entry.kind === 'expired'), true);
  const released = w.coordinator.release(lease.handle);
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.suppression.alreadyReleased, true);
  assert.equal(released.suppression.outcome, 'expired');
});

test('action 类租约不触发抑制（连引用都不拿）', () => {
  const w = world();
  const lease = w.coordinator.acquire(6, { kind: LEASE_KINDS.ACTION, method: 'click' });
  assert.equal(lease.suppression, null);
  assert.equal(w.capture.snapshot(6).count, 0);
  assert.equal(w.scope.snapshot(6).live.length, 0);
  assert.equal(w.scope.snapshot(6).counters.begun, 0);
  w.coordinator.release(lease.handle);
  assert.equal(w.capture.snapshot(6).count, 0);
});

test('releaseAll/reset：所有抑制作用域与被抑制引用一并归零', () => {
  const w = world();
  w.coordinator.acquire(7, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  w.coordinator.acquire(7, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  w.coordinator.acquire(8, { kind: LEASE_KINDS.RECORD_SHOT, method: 'record' });
  assert.equal(w.scope.snapshot(7).live.length + w.scope.snapshot(8).live.length, 3);
  const released = w.coordinator.releaseAll(7);
  assert.equal(released.released, 2);
  assert.equal(w.scope.snapshot(7).live.length, 0);
  assert.equal(w.capture.snapshot(7).count, 0);
  assert.equal(w.scope.snapshot(8).live.length, 1, '别的 tab 不受影响');
  w.coordinator.releaseAll(8);
  w.scope.reset();
  assert.equal(w.scope.snapshot(null).live.length, 0);
  assert.equal(w.capture.list().length, 0);
});

test('抑制与 token 双清理：异常结局下两者都释放（证据完整）', () => {
  const w = world();
  const lease = w.coordinator.acquire(9, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'fill' });
  assert.equal(w.tokens.list('coop:9').length, 1);
  const released = w.coordinator.release(lease.handle, { outcome: 'timeout' });
  assert.equal(released.token.ok, true);
  assert.equal(released.token.usedAt > 0, true);
  assert.equal(w.capture.snapshot(9).count, 0);
  assert.equal(w.scope.snapshot(9).live.length, 0);
  assert.equal(released.suppression.outcome, 'timeout');
  assert.equal(w.scope.snapshot(9).history.some((entry) => entry.outcome === 'timeout'), true);
});

test('乱序释放中间层：计数正确递减，作用域一一对应', () => {
  const w = world();
  const first = w.coordinator.acquire(10, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'a' });
  const second = w.coordinator.acquire(10, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'b' });
  const third = w.coordinator.acquire(10, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'c' });
  assert.equal(w.capture.snapshot(10).count, 3);
  w.coordinator.release(second.handle);
  assert.equal(w.capture.snapshot(10).count, 2);
  const live = w.scope.snapshot(10).live;
  assert.equal(live.length, 2);
  assert.equal(live.some((scope) => scope.scopeId === second.suppression.scopeId), false);
  w.coordinator.release(third.handle);
  w.coordinator.release(first.handle);
  assert.equal(w.capture.snapshot(10).count, 0);
  assert.equal(w.scope.snapshot(10).counters.ended, 3);
});

test('真实单例接线：cooperationCoordinator 与 suppressionScope/captureSuppression 共用同一份计数', () => {
  const lease = cooperationCoordinator.acquire(101, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click', respectHuman: false });
  assert.equal(lease.ok, true);
  const captureCount = captureSuppression.snapshot(101).count;
  assert.equal(captureCount, 1, '单例 coordinator 驱动单例 captureSuppression');
  assert.equal(suppressionScope.snapshot(101).live.length, 1, '单例 suppressionScope 看到同一作用域');
  const released = cooperationCoordinator.release(lease.handle);
  assert.equal(released.released, true);
  assert.equal(captureSuppression.snapshot(101).count, 0);
  assert.equal(suppressionScope.snapshot(101).live.length, 0);
});

test('coordinator 快照里的抑制证据：active/count/holders/live 与真实状态一致', () => {
  const w = world();
  const lease = w.coordinator.acquire(11, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  w.frames.flush(2);
  const snapshot = w.coordinator.snapshot(11);
  assert.equal(snapshot.suppression.active, true);
  assert.equal(snapshot.suppression.count, 1);
  assert.equal(snapshot.suppression.effective, true);
  assert.equal(snapshot.suppression.holders.length, 1);
  assert.equal(snapshot.suppression.holders[0].owner, 'cooperate:capture');
  assert.equal(snapshot.suppression.live.length, 1);
  assert.equal(snapshot.suppression.live[0].method, 'screenshot');
  w.coordinator.release(lease.handle);
  const after = w.coordinator.snapshot(11);
  assert.equal(after.suppression.active, false);
  assert.equal(after.suppression.count, 0);
});

test('suppress:false 只跳过抑制，不改变租约/令牌引用计数', () => {
  const w = world();
  const lease = w.coordinator.acquire(12, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot', suppress: false });
  assert.equal(lease.suppression, null);
  assert.equal(lease.evidence.suppression, null);
  assert.equal(w.capture.snapshot(12).count, 0);
  assert.equal(w.coordinator.snapshot(12).depth, 1);
  assert.equal(w.tokens.list('coop:12').length, 1);
  const released = w.coordinator.release(lease.handle);
  assert.equal(released.released, true);
  assert.equal(released.suppression, null);
  assert.equal(released.token.ok, true);
});

test('抑制历史有界且记录结局（scope.recent 只看本 tab）', () => {
  const w = world();
  for (let index = 0; index < 10; index += 1) {
    const lease = w.coordinator.acquire(13, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'm' + index });
    w.coordinator.release(lease.handle, { outcome: index % 2 === 0 ? 'ok' : 'error' });
  }
  const recent = w.scope.recent(13);
  assert.equal(recent.length, 8, '历史有界（最近 8 条）');
  const outcomes = new Set(recent.map((entry) => entry.outcome));
  assert.equal(outcomes.has('ok'), true);
  assert.equal(outcomes.has('error'), true);
  assert.equal(w.scope.recent(999).length, 0);
  assert.equal(w.scope.counters().begun, 10);
  assert.equal(w.scope.counters().ended, 10);
});
