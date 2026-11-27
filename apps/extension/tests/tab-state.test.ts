// tests/tab-state.test.ts —— per-tab 策略 / alias / 活动登记 与 tab 控制面命令单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TabActivityRegistry, TabAliasStore, TabPolicyStore } from '../src/runtime/tab-state.ts';
import { createTabCommands } from '../src/runtime/tab-commands.ts';
import type { BrowserApiLike } from '../src/runtime/commands.ts';

class MemoryStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: this.data.get(key) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }
}

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
}

function createFakeApi(tabs: FakeTab[]) {
  const removed: number[] = [];
  const api: BrowserApiLike = {
    tabs: {
      async get(tabId: number) {
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) throw new Error('No tab with id ' + String(tabId));
        return tab;
      },
      async query() {
        return [...tabs];
      },
      async update() {
        return tabs[0] as FakeTab;
      },
      async create() {
        return tabs[0] as FakeTab;
      },
      async remove(tabId: number) {
        removed.push(tabId);
        const index = tabs.findIndex((item) => item.id === tabId);
        if (index >= 0) tabs.splice(index, 1);
      },
      async reload() {},
      onUpdated: { addListener() {}, removeListener() {} },
    },
    windows: {
      async getAll() { return []; },
      async create() { return {}; },
      async get() { return {}; },
      async update() { return {}; },
      async remove() {},
    },
    storage: { local: new MemoryStorage(), session: new MemoryStorage() },
  };
  return { api, removed };
}

test('tab-state：policy patch/get/clear 并持久化到 storage', async () => {
  const storage = new MemoryStorage();
  const store = new TabPolicyStore(storage);
  const patched = await store.patch(7, { readOnly: true, allowedOrigins: 'https://example.test, http://127.0.0.1:8080' });
  assert.equal(patched.readOnly, true);
  assert.deepEqual(patched.allowedOrigins, ['https://example.test', 'http://127.0.0.1:8080']);
  const reloaded = new TabPolicyStore(storage);
  const stored = await reloaded.get(7);
  assert.equal(stored?.readOnly, true);
  const cleared = await store.patch(7, { clear: true });
  assert.equal(cleared.readOnly, false);
  assert.equal(await store.get(7), null);
});

test('tab-state：policy 只读时拒绝变更动作、放行只读面', async () => {
  const store = new TabPolicyStore(new MemoryStorage());
  await store.patch(7, { readOnly: true });
  for (const method of ['click', 'fill', 'select', 'evaluate', 'drag', 'press', 'navigate']) {
    assert.equal(store.authorize(7, method).ok, false, method + ' 应被拒绝');
  }
  for (const method of ['observe', 'read', 'get-html', 'screenshot', 'extract', 'wait-for-element', 'network.list']) {
    assert.equal(store.authorize(7, method).ok, true, method + ' 应放行');
  }
  const denied = store.authorize(7, 'click');
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, 'E_READ_ONLY');
    assert.deepEqual(denied.data, { tabId: 7, method: 'click', reason: 'read-only' });
  }
  assert.equal(store.authorize(8, 'click').ok, true, '未设置策略的 tab 不受影响');
});

test('tab-state：allowedOrigins 导航校验', async () => {
  const store = new TabPolicyStore(new MemoryStorage());
  await store.patch(7, { allowedOrigins: 'https://example.test' });
  await store.checkNavigation(7, 'https://example.test/a');
  await assert.rejects(
    () => store.checkNavigation(7, 'https://other.test/'),
    (error: unknown) => (error as { code?: string }).code === 'E_FORBIDDEN',
  );
  await assert.rejects(() => store.checkNavigation(7, 'not a url'), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('tab-state：alias set/list/resolve/clear 与校验', async () => {
  const storage = new MemoryStorage();
  const aliases = new TabAliasStore(storage);
  await aliases.set(11, 'e2e-alias');
  assert.deepEqual(await aliases.list(), { 'e2e-alias': 11 });
  assert.equal(await aliases.resolve('e2e-alias'), 11);
  await aliases.set(11, 'second');
  assert.deepEqual(await aliases.list(), { second: 11 }, '同一 tab 只保留一个 alias');
  const reloaded = new TabAliasStore(storage);
  assert.equal(await reloaded.resolve('second'), 11);
  assert.deepEqual(await aliases.clear('second'), { alias: 'second', removed: true });
  await assert.rejects(() => aliases.resolve('second'), (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND');
  await assert.rejects(() => aliases.set(11, 'bad alias!'), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('tab-state：activity 记录/触摸/丢弃/排序', () => {
  let clock = 0;
  const activity = new TabActivityRegistry(() => clock);
  activity.record(1);
  clock = 10;
  activity.record(2);
  clock = 20;
  activity.touch(1);
  const list = activity.list();
  assert.deepEqual(list.map((item) => item.tabId), [1, 2]);
  assert.equal(list[0]?.lastSeen, 20);
  activity.drop(1);
  assert.deepEqual(activity.list().map((item) => item.tabId), [2]);
});

function commandHandler(commands: ReturnType<typeof createTabCommands>, method: string) {
  const command = commands.find((item) => item.method === method);
  assert.ok(command, '缺少命令 ' + method);
  return (params: Record<string, unknown>, requestId = 'r1') => command!.handler({
    method,
    params,
    timeoutMs: 10_000,
    requestId,
    now: Date.now(),
  });
}

test('tab-commands：tab.alias set/list/resolve/clear 全链路', async () => {
  const { api } = createFakeApi([{ id: 7, windowId: 3, url: 'https://example.test/', active: true }]);
  const policies = new TabPolicyStore(new MemoryStorage());
  const aliases = new TabAliasStore(new MemoryStorage());
  const commands = createTabCommands({ api, policies, aliases });
  const alias = commandHandler(commands, 'tab.alias');
  const setResult = await alias({ action: 'set', tabId: 7, alias: 'e2e' }) as { ok: boolean; tabId: number };
  assert.equal(setResult.tabId, 7);
  const list = await alias({ action: 'list' }) as { aliases: Record<string, number> };
  assert.deepEqual(list.aliases, { e2e: 7 });
  const resolved = await alias({ action: 'resolve', alias: 'e2e' }) as { tabId: number };
  assert.equal(resolved.tabId, 7);
  await assert.rejects(async () => { await alias({ action: 'resolve', alias: 'missing' }); }, (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND');
  await assert.rejects(async () => { await alias({ action: 'set', tabId: 999, alias: 'x' }); }, (error: unknown) => (error as { code?: string }).code === 'E_NO_TAB');
  await assert.rejects(async () => { await alias({ action: 'bogus' }); }, (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  const cleared = await alias({ action: 'clear', alias: 'e2e' }) as { removed: boolean };
  assert.equal(cleared.removed, true);
});

test('tab-commands：tab.policy 设置/读取/清除', async () => {
  const { api } = createFakeApi([{ id: 7, windowId: 3, url: 'https://example.test/', active: true }]);
  const policies = new TabPolicyStore(new MemoryStorage());
  const commands = createTabCommands({ api, policies, aliases: new TabAliasStore(new MemoryStorage()) });
  const policy = commandHandler(commands, 'tab.policy');
  const updated = await policy({ tabId: 7, readOnly: true, keepOpen: true }) as { policy: { readOnly: boolean; keepOpen: boolean }; applied: string[] };
  assert.equal(updated.policy.readOnly, true);
  assert.equal(updated.policy.keepOpen, true);
  assert.deepEqual(updated.applied, ['readOnly', 'keepOpen']);
  const read = await policy({ tabId: 7 }) as { policy: { readOnly: boolean } };
  assert.equal(read.policy.readOnly, true);
  const cleared = await policy({ tabId: 7, clear: true }) as { policy: { readOnly: boolean } };
  assert.equal(cleared.policy.readOnly, false);
});

test('tab-commands：tab.cleanup 只清本运行时创建的 tab，keepOpen/active 保留', async () => {
  const tabs: FakeTab[] = [
    { id: 1, windowId: 3, url: 'https://example.test/active', active: true },
    { id: 2, windowId: 3, url: 'https://example.test/keep', active: false },
    { id: 3, windowId: 3, url: 'https://example.test/idle', active: false },
  ];
  const { api, removed } = createFakeApi(tabs);
  const policies = new TabPolicyStore(new MemoryStorage());
  await policies.patch(2, { keepOpen: true });
  let clock = 0;
  const activity = new TabActivityRegistry(() => clock);
  activity.record(1);
  activity.record(2);
  clock = 1000;
  activity.record(3);
  clock = 2000;
  const commands = createTabCommands({ api, policies, aliases: new TabAliasStore(new MemoryStorage()), activity, now: () => clock });
  const cleanup = commandHandler(commands, 'tab.cleanup');
  const dry = await cleanup({ idleMs: 500, dryRun: true }) as {
    dryRun: boolean; close: number[]; keep: Array<{ tabId: number; reason: string }>; scanned: number;
  };
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.close, [3], '只有本运行时创建且空闲的 tab 进入 close');
  assert.equal(dry.keep.some((item) => item.tabId === 2 && item.reason === 'keep-open'), true);
  assert.equal(dry.keep.some((item) => item.tabId === 1 && item.reason === 'active-tab'), true);
  assert.equal(dry.scanned, 3);
  assert.deepEqual(removed, [], 'dry-run 不真正关闭');
  const real = await cleanup({ idleMs: 500, dryRun: false }) as { closed: number[]; close: number[] };
  assert.deepEqual(real.closed, [3]);
  assert.deepEqual(removed, [3]);
});
