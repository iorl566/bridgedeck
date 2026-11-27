// tests/daemon-client.test.ts —— 类型化 HTTP /rpc 客户端的真实 HTTP 单测。
//
// 用 node:http 起 stub daemon（不是 mock fetch），验证：
// - 请求信封/头/token/超时字段；
// - daemon { ok:false, error } → DaemonRpcError / ProtocolError 的映射；
// - 401/404/5xx/畸形 JSON 的 HTTP 处理；
// - 客户端超时（E_TIMEOUT）、调用方取消（E_CANCELLED）、连接被拒（E_NO_DAEMON）；
// - 可注入 fetch、传输级重试、GET /health、类型化便捷方法、并发隔离。

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DaemonHttpClient } from '../src/daemon/client.ts';
import { DaemonRpcError, isDaemonRpcError } from '../src/daemon/errors.ts';
import {
  daemonHttpBaseUrl,
  daemonPortFromUrl,
  daemonWsUrl,
  normalizeDaemonPort,
} from '../src/daemon/types.ts';
import { isProtocolError, ProtocolError, protocolErrorDataOf } from '../../../packages/protocol/src/index.ts';
import { getFreePort, sendJson, startStubHttpServer } from './support/stub-daemon.ts';

test('POST /rpc 成功：信封/头/token 正确，result 原样返回', async (t) => {
  const total = await startStubHttpServer((_call, response) => {
    sendJson(response, 200, { ok: true, result: { service: 'browser-bridge', protocol: '1.9' } });
  });
  t.after(() => total.close());
  const client = new DaemonHttpClient({ baseUrl: total.baseUrl, token: 'token-abc' });
  const result = await client.call<{ service: string; protocol: string }>('status', { session: 's1' }, { timeoutMs: 3000 });
  assert.deepEqual(result, { service: 'browser-bridge', protocol: '1.9' });

  const call = total.calls[0];
  assert.ok(call, 'stub 应收到一次请求');
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/rpc');
  assert.equal(call.headers['x-bridge-token'], 'token-abc');
  assert.match(String(call.headers['content-type']), /^application\/json/);
  assert.match(String(call.headers.accept), /application\/json/);
  assert.deepEqual(call.body, { method: 'status', params: { session: 's1' }, timeoutMs: 3000 });
});

test('GET /health 不需要 token，字段被规范化', async (t) => {
  const stub = await startStubHttpServer((call, response) => {
    assert.equal(call.method, 'GET');
    assert.equal(call.url, '/health');
    sendJson(response, 200, {
      ok: true,
      service: 'browser-bridge',
      protocol: '1.9',
      version: '0.3.0',
      pid: 4242,
      uptimeMs: 1234,
      port: 52900,
      tls: false,
      bind: '127.0.0.1',
      publicUrl: null,
      browsers: 2,
      sessions: 1,
    });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  const health = await client.health({ timeoutMs: 2000 });
  assert.equal(health.ok, true);
  assert.equal(health.service, 'browser-bridge');
  assert.equal(health.protocol, '1.9');
  assert.equal(health.pid, 4242);
  assert.equal(health.browsers, 2);
  assert.equal(health.sessions, 1);
  assert.equal(health.publicUrl, null);
  assert.equal(health.tls, false);
});

test('daemon 业务错误 → DaemonRpcError（code/data/category 保留）', async (t) => {
  const stub = await startStubHttpServer((_call, response) => {
    sendJson(response, 200, {
      ok: false,
      error: { code: 'E_NO_SESSION', message: '没有可用会话', data: { sessions: 0 } },
    });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  await assert.rejects(
    client.call('session.stop'),
    (error: unknown) => {
      assert.ok(isDaemonRpcError(error));
      assert.equal(error.code, 'E_NO_SESSION');
      assert.equal(error.message, '没有可用会话');
      assert.deepEqual(error.data, { sessions: 0 });
      assert.equal(error.category, 'daemon');
      assert.equal(error.retryable, false);
      assert.equal(error.httpStatus, 200);
      assert.deepEqual(error.toPayload(), {
        code: 'E_NO_SESSION',
        message: '没有可用会话',
        data: { sessions: 0 },
      });
      return true;
    },
  );
});

test('HTTP 401 → E_AUTH；HTTP 404 → E_UNKNOWN_METHOD', async (t) => {
  const stub = await startStubHttpServer((call, response) => {
    if (call.headers['x-bridge-token'] === 'bad') {
      sendJson(response, 401, { ok: false, error: { code: 'E_AUTH', message: 'invalid token' } });
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: 'E_UNKNOWN_METHOD', message: 'unknown method' } });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl, token: 'bad' });
  await assert.rejects(client.call('status'), (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_AUTH');
    assert.equal(error.httpStatus, 401);
    assert.equal(error.category, 'auth');
    return true;
  });

  const unknown = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  await assert.rejects(unknown.call('nope.nope'), (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_UNKNOWN_METHOD');
    assert.equal(error.httpStatus, 404);
    return true;
  });
});

test('HTTP 5xx → E_DAEMON_HTTP 且标记可重试', async (t) => {
  const stub = await startStubHttpServer((_call, response) => {
    sendJson(response, 503, { ok: false, error: { code: 'E_DAEMON_HTTP', message: 'busy' } });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  await assert.rejects(client.call('status'), (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_DAEMON_HTTP');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('200 非 JSON → E_BAD_RESPONSE', async (t) => {
  const stub = await startStubHttpServer((_call, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not json');
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  await assert.rejects(client.call('status'), (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_BAD_RESPONSE');
    assert.equal(error.httpStatus, 200);
    return true;
  });
});

test('E_PROTOCOL_UNSUPPORTED + 结构化 data → ProtocolError（不是普通 DaemonRpcError）', async (t) => {
  const stub = await startStubHttpServer((_call, response) => {
    sendJson(response, 200, {
      ok: false,
      error: {
        code: 'E_PROTOCOL_UNSUPPORTED',
        message: '浏览器扩展协议版本过低，缺少特性：video（需要 1.9，当前 1.8）。',
        data: {
          code: 'E_PROTOCOL_UNSUPPORTED',
          method: 'video.start',
          feature: 'video',
          features: ['video'],
          missing: [{ feature: 'video', required: '1.9', actual: '1.8' }],
          required: '1.9',
          actual: '1.8',
        },
      },
    });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  await assert.rejects(client.call('video.start'), (error: unknown) => {
    assert.ok(isProtocolError(error));
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(error.data.method, 'video.start');
    assert.equal(error.data.feature, 'video');
    assert.deepEqual(error.data.missing, [{ feature: 'video', required: '1.9', actual: '1.8' }]);
    assert.equal(error.data.required, '1.9');
    assert.equal(error.data.actual, '1.8');
    assert.ok(protocolErrorDataOf(error), 'protocolErrorDataOf 应识别该错误');
    return true;
  });
  assert.equal(stub.calls.length, 1, '协议拒绝不应被当作可重试错误');
});

test('客户端超时 → E_TIMEOUT（daemon 迟到响应被忽略）', async (t) => {
  const stub = await startStubHttpServer(async (_call, response) => {
    await delay(400);
    try {
      sendJson(response, 200, { ok: true, result: { late: true } });
    } catch {
      // 客户端已中止；忽略
    }
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl, defaultTimeoutMs: 80 });
  const startedAt = Date.now();
  await assert.rejects(client.call('status'), (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_TIMEOUT');
    assert.equal(error.category, 'transport');
    return true;
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 350, `超时应远早于 daemon 的 400ms 响应（实际 ${elapsed}ms）`);
});

test('调用方 AbortSignal 取消 → E_CANCELLED（与 E_TIMEOUT 区分）', async (t) => {
  const stub = await startStubHttpServer(async (_call, response) => {
    await delay(300);
    try {
      sendJson(response, 200, { ok: true, result: {} });
    } catch {
      // 客户端已中止
    }
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl, defaultTimeoutMs: 5000 });
  const controller = new AbortController();
  const pending = client.call('status', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DaemonRpcError);
    assert.equal(error.code, 'E_CANCELLED');
    assert.equal(error.category, 'transport');
    return true;
  });
});

test('连接被拒 → E_NO_DAEMON 且可重试', async () => {
  const port = await getFreePort();
  const client = new DaemonHttpClient({ baseUrl: `http://127.0.0.1:${port}`, defaultTimeoutMs: 1000 });
  await assert.rejects(client.call('status'), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_NO_DAEMON');
    assert.equal(error.category, 'transport');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('传输级重试：前两次 503，第三次成功；业务错误不重试', async (t) => {
  let attempts = 0;
  const stub = await startStubHttpServer((_call, response) => {
    attempts += 1;
    if (attempts < 3) {
      sendJson(response, 503, { ok: false, error: { code: 'E_DAEMON_HTTP', message: 'busy' } });
      return;
    }
    sendJson(response, 200, { ok: true, result: { attempt: attempts } });
  });
  t.after(() => stub.close());
  const sleeps: number[] = [];
  const client = new DaemonHttpClient({
    baseUrl: stub.baseUrl,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 4, jitter: 0 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await client.call<{ attempt: number }>('status');
  assert.equal(result.attempt, 3);
  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 1 && ms <= 4));

  let businessAttempts = 0;
  const failing = await startStubHttpServer((_call, response) => {
    businessAttempts += 1;
    sendJson(response, 200, { ok: false, error: { code: 'E_BAD_ARG', message: 'bad' } });
  });
  t.after(() => failing.close());
  const retryingClient = new DaemonHttpClient({
    baseUrl: failing.baseUrl,
    retry: { attempts: 3, baseDelayMs: 1, jitter: 0 },
    sleep: async () => undefined,
  });
  await assert.rejects(retryingClient.call('observe'), /bad/);
  assert.equal(businessAttempts, 1, '业务错误不应触发传输重试');
});

test('fetch 可注入，且请求 URL/头/token 与注入点一致', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new DaemonHttpClient({
    baseUrl: 'http://127.0.0.1:59999',
    token: 'injected-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { injected: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await client.call<{ injected: boolean }>('status');
  assert.deepEqual(result, { injected: true });
  assert.equal(seen.length, 1);
  const request = seen[0];
  assert.ok(request);
  assert.equal(request.url, 'http://127.0.0.1:59999/rpc');
  assert.equal(request.init?.method, 'POST');
  const headers = request.init?.headers as Record<string, string>;
  assert.equal(headers['x-bridge-token'], 'injected-token');
  assert.equal(headers['content-type'], 'application/json');
});

test('类型化便捷方法 status/sessionList/browsers/auditList 走对应方法名', async (t) => {
  const stub = await startStubHttpServer((call, response) => {
    const body = call.body as { method?: string; params?: Record<string, unknown> };
    switch (body.method) {
      case 'status':
        sendJson(response, 200, {
          ok: true,
          result: {
            service: 'browser-bridge',
            version: '0.3.0',
            protocol: '1.9',
            pid: 1,
            port: 52900,
            uptimeMs: 1,
            browsers: [],
            sessions: [],
            inflight: [],
            queues: {},
            auth: {},
            compatibility: {},
          },
        });
        return;
      case 'session.list':
        sendJson(response, 200, { ok: true, result: { sessions: [{ sessionId: 's1' }] } });
        return;
      case 'browsers':
        sendJson(response, 200, { ok: true, result: { browsers: [{ instanceId: 'i1' }] } });
        return;
      case 'audit.list':
        sendJson(response, 200, { ok: true, result: { dir: 'x', total: 0, entries: [] } });
        return;
      default:
        sendJson(response, 404, { ok: false, error: { code: 'E_UNKNOWN_METHOD', message: String(body.method) } });
    }
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl });
  const status = await client.status();
  assert.equal(status.service, 'browser-bridge');
  assert.equal(status.protocol, '1.9');
  const sessions = await client.sessionList();
  assert.equal(sessions.sessions.length, 1);
  const browsers = await client.browsers();
  assert.equal(browsers.browsers.length, 1);
  const audit = await client.auditList({ limit: 10 });
  assert.equal(audit.total, 0);
  assert.deepEqual(
    stub.calls.map((call) => (call.body as { method: string }).method),
    ['status', 'session.list', 'browsers', 'audit.list'],
  );
});

test('并发调用互不串扰（不同方法/不同结果）', async (t) => {
  const stub = await startStubHttpServer(async (call, response) => {
    const body = call.body as { method: string; params?: Record<string, unknown> };
    const id = String(body.params?.id ?? '');
    await delay(id === 'slow' ? 60 : 10);
    sendJson(response, 200, { ok: true, result: { method: body.method, id } });
  });
  t.after(() => stub.close());
  const client = new DaemonHttpClient({ baseUrl: stub.baseUrl, defaultTimeoutMs: 2000 });
  const [slow, fast] = await Promise.all([
    client.call<{ id: string }>('observe', { id: 'slow' }),
    client.call<{ id: string }>('status', { id: 'fast' }),
  ]);
  assert.equal(slow.id, 'slow');
  assert.equal(fast.id, 'fast');
});

test('buildRequest/describe/方法名校验', () => {
  const client = new DaemonHttpClient({ baseUrl: 'http://127.0.0.1:52900/' });
  assert.equal(client.rpcUrl, 'http://127.0.0.1:52900/rpc');
  assert.deepEqual(client.buildRequest('status', undefined, 5000), {
    method: 'status',
    params: {},
    timeoutMs: 5000,
  });
  assert.deepEqual(client.buildRequest('browsers'), { method: 'browsers', params: {} });
  assert.throws(
    () => client.buildRequest('  '),
    (error: unknown) => isDaemonRpcError(error) && error.code === 'E_CLIENT_BAD_METHOD',
  );
  assert.throws(
    () => client.buildRequest('status', [1, 2] as unknown as Record<string, unknown>),
    (error: unknown) => isDaemonRpcError(error) && error.code === 'E_CLIENT_BAD_REQUEST',
  );
  const description = client.describe();
  assert.equal(description.tokenPresent, false);
  assert.equal(description.attempts, 1);
});

test('端点/URL 构造与端口规范化', () => {
  assert.equal(daemonHttpBaseUrl({ port: 52900 }), 'http://127.0.0.1:52900');
  assert.equal(daemonHttpBaseUrl({ port: 52900, secure: true }), 'https://127.0.0.1:52900');
  assert.equal(daemonHttpBaseUrl({ baseUrl: 'https://example.test/api/' }), 'https://example.test/api');
  assert.throws(() => daemonHttpBaseUrl({ baseUrl: 'ftp://example.test' }), TypeError);

  const ws = daemonWsUrl({ port: 52901, extVersion: '0.3.0' });
  assert.equal(ws, 'ws://127.0.0.1:52901/ws?role=extension&v=0.3.0');
  const secureWs = daemonWsUrl({ port: 52901, secure: true, extVersion: '0.3.0' });
  assert.equal(secureWs, 'wss://127.0.0.1:52901/ws?role=extension&v=0.3.0');
  const remote = daemonWsUrl({ url: 'wss://bridge.example.test/ws', extVersion: '0.3.0' });
  assert.equal(remote, 'wss://bridge.example.test/ws?role=extension&v=0.3.0');

  assert.equal(normalizeDaemonPort(0), 52900);
  assert.equal(normalizeDaemonPort(70000), 52900);
  assert.equal(normalizeDaemonPort('52901'), 52901);
  assert.equal(daemonPortFromUrl('ws://127.0.0.1:52903/ws'), 52903);
  assert.equal(daemonPortFromUrl('ws://127.0.0.1/ws'), 80);
});
