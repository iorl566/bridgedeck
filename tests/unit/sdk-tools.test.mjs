// tests/unit/sdk-tools.test.mjs —— Node SDK 对 92 个 MCP 工具的语义覆盖测试。
//
// 覆盖：工具目录（分档/分页/入参）、运行时参数校验、ctx 接线（session/rpc/超时）、
// 审批闸门、callToolDetailed、Page.callTool 自动补 session、运行时关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../../mcp/server.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { BrowserBridge, Page } from '../../sdk/index.mjs';
import {
  TOOL_NAMES,
  ToolArgumentError,
  assertToolInput,
  listToolSpecs,
  paginationOf,
  toolSpec,
  toolTierSummary,
  validateToolInput,
} from '../../sdk/tool-catalog.mjs';
import { ToolCallError, createToolRuntime, parseDurationMs } from '../../sdk/tool-runtime.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-tools-'));
}

function fakeBridge(handler) {
  const calls = [];
  return {
    calls,
    info: { port: 1, token: 'test' },
    async rpc(method, params = {}, options = {}) {
      calls.push({ method, params, options });
      return handler(method, params, calls);
    },
  };
}

function defaultHandler(method, params) {
  if (method === 'session.start') return { sessionId: 'sdk-1', tabId: 1, windowId: 2, instanceId: 'i1' };
  if (method === 'session.stop') return { ok: true };
  if (method === 'observe') return { url: 'https://fixture.test/', title: 'fixture', observation: '@e1 button', refs: 1, truncated: false };
  return { ok: true, method, params };
}

test('SDK 工具目录覆盖 92 个 MCP 工具且与 MCP 注册一致', () => {
  assert.equal(TOOL_NAMES.length, 92);
  assert.deepEqual(TOOL_NAMES, TOOLS.map((tool) => tool.name));
  const specs = listToolSpecs();
  assert.equal(specs.length, 92);
  for (const spec of specs) {
    assert.deepEqual(spec.methods, TOOL_METHODS[spec.name], spec.name);
    assert.ok(['read', 'mutate', 'destructive'].includes(spec.tier), spec.name);
    assert.equal(typeof spec.title, 'string');
    assert.equal(typeof spec.description, 'string');
    assert.ok(spec.timeoutMs > 0);
    assert.equal(typeof spec.pagination.partial, 'boolean');
    assert.equal(typeof spec.pagination.resumeHint, 'string');
    assert.equal(typeof spec.annotations.readOnlyHint, 'boolean');
    assert.ok(spec.properties && typeof spec.properties === 'object');
  }
  const summary = toolTierSummary();
  assert.equal(summary.total, 92);
  assert.equal(summary.byTier.read + summary.byTier.mutate + summary.byTier.destructive, 92);
  assert.ok(summary.approvals.includes('browser_evaluate'));
  assert.ok(summary.paginated.includes('browser_observe'));
});

test('分页标记：可能截断的工具标 partial，可续读工具带 cursor 参数', () => {
  assert.equal(paginationOf('browser_observe').partial, true);
  assert.deepEqual(paginationOf('browser_observe').methods, ['observe']);
  assert.equal(paginationOf('browser_observe').cursorParam, 'cursor');
  assert.deepEqual(paginationOf('browser_observe').resultFields, ['cursor', 'truncated', 'partial']);
  assert.equal(paginationOf('browser_extract').partial, true);
  assert.equal(paginationOf('browser_network_list').partial, true);
  assert.equal(paginationOf('browser_screenshot').partial, true);
  assert.equal(paginationOf('browser_click').partial, false);
  assert.deepEqual(paginationOf('browser_click').methods, []);
  assert.equal(paginationOf('browser_click').cursorParam, null);
  assert.equal(paginationOf('no_such_tool'), null);
});

test('入参运行时校验：类型 / 必填 / 枚举 / 范围 / 未声明字段', () => {
  assert.equal(validateToolInput('browser_observe', { max_tokens: 500 }).ok, true);
  assert.equal(validateToolInput('browser_click', { ref: '@e1', trusted: true }).ok, true);
  const missing = validateToolInput('browser_fill', { ref: '@e1' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.code === 'E_ARG_MISSING' && error.path === 'value'));
  const type = validateToolInput('browser_tab_close', { tab_id: 'x' });
  assert.ok(type.errors.some((error) => error.code === 'E_ARG_TYPE' && error.path === 'tab_id'));
  const enumError = validateToolInput('browser_window', { action: 'explode' });
  assert.ok(enumError.errors.some((error) => error.code === 'E_ARG_ENUM' && error.path === 'action'));
  const range = validateToolInput('browser_network_waterfall', { limit: 0 });
  assert.ok(range.errors.some((error) => error.code === 'E_ARG_RANGE' && error.path === 'limit'));
  const unexpected = validateToolInput('browser_status', { nope: 1 });
  assert.ok(unexpected.errors.some((error) => error.code === 'E_ARG_UNEXPECTED' && error.path === 'nope'));
  assert.throws(() => assertToolInput('browser_fill', { ref: '@e1' }), (error) => {
    assert.ok(error instanceof ToolArgumentError);
    assert.equal(error.code, 'E_ARG_MISSING');
    return true;
  });
  assert.throws(() => assertToolInput('browser_not_real', {}), (error) => error.code === 'E_ARG_UNEXPECTED');
});

test('运行时调用 read 工具：自动会话 + snake→camel 参数映射', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const result = await runtime.callTool('browser_observe', { max_tokens: 800, vom: true });
  assert.equal(result.observation, '@e1 button');
  assert.equal(bridge.calls[0].method, 'session.start');
  assert.equal(bridge.calls[1].method, 'observe');
  assert.equal(bridge.calls[1].params.session, 'sdk-1');
  assert.equal(bridge.calls[1].params.maxTokens, 800);
  assert.equal(bridge.calls[1].params.vom, true);
  assert.equal(runtime.sessionId(), 'sdk-1');
  // 显式 session 不再 session.start
  bridge.calls.length = 0;
  await runtime.callTool('browser_read', { session: 'explicit-1', ref: '@e2' });
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].method, 'read');
  assert.equal(bridge.calls[0].params.session, 'explicit-1');
  assert.equal(bridge.calls[0].params.ref, '@e2');
});

test('运行时调用动作工具：dispatch/别名参数走同一份 MCP run 实现', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  await runtime.callTool('browser_window', { action: 'resize', width: 800, height: 600 });
  assert.equal(bridge.calls.at(-1).method, 'window.resize');
  assert.equal(bridge.calls.at(-1).params.width, 800);
  await runtime.callTool('browser_tab_new', { url: 'https://example.test/', no_focus: true });
  const tabNew = bridge.calls.find((call) => call.method === 'tab.new');
  assert.equal(tabNew.params.url, 'https://example.test/');
  assert.equal(tabNew.params.noFocus, true);
});

test('审批闸门：destructive 需要 approval，BB_MCP_APPROVAL=off 可关闭（browser_update 例外）', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  await assert.rejects(() => runtime.callTool('browser_evaluate', { expression: '1 + 1' }), (error) => {
    assert.ok(error instanceof ToolCallError);
    assert.equal(error.code, 'E_HUMAN_GATE');
    assert.equal(error.tool, 'browser_evaluate');
    return true;
  });
  const approved = await runtime.callTool('browser_evaluate', { expression: '1 + 1' }, { approval: true });
  assert.equal(approved.ok, true);
  assert.equal(bridge.calls.at(-1).method, 'evaluate');
  assert.equal(bridge.calls.at(-1).params.expression, '1 + 1');

  const offRuntime = createToolRuntime({ bridge, home: tempHome(), env: { BB_MCP_APPROVAL: 'off' } });
  await offRuntime.callTool('browser_evaluate', { expression: '2 + 2' });
  await assert.rejects(
    () => offRuntime.callTool('browser_update', { action: 'check' }),
    (error) => error.code === 'E_HUMAN_GATE',
  );
});

test('超时覆盖：工具逾期抛 E_TIMEOUT', async () => {
  const bridge = fakeBridge((method) => {
    if (method === 'session.start') return { sessionId: 'sdk-1' };
    return new Promise(() => {}); // 永不返回
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  await assert.rejects(
    () => runtime.callTool('browser_observe', {}, { timeoutMs: 10 }),
    (error) => error instanceof ToolCallError && error.code === 'E_TIMEOUT',
  );
});

test('callToolDetailed 返回分档/方法/耗时；close 结束 SDK 会话', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const detailed = await runtime.callToolDetailed('browser_observe', {});
  assert.equal(detailed.tool, 'browser_observe');
  assert.equal(detailed.tier, 'read');
  assert.deepEqual(detailed.methods, ['observe']);
  assert.ok(detailed.elapsedMs >= 0);
  assert.equal(typeof detailed.result.title, 'string');
  const closed = await runtime.close();
  assert.equal(closed.ok, true);
  assert.equal(closed.stopped, true);
  assert.equal(bridge.calls.at(-1).method, 'session.stop');
  assert.equal(runtime.sessionId(), null);
  const again = await runtime.close();
  assert.equal(again.stopped, false);
});

test('页面级 callTool 自动补 session', async () => {
  const home = tempHome();
  const bridge = new BrowserBridge({ port: 1, token: 'tok' }, { home });
  const calls = [];
  bridge.rpc = async (method, params) => {
    calls.push({ method, params });
    return { ok: true, method };
  };
  const page = new Page(bridge, { sessionId: 'page-1' });
  await page.callTool('browser_read', { ref: '@e9' });
  assert.equal(calls.at(-1).method, 'read');
  assert.equal(calls.at(-1).params.session, 'page-1');
  assert.equal(calls.at(-1).params.ref, '@e9');
  await assert.rejects(() => page.callTool('browser_not_real', {}), (error) => error.code === 'E_ARG_UNEXPECTED');
});

test('parseDurationMs 与 MCP server 口径一致', () => {
  assert.equal(parseDurationMs('3s'), 3000);
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs('2m'), 120000);
  assert.equal(parseDurationMs(1234), 1234);
  assert.equal(parseDurationMs('nope'), null);
});

test('toolSpec 暴露协议方法与契约细节', () => {
  const spec = toolSpec('browser_click');
  assert.equal(spec.methods[0], 'click');
  assert.equal(spec.tier, 'mutate');
  assert.equal(spec.properties.trusted.type, 'boolean');
  assert.ok(spec.contract.localParams.length === 0);
  const screenshot = toolSpec('browser_screenshot');
  assert.ok(screenshot.contract.localParams.includes('out'));
  const dialog = toolSpec('browser_dialog');
  assert.ok(dialog.contract.actions && dialog.contract.actions.actions.includes('arm'));
  assert.equal(toolSpec('nope'), null);
});

// ---------------------------------------------------------------------------
// W7-C 第 2 项：Node SDK 进度与取消（与 Python SDK 的 call_tool 对齐）
// ---------------------------------------------------------------------------
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test('callTool onProgress：start/done 事件、callId 与 progress 元数据', async () => {
  const bridge = fakeBridge(async (method) => {
    if (method === 'session.start') return { sessionId: 'sdk-p1' };
    if (method === 'observe') {
      await delay(20);
      return { url: 'https://p.test/', observation: '@e1 button', refs: 1 };
    }
    return { ok: true };
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const events = [];
  const detailed = await runtime.callToolDetailed('browser_observe', {}, { onProgress: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => event.phase), ['start', 'done']);
  for (const event of events) {
    assert.equal(event.tool, 'browser_observe');
    assert.equal(event.tier, 'read');
    assert.match(event.callId, /^browser_observe#\d+$/);
    assert.equal(typeof event.elapsedMs, 'number');
    assert.ok(Object.isFrozen(event));
  }
  assert.equal(detailed.progress.enabled, true);
  assert.equal(detailed.progress.class, 'observe');
  assert.equal(detailed.progress.finalPhase, 'done');
  assert.equal(detailed.progress.emitted, 2);
  assert.equal(detailed.events.length, 2);
  assert.equal(detailed.callId, events[0].callId);
  assert.equal(runtime.inflight().inflightCount, 0, '调用结束后必须从在途登记里释放');
});

test('callTool onProgress：长调用按档位节流发 progress 心跳（observe 档 400ms 首延迟）', async () => {
  const bridge = fakeBridge(async (method) => {
    if (method === 'session.start') return { sessionId: 'sdk-hb' };
    if (method === 'observe') {
      await delay(520);
      return { observation: '@e1 slow' };
    }
    return { ok: true };
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const events = [];
  await runtime.callTool('browser_observe', {}, { onProgress: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => event.phase), ['start', 'progress', 'done']);
  const heartbeat = events[1];
  assert.ok(heartbeat.progress >= 400, JSON.stringify(heartbeat.progress));
  assert.match(String(heartbeat.message), /运行中/);
  assert.ok(heartbeat.elapsedMs >= 400);
});

test('callTool signal：中止后立即 E_CANCELLED，发出 cancelled 终态并转发 daemon 取消', async () => {
  const bridge = fakeBridge(async (method, params) => {
    if (method === 'session.start') return { sessionId: 'sdk-c1' };
    if (method === 'observe') return new Promise(() => {}); // 永不返回，模拟卡住的工具
    if (method === 'inflight.list') return { inflight: [{ id: 'cmd-1', method: 'observe', startedAt: 1, elapsedMs: 10 }] };
    if (method === 'command.cancel') return { id: params.id, forwarded: true, accepted: true };
    return { ok: true };
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const controller = new AbortController();
  const events = [];
  const pending = runtime.callTool('browser_observe', {}, {
    signal: controller.signal,
    onProgress: (event) => events.push(event),
  });
  await delay(40);
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof ToolCallError);
    assert.equal(error.code, 'E_CANCELLED');
    assert.equal(error.tool, 'browser_observe');
    assert.equal(error.details.callId, events[0].callId);
    return true;
  });
  assert.ok(Date.now() - started < 2_000, '取消必须立即停止等待，而不是等超时');
  assert.equal(events.at(-1).phase, 'cancelled');
  assert.equal(events.at(-1).code, 'E_CANCELLED');
  assert.ok(bridge.calls.some((call) => call.method === 'inflight.list'), '应向 daemon 查在途命令');
  assert.ok(bridge.calls.some((call) => call.method === 'command.cancel'), '应转发 daemon 取消');
  assert.equal(runtime.inflight().inflightCount, 0);
});

test('callTool signal：已中止的 signal 不执行工具，直接 E_CANCELLED', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const controller = new AbortController();
  controller.abort();
  const events = [];
  await assert.rejects(
    runtime.callTool('browser_observe', {}, { signal: controller.signal, onProgress: (event) => events.push(event) }),
    (error) => error.code === 'E_CANCELLED',
  );
  assert.deepEqual(events.map((event) => event.phase), ['cancelled']);
  assert.deepEqual(bridge.calls, [], '提前取消不应发起任何 RPC');
});

test('callTool signal 形状校验：非 AbortSignal 返回 E_ARG_TYPE', async () => {
  const runtime = createToolRuntime({ bridge: fakeBridge(defaultHandler), home: tempHome(), env: {} });
  await assert.rejects(
    runtime.callTool('browser_observe', {}, { signal: {} }),
    (error) => error.code === 'E_ARG_TYPE' && /AbortSignal/.test(error.message),
  );
});

test('callTool 错误路径：daemon 错误原样透传，onProgress 收到 error 终态与错误码', async () => {
  const bridge = fakeBridge(async (method) => {
    if (method === 'session.start') return { sessionId: 'sdk-e1' };
    if (method === 'observe') throw Object.assign(new Error('daemon 挂了'), { code: 'E_DAEMON' });
    return { ok: true };
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const events = [];
  await assert.rejects(
    runtime.callTool('browser_observe', {}, { onProgress: (event) => events.push(event) }),
    (error) => error.code === 'E_DAEMON' && /daemon 挂了/.test(error.message),
  );
  assert.deepEqual(events.map((event) => event.phase), ['start', 'error']);
  assert.equal(events.at(-1).code, 'E_DAEMON');
  assert.equal(runtime.inflight().inflightCount, 0);
});

test('BB_MCP_PROGRESS=off：不再发通知，但 onProgress 仍给 start/done 本地事件', async () => {
  const bridge = fakeBridge(defaultHandler);
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: { BB_MCP_PROGRESS: 'off' } });
  const events = [];
  const detailed = await runtime.callToolDetailed('browser_observe', {}, { onProgress: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => event.phase), ['start', 'done']);
  assert.equal(detailed.progress.enabled, false);
  assert.equal(detailed.progress.emitted, 0);
});

test('cancelTool：按 callId / 工具名 / 全部取消并返回结构化报告', async () => {
  const bridge = fakeBridge(async (method) => {
    if (method === 'session.start') return { sessionId: 'sdk-ct' };
    if (method === 'observe') return new Promise(() => {});
    if (method === 'inflight.list') return { inflight: [] };
    return { ok: true };
  });
  const runtime = createToolRuntime({ bridge, home: tempHome(), env: {} });
  const first = runtime.callTool('browser_observe', {}).catch((error) => error);
  const second = runtime.callTool('browser_observe', {}).catch((error) => error);
  await delay(30);
  const inflight = runtime.inflight();
  assert.equal(inflight.inflightCount, 2);
  const callId = inflight.inflight[0].id;
  const precise = await runtime.cancelTool(callId, '测试取消');
  assert.equal(precise.requested, 1);
  assert.deepEqual([...precise.cancelled], [callId]);
  assert.equal(precise.unknown, false);
  assert.equal(precise.reason, '测试取消');
  const firstError = await first;
  assert.equal(firstError.code, 'E_CANCELLED');
  assert.match(firstError.message, /测试取消/);

  const remaining = runtime.inflight();
  assert.equal(remaining.inflightCount, 1);
  const byTool = await runtime.cancelTool('browser_observe', '收尾');
  assert.equal(byTool.requested, 1);
  assert.deepEqual([...byTool.cancelled], [remaining.inflight[0].id]);
  const secondError = await second;
  assert.equal(secondError.code, 'E_CANCELLED');
  assert.equal(runtime.inflight().inflightCount, 0);

  const unknown = await runtime.cancelTool('browser_nope', '无此调用');
  assert.equal(unknown.requested, 0);
  assert.equal(unknown.unknown, true);
  assert.deepEqual([...unknown.cancelled], []);
  const empty = await runtime.cancelTool();
  assert.equal(empty.requested, 0);
  assert.equal(empty.unknown, false);
});

test('BrowserBridge 暴露 cancelTool/inflightTools 委托给工具运行时', async () => {
  const bridge = new BrowserBridge({ port: 1, token: 'tok' }, { home: tempHome() });
  const calls = [];
  bridge._toolRuntime = {
    async callTool() { return { ok: true }; },
    async cancelTool(target, reason) { calls.push({ target, reason }); return { requested: 1, cancelled: ['x#1'], unknown: false, reports: [], inflight: { inflightCount: 0 } }; },
    inflight() { return { inflightCount: 0, inflight: [] }; },
  };
  const report = await bridge.cancelTool('browser_observe#1', '外部取消');
  assert.equal(report.cancelled[0], 'x#1');
  assert.deepEqual(calls, [{ target: 'browser_observe#1', reason: '外部取消' }]);
  assert.equal(bridge.inflightTools().inflightCount, 0);
});
