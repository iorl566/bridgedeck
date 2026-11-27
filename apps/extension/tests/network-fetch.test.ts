// tests/network-fetch.test.ts —— CDP Fetch 域 + 规则同步 + network.waterfall/replay 单测。
//
// 全部用假 CdpChannel（记录命令、可手动发事件），不 attach 真实浏览器。
// 覆盖：enable/disable 生命周期、requestPaused → fulfill/block/modify/continue 派发、
// 规则新增/清空时的 Fetch 启停同步、命中计数、fetch_probe 诊断、waterfall 纯函数、
// network.replay 主世界重放（假 chrome.scripting）。

import assert from 'node:assert/strict';
import test from 'node:test';

import { FetchController, actionNeedsFetch } from '../src/network/fetch.ts';
import type { FetchRuleSpec } from '../src/network/fetch.ts';
import { RuleService } from '../src/debug/rules.ts';
import { NetworkService } from '../src/network/service.ts';
import { buildNetworkWaterfall } from '../src/network/waterfall.ts';
import type { CdpChannel, CdpChannelHandler } from '../src/debug/cdp-channel.ts';
import { base64DecodeUtf8 } from '../src/debug/cdp-channel.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';

interface SentCommand {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

/** 假 CDP 通道：记录 acquire/release/send；事件可手动 emit。 */
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

function fulfillRule(overrides: Partial<FetchRuleSpec> = {}): FetchRuleSpec {
  return {
    id: 1,
    action: 'fulfill',
    urlPattern: '*/api/ping*',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":false}',
    enabled: true,
    ...overrides,
  };
}

test('FetchController：enable 幂等 + Fetch.enable 图案 + disable 释放租约', async () => {
  const channel = new FakeChannel();
  const fetch = new FetchController({ client: channel, resolveRules: () => [fulfillRule()] });
  await fetch.enable(7);
  await fetch.enable(7);
  assert.deepEqual(channel.acquires, [{ tabId: 7, feature: 'fetch-rules' }], 'enable 只 acquire 一次');
  const patterns = channel.commandsOf('Fetch.enable');
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0]?.['patterns'], [{ urlPattern: '*', requestStage: 'Request' }]);
  assert.equal(fetch.isEnabled(7), true);
  await fetch.disable(7);
  assert.equal(fetch.isEnabled(7), false);
  assert.equal(channel.has('Fetch.disable'), true);
  assert.deepEqual(channel.releases, [{ tabId: 7, feature: 'fetch-rules' }]);
  // 幂等：再次 disable 不重复发命令
  const before = channel.sent.length;
  await fetch.disable(7);
  assert.equal(channel.sent.length, before);
});

test('requestPaused：fulfill 命中 → fulfillRequest（状态/头/base64 正文）且 hits 回写', async () => {
  const channel = new FakeChannel();
  const hitIds: Array<number | string> = [];
  const rules: FetchRuleSpec[] = [fulfillRule()];
  const fetch = new FetchController({
    client: channel,
    resolveRules: () => rules,
    onHit: (_tabId, id) => hitIds.push(id),
  });
  await fetch.enable(7);
  channel.emit(7, 'Fetch.requestPaused', {
    requestId: 'req-1',
    request: { url: 'http://127.0.0.1:1/api/ping?x=1', method: 'GET' },
  });
  await tick(5);
  const fulfilled = channel.commandsOf('Fetch.fulfillRequest');
  assert.equal(fulfilled.length, 1);
  assert.equal(fulfilled[0]?.['requestId'], 'req-1');
  assert.equal(fulfilled[0]?.['responseCode'], 200);
  assert.deepEqual(fulfilled[0]?.['responseHeaders'], [{ name: 'content-type', value: 'application/json' }]);
  assert.equal(base64DecodeUtf8(String(fulfilled[0]?.['body'] ?? '')), '{"ok":false}');
  assert.deepEqual(hitIds, [1]);
  const stats = fetch.statsOf(7);
  assert.equal(stats.paused, 1);
  assert.equal(stats.matched, 1);
  assert.equal(stats.fulfilled, 1);
  assert.equal(stats.urls[0], 'http://127.0.0.1:1/api/ping?x=1');
  assert.equal(channel.has('Fetch.continueRequest'), false, '命中后不应再 continue');
});

test('requestPaused：block/abort → failRequest；modify → continueRequest 改 URL；未命中 → continueRequest', async () => {
  const channel = new FakeChannel();
  const rules: FetchRuleSpec[] = [
    { id: 1, action: 'block', urlPattern: '*block-me*', enabled: true },
    { id: 2, action: 'modify', urlPattern: '*modify-me*', url: 'http://127.0.0.1:1/api/script-mock', method: 'POST', headers: { 'x-a': 'b' }, enabled: true },
  ];
  const fetch = new FetchController({ client: channel, resolveRules: () => rules });
  await fetch.enable(7);
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-block', request: { url: 'http://x/block-me', method: 'GET' } });
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-modify', request: { url: 'http://x/modify-me?a=1', method: 'GET' } });
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-pass', request: { url: 'http://x/other', method: 'GET' } });
  await tick(10);
  const failed = channel.commandsOf('Fetch.failRequest');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.['requestId'], 'r-block');
  assert.equal(failed[0]?.['errorReason'], 'Aborted');
  const continued = channel.commandsOf('Fetch.continueRequest');
  assert.equal(continued.length, 2);
  const modify = continued.find((item) => item['requestId'] === 'r-modify');
  assert.ok(modify, 'modify 应走 continueRequest');
  assert.equal(modify['url'], 'http://127.0.0.1:1/api/script-mock');
  assert.equal(modify['method'], 'POST');
  assert.deepEqual(modify['headers'], [{ name: 'x-a', value: 'b' }]);
  const pass = continued.find((item) => item['requestId'] === 'r-pass');
  assert.deepEqual(pass, { requestId: 'r-pass' });
  const stats = fetch.statsOf(7);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.modified, 1);
  assert.equal(stats.continued, 1);
});

test('Fetch 派发失败时兜底 continueRequest（页面请求不能挂死）', async () => {
  const channel = new FakeChannel();
  channel.commandImpl = async (_tabId, method) => {
    if (method === 'Fetch.fulfillRequest') throw new Error('boom');
    return {};
  };
  const fetch = new FetchController({ client: channel, resolveRules: () => [fulfillRule()] });
  await fetch.enable(7);
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-1', request: { url: 'http://x/api/ping', method: 'GET' } });
  await tick(10);
  const continued = channel.commandsOf('Fetch.continueRequest');
  assert.equal(continued.length, 1, 'fulfill 失败后必须继续请求');
  assert.equal(fetch.statsOf(7).errors, 1);
  assert.match(String(fetch.statsOf(7).lastError), /boom/);
});

test('sync：没有 fulfill/modify 规则就关闭 Fetch；清空后也不留拦截', async () => {
  const channel = new FakeChannel();
  let rules: FetchRuleSpec[] = [];
  const fetch = new FetchController({ client: channel, resolveRules: () => rules });
  assert.equal(await fetch.sync(7), false);
  assert.equal(fetch.isEnabled(7), false);
  rules = [fulfillRule()];
  assert.equal(await fetch.sync(7), true);
  assert.equal(fetch.isEnabled(7), true);
  rules = [{ id: 3, action: 'block', urlPattern: '*', enabled: true }];
  assert.equal(await fetch.sync(7), false, 'block-only 不需要 Fetch（交给 DNR）');
  assert.equal(fetch.isEnabled(7), false);
});

test('probe：临时启用统计 requestPaused 并继续请求（20w）', async () => {
  const channel = new FakeChannel();
  const fetch = new FetchController({ client: channel, resolveRules: () => [] });
  const running = fetch.probe(7, { ms: 120 });
  await tick(20);
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'p-1', request: { url: 'http://x/api/ping' } });
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'p-2', request: { url: 'http://x/api/ping' } });
  const result = await running;
  assert.equal(result['paused'], 2);
  assert.deepEqual(result['urls'], ['http://x/api/ping']);
  assert.equal(result['reused'], false);
  assert.equal(channel.commandsOf('Fetch.continueRequest').length, 2, 'probe 必须继续请求');
  assert.equal(channel.has('Fetch.disable'), true);
  assert.deepEqual(channel.acquires.map((item) => item.feature), ['fetch-probe']);
});

test('RuleService × FetchController：fulfill 规则真实拦截、hits 递增、清空关闭 Fetch', async () => {
  const channel = new FakeChannel();
  const dnrCalls: unknown[] = [];
  const dnr = {
    async getSessionRules() { return []; },
    async updateSessionRules(options: { addRules?: Array<Record<string, unknown>> }) { dnrCalls.push(options); },
  };
  const rules = new RuleService({ rules: dnr, now: () => 10 });
  const fetch = new FetchController({
    client: channel,
    resolveRules: () => rules.rulesForFetch(),
    onHit: (_tabId, id) => rules.recordHit(id),
  });
  rules.attachFetch(fetch);

  const added = await rules.add({
    action: 'fulfill',
    urlPattern: '*/api/ping*',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":false}',
  }, 7);
  assert.equal(channel.has('Fetch.enable'), true, 'fulfill 规则应启用 Fetch');
  const addedRule = (added['added'] ?? {}) as Record<string, unknown>;
  assert.equal(addedRule['applied'], true);
  assert.equal(added['fulfillSupported'], true);

  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-1', request: { url: 'http://x/api/ping', method: 'GET' } });
  await tick(10);
  const listed = await rules.list();
  const local = (listed['rules'] as Array<Record<string, unknown>>)[0];
  assert.equal(local?.['hits'], 1, '命中计数应回写到规则列表');

  const cleared = await rules.clear(7);
  assert.equal(cleared['cleared'], 1);
  assert.equal(channel.has('Fetch.disable'), true, '清空规则后必须关闭 Fetch');
  // clear 后不再拦截：新 paused 请求走 continueRequest（若还有监听的话不会；这里断言没有新 fulfill）
  const fulfilledBefore = channel.commandsOf('Fetch.fulfillRequest').length;
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'r-2', request: { url: 'http://x/api/ping', method: 'GET' } });
  await tick(5);
  assert.equal(channel.commandsOf('Fetch.fulfillRequest').length, fulfilledBefore);
});

test('RuleService：fetch_probe RPC 面 + 无通道时明确 E_NOT_IMPLEMENTED', async () => {
  const channel = new FakeChannel();
  const rules = new RuleService({});
  await assert.rejects(() => rules.probe({ tabId: 7, ms: 100 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_NOT_IMPLEMENTED');
    return true;
  });
  const fetch = new FetchController({ client: channel, resolveRules: () => [] });
  rules.attachFetch(fetch);
  const running = rules.probe({ tabId: 7, ms: 100 });
  await tick(20);
  channel.emit(7, 'Fetch.requestPaused', { requestId: 'p-1', request: { url: 'http://x/api/ping' } });
  const result = await running;
  assert.equal(result['paused'], 1);
  assert.deepEqual(result['urls'], ['http://x/api/ping']);
});

test('actionNeedsFetch：只有 fulfill/modify 需要 Fetch 域', () => {
  assert.equal(actionNeedsFetch('fulfill'), true);
  assert.equal(actionNeedsFetch('modify'), true);
  assert.equal(actionNeedsFetch('block'), false);
  assert.equal(actionNeedsFetch('abort'), false);
  assert.equal(actionNeedsFetch('redirect'), false);
});

// ---------------------------------------------------------------------------
// network.waterfall / network.replay
// ---------------------------------------------------------------------------

test('buildNetworkWaterfall：相对时间轴、分类、错误与慢请求统计', () => {
  const entries = [
    { id: 1, url: 'http://a/test.html', type: 'Document', method: 'GET', status: 200, durationMs: 40, startedAt: 1000 },
    { id: 2, url: 'http://a/api/ping', type: 'fetch', method: 'GET', status: 200, durationMs: 1500, startedAt: 1050 },
    { id: 3, url: 'http://a/app.js', type: 'script', method: 'GET', status: 404, durationMs: 20, startedAt: 1060, error: 'HTTP 404' },
    { id: 4, url: 'http://a/style.css', type: 'stylesheet', method: 'GET', status: 200, durationMs: 10, startedAt: 1070, transferSize: 2048 },
  ];
  const built = buildNetworkWaterfall(entries, { slowMs: 1_000 });
  assert.equal(built.rows.length, 4);
  assert.equal(built.rows[0]?.startOffsetMs, 0);
  assert.equal(built.rows[1]?.startOffsetMs, 50);
  assert.equal(built.rows[1]?.kind, 'xhr');
  assert.equal(built.rows[2]?.kind, 'script');
  assert.equal(built.rows[2]?.ok, false);
  assert.equal(built.summary.count, 4);
  assert.equal(built.summary.errors, 1);
  assert.equal(built.summary.slowCount, 1);
  assert.equal(built.summary.maxMs, 1500);
  assert.equal(built.summary.wallMs, 1550, '跨度以最后结束的那条为准（1050 起点 + 1500ms）');
  assert.equal(built.summary.totalBytes, 2048);
  // 过滤 + limit
  const filtered = buildNetworkWaterfall(entries, { urlContains: 'API', limit: 1 });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0]?.url, 'http://a/api/ping');
});

test('NetworkService.waterfall：从采集时间线生成 rows/summary', async () => {
  const content = {
    async request(_tabId: number, _request: ContentRequest): Promise<ContentReply> {
      return {
        ok: true,
        result: {
          url: 'http://a/test.html',
          timeOrigin: 0,
          entries: [
            { id: 1, url: 'http://a/test.html', initiatorType: 'navigation', status: 200, durationMs: 30, startedAt: 2100, transferSize: 100, finished: true, fromCache: false, timings: {} },
            { id: 2, url: 'http://a/api/ping', initiatorType: 'fetch', status: 200, durationMs: 60, startedAt: 2140, transferSize: 20, finished: true, fromCache: false, timings: {} },
          ],
        },
      } as unknown as ContentReply;
    },
  };
  const service = new NetworkService({ content, now: () => 2_000 });
  await service.start({ tabId: 7 });
  const waterfall = await service.waterfall({ tabId: 7, limit: 10 });
  const rows = waterfall['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows.length >= 1, true, 'waterfall 应有行：' + JSON.stringify(waterfall).slice(0, 200));
  assert.equal((waterfall['summary'] as Record<string, unknown>)['count'], rows.length);
  assert.equal(typeof rows[0]?.['startOffsetMs'], 'number');
});

test('NetworkService.replay：主世界重放返回状态/正文/耗时', async () => {
  const content = {
    async request(): Promise<ContentReply> {
      return { ok: true, result: { url: 'http://a/test.html', timeOrigin: 0, entries: [] } } as unknown as ContentReply;
    },
  };
  const injections: Array<Record<string, unknown>> = [];
  const scripting = {
    scripting: {
      async executeScript<T>(injection: { args?: unknown[] }): Promise<Array<{ result?: T }>> {
        injections.push({ args: injection.args });
        return [{
          result: {
            ok: true,
            status: 200,
            statusText: 'OK',
            durationMs: 12,
            body: '{"ok":true}',
            truncated: false,
            headers: { 'content-type': 'application/json' },
          } as unknown as T,
        }];
      },
    },
  };
  const service = new NetworkService({ content, scripting, now: () => 5_000 });
  const replayed = await service.replay({ tabId: 7, id: 3, request: { url: 'http://a/api/ping', method: 'get', headers: { 'x-a': 'b' } } });
  assert.equal(replayed['ok'], true);
  assert.equal(replayed['status'], 200);
  assert.equal(replayed['body'], '{"ok":true}');
  assert.equal(replayed['mode'], 'page-fetch-replay');
  const args = injections[0]?.['args'] as Array<Record<string, unknown>>;
  assert.equal(args[0]?.['url'], 'http://a/api/ping');
  assert.equal(args[0]?.['method'], 'GET');
});

test('NetworkService.replay：没有 chrome.scripting 时 E_NOT_IMPLEMENTED', async () => {
  const content = { async request(): Promise<ContentReply> { return { ok: true, result: { url: '', entries: [] } } as unknown as ContentReply; } };
  const service = new NetworkService({ content });
  await assert.rejects(() => service.replay({ tabId: 7, request: { url: 'http://a/x' } }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_NOT_IMPLEMENTED');
    return true;
  });
});
