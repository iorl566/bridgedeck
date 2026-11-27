// cooperate passthrough 引用计数租约：嵌套 acquire/release、抑制接线、人机互斥、释放证据。
// 真实模块 + 注入依赖（时钟/令牌/抑制/controller），不复制实现。
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
  LEASE_ERROR,
  HANDOFF_STATES,
  SUPPRESSION_KIND_FOR,
  normalizeCooperationTabId,
  normalizeLeaseKind,
  summarizeLease,
  revisionVector,
  evidenceDigest,
  describeCooperationState,
} = await import('../../extension/src/lib/cooperate.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');
const { createSuppressionScope } = await import('../../extension/src/lib/suppression-scope.js');
const { createCaptureSuppression } = await import('../../extension/src/lib/capture-suppression.js');
const { clearControlGeneration, controlGenerationRecord } = await import('../../extension/src/control-generation.js');

const emptyVector = () => ({ controlRevision: 0, authorityRevision: 0, revision: 0, frameEpoch: 0, epoch: 0, generation: 0 });

/**
 * 组装一个完全隔离的协作世界：
 *   - 真实 passthrough token 存储（时钟可注入）；
 *   - 真实 human-gate / controller-state；
 *   - 记录型抑制桩（begin/end 序列可断言）；
 *   - revision 计数用内存 Map（避免跨测试污染真实 revision-chain）。
 */
function world(start = 1000, overrides = {}) {
  let clock = start;
  const now = () => clock;
  const advance = (ms) => { clock += ms; return clock; };
  const tokens = createPassthroughTokens({ now });
  const human = createHumanGate({ now });
  const controller = createControllerStateMachine({ now });
  const begun = [];
  const ended = [];
  const suppression = {
    begin(tabId, options = {}) {
      const scopeId = 'sup-' + (begun.length + 1);
      begun.push({ tabId, ...options, scopeId });
      return { ok: true, scopeId, count: begun.length - ended.length };
    },
    end(tabId, options = {}) {
      ended.push({ tabId, ...options });
      return { ok: true, released: true, scopeId: options.scopeId, outcome: options.outcome, evidence: { scopeId: options.scopeId, outcome: options.outcome } };
    },
    snapshot(tabId) {
      return { tabId, active: begun.length > ended.length, count: begun.length - ended.length, live: [], counters: { begun: begun.length, ended: ended.length } };
    },
  };
  const capture = { snapshot: () => ({ count: begun.length - ended.length, effective: false, holders: [], pending: [] }) };
  const revisions = new Map();
  const revisionRecord = (tabId) => ({ ...emptyVector(), ...(revisions.get(tabId) || {}) });
  const bumpRevisions = (tabId, delta = {}) => {
    const next = { ...revisionRecord(tabId) };
    for (const [field, value] of Object.entries(delta)) next[field] = (next[field] || 0) + (typeof value === 'number' ? value : 1);
    revisions.set(tabId, next);
    return next;
  };
  const alignRevisions = (tabId, remote = {}) => ({
    ok: true,
    tabId,
    stale: true,
    side: 'remote',
    fields: [{ field: 'controlRevision', local: 0, remote: Number(remote.controlRevision) || 1, delta: 1, side: 'remote' }],
    aligned: { ...revisionRecord(tabId), controlRevision: Number(remote.controlRevision) || 1 },
    local: revisionRecord(tabId),
    remote,
    evidence: { alignedAt: clock },
  });
  const coordinator = createCooperationCoordinator({
    now,
    tokens,
    human,
    controller,
    suppression,
    capture,
    revisionRecord,
    bumpRevisions,
    alignRevisions,
    maxTabs: 8,
    ...overrides,
  });
  return { now, advance, tokens, human, controller, suppression, capture, coordinator, begun, ended, revisions, revisionRecord };
}

test('嵌套 acquire 是栈式引用计数：depth 1→2→1→0，每次签发独立 token', () => {
  const w = world();
  const first = w.coordinator.acquire(1, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  assert.equal(first.ok, true);
  assert.equal(first.depth, 1);
  assert.equal(first.count, 1);
  assert.equal(first.tabId, 1);
  assert.match(first.leaseId, /^coop-lease-/);
  assert.ok(first.token && first.token.length > 8, '应签发 token');
  assert.equal(first.handle.leaseId, first.leaseId);

  const second = w.coordinator.acquire(1, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  assert.equal(second.ok, true);
  assert.equal(second.depth, 2, '嵌套 acquire 深度 +1');
  assert.notEqual(second.token, first.token, '每一层都应签发独立 token');

  const releasedFirst = w.coordinator.release(first.handle, { outcome: 'ok' });
  assert.equal(releasedFirst.released, true);
  assert.equal(releasedFirst.depth, 1);
  assert.equal(w.coordinator.snapshot(1).depth, 1, '还有一层时租约仍活');

  const releasedSecond = w.coordinator.release(second.handle, { outcome: 'ok' });
  assert.equal(releasedSecond.released, true);
  assert.equal(releasedSecond.depth, 0);
  assert.equal(w.coordinator.snapshot(1).depth, 0);
  assert.equal(w.tokens.list('coop:1').length, 2);
  assert.equal(w.tokens.list('coop:1').every((record) => record.used === true), true, '两层 token 都已被消费');
});

test('引用计数抑制：每层 acquire/end 一一对应，最外层释放后抑制计数归零', () => {
  const w = world();
  const a = w.coordinator.acquire(2, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'fill' });
  const b = w.coordinator.acquire(2, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'press' });
  assert.equal(w.begun.length, 2);
  assert.equal(w.ended.length, 0);
  assert.equal(w.coordinator.snapshot(2).suppression.live.length, 0, '记录型抑制桩没有 live 列表，但计数可见');
  const endedA = w.coordinator.release(a.handle);
  assert.equal(endedA.suppression.released, true);
  assert.equal(w.ended.length, 1);
  assert.equal(w.ended[0].scopeId, a.suppression.scopeId);
  const endedB = w.coordinator.release(b.handle);
  assert.equal(endedB.suppression.released, true);
  assert.equal(w.ended.length, 2);
  assert.equal(w.begun.length - w.ended.length, 0);
});

test('深度上限拒绝 E_LEASE_DEPTH，拒绝时不再签发 token', () => {
  const w = world();
  for (let index = 0; index < 3; index += 1) {
    const lease = w.coordinator.acquire(3, { kind: LEASE_KINDS.ACTION, maxDepth: 3 });
    assert.equal(lease.ok, true, '第 ' + (index + 1) + ' 层应成功');
  }
  const before = w.tokens.counter().minted;
  const rejected = w.coordinator.acquire(3, { kind: LEASE_KINDS.ACTION, maxDepth: 3 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, LEASE_ERROR.DEPTH);
  assert.equal(rejected.evidence.maxDepth, 3);
  assert.equal(w.tokens.counter().minted, before, '拒绝路径不花 token');
  w.coordinator.releaseAll(3);
});

test('非法 tabId / kind 返回结构化失败，不抛异常', () => {
  const w = world();
  const badTab = w.coordinator.acquire(null, { kind: LEASE_KINDS.ACTION });
  assert.equal(badTab.ok, false);
  assert.equal(badTab.code, LEASE_ERROR.BAD_ARG);
  assert.equal(badTab.evidence.reason, 'bad-tab');
  const badKind = w.coordinator.acquire(4, { kind: 'telepathy' });
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, LEASE_ERROR.BAD_KIND);
  assert.match(badKind.error, /telepathy/);
  const badOptions = w.coordinator.acquire(4, 'nope');
  assert.equal(badOptions.ok, false);
  assert.equal(badOptions.code, LEASE_ERROR.BAD_ARG);
  assert.equal(normalizeCooperationTabId(''), null);
  assert.equal(normalizeCooperationTabId('5'), 5);
  assert.equal(normalizeLeaseKind('capture'), 'capture');
  assert.equal(normalizeLeaseKind('CAPTURE'), null);
});

test('kind → 抑制作用域映射：输入/截图/录制抑制，纯 action 不抑制', () => {
  const w = world();
  assert.equal(SUPPRESSION_KIND_FOR[LEASE_KINDS.NATIVE_INPUT], 'native-input');
  assert.equal(SUPPRESSION_KIND_FOR[LEASE_KINDS.CAPTURE], 'capture');
  assert.equal(SUPPRESSION_KIND_FOR[LEASE_KINDS.RECORD_SHOT], 'record-shot');
  assert.equal(SUPPRESSION_KIND_FOR[LEASE_KINDS.ACTION], undefined);

  const action = w.coordinator.acquire(5, { kind: LEASE_KINDS.ACTION, method: 'click' });
  assert.equal(action.suppression, null, 'action 类租约不抑制浮层');
  assert.equal(w.begun.length, 0);

  const native = w.coordinator.acquire(5, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  assert.deepEqual(native.suppression, { ok: true, kind: 'native-input', scopeId: native.suppression.scopeId, code: null, count: 1 });
  assert.equal(w.begun[0].owner, 'cooperate:native-input');

  const shot = w.coordinator.acquire(5, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  assert.equal(shot.suppression.kind, 'capture');

  const suppressedOff = w.coordinator.acquire(5, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot', suppress: false });
  assert.equal(suppressedOff.suppression, null);
  assert.equal(w.begun.length, 2, 'suppress:false 不 begin 抑制');
  w.coordinator.releaseAll(5);
});

test('release 幂等：重复释放返回 alreadyReleased，不重复消费 token', () => {
  const w = world();
  const lease = w.coordinator.acquire(6, { kind: LEASE_KINDS.ACTION });
  const first = w.coordinator.release(lease.handle);
  assert.equal(first.released, true);
  const again = w.coordinator.release(lease.handle);
  assert.equal(again.ok, true);
  assert.equal(again.released, false);
  assert.equal(again.alreadyReleased, true);
  assert.equal(w.tokens.counter().consumed, 1, 'token 只消费一次');
  const unknown = w.coordinator.release('missing-lease');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.code, LEASE_ERROR.UNKNOWN);
});

test('release 证据：token 打码 + 抑制结局 + 四项 revision 前后向量', () => {
  const w = world();
  const lease = w.coordinator.acquire(7, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'fill' });
  w.advance(125);
  const released = w.coordinator.release(lease.handle, { outcome: 'error' });
  const evidence = released.evidence;
  assert.equal(evidence.heldMs, 125);
  assert.equal(evidence.outcome, 'error');
  assert.match(evidence.token.token, /…/, '证据里的 token 必须打码');
  assert.equal(evidence.token.token, lease.token.slice(0, 6) + '…' + lease.token.slice(-6));
  assert.equal(evidence.suppression.outcome, 'error');
  assert.equal(evidence.suppression.released, true);
  assert.deepEqual(evidence.revisions.before, emptyVector());
  assert.deepEqual(evidence.revisions.after, emptyVector());
  assert.equal(evidence.revisions.stale, false);
  assert.equal(evidence.depthAfter, 0);
});

test('ttl 过期：release 仍成功但 token 证据是 E_TOKEN_EXPIRED（不抛异常）', () => {
  const w = world();
  const lease = w.coordinator.acquire(8, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot', ttlMs: 500 });
  assert.equal(lease.ok, true);
  w.advance(800);
  const released = w.coordinator.release(lease.handle);
  assert.equal(released.released, true);
  assert.equal(released.token.ok, false);
  assert.equal(released.token.code, 'E_TOKEN_EXPIRED');
  assert.equal(released.suppression.released, true, 'token 失败也要释放抑制');
  const external = w.coordinator.acquire(8, { kind: LEASE_KINDS.ACTION, ttlMs: 100 });
  w.tokens.consume(external.token, external.handle ? 'coop:8' : 'coop:8');
  const second = w.coordinator.release(external.handle);
  assert.equal(second.token.code, 'E_TOKEN_USED', '被外部消费过的 token 给结构化错误');
});

test('人机互斥：人工活动窗口内拒绝签发，force 才放行', () => {
  const w = world();
  const noted = w.coordinator.noteHuman(9, { at: w.now(), kind: 'key', source: 'content-activity' });
  assert.equal(noted.ok, true);
  assert.equal(w.human.active(9), true);

  const blocked = w.coordinator.acquire(9, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'press' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, LEASE_ERROR.HUMAN_ACTIVE);
  assert.equal(blocked.human.state, 'human-active');
  assert.equal(blocked.evidence.reason, 'human-exclusive');
  assert.equal(w.tokens.counter().minted, 0);

  const forced = w.coordinator.acquire(9, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'press', force: true });
  assert.equal(forced.ok, true, 'force（Agent 明确覆盖）可以签发');
  w.coordinator.releaseAll(9);
});

test('冷却窗：settle 后处于 cooling 仍拒绝，冷却结束才恢复', () => {
  const w = world();
  w.coordinator.noteHuman(10, { at: w.now(), kind: 'key' });
  w.advance(2100);
  const settled = w.coordinator.snapshot(10).human;
  assert.equal(settled.state, 'human-active', '快照是只读的，没推进状态机');
  w.human.settle(10, { now: w.now() });
  assert.equal(w.human.state(10).state, 'cooling');
  const blocked = w.coordinator.acquire(10, { kind: LEASE_KINDS.ACTION });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, LEASE_ERROR.HUMAN_ACTIVE);
  assert.equal(blocked.human.cooling, true);
  w.advance(1000);
  w.human.settle(10, { now: w.now() });
  const allowed = w.coordinator.acquire(10, { kind: LEASE_KINDS.ACTION });
  assert.equal(allowed.ok, true, '冷却结束恢复签发');
  w.coordinator.releaseAll(10);
});

test('noteHuman 发现活跃租约记冲突；release:true 立即撤销全部租约', () => {
  const w = world();
  const lease = w.coordinator.acquire(11, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  assert.equal(lease.ok, true);
  const conflict = w.coordinator.noteHuman(11, { at: w.now(), kind: 'pointer' });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.activeLeases, 1);
  assert.equal(w.coordinator.snapshot(11).conflicts, 1);

  const preempted = w.coordinator.noteHuman(11, { at: w.now(), kind: 'pointer', release: true });
  assert.equal(preempted.released.released, 1);
  assert.equal(preempted.released.remaining, 0);
  assert.equal(w.coordinator.snapshot(11).depth, 0);
  assert.equal(w.tokens.counter().revoked, 1, 'noteHuman release:true 走 revokeTokens 路径');
  const revoked = w.coordinator.releaseAll(11, { revokeTokens: true });
  assert.equal(revoked.released, 0);
});

test('releaseAll 倒序释放并 revokeTokens：留下逐条证据、计数归零', () => {
  const w = world({
  });
  const first = w.coordinator.acquire(12, { kind: LEASE_KINDS.ACTION });
  const second = w.coordinator.acquire(12, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' });
  assert.equal(w.coordinator.releaseAll(12).released, 2);
  const all = w.coordinator.releaseAll(12);
  assert.equal(all.released, 0);
  assert.equal(all.evidence.released, 0);
  void first;
  void second;
});

test('withLease 成功路径自动释放；异常路径把证据塞进 error.data.cooperation', async () => {
  const w = world();
  const result = await w.coordinator.withLease(13, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' }, async (lease) => {
    assert.equal(lease.ok, true);
    assert.equal(w.coordinator.snapshot(13).depth, 1);
    return { clicked: true };
  });
  assert.deepEqual(result, { clicked: true });
  assert.equal(w.coordinator.snapshot(13).depth, 0, 'finally 里已释放');

  await assert.rejects(
    () => w.coordinator.withLease(13, { kind: LEASE_KINDS.CAPTURE, method: 'screenshot' }, async () => {
      throw Object.assign(new Error('shot failed'), { code: 'E_SHOT' });
    }),
    (error) => {
      assert.equal(error.code, 'E_SHOT');
      assert.equal(error.data.cooperation.outcome, 'error');
      assert.equal(error.data.cooperation.released, true);
      return true;
    },
  );
  assert.equal(w.coordinator.snapshot(13).depth, 0);
});

test('withLease 人工互斥 fail closed 不执行回调；failOpen 才执行', async () => {
  const w = world();
  w.coordinator.noteHuman(14, { at: w.now(), kind: 'key' });
  let called = 0;
  const blocked = await w.coordinator.withLease(14, { kind: LEASE_KINDS.ACTION }, async () => { called += 1; return 'x'; });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, LEASE_ERROR.HUMAN_ACTIVE);
  assert.equal(called, 0);

  const open = await w.coordinator.withLease(14, { kind: LEASE_KINDS.ACTION, failOpen: true, force: true }, async () => { called += 1; return 'y'; });
  assert.equal(open, 'y');
  assert.equal(called, 1);

  await assert.rejects(() => w.coordinator.withLease(14, { kind: LEASE_KINDS.ACTION }, null), /需要函数/);
});

test('mayAct：controller held 时拒绝（E_SESSION_PAUSED）', () => {
  const w = world();
  const held = w.controller.transition(15, 'hold.engage', { source: 'test.hold' });
  assert.equal(held.ok, true);
  const decided = w.coordinator.mayAct(15, { method: 'click' });
  assert.equal(decided.allowed, false);
  assert.equal(decided.code, 'E_SESSION_PAUSED');
  assert.equal(decided.evidence.source, 'controller');
  assert.equal(decided.evidence.controller.state, 'held');
  w.controller.transition(15, 'hold.release', { source: 'test.release' });
  const allowed = w.coordinator.mayAct(15, { method: 'read' });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, null);
});

test('mayAct：借用确认 pending 拒绝并保留 requestId 证据', () => {
  const w = world();
  const decided = w.coordinator.mayAct(16, {
    method: 'click',
    borrowGate: { allowed: false, code: 'E_BORROW_CONFLICT', evidence: { requestId: 'req-16', pendingMs: 900 } },
  });
  assert.equal(decided.allowed, false);
  assert.equal(decided.code, 'E_BORROW_CONFLICT');
  assert.equal(decided.evidence.source, 'borrow');
  assert.equal(decided.evidence.borrow.requestId, 'req-16');
});

test('mayAct：人工活跃/冷却拒绝，稳定后放行；requireLease 额外要求租约', () => {
  const w = world();
  w.coordinator.noteHuman(17, { at: w.now(), kind: 'pointer' });
  const human = w.coordinator.mayAct(17, { method: 'click' });
  assert.equal(human.allowed, false);
  assert.equal(human.code, 'E_HUMAN_GATE');
  w.advance(3000);
  w.human.settle(17, { now: w.now() });
  const allowed = w.coordinator.mayAct(17, { method: 'click' });
  assert.equal(allowed.allowed, true);
  const needLease = w.coordinator.mayAct(17, { method: 'click', requireLease: true });
  assert.equal(needLease.allowed, false);
  assert.equal(needLease.code, LEASE_ERROR.REQUIRED);
  w.coordinator.acquire(17, { kind: LEASE_KINDS.ACTION });
  const withLease = w.coordinator.mayAct(17, { method: 'click', requireLease: true });
  assert.equal(withLease.allowed, true);
  w.coordinator.releaseAll(17);
});

test('快照/摘要：租约栈、人工、抑制、controller、revision 一次读全', () => {
  const w = world();
  w.coordinator.acquire(18, { kind: LEASE_KINDS.NATIVE_INPUT, method: 'click' });
  const snapshot = w.coordinator.snapshot(18);
  assert.equal(snapshot.tabId, 18);
  assert.equal(snapshot.valid, true);
  assert.equal(snapshot.depth, 1);
  assert.equal(snapshot.leases.length, 1);
  assert.match(snapshot.leases[0].token, /…/, '摘要里的 token 打码');
  assert.equal(typeof summarizeLease(snapshot.leases[0]).leaseId, 'string');
  assert.equal(snapshot.handoff.state, HANDOFF_STATES.IDLE);
  assert.equal(snapshot.human.state, 'idle');
  assert.equal(snapshot.suppression.active, true);
  assert.equal(snapshot.revisions.generation, 0);
  assert.equal(snapshot.lastAction.count, 0);
  const summary = w.coordinator.summary(18);
  assert.match(summary, /leases=1/);
  assert.match(describeCooperationState(snapshot), /handoff=idle/);
  assert.equal(w.coordinator.snapshot(null).valid, false);
});

test('forget 清空租约并撤销 token、清人机状态', () => {
  const w = world();
  w.coordinator.acquire(19, { kind: LEASE_KINDS.ACTION });
  w.coordinator.noteHuman(19, { at: w.now(), kind: 'key' });
  const forgotten = w.coordinator.forget(19);
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.released, 1);
  assert.equal(w.coordinator.snapshot(19).depth, 0);
  assert.equal(w.human.state(19).lastAt, 0, '人机状态已清');
  assert.equal(w.coordinator.forget('bad').ok, false);
});

test('maxTabs 有界：超过上限驱逐最旧 tab 记录', () => {
  const w = world(1000, { maxTabs: 2 });
  w.coordinator.acquire(101, { kind: LEASE_KINDS.ACTION });
  w.coordinator.acquire(102, { kind: LEASE_KINDS.ACTION });
  w.coordinator.acquire(103, { kind: LEASE_KINDS.ACTION });
  assert.equal(w.coordinator.counters().tabs, 2);
  assert.equal(w.coordinator.snapshot(101).valid, false, '最旧 tab 记录被驱逐');
  assert.equal(w.coordinator.snapshot(103).depth, 1);
  w.coordinator.reset();
  assert.equal(w.coordinator.counters().tabs, 0);
});

test('acquire 证据带 controller 当前状态与 human 最近活动', () => {
  const w = world();
  w.controller.transition(20, 'agent.claim', { source: 'test.agent' });
  w.coordinator.noteHuman(20, { at: w.now(), kind: 'key' });
  // 冷却结束后再签发，证据里仍能看到最近人工活动时间。
  w.advance(3000);
  w.human.settle(20, { now: w.now() });
  const lease = w.coordinator.acquire(20, { kind: LEASE_KINDS.ACTION });
  assert.equal(lease.ok, true);
  assert.equal(lease.evidence.controller, 'agent');
  assert.equal(lease.evidence.revision.at, w.now());
  assert.equal(lease.evidence.grantee, 'coop:20');
  assert.equal(lease.evidence.token, lease.token.slice(0, 6) + '…' + lease.token.slice(-6));
  w.coordinator.releaseAll(20);
});

test('revision 全链路：默认写入 control-generation 的 revision-chain（真实单源）', () => {
  clearControlGeneration(21);
  const w = world();
  const coordinator = createCooperationCoordinator({
    now: w.now,
    tokens: createPassthroughTokens({ now: w.now }),
    human: w.human,
    controller: w.controller,
    suppression: w.suppression,
    capture: w.capture,
  });
  const lease = coordinator.acquire(21, { kind: LEASE_KINDS.ACTION });
  assert.equal(lease.ok, true);
  const afterAcquire = controlGenerationRecord(21);
  assert.equal(afterAcquire.tabId, 21);
  coordinator.noteHumanTakeover(21, { source: 'test', humanAt: w.now() });
  const afterTakeover = controlGenerationRecord(21);
  assert.ok(afterTakeover.controlRevision >= 1, '人工接管推进 controlRevision');
  assert.ok(afterTakeover.authorityRevision >= 1, '人工接管撤销动作许可（authorityRevision）');
  const trace = coordinator.revisionTrace(21);
  assert.equal(trace.ok, true);
  assert.equal(trace.history.length >= 1, true);
  assert.equal(trace.vector.controlRevision >= 1, true);
  const local = afterTakeover;
  const remote = { ...local, controlRevision: local.controlRevision + 3 };
  const aligned = coordinator.alignRevision(21, remote);
  assert.equal(aligned.ok, true);
  assert.equal(aligned.stale, true);
  // revision-chain 语义：side='local' 表示本进程落后（远端更高），需要采纳远端更大值。
  assert.equal(aligned.side, 'local');
  assert.equal(aligned.aligned.controlRevision >= local.controlRevision + 3, true);
  coordinator.releaseAll(21);
  clearControlGeneration(21);
});

test('单例 cooperationCoordinator 存在且可释放（模块级接线冒烟）', () => {
  assert.equal(typeof cooperationCoordinator.acquire, 'function');
  const lease = cooperationCoordinator.acquire(999, { kind: LEASE_KINDS.ACTION, respectHuman: false });
  assert.equal(lease.ok, true);
  const released = cooperationCoordinator.release(lease.handle);
  assert.equal(released.released, true);
  assert.equal(cooperationCoordinator.snapshot(999).depth, 0);
});

test('evidenceDigest 稳定且对内容敏感（handback/借用证据共用实现）', () => {
  assert.equal(evidenceDigest({ a: 1 }), evidenceDigest({ a: 1 }));
  assert.notEqual(evidenceDigest({ a: 1 }), evidenceDigest({ a: 2 }));
  assert.match(evidenceDigest('x'), /^[0-9a-f]{8}$/);
  const vector = revisionVector(null);
  assert.deepEqual(vector, { controlRevision: 0, authorityRevision: 0, revision: 0, frameEpoch: 0, epoch: 0, generation: 0 });
});
