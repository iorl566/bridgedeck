import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../mcp/server.mjs';
import { createBrowserTools } from '../../mcp/tools.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';

// 这些工具只做本地 CLI/文件操作，不直接映射 daemon RPC 方法。
const LOCAL_ONLY = new Set([
  'browser_update_state',
  'browser_install_skill',
  'browser_recipe',
  'browser_update',
  'browser_debug_analyze',
  'browser_debug_evidence',
  'browser_debug_journal',
  'browser_debug_query',
  'browser_debug_archive',
  'browser_debug_archives',
  'browser_trace_summary',
  'browser_video_trim',
  'browser_video_recover',
  'browser_video_info',
  'browser_video_split',
  'browser_video_merge',
  'browser_debug_har',
  'browser_debug_har_import',
]);

test('MCP 工具数量、命名与协议方法映射', () => {
  assert.equal(TOOLS.length, 92);
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length);
  const clickBackend = TOOLS.find((tool) => tool.name === 'browser_click_backend');
  assert.ok(clickBackend && clickBackend.methods.includes('click-backend'), 'browser_click_backend 未映射 click-backend');
  for (const tool of TOOLS) {
    assert.match(tool.name, /^browser_[a-z_]+$/, tool.name);
    assert.ok(Array.isArray(tool.methods), tool.name + ' 缺少 methods');
    for (const method of tool.methods) {
      assert.ok(METHOD_EFFECT[method], tool.name + ' 映射了未知方法 ' + method);
    }
    if (tool.methods.length === 0) assert.ok(LOCAL_ONLY.has(tool.name), tool.name + ' 空映射但不在本地工具清单');
    if (LOCAL_ONLY.has(tool.name)) assert.equal(tool.methods.length, 0, tool.name);
  }
});

test('生成的页面动作 schema 暴露 actionability 选项', () => {
  const click = TOOLS.find((tool) => tool.name === 'browser_click');
  assert.equal(click.methods[0], 'click');
  assert.equal(click.inputSchema.properties.trusted.type, 'boolean');
  assert.equal(click.inputSchema.properties.force.type, 'boolean');
  assert.equal(click.inputSchema.properties.wait_timeout.type, 'integer');
  const fill = TOOLS.find((tool) => tool.name === 'browser_fill');
  assert.deepEqual(fill.inputSchema.required, ['value']);
  assert.equal(fill.inputSchema.properties.no_clear.type, 'boolean');
});

test('控制类工具也从规范 schema 生成', () => {
  const tabs = TOOLS.find((tool) => tool.name === 'browser_tabs');
  assert.equal(tabs.inputSchema.properties.scope.type, 'string');
  const close = TOOLS.find((tool) => tool.name === 'browser_tab_close');
  assert.deepEqual(close.inputSchema.required, ['tab_id']);
  const wait = TOOLS.find((tool) => tool.name === 'browser_wait_for');
  assert.equal(wait.inputSchema.properties.state.type, 'string');
  assert.equal(wait.inputSchema.properties.operation_id.type, 'string');
  const record = TOOLS.find((tool) => tool.name === 'browser_record_start');
  assert.equal(record.inputSchema.properties.purpose.type, 'string');
  assert.equal(record.inputSchema.properties.max_page_tokens.type, 'integer');
  const video = TOOLS.find((tool) => tool.name === 'browser_video_status');
  assert.equal(video.inputSchema.properties.recording.type, 'string');
  const videoStart = TOOLS.find((tool) => tool.name === 'browser_video_start');
  assert.equal(videoStart.inputSchema.properties.duration_ms.type, 'integer');
  assert.equal(videoStart.inputSchema.properties.duration.type, 'string');
  const videoStop = TOOLS.find((tool) => tool.name === 'browser_video_stop');
  assert.equal(videoStop.inputSchema.properties.recording.type, 'string');
  assert.equal(videoStop.inputSchema.properties.recording_id.type, 'string');
  const network = TOOLS.find((tool) => tool.name === 'browser_network_list');
  assert.equal(network.inputSchema.properties.filter.type, 'object');
  assert.equal(network.inputSchema.properties.filter_text.type, 'string');
  assert.equal(network.inputSchema.properties.since.type, 'integer');
  const window = TOOLS.find((tool) => tool.name === 'browser_window');
  assert.equal(window.inputSchema.properties.width.type, 'number');
  assert.equal(window.inputSchema.properties.height.type, 'number');
  const dialog = TOOLS.find((tool) => tool.name === 'browser_dialog');
  assert.ok(dialog.inputSchema.properties.action.enum.includes('arm'));
  assert.equal(dialog.inputSchema.properties.prompt_text.type, 'string');
  const debugStart = TOOLS.find((tool) => tool.name === 'browser_debug_start');
  assert.equal(debugStart.inputSchema.properties.name.type, 'string');
  assert.equal(debugStart.inputSchema.properties.bodies.type, 'boolean');
  const ruleAdd = TOOLS.find((tool) => tool.name === 'browser_rule_add');
  assert.deepEqual(ruleAdd.inputSchema.required, ['rule']);
  assert.equal(ruleAdd.inputSchema.properties.rule.type, 'object');
});

test('所有 MCP inputSchema 都是封闭对象', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.inputSchema.properties, 'object', tool.name);
  }
});

// ---------------------------------------------------------------------------
// M6-P0①：BSK MCP 直接动作入口（press/hover/select/drag/scroll_to/wheel/focus/blur、
// back/forward/reload/console、session.request_*、tab borrow/return）。
// 这里用假 ctx 抓 RPC 调用，验证：
//   1. 新工具分发到既有 canonical 目录方法（不新增未实现 RPC）；
//   2. BSK 风格入参（source/target/delta/ref/selector/tab_id/request_id）换算成我方协议参数；
//   3. schema 的必填/枚举与协议 schema 同源。
// ---------------------------------------------------------------------------
function fakeCtx() {
  const calls = [];
  const state = {};
  return {
    calls,
    state,
    ctx: {
      rpc: async (method, params) => {
        calls.push({ method, params });
        if (method.startsWith('session.request_')) return { ok: true, requestId: params.requestId, entry: { state: 'prepared' } };
        return { ok: true };
      },
      ensureSession: async () => 's-m6',
      withSession: (sessionId, params) => ({ ...params, session: sessionId }),
      parseDurationMs: () => null,
      runCliJson: async () => ({}),
      HOME: '',
      state,
    },
  };
}

test('M6 直接入口：schema 必填项与协议 schema 同源', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get('browser_press').inputSchema.required, ['key']);
  assert.deepEqual(byName.get('browser_select').inputSchema.required, ['value']);
  const drag = byName.get('browser_drag');
  for (const prop of ['source', 'target', 'delta', 'mode', 'hold_ms', 'capture', 'image_x', 'steps', 'modifiers']) {
    assert.ok(drag.inputSchema.properties[prop], 'browser_drag 缺参数 ' + prop);
  }
  assert.deepEqual(drag.inputSchema.properties.mode.enum, ['hold', 'click-move-click']);
  assert.deepEqual(byName.get('browser_wheel').inputSchema.properties.delta_y.type, 'number');
  assert.equal(byName.get('browser_wheel').inputSchema.properties.ref.type, 'string');
  assert.deepEqual(byName.get('browser_back').methods, ['navigate-back']);
  assert.deepEqual(byName.get('browser_forward').methods, ['navigate-forward']);
  assert.deepEqual(byName.get('browser_reload').methods, ['reload']);
  assert.deepEqual(byName.get('browser_console').methods, ['console']);
  for (const name of ['browser_session_request_status', 'browser_session_request_claim', 'browser_session_request_cancel']) {
    assert.deepEqual(byName.get(name).inputSchema.required, ['request_id'], name);
  }
  assert.equal(byName.get('browser_session_request_prepare').inputSchema.required, undefined);
  for (const name of ['browser_tab_borrow', 'browser_tab_return']) {
    assert.deepEqual(byName.get(name).inputSchema.required, ['tab_id'], name);
    assert.equal(byName.get(name).inputSchema.properties.tab_id.type, 'integer', name);
  }
});

test('M6 直接入口：分发到既有 RPC 并换算 BSK 风格参数', async () => {
  const { calls, ctx } = fakeCtx();
  const tools = new Map(createBrowserTools(ctx).map((tool) => [tool.name, tool]));
  await tools.get('browser_press').run({ key: 'Enter', ref: '@e1' });
  await tools.get('browser_hover').run({ selector: '#menu' });
  await tools.get('browser_select').run({ ref: '@e2', value: 'b' });
  await tools.get('browser_drag').run({ source: '@e1', target: '@e2', mode: 'click-move-click' });
  await tools.get('browser_drag').run({ source: '@e1', delta: { x: 10, y: -20 } });
  await tools.get('browser_scroll_to').run({ ref: '@e3' });
  await tools.get('browser_wheel').run({ delta_y: 120, selector: '#list' });
  await tools.get('browser_focus').run({ ref: '@e4' });
  await tools.get('browser_blur').run({ ref: '@e4' });
  await tools.get('browser_back').run({});
  await tools.get('browser_forward').run({});
  await tools.get('browser_reload').run({});
  await tools.get('browser_console').run({ since: 5, limit: 10 });
  await tools.get('browser_tab_borrow').run({ tab_id: 9 });
  await tools.get('browser_tab_return').run({ tab_id: 9 });
  await tools.get('browser_session_request_status').run({ request_id: '1700000000000:abcdefgh' });

  assert.deepEqual(calls.map((call) => call.method), [
    'press', 'hover', 'select', 'drag', 'drag', 'scroll-to', 'wheel', 'focus', 'blur',
    'navigate-back', 'navigate-forward', 'reload', 'console', 'tab.borrow', 'tab.return', 'session.request_status',
  ]);
  for (const call of calls) {
    assert.ok(METHOD_EFFECT[call.method], '分发到 canonical 目录外的方法：' + call.method);
  }
  // 每个会话级工具都注入了同一个 session；tab 工具与 request_* 是本地/实例方法，不带 session。
  assert.equal(calls[0].params.session, 's-m6');
  assert.deepEqual(calls[0].params, { ref: '@e1', key: 'Enter', session: 's-m6' });
  assert.deepEqual(calls[3].params, { from: '@e1', to: '@e2', mode: 'click-move-click', session: 's-m6' });
  assert.deepEqual(calls[4].params, { from: '@e1', dx: 10, dy: -20, session: 's-m6' });
  assert.deepEqual(calls[6].params, { deltaY: 120, selector: '#list', session: 's-m6' });
  assert.deepEqual(calls[12].params, { since: 5, limit: 10, session: 's-m6' });
  assert.deepEqual(calls[13].params, { tabId: 9 });
  assert.deepEqual(calls[14].params, { tabId: 9 });
  assert.deepEqual(calls[15].params, { requestId: '1700000000000:abcdefgh' });
});

test('M6 tracked session prepare：缺 request_id 时生成可恢复 token 并回填状态', async () => {
  const { calls, state, ctx } = fakeCtx();
  const tools = new Map(createBrowserTools(ctx).map((tool) => [tool.name, tool]));
  await tools.get('browser_session_request_prepare').run({ browser: 'chrome', no_focus: true });
  assert.equal(calls[0].method, 'session.request_prepare');
  assert.match(calls[0].params.requestId, /^\d{10,16}:[A-Za-z0-9_-]{8,80}$/);
  assert.equal(calls[0].params.browser, 'chrome');
  assert.equal(calls[0].params.noFocus, true);
  assert.equal(state.startRequestId, calls[0].params.requestId);
  await tools.get('browser_session_request_claim').run({ request_id: '1700000000000:abcdefgh' });
  assert.deepEqual(calls[1], { method: 'session.request_claim', params: { requestId: '1700000000000:abcdefgh' } });
});

// ---------------------------------------------------------------------------
// M6-P0②：剩余 MCP 动作入口（inspect html / assist emulate+request_help+operation.* /
// session browsers+list）。与 M6-P0① 同样的验证口径：分发到既有 canonical 方法、
// 上游风格入参换算正确、schema 必填/枚举与协议 schema 同源。
// ---------------------------------------------------------------------------
test('M6-P0② 直接入口：schema 必填项与协议 schema 同源', () => {  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const html = byName.get('browser_inspect_html');
  assert.deepEqual(html.methods, ['get-html']);
  for (const prop of ['ref', 'selector', 'stable_ref', 'expect_revision']) assert.ok(html.inputSchema.properties[prop], 'browser_inspect_html 缺参数 ' + prop);
  const emulate = byName.get('browser_assist_emulate');
  for (const prop of ['device', 'width', 'height', 'dpr', 'mobile', 'ua', 'timezone', 'locale', 'geolocation', 'touch', 'reset']) {
    assert.ok(emulate.inputSchema.properties[prop], 'browser_assist_emulate 缺参数 ' + prop);
  }
  const requestHelp = byName.get('browser_assist_request_help');
  assert.deepEqual(requestHelp.inputSchema.required, ['reason']);
  assert.equal(requestHelp.inputSchema.properties.timeout_ms.type, 'integer');
  assert.ok(requestHelp.inputSchema.properties.criteria, 'browser_assist_request_help 缺 criteria');
  assert.deepEqual(requestHelp.inputSchema.properties.criteria.items.properties.kind.enum, ['selector_exists', 'selector_visible', 'text_exists', 'url_contains']);
  for (const name of ['browser_assist_operation_await', 'browser_assist_operation_cancel']) {
    assert.ok(byName.get(name).inputSchema.properties.operation_id, name + ' 缺 operation_id');
    assert.equal(byName.get(name).inputSchema.properties.operation_id.minLength, 1, name);
  }
  for (const name of ['browser_session_browsers', 'browser_session_list']) {
    assert.deepEqual(byName.get(name).methods, name === 'browser_session_browsers' ? ['browsers'] : ['session.list']);
    // 入参 schema 自适应 lib/schemas.mjs：方法后续补 schema 时属性会跟着变化，这里只要求
    // 是封闭对象、且不要求任何业务参数（daemon 本地全局查询）。
    assert.equal(byName.get(name).inputSchema.type, 'object');
    assert.equal(byName.get(name).inputSchema.additionalProperties, false);
    assert.equal(byName.get(name).inputSchema.required, undefined);
  }
});

test('M6-P0② 直接入口：分发到既有 RPC 并换算上游风格参数', async () => {
  const { calls, ctx } = fakeCtx();
  const tools = new Map(createBrowserTools(ctx).map((tool) => [tool.name, tool]));
  await tools.get('browser_inspect_html').run({ ref: '@e1' });
  // device 预设（与 cli/commands/emulate.mjs 同一套换算）→ 扩展读取的 viewport/userAgent。
  await tools.get('browser_assist_emulate').run({ device: 'iphone-14' });
  await tools.get('browser_assist_emulate').run({ width: 800, height: 600, mobile: true, timezone: 'Asia/Shanghai' });
  await tools.get('browser_assist_emulate').run({ reset: true });
  await tools.get('browser_assist_request_help').run({ reason: '完成登录', timeout_ms: 5000, criteria: [{ kind: 'selector_exists', selector: '#done' }] });
  await tools.get('browser_assist_operation_await').run({ operation_id: 'op-1', timeout_ms: 5000 });
  await tools.get('browser_assist_operation_cancel').run({ operation_id: 'op-1' });
  await tools.get('browser_session_browsers').run({});
  await tools.get('browser_session_list').run({});

  assert.deepEqual(calls.map((call) => call.method), [
    'get-html', 'emulate', 'emulate', 'emulate', 'request-help', 'operation.await', 'operation.cancel', 'browsers', 'session.list',
  ]);
  for (const call of calls) {
    assert.ok(METHOD_EFFECT[call.method], '分发到 canonical 目录外的方法：' + call.method);
  }
  assert.deepEqual(calls[0].params, { ref: '@e1', session: 's-m6' });
  assert.deepEqual(calls[1].params, {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    session: 's-m6',
  });
  assert.deepEqual(calls[2].params, {
    viewport: { width: 800, height: 600, mobile: true },
    timezone: 'Asia/Shanghai',
    session: 's-m6',
  });
  assert.deepEqual(calls[3].params, { reset: true, session: 's-m6' });
  assert.deepEqual(calls[4].params, {
    reason: '完成登录',
    timeoutMs: 5000,
    criteria: [{ kind: 'selector_exists', selector: '#done' }],
    session: 's-m6',
  });
  assert.deepEqual(calls[5].params, { timeoutMs: 5000, id: 'op-1', session: 's-m6' });
  assert.deepEqual(calls[6].params, { id: 'op-1', session: 's-m6' });
  // 两个 daemon 本地查询不注入会话（全局只读）。
  assert.deepEqual(calls[7].params, {});
  assert.deepEqual(calls[8].params, {});
});

test('M6-P0② 直接入口：参数边界与错误码', async () => {
  const { ctx } = fakeCtx();
  const tools = new Map(createBrowserTools(ctx).map((tool) => [tool.name, tool]));
  await assert.rejects(() => tools.get('browser_assist_emulate').run({ device: 'not-a-device' }), (error) => error.code === 'E_ARG_ENUM');
  await assert.rejects(() => tools.get('browser_assist_emulate').run({ width: 800 }), (error) => error.code === 'E_ARG_MISSING');
  await assert.rejects(() => tools.get('browser_assist_emulate').run({ reset: true, timezone: 'UTC' }), (error) => error.code === 'E_ARG_UNEXPECTED');
  await assert.rejects(() => tools.get('browser_assist_emulate').run({}), (error) => error.code === 'E_ARG_MISSING');
  await assert.rejects(() => tools.get('browser_assist_operation_await').run({}), (error) => error.code === 'E_ARG_MISSING');
  await assert.rejects(() => tools.get('browser_assist_operation_cancel').run({}), (error) => error.code === 'E_ARG_MISSING');
});
