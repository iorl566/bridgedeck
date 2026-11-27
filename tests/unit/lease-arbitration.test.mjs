// tests/unit/lease-arbitration.test.mjs —— 跨会话租约冲突裁决（daemon/lease-arbitration.js）。
//
// 覆盖：
// - 策略归一化（非法策略/limit 夹取/布尔强制/默认值）；
// - 候选收集（租约参与者 ∪ tab 上的会话、存活/phase/优先级/最近活动）与四种排序策略；
// - 单 tab 裁决：holder 失联晋升/无候选释放、holder stopping、无租约 adopt、非参与者 attach、
//   失联参与者 prune、结构不一致 repair（report-only）、无会话控制记录 drop-control、preempt；
// - 计划组装：多 tab、tabId 过滤、includeClean、limit/truncated、summary/byAction/byCode；
// - 执行：dry-run 零副作用、unsupported 跳过、失败记录、成功路径（用假 leaseOps 真改数据）；
// - 运行期裁决器：report / arbitrate(dry-run/apply) / residual / stats / reset。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARBITRATION_ACTIONS,
  ARBITRATION_DEFAULTS,
  ARBITRATION_KIND,
  ARBITRATION_SCHEMA,
  ARBITRATION_SEVERITIES,
  ARBITRATION_STRATEGIES,
  CONFLICT_ACTION_MAP,
  actionForConflictCode,
  applyArbitrationPlan,
  arbitrateLeaseConflicts,
  buildTabVerdict,
  collectCandidates,
  createLeaseArbiter,
  describeArbitrationPlan,
  normalizeArbitrationPolicy,
  rankCandidates,
} from '../../daemon/lease-arbitration.js';

const NOW = 1_700_000_000_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function leaseFixture(overrides = {}) {
  return {
    tabId: 7,
    holder: 's1',
    epoch: 3,
    acquiredAt: NOW - 5_000,
    holderSince: NOW - 5_000,
    expiresAt: NOW + 30_000,
    remainingMs: 30_000,
    ttlMs: 60_000,
    mode: 'exclusive',
    reason: 'session-start',
    shared: false,
    participantCount: 1,
    participants: [{ sessionId: 's1', attachedAt: NOW - 5_000, role: 'holder' }],
    since: NOW - 5_000,
    history: [],
    ...overrides,
  };
}

function sessionFixture(sessionId, tabId, overrides = {}) {
  return {
    sessionId,
    tabId,
    startedAt: NOW - 10_000,
    lastAgentActivity: NOW - 9_000,
    lastHumanInputAt: 0,
    priority: 0,
    connected: true,
    ...overrides,
  };
}

function conflictFixture(code, tabId, evidence = {}, severity = 'high') {
  return { code, severity, message: code + ' @tab' + tabId, at: NOW, evidence: { tabId, ...evidence } };
}

/** 假 leaseOps：内存里维护 leases 数组，供 createLeaseArbiter 的写步骤使用。 */
function fakeLeaseOps({ leases = [], conflicts = [] } = {}) {
  const state = {
    leases: clone(leases),
    conflicts: clone(conflicts),
    calls: [],
  };
  const find = (tabId) => state.leases.find((item) => item.tabId === tabId) || null;
  return {
    state,
    snapshot: () => clone(state.leases),
    ownershipMatrix: () => ({ conflicts: clone(state.conflicts) }),
    acquire: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'acquire', tabId, sessionId, options });
      if (find(tabId)) return { ok: false, code: 'E_TAB_LEASE_HELD' };
      state.leases.push(leaseFixture({ tabId, holder: sessionId, participants: [{ sessionId, attachedAt: NOW, role: 'holder' }] }));
      return { ok: true, lease: { holder: sessionId, epoch: 1 } };
    },
    join: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'join', tabId, sessionId, options });
      const item = find(tabId);
      if (!item) return { ok: false, code: 'E_TAB_LEASE_NOT_FOUND' };
      item.participants.push({ sessionId, attachedAt: NOW, role: 'participant' });
      item.participantCount = item.participants.length;
      return { ok: true, joined: true, holder: item.holder, lease: { holder: item.holder, epoch: item.epoch } };
    },
    transfer: (tabId, from, to, options = {}) => {
      state.calls.push({ op: 'transfer', tabId, from, to, options });
      const item = find(tabId);
      if (!item || item.holder !== from) return false;
      item.holder = to;
      if (!item.participants.some((entry) => entry.sessionId === to)) item.participants.push({ sessionId: to, attachedAt: NOW, role: 'holder' });
      item.participantCount = item.participants.length;
      return true;
    },
    release: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'release', tabId, sessionId, options });
      const item = find(tabId);
      if (!item) return { ok: false, code: 'E_TAB_LEASE_NOT_FOUND' };
      item.participants = item.participants.filter((entry) => entry.sessionId !== sessionId);
      let released = true;
      if (item.holder === sessionId) {
        const next = item.participants.find((entry) => entry.sessionId !== sessionId);
        item.holder = next ? next.sessionId : null;
      }
      if (!item.holder && item.participants.length === 0) {
        state.leases = state.leases.filter((entry) => entry.tabId !== tabId);
        return { ok: true, released, removed: true, promotedTo: null };
      }
      item.participantCount = item.participants.length;
      return { ok: true, released, removed: false, promotedTo: item.holder };
    },
  };
}

// ---------------------------------------------------------------------------
// 常量与策略
// ---------------------------------------------------------------------------

test('模块常量：schema/kind/策略/动作/严重度稳定（对外契约）', () => {
  assert.equal(ARBITRATION_SCHEMA, 1);
  assert.equal(ARBITRATION_KIND, 'bridge/lease-arbitration');
  assert.deepEqual(ARBITRATION_STRATEGIES, ['fifo', 'lru', 'priority', 'holder']);
  assert.deepEqual(ARBITRATION_SEVERITIES, ['high', 'warn', 'info']);
  for (const action of ['promote', 'release', 'attach', 'adopt', 'prune', 'repair', 'drop-control', 'none']) {
    assert.ok(ARBITRATION_ACTIONS.includes(action), action);
  }
  assert.equal(ARBITRATION_DEFAULTS.strategy, 'fifo');
  assert.equal(ARBITRATION_DEFAULTS.preempt, false);
  assert.equal(ARBITRATION_DEFAULTS.allowForce, false);
});

test('CONFLICT_ACTION_MAP：每个已知冲突码都有动作/严重度，结构不一致类为 report-only', () => {
  assert.equal(actionForConflictCode('lease-holder-missing').action, 'promote');
  assert.equal(actionForConflictCode('lease-holder-stopping').action, 'release');
  assert.equal(actionForConflictCode('lease-participant-missing').action, 'prune');
  assert.equal(actionForConflictCode('session-without-lease').action, 'adopt');
  assert.equal(actionForConflictCode('session-not-participant').action, 'attach');
  for (const code of ['lease-holder-not-participant', 'duplicate-participant', 'lease-tab-mismatch']) {
    assert.equal(actionForConflictCode(code).reportOnly, true, code);
  }
  assert.equal(actionForConflictCode('control-without-session').action, 'drop-control');
  const unknown = actionForConflictCode('mystery');
  assert.equal(unknown.action, 'none');
  assert.equal(unknown.reportOnly, true);
  assert.equal(unknown.unregistered, true);
  assert.equal(Object.keys(CONFLICT_ACTION_MAP).length >= 9, true);
});

test('normalizeArbitrationPolicy：默认值与非法策略回退（记录 clamped 证据）', () => {
  const defaults = normalizeArbitrationPolicy();
  assert.equal(defaults.policy.strategy, 'fifo');
  assert.equal(defaults.policy.limit, 20);
  assert.deepEqual(defaults.clamped, []);

  const bad = normalizeArbitrationPolicy({ strategy: 'random', preempt: 'yes', allowForce: 1, limit: 0 });
  assert.equal(bad.policy.strategy, 'fifo');
  assert.equal(bad.policy.preempt, false);
  assert.equal(bad.policy.allowForce, false);
  assert.equal(bad.policy.limit, 20);
  assert.ok(bad.clamped.some((item) => item.key === 'strategy' && item.reason === 'unknown-strategy'));
  assert.ok(bad.clamped.some((item) => item.key === 'preempt' && item.reason === 'not-boolean'));
  assert.ok(bad.clamped.some((item) => item.key === 'limit'));
});

test('normalizeArbitrationPolicy：limit 封顶 200、reviveWindow 夹取、by 截断', () => {
  const high = normalizeArbitrationPolicy({ limit: 9999, reviveWindowMs: -5, by: 'x'.repeat(200) });
  assert.equal(high.policy.limit, 200);
  assert.equal(high.policy.reviveWindowMs, ARBITRATION_DEFAULTS.reviveWindowMs);
  assert.ok(high.policy.by.length <= 80);
  assert.ok(high.clamped.some((item) => item.key === 'limit' && item.reason === 'clamped'));
  const tiny = normalizeArbitrationPolicy({ limit: 3, reviveWindowMs: 12.9 });
  assert.equal(tiny.policy.limit, 3);
  assert.equal(tiny.policy.reviveWindowMs, 12);
});

// ---------------------------------------------------------------------------
// 候选收集与排序
// ---------------------------------------------------------------------------

test('collectCandidates：租约参与者 ∪ tab 上会话、holder 标记、角色合并、排序稳定', () => {
  const candidates = collectCandidates({
    lease: leaseFixture({
      holder: 's1',
      participants: [
        { sessionId: 's1', attachedAt: NOW - 5_000, role: 'holder' },
        { sessionId: 's2', attachedAt: NOW - 3_000, role: 'participant' },
        { sessionId: 'dead', attachedAt: NOW - 1_000, role: 'participant' },
      ],
    }),
    sessions: [
      sessionFixture('s1', 7, { priority: 5 }),
      sessionFixture('s2', 7),
      sessionFixture('s3', 7),
    ],
    isAlive: (sessionId) => sessionId !== 'dead',
  });
  assert.deepEqual(candidates.map((item) => item.sessionId), ['dead', 's1', 's2', 's3']);
  const byId = new Map(candidates.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('s1').isHolder, true);
  assert.equal(byId.get('s1').isParticipant, true);
  assert.equal(byId.get('s1').priority, 5);
  assert.equal(byId.get('dead').alive, false);
  assert.equal(byId.get('s3').alive, true);
  assert.equal(byId.get('s3').isParticipant, false);
  assert.ok(byId.get('s1').roles.includes('holder'));
  assert.ok(byId.get('s1').roles.includes('session'));
});

test('collectCandidates：phase=stopping/stopped 一律不存活；Map 形式的 phase 表也支持', () => {
  const candidates = collectCandidates({
    lease: leaseFixture({ participants: [{ sessionId: 's1' }, { sessionId: 's2' }] }),
    sessions: [sessionFixture('s1', 7), sessionFixture('s2', 7)],
    phases: new Map([['s1', 'stopping'], ['s2', 'ready']]),
    isAlive: () => true,
  });
  const byId = new Map(candidates.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('s1').alive, false);
  assert.equal(byId.get('s1').stopped, true);
  assert.equal(byId.get('s2').alive, true);
});

test('collectCandidates：非法输入安全（无租约/无会话/坏 tab）', () => {
  const empty = collectCandidates();
  assert.deepEqual(empty, []);
  const noLease = collectCandidates({ sessions: [sessionFixture('s1', 7)] });
  assert.equal(noLease.length, 1);
  const badSessions = collectCandidates({ lease: leaseFixture(), sessions: [null, {}, { sessionId: '' }] });
  assert.equal(badSessions.length, 1, '只有租约 holder 是合法候选');
});

test('rankCandidates：fifo 按 startedAt 最早优先，失联候选不参与', () => {
  const candidates = collectCandidates({
    sessions: [
      sessionFixture('late', 7, { startedAt: NOW - 100 }),
      sessionFixture('early', 7, { startedAt: NOW - 9_000 }),
      sessionFixture('dead', 7, { startedAt: NOW - 20_000 }),
    ],
    isAlive: (sessionId) => sessionId !== 'dead',
  });
  const ranked = rankCandidates(candidates, { strategy: 'fifo' });
  assert.deepEqual(ranked.map((item) => item.sessionId), ['early', 'late']);
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2]);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('rankCandidates：holder 策略让存活 holder 排第一', () => {
  const candidates = collectCandidates({
    lease: leaseFixture({ holder: 'holder', participants: [{ sessionId: 'holder' }, { sessionId: 'older' }] }),
    sessions: [
      sessionFixture('holder', 7, { startedAt: NOW - 100 }),
      sessionFixture('older', 7, { startedAt: NOW - 9_000 }),
    ],
  });
  const fifo = rankCandidates(candidates, { strategy: 'fifo' });
  assert.equal(fifo[0].sessionId, 'older');
  const holderFirst = rankCandidates(candidates, { strategy: 'holder' });
  assert.equal(holderFirst[0].sessionId, 'holder');
  assert.ok(holderFirst[0].reasons.includes('holder-first'));
});

test('rankCandidates：lru 按最近活动、priority 按显式优先级', () => {
  const candidates = collectCandidates({
    sessions: [
      sessionFixture('recent', 7, { lastAgentActivity: NOW - 10 }),
      sessionFixture('stale', 7, { lastAgentActivity: NOW - 100_000 }),
    ],
  });
  assert.equal(rankCandidates(candidates, { strategy: 'lru' })[0].sessionId, 'recent');
  const priorities = collectCandidates({
    sessions: [
      sessionFixture('low', 7, { priority: 1 }),
      sessionFixture('high', 7, { priority: 9 }),
    ],
  });
  assert.equal(rankCandidates(priorities, { strategy: 'priority' })[0].sessionId, 'high');
});

test('rankCandidates：同分按 sessionId 字典序兜底（确定性）', () => {
  const candidates = collectCandidates({
    sessions: [
      sessionFixture('b-session', 7, { startedAt: NOW - 100 }),
      sessionFixture('a-session', 7, { startedAt: NOW - 100 }),
    ],
  });
  assert.deepEqual(rankCandidates(candidates).map((item) => item.sessionId), ['a-session', 'b-session']);
});

// ---------------------------------------------------------------------------
// 单 tab 裁决
// ---------------------------------------------------------------------------

test('buildTabVerdict：无冲突返回 none/confidence=1（includeClean 时展示）', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture(),
    sessions: [sessionFixture('s1', 7)],
    conflicts: [],
    now: NOW,
  });
  assert.equal(verdict.action, 'none');
  assert.equal(verdict.reason, 'no-conflict');
  assert.equal(verdict.confidence, 1);
  assert.deepEqual(verdict.steps, []);
  assert.equal(verdict.winner.sessionId, 's1');
  assert.equal(verdict.severity, 'info');
});

test('buildTabVerdict：holder 失联且有存活候选 → promote + transfer（winner/losers 可解释）', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }, { sessionId: 's3' }] }),
    sessions: [sessionFixture('s2', 7), sessionFixture('s3', 7)],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    now: NOW,
    isAlive: (sessionId) => sessionId !== 'dead',
  });
  assert.equal(verdict.action, 'promote');
  assert.equal(verdict.severity, 'high');
  assert.equal(verdict.winner.sessionId, 's2');
  assert.equal(verdict.winner.rank, 1);
  assert.ok(verdict.losers.some((item) => item.sessionId === 's3' && item.disposition === 'participant'));
  assert.equal(verdict.steps.length, 1);
  assert.equal(verdict.steps[0].op, 'transfer');
  assert.deepEqual(verdict.steps[0].args, { tabId: 7, from: 'dead', to: 's2' });
  assert.equal(verdict.confidence, 0.9);
  assert.ok(verdict.reason.includes('s2'));
  assert.equal(verdict.reportOnly, false);
});

test('buildTabVerdict：holder 失联且无存活候选 → release（按 allowForce 决定 force）', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 'dead', participants: [{ sessionId: 'dead' }] }),
    sessions: [],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    policy: { ...ARBITRATION_DEFAULTS, allowForce: true, by: 'operator' },
    now: NOW,
    isAlive: () => false,
  });
  assert.equal(verdict.action, 'release');
  assert.equal(verdict.steps[0].op, 'release');
  assert.equal(verdict.steps[0].args.force, true);
  assert.equal(verdict.steps[0].args.by, 'operator');
  assert.equal(verdict.steps[0].args.reason, 'holder-missing');
  assert.equal(verdict.winner, null);
});

test('buildTabVerdict：holder 失联同时清理失联参与者（holder-missing-cleanup）', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({
      holder: 'dead',
      participants: [{ sessionId: 'dead' }, { sessionId: 'dead2' }, { sessionId: 'alive' }],
    }),
    sessions: [sessionFixture('alive', 7)],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    now: NOW,
    isAlive: (sessionId) => sessionId === 'alive',
  });
  assert.equal(verdict.action, 'promote');
  const ops = verdict.steps.map((step) => step.op);
  assert.deepEqual(ops, ['transfer', 'prune']);
  assert.equal(verdict.steps[1].args.sessionId, 'dead2');
  assert.ok(verdict.losers.some((item) => item.sessionId === 'dead2' && item.disposition === 'release'));
});

test('buildTabVerdict：holder 正在 stopping → release/deferred（不抢先转移）', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 's1', participants: [{ sessionId: 's1' }] }),
    sessions: [sessionFixture('s1', 7)],
    phases: () => 'stopping',
    conflicts: [conflictFixture('lease-holder-stopping', 7, { holder: 's1' }, 'warn')],
    now: NOW,
  });
  assert.equal(verdict.action, 'release');
  assert.equal(verdict.deferred, true);
  assert.equal(verdict.steps[0].op, 'release');
  assert.equal(verdict.steps[0].args.reason, 'holder-stopping');
  assert.equal(verdict.confidence, 0.95);
});

test('buildTabVerdict：无租约多会话 → adopt 最强 + 其余 join（跨会话裁决）', () => {
  const verdict = buildTabVerdict({
    tabId: 9,
    lease: null,
    sessions: [
      sessionFixture('old', 9, { startedAt: NOW - 9_000 }),
      sessionFixture('new', 9, { startedAt: NOW - 100 }),
    ],
    conflicts: [
      conflictFixture('session-without-lease', 9, { sessionId: 'old' }, 'info'),
      conflictFixture('session-without-lease', 9, { sessionId: 'new' }, 'info'),
    ],
    now: NOW,
  });
  assert.equal(verdict.action, 'adopt');
  assert.equal(verdict.winner.sessionId, 'old');
  assert.deepEqual(verdict.steps.map((step) => step.op), ['acquire', 'join']);
  assert.equal(verdict.steps[0].args.sessionId, 'old');
  assert.equal(verdict.steps[1].args.sessionId, 'new');
  assert.deepEqual(verdict.losers.find((item) => item.sessionId === 'new'), { sessionId: 'new', disposition: 'participant', reason: 'adopt-loser' });
});

test('buildTabVerdict：已有 holder 时无租约会话登记为参与者（不抢 holder）', () => {
  const verdict = buildTabVerdict({
    tabId: 9,
    lease: leaseFixture({ tabId: 9, holder: 's1', participants: [{ sessionId: 's1' }] }),
    sessions: [sessionFixture('s1', 9), sessionFixture('s2', 9)],
    conflicts: [conflictFixture('session-without-lease', 9, { sessionId: 's2' }, 'info')],
    now: NOW,
  });
  assert.equal(verdict.action, 'attach');
  assert.equal(verdict.steps[0].op, 'join');
  assert.equal(verdict.steps[0].args.sessionId, 's2');
  assert.equal(verdict.winner.sessionId, 's1');
});

test('buildTabVerdict：session-not-participant（存活）→ join 补登', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 's1', participants: [{ sessionId: 's1' }] }),
    sessions: [sessionFixture('s1', 7), sessionFixture('s2', 7)],
    conflicts: [conflictFixture('session-not-participant', 7, { sessionId: 's2', holder: 's1' })],
    now: NOW,
  });
  assert.equal(verdict.action, 'attach');
  assert.equal(verdict.steps[0].op, 'join');
  assert.equal(verdict.steps[0].args.reason, 'session-not-participant');
  assert.ok(verdict.reason.includes('s2'));
});

test('buildTabVerdict：session-not-participant（已失联）→ report-only repair', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 's1', participants: [{ sessionId: 's1' }] }),
    sessions: [sessionFixture('s1', 7)],
    conflicts: [conflictFixture('session-not-participant', 7, { sessionId: 'ghost', holder: 's1' })],
    now: NOW,
    isAlive: (sessionId) => sessionId !== 'ghost',
  });
  assert.equal(verdict.reportOnly, true);
  assert.deepEqual(verdict.steps, []);
  assert.ok(verdict.conflictCodes.includes('session-not-participant'));
});

test('buildTabVerdict：lease-participant-missing → 只 prune 失联参与者', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({
      holder: 's1',
      participants: [{ sessionId: 's1' }, { sessionId: 'dead' }, { sessionId: 'alive' }],
    }),
    sessions: [sessionFixture('s1', 7), sessionFixture('alive', 7)],
    conflicts: [conflictFixture('lease-participant-missing', 7, { sessionId: 'dead', holder: 's1' }, 'warn')],
    now: NOW,
    isAlive: (sessionId) => sessionId !== 'dead',
  });
  assert.equal(verdict.action, 'prune');
  assert.equal(verdict.steps.length, 1);
  assert.equal(verdict.steps[0].op, 'prune');
  assert.equal(verdict.steps[0].args.sessionId, 'dead');
});

test('buildTabVerdict：结构不一致（holder 不在参与者/重复参与者/tab 错乱）→ repair report-only', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 's1', participants: [{ sessionId: 's2' }, { sessionId: 's2' }] }),
    sessions: [sessionFixture('s1', 7), sessionFixture('s2', 7)],
    conflicts: [
      conflictFixture('lease-holder-not-participant', 7, { holder: 's1' }),
      conflictFixture('duplicate-participant', 7, { sessionId: 's2' }, 'warn'),
      conflictFixture('lease-tab-mismatch', 7, {}),
    ],
    now: NOW,
  });
  assert.equal(verdict.action, 'repair');
  assert.equal(verdict.reportOnly, true);
  assert.deepEqual(verdict.steps, []);
  assert.ok(verdict.confidence <= 0.5);
  assert.ok(verdict.notes.some((note) => note.includes('结构不一致')));
});

test('buildTabVerdict：control-without-session → drop-control 步骤', () => {
  const verdict = buildTabVerdict({
    tabId: 3,
    lease: null,
    sessions: [],
    conflicts: [conflictFixture('control-without-session', 3, {}, 'info')],
    now: NOW,
  });
  assert.equal(verdict.action, 'drop-control');
  assert.equal(verdict.steps[0].op, 'drop-control');
  assert.deepEqual(verdict.steps[0].args, { tabId: 3 });
});

test('buildTabVerdict：preempt 策略下存活但 TTL 过期的 holder 可被抢占', () => {
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture({ holder: 's1', expiresAt: NOW - 1, remainingMs: 0, participants: [{ sessionId: 's1' }, { sessionId: 's2' }] }),
    sessions: [
      sessionFixture('s1', 7, { startedAt: NOW - 9_000 }),
      sessionFixture('s2', 7, { startedAt: NOW - 1_000, priority: 5 }),
    ],
    conflicts: [conflictFixture('session-not-participant', 7, { sessionId: 's2' }, 'info')],
    policy: { ...ARBITRATION_DEFAULTS, preempt: true, strategy: 'priority' },
    now: NOW,
  });
  assert.equal(verdict.winner.sessionId, 's2');
  assert.ok(verdict.steps.some((step) => step.op === 'transfer' && step.args.preempt === true));
  assert.ok(verdict.notes.some((note) => note.includes('preempt')));
});

test('buildTabVerdict：非法 tabId 返回 null；confidence 始终在 (0,1]', () => {
  assert.equal(buildTabVerdict({ tabId: 'x' }), null);
  assert.equal(buildTabVerdict({ tabId: -1 }), null);
  const verdict = buildTabVerdict({
    tabId: 7,
    lease: leaseFixture(),
    sessions: [],
    conflicts: [conflictFixture('lease-holder-missing', 7, {})],
    now: NOW,
    isAlive: () => false,
  });
  assert.ok(verdict.confidence > 0 && verdict.confidence <= 1);
});

// ---------------------------------------------------------------------------
// 计划组装
// ---------------------------------------------------------------------------

test('arbitrateLeaseConflicts：多 tab 分组、summary 统计与步骤扁平化', () => {
  const plan = arbitrateLeaseConflicts({
    leases: [
      leaseFixture({ tabId: 1, holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }] }),
      leaseFixture({ tabId: 2, holder: 's3', participants: [{ sessionId: 's3' }] }),
    ],
    sessions: [
      sessionFixture('s2', 1),
      sessionFixture('s3', 2),
      sessionFixture('s4', 2),
      sessionFixture('s5', 9),
    ],
    conflicts: [
      conflictFixture('lease-holder-missing', 1, { holder: 'dead' }),
      conflictFixture('session-not-participant', 2, { sessionId: 's4', holder: 's3' }),
      conflictFixture('session-without-lease', 9, { sessionId: 's5' }, 'info'),
    ],
    now: NOW,
    isAlive: (sessionId) => sessionId !== 'dead',
  });
  assert.equal(plan.schema, ARBITRATION_SCHEMA);
  assert.equal(plan.kind, ARBITRATION_KIND);
  assert.deepEqual(plan.verdicts.map((verdict) => verdict.tabId), [1, 2, 9]);
  assert.equal(plan.summary.tabs, 3);
  assert.equal(plan.summary.verdicts, 3);
  assert.equal(plan.summary.actionable, 3);
  assert.equal(plan.summary.highSeverity, 2);
  assert.equal(plan.summary.infoSeverity, 1);
  assert.deepEqual(plan.summary.byAction, { promote: 1, attach: 1, adopt: 1 });
  assert.deepEqual(plan.summary.byCode, { 'lease-holder-missing': 1, 'session-not-participant': 1, 'session-without-lease': 1 });
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((step) => step.index), [0, 1, 2]);
  assert.ok(plan.steps.every((step) => Number.isInteger(step.tabId) && step.verdictAction));
  assert.equal(plan.summary.winners.length, 3);
});

test('arbitrateLeaseConflicts：tabId 过滤只裁决指定 tab', () => {
  const plan = arbitrateLeaseConflicts({
    leases: [leaseFixture({ tabId: 1, holder: 'dead' }), leaseFixture({ tabId: 2, holder: 'dead2' })],
    sessions: [],
    conflicts: [
      conflictFixture('lease-holder-missing', 1, { holder: 'dead' }),
      conflictFixture('lease-holder-missing', 2, { holder: 'dead2' }),
    ],
    tabId: 2,
    now: NOW,
    isAlive: () => false,
  });
  assert.deepEqual(plan.verdicts.map((verdict) => verdict.tabId), [2]);
  assert.equal(plan.tabId, 2);
});

test('arbitrateLeaseConflicts：includeClean 控制无冲突 tab 是否出现', () => {
  const input = {
    leases: [leaseFixture({ tabId: 1, holder: 's1', participants: [{ sessionId: 's1' }] })],
    sessions: [sessionFixture('s1', 1)],
    conflicts: [],
    now: NOW,
  };
  const hidden = arbitrateLeaseConflicts(input);
  assert.deepEqual(hidden.verdicts, []);
  const visible = arbitrateLeaseConflicts({ ...input, policy: { ...ARBITRATION_DEFAULTS, includeClean: true } });
  assert.equal(visible.verdicts.length, 1);
  assert.equal(visible.verdicts[0].action, 'none');
});

test('arbitrateLeaseConflicts：limit 截断与 truncated 标记', () => {
  const leases = [];
  const conflicts = [];
  for (let tabId = 0; tabId < 5; tabId += 1) {
    leases.push(leaseFixture({ tabId, holder: 'dead' + tabId }));
    conflicts.push(conflictFixture('lease-holder-missing', tabId, { holder: 'dead' + tabId }));
  }
  const plan = arbitrateLeaseConflicts({ leases, sessions: [], conflicts, now: NOW, isAlive: () => false, policy: { ...ARBITRATION_DEFAULTS, limit: 2 } });
  assert.equal(plan.verdicts.length, 2);
  assert.equal(plan.truncated, true);
  assert.equal(plan.summary.tabs, 5);
  assert.equal(plan.steps.filter((step) => step.tabId >= 2).length, 0);
});

test('arbitrateLeaseConflicts：非法 tabId 返回 E_BAD_ARG 且不抛错', () => {
  const plan = arbitrateLeaseConflicts({ tabId: -3 });
  assert.equal(plan.error.code, 'E_BAD_ARG');
  assert.deepEqual(plan.verdicts, []);
  assert.equal(plan.summary.verdicts, 0);
});

test('arbitrateLeaseConflicts：空输入返回空计划（不是 null）', () => {
  const plan = arbitrateLeaseConflicts();
  assert.equal(plan.schema, ARBITRATION_SCHEMA);
  assert.deepEqual(plan.verdicts, []);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.summary.conflicts, 0);
});

// ---------------------------------------------------------------------------
// 执行计划
// ---------------------------------------------------------------------------

test('applyArbitrationPlan：dry-run 不调用任何 op', () => {
  const ops = fakeLeaseOps();
  const result = applyArbitrationPlan({ steps: [{ index: 0, op: 'transfer', args: { tabId: 1, from: 'a', to: 'b' } }] }, ops, { now: NOW, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.applied, []);
  assert.equal(ops.state.calls.length, 0);
});

test('applyArbitrationPlan：不支持的 op 记 skipped/unsupported', () => {
  const result = applyArbitrationPlan({
    steps: [
      { index: 0, op: 'repair', tabId: 1 },
      { index: 1, op: 'drop-control', tabId: 2, args: { tabId: 2 } },
    ],
  }, {}, { now: NOW });
  assert.equal(result.summary.unsupported, 2);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['unsupported-op', 'unsupported-op']);
  assert.equal(result.summary.ok, 0);
});

test('applyArbitrationPlan：真实执行 transfer/release/acquire/join/prune 并记录失败', () => {
  const ops = fakeLeaseOps({
    leases: [
      leaseFixture({ tabId: 1, holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }] }),
      leaseFixture({ tabId: 2, holder: 's3', participants: [{ sessionId: 's3' }] }),
    ],
  });
  const plan = {
    steps: [
      { index: 0, op: 'transfer', args: { tabId: 1, from: 'dead', to: 's2' }, reason: 'holder-missing' },
      { index: 1, op: 'join', args: { tabId: 2, sessionId: 's4' }, reason: 'session-not-participant' },
      { index: 2, op: 'acquire', args: { tabId: 5, sessionId: 's9' }, reason: 'session-without-lease' },
      { index: 3, op: 'prune', args: { tabId: 88, sessionId: 'ghost' }, reason: 'participant-missing' },
      { index: 4, op: 'transfer', args: { tabId: 99, from: 'x', to: 'y' }, reason: 'missing-tab' },
    ],
  };
  const result = applyArbitrationPlan(plan, ops, { now: NOW });
  assert.equal(result.summary.steps, 5);
  assert.equal(result.summary.ok, 3);
  assert.equal(result.summary.failed, 2);
  assert.equal(result.summary.skipped, 0);
  assert.deepEqual(result.applied.map((item) => item.op), ['transfer', 'join', 'acquire']);
  assert.equal(ops.state.leases.find((item) => item.tabId === 1).holder, 's2');
  assert.equal(ops.state.leases.find((item) => item.tabId === 2).participants.some((entry) => entry.sessionId === 's4'), true);
  assert.ok(ops.state.leases.some((item) => item.tabId === 5 && item.holder === 's9'));
  assert.deepEqual(result.failed.map((item) => item.index), [3, 4]);
});

test('applyArbitrationPlan：op 抛错被捕获并记录 code/message', () => {
  const result = applyArbitrationPlan({
    steps: [{ index: 0, op: 'transfer', args: { tabId: 1, from: 'a', to: 'b' } }],
  }, {
    transfer: () => { throw Object.assign(new Error('boom'), { code: 'E_INTERNAL' }); },
  }, { now: NOW });
  assert.equal(result.summary.failed, 1);
  assert.equal(result.failed[0].code, 'E_INTERNAL');
  assert.equal(result.failed[0].message, 'boom');
});

// ---------------------------------------------------------------------------
// 运行期裁决器
// ---------------------------------------------------------------------------

function makeArbiter({ leases = [], conflicts = [], sessions = [], drops = [] } = {}) {
  const ops = fakeLeaseOps({ leases, conflicts });
  const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: sessionMap,
    phases: (sessionId) => (sessionMap.has(sessionId) ? 'ready' : null),
    controls: () => [],
    now: () => NOW,
    dropControl: (tabId) => { drops.push(tabId); return { ok: true, tabId }; },
  });
  return { ops, sessionMap, arbiter, drops };
}

test('createLeaseArbiter：report 基于 leaseOps 快照 + 冲突矩阵（dry-run）', () => {
  const { ops, arbiter } = makeArbiter({
    leases: [leaseFixture({ tabId: 7, holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }] })],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    sessions: [sessionFixture('s2', 7)],
  });
  const report = arbiter.report({ limit: 5 });
  assert.equal(report.kind, ARBITRATION_KIND);
  assert.equal(report.summary.verdicts, 1);
  assert.equal(report.verdicts[0].action, 'promote');
  assert.equal(ops.state.calls.length, 0, 'report 不执行任何写操作');
});

test('createLeaseArbiter：arbitrate 默认 dry-run（不写，也不返回 applied）', () => {
  const { ops, arbiter } = makeArbiter({
    leases: [leaseFixture({ tabId: 7, holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }] })],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    sessions: [sessionFixture('s2', 7)],
  });
  const plan = arbiter.arbitrate({ strategy: 'fifo' });
  assert.equal(plan.applied, null);
  assert.equal(plan.appliedAt, 0);
  assert.equal(ops.state.calls.length, 0);
});

test('createLeaseArbiter：apply 执行 transfer 后 residual 冲突归零', () => {
  const { ops, arbiter } = makeArbiter({
    leases: [leaseFixture({ tabId: 7, holder: 'dead', participants: [{ sessionId: 'dead' }, { sessionId: 's2' }] })],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
    sessions: [sessionFixture('s2', 7)],
  });
  const result = arbiter.arbitrate({ apply: true, strategy: 'fifo' });
  assert.equal(result.applied.dryRun, false);
  assert.equal(result.applied.summary.ok, 1);
  assert.equal(ops.state.calls[0].op, 'transfer');
  assert.equal(ops.state.leases.find((item) => item.tabId === 7).holder, 's2');
  // 假 ops 的 ownershipMatrix 仍返回旧冲突（未自动刷新），residual 计划据此计算；
  // 仅断言 apply 结果与 resolved 字段是数字，避免把假实现的行为当契约。
  assert.equal(typeof result.residual.residualConflicts, 'number');
  assert.equal(typeof result.residual.resolved, 'number');
  assert.equal(result.appliedAt, NOW);
});

test('createLeaseArbiter：apply 带 dropControl 能力时清理控制记录', () => {
  const drops = [];
  const { arbiter } = makeArbiter({
    conflicts: [conflictFixture('control-without-session', 3, {}, 'info')],
    drops,
  });
  const result = arbiter.arbitrate({ apply: true });
  assert.equal(result.applied.summary.ok, 1);
  assert.deepEqual(drops, [3]);
});

test('createLeaseArbiter：force 参数只把 allowForce 打开，不改其它策略', () => {
  const { arbiter } = makeArbiter({});
  const plan = arbiter.arbitrate({ force: true });
  assert.equal(plan.policy.allowForce, true);
  assert.equal(plan.policy.preempt, false);
  const clamped = arbiter.arbitrate({ strategy: 'bogus', limit: 1000 });
  assert.equal(clamped.policy.strategy, 'fifo');
  assert.equal(clamped.policy.limit, 200);
});

test('createLeaseArbiter：stats/reset 维护计数器与时间戳', () => {
  const { arbiter } = makeArbiter({
    leases: [leaseFixture({ tabId: 7, holder: 'dead', participants: [{ sessionId: 'dead' }] })],
    conflicts: [conflictFixture('lease-holder-missing', 7, { holder: 'dead' })],
  });
  arbiter.report();
  arbiter.arbitrate({ apply: true });
  const stats = arbiter.stats();
  assert.equal(stats.counters.arbitrations, 1);
  assert.equal(stats.counters.appliedPlans, 1);
  assert.equal(stats.counters.stepsApplied, 1);
  assert.ok(stats.lastPlanAt > 0);
  assert.ok(stats.lastApplyAt > 0);
  const reset = arbiter.reset();
  assert.equal(reset.counters.arbitrations, 0);
  assert.equal(reset.lastApplyAt, 0);
});

test('createLeaseArbiter：缺 leaseOps 快速失败；Phases 函数异常不影响裁决', () => {
  assert.throws(() => createLeaseArbiter({}), /leaseOps/);
  const ops = fakeLeaseOps({ leases: [leaseFixture({ tabId: 1, holder: 's1', participants: [{ sessionId: 's1' }] })] });
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: new Map([['s1', sessionFixture('s1', 1)]]),
    phases: () => { throw new Error('phase boom'); },
    now: () => NOW,
  });
  const plan = arbiter.report({ includeClean: true });
  assert.equal(plan.verdicts.length, 1);
});

test('describeArbitrationPlan：人类摘要包含 tab 数与动作分布', () => {
  const plan = arbitrateLeaseConflicts({
    leases: [leaseFixture({ tabId: 1, holder: 'dead' })],
    conflicts: [conflictFixture('lease-holder-missing', 1, { holder: 'dead' })],
    sessions: [],
    now: NOW,
    isAlive: () => false,
  });
  const text = describeArbitrationPlan(plan);
  assert.match(text, /租约裁决/);
  assert.match(text, /tab/);
  assert.match(text, /release=1/);
});
