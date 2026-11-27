// tests/video-selftest.test.ts —— 视频页自测编排单测：目标页选择 / 标题格式 / 两条 selftest 流程。
//
// 页面（record.ts）只做浏览器能力注入；这里用 fake 依赖验证：
// - selftest=1 的计数/容器/字节标题（E2E 35 正则 `SELFTEST:ok:video:\d+:(mp4|webm):\d+`）；
// - selftest=seed 的 id/字节/容器标题与两片切分（E2E 35r 读 parts[0]/parts[1]）；
// - 任何一步失败都必须抛错（页面据此写 SELFTEST:fail:*，不伪造 ok）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecordSelftestDetail,
  buildSeedSelftestDetail,
  pickRecordTarget,
  runRecordSelftest,
  runSeedSelftest,
  splitSeedChunks,
  type RecordSelftestDeps,
  type SeedSelftestDeps,
} from '../src/video/selftest.ts';

// ---------------------------------------------------------------------------
// 目标标签页选择
// ---------------------------------------------------------------------------

test('video-selftest：目标页过滤扩展/受限页，按 lastAccessed 取最近普通页', () => {
  const tabs = [
    { id: 1, url: 'https://slow.test/', title: 'slow', lastAccessed: 10 },
    { id: 2, url: 'https://fast.test/', title: 'fast', lastAccessed: 30 },
    { id: 3, url: 'chrome-extension://abc/record.html', title: 'self', lastAccessed: 99 },
    { id: 4, url: 'chrome://settings', title: 'settings', lastAccessed: 98 },
    { id: 5, url: 'about:blank', title: 'blank', lastAccessed: 97 },
    { id: 6, url: '', title: 'empty', lastAccessed: 96 },
  ];
  assert.equal(pickRecordTarget(tabs, { selfPrefix: 'chrome-extension://abc' }), 2);
  assert.equal(pickRecordTarget(tabs, { selfPrefix: 'chrome-extension://abc', preferredTabId: 1 }), 1);
  assert.equal(pickRecordTarget(tabs, { selfPrefix: 'chrome-extension://abc', preferredTabId: 4 }), 2);
  assert.equal(pickRecordTarget([], {}), null);
  assert.equal(pickRecordTarget([{ id: null, url: 'https://x.test/' }], {}), null);
});

// ---------------------------------------------------------------------------
// 标题格式
// ---------------------------------------------------------------------------

test('video-selftest：录制标题 = count:mp4|webm:bytes，空列表/0 字节报错', () => {
  assert.equal(buildRecordSelftestDetail([{ id: 'a', mime: 'video/mp4', bytes: 1234, startedAt: 1 }]), '1:mp4:1234');
  assert.equal(buildRecordSelftestDetail([
    { id: 'a', mime: 'video/mp4', bytes: 10, startedAt: 2 },
    { id: 'b', mime: 'video/webm', bytes: 20, startedAt: 1 },
  ], 'b'), '2:webm:20');
  assert.throws(() => buildRecordSelftestDetail([]), /录制没有落库/);
  assert.throws(() => buildRecordSelftestDetail([{ id: 'a', mime: 'video/mp4', bytes: 0 }]), /空文件/);
});

test('video-selftest：seed 标题 = id:bytes:mp4|webm', () => {
  assert.equal(buildSeedSelftestDetail('recover-drill-abc', 977, 'video/mp4'), 'recover-drill-abc:977:mp4');
  assert.equal(buildSeedSelftestDetail('x', 1, 'video/webm'), 'x:1:webm');
  assert.throws(() => buildSeedSelftestDetail('', 1, 'video/mp4'), /recordingId/);
  assert.throws(() => buildSeedSelftestDetail('x', 0, 'video/mp4'), /为空/);
});

// ---------------------------------------------------------------------------
// selftest=1 流程
// ---------------------------------------------------------------------------

function createRecordDeps(options: {
  tabId?: number | null;
  startError?: Error;
  recordingId?: string;
  stopError?: Error;
  records?: Array<{ id: string; mime: string; bytes: number; startedAt?: number }>;
} = {}): { deps: RecordSelftestDeps; calls: Array<{ name: string; params?: Record<string, unknown> }>; sleeps: number[] } {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  const deps: RecordSelftestDeps = {
    async pickTargetTab() { calls.push({ name: 'pick' }); return options.tabId === undefined ? 7 : options.tabId; },
    async start(params) {
      calls.push({ name: 'start', params: { ...params } });
      if (options.startError) throw options.startError;
      return { recordingId: options.recordingId ?? 'rec-self-1', mime: 'video/mp4', mode: 'tabCapture' };
    },
    async stop(params) {
      calls.push({ name: 'stop', params: { ...params } });
      if (options.stopError) throw options.stopError;
      return { ok: true };
    },
    async listRecords() {
      calls.push({ name: 'list' });
      return options.records ?? [{ id: 'rec-self-1', mime: 'video/mp4', bytes: 4321, startedAt: 1 }];
    },
    async sleep(ms) { sleeps.push(ms); },
    recordMs: 1200,
  };
  return { deps, calls, sleeps };
}

test('video-selftest：selftest=1 真实 start→sleep→stop→读回，标题为 count:mp4:bytes', async () => {
  const { deps, calls, sleeps } = createRecordDeps();
  const detail = await runRecordSelftest(deps);
  assert.equal(detail, '1:mp4:4321');
  assert.deepEqual(calls.map((item) => item.name), ['pick', 'start', 'stop', 'list']);
  assert.equal(calls[1]?.params?.tabId, 7);
  assert.deepEqual(sleeps, [1200]);
});

test('video-selftest：start 失败/缺 recordingId 一律抛错（页面转 SELFTEST:fail）', async () => {
  const failing = createRecordDeps({ startError: new Error('E_VIDEO_CAPTURE: 启动失败') });
  await assert.rejects(() => runRecordSelftest(failing.deps), /启动失败/);

  const noId = createRecordDeps({ recordingId: '' });
  await assert.rejects(() => runRecordSelftest(noId.deps), /recordingId/);

  const noTab = createRecordDeps({ tabId: null });
  await assert.rejects(() => runRecordSelftest(noTab.deps), /没有可录制的标签页/);
});

test('video-selftest：stop 失败仍尝试读回（真实失败在 list 阶段暴露）', async () => {
  const { deps, calls } = createRecordDeps({ stopError: new Error('stop 超时') });
  const detail = await runRecordSelftest(deps);
  assert.equal(detail, '1:mp4:4321');
  assert.ok(calls.some((item) => item.name === 'list'));
});

test('video-selftest：status 仍 active 或回读容器不可识别时不伪造成功', async () => {
  const { deps } = createRecordDeps();
  await assert.rejects(
    () => runRecordSelftest({ ...deps, status: async () => ({ active: true }) }),
    /仍处于活动态/,
  );
  await assert.rejects(
    () => runRecordSelftest({ ...deps, inspectRecord: async () => ({ bytes: 4321, container: 'unknown' }) }),
    /容器不可识别/,
  );
  await assert.rejects(
    () => runRecordSelftest({ ...deps, inspectRecord: async () => ({ bytes: 0, container: 'mp4' }) }),
    /空文件/,
  );
});

test('video-selftest：status/回读容器正常时成功返回原标题', async () => {
  const { deps, calls } = createRecordDeps();
  const detail = await runRecordSelftest({
    ...deps,
    status: async (recordingId) => {
      calls.push({ name: 'status', params: { recordingId } });
      return { active: false, state: 'ready', recordingId };
    },
    inspectRecord: async (recordingId) => {
      calls.push({ name: 'inspect', params: { recordingId } });
      return { bytes: 4321, container: 'mp4' };
    },
  });
  assert.equal(detail, '1:mp4:4321');
  assert.deepEqual(calls.map((item) => item.name), ['pick', 'start', 'stop', 'status', 'list', 'inspect']);
  assert.equal(calls[3]?.params?.recordingId, 'rec-self-1');
  assert.equal(calls[5]?.params?.recordingId, 'rec-self-1');
});

// ---------------------------------------------------------------------------
// selftest=seed 流程
// ---------------------------------------------------------------------------

test('video-selftest：两片切分覆盖全部字节且保持顺序', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const parts = splitSeedChunks(bytes);
  assert.equal(parts.length, 2);
  assert.deepEqual(Array.from(parts[0]?.data ?? []), [1, 2]);
  assert.deepEqual(Array.from(parts[1]?.data ?? []), [3, 4, 5]);
  assert.deepEqual(parts.map((item) => item.index), [0, 1]);
  assert.deepEqual(splitSeedChunks(new Uint8Array([9])).map((item) => item.index), [0]);
  assert.deepEqual(splitSeedChunks(new Uint8Array(0)), []);
});

test('video-selftest：selftest=seed 生成真实字节并写分片，标题 = id:bytes:mp4', async () => {
  const wrote: Array<{ recordingId: string; bytes: number; mime: string; startedAt: number }> = [];
  const clip = new Uint8Array(200).fill(7);
  const deps: SeedSelftestDeps = {
    async recordClip(options) {
      assert.equal(options.ms, 1000);
      return { bytes: clip, mime: 'video/mp4' };
    },
    async saveChunks(input) {
      wrote.push({ recordingId: input.recordingId, bytes: input.bytes.length, mime: input.mime, startedAt: input.startedAt });
    },
    now: () => 1_700_000_000_000,
    recordMs: 1000,
  };
  const detail = await runSeedSelftest(deps);
  const id = 'recover-drill-' + (1_700_000_000_000).toString(36);
  assert.equal(detail, id + ':200:mp4');
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0]?.recordingId, id);
  assert.equal(wrote[0]?.bytes, 200);
  assert.equal(wrote[0]?.mime, 'video/mp4');
});

test('video-selftest：seed 没录到字节时抛错（不生成空分片）', async () => {
  const deps: SeedSelftestDeps = {
    async recordClip() { return { bytes: new Uint8Array(0), mime: 'video/mp4' }; },
    async saveChunks() { throw new Error('不应写入'); },
    now: () => 1,
  };
  await assert.rejects(() => runSeedSelftest(deps), /没有录到任何分片/);
});
