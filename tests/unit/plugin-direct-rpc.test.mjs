// 直连 daemon RPC 协议：信封/鉴权头/超时/连接失败，以及“直连→CLI 回退”边界。
// 用本机临时 HTTP 服务器模拟 daemon（回环，不联网），daemon.json 指向临时 BB_HOME。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { daemonRpc, DaemonRpcError, defaultHome, readDaemonInfo } from '../../dsh-plugin/lib/daemon-rpc.mjs';
import { canFallbackToCli, FALLBACK_CODES } from '../../dsh-plugin/lib/error-recovery.mjs';
import { createFakeAdapter } from '../../dsh-plugin/lib/fake-adapter.mjs';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-direct-rpc-'));
}

function writeDaemonInfo(home, info) {
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify(info), 'utf8');
}

/**
 * 启动一个可脚本化 daemon。
 * responder({ path, body, headers }) → { status, payload, delayMs }
 */
async function startDaemon(responder) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      const record = { path: req.url, method: req.method, headers: req.headers, body };
      requests.push(record);
      const reply = responder(record) || {};
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
        res.end(typeof reply.payload === 'string' ? reply.payload : JSON.stringify(reply.payload));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    requests,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withDaemon(responder, fn) {
  const home = tempHome();
  const daemon = await startDaemon(responder);
  writeDaemonInfo(home, { port: daemon.port, token: 'tok-123' });
  try {
    await fn({ home, daemon });
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('daemonRpc：POST /rpc + token 头 + 方法/参数信封，返回 result', async () => {
  await withDaemon(() => ({ payload: { ok: true, result: { port: 4242, sessions: [{ sessionId: 's1' }] } } }), async ({ home, daemon }) => {
    const result = await daemonRpc('status', { probe: true }, { home, timeoutMs: 5000 });
    assert.deepEqual(result, { port: 4242, sessions: [{ sessionId: 's1' }] });
    assert.equal(daemon.requests.length, 1);
    const request = daemon.requests[0];
    assert.equal(request.path, '/rpc');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-bridge-token'], 'tok-123');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.body.method, 'status');
    assert.deepEqual(request.body.params, { probe: true });
    assert.equal(request.body.timeoutMs, 5000);
  });
});

test('daemonRpc：错误信封映射成 DaemonRpcError（保留 code/data）', async () => {
  await withDaemon(() => ({
    payload: { ok: false, error: { code: 'E_NO_SESSION', message: '没有活动会话', data: { hint: 'start' } } },
  }), async ({ home }) => {
    await assert.rejects(
      () => daemonRpc('observe', {}, { home }),
      (error) => error instanceof DaemonRpcError
        && error.code === 'E_NO_SESSION'
        && /没有活动会话/.test(error.message)
        && error.data.hint === 'start',
    );
  });
});

test('daemonRpc：非 JSON 响应报 E_DAEMON（不把坏响应当业务错误）', async () => {
  await withDaemon(() => ({ payload: 'this is not json' }), async ({ home }) => {
    await assert.rejects(
      () => daemonRpc('status', {}, { home }),
      (error) => error instanceof DaemonRpcError && error.code === 'E_DAEMON' && /非 JSON/.test(error.message),
    );
  });
});

test('daemonRpc：daemon 假死时按 timeoutMs 报 E_TIMEOUT（不挂住调用方）', async () => {
  await withDaemon(() => ({ payload: { ok: true, result: {} }, delayMs: 1500 }), async ({ home }) => {
    const startedAt = Date.now();
    await assert.rejects(
      () => daemonRpc('observe', {}, { home, timeoutMs: 1000 }),
      (error) => error instanceof DaemonRpcError && error.code === 'E_TIMEOUT',
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 900 && elapsed < 1450, '超时应在约 1s 触发，实际 ' + elapsed + 'ms');
  });
});

test('daemonRpc：连接被拒绝 / daemon.json 缺失 / 内容非法都报 E_DAEMON', async () => {
  const home = tempHome();
  try {
    // 连接拒绝：daemon.json 指向一个已关闭端口。
    const daemon = await startDaemon(() => ({ payload: { ok: true, result: {} } }));
    const port = daemon.port;
    await daemon.close();
    writeDaemonInfo(home, { port, token: 'tok' });
    await assert.rejects(
      () => daemonRpc('status', {}, { home, timeoutMs: 1000 }),
      (error) => error.code === 'E_DAEMON' && /连接 daemon 失败/.test(error.message),
    );
    // 文件缺失
    fs.rmSync(path.join(home, 'daemon.json'), { force: true });
    await assert.rejects(() => daemonRpc('status', {}, { home }), (error) => error.code === 'E_DAEMON' && /daemon\.json/.test(error.message));
    // 内容非法：port 不是整数 / token 不是字符串
    writeDaemonInfo(home, { port: 'not-int', token: 42 });
    assert.equal(readDaemonInfo(home), null);
    await assert.rejects(() => daemonRpc('status', {}, { home }), (error) => error.code === 'E_DAEMON');
    // 损坏 JSON
    fs.writeFileSync(path.join(home, 'daemon.json'), '{bad json', 'utf8');
    assert.equal(readDaemonInfo(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('BB_PLUGIN_DIRECT_RPC=0 是受支持的“关闭直连”边界（E_DIRECT_RPC_DISABLED）', async () => {
  const saved = process.env.BB_PLUGIN_DIRECT_RPC;
  const home = tempHome();
  const daemon = await startDaemon(() => ({ payload: { ok: true, result: {} } }));
  writeDaemonInfo(home, { port: daemon.port, token: 'tok' });
  try {
    process.env.BB_PLUGIN_DIRECT_RPC = '0';
    await assert.rejects(
      () => daemonRpc('status', {}, { home }),
      (error) => error instanceof DaemonRpcError && error.code === 'E_DIRECT_RPC_DISABLED',
    );
    assert.equal(canFallbackToCli({ code: 'E_DIRECT_RPC_DISABLED' }), true);
    assert.equal(daemon.requests.length, 0, '关闭直连后不应发出 RPC');
  } finally {
    if (saved === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = saved;
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('BB_HOME 决定默认 home；daemon 读不到时 defaultHome 指向它', () => {
  const saved = process.env.BB_HOME;
  const home = tempHome();
  try {
    process.env.BB_HOME = home;
    assert.equal(defaultHome(), path.resolve(home));
    writeDaemonInfo(home, { port: 4242, token: 'tok' });
    assert.deepEqual(readDaemonInfo(), { port: 4242, token: 'tok' });
  } finally {
    if (saved === undefined) delete process.env.BB_HOME;
    else process.env.BB_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('回退边界：只有 E_DAEMON / E_DIRECT_RPC_DISABLED 允许回退 CLI，动作错误不回退', async () => {
  assert.deepEqual(FALLBACK_CODES, ['E_DAEMON', 'E_DIRECT_RPC_DISABLED']);
  const cases = [
    { code: 'E_DAEMON', expectFallback: true },
    { code: 'E_DIRECT_RPC_DISABLED', expectFallback: true },
    { code: 'E_TIMEOUT', expectFallback: false },
    { code: 'E_FORBIDDEN', expectFallback: false },
    { code: 'E_STALE_REF', expectFallback: false },
  ];
  for (const item of cases) {
    const cliCalls = [];
    const run = async (argv) => {
      cliCalls.push(argv);
      return { url: 'https://cli/', title: 'cli', refs: 0, observation: '- cli' };
    };
    const adapter = createFakeAdapter({ handlers: { observe: { error: { code: item.code, message: item.code } } } });
    const observe = buildToolSpecs(run, { rpc: adapter.call }).find((spec) => spec.name === 'browser_observe');
    if (item.expectFallback) {
      const result = await observe.execute({ sessionId: 's1' }, {});
      assert.equal(result.url, 'https://cli/', item.code + ' 应回退 CLI');
      assert.equal(cliCalls.length, 1);
    } else {
      await assert.rejects(
        () => observe.execute({ sessionId: 's1' }, {}),
        (error) => error.code === item.code,
        item.code + ' 不应回退 CLI',
      );
      assert.equal(cliCalls.length, 0, item.code + ' 不得触发 CLI 回退');
    }
    assert.equal(canFallbackToCli({ code: item.code }), item.expectFallback);
  }
});

test('回退只发生一次：直连失败后 CLI 再失败就上抛，不循环', async () => {
  const cliCalls = [];
  const run = async (argv) => {
    cliCalls.push(argv);
    throw Object.assign(new Error('cli 也失败'), { code: 'E_DAEMON' });
  };
  const offline = createFakeAdapter({ unavailable: true });
  const status = buildToolSpecs(run, { rpc: offline.call }).find((spec) => spec.name === 'browser_status');
  await assert.rejects(
    () => status.execute({}, {}),
    (error) => error.code === 'E_DAEMON',
  );
  assert.equal(cliCalls.length, 1, 'CLI 只应尝试一次');
  assert.equal(offline.calls.length, 1, '直连只应尝试一次');
});
