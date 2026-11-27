// tests/record-messages.test.ts —— bb.record.* 消息面（解析/权限/路由/页面客户端信封）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordMessage, RecordMessageHandler, sendRecordMessage, type ChromeRuntimeLike } from '../src/record/messages.ts';
import { RecordService, type RecordServiceDeps, type RecordTabInfo } from '../src/record/service.ts';
import { RecordStore } from '../src/record/store.ts';

const EXT_SENDER = { id: 'ext-1', url: 'chrome-extension://ext-1/ops.html' };
const CONTENT_SENDER = { tab: { id: 12 }, frameId: 0, documentId: 'doc-12', url: 'https://example.test/' };

function harness(): { handler: RecordMessageHandler; service: RecordService } {
  const tabs = new Map<number, RecordTabInfo>([
    [12, { tabId: 12, windowId: 1, url: 'https://example.test/', title: '夹具页' }],
  ]);
  const deps: RecordServiceDeps = {
    now: () => 1_700_000_000_000,
    newId: () => 'rec-1',
    store: new RecordStore({}, {}),
    tabs: { get: async (tabId) => tabs.get(Number(tabId)) ?? null },
    capture: { start: async () => 1, stop: async () => 1 },
    overlay: { show: async () => true, hide: async () => true },
    log: () => undefined,
  };
  const service = new RecordService(deps);
  const handler = new RecordMessageHandler(service, { extensionId: 'ext-1', extensionOrigin: 'chrome-extension://ext-1/' });
  return { handler, service };
}

test('parseRecordMessage：页面 op/事件/结束 的合法与非法形状', () => {
  const start = parseRecordMessage({ type: 'bb.record.start', params: { tabId: 12 } });
  assert.ok(start && 'op' in start && start.op === 'start');
  assert.deepEqual(start && 'params' in start ? start.params : null, { tabId: 12 });

  const noParams = parseRecordMessage({ type: 'bb.record.list' });
  assert.ok(noParams && 'params' in noParams && noParams.params && Object.keys(noParams.params).length === 0);

  const event = parseRecordMessage({ type: 'bb.record.event', event: { kind: 'click' } });
  assert.ok(event && 'op' in event && event.op === null);
  assert.ok(event && 'event' in event && event.event);

  const finish = parseRecordMessage({ type: 'bb.record.finish' });
  assert.ok(finish && 'op' in finish && finish.op === null);

  const unknown = parseRecordMessage({ type: 'bb.record.nope' });
  assert.ok(unknown && 'ok' in unknown && unknown.ok === false && unknown.code === 'E_BAD_ARG');

  const badEvent = parseRecordMessage({ type: 'bb.record.event', event: 'click' });
  assert.ok(badEvent && 'ok' in badEvent && badEvent.ok === false);

  const badParams = parseRecordMessage({ type: 'bb.record.start', params: [] });
  assert.ok(badParams && 'ok' in badParams && badParams.ok === false);

  assert.equal(parseRecordMessage({ type: 'bb.ui', op: 'state' }), null);
  assert.equal(parseRecordMessage({ type: 'bb.record' }), null);
  assert.equal(parseRecordMessage(null), null);
});

test('handler：页面 op 只接受扩展上下文；不支持的消息返回 null', async () => {
  const { handler } = harness();
  assert.equal(await handler.handle({ type: 'bb.ui', op: 'state' }, EXT_SENDER), null);

  const forbidden = await handler.handle({ type: 'bb.record.start', params: { tabId: 12 } }, CONTENT_SENDER);
  assert.ok(forbidden && forbidden.ok === false && forbidden.code === 'E_FORBIDDEN');

  const started = await handler.handle({ type: 'bb.record.start', params: { tabId: 12 } }, EXT_SENDER);
  assert.ok(started && started.ok === true);
  const result = started.ok === true ? started.result as { ok: true; tabId: number } : null;
  assert.equal(result?.tabId, 12);

  const status = await handler.handle({ type: 'bb.record.status' }, EXT_SENDER);
  assert.ok(status && status.ok === true);
});

test('handler：内容脚本事件经 pushEvent 入会话；finish 停录落库', async () => {
  const { handler, service } = harness();
  await handler.handle({ type: 'bb.record.start', params: { tabId: 12, includeAgent: true } }, EXT_SENDER);

  const eventReply = await handler.handle({ type: 'bb.record.event', event: { kind: 'click', selector: '#submit-btn' } }, CONTENT_SENDER);
  assert.ok(eventReply && eventReply.ok === true);
  const pushed = eventReply.ok === true ? eventReply.result as { recorded: boolean } : null;
  assert.equal(pushed?.recorded, true);
  assert.equal(service.sessionOf(12)?.events.length, 1);

  const noSender = await handler.handle({ type: 'bb.record.event', event: { kind: 'click' } }, EXT_SENDER);
  assert.ok(noSender && noSender.ok === false && noSender.code === 'E_FORBIDDEN');

  const finished = await handler.handle({ type: 'bb.record.finish' }, { tab: { id: 12 } });
  assert.ok(finished && finished.ok === true);
  assert.equal(service.sessionOf(12), null);
  const list = await handler.handle({ type: 'bb.record.list', params: { includeEvents: false } }, EXT_SENDER);
  assert.ok(list && list.ok === true);
  const listed = list.ok === true ? list.result as { total: number } : null;
  assert.equal(listed?.total, 1);
});

test('handler：服务异常转结构化失败信封（stop 无会话 → E_NOT_FOUND）', async () => {
  const { handler } = harness();
  const reply = await handler.handle({ type: 'bb.record.stop', params: { tabId: 12 } }, EXT_SENDER);
  assert.ok(reply && reply.ok === false);
  assert.equal(reply.ok === false ? reply.code : '', 'E_NOT_FOUND');
});

test('sendRecordMessage：成功解包、失败保留 code、无 runtime 报 E_NO_RUNTIME', async () => {
  const okRuntime: ChromeRuntimeLike = { sendMessage: async () => ({ ok: true, result: { total: 2 } }) };
  const okReply = await sendRecordMessage<{ total: number }>('list', {}, okRuntime);
  assert.equal(okReply.ok, true);
  assert.equal(okReply.ok === true ? okReply.result.total : 0, 2);

  const failRuntime: ChromeRuntimeLike = { sendMessage: async () => ({ ok: false, code: 'E_BAD_ARG', message: '参数不对' }) };
  const failReply = await sendRecordMessage('start', {}, failRuntime);
  assert.equal(failReply.ok, false);
  assert.equal(failReply.ok === false ? failReply.code : '', 'E_BAD_ARG');
  assert.equal(failReply.ok === false ? failReply.message : '', '参数不对');

  const throwingRuntime: ChromeRuntimeLike = { sendMessage: async () => { throw new Error('通道断了'); } };
  const thrown = await sendRecordMessage('list', {}, throwingRuntime);
  assert.equal(thrown.ok, false);
  assert.equal(thrown.ok === false ? thrown.code : '', 'E_NO_RUNTIME');

  const none = await sendRecordMessage('list', {}, null);
  assert.equal(none.ok, false);
  assert.equal(none.ok === false ? none.code : '', 'E_NO_RUNTIME');
});
