// tests/unit/daemon-cli-batch-dispatch.test.mjs —— `bridge daemon batch|lease` 子命令接线 +
// 既有 daemon 子命令零回归（cli/commands/daemon.mjs）。
//
// 目的：命令面接线（bridge.mjs → createDaemonCommand → batch/lease 命令模块）以前没有单测，
// 一旦有人重构 daemon 子命令分发，batch/lease 很容易静默丢失。这里用纯 fake ctx 覆盖：
// - batch/lease 分派到注入的命令函数；
// - 未装配时给出明确 ArgError；
// - 未知子命令的用法文本包含 batch/lease；
// - ledger/transfer/queue/doctor/status 的既有 RPC 参数与输出不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonCommand } from '../../cli/commands/daemon.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

function makeHarness(options = {}) {
  const state = {
    rpc: [],
    emitted: [],
    printed: [],
    batch: [],
    lease: [],
    logCalls: 0,
  };
  const ctx = {
    SERVER_PATH: 'daemon/server.mjs',
    REPO_ROOT: '/repo',
    HOME_DIR: '/tmp/home',
    ensureDaemon: async () => ({ pid: 1, port: 52900 }),
    stopDaemon: async () => ({ stopped: true }),
    locateDaemon: async () => ({ info: { port: 52900 }, health: { pid: 42, port: 52900, version: '0.3.0', uptimeMs: 65_000, browsers: 1, sessions: 2 } }),
    setDaemonInfo: () => {},
    callRpc: async (method, params) => {
      state.rpc.push({ method, params: JSON.parse(JSON.stringify(params || {})) });
      if (method === 'ledger.status') return { ok: true, result: { pending: [], recent: [], wal: { parsed: 0, lines: 0 }, durability: { fsync: true } } };
      if (method === 'status') return { ok: true, result: { doctor: { status: 'ok', checks: [] }, transfers: { quota: { maxConcurrent: 4 }, counts: { active: 0 }, transfers: [] }, queue: { fairness: { strategy: 'round-robin-per-tab' }, totals: {}, limits: {} } } };
      return { ok: true, result: {} };
    },
    timeoutOf: () => 60_000,
    outputFailure: () => 1,
    outputJsonBody: (body) => { state.emitted.push(body); return 0; },
    emitJson: (value) => { state.emitted.push(value); },
    isJson: () => options.json === true,
    print: (text) => { state.printed.push(text); },
    daemonLog: () => { state.logCalls += 1; return 0; },
    cmdBatch: options.cmdBatch === undefined
      ? (flags, pos) => { state.batch.push({ flags, pos }); return options.batchCode ?? 0; }
      : options.cmdBatch,
    cmdLease: options.cmdLease === undefined
      ? (flags, pos) => { state.lease.push({ flags, pos }); return options.leaseCode ?? 0; }
      : options.cmdLease,
  };
  return { ctx, state, cmdDaemon: createDaemonCommand(ctx) };
}

test('daemon batch：分派给注入的 batch 命令函数（原样传 flags/pos）', async () => {
  const { cmdDaemon, state } = makeHarness({ batchCode: 3 });
  const flags = { json: true, 'on-error': 'abort' };
  const pos = ['daemon', 'batch', 'start', '--json'];
  const code = await cmdDaemon(flags, pos);
  assert.equal(code, 3);
  assert.equal(state.batch.length, 1);
  assert.equal(state.batch[0].flags, flags);
  assert.deepEqual(state.batch[0].pos, pos);
  assert.equal(state.rpc.length, 0, 'batch 子命令自己发 RPC，daemon 分发层不重复调用');
});

test('daemon lease：分派给注入的 lease 命令函数', async () => {
  const { cmdDaemon, state } = makeHarness({ leaseCode: 1 });
  const pos = ['daemon', 'lease', 'arbitrate', '--apply', '--yes'];
  const flags = { apply: true, yes: true };
  assert.equal(await cmdDaemon(flags, pos), 1);
  assert.equal(state.lease.length, 1);
  assert.deepEqual(state.lease[0].pos, pos);
  assert.equal(state.lease[0].flags, flags);
});

test('daemon batch/lease：未装配命令函数时给出明确 ArgError', async () => {
  const { cmdDaemon } = makeHarness({ cmdBatch: null, cmdLease: null });
  await assert.rejects(cmdDaemon({}, ['daemon', 'batch', 'quota']), (error) => {
    assert.ok(error instanceof ArgError);
    assert.match(error.message, /batch/);
    return true;
  });
  await assert.rejects(cmdDaemon({}, ['daemon', 'lease', 'report']), (error) => {
    assert.ok(error instanceof ArgError);
    assert.match(error.message, /lease/);
    return true;
  });
});

test('daemon 未知子命令：用法文本包含 batch/lease 与既有子命令（不回归）', async () => {
  const { cmdDaemon } = makeHarness();
  await assert.rejects(cmdDaemon({}, ['daemon', 'nope']), (error) => {
    assert.ok(error instanceof ArgError);
    for (const word of ['start', 'stop', 'status', 'ledger', 'transfer', 'queue', 'doctor', 'batch', 'lease']) {
      assert.ok(error.message.includes(word), '用法缺少 ' + word);
    }
    return true;
  });
});

test('既有 daemon ledger：RPC 参数与人类输出不变（新增子命令不影响）', async () => {
  const { cmdDaemon, state } = makeHarness();
  const code = await cmdDaemon({ limit: '5' }, ['daemon', 'ledger']);
  assert.equal(code, 0);
  assert.equal(state.rpc[0].method, 'ledger.status');
  assert.equal(state.rpc[0].params.limit, 5);
  assert.match(state.printed.join('\n'), /账本：待确认/);
});

test('既有 daemon transfer/queue：仍通过 status 增量视图取数', async () => {
  const { cmdDaemon, state } = makeHarness();
  await cmdDaemon({}, ['daemon', 'transfer']);
  assert.deepEqual(state.rpc[0], { method: 'status', params: { views: ['transfers'], limit: 20 } });
  await cmdDaemon({}, ['daemon', 'queue']);
  assert.deepEqual(state.rpc[1], { method: 'status', params: { views: ['queues'], limitSessions: 50, limit: 20 } });
});

test('既有 daemon doctor：views 参数保持（ledger/transfers/queues）', async () => {
  const { cmdDaemon, state } = makeHarness();
  await cmdDaemon({}, ['daemon', 'doctor']);
  assert.equal(state.rpc[0].method, 'status');
  assert.deepEqual(state.rpc[0].params.views, ['ledger', 'transfers', 'queues']);
  assert.equal(state.rpc[0].params.doctor, true);
});

test('既有 daemon status：JSON 输出字段不变（running/pid/browsers/sessions）', async () => {
  const { cmdDaemon, state } = makeHarness({ json: true });
  assert.equal(await cmdDaemon({ json: true }, ['daemon', 'status']), 0);
  const emitted = state.emitted[0];
  assert.equal(emitted.ok, true);
  assert.equal(emitted.result.running, true);
  assert.equal(emitted.result.pid, 42);
  assert.equal(emitted.result.browsers, 1);
  assert.equal(emitted.result.sessions, 2);
});

test('既有 daemon log：仍委托 daemonLog', async () => {
  const { cmdDaemon, state } = makeHarness();
  await cmdDaemon({}, ['daemon', 'log']);
  assert.equal(state.logCalls, 1);
});

test('daemon start（local 模式）：无 flags 时调用 ensureDaemon 并打印运行中', async () => {
  const { cmdDaemon, state } = makeHarness();
  assert.equal(await cmdDaemon({}, ['daemon', 'start']), 0);
  assert.match(state.printed.join('\n'), /daemon 运行中/);
});

test('daemon stop：优雅停止路径仍返回 0', async () => {
  const { cmdDaemon } = makeHarness();
  assert.equal(await cmdDaemon({}, ['daemon', 'stop']), 0);
});
