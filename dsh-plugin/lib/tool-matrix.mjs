// dsh-plugin/lib/tool-matrix.mjs —— 37 个工具 × 4 类场景的离线行为矩阵。
//
// 目的：没有 daemon、没有浏览器时，也能对每一个模型可见工具验证四种真实路径：
//   success  正常返回并保留工具自己的结果整形
//   error    daemon/CLI 业务错误（E_FORBIDDEN）原样上抛，不被 CLI 兜底静默替换
//   timeout  超时（E_TIMEOUT）不触发回退（除 browser_status 的既定兜底），动作不会被重放
//   offline  daemon 不可用（E_DAEMON）时只允许“请求还没到 daemon”的直连工具回退 CLI；
//            纯 CLI 工具直接上抛 E_DAEMON
//
// 驱动方式是 lib/fake-adapter.mjs（与 daemonRpc 同形）+ 记录调用序列的假 CLI；所有断言都是
// 真实断言（调用次数、方法、argv、错误码、结果字段、启动 journal 状态），没有占位通过。
// 消费方：
//   - scripts/tool-matrix.mjs（写 TOOLS-MATRIX.md，--check 校验生成物）
//   - tests/unit/plugin-matrix.test.mjs（node --test 全量跑 148 格）
//   - skill references/offline-testing.md（作为离线验证流程的权威说明）
import assert from 'node:assert/strict';
import { buildToolSpecs, TOOL_METHODS } from './tools.mjs';
import { createFakeAdapter } from './fake-adapter.mjs';
import { BridgeCliError } from './bridge.mjs';

/** 四类场景，顺序即报告列顺序。 */
export const MATRIX_CLASSES = Object.freeze(['success', 'error', 'timeout', 'offline']);

function clone(value) {
  if (value === undefined || value === null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function memoryJournal() {
  const entries = new Map();
  const order = [];
  return {
    filePath: '<matrix-memory>',
    add(token, meta) {
      entries.set(token, { state: 'starting', at: 1, meta: meta || null });
      order.push(token);
      return entries.get(token);
    },
    ready(token, result) {
      entries.set(token, { ...(entries.get(token) || {}), state: 'ready', result: result || null });
      order.push(token);
    },
    fail(token, error) {
      entries.set(token, { ...(entries.get(token) || {}), state: 'failed', error: String(error || 'failed') });
      order.push(token);
    },
    get(token) {
      return entries.get(token) || null;
    },
    list() {
      return [...entries.entries()].map(([token, entry]) => ({ token, ...entry }));
    },
    latest() {
      const token = order[order.length - 1];
      return token ? { token, ...entries.get(token) } : null;
    },
    stale() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// 每个工具的“代表性调用”：参数、期望通道、协议方法、假结果与结果断言。
// 通道 = 工具在给定参数下实际走哪条路（rpc 直连 / CLI / 直连失败才回退）。
// ---------------------------------------------------------------------------
const E = {
  forbidden: { code: 'E_FORBIDDEN', message: '策略禁止（matrix fake）' },
  timeout: { code: 'E_TIMEOUT', message: '调用超时（matrix fake）' },
};

function expectArray(value, key) {
  assert.ok(Array.isArray(value[key]), key + ' 应为数组');
}

function scenario(def) {
  return Object.freeze(def);
}

export const TOOL_SCENARIOS = Object.freeze({
  browser_status: scenario({
    channel: 'rpc',
    args: {},
    rpcMethod: 'status',
    rpcResult: { port: 4242, version: '0.3.0', browsers: [{ instanceId: 'inst-1' }], sessions: [{ sessionId: 's1' }] },
    cliResult: { port: 4242, version: '0.3.0', browsers: [{ instanceId: 'inst-1' }], sessions: [] },
    cli: ['status'],
    timeout: 'fallback',
    offline: 'fallback',
    error: 'fallback',
    expect(value) {
      assert.equal(value.port, 4242);
      assert.equal(value.browsers[0].instanceId, 'inst-1');
    },
  }),
  browser_session_start: scenario({
    channel: 'rpc',
    args: { browser: 'edge' },
    rpcMethod: 'session.start_tracked',
    rpcResult: { sessionId: 's-start', tabId: 11, windowId: 22, instanceId: 'inst-1', borrowed: false },
    cliResult: { sessionId: 's-start', tabId: 11, windowId: 22, instanceId: 'inst-1', borrowed: false },
    cli: ['session', 'start'],
    timeout: 'retry-reject',
    offline: 'fallback',
    journal: { success: 'ready', error: 'failed', timeout: 'failed', offline: 'ready' },
    expect(value) {
      assert.equal(value.sessionId, 's-start');
      assert.equal(value.borrowed, false);
    },
  }),
  browser_session_stop: scenario({
    channel: 'rpc',
    args: { sessionId: 's1' },
    rpcMethod: 'session.stop',
    rpcResult: { ok: true, stopped: true },
    cliResult: { ok: true, stopped: true },
    cli: ['session', 'stop'],
    expect(value) {
      assert.equal(value.ok, true);
    },
  }),
  browser_navigate: scenario({
    channel: 'rpc',
    args: { url: 'https://example.test/page', sessionId: 's1' },
    rpcMethod: 'navigate',
    rpcResult: { url: 'https://example.test/page', title: 'Example' },
    cliResult: { url: 'https://example.test/page', title: 'Example' },
    cli: ['navigate'],
    expect(value) {
      assert.equal(value.url, 'https://example.test/page');
      assert.equal(value.title, 'Example');
    },
  }),
  browser_observe: scenario({
    channel: 'rpc',
    args: { sessionId: 's1', vom: true },
    rpcMethod: 'observe',
    rpcResult: {
      url: 'https://example.test/',
      title: 'Example',
      refs: 3,
      observation: '- document\n  - button "提交" [@e1]',
      nodes: [{ role: 'button', name: '提交', ref: '@e1' }],
      blocking: null,
    },
    cliResult: {
      url: 'https://example.test/',
      title: 'Example',
      refs: 3,
      observation: '- document\n  - button "提交" [@e1]',
      nodes: [{ role: 'button', name: '提交', ref: '@e1' }],
      blocking: null,
    },
    cli: ['observe'],
    expect(value) {
      assert.equal(value.refs, 3);
      assert.ok(value.observation.includes('提交'));
      assert.equal(value.nodes[0].role, 'button');
    },
  }),
  browser_act: scenario({
    channel: 'rpc',
    args: { action: 'click', ref: '@e1', sessionId: 's1' },
    rpcMethod: 'click',
    rpcResult: { ok: true },
    cliResult: { ok: true },
    cli: ['click'],
    expect(value) {
      assert.equal(value.ok, true);
    },
  }),
  browser_click_backend: scenario({
    channel: 'cli',
    args: { backendNodeId: 42, sessionId: 's1' },
    cliResult: { ok: true, x: 10, y: 20, via: 'cdp-backend' },
    cli: ['click-backend', '--backend', '42'],
    expect(value) {
      assert.equal(value.ok, true);
      assert.equal(value.x, 10);
      assert.equal(value.via, 'cdp-backend');
    },
  }),
  browser_read: scenario({
    channel: 'rpc',
    args: { kind: 'read', ref: '@e1', sessionId: 's1' },
    rpcMethod: 'read',
    rpcResult: { fields: [{ ref: '@e1', value: '矩阵' }] },
    cliResult: { fields: [{ ref: '@e1', value: '矩阵' }] },
    cli: ['read'],
    expect(value) {
      assert.equal(value.fields[0].value, '矩阵');
    },
  }),
  browser_screenshot: scenario({
    channel: 'cli',
    args: { out: 'matrix-shot.png' },
    cliResult: { path: 'D:/tmp/matrix-shot.png', width: 800, height: 600, bytes: 1234 },
    cli: ['screenshot', '--out', 'matrix-shot.png'],
    expect(value) {
      assert.match(value.path, /matrix-shot\.png$/);
      assert.equal(value.bytes, 1234);
    },
  }),
  browser_eval: scenario({
    channel: 'cli',
    args: { expression: '1 + 1' },
    cliResult: { value: 2, verified: true },
    cli: ['evaluate', '1 + 1'],
    expect(value) {
      assert.equal(value.value, 2);
    },
  }),
  browser_network: scenario({
    channel: 'cli',
    args: { action: 'list', filter: '/api' },
    cliResult: { entries: [{ id: 1, url: 'https://example.test/api/x' }], active: true },
    cli: ['network', 'list'],
    expect(value) {
      assert.equal(value.entries[0].id, 1);
      assert.equal(value.active, true);
    },
  }),
  browser_dialog: scenario({
    channel: 'cli',
    args: { action: 'list' },
    cliResult: { dialogs: [{ type: 'alert', handled: true }], armed: false },
    cli: ['dialog', 'list'],
    expect(value) {
      assert.equal(value.dialogs[0].type, 'alert');
      assert.equal(value.armed, false);
    },
  }),
  browser_tab_borrow: scenario({
    channel: 'cli',
    args: { tabId: 7 },
    cliResult: { tabId: 7, borrowed: true, sessionId: 's-borrow' },
    cli: ['tab', 'borrow', '7'],
    expect(value) {
      assert.equal(value.borrowed, true);
    },
  }),
  browser_debug: scenario({
    channel: 'cli',
    args: { action: 'requests', filter: '/api' },
    cliResult: { requests: [{ id: 1, url: '/api/x' }], count: 1 },
    cli: ['debug', 'requests'],
    expect(value) {
      assert.equal(value.count, 1);
    },
  }),
  browser_video: scenario({
    channel: 'cli',
    args: { action: 'start', duration: '10s' },
    cliResult: { recordingId: 'rec-1', durationMs: 0 },
    cli: ['video', 'start'],
    expect(value) {
      assert.equal(value.recordingId, 'rec-1');
    },
  }),
  browser_record: scenario({
    channel: 'cli',
    args: { action: 'list' },
    cliResult: { recordings: [] },
    cli: ['record', 'list'],
    expect(value) {
      expectArray(value, 'recordings');
    },
  }),
  browser_cooperate: scenario({
    channel: 'cli',
    args: { action: 'sync' },
    cliResult: { context_id: 'ctx-1', authority: 'agent' },
    cli: ['cooperate', 'sync'],
    expect(value) {
      assert.equal(value.context_id, 'ctx-1');
    },
  }),
  browser_plan: scenario({
    channel: 'cli',
    args: { steps: [{ method: 'click', params: { ref: '@e1' } }], sessionId: 's1' },
    cliResult: { ok: true, completed: 1, total: 1 },
    cli: ['plan', '--steps'],
    expect(value) {
      assert.equal(value.completed, 1);
      assert.equal(value.total, 1);
    },
  }),
  browser_recipe: scenario({
    channel: 'cli',
    args: { action: 'list' },
    cliResult: { recipes: [{ name: 'demo' }] },
    cli: ['recipe', 'list'],
    expect(value) {
      assert.equal(value.recipes[0].name, 'demo');
    },
  }),
  browser_ledger: scenario({
    channel: 'cli',
    args: { action: 'status' },
    cliResult: { pending: [{ id: 'lt_1' }] },
    cli: ['ledger', 'status'],
    expect(value) {
      assert.equal(value.pending[0].id, 'lt_1');
    },
  }),
  browser_pair: scenario({
    channel: 'cli',
    args: { action: 'list' },
    cliResult: { pairs: [] },
    cli: ['pair', 'list'],
    expect(value) {
      expectArray(value, 'pairs');
    },
  }),
  browser_update: scenario({
    channel: 'cli',
    args: { action: 'state' },
    cliResult: { version: '0.3.0', current: '0.3.0' },
    cli: ['update', 'state'],
    expect(value) {
      assert.equal(value.current, '0.3.0');
    },
  }),
  browser_settings: scenario({
    channel: 'cli',
    args: { action: 'get' },
    cliResult: { label: 'edge', borrowConfirm: true },
    cli: ['settings'],
    expect(value) {
      assert.equal(value.label, 'edge');
    },
  }),
  browser_install_skill: scenario({
    channel: 'cli',
    args: { target: 'dsh' },
    cliResult: { installed: 'dsh', path: 'D:/skills/browser-bridge' },
    cli: ['install-skill', '--target', 'dsh'],
    expect(value) {
      assert.equal(value.installed, 'dsh');
    },
  }),
  browser_brief: scenario({
    channel: 'cli',
    args: { sessionId: 's1' },
    cliResult: { url: 'https://example.test/', refs: 2, suggestions: ['observe'] },
    cli: ['agent', 'brief'],
    expect(value) {
      assert.equal(value.refs, 2);
    },
  }),
  browser_tab: scenario({
    channel: 'rpc',
    args: { action: 'list' },
    rpcMethod: 'tab.list',
    rpcResult: { tabs: [{ tabId: 3, url: 'https://example.test/' }] },
    cliResult: { tabs: [{ tabId: 3, url: 'https://example.test/' }] },
    cli: ['tab', 'list'],
    expect(value) {
      assert.equal(value.tabs[0].tabId, 3);
    },
  }),
  browser_audit: scenario({
    channel: 'cli',
    args: { limit: 5 },
    cliResult: { entries: [{ action: 'click' }], total: 1 },
    cli: ['audit', 'list'],
    expect(value) {
      assert.equal(value.total, 1);
    },
  }),
  browser_tab_new: scenario({
    channel: 'rpc',
    args: { url: 'https://example.test/new' },
    rpcMethod: 'tab.new',
    rpcResult: { tabId: 9, windowId: 2, url: 'https://example.test/new' },
    cliResult: { tabId: 9, windowId: 2, url: 'https://example.test/new' },
    cli: ['tab', 'new'],
    expect(value) {
      assert.equal(value.tabId, 9);
    },
  }),
  browser_tab_close: scenario({
    channel: 'rpc',
    args: { tabId: 9 },
    rpcMethod: 'tab.close',
    rpcResult: { closed: true, tabId: 9 },
    cliResult: { closed: true, tabId: 9 },
    cli: ['tab', 'close'],
    expect(value) {
      assert.equal(value.closed, true);
    },
  }),
  browser_tab_select: scenario({
    channel: 'rpc',
    args: { tabId: 9 },
    rpcMethod: 'tab.select',
    rpcResult: { selected: true, tabId: 9 },
    cliResult: { selected: true, tabId: 9 },
    cli: ['tab', 'select'],
    expect(value) {
      assert.equal(value.selected, true);
    },
  }),
  browser_network_list: scenario({
    channel: 'cli',
    args: { filter: '/api', limit: 5 },
    cliResult: { entries: [{ id: 2, url: '/api/y' }], active: true },
    cli: ['network', 'list'],
    expect(value) {
      assert.equal(value.entries[0].id, 2);
    },
  }),
  browser_rule_list: scenario({
    channel: 'cli',
    args: {},
    cliResult: { rules: [{ id: 1, enabled: true }] },
    cli: ['debug', 'rule_list'],
    expect(value) {
      assert.equal(value.rules[0].enabled, true);
    },
  }),
  browser_video_status: scenario({
    channel: 'cli',
    args: {},
    cliResult: { recording: null, interrupted: false },
    cli: ['video', 'status'],
    expect(value) {
      assert.equal(value.interrupted, false);
    },
  }),
  browser_video_list: scenario({
    channel: 'cli',
    args: {},
    cliResult: { videos: [{ recordingId: 'r1', bytes: 100 }] },
    cli: ['video', 'list'],
    expect(value) {
      assert.equal(value.videos[0].bytes, 100);
    },
  }),
  browser_debug_evidence: scenario({
    channel: 'cli',
    args: {},
    cliResult: { path: 'evidence.json', sha256: 'abc123' },
    cli: ['debug', 'evidence'],
    expect(value) {
      assert.equal(value.sha256, 'abc123');
    },
  }),
  browser_debug_query: scenario({
    channel: 'cli',
    args: { file: 'debug-export.json' },
    cliResult: { requests: [{ url: 'https://example.test/x' }], count: 1 },
    cli: ['debug', 'query', '--file', 'debug-export.json'],
    expect(value) {
      assert.equal(value.count, 1);
    },
  }),
  browser_window: scenario({
    channel: 'rpc',
    args: { action: 'list' },
    rpcMethod: 'window.list',
    rpcResult: { windows: [{ windowId: 1 }] },
    cliResult: { windows: [{ windowId: 1 }] },
    cli: ['window', 'list'],
    expect(value) {
      assert.equal(value.windows[0].windowId, 1);
    },
  }),
});

// ---------------------------------------------------------------------------
// 单格执行
// ---------------------------------------------------------------------------
async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function buildEnvironment(toolName, cls) {
  const scenario = TOOL_SCENARIOS[toolName];
  const cliCalls = [];
  const journal = memoryJournal();
  const run = async (argv) => {
    cliCalls.push(argv.slice());
    if (scenario.channel === 'cli') {
      if (cls === 'error') throw new BridgeCliError('E_FORBIDDEN', '策略禁止（matrix fake CLI）');
      if (cls === 'timeout') throw new BridgeCliError('E_TIMEOUT', 'matrix fake CLI 超时');
      if (cls === 'offline') throw new BridgeCliError('E_DAEMON', 'matrix fake CLI：daemon 未运行');
      return clone(scenario.cliResult);
    }
    // 直连通道只在回退场景下才会调用 CLI。
    return clone(scenario.cliResult);
  };

  let adapter;
  if (scenario.channel === 'rpc') {
    const handlers = {};
    if (cls === 'offline') {
      adapter = createFakeAdapter({ unavailable: true });
    } else {
      const body = cls === 'error' ? { error: E.forbidden } : cls === 'timeout' ? { error: E.timeout } : { result: scenario.rpcResult };
      for (const method of Object.keys(TOOL_METHODS_FOR(toolName))) handlers[method] = body;
      adapter = createFakeAdapter({ handlers });
    }
  } else {
    adapter = createFakeAdapter({ handlers: {} });
  }

  const specs = buildToolSpecs(run, { rpc: adapter.call, journal });
  const spec = specs.find((item) => item.name === toolName);
  if (!spec) throw new Error('矩阵找不到工具：' + toolName);
  return { scenario, spec, adapter, run, cliCalls, journal };
}

// 工具→协议方法映射从 tools.mjs 的 TOOL_METHODS 取，避免测试手抄一份会漂移的清单。
function TOOL_METHODS_FOR(toolName) {
  const methods = TOOL_METHODS[toolName] || [];
  if (!methods.length) throw new Error('矩阵的直连工具缺少方法映射：' + toolName);
  return Object.fromEntries(methods.map((method) => [method, true]));
}

function cliPrefixMatches(actual, expected) {
  if (!Array.isArray(actual) || actual.length < expected.length) return false;
  return expected.every((item, index) => actual[index] === item);
}

function rpcCallsDetail(adapter) {
  return adapter.calls.map((entry) => entry.method).join('+') || '无 rpc';
}

function assertRpcCalls(env, expectedCount) {
  assert.equal(env.adapter.calls.length, expectedCount, '直连调用次数不符：' + rpcCallsDetail(env.adapter));
  for (const call of env.adapter.calls) {
    assert.ok((TOOL_METHODS[env.spec.name] || []).includes(call.method), '调用了未映射方法：' + call.method);
  }
}

function assertNoCli(env) {
  assert.equal(env.cliCalls.length, 0, '不该回退 CLI：' + JSON.stringify(env.cliCalls[0]));
}

function assertCliFallback(env, expectedCalls = 1) {
  assert.equal(env.cliCalls.length, expectedCalls, 'CLI 回退次数不符');
  assert.ok(cliPrefixMatches(env.cliCalls[0], env.scenario.cli), 'CLI 回退命令不符：' + JSON.stringify(env.cliCalls[0]));
}

function checkJournal(env, cls) {
  const expected = env.scenario.journal && env.scenario.journal[cls];
  if (!expected) return;
  const latest = env.journal.latest();
  assert.ok(latest, '启动 journal 没有记录');
  assert.equal(latest.state, expected, '启动 journal 状态应为 ' + expected + '，实际 ' + latest.state);
}

function verdict(ok, detail, extra = {}) {
  return { ok, detail, ...extra };
}

function expectCell(env, cls, outcome) {
  const { scenario, spec } = env;
  const channel = scenario.channel;

  if (cls === 'success') {
    assert.ok(outcome.ok, '成功场景不应抛错：' + (outcome.error && outcome.error.message));
    scenario.expect(outcome.value, env);
    if (channel === 'rpc') {
      assertRpcCalls(env, scenario.rpcCalls || 1);
      if (scenario.rpcMethod) assert.ok(env.adapter.callsFor(scenario.rpcMethod).length >= 1, '未调用 ' + scenario.rpcMethod);
      assertNoCli(env);
    } else {
      assert.equal(env.cliCalls.length, 1, 'CLI 调用次数应为 1');
      assert.ok(cliPrefixMatches(env.cliCalls[0], scenario.cli), 'CLI 命令不符：' + JSON.stringify(env.cliCalls[0]));
      assert.equal(env.adapter.calls.length, 0, '纯 CLI 工具不应直连');
    }
    checkJournal(env, cls);
    return verdict(true, channel === 'rpc'
      ? 'rpc ' + rpcCallsDetail(env.adapter) + ' → 结果已整形'
      : 'cli ' + scenario.cli.join(' ') + ' → 结果已整形');
  }

  if (cls === 'error') {
    if (scenario.error === 'fallback') {
      // browser_status 是只读状态查询：直连失败时按既定实现兜底 CLI，属安全回退。
      assert.ok(outcome.ok, 'error 兜底场景应成功：' + (outcome.error && outcome.error.message));
      assertCliFallback(env, 1);
      assert.equal(env.adapter.calls.length, 1, '应只直连一次');
      return verdict(true, 'E_FORBIDDEN → CLI 兜底成功（只读状态查询）');
    }
    assert.equal(outcome.ok, false, '业务错误不应被吞掉');
    assert.equal(outcome.error && outcome.error.code, 'E_FORBIDDEN', '业务错误码应原样上抛');
    if (channel === 'rpc') {
      assertRpcCalls(env, 1);
      assertNoCli(env);
    } else {
      assert.equal(env.cliCalls.length, 1, 'CLI 调用次数应为 1');
    }
    checkJournal(env, cls);
    return verdict(true, channel === 'rpc' ? 'E_FORBIDDEN 原样上抛，未回退 CLI' : 'CLI E_FORBIDDEN 原样上抛');
  }

  if (cls === 'timeout') {
    const mode = scenario.timeout || (channel === 'rpc' ? 'reject' : 'reject');
    if (mode === 'fallback') {
      assert.ok(outcome.ok, 'timeout 兜底场景应成功：' + (outcome.error && outcome.error.message));
      assertCliFallback(env, 1);
      assert.equal(env.adapter.calls.length, 1, '应只直连一次');
      return verdict(true, 'E_TIMEOUT → CLI 兜底成功（browser_status 既定行为）');
    }
    assert.equal(outcome.ok, false, '超时不应被吞掉');
    assert.equal(outcome.error && outcome.error.code, 'E_TIMEOUT', '应上抛 E_TIMEOUT');
    if (channel === 'rpc') {
      const expectedCalls = mode === 'retry-reject' ? 2 : 1;
      assertRpcCalls(env, expectedCalls);
      assertNoCli(env);
      checkJournal(env, cls);
      return verdict(true, mode === 'retry-reject' ? 'E_TIMEOUT 重试 2 次后上抛' : 'E_TIMEOUT 上抛，未回退 CLI');
    }
    assert.equal(env.cliCalls.length, 1, 'CLI 调用次数应为 1');
    return verdict(true, 'CLI E_TIMEOUT 上抛');
  }

  if (cls === 'offline') {
    const mode = scenario.offline || (channel === 'rpc' ? 'fallback' : 'reject');
    if (mode === 'fallback') {
      assert.ok(outcome.ok, 'offline 回退场景应成功：' + (outcome.error && outcome.error.message));
      assertCliFallback(env, 1);
      assert.equal(env.adapter.calls.length, 1, '应只直连一次后回退');
      checkJournal(env, cls);
      return verdict(true, 'E_DAEMON → CLI 回退成功');
    }
    assert.equal(outcome.ok, false, 'E_DAEMON 不应被吞掉');
    assert.equal(outcome.error && outcome.error.code, 'E_DAEMON', '应上抛 E_DAEMON');
    assert.equal(env.cliCalls.length, 1, 'CLI 调用次数应为 1');
    return verdict(true, 'CLI E_DAEMON 上抛');
  }

  throw new Error('未知场景类：' + cls);
}

/** 跑单格（供测试逐格断言/调试单点）。 */
export async function runCell(toolName, cls) {
  if (!MATRIX_CLASSES.includes(cls)) throw new Error('未知场景类：' + cls);
  const env = buildEnvironment(toolName, cls);
  const outcome = await capture(() => env.spec.execute(clone(env.scenario.args), {}));
  try {
    const result = expectCell(env, cls, outcome);
    return { tool: toolName, cls, channel: env.scenario.channel, ...result };
  } catch (error) {
    return {
      tool: toolName,
      cls,
      channel: env.scenario.channel,
      ok: false,
      detail: String((error && error.message) || error),
      actual: outcome.ok ? 'resolved' : 'rejected:' + (outcome.error && outcome.error.code),
    };
  }
}

/** 跑全部工具 × 4 类，返回行与汇总（永不抛错：失败格记录在 rows 里）。 */
export async function runMatrix() {
  const toolNames = Object.keys(TOOL_SCENARIOS);
  const rows = [];
  for (const tool of toolNames) {
    for (const cls of MATRIX_CLASSES) rows.push(await runCell(tool, cls));
  }
  const byClass = {};
  for (const cls of MATRIX_CLASSES) {
    const cells = rows.filter((row) => row.cls === cls);
    byClass[cls] = { total: cells.length, passed: cells.filter((cell) => cell.ok).length, failed: cells.filter((cell) => !cell.ok).length };
  }
  const failures = rows.filter((row) => !row.ok);
  return {
    rows,
    summary: {
      tools: toolNames.length,
      classes: MATRIX_CLASSES.length,
      cells: rows.length,
      passed: rows.filter((row) => row.ok).length,
      failed: failures.length,
      fallbacks: rows.filter((row) => row.ok && /回退|兜底/.test(row.detail)).length,
      byClass,
      failures,
    },
  };
}

// ---------------------------------------------------------------------------
// 报告渲染（TOOLS-MATRIX.md；纯函数，便于 --check 与测试对照）
// ---------------------------------------------------------------------------
const CLASS_LABEL = {
  success: 'success（正常返回）',
  error: 'error（业务错误）',
  timeout: 'timeout（超时）',
  offline: 'offline（daemon 不可用）',
};

/** @param {{rows: Array, summary: object}} result */
export function renderMatrixReport(result) {
  const rows = result.rows.slice().sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  const lines = [];
  lines.push('# 37 个 browser_* 工具 · 离线行为矩阵');
  lines.push('');
  lines.push('> GENERATED by `dsh-plugin/scripts/tool-matrix.mjs` —— 不要手改；`--check` 会校验本文件与实现一致。');
  lines.push('');
  lines.push('本矩阵用 `dsh-plugin/lib/fake-adapter.mjs`（与 `daemonRpc` 同形的可脚本化假 daemon）与记录');
  lines.push('调用的假 CLI，在**没有 daemon、没有浏览器、不联网**的条件下驱动每个工具的四种路径：');
  lines.push('');
  for (const cls of MATRIX_CLASSES) lines.push('- **' + CLASS_LABEL[cls] + '**');
  lines.push('');
  lines.push('`成功` 会校验工具自己的结果整形；`错误` 断言业务错误码原样上抛且不被 CLI 兜底；');
  lines.push('`超时` 断言不触发动作重放（`browser_status` 的 CLI 兜底与 `browser_session_start` 的');
  lines.push('一次 request-id 重试是既定行为，单独标注）；`离线` 断言只有“请求尚未到达 daemon”的');
  lines.push('`E_DAEMON`/`E_DIRECT_RPC_DISABLED` 才允许回退 CLI。');
  lines.push('');
  const summary = result.summary;
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 项目 | 数值 |');
  lines.push('| --- | ---: |');
  lines.push('| 工具数 | ' + summary.tools + ' |');
  lines.push('| 场景类 | ' + summary.classes + ' |');
  lines.push('| 断言格 | ' + summary.cells + ' |');
  lines.push('| 通过 | ' + summary.passed + ' |');
  lines.push('| 失败 | ' + summary.failed + ' |');
  lines.push('| 回退/兜底格 | ' + summary.fallbacks + ' |');
  for (const cls of MATRIX_CLASSES) {
    lines.push('| ' + classShort(cls) + ' 通过 | ' + summary.byClass[cls].passed + '/' + summary.byClass[cls].total + ' |');
  }
  lines.push('');
  lines.push('## 矩阵');
  lines.push('');
  lines.push('| 工具 | 通道 | ' + MATRIX_CLASSES.join(' | ') + ' |');
  lines.push('| --- | --- | ' + MATRIX_CLASSES.map(() => '---').join(' | ') + ' |');
  const byTool = new Map();
  for (const row of rows) {
    if (!byTool.has(row.tool)) byTool.set(row.tool, {});
    byTool.get(row.tool)[row.cls] = row;
  }
  for (const [tool, cells] of byTool) {
    const channel = cells[MATRIX_CLASSES[0]].channel;
    const columns = MATRIX_CLASSES.map((cls) => {
      const cell = cells[cls];
      return (cell.ok ? 'PASS' : 'FAIL') + ' · ' + cell.detail.replace(/\|/g, '\\|');
    });
    lines.push('| `' + tool + '` | ' + channel + ' | ' + columns.join(' | ') + ' |');
  }
  lines.push('');
  if (summary.failures.length) {
    lines.push('## 失败明细');
    lines.push('');
    for (const failure of summary.failures) {
      lines.push('- `' + failure.tool + ` / ${failure.cls}` + '`：' + failure.detail);
    }
    lines.push('');
    lines.push('矩阵存在失败格：不要发布，先按明细修复实现或场景期望。');
  } else {
    lines.push('全部 ' + summary.cells + ' 格通过（' + summary.tools + ' 工具 × ' + summary.classes + ' 场景类）。');
  }
  lines.push('');
  return lines.join('\n');
}

function classShort(cls) {
  return cls;
}
