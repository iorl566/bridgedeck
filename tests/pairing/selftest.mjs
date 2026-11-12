#!/usr/bin/env node
// tests/pairing/selftest.mjs —— 配对码 + 远程 WS token 鉴权（不需要浏览器）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectWs } from '../../lib/ws.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const PORT = 52931;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-pair-test-'));
const env = { ...process.env, BB_HOME: home, BB_PORT: String(PORT), BB_BIND: '0.0.0.0', BB_NO_PROBE: '1' };

function sleep(ms) { return new Promise((resolve) => setTimeout(() => resolve(), ms)); }
function cli(args) {
  return spawnSync(NODE, [path.join(ROOT, 'cli', 'bridge.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 });
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

let ready = false;
for (let i = 0; i < 40 && !ready; i += 1) {
  await sleep(200);
  try {
    const response = await fetch('http://127.0.0.1:' + PORT + '/health');
    ready = response.ok;
  } catch {
    ready = false;
  }
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

check('daemon 在 0.0.0.0 上就绪', ready);

const created = cliJson(['pair', 'create', '--label', 'selftest', '--ttl', '5m']).result;
check('pair create 返回 code/url/token', Boolean(created && created.code && created.url && created.token), created && created.code);

const listed = cliJson(['pair', 'list']).result;
check('pair list 含刚创建的码', Boolean(listed && listed.pairings.some((item) => item.code === created.code)), listed && String(listed.pairings.length));

const redeemed = cliJson(['pair', 'redeem', created.code]).result;
check('pair redeem 换回同一 token', Boolean(redeemed && redeemed.token === created.token));

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}
const host = lanAddress();
const wsUrl = 'ws://' + host + ':' + PORT + '/ws?role=extension&v=0.1.1';

function waitMessage(conn, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => finish({ type: 'timeout' }), ms);
    conn.on('message', (raw) => {
      clearTimeout(timer);
      try { finish(JSON.parse(raw)); } catch { finish({ type: 'raw' }); }
    });
    conn.on('close', () => { clearTimeout(timer); finish({ type: 'closed' }); });
  });
}
function waitClose(conn, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(() => finish(), ms);
    conn.on('close', () => { clearTimeout(timer); finish(); });
  });
}

const helloBase = { type: 'hello', role: 'extension', browser: 'edge', browserVersion: 'test', extVersion: '0.1.1' };

const bad = await connectWs(wsUrl, { timeoutMs: 5000 });
bad.sendJson(helloBase);
const badReply = await waitMessage(bad, 3000);
check('无 token 的远程连接被拒绝', badReply.type === 'hello-error' && badReply.code === 'E_PAIR_REQUIRED', JSON.stringify(badReply));
await waitClose(bad, 2000);
try { bad.close(1000, 'done'); } catch { /* 忽略 */ }

const good = await connectWs(wsUrl, { timeoutMs: 5000 });
good.sendJson({ ...helloBase, pairToken: created.token });
const goodReply = await waitMessage(good, 5000);
check('带 token 的远程连接握手成功', goodReply.type === 'hello-ack' && Boolean(goodReply.instanceId), JSON.stringify(goodReply));

const proto = await connectWs(wsUrl, { timeoutMs: 5000 });
proto.sendJson({ ...helloBase, pairToken: created.token, protocol: 99 });
const protoReply = await waitMessage(proto, 3000);
check('协议过新的客户端被拒绝', protoReply.type === 'hello-error' && protoReply.code === 'E_PROTOCOL_UNSUPPORTED', JSON.stringify(protoReply));
try { proto.close(1000, 'done'); } catch { /* 忽略 */ }

const closedPromise = waitClose(good, 3000);
const revoked = cliJson(['pair', 'revoke', created.code]).result;
check('pair revoke 生效', Boolean(revoked && revoked.revoked === true), 'kicked=' + (revoked && revoked.kicked));
const kicked = await Promise.race([closedPromise, sleep(1200).then(() => 'timeout')]);
check('撤销后已连接的实例被断开', kicked === true || good.closed === true, 'event=' + kicked + ' closed=' + good.closed);

const afterRevoke = cliJson(['pair', 'redeem', created.code]);
check('撤销后 redeem 返回 E_PAIR_INVALID', Boolean(afterRevoke.error && afterRevoke.error.code === 'E_PAIR_INVALID'), JSON.stringify(afterRevoke.error));

try { good.close(1000, 'done'); } catch { /* 忽略 */ }
daemon.kill();
await sleep(300);
const failed = results.filter((item) => !item.ok);
console.log('');
console.log('== 配对结果 ==');
console.log('通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
process.exit(failed.length ? 1 : 0);
