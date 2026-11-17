import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectWs } from '../../lib/ws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'daemon', 'server.mjs');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch { /* 继续等 */ }
    await sleep(100);
  }
  throw new Error('daemon health timeout');
}

function startDaemon(home, port) {
  const child = spawn(process.execPath, [SERVER, '--foreground', '--port', String(port)], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, BB_HOME: home, BB_BIND: '127.0.0.1', BB_TLS: '0', BB_PORT: String(port) },
  });
  return child;
}

async function stopDaemon(child, port) {
  try { child.kill(); } catch { /* 忽略 */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      await sleep(100);
    } catch {
      return;
    }
  }
}

async function rpc(port, token, method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'x-bridge-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs: 5000 }),
  });
  return res.json();
}

function hello(token) {
  return {
    type: 'hello', protocol: '1.9', pairToken: token,
    browser: 'edge', browserVersion: '157.0.0.0', extVersion: '0.1.8',
    instanceId: 'deadbeef', label: 'remote-integration', settings: {},
  };
}

function connectRemote(port, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    (async () => {
      const conn = await connectWs(`ws://127.0.0.1:${port}/ws?role=extension`, { timeoutMs, localAddress: '127.0.0.2' });
      const timer = setTimeout(() => { try { conn.close(); } catch { /* 忽略 */ } reject(new Error('hello timeout')); }, timeoutMs);
      conn.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'hello-ack' || msg.type === 'hello-error') {
          clearTimeout(timer);
          resolve({ conn, msg });
        }
      });
      conn.sendJson(hello(token));
    })().catch(reject);
  });
}

test('远程设备凭据 daemon 重启后仍可重连，撤销后 token 失效', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-remote-device-'));
  const port = await freePort();
  let child = startDaemon(home, port);
  try {
    await waitHealth(port);
    const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
    const pair = await rpc(port, info.token, 'pair.create', { label: 'remote-integration', scope: 'read' });
    assert.equal(pair.ok, true);
    let token = pair.result.token;

    const first = await connectRemote(port, token);
    assert.equal(first.msg.type, 'hello-ack');
    first.conn.close();
    await sleep(300);

    const list = await rpc(port, info.token, 'pair.list');
    assert.equal(list.ok, true);
    assert.equal((list.result.knownDevices || []).length, 1);
    const deviceId = list.result.knownDevices[0].deviceId;
    assert.equal(list.result.knownDevices[0].scope, 'read');

    const renewed = await rpc(port, info.token, 'pair.renew', { deviceId });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.result.deviceId, deviceId);
    assert.equal(renewed.result.scope, 'read');
    const oldToken = await connectRemote(port, token);
    assert.equal(oldToken.msg.type, 'hello-error');
    oldToken.conn.close();
    await sleep(200);
    const newToken = await connectRemote(port, renewed.result.token);
    assert.equal(newToken.msg.type, 'hello-ack');
    newToken.conn.close();
    await sleep(200);
    token = renewed.result.token;

    await stopDaemon(child, port);
    child = startDaemon(home, port);
    await waitHealth(port);
    const info2 = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));

    const second = await connectRemote(port, token);
    assert.equal(second.msg.type, 'hello-ack', JSON.stringify(second.msg));
    second.conn.close();
    await sleep(200);

    const revoked = await rpc(port, info2.token, 'pair.revoke', { deviceId });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.result.revoked, true);

    const third = await connectRemote(port, token);
    assert.equal(third.msg.type, 'hello-error');
    assert.equal(third.msg.code, 'E_PAIR_REQUIRED');
    third.conn.close();
  } finally {
    await stopDaemon(child, port);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
