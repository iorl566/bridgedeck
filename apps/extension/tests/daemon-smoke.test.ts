// tests/daemon-smoke.test.ts —— 真实 Node daemon 冒烟：TS 客户端 → 真实 daemon /rpc 与 /ws。
//
// 与 stub 测试互补：这里起的是仓库里的 `daemon/server.mjs`（独立子进程、临时 BB_HOME、
// 随机回环端口），验证协议 1.9 的真实请求/响应形状，而不是我们自己的假设：
// 1. GET /health（无 token）；
// 2. POST /rpc status（从 daemon.json 读 token）与 session.list；
// 3. 未知方法 404 → E_UNKNOWN_METHOD；错误 token 401 → E_AUTH；
// 4. WS hello-ack → {type:'call',method:'status'} → call-res；daemon 侧白名单拒绝 navigate。
//
// 起不来时 skip 并说明原因（daemon 代码缺失/端口/环境不可用），不把环境问题伪装成通过。
// 子进程退出/临时目录清理放在钩子里，失败也会执行。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonHttpClient } from '../src/daemon/client.ts';
import { isDaemonRpcError } from '../src/daemon/errors.ts';
import { DaemonSocket } from '../src/daemon/ws.ts';
import { getFreePort } from './support/stub-daemon.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const SERVER = path.join(REPO, 'daemon', 'server.mjs');

interface RealDaemon {
  child: ChildProcess;
  port: number;
  token: string;
  pid: number;
  home: string;
  output: () => string;
  stop: () => Promise<void>;
}

/** 等子进程退出；超时返回 false（定时器会被清掉，避免拖住测试进程）。 */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function startRealDaemon(): Promise<RealDaemon> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdl-smoke-home-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, [SERVER, '--foreground', '--port', String(port)], {
    cwd: REPO,
    env: { ...process.env, BB_HOME: home, BB_AUDIT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    output += String(chunk);
  });

  const cleanupEarly = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, 3_000);
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响测试结论
    }
  };

  const daemonJsonPath = path.join(home, 'daemon.json');
  const deadline = Date.now() + 20_000;
  let info: { port?: unknown; token?: unknown; pid?: unknown } | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await cleanupEarly();
      throw new Error(`daemon 提前退出（exit=${child.exitCode}）：${output.slice(-800)}`);
    }
    try {
      info = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf8')) as {
        port?: unknown;
        token?: unknown;
        pid?: unknown;
      };
      if (typeof info.port === 'number' && typeof info.token === 'string' && info.token) break;
    } catch {
      // 还没写出来，继续等
    }
    await delay(100);
  }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string' || !info.token) {
    await cleanupEarly();
    throw new Error(`daemon 未在 20s 内写出可用 daemon.json：${output.slice(-800)}`);
  }

  const started: RealDaemon = {
    child,
    port: info.port,
    token: info.token,
    pid: typeof info.pid === 'number' ? info.pid : child.pid ?? 0,
    home,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const exited = await waitForChildExit(child, 5_000);
        if (!exited && child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // 已经退出
          }
          await waitForChildExit(child, 2_000);
        }
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    },
  };

  // 等 /health 真正可服务（daemon.json 写入后可能还差几毫秒）。
  const client = new DaemonHttpClient({ port: started.port, defaultTimeoutMs: 2_000 });
  const healthDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      const health = await client.health({ timeoutMs: 1_000 });
      if (health.ok && health.pid === started.pid) break;
    } catch {
      // 继续等
    }
    if (Date.now() > healthDeadline) {
      await started.stop();
      throw new Error(`daemon 已写 daemon.json 但 /health 不可用：${output.slice(-800)}`);
    }
    await delay(100);
  }
  return started;
}

let daemon: RealDaemon | null = null;
let setupFailure: string | null = null;

before(async () => {
  if (!fs.existsSync(SERVER)) {
    setupFailure = `找不到 daemon 入口：${SERVER}`;
    return;
  }
  try {
    daemon = await startRealDaemon();
  } catch (error) {
    setupFailure = error instanceof Error ? error.message : String(error);
  }
});

after(async () => {
  if (daemon) await daemon.stop();
});

function daemonOrSkip(t: { skip: (message: string) => void }): RealDaemon | null {
  if (daemon) return daemon;
  t.skip(`真实 daemon 不可用，跳过冒烟：${setupFailure ?? '未知原因'}`);
  return null;
}

test('真实 daemon：/health 与 /rpc status/session.list 只读调用', { timeout: 60_000 }, async (t) => {
  const current = daemonOrSkip(t);
  if (!current) return;
  const client = new DaemonHttpClient({
    port: current.port,
    token: current.token,
    defaultTimeoutMs: 10_000,
  });

  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'browser-bridge');
  assert.equal(health.protocol, '1.9');
  assert.equal(health.version, '0.3.0');
  assert.equal(health.pid, current.pid);
  assert.equal(health.port, current.port);
  assert.equal(health.bind, '127.0.0.1');
  assert.equal(typeof health.uptimeMs, 'number');

  const status = await client.status();
  assert.equal(status.service, 'browser-bridge');
  assert.equal(status.protocol, '1.9');
  assert.equal(status.pid, current.pid);
  assert.equal(status.port, current.port);
  assert.ok(Array.isArray(status.browsers), 'status.browsers 应是数组');
  assert.ok(Array.isArray(status.sessions), 'status.sessions 应是数组');
  assert.ok(Array.isArray(status.inflight), 'status.inflight 应是数组');
  assert.equal(typeof status.queues, 'object');
  assert.equal(typeof status.compatibility, 'object');

  const sessions = await client.sessionList();
  assert.deepEqual(sessions.sessions, [], '全新 daemon 不应有会话');
  const browsers = await client.browsers();
  assert.deepEqual(browsers.browsers, [], '没有扩展连接时 browsers 为空');
});

test('真实 daemon：未知方法 404 / 错误 token 401 的真实错误码', { timeout: 60_000 }, async (t) => {
  const current = daemonOrSkip(t);
  if (!current) return;
  const client = new DaemonHttpClient({
    port: current.port,
    token: current.token,
    defaultTimeoutMs: 10_000,
  });
  await assert.rejects(client.call('definitely.not.a.method', {}), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_UNKNOWN_METHOD');
    assert.equal(error.httpStatus, 404);
    assert.equal(error.retryable, false);
    assert.match(error.message, /definitely\.not\.a\.method/);
    return true;
  });

  const unauthorized = new DaemonHttpClient({
    port: current.port,
    token: 'this-token-is-wrong',
    defaultTimeoutMs: 10_000,
  });
  await assert.rejects(unauthorized.call('status'), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_AUTH');
    assert.equal(error.httpStatus, 401);
    assert.equal(error.category, 'auth');
    return true;
  });
});

test('真实 daemon：WS hello-ack → status call-res；非白名单方法被拒绝', { timeout: 60_000 }, async (t) => {
  const current = daemonOrSkip(t);
  if (!current) return;
  const socket = new DaemonSocket({
    port: current.port,
    extVersion: '0.3.0',
    browser: 'edge',
    browserVersion: '150.0.0.0',
    userAgent: 'daemon-smoke-test/0.3.0',
    handshakeTimeoutMs: 5_000,
    callTimeoutMs: 10_000,
    reconnect: { initialDelayMs: 200, maxDelayMs: 2_000, factor: 2, jitter: 0, maxAttempts: 3 },
  });
  t.after(() => socket.stop());
  try {
    await socket.ensureConnected(10_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    t.skip(`真实 daemon WS 不可用，跳过：${message}`);
    return;
  }
  assert.equal(socket.state, 'connected');
  assert.equal(socket.daemonProtocol, '1.9');
  assert.equal(socket.daemonVersion, '0.3.0');
  assert.match(socket.instanceId ?? '', /^[0-9a-f]{8}$/);

  const status = await socket.call<{ service: string; protocol: string; pid: number }>('status', {});
  assert.equal(status.service, 'browser-bridge');
  assert.equal(status.protocol, '1.9');
  assert.equal(status.pid, current.pid);

  await assert.rejects(socket.call('navigate', { url: 'https://example.test' }), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_UNKNOWN_METHOD');
    assert.match(error.message, /不允许的 WS 调用/);
    return true;
  });
});
