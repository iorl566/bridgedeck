import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoctorCommand } from '../../cli/commands/doctor.mjs';

function makeCommand({ locate, rpc }) {
  const printed = [];
  const emitted = [];
  const cmd = createDoctorCommand({
    HOME_DIR: '.',
    DAEMON_JSON_PATH: 'daemon.json',
    LOG_PATH: 'daemon.log',
    REPO_ROOT: '.',
    locateDaemon: async () => locate,
    postRpc: async (info, method) => rpc(method),
    readDaemonInfo: () => locate.info,
    readTailLines: () => ['ok line'],
    emitJson: (payload) => emitted.push(payload),
    isJson: () => false,
    print: (line) => printed.push(line),
  });
  return { cmd, printed, emitted };
}

test('doctor daemon 未运行：fail 且退出 1', async () => {
  const { cmd, printed } = makeCommand({
    locate: { info: null, health: null },
    rpc: () => ({ ok: false }),
  });
  assert.equal(await cmd({}), 1);
  const text = printed.join('\n');
  assert.match(text, /\[fail\]/);
  assert.match(text, /daemon/);
});

test('doctor daemon 运行：输出 token/browsers/sessions 与配对/安装/TLS', async () => {
  const { cmd, printed } = makeCommand({
    locate: { info: { port: 52900 }, health: { pid: 1, port: 52900, uptimeMs: 1000, browsers: 1, sessions: 0 } },
    rpc: (method) => {
      if (method === 'status') return { ok: true, result: {} };
      if (method === 'diagnostics.ui') return { ok: true, result: { ok: true, packageVersion: '0.3.0' } };
      if (method === 'pair.list') return { ok: true, result: { strict: false, knownDevices: [], pairings: [] } };
      if (method === 'browsers') return { ok: true, result: { browsers: [{ localAuth: 'unpaired' }] } };
      return { ok: true, result: {} };
    },
  });
  assert.equal(await cmd({}), 0);
  const text = printed.join('\n');
  assert.match(text, /token/);
  assert.match(text, /browsers/);
  assert.match(text, /pairing/);
  assert.match(text, /install/);
  assert.match(text, /tls/);
  assert.match(text, /log-errors/);
});

test('doctor --json：单行 JSON 含 checks', async () => {
  const { cmd, emitted } = makeCommand({
    locate: { info: { port: 52900 }, health: { pid: 1, port: 52900, uptimeMs: 1000, browsers: 0, sessions: 0 } },
    rpc: (method) => (method === 'status' ? { ok: true, result: {} } : { ok: true, result: {} }),
  });
  // 使用 isJson 版本
  const printed = [];
  const out = [];
  const jsonCmd = createDoctorCommand({
    HOME_DIR: '.', DAEMON_JSON_PATH: 'daemon.json', LOG_PATH: 'daemon.log', REPO_ROOT: '.',
    locateDaemon: async () => ({ info: { port: 52900 }, health: { pid: 1, port: 52900, uptimeMs: 1000, browsers: 0, sessions: 0 } }),
    postRpc: async (info, method) => (method === 'status' ? { ok: true, result: {} } : { ok: true, result: {} }),
    readDaemonInfo: () => ({ port: 52900 }),
    readTailLines: () => [],
    emitJson: (payload) => out.push(payload),
    isJson: () => true,
    print: (line) => printed.push(line),
  });
  await jsonCmd({});
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].result.checks));
  assert.ok(out[0].result.checks.some((item) => item.name === 'pairing'));
});
