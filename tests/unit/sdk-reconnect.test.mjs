// tests/unit/sdk-reconnect.test.mjs —— Node SDK 传输重连（策略 / 退避 / 状态机 / 编排 / 客户端集成）。
//
// 覆盖：策略归一化（默认关闭、上限、非法值回落）、确定性退避、错误分类、状态机事件、
// runReconnect（成功/耗尽/关闭）、McpClient 的 ensureConnected/callTool 重连、非幂等工具
// 保护、transportSnapshot、syncResourceSubscriptions 订阅对账，以及真实 McpTransport 生命周期。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECONNECT_DEFAULTS,
  RECONNECT_REASONS,
  RECONNECT_STATES,
  RECONNECTABLE_CODES,
  ReconnectTracker,
  backoffDelayMs,
  isReconnectableError,
  reconnectSnapshot,
  resolveReconnectPolicy,
  runReconnect,
} from '../../sdk/reconnect.mjs';
import { McpClient, McpRpcError, McpTransport, createMcpClient, mcpClientSnapshot } from '../../sdk/mcp-client.mjs';

const noSleep = async () => {};

/** 可编程的 fake 传输：记录请求、可按方法抛错，行为与 McpTransport 的客户端面一致。 */
class FakeTransport {
  constructor({ name = 'fake', fail = null, closeOnStart = false } = {}) {
    this.name = name;
    this.fail = fail;
    this.closed = false;
    this.exitOnStart = closeOnStart;
    this.requests = [];
    this.notifications = [];
    this.listeners = [];
    this.cancels = [];
    this.seq = 0;
    this.pending = new Map();
    this.onExit = null;
    this.subscriptions = new Set();
    this.delays = [];
  }

  get alive() {
    return !this.closed;
  }

  async _maybeDelay(method) {
    const wait = this.behavior && this.behavior[method];
    if (typeof wait === 'number') await new Promise((resolve) => setTimeout(resolve, wait));
  }

  setBehavior(behavior) {
    this.behavior = behavior;
    return this;
  }

  async request(method, params = {}, options = {}) {
    if (this.closed) throw new McpRpcError('E_DISCONNECTED', this.name + ' closed');
    this.seq += 1;
    const id = this.seq;
    this.requests.push({ method, params, options, id });
    if (typeof options.onStart === 'function') options.onStart(id);
    await this._maybeDelay(method);
    if (this.fail && this.fail(method, params)) {
      throw new McpRpcError(this.fail(method, params), this.name + ' 模拟失败：' + method, { method, requestId: id });
    }
    if (method === 'initialize') {
      return {
        protocolVersion: '2024-11-05',
        capabilities: { resources: { subscribe: true }, tools: { listChanged: false } },
        serverInfo: { name: 'fake-' + this.name, version: '0.0.1' },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/call') {
      const name = params.name;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, transport: this.name }) }],
        isError: false,
        _meta: { 'browser-bridge/tier': 'read' },
      };
    }
    if (method === 'resources/subscribe') {
      this.subscriptions.add(params.uri);
      return { _meta: { 'browser-bridge/subscription': { uri: params.uri, added: true, count: this.subscriptions.size } } };
    }
    if (method === 'resources/unsubscribe') {
      const found = this.subscriptions.delete(params.uri);
      return { _meta: { 'browser-bridge/subscription': { uri: params.uri, found, count: this.subscriptions.size } } };
    }
    if (method === 'resources/list') return { resources: [], _meta: {} };
    return {};
  }

  notify(method, params = {}) {
    this.notifications.push({ method, params });
  }

  cancel(requestId, reason = '') {
    this.cancels.push({ requestId, reason });
    return this.pending.delete(requestId);
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

  snapshot() {
    return { alive: this.alive, closed: this.closed, pid: null, requests: this.seq };
  }

  close() {
    this.closed = true;
  }
}

test('resolveReconnectPolicy：默认关闭、布尔开启、对象细粒度与非法值回落', () => {
  const disabled = resolveReconnectPolicy();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maxAttempts, RECONNECT_DEFAULTS.maxAttempts);
  assert.equal(resolveReconnectPolicy(false).enabled, false);

  const enabled = resolveReconnectPolicy(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.healthCheck, true);
  assert.equal(enabled.resubscribe, true);
  assert.equal(enabled.retryIdempotentOnly, true);

  const custom = resolveReconnectPolicy({
    enabled: true,
    maxAttempts: 2,
    baseDelayMs: 50,
    maxDelayMs: 200,
    jitter: false,
    healthCheck: false,
    resubscribe: false,
    handshakeTimeoutMs: 500,
    retryIdempotentOnly: false,
  });
  assert.equal(custom.maxAttempts, 2);
  assert.equal(custom.baseDelayMs, 50);
  assert.equal(custom.maxDelayMs, 200);
  assert.equal(custom.jitter, false);
  assert.equal(custom.healthCheck, false);
  assert.equal(custom.resubscribe, false);
  assert.equal(custom.retryIdempotentOnly, false);

  // 上限与非法值：次数封顶 16、延迟封顶 120s、非法回落默认。
  const capped = resolveReconnectPolicy({ maxAttempts: 999, baseDelayMs: -1, maxDelayMs: 1e9 });
  assert.equal(capped.maxAttempts, 16);
  assert.equal(capped.baseDelayMs, RECONNECT_DEFAULTS.baseDelayMs);
  assert.equal(capped.maxDelayMs, 120_000);
  assert.equal(resolveReconnectPolicy({ enabled: false }).enabled, false);
});

test('backoffDelayMs：指数增长、确定性、上限与 jitter 关闭', () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 1000, jitter: false };
  assert.equal(backoffDelayMs(0, policy), 100);
  assert.equal(backoffDelayMs(1, policy), 200);
  assert.equal(backoffDelayMs(2, policy), 400);
  assert.equal(backoffDelayMs(10, policy), 1000, '不超过 maxDelayMs');
  assert.equal(backoffDelayMs(-1, policy), 100);

  const jittered = { baseDelayMs: 100, maxDelayMs: 1000, jitter: true };
  const first = backoffDelayMs(2, jittered, { code: 'E_DISCONNECTED' });
  const second = backoffDelayMs(2, jittered, { code: 'E_DISCONNECTED' });
  assert.equal(first, second, '抖动必须确定（同 attempt/code）');
  assert.ok(first >= 320 && first <= 480, '抖动区间应在 0.8..1.2 内：' + first);
  assert.notEqual(first, backoffDelayMs(2, jittered, { code: 'E_DAEMON' }), '不同错误码抖动不同');
  assert.equal(typeof backoffDelayMs(0, null), 'number');
});

test('isReconnectableError：连接类可重连，业务/参数/审批错误不可', () => {
  for (const code of RECONNECTABLE_CODES) {
    const result = isReconnectableError({ code });
    assert.equal(result.reconnectable, true, code);
    assert.equal(result.code, code);
  }
  for (const code of ['E_ARG_MISSING', 'E_HUMAN_GATE', 'E_SESSION_STOPPED', 'E_CANCELLED', 'E_NOT_FOUND']) {
    assert.equal(isReconnectableError({ code }).reconnectable, false, code);
  }
  assert.equal(isReconnectableError(null).reconnectable, false);
  assert.equal(isReconnectableError(new Error('x')).reconnectable, false);
});

test('ReconnectTracker：状态迁移、计数、canRetry 与事件有界', () => {
  const tracker = new ReconnectTracker({ policy: { ...RECONNECT_DEFAULTS, enabled: true, maxAttempts: 2, baseDelayMs: 1, jitter: false }, now: () => 1_700_000_000_000 });
  assert.equal(tracker.state, RECONNECT_STATES.DISCONNECTED);
  tracker.recordConnected();
  assert.equal(tracker.state, RECONNECT_STATES.CONNECTED);
  assert.equal(tracker.connects, 1);
  tracker.recordDisconnect(new McpRpcError('E_DISCONNECTED', 'gone'));
  assert.equal(tracker.state, RECONNECT_STATES.DISCONNECTED);
  assert.equal(tracker.lastFailure.code, 'E_DISCONNECTED');
  assert.equal(tracker.canRetry(), true);
  const first = tracker.beginAttempt(new McpRpcError('E_DISCONNECTED', 'gone'));
  assert.equal(first.attempt, 1);
  assert.equal(first.maxAttempts, 2);
  assert.equal(first.delayMs, 1);
  tracker.recordFailed(new McpRpcError('E_DISCONNECTED', 'still gone'));
  assert.equal(tracker.canRetry(), true);
  tracker.beginAttempt();
  tracker.recordFailed(new McpRpcError('E_DISCONNECTED', 'still gone'));
  assert.equal(tracker.canRetry(), false, '次数耗尽后不能再试');
  assert.equal(tracker.state, RECONNECT_STATES.FAILED);

  const disabled = new ReconnectTracker({ policy: { ...RECONNECT_DEFAULTS, enabled: false } });
  assert.equal(disabled.canRetry(), false);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.maxAttempts, 2);
  assert.equal(snapshot.failures, 2);
  assert.ok(snapshot.events.length <= 64);
  assert.equal(snapshot.events.some((event) => event.type === 'retry-denied'), true);
});

test('runReconnect：失败后成功、耗尽、禁用三种结果', async () => {
  const policy = { enabled: true, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: false };
  const tracker = new ReconnectTracker({ policy });
  const events = [];
  let attempts = 0;
  const recovered = await runReconnect(async () => {
    attempts += 1;
    if (attempts < 2) throw new McpRpcError('E_DISCONNECTED', 'not yet');
    return 'connected!';
  }, { policy, tracker, sleep: noSleep, onEvent: (event) => events.push(event) });
  assert.equal(recovered.connected, true);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.result, 'connected!');
  assert.equal(recovered.errors.length, 1);
  assert.equal(recovered.errors[0].code, 'E_DISCONNECTED');
  assert.equal(recovered.reason, RECONNECT_REASONS.NONE);
  assert.equal(events.filter((event) => event.phase === 'attempt').length, 2);

  const exhausted = await runReconnect(async () => { throw new McpRpcError('E_DISCONNECTED', 'nope'); }, { policy, sleep: noSleep });
  assert.equal(exhausted.connected, false);
  assert.equal(exhausted.errors.length, 3);
  assert.equal(exhausted.reason, RECONNECT_REASONS.ATTEMPTS_EXHAUSTED);

  const disabled = await runReconnect(async () => 'nope', { policy: { enabled: false }, sleep: noSleep });
  assert.equal(disabled.connected, false);
  assert.equal(disabled.reason, RECONNECT_REASONS.DISABLED);
  assert.equal(disabled.attempts, 0);

  await assert.rejects(() => runReconnect(null), /需要 connectFn/);
});

test('McpClient 重连：连接错误后重建传输、重新握手并重试幂等工具', async () => {
  const failing = new FakeTransport({ name: 'failing', fail: (method) => (method === 'tools/call' ? 'E_DISCONNECTED' : null) });
  const healthy = new FakeTransport({ name: 'healthy' });
  const factoryCalls = [];
  const client = new McpClient({
    transport: failing,
    transportFactory: () => {
      factoryCalls.push('created');
      return healthy;
    },
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, jitter: false },
    sleep: noSleep,
  });
  await client.connect();
  assert.equal(client.transport, failing);

  const events = [];
  const payload = await client.callTool('browser_observe', {}, { onProgress: (event) => events.push(event) });
  assert.deepEqual(payload, { ok: true, tool: 'browser_observe', transport: 'healthy' });
  assert.equal(factoryCalls.length, 1, '重连应通过工厂新建传输');
  assert.ok(healthy.requests.some((request) => request.method === 'initialize'));
  assert.ok(healthy.requests.some((request) => request.method === 'ping'));
  assert.equal(events.some((event) => event.phase === 'reconnect'), true);

  const snapshot = client.transportSnapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.reconnect.tracker.connects >= 2, true);
  assert.equal(snapshot.reconnect.tracker.totalAttempts, 1);
  assert.equal(snapshot.reconnect.lastResult.connected, true);
  client.close();
});

test('McpClient 重连：非幂等工具默认不自动重放；显式关闭保护后才重连', async () => {
  const failing = new FakeTransport({ name: 'failing', fail: (method) => (method === 'tools/call' ? 'E_DISCONNECTED' : null) });
  const guarded = new McpClient({
    transport: failing,
    transportFactory: () => new FakeTransport({ name: 'healthy-guarded' }),
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 1, jitter: false },
    sleep: noSleep,
  });
  await guarded.connect();
  // browser_evaluate 非幂等（idempotent=false），默认 retryIdempotentOnly=true → 不重连重放。
  await assert.rejects(
    () => guarded.callTool('browser_evaluate', { expression: '1+1' }, { approval: true }),
    (error) => error.code === 'E_DISCONNECTED',
  );
  assert.equal(guarded.reconnectTracker.totalAttempts, 0);
  guarded.close();

  const failedAgain = new FakeTransport({ name: 'failing-2', fail: (method) => (method === 'tools/call' ? 'E_DISCONNECTED' : null) });
  const permissive = new McpClient({
    transport: failedAgain,
    transportFactory: () => new FakeTransport({ name: 'healthy-permissive' }),
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 1, jitter: false, retryIdempotentOnly: false },
    sleep: noSleep,
  });
  await permissive.connect();
  const payload = await permissive.callTool('browser_evaluate', { expression: '1+1' }, { approval: true });
  assert.equal(payload.transport, 'healthy-permissive');
  assert.equal(permissive.reconnectTracker.totalAttempts, 1);
  permissive.close();
});

test('McpClient 重连：未开启时 ensureConnected 抛 E_DISCONNECTED；开启后重建并恢复订阅', async () => {
  const disabled = new McpClient({ transport: new FakeTransport({ name: 'x' }) });
  await disabled.connect();
  disabled.connected = false;
  disabled._transport.closed = true;
  await assert.rejects(() => disabled.ensureConnected(), (error) => error.code === 'E_DISCONNECTED' && /未开启重连/.test(error.message));
  disabled.close();

  const first = new FakeTransport({ name: 'first' });
  const second = new FakeTransport({ name: 'second' });
  let created = 0;
  const client = new McpClient({
    transport: first,
    transportFactory: () => { created += 1; return second; },
    reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 1, jitter: false, healthCheck: true, resubscribe: true },
    sleep: noSleep,
  });
  await client.connect();
  await client.subscribeResource('bridge://observation/latest');
  assert.deepEqual(client.resourceSubscriptions(), ['bridge://observation/latest']);
  // 模拟传输断开：ensureConnected 走重连，并在新连接上恢复订阅。
  client.connected = false;
  first.closed = true;
  await client.ensureConnected();
  assert.equal(created, 1);
  assert.equal(client.connected, true);
  assert.ok(second.requests.some((request) => request.method === 'resources/subscribe'
    && request.params.uri === 'bridge://observation/latest'));
  assert.deepEqual(client.resourceSubscriptions(), ['bridge://observation/latest']);
  client.close();
});

test('McpClient.syncResourceSubscriptions：按差量 subscribe/unsubscribe，幂等', async () => {
  const transport = new FakeTransport({ name: 'sync' });
  const client = new McpClient({ transport });
  await client.connect();
  const first = await client.syncResourceSubscriptions(['bridge://observation/latest', 'bridge://observation/s1']);
  assert.deepEqual(first.toSubscribe, ['bridge://observation/latest', 'bridge://observation/s1']);
  assert.deepEqual(first.toUnsubscribe, []);
  assert.deepEqual(first.subscribed, ['bridge://observation/latest', 'bridge://observation/s1']);
  assert.equal(transport.subscriptions.size, 2);

  const second = await client.syncResourceSubscriptions(['bridge://observation/s1']);
  assert.deepEqual(second.toSubscribe, []);
  assert.deepEqual(second.toUnsubscribe, ['bridge://observation/latest']);
  assert.deepEqual(second.unsubscribed, ['bridge://observation/latest']);
  assert.deepEqual(client.resourceSubscriptions(), ['bridge://observation/s1']);

  const idempotent = await client.syncResourceSubscriptions(['bridge://observation/s1']);
  assert.equal(idempotent.toSubscribe.length, 0);
  assert.equal(idempotent.toUnsubscribe.length, 0);
  assert.deepEqual(idempotent.unchanged, ['bridge://observation/s1']);

  // ignoreErrors=true：server 拒绝时收集错误而不抛。
  transport.fail = (method) => (method === 'resources/subscribe' ? 'E_ARG_RANGE' : null);
  const ignored = await client.syncResourceSubscriptions(['bridge://observation/s2'], { ignoreErrors: true });
  assert.equal(ignored.errors.length, 1);
  assert.equal(ignored.errors[0].code, 'E_ARG_RANGE');
  client.close();
});

test('McpTransport：真实 server 的 alive/snapshot/restart 生命周期', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-reconnect-'));
  const transport = new McpTransport({ env: { ...process.env, BB_HOME: home } });
  try {
    assert.equal(transport.alive, false);
    const init = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reconnect-test' } });
    assert.equal(init.serverInfo.name, 'browser-bridge');
    assert.equal(transport.alive, true);
    const snapshot = transport.snapshot();
    assert.equal(snapshot.alive, true);
    assert.equal(snapshot.closed, false);
    assert.equal(typeof snapshot.pid, 'number');
    assert.equal(snapshot.requests, 1);

    transport.restart();
    assert.equal(transport.alive, true);
    assert.equal(transport.exited, false);
    const reinit = await transport.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reconnect-test-2' } });
    assert.equal(reinit.serverInfo.name, 'browser-bridge');
    assert.equal(transport.snapshot().requests, 1, 'restart 后请求序号重置');
    transport.close();
    assert.equal(transport.alive, false);
    await assert.rejects(async () => transport.request('ping', {}), (error) => error.code === 'E_DISCONNECTED');
  } finally {
    transport.close();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

test('能力快照：reconnectSnapshot / mcpClientSnapshot 声明新增方法与默认关闭', () => {
  const reconnect = reconnectSnapshot();
  assert.equal(reconnect.supported, true);
  assert.equal(reconnect.defaults.enabled, false);
  assert.deepEqual([...reconnect.reconnectableCodes], [...RECONNECTABLE_CODES]);
  assert.equal(reconnect.states.CONNECTED, 'connected');
  assert.equal(reconnect.methods.includes('syncResourceSubscriptions'), true);

  const client = mcpClientSnapshot();
  assert.equal(client.reconnect.supported, true);
  assert.equal(client.clientMethods.includes('ensureConnected'), true);
  assert.equal(client.clientMethods.includes('transportSnapshot'), true);
  assert.ok(client.defaults.retryMaxAttempts >= 1);
});

test('createMcpClient 便捷构造：reconnect 选项透传且 connect 后 tracker 已连接', async () => {
  const transport = new FakeTransport({ name: 'factory-built' });
  const client = await createMcpClient({ transport, reconnect: true, sleep: noSleep });
  assert.equal(client.connected, true);
  assert.equal(client.reconnectPolicy.enabled, true);
  assert.equal(client.reconnectTracker.state, RECONNECT_STATES.CONNECTED);
  const snapshot = client.transportSnapshot();
  assert.equal(snapshot.serverInfo.name, 'fake-factory-built');
  assert.equal(snapshot.reconnect.policy.enabled, true);
  client.close();
});
