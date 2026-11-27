// tests/record-store.test.ts —— 录制历史持久化（内存/session/local 降级、裁剪、删除、摘要）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordStore, RECORDINGS_KEY, summarizeRecording, type StorageAreaLike } from '../src/record/store.ts';
import type { Recording } from '../src/record/types.ts';

function recordingOf(id: string, eventCount = 1, extra: Partial<Recording> = {}): Recording {
  const events = Array.from({ length: eventCount }, (_, index) => ({
    kind: 'click',
    seq: index + 1,
    ts: 1_700_000_000_000 + index,
    actor: 'human',
    url: 'https://example.test/',
    frameId: 0,
    documentId: 'doc-1',
    boundary: { documentId: 'doc-1', frameId: 0, revision: null },
    selector: '#btn-' + index,
  }));
  return {
    id,
    tabId: 3,
    url: 'https://example.test/',
    title: '录制 ' + id,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    events,
    includeAgent: false,
    ...extra,
  };
}

class FakeArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();
  setCalls = 0;
  failSet = false;
  failGet = false;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.failGet) throw new Error('get failed');
    return this.data.has(key) ? { [key]: this.data.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error('quota exceeded');
    this.setCalls += 1;
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  clone(): Recording[] {
    const list = this.data.get(RECORDINGS_KEY);
    return Array.isArray(list) ? (list as Recording[]) : [];
  }
}

test('无 chrome.storage：save 落内存并给出 warning，load 读得回', async () => {
  const store = new RecordStore({}, { maxRecordings: 3 });
  const result = await store.save(recordingOf('rec-1'));
  assert.equal(result.saved, false);
  assert.equal(result.backend, 'memory');
  assert.match(result.warning, /内存/);
  assert.equal(store.backendKind(), 'memory');
  const list = await store.load();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'rec-1');
  assert.equal(store.memorySnapshot().length, 1);
});

test('session+local：写入两处、读取优先 local、前插顺序与上限生效', async () => {
  const session = new FakeArea();
  const local = new FakeArea();
  const store = new RecordStore({ session, local }, { maxRecordings: 2 });
  await store.save(recordingOf('a'));
  await store.save(recordingOf('b'));
  const third = await store.save(recordingOf('c'));
  assert.equal(third.saved, true);
  assert.equal(third.backend, 'session+local');
  assert.equal(third.recordings, 2, '超过 maxRecordings 裁掉最旧的');
  assert.deepEqual(local.clone().map((item) => item.id), ['c', 'b']);
  assert.deepEqual(session.clone().map((item) => item.id), ['c', 'b']);

  const reloaded = new RecordStore({ session, local });
  const list = await reloaded.load();
  assert.deepEqual(list.map((item) => item.id), ['c', 'b']);
  assert.equal(reloaded.backendKind(), 'session+local');
});

test('session-only/local-only 的 backend 判定与读取', async () => {
  const sessionOnly = new FakeArea();
  const store = new RecordStore({ session: sessionOnly });
  const saved = await store.save(recordingOf('s'));
  assert.equal(saved.backend, 'session');
  assert.equal(store.backendKind(), 'session');
  const reloaded = new RecordStore({ session: sessionOnly });
  assert.deepEqual((await reloaded.load()).map((item) => item.id), ['s']);

  const localOnly = new FakeArea();
  const localStore = new RecordStore({ local: localOnly });
  const savedLocal = await localStore.save(recordingOf('l'));
  assert.equal(savedLocal.backend, 'local');
  assert.deepEqual((await new RecordStore({ local: localOnly }).load()).map((item) => item.id), ['l']);
});

test('事件数裁剪（保留最近 maxEvents 条）与旧录制截图清理', async () => {
  const local = new FakeArea();
  const store = new RecordStore({ local }, { maxEvents: 3 });
  const older = recordingOf('older', 1);
  older.events[0]!.screenshot = 'data:image/png;base64,OLD';
  await store.save(older);
  const newest = recordingOf('newest', 5);
  newest.events[4]!.screenshot = 'data:image/png;base64,NEW';
  const saved = await store.save(newest);
  assert.equal(saved.saved, true);
  const list = await store.load();
  const persistedNewest = list.find((item) => item.id === 'newest');
  assert.equal(persistedNewest?.events.length, 3, '单条录制事件数按上限裁剪');
  assert.equal(persistedNewest?.events[2]?.screenshot, 'data:image/png;base64,NEW', '最新录制保留步骤截图');
  const persistedOlder = list.find((item) => item.id === 'older');
  assert.equal(persistedOlder?.events[0]?.screenshot, undefined, '旧录制不保留截图（防配额）');
});

test('两处写入都失败：仍保留内存并在返回里如实报告', async () => {
  const session = new FakeArea();
  const local = new FakeArea();
  session.failSet = true;
  local.failSet = true;
  const store = new RecordStore({ session, local });
  const result = await store.save(recordingOf('mem'));
  assert.equal(result.saved, false);
  assert.equal(result.backend, 'memory');
  assert.match(result.warning, /session 写入失败/);
  assert.equal(store.memorySnapshot().length, 1);
  assert.equal((await store.load()).length, 1);
});

test('storage 读取异常时降级为内存，不影响后续 save', async () => {
  const local = new FakeArea();
  local.failGet = true;
  const store = new RecordStore({ local });
  assert.deepEqual(await store.load(), []);
  const saved = await store.save(recordingOf('r'));
  assert.equal(saved.saved, true);
  assert.equal(store.backendKind(), 'local');
});

test('remove 删除一条并同步 storage；未知 id 返回 0', async () => {
  const local = new FakeArea();
  const store = new RecordStore({ local });
  await store.save(recordingOf('a'));
  await store.save(recordingOf('b'));
  assert.equal(await store.remove('a'), 1);
  assert.deepEqual((await store.load()).map((item) => item.id), ['b']);
  assert.equal(await store.remove('missing'), 0);
  assert.equal(await store.remove(''), 0);
});

test('summarizeRecording：事件数/种类/agent 标记', () => {
  const recording = recordingOf('sum', 3, { includeAgent: true });
  recording.events[1] = { ...recording.events[1]!, kind: 'hover' };
  const summary = summarizeRecording(recording);
  assert.equal(summary.id, 'sum');
  assert.equal(summary.events, 3);
  assert.equal(summary.includeAgent, true);
  assert.equal(summary.kinds.click, 2);
  assert.equal(summary.kinds.hover, 1);
});

test('非法录制形状被拒绝持久化（不抛异常）', async () => {
  const store = new RecordStore({});
  const result = await store.save(null as unknown as Recording);
  assert.equal(result.saved, false);
  assert.match(result.warning, /非法/);
});
