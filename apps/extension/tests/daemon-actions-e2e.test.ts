// tests/daemon-actions-e2e.test.ts —— 真实 daemon 冒烟：TS 命令路由 + 动作面跑通 /rpc 链路。
//
// 与 daemon-smoke.test.ts 的分工：那个文件验证传输层（HTTP/WS 形状）；这里把**扩展侧
// 真实运行时**（CommandRouter + ActionRegistry + RefRegistry）接到真实 daemon 的 WS 上，
// 用假 browser API / 假内容脚本替代浏览器，验证：
//   session.start（daemon 发 window.newAgent）→ navigate → observe（建 ref 表）→
//   fill/read/click（refKey 校验收据）→ session.stop 全链路。
// 这就是 tools/e2e.mjs 第 1-9 项在 daemon 协议层的等价物；真实浏览器/CDP/原生输入
// 不在本进程内（由 E2E 覆盖），因此这里不声称验证了原生输入。
//
// 起不来时 skip 并说明原因（daemon 代码缺失/端口/环境不可用），不把环境问题伪装成通过。

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonHttpClient } from '../src/daemon/client.ts';
import { DaemonSocket } from '../src/daemon/ws.ts';
import { getFreePort } from './support/stub-daemon.ts';
import { ActionRegistry } from '../src/actions/registry.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { CommandRouter } from '../src/runtime/router.ts';
import { createRuntimeCommands } from '../src/runtime/commands.ts';
import { StubContentTransport } from './support/stub-content.ts';
import { FakeBrowserApi } from './support/fake-browser.ts';
import type { ContentObserveResult } from '../src/content/protocol.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..', '..');
const SERVER = path.join(REPO, 'daemon', 'server.mjs');

interface RealDaemon {
  child: ChildProcess;
  port: number;
  token: string;
  output: () => string;
  stop: () => Promise<void>;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve(true);
    };
    child.once('exit', finish);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
  });
}

async function startRealDaemon(): Promise<RealDaemon> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bbdl-actions-home-'));
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

  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, 3_000);
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响结论
    }
  };

  const daemonJson = path.join(home, 'daemon.json');
  const deadline = Date.now() + 20_000;
  let info: { port?: unknown; token?: unknown } | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await cleanup();
      throw new Error('daemon 提前退出：' + output.slice(-500));
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(daemonJson, 'utf8')) as { port?: unknown; token?: unknown };
      if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && parsed.token) {
        info = parsed;
        break;
      }
    } catch {
      // 还没写出来
    }
    await delay(100);
  }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') {
    await cleanup();
    throw new Error('daemon 未在 20s 内写出可用 daemon.json：' + output.slice(-500));
  }
  const started: RealDaemon = {
    child,
    port: info.port,
    token: info.token,
    output: () => output,
    stop: cleanup,
  };
  const client = new DaemonHttpClient({ port: started.port, defaultTimeoutMs: 2_000 });
  const healthDeadline = Date.now() + 10_000;
  for (;;) {
    try {
      const health = await client.health({ timeoutMs: 1_000 });
      if (health.ok) return started;
    } catch {
      // 继续等
    }
    if (Date.now() > healthDeadline) {
      await started.stop();
      throw new Error('daemon /health 不可用：' + output.slice(-500));
    }
    await delay(100);
  }
}

const OBSERVATION_NODES: ContentObserveResult['nodes'] = [
  { ref: '@e1', role: 'textbox', name: '关键词', tag: 'input', id: 'kw' },
  { ref: '@e2', role: 'button', name: '提交查询', tag: 'button', id: 'submit-btn' },
];

let daemon: RealDaemon | null = null;
let setupFailure: string | null = null;

before(async () => {
  if (!fs.existsSync(SERVER)) {
    setupFailure = '找不到 daemon 入口：' + SERVER;
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
  t.skip('真实 daemon 不可用，跳过动作链路冒烟：' + (setupFailure ?? '未知原因'));
  return null;
}

test('真实 daemon：session.start → navigate → observe → fill/read/click → session.stop', { timeout: 90_000 }, async (t) => {
  const current = daemonOrSkip(t);
  if (!current) return;

  // ---- 扩展侧真实运行时 -----------------------------------------------------
  const api = new FakeBrowserApi();
  const content = new StubContentTransport();
  const refs = new RefRegistry();
  let revision = 0;
  content.set('observe', () => {
    revision += 1;
    const result: ContentObserveResult = {
      url: 'http://127.0.0.1/test.html',
      title: 'E2E 夹具页',
      observation: '- textbox "关键词" [@e1]\n- button "提交查询" [@e2]',
      refs: OBSERVATION_NODES.length,
      revision,
      documentId: 'doc-live',
      nodes: OBSERVATION_NODES,
    };
    return { ok: true, result };
  });
  content.set('fill', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'input',
      expected_value: String(request.params.value ?? ''),
      actual_value: String(request.params.value ?? ''),
      matches: true,
      cleared: true,
      via: 'content-script',
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('click', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'button',
      x: 90,
      y: 200,
      via: 'content-script',
      hit: 'self',
      isConnected: true,
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('read', () => ({
    ok: true,
    result: {
      fields: [{ key: 'value', tag: 'input', type: 'text', text: null, value: 'hello bridge', checked: null }],
      ref: null,
      selector: '#kw',
      count: 1,
    },
  }));

  const actions = new ActionRegistry({ content, refs, random: () => 0 });
  const router = new CommandRouter();
  router.registerAll(createRuntimeCommands({ api }));
  for (const spec of actions.specsList()) {
    router.register(
      spec.method,
      (context) => actions.dispatch(spec.method, context.params, { timeoutMs: context.timeoutMs, requestId: context.requestId }),
      { description: spec.description },
    );
  }

  const socket = new DaemonSocket({
    port: current.port,
    extVersion: '0.3.0',
    browser: 'edge',
    browserVersion: '150.0.0.0',
    userAgent: 'actions-e2e/0.3.0',
    handshakeTimeoutMs: 5_000,
    callTimeoutMs: 20_000,
    reconnect: { initialDelayMs: 200, maxDelayMs: 2_000, factor: 2, jitter: 0, maxAttempts: 3 },
  });
  socket.setCommandHandler((frame) => {
    void router.respond(frame, socket);
  });
  t.after(() => socket.stop());

  try {
    await socket.ensureConnected(10_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    t.skip('真实 daemon WS 不可用，跳过：' + message);
    return;
  }
  assert.equal(socket.state, 'connected');

  const client = new DaemonHttpClient({ port: current.port, token: current.token, defaultTimeoutMs: 30_000 });

  // daemon 已把这条 WS 当成一个浏览器实例。
  const browsers = await client.browsers();
  assert.equal(browsers.browsers.length, 1, 'daemon 应看到一个浏览器实例');

  // 1) session.start：daemon 会发 window.newAgent（+ dialog.arm/control-hint，未迁移被忽略）。
  const started = await client.call<{ sessionId: string; tabId: number; windowId: number }>('session.start', { noFocus: true });
  assert.match(started.sessionId, /^[a-z]{4}$/);
  assert.ok(Number.isInteger(started.tabId) && started.tabId > 0, 'session.start 需要 tabId');
  assert.ok(Number.isInteger(started.windowId) && started.windowId > 0, 'session.start 需要 windowId');

  const status = await client.status();
  assert.ok(status.sessions.some((item) => {
    const row = item as { sessionId?: string; phase?: string };
    return row.sessionId === started.sessionId && row.phase === 'active';
  }), 'status 里应有 active 会话');

  // 2) navigate：daemon 透传 tabId，扩展命令处理器更新假 tab。
  const navigated = await client.call<{ url: string }>('navigate', { session: started.sessionId, url: 'http://127.0.0.1/test.html' });
  assert.equal(navigated.url, 'http://127.0.0.1/test.html');
  assert.equal(api.findTab(started.tabId)?.url, 'http://127.0.0.1/test.html');

  // 3) observe：内容脚本结果 → ref 表 + observationId/refDetails。
  const observed = await client.call<{
    url: string;
    refs: number;
    revision: number;
    observationId: string;
    observation: string;
    refDetails: Array<{ ref: string; stableRef: string }>;
    refsRegistered: number;
  }>('observe', { session: started.sessionId });
  assert.equal(observed.refs, 2);
  assert.match(observed.observationId, /^ob_/);
  assert.equal(observed.refDetails.length, 2);
  assert.match(observed.refDetails[0]?.stableRef ?? '', /^s-/);
  assert.equal(observed.refsRegistered, 2);
  assert.equal(refs.size(started.tabId), 2);
  assert.match(observed.observation, /- textbox "关键词" \[@e1\]/);

  // 4) fill：daemon → cmd fill（带 refKey）→ 内容脚本回包 → matches 字段。
  const filled = await client.call<{
    expected_value: string;
    actual_value: string;
    matches: boolean;
    via: string;
    effectState: string;
  }>('fill', { session: started.sessionId, ref: '@e1', value: 'hello bridge' });
  assert.equal(filled.expected_value, 'hello bridge');
  assert.equal(filled.actual_value, 'hello bridge');
  assert.equal(filled.matches, true);
  assert.equal(filled.via, 'content-script');
  assert.equal(filled.effectState, 'committed', 'daemon 侧应为动作用例标注 committed');
  const fillCall = content.callsFor('fill')[0];
  assert.ok(fillCall);
  const refKey = fillCall.request.params.refKey as { documentId?: string; revision?: number; signature?: string };
  assert.equal(refKey.documentId, 'doc-live');
  assert.equal(refKey.revision, observed.revision);
  assert.match(refKey.signature ?? '', /^sig:/);

  // 5) read（selector 路径，不依赖 ref 表）。
  const read = await client.call<{ fields: Array<{ value: string | null }>; count: number }>('read', {
    session: started.sessionId,
    selector: '#kw',
  });
  assert.equal(read.count, 1);
  assert.equal(read.fields[0]?.value, 'hello bridge');

  // 6) click：合成输入证据如实上报（trusted:false / via content-script）。
  const clicked = await client.call<{ via: string; trusted: boolean; synthetic: boolean; ref: string }>('click', {
    session: started.sessionId,
    ref: '@e2',
  });
  assert.equal(clicked.via, 'content-script');
  assert.equal(clicked.trusted, false);
  assert.equal(clicked.synthetic, true);
  assert.equal(clicked.ref, '@e2');

  // 7) 旧 ref 在重新 observe 后失效（generation/revision 变化 → E_STALE_REF 语义）。
  //    这里直接删掉 ref 表模拟导航后的失效，daemon 的错误码必须原样透传。
  refs.invalidateTab(started.tabId);
  await assert.rejects(client.call('click', { session: started.sessionId, ref: '@e2' }), (error: unknown) => {
    const code = (error as { code?: string }).code;
    assert.equal(code, 'E_STALE_REF');
    return true;
  });

  // 8) session.stop：daemon 发 tab.close/window.close，会话清空。
  const stopped = await client.call<{ ok: boolean }>('session.stop', { session: started.sessionId });
  assert.equal(stopped.ok, true);
  const afterStop = await client.status();
  assert.equal(afterStop.sessions.length, 0, 'session.stop 后不应有残留会话');
  assert.equal(api.findTab(started.tabId), null, 'Agent tab 应被关闭');
});
