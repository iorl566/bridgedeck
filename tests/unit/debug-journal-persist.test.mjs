// tests/unit/debug-journal-persist.test.mjs —— journal 持久化模型（seq/环形缓冲/索引/恢复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_JOURNAL_LIMITS,
  EVICTION_REASONS,
  JOURNAL_STORE_VERSION,
  createDebugJournalStore,
  createIndexedDbStorageAdapter,
  createMemoryStorage,
  createStorageFromHandlers,
  jsonByteLength,
  utf8ByteLength,
} from '../../extension/src/lib/debug-journal-persist.js';
import { redactJournalEvent, scanForPlaintextSecrets } from '../../extension/src/lib/debug-redact.js';

function makeStore(options = {}) {
  let tick = 0;
  const clock = options.clock || (() => (tick += 10));
  return createDebugJournalStore({
    storage: options.storage || createMemoryStorage(),
    clock,
    redact: options.redact === undefined ? redactJournalEvent : options.redact,
    limits: options.limits,
    storageKey: options.storageKey,
  });
}

test('append 分配单调 seq，按会话与时间索引可查', () => {
  const store = makeStore();
  const a1 = store.append('s1', { type: 'start', at: 300, name: 'a' });
  const b1 = store.append('s2', { type: 'pin', at: 100 });
  const a2 = store.append('s1', { type: 'stop', at: 200 });
  assert.deepEqual([a1.seq, b1.seq, a2.seq], [1, 2, 3]);
  assert.equal(a1.sessionId, 's1');
  assert.equal(a2.at, 200);

  const s1 = store.read('s1');
  assert.deepEqual(s1.map((event) => event.type), ['start', 'stop']);
  assert.deepEqual(store.read('s2').map((event) => event.type), ['pin']);

  // 时间索引按 at 排序（而不是写入顺序）
  assert.deepEqual(store.read(null, { since: 0, until: 1000 }).map((event) => event.at), [100, 200, 300]);
  const windowed = store.eventsInWindow(150, 250);
  assert.deepEqual(windowed.map((event) => event.at), [200]);

  // 时间索引内部结构保持 (at, seq) 升序
  const index = store._state.timeIndex;
  for (let i = 1; i < index.length; i += 1) {
    assert.ok(index[i - 1].at < index[i].at || (index[i - 1].at === index[i].at && index[i - 1].seq < index[i].seq));
  }
  assert.deepEqual(store.stats().events, 3);
});

test('环形缓冲：单会话上限淘汰最旧事件并记录原因', () => {
  const store = makeStore({ limits: { maxSessionEvents: 2 } });
  for (let index = 1; index <= 5; index += 1) store.append('s1', { type: 'rule', at: 100 + index, index });
  assert.equal(store.read('s1').length, 2);
  const kept = store.read('s1').map((event) => event.index);
  assert.deepEqual(kept, [4, 5]);
  const report = store.evictionReport();
  assert.equal(report.counts[EVICTION_REASONS.SESSION], 3);
  assert.equal(report.total, 3);
  assert.ok(report.recent.every((entry) => entry.sessionId === 's1'));
  assert.deepEqual(store.read('s1').map((event) => event.seq), [4, 5]);

  // 按 sessionId 报告：别的会话不受 s1 淘汰计数影响
  store.append('s2', { type: 'start', at: 500 });
  assert.equal(store.snapshot({ sessionId: 's2' }).evictions.total, 0);
  assert.deepEqual(store.snapshot({ sessionId: 's2' }).evictions.counts, {});
  const s1Report = store.snapshot({ sessionId: 's1' }).evictions;
  assert.equal(s1Report.total, 3);
  assert.deepEqual(s1Report.counts, { [EVICTION_REASONS.SESSION]: 3 });
  assert.equal(s1Report.sessions.s1, 3);
});

test('环形缓冲：全局条数上限淘汰最旧事件', () => {
  const store = makeStore({ limits: { maxEvents: 3, maxSessionEvents: 10 } });
  for (let index = 0; index < 6; index += 1) store.append('s1', { type: 'evt', at: 100 + index, index });
  assert.equal(store._state.events.length, 3);
  assert.deepEqual(store.read('s1').map((event) => event.index), [3, 4, 5]);
  assert.equal(store.evictionReport().counts[EVICTION_REASONS.GLOBAL], 3);
});

test('环形缓冲：字节预算与事件过大都有独立淘汰原因', () => {
  const byteStore = makeStore({ limits: { maxBytes: 700, maxEvents: 100, maxSessionEvents: 100 } });
  for (let index = 0; index < 8; index += 1) {
    byteStore.append('s1', { type: 'evt', at: 100 + index, payload: 'x'.repeat(90), index });
  }
  assert.ok(byteStore.stats().bytes <= 700, '字节预算没有生效：' + byteStore.stats().bytes);
  assert.ok((byteStore.evictionReport().counts[EVICTION_REASONS.BYTES] || 0) > 0);

  const bigStore = makeStore({ limits: { maxEventBytes: 200 } });
  const result = bigStore.append('s1', { type: 'replay', at: 100, body: 'y'.repeat(2000) });
  assert.equal(result.dropped, true);
  assert.equal(result.reason, EVICTION_REASONS.EVENT_TOO_LARGE);
  const snapshot = bigStore.snapshot({ sessionId: 's1' });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].dropped, true);
  assert.equal(snapshot.events[0].bytes > 200, true);
  assert.ok(Array.isArray(snapshot.events[0].keys));
  assert.equal(bigStore.evictionReport().counts[EVICTION_REASONS.EVENT_TOO_LARGE], 1);
  // 原文不落盘：序列化后不应出现 2000 个 y
  assert.equal(JSON.stringify(bigStore.exportState()).includes('y'.repeat(2000)), false);
});

test('环形缓冲：会话数上限淘汰最久未更新的会话', () => {
  // 与真实环境一致：clock 是 Date.now 同域的大数，updatedAt 顺序 = 会话创建顺序。
  let tick = 1_000_000;
  const store = makeStore({ limits: { maxSessions: 2, maxEvents: 100 }, clock: () => (tick += 10) });
  store.beginSession('old', { tabId: 1 });
  store.append('old', { type: 'start', at: 100 });
  store.beginSession('mid', { tabId: 2 });
  store.append('mid', { type: 'start', at: 200 });
  store.beginSession('new', { tabId: 3 });
  store.append('new', { type: 'start', at: 300 });
  const sessions = store.snapshot().sessions.map((session) => session.id).sort();
  assert.deepEqual(sessions, ['mid', 'new']);
  assert.equal(store.read('old').length, 0);
  assert.equal(store.evictionReport().counts[EVICTION_REASONS.SESSION_CAPACITY], 1);
});

test('appendMany / beginSession / endSession / clearSession / removeSession 语义', () => {
  const store = makeStore();
  const begun = store.beginSession('tab-1', { tabId: 1, url: 'https://x.test/?token=SECRET_TOKEN' });
  assert.equal(begun.id, 'tab-1');
  assert.equal(begun.meta.tabId, 1);
  assert.doesNotMatch(JSON.stringify(begun.meta), /SECRET_TOKEN/);
  const events = store.appendMany('tab-1', [{ type: 'a', at: 1 }, { type: 'b', at: 2 }, { type: 'c', at: 3 }]);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);

  const ended = store.endSession('tab-1', { requests: 2 });
  assert.ok(ended.endedAt > 0);
  assert.equal(ended.meta.requests, 2);
  assert.equal(store.sessionSummary('tab-1').count, 3);

  const cleared = store.clearSession('tab-1');
  assert.equal(cleared.length, 3);
  assert.equal(store.read('tab-1').length, 0);
  assert.equal(store.sessionSummary('tab-1').count, 0);
  assert.ok(store.evictionReport().counts[EVICTION_REASONS.CLEARED] >= 3);

  assert.equal(store.removeSession('tab-1'), true);
  assert.equal(store.sessionSummary('tab-1'), null);
  assert.equal(store.removeSession('tab-1'), false);
});

test('query 支持时间窗/类型过滤与 offset/page 分页', () => {
  const store = makeStore();
  for (let index = 0; index < 10; index += 1) {
    store.append(index % 2 === 0 ? 'a' : 'b', { type: index % 3 === 0 ? 'rule' : 'replay', at: 1000 + index * 10, index });
  }
  const page1 = store.query({ limit: 3, offset: 0 });
  assert.equal(page1.total, 10);
  assert.equal(page1.returned, 3);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 3);
  const page2 = store.query({ limit: 3, offset: 3 });
  assert.deepEqual(page2.items.map((event) => event.index), [3, 4, 5]);
  const page4 = store.query({ limit: 3, offset: 9 });
  assert.equal(page4.hasMore, false);
  assert.equal(page4.nextOffset, null);

  const windowed = store.query({ since: 1020, until: 1050 });
  assert.equal(windowed.total, 4);
  assert.deepEqual(windowed.items.map((event) => event.index), [2, 3, 4, 5]);

  const typed = store.query({ sessionId: 'b', types: ['replay'] });
  assert.equal(typed.total, 3); // b 会话 index 1/3/5/7/9 中 replay 是 1/5/7? index%3!==0 的奇数：1,5,7
  assert.deepEqual(typed.items.map((event) => event.index), [1, 5, 7]);

  const desc = store.read(null, { order: 'desc', limit: 2 });
  assert.deepEqual(desc.map((event) => event.index), [9, 8]);
});

test('flush 写入 storage、unchanged 跳过；hydrate 跨实例恢复 seq/事件/淘汰计数', async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ storage, limits: { maxSessionEvents: 4 } });
  store.beginSession('tab-9', { tabId: 9 });
  for (let index = 0; index < 6; index += 1) store.append('tab-9', { type: 'rule', at: 100 + index, index });
  const first = await store.flush();
  assert.equal(first.written, true);
  assert.equal(first.seq, 6);
  assert.ok(first.bytes > 0);
  const second = await store.flush();
  assert.equal(second.written, false);
  assert.equal(second.reason, 'unchanged');

  const restored = makeStore({ storage });
  const hydrated = await restored.hydrate();
  assert.equal(hydrated.restored, true);
  assert.equal(hydrated.seq, 6);
  assert.equal(hydrated.events, 4);
  assert.equal(restored.stats().seq, 6);
  assert.deepEqual(restored.read('tab-9').map((event) => event.index), [2, 3, 4, 5]);
  assert.equal(restored.evictionReport().counts[EVICTION_REASONS.SESSION], 2);
  // 按会话的淘汰计数也随 state 一起恢复
  assert.equal(restored.evictionReport('tab-9').total, 2);
  assert.deepEqual(restored.snapshot({ sessionId: 'tab-9' }).evictions.counts, { [EVICTION_REASONS.SESSION]: 2 });

  // 恢复后继续追加：seq 接着 6 往上，而不是回到 1
  const next = restored.append('tab-9', { type: 'stop', at: 200 });
  assert.equal(next.seq, 7);
  // 恢复后的实例再 hydrate 不应重复导入
  const again = await restored.hydrate();
  assert.equal(again.restored, false);
  assert.equal(again.reason, 'already-hydrated');
});

test('hydrate fail-safe：空 / 损坏 / 版本不匹配都返回 reason 且不抛', async () => {
  const empty = await makeStore().hydrate();
  assert.deepEqual({ restored: empty.restored, reason: empty.reason }, { restored: false, reason: 'empty' });

  const corruptStorage = createMemoryStorage({ 'bb.debug.journal.v2': '{not-json' });
  const corrupt = await makeStore({ storage: corruptStorage }).hydrate();
  assert.equal(corrupt.restored, false);
  assert.equal(corrupt.reason, 'corrupt');

  const versionStorage = createMemoryStorage({ 'bb.debug.journal.v2': JSON.stringify({ version: 99, events: [] }) });
  const mismatch = await makeStore({ storage: versionStorage }).hydrate();
  assert.equal(mismatch.restored, false);
  assert.equal(mismatch.reason, 'version-mismatch');

  const nonObject = createMemoryStorage({ 'bb.debug.journal.v2': JSON.stringify([1, 2, 3]) });
  const nonObjectResult = await makeStore({ storage: nonObject }).hydrate();
  assert.equal(nonObjectResult.restored, false);
  assert.equal(nonObjectResult.reason, 'corrupt');

  // storage.get 抛错也要 fail-safe
  const throwing = createDebugJournalStore({
    storage: { async get() { throw new Error('boom'); }, async set() {} },
    clock: () => 1,
  });
  const failure = await throwing.hydrate();
  assert.equal(failure.restored, false);
  assert.equal(failure.reason, 'storage-error');
  assert.match(failure.error, /boom/);
});

test('Node 形态：fs 文件 storage 真实落盘并恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-w2c-journal-'));
  const file = path.join(dir, 'journal.json');
  const storage = createStorageFromHandlers({
    async get() {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    async set(key, value) {
      fs.writeFileSync(file, value, 'utf8');
      assert.equal(key, 'bb.debug.journal.v2');
    },
    async remove() {
      fs.rmSync(file, { force: true });
    },
  });
  try {
    const store = makeStore({ storage });
    store.beginSession('node-session', { tabId: 42, name: 'node' });
    store.append('node-session', { type: 'start', at: 100, name: 'node' });
    store.append('node-session', { type: 'replay', at: 200, url: 'https://x.test/a?token=HIDDEN' });
    const flushed = await store.flush({ force: true });
    assert.equal(flushed.written, true);

    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, JOURNAL_STORE_VERSION);
    assert.equal(parsed.events.length, 2);
    assert.doesNotMatch(raw, /HIDDEN/);

    const restored = makeStore({ storage });
    const result = await restored.hydrate();
    assert.equal(result.restored, true);
    assert.deepEqual(restored.read('node-session').map((event) => event.type), ['start', 'replay']);
    assert.equal(restored.sessionSummary('node-session').meta.name, 'node');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化前统一脱敏：storage 文本不含 cookie/authorization/token/password 明文', async () => {
  const storage = createMemoryStorage();
  const store = makeStore({ storage });
  store.beginSession('s1', { tabId: 1, url: 'https://x.test/login?token=QUERY_SECRET' });
  store.append('s1', {
    type: 'replay',
    at: 100,
    url: 'https://x.test/a?access_token=URL_SECRET&page=2',
    headers: { Authorization: 'Bearer HEADER_SECRET', Cookie: 'sid=COOKIE_SECRET', 'Content-Type': 'text/plain' },
    responseHeaders: [{ name: 'set-cookie', value: 'sid=SET_COOKIE_SECRET' }, { name: 'x-trace', value: 'ok' }],
    cookies: [{ name: 'sid', value: 'COOKIE_ARRAY_SECRET' }],
    requestBody: JSON.stringify({ username: 'u', password: 'PASSWORD_SECRET', nested: { api_key: 'APIKEY_SECRET' } }),
    error: 'failed at https://x.test/cb?token=ERROR_SECRET',
  });
  assert.equal((await store.flush({ force: true })).written, true);
  const text = storage.dump()['bb.debug.journal.v2'];
  const secrets = [
    'QUERY_SECRET', 'URL_SECRET', 'HEADER_SECRET', 'COOKIE_SECRET', 'SET_COOKIE_SECRET',
    'COOKIE_ARRAY_SECRET', 'PASSWORD_SECRET', 'APIKEY_SECRET', 'ERROR_SECRET',
  ];
  const scan = scanForPlaintextSecrets(text, secrets);
  assert.deepEqual(scan.leaked, []);
  assert.equal(scan.clean, true);
  assert.match(text, /\[redacted\]/);

  // 非敏感字段仍然可读，脱敏不能把证据全吃掉
  const stored = store.read('s1')[0];
  assert.equal(stored.url.includes('page=2'), true);
  assert.equal(stored.headers['Content-Type'], 'text/plain');
});

test('IndexedDB 适配器：无 factory 拒绝，注入 fake factory 可读写删', async () => {
  const unavailable = createIndexedDbStorageAdapter({ factory: null });
  await assert.rejects(() => unavailable.open(), /IndexedDB 不可用/);

  const data = new Map();
  const fakeFactory = {
    open(name, version) {
      assert.equal(name, 'test-db');
      assert.equal(version, 1);
      const request = {};
      const db = {
        objectStoreNames: { contains: () => true },
        transaction() {
          const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
          const store = {
            get(key) {
              const req = {};
              queueMicrotask(() => {
                req.result = data.get(key);
                if (req.onsuccess) req.onsuccess();
                if (tx.oncomplete) tx.oncomplete();
              });
              return req;
            },
            put(value, key) {
              data.set(key, value);
              const req = {};
              queueMicrotask(() => {
                if (req.onsuccess) req.onsuccess();
                if (tx.oncomplete) tx.oncomplete();
              });
              return req;
            },
            delete(key) {
              data.delete(key);
              const req = {};
              queueMicrotask(() => {
                if (req.onsuccess) req.onsuccess();
                if (tx.oncomplete) tx.oncomplete();
              });
              return req;
            },
          };
          tx.objectStore = () => store;
          return tx;
        },
        close() {
          this.closed = true;
        },
      };
      setTimeout(() => {
        request.result = db;
        if (request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      }, 0);
      return request;
    },
  };
  const adapter = createIndexedDbStorageAdapter({ factory: fakeFactory, name: 'test-db', storeName: 'journal' });
  assert.equal(adapter.kind, 'indexeddb');
  assert.equal(await adapter.get('missing'), null);
  assert.equal(await adapter.set('k', 'v1'), true);
  assert.equal(await adapter.get('k'), 'v1');
  assert.equal(await adapter.remove('k'), true);
  assert.equal(await adapter.get('k'), null);
  await adapter.close();
});

test('limits/工具函数：UTF-8 字节数与默认上限', () => {
  assert.equal(DEFAULT_JOURNAL_LIMITS.maxEvents >= DEFAULT_JOURNAL_LIMITS.maxSessionEvents, true);
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('调试'), 6);
  assert.equal(jsonByteLength({ a: 1 }), utf8ByteLength(JSON.stringify({ a: 1 })));
  // undefined 归一化成 null 参与序列化（不让 undefined 把 JSON.stringify 变成 undefined）
  assert.equal(jsonByteLength(undefined), 4);
});
