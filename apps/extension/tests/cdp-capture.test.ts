// tests/cdp-capture.test.ts —— 截图差分尺寸容差（31g 回归修复）单测。
//
// 背景：31f2 的设备仿真（1241x800 @1.5 DPR）reset 后，Edge 窗口 chrome/合成器会重排一次，
// 同页相邻两次视口截图可能差 4px 高（E2E 实测 1256x761 → 1256x757），严格等尺寸差分误判
// sizeMatch=false。修复：仅对「viewport 对 viewport」允许 ≤8px 漂移（左上角对齐裁剪后差分）；
// 整页/区域/元素截图仍严格等尺寸。这里用假 tabs/content/codec 精确覆盖两条路径。

import assert from 'node:assert/strict';
import test from 'node:test';

import { ScreenshotService, VIEWPORT_DIFF_SIZE_TOLERANCE_PX, cropTopLeftImage, tolerantViewportSizeDelta } from '../src/capture/screenshot.ts';
import { createFakeCanvasCodec, fakePngDataUrl } from './support/fake-canvas.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';

interface FakeFrame {
  width: number;
  height: number;
  color: [number, number, number, number];
}

function createHarness(options: { frames: FakeFrame[]; innerHeight?: number; scrollHeight?: number }) {
  const state = {
    activeTabId: 7,
    captures: 0,
    updateCalls: 0,
  };
  const contentState = {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: options.innerHeight ?? 500,
    scrollWidth: 1000,
    scrollHeight: options.scrollHeight ?? 500,
    ops: [] as string[],
  };
  const api = {
    tabs: {
      async get(tabId: number) {
        if (tabId !== 7) throw new Error('No tab with id ' + String(tabId));
        return { id: 7, windowId: 3, url: 'https://example.test/', active: true };
      },
      async query(queryInfo: Record<string, unknown>) {
        if (queryInfo.active === true && queryInfo.windowId === 3) return [{ id: state.activeTabId, windowId: 3 }];
        return [];
      },
      async update(tabId: number) {
        state.updateCalls += 1;
        state.activeTabId = tabId;
        return { id: tabId };
      },
      async captureVisibleTab() {
        const index = state.captures;
        const frame = options.frames[index] ?? options.frames[options.frames.length - 1];
        state.captures += 1;
        if (!frame) return fakePngDataUrl(100, 100);
        // pngSize 只读 IHDR；追加一个唯一字节让「同尺寸但不同帧」拥有不同 dataUrl，
        // 否则假 codec 的 setPixels 会按 dataUrl 互相覆盖。
        const header = Buffer.from(fakePngDataUrl(frame.width, frame.height).split(',')[1] ?? '', 'base64');
        const unique = Buffer.from([index & 0xff]);
        const dataUrl = 'data:image/png;base64,' + Buffer.concat([header, unique]).toString('base64');
        codec.setPixels(dataUrl, { width: frame.width, height: frame.height, color: frame.color });
        return dataUrl;
      },
    },
  };
  const content = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      contentState.ops.push(request.op);
      const params = request.params;
      if (request.op === 'metrics') {
        return {
          ok: true,
          result: {
            url: 'https://example.test/',
            title: '示例',
            scrollX: contentState.scrollX,
            scrollY: contentState.scrollY,
            innerWidth: contentState.innerWidth,
            innerHeight: contentState.innerHeight,
            scrollWidth: contentState.scrollWidth,
            scrollHeight: contentState.scrollHeight,
            devicePixelRatio: 1,
            documentId: 'doc-1',
          },
        };
      }
      if (request.op === 'scroll') {
        if (typeof params['y'] === 'number') {
          contentState.scrollY = Math.max(0, Math.min(Number(params['y']), contentState.scrollHeight - contentState.innerHeight));
        }
        if (typeof params['x'] === 'number') contentState.scrollX = Math.max(0, Number(params['x']));
        return {
          ok: true,
          result: {
            ok: true,
            scrollX: contentState.scrollX,
            scrollY: contentState.scrollY,
            clampedX: contentState.scrollX,
            clampedY: contentState.scrollY,
            bounds: null,
            viewport: { width: contentState.innerWidth, height: contentState.innerHeight },
            ref: null,
            selector: null,
            via: 'content-script',
          },
        };
      }
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + request.op };
    },
  };
  const codec = createFakeCanvasCodec();
  let clock = 1_000;
  const service = new ScreenshotService({
    api,
    content,
    codec,
    now: () => clock,
    sleep: async (ms) => {
      clock += Math.max(0, ms);
    },
    captureIntervalMs: 0,
    maxFullPageFrames: 8,
    maxCanvasHeight: 16_000,
  });
  return { service, content: contentState, state };
}

test('cropTopLeftImage：左上角对齐裁剪 RGBA（行/像素都必须对齐）', () => {
  const source = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  source.data.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const cropped = cropTopLeftImage(source, 1, 1);
  assert.equal(cropped.width, 1);
  assert.equal(cropped.height, 1);
  assert.deepEqual([...cropped.data], [1, 2, 3, 4]);
  const wide = cropTopLeftImage(source, 2, 1);
  assert.deepEqual([...wide.data], [1, 2, 3, 4, 5, 6, 7, 8], '第二行必须被裁掉，第一行保留两列');
});

test('31g 回归：视口截图 4px 高度漂移 → sizeMatch=true（裁剪后差分），不误报几何变化', async () => {
  const harness = createHarness({
    frames: [
      { width: 1256, height: 761, color: [0, 0, 0, 255] },
      { width: 1256, height: 757, color: [0, 0, 0, 255] },
    ],
  });
  const first = await harness.service.takeScreenshot({ tabId: 7 });
  assert.equal(first['height'], 761);
  const second = await harness.service.takeScreenshot({ tabId: 7, diff: true });
  const diff = second['diff'] as Record<string, unknown>;
  assert.equal(diff['sizeMatch'], true, '≤8px 的视口漂移应按同页处理：' + JSON.stringify(diff));
  assert.equal(diff['cropped'], true);
  assert.deepEqual(diff['sizeDelta'], { width: 0, height: 4 });
  assert.equal(diff['changed'], 0, '同色画面裁剪后没有像素变化');
  assert.equal(Number(diff['total']) > 0, true);
});

test('视口漂移 > 容差仍严格判 sizeMatch=false（不掩盖真实几何变化）', async () => {
  const harness = createHarness({
    frames: [
      { width: 1256, height: 761, color: [0, 0, 0, 255] },
      { width: 1256, height: 761 - VIEWPORT_DIFF_SIZE_TOLERANCE_PX - 1, color: [0, 0, 0, 255] },
    ],
  });
  await harness.service.takeScreenshot({ tabId: 7 });
  const second = await harness.service.takeScreenshot({ tabId: 7, diff: true });
  const diff = second['diff'] as Record<string, unknown>;
  assert.equal(diff['sizeMatch'], false);
  assert.deepEqual(diff['before'], { width: 1256, height: 761 });
  assert.equal((diff['after'] as Record<string, unknown>)['height'], 761 - VIEWPORT_DIFF_SIZE_TOLERANCE_PX - 1);
  assert.deepEqual(diff['sizeDelta'], { width: 0, height: VIEWPORT_DIFF_SIZE_TOLERANCE_PX + 1 });
});

test('视口同尺寸且像素变化 → 仍走普通差分（changed/ratio>0）', async () => {
  const harness = createHarness({
    frames: [
      { width: 1256, height: 761, color: [0, 0, 0, 255] },
      { width: 1256, height: 761, color: [255, 0, 0, 255] },
    ],
  });
  await harness.service.takeScreenshot({ tabId: 7 });
  const second = await harness.service.takeScreenshot({ tabId: 7, diff: true });
  const diff = second['diff'] as Record<string, unknown>;
  assert.equal(diff['sizeMatch'], true);
  assert.equal(diff['cropped'], undefined, '同尺寸不应走裁剪路径');
  assert.equal(Number(diff['changed']) > 0, true);
  assert.equal(Number(diff['ratio']) > 0, true);
});

test('tolerantViewportSizeDelta：只对视口截图生效，其它 scope 严格等尺寸', () => {
  assert.equal(tolerantViewportSizeDelta('viewport', 'viewport', 0, 4), true);
  assert.equal(tolerantViewportSizeDelta('viewport', 'viewport', 8, 8), true, '容差边界（含）');
  assert.equal(tolerantViewportSizeDelta('viewport', 'viewport', 0, 9), false, '超容差仍严格');
  assert.equal(tolerantViewportSizeDelta('viewport', 'viewport', 9, 0), false);
  assert.equal(tolerantViewportSizeDelta('document', 'document', 0, 4), false, '整页截图必须严格等尺寸');
  assert.equal(tolerantViewportSizeDelta('region', 'region', 0, 4), false);
  assert.equal(tolerantViewportSizeDelta('element', 'element', 0, 4), false);
  assert.equal(tolerantViewportSizeDelta('viewport', 'document', 0, 4), false, 'scope 不一致不享受容差');
  assert.equal(tolerantViewportSizeDelta(undefined, 'viewport', 0, 4), false);
});
