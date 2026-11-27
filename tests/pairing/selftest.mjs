#!/usr/bin/env node
// tests/pairing/selftest.mjs —— 配对码 + 远程 WS token 鉴权（不需要浏览器）
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const wsUrl = 'ws://' + host + ':' + PORT + '/ws?role=extension&v=0.1.2';

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

const helloBase = { type: 'hello', role: 'extension', browser: 'edge', browserVersion: 'test', extVersion: '0.1.2', browserId: 'selftest-browser-a' };

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
const deviceToken = goodReply.deviceToken;
check('激活后换发独立设备 token', typeof deviceToken === 'string' && deviceToken.length >= 32 && deviceToken !== created.token);
check('激活先进入 pending 并给 commitTxn', goodReply.deviceStatus === 'pending' && typeof goodReply.commitTxn === 'string' && goodReply.commitTxn.length > 0, JSON.stringify({ status: goodReply.deviceStatus, txn: goodReply.commitTxn }));
good.sendJson({ type: 'auth-commit', txn: goodReply.commitTxn, proof: hmacHex(deviceToken, 'bridgedeck-commit-v1\n' + goodReply.commitTxn) });
const commitAck = await waitMessage(good, 4000);
check('auth-commit 后 commit-ack', commitAck.type === 'commit-ack' && commitAck.txn === goodReply.commitTxn, JSON.stringify(commitAck));
check('激活后原始配对码失效', Boolean(cliJson(['pair', 'redeem', created.code]).error));

const replay = await connectWs(wsUrl, { timeoutMs: 5000 });
replay.sendJson({ ...helloBase, pairToken: created.token });
const replayReply = await waitMessage(replay, 3000);
check('激活后原链接 token 不能再次认证', replayReply.type === 'hello-error' && replayReply.code === 'E_PAIR_REQUIRED', JSON.stringify(replayReply));
try { replay.close(1000, 'done'); } catch { /* 忽略 */ }

const renew = await connectWs(wsUrl, { timeoutMs: 5000 });
renew.sendJson({ ...helloBase, pairToken: deviceToken });
const renewReply = await waitMessage(renew, 5000);
check('设备 token 可重连', renewReply.type === 'hello-ack' && Boolean(renewReply.instanceId), JSON.stringify(renewReply));

const otherBrowser = await connectWs(wsUrl, { timeoutMs: 5000 });
otherBrowser.sendJson({ ...helloBase, browserId: 'selftest-browser-b', pairToken: deviceToken });
const otherReply = await waitMessage(otherBrowser, 4000);
check('同一 token 换浏览器被拒绝（browser_id 绑定）', otherReply.type === 'hello-error' && otherReply.code === 'E_PAIR_REJECTED', JSON.stringify(otherReply));
try { otherBrowser.close(1000, 'done'); } catch { /* 忽略 */ }

const proto = await connectWs(wsUrl, { timeoutMs: 5000 });
proto.sendJson({ ...helloBase, pairToken: deviceToken, protocol: 99 });
const protoReply = await waitMessage(proto, 3000);
check('协议过新的客户端被拒绝', protoReply.type === 'hello-error' && protoReply.code === 'E_PROTOCOL_UNSUPPORTED', JSON.stringify(protoReply));
try { proto.close(1000, 'done'); } catch { /* 忽略 */ }

const known = cliJson(['pair', 'list']).result;
const device = (known && known.knownDevices || [])[0];
check('pair list 记录激活后的设备', Boolean(device && device.deviceId), JSON.stringify(device));
const closedPromise = waitClose(good, 3000);
const revoked = cliJson(['pair', 'revoke', device ? device.deviceId : created.code]).result;
check('pair revoke 生效', Boolean(revoked && revoked.revoked === true), 'kicked=' + (revoked && revoked.kicked));
const kicked = await Promise.race([closedPromise, sleep(1200).then(() => 'timeout')]);
check('撤销后已连接的实例被断开', kicked === true || good.closed === true, 'event=' + kicked + ' closed=' + good.closed);

const afterRevoke = cliJson(['pair', 'redeem', created.code]);
check('撤销后 redeem 返回 E_PAIR_INVALID', Boolean(afterRevoke.error && afterRevoke.error.code === 'E_PAIR_INVALID'), JSON.stringify(afterRevoke.error));

// ---- 本机配对激活：旧链接降级为 unpaired，新 token 保持 verified ----
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function hmacHex(key, value) {
  return crypto.createHmac('sha256', String(key)).update(String(value)).digest('hex');
}
const localPair = cliJson(['daemon', 'pair']).result;
check('本机 pair 生成 link/code/token', Boolean(localPair && localPair.token && localPair.code), JSON.stringify(localPair).slice(0, 80));
const localUrl = 'ws://127.0.0.1:' + PORT + '/ws?role=extension&v=0.1.2';
const localHello = (token, extra = {}) => ({
  ...helloBase,
  protocol: '1.9',
  capabilities: [],
  authChallenge: true,
  authKeyId: sha256Hex(token).slice(0, 32),
  pairToken: token,
  ...extra,
});
const first = await connectWs(localUrl, { timeoutMs: 5000 });
first.sendJson(localHello(localPair.token, { pairCode: localPair.code }));
const challenge = await waitMessage(first, 3000);
check('本机配对先收到 auth-challenge', challenge.type === 'auth-challenge' && Boolean(challenge.challenge), JSON.stringify(challenge));
first.sendJson({ type: 'auth-response', challenge: challenge.challenge, proof: hmacHex(localPair.token, 'bridgedeck-auth-v1\n' + challenge.challenge) });
const firstAck = await waitMessage(first, 5000);
check('本机配对激活成功并换发 token', firstAck.type === 'hello-ack' && typeof firstAck.deviceToken === 'string' && firstAck.deviceToken !== localPair.token, JSON.stringify(firstAck).slice(0, 120));
check('本机激活先进入 pending', firstAck.deviceStatus === 'pending' && Boolean(firstAck.commitTxn));
first.sendJson({ type: 'auth-commit', txn: firstAck.commitTxn, proof: hmacHex(firstAck.deviceToken, 'bridgedeck-commit-v1\n' + firstAck.commitTxn) });
const localCommitAck = await waitMessage(first, 4000);
check('本机 auth-commit 后 commit-ack', localCommitAck.type === 'commit-ack', JSON.stringify(localCommitAck));
try { first.close(1000, 'done'); } catch { /* 忽略 */ }

const stale = await connectWs(localUrl, { timeoutMs: 5000 });
stale.sendJson(localHello(localPair.token));
const staleReply = await waitMessage(stale, 4000);
check('旧本机链接降级为 unpaired（不再视为已配对）', staleReply.type === 'hello-ack' && staleReply.localAuth && staleReply.localAuth.state === 'unpaired', JSON.stringify(staleReply).slice(0, 120));
try { stale.close(1000, 'done'); } catch { /* 忽略 */ }

const fresh = await connectWs(localUrl, { timeoutMs: 5000 });
fresh.sendJson(localHello(firstAck.deviceToken));
const freshChallenge = await waitMessage(fresh, 3000);
check('新本机 token 进入挑战', freshChallenge.type === 'auth-challenge', JSON.stringify(freshChallenge));
fresh.sendJson({ type: 'auth-response', challenge: freshChallenge.challenge, proof: hmacHex(firstAck.deviceToken, 'bridgedeck-auth-v1\n' + freshChallenge.challenge) });
const freshAck = await waitMessage(fresh, 5000);
check('新本机 token 重连为 verified', freshAck.type === 'hello-ack' && freshAck.localAuth && freshAck.localAuth.state === 'verified', JSON.stringify(freshAck).slice(0, 120));
try { fresh.close(1000, 'done'); } catch { /* 忽略 */ }

const localOther = await connectWs(localUrl, { timeoutMs: 5000 });
localOther.sendJson(localHello(firstAck.deviceToken, { browserId: 'selftest-browser-b' }));
const localOtherReply = await waitMessage(localOther, 4000);
check('本机 token 换浏览器被拒绝（browser_id 绑定）', localOtherReply.type === 'hello-error' && localOtherReply.code === 'E_PAIR_REJECTED', JSON.stringify(localOtherReply));
try { localOther.close(1000, 'done'); } catch { /* 忽略 */ }

// ---- 本机分阶段 rotation：daemon rotate 先 pending，新 token commit 后才替换旧 token ----
const localRotate = cliJson(['daemon', 'rotate']).result;
check('本机 rotate 返回 pending rotation', Boolean(localRotate && localRotate.pending === true && localRotate.token && localRotate.txn), JSON.stringify(localRotate).slice(0, 120));
const rotLocal = await connectWs(localUrl, { timeoutMs: 5000 });
rotLocal.sendJson(localHello(localRotate.token));
const rotLocalChallenge = await waitMessage(rotLocal, 3000);
check('本机 rotation 进入挑战', rotLocalChallenge.type === 'auth-challenge', JSON.stringify(rotLocalChallenge));
rotLocal.sendJson({ type: 'auth-response', challenge: rotLocalChallenge.challenge, proof: hmacHex(localRotate.token, 'bridgedeck-auth-v1\n' + rotLocalChallenge.challenge) });
const rotLocalAck = await waitMessage(rotLocal, 5000);
check('本机 rotation 拿到 commitTxn', rotLocalAck.type === 'hello-ack' && rotLocalAck.commitTxn === localRotate.txn, JSON.stringify(rotLocalAck).slice(0, 120));
rotLocal.sendJson({ type: 'auth-commit', txn: rotLocalAck.commitTxn, proof: hmacHex(localRotate.token, 'bridgedeck-commit-v1\n' + rotLocalAck.commitTxn) });
const rotLocalCommit = await waitMessage(rotLocal, 4000);
check('本机 rotation commit 完成', rotLocalCommit.type === 'commit-ack', JSON.stringify(rotLocalCommit));
try { rotLocal.close(1000, 'done'); } catch { /* 忽略 */ }
const staleLocal = await connectWs(localUrl, { timeoutMs: 5000 });
staleLocal.sendJson(localHello(firstAck.deviceToken));
const staleLocalReply = await waitMessage(staleLocal, 4000);
check('本机 rotation commit 后旧 token 降级 unpaired', staleLocalReply.type === 'hello-ack' && staleLocalReply.localAuth && staleLocalReply.localAuth.state === 'unpaired', JSON.stringify(staleLocalReply).slice(0, 120));
try { staleLocal.close(1000, 'done'); } catch { /* 忽略 */ }
const freshLocalRot = await connectWs(localUrl, { timeoutMs: 5000 });
freshLocalRot.sendJson(localHello(localRotate.token));
const freshLocalRotChallenge = await waitMessage(freshLocalRot, 3000);
check('本机 rotation 后新 token 进入挑战', freshLocalRotChallenge.type === 'auth-challenge', JSON.stringify(freshLocalRotChallenge));
freshLocalRot.sendJson({ type: 'auth-response', challenge: freshLocalRotChallenge.challenge, proof: hmacHex(localRotate.token, 'bridgedeck-auth-v1\n' + freshLocalRotChallenge.challenge) });
const freshLocalRotAck = await waitMessage(freshLocalRot, 5000);
check('本机 rotation 后新 token verified', freshLocalRotAck.type === 'hello-ack' && freshLocalRotAck.localAuth && freshLocalRotAck.localAuth.state === 'verified', JSON.stringify(freshLocalRotAck).slice(0, 120));
try { freshLocalRot.close(1000, 'done'); } catch { /* 忽略 */ }

// ---- 分阶段激活的断点恢复：拿到 pending token 但没 commit 就断开，重连后应重新拿到 commitTxn ----
const created2 = cliJson(['pair', 'create', '--label', 'interrupt', '--ttl', '5m']).result;
check('恢复测试配对码已创建', Boolean(created2 && created2.code && created2.token));
const interrupted = await connectWs(wsUrl, { timeoutMs: 5000 });
interrupted.sendJson({ ...helloBase, pairToken: created2.token });
const interruptedAck = await waitMessage(interrupted, 5000);
check('恢复测试激活进入 pending', interruptedAck.type === 'hello-ack' && interruptedAck.deviceStatus === 'pending' && Boolean(interruptedAck.commitTxn), JSON.stringify(interruptedAck).slice(0, 120));
const pendingToken = interruptedAck.deviceToken;
const pendingTxn = interruptedAck.commitTxn;
try { interrupted.close(1000, 'done'); } catch { /* 忽略 */ }
await waitClose(interrupted, 2000);

const resumed = await connectWs(wsUrl, { timeoutMs: 5000 });
resumed.sendJson({ ...helloBase, pairToken: pendingToken });
const resumedAck = await waitMessage(resumed, 5000);
check('断点恢复：pending token 重连成功', resumedAck.type === 'hello-ack' && Boolean(resumedAck.instanceId), JSON.stringify(resumedAck).slice(0, 120));
check('断点恢复：重新下发 commitTxn', resumedAck.commitTxn === pendingTxn && resumedAck.deviceStatus === 'pending', JSON.stringify({ txn: resumedAck.commitTxn, status: resumedAck.deviceStatus }));
resumed.sendJson({ type: 'auth-commit', txn: resumedAck.commitTxn, proof: hmacHex(pendingToken, 'bridgedeck-commit-v1\n' + resumedAck.commitTxn) });
const resumedCommit = await waitMessage(resumed, 4000);
check('断点恢复：commit 完成', resumedCommit.type === 'commit-ack', JSON.stringify(resumedCommit));
const known2 = cliJson(['pair', 'list']).result;
const device2 = ((known2 && known2.knownDevices) || []).find((item) => item.instanceId === resumedAck.instanceId);
check('断点恢复后设备状态 active', Boolean(device2 && device2.status === 'active'), JSON.stringify(device2));
try { resumed.close(1000, 'done'); } catch { /* 忽略 */ }

// ---- 分阶段 rotation：pair renew 先 pending，新 token commit 后才替换旧 token ----
const renewed = cliJson(['pair', 'renew', device2.deviceId]).result;
check('pair renew 返回 pending rotation', Boolean(renewed && renewed.pending === true && renewed.token && renewed.txn), JSON.stringify(renewed).slice(0, 120));
const rotConn = await connectWs(wsUrl, { timeoutMs: 5000 });
rotConn.sendJson({ ...helloBase, pairToken: renewed.token });
const rotAck = await waitMessage(rotConn, 5000);
check('rotation 连接拿到 commitTxn', rotAck.type === 'hello-ack' && rotAck.commitTxn === renewed.txn, JSON.stringify(rotAck).slice(0, 120));
const oldReplay = await connectWs(wsUrl, { timeoutMs: 5000 });
oldReplay.sendJson({ ...helloBase, pairToken: pendingToken });
const oldReplayReply = await waitMessage(oldReplay, 4000);
check('rotation commit 前旧 token 仍有效（重连成功）', oldReplayReply.type === 'hello-ack', JSON.stringify(oldReplayReply).slice(0, 120));
try { oldReplay.close(1000, 'done'); } catch { /* 忽略 */ }
rotConn.sendJson({ type: 'auth-commit', txn: rotAck.commitTxn, proof: hmacHex(renewed.token, 'bridgedeck-commit-v1\n' + rotAck.commitTxn) });
const rotCommit = await waitMessage(rotConn, 4000);
check('rotation commit 完成', rotCommit.type === 'commit-ack', JSON.stringify(rotCommit));
const afterRotation = cliJson(['pair', 'list']).result;
const rotatedDevice = ((afterRotation && afterRotation.knownDevices) || []).find((item) => item.deviceId === device2.deviceId);
check('rotation 后设备 active 且无 pending', Boolean(rotatedDevice && rotatedDevice.status === 'active' && rotatedDevice.rotationPending === false), JSON.stringify(rotatedDevice));
const staleRotation = await connectWs(wsUrl, { timeoutMs: 5000 });
staleRotation.sendJson({ ...helloBase, pairToken: pendingToken });
const staleRotationReply = await waitMessage(staleRotation, 4000);
check('rotation commit 后旧 token 失效', staleRotationReply.type === 'hello-error' && staleRotationReply.code === 'E_PAIR_REQUIRED', JSON.stringify(staleRotationReply).slice(0, 120));
try { staleRotation.close(1000, 'done'); } catch { /* 忽略 */ }
try { rotConn.close(1000, 'done'); } catch { /* 忽略 */ }
cliJson(['pair', 'revoke', device2.deviceId]);

try { good.close(1000, 'done'); } catch { /* 忽略 */ }
daemon.kill();
await sleep(300);
const failed = results.filter((item) => !item.ok);
console.log('');
console.log('== 配对结果 ==');
console.log('通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
process.exit(failed.length ? 1 : 0);
