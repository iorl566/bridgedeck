// tests/unit/session-recovery-e2e.test.mjs —— 真实 daemon 进程级端到端：
// 崩溃恢复（WAL pending→unknown、会话/租约重建、恢复报告）、status 增量视图（leases/boundary）、
// ledger.status recovery / ledger.resolve 计划-执行两段式，以及默认载荷零变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SERVER = path.join(REPO, 'daemon', 'server.mjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-daemon-lease-e2e-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function httpJson(port, method, body, token) {
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

test('真实 daemon：崩溃恢复报告 + 租约/命令边界视图 + 人工 resolve 两段式（默认载荷不变）', async () => {
  const home = tempDir();
  const crashId = 'lt_crash_e2e_click';
  fs.writeFileSync(path.join(home, 'ledger.wal'), JSON.stringify({
    id: crashId,
    at: new Date().toISOString(),
    method: 'click',
    tabId: 77,
    sessionId: 's-restored',
    keys: [],
    target: { ref: '@e9' },
    state: 'active',
    nonIdempotent: true,
  }) + '\n', 'utf8');
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({
    version: 1,
    sessions: [{ sessionId: 's-restored', instanceId: 'i-restored', tabId: 77, windowId: 0, url: '', title: '', startedAt: Date.now() - 5_000 }],
  }), 'utf8');
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--foreground', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, BB_HOME: home, BB_PORT: String(port), BB_DAEMON_TRACE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  try {
    const health = await waitForDaemon(port, child);
    assert.equal(health.ok, true);
    const token = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).token;
    const rpc = (method, params) => httpJson(port, 'POST', { method, params }, token);

    // ---- 默认 status 载荷不变（新视图只在显式请求时出现） ----
    const plain = await rpc('status', {});
    assert.equal(plain.json.ok, true);
    const plainKeys = Object.keys(plain.json.result);
    assert.equal(plainKeys.includes('leases'), false);
    assert.equal(plainKeys.includes('boundary'), false);
    assert.equal(plainKeys.includes('recovery'), true);
    // recovery 子树新增 leaseReconcile/report 字段（只加不改）。
    const recovery = plain.json.result.recovery;
    assert.ok(recovery.ledger);
    assert.equal(recovery.ledger.recovered >= 1, true);
    assert.ok('leaseReconcile' in recovery);
    assert.ok('report' in recovery);
    assert.equal(recovery.report.autoResolved, 0);
    assert.equal(recovery.report.explicitOnly >= 1, true);
    assert.ok(Array.isArray(recovery.leases));
    assert.equal(recovery.leases.length >= 1, true);

    // ---- status views=leases：真实所有权报告（恢复会话是 holder） ----
    const leasesView = await rpc('status', { views: ['leases'], limit: 5 });
    assert.equal(leasesView.json.ok, true);
    const leases = leasesView.json.result.leases;
    assert.equal(leases.kind, 'bridge/tab-ownership');
    assert.equal(leases.totals.tabs >= 1, true);
    const restoredTab = leases.tabs.find((row) => row.tabId === 77);
    assert.ok(restoredTab, '恢复会话的 tab 应出现在所有权矩阵');
    assert.equal(restoredTab.holder, 's-restored');
    assert.equal(restoredTab.state, 'held');
    assert.deepEqual(leasesView.json.result.views, ['leases']);
    assert.equal(leasesView.json.result.leases.reclaim.dryRun, true);

    // ---- status views=boundary：命令边界矩阵（165 方法） ----
    const boundaryView = await rpc('status', { views: ['boundary'], limit: 5 });
    assert.equal(boundaryView.json.ok, true);
    const boundary = boundaryView.json.result.boundary;
    assert.equal(boundary.kind, 'bridge/command-boundary');
    assert.equal(boundary.counts.total >= 150, true);
    assert.equal(boundary.invariantOk, true);
    assert.equal(boundary.timeoutClasses.mutation.defaultMs > 0, true);

    // ---- ledger.status 默认载荷不变；recovery=true 才追加恢复报告 ----
    const ledgerPlain = await rpc('ledger.status', {});
    assert.equal(ledgerPlain.json.result.snapshot, undefined);
    assert.equal(ledgerPlain.json.result.recoveryReport, undefined);
    const ledgerRecovery = await rpc('ledger.status', { recovery: true });
    assert.equal(ledgerRecovery.json.ok, true);
    const report = ledgerRecovery.json.result.recoveryReport;
    assert.ok(report, 'recovery=true 应返回恢复报告');
    assert.equal(report.summary.autoResolved, 0);
    assert.equal(report.summary.explicitOnly >= 1, true);
    assert.equal(report.manualResolve.policy.autoResolve, false);
    assert.equal(report.manualResolve.required.some((item) => item.id === crashId), true);
    assert.equal(report.ledger.pending >= 1, true);

    // ---- 人工 resolve 计划（dryRun）：旧结论被 protected，不写账本 ----
    const dry = await rpc('ledger.resolve', { ids: [crashId], outcome: 'abandoned', dryRun: true });
    assert.equal(dry.json.ok, true);
    assert.equal(dry.json.result.dryRun, true);
    assert.equal(dry.json.result.counts.protected, 1);
    const singleDry = await rpc('ledger.resolve', { id: crashId, outcome: 'confirmed', dryRun: true });
    assert.equal(singleDry.json.ok, true);
    assert.equal(singleDry.json.result.counts.eligible, 1);
    const stillPending = await rpc('ledger.status', {});
    assert.equal(stillPending.json.result.pending.some((item) => item.id === crashId), true, 'dryRun 不写账本');

    // ---- 显式 confirmed 后解锁；非幂等恢复意图不再阻断 ----
    const applied = await rpc('ledger.resolve', { ids: [crashId], outcome: 'confirmed', by: 'e2e' });
    assert.equal(applied.json.ok, true);
    assert.equal(applied.json.result.counts.resolved, 1);
    assert.equal(applied.json.result.autoResolved, 0);
    const after = await rpc('ledger.status', {});
    assert.equal(after.json.result.pending.some((item) => item.id === crashId), false);

    // ---- 既有单条 resolve 默认语义不变：缺 id 仍 E_BAD_ARG ----
    const badResolve = await rpc('ledger.resolve', {});
    assert.equal(badResolve.json.ok, false);
    assert.equal(badResolve.json.error.code, 'E_BAD_ARG');

    // ---- session.list 仍透出租约（holder 为恢复会话） ----
    const sessionList = await rpc('session.list', {});
    assert.equal(sessionList.json.ok, true);
    const restored = sessionList.json.result.sessions.find((item) => item.sessionId === 's-restored');
    assert.ok(restored);
    assert.equal(restored.lease.holder, 's-restored');
    assert.equal(restored.phase, 'recovering');

    // ---- 未知方法语义未变 ----
    const unknown = await httpJson(port, 'POST', { method: 'no.such.method', params: {} }, token);
    assert.equal(unknown.status, 404);
  } finally {
    try { await httpJson(port, 'POST', { method: 'daemon.stop', params: {} }); } catch { /* 忽略 */ }
    await sleep(300);
    if (child.exitCode === null) child.kill();
    await sleep(150);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
    assert.equal(output.includes('daemon 启动失败'), false, output.slice(-2000));
  }
});
