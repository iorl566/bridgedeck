import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION } from '../../extension/src/transport/handshake.js';
import { ConnectionController, computeConnectedState } from '../../extension/src/lib/connection-controller.js';

const BROWSER = { name: 'Chrome', version: '125' };

function handshake(protocol = PROTOCOL_VERSION, { peerFloor = MIN_COMPATIBLE_PROTOCOL, version = '0.9.0' } = {}) {
  return {
    server: 'test-daemon',
    version,
    protocol_version: protocol,
    min_compatible_peer: '0.0.0',
    ...(peerFloor === null ? {} : { min_compatible_protocol: peerFloor }),
  };
}

function installStorage({ instanceId = 'a1b2c3d4', label = 'test-label' } = {}) {
  const state = { instanceId, label };
  globalThis.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, callback) {
          queueMicrotask(() => callback({ bb_instance_id: state.instanceId, bb_label: state.label }));
        },
        set(items, callback) { queueMicrotask(() => callback()); },
      },
    },
  };
  return { setLabel(next) { state.label = next; } };
}

function makeTransport() {
  let state = 'disconnected';
  const stateHandlers = new Set();
  const messageHandlers = new Set();
  const sent = [];
  const transport = {
    sent,
    connectCalls: 0,
    disconnectCalls: 0,
    get state() { return state; },
    async connect() {
      transport.connectCalls += 1;
      state = 'connected';
      for (const handler of [...stateHandlers]) handler('connected');
    },
    async disconnect() {
      transport.disconnectCalls += 1;
      state = 'disconnected';
      for (const handler of [...stateHandlers]) handler('disconnected');
    },
    send(frame) { sent.push(frame); },
    onMessage(handler) {
      messageHandlers.add(handler);
      return { dispose: () => messageHandlers.delete(handler) };
    },
    onConnectionStateChange(handler) {
      stateHandlers.add(handler);
      return { dispose: () => stateHandlers.delete(handler) };
    },
    emitState(next) {
      state = next;
      for (const handler of [...stateHandlers]) handler(next);
    },
    replyTo(id, payload) {
      for (const handler of [...messageHandlers]) handler({ id, ...payload });
    },
    reply(payload) { transport.replyTo(sent.at(-1).id, payload); },
  };
  return transport;
}

async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

async function attachController(t, { enabled = true, hooks = {}, storage } = {}) {
  const storageState = installStorage(storage);
  const transport = makeTransport();
  const controller = new ConnectionController();
  t.after(async () => {
    try { await controller.setConnectionEnabled(false); } catch { /* best effort */ }
  });
  await controller.attach(transport, BROWSER, enabled, hooks);
  return { controller, transport, storageState };
}

test('computeConnectedState enforces major, local floor and peer floor', () => {
  assert.deepEqual(computeConnectedState(handshake()), { kind: 'connected' });
  assert.deepEqual(computeConnectedState(handshake('1.10')), { kind: 'version_skew' });
  assert.deepEqual(computeConnectedState(handshake(`${PROTOCOL_VERSION}.0`)), { kind: 'version_skew' });

  const major = computeConnectedState(handshake('2.0'));
  assert.equal(major.kind, 'rejected');
  assert.match(major.reason, /protocol-major mismatch/);

  const belowLocal = computeConnectedState(handshake('1.5'));
  assert.equal(belowLocal.kind, 'rejected');
  assert.match(belowLocal.reason, /below extension min_compatible_protocol 1\.6/);

  const customFloor = computeConnectedState(handshake('1.7'), '1.8');
  assert.equal(customFloor.kind, 'rejected');
  assert.match(customFloor.reason, /min_compatible_protocol 1\.8/);

  const belowPeer = computeConnectedState(handshake(PROTOCOL_VERSION, { peerFloor: '1.10' }));
  assert.equal(belowPeer.kind, 'rejected');
  assert.match(belowPeer.reason, /extension protocol v1\.9 below daemon min_compatible_protocol 1\.10/);

  const badPeer = computeConnectedState(handshake(PROTOCOL_VERSION, { peerFloor: 'oops' }));
  assert.equal(badPeer.kind, 'rejected');
  assert.match(badPeer.reason, /daemon min_compatible_protocol oops is unparseable/);

  const legacyPeer = computeConnectedState(handshake(PROTOCOL_VERSION, { peerFloor: null }));
  assert.deepEqual(legacyPeer, { kind: 'connected' });

  const badDaemon = computeConnectedState(handshake('oops'));
  assert.equal(badDaemon.kind, 'rejected');

  const badLocalFloor = computeConnectedState(handshake(PROTOCOL_VERSION), 'oops');
  assert.equal(badLocalFloor.kind, 'rejected');
  assert.match(badLocalFloor.reason, /daemon protocol v1\.9 is unparseable/);
});

test('attach hydrates identity without connecting when disabled', async (t) => {
  const { controller, transport } = await attachController(t, {
    enabled: false,
    storage: { instanceId: 'deadbeef', label: 'Work' },
  });

  assert.equal(transport.connectCalls, 0);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.state, 'disconnected');
  assert.equal(snapshot.connectionEnabled, false);
  assert.equal(snapshot.instanceId, 'deadbeef');
  assert.equal(snapshot.label, 'Work');
  assert.equal(snapshot.handshake, null);
  assert.equal(snapshot.lastError, null);
  assert.equal(typeof snapshot.extensionVersion, 'string');
  assert.equal(controller.isConnectionEnabled, false);
});

test('attach connects and a compatible handshake becomes connected', async (t) => {
  const { controller, transport } = await attachController(t);

  assert.equal(transport.connectCalls, 1);
  assert.equal(transport.sent.length, 1);
  const request = transport.sent[0];
  assert.equal(request.method, 'system.handshake');
  assert.equal(request.params.instance_id, 'a1b2c3d4');
  assert.equal(request.params.label, 'test-label');
  assert.deepEqual(request.params.browser, BROWSER);
  assert.equal(request.params.protocol_version, PROTOCOL_VERSION);
  assert.equal(request.params.min_compatible_protocol, MIN_COMPATIBLE_PROTOCOL);
  assert.equal(request.params.audit_enabled, false);

  const result = handshake();
  transport.reply({ result });
  await flush();

  assert.equal(controller.snapshot().state, 'connected');
  assert.deepEqual(controller.snapshot().handshake, result);
  assert.equal(controller.snapshot().lastError, null);
  assert.equal(controller.snapshot().daemonUpgradeRequired, null);
});

test('an old daemon rejection records upgrade guidance and disconnects', async (t) => {
  const { controller, transport } = await attachController(t);
  const error = {
    code: 'version_too_old',
    message: 'local protocol 1.3 is below peer min_compatible_protocol 1.6',
    data: { daemon_version: '0.3.3', daemon_protocol_version: '1.3' },
  };

  transport.reply({ error });
  assert.deepEqual(controller.snapshot().daemonUpgradeRequired, {
    daemonVersion: '0.3.3',
    daemonProtocolVersion: '1.3',
    requiredProtocolVersion: MIN_COMPATIBLE_PROTOCOL,
  });
  assert.match(controller.snapshot().lastError, /local protocol 1\.3/);

  await flush();
  assert.equal(transport.disconnectCalls, 1);
  assert.equal(controller.snapshot().state, 'disconnected');
  assert.equal(controller.snapshot().handshake, null);
  assert.equal(transport.sent.length, 1);
});

test('upgrade guidance survives a socket close and clears after a successful retry', async (t) => {
  let disconnectedCalls = 0;
  const { controller, transport } = await attachController(t, {
    hooks: { onDisconnected: () => { disconnectedCalls += 1; } },
  });

  transport.reply({
    error: {
      code: 'version_too_old',
      message: 'local protocol 1.3 is below peer min_compatible_protocol 1.6',
      data: { daemon_version: '0.3.3', daemon_protocol_version: '1.3' },
    },
  });
  transport.emitState('disconnected');
  await flush();

  assert.equal(disconnectedCalls, 1);
  assert.equal(transport.connectCalls, 2);
  assert.equal(transport.sent.length, 2);
  assert.deepEqual(controller.snapshot().daemonUpgradeRequired, {
    daemonVersion: '0.3.3',
    daemonProtocolVersion: '1.3',
    requiredProtocolVersion: MIN_COMPATIBLE_PROTOCOL,
  });
  assert.match(controller.snapshot().lastError, /local protocol 1\.3/);
  assert.equal(controller.snapshot().handshake, null);

  transport.reply({ result: handshake(PROTOCOL_VERSION, { version: '0.4.0' }) });
  await flush();

  assert.equal(controller.snapshot().state, 'connected');
  assert.equal(controller.snapshot().daemonUpgradeRequired, null);
  assert.equal(controller.snapshot().lastError, null);
});

test('a fresh rejection replaces stale daemon upgrade guidance', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let controller;
  let transport;
  try {
    ({ controller, transport } = await attachController(t));

    transport.reply({
      error: {
        code: 'version_too_old',
        message: 'local protocol 1.3 is below peer min_compatible_protocol 1.6',
        data: { daemon_version: '0.3.3', daemon_protocol_version: '1.3' },
      },
    });
    await flush();
    assert.equal(controller.snapshot().daemonUpgradeRequired.daemonProtocolVersion, '1.3');

    mock.timers.tick(1_000);
    await flush();
    assert.equal(transport.connectCalls, 2);
    assert.equal(transport.sent.length, 2);

    transport.reply({ error: { code: 'protocol_error', message: 'bad handshake' } });
    assert.equal(controller.snapshot().daemonUpgradeRequired, null);
    assert.match(controller.snapshot().lastError, /bad handshake/);
    await flush();
  } finally {
    if (controller) {
      try { await controller.setConnectionEnabled(false); } catch { /* best effort */ }
    }
    mock.timers.reset();
  }
});

test('unexpected transport loss runs cleanup after the disconnect and reconnects', async (t) => {
  const order = [];
  const { controller, transport } = await attachController(t, {
    hooks: {
      beforeDisconnect: () => { order.push('before'); },
      onDisconnected: () => { order.push('after'); },
    },
  });
  const originalDisconnect = transport.disconnect.bind(transport);
  transport.disconnect = async () => {
    order.push('disconnect');
    await originalDisconnect();
  };

  transport.emitState('disconnected');
  await flush();

  assert.deepEqual(order, ['disconnect', 'after']);
  assert.equal(transport.connectCalls, 2);
  assert.equal(controller.snapshot().connectionEnabled, true);
});

test('disabling runs safe cleanup before disconnect without onDisconnected', async (t) => {
  const order = [];
  const { controller, transport } = await attachController(t, {
    hooks: {
      beforeDisconnect: () => { order.push('before'); },
      onDisconnected: () => { order.push('after'); },
    },
  });
  const originalDisconnect = transport.disconnect.bind(transport);
  transport.disconnect = async () => {
    order.push('disconnect');
    await originalDisconnect();
  };

  await controller.setConnectionEnabled(false);

  assert.deepEqual(order, ['before', 'disconnect']);
  assert.equal(controller.snapshot().state, 'disconnected');
  assert.equal(controller.snapshot().handshake, null);
  assert.equal(controller.snapshot().lastError, null);
});

test('re-enabling after a disabled attach connects again', async (t) => {
  const { controller, transport } = await attachController(t, { enabled: false });

  await controller.setConnectionEnabled(true);
  await flush();

  assert.equal(controller.snapshot().connectionEnabled, true);
  assert.equal(transport.connectCalls, 1);
  assert.equal(transport.sent.length, 1);

  transport.reply({ result: handshake() });
  await flush();
  assert.equal(controller.snapshot().state, 'connected');
});

test('reconfiguration applies only the latest pending change', async (t) => {
  const transport = makeTransport();
  const controller = new ConnectionController();
  t.after(async () => {
    try { await controller.setConnectionEnabled(false); } catch { /* best effort */ }
  });

  const applied = [];
  const first = controller.reconfigureTransport('device', () => applied.push('old'));
  const second = controller.reconfigureTransport('device', () => applied.push('new'));
  await Promise.all([first, second]);
  assert.deepEqual(applied, []);

  await controller.attach(transport, BROWSER, true);
  assert.deepEqual(applied, ['new']);
});

test('a different configuration key tears down and clears guidance', async (t) => {
  const { controller, transport } = await attachController(t);

  const applied = [];
  await controller.reconfigureTransport('device', () => applied.push('first'));
  await flush();
  assert.deepEqual(applied, ['first']);
  assert.equal(transport.connectCalls, 2);

  const before = transport.connectCalls;
  await controller.reconfigureTransport('device', () => applied.push('again'));
  assert.deepEqual(applied, ['first']);
  assert.equal(transport.connectCalls, before);

  transport.reply({
    error: {
      code: 'version_too_old',
      message: 'old daemon',
      data: { daemon_protocol_version: '1.3' },
    },
  });
  assert.notEqual(controller.snapshot().daemonUpgradeRequired, null);

  await controller.reconfigureTransport('other', () => applied.push('other'));
  assert.equal(controller.snapshot().daemonUpgradeRequired, null);
  assert.equal(controller.snapshot().lastError, null);
  assert.deepEqual(applied, ['first', 'other']);
});

test('refreshLabel reconnects only when the saved label changes', async (t) => {
  const { controller, transport, storageState } = await attachController(t);
  transport.reply({ result: handshake() });
  await flush();
  assert.equal(controller.snapshot().state, 'connected');

  await controller.refreshLabel();
  assert.equal(transport.connectCalls, 1);
  assert.equal(transport.disconnectCalls, 0);

  storageState.setLabel('Work profile');
  await controller.refreshLabel();
  await flush();

  assert.equal(controller.snapshot().label, 'Work profile');
  assert.equal(transport.connectCalls, 2);
  assert.equal(transport.sent.at(-1).params.label, 'Work profile');
});

test('late replies from an old handshake cannot clobber the new connection', async (t) => {
  const { controller, transport } = await attachController(t);
  const first = transport.sent[0];

  transport.emitState('disconnected');
  await flush();
  const second = transport.sent[1];
  assert.notEqual(second, undefined);

  transport.replyTo(first.id, { result: handshake() });
  await flush();
  assert.notEqual(controller.snapshot().state, 'connected');

  transport.replyTo(second.id, { result: handshake() });
  await flush();
  assert.equal(controller.snapshot().state, 'connected');
});

test('connect failures surface the transport error', async (t) => {
  const transport = makeTransport();
  transport.connect = async () => {
    transport.connectCalls += 1;
    throw new Error('connection refused');
  };
  const controller = new ConnectionController();
  t.after(async () => {
    try { await controller.setConnectionEnabled(false); } catch { /* best effort */ }
  });

  await controller.attach(transport, BROWSER, true);
  await flush();

  assert.equal(controller.snapshot().lastError, 'connection refused');
  assert.equal(controller.snapshot().state, 'disconnected');
  assert.equal(transport.sent.length, 0);
});

test('cleanup failures surface and keep the new connection blocked', async (t) => {
  let failures = 1;
  const cleanupCalls = [];
  const { controller, transport } = await attachController(t, {
    hooks: {
      onDisconnected: async () => {
        cleanupCalls.push('cleanup');
        if (failures > 0) {
          failures -= 1;
          throw new Error('tab return failed');
        }
      },
    },
  });

  transport.emitState('disconnected');
  await flush();
  assert.equal(controller.snapshot().lastError, 'tab return failed');
  assert.equal(transport.connectCalls, 1);

  controller.requestConnect();
  await flush();
  assert.deepEqual(cleanupCalls, ['cleanup', 'cleanup']);
  assert.equal(transport.connectCalls, 2);
  assert.equal(controller.snapshot().lastError, null);
});

test('unrelated or malformed rejections do not advertise a daemon upgrade', async (t) => {
  const cases = [
    { code: 'protocol_error', message: 'bad handshake', data: { daemon_protocol_version: '1.3' } },
    { code: 'version_too_old', message: 'upgrade', data: { daemon_protocol_version: 1.3 } },
    { code: 'version_too_old', message: 'upgrade', data: { daemon_protocol_version: '1.6' } },
    { code: 'version_too_old', message: 'upgrade', data: { daemon_protocol_version: 'invalid' } },
  ];

  for (const error of cases) {
    const { controller, transport } = await attachController(t);
    transport.reply({ error });
    assert.equal(controller.snapshot().daemonUpgradeRequired, null);
    assert.match(controller.snapshot().lastError, new RegExp(error.message));
    await flush();
    await controller.setConnectionEnabled(false);
  }
});

test('a throwing snapshot listener does not break other listeners', async (t) => {
  const { controller } = await attachController(t, { enabled: false });
  let shouldThrow = false;
  controller.subscribe(() => { if (shouldThrow) throw new Error('listener failed'); });
  const seen = [];
  controller.subscribe((snapshot) => seen.push(snapshot.localAuth));

  shouldThrow = true;
  controller.setLocalAuth({ state: 'paired' });

  assert.deepEqual(seen, [null, { state: 'paired' }]);
});
