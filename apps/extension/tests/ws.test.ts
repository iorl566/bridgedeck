// tests/ws.test.ts —— WebSocket 接入层单测（假 WebSocket + 假时钟）。
//
// 覆盖：hello 握手、ping→pong、只读 call 超时/取消/错误映射、事件分发、cmd 分发与回包、
// 断线指数退避重连、握手超时、心跳看门狗、hello-error/auth-challenge 拒绝、坏帧忽略、
// 实例 id 复用、主动 stop 不再重连。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DaemonSocket } from '../src/daemon/ws.ts';
import type { DaemonSocketOptions } from '../src/daemon/ws.ts';
import { DaemonRpcError, isDaemonRpcError } from '../src/daemon/errors.ts';
import { isProtocolError } from '../../../packages/protocol/src/index.ts';
import type { DaemonCommandFrame } from '../src/daemon/ws.ts';
import { createFakeTransport, type FakeTransport } from './support/stub-daemon.ts';

interface Harness {
  socket: DaemonSocket;
  transport: FakeTransport;
  states: string[];
}

function createHarness(overrides: DaemonSocketOptions = {}): Harness {
  const transport = createFakeTransport();
  const states: string[] = [];
  const socket = new DaemonSocket({
    port: 52900,
    extVersion: '0.3.0',
    browser: 'edge',
    browserVersion: '150.0.0.0',
    userAgent: 'test-agent/1.0',
    webSocketFactory: (url) => transport.factory(url),
    clock: transport.clock,
    random: () => 0.5,
    handshakeTimeoutMs: 1_000,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 500,
    callTimeoutMs: 200,
    reconnect: { initialDelayMs: 100, maxDelayMs: 800, factor: 2, jitter: 0, maxAttempts: 0 },
    ...overrides,
  });
  socket.onStateChange((snapshot) => states.push(snapshot.state));
  return { socket, transport, states };
}

function openAndAck(harness: Harness, ack: Record<string, unknown> = {}): void {
  const socket = harness.transport.latest();
  socket.driveOpen();
  socket.receive({
    type: 'hello-ack',
    instanceId: 'abcd1234',
    daemonVersion: '0.3.0',
    protocol: '1.9',
    capabilities: ['observe', 'screenshot'],
    ...ack,
  });
}

function sentFrames(harness: Harness): Array<Record<string, unknown>> {
  return harness.transport.latest().frames();
}

function findFrame(harness: Harness, predicate: (frame: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  return sentFrames(harness).find(predicate);
}

test('连接 URL 带 role/v；hello 首帧字段完整；hello-ack 后进入 connected', () => {
  const harness = createHarness();
  harness.socket.start();
  assert.equal(harness.transport.sockets.length, 1);
  const url = harness.transport.latest().url;
  assert.match(url, /^ws:\/\/127\.0\.0\.1:52900\/ws\?/);
  assert.match(url, /role=extension/);
  assert.match(url, /v=0\.3\.0/);
  assert.equal(harness.socket.state, 'connecting');

  harness.transport.latest().driveOpen();
  assert.equal(harness.socket.state, 'handshaking');
  const hello = harness.transport.latest().lastFrame();
  assert.ok(hello);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.role, 'extension');
  assert.equal(hello.protocol, '1.9');
  assert.equal(hello.extVersion, '0.3.0');
  assert.equal(hello.browser, 'edge');
  assert.equal(hello.browserVersion, '150.0.0.0');
  assert.equal(hello.userAgent, 'test-agent/1.0');
  assert.deepEqual(hello.capabilities, [
    'observe',
    'frames',
    'dialog',
    'screenshot',
    'network',
    'rules',
    'video',
    'recording',
    'pairing',
    'auth-challenge',
    'unverified',
    'dom-read',
  ]);

  harness.transport.latest().receive({
    type: 'hello-ack',
    instanceId: 'abcd1234',
    daemonVersion: '0.3.0',
    protocol: '1.9',
    capabilities: ['observe'],
  });
  assert.equal(harness.socket.state, 'connected');
  assert.equal(harness.socket.isConnected(), true);
  const snapshot = harness.socket.snapshot();
  assert.equal(snapshot.instanceId, 'abcd1234');
  assert.equal(snapshot.daemonVersion, '0.3.0');
  assert.equal(snapshot.daemonProtocol, '1.9');
  assert.deepEqual(snapshot.capabilities.length, 12);
  assert.ok(snapshot.connectedAt !== null);
  assert.deepEqual(harness.states, ['idle', 'connecting', 'handshaking', 'connected']);
});

test('daemon 的 ping 回 pong，并统计 ping 次数', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  harness.transport.latest().receive({ type: 'ping' });
  const pong = harness.transport.latest().lastFrame();
  assert.deepEqual(pong, { type: 'pong' });
  harness.transport.latest().receive({ type: 'ping' });
  assert.equal(harness.socket.stats().pingsReceived, 2);
});

test('只读 call：发 {type:"call",id,method,params} 并按 call-res 解析', async () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const pending = harness.socket.call<{ service: string }>('status', { limit: 1 }, { timeoutMs: 150 });
  assert.equal(harness.socket.snapshot().pendingCalls, 1);
  const frame = findFrame(harness, (item) => item.type === 'call');
  assert.ok(frame);
  assert.equal(frame.method, 'status');
  assert.equal(frame.id, 'ws-1');
  assert.deepEqual(frame.params, { limit: 1 });

  harness.transport.latest().receive({ type: 'call-res', id: frame.id, ok: true, result: { service: 'browser-bridge' } });
  assert.deepEqual(await pending, { service: 'browser-bridge' });
  assert.equal(harness.socket.snapshot().pendingCalls, 0);
});

test('call-res 业务错误 → DaemonRpcError；协议拒绝 → ProtocolError', async () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);

  const business = harness.socket.call('session.list');
  const first = findFrame(harness, (item) => item.type === 'call');
  assert.ok(first);
  harness.transport.latest().receive({
    type: 'call-res',
    id: first.id,
    ok: false,
    error: { code: 'E_NO_SESSION', message: '没有会话', data: { sessions: 0 } },
  });
  await assert.rejects(business, (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_NO_SESSION');
    assert.deepEqual(error.data, { sessions: 0 });
    return true;
  });

  const protocol = harness.socket.call('read', {});
  const second = findFrame(harness, (item) => item.type === 'call' && item.id !== first.id);
  assert.ok(second);
  harness.transport.latest().receive({
    type: 'call-res',
    id: second.id,
    ok: false,
    error: {
      code: 'E_PROTOCOL_UNSUPPORTED',
      message: '缺少特性 read',
      data: {
        code: 'E_PROTOCOL_UNSUPPORTED',
        method: 'read',
        feature: 'read',
        features: ['read'],
        missing: [{ feature: 'read', required: '1.9', actual: '1.8' }],
        required: '1.9',
        actual: '1.8',
      },
    },
  });
  await assert.rejects(protocol, (error: unknown) => {
    assert.ok(isProtocolError(error));
    assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
    return true;
  });
});

test('call 超时 → E_TIMEOUT；迟到 call-res 被忽略', async () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const pending = harness.socket.call('status', {}, { timeoutMs: 50 });
  harness.transport.clock.advance(49);
  assert.equal(harness.socket.snapshot().pendingCalls, 1);
  harness.transport.clock.advance(1);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
  assert.equal(harness.socket.snapshot().pendingCalls, 0);
  // 迟到的回包不应抛未处理异常，也不应复活调用。
  harness.transport.latest().receive({ type: 'call-res', id: 'ws-1', ok: true, result: { late: true } });
  assert.equal(harness.socket.snapshot().pendingCalls, 0);
});

test('call 支持 AbortSignal 取消；未连接时 E_NO_DAEMON', async () => {
  const harness = createHarness();
  assert.equal(harness.socket.isConnected(), false);
  await assert.rejects(harness.socket.call('status'), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_NO_DAEMON');
    return true;
  });

  harness.socket.start();
  openAndAck(harness);
  const controller = new AbortController();
  const pending = harness.socket.call('status', {}, { signal: controller.signal, timeoutMs: 500 });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_CANCELLED');
    return true;
  });
  assert.equal(harness.socket.snapshot().pendingCalls, 0);
  assert.equal(harness.transport.clock.pending() <= 2, true, '取消后只应剩心跳等长生命周期定时器');
});

test('ensureConnected 等待握手成功；无 daemon 时超时', async () => {
  const harness = createHarness();
  const waiting = harness.socket.ensureConnected(500);
  harness.transport.latest().driveOpen();
  harness.transport.latest().receive({ type: 'hello-ack', instanceId: 'abcd1234', protocol: '1.9' });
  await waiting;
  assert.equal(harness.socket.isConnected(), true);

  const lonely = createHarness();
  const never = lonely.socket.ensureConnected(300);
  lonely.transport.clock.advance(300);
  await assert.rejects(never, (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
});

test('daemon 事件按名字分发，可取消订阅，onAny 收到全部', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const tabRemoved: unknown[] = [];
  const all: string[] = [];
  const off = harness.socket.onDaemonEvent('tab-removed', (frame) => tabRemoved.push(frame.params));
  const offAny = harness.socket.onAnyDaemonEvent((frame) => all.push(frame.event));

  harness.transport.latest().receive({ type: 'event', event: 'tab-removed', params: { tabId: 7 } });
  harness.transport.latest().receive({ type: 'event', event: 'help-resolved', params: { helpId: 'h1' } });
  assert.deepEqual(tabRemoved, [{ tabId: 7 }]);
  assert.deepEqual(all, ['tab-removed', 'help-resolved']);

  off();
  offAny();
  harness.transport.latest().receive({ type: 'event', event: 'tab-removed', params: { tabId: 8 } });
  assert.deepEqual(tabRemoved, [{ tabId: 7 }]);
  assert.deepEqual(all, ['tab-removed', 'help-resolved']);
});

test('cmd 分发：有 handler 交给 handler；无 handler 时回 E_UNKNOWN_METHOD', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const received: DaemonCommandFrame[] = [];
  harness.socket.setCommandHandler((frame) => received.push(frame));
  harness.transport.latest().receive({ type: 'cmd', id: 'cmd-1', method: 'navigate', params: { tabId: 1, url: 'https://x' } });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.method, 'navigate');
  assert.deepEqual(received[0]?.params, { tabId: 1, url: 'https://x' });
  assert.equal(harness.socket.sendCommandResult('cmd-1', { ok: true }), true);
  const resultFrame = harness.transport.latest().lastFrame();
  assert.equal(resultFrame?.type, 'res');
  assert.equal(resultFrame?.id, 'cmd-1');
  assert.equal(resultFrame?.ok, true);

  harness.socket.setCommandHandler(null);
  harness.transport.latest().receive({ type: 'cmd', id: 'cmd-2', method: 'click', params: {} });
  const rejected = harness.transport.latest().lastFrame();
  assert.equal(rejected?.type, 'res');
  assert.equal(rejected?.id, 'cmd-2');
  assert.equal(rejected?.ok, false);
  assert.equal((rejected?.error as { code?: string } | undefined)?.code, 'E_UNKNOWN_METHOD');

  harness.socket.sendCommandError('cmd-3', { code: 'E_STALE_REF', message: 'ref 失效', data: { ref: 'e1' } });
  const errorFrame = harness.transport.latest().lastFrame();
  assert.deepEqual(errorFrame, {
    type: 'res',
    id: 'cmd-3',
    ok: false,
    error: { code: 'E_STALE_REF', message: 'ref 失效', data: { ref: 'e1' } },
  });
});

test('断线按指数退避重连，成功后重置尝试计数；hello 带上上次 instanceId', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  assert.equal(harness.socket.state, 'connected');

  harness.transport.latest().driveServerClose(1006, 'network down');
  assert.equal(harness.socket.state, 'reconnecting');
  assert.equal(harness.socket.snapshot().lastClose?.code, 1006);
  assert.equal(harness.transport.sockets.length, 1);

  harness.transport.clock.advance(99);
  assert.equal(harness.transport.sockets.length, 1, '退避未到期不应重连');
  harness.transport.clock.advance(1);
  assert.equal(harness.transport.sockets.length, 2);
  assert.equal(harness.transport.latest().url, harness.transport.sockets[0]?.url);

  // 第二次握手也失败：退避翻倍（100 → 200）。
  harness.transport.latest().driveOpen();
  harness.transport.latest().driveServerClose(1006, 'still down');
  assert.equal(harness.socket.snapshot().reconnectAttempts, 2);
  harness.transport.clock.advance(199);
  assert.equal(harness.transport.sockets.length, 2);
  harness.transport.clock.advance(1);
  assert.equal(harness.transport.sockets.length, 3);

  // 第三次成功：实例 id 复用 + 尝试计数清零。
  harness.transport.latest().driveOpen();
  const hello = harness.transport.latest().lastFrame();
  assert.equal(hello?.instanceId, 'abcd1234');
  harness.transport.latest().receive({ type: 'hello-ack', instanceId: 'abcd1234', protocol: '1.9' });
  assert.equal(harness.socket.state, 'connected');
  assert.equal(harness.socket.snapshot().reconnectAttempts, 0);
});

test('握手超时 → 主动断开并按退避重连', () => {
  const harness = createHarness();
  harness.socket.start();
  harness.transport.latest().driveOpen();
  assert.equal(harness.socket.state, 'handshaking');
  harness.transport.clock.advance(1_000);
  assert.equal(harness.socket.state, 'reconnecting');
  assert.equal(harness.socket.lastError?.code, 'E_HANDSHAKE_TIMEOUT');
  assert.equal(harness.transport.latest().readyState, 3, '超时后应主动关闭该 socket');
  harness.transport.clock.advance(100);
  assert.equal(harness.transport.sockets.length, 2);
});

test('心跳看门狗：长时间没有帧则断线重连；收到帧则保活', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);

  // 先证明有帧时不会被误杀：每 200ms 收到一个 ping。
  for (let index = 0; index < 3; index += 1) {
    harness.transport.clock.advance(200);
    harness.transport.latest().receive({ type: 'ping' });
    assert.equal(harness.socket.state, 'connected');
  }

  // 然后完全静默：500ms 后看门狗触发。
  harness.transport.clock.advance(500);
  assert.equal(harness.socket.state, 'reconnecting');
  assert.equal(harness.socket.lastError?.code, 'E_HEARTBEAT_TIMEOUT');
});

test('hello-error 与 auth-challenge：进入 rejected 且不再自动重连', () => {
  const rejected = createHarness();
  rejected.socket.start();
  rejected.transport.latest().driveOpen();
  rejected.transport.latest().receive({ type: 'hello-error', code: 'E_PAIR_REQUIRED', message: '需要配对' });
  assert.equal(rejected.socket.state, 'rejected');
  assert.equal(rejected.socket.lastError?.code, 'E_PAIR_REQUIRED');
  assert.equal(rejected.transport.latest().readyState, 3);
  rejected.transport.clock.advance(10_000);
  assert.equal(rejected.transport.sockets.length, 1, 'rejected 后不应自动重连');

  const challenge = createHarness();
  challenge.socket.start();
  challenge.transport.latest().driveOpen();
  challenge.transport.latest().receive({ type: 'auth-challenge', challenge: 'c'.repeat(64), alg: 'hmac-sha256' });
  assert.equal(challenge.socket.state, 'rejected');
  assert.equal(challenge.socket.lastError?.code, 'E_WS_REJECTED');
  assert.match(challenge.socket.lastError?.message ?? '', /配对/);
});

test('坏帧被忽略，不影响已建立连接', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const socket = harness.transport.latest();
  socket.receive('not-json');
  socket.receive({ type: 'event' });
  socket.receive({ type: 'call-res', id: '', ok: true });
  socket.receive({ type: 'cmd', id: 'x', method: '' });
  socket.receive({ type: 'unknown-type', value: 1 });
  assert.equal(harness.socket.state, 'connected');
  assert.equal(harness.socket.snapshot().pendingCalls, 0);
});

test('stop() 后不再重连，未完成调用以 E_SOCKET_CLOSED 拒绝', async () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const pending = harness.socket.call('status', {}, { timeoutMs: 5_000 });
  harness.socket.stop();
  assert.equal(harness.socket.state, 'closed');
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_SOCKET_CLOSED');
    return true;
  });
  harness.transport.clock.advance(10_000);
  assert.equal(harness.transport.sockets.length, 1);
  assert.equal(harness.socket.sendJson({ type: 'pong' }), false);
  assert.equal(harness.socket.sendEvent('tab-removed', { tabId: 1 }), false);
});

test('commit-ack/commit-error 只做统计与错误记录', () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  harness.transport.latest().receive({ type: 'commit-ack', txn: 't1' });
  harness.transport.latest().receive({ type: 'commit-error', txn: 't2', code: 'E_AUTH_FAILED', message: 'commit 失败' });
  const stats = harness.socket.stats();
  assert.equal(stats.commitAcks, 1);
  assert.equal(stats.commitErrors, 1);
  assert.equal(harness.socket.lastError?.message, 'commit 失败');
});

test('start() 幂等；connectNow() 立即重建连接', () => {
  const harness = createHarness();
  harness.socket.start();
  harness.socket.start();
  assert.equal(harness.transport.sockets.length, 1);

  openAndAck(harness);
  harness.socket.connectNow();
  assert.equal(harness.transport.sockets.length, 2);
  assert.equal(harness.transport.sockets[0]?.readyState, 3);
  assert.match(harness.socket.state, /connecting|handshaking/);
});

test('DaemonRpcError 具有稳定 name/code，便于跨消息边界识别', async () => {
  const harness = createHarness();
  harness.socket.start();
  openAndAck(harness);
  const pending = harness.socket.call('status');
  const frame = findFrame(harness, (item) => item.type === 'call');
  assert.ok(frame);
  harness.transport.latest().receive({ type: 'call-res', id: frame.id, ok: false, error: { code: 'E_INTERNAL', message: 'boom' } });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.name, 'DaemonRpcError');
    assert.equal(error.code, 'E_INTERNAL');
    return true;
  });
});
