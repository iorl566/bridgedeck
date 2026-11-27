// tests/unit/daemon-session-recovery.test.mjs —— daemon 启动恢复：持久化会话分类、账本 reconcile、
// 租约重建，以及真实 daemon 进程级的 recovery 证据 / ledger.resolve 分发语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SESSION_RECOVERY_TTL_MS,
  createSessionRecovery,
  planPersistedSessionRecovery,
  recoverLedgerOnStartup,
} from '../../daemon/session-recovery.js';
import { IntentLedger } from '../../lib/intent-ledger.mjs';
import { createSessionState } from '../../lib/session-state.mjs';
import { createSessionLeases } from '../../lib/session-lease.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SERVER = path.join(REPO, 'daemon', 'server.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-daemon-recovery-'));
}

function nowIso() {
  return new Date().toISOString();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpJson(port, method, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: method === 'GET' ? '/health' : '/rpc',
      headers: {
        ...(token ? { 'x-bridge-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, text }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForDaemon(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('daemon 提前退出：' + child.exitCode);
    try {
      const health = await httpJson(port, 'GET');
      if (health.status === 200 && health.json && health.json.ok) return health.json;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('daemon 未在 20s 内就绪');
}

function writeLegacyPending(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.wal'), JSON.stringify(entry) + '\n', 'utf8');
}

test('planPersistedSessionRecovery：restore/expired/invalid/duplicate 分类与证据', () => {
  const now = 1_700_000_000_000;
  const rows = [
    { sessionId: 'ok', instanceId: 'i1', tabId: 1, startedAt: now - 1_000 },
    { sessionId: 'old', instanceId: 'i1', tabId: 2, startedAt: now - SESSION_RECOVERY_TTL_MS - 1 },
    { sessionId: 'badtab', instanceId: 'i1', tabId: 'x', startedAt: now },
    { sessionId: 'nostart', instanceId: 'i1', tabId: 3, startedAt: 0 },
    { sessionId: 'ok', instanceId: 'i1', tabId: 4, startedAt: now },
    { instanceId: 'i1', tabId: 5, startedAt: now },
  ];
  const plan = planPersistedSessionRecovery(rows, { now });
  assert.deepEqual(plan.restore.map((item) => item.sessionId), ['ok']);
  assert.equal(plan.restore[0].restored, true);
  assert.deepEqual(plan.expired.map((item) => item.sessionId), ['old']);
  assert.equal(plan.expired[0].reason, 'ttl-expired');
  assert.deepEqual(plan.invalid.map((item) => item.reason), ['bad-tab-id', 'missing-startedAt', 'missing-session-id']);
  assert.deepEqual(plan.duplicates.map((item) => item.sessionId), ['ok']);
  assert.equal(plan.stats.total, 6);
  assert.equal(plan.stats.restore, 1);
  assert.equal(plan.stats.expired, 1);
  // 非数组/空输入不抛错。
  assert.equal(planPersistedSessionRecovery(null).stats.total, 0);
  assert.equal(planPersistedSessionRecovery([]).stats.restore, 0);
});

test('recoverLedgerOnStartup：pending→unknown 汇总；账本不可用时降级不抛错', () => {
  const dir = tempDir();
  const ledger = new IntentLedger({ dir, staleMs: 60_000 });
  ledger.begin('click', { ref: '@e1' }, { tabId: 71, sessionId: 's71' });
  ledger.begin('observe', {}, { tabId: 72 });
  const summary = recoverLedgerOnStartup(ledger, { reason: 'test-restart' });
  assert.equal(summary.ok, true);
  assert.equal(summary.recovered, 1, 'observe 不是变异动作，不入账');
  assert.equal(summary.unknown, 1);
  assert.equal(summary.replayBlocked, 1);
  const degraded = recoverLedgerOnStartup(null);
  assert.equal(degraded.ok, false);
  assert.equal(degraded.error, 'ledger-unavailable');
  const throwing = { recover: () => { throw new Error('boom'); } };
  const failed = recoverLedgerOnStartup(throwing);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /boom/);
});

test('createSessionRecovery：恢复计划 → 状态机 recovering + 同 tab 租约重建（最老会话为 holder）', () => {
  const state = createSessionState();
  const leases = createSessionLeases();
  const sessions = new Map();
  const recovery = createSessionRecovery({ sessions, sessionState: state, sessionLeases: leases, log: () => {} });
  const now = Date.now();
  const plan = planPersistedSessionRecovery([
    { sessionId: 's-old', instanceId: 'i1', tabId: 9, startedAt: now - 5_000 },
    { sessionId: 's-new', instanceId: 'i1', tabId: 9, startedAt: now - 1_000 },
    { sessionId: 's-other', instanceId: 'i1', tabId: 10, startedAt: now - 3_000 },
  ], { now });
  for (const item of plan.restore) sessions.set(item.sessionId, item.record);
  recovery.recordSessionPlan(plan);
  const applied = recovery.applySessionPlan(plan);
  assert.equal(applied.sessions, 3);
  assert.equal(state.phase('s-old'), 'recovering');
  assert.equal(state.canonicalPhase('s-new'), 'preparing');
  assert.equal(leases.ownerOf(9), 's-old', '同 tab 最老会话成为 holder');
  assert.equal(leases.participants(9).length, 2);
  assert.deepEqual(leases.participants(9).map((item) => item.sessionId).sort(), ['s-new', 's-old']);
  assert.equal(leases.ownerOf(10), 's-other');
  const snapshot = recovery.snapshot();
  assert.equal(snapshot.sessions.live, 3);
  assert.equal(snapshot.sessions.plan.restore, 3);
  assert.equal(snapshot.sessions.phases.length, 3);
  assert.equal(snapshot.leases.length, 2);
});

test('createSessionRecovery：租约冲突/异常只记日志，不影响其余 tab 恢复', () => {
  const state = createSessionState();
  const leases = createSessionLeases();
  const logs = [];
  const recovery = createSessionRecovery({ sessions: new Map(), sessionState: state, sessionLeases: leases, log: (line) => logs.push(line) });
  // 预置一个冲突 holder：s1 已占用 tab 1，但恢复计划要把它给 s2。
  leases.acquire(1, 's1', { reason: 'session-start' });
  const plan = planPersistedSessionRecovery([
    { sessionId: 's2', instanceId: 'i', tabId: 1, startedAt: Date.now() - 1_000 },
  ], {});
  recovery.recordSessionPlan(plan);
  const applied = recovery.applySessionPlan(plan);
  assert.equal(applied.sessions, 1);
  assert.equal(leases.ownerOf(1), 's1', '冲突时不抢已有 holder');
  assert.equal(state.phase('s2'), 'recovering');
});

test('真实 daemon 进程：启动恢复 pending→unknown、status.recovery 可见、ledger.resolve 强制显式结论', async () => {
  const home = tempDir();
  const pending = {
    id: 'lt_crash_click',
    at: nowIso(),
    method: 'click',
    tabId: 77,
    sessionId: 's-restored',
    keys: [],
    target: { ref: '@e9' },
    state: 'active',
    nonIdempotent: true,
  };
  writeLegacyPending(home, pending);
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({
    version: 1,
    sessions: [{ sessionId: 's-restored', instanceId: 'i-restored', tabId: 77, windowId: 0, url: '', title: '', startedAt: Date.now() - 5_000 }],
  }), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--foreground', '--port', String(port)], {
    cwd: REPO,
    env: {
      ...process.env,
      BB_HOME: home,
      BB_PORT: String(port),
      BB_DAEMON_TRACE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  try {
    const health = await waitForDaemon(port, child);
    assert.equal(health.ok, true);
    assert.equal(typeof health.sessions, 'number');
    const token = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).token;
    // /health 不暴露恢复细节，status 里才带 recovery 证据。
    const status = await httpJson(port, 'POST', { method: 'status', params: {} }, token);
    assert.equal(status.json.ok, true);
    const recovery = status.json.result.recovery;
    assert.ok(recovery, 'status 应包含 recovery');
    assert.equal(recovery.ledger.recovered >= 1, true);
    assert.equal(recovery.ledger.unknown >= 1, true);
    assert.equal(recovery.ledger.replayBlocked >= 1, true);
    assert.equal(recovery.sessions.plan.restore, 1);
    assert.equal(recovery.leases.length >= 1, true);
    // 持久化会话恢复后进入 preparing（对外 phase recovering）。
    const restored = status.json.result.sessions.find((item) => item.sessionId === 's-restored');
    assert.equal(restored.phase, 'recovering');
    assert.equal(restored.lease.holder, 's-restored');
    // 账本状态：pending 为 unknown。
    const ledgerStatus = await httpJson(port, 'POST', { method: 'ledger.status', params: {} }, token);
    assert.equal(ledgerStatus.json.ok, true);
    const unknownEntry = ledgerStatus.json.result.pending.find((item) => item.id === pending.id);
    assert.equal(unknownEntry.state, 'unknown');
    assert.equal(unknownEntry.recovered, true);
    // 旧结论不能解锁非幂等恢复动作。
    const rejected = await httpJson(port, 'POST', { method: 'ledger.resolve', params: { id: pending.id, outcome: 'abandoned' } }, token);
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.json.error.code, 'E_LEDGER_RESOLVE_REQUIRED');
    assert.deepEqual(rejected.json.error.data.allowedOutcomes, ['confirmed', 'not-applied']);
    // confirmed 后解锁。
    const resolved = await httpJson(port, 'POST', { method: 'ledger.resolve', params: { id: pending.id, outcome: 'confirmed' } }, token);
    assert.equal(resolved.json.ok, true);
    assert.equal(resolved.json.result.entry.state, 'resolved');
    assert.equal(resolved.json.result.entry.resolution.effect, 'applied');
    const after = await httpJson(port, 'POST', { method: 'ledger.status', params: {} }, token);
    assert.equal(after.json.result.pending.some((item) => item.id === pending.id), false);
    // 165 方法分发语义未变：未知方法仍然 404。
    const unknownMethod = await httpJson(port, 'POST', { method: 'no.such.method', params: {} }, token);
    assert.equal(unknownMethod.status, 404);
    assert.equal(unknownMethod.json.error.code, 'E_UNKNOWN_METHOD');
  } finally {
    try { await httpJson(port, 'POST', { method: 'daemon.stop', params: {} }); } catch { /* 忽略 */ }
    await sleep(300);
    if (child.exitCode === null) child.kill();
    await sleep(200);
    assert.equal(output.includes('daemon 启动失败'), false, output.slice(-2000));
  }
});
