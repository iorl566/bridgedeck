// tests/discovery.test.ts —— 端口锚点解析 + 多端口连接编排（纯逻辑/假 socket，不需要浏览器）。
//
// 关键回归：tools/e2e.mjs 会把产物里的 `const PORTS = [...]` 改写成“本次 daemon 端口”，
// 所以这里必须覆盖“单端口改写文本”“多端口默认文本”“没有锚点行回退 null”“非法端口被过滤”。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CANDIDATE_PORTS,
  explicitSettingsPort,
  isValidPort,
  loadPortsAsset,
  normalizePortCandidates,
  parsePortsAsset,
  PORTS_ASSET_PATH,
  resolvePortCandidates,
} from '../src/daemon/discovery.ts';
import {
  createDaemonConnector,
  DaemonConnector,
  type ConnectableSocket,
} from '../src/daemon/connector.ts';
import { isDaemonRpcError } from '../src/daemon/errors.ts';

const DEFAULT_ASSET = `// src/ws-client.js —— 端口锚点
const PORTS = [52900, 52901, 52902, 52903, 52904, 52905, 52906, 52907, 52908, 52909];
export { PORTS };
`;

test('parsePortsAsset：默认多端口文本与 E2E 改写后的单端口文本都能解析', () => {
  assert.equal(PORTS_ASSET_PATH, 'src/ws-client.js');
  assert.deepEqual(parsePortsAsset(DEFAULT_ASSET), [...DEFAULT_CANDIDATE_PORTS]);
  // E2E 的改写结果形态（tools/e2e.mjs 只替换数组字面量）。
  assert.deepEqual(parsePortsAsset('const PORTS = [53907];'), [53907]);
  assert.deepEqual(parsePortsAsset('  const PORTS=[61234, 61235];  '), [61234, 61235]);

  // 非法/越界端口被过滤，重复去重。
  assert.deepEqual(parsePortsAsset('const PORTS = [0, -1, 65536, 70000, 52900, 52900];'), [52900]);
  assert.deepEqual(parsePortsAsset('const PORTS = [];'), []);

  // 没有锚点行 → null（调用方回退默认表）。
  assert.equal(parsePortsAsset('const OTHER = [1];'), null);
  assert.equal(parsePortsAsset(''), null);
  assert.equal(parsePortsAsset(null), null);
  assert.equal(parsePortsAsset(42), null);
  // 只认整行形状：注释里的伪锚点不会被误读。
  assert.equal(parsePortsAsset('// const PORTS = [1,2];'), null);
});

test('normalizePortCandidates / isValidPort：合法端口边界', () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort('52900'), true);
  assert.equal(isValidPort(1.5), false);
  assert.deepEqual(normalizePortCandidates([52901, 52901, '52902', 0]), [52901, 52902]);
  assert.deepEqual(normalizePortCandidates('nope'), []);
});

test('explicitSettingsPort：只有用户真写过 daemonPort 才算显式（缺省 52900 不能盖过锚点）', () => {
  assert.equal(explicitSettingsPort(null), null);
  assert.equal(explicitSettingsPort({}), null);
  assert.equal(explicitSettingsPort({ borrowRequireConfirm: true }), null);
  assert.equal(explicitSettingsPort({ daemonPort: 'nope' }), null);
  assert.equal(explicitSettingsPort({ daemonPort: 0 }), null);
  assert.equal(explicitSettingsPort({ daemonPort: 53001 }), 53001);
  assert.equal(explicitSettingsPort({ daemonPort: '53002' }), 53002);

  // 回归：E2E 改写锚点为 53907 时，未配置过 daemonPort 的扩展必须先试 53907。
  assert.deepEqual(
    resolvePortCandidates({ settingsPort: explicitSettingsPort({ borrowRequireConfirm: true }), assetPorts: parsePortsAsset('const PORTS = [53907];') }),
    [53907, 52900],
  );
});

test('resolvePortCandidates：settings → lastPort → 锚点 → 默认，去重且非空', () => {  assert.deepEqual(
    resolvePortCandidates({ settingsPort: 60001, lastPort: 60002, assetPorts: [53907, 52900] }),
    [60001, 60002, 53907, 52900],
  );
  // 锚点优先级高于默认表；没有锚点时用默认表。
  assert.deepEqual(resolvePortCandidates({ assetPorts: [53907] }), [53907, 52900]);
  assert.deepEqual(resolvePortCandidates({}, ), [52900, ...DEFAULT_CANDIDATE_PORTS].filter((port, index, list) => list.indexOf(port) === index));
  // 非法值被过滤；永远至少含默认端口。
  assert.deepEqual(resolvePortCandidates({ settingsPort: 0, lastPort: -1, assetPorts: [] }), [...DEFAULT_CANDIDATE_PORTS]);
  assert.deepEqual(resolvePortCandidates({ assetPorts: null }), [...DEFAULT_CANDIDATE_PORTS]);
  assert.deepEqual(resolvePortCandidates({ defaults: [60010] }), [60010, 52900]);

  // 与 JS 扩展的端口表一致（M-C 兼容基线）。
  assert.deepEqual([...DEFAULT_CANDIDATE_PORTS], [52900, 52901, 52902, 52903, 52904, 52905, 52906, 52907, 52908, 52909]);
});

test('loadPortsAsset：成功解析；网络/HTTP 失败回退 null', async () => {
  const ok = await loadPortsAsset('chrome-extension://x/src/ws-client.js', async () => ({
    ok: true,
    text: async () => 'const PORTS = [53907];',
  }));
  assert.deepEqual(ok, [53907]);

  const httpFail = await loadPortsAsset('chrome-extension://x/src/ws-client.js', async () => ({
    ok: false,
    text: async () => '',
  }));
  assert.equal(httpFail, null);

  const networkFail = await loadPortsAsset('chrome-extension://x/src/ws-client.js', async () => {
    throw new Error('network');
  });
  assert.equal(networkFail, null);
});

// ---------------------------------------------------------------------------
// DaemonConnector
// ---------------------------------------------------------------------------

class FakeSocket implements ConnectableSocket {
  readonly url: string;
  readonly port: number;
  private options: { behavior?: 'ok' | 'fail' | 'flaky'; recoverOnEnsure?: boolean };
  state = 'idle';
  connected = false;
  starts = 0;
  stops = 0;
  connectCalls = 0;

  constructor(
    port: number,
    options: { behavior?: 'ok' | 'fail' | 'flaky'; recoverOnEnsure?: boolean } = {},
  ) {
    this.port = port;
    this.options = options;
    this.url = 'ws://127.0.0.1:' + String(port) + '/ws?role=extension';
  }

  start(): void {
    this.starts += 1;
    if (this.state !== 'connected') this.state = 'connecting';
  }

  stop(): void {
    this.stops += 1;
    this.state = 'closed';
    this.connected = false;
  }

  async ensureConnected(): Promise<void> {
    this.connectCalls += 1;
    const behavior = this.options.behavior ?? 'ok';
    if (behavior === 'fail') throw new Error('connect refused ' + String(this.port));
    if (behavior === 'flaky' && this.connectCalls === 1 && this.options.recoverOnEnsure !== true) {
      throw new Error('first attempt failed');
    }
    this.connected = true;
    this.state = 'connected';
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 测试驱动：切换连接行为。 */
  setBehavior(behavior: 'ok' | 'fail' | 'flaky'): void {
    this.options = { behavior };
  }
}

function socketFactory(behaviorByPort: Record<number, 'ok' | 'fail'>, sockets: FakeSocket[]) {
  return (port: number): ConnectableSocket => {
    const socket = new FakeSocket(port, { behavior: behaviorByPort[port] ?? 'ok' });
    sockets.push(socket);
    return socket;
  };
}

test('DaemonConnector：按候选顺序试端口，第一个成功即停，后续端口不再尝试', async () => {
  const sockets: FakeSocket[] = [];
  const connected: number[] = [];
  const connector = createDaemonConnector({
    socketFactory: socketFactory({ 52901: 'fail', 52902: 'fail' }, sockets),
    candidatePorts: [52900, 52901, 52902, 52903],
    onConnected: (_socket, port) => connected.push(port),
  });
  const socket = await connector.ensure();
  assert.equal(connector.isConnected(), true);
  assert.equal(connector.currentPort(), 52900);
  assert.deepEqual(connected, [52900]);
  assert.equal(sockets.length, 1);
  assert.equal(socket.isConnected(), true);
  assert.deepEqual(connector.attempts().map((attempt) => [attempt.port, attempt.ok]), [[52900, true]]);
  assert.equal(connector.snapshot().connected, true);

  // 已连接时 ensure 幂等：不再新建 socket。
  const again = await connector.ensure();
  assert.equal(again, socket);
  assert.equal(sockets.length, 1);
});

test('DaemonConnector：前面的端口失败后换下一个；全部失败抛 E_NO_DAEMON 且带 attempts', async () => {
  const sockets: FakeSocket[] = [];
  const connector = createDaemonConnector({
    socketFactory: socketFactory({ 52900: 'fail', 52901: 'fail' }, sockets),
    candidatePorts: [52900, 52901, 52902],
  });
  const socket = await connector.ensure();
  assert.equal((socket as FakeSocket).port, 52902);
  assert.deepEqual(sockets.map((item) => item.port), [52900, 52901, 52902]);
  assert.equal(sockets[0]?.stops, 1, '失败端口应被 stop');
  const attempts = connector.attempts();
  assert.deepEqual(attempts.map((attempt) => attempt.ok), [false, false, true]);
  assert.match(attempts[0]?.reason ?? '', /connect refused/);

  const failing = createDaemonConnector({
    socketFactory: socketFactory({ 52900: 'fail', 52901: 'fail' }, []),
    candidatePorts: [52900, 52901],
  });
  await assert.rejects(failing.ensure(), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_NO_DAEMON');
    const data = error.data as { attempts?: Array<{ port: number }>; candidatePorts?: number[] };
    assert.equal(data.attempts?.length, 2);
    assert.deepEqual(data.candidatePorts, [52900, 52901]);
    return true;
  });
  assert.equal(failing.isConnected(), false);
  assert.match(failing.snapshot().lastError ?? '', /连不上 daemon/);
});

test('DaemonConnector：并发 ensure 只发起一轮探测；失败后可以重试成功', async () => {
  const sockets: FakeSocket[] = [];
  let calls = 0;
  const connector = createDaemonConnector({
    socketFactory: (port) => {
      calls += 1;
      const behavior: 'ok' | 'fail' = calls === 1 ? 'fail' : 'ok';
      const socket = new FakeSocket(port, { behavior });
      sockets.push(socket);
      return socket;
    },
    candidatePorts: [52900],
  });

  const [first, second] = await Promise.allSettled([connector.ensure(), connector.ensure()]);
  assert.equal(first?.status, 'rejected');
  assert.equal(second?.status, 'rejected');
  assert.equal(calls, 1, '并发 ensure 应合并成一轮探测');

  const socket = await connector.ensure();
  assert.equal(connector.isConnected(), true);
  assert.equal(socket, connector.current());
  assert.equal(calls, 2);
});

test('DaemonConnector：当前连接断开时优先尝试它自己的重连，失败再按候选换端口', async () => {
  const sockets: FakeSocket[] = [];
  const connector = createDaemonConnector({
    socketFactory: (port) => {
      const socket = new FakeSocket(port, { behavior: sockets.length === 0 ? 'ok' : 'ok' });
      sockets.push(socket);
      return socket;
    },
    candidatePorts: [52900, 52901],
  });
  const socket = await connector.ensure() as FakeSocket;
  socket.connected = false;
  socket.state = 'reconnecting';

  const recovered = await connector.ensure();
  assert.equal(recovered, socket, '应优先恢复当前 socket');
  assert.equal(socket.connectCalls, 2);

  // 当前 socket 恢复失败 → 放弃它，重新按候选探测（新 socket 接管）。
  socket.connected = false;
  socket.setBehavior('fail');
  const next = await connector.ensure() as FakeSocket;
  assert.notEqual(next, socket);
  assert.equal(next.port, 52900);
  assert.deepEqual(sockets.map((item) => item.port), [52900, 52900]);
  assert.equal(connector.isConnected(), true);
});

test('DaemonConnector：stop/reconnect 清空状态', async () => {
  const sockets: FakeSocket[] = [];
  const connector = new DaemonConnector({
    socketFactory: socketFactory({}, sockets),
    candidatePorts: [52900],
  });
  const socket = await connector.ensure() as FakeSocket;
  assert.equal(connector.isConnected(), true);

  connector.stop();
  assert.equal(connector.isConnected(), false);
  assert.equal(connector.current(), null);
  assert.equal(socket.stops, 1);

  const reconnected = await connector.reconnect() as FakeSocket;
  assert.notEqual(reconnected, socket);
  assert.equal(connector.isConnected(), true);
});

test('DaemonConnector：候选端口读取抛错时给 E_NO_DAEMON（不吞异常）', async () => {
  const connector = new DaemonConnector({
    socketFactory: socketFactory({}, []),
    candidatePorts: async () => {
      throw new Error('settings unavailable');
    },
  });
  await assert.rejects(connector.ensure(), (error: unknown) => {
    assert.ok(isDaemonRpcError(error));
    assert.equal(error.code, 'E_NO_DAEMON');
    assert.match(error.message, /候选端口/);
    return true;
  });
});
