#!/usr/bin/env node
// tests/tls/selftest.mjs —— TLS/WSS：daemon 自签证书 + CLI over https + wss 握手
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { connectWs } from '../../lib/ws.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const PORT = 52932;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-tls-test-'));
const env = { ...process.env, BB_HOME: home, BB_PORT: String(PORT), BB_TLS: '1', BB_BIND: '0.0.0.0', BB_NO_PROBE: '1' };

function sleep(ms) { return new Promise((resolve) => setTimeout(() => resolve(), ms)); }
function cli(args) {
  return spawnSync(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), ...args], { env, encoding: 'utf8', timeout: 40000 });
}
function cliJson(args) {
  const out = cli([...args, '--json']);
  try { return JSON.parse(out.stdout); } catch { return { raw: out.stdout, stderr: out.stderr }; }
}

const daemon = spawn(NODE, [path.join(ROOT, 'daemon', 'server.mjs'), '--foreground'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'ignore', 'ignore'],
});

function httpsHealth() {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: PORT, path: '/health', rejectUnauthorized: false, timeout: 1000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

let health = null;
for (let i = 0; i < 80 && !health; i += 1) {
  await sleep(250);
  health = await httpsHealth();
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

check('daemon 以 https 就绪', Boolean(health && health.service === 'browser-bridge'), JSON.stringify(health && health.version));

const status = cliJson(['status']);
check('CLI 通过 https 正常通信', Boolean(status.ok), JSON.stringify(status.error || status.result && status.result.version));

const info = JSON.parse(fs.readFileSync(path.join(home, 'daemon.json'), 'utf8'));
check('daemon.json 标记 tls', info.tls === true);

const created = cliJson(['pair', 'create', '--ttl', '5m']).result;
check('pair create 可用', Boolean(created && created.token), JSON.stringify(created && created.code));
check('配对地址是 wss://', Boolean(created && /^wss:\/\//.test(created.url)), created && created.url);

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}
const wsUrl = 'wss://' + lanAddress() + ':' + PORT + '/ws?role=extension&v=0.1.2';
function waitMessage(conn, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => finish({ type: 'timeout' }), ms);
    conn.on('message', (raw) => { clearTimeout(timer); try { finish(JSON.parse(raw)); } catch { finish({ type: 'raw' }); } });
    conn.on('close', () => { clearTimeout(timer); finish({ type: 'closed' }); });
  });
}

const bad = await connectWs(wsUrl, { timeoutMs: 5000, rejectUnauthorized: false });
bad.sendJson({ type: 'hello', role: 'extension', browser: 'edge', browserVersion: 'test', extVersion: '0.1.2' });
const badReply = await waitMessage(bad, 3000);
check('无 token 的 wss 连接被拒绝', badReply.type === 'hello-error' && badReply.code === 'E_PAIR_REQUIRED', JSON.stringify(badReply));
try { bad.close(1000, 'done'); } catch { /* 忽略 */ }

const good = await connectWs(wsUrl, { timeoutMs: 5000, rejectUnauthorized: false });
good.sendJson({ type: 'hello', role: 'extension', browser: 'edge', browserVersion: 'test', extVersion: '0.1.2', pairToken: created && created.token });
const goodReply = await waitMessage(good, 5000);
check('带 token 的 wss 握手成功', goodReply.type === 'hello-ack' && Boolean(goodReply.instanceId), JSON.stringify(goodReply));

try { good.close(1000, 'done'); } catch { /* 忽略 */ }
const stopped = cli(['daemon', 'stop']);
check('daemon stop 正常', stopped.status === 0, stopped.stdout.trim());

daemon.kill();
await sleep(300);
const failed = results.filter((item) => !item.ok);
console.log('');
console.log('== TLS 结果 ==');
console.log('通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
process.exit(failed.length ? 1 : 0);
