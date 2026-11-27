// tests/debug-cdp.test.ts —— CDP 调试采集器 + DebugService CDP 集成单测（假通道，无浏览器）。
//
// 覆盖：recorder start/stop 的域 enable 与租约、Network 事件→请求条目（方法/状态/耗时/头）、
// Runtime console、WebSocket 帧、bodies（getResponseBody/getRequestPostData）、journal（start/stop）、
// performance（Runtime.evaluate 实测指标）、DebugService 在 CDP 会话下的 current/request/console/
// performance/coverage/stop 行为，以及 CDP 不可用时的明确降级（形态不变）。

import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugCdpRecorder } from '../src/debug/recorder.ts';
import { DebugService } from '../src/debug/service.ts';
import type { CdpChannel, CdpChannelHandler } from '../src/debug/cdp-channel.ts';
import type { ContentReply } from '../src/content/protocol.ts';

interface SentCommand {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeChannel implements CdpChannel {
  acquires: Array<{ tabId: number; feature: string }> = [];
  releases: Array<{ tabId: number; feature: string }> = [];
  sent: SentCommand[] = [];
  commandImpl: (tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({});
  private readonly handlers = new Map<string, Set<CdpChannelHandler>>();

  async acquire(tabId: number, feature: string): Promise<void> {
    this.acquires.push({ tabId, feature });
  }

  release(tabId: number, feature: string): void {
    this.releases.push({ tabId, feature });
  }

  async send<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ tabId, method, params });
    return await this.commandImpl(tabId, method, params) as T;
  }

  onEvent(tabId: number, method: string, handler: CdpChannelHandler): () => void {
    const key = String(tabId) + ':' + method;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(tabId: number, method: string, params: Record<string, unknown> = {}): void {
    const set = this.handlers.get(String(tabId) + ':' + method);
    if (!set) return;
    for (const handler of [...set]) handler(params, { tabId });
  }

  commandsOf(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((item) => item.method === method).map((item) => item.params);
  }

  has(method: string): boolean {
    return this.sent.some((item) => item.method === method);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 标准假实现：frame tree + Runtime.evaluate（上下文/性能）+ getResponseBody。 */
function standardCommands(channel: FakeChannel): void {
  channel.commandImpl = async (_tabId, method, params) => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'F0', url: 'http://127.0.0.1:9/test.html' }, childFrames: [{ frame: { id: 'F1', url: 'http://127.0.0.1:9/frame.html' } }] } };
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params['expression'] ?? '');
      if (expression.includes('document.title')) {
        return { result: { value: { url: 'http://127.0.0.1:9/test.html', title: 'E2E 夹具页' } } };
      }
      return {
        result: {
          value: {
            url: 'http://127.0.0.1:9/test.html',
            resources: { count: 3, transferBytes: 2048 },
            ttfb: 12.5,
            domContentLoaded: 30,
            load: 55,
            paints: [{ name: 'first-contentful-paint', startTime: 20 }],
            lcp: 42,
            cls: 0.031,
            longTasks: { count: 2, maxMs: 80 },
          },
        },
      };
    }
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false };
    if (method === 'Network.getRequestPostData') return { postData: '{"kw":"x"}' };
    return {};
  };
}

function emitRequest(channel: FakeChannel, tabId: number, options: { requestId?: string; url?: string; method?: string } = {}): void {
  const requestId = options.requestId ?? 'r-1';
  channel.emit(tabId, 'Network.requestWillBeSent', {
    requestId,
    type: 'Fetch',
    documentURL: 'http://127.0.0.1:9/test.html',
    frameId: 'F0',
    wallTime: 1_700_000_000,
    request: {
      url: options.url ?? 'http://127.0.0.1:9/api/ping',
      method: options.method ?? 'GET',
      headers: { accept: '*/*', 'x-bridge-command': 'cmd-1' },
      headersSize: 120,
    },
  });
  channel.emit(tabId, 'Network.responseReceived', {
    requestId,
    type: 'Fetch',
    response: {
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      protocol: 'h2',
      headers: { 'content-type': 'application/json' },
      encodedDataLength: 512,
      remoteIPAddress: '127.0.0.1',
    },
  });
  channel.emit(tabId, 'Network.dataReceived', { requestId, dataLength: 100, encodedDataLength: 200 });
  channel.emit(tabId, 'Network.loadingFinished', { requestId, encodedDataLength: 512 });
}

test('DebugCdpRecorder：start 启用 Network/Page/Runtime/Performance，stop 释放租约并保留快照', async () => {
  const channel = new FakeChannel();
  standardCommands(channel);
  const recorder = new DebugCdpRecorder({ client: channel, now: () => 1_000 });
  const started = await recorder.start(7, { bodies: true, name: 'e2e-debug' });
  assert.equal(started['mode'], 'cdp-network');
  assert.equal(started['bodies'], true);
  assert.deepEqual(channel.acquires.map((item) => item.feature), ['debug']);
  for (const method of ['Network.enable', 'Page.enable', 'Runtime.enable', 'Performance.enable', 'Page.getFrameTree']) {
    assert.equal(channel.has(method), true, '缺少命令 ' + method);
  }
  assert.equal(recorder.isRecording(7), true);
  const journal = recorder.journal(7);
  assert.equal(journal.some((event) => event.type === 'start'), true, 'journal 缺少 start 事件');

  const stopped = await recorder.stop(7);
  assert.equal(stopped['requests'], 0);
  assert.equal(recorder.isRecording(7), false);
  assert.equal(channel.has('Network.disable'), true);
  assert.deepEqual(channel.releases.map((item) => item.feature), ['debug']);
  assert.equal(recorder.journal(7).some((event) => event.type === 'stop'), true, 'journal 缺少 stop 事件');
  await recorder.dispose();
});

test('DebugCdpRecorder：Network 事件 → 请求条目（方法/状态/耗时/头/commandId）+ bodies', async () => {
  const channel = new FakeChannel();
  standardCommands(channel);
  const recorder = new DebugCdpRecorder({ client: channel, now: () => 1_700_000_000_500 });
  await recorder.start(7, { bodies: true });
  emitRequest(channel, 7);
  const requests = recorder.requests(7);
  assert.equal(requests.length, 1);
  const entry = requests[0];
  assert.equal(entry?.method, 'GET');
  assert.equal(entry?.url, 'http://127.0.0.1:9/api/ping');
  assert.equal(entry?.status, 200);
  assert.equal(entry?.type, 'Fetch');
  assert.equal(entry?.finished, true);
  assert.equal(entry?.requestHeaders?.['x-bridge-command'], 'cmd-1');
  assert.equal(entry?.responseHeaders?.['content-type'], 'application/json');
  assert.equal(entry?.commandId, 'cmd-1');
  assert.equal(entry?.responseBytes, 512);
  assert.equal(typeof entry?.durationMs, 'number');

  const detail = await recorder.requestDetail(7, entry?.id);
  assert.equal(detail['responseBody'], '{"ok":true}');
  assert.deepEqual(detail['responseHeaders'], [{ name: 'content-type', value: 'application/json' }]);
  assert.equal(detail['mode'], 'cdp-network');

  // 停止后仍可读取最后一份快照（debug.request 在 stop 之后调用）
  await recorder.stop(7);
  const afterStop = await recorder.requestDetail(7, entry?.id);
  assert.equal(afterStop['responseBody'], '{"ok":true}');
  // stop 后 live 表清空，但只读面回落到最后一次快照（20b3 场景依赖这一点）。
  assert.equal(recorder.requests(7).length, 1, 'stop 后 requests 应返回最后一次快照');
  assert.equal(recorder.hasSnapshot(7), true);
  await recorder.dispose();
});

test('DebugCdpRecorder：Runtime console + WebSocket 帧 + performance 指标', async () => {
  const channel = new FakeChannel();
  standardCommands(channel);
  const recorder = new DebugCdpRecorder({ client: channel, now: () => 2_000 });
  await recorder.start(7, {});
  channel.emit(7, 'Runtime.consoleAPICalled', {
    type: 'warning',
    timestamp: 2_000_000,
    args: [{ type: 'string', value: 'bridge-e2e-console' }, { type: 'number', value: 42 }],
  });
  channel.emit(7, 'Runtime.exceptionThrown', {
    timestamp: 2_000_100,
    exceptionDetails: { text: 'Uncaught Error', exception: { description: 'Error: boom' } },
  });
  const consoleEntries = recorder.console(7);
  assert.equal(consoleEntries.length, 2);
  assert.equal(consoleEntries[0]?.level, 'warn');
  assert.equal(consoleEntries[0]?.text, 'bridge-e2e-console 42');
  assert.equal(consoleEntries[1]?.level, 'error');

  channel.emit(7, 'Network.webSocketCreated', { requestId: 'ws-1', url: 'ws://127.0.0.1:1/' });
  channel.emit(7, 'Network.webSocketFrameSent', { requestId: 'ws-1', response: { opcode: 1, payloadData: 'ping' } });
  channel.emit(7, 'Network.webSocketFrameReceived', { requestId: 'ws-1', response: { opcode: 1, payloadData: 'pong' } });
  channel.emit(7, 'Network.webSocketClosed', { requestId: 'ws-1' });
  const sockets = recorder.websockets(7);
  assert.equal(sockets.total, 1);
  assert.equal(sockets.sockets[0]?.frames.length, 2);
  assert.equal(sockets.sockets[0]?.closed, true);

  const perf = await recorder.performance(7);
  const metrics = perf['metrics'] as Record<string, unknown>;
  assert.equal(metrics['url'], 'http://127.0.0.1:9/test.html');
  assert.equal((metrics['resources'] as Record<string, unknown>)['count'], 3);
  assert.equal(metrics['cls'], 0.031);
  assert.equal(metrics['lcp'], 42);
  assert.equal((metrics['longTasks'] as Record<string, unknown>)['count'], 2);
  assert.equal(perf['mode'], 'cdp-performance');
  await recorder.stop(7);
  await recorder.dispose();
});

test('DebugService（CDP 会话）：start/current/request/console/performance/coverage/stop', async () => {
  const channel = new FakeChannel();
  standardCommands(channel);
  const content = {
    async request(): Promise<ContentReply> {
      return { ok: true, result: { url: 'http://127.0.0.1:9/test.html', entries: [] } } as unknown as ContentReply;
    },
  };
  const debug = new DebugService({ content, cdp: { client: channel }, now: () => 3_000 });
  const started = await debug.start({ tabId: 7, name: 'e2e-debug', bodies: true });
  assert.equal(started['mode'], 'cdp-network');
  assert.equal(started['bodies'], true);

  emitRequest(channel, 7);
  channel.emit(7, 'Runtime.consoleAPICalled', { type: 'log', timestamp: 3_000_000, args: [{ type: 'string', value: 'cursor-a' }] });
  channel.emit(7, 'Runtime.consoleAPICalled', { type: 'log', timestamp: 3_000_001, args: [{ type: 'string', value: 'cursor-b' }] });

  const current = await debug.current({ tabId: 7 });
  assert.equal(current['mode'], 'cdp-network');
  assert.equal((current['requests'] as unknown[]).length, 1);
  assert.equal((current['console'] as unknown[]).length, 2);
  assert.equal(String(current['url']).includes('test.html'), true);
  assert.equal((current['context'] as Record<string, unknown>)['title'], 'E2E 夹具页');
  const journal = current['journal'] as Array<Record<string, unknown>>;
  assert.equal(journal.some((event) => event['type'] === 'start'), true, 'current 必须带 debug journal 的 start 事件');

  const listed = await debug.requests({ tabId: 7 });
  const id = (listed['entries'] as Array<Record<string, unknown>>)[0]?.['id'];
  const detail = await debug.request({ tabId: 7, id });
  assert.equal(detail['responseBody'], '{"ok":true}', 'bodies 应取到真实响应正文');

  const firstPage = await debug.console({ tabId: 7, limit: 1 });
  assert.equal((firstPage['entries'] as unknown[]).length, 1);
  assert.equal(typeof firstPage['nextCursor'], 'number');
  const secondPage = await debug.console({ tabId: 7, cursor: firstPage['nextCursor'], limit: 1 });
  assert.equal((secondPage['entries'] as unknown[]).length, 1);

  const perf = await debug.performance({ tabId: 7 });
  const metrics = perf['metrics'] as Record<string, unknown>;
  assert.equal(typeof metrics['cls'], 'number');
  assert.equal((metrics['longTasks'] as Record<string, unknown>)['count'], 2);

  const coverage = await debug.coverage({ tabId: 7 });
  assert.equal(coverage['mode'], 'cdp-network');
  assert.equal((coverage['requests'] as Record<string, unknown>)['total'], 1);
  assert.equal(coverage['complete'], false, '没有 WebSocket 时仍有 gap');
  assert.equal((coverage['gaps'] as Array<Record<string, unknown>>).some((gap) => gap['kind'] === 'websocket-frames'), true);

  const stopped = await debug.stop({ tabId: 7 });
  assert.equal(stopped['requests'], 1);
  assert.equal(stopped['console'], 2);
  assert.equal(stopped['bodies'], true);
  const history = debug.historyList();
  assert.equal((history['history'] as Array<Record<string, unknown>>).length, 1);

  // 20b3 回归：stop 之后 CLI `debug requests`（= debug.current）仍要能读最近一次采集快照，
  // 不得报 E_NOT_ACTIVE（active 明确为 false，但不是“没有数据”）。
  const afterStop = await debug.current({ tabId: 7 });
  assert.equal(afterStop['ok'], true);
  assert.equal(afterStop['active'], false);
  assert.equal(afterStop['stopped'], true);
  assert.equal((afterStop['requests'] as unknown[]).length, 1, 'stop 后 current 应返回最近快照的请求');
  assert.equal((afterStop['console'] as unknown[]).length, 2);
  assert.equal(String((afterStop['context'] as Record<string, unknown>)['url']).includes('test.html'), true);
  const afterStopRequests = await debug.requests({ tabId: 7 });
  assert.equal(afterStopRequests['ok'], true);
  assert.equal(afterStopRequests['active'], false);
  assert.equal((afterStopRequests['entries'] as unknown[]).length, 1);
  const afterStopDetail = await debug.request({ tabId: 7, id });
  assert.equal(afterStopDetail['responseBody'], '{"ok":true}', 'stop 后仍可按 id 读最近快照的正文');
  const afterStopConsole = await debug.console({ tabId: 7, limit: 10 });
  assert.equal((afterStopConsole['entries'] as unknown[]).length, 2);
});

test('DebugService：start 成功后 requests/current 必须处于活跃态（CDP 与降级两路）', async () => {
  // 路 1：CDP 活跃
  const channel = new FakeChannel();
  standardCommands(channel);
  const content = {
    async request(): Promise<ContentReply> {
      return { ok: true, result: { url: 'http://127.0.0.1:9/test.html', entries: [] } } as unknown as ContentReply;
    },
  };
  const cdpDebug = new DebugService({ content, cdp: { client: channel }, now: () => 6_000 });
  const cdpStarted = await cdpDebug.start({ tabId: 7, name: 'e2e-debug' });
  assert.equal(cdpStarted['mode'], 'cdp-network');
  assert.equal(cdpStarted['capturing'], true);
  const cdpCurrent = await cdpDebug.current({ tabId: 7 });
  assert.equal(cdpCurrent['active'], true);
  const cdpRequests = await cdpDebug.requests({ tabId: 7 });
  assert.equal(cdpRequests['active'], true);
  assert.equal(cdpRequests['ok'], true);
  await cdpDebug.stop({ tabId: 7 });

  // 路 2：CDP 不可用 → 显式降级，但 active 仍为 true（不允许“已 start 但未激活”）
  const failing = new FakeChannel();
  failing.commandImpl = async (_tabId, method) => {
    if (method === 'Network.enable') throw new Error('debugger unavailable');
    return {};
  };
  const fallbackDebug = new DebugService({ content, cdp: { client: failing }, now: () => 7_000 });
  const fallbackStarted = await fallbackDebug.start({ tabId: 7 });
  assert.equal(fallbackStarted['mode'], 'page-hooks+resource-timing');
  const fallbackCurrent = await fallbackDebug.current({ tabId: 7 });
  assert.equal(fallbackCurrent['active'], true);
  const fallbackRequests = await fallbackDebug.requests({ tabId: 7 });
  assert.equal(fallbackRequests['active'], true);
  assert.equal(fallbackRequests['ok'], true);
  await fallbackDebug.stop({ tabId: 7 });
});

test('DebugService：CDP 启动失败时明确降级到页面钩子模式（不抛错、形态不变）', async () => {
  const channel = new FakeChannel();
  channel.commandImpl = async (_tabId, method) => {
    if (method === 'Network.enable') throw new Error('Another debugger is already attached');
    return {};
  };
  const content = {
    async request(): Promise<ContentReply> {
      return { ok: true, result: { url: 'http://127.0.0.1:9/test.html', entries: [] } } as unknown as ContentReply;
    },
  };
  const debug = new DebugService({ content, cdp: { client: channel }, now: () => 4_000 });
  const started = await debug.start({ tabId: 7 });
  assert.equal(started['mode'], 'page-hooks+resource-timing');
  assert.match(String(started['cdpFallback']), /already attached/);
  const current = await debug.current({ tabId: 7 });
  assert.equal(current['mode'], 'page-hooks+resource-timing');
  await debug.stop({ tabId: 7 });
});

test('DebugService：没有 CDP 通道时行为与第四批一致（回归保护）', async () => {
  const content = {
    async request(): Promise<ContentReply> {
      return { ok: true, result: { url: 'http://a/', entries: [] } } as unknown as ContentReply;
    },
  };
  const debug = new DebugService({ content, now: () => 5_000 });
  const caps = debug.capabilities();
  assert.equal(caps['mode'], 'page-hooks+resource-timing');
  assert.deepEqual(caps['rules'], { readonly: true, fulfill: false, modify: false });
  const started = await debug.start({ tabId: 7 });
  assert.equal(started['mode'], 'page-hooks+resource-timing');
  const current = await debug.current({ tabId: 7 });
  assert.equal(current['mode'], 'page-hooks+resource-timing');
  await debug.stop({ tabId: 7 });
  await tick(1);
});
