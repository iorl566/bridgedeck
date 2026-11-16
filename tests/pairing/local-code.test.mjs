#!/usr/bin/env node
// tests/pairing/local-code.test.mjs —— 本机配对必须同时提供 6 位配对码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { connectWs } from '../../lib/ws.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const PORT = 52941;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-local-code-'));
const env = { ...process.env, BB_HOME: home, BB_PORT: String(PORT), BB_BIND: '127.0.0.1', BB_NO_PROBE: '1' };
const daemon = spawn(NODE, [path.join(ROOT, 'daemon', 'server.mjs'), '--foreground'], { cwd: ROOT, env, stdio: 'ignore' });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function cliJson(args) {
  const out = spawnSync(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), ...args, '--json'], { env, encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out.stdout);
}
async function waitMessage(socket, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
    socket.on('message', (raw) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw)); } catch { resolve({ type: 'raw' }); }
    });
  });
}
function hello(token, code) {
  return {
    type: 'hello',
    role: 'extension',
    browser: 'edge',
    browserVersion: 'test',
    extVersion: '0.1.4',
    authChallenge: true,
    authKeyId: crypto.createHash('sha256').update(token).digest('hex').slice(0, 32),
    pairToken: token,
    pairCode: code,
  };
}

test('没有配对码/配对码错误时拒绝，正确时进入 auth-challenge', async (t) => {
  t.after(() => {
    try { daemon.kill(); } catch { /* 忽略 */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(200);
    try { ready = (await fetch('http://127.0.0.1:' + PORT + '/health')).ok; } catch { /* 等待 */ }
  }
  assert.equal(ready, true, 'daemon 未就绪');
  const created = cliJson(['daemon', 'pair']).result;
  assert.match(created.code, /^\d{6}$/);

  const wrong = await connectWs('ws://127.0.0.1:' + PORT + '/ws?role=extension', { timeoutMs: 3000 });
  const rejectedPromise = waitMessage(wrong);
  wrong.sendJson(hello(created.token, '000000'));
  const rejected = await rejectedPromise;
  assert.equal(rejected.type, 'hello-error');
  assert.equal(rejected.code, 'E_PAIR_REQUIRED');
  try { wrong.close(1000, 'done'); } catch { /* 忽略 */ }

  const right = await connectWs('ws://127.0.0.1:' + PORT + '/ws?role=extension', { timeoutMs: 3000 });
  const challengedPromise = waitMessage(right);
  right.sendJson(hello(created.token, created.code));
  const challenged = await challengedPromise;
  assert.equal(challenged.type, 'auth-challenge');
  assert.ok(challenged.challenge);
  try { right.close(1000, 'done'); } catch { /* 忽略 */ }
});
