// tests/unit/daemon-batch-arbitration-integration.test.mjs —— 批处理 + 配额 + 裁决 + CLI 渲染的**集成**单测。
//
// 与纯模块单测不同，这里把真实模块串起来（不启动 daemon）：
//   createSessionQuota → createBatchSessions（假 start/stop/navigate）
//   → batch 结果 → cli/lib/json-schema 校验 → cli/lib/exit-codes 退出码 → table-views 渲染
//   leaseOps（真实 detectOwnershipConflicts/buildOwnershipMatrix 计算冲突）→ createLeaseArbiter
//   → apply 后 residual 真的归零。
//
// 目的：捕获"每个模块单测都绿、但拼起来字段名/语义对不上"的集成漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionQuota } from '../../daemon/session-quota.js';
import { createBatchSessions } from '../../daemon/batch-sessions.js';
import { createLeaseArbiter } from '../../daemon/lease-arbitration.js';
import { detectOwnershipConflicts } from '../../daemon/lease-registry.js';
import { validateSchema } from '../../cli/lib/json-schema.mjs';
import { exitCodeForBatch, exitCodeForArbitration } from '../../cli/lib/exit-codes.mjs';
import {
  renderArbitrationPlan,
  renderBatchReport,
  renderQuota,
} from '../../cli/lib/table-views.mjs';

const NOW = 1_700_000_000_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBatchHarness(options = {}) {
  const state = {
    now: NOW,
    live: 0,
    sessions: new Set(),
    seq: 0,
    calls: { start: [], stop: [], navigate: [] },
    policy: { maxSessions: 6, maxPerBatch: 3, maxConcurrentStarts: 2, maxPerInstance: 6, maxBatchItems: 20, reservationTtlMs: 60_000, ...(options.policy || {}) },
  };
  const now = () => state.now;
  const quota = createSessionQuota({ policy: state.policy, liveSessions: () => state.live, now });
  const startImpl = options.start || (async () => {
    state.seq += 1;
    const sessionId = 'sess-' + state.seq;
    state.sessions.add(sessionId);
    state.live += 1;
    return { sessionId };
  });
  const batch = createBatchSessions({
    quota,
    startSession: async (params, timeoutMs) => {
      state.calls.start.push({ params: clone(params), timeoutMs });
      return startImpl(params, timeoutMs);
    },
    stopSession: async (params, timeoutMs) => {
      state.calls.stop.push({ params: clone(params), timeoutMs });
      if (params && params.session && state.sessions.delete(params.session)) state.live = Math.max(0, state.live - 1);
      return { ok: true };
    },
    navigate: async (sessionId, url, timeoutMs) => {
      state.calls.navigate.push({ sessionId, url, timeoutMs });
      return { ok: true, sessionId, url };
    },
    now,
    sleep: async () => {},
    BridgeError: class extends Error {},
    idFactory: options.idFactory || (() => 'b-' + (state.calls.start.length + 1)),
  });
  return { state, quota, batch };
}

// ---------------------------------------------------------------------------
// 批处理 → JSON schema → 退出码 → 表格渲染
// ---------------------------------------------------------------------------

test('集成：成功批次贯通 schema/退出码/表格（单行渲染包含条目与配额）', async () => {
  const { batch, quota, state } = makeBatchHarness();
  const report = await batch.start({
    items: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }],
    batchId: 'integration-ok',
  });
  // 1) schema：真实结果必须通过登记 schema。
  assert.deepEqual(validateSchema('bb.session-batch/1', report).problems, []);
  // 2) 退出码：全部成功 → 0。
  assert.equal(exitCodeForBatch(report), 0);
  // 3) 表格：批次摘要 + 条目 + 会话 id 都能渲染。
  const text = renderBatchReport(report);
  assert.match(text, /批次 integration-ok：completed \/ ok/);
  assert.match(text, /成功 2/);
  assert.match(text, /sess-1/);
  assert.match(text, /sess-2/);
  // 4) 配额：提交 2、无残留预约、live 与会话集合一致。
  const snapshot = quota.snapshot();
  assert.equal(snapshot.totals.used, 2);
  assert.equal(snapshot.reserved, 0);
  assert.equal(state.live, 2);
  // 5) 配额快照同样通过 schema，并能渲染。
  assert.deepEqual(validateSchema('bb.session-quota/1', snapshot).problems, []);
  assert.match(renderQuota(snapshot), /会话配额：存活 2\/6/);
});

test('集成：部分配额拒绝 → outcome=partial / 退出码 3 / schema 仍通过', async () => {
  const { batch } = makeBatchHarness({ policy: { maxSessions: 6, maxPerBatch: 2 } });
  const report = await batch.start({ items: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }, { url: 'https://c.example/' }] });
  assert.equal(report.outcome, 'partial');
  assert.equal(report.summary.succeeded, 2);
  assert.equal(report.summary.denied, 1);
  assert.equal(exitCodeForBatch(report), 3);
  assert.deepEqual(validateSchema('bb.session-batch/1', report).problems, []);
  assert.match(renderBatchReport(report), /配额拒绝 1/);
});

test('集成：失败批次 → 退出码 1，且失败条目错误码已登记（不是自定义 E_ 码）', async () => {
  const { batch } = makeBatchHarness({
    start: async () => { throw Object.assign(new Error('没有浏览器'), { code: 'E_NO_BROWSER' }); },
  });
  const report = await batch.start({ items: [{ url: 'https://fail.example/' }] });
  assert.equal(report.outcome, 'failed');
  assert.equal(exitCodeForBatch(report), 1);
  const item = report.items[0];
  assert.equal(item.state, 'failed');
  assert.equal(item.error.code, 'E_NO_BROWSER');
  assert.match(item.error.code, /^E_[A-Z0-9_]+$/);
  assert.deepEqual(validateSchema('bb.session-batch/1', report).problems, []);
});

test('集成：配额耗尽 → quota-denied / 退出码 4 / 计划产物可渲染', async () => {
  const { batch, quota } = makeBatchHarness({ policy: { maxSessions: 1, maxPerBatch: 1 } });
  quota.reserve('occupier', 1);
  const plan = batch.plan({ items: [{ url: 'https://a.example/' }] });
  assert.equal(plan.summary.admissable, 0);
  assert.deepEqual(validateSchema('bb.session-batch-plan/1', plan).problems, []);
  const report = await batch.start({ items: [{ url: 'https://a.example/' }] });
  assert.equal(report.outcome, 'quota-denied');
  assert.equal(exitCodeForBatch(report), 4);
  assert.equal(report.items[0].error.code, 'E_QUEUE_FULL');
});

test('集成：status 视图字段（snapshot）与 batch.recent 结构可被 schema 接受', async () => {
  const { batch } = makeBatchHarness();
  await batch.start({ items: [{ url: 'https://a.example/' }], batchId: 'view-b1' });
  const snapshot = batch.snapshot({ limit: 5 });
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.recent[0].batchId, 'view-b1');
  assert.equal(snapshot.quota.schema, 1);
  assert.equal(snapshot.quota.policy.maxSessions, 6);
  // 模拟 status views=batch 的信封，交给 status-views schema 的 batch 子 schema 校验。
  const envelope = {
    service: 'browser-bridge',
    version: '0.3.0',
    browsers: [],
    sessions: [],
    views: ['batch'],
    batch: snapshot,
  };
  const checked = validateSchema('bb.status-views/1', envelope);
  assert.deepEqual(checked.problems, []);
});

// ---------------------------------------------------------------------------
// 租约裁决 → 真实冲突矩阵 → apply → residual 归零
// ---------------------------------------------------------------------------

/**
 * 真实冲突计算 + 可变租约的 fake leaseOps：
 * - ownershipMatrix() 用 detectOwnershipConflicts 从当前 leases/sessions 现算冲突；
 * - 所有写操作都改内存数据，因此 apply 后 residual 能真实下降。
 */
function makeLiveLeaseOps({ leases = [], sessions = [], phases = new Map() } = {}) {
  const state = {
    leases: clone(leases),
    sessions: clone(sessions),
    phases: new Map(phases),
    calls: [],
  };
  const find = (tabId) => state.leases.find((item) => item.tabId === tabId) || null;
  const isAlive = (sessionId) => state.sessions.some((session) => session.sessionId === sessionId) && !['stopping', 'stopped'].includes(state.phases.get(sessionId));
  return {
    state,
    snapshot: () => clone(state.leases),
    ownershipMatrix: () => {
      const leasesNow = state.leases.map((item) => ({
        ...item,
        remainingMs: Math.max(0, Number(item.expiresAt || 0) - NOW),
        ttlMs: item.ttlMs || 60_000,
        participantCount: (item.participants || []).length,
        participants: item.participants || [],
      }));
      const conflicts = detectOwnershipConflicts({
        leases: leasesNow,
        sessions: state.sessions,
        phases: state.phases,
        now: NOW,
        isAlive,
      });
      return { leases: leasesNow, conflicts };
    },
    acquire: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'acquire', tabId, sessionId, options });
      if (find(tabId)) return { ok: false, code: 'E_TAB_LEASE_HELD' };
      state.leases.push({
        tabId, holder: sessionId, epoch: 1, acquiredAt: NOW, expiresAt: NOW + 60_000, ttlMs: 60_000,
        participants: [{ sessionId, attachedAt: NOW }],
      });
      return { ok: true };
    },
    join: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'join', tabId, sessionId, options });
      const item = find(tabId);
      if (!item) return { ok: false, code: 'E_TAB_LEASE_NOT_FOUND' };
      item.participants = item.participants || [];
      if (!item.participants.some((entry) => entry.sessionId === sessionId)) {
        item.participants.push({ sessionId, attachedAt: NOW });
      }
      item.participantCount = item.participants.length;
      return { ok: true, joined: true, holder: item.holder };
    },
    transfer: (tabId, from, to, options = {}) => {
      state.calls.push({ op: 'transfer', tabId, from, to, options });
      const item = find(tabId);
      if (!item || item.holder !== from) return false;
      item.holder = to;
      item.participants = item.participants || [];
      if (!item.participants.some((entry) => entry.sessionId === to)) item.participants.push({ sessionId: to, attachedAt: NOW });
      return true;
    },
    release: (tabId, sessionId, options = {}) => {
      state.calls.push({ op: 'release', tabId, sessionId, options });
      const item = find(tabId);
      if (!item) return { ok: false, code: 'E_TAB_LEASE_NOT_FOUND' };
      item.participants = (item.participants || []).filter((entry) => entry.sessionId !== sessionId);
      if (item.holder === sessionId) {
        const next = item.participants.find((entry) => entry.sessionId !== sessionId);
        item.holder = next ? next.sessionId : null;
      }
      if (!item.holder && !item.participants.length) {
        state.leases = state.leases.filter((entry) => entry.tabId !== tabId);
        return { ok: true, removed: true };
      }
      return { ok: true, promotedTo: item.holder };
    },
  };
}

function leaseFixture(overrides = {}) {
  return {
    tabId: 7,
    holder: 'dead',
    epoch: 2,
    acquiredAt: NOW - 10_000,
    expiresAt: NOW + 30_000,
    ttlMs: 60_000,
    participants: [{ sessionId: 'dead', attachedAt: NOW - 10_000 }, { sessionId: 's2', attachedAt: NOW - 9_000 }],
    ...overrides,
  };
}

function sessionFixture(sessionId, tabId, overrides = {}) {
  return { sessionId, tabId, startedAt: NOW - 9_000, lastAgentActivity: NOW - 1_000, ...overrides };
}

test('集成：holder 失联冲突 → apply transfer → residual 冲突归零（真实冲突矩阵）', () => {
  const ops = makeLiveLeaseOps({
    leases: [leaseFixture()],
    sessions: [sessionFixture('s2', 7)],
    phases: new Map([['s2', 'ready']]),
  });
  const before = ops.ownershipMatrix().conflicts;
  assert.ok(before.some((conflict) => conflict.code === 'lease-holder-missing'), JSON.stringify(before));
  const sessionMap = new Map([['s2', sessionFixture('s2', 7)]]);
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: sessionMap,
    phases: (sessionId) => (sessionMap.has(sessionId) ? 'ready' : null),
    now: () => NOW,
  });
  const result = arbiter.arbitrate({ apply: true });
  assert.equal(result.applied.summary.ok, 1);
  assert.equal(ops.state.leases[0].holder, 's2');
  // 真实冲突矩阵重算后，该 tab 不再有 lease-holder-missing。
  const after = ops.ownershipMatrix().conflicts.filter((conflict) => conflict.code === 'lease-holder-missing');
  assert.deepEqual(after, []);
  assert.equal(result.residual.residualConflicts <= result.summary.conflicts, true);
  // dry-run 与 apply 的退出码语义。
  assert.equal(exitCodeForArbitration(result, { apply: true }), 0);
});

test('集成：无租约多会话 → adopt+join → residual 冲突归零（跨会话裁决）', () => {
  const ops = makeLiveLeaseOps({
    leases: [],
    sessions: [sessionFixture('old', 9, { startedAt: NOW - 9_000 }), sessionFixture('new', 9, { startedAt: NOW - 1_000 })],
    phases: new Map([['old', 'ready'], ['new', 'ready']]),
  });
  assert.ok(ops.ownershipMatrix().conflicts.some((conflict) => conflict.code === 'session-without-lease'));
  const sessionMap = new Map(ops.state.sessions.map((session) => [session.sessionId, session]));
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: sessionMap,
    phases: (sessionId) => (sessionMap.has(sessionId) ? 'ready' : null),
    now: () => NOW,
  });
  const result = arbiter.arbitrate({ apply: true, strategy: 'fifo' });
  assert.equal(result.applied.summary.failed, 0);
  const lease = ops.state.leases.find((item) => item.tabId === 9);
  assert.ok(lease);
  assert.equal(lease.holder, 'old');
  assert.ok(lease.participants.some((entry) => entry.sessionId === 'new'));
  const leftover = ops.ownershipMatrix().conflicts.filter((conflict) => conflict.code === 'session-without-lease');
  assert.deepEqual(leftover, []);
});

test('集成：失联参与者 → prune → 参与者列表收敛', () => {
  const ops = makeLiveLeaseOps({
    leases: [{
      tabId: 5,
      holder: 'alive',
      epoch: 1,
      acquiredAt: NOW - 1000,
      expiresAt: NOW + 30_000,
      ttlMs: 60_000,
      participants: [{ sessionId: 'alive', attachedAt: NOW - 1000 }, { sessionId: 'ghost', attachedAt: NOW - 500 }],
    }],
    sessions: [sessionFixture('alive', 5)],
    phases: new Map([['alive', 'ready']]),
  });
  assert.ok(ops.ownershipMatrix().conflicts.some((conflict) => conflict.code === 'lease-participant-missing'));
  const sessionMap = new Map([['alive', sessionFixture('alive', 5)]]);
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: sessionMap,
    phases: () => 'ready',
    now: () => NOW,
  });
  const result = arbiter.arbitrate({ apply: true });
  assert.equal(result.applied.summary.failed, 0);
  const lease = ops.state.leases.find((item) => item.tabId === 5);
  assert.deepEqual(lease.participants.map((entry) => entry.sessionId), ['alive']);
  assert.deepEqual(ops.ownershipMatrix().conflicts.filter((conflict) => conflict.code === 'lease-participant-missing'), []);
});

test('集成：只读 report 零副作用；渲染表格包含 tab/动作/步骤', () => {
  const ops = makeLiveLeaseOps({
    leases: [leaseFixture()],
    sessions: [sessionFixture('s2', 7)],
    phases: new Map([['s2', 'ready']]),
  });
  const sessionMap = new Map([['s2', sessionFixture('s2', 7)]]);
  const arbiter = createLeaseArbiter({
    leaseOps: ops,
    sessions: sessionMap,
    phases: () => 'ready',
    now: () => NOW,
  });
  const report = arbiter.report({ limit: 5 });
  assert.equal(ops.state.calls.length, 0, 'report 不写');
  assert.ok(report.verdicts.length >= 1);
  const text = renderArbitrationPlan(report);
  assert.match(text, /租约裁决：/);
  assert.match(text, /7\s+high\s+promote/);
  assert.match(text, /holder-missing/);
  assert.match(text, /transfer/);
  // report 没有 applied 字段（只读语义），apply 才有。
  assert.equal(report.applied, undefined);
});
