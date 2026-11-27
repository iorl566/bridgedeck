// tests/rpc-registry.test.ts —— RPC 注册表、feature gate、只读白名单、编解码、事件分发单测。
//
// 这里的“协议事实”全部来自 packages/protocol（165 方法 / 9 feature floor），测试只验证
// 本层如何消费它们：
// - 1.8 对端在派发前被 E_PROTOCOL_UNSUPPORTED 拒绝，异常携带 missing/required 证据；
// - 转发严格受只读白名单约束（与 daemon WS_CALL_METHODS 一致）；
// - 畸形请求/回包不抛异常而是结构化回包；
// - 事件分发隔离订阅者异常并保留历史。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  METHOD_COUNT,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  ProtocolError,
  requireCatalogRow as assertCatalogRow,
} from '../../../packages/protocol/src/index.ts';
import type { ProtocolErrorData } from '../../../packages/protocol/src/index.ts';
import {
  catalogReadonlyMethods,
  createRpcRegistry,
  encodeRpcReply,
  encodeRpcRequest,
  isCatalogMethod,
  isCatalogReadonlyMethod,
  isReadonlyMethod,
  parseRpcReply,
  parseRpcRequest,
  readonlyRejection,
  RpcEventDispatcher,
  RpcMethodError,
  RpcRegistry,
  rpcErrorPayloadOf,
  WS_READONLY_METHODS,
} from '../src/rpc/registry.ts';
import { errorPayloadOf, DaemonRpcError } from '../src/daemon/errors.ts';
import type { DaemonCallOptions, DaemonRpcTransport } from '../src/daemon/types.ts';

// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

class FakeTransport implements DaemonRpcTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; options: DaemonCallOptions }> = [];
  handler: (method: string, params: Record<string, unknown>) => unknown;

  constructor(handler: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true })) {
    this.handler = handler;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, options: DaemonCallOptions = {}): Promise<T> {
    this.calls.push({ method, params, options });
    return Promise.resolve(this.handler(method, params) as T);
  }
}

function protocolUnsupportedData(overrides: Partial<ProtocolErrorData> = {}): ProtocolErrorData {
  return {
    code: 'E_PROTOCOL_UNSUPPORTED',
    method: 'read',
    feature: 'read',
    features: ['read'],
    missing: [{ feature: 'read', required: '1.9', actual: '1.8' }],
    required: '1.9',
    actual: '1.8',
    // packages/protocol 的 ProtocolErrorData 带历史兼容码（W4-C 起为必填字段）。
    legacyCode: 'E_UNSUPPORTED_CAPABILITY',
    aliasCodes: ['E_PROTOCOL_UNSUPPORTED', 'E_UNSUPPORTED_CAPABILITY'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 编解码
// ---------------------------------------------------------------------------

test('parseRpcRequest：合法形态被规范化', () => {
  const simple = parseRpcRequest({ type: 'bb.rpc', method: 'status' });
  assert.ok(simple.ok);
  assert.deepEqual(simple.request, { method: 'status', params: {} });

  const full = parseRpcRequest({
    method: ' status ',
    params: { limit: 5 },
    timeoutMs: 1234.9,
    id: 'req-1',
    type: 'bb.rpc',
  });
  assert.ok(full.ok);
  assert.deepEqual(full.request, {
    method: 'status',
    params: { limit: 5 },
    timeoutMs: 1234,
    id: 'req-1',
  });

  const nullParams = parseRpcRequest({ method: 'browsers', params: null, timeoutMs: null, id: null });
  assert.ok(nullParams.ok);
  assert.deepEqual(nullParams.request, { method: 'browsers', params: {} });
});

test('parseRpcRequest：畸形输入返回 E_BAD_REQUEST 而不是抛异常', () => {
  const cases: unknown[] = [
    null,
    'status',
    [],
    {},
    { method: '' },
    { method: '   ' },
    { method: 42 },
    { method: 'status', params: [1, 2] },
    { method: 'status', params: 'x' },
    { method: 'status', timeoutMs: 0 },
    { method: 'status', timeoutMs: -5 },
    { method: 'status', timeoutMs: 'abc' },
    { method: 'status', id: '' },
    { method: 'status', id: 12 },
    { method: 'x'.repeat(129) },
  ];
  for (const input of cases) {
    const parsed = parseRpcRequest(input);
    assert.equal(parsed.ok, false, `应拒绝输入：${JSON.stringify(input)}`);
    if (!parsed.ok) assert.equal(parsed.error.code, 'E_BAD_REQUEST');
  }
});

test('encodeRpcRequest：省略空字段并保留 timeout/id', () => {
  assert.deepEqual(encodeRpcRequest({ method: 'status', params: {} }), {
    method: 'status',
    params: {},
  });
  assert.deepEqual(encodeRpcRequest({ method: 'status', params: { x: 1 }, timeoutMs: 100, id: 'a' }), {
    method: 'status',
    params: { x: 1 },
    timeoutMs: 100,
    id: 'a',
  });
});

test('parseRpcReply：成功/失败/畸形三类', () => {
  assert.deepEqual(parseRpcReply({ ok: true, result: { a: 1 } }), { ok: true, result: { a: 1 } });
  assert.deepEqual(
    parseRpcReply({ ok: false, error: { code: 'E_NO_SESSION', message: 'no session', data: { n: 0 } } }),
    { ok: false, error: { code: 'E_NO_SESSION', message: 'no session', data: { n: 0 } } },
  );
  assert.deepEqual(parseRpcReply({ ok: false, error: {} }), {
    ok: false,
    error: { code: 'E_BAD_RESPONSE', message: 'rpc 失败回包缺少 error.code' },
  });
  assert.deepEqual(parseRpcReply({ hello: 1 }), {
    ok: false,
    error: { code: 'E_BAD_RESPONSE', message: 'rpc 回包缺少 ok 字段' },
  });
  assert.deepEqual(parseRpcReply(null), {
    ok: false,
    error: { code: 'E_BAD_RESPONSE', message: 'rpc 回包必须是对象' },
  });
  assert.deepEqual(encodeRpcReply({ ok: true, result: 1 }), { ok: true, result: 1 });
  assert.deepEqual(encodeRpcReply({ ok: false, error: { code: 'E_AUTH', message: 'x' } }), {
    ok: false,
    error: { code: 'E_AUTH', message: 'x' },
  });
});

// ---------------------------------------------------------------------------
// 只读白名单
// ---------------------------------------------------------------------------

test('只读白名单与 daemon §25.3 / WS_CALL_METHODS 一致', () => {
  assert.deepEqual([...WS_READONLY_METHODS], [
    'audit.list',
    'status',
    'session.list',
    'browsers',
    'operations.list',
    'operations.get',
  ]);
  assert.equal(isReadonlyMethod('status'), true);
  assert.equal(isReadonlyMethod('audit.list'), true);
  assert.equal(isReadonlyMethod('navigate'), false);
  assert.equal(isReadonlyMethod('click'), false);
  assert.equal(isReadonlyMethod('session.stop'), false);
  assert.equal(isReadonlyMethod('status', []), false);
  assert.equal(isReadonlyMethod(42), false);
});

test('协议目录只读方法按 effect 派生（与 165 方法目录同源）', () => {
  const readonly = catalogReadonlyMethods();
  assert.ok(readonly.length > 0);
  assert.ok(readonly.includes('observe'));
  assert.ok(readonly.includes('read'));
  assert.ok(readonly.includes('network.list'));
  // status 是 control_plane 不是 passive_read：它靠显式 WS 白名单放行，而不是目录 effect。
  assert.ok(!readonly.includes('status'));
  assert.ok(!readonly.includes('navigate'));
  assert.ok(!readonly.includes('click'));
  assert.ok(!readonly.includes('session.stop'));
  assert.equal(isCatalogReadonlyMethod('observe'), true);
  assert.equal(isCatalogReadonlyMethod('status'), false);
  assert.equal(isCatalogReadonlyMethod('hardly-known-method'), false);
  assert.equal(isCatalogMethod('status'), true);
  assert.equal(isCatalogMethod('not.a.method'), false);
  // 目录行本身可被断言（防止把不存在的名字加入白名单）。
  assert.equal(assertCatalogRow('status').method, 'status');
  assert.ok(METHOD_COUNT >= 165);
  assert.equal(PROTOCOL_BASELINE, '1.8');
  assert.equal(PROTOCOL_CURRENT, '1.9');

  const rejection = readonlyRejection('navigate');
  assert.equal(rejection.code, 'E_METHOD_NOT_ALLOWED');
  assert.match(rejection.message, /navigate/);
  assert.deepEqual((rejection.data as { allowlist: string[] }).allowlist, [...WS_READONLY_METHODS]);
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('注册表：注册/查询/注销/重复注册', () => {
  const registry = new RpcRegistry();
  assert.equal(registry.size, 0);
  registry.registerMethod('status', () => ({ ok: true }));
  assert.equal(registry.has('status'), true);
  assert.equal(registry.size, 1);
  assert.deepEqual(registry.methodsList(), ['status']);
  const entry = registry.get('status');
  assert.ok(entry);
  // 目录行给了 effect/owner；白名单给了 readonly。
  assert.equal(entry.spec.effect, 'control_plane');
  assert.equal(entry.spec.owner, 'local');
  assert.equal(entry.spec.readonly, true);

  assert.throws(() => registry.registerMethod('status', () => ({})), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_DUPLICATE_METHOD');
    return true;
  });
  assert.throws(() => registry.registerMethod('  ', () => ({})), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_BAD_METHOD');
    return true;
  });
  assert.equal(registry.unregister('status'), true);
  assert.equal(registry.unregister('status'), false);
  assert.equal(registry.has('status'), false);
});

test('注册表：目录外的方法用 extension owner / browser_mutation 兜底', () => {
  const registry = new RpcRegistry();
  registry.registerMethod('bb.custom', () => 'ok');
  const entry = registry.get('bb.custom');
  assert.ok(entry);
  assert.equal(entry.spec.owner, 'extension');
  assert.equal(entry.spec.effect, 'browser_mutation');
  assert.equal(entry.spec.readonly, false);
});

test('dispatch：成功、未知方法、非法请求、handler 异常都有结构化回包', async () => {
  const registry = createRpcRegistry();
  const contexts: Array<{ method: string; params: Record<string, unknown>; timeoutMs: number; requestId: string | undefined }> = [];
  registry.registerMethod('status', (context) => {
    contexts.push({ method: context.method, params: context.params, timeoutMs: context.timeoutMs, requestId: context.requestId });
    return { service: 'browser-bridge' };
  });

  const ok = await registry.dispatch({ method: 'status', params: { verbose: true }, timeoutMs: 900, id: 'r1' });
  assert.deepEqual(ok, { ok: true, result: { service: 'browser-bridge' } });
  assert.deepEqual(contexts, [{ method: 'status', params: { verbose: true }, timeoutMs: 900, requestId: 'r1' }]);

  const unknown = await registry.dispatch({ method: 'nope' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, 'E_UNKNOWN_METHOD');
    assert.deepEqual(unknown.error.data, { method: 'nope' });
  }

  const invalid = await registry.dispatch({ method: '' });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'E_BAD_REQUEST');

  registry.registerMethod('bb.boom', () => {
    throw new RpcMethodError('E_STALE_REF', 'ref 失效', { ref: 'e1' });
  });
  const business = await registry.dispatch({ method: 'bb.boom' });
  assert.deepEqual(business, { ok: false, error: { code: 'E_STALE_REF', message: 'ref 失效', data: { ref: 'e1' } } });

  registry.registerMethod('bb.crash', () => {
    throw new Error('unexpected');
  });
  const crash = await registry.dispatch({ method: 'bb.crash' });
  assert.deepEqual(crash, { ok: false, error: { code: 'E_INTERNAL', message: 'unexpected' } });

  registry.registerMethod('bb.async', async () => ({ async: true }));
  assert.deepEqual(await registry.dispatch({ method: 'bb.async' }), { ok: true, result: { async: true } });
});

test('feature gate：1.8 对端在派发前被拒绝，1.9 放行', async () => {
  const oldPeer = new RpcRegistry({ peer: { protocol: '1.8' } });
  let called = 0;
  oldPeer.registerMethod('read', () => {
    called += 1;
    return { text: 'x' };
  });
  const rejected = await oldPeer.dispatch({ method: 'read', params: { ref: 'e1' } });
  assert.equal(called, 0, '被闸门拒绝时不应调用 handler');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.code, 'E_PROTOCOL_UNSUPPORTED');
    const data = rejected.error.data as ProtocolErrorData;
    assert.equal(data.method, 'read');
    assert.equal(data.feature, 'read');
    assert.deepEqual(data.missing, [{ feature: 'read', required: '1.9', actual: '1.8' }]);
    assert.equal(data.required, '1.9');
    assert.equal(data.actual, '1.8');
  }

  const currentPeer = new RpcRegistry({ peer: { protocol: PROTOCOL_CURRENT } });
  currentPeer.registerMethod('read', () => ({ text: 'x' }));
  assert.deepEqual(await currentPeer.dispatch({ method: 'read' }), { ok: true, result: { text: 'x' } });
});

test('feature gate：参数级特性（delta/unverified/expect）也会被拦截', () => {
  const oldPeer = new RpcRegistry({ peer: { protocol: '1.8' } });
  const delta = oldPeer.checkCompatible('observe', { delta: true });
  assert.equal(delta.ok, false);
  if (!delta.ok) {
    assert.equal(delta.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(delta.features.includes('observe-delta'), true);
    assert.equal(delta.data.actual, '1.8');
  }
  const unverified = oldPeer.checkCompatible('evaluate', { unverified: true });
  assert.equal(unverified.ok, false);
  const expect = oldPeer.checkCompatible('click', { expect: [{ selector: '#a' }] });
  assert.equal(expect.ok, false);

  oldPeer.setPeer({ protocol: PROTOCOL_CURRENT });
  assert.equal(oldPeer.checkCompatible('observe', { delta: true }).ok, true);
});

test('assertCompatible 抛 ProtocolError（异常形态与 daemon 一致）', () => {
  const registry = new RpcRegistry({ peer: { protocol: '1.8' } });
  assert.throws(
    () => registry.assertCompatible('video.start'),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
      assert.equal(error.data.method, 'video.start');
      assert.equal(error.data.feature, 'video');
      assert.equal(error.data.missing.length, 1);
      assert.match(error.message, /浏览器扩展协议版本过低/);
      return true;
    },
  );
  const passing = new RpcRegistry().assertCompatible('status');
  assert.equal(passing.ok, true);
  assert.equal(passing.method, 'status');
});

test('assertAllowed：白名单外方法被拒绝', () => {
  const registry = new RpcRegistry();
  assert.equal(registry.isAllowed('status'), true);
  assert.equal(registry.isAllowed('navigate'), false);
  assert.throws(() => registry.assertAllowed('navigate'), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_METHOD_NOT_ALLOWED');
    return true;
  });
  assert.deepEqual(registry.allowedMethods(), []);
  registry.registerMethod('status', () => ({ ok: true }));
  assert.deepEqual(registry.allowedMethods(), ['status']);
});

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------

test('forward：白名单方法转发成功，并透传 params/timeout', async () => {
  const registry = new RpcRegistry({ peer: { protocol: PROTOCOL_CURRENT } });
  const transport = new FakeTransport((method) => ({ method, entries: [] }));
  const reply = await registry.forward(transport, { method: 'audit.list', params: { limit: 5 }, timeoutMs: 700 });
  assert.deepEqual(reply, { ok: true, result: { method: 'audit.list', entries: [] } });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.method, 'audit.list');
  assert.deepEqual(transport.calls[0]?.params, { limit: 5 });
  assert.equal(transport.calls[0]?.options.timeoutMs, 700);
});

test('forward：白名单外方法直接拒绝，不触达 transport', async () => {
  const registry = new RpcRegistry();
  const transport = new FakeTransport();
  for (const method of ['navigate', 'click', 'session.stop', 'not.real']) {
    const reply = await registry.forward(transport, { method });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'E_METHOD_NOT_ALLOWED');
  }
  assert.equal(transport.calls.length, 0);
});

test('forward：feature gate 在 transport 之前生效', async () => {
  const registry = new RpcRegistry({ peer: { protocol: '1.8' }, allowlist: ['video.list'] });
  const transport = new FakeTransport();
  const reply = await registry.forward(transport, { method: 'video.list' });
  assert.equal(reply.ok, false);
  if (!reply.ok) {
    assert.equal(reply.error.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal((reply.error.data as ProtocolErrorData).actual, '1.8');
  }
  assert.equal(transport.calls.length, 0);
});

test('forward：transport 的 DaemonRpcError / ProtocolError / 普通异常都映射成结构化回包', async () => {
  const registry = new RpcRegistry();

  const daemonFailure = new FakeTransport(() => {
    throw new DaemonRpcError({ code: 'E_NO_BROWSER', message: '没有浏览器', data: { instances: 0 } });
  });
  const mapped = await registry.forward(daemonFailure, { method: 'status' });
  assert.deepEqual(mapped, {
    ok: false,
    error: { code: 'E_NO_BROWSER', message: '没有浏览器', data: { instances: 0 } },
  });

  const protocolFailure = new FakeTransport(() => {
    throw new ProtocolError('缺少特性 video', protocolUnsupportedData({ method: 'video.list', feature: 'video' }));
  });
  const protocolReply = await registry.forward(protocolFailure, { method: 'status' });
  assert.equal(protocolReply.ok, false);
  if (!protocolReply.ok) {
    assert.equal(protocolReply.error.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal((protocolReply.error.data as ProtocolErrorData).feature, 'video');
  }

  const crash = new FakeTransport(() => {
    throw new TypeError('fetch failed');
  });
  const crashReply = await registry.forward(crash, { method: 'status' });
  assert.deepEqual(crashReply, { ok: false, error: { code: 'E_INTERNAL', message: 'fetch failed' } });
});

test('forward：畸形请求不触达 transport', async () => {
  const registry = new RpcRegistry();
  const transport = new FakeTransport();
  for (const raw of [null, {}, { method: '' }, { method: 'status', params: [] }]) {
    const reply = await registry.forward(transport, raw);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'E_BAD_REQUEST');
  }
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

test('rpcErrorPayloadOf / errorPayloadOf：ProtocolError / RpcMethodError / Error', () => {
  const protocol = new ProtocolError('缺少特性 read', protocolUnsupportedData());
  const protocolPayload = rpcErrorPayloadOf(protocol);
  assert.equal(protocolPayload.code, 'E_PROTOCOL_UNSUPPORTED');
  assert.equal((protocolPayload.data as ProtocolErrorData).actual, '1.8');
  assert.deepEqual(errorPayloadOf(protocol), protocolPayload);

  const methodError = new RpcMethodError('E_BAD_METHOD', '方法名不能为空');
  assert.deepEqual(rpcErrorPayloadOf(methodError), { code: 'E_BAD_METHOD', message: '方法名不能为空' });

  assert.deepEqual(errorPayloadOf(new Error('boom')), { code: 'E_INTERNAL', message: 'boom' });
  assert.deepEqual(errorPayloadOf('string-error'), { code: 'E_INTERNAL', message: 'string-error' });
});

// ---------------------------------------------------------------------------
// 事件分发
// ---------------------------------------------------------------------------

test('RpcEventDispatcher：具名 + 通配订阅、历史、取消订阅', () => {
  let now = 1_000;
  const dispatcher = new RpcEventDispatcher({ now: () => now, historyLimit: 2 });
  const named: string[] = [];
  const any: string[] = [];
  const offNamed = dispatcher.on('tab-removed', (event) => named.push('named:' + String(event.params.tabId)));
  dispatcher.onAny((event) => any.push('any:' + event.event));

  const first = dispatcher.dispatch({ type: 'event', event: 'tab-removed', params: { tabId: 1 } });
  assert.ok(first);
  assert.equal(first?.receivedAt, 1_000);
  now = 2_000;
  dispatcher.dispatch({ event: 'help-resolved', params: { helpId: 'h1' } });
  now = 3_000;
  dispatcher.dispatch({ event: 'tab-removed', params: { tabId: 2 } });

  assert.deepEqual(named, ['named:1', 'named:2']);
  assert.deepEqual(any, ['any:tab-removed', 'any:help-resolved', 'any:tab-removed']);
  const history = dispatcher.history();
  assert.equal(history.length, 2, 'historyLimit=2 只保留最近两条');
  assert.equal(history[0]?.event, 'tab-removed');
  assert.equal(history[1]?.event, 'help-resolved');
  assert.deepEqual(dispatcher.subscriberCount(), { named: 1, wildcard: 1 });

  offNamed();
  dispatcher.dispatch({ event: 'tab-removed', params: { tabId: 3 } });
  assert.deepEqual(named, ['named:1', 'named:2']);
  dispatcher.clear();
  assert.equal(dispatcher.history().length, 0);
});

test('RpcEventDispatcher：坏帧返回 null 且不分发；订阅者异常被隔离', () => {
  const dispatcher = new RpcEventDispatcher();
  const seen: string[] = [];
  dispatcher.onAny((event) => {
    seen.push(event.event);
    if (event.event === 'boom') throw new Error('subscriber crash');
  });
  dispatcher.on('ok', () => seen.push('ok-handler'));

  assert.equal(dispatcher.dispatch(null), null);
  assert.equal(dispatcher.dispatch({}), null);
  assert.equal(dispatcher.dispatch({ event: '' }), null);
  assert.equal(dispatcher.dispatch({ type: 'cmd', event: 'x' }), null);
  assert.deepEqual(seen, []);

  const frame = dispatcher.dispatch({ event: 'boom', params: {} });
  assert.ok(frame);
  assert.deepEqual(seen, ['boom']);
  const ok = dispatcher.dispatch({ event: 'ok', params: null });
  assert.ok(ok);
  assert.deepEqual(ok?.params, {});
  // 具名订阅先于通配订阅执行（dispatch 实现顺序），订阅者异常不中断其它订阅者。
  assert.deepEqual(seen, ['boom', 'ok-handler', 'ok']);
});

test('registry.events 可直接消费 daemon 事件帧', () => {
  const registry = new RpcRegistry();
  const seen: string[] = [];
  registry.events.on('tab-removed', (event) => seen.push(String(event.params.tabId)));
  registry.events.dispatch({ type: 'event', event: 'tab-removed', params: { tabId: 9 } });
  registry.events.dispatch({ type: 'event', event: 'other', params: {} });
  assert.deepEqual(seen, ['9']);
  assert.equal(registry.events.history().length, 2);
});
