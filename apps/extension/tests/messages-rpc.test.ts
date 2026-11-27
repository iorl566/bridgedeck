// tests/messages-rpc.test.ts —— `bb.rpc` 浏览器消息契约的解析/回包形状单测。
//
// `shared/messages.ts` 是 background 与 popup/内容脚本之间的不可信输入边界：这里先挡掉
// 明显非法的 bb.rpc（method/params/timeoutMs/id），注册表再做一次权威校验。两个新消息
// 分支（请求 + 成功/失败回包）都应有测试，否则 background 接线就是无覆盖代码。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../shared/messages.ts';
import type { ExtensionReply } from '../shared/messages.ts';

test('parseMessage 接受合法 bb.rpc 并规范化', () => {
  assert.deepEqual(parseMessage({ type: 'bb.rpc', method: 'status' }), {
    type: 'bb.rpc',
    method: 'status',
  });
  assert.deepEqual(
    parseMessage({ type: 'bb.rpc', method: ' audit.list ', params: { limit: 20 }, timeoutMs: 1234.9, id: 'r1' }),
    { type: 'bb.rpc', method: 'audit.list', params: { limit: 20 }, timeoutMs: 1234, id: 'r1' },
  );
  // params/timeoutMs/id 为 null 等同于未提供（与 registry.parseRpcRequest 一致）。
  assert.deepEqual(parseMessage({ type: 'bb.rpc', method: 'browsers', params: null, timeoutMs: null, id: null }), {
    type: 'bb.rpc',
    method: 'browsers',
  });
});

test('parseMessage 拒绝畸形 bb.rpc', () => {
  const invalid: unknown[] = [
    { type: 'bb.rpc' },
    { type: 'bb.rpc', method: '' },
    { type: 'bb.rpc', method: '   ' },
    { type: 'bb.rpc', method: 42 },
    { type: 'bb.rpc', method: 'x'.repeat(129) },
    { type: 'bb.rpc', method: 'status', params: [] },
    { type: 'bb.rpc', method: 'status', params: 'x' },
    { type: 'bb.rpc', method: 'status', params: 5 },
    { type: 'bb.rpc', method: 'status', timeoutMs: 0 },
    { type: 'bb.rpc', method: 'status', timeoutMs: -1 },
    { type: 'bb.rpc', method: 'status', timeoutMs: 'abc' },
    { type: 'bb.rpc', method: 'status', id: '' },
    { type: 'bb.rpc', method: 'status', id: 7 },
  ];
  for (const input of invalid) {
    assert.equal(parseMessage(input), null, `应拒绝：${JSON.stringify(input)}`);
  }
  // 其它既有消息类型不受 bb.rpc 改动影响。
  assert.deepEqual(parseMessage({ type: 'bb.status' }), { type: 'bb.status' });
  assert.deepEqual(parseMessage({ type: 'bb.ping', nonce: 'n1' }), { type: 'bb.ping', nonce: 'n1' });
  assert.deepEqual(parseMessage({ type: 'bb.settings.get' }), { type: 'bb.settings.get' });
  assert.equal(parseMessage({ type: 'bb.rpcx', method: 'status' }), null);
});

test('ExtensionReply 的 rpc 成功/失败回包形状（background 契约）', () => {
  const success: ExtensionReply = { ok: true, type: 'rpc', result: { service: 'browser-bridge' }, id: 'r1' };
  assert.equal(success.ok, true);
  assert.equal(success.type, 'rpc');
  assert.deepEqual(success.result, { service: 'browser-bridge' });

  const failure: ExtensionReply = { ok: false, code: 'E_NO_DAEMON', message: '连不上 daemon', data: { port: 52900 } };
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'E_NO_DAEMON');
  assert.deepEqual(failure.data, { port: 52900 });
});
