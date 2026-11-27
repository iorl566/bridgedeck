// tests/unit/daemon-cli-status-views.test.mjs —— `bridge status --views` 的命令层行为。
//
// 回归重点：
// - 不带 --views 时调用 daemon 的参数必须是 {}（0.3.0 默认载荷不变）；
// - 人类输出在默认路径与基线一致（browsers/sessions/inflight 三段）；
// - 带 --views 时把数组/limit/strategy 透传给 daemon，并在人类输出追加视图段落；
// - --limit 非法在本地 ArgError（不发 RPC）；空 views 字符串回退默认行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusCommands } from '../../cli/commands/status.mjs';
import { ArgError } from '../../cli/lib/args.mjs';
import { formatTime, formatUptime, renderTable, truncateText } from '../../cli/lib/format.mjs';

function makeHarness({ body } = {}) {
  const state = { rpc: [], json: false, stdout: [], errors: [] };
  const ctx = {
    callRpc: async (method, params, timeoutMs) => {
      state.rpc.push({ method, params: JSON.parse(JSON.stringify(params || {})), timeoutMs });
      if (typeof body === 'function') return body(method, params);
      return body === undefined ? { ok: true, result: statusFixture() } : body;
    },
    timeoutOf: () => 60_000,
    outputFailure: (value) => { state.errors.push(value); return 1; },
    outputJsonBody: (value) => { state.stdout.push(JSON.stringify(value)); return 0; },
    print: (text) => { state.stdout.push(text); },
    isJson: () => state.json,
    requirePos: (pos, index, label) => {
      if (pos[index] === undefined || pos[index] === '') throw new ArgError('缺少参数 ' + label);
      return pos[index];
    },
    formatTime,
    formatUptime,
    indent: (text) => text.split('\n').map((line) => '  ' + line).join('\n'),
    renderTable,
    truncateText,
  };
  return { ctx, state, commands: createStatusCommands(ctx) };
}

function statusFixture() {
  return {
    service: 'browser-bridge',
    version: '0.3.0',
    protocol: '1.9',
    pid: 123,
    port: 52900,
    uptimeMs: 65_000,
    browsers: [
      { instanceId: 'edge-1', browser: 'edge', browserVersion: '120', extVersion: '0.3.0', connectedAt: 1_700_000_000_000 },
    ],
    sessions: [
      { sessionId: 'a1b2', instanceId: 'edge-1', tabId: 7, windowId: 1, url: 'https://example.com/', title: '示例', startedAt: 1_700_000_000_000 },
    ],
    inflight: [
      { method: 'observe', instanceId: 'edge-1', tabId: 7, elapsedMs: 12 },
    ],
  };
}

function viewStatusFixture() {
  return {
    ...statusFixture(),
    views: ['batch', 'arbitration'],
    batch: {
      schema: 1,
      kind: 'bridge/session-batch',
      quota: { policy: { maxSessions: 12 }, live: 2, reserved: 1, available: 9 },
      recent: [],
      running: [],
      totals: { batches: 2, running: 0, succeeded: 3, failed: 0, denied: 0 },
    },
    arbitration: {
      kind: 'bridge/lease-arbitration',
      verdicts: [],
      steps: [],
      summary: { verdicts: 0, actionable: 0, reportOnly: 0, conflicts: 0 },
    },
    unknownViews: [],
  };
}

test('默认 status：调用参数为空对象，人类输出保留三段基线结构', async () => {
  const { commands, state } = makeHarness();
  const code = await commands.cmdStatus({});
  assert.equal(code, 0);
  assert.deepEqual(state.rpc[0], { method: 'status', params: {}, timeoutMs: 60_000 });
  const text = state.stdout.join('\n');
  assert.match(text, /browser-bridge v0\.3\.0/);
  assert.match(text, /browsers \(1\):/);
  assert.match(text, /sessions \(1\):/);
  assert.match(text, /inflight \(1\):/);
  assert.match(text, /a1b2/);
  assert.match(text, /edge-1/);
  assert.match(text, /observe/);
  assert.doesNotMatch(text, /批处理\/配额：/);
  assert.doesNotMatch(text, /租约裁决：/);
});

test('默认 status --json：原样透传 body（不做视图裁剪/注入）', async () => {
  const { commands, state } = makeHarness();
  state.json = true;
  const code = await commands.cmdStatus({});
  assert.equal(code, 0);
  const parsed = JSON.parse(state.stdout[0]);
  assert.equal(parsed.result.batch, undefined);
  assert.equal(parsed.result.views, undefined);
  assert.deepEqual(state.rpc[0].params, {});
});

test('--views：数组透传（去空白）、limit/strategy 一并传递', async () => {
  const { commands, state } = makeHarness({ body: { ok: true, result: viewStatusFixture() } });
  const code = await commands.cmdStatus({ views: ' batch , arbitration ', limit: '5', strategy: 'priority' });
  assert.equal(code, 0);
  assert.deepEqual(state.rpc[0].params, { views: ['batch', 'arbitration'], limit: 5, strategy: 'priority' });
  const text = state.stdout.join('\n');
  assert.match(text, /批处理\/配额：/);
  assert.match(text, /租约裁决：/);
  assert.match(text, /browsers \(1\):/, '视图段落不替换基线段落');
});

test('--views 单个视图 + --json：JSON 结果包含 views 与视图字段', async () => {
  const { commands, state } = makeHarness({ body: { ok: true, result: viewStatusFixture() } });
  state.json = true;
  const code = await commands.cmdStatus({ views: 'batch', json: true });
  assert.equal(code, 0);
  const parsed = JSON.parse(state.stdout[0]);
  assert.deepEqual(parsed.result.views, ['batch', 'arbitration']);
  assert.ok(parsed.result.batch);
  assert.deepEqual(state.rpc[0].params, { views: ['batch'] });
});

test('--views 空字符串回退默认参数（不发送 views 键）', async () => {
  const { commands, state } = makeHarness();
  await commands.cmdStatus({ views: '' });
  assert.deepEqual(state.rpc[0].params, {});
  await commands.cmdStatus({ views: ' , ' });
  assert.deepEqual(state.rpc[1].params, { views: [] });
});

test('--limit 非法在本地抛 ArgError（不触达 daemon）', async () => {
  const { commands, state } = makeHarness({ body: { ok: true, result: viewStatusFixture() } });
  await assert.rejects(commands.cmdStatus({ views: 'batch', limit: '0' }), ArgError);
  await assert.rejects(commands.cmdStatus({ views: 'batch', limit: 'abc' }), ArgError);
  await assert.rejects(commands.cmdStatus({ views: 'batch', limit: '-3' }), ArgError);
  assert.equal(state.rpc.length, 0);
});

test('--views 未知视图名：由 daemon 回显 unknownViews，CLI 追加未知视图段落', async () => {
  const result = { ...viewStatusFixture(), views: ['batch'], unknownViews: ['nope'] };
  const { commands, state } = makeHarness({ body: { ok: true, result } });
  const code = await commands.cmdStatus({ views: 'batch,nope' });
  assert.equal(code, 0);
  const text = state.stdout.join('\n');
  assert.ok(text.includes('未知视图：') && text.includes('nope'), text);
});

test('daemon 失败 body：交给 outputFailure，返回 1', async () => {
  const { commands, state } = makeHarness({ body: { ok: false, error: { code: 'E_INTERNAL', message: 'boom' } } });
  const code = await commands.cmdStatus({ views: 'batch' });
  assert.equal(code, 1);
  assert.equal(state.errors[0].error.code, 'E_INTERNAL');
});

test('cmdBrowsers / cmdCancel：默认行为不变（不请求视图）', async () => {
  const { commands, state } = makeHarness({
    body: (method) => {
      if (method === 'browsers') return { ok: true, result: { browsers: statusFixture().browsers } };
      if (method === 'command.cancel') return { ok: true, result: { accepted: true, id: 'cmd-1' } };
      return { ok: true, result: {} };
    },
  });
  assert.equal(await commands.cmdBrowsers({}), 0);
  assert.equal(state.rpc[0].method, 'browsers');
  assert.match(state.stdout.join('\n'), /edge-1/);
  assert.equal(await commands.cmdCancel({}, ['cancel', 'cmd-1']), 0);
  assert.equal(state.rpc[1].method, 'command.cancel');
  assert.deepEqual(state.rpc[1].params, { id: 'cmd-1' });
});
