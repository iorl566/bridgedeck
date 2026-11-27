// tests/unit/sdk-mcp-client.test.mjs —— Node MCP 客户端（sdk/mcp-client.mjs）的端到端测试。
//
// 覆盖两层：
//   1. 真实 MCP server（spawn node mcp/server.mjs，无 daemon）：initialize/tools/list/
//      resources 分页与过滤/prompts 分页/completion/错误码透传/协议版本协商；
//   2. 可注入 FakeTransport 的单元面：校验/审批/重试/进度事件/取消/分页循环/能力快照；
//   3. fake daemon + 真实 server：进度通知与 cancelRequest 的取消语义（不回响应）。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_CLIENT_DEFAULTS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_PATH,
  McpClient,
  McpRpcError,
  McpTransport,
  ProgressAggregator,
  createMcpClient,
  mcpClientSnapshot,
  requiresApproval,
  toolPayloadFromResult,
  withMcpClient,
} from '../../sdk/mcp-client.mjs';
import { ToolCallError } from '../../sdk/tool-runtime.mjs';
import { decodeCursor } from '../../mcp/cursor.mjs';
import { toolSpec } from '../../sdk/tool-catalog.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-'));
const APPROVAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-approval-'));

let client = null;
let approvalClient = null;

before(async () => {
  client = await createMcpClient({ home: HOME, timeoutMs: 20_000 });
  approvalClient = await createMcpClient({
    home: APPROVAL_HOME,
    timeoutMs: 20_000,
    env: { ...process.env, BB_HOME: APPROVAL_HOME, BB_MCP_APPROVAL: 'required' },
  });
});

after(() => {
  if (client) client.close();
  if (approvalClient) approvalClient.close();
});

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate, timeoutMs = 4000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

/** 可注入传输：记录请求、按 handler 返回、支持通知广播与取消。 */
class FakeTransport {
  constructor(handler = () => ({})) {
    this.handler = handler;
    this.requests = [];
    this.notifications = [];
    this.cancels = [];
    this.listeners = [];
    this.closed = false;
    this.seq = 0;
  }

  request(method, params = {}, options = {}) {
    this.requests.push({ method, params, timeoutMs: options.timeoutMs });
    if (this.closed) return Promise.reject(new McpRpcError('E_DISCONNECTED', 'closed'));
    this.seq += 1;
    const id = this.seq;
    if (typeof options.onStart === 'function') options.onStart(id);
    return Promise.resolve(this.handler(method, params, id, this));
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
  }

  cancel(requestId, reason = '') {
    this.cancels.push({ requestId, reason });
    return true;
  }

  addNotificationHandler(handler) {
    this.listeners.push(handler);
    return handler;
  }

  removeNotificationHandler(handler) {
    const index = this.listeners.indexOf(handler);
    if (index < 0) return false;
    this.listeners.splice(index, 1);
    return true;
  }

  emit(message) {
    for (const listener of [...this.listeners]) listener(message);
  }

  close() {
    this.closed = true;
  }
}

function toolResult(payload, { isError = false, errorCode = null, meta = {} } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    isError,
    _meta: { 'browser-bridge/tier': 'read', 'browser-bridge/elapsedMs': 1, ...(errorCode ? { 'browser-bridge/errorCode': errorCode } : {}), ...meta },
  };
}

test('初始化握手：协议版本 / 能力 / serverInfo', async () => {
  assert.equal(MCP_PROTOCOL_VERSION, '2024-11-05');
  assert.ok(fs.existsSync(MCP_SERVER_PATH));
  assert.equal(client.connected, true);
  assert.equal(client.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(client.serverInfo.name, 'browser-bridge');
  assert.equal(client.capabilities.completions !== undefined, true);
  assert.equal(client.capabilities.resources.subscribe, true);
  assert.equal(client.capabilities.resources.listPagination.cursorParam, 'cursor');
  assert.equal(client.supportsResourceSubscriptions(), true);
  const ping = await client.ping();
  assert.deepEqual(ping, {});
});

test('tools/list：92 工具 + annotations + 审批分级字段', async () => {
  const tools = await client.listTools();
  assert.equal(tools.length, 92);
  for (const tool of tools) {
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    assert.equal(typeof tool._meta['browser-bridge/policy'].approvalGrade, 'string');
  }
  const evaluate = tools.find((tool) => tool.name === 'browser_evaluate');
  assert.equal(evaluate._meta['browser-bridge/policy'].approvalGrade, 'confirm');
  const update = tools.find((tool) => tool.name === 'browser_update');
  assert.equal(update._meta['browser-bridge/policy'].approvalGrade, 'mandatory');
  const observe = tools.find((tool) => tool.name === 'browser_observe');
  assert.equal(observe._meta['browser-bridge/policy'].approvalGrade, 'none');
});

test('resources/list：默认全量 / limit 分页 / query 过滤 / 索引与新鲜度 _meta', async () => {
  const full = await client.listResources();
  assert.ok(Array.isArray(full.resources));
  assert.equal(full.nextCursor, undefined);
  const meta = full._meta['browser-bridge/resources'];
  assert.equal(meta.subscribe, true);
  assert.equal(meta.listPagination.defaulted, true);
  assert.equal(typeof meta.index.total, 'number');
  assert.equal(typeof meta.freshness.byState, 'object');

  const page = await client.listResources({ limit: 2 });
  assert.equal(page.resources.length, 2);
  assert.equal(typeof page.nextCursor, 'string');
  assert.equal(decodeCursor(page.nextCursor, { label: 'resources' }).offset, 2);
  assert.equal(page._meta['browser-bridge/resources'].listPagination.hasMore, true);

  const second = await client.listResources({ limit: 2, cursor: page.nextCursor });
  assert.equal(second.resources.length, 2);
  assert.notEqual(second.resources[0].uri, page.resources[0].uri);

  const filtered = await client.listResources({ kind: 'skill-main' });
  assert.equal(filtered.resources.length, 1);
  assert.equal(filtered.resources[0].uri, 'bridge://skill/SKILL.md');

  const searched = await client.listResources({ query: 'protocol' });
  assert.equal(searched.resources.length, 1);

  const all = await client.listAllResources({ maxPages: 5, pageSize: 2 });
  assert.ok(all.pages >= 2);
  assert.equal(all.resources.length, full.resources.length);
});

test('resources/list：非法游标 → McpRpcError(-32602)', async () => {
  await assert.rejects(
    () => client.listResources({ cursor: 'not-a-cursor' }),
    (error) => error instanceof McpRpcError && error.rpcCode === -32602 && error.code === 'E_RPC',
  );
});

test('resources/read：技能文档可读 + 静态资源的 freshnessState', async () => {
  const skill = await client.readResource('bridge://skill/SKILL.md');
  assert.ok(skill.contents[0].text.length > 200);
  const meta = skill._meta['browser-bridge/resource'];
  assert.equal(meta.kind, 'skill-main');
  assert.equal(meta.freshnessState, 'static');
  assert.equal(meta.freshnessAction, 'use');

  await assert.rejects(
    () => client.readResource('bridge://observation/latest'),
    (error) => error instanceof McpRpcError && error.rpcCode === -32002,
  );
  await assert.rejects(
    () => client.readResource('bridge://nope'),
    (error) => error instanceof McpRpcError && error.rpcCode === -32002,
  );
});

test('prompts：list 分页 / get 渲染 / 错误码 -32602', async () => {
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.length >= 9);
  assert.equal(prompts._meta['browser-bridge/prompts'].total, prompts.prompts.length);

  const first = await client.listPrompts({ limit: 3 });
  assert.equal(first.prompts.length, 3);
  assert.equal(typeof first.nextCursor, 'string');
  const rest = await client.listPrompts({ limit: 3, cursor: first.nextCursor });
  assert.equal(rest.prompts.length, 3);

  const rendered = await client.getPrompt('browser_task_brief', { task: '登录并查看订单' });
  assert.match(rendered.messages[0].content.text, /登录并查看订单/);
  await assert.rejects(() => client.getPrompt('nope_prompt', {}), (error) => error.rpcCode === -32602);
  await assert.rejects(
    () => client.getPrompt('longshot_recovery', { failure: 'not-a-failure' }),
    (error) => error.rpcCode === -32602 && /stale/.test(error.message),
  );
});

test('completion/complete：prompt 枚举 / 资源模板 / 未知 prompt', async () => {
  const enumResult = await client.complete({
    ref: { type: 'ref/prompt', name: 'har_analysis' },
    argument: { name: 'focus', value: '' },
  });
  assert.ok(enumResult.completion.values.length >= 2);
  assert.equal(enumResult.completion.hasMore, false);
  assert.equal(enumResult._meta['browser-bridge/completion'].freeForm, false);

  const filtered = await client.complete({
    ref: { type: 'ref/prompt', name: 'har_analysis' },
    argument: { name: 'focus', value: 'err' },
  });
  assert.deepEqual(filtered.completion.values, ['errors']);

  const freeForm = await client.complete({
    ref: { type: 'ref/prompt', name: 'browser_task_brief' },
    argument: { name: 'task', value: 'x' },
  });
  assert.deepEqual(freeForm.completion.values, []);
  assert.equal(freeForm._meta['browser-bridge/completion'].freeForm, true);

  const resource = await client.complete({
    ref: { type: 'ref/resource', uri: 'bridge://skill/references/{name}' },
    argument: { name: 'name', value: '' },
  });
  assert.ok(resource.completion.values.includes('environment.md'));

  await assert.rejects(
    () => client.complete({ ref: { type: 'ref/prompt', name: 'nope' }, argument: { name: 'x' } }),
    (error) => error.rpcCode === -32602,
  );
});

test('callTool：无 daemon 时错误码透传为 ToolCallError(E_DAEMON)', async () => {
  const error = await client.callTool('browser_status', {}).catch((err) => err);
  assert.ok(error instanceof ToolCallError);
  assert.equal(error.code, 'E_DAEMON');
  assert.equal(error.tool, 'browser_status');
  assert.equal(error.details['browser-bridge/error'].category, 'transport');
});

test('callTool：本地校验 / 未知工具 / 审批闸门（BB_MCP_APPROVAL=required）', async () => {
  await assert.rejects(
    () => client.callTool('browser_nope', {}),
    (error) => error instanceof ToolCallError && error.code === 'E_ARG_UNEXPECTED',
  );
  await assert.rejects(
    () => client.callTool('browser_status', { bogus: 1 }),
    (error) => error instanceof ToolCallError && error.code === 'E_ARG_UNEXPECTED',
  );
  await assert.rejects(
    () => client.callTool('browser_evaluate', {}),
    (error) => error instanceof ToolCallError && error.code === 'E_ARG_MISSING',
  );
  const gate = await approvalClient.callTool('browser_evaluate', { expression: '1 + 1' }).catch((err) => err);
  assert.ok(gate instanceof ToolCallError);
  assert.equal(gate.code, 'E_HUMAN_GATE');
  assert.equal(gate.details.retry, 'after-action');
  // 带 approval 后放行到 daemon（无 daemon → E_DAEMON）
  const passed = await approvalClient.callTool('browser_evaluate', { expression: '1 + 1' }, { approval: true }).catch((err) => err);
  assert.equal(passed.code, 'E_DAEMON');
});

test('ProgressAggregator + FakeTransport：进度事件与 retry 退避', async () => {
  let attempts = 0;
  const transport = new FakeTransport((method, params) => {
    if (method === 'initialize') return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake' } };
    if (method === 'tools/call') {
      attempts += 1;
      if (attempts < 3) return toolResult('E_RATE_LIMITED: 被限流', { isError: true, errorCode: 'E_RATE_LIMITED' });
      return toolResult({ observation: '@e1 ok', cursor: null });
    }
    return {};
  });
  const fakeClient = new McpClient({ transport, timeoutMs: 5000 });
  await fakeClient.connect();
  const aggregator = new ProgressAggregator();
  const retryEvents = [];
  const result = await fakeClient.callToolDetailed('browser_observe', {}, {
    retry: 3,
    onProgress: aggregator.handler((event) => { if (event.phase === 'retry') retryEvents.push(event); }),
  });
  assert.equal(attempts, 3);
  assert.equal(result.payload.observation, '@e1 ok');
  assert.equal(retryEvents.length, 2);
  assert.equal(retryEvents[0].attempt, 1);
  assert.ok(retryEvents[0].delayMs > 0);
  const summary = aggregator.summary();
  assert.equal(summary.sawStart, true);
  assert.equal(summary.sawDone, true);
  assert.ok(summary.phases.filter((phase) => phase === 'retry').length === 2);
  fakeClient.close();
});

test('callTool：不可重试错误不重试（E_HUMAN_GATE 本地拦截，0 次请求）', async () => {
  const previous = process.env.BB_MCP_APPROVAL;
  process.env.BB_MCP_APPROVAL = 'required';
  const transport = new FakeTransport((method) => {
    if (method === 'initialize') return { capabilities: {}, serverInfo: { name: 'fake' } };
    return toolResult({ ok: true });
  });
  const fakeClient = new McpClient({ transport, timeoutMs: 5000 });
  try {
    await fakeClient.connect();
    let calls = 0;
    const original = transport.request.bind(transport);
    transport.request = (method, params, options) => { calls += 1; return original(method, params, options); };
    // 审批闸门在本地拦截（连 transport 都不发），因此 retry 不应产生任何请求。
    await assert.rejects(
      () => fakeClient.callTool('browser_evaluate', { expression: '1' }, { retry: 3 }),
      (error) => error instanceof ToolCallError && error.code === 'E_HUMAN_GATE',
    );
    assert.equal(calls, 0, '审批拦截不应发起请求，更不应重试');
  } finally {
    fakeClient.close();
    if (previous === undefined) delete process.env.BB_MCP_APPROVAL;
    else process.env.BB_MCP_APPROVAL = previous;
  }
});

test('FakeTransport：取消 → E_CANCELLED；transport 关闭后请求拒绝', async () => {
  const transport = new FakeTransport((method) => {
    if (method === 'initialize') return { capabilities: {}, serverInfo: { name: 'fake' } };
    return {};
  });
  const fakeClient = new McpClient({ transport, timeoutMs: 5000 });
  await fakeClient.connect();
  assert.equal(fakeClient.cancelRequest(999), true);
  assert.equal(fakeClient.cancelRequest(999, 'again'), true);
  assert.deepEqual(transport.cancels.at(-1), { requestId: 999, reason: 'again' });
  transport.close();
  await assert.rejects(() => transport.request('ping', {}), (error) => error.code === 'E_DISCONNECTED');
  fakeClient.close();
});

test('callToolPaged：分页循环与停止原因', async () => {
  const pages = [
    { observation: '@e1', cursor: 'c2' },
    { observation: '@e2', cursor: 'c3' },
    { observation: '@e3', cursor: null },
  ];
  let index = 0;
  const transport = new FakeTransport((method) => {
    if (method === 'initialize') return { capabilities: {}, serverInfo: { name: 'fake' } };
    const payload = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return toolResult(payload);
  });
  const fakeClient = new McpClient({ transport, timeoutMs: 5000 });
  await fakeClient.connect();
  const result = await fakeClient.callToolPaged('browser_observe', {}, { maxPages: 5 });
  assert.equal(result.calls, 3);
  assert.equal(result.stoppedReason, 'no-more-pages');
  assert.deepEqual(result.pages.map((page) => page.observation), ['@e1', '@e2', '@e3']);

  const notPaged = await fakeClient.callToolPaged('browser_status', {}, { maxPages: 3 });
  assert.equal(notPaged.calls, 1);
  assert.equal(notPaged.stoppedReason, 'not-paginated');
  await assert.rejects(() => fakeClient.callToolPaged('browser_observe', {}, { maxPages: 0 }), (error) => error.code === 'E_ARG_RANGE');
  fakeClient.close();
});

test('订阅：subscribeResource 报告 + 本地镜像；resources/updated 回调', async () => {
  const report = await client.subscribeResource('bridge://observation/latest');
  assert.equal(report.added, true);
  assert.equal(report.notification, 'notifications/resources/updated');
  assert.deepEqual(client.resourceSubscriptions(), ['bridge://observation/latest']);
  const again = await client.subscribeResource('bridge://observation/latest');
  assert.equal(again.added, false);
  const updates = [];
  const remove = client.addResourceUpdatedHandler((params) => updates.push(params));
  assert.equal(typeof remove, 'function');
  const unsub = await client.unsubscribeResource('bridge://observation/latest');
  assert.equal(unsub.found, true);
  assert.deepEqual(client.resourceSubscriptions(), []);
  client.removeResourceUpdatedHandler(remove);
  assert.throws(() => client.addResourceUpdatedHandler('nope'), (error) => error.code === 'E_ARG_TYPE');
});

test('withMcpClient：作用域关闭 + 快照 + requiresApproval 语义', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-scope-'));
  const tools = await withMcpClient({ home, timeoutMs: 20_000 }, async (scoped) => {
    assert.equal(scoped.connected, true);
    return scoped.listTools();
  });
  assert.equal(tools.length, 92);

  const snapshot = mcpClientSnapshot();
  assert.equal(snapshot.tools, 92);
  assert.equal(snapshot.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.ok(snapshot.methods.includes('completion/complete'));
  assert.equal(MCP_CLIENT_DEFAULTS.approvalRetry, 'after-action');

  const spec = toolSpec('browser_evaluate');
  assert.equal(requiresApproval(spec, { approval: false, env: { BB_MCP_APPROVAL: 'required' } }), true);
  assert.equal(requiresApproval(spec, { approval: true, env: { BB_MCP_APPROVAL: 'required' } }), false);
  assert.equal(requiresApproval(spec, { approval: false, env: { BB_MCP_APPROVAL: 'off' } }), false);
  assert.equal(requiresApproval(toolSpec('browser_update'), { approval: false, env: { BB_MCP_APPROVAL: 'off' } }), true);
  assert.equal(requiresApproval(toolSpec('browser_observe')), false);
});

test('toolPayloadFromResult：JSON / 文本 / isError 三种形态', () => {
  assert.deepEqual(toolPayloadFromResult('browser_status', toolResult({ a: 1 })), { a: 1 });
  assert.equal(toolPayloadFromResult('browser_status', toolResult('plain text')), 'plain text');
  assert.throws(
    () => toolPayloadFromResult('browser_evaluate', toolResult('E_HUMAN_GATE: 需要确认', { isError: true, errorCode: 'E_HUMAN_GATE' })),
    (error) => error instanceof ToolCallError && error.code === 'E_HUMAN_GATE' && error.tool === 'browser_evaluate',
  );
  // 没有 _meta 错误码时从文本前缀提取
  assert.throws(
    () => toolPayloadFromResult('browser_click', { content: [{ type: 'text', text: 'E_STALE_REF: ref gone' }], isError: true }),
    (error) => error.code === 'E_STALE_REF',
  );
});

// ---------------------------------------------------------------------------
// fake daemon：验证真实 server + 客户端进度通知 / 取消语义
// ---------------------------------------------------------------------------
function startFakeDaemon() {
  return new Promise((resolve, reject) => {
    const state = { requests: [], inflight: new Map(), seq: 0, server: null };
    state.server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
        const method = String(payload.method || '');
        const params = payload.params || {};
        state.requests.push({ method, params });
        const reply = (result) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result }));
        };
        if (method === 'session.start') return reply({ sessionId: 's-http' });
        if (method === 'session.stop') return reply({ stopped: true });
        if (method === 'status') return reply({ ok: true, daemon: 'fake' });
        if (method === 'inflight.list') return reply({ inflight: [...state.inflight.values()] });
        if (method === 'command.cancel') {
          const entry = state.inflight.get(params.id);
          if (!entry) return reply({ id: params.id, forwarded: false, accepted: false });
          state.inflight.delete(params.id);
          return reply({ id: params.id, forwarded: true, accepted: true });
        }
        if (method === 'observe') {
          const id = 'cmd-' + (state.seq += 1);
          state.inflight.set(id, { id, instanceId: 'inst', method: 'observe', tabId: 1, startedAt: Date.now() });
          setTimeout(() => {
            state.inflight.delete(id);
            reply({ session: 's-http', url: 'https://fake.test/', title: 'Fake', refs: 1, observation: '@e1 fake', truncated: false });
          }, 900);
          return undefined;
        }
        return reply({ ok: true, method });
      });
    });
    state.server.on('error', reject);
    state.server.listen(0, '127.0.0.1', () => resolve({ state, port: state.server.address().port }));
  });
}

test('fake daemon：进度通知（notifications/progress）+ snapshot 回填', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-daemon-'));
  const daemon = await startFakeDaemon();
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port: daemon.port, token: 't' }), 'utf8');
  const daemonClient = await createMcpClient({ home, timeoutMs: 20_000 });
  try {
    const aggregator = new ProgressAggregator();
    const detail = await daemonClient.callToolDetailed('browser_observe', {}, {
      progress: true,
      onProgress: aggregator.handler(),
    });
    assert.equal(detail.payload.url, 'https://fake.test/');
    assert.equal(detail.meta['browser-bridge/snapshot'].kind, 'observation');
    const summary = aggregator.summary();
    assert.equal(summary.sawStart, true);
    assert.equal(summary.sawDone, true);
    assert.ok(summary.progressSamples >= 1, '长任务应收到 server 的 progress 通知：' + JSON.stringify(summary.phases));
  } finally {
    daemonClient.close();
    try { daemon.state.server.close(); } catch { /* 忽略 */ }
  }
});

test('fake daemon：cancelRequest 取消在途调用（E_CANCELLED + server 不回响应）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-cancel-'));
  const daemon = await startFakeDaemon();
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port: daemon.port, token: 't' }), 'utf8');
  const daemonClient = await createMcpClient({ home, timeoutMs: 20_000 });
  try {
    const events = [];
    const pending = daemonClient.callTool('browser_observe', {}, {
      onProgress: (event) => events.push(event),
      onRequest: (requestId) => {
        assert.equal(typeof requestId, 'number');
        setTimeout(() => daemonClient.cancelRequest(requestId, 'sdk-test-cancel'), 120);
      },
    });
    const error = await pending.catch((err) => err);
    assert.ok(error instanceof ToolCallError || error instanceof McpRpcError);
    assert.equal(error.code, 'E_CANCELLED');
    assert.equal(events.some((event) => event.phase === 'cancelled'), true);
    // 取消转发到 daemon（server 的 CALLS.cancel → inflight.list / command.cancel）
    const forwarded = await waitFor(() => daemon.state.requests.some((request) => request.method === 'command.cancel'), 3000);
    assert.equal(forwarded, true);
    // server 仍可服务其它请求
    assert.deepEqual(await daemonClient.ping(), {});
  } finally {
    daemonClient.close();
    try { daemon.state.server.close(); } catch { /* 忽略 */ }
  }
});

test('McpTransport：真实 server 的 request/notify/close 生命周期', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-mcp-transport-'));
  const transport = new McpTransport({
    command: [process.execPath, MCP_SERVER_PATH],
    env: { ...process.env, BB_HOME: home },
    timeoutMs: 20_000,
  });
  const init = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'transport-test' } });
  assert.equal(init.serverInfo.name, 'browser-bridge');
  transport.notify('notifications/initialized', {});
  const ping = await transport.request('ping', {});
  assert.deepEqual(ping, {});
  assert.equal(transport.cancel(12345), false);
  transport.close();
  await assert.rejects(async () => transport.request('ping', {}), (error) => error.code === 'E_DISCONNECTED');
});
