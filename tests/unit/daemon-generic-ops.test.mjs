// tests/unit/daemon-generic-ops.test.mjs —— 兼容基线对齐的通用 RPC：
//   * cancel { rpc_id }      —— 按调用方 rpc_id（或内部命令 id）取消进行中的 daemon→扩展命令
//   * ledger.request         —— action=status|resolve 的通用账本入口
//
// 两层证据：
//   1) 纯函数层：createGenericOps 的错误码/回包形状/转发链路（假 inflight + 假账本）；
//   2) 真实 daemon 进程：两个方法都不再 404（进入 LOCAL 路由），ledger.request 真跑
//      意图账本（status 默认载荷 + resolve 真解锁非幂等恢复动作），cancel 对未知 id
//      回 cancelled:false 而不是报错（兼容基线 “RPC 本身不报错”的语义）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createGenericOps, GENERIC_RPC_METHODS, LEDGER_REQUEST_ACTIONS } from '../../daemon/generic-ops.js';
import { normalizeRpcId, currentRpcId, runWithRpcId } from '../../daemon/request-context.js';

class TestBridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SERVER = path.join(REPO, 'daemon', 'server.mjs');

function fakeOps(overrides = {}) {
  const calls = [];
  const inflight = new Map();
  inflight.set('cmd-1', { id: 'cmd-1', method: 'click', rpcId: 'rpc-1', instanceId: 'i-1', tabId: 9, startedAt: Date.now() });
  const ledgerEntries = [];
  const ledger = {
    status({ limit } = {}) {
      return {
        staleMs: 15000,
        pending: [{ id: 'lt_1', method: 'click', state: 'unknown', tabId: 9 }],
        recent: [{ id: 'lt_1', method: 'click', state: 'unknown' }],
        recovery: { recovered: 1 },
        wal: { writes: 3 },
        durability: { fsync: true },
        limit,
      };
    },
    resolve(id, outcome, options) {
      const entry = { id, outcome, state: 'resolved', by: options && options.by };
      ledgerEntries.push(entry);
      return entry;
    },
  };
  const ledgerReport = {
    reconcile(params) {
      calls.push(['reconcile', params]);
      return { ok: true, dryRun: params.dryRun === true, candidates: 1, resolved: params.dryRun === true ? 0 : 1, params };
    },
  };
  const recoveryReporter = {
    manualResolve(params) {
      calls.push(['manualResolve', params]);
      return { ok: true, dryRun: params.dryRun === true, candidates: params.ids.length, resolved: params.ids.length };
    },
  };
  const ops = createGenericOps({
    inflight,
    instances: new Map(),
    inflightList: () => [],
    cancelInflight: async (params) => {
      calls.push(['cancelInflight', params]);
      const entry = inflight.get(params.id);
      return {
        id: params.id,
        forwarded: Boolean(entry),
        accepted: Boolean(entry),
        ...(entry ? { boundary: { method: entry.method, idempotent: false } } : {}),
      };
    },
    cancelStartRequest: (params) => {
      calls.push(['cancelStartRequest', params]);
      throw new TestBridgeError('E_NOT_FOUND', '没有这个 start request');
    },
    ledger,
    ledgerReport,
    recoveryReporter,
    resolveSession: (sessionId) => {
      if (sessionId === 's-9') return { sessionId, tabId: 9 };
      throw new Error('session not found');
    },
    getOperation: (id) => (id === 'op-done' ? { id, state: 'done' } : null),
    BridgeError: TestBridgeError,
    log: () => {},
    ...overrides,
  });
  return { ops, calls, inflight, ledgerEntries };
}

test('request-context：rpc_id 归一化与 AsyncLocalStorage 传播', async () => {
  assert.equal(normalizeRpcId(undefined), null);
  assert.equal(normalizeRpcId(''), null);
  assert.equal(normalizeRpcId(0), '0');
  assert.equal(normalizeRpcId(42), '42');
  assert.equal(normalizeRpcId(' r1 '), 'r1');
  assert.equal(currentRpcId(), null);
  await runWithRpcId('rpc-9', async () => {
    assert.equal(currentRpcId(), 'rpc-9');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(currentRpcId(), 'rpc-9', 'await 之后上下文仍在');
  });
  assert.equal(currentRpcId(), null, '离开上下文后不泄漏');
});

test('cancel：按调用方 rpc_id 或内部 id 都能命中并转发；未知 id 回 cancelled:false', async () => {
  const { ops, calls } = fakeOps();
  const byRpcId = await ops.cancel({ rpc_id: 'rpc-1' });
  assert.equal(byRpcId.cancelled, true);
  assert.equal(byRpcId.forwarded, true);
  assert.equal(byRpcId.id, 'cmd-1');
  assert.equal(byRpcId.method, 'click');
  assert.equal(byRpcId.rpc_id, 'rpc-1');
  assert.ok(byRpcId.boundary, '取消回包带边界证据');
  assert.deepEqual(calls.at(-1), ['cancelInflight', { id: 'cmd-1' }]);

  const byId = await ops.cancel({ id: 'cmd-1' });
  assert.equal(byId.cancelled, true);
  assert.equal(byId.accepted, true, '兼容既有 command.cancel 的 accepted 字段');

  const unknown = await ops.cancel({ rpc_id: 'no-such-rpc' });
  assert.deepEqual(unknown, { rpc_id: 'no-such-rpc', cancelled: false, forwarded: false, reason: 'no-inflight' });

  const finished = await ops.cancel({ operation_id: 'op-done' });
  assert.equal(finished.cancelled, false);
  assert.equal(finished.reason, 'operation-finished');
  assert.equal(finished.operation.state, 'done');
});

test('cancel：缺 id / 取消 cancel 自身 / pending start-request 的语义', async () => {
  const { ops, calls, inflight } = fakeOps();
  await assert.rejects(() => ops.cancel({}), (error) => error.code === 'E_BAD_ARG');
  inflight.set('cmd-2', { id: 'cmd-2', method: 'cancel', rpcId: 'rpc-2', instanceId: 'i-1', startedAt: Date.now() });
  await assert.rejects(() => ops.cancel({ rpc_id: 'rpc-2' }), (error) => error.code === 'E_BAD_ARG');
  const pending = await ops.cancel({ request_id: 'req-1' });
  assert.equal(pending.cancelled, false);
  assert.equal(pending.reason, 'E_NOT_FOUND');
  assert.deepEqual(calls.at(-1), ['cancelStartRequest', { requestId: 'req-1' }]);
});

test('ledger.request status：默认 action=status，返回 兼容形状 + 既有字段', async () => {
  const { ops } = fakeOps();
  const reply = await ops.ledgerRequest({ limit: 5 });
  assert.equal(reply.action, 'status');
  assert.equal(reply.session_id, null);
  assert.equal(reply.frozen, true, '存在 unknown 意图时 frozen=true');
  assert.equal(reply.pending_unknown.length, 1);
  assert.equal(Array.isArray(reply.pending), true, '既有 pending 字段保留');
  assert.equal(Array.isArray(reply.recent), true, '既有 recent 字段保留');
  assert.equal(reply.wal.writes, 3);
  assert.equal(reply.durability.fsync, true);

  const bySession = await ops.ledgerRequest({ action: 'status', session_id: 's-9' });
  assert.equal(bySession.session_id, 's-9');
});

test('ledger.request resolve：operation_id 单条 / tab_id 批量 / 缺目标 E_BAD_ARG', async () => {
  const { ops, calls, ledgerEntries } = fakeOps();
  const single = await ops.ledgerRequest({ action: 'resolve', operation_id: 'lt_1', outcome: 'confirmed' });
  assert.equal(single.action, 'resolve');
  assert.equal(single.resolved_count, 1);
  assert.equal(ledgerEntries.at(-1).by, 'rpc-ledger-request');
  assert.equal(single.entry.state, 'resolved');

  const planned = await ops.ledgerRequest({ action: 'resolve', operation_id: 'lt_1', outcome: 'confirmed', dryRun: true });
  assert.equal(planned.dry_run, true);
  assert.equal(planned.resolved_count, undefined);

  const bySession = await ops.ledgerRequest({ action: 'resolve', session_id: 's-9', outcome: 'confirmed' });
  assert.equal(bySession.tab_id, 9);
  assert.deepEqual(calls.find(([name]) => name === 'reconcile')[1].tabId, 9);

  const byTab = await ops.ledgerRequest({ action: 'resolve', tab_id: 12, outcome: 'reconciled', dryRun: true });
  assert.equal(byTab.dry_run, true);
  assert.equal(byTab.tab_id, 12);

  const ids = await ops.ledgerRequest({ action: 'resolve', ids: ['lt_1', 'lt_2'], outcome: 'confirmed' });
  assert.equal(ids.candidates, 2);
  assert.deepEqual(calls.find(([name]) => name === 'manualResolve')[1].ids, ['lt_1', 'lt_2']);

  await assert.rejects(
    () => ops.ledgerRequest({ action: 'resolve', outcome: 'confirmed' }),
    (error) => error.code === 'E_BAD_ARG' && Array.isArray(error.data.allowedActions),
  );
});

test('ledger.request：非法 action / 账本不可用都给出明确错误码', async () => {
  const { ops } = fakeOps();
  await assert.rejects(
    () => ops.ledgerRequest({ action: 'prune' }),
    (error) => error.code === 'E_BAD_ARG'
      && error.data.allowedActions.join(',') === LEDGER_REQUEST_ACTIONS.join(','),
  );
  const { ops: broken } = fakeOps({ ledger: null });
  await assert.rejects(() => broken.ledgerRequest({ action: 'status' }), (error) => error.code === 'E_INTERNAL');
});

test('GENERIC_RPC_METHODS：两个方法名与目录 DAEMON_ONLY 一致（防止复制粘贴漂移）', async () => {
  const { DAEMON_ONLY_METHODS } = await import('../../lib/method-catalog.mjs');
  assert.deepEqual([...GENERIC_RPC_METHODS].sort(), ['cancel', 'ledger.request']);
  for (const method of GENERIC_RPC_METHODS) assert.ok(DAEMON_ONLY_METHODS.includes(method), method);
});

// ---------------------------------------------------------------------------
// 真实 daemon 进程：RPC 入口 + 真实意图账本
// ---------------------------------------------------------------------------

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-generic-ops-'));
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

async function httpJson(port, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/rpc',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(token ? { 'x-bridge-token': token } : {}),
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
    req.write(payload);
    req.end();
  });
}

async function waitForDaemon(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('daemon 提前退出：' + child.exitCode);
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/health' }, (reply) => {
          const chunks = [];
          reply.on('data', (chunk) => chunks.push(chunk));
          reply.on('end', () => resolve({ status: reply.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
      });
      if (res.status === 200) return JSON.parse(res.text);
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('daemon 未在 20s 内就绪');
}

test('真实 daemon 进程：cancel / ledger.request 进入 LOCAL 路由并真跑账本', async () => {
  const home = tempDir();
  // 崩溃遗留：非幂等 click 的 pending 意图，启动后升级成 unknown（需要显式 resolve 才能解锁）。
  fs.writeFileSync(path.join(home, 'ledger.wal'), JSON.stringify({
    id: 'lt_crash_click',
    at: new Date().toISOString(),
    method: 'click',
    tabId: 77,
    sessionId: 's-restored',
    keys: [],
    target: { ref: '@e9' },
    state: 'active',
    nonIdempotent: true,
  }) + '\n', 'utf8');
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
    await waitForDaemon(port, child);
    const token = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8')).token;

    // 1) cancel 已进入 LOCAL 路由（不再 404），未知 id 按 兼容语义回 cancelled:false。
    const unknown = await httpJson(port, { method: 'cancel', params: { rpc_id: 'no-such-rpc' } }, token);
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.ok, true);
    assert.equal(unknown.json.result.cancelled, false);
    assert.equal(unknown.json.result.reason, 'no-inflight');
    // 缺 rpc_id：参数层 E_BAD_ARG。
    const badCancel = await httpJson(port, { method: 'cancel', params: {} }, token);
    assert.equal(badCancel.json.ok, false);
    assert.equal(badCancel.json.error.code, 'E_BAD_ARG');
    // 带调用方 rpc_id 的正常 RPC 不应被 request-context 破坏。
    const status = await httpJson(port, { method: 'status', params: {}, rpc_id: 'rpc-77' }, token);
    assert.equal(status.json.ok, true);

    // 2) ledger.request status：默认（action 省略）等于 status，带 兼容形状 + 既有字段。
    const ledgerStatus = await httpJson(port, { method: 'ledger.request', params: {} }, token);
    assert.equal(ledgerStatus.json.ok, true);
    const statusReply = ledgerStatus.json.result;
    assert.equal(statusReply.action, 'status');
    assert.equal(Array.isArray(statusReply.pending), true);
    assert.equal(Array.isArray(statusReply.recent), true);
    assert.equal(Array.isArray(statusReply.pending_unknown), true);
    assert.equal(statusReply.frozen, true, '崩溃遗留 unknown 意图 → frozen');
    assert.ok(statusReply.pending.some((entry) => entry.id === 'lt_crash_click'));

    // 3) ledger.request resolve：非幂等恢复动作先用错结论被拒（真实账本裁定）。
    const rejected = await httpJson(port, {
      method: 'ledger.request',
      params: { action: 'resolve', operation_id: 'lt_crash_click', outcome: 'abandoned' },
    }, token);
    assert.equal(rejected.json.ok, false);
    assert.equal(rejected.json.error.code, 'E_LEDGER_RESOLVE_REQUIRED');
    // 正确结论真解锁。
    const resolved = await httpJson(port, {
      method: 'ledger.request',
      params: { action: 'resolve', operation_id: 'lt_crash_click', outcome: 'confirmed' },
    }, token);
    assert.equal(resolved.json.ok, true);
    assert.equal(resolved.json.result.resolved_count, 1);
    assert.equal(resolved.json.result.entry.state, 'resolved');
    // 非法 action：参数层拒绝并给出允许清单。
    const badAction = await httpJson(port, { method: 'ledger.request', params: { action: 'prune' } }, token);
    assert.equal(badAction.json.ok, false);
    assert.equal(badAction.json.error.code, 'E_BAD_ARG');
    assert.deepEqual(badAction.json.error.data.allowedActions, ['status', 'resolve']);
    // 解锁后再看 status：pending 里不再有该条。
    const after = await httpJson(port, { method: 'ledger.request', params: { action: 'status' } }, token);
    assert.equal(after.json.result.pending.some((entry) => entry.id === 'lt_crash_click'), false);
  } finally {
    try { await httpJson(port, { method: 'daemon.stop', params: {} }); } catch { /* 忽略 */ }
    await sleep(300);
    if (child.exitCode === null) child.kill();
    await sleep(200);
    assert.equal(output.includes('daemon 启动失败'), false, output.slice(-2000));
  }
});
