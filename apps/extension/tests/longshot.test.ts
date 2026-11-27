// tests/longshot.test.ts —— 长截图规划/存储/采集/恢复（M-C 第五批）。
//
// 全部依赖注入：假页面度量、假滚动、假 captureVisibleTab、假 CanvasCodec、内存分片后端，
// 因此可以精确断言"规划 → 滚动 → 抓帧 → 拼接 → 固定带重绘 → 落盘 → 恢复"的几何与证据，
// 不需要真实浏览器（真实浏览器路径由 E2E 31c/31e/31f/31h3 覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bandRedrawRect,
  describeSegmentPlan,
  estimateLongshotBudget,
  normalizeDpr,
  planFixedBands,
  planLongshotSegments,
  planSegmentFrames,
  planStitch,
  planColumnScrolls,
  planStaleRecovery,
  segmentPlanWire,
  splitSegmentHeights,
  staleMetrics,
  toDevicePx,
  validateSegmentPlan,
} from '../src/capture/longshot-plan.ts';
import {
  LongshotStore,
  MemoryLongshotBackend,
  appendLongshotSegment,
  buildLongshotManifest,
  dataUrlBytes,
  hashDataUrl,
  manifestSummary,
  sealLongshotManifest,
} from '../src/capture/longshot-store.ts';
import { LongshotCapture } from '../src/capture/longshot.ts';
import type { AnnotateBox, CanvasCodec, CropRect, DecodedImage, EncodedImage, StitchBand, StitchFrame } from '../src/capture/codec.ts';
import { fakePngDataUrl } from './support/fake-canvas.ts';

// ---------------------------------------------------------------------------
// 假依赖
// ---------------------------------------------------------------------------

interface FakeMetricsState {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  devicePixelRatio: number;
  fixedTopHeight?: number;
  fixedBottomHeight?: number;
  fixedBands?: Array<{ edge: 'top' | 'bottom'; height: number; top: number; bottom: number }>;
  revision?: number;
}

function metricsOf(overrides: Partial<FakeMetricsState> = {}): FakeMetricsState {
  return {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1000,
    innerHeight: 500,
    scrollWidth: 1000,
    scrollHeight: 6000,
    devicePixelRatio: 1,
    revision: 0,
    ...overrides,
  };
}

interface FakeCodecState {
  stitches: Array<{ drawYs: number[]; drawXs: number[]; width: number; height: number; bands: number }>;
}

function createRecordingCodec(): { codec: CanvasCodec; state: FakeCodecState } {
  const state: FakeCodecState = { stitches: [] };
  const codec: CanvasCodec = {
    async decode(): Promise<DecodedImage> {
      return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    },
    async crop(_dataUrl: string, rect: CropRect): Promise<EncodedImage> {
      return { dataUrl: fakePngDataUrl(Math.round(rect.width), Math.round(rect.height)), width: Math.round(rect.width), height: Math.round(rect.height) };
    },
    async stitch(frames: readonly StitchFrame[], width: number, height: number, bands?: readonly StitchBand[]): Promise<EncodedImage> {
      state.stitches.push({
        drawYs: frames.map((frame) => Math.round(frame.drawY)),
        drawXs: frames.map((frame) => Math.round(frame.drawX ?? 0)),
        width,
        height,
        bands: bands?.length ?? 0,
      });
      return { dataUrl: fakePngDataUrl(width, height), width, height };
    },
    async annotate(_dataUrl: string, boxes: readonly AnnotateBox[]): Promise<EncodedImage> {
      return { dataUrl: fakePngDataUrl(1, boxes.length || 1), width: 1, height: boxes.length || 1 };
    },
  };
  return { codec, state };
}

interface FakeHarness {
  engine: LongshotCapture;
  store: LongshotStore;
  codecState: FakeCodecState;
  scrolls: Array<{ x: number; y: number }>;
  captures: number;
  metricsCalls: number;
}

function createHarness(options: {
  metrics?: Partial<FakeMetricsState>;
  /** 每次 metrics() 依次返回的量度（用于 stale 场景）；耗尽后返回最后一个。 */
  metricsSequence?: Partial<FakeMetricsState>[];
  pageHeight?: number;
  frameHeight?: number;
  frameWidth?: number;
  maxFrames?: number;
  fixedTopHeight?: number;
  fixedBottomHeight?: number;
  fixedBands?: Array<{ edge: 'top' | 'bottom'; height: number; top: number; bottom: number }>;
} = {}): FakeHarness {
  const { codec, state: codecState } = createRecordingCodec();
  const store = new LongshotStore({ backend: new MemoryLongshotBackend(), now: () => 1000 });
  const scrolls: Array<{ x: number; y: number }> = [];
  const sequence = options.metricsSequence ? [...options.metricsSequence] : [];
  let metricsCalls = 0;
  const base = metricsOf(options.metrics);
  let captures = 0;
  const frameWidth = options.frameWidth ?? base.innerWidth;
  const frameHeight = options.frameHeight ?? base.innerHeight;
  const harness: FakeHarness = {
    engine: null as unknown as LongshotCapture,
    store,
    codecState,
    scrolls,
    captures: 0,
    metricsCalls: 0,
  };
  harness.engine = new LongshotCapture({
    metrics: async () => {
      metricsCalls += 1;
      harness.metricsCalls = metricsCalls;
      const step = sequence.length ? sequence[Math.min(sequence.length - 1, metricsCalls - 1)] : undefined;
      return {
        ...base,
        ...(options.fixedTopHeight !== undefined ? { fixedTopHeight: options.fixedTopHeight } : {}),
        ...(options.fixedBottomHeight !== undefined ? { fixedBottomHeight: options.fixedBottomHeight } : {}),
        ...(options.fixedBands !== undefined ? { fixedBands: options.fixedBands } : {}),
        ...(step ?? {}),
      };
    },
    scroll: async (_tabId, x, y) => {
      scrolls.push({ x, y });
    },
    capture: async () => {
      captures += 1;
      harness.captures = captures;
      return fakePngDataUrl(frameWidth, frameHeight);
    },
    codec,
    store,
    now: () => 5000,
    sleep: async () => undefined,
    newId: () => 'longshot-test-1',
    maxFrames: options.maxFrames,
    segmentHeight: 20000,
    settleMs: 0,
  });
  return harness;
}

// ---------------------------------------------------------------------------
// 纯函数：固定带 / 分段 / 滚动帧
// ---------------------------------------------------------------------------

test('planFixedBands：footer 夹具口径（顶 56 / 底 80，两条明细）', () => {
  const bands = planFixedBands(
    {
      scrollHeight: 15000,
      innerHeight: 800,
      innerWidth: 1280,
      fixedTopHeight: 56,
      fixedBottomHeight: 80,
      fixedBands: [
        { edge: 'top', height: 56, top: 0, bottom: 56 },
        { edge: 'bottom', height: 80, top: 720, bottom: 800 },
      ],
    },
    { dpr: 1, deviceHeight: 15000 },
  );
  assert.equal(bands.measured, true);
  assert.equal(bands.fixedTop, 56);
  assert.equal(bands.fixedBottom, 80);
  assert.equal(bands.bands.length, 2);
  assert.equal(bands.cssHeight, 15000);
});

test('planFixedBands：超过页面 1/3 的"固定元素"视为整页容器而丢弃', () => {
  const bands = planFixedBands(
    { scrollHeight: 900, fixedTopHeight: 600, fixedBottomHeight: 500 },
    { dpr: 1, deviceHeight: 900 },
  );
  assert.equal(bands.fixedTop, 0, '600 > 900/3，不应当顶栏');
  assert.equal(bands.fixedBottom, 0, '500 > 900/3，不应当页脚');
  const fractional = planFixedBands({ scrollHeight: 15000, fixedTopHeight: 56, fixedBottomHeight: 80 }, { dpr: 1.5, deviceHeight: 22500 });
  assert.equal(fractional.fixedTop, 84, '分数 DPR 下 56*1.5=84 设备像素');
  assert.equal(fractional.fixedBottom, 120);
});

test('planFixedBands：没有度量时返回未测量而不是编造数据', () => {
  const bands = planFixedBands(null, { dpr: 2, deviceHeight: 1000 });
  assert.equal(bands.measured, false);
  assert.equal(bands.fixedTop, 0);
  assert.equal(bands.fixedBottom, 0);
});

test('toDevicePx / normalizeDpr：非法输入回退且不产生 NaN', () => {
  assert.equal(normalizeDpr(0), 1);
  assert.equal(normalizeDpr(-2), 1);
  assert.equal(normalizeDpr('1.25'), 1.25);
  assert.equal(toDevicePx(56, 1.5), 84);
  assert.equal(toDevicePx(-1, 1.5), 0);
});

test('splitSegmentHeights：40000 上限与"末段过小"重排', () => {
  assert.deepEqual(splitSegmentHeights(15000, { maxSegmentHeight: 40000 }), [15000]);
  assert.deepEqual(splitSegmentHeights(45000, { maxSegmentHeight: 20000 }), [20000, 20000, 5000]);
  // 40001 → 末段 1px 太小：重排成两段均分
  assert.deepEqual(splitSegmentHeights(40001, { maxSegmentHeight: 40000, minSegmentHeight: 256 }), [20001, 20000]);
});

test('planLongshotSegments：单段 / 多段 + 固定带只落首末段 + 重叠', () => {
  const single = planLongshotSegments({ deviceWidth: 1280, deviceHeight: 6000, dpr: 1, fixedTop: 56, fixedBottom: 80, maxSegmentHeight: 40000 });
  assert.equal(single.totalSegments, 1);
  assert.equal(single.segments[0]?.fixedTop, 56);
  assert.equal(single.segments[0]?.fixedBottom, 80);
  assert.equal(single.segmented, false);

  const multi = planLongshotSegments({
    deviceWidth: 1280,
    deviceHeight: 45000,
    dpr: 1.5,
    fixedTop: 84,
    fixedBottom: 120,
    overlap: 32,
    maxSegmentHeight: 20000,
  });
  assert.equal(multi.totalSegments, 3);
  assert.equal(multi.segments[0]?.fixedTop, 84);
  assert.equal(multi.segments[2]?.fixedBottom, 120);
  assert.equal(multi.segments[1]?.fixedTop, 0, '中间段不应重绘顶栏');
  assert.equal(multi.segments[1]?.fixedBottom, 0, '中间段不应重绘页脚');
  assert.equal(multi.segments[1]?.overlapTop, 32);
  assert.equal(multi.segments[1]?.drawY, multi.segments[1]!.pageY - 32);
  assert.equal(multi.fractional, true);
  assert.equal(validateSegmentPlan(multi).ok, true);
  assert.match(describeSegmentPlan(multi), /3 段 \(20000\+20000\+5000, dpr=1.5, 顶 84\/底 120, 重叠 32\)/);
});

test('validateSegmentPlan：覆盖缺口/固定带错位必须被检出', () => {
  const plan = planLongshotSegments({ deviceWidth: 100, deviceHeight: 30000, dpr: 1, maxSegmentHeight: 20000 });
  const broken = {
    ...plan,
    segments: plan.segments.map((segment, index) => (index === 1 ? { ...segment, pageY: segment.pageY + 5 } : segment)),
  };
  const report = validateSegmentPlan(broken);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((item) => item.code === 'gap'), '应报告段起点不连续：' + JSON.stringify(report.errors));
});

test('planSegmentFrames：纵向行数、横向列与帧数上限', () => {
  const plan = planLongshotSegments({ deviceWidth: 1000, deviceHeight: 2600, dpr: 1, maxSegmentHeight: 40000 });
  const frames = planSegmentFrames(plan.segments[0]!, { innerWidth: 1000, innerHeight: 500, scrollHeight: 2600, scrollWidth: 1000 });
  assert.deepEqual(frames.map((frame) => frame.scrollY), [0, 500, 1000, 1500, 2000, 2100]);
  assert.equal(frames[frames.length - 1]?.drawY, 2100);

  const wide = planLongshotSegments({ deviceWidth: 16000, deviceHeight: 1000, dpr: 1, maxSegmentHeight: 40000 });
  const wideFrames = planSegmentFrames(wide.segments[0]!, { innerWidth: 1000, innerHeight: 1000, scrollHeight: 1000, scrollWidth: 16000 });
  assert.equal(wideFrames.length, 16, '16 列（16000/1000）');
  assert.deepEqual(planColumnScrolls({ innerWidth: 1000, scrollWidth: 16000 }).slice(0, 3), [0, 1000, 2000]);
  assert.deepEqual(planColumnScrolls({ innerWidth: 1000, scrollWidth: 1000 }), [0]);

  const capped = planSegmentFrames(plan.segments[0]!, { innerWidth: 1000, innerHeight: 500, scrollHeight: 6000, scrollWidth: 1000 }, { maxFrames: 3 });
  assert.equal(capped.length, 3);
});

test('bandRedrawRect：顶带贴 0、底带贴段底', () => {
  const top = bandRedrawRect({ width: 100, drawHeight: 500, fixedTop: 40 }, 'top');
  assert.deepEqual(top, { x: 0, y: 0, width: 100, height: 40, edge: 'top' });
  const bottom = bandRedrawRect({ width: 100, drawHeight: 500, fixedBottom: 60 }, 'bottom');
  assert.deepEqual(bottom, { x: 0, y: 440, width: 100, height: 60, edge: 'bottom' });
  assert.equal(bandRedrawRect({ width: 100, drawHeight: 500 }, 'top'), null);
});

test('segmentPlanWire：wire 字段与几何一致', () => {
  const plan = planLongshotSegments({ deviceWidth: 1280, deviceHeight: 45000, dpr: 1.5, fixedTop: 84, fixedBottom: 120, maxSegmentHeight: 20000 });
  const wire = segmentPlanWire(plan.segments[0]!);
  assert.equal(wire.offsetY, wire.y);
  assert.equal(wire.height, wire.pageHeight + wire.overlapTop);
  assert.equal(wire.width, 1280);
  assert.equal(wire.dpr, 1.5);
});

// ---------------------------------------------------------------------------
// stale
// ---------------------------------------------------------------------------

test('staleMetrics / planStaleRecovery：增长→extend，同尺寸改内容→rewrite，缩宽→retry', () => {
  const before = { scrollHeight: 12000, scrollWidth: 1000, innerWidth: 1000, innerHeight: 800, revision: 1 };
  const same = staleMetrics(before, { ...before });
  assert.equal(same.stale, false);

  const grown = { ...before, scrollHeight: 12600 };
  const grownReport = staleMetrics(before, grown);
  assert.equal(grownReport.stale, true);
  assert.deepEqual(grownReport.changed.map((item) => item.field), ['scrollHeight']);
  assert.equal(planStaleRecovery(before, grown, { scale: 1 }).action, 'extend');
  assert.equal(planStaleRecovery(before, grown, { scale: 1 }).y0, 12000);

  const revisionChanged = { ...before, revision: 9 };
  assert.equal(staleMetrics(before, revisionChanged, { tolerance: 0 }).stale, true);
  assert.equal(planStaleRecovery(before, revisionChanged, { scale: 1 }).action, 'rewrite');

  const narrower = { ...before, scrollWidth: 800, innerWidth: 800 };
  assert.equal(planStaleRecovery(before, narrower, { scale: 1 }).action, 'retry');
  assert.equal(planStaleRecovery(before, null).action, 'accept');
});

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

test('LongshotStore：写分片/读回/排序/manifest 封版/摘要', async () => {
  const store = new LongshotStore({ backend: new MemoryLongshotBackend(), now: () => 1234 });
  const first = await store.putSegment({ longshotId: 'l1', index: 1, drawY: 20000, width: 1280, height: 5000, dataUrl: fakePngDataUrl(1280, 5000) });
  const second = await store.putSegment({ longshotId: 'l1', index: 0, drawY: 0, width: 1280, height: 20000, dataUrl: fakePngDataUrl(1280, 20000) });
  assert.ok(first && second);
  const segments = await store.listSegments('l1');
  assert.deepEqual(segments.map((segment) => segment.index), [0, 1], '按 index 升序');
  assert.equal(segments[0]?.drawY, 0);
  assert.ok(Number(segments[0]?.bytes) > 0);
  assert.match(String(segments[0]?.hash), /^[0-9a-f]{8}$/);

  let manifest = buildLongshotManifest({ id: 'l1', width: 1280, height: 25000, dpr: 1, totalSegments: 2, now: 1234 });
  manifest = appendLongshotSegment(manifest, { index: 1, drawY: 20000, pageY: 20000, pageHeight: 5000, width: 1280, height: 5000, bytes: 10, hash: 'aaaa' }, 1234);
  manifest = appendLongshotSegment(manifest, { index: 0, drawY: 0, pageY: 0, pageHeight: 20000, width: 1280, height: 20000, bytes: 20, hash: 'bbbb' }, 1234);
  assert.equal(sealLongshotManifest(manifest, 1234).sealed, true);
  assert.equal(sealLongshotManifest({ ...manifest, totalSegments: 3 }).sealed, false, '缺段不封版');
  const summary = manifestSummary(manifest);
  assert.equal(summary?.total, 2);
  assert.equal(summary?.segments, 2);

  await store.putManifest(manifest);
  const listed = await store.listManifests();
  assert.equal(listed.length, 1);
  assert.equal((await store.latest())?.id, 'l1');
  assert.equal(store.backendKind(), 'memory');
});

test('hashDataUrl / dataUrlBytes：base64 长度换算与确定性', () => {
  const dataUrl = fakePngDataUrl(10, 10);
  assert.equal(hashDataUrl(dataUrl), hashDataUrl(dataUrl));
  assert.notEqual(hashDataUrl(dataUrl), hashDataUrl(dataUrl + 'x'));
  assert.equal(dataUrlBytes('data:image/png;base64,AAAA'), 3);
});

// ---------------------------------------------------------------------------
// 采集（假依赖驱动）
// ---------------------------------------------------------------------------

test('capture：6000px 页面 → 帧数/尺寸/拼接几何，恢复原始滚动位置', async () => {
  const harness = createHarness({ metrics: { scrollHeight: 6000, innerHeight: 500 } });
  const result = await harness.engine.capture({ tabId: 7, windowId: 1, url: 'https://example.test/' });
  assert.equal(result.width, 1000);
  assert.equal(result.height, 6000);
  assert.equal(result.frames, 12, '12 帧（6000/500）');
  assert.equal(result.tiled, 12);
  assert.equal(result.segmented, false);
  assert.equal(result.stale, false);
  assert.equal(result.staleAttempts, 1);
  const stitch = harness.codecState.stitches[0];
  assert.ok(stitch);
  assert.equal(stitch.width, 1000);
  assert.equal(stitch.height, 6000);
  assert.deepEqual(stitch.drawYs.slice(0, 3), [0, 500, 1000]);
  assert.deepEqual(harness.scrolls[harness.scrolls.length - 1], { x: 0, y: 0 }, '结束回到原始滚动位置');
});

test('capture：页脚夹具 → 固定顶/底带重绘 + 分片落盘 + 恢复尺寸一致', async () => {
  const harness = createHarness({
    metrics: { scrollHeight: 15000, innerHeight: 800, innerWidth: 1280, scrollWidth: 1280 },
    frameWidth: 1280,
    frameHeight: 800,
    fixedTopHeight: 56,
    fixedBottomHeight: 80,
    fixedBands: [
      { edge: 'top', height: 56, top: 0, bottom: 56 },
      { edge: 'bottom', height: 80, top: 720, bottom: 800 },
    ],
  });
  const result = await harness.engine.capture({ tabId: 9, windowId: 1, url: 'https://example.test/footer.html' });
  assert.equal(result.height, 15000);
  assert.equal(result.fixedTop, 56);
  assert.equal(result.fixedFooter, 80);
  assert.equal(result.fixedBands, 2);
  assert.equal(result.stale, false);
  assert.ok(result.tilesPersisted >= 1, '必须落盘分片');
  assert.equal(typeof result.longshotId, 'string');
  const stitch = harness.codecState.stitches[0];
  assert.ok(stitch);
  assert.equal(stitch.bands, 2, '顶带+底带两条 overlay');
  // 固定带重绘会额外滚动到页首/页尾
  assert.ok(harness.scrolls.some((item) => item.y === 0));
  assert.ok(harness.scrolls.some((item) => item.y === 15000 - 800));

  const recovered = await harness.engine.recover({ longshotId: result.longshotId });
  assert.equal(recovered.width, result.width);
  assert.equal(recovered.height, result.height);
  assert.equal(recovered.tiles, 1);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.sealed, true);
});

test('capture：stale 页面按 --stale-attempts 重拍并如实标记', async () => {
  const harness = createHarness({
    metricsSequence: [
      { scrollHeight: 12000 },
      { scrollHeight: 12600 },
      { scrollHeight: 12900 },
      { scrollHeight: 13100 },
      { scrollHeight: 13200 },
      { scrollHeight: 13300 },
    ],
  });
  const result = await harness.engine.capture({ tabId: 3, windowId: 1, staleAttempts: 2 });
  assert.equal(result.stale, true, '页面一直在变必须标 stale');
  assert.equal(result.staleAttempts, 2);
  assert.equal(result.staleRepairs, 1);
  assert.ok(result.staleChanges.some((item) => item.field === 'scrollHeight'));
});

test('capture：稳定页面不重拍（stale=false, attempts=1）', async () => {
  const harness = createHarness({ metricsSequence: [{ scrollHeight: 6000 }, { scrollHeight: 6000 }] });
  const result = await harness.engine.capture({ tabId: 3, windowId: 1, staleAttempts: 3 });
  assert.equal(result.stale, false);
  assert.equal(result.staleAttempts, 1);
  assert.equal(result.staleRepairs, 0);
});

test('capture：帧数上限触发 truncated，且不谎报高度', async () => {
  const harness = createHarness({ metrics: { scrollHeight: 6000, innerHeight: 500 }, maxFrames: 8 });
  const result = await harness.engine.capture({ tabId: 5, windowId: 1 });
  assert.equal(result.frames, 8);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((note) => /帧数达到上限/.test(note)));
});

test('capture：超过单画布上限 → 分段输出（每段独立 PNG + offset）', async () => {
  const harness = createHarness({
    metrics: { scrollHeight: 45000, innerHeight: 1500, innerWidth: 1280, scrollWidth: 1280, devicePixelRatio: 1 },
    frameWidth: 1280,
    frameHeight: 1500,
    maxFrames: 60,
  });
  const result = await harness.engine.capture({ tabId: 11, windowId: 1 });
  assert.equal(result.segmented, true);
  assert.equal(result.segmentCount, 3, '45000 → 20000+20000+5000');
  assert.equal(result.height, 45000);
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.segments.map((segment) => segment.offsetY), [0, 20000, 40000]);
  assert.ok(result.segments.every((segment) => segment.height > 0));
});

test('capture：强制 segmented（单段页面）也回执 segment_count=1', async () => {
  const harness = createHarness({ metrics: { scrollHeight: 2600, innerHeight: 500 } });
  const result = await harness.engine.capture({ tabId: 2, windowId: 1, segmented: true, tileSize: 512 });
  assert.equal(result.segmented, true);
  assert.equal(result.segmentCount, 1);
  assert.equal(result.tileSize, 512);
});

test('recover：没有分片时 E_NOT_FOUND，分片缺段时标 recovered', async () => {
  const harness = createHarness({ metrics: { scrollHeight: 3000, innerHeight: 500 } });
  await assert.rejects(
    () => harness.engine.recover({ longshotId: 'missing' }),
    (error: unknown) => (error as { code?: string }).code === 'E_NOT_FOUND',
  );
  const capture = await harness.engine.capture({ tabId: 2, windowId: 1 });
  // 人为制造缺段：把 manifest 改成 3 段
  const manifest = (await harness.store.latest())!;
  await harness.store.putManifest({ ...manifest, totalSegments: 3, sealed: false });
  const partial = await harness.engine.recover({ longshotId: capture.longshotId });
  assert.equal(partial.complete, false);
  assert.equal(partial.recovered, true);
  assert.deepEqual(partial.gaps, [1, 2]);
});

test('estimateLongshotBudget：像素预算与分段建议', () => {
  const budget = estimateLongshotBudget({ scrollWidth: 1280, scrollHeight: 45000, dpr: 1, maxSegmentHeight: 20000 });
  assert.equal(budget.deviceWidth, 1280);
  assert.equal(budget.deviceHeight, 45000);
  assert.equal(budget.segmented, true);
  assert.equal(budget.estimatedSegments, 3);
  assert.equal(budget.truncated, false);
  assert.equal(budget.pixels, 1280 * 45000);

  const tooBig = estimateLongshotBudget({ scrollWidth: 4000, scrollHeight: 200000, dpr: 1, maxTotalPixels: 10_000_000 });
  assert.equal(tooBig.truncated, true);
  assert.ok(tooBig.deviceHeight < 200000);
  assert.match(tooBig.reason, /高度截断/);
});

test('planStitch：有 drawY 按页面坐标、旧分片按顺序累加', () => {
  const withDrawY = planStitch([{ drawY: 0, height: 500 }, { drawY: 500, height: 500 }], { width: 100 });
  assert.deepEqual(withDrawY.placements.map((item) => item.drawY), [0, 500]);
  assert.equal(withDrawY.height, 1000);
  const legacy = planStitch([{ height: 500 }, { height: 600 }], { width: 100 });
  assert.deepEqual(legacy.placements.map((item) => item.drawY), [0, 500]);
  assert.equal(legacy.height, 1100);
});
