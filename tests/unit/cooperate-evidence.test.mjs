// tests/unit/cooperate-evidence.test.mjs —— 协作 passthrough 判定证据包 v2：
//   1) 四类来源归一化（租约栈/borrowGate/controllerGate/human-gate）+ token 打码；
//   2) mayAct 证据包：flags/anomalies/digest 可复算，语义冲突只报告；
//   3) mayAct 证据链（prevDigest+digest）与篡改定位；
//   4) 真实接线：cooperationCoordinator.mayAct → human.exclusive 的 evidence 里带
//      cooperation 字段（cooperate.js 原样并入 evidence），判定 allowed/code 不变。
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

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  COOPERATION_EVIDENCE_CODES,
  COOPERATION_EVIDENCE_LIMITS,
  COOPERATION_EVIDENCE_VERSION,
  borrowGateEvidence,
  chainMayActEvidence,
  controllerGateEvidence,
  describeMayActEvidence,
  formatMayActEvidence,
  humanGateEvidence,
  leaseOverlap,
  leaseStackEvidence,
  mayActEvidence,
  normalizeLeaseEvidence,
  summarizeMayActEvidence,
  verifyMayActChain,
  verifyMayActEvidence,
} = await import('../../extension/src/lib/cooperate-evidence.js');
const { createCooperationCoordinator } = await import('../../extension/src/lib/cooperate.js');
const { createPassthroughTokens } = await import('../../extension/src/lib/passthrough-token.js');
const { createHumanGate } = await import('../../extension/src/lib/human-gate.js');
const { createControllerStateMachine } = await import('../../extension/src/lib/controller-state.js');

function lease(overrides = {}) {
  return {
    leaseId: 'coop-lease-1',
    kind: 'native-input',
    method: 'click',
    owner: 'agent',
    grantee: 'coop:5',
    token: 'tok-abcdef',
    tokenMasked: 'to***ef',
    startedAt: 1000,
    expiresAt: 5000,
    suppressed: true,
    active: true,
    ...overrides,
  };
}

test('normalizeLeaseEvidence：token 打码、active/ended 状态、字段截断', () => {
  const normalized = normalizeLeaseEvidence(lease());
  assert.equal(normalized.leaseId, 'coop-lease-1');
  assert.equal(normalized.token, 'to***ef');
  assert.notEqual(normalized.token, 'tok-abcdef');
  assert.equal(normalized.active, true);
  assert.equal(normalized.state, 'active');
  assert.equal(normalized.startedAt, 1000);
  assert.equal(normalized.expiresAt, 5000);

  const released = normalizeLeaseEvidence(lease({ released: true, endedAt: 2000 }));
  assert.equal(released.active, false);
  assert.equal(released.state, 'ended');

  const longToken = normalizeLeaseEvidence(lease({ token: 'x'.repeat(80) }));
  assert.equal(longToken.token.length <= 7, true, '长 token 也只保留首尾两字符');
  assert.equal(normalizeLeaseEvidence(null), null);
});

test('leaseStackEvidence：只统计 active、kind/method 聚合、窗口范围、digest 对内容敏感', () => {
  const stack = leaseStackEvidence([
    lease({ leaseId: 'a', kind: 'native-input', method: 'click', startedAt: 1000, expiresAt: 2000 }),
    lease({ leaseId: 'b', kind: 'capture', method: 'screenshot', startedAt: 1500, expiresAt: 9000 }),
    lease({ leaseId: 'c', kind: 'action', method: 'fill', startedAt: 500, released: true, endedAt: 600 }),
  ]);
  assert.equal(stack.count, 3);
  assert.equal(stack.active, 2);
  assert.equal(stack.kinds['native-input'], 1);
  assert.equal(stack.kinds.capture, 1);
  assert.deepEqual(stack.methods.sort(), ['click', 'screenshot']);
  assert.equal(stack.firstStartedAt, 1000);
  assert.equal(stack.lastStartedAt, 1500);
  assert.equal(stack.latestExpiresAt, 9000);
  assert.deepEqual(stack.leaseIds, ['a', 'b']);
  assert.match(stack.digest, /^[0-9a-f]{8}$/);

  const other = leaseStackEvidence([lease({ leaseId: 'a', kind: 'capture', method: 'click' })]);
  assert.notEqual(other.digest, stack.digest);
  assert.deepEqual(leaseStackEvidence(null), { count: 0, active: 0, kinds: {}, methods: [], firstStartedAt: 0, lastStartedAt: 0, latestExpiresAt: 0, leaseIds: [], digest: leaseStackEvidence(null).digest });
  assert.ok(COOPERATION_EVIDENCE_LIMITS.maxLeases >= 8);
});

test('leaseOverlap：窗口重叠判定、无重叠/非法时刻/已释放租约', () => {
  const leases = [
    lease({ leaseId: 'a', startedAt: 1000, expiresAt: 2000 }),
    lease({ leaseId: 'b', startedAt: 3000, expiresAt: 4000 }),
  ];
  const hit = leaseOverlap(leases, 3200);
  assert.equal(hit.overlapping, true);
  assert.equal(hit.lease.leaseId, 'b');
  assert.equal(hit.overlapMs, 200);
  assert.equal(leaseOverlap(leases, 2500).overlapping, false);
  assert.equal(leaseOverlap(leases, 0).overlapping, false);
  assert.equal(leaseOverlap([lease({ startedAt: 1000, expiresAt: 2000, released: true })], 1500).overlapping, false);
  assert.equal(leaseOverlap(leases, 1500).lease.leaseId, 'a');
});

test('borrowGateEvidence/controllerGateEvidence/humanGateEvidence：三态归一化与摘要', () => {
  const absent = borrowGateEvidence(null);
  assert.equal(absent.present, false);
  assert.equal(absent.allowed, true);
  const pending = borrowGateEvidence({ allowed: false, code: 'E_BORROW_CONFLICT', status: 'pending', evidence: { requestId: 'req-1' } });
  assert.equal(pending.present, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.requestId, 'req-1');
  assert.match(pending.digest, /^[0-9a-f]{8}$/);
  const confirmed = borrowGateEvidence({ allowed: true, status: 'confirmed', decision: 'allow' });
  assert.equal(confirmed.pending, false);
  assert.equal(confirmed.decision, 'allow');

  const controllerAbsent = controllerGateEvidence(null);
  assert.equal(controllerAbsent.present, false);
  const held = controllerGateEvidence({ allowed: false, code: 'E_SESSION_STATE', state: 'held', evidence: { reason: 'paused' } });
  assert.equal(held.present, true);
  assert.equal(held.allowed, false);
  assert.equal(held.state, 'held');

  const human = humanGateEvidence({ state: 'human-active', active: true, cooling: false, lastAt: 100, ageMs: 20, toleranceMs: 1.5 });
  assert.equal(human.state, 'human-active');
  assert.equal(human.active, true);
  assert.match(human.digest, /^[0-9a-f]{8}$/);
  assert.equal(humanGateEvidence(null).state, 'idle');
});

test('mayActEvidence：flags 汇总、语义冲突 anomalies、decision 与 digest', () => {
  const bundle = mayActEvidence({
    method: 'click',
    at: 10_000,
    leases: [lease({ startedAt: 9000, expiresAt: 20_000 })],
    controllerGate: { allowed: true },
    borrowGate: { allowed: false, code: 'E_BORROW_CONFLICT', status: 'pending', requestId: 'req-1' },
    human: { state: 'human-active', active: true, lastAt: 9500, ageMs: 500, toleranceMs: 1.5 },
    decision: { allowed: false, code: 'E_BORROW_CONFLICT', source: 'borrow' },
  });
  assert.equal(bundle.version, COOPERATION_EVIDENCE_VERSION);
  assert.equal(bundle.method, 'click');
  assert.equal(bundle.flags.borrowPending, true);
  assert.equal(bundle.flags.humanActive, true);
  assert.equal(bundle.flags.leaseAmbient, true);
  assert.equal(bundle.flags.controllerHeld, false);
  assert.equal(bundle.decision.allowed, false);
  assert.equal(bundle.decision.source, 'borrow');
  assert.equal(bundle.anomalies.some((item) => item.code === COOPERATION_EVIDENCE_CODES.LEASE_PENDING_CONFLICT), true);
  assert.equal(bundle.anomalies.some((item) => item.code === COOPERATION_EVIDENCE_CODES.HUMAN_LEASE_AMBIENT), true);
  assert.match(bundle.digest, /^[0-9a-f]{8}$/);
  assert.equal(verifyMayActEvidence(bundle).ok, true);
  assert.equal(verifyMayActEvidence(bundle).anomalies, 2);

  const held = mayActEvidence({
    method: 'fill',
    leases: [],
    controllerGate: { allowed: false, state: 'held' },
    borrowGate: { status: 'confirmed', decision: 'allow' },
    human: { state: 'idle' },
    decision: { allowed: false, code: 'E_SESSION_STATE', source: 'controller' },
  });
  assert.equal(held.flags.controllerHeld, true);
  assert.equal(held.anomalies.length, 0);

  const humanConflict = mayActEvidence({ leases: [lease()], human: { state: 'conflict', active: false }, decision: { allowed: false, code: 'E_HUMAN_GATE', source: 'human' } });
  assert.equal(humanConflict.flags.humanActive, false);
  assert.equal(humanConflict.flags.leaseAmbient, true);
  assert.equal(verifyMayActEvidence(mayActEvidence({})).ok, true, '空输入也能形成可校验证据');
});

test('verifyMayActEvidence：digest 篡改/缺失；source 摘要被替换也能发现', () => {
  const bundle = mayActEvidence({ method: 'click', leases: [lease()] });
  const tampered = { ...bundle, method: 'fill' };
  const check = verifyMayActEvidence(tampered);
  assert.equal(check.ok, false);
  assert.equal(check.code, COOPERATION_EVIDENCE_CODES.EVIDENCE_MISMATCH);
  assert.equal(verifyMayActEvidence(null).code, COOPERATION_EVIDENCE_CODES.EVIDENCE_MISSING);
  const replacedSource = { ...bundle, leases: { ...bundle.leases, active: 0 } };
  assert.equal(verifyMayActEvidence(replacedSource).ok, false);
});

test('chainMayActEvidence/verifyMayActChain：链节链接、连续判定可对账、篡改定位', () => {
  const first = mayActEvidence({ method: 'click', at: 1000, leases: [], decision: { allowed: true, code: null, source: null } });
  const second = mayActEvidence({ method: 'fill', at: 1100, leases: [lease()], decision: { allowed: false, code: 'E_HUMAN_GATE', source: 'human' } });
  const link1 = chainMayActEvidence(null, first, { seq: 1, at: 1000 });
  assert.equal(link1.prevDigest, 'genesis');
  assert.match(link1.chainDigest, /^[0-9a-f]{8}$/);
  const link2 = chainMayActEvidence(link1, second, { seq: 2, at: 1100 });
  assert.equal(link2.prevDigest, link1.chainDigest);
  assert.notEqual(link2.chainDigest, link1.chainDigest);
  const chain = [link1, link2];
  const verified = verifyMayActChain(chain);
  assert.equal(verified.ok, true);
  assert.equal(verified.count, 2);
  assert.equal(verified.digest, link2.chainDigest);
  assert.equal(verifyMayActChain([]).ok, true);

  const tampered = [link1, { ...link2, method: 'fill-modified' }];
  const tamperedCheck = verifyMayActChain(tampered);
  assert.equal(tamperedCheck.ok, false);
  assert.equal(tamperedCheck.index, 1);
  assert.equal(chainMayActEvidence(null, null), null);
});

test('summarizeMayActEvidence/describe/format：紧凑摘要、文本行有上限', () => {
  const bundle = mayActEvidence({ method: 'click', leases: [lease()], borrowGate: { allowed: false, status: 'pending' }, human: { state: 'human-active', active: true } });
  const summary = summarizeMayActEvidence(bundle);
  assert.equal(summary.version, COOPERATION_EVIDENCE_VERSION);
  assert.equal(summary.digest, bundle.digest);
  assert.equal(summary.flags.borrowPending, true);
  assert.equal(summary.leases.active, 1);
  assert.equal(summary.borrow.status, 'pending');
  assert.ok(JSON.stringify(summary).length < 500);
  assert.equal(summarizeMayActEvidence(null), null);

  const described = describeMayActEvidence(bundle);
  assert.match(described, /^method=click/);
  assert.match(described, /borrow-pending/);
  assert.match(described, /leases=1/);
  assert.equal(describeMayActEvidence(null), 'coop-evidence: 无证据');
  const lines = formatMayActEvidence(bundle, { maxLines: 3 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /method=click/);
  assert.equal(formatMayActEvidence(null)[0], 'coop-evidence: 无证据');
});

test('mayActEvidence：allowCooling/expiresAt=Infinity/空 anomalies 的边界', () => {
  const cooling = mayActEvidence({
    method: 'click',
    leases: [],
    human: { state: 'cooling', active: false, cooling: true, lastAt: 100, ageMs: 350 },
    allowCooling: true,
    decision: { allowed: true, code: null, source: null },
  });
  assert.equal(cooling.flags.cooling, true);
  assert.equal(cooling.flags.allowCooling, true);
  assert.equal(cooling.decision.allowed, true);
  assert.equal(verifyMayActEvidence(cooling).ok, true);

  const infinite = leaseOverlap([lease({ startedAt: 1000, expiresAt: Infinity })], 900_000);
  assert.equal(infinite.overlapping, true);
  assert.equal(infinite.lease.leaseId, 'coop-lease-1');

  const clean = mayActEvidence({ method: 'observe', decision: { allowed: true, source: null } });
  assert.equal(clean.anomalies.length, 0);
  assert.equal(clean.flags.leaseAmbient, false);
  assert.equal(formatMayActEvidence(clean, { maxLines: 1 }).length, 1);
  assert.equal(formatMayActEvidence({ anomalies: [{ code: 'A' }, { code: 'B' }] }, { maxLines: 2 }).length, 2);
});

test('真实接线：cooperationCoordinator.mayAct 的 evidence 带 cooperation 证据包（判定不变）', () => {
  let clock = 100_000;
  const now = () => clock;
  const tokens = createPassthroughTokens({ now });
  const human = createHumanGate({ now, activeMs: 300, coolingMs: 100 });
  const controller = createControllerStateMachine({ now });
  const suppression = {
    begin: () => ({ ok: true, scopeId: 'sup-1', count: 1 }),
    end: () => ({ ok: true, released: true, outcome: 'ok' }),
    snapshot: () => ({ active: false, live: [], count: 0 }),
  };
  const capture = { snapshot: () => ({ count: 0, effective: false, holders: [] }) };
  const revisions = new Map();
  const emptyVector = () => ({ controlRevision: 0, authorityRevision: 0, revision: 0, frameEpoch: 0, epoch: 0, generation: 0 });
  const revisionRecord = (tabId) => ({ ...emptyVector(), ...(revisions.get(tabId) || {}) });
  const bumpRevisions = (tabId, delta = {}) => {
    const next = { ...revisionRecord(tabId) };
    for (const [field, value] of Object.entries(delta)) next[field] = (next[field] || 0) + (typeof value === 'number' ? value : 1);
    revisions.set(tabId, next);
    return next;
  };
  const coordinator = createCooperationCoordinator({ now, tokens, human, controller, suppression, capture, revisionRecord, bumpRevisions });

  try {
    clock += 10;
    const noted = coordinator.noteHuman(5, { kind: 'input', frameId: 0 });
    assert.equal(noted.ok, true);

    clock += 20;
    // 人工活跃：mayAct 必然拒绝（与第一轮一致）。
    const blocked = coordinator.mayAct(5, { method: 'click' });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.code, 'E_HUMAN_GATE');
    assert.equal(blocked.evidence.source, 'human');
    assert.ok(blocked.evidence.cooperation, 'cooperate.mayAct 应并入 human.exclusive 的新证据包');
    assert.match(blocked.evidence.cooperation.digest, /^[0-9a-f]{8}$/);
    assert.equal(blocked.evidence.cooperation.flags.humanActive, true);
    assert.ok(blocked.evidence.mayAct && blocked.evidence.mayAct.chainDigest, 'mayAct 链节随证据返回');
    assert.equal(blocked.evidence.leases, 0);

    // 借阅确认 pending：判定码沿用 borrowGate 的 code，cooperation 里 borrowPending=true。
    clock += 400;
    const borrowBlocked = coordinator.mayAct(5, {
      method: 'fill',
      borrowGate: { allowed: false, code: 'E_BORROW_CONFLICT', status: 'pending', evidence: { requestId: 'req-9' } },
    });
    assert.equal(borrowBlocked.allowed, false);
    assert.equal(borrowBlocked.code, 'E_BORROW_CONFLICT');
    assert.equal(borrowBlocked.evidence.source, 'borrow');
    assert.equal(borrowBlocked.evidence.cooperation.flags.borrowPending, true);
    assert.equal(borrowBlocked.evidence.cooperation.borrow.requestId, 'req-9');

    // 有活跃租约 + 人工冷却：判定可能放行，但 cooperation 摘要里 leaseAmbient=true。
    clock += 500;
    const acquired = coordinator.acquire(5, { kind: 'action', method: 'click', suppress: false, respectHuman: false });
    assert.equal(acquired.ok, true);
    const withLease = coordinator.mayAct(5, { method: 'click' });
    assert.equal(withLease.allowed, true);
    assert.equal(withLease.evidence.cooperation.flags.leaseAmbient, true);
    assert.equal(withLease.evidence.cooperation.leases.active, 1);
    assert.equal(withLease.evidence.mayAct.seq >= 3, true);
    coordinator.release(acquired.handle);

    // human 链证据：cooperation 来源里的 human 摘要与 gate.state 一致。
    const humanEvidence = coordinator.humanEvidence(5);
    assert.ok(humanEvidence);
    const bundle = mayActEvidence({ method: 'click', human: humanEvidence });
    assert.equal(verifyMayActEvidence(bundle).ok, true);
    assert.equal(coordinator.snapshot(5).human.state, human.state(5).state);
  } finally {
    coordinator.forget(5);
    human.reset();
    controller.clear(5);
  }
});
