// tests/annotate-click.test.ts —— screenshot --annotate 产物契约 + 按图坐标点击链路单测（23q）。
//
// 覆盖两个关键契约（真实 E2E 23q 曾经踩过）：
// 1) 坐标 capture 只以 snake_case 的 `capture_id` 暴露；camelCase 的 `captureId` 是
//    **分块流**的 id（CLI 拿它调 screenshot.read 拼文件）。二者混用时 CLI 会按流式读
//    坐标 capture → E_NOT_FOUND「读取截图块失败」，整条 --annotate --out 失败。
// 2) visual_refs 的 image_x/image_y 必须是**图片像素**坐标，click --capture --image-x/--image-y
//    经 click-point 换算回页面坐标（pageX = scrollX + imageX / scale），且 capture 单次消费。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ScreenshotService } from '../src/capture/screenshot.ts';
import { ExtendedActionRegistry } from '../src/actions/extended.ts';
import { pngSize } from '../src/capture/codec.ts';
import type { AnnotateBox, CanvasCodec, CropRect, DecodedImage, EncodedImage, StitchFrame } from '../src/capture/codec.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';
import { createFakeCanvasCodec, fakePngDataUrl } from './support/fake-canvas.ts';

interface VisualRef {
  ref: string;
  role: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
}

interface HarnessState {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  refs: VisualRef[];
  /** 每次 visual-refs 调用后对 scroll 的扰动（测“几何变化 → 不生成 capture”）。 */
  driftScrollY: number;
  ops: string[];
  clickPointParams: Array<Record<string, unknown>>;
  captures: number;
}

interface Harness {
  service: ScreenshotService;
  state: HarnessState;
  codec: ReturnType<typeof createFakeCanvasCodec>;
  annotations: Array<readonly AnnotateBox[]>;
}

function createHarness(options: { annotatePayloadChars?: number; frames?: Array<{ width: number; height: number }> } = {}): Harness {
  const state: HarnessState = {
    scrollX: 0,
    scrollY: 40,
    innerWidth: 1000,
    innerHeight: 500,
    refs: [{ ref: '@e1', role: 'button', name: '提交查询', rect: { x: 10, y: 20, width: 100, height: 40 } }],
    driftScrollY: 0,
    ops: [],
    clickPointParams: [],
    captures: 0,
  };
  const frames = options.frames ?? [{ width: 2000, height: 1000 }];
  const tabs = {
    async get(tabId: number) {
      if (tabId !== 7) throw new Error('No tab with id ' + String(tabId));
      return { id: 7, windowId: 3, url: 'https://example.test/', title: '示例', active: true };
    },
    async query(queryInfo: Record<string, unknown>) {
      if (queryInfo.active === true) return [{ id: 7, windowId: 3 }];
      return [];
    },
    async update() {
      return { id: 7, windowId: 3 };
    },
    async captureVisibleTab() {
      const frame = frames[state.captures] ?? frames[frames.length - 1] ?? { width: 2000, height: 1000 };
      state.captures += 1;
      return fakePngDataUrl(frame.width, frame.height);
    },
  };
  const content = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      state.ops.push(request.op);
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
            scrollWidth: state.innerWidth,
            scrollHeight: 4000,
            devicePixelRatio: 2,
            documentId: 'doc-1',
          },
        };
      }
      if (request.op === 'visual-refs') {
        const result = {
          refs: state.refs,
          scrollX: state.scrollX,
          scrollY: state.scrollY,
          innerWidth: state.innerWidth,
          innerHeight: state.innerHeight,
          devicePixelRatio: 2,
          url: 'https://example.test/',
        };
        state.scrollY += state.driftScrollY;
        return { ok: true, result };
      }
      if (request.op === 'click-point') {
        state.clickPointParams.push({ ...request.params });
        return {
          ok: true,
          result: {
            ok: true,
            via: 'content-script',
            trusted: false,
            synthetic: true,
            tag: 'button',
            ref: null,
            selector: '#submit-btn',
            x: Number(request.params.x),
            y: Number(request.params.y),
            generated: 3,
          },
        };
      }
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + request.op };
    },
  };
  const baseCodec = createFakeCanvasCodec();
  const annotations: Array<readonly AnnotateBox[]> = [];
  const payloadChars = Number(options.annotatePayloadChars) > 0 ? Number(options.annotatePayloadChars) : 0;
  const codec: CanvasCodec & ReturnType<typeof createFakeCanvasCodec> = {
    ...baseCodec,
    async annotate(dataUrl: string, boxes: readonly AnnotateBox[]): Promise<EncodedImage> {
      annotations.push(boxes);
      const size = pngSize(dataUrl);
      const payload = payloadChars > 0 ? 'A'.repeat(payloadChars) : 'annotated';
      return {
        dataUrl: 'data:image/png;base64,' + payload,
        width: size.width,
        height: size.height,
      };
    },
  };
  let clock = 1_000;
  const service = new ScreenshotService({
    api: { tabs } as never,
    content: content as never,
    codec,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += Math.max(0, ms);
    },
    captureIntervalMs: 1,
  });
  return { service, state, codec: codec as ReturnType<typeof createFakeCanvasCodec>, annotations };
}

test('annotate：坐标 capture 只走 snake_case，visual_refs 给图片像素坐标', async () => {
  const harness = createHarness();
  const shot = await harness.service.takeScreenshot({ tabId: 7, annotate: true });

  assert.equal(typeof shot.capture_id, 'string');
  assert.equal(String(shot.capture_id).length > 0, true);
  assert.equal(shot.captureId, undefined, 'camelCase captureId 属于分块流契约，annotate 不能占用（23q 根因回归）');
  assert.equal(shot.streamed, undefined, '小图不应走流式通道');
  assert.equal(String(shot.dataUrl).startsWith('data:image/png;base64,'), true, 'CLI --out 走 writeDataUrl 需要内联 dataUrl');
  assert.equal(harness.annotations.length, 1, 'annotate 应只调一次 codec');
  const boxes = harness.annotations[0] ?? [];
  assert.equal(boxes.length, 1);
  // 设备像素 2000 / CSS 1000 = scale 2；框按图片像素画。
  assert.deepEqual({ x: boxes[0]?.x, y: boxes[0]?.y, width: boxes[0]?.width, height: boxes[0]?.height }, { x: 20, y: 40, width: 200, height: 80 });

  const visualRefs = shot.visual_refs as Array<Record<string, unknown>>;
  assert.equal(visualRefs.length, 1);
  const target = visualRefs[0] ?? {};
  assert.equal(target.ref, '@e1');
  assert.equal(target.role, 'button');
  assert.equal(target.name, '提交查询');
  // 图片像素中心：(10 + 100/2) * 2 = 120，(20 + 40/2) * 2 = 80。
  assert.equal(target.image_x, 120);
  assert.equal(target.image_y, 80);
  assert.equal(target.x, 20);
  assert.equal(target.y, 40);
  assert.equal(target.width, 200);
  assert.equal(target.height, 80);

  // 坐标 capture 单次消费：同一张图只能派发一次坐标动作。
  const capture = harness.service.consumeCapture(shot.capture_id);
  assert.ok(capture);
  assert.equal(capture?.tabId, 7);
  assert.equal(capture?.scale, 2);
  assert.equal(capture?.scrollY, 40);
  assert.equal(harness.service.consumeCapture(shot.capture_id), null);
});

test('annotate：visual_refs 的 image 坐标经 click-point 换算回页面坐标', async () => {
  const harness = createHarness();
  const shot = await harness.service.takeScreenshot({ tabId: 7, annotate: true });
  const target = (shot.visual_refs as Array<Record<string, unknown>>)[0] ?? {};
  const registry = new ExtendedActionRegistry({
    content: {
      async request(tabId: number, request: ContentRequest): Promise<ContentReply> {
        return harnessStateRequest(harness, tabId, request);
      },
    },
    captures: { consume: (id: string) => harness.service.consumeCapture(id) },
    now: () => 2_000,
    random: () => 0.5,
  });
  const clicked = await registry.dispatch('click-point', {
    tabId: 7,
    capture: shot.capture_id,
    imageX: target.image_x,
    imageY: target.image_y,
  }) as Record<string, unknown>;
  assert.equal(clicked.effectState, 'committed');
  // pageX = scrollX + imageX / scale = 0 + 120/2 = 60；pageY = 40 + 80/2 = 80。
  assert.equal(clicked.x, 60);
  assert.equal(clicked.y, 80);
  assert.equal(clicked.capture, shot.capture_id);
  const params = harness.state.clickPointParams[0] ?? {};
  assert.equal(params.x, 60);
  assert.equal(params.y, 80);
  assert.equal(harness.state.ops.includes('metrics'), true, '按图点击前应校验页面没有滚动');

  // capture 已消费：同一张图重复按图点击必须明确报 capture 过期，而不是打错位置。
  await assert.rejects(
    () => registry.dispatch('click-point', { tabId: 7, capture: shot.capture_id, imageX: 1, imageY: 2 }),
    (error: unknown) => (error as { code?: string }).code === 'E_CAPTURE_STALE',
  );
});

test('annotate：大图走分块流时 captureId=流 id、capture_id=坐标 id，二者不混用', async () => {
  const harness = createHarness({ annotatePayloadChars: 1_600_000 });
  const shot = await harness.service.takeScreenshot({ tabId: 7, annotate: true });
  assert.equal(shot.streamed, true, '超过内联上限应走分块流（CLI 用 screenshot.read 拼文件）');
  assert.equal(shot.dataUrl, undefined, '流式后不应再回大 dataUrl');
  const streamId = String(shot.captureId);
  const coordinateId = String(shot.capture_id);
  assert.equal(streamId.length > 0, true);
  assert.equal(coordinateId.length > 0, true);
  assert.notEqual(streamId, coordinateId, '流 id 与坐标 id 必须是两个不同的仓库');

  // CLI 读文件：按 captureId 分块取，直到 eof。
  const chunks: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const chunk = harness.service.readChunk({ captureId: streamId, offset, length: 512 * 1024 });
    chunks.push(String(chunk.dataBase64));
    offset = Number(chunk.nextOffset);
    if (chunk.eof === true) break;
  }
  assert.equal(chunks.join('').length >= 1_600_000, true);
  assert.deepEqual({ width: shot.width, height: shot.height }, { width: 2000, height: 1000 });

  // 坐标 capture 仍可用（按图点击依赖它），并且不走流仓库。
  const capture = harness.service.consumeCapture(coordinateId);
  assert.ok(capture, '流式截图也必须保留可单次消费的坐标 capture');
  assert.equal(capture?.scale, 2);
  assert.throws(
    () => harness.service.readChunk({ captureId: coordinateId }),
    (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND',
    '坐标 capture 不是流：CLI 不能拿它去 screenshot.read（23q 根因）',
  );
});

test('annotate：不能与整页/区域截图同用（既有契约）', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.service.takeScreenshot({ tabId: 7, annotate: true, fullPage: true }),
    (error: unknown) => (error as { code?: string }).code === 'E_ARG_CONFLICT',
  );
});

test('annotate：截图期间页面几何变化 → capture 作废（不产出假坐标）', async () => {
  const harness = createHarness();
  harness.state.driftScrollY = 100;
  const shot = await harness.service.takeScreenshot({ tabId: 7, annotate: true });
  assert.equal(shot.capture_skipped, 'geometry-changed');
  assert.equal(shot.capture_id, undefined, '几何变化时不能给出可用的按图坐标');
  assert.equal(shot.visual_refs, undefined);
});

/** ExtendedActionRegistry 的内容传输（复用同一 harness 的状态与记录）。 */
async function harnessStateRequest(harness: Harness, _tabId: number, request: ContentRequest): Promise<ContentReply> {
  harness.state.ops.push(request.op);
  if (request.op === 'metrics') {
    return {
      ok: true,
      result: {
        url: 'https://example.test/',
        title: '示例',
        scrollX: harness.state.scrollX,
        scrollY: harness.state.scrollY,
        innerWidth: harness.state.innerWidth,
        innerHeight: harness.state.innerHeight,
        scrollWidth: harness.state.innerWidth,
        scrollHeight: 4000,
        devicePixelRatio: 2,
        documentId: 'doc-1',
      },
    };
  }
  if (request.op === 'click-point') {
    harness.state.clickPointParams.push({ ...request.params });
    return {
      ok: true,
      result: {
        ok: true,
        via: 'content-script',
        trusted: false,
        synthetic: true,
        tag: 'button',
        ref: null,
        selector: '#submit-btn',
        x: Number(request.params.x),
        y: Number(request.params.y),
        generated: 3,
      },
    };
  }
  return { ok: false, code: 'E_UNKNOWN_OP', message: 'unexpected op ' + request.op };
}
