// tests/unit/ui-rpc.test.mjs —— extension/ui/lib/rpc.js RPC 封装单测（假传输）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETRIES,
  callWithStatus,
  createRpc,
  errorCodeOf,
  isTransientError,
  localizeError,
  normalizeReply,
} from '../../extension/ui/lib/rpc.js';

test('normalizeReply：三种后台返回风格', () => {
  assert.deepEqual(normalizeReply({ ok: true, result: { entries: [1] } }).result, { entries: [1] });
  assert.deepEqual(normalizeReply({ ok: true, entries: [1] }).result.entries, [1], '没有 result 字段时整条当结果');
  const failed = normalizeReply({ ok: false, error: 'E_TIMEOUT' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'E_TIMEOUT');
  assert.equal(failed.code, 'E_TIMEOUT');
  assert.equal(normalizeReply(undefined).ok, false);
  assert.equal(normalizeReply(null).code, 'E_EMPTY_REPLY');
  assert.equal(normalizeReply('text').result, 'text');
  assert.equal(normalizeReply({ ok: false, code: 'E_BUSY', message: 'busy' }).code, 'E_BUSY');
  assert.equal(normalizeReply({ ok: false, error: { code: 'E_AUTH' } }).code, 'E_AUTH');
  assert.equal(errorCodeOf({ error: 'E_X' }), 'E_X');
  assert.equal(errorCodeOf({ error: 'plain message' }), null);
  assert.equal(errorCodeOf(null), null);
});

test('isTransientError / localizeError', () => {
  assert.equal(isTransientError(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(isTransientError(new Error('The message port closed before a response was received.')), true);
  assert.equal(isTransientError(new Error('boom')), false);
  assert.equal(isTransientError('Extension context invalidated'), true);
  assert.equal(isTransientError(null), false);
  const text = localizeError({ error: 'E_TIMEOUT' }, 'zh');
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.equal(typeof localizeError(new Error('x'), 'en'), 'string');
});

test('createRpc：成功调用与调用记录', async () => {
  const sent = [];
  const rpc = createRpc(async (message) => {
    sent.push(message);
    return { ok: true, result: { value: message.type } };
  });
  assert.equal(DEFAULT_RETRIES, 1);
  const result = await rpc.send('bb.debug.history', { limit: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { value: 'bb.debug.history' });
  assert.deepEqual(sent[0], { type: 'bb.debug.history', limit: 5 });
  assert.equal(rpc.calls.length, 1);
  assert.equal(rpc.latest().type, 'bb.debug.history');
  assert.equal(rpc.latest().ok, true);
  assert.ok(rpc.latest().elapsedMs >= 0);
});

test('createRpc：超时返回 E_TIMEOUT（不无限等）', async () => {
  const rpc = createRpc(() => new Promise(() => {}), { timeoutMs: 15, retries: 0 });
  const result = await rpc.send('bb.slow');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'E_TIMEOUT');
  assert.equal(result.timeout, true);
});

test('createRpc：瞬时错误重试一次后成功', async () => {
  let attempts = 0;
  const rpc = createRpc(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true, result: 42 };
  }, { retries: 1, sleep: async () => {} });
  const result = await rpc.send('bb.state');
  assert.equal(result.ok, true);
  assert.equal(result.result, 42);
  assert.equal(attempts, 2, '应该重试一次');
});

test('createRpc：非瞬时错误不重试', async () => {
  let attempts = 0;
  const rpc = createRpc(async () => {
    attempts += 1;
    throw new Error('boom');
  }, { retries: 3, sleep: async () => {} });
  const result = await rpc.send('bb.state');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
  assert.equal(attempts, 1);
});

test('createRpc.daemon：转发 bb.daemon.call 并解包', async () => {
  const sent = [];
  const rpc = createRpc(async (message) => {
    sent.push(message);
    return { ok: true, result: { ok: true, result: { entries: [{ method: 'page.goto' }] } } };
  });
  const reply = await rpc.daemon('operations.list', { limit: 10 });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result.entries, [{ method: 'page.goto' }]);
  assert.equal(sent[0].type, 'bb.daemon.call');
  assert.equal(sent[0].method, 'operations.list');
  assert.deepEqual(sent[0].params, { limit: 10 });

  const offline = createRpc(async () => ({ ok: true, result: { ok: false, error: 'daemon 未连接' } }));
  const failed = await offline.daemon('status');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'daemon 未连接');
});

test('createRpc：传输函数非法立即抛错', () => {
  assert.throws(() => createRpc(null), /transport/);
  assert.throws(() => createRpc('x'), /transport/);
});

test('callWithStatus：钩子顺序与错误本地化', async () => {
  const events = [];
  const rpc = createRpc(async () => ({ ok: false, error: 'E_TIMEOUT' }));
  const result = await callWithStatus(rpc, 'bb.x', {}, {
    onStart: () => events.push('start'),
    onFinish: () => events.push('finish'),
    onError: (reply, text) => events.push('error:' + reply.error + ':' + Boolean(text)),
    lang: 'en',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(events, ['start', 'finish', 'error:E_TIMEOUT:true']);

  const ok = createRpc(async () => ({ ok: true, result: 1 }));
  const okEvents = [];
  const success = await callWithStatus(ok, 'bb.y', {}, { onStart: () => okEvents.push('start'), onFinish: () => okEvents.push('finish'), onError: () => okEvents.push('error') });
  assert.equal(success.ok, true);
  assert.deepEqual(okEvents, ['start', 'finish']);
});
