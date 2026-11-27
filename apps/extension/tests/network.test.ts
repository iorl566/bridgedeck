// tests/network.test.ts —— 网络只读面（NetworkService）单测。
//
// 断言重点：
// - 只读口径：method/commandId/headers/body 一律为 null，并带 limitations（不伪造 CDP 能力）；
// - 时间线过滤：start 之后 / since / urlContains / status / type / limit；
// - 生命周期：start→list→stop、forgetTab 清理、未 start 的空列表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkService } from '../src/network/service.ts';
import type { ContentNetworkEntry, ContentReply, ContentRequest } from '../src/content/protocol.ts';

function entry(overrides: Partial<ContentNetworkEntry> = {}): ContentNetworkEntry {
  return {
    id: 1,
    url: 'https://example.test/api/ping',
    initiatorType: 'fetch',
    startedAt: 1000,
    durationMs: 4,
    status: 200,
    transferSize: 330,
    encodedBodySize: 300,
    decodedBodySize: 280,
    fromCache: false,
    finished: true,
    timings: { redirectMs: null, dnsMs: 0, connectMs: 0, tlsMs: 0, requestMs: 1, ttfbMs: 1, downloadMs: 1 },
    ...overrides,
  };
}

function createHarness(entries: ContentNetworkEntry[] = [entry()], now = 500) {
  const requests: ContentRequest[] = [];
  const transport = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      requests.push(request);
      return {
        ok: true,
        result: { entries, url: 'https://example.test/', timeOrigin: 900, now: 100, seen: entries.length },
      };
    },
  };
  let clock = now;
  const service = new NetworkService({ content: transport, now: () => clock });
  return { service, requests, advance: (ms: number) => { clock += ms; } };
}

test('network：start 记录时间线基线并声明不使用 debugger', async () => {
  const harness = createHarness();
  const result = await harness.service.start({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'resource-timing');
  assert.equal(result.bodies, false);
  assert.equal((result.limitations as string[]).some((line) => line.includes('no-debugger')), true);
  assert.equal(harness.service.activeCaptures().length, 1);
});

test('network：list 过滤 since / urlContains / status / type / limit', async () => {
  const entries = [
    entry({ id: 1, url: 'https://example.test/api/ping', startedAt: 1000, status: 200 }),
    entry({ id: 2, url: 'https://example.test/api/ping', startedAt: 2000, status: 500, initiatorType: 'xmlhttprequest' }),
    entry({ id: 3, url: 'https://example.test/app.js', startedAt: 3000, status: 200, initiatorType: 'script' }),
  ];
  const harness = createHarness(entries);
  await harness.service.start({ tabId: 7 });
  const byUrl = await harness.service.list({ tabId: 7, filter: { urlContains: '/api/ping' } });
  assert.equal((byUrl.entries as unknown[]).length, 2);
  const byStatus = await harness.service.list({ tabId: 7, filter: { status: 500 } });
  assert.equal((byStatus.entries as Array<{ status: number }>).length, 1);
  assert.equal((byStatus.entries as Array<{ status: number }>)[0]?.status, 500);
  const byType = await harness.service.list({ tabId: 7, filter: { type: 'script' } });
  assert.equal((byType.entries as unknown[]).length, 1);
  const limited = await harness.service.list({ tabId: 7, limit: 1 });
  assert.equal((limited.entries as unknown[]).length, 1);
  const since = await harness.service.list({ tabId: 7, since: 2500 });
  assert.equal((since.entries as Array<{ id: number }>)[0]?.id, 3);
});

test('network：method 过滤明确返回空集（资源计时没有 HTTP 方法）', async () => {
  const harness = createHarness();
  await harness.service.start({ tabId: 7 });
  const result = await harness.service.list({ tabId: 7, filter: { method: 'GET' } });
  assert.equal((result.entries as unknown[]).length, 0);
});

test('network：未 start 时 list 返回空且 active=false、bodies=false', async () => {
  const harness = createHarness();
  const result = await harness.service.list({ tabId: 9 });
  assert.equal(result.active, false);
  assert.equal(result.bodies, false);
  assert.equal((result.entries as unknown[]).length, 1, '未 start 时按 since=0 返回时间线可见条目');
});

test('network：公开条目字段是只读口径（method/commandId/headers 都为 null）', async () => {
  const harness = createHarness([entry({ id: 1, url: 'https://example.test/api/ping' })]);
  await harness.service.start({ tabId: 7 });
  const result = await harness.service.list({ tabId: 7 });
  const item = (result.entries as Array<Record<string, unknown>>)[0] ?? {};
  assert.equal(item.method, null);
  assert.equal(item.commandId, null);
  assert.equal(item.requestId, null);
  assert.equal(item.frame, null);
  assert.equal(item.status, 200);
  assert.equal(item.transferSize, 330);
  assert.equal(item.finished, true);
});

test('network：stop 返回 start 之后的新条目数并停止 active', async () => {
  const entries: ContentNetworkEntry[] = [entry({ id: 1 })];
  const harness = createHarness(entries);
  await harness.service.start({ tabId: 7 });
  entries.push(entry({ id: 2, url: 'https://example.test/late', startedAt: 2000 }));
  const stopped = await harness.service.stop({ tabId: 7 });
  assert.equal(stopped.active, false);
  assert.equal(stopped.entries, 1);
  assert.equal(harness.service.activeCaptures().length, 0);
});

test('network：detail 返回阶段计时并明确正文不可得', async () => {
  const harness = createHarness([entry({ id: 1 })]);
  await harness.service.start({ tabId: 7 });
  const detail = await harness.service.detail({ tabId: 7, id: 1 });
  assert.equal((detail.entry as { url: string }).url.includes('/api/ping'), true);
  assert.equal(detail.responseBody, null);
  assert.equal(detail.responseBodyUnavailable, 'no-debugger');
  assert.equal((detail.timings as { requestMs: number }).requestMs, 1);
});

test('network：detail 找不到条目 / 非法 id', async () => {
  const harness = createHarness([entry({ id: 1 })]);
  await assert.rejects(() => harness.service.detail({ tabId: 7, id: 99 }), (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND');
  await assert.rejects(() => harness.service.detail({ tabId: 7, id: 0 }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('network：forgetTab 清理采集状态', async () => {
  const harness = createHarness();
  await harness.service.start({ tabId: 7 });
  harness.service.forgetTab(7);
  assert.equal(harness.service.activeCaptures().length, 0);
  const result = await harness.service.start({ tabId: 7 });
  assert.equal(result.active, true);
});

test('network：缺 tabId 的命令回 E_BAD_ARG', async () => {
  const harness = createHarness();
  await assert.rejects(() => harness.service.start({}), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  await assert.rejects(() => harness.service.list({}), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});
