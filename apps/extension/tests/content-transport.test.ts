// tests/content-transport.test.ts —— background → 内容脚本的传输层（假 tabs API）。
//
// 这层最容易出“看起来能跑”的错误：不指定 frameId 时 Chrome 会把消息广播给所有帧，
// iframe 可能先回包（E2E 实测把跨源 iframe 当成当前页面）。所以这里把 frameId:0
// 固定成契约的一部分，并覆盖无接收方/超时/取消/畸形回包四类分支。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentScriptTransport, MAIN_FRAME_ID } from '../src/content/transport.ts';
import { makeContentRequest } from '../src/content/protocol.ts';

interface SentCall {
  tabId: number;
  message: unknown;
  options: { frameId?: number } | undefined;
}

function makeApi(replyFactory: () => Promise<unknown> | unknown) {
  const calls: SentCall[] = [];
  return {
    calls,
    api: {
      tabs: {
        sendMessage: (tabId: number, message: unknown, options?: { frameId?: number }) => {
          calls.push({ tabId, message, options });
          return replyFactory();
        },
      },
    },
  };
}

test('ContentScriptTransport：显式 frameId:0（主文档），成功回包原样归一', async () => {
  const { calls, api } = makeApi(() => ({ ok: true, result: { observation: 'x', refs: 2 } }));
  const transport = new ContentScriptTransport(api);
  const request = makeContentRequest('observe', { tabId: 7 }, 'r1');
  const reply = await transport.request(7, request);
  assert.deepEqual(reply, { ok: true, result: { observation: 'x', refs: 2 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tabId, 7);
  assert.deepEqual(calls[0]?.options, { frameId: MAIN_FRAME_ID });
  assert.equal(MAIN_FRAME_ID, 0);
  assert.equal((calls[0]?.message as { type?: string }).type, 'bb.content');
});

test('ContentScriptTransport：没有接收方 → E_NO_CONTENT（可重试），而非裸异常', async () => {
  const { api } = makeApi(() => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  const transport = new ContentScriptTransport(api);
  const reply = await transport.request(9, makeContentRequest('click', { tabId: 9 }));
  assert.equal(reply.ok, false);
  if (!reply.ok) {
    assert.equal(reply.code, 'E_NO_CONTENT');
    assert.equal((reply.data as { retryable?: boolean }).retryable, true);
    assert.match(reply.message, /没有内容脚本/);
  }
});

test('ContentScriptTransport：其它异常 → E_CONTENT_ERROR；畸形回包 → E_BAD_RESPONSE', async () => {
  const failing = makeApi(() => {
    throw new Error('some other failure');
  });
  const failed = await new ContentScriptTransport(failing.api).request(3, makeContentRequest('read', { tabId: 3 }));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.code, 'E_CONTENT_ERROR');

  const malformed = makeApi(() => 'not-an-object');
  const bad = await new ContentScriptTransport(malformed.api).request(3, makeContentRequest('read', { tabId: 3 }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'E_BAD_RESPONSE');
});

test('ContentScriptTransport：超时 → E_TIMEOUT；取消信号 → E_CANCELLED', async () => {
  const hanging = makeApi(() => new Promise(() => { /* never */ }));
  const transport = new ContentScriptTransport(hanging.api);
  const timedOut = await transport.request(5, makeContentRequest('observe', { tabId: 5 }), { timeoutMs: 20 });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.code, 'E_TIMEOUT');

  const controller = new AbortController();
  const cancelTransport = new ContentScriptTransport(makeApi(() => new Promise(() => { /* never */ })).api);
  const pending = cancelTransport.request(6, makeContentRequest('observe', { tabId: 6 }), { timeoutMs: 1_000, signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.code, 'E_CANCELLED');

  const already = await transport.request(6, makeContentRequest('observe', { tabId: 6 }), { signal: AbortSignal.abort() });
  assert.equal(already.ok, false);
  if (!already.ok) assert.equal(already.code, 'E_CANCELLED');
});

test('ContentScriptTransport：非法 tabId 直接 E_BAD_ARG；业务失败码原样透传', async () => {
  const { api } = makeApi(() => ({ ok: false, code: 'E_STALE_REF', message: 'ref 过期', data: { ref: '@e1' } }));
  const transport = new ContentScriptTransport(api);
  const badTab = await transport.request(0, makeContentRequest('click', {}));
  assert.equal(badTab.ok, false);
  if (!badTab.ok) assert.equal(badTab.code, 'E_BAD_ARG');

  const business = await transport.request(7, makeContentRequest('click', { ref: '@e1' }));
  assert.deepEqual(business, { ok: false, code: 'E_STALE_REF', message: 'ref 过期', data: { ref: '@e1' } });
});
