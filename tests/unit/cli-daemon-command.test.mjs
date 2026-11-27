import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonCommand } from '../../cli/commands/daemon.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand({ locate = { info: null, health: null }, rpc = null } = {}) {
  const printed = [];
  let daemonInfo = { port: 1 };
  const cmd = createDaemonCommand({
    SERVER_PATH: 'daemon/server.mjs',
    REPO_ROOT: '.',
    HOME_DIR: '.',
    ensureDaemon: async () => ({ pid: 9, port: 52900 }),
    stopDaemon: async () => ({ stopped: true, message: 'daemon 已停止' }),
    locateDaemon: async () => locate,
    setDaemonInfo: (value) => { daemonInfo = value; },
    callRpc: async (method, params) => (rpc ? rpc(method, params) : { ok: true, result: {} }),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    emitJson: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    daemonLog: () => 0,
  });
  return { cmd, printed };
}

test('daemon status 未运行时提示', async () => {
  const { cmd, printed } = makeCommand();
  assert.equal(await cmd({}, ['daemon', 'status']), 0);
  assert.match(printed.join('\n'), /daemon 未运行/);
});

test('daemon status 运行中输出 pid/port/uptime', async () => {
  const { cmd, printed } = makeCommand({
    locate: { info: { port: 52900 }, health: { pid: 12, port: 52900, version: '0.3.0', uptimeMs: 65_000, browsers: 1, sessions: 2 } },
  });
  assert.equal(await cmd({}, ['daemon', 'status']), 0);
  const text = printed.join('\n');
  assert.match(text, /pid 12/);
  assert.match(text, /1m 5s/);
  assert.match(text, /browsers 1/);
});

test('daemon devices 打印连接/已知设备计数', async () => {
  const { cmd, printed } = makeCommand({
    rpc: (method) => (method === 'pair.list' ? { ok: true, result: { devices: [{ instanceId: 'i1', browser: 'edge' }], knownDevices: [{ deviceId: 'd1', browser: 'chrome' }], pairings: [] } } : { ok: true, result: {} }),
  });
  assert.equal(await cmd({}, ['daemon', 'devices']), 0);
  const text = printed.join('\n');
  assert.match(text, /已连接远程浏览器：1/);
  assert.match(text, /已记住远程设备：1/);
  assert.match(text, /未使用配对码：0/);
});

test('daemon trust-local 非法值抛错；rotate 打印 pending 链接', async () => {
  const { cmd, printed } = makeCommand({
    rpc: (method) => (method === 'pair.rotate' ? { ok: true, result: { link: 'ws://x#t' } } : { ok: true, result: {} }),
  });
  await assert.rejects(() => cmd({}, ['daemon', 'trust-local', 'maybe']), /用法/);
  assert.equal(await cmd({}, ['daemon', 'rotate']), 0);
  assert.match(printed.join('\n'), /rotation 已开始（pending/);
  assert.match(printed.join('\n'), /ws:\/\/x#t/);
});
