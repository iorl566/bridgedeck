// tests/unit/daemon-protocol-gate.test.mjs —— 真实 daemon 的派发前协议门禁。
//
// 不是纯函数单测：真的 spawn `daemon/server.mjs`（临时 BB_HOME + 随机端口），真的用
// WebSocket 冒充浏览器扩展完成 hello 握手，再经 HTTP `/rpc` 发命令，断言：
//   1) 1.8 客户端请求 1.9 特性 → 扩展**收不到命令**，RPC 返回 E_PROTOCOL_UNSUPPORTED，
//      data 里带 method/feature/required/actual，并保留 E_UNSUPPORTED_CAPABILITY 兼容别名；
//   2) 1.9 客户端同一批请求照常派发；
//   3) 能力位缺失（hello caps 不含 video）仍报旧码 E_UNSUPPORTED_CAPABILITY —— 旧语义未放宽。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { connectWs } from '../../lib/ws.mjs';
import {
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  isProtocolUnsupportedCode,
  protocolGate,
} from '../../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'daemon', 'server.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startDaemon(home, port) {
  return spawn(process.execPath, [SERVER, '--foreground', '--port', String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, BB_HOME: home, BB_BIND: '127.0.0.1', BB_TLS: '0', BB_PORT: String(port), BB_DAEMON_TRACE: '0' },
  });
}

async function waitHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      if (res.ok) return await res.json();
    } catch { /* 继续等 */ }
    await sleep(100);
  }
  throw new Error('daemon health timeout');
}

async function stopDaemon(child, port) {
  try { child.kill(); } catch { /* 忽略 */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:' + port + '/health');
      await sleep(100);
    } catch {
      return;
    }
  }
}

async function rpc(port, token, method, params = {}) {
  const res = await fetch('http://127.0.0.1:' + port + '/rpc', {
    method: 'POST',
    headers: { 'x-bridge-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs: 8000 }),
  });
  return res.json();
}

/** 冒充扩展：hello 握手 + 对 daemon 下发的 cmd 回 res。记录收到的每条命令。 */
function connectFakeExtension(port, { protocol, instanceId, capabilities, tabId = 201, windowId = 7, commands = [] }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake extension hello timeout')), 8000);
    (async () => {
      const conn = await connectWs('ws://127.0.0.1:' + port + '/ws?role=extension', { timeoutMs: 8000 });
      const results = {
        read: { value: 'gate-ok', selector: 'body' },
        click: { ok: true, clicked: true, target: { ref: '@e1' } },
        screenshot: { ok: true, dataUrl: 'data:image/png;base64,AA==', width: 10, height: 8 },
        evaluate: { value: 2, unverified: true },
        'window.newAgent': { tabId, windowId, url: 'https://gate.test/', title: 'Gate' },
        'dialog.arm': { ok: true, armed: true },
        'control-hint': { ok: true },
      };
      conn.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'hello-ack') {
          clearTimeout(timer);
          resolve({ conn, commands, ack: msg });
          return;
        }
        if (msg.type === 'hello-error') {
          clearTimeout(timer);
          reject(new Error('hello-error: ' + msg.code));
          return;
        }
        if (msg.type === 'ping') {
          try { conn.sendJson({ type: 'pong' }); } catch { /* 忽略 */ }
          return;
        }
        if (msg.type === 'cmd') {
          commands.push({ method: msg.method, params: msg.params });
          const result = results[msg.method] !== undefined ? results[msg.method] : { ok: true };
          try { conn.sendJson({ type: 'res', id: msg.id, ok: true, result }); } catch { /* 忽略 */ }
        }
      });
      conn.sendJson({
        type: 'hello',
        protocol,
        browser: 'edge',
        browserVersion: '157.0.0.0',
        extVersion: 'gate-test',
        instanceId,
        label: 'gate-' + protocol,
        capabilities,
        settings: {},
      });
    })().catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 1.9 客户端应有的能力位；故意不含 video，用来验证旧码语义仍然生效。 */
const CURRENT_CAPS = ['observe', 'frames', 'dialog', 'screenshot', 'network', 'rules', 'unverified', 'dom-read', 'recording', 'pairing', 'tls'];

test('协议门禁错误码与兼容别名（纯数据，先于真实 daemon 断言）', () => {
  const denied = protocolGate({ protocol: '1.8' }, 'read', {});
  assert.equal(denied.code, PROTOCOL_UNSUPPORTED);
  assert.equal(denied.data.legacyCode, LEGACY_CAPABILITY_UNSUPPORTED);
  assert.deepEqual([...denied.data.aliasCodes], [...PROTOCOL_UNSUPPORTED_ALIASES]);
  assert.equal(isProtocolUnsupportedCode(PROTOCOL_UNSUPPORTED), true);
  assert.equal(isProtocolUnsupportedCode(LEGACY_CAPABILITY_UNSUPPORTED), true);
  assert.equal(isProtocolUnsupportedCode('E_NO_SESSION'), false);
});

test('真实 daemon：1.8 客户端被特性门拒绝、1.9 客户端放行、能力位旧码保留', { timeout: 90000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-daemon-gate-'));
  const port = await freePort();
  let child = startDaemon(home, port);
  const legacy = { conn: null };
  const current = { conn: null };
  try {
    await waitHealth(port);
    const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
    assert.equal(typeof info.token, 'string');

    // ---- 1.8 老客户端：会话建立不受影响（session.start 不是 gated 方法）----
    const legacyExt = await connectFakeExtension(port, {
      protocol: '1.8',
      instanceId: 'aaaa1111',
      capabilities: ['observe', 'frames', 'dialog', 'screenshot', 'network', 'rules'],
      tabId: 101,
      windowId: 5,
    });
    legacy.conn = legacyExt.conn;
    const legacyStart = await rpc(port, info.token, 'session.start', { controller: { name: 'gate-legacy' } });
    assert.equal(legacyStart.ok, true, JSON.stringify(legacyStart));
    const legacySession = legacyStart.result.sessionId;
    assert.equal(typeof legacySession, 'string');

    // 1) 方法级特性门：read 需要协议 1.9
    const deniedRead = await rpc(port, info.token, 'read', { session: legacySession, selector: 'body' });
    assert.equal(deniedRead.ok, false);
    assert.equal(deniedRead.error.code, PROTOCOL_UNSUPPORTED, JSON.stringify(deniedRead.error));
    assert.equal(deniedRead.error.data.method, 'read');
    assert.equal(deniedRead.error.data.feature, 'read');
    assert.equal(deniedRead.error.data.required, '1.9');
    assert.equal(deniedRead.error.data.actual, '1.8');
    assert.deepEqual(deniedRead.error.data.features, ['read']);
    assert.equal(deniedRead.error.data.legacyCode, LEGACY_CAPABILITY_UNSUPPORTED);
    assert.ok(deniedRead.error.data.aliasCodes.includes(LEGACY_CAPABILITY_UNSUPPORTED));
    assert.match(deniedRead.error.message, /E_PROTOCOL_UNSUPPORTED/);
    assert.match(deniedRead.error.message, /read/);
    assert.match(deniedRead.error.message, /1\.9/);
    // 关键：被拒的请求根本没有下发到扩展（不是“扩展收到再报错”）。
    assert.equal(legacyExt.commands.some((cmd) => cmd.method === 'read'), false);

    // 2) 参数级特性门：screenshot --stream
    const deniedShot = await rpc(port, info.token, 'screenshot', { session: legacySession, stream: true });
    assert.equal(deniedShot.ok, false);
    assert.equal(deniedShot.error.code, PROTOCOL_UNSUPPORTED);
    assert.equal(deniedShot.error.data.feature, 'capture.stream');
    assert.equal(deniedShot.error.data.method, 'screenshot');
    assert.equal(legacyExt.commands.some((cmd) => cmd.method === 'screenshot'), false);

    // 3) 参数级特性门：evaluate --unverified
    const deniedEval = await rpc(port, info.token, 'evaluate', { session: legacySession, expression: '1 + 1', unverified: true });
    assert.equal(deniedEval.ok, false);
    assert.equal(deniedEval.error.code, PROTOCOL_UNSUPPORTED);
    assert.equal(deniedEval.error.data.feature, 'unverified');
    assert.equal(legacyExt.commands.some((cmd) => cmd.method === 'evaluate'), false);

    // 4) 无特性门的方法照常派发：click 在 1.8 上必须可用
    const clicked = await rpc(port, info.token, 'click', { session: legacySession, ref: '@e1' });
    assert.equal(clicked.ok, true, JSON.stringify(clicked));
    assert.equal(clicked.result.clicked, true);
    assert.ok(legacyExt.commands.some((cmd) => cmd.method === 'click' && cmd.params.tabId === legacyStart.result.tabId));

    legacyExt.conn.close();
    await sleep(300);

    // ---- 1.9 当前客户端：同一批能力全放行；能力位缺失仍报旧码 ----
    const currentExt = await connectFakeExtension(port, {
      protocol: '1.9',
      instanceId: 'bbbb2222',
      capabilities: CURRENT_CAPS,
    });
    current.conn = currentExt.conn;
    const currentStart = await rpc(port, info.token, 'session.start', { controller: { name: 'gate-current' } });
    assert.equal(currentStart.ok, true, JSON.stringify(currentStart));
    const currentSession = currentStart.result.sessionId;

    const read = await rpc(port, info.token, 'read', { session: currentSession, selector: 'body' });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.result.value, 'gate-ok');
    assert.ok(currentExt.commands.some((cmd) => cmd.method === 'read'));

    const shot = await rpc(port, info.token, 'screenshot', { session: currentSession, stream: true });
    assert.equal(shot.ok, true, JSON.stringify(shot));
    assert.equal(shot.result.width, 10);

    const evaluated = await rpc(port, info.token, 'evaluate', { session: currentSession, expression: '1 + 1', unverified: true });
    assert.equal(evaluated.ok, true, JSON.stringify(evaluated));
    assert.equal(evaluated.result.value, 2);

    // 能力位缺失（caps 没有 video）沿用旧码 E_UNSUPPORTED_CAPABILITY：协议门禁没有放宽旧语义。
    const noCap = await rpc(port, info.token, 'video.start', { session: currentSession });
    assert.equal(noCap.ok, false);
    assert.equal(noCap.error.code, 'E_UNSUPPORTED_CAPABILITY', JSON.stringify(noCap.error));
    assert.match(noCap.error.message, /video/);
    assert.equal(currentExt.commands.some((cmd) => cmd.method === 'video.start'), false);
  } finally {
    try { if (legacy.conn) legacy.conn.close(); } catch { /* 忽略 */ }
    try { if (current.conn) current.conn.close(); } catch { /* 忽略 */ }
    await stopDaemon(child, port);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('真实 daemon：hello 阶段 major 不兼容仍直接 E_PROTOCOL_UNSUPPORTED', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-daemon-gate-major-'));
  const port = await freePort();
  const child = startDaemon(home, port);
  try {
    await waitHealth(port);
    const rejected = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 8000);
      (async () => {
        const conn = await connectWs('ws://127.0.0.1:' + port + '/ws?role=extension', { timeoutMs: 8000 });
        conn.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(String(raw)); } catch { return; }
          if (msg.type === 'hello-error') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        conn.sendJson({ type: 'hello', protocol: '2.0', browser: 'edge', instanceId: 'cccc3333', capabilities: [] });
      })();
    });
    assert.equal(rejected.timeout, undefined, 'daemon 没有在 hello 阶段拒绝不兼容 major');
    assert.equal(rejected.code, PROTOCOL_UNSUPPORTED);
  } finally {
    await stopDaemon(child, port);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
