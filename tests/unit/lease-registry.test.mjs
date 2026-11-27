// tests/unit/lease-registry.test.mjs —— 多会话 tab 所有权租约的纯判定层：
// 状态分类、所有权矩阵、冲突不变量、过期回收/续租/对账计划、报告结构与证据解释。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEASE_EXPIRING_WINDOW_MS,
  LEASE_EXPIRING_WINDOW_MS as EXPIRING,
  LEASE_OWNERSHIP_KIND,
  LEASE_OWNERSHIP_SCHEMA,
  LEASE_STATE_KINDS,
  buildLeaseReport,
  buildOwnershipMatrix,
  buildTabOwnershipRow,
  classifyLeaseStatus,
  collectTabSessions,
  describeLeaseConflict,
  describeLeaseState,
  detectOwnershipConflicts,
  indexSessionsById,
  isStartToken,
  isValidLeaseReason,
  normalizeLeaseReason,
  normalizeSessionId,
  normalizeTabId,
  planExpiryReclaim,
  planLeaseReconcile,
  planRenewals,
  summarizeConflicts,
  summarizeLeaseStatus,
  ttlBucketOf,
} from '../../daemon/lease-registry.js';

const NOW = 1_700_000_000_000;

function leaseFixture(overrides = {}) {
  const at = NOW;
  const base = {
    tabId: 7,
    holder: 's1',
    acquiredAt: at - 1_000,
    holderSince: at - 1_000,
    expiresAt: at + 30_000,
    ttlMs: 60_000,
    epoch: 1,
    mode: 'exclusive',
    reason: 'session-start',
    shared: false,
    participantCount: 1,
    participants: [{ sessionId: 's1', attachedAt: at - 1_000, role: 'holder' }],
    since: at - 1_000,
    lastEvent: { seq: 1, type: 'acquire', at: at - 1_000 },
    history: [{ seq: 1, type: 'acquire', at: at - 1_000, to: 's1' }],
  };
  return { ...base, ...overrides };
}

function sessionFixture(sessionId, tabId, overrides = {}) {
  return { sessionId, tabId, startedAt: NOW - 10_000, shared: false, borrowed: false, ...overrides };
}

// ---------------------------------------------------------------------------
// 参数规范化 / 快照视图
// ---------------------------------------------------------------------------

test('normalizeTabId / normalizeSessionId / ttlBucketOf：坏输入不抛错，返回保守值', () => {
  assert.equal(normalizeTabId(7), 7);
  assert.equal(normalizeTabId('8'), 8);
  assert.equal(normalizeTabId(-1), null);
  assert.equal(normalizeTabId(1.5), null);
  assert.equal(normalizeTabId(null), null);
  assert.equal(normalizeTabId('x'), null);
  assert.equal(normalizeSessionId(' s1 '), 's1');
  assert.equal(normalizeSessionId(''), null);
  assert.equal(normalizeSessionId(null), null);
  assert.equal(isStartToken('start:abc'), true);
  assert.equal(isStartToken('s1'), false);
  assert.equal(isValidLeaseReason('session-start'), true);
  assert.equal(isValidLeaseReason('custom-reason'), false);
  assert.equal(normalizeLeaseReason(''), 'renew');
  assert.equal(normalizeLeaseReason('  '), 'renew');
  assert.equal(normalizeLeaseReason('rebind'), 'rebind');
  assert.equal(normalizeLeaseReason(42), '42');
  assert.equal(ttlBucketOf(50_000, 60_000), 'fresh');
  assert.equal(ttlBucketOf(30_000, 60_000), 'aging');
  assert.equal(ttlBucketOf(5_000, 60_000), 'expiring');
  assert.equal(ttlBucketOf(0, 60_000), 'expired');
  assert.equal(ttlBucketOf(-5, 60_000), 'expired');
});

test('summarizeLeaseStatus：规范化 holder/参与者/剩余租期/TTL 分桶与历史裁剪', () => {
  const raw = leaseFixture({
    participants: [
      { sessionId: 's1', attachedAt: NOW - 3_000, role: 'holder' },
      { sessionId: 's2', attachedAt: NOW - 2_000, role: 'participant' },
    ],
    participantCount: 2,
    history: [1, 2, 3, 4, 5, 6, 7].map((seq) => ({ seq, type: 'x' })),
  });
  const summary = summarizeLeaseStatus(raw, { now: NOW, historyLimit: 3 });
  assert.equal(summary.tabId, 7);
  assert.equal(summary.holder, 's1');
  assert.equal(summary.epoch, 1);
  assert.equal(summary.remainingMs, 30_000);
  assert.equal(summary.ttlBucket, 'aging');
  assert.equal(summary.shared, true);
  assert.equal(summary.participantCount, 2);
  assert.deepEqual(summary.participants.map((item) => item.sessionId), ['s1', 's2']);
  assert.deepEqual(summary.history.map((item) => item.seq), [5, 6, 7]);
  // 无 holder 的租约 bucket 恒为 expired（表示"没有租期"）。
  const empty = summarizeLeaseStatus(leaseFixture({ holder: null, participants: [], participantCount: 0 }), { now: NOW });
  assert.equal(empty.ttlBucket, 'expired');
  assert.equal(empty.remainingMs, 0);
  // 非对象/缺 tabId 返回 null（视图层容错）。
  assert.equal(summarizeLeaseStatus(null), null);
  assert.equal(summarizeLeaseStatus({ holder: 's1' }), null);
});

test('classifyLeaseStatus：free/held/shared/expiring/expired/orphan/启动占位令牌', () => {
  const alive = () => true;
  const free = classifyLeaseStatus(null, { now: NOW, isAlive: alive });
  assert.equal(free.kind, 'free');
  const held = classifyLeaseStatus(leaseFixture(), { now: NOW, isAlive: alive });
  assert.equal(held.kind, 'held');
  assert.equal(held.holderAlive, true);
  assert.equal(held.reclaimable, false);
  const shared = classifyLeaseStatus(leaseFixture({ participantCount: 2 }), { now: NOW, isAlive: alive });
  assert.equal(shared.kind, 'shared');
  const expiring = classifyLeaseStatus(leaseFixture({ expiresAt: NOW + 5_000 }), { now: NOW, isAlive: alive });
  assert.equal(expiring.kind, 'expiring');
  assert.equal(expiring.remainingMs, 5_000);
  const expired = classifyLeaseStatus(leaseFixture({ expiresAt: NOW - 1 }), { now: NOW, isAlive: alive });
  assert.equal(expired.kind, 'expired');
  assert.equal(expired.reclaimable, false, '存活持有者的过期租约默认不回收');
  const orphan = classifyLeaseStatus(leaseFixture(), { now: NOW, isAlive: () => false });
  assert.equal(orphan.kind, 'orphan');
  assert.equal(orphan.reclaimable, true);
  // 启动占位令牌（start:<uuid>）视为存活，避免 session.start 竞态被回收。
  const starting = classifyLeaseStatus(leaseFixture({ holder: 'start:tok' }), { now: NOW, isAlive: () => false });
  assert.notEqual(starting.kind, 'orphan');
  // 自定义告警窗口。
  const wide = classifyLeaseStatus(leaseFixture({ expiresAt: NOW + 20_000 }), { now: NOW, isAlive: alive, expiringWithinMs: 25_000 });
  assert.equal(wide.kind, 'expiring');
  assert.equal(LEASE_EXPIRING_WINDOW_MS, EXPIRING);
  assert.equal(LEASE_STATE_KINDS.includes(orphan.kind), true);
});

test('indexSessionsById / collectTabSessions：Map 与数组输入一致，按 startedAt 排序', () => {
  const sessions = [
    sessionFixture('s2', 9, { startedAt: NOW - 1_000 }),
    sessionFixture('s1', 9, { startedAt: NOW - 5_000 }),
    sessionFixture('bad', 'x'),
    { tabId: 9, startedAt: NOW },
  ];
  const index = indexSessionsById(sessions);
  assert.deepEqual([...index.keys()].sort(), ['bad', 's1', 's2']);
  const byTab = collectTabSessions(sessions);
  assert.deepEqual(byTab.get(9).map((item) => item.sessionId), ['s1', 's2']);
  const fromMap = indexSessionsById(new Map([['s1', sessions[1]]]));
  assert.equal(fromMap.get('s1').sessionId, 's1');
});

// ---------------------------------------------------------------------------
// 冲突不变量
// ---------------------------------------------------------------------------

test('detectOwnershipConflicts：holder 失联/参与者失联/stopping/重复参与者全覆盖', () => {
  const leases = [
    leaseFixture({
      tabId: 1,
      holder: 'ghost',
      participants: [{ sessionId: 'ghost' }],
      participantCount: 1,
    }),
    leaseFixture({
      tabId: 2,
      holder: 's1',
      participants: [{ sessionId: 's1' }, { sessionId: 's-dead' }, { sessionId: 's1' }],
      participantCount: 3,
    }),
    leaseFixture({
      tabId: 3,
      holder: 's2',
      participants: [{ sessionId: 's2' }],
      participantCount: 1,
    }),
  ];
  const sessions = [
    sessionFixture('s1', 2),
    sessionFixture('s2', 3),
    sessionFixture('s3', 4),
  ];
  const conflicts = detectOwnershipConflicts({
    leases,
    sessions,
    phases: { s2: 'stopping' },
    now: NOW,
    isAlive: (id) => ['s1', 's2', 's3'].includes(id),
  });
  const codes = conflicts.map((item) => item.code);
  assert.equal(codes.includes('lease-holder-missing'), true);
  assert.equal(codes.includes('lease-participant-missing'), true);
  assert.equal(codes.includes('lease-holder-stopping'), true);
  assert.equal(codes.includes('duplicate-participant'), true);
  assert.equal(codes.includes('session-without-lease'), true);
  const holderMissing = conflicts.find((item) => item.code === 'lease-holder-missing');
  assert.equal(holderMissing.severity, 'high');
  assert.equal(holderMissing.evidence.tabId, 1);
  assert.equal(holderMissing.evidence.holder, 'ghost');
  // 严重度排序：high 在 warn/info 之前。
  const ranks = conflicts.map((item) => (item.severity === 'high' ? 0 : item.severity === 'warn' ? 1 : 2));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('detectOwnershipConflicts：holder 不在参与者里 / 控制记录残留 / 空输入', () => {
  const conflicts = detectOwnershipConflicts({
    leases: [leaseFixture({
      tabId: 5,
      holder: 's1',
      participants: [{ sessionId: 's2' }],
      participantCount: 1,
    })],
    sessions: [sessionFixture('s1', 5), sessionFixture('s2', 5)],
    controls: [{ tabId: 99, mode: 'open' }],
    now: NOW,
    isAlive: () => true,
  });
  const codes = conflicts.map((item) => item.code);
  assert.equal(codes.includes('lease-holder-not-participant'), true);
  assert.equal(codes.includes('control-without-session'), true);
  // 会话 s1 是 holder 但不在参与者里：session-not-participant 不重复报，holder 不一致单独报。
  assert.equal(codes.filter((code) => code === 'lease-holder-not-participant').length, 1);
  assert.deepEqual(detectOwnershipConflicts({}), []);
  assert.deepEqual(detectOwnershipConflicts({ leases: [], sessions: [], controls: [] }), []);
});

// ---------------------------------------------------------------------------
// 所有权矩阵 / 单行视图
// ---------------------------------------------------------------------------

test('buildTabOwnershipRow：租约 + 会话角色 + 控制记录 + 冲突摘要', () => {
  const lease = leaseFixture({
    participants: [{ sessionId: 's1', role: 'holder' }, { sessionId: 's2', role: 'participant' }],
    participantCount: 2,
    shared: true,
  });
  const conflicts = [{ code: 'x', severity: 'warn', message: 'm', evidence: { tabId: 7 } }];
  const row = buildTabOwnershipRow({
    tabId: 7,
    lease,
    tabSessions: [sessionFixture('s2', 7, { startedAt: NOW - 500 }), sessionFixture('s1', 7, { startedAt: NOW - 3_000 })],
    phases: { s1: 'active', s2: 'preparing' },
    control: { mode: 'exclusive', epoch: 2, holder: 's1', primary: 's1', shared: true, sessionCount: 2 },
    now: NOW,
    isAlive: () => true,
    conflicts,
  });
  assert.equal(row.tabId, 7);
  assert.equal(row.state, 'shared');
  assert.equal(row.holder, 's1');
  assert.equal(row.holderPhase, 'active');
  assert.equal(row.sessionCount, 2);
  assert.deepEqual(row.sessions.map((item) => item.sessionId).sort(), ['s1', 's2']);
  assert.equal(row.sessions.find((item) => item.sessionId === 's1').role, 'holder');
  assert.equal(row.control.mode, 'exclusive');
  assert.equal(row.control.sessionCount, 2);
  assert.equal(row.conflictCount, 1);
  assert.deepEqual(row.conflicts.map((item) => item.code), ['x']);
  assert.equal(row.reclaimable, false);
  // 无租约但仍登记会话：free 行并保留 sessions。
  const orphanRow = buildTabOwnershipRow({
    tabId: 8,
    lease: null,
    tabSessions: [sessionFixture('s9', 8)],
    now: NOW,
    isAlive: () => true,
  });
  assert.equal(orphanRow.state, 'free');
  assert.equal(orphanRow.sessionCount, 1);
  assert.equal(buildTabOwnershipRow({ tabId: 'x' }), null);
});

test('buildOwnershipMatrix：多 tab 汇总 totals/orphans/conflicts，控制记录单独成行', () => {
  const leases = [
    leaseFixture({ tabId: 1, holder: 's1' }),
    leaseFixture({
      tabId: 2,
      holder: 'ghost',
      participants: [{ sessionId: 'ghost' }],
      participantCount: 1,
    }),
    leaseFixture({ tabId: 3, holder: 's3', expiresAt: NOW + 4_000 }),
  ];
  const sessions = [
    sessionFixture('s1', 1),
    sessionFixture('s3', 3),
    sessionFixture('s4', 4),
  ];
  const matrix = buildOwnershipMatrix({
    leases,
    sessions,
    phases: { s1: 'active', s3: 'active' },
    controls: [{ tabId: 5, mode: 'open' }],
    now: NOW,
    isAlive: (id) => ['s1', 's3', 's4'].includes(id),
  });
  assert.equal(matrix.schema, LEASE_OWNERSHIP_SCHEMA);
  assert.equal(matrix.kind, LEASE_OWNERSHIP_KIND);
  assert.deepEqual(matrix.rows.map((row) => row.tabId), [1, 2, 3, 4, 5]);
  assert.equal(matrix.totals.tabs, 5);
  assert.equal(matrix.totals.leasedTabs, 3);
  assert.equal(matrix.totals.orphanTabs, 1);
  assert.equal(matrix.totals.reclaimableTabs, 1);
  assert.equal(matrix.totals.expiringTabs, 1);
  assert.equal(matrix.totals.sessions, 3);
  assert.equal(matrix.totals.conflicts >= 2, true);
  assert.equal(matrix.totals.highConflicts >= 1, true);
  assert.deepEqual(matrix.orphans.map((item) => item.holder), ['ghost']);
});

// ---------------------------------------------------------------------------
// 回收 / 续租 / 对账计划
// ---------------------------------------------------------------------------

test('planExpiryReclaim：失联 holder 回收并先摘掉失联参与者，存活参与者成为晋升预期', () => {
  const plan = planExpiryReclaim({
    leases: [leaseFixture({
      tabId: 11,
      holder: 'dead',
      participants: [{ sessionId: 'dead' }, { sessionId: 'alive' }],
      participantCount: 2,
      expiresAt: NOW + 30_000,
    })],
    sessions: [sessionFixture('alive', 11)],
    now: NOW,
    isAlive: (id) => id === 'alive',
  });
  assert.equal(plan.stats.scanned, 1);
  assert.equal(plan.stats.reclaim, 1);
  assert.equal(plan.stats.skipped, 0);
  const item = plan.reclaim[0];
  assert.equal(item.tabId, 11);
  assert.equal(item.holder, 'dead');
  assert.equal(item.holderAlive, false);
  assert.deepEqual(item.actions.map((action) => action.action), ['release-holder']);
  assert.equal(item.actions[0].promoteExpected, 'alive');
  // 失联参与者在 actions 里先 detach（holder==dead 自身不 detach）。
  const withDeadParticipant = planExpiryReclaim({
    leases: [leaseFixture({
      tabId: 12,
      holder: 'dead',
      participants: [{ sessionId: 'dead' }, { sessionId: 'dead2' }, { sessionId: 'alive' }],
      participantCount: 3,
      expiresAt: NOW + 30_000,
    })],
    sessions: [sessionFixture('alive', 12)],
    now: NOW,
    isAlive: (id) => id === 'alive',
  });
  const actions = withDeadParticipant.reclaim[0].actions.map((action) => action.action);
  assert.deepEqual(actions, ['detach-participant', 'release-holder']);
  assert.equal(withDeadParticipant.reclaim[0].actions[0].sessionId, 'dead2');
});

test('planExpiryReclaim：存活 holder 的 TTL 过期默认跳过；显式 reclaimAliveExpired 才回收', () => {
  const leases = [leaseFixture({ tabId: 20, holder: 's1', expiresAt: NOW - 1 })];
  const sessions = [sessionFixture('s1', 20)];
  const conservative = planExpiryReclaim({ leases, sessions, now: NOW, isAlive: () => true });
  assert.equal(conservative.stats.reclaim, 0);
  assert.equal(conservative.stats.skipped, 1);
  assert.equal(conservative.skipped[0].reason, 'holder-alive-expired');
  assert.equal(conservative.skipped[0].expired, true);
  const forced = planExpiryReclaim({ leases, sessions, now: NOW, isAlive: () => true, reclaimAliveExpired: true });
  assert.equal(forced.stats.reclaim, 1);
  assert.equal(forced.reclaim[0].reason, 'ttl-expired-alive-forced');
  assert.equal(forced.reclaim[0].actions[0].action, 'release-holder');
  // 存活且新鲜：not-expired。
  const fresh = planExpiryReclaim({ leases: [leaseFixture({ tabId: 21, holder: 's1' })], sessions: [sessionFixture('s1', 21)], now: NOW, isAlive: () => true });
  assert.equal(fresh.skipped[0].reason, 'not-expired');
});

test('planExpiryReclaim：无 holder + 失联参与者 → force-clear；启动占位令牌不回收', () => {
  const plan = planExpiryReclaim({
    leases: [leaseFixture({
      tabId: 30,
      holder: null,
      participants: [{ sessionId: 'dead1' }, { sessionId: 'dead2' }],
      participantCount: 2,
      expiresAt: 0,
    })],
    sessions: [],
    now: NOW,
    isAlive: () => false,
  });
  assert.equal(plan.stats.reclaim, 1);
  const actions = plan.reclaim[0].actions;
  assert.equal(actions.filter((action) => action.action === 'detach-participant').length, 2);
  assert.equal(actions[actions.length - 1].action, 'force-clear');
  assert.equal(actions[actions.length - 1].by, 'lease-sweeper');
  const starting = planExpiryReclaim({
    leases: [leaseFixture({ tabId: 31, holder: 'start:tok', expiresAt: NOW + 30_000 })],
    sessions: [],
    now: NOW,
    isAlive: () => false,
  });
  assert.equal(starting.stats.reclaim, 0);
  assert.equal(starting.skipped[0].reason, 'not-expired');
});

test('planRenewals：due/expired/holder-missing/fresh 分类，按剩余时间排序', () => {
  const leases = [
    leaseFixture({ tabId: 40, holder: 's1', expiresAt: NOW + 20_000 }),
    leaseFixture({ tabId: 41, holder: 's1', expiresAt: NOW + 3_000 }),
    leaseFixture({ tabId: 42, holder: 'ghost', expiresAt: NOW + 3_000 }),
    leaseFixture({ tabId: 43, holder: 's1', expiresAt: NOW - 1 }),
  ];
  const plan = planRenewals({
    leases,
    sessions: [sessionFixture('s1', 40)],
    now: NOW,
    withinMs: 15_000,
    isAlive: (id) => id === 's1',
  });
  assert.deepEqual(plan.due.map((item) => item.tabId), [43, 41]);
  assert.equal(plan.due[0].reason, 'expired');
  assert.equal(plan.due[1].reason, 'due');
  assert.equal(plan.skipped.some((item) => item.reason === 'holder-missing'), true);
  assert.equal(plan.skipped.some((item) => item.reason === 'fresh'), true);
  assert.equal(plan.stats.due, 2);
});

test('planLeaseReconcile：adopt/join/releaseOrphans/conflicts 与 stopping 跳过', () => {
  const plan = planLeaseReconcile({
    leases: [
      leaseFixture({ tabId: 50, holder: 's1', participants: [{ sessionId: 's1' }], participantCount: 1, expiresAt: NOW + 30_000 }),
      leaseFixture({ tabId: 51, holder: 'ghost', participants: [{ sessionId: 'ghost' }], participantCount: 1 }),
    ],
    sessions: [
      sessionFixture('s1', 50),
      sessionFixture('s2', 50),
      sessionFixture('s3', 52),
      sessionFixture('s4', 52, { }),
    ],
    phases: { s4: 'stopping' },
    now: NOW,
    isAlive: (id) => id !== 'ghost',
  });
  assert.deepEqual(plan.adopt.map((item) => item.action).sort(), ['acquire', 'join']);
  const join = plan.adopt.find((item) => item.action === 'join');
  assert.equal(join.tabId, 50);
  assert.equal(join.sessionId, 's2');
  assert.equal(join.holder, 's1');
  const acquire = plan.adopt.find((item) => item.action === 'acquire');
  assert.equal(acquire.tabId, 52);
  // s3 在 52 上需要 acquire；s4 已 stopping 被跳过。
  assert.equal(plan.adopt.filter((item) => item.tabId === 52).map((item) => item.sessionId).join(','), 's3');
  assert.equal(plan.releaseOrphans.length, 1);
  assert.equal(plan.stats.adopt, 2);
  assert.equal(plan.renewals.stats.scanned, 2);
  assert.equal(plan.conflicts.some((item) => item.code === 'lease-holder-missing'), true);
});

// ---------------------------------------------------------------------------
// 报告结构与证据解释
// ---------------------------------------------------------------------------

test('buildLeaseReport：只读汇总矩阵/回收计划/续租/对账 + 截断标记', () => {
  const matrix = buildOwnershipMatrix({
    leases: [leaseFixture({ tabId: 1, holder: 's1' }), leaseFixture({ tabId: 2, holder: 's2' })],
    sessions: [sessionFixture('s1', 1), sessionFixture('s2', 2)],
    now: NOW,
    isAlive: () => true,
  });
  const reclaim = planExpiryReclaim({ leases: [], sessions: [], now: NOW });
  const renewals = planRenewals({ leases: [], sessions: [], now: NOW });
  const reconcile = planLeaseReconcile({ leases: [], sessions: [], now: NOW });
  const report = buildLeaseReport({
    matrix,
    reclaim,
    renewals,
    reconcile,
    counters: { acquire: 2 },
    sweeper: { running: false },
    evidence: [{ type: 'acquire' }, { type: 'renew' }],
    limit: 1,
    now: NOW,
  });
  assert.equal(report.schema, LEASE_OWNERSHIP_SCHEMA);
  assert.equal(report.kind, LEASE_OWNERSHIP_KIND);
  assert.equal(report.tabs.length, 1);
  assert.equal(report.tabsTruncated, true);
  assert.equal(report.tabsTotal, 2);
  assert.equal(report.reclaim.dryRun, true);
  assert.equal(report.counters.acquire, 2);
  assert.equal(report.sweeper.running, false);
  assert.equal(report.evidence.length, 2);
  // 不传 matrix 时自动构建空矩阵（不抛错）。
  const empty = buildLeaseReport({ now: NOW });
  assert.equal(empty.totals.tabs, 0);
  assert.equal(empty.reclaim, null);
});

test('describeLeaseConflict / describeLeaseState / summarizeConflicts：人话解释与计数', () => {
  const text = describeLeaseConflict({
    tabId: 7,
    holder: 's1',
    epoch: 3,
    reason: 'session-start',
    requestedBy: 's2',
    requestedReason: 'rebind',
    remainingMs: 42_500,
    participants: [{ sessionId: 's1' }, { sessionId: 's3' }],
  });
  assert.match(text, /tab 7/);
  assert.match(text, /s1/);
  assert.match(text, /epoch 3/);
  assert.match(text, /s2/);
  assert.match(text, /42\.5s/);
  assert.equal(describeLeaseConflict(null), '租约冲突：无证据');
  const state = describeLeaseState({ tabId: 9, holder: 's1', state: 'held', remainingMs: 1_500, sessionCount: 1, participantCount: 1 });
  assert.match(state, /tab 9/);
  assert.match(state, /holder=s1/);
  assert.equal(describeLeaseState(null), '未知 tab');
  const summary = summarizeConflicts([
    { code: 'a', severity: 'high' },
    { code: 'a', severity: 'warn' },
    { code: 'b', severity: 'info' },
    { code: 'b' },
  ]);
  assert.deepEqual(summary, { total: 4, high: 1, warn: 1, info: 2, byCode: { a: 2, b: 2 } });
  assert.deepEqual(summarizeConflicts(null), { total: 0, high: 0, warn: 0, info: 0, byCode: {} });
});
