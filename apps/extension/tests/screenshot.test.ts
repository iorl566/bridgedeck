// tests/screenshot.test.ts —— 截图只读面（ScreenshotService）单测。
//
// 全部依赖注入：假 browser.tabs / 假内容脚本传输 / 假 CanvasCodec，
// 因此可以精确断言“滚动到位 → 抓帧 → 拼接 → 裁剪 → 差分 → 流式读取”的几何与预算，
// 不需要真实浏览器（真实浏览器由 E2E 覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotService, mapCaptureError } from '../src/capture/screenshot.ts';
import { CaptureStore, CaptureStreamStore, base64ByteLength, dataUrlBase64 } from '../src/capture/store.ts';
import { createFakeCanvasCodec, fakePngDataUrl } from './support/fake-canvas.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';

interface FakeTab {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
}

function createFakeTabs(options: {
  tab: FakeTab;
  frames?: Array<{ width: number; height: number; dataUrl?: string }>;
  activeTabId?: number;
}) {
  const state = {
    tab: { ...options.tab },
    activeTabId: options.activeTabId ?? options.tab.id,
    requests: [] as string[],
    updates: [] as Array<{ tabId: number; props: Record<string, unknown> }>,
    captures: 0,
  };
  const frames = options.frames ?? [];
  const api = {
    tabs: {
      async get(tabId: number) {
        if (tabId !== state.tab.id) throw new Error('No tab with id ' + String(tabId));
        return { ...state.tab };
      },
      async query(queryInfo: Record<string, unknown>) {
        if (queryInfo.active === true && queryInfo.windowId === state.tab.windowId) {
          return [{ id: state.activeTabId, windowId: state.tab.windowId }];
        }
        return [];
      },
      async update(tabId: number, props: Record<string, unknown>) {
        state.updates.push({ tabId, props });
        if (props.active === true) state.activeTabId = tabId;
        return { ...state.tab, active: props.active === true };
      },
      async captureVisibleTab(windowId?: number, captureOptions?: Record<string, unknown>) {
        state.requests.push('capture:' + String(windowId) + ':' + String(captureOptions?.format ?? ''));
        const frame = frames[state.captures] ?? frames[frames.length - 1] ?? { width: 1000, height: 500 };
        state.captures += 1;
        return frame.dataUrl ?? fakePngDataUrl(frame.width, frame.height);
      },
    },
  };
  return { api, state };
}

interface FakeContentState {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  scrollHeight: number;
  scrollWidth: number;
  elementRect: { x: number; y: number; width: number; height: number };
  visualRefs: Array<{ ref: string; role: string; name: string; rect: { x: number; y: number; width: number; height: number } }>;
  ops: string[];
}

function createFakeContent(overrides: Partial<FakeContentState> = {}) {
  const state: FakeContentState = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: 500,
    scrollHeight: 500,
    scrollWidth: 1000,
    elementRect: { x: 10, y: 20, width: 200, height: 100 },
    visualRefs: [{ ref: '@e1', role: 'button', name: '提交', rect: { x: 10, y: 20, width: 100, height: 40 } }],
    ops: [],
    ...overrides,
  };
  const transport = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      state.ops.push(request.op);
      const params = request.params;
      if (request.op === 'metrics') {
        return {
          ok: true,
          result: {
            url: 'https://example.test/',
            title: '示例',
            scrollX: state.scrollX,
            scrollY: state.scrollY,
            innerWidth: state.innerWidth,
            innerHeight: state.innerHeight,
            scrollWidth: state.scrollWidth,
            scrollHeight: state.scrollHeight,
            devicePixelRatio: 1,
            documentId: 'doc-1',
          },
        };
      }
      if (request.op === 'scroll') {
        if (typeof params.y === 'number') state.scrollY = Math.max(0, Math.min(Number(params.y), state.scrollHeight - state.innerHeight));
        if (typeof params.x === 'number') state.scrollX = Math.max(0, Number(params.x));
        return {
          ok: true,
          result: {
            ok: true,
            scrollX: state.scrollX,
            scrollY: state.scrollY,
            clampedX: state.scrollX,
            clampedY: state.scrollY,
            bounds: null,
            viewport: { width: state.innerWidth, height: state.innerHeight },
            ref: null,
            selector: null,
            via: 'content-script',
          },
        };
      }
      if (request.op === 'element-state') {
        return {
          ok: true,
          result: {
            attached: true,
            visible: true,
            rect: state.elementRect,
            tag: 'table',
            id: 'people',
            role: 'table',
            name: '人员表',
            value: null,
            disabled: false,
            inViewport: true,
            ref: typeof params.ref === 'string' ? params.ref : null,
            selector: typeof params.selector === 'string' ? params.selector : null,
          },
        };
      }
      if (request.op === 'visual-refs') {
        return {
          ok: true,
          result: {
            refs: state.visualRefs,
            scrollX: state.scrollX,
            scrollY: state.scrollY,
            innerWidth: state.innerWidth,
            innerHeight: state.innerHeight,
            devicePixelRatio: 1,
            url: 'https://example.test/',
          },
        };
      }
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + request.op };
    },
  };
  return { state, transport };
}

function createService(overrides: Partial<Parameters<typeof createFakeTabs>[0]> = {}, contentOverrides: Partial<FakeContentState> = {}) {
  const tabs = createFakeTabs({ tab: { id: 7, windowId: 3, url: 'https://example.test/', active: true }, ...overrides });
  const content = createFakeContent(contentOverrides);
  const codec = createFakeCanvasCodec();
  const sleepCalls: number[] = [];
  let clock = 1_000;
  const service = new ScreenshotService({
    api: tabs.api,
    content: content.transport,
    codec,
    now: () => clock,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      clock += Math.max(0, ms);
    },
    captureIntervalMs: 550,
    maxFullPageFrames: 8,
    maxCanvasHeight: 16000,
  });
  return { service, tabs: tabs.state, content: content.state, codec, sleepCalls, advance: (ms: number) => { clock += ms; } };
}

test('screenshot：可见区域截图返回 dataUrl 与 PNG 尺寸', async () => {
  const harness = createService({ frames: [{ width: 1000, height: 500 }] });
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.width, 1000);
  assert.equal(result.height, 500);
  assert.equal(result.scope, 'viewport');
  assert.equal(String(result.dataUrl).startsWith('data:image/png;base64,'), true);
  assert.equal(harness.tabs.requests.length, 1);
});

test('screenshot：目标 tab 不是活动 tab 时临时激活并还原', async () => {
  const harness = createService({ activeTabId: 99, frames: [{ width: 800, height: 400 }] });
  const result = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(result.width, 800);
  assert.deepEqual(harness.tabs.updates.map((item) => item.tabId), [7, 99]);
  assert.equal(harness.tabs.updates[0]?.props.active, true);
  assert.equal(harness.tabs.updates[1]?.props.active, true);
});

test('screenshot：captureVisibleTab 限速（相邻截图间隔 ≥ 550ms）', async () => {
  const harness = createService({ frames: [{ width: 100, height: 100 }, { width: 100, height: 100 }] });
  await harness.service.takeScreenshot({ tabId: 7 });
  await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(harness.sleepCalls.length, 1);
  assert.equal(harness.sleepCalls[0], 550);
});

test('screenshot：整页截图按 innerHeight 分帧并恢复滚动位置', async () => {
  const harness = createService(
    { frames: [{ width: 1000, height: 500 }, { width: 1000, height: 500 }, { width: 1000, height: 500 }] },
    { scrollHeight: 1200, scrollY: 40 },
  );
  const result = await harness.service.takeScreenshot({ tabId: 7, fullPage: true });
  assert.equal(result.fullPage, true);
  assert.equal(result.height, 1200);
  assert.equal(Number(result.frames) >= 2, true);
  assert.equal(result.truncated, false);
  const scrolls = harness.content.ops.filter((op) => op === 'scroll').length;
  assert.equal(scrolls >= 3, true);
  // 最后一帧之后恢复到原始滚动位置
  assert.equal(harness.content.scrollY, 40);
});

test('screenshot：整页帧数超过上限时标记 truncated', async () => {
  const harness = createService(
    { frames: Array.from({ length: 10 }, () => ({ width: 1000, height: 500 })) },
    { scrollHeight: 6000, innerHeight: 500 },
  );
  const result = await harness.service.takeScreenshot({ tabId: 7, fullPage: true });
  assert.equal(result.fullPage, true);
  assert.equal(result.frames, 8);
  assert.equal(result.truncated, true);
  assert.equal(result.height, 6000);
});

test('screenshot：元素截图按元素矩形裁剪，并在截图后恢复滚动', async () => {
  const harness = createService(
    { frames: [{ width: 1000, height: 500 }] },
    { scrollY: 20, elementRect: { x: 30, y: 40, width: 120, height: 60 } },
  );
  const result = await harness.service.takeScreenshot({ tabId: 7, selector: '#people' });
  assert.deepEqual(result.element, { selector: '#people', tag: 'table' });
  assert.equal(result.width, 120);
  assert.equal(result.height, 60);
  assert.equal(harness.codec.crops.length, 1);
  assert.deepEqual(harness.codec.crops[0], { x: 30, y: 40, width: 120, height: 60 });
});

test('screenshot：区域截图输出 CSS 像素尺寸（高 DPR 时重采样）', async () => {
  const harness = createService({ frames: [{ width: 2000, height: 1000 }] }, { innerWidth: 1000, innerHeight: 500, scrollHeight: 500 });
  const result = await harness.service.takeScreenshot({ tabId: 7, region: { x: 10, y: 10, width: 100, height: 50 } });
  assert.equal(result.width, 100);
  assert.equal(result.height, 50);
  assert.deepEqual(harness.codec.crops[0], { x: 20, y: 20, width: 200, height: 100 });
  assert.deepEqual(harness.codec.cropOutputs[0], { width: 100, height: 50 });
});

test('screenshot：区域超出视口时明确 E_NOT_IMPLEMENTED（不接 CDP clip）', async () => {
  const harness = createService({ frames: [{ width: 1000, height: 500 }] });
  await assert.rejects(
    () => harness.service.takeScreenshot({ tabId: 7, region: { x: 900, y: 10, width: 400, height: 50 } }),
    (error: unknown) => (error as { code?: string }).code === 'E_NOT_IMPLEMENTED',
  );
});

test('screenshot：视觉/网格参数明确 E_NOT_IMPLEMENTED；分块/分段参数已迁移不再拒绝', async () => {
  const harness = createService();
  for (const params of [{ visualIndex: 1 }, { grid: true }]) {
    await assert.rejects(
      () => harness.service.takeScreenshot({ tabId: 7, ...params }),
      (error: unknown) => (error as { code?: string }).code === 'E_NOT_IMPLEMENTED',
      '应拒绝 ' + JSON.stringify(params),
    );
  }
  // 第四批：--tile-size / --segmented / --stale-attempts 已迁移（captureVisibleTab 分块拼接），
  // 这些参数不再整体拒绝，而是进入整页分块路径。
  const tiledHarness = createService(
    { frames: Array.from({ length: 6 }, () => ({ width: 1000, height: 500 })) },
    { innerWidth: 1000, innerHeight: 500, scrollHeight: 2600, scrollWidth: 1000 },
  );
  const tiled = await tiledHarness.service.takeScreenshot({ tabId: 7, fullPage: true, tileSize: 512, segmented: true, staleAttempts: 2 });
  assert.equal(Number(tiled.tile_size), 512);
  assert.equal(tiled.segmented, true);
  assert.equal(Number(tiled.segment_count) >= 1, true);
});

test('screenshot：annotate 生成 capture_id/visual_refs，capture 可单次消费', async () => {
  const harness = createService({ frames: [{ width: 1000, height: 500 }] });
  const result = await harness.service.takeScreenshot({ tabId: 7, annotate: true });
  assert.equal(typeof result.capture_id, 'string');
  assert.equal((result.visual_refs as unknown[]).length, 1);
  assert.equal(harness.codec.annotations.length, 1);
  const captureId = String(result.capture_id);
  const first = harness.service.consumeCapture(captureId);
  assert.ok(first);
  assert.equal(first?.tabId, 7);
  assert.equal(first?.scale, 1);
  const second = harness.service.consumeCapture(captureId);
  assert.equal(second, null);
});

test('screenshot：差分基线 → 同图 changed=0 → 变化后 changed>0', async () => {
  const dark = fakePngDataUrl(100, 50);
  const dark2 = fakePngDataUrl(100, 50).slice(0, -4) + 'AAA=';
  const red = fakePngDataUrl(100, 50).slice(0, -4) + 'BBB=';
  const harness = createService({ frames: [{ width: 100, height: 50, dataUrl: dark }, { width: 100, height: 50, dataUrl: dark2 }, { width: 100, height: 50, dataUrl: red }] });
  harness.codec.setPixels(dark, { width: 100, height: 50, color: [0, 0, 0, 255] });
  harness.codec.setPixels(dark2, { width: 100, height: 50, color: [0, 0, 0, 255] });
  harness.codec.setPixels(red, { width: 100, height: 50, color: [255, 0, 0, 255] });
  const first = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(first.diff, undefined);
  const same = await harness.service.takeScreenshot({ tabId: 7, diff: true });
  assert.equal((same.diff as { changed: number }).changed, 0);
  const changed = await harness.service.takeScreenshot({ tabId: 7, diff: true });
  assert.equal((changed.diff as { changed: number }).changed > 0, true);
});

test('screenshot：--stream 返回 captureId/bytes 并支持分块读回与释放', async () => {
  const harness = createService({ frames: [{ width: 200, height: 100 }] });
  const result = await harness.service.takeScreenshot({ tabId: 7, stream: true });
  assert.equal(result.streamed, true);
  assert.equal(typeof result.captureId, 'string');
  assert.equal(result.dataUrl, undefined);
  const first = harness.service.readChunk({ captureId: result.captureId, offset: 0, length: 4 });
  assert.equal(first.offset, 0);
  assert.equal(first.eof, false);
  const rest = harness.service.readChunk({ captureId: result.captureId, offset: first.nextOffset, length: 10_000_000 });
  assert.equal(rest.eof, true);
  assert.equal(first.total, rest.total);
  const released = harness.service.releaseStream({ captureId: result.captureId });
  assert.equal(released.released, true);
  assert.throws(() => harness.service.readChunk({ captureId: result.captureId }), (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND');
});

test('screenshot：manual frame 暂存 + save 纵向拼接并清空', async () => {
  const harness = createService({ frames: [{ width: 400, height: 300 }, { width: 400, height: 300 }] });
  const first = await harness.service.manualFrame({ tabId: 7 });
  assert.equal(first.frames, 1);
  const second = await harness.service.manualFrame({ tabId: 7 });
  assert.equal(second.frames, 2);
  const stitched = await harness.service.manualSave({ tabId: 7 });
  assert.equal(stitched.height, 600);
  assert.equal(stitched.frames, 2);
  assert.deepEqual(harness.codec.stitches.at(-1)?.drawYs, [0, 300]);
  await assert.rejects(() => harness.service.manualSave({ tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND');
});

test('screenshot：参数校验（缺 tabId / 非法 region）', async () => {
  const harness = createService();
  await assert.rejects(() => harness.service.takeScreenshot({}), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  await assert.rejects(
    () => harness.service.takeScreenshot({ tabId: 7, region: { x: 0, y: 0, width: 0, height: 10 } }),
    (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG',
  );
});

test('screenshot：captureVisibleTab 错误映射（限速/窗口关闭/readback）', () => {
  assert.equal(mapCaptureError(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')).code, 'E_CAPTURE_RATE_LIMIT');
  assert.equal(mapCaptureError(new Error('No window with id 3')).code, 'E_NO_WINDOW');
  assert.equal(mapCaptureError(new Error('image readback failed')).code, 'E_CAPTURE_FAILED');
});

test('screenshot：readback 失败时先 normalize 窗口再重试（E2E 31 系列抖动修复）', async () => {
  const tabs = createFakeTabs({ tab: { id: 7, windowId: 3, url: 'https://example.test/', active: true }, frames: [{ width: 1000, height: 500 }] });
  let captureCalls = 0;
  const originalCapture = tabs.api.tabs.captureVisibleTab.bind(tabs.api.tabs);
  const api = {
    ...tabs.api,
    tabs: {
      ...tabs.api.tabs,
      async captureVisibleTab(windowId?: number, captureOptions?: Record<string, unknown>) {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error('Failed to capture tab: image readback failed');
        return originalCapture(windowId, captureOptions);
      },
    },
  };
  const windowUpdates: Array<{ windowId: number; props: Record<string, unknown> }> = [];
  const content = createFakeContent();
  const service = new ScreenshotService({
    api,
    windows: {
      async update(windowId: number, props: Record<string, unknown>) {
        windowUpdates.push({ windowId, props });
        return {};
      },
    },
    content: content.transport,
    codec: createFakeCanvasCodec(),
    now: () => 1_000,
    sleep: async () => {},
    captureIntervalMs: 1,
    captureRetries: 2,
  });
  const result = await service.takeScreenshot({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal(captureCalls, 2, 'readback 失败后应重试一次');
  assert.equal(windowUpdates.length, 1, '重试前应 normalize 窗口');
  const update = windowUpdates[0]!;
  assert.equal(update.props.state, 'normal');
  assert.equal(update.props.focused, true);
});

test('capture store：TTL 清理、上限淘汰、consume 单次消费', () => {
  let clock = 0;
  const store = new CaptureStore({ ttlMs: 100, max: 2, now: () => clock });
  const a = store.put({ tabId: 1, scale: 1, scrollX: 0, scrollY: 0, width: 10, height: 10, url: '' });
  clock = 50;
  const b = store.put({ tabId: 2, scale: 1, scrollX: 0, scrollY: 0, width: 10, height: 10, url: '' });
  assert.equal(store.size, 2);
  assert.equal(store.consume(a.id)?.tabId, 1);
  assert.equal(store.consume(a.id), null);
  clock = 200;
  assert.equal(store.get(b.id), null, 'TTL 过期条目应被清理');
  const c = store.put({ tabId: 3, scale: 1, scrollX: 0, scrollY: 0, width: 1, height: 1, url: '' });
  clock = 210;
  store.put({ tabId: 4, scale: 1, scrollX: 0, scrollY: 0, width: 1, height: 1, url: '' });
  assert.equal(store.size, 2);
  void c;
});

test('capture stream：dataUrlBase64 解析与 base64 字节数', () => {
  assert.equal(dataUrlBase64('not-a-data-url'), null);
  const base64 = Buffer.from('hello').toString('base64');
  assert.equal(base64ByteLength(base64), 5);
  assert.equal(dataUrlBase64('data:image/png;base64,' + base64), base64);
  const store = new CaptureStreamStore({ chunkChars: 4 });
  const stored = store.put({ dataUrl: 'data:image/png;base64,' + base64, width: 1, height: 1, via: 'test' });
  assert.ok(stored);
  const chunk = store.read(stored?.captureId, { offset: 0, length: 4 });
  assert.equal(chunk?.dataBase64.length, 4);
  assert.equal(chunk?.eof, false);
  const last = store.read(stored?.captureId, { offset: chunk?.nextOffset, length: 100 });
  assert.equal(last?.eof, true);
  assert.equal(store.release(stored?.captureId), true);
  assert.equal(store.read(stored?.captureId), null);
});
