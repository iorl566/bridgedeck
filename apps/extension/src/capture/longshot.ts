// src/capture/longshot.ts —— 整页长截图采集（captureVisibleTab 滚动分段 + 拼接）。
//
// 边界（必须显式）：
// - **没有 chrome.debugger**：整页不是一次 CDP clip 拍出来的，而是"滚到位置 → 拍可见区域 →
//   按页面坐标贴回大画布"。因此：
//   - 采集期间页面真实滚动（结束后恢复到原始 scrollX/scrollY）；
//   - 每次 captureVisibleTab 受浏览器限速约束（调用方在 capture() 里已节流）；
//   - 固定顶/底栏每次滚动都贴在视口里，必须在拼接后**重绘**到首/末段，否则整页会布满重复横条；
//   - 页面在采集期间继续变化时必须检测 stale 并重拍（有限次数），不能假装成功。
// - 超过单画布高度上限（40000 设备像素）时按段输出：每段独立画布、独立 PNG，首段画固定顶带、
//   末段画固定底带；每段落盘成分片（IndexedDB），`longshot.recover` 可按段拼回来。
// - 所有浏览器交互都由 deps 注入（metrics/scroll/capture/codec/store），Node 单测可以精确
//   驱动"规划 → 滚动 → 抓帧 → 拼接 → 重绘固定带 → 落盘 → 恢复"的全过程。

import { pngSize, type CanvasCodec, type EncodedImage, type StitchBand, type StitchFrame } from './codec.ts';
import {
  bandRedrawRect,
  canvasDevicePx,
  describeSegmentPlan,
  estimateLongshotBudget,
  normalizeDpr,
  planFixedBands,
  planLongshotSegments,
  planSegmentFrames,
  planStitch,
  segmentPlanWire,
  staleMetrics,
  validateSegmentPlan,
  MAX_SINGLE_CANVAS_HEIGHT,
  DEFAULT_SEGMENT_HEIGHT,
  type LongshotMetrics,
  type SegmentPlan,
  type SegmentPlanEntry,
} from './longshot-plan.ts';
import {
  appendLongshotSegment,
  buildLongshotManifest,
  manifestSummary,
  sealLongshotManifest,
  type LongshotManifest,
  type LongshotStore,
} from './longshot-store.ts';

/** 固定带重绘的源图裁剪方式：顶带取视口顶部、底带取视口底部。 */
export type StitchBandOverlay = StitchBand;

export interface LongshotDeps {
  metrics(tabId: number): Promise<LongshotMetrics>;
  scroll(tabId: number, x: number, y: number): Promise<void>;
  /** 拍一帧可见区域（调用方负责限速/重试/超时）。 */
  capture(): Promise<string>;
  codec: CanvasCodec;
  store: LongshotStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** 单画布设备像素高度上限（默认 40000）。 */
  maxSingleCanvasHeight?: number;
  /** 超出单画布上限时的段高（默认 20000）。 */
  segmentHeight?: number;
  /** 总像素预算（画布内存 ≈ 4 字节/像素）。 */
  maxTotalPixels?: number;
  /** 单次采集的帧数上限（防止超大页把 SW 拖死）。 */
  maxFrames?: number;
  /** 每帧前的滚动稳定等待（毫秒）。 */
  settleMs?: number;
  log?: (message: string) => void;
}

export interface FullPageCaptureOptions {
  tabId: number;
  windowId: number;
  url?: string;
  /** 分块尺寸提示（只回执到结果里；滚动采集固定按视口分帧）。 */
  tileSize?: number | null;
  /** 段间重叠设备像素（默认 0）。 */
  overlap?: number;
  /** 强制分段输出（即使没超过单画布上限）。 */
  segmented?: boolean;
  /** stale 重拍次数上限（1–3；默认 1 = 不重拍）。 */
  staleAttempts?: number;
  /** 预滚动触发懒加载（`--scope follow`）。 */
  growth?: boolean;
  /** 是否落盘分片（默认 true；恢复命令依赖它）。 */
  persist?: boolean;
}

export interface SegmentOutput {
  dataUrl: string;
  height: number;
  offsetY: number;
  fixedTop: number;
  fixedBottom: number;
}

export interface FullPageCaptureResult {
  dataUrl: string;
  width: number;
  height: number;
  via: 'capture-visible-tab+stitch';
  fullPage: true;
  frames: number;
  tiled: number;
  tileSize: number | null;
  dpr: number;
  fixedTop: number;
  fixedFooter: number;
  fixedBands: number;
  stale: boolean;
  staleAttempts: number;
  staleRepairs: number;
  staleChanges: Array<{ field: string; before: number; after: number }>;
  longshotId: string;
  tilesPersisted: number;
  segmented: boolean;
  segmentCount: number;
  segments: SegmentOutput[];
  truncated: boolean;
  extended: boolean;
  rewrittenTiles: number;
  manifest: Record<string, unknown> | null;
  plan: Record<string, unknown>;
  notes: string[];
  scrollHeight: number;
  scrollWidth: number;
  scale: number;
  durationMs: number;
}

export interface RecoverResult {
  ok: true;
  dataUrl: string;
  width: number;
  height: number;
  tiles: number;
  complete: boolean;
  sealed: boolean;
  recovered: boolean;
  longshotId: string;
  manifest: Record<string, unknown> | null;
  gaps: number[];
  note: string;
}

const DEFAULT_SETTLE_MS = 90;
const DEFAULT_MAX_FRAMES = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringParam(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function newLongshotId(): string {
  try {
    const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoValue && typeof cryptoValue.randomUUID === 'function') return cryptoValue.randomUUID();
  } catch {
    // 忽略：回退到时间戳 + 随机后缀
  }
  return 'longshot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 长截图采集/恢复服务。
 *
 * ```ts
 * const longshot = new LongshotCapture({ metrics, scroll, capture, codec, store, ... });
 * const shot = await longshot.capture({ tabId, windowId, url, staleAttempts: 2 });
 * const restored = await longshot.recover({ longshotId: shot.longshotId });
 * ```
 */
export class LongshotCapture {
  private readonly deps: LongshotDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly maxSingleCanvasHeight: number;
  private readonly segmentHeight: number;
  private readonly maxTotalPixels: number;
  private readonly maxFrames: number;
  private readonly settleMs: number;
  private readonly log: (message: string) => void;

  constructor(deps: LongshotDeps) {
    if (!deps || typeof deps.capture !== 'function') throw new TypeError('LongshotCapture 需要 capture()');
    if (!deps.codec) throw new TypeError('LongshotCapture 需要 CanvasCodec');
    if (!deps.store) throw new TypeError('LongshotCapture 需要 LongshotStore');
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.newId = deps.newId ?? newLongshotId;
    this.maxSingleCanvasHeight = Number(deps.maxSingleCanvasHeight) > 0
      ? Math.floor(Number(deps.maxSingleCanvasHeight))
      : MAX_SINGLE_CANVAS_HEIGHT;
    this.segmentHeight = Number(deps.segmentHeight) > 0 ? Math.floor(Number(deps.segmentHeight)) : DEFAULT_SEGMENT_HEIGHT;
    this.maxTotalPixels = Number(deps.maxTotalPixels) > 0 ? Math.floor(Number(deps.maxTotalPixels)) : 268_000_000;
    this.maxFrames = Number(deps.maxFrames) > 0 ? Math.floor(Number(deps.maxFrames)) : DEFAULT_MAX_FRAMES;
    this.settleMs = Number(deps.settleMs) >= 0 ? Math.floor(Number(deps.settleMs)) : DEFAULT_SETTLE_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /** 整页长截图入口：测度量 → 规划 → 采集 → stale 重拍 → 拼接 → 落盘。 */
  async capture(options: FullPageCaptureOptions): Promise<FullPageCaptureResult> {
    const startedAt = this.now();
    const tabId = Number(options.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new TypeError('LongshotCapture.capture 需要正整数 tabId');
    const maxAttempts = Math.max(1, Math.min(3, Math.floor(Number(options.staleAttempts) || 1)));
    const longshotId = this.newId();
    let metrics = await this.deps.metrics(tabId);
    const original = { x: Number(metrics.scrollX) || 0, y: Number(metrics.scrollY) || 0 };
    let staleRepairs = 0;
    let attempts = 0;
    let lastStale: ReturnType<typeof staleMetrics> = { stale: false, changed: [] };
    let pass: SinglePassResult | null = null;
    try {
      if (options.growth === true) {
        await this.warmupScrolling(tabId, metrics);
        metrics = await this.deps.metrics(tabId);
      }
      for (;;) {
        attempts += 1;
        pass = await this.capturePass(metrics, { ...options, longshotId });
        const after = await this.deps.metrics(tabId);
        lastStale = staleMetrics(metrics, after, { tolerance: 1 });
        if (!lastStale.stale) break;
        if (attempts >= maxAttempts) break;
        // 页面还在变：用最新度量整页重拍（尺寸变化时旧帧的坐标不能复用）。
        staleRepairs += 1;
        this.log('长截图 stale（' + lastStale.changed.map((item) => item.field + ':' + String(item.before) + '→' + String(item.after)).join(',') +
          '），重拍第 ' + String(attempts) + ' 次');
        metrics = after;
      }
    } finally {
      try {
        await this.deps.scroll(tabId, original.x, original.y);
      } catch {
        // 页面可能已经导航：恢复滚动失败不覆盖截图结果
      }
    }
    if (!pass) throw new Error('LongshotCapture.capture 没有采集结果');
    const manifest = pass.manifest;
    return {
      dataUrl: pass.segments[0]?.dataUrl ?? '',
      width: pass.width,
      height: pass.height,
      via: 'capture-visible-tab+stitch',
      fullPage: true,
      frames: pass.frames,
      tiled: pass.frames,
      tileSize: Number.isFinite(Number(options.tileSize)) && Number(options.tileSize) >= 256 ? Math.floor(Number(options.tileSize)) : null,
      dpr: pass.dpr,
      fixedTop: pass.fixedTop,
      fixedFooter: pass.fixedFooter,
      fixedBands: pass.fixedBands,
      stale: lastStale.stale,
      staleAttempts: attempts,
      staleRepairs,
      staleChanges: lastStale.changed,
      longshotId,
      tilesPersisted: pass.tilesPersisted,
      segmented: options.segmented === true || pass.segments.length > 1,
      segmentCount: pass.segments.length,
      segments: pass.segments,
      truncated: pass.truncated,
      extended: false,
      rewrittenTiles: 0,
      manifest: manifest ? manifestSummary(manifest) : null,
      plan: pass.plan,
      notes: pass.notes,
      scrollHeight: pass.scrollHeight,
      scrollWidth: pass.scrollWidth,
      scale: pass.dpr,
      durationMs: Math.max(0, this.now() - startedAt),
    };
  }

  /**
   * 恢复：按 manifest/分片把整页拼回来。
   * - 不带 id 时用最近一张 manifest（长截图页"恢复最新"）；
   * - 分片缺段时仍尽量拼出已有部分并标 `complete:false`/`recovered:true`；
   * - 完全没有分片时抛 E_NOT_FOUND（调用方映射成结构化错误）。
   */
  async recover(rawParams: unknown): Promise<RecoverResult> {
    const params = isRecord(rawParams) ? rawParams : {};
    const requestedId = stringParam(params, ['longshotId', 'longshot_id', 'captureId', 'capture_id', 'id']);
    const manifests = await this.deps.store.listManifests();
    const manifest = requestedId
      ? (manifests.find((item) => item.id === requestedId) ?? null)
      : (manifests[0] ?? null);
    const longshotId = requestedId || manifest?.id || '';
    if (!longshotId) {
      throw Object.assign(new Error('没有可恢复的长截图分片（先拍一张 --full-page 长截图）'), {
        code: 'E_NOT_FOUND',
        data: { longshotId: null },
      });
    }
    const segments = await this.deps.store.listSegments(longshotId);
    if (!segments.length) {
      throw Object.assign(new Error('长截图分片不存在或已过期：' + longshotId), {
        code: 'E_NOT_FOUND',
        data: { longshotId },
      });
    }
    const width = Math.max(1, ...segments.map((segment) => Math.max(1, Math.round(Number(segment.width) || 1))));
    const layout = planStitch(segments, { width });
    const manifestHeight = manifest && manifest.id === longshotId ? Math.max(1, Math.round(Number(manifest.height) || 0)) : 0;
    const height = Math.max(1, Math.min(manifestHeight > 0 ? manifestHeight : layout.height, this.maxSingleCanvasHeight * 8));
    const frames: StitchFrame[] = segments.map((segment, index) => {
      const placement = layout.placements[index];
      return {
        dataUrl: segment.dataUrl,
        drawX: 0,
        drawY: placement ? placement.drawY : 0,
        width: segment.width,
        height: segment.height,
      };
    });
    const encoded = await this.deps.codec.stitch(frames, width, height);
    const gaps: number[] = [];
    if (manifest) {
      const present = new Set(segments.map((segment) => Number(segment.index)));
      for (let index = 0; index < manifest.totalSegments; index += 1) {
        if (!present.has(index)) gaps.push(index);
      }
    }
    const sealed = Boolean(manifest?.sealed) && gaps.length === 0;
    return {
      ok: true,
      dataUrl: encoded.dataUrl,
      width: encoded.width,
      height: encoded.height,
      tiles: segments.length,
      complete: gaps.length === 0,
      sealed,
      recovered: !sealed,
      longshotId,
      manifest: manifestSummary(manifest),
      gaps,
      note: gaps.length === 0 ? '分片完整' : '缺 ' + String(gaps.length) + ' 段（已按现有分片拼接）',
    };
  }

  /** 预览用的 manifest 列表（长截图页"本地分片"列表）。 */
  async manifests(): Promise<Record<string, unknown>[]> {
    const list = await this.deps.store.listManifests();
    return list.map((item) => ({
      id: item.id,
      width: item.width,
      height: item.height,
      dpr: item.dpr,
      tiles: item.totalSegments,
      segments: item.segments.length,
      sealed: item.sealed,
      createdAt: item.createdAt,
      url: item.url,
    }));
  }

  // -------------------------------------------------------------------------

  /** 预滚动一遍（触发懒加载/滚动容器），然后回到页首。 */
  private async warmupScrolling(tabId: number, metrics: LongshotMetrics): Promise<void> {
    const innerHeight = Math.max(1, Math.round(Number(metrics.innerHeight) || 1));
    const scrollHeight = Math.max(innerHeight, Math.round(Number(metrics.scrollHeight) || innerHeight));
    const maxScroll = Math.max(0, scrollHeight - innerHeight);
    const steps = Math.min(6, Math.max(1, Math.ceil(scrollHeight / innerHeight)));
    try {
      for (let step = 1; step <= steps; step += 1) {
        await this.deps.scroll(tabId, 0, Math.round((maxScroll * step) / steps));
        await this.sleep(this.settleMs);
      }
      await this.deps.scroll(tabId, 0, 0);
      await this.sleep(this.settleMs);
    } catch {
      // 懒加载预热失败不影响主流程
    }
  }

  /** 单次采集：规划分段 → 逐帧滚动抓取 → 拼接（含固定带重绘）→ 落盘。 */
  private async capturePass(metrics: LongshotMetrics, options: FullPageCaptureOptions & { longshotId: string }): Promise<SinglePassResult> {
    const tabId = Number(options.tabId);
    const dpr = normalizeDpr(metrics.devicePixelRatio);
    const innerWidth = Math.max(1, Math.round(Number(metrics.innerWidth) || 1));
    const innerHeight = Math.max(1, Math.round(Number(metrics.innerHeight) || 1));
    const scrollWidth = Math.max(innerWidth, Math.round(Number(metrics.scrollWidth) || innerWidth));
    const scrollHeight = Math.max(innerHeight, Math.round(Number(metrics.scrollHeight) || innerHeight));
    const budget = estimateLongshotBudget({
      scrollWidth,
      scrollHeight,
      dpr,
      maxDeviceDimension: this.maxSingleCanvasHeight,
      maxSegmentHeight: options.segmented === true ? this.segmentHeight : this.maxSingleCanvasHeight,
      maxTotalPixels: this.maxTotalPixels,
    });
    const deviceWidth = budget.deviceWidth;
    const deviceHeight = budget.deviceHeight;
    const bands = planFixedBands(metrics, { dpr, deviceHeight });
    const maxSegmentHeight = budget.segmented ? this.segmentHeight : this.maxSingleCanvasHeight;
    const plan = planLongshotSegments({
      deviceWidth,
      deviceHeight,
      dpr,
      fixedTop: bands.fixedTop,
      fixedBottom: bands.fixedBottom,
      overlap: Number(options.overlap) || 0,
      maxSegmentHeight,
      minSegmentHeight: Math.min(maxSegmentHeight, 512),
    });
    const validation = validateSegmentPlan(plan);
    if (!validation.ok) {
      this.log('长截图分段规划自检失败（按规划继续）：' + validation.errors.map((item) => item.code).join(','));
    }
    this.log('长截图分段规划：' + describeSegmentPlan(plan));

    let manifest = buildLongshotManifest({
      id: options.longshotId,
      tabId,
      url: options.url ?? '',
      width: deviceWidth,
      height: deviceHeight,
      dpr,
      totalSegments: plan.totalSegments,
      now: this.now(),
    });
    if (options.persist !== false) await this.deps.store.putManifest(manifest);

    const columns = this.planColumns({ innerWidth, scrollWidth });
    const segments: SegmentOutput[] = [];
    let framesTotal = 0;
    let tilesPersisted = 0;
    let framesTruncated = false;
    let topBandHeight = 0;
    let bottomBandHeight = 0;
    for (const segment of plan.segments) {
      const frames = planSegmentFrames(segment, { innerWidth, innerHeight, scrollWidth, scrollHeight }, {
        overlap: plan.overlap,
        maxFrames: this.maxFrames,
        columns,
      });
      const captured = await this.captureFrames(tabId, segment, frames, dpr);
      framesTotal += captured.frames.length;
      if (captured.truncated) framesTruncated = true;
      const overlays = await this.captureBands(tabId, segment, bands, dpr, scrollHeight, innerHeight);
      topBandHeight = Math.max(topBandHeight, overlays.renderedTop);
      bottomBandHeight = Math.max(bottomBandHeight, overlays.renderedBottom);
      const encoded = await this.deps.codec.stitch(
        captured.frames.map((frame) => ({
          dataUrl: frame.dataUrl,
          drawX: frame.drawX,
          drawY: frame.drawY,
          width: frame.width,
          height: frame.height,
        })),
        deviceWidth,
        segment.drawHeight,
        overlays.overlays,
      );
      const output: SegmentOutput = {
        dataUrl: encoded.dataUrl,
        height: encoded.height,
        offsetY: segment.drawY,
        fixedTop: overlays.renderedTop,
        fixedBottom: overlays.renderedBottom,
      };
      segments.push(output);
      if (options.persist !== false) {
        const stored = await this.deps.store.putSegment({
          longshotId: options.longshotId,
          index: segment.index,
          drawY: segment.drawY,
          pageY: segment.pageY,
          width: encoded.width,
          height: encoded.height,
          dataUrl: encoded.dataUrl,
        });
        if (stored) tilesPersisted += 1;
        manifest = appendLongshotSegment(manifest, {
          index: segment.index,
          drawY: segment.drawY,
          pageY: segment.pageY,
          pageHeight: segment.pageHeight,
          width: encoded.width,
          height: encoded.height,
          bytes: stored?.bytes ?? 0,
          hash: stored?.hash ?? '',
        }, this.now());
        await this.deps.store.putManifest(manifest);
      }
      this.log('分段截图 ' + String(segments.length) + '/' + String(plan.totalSegments) + '：' +
        String(encoded.width) + 'x' + String(encoded.height) + '（offset ' + String(segment.drawY) + '，dpr ' + String(dpr) + '）');
    }
    manifest = sealLongshotManifest(manifest, this.now());
    if (options.persist !== false) await this.deps.store.putManifest(manifest);
    const planWire = {
      totalSegments: plan.totalSegments,
      segmentHeight: plan.maxSegmentHeight,
      overlap: plan.overlap,
      fixedTop: bands.fixedTop,
      fixedBottom: bands.fixedBottom,
      dpr: plan.dpr,
      fractionalDpr: plan.fractional,
      validation: { ok: validation.ok, errors: validation.errors.length },
      budget: { pixels: budget.pixels, degraded: budget.degraded, reason: budget.reason },
      segments: plan.segments.map((segment) => segmentPlanWire(segment)),
    };
    return {
      segments,
      width: deviceWidth,
      height: deviceHeight,
      dpr,
      frames: framesTotal,
      fixedTop: topBandHeight || bands.fixedTop,
      fixedFooter: bottomBandHeight || bands.fixedBottom,
      fixedBands: bands.bands.length,
      tilesPersisted,
      manifest,
      plan: planWire,
      notes: [
        ...plan.notes,
        'via=capture-visible-tab（滚动采集；无 CDP clip）',
        ...(budget.degraded ? ['预算降级：' + budget.reason] : []),
        ...(framesTruncated ? ['帧数达到上限 ' + String(this.maxFrames) + '：页面尾部未采集（truncated）'] : []),
      ],
      truncated: budget.truncated || framesTruncated,
      scrollHeight,
      scrollWidth,
    };
  }

  /** 横向列位置：页面比视口宽时按视口宽推进。 */
  private planColumns(metrics: { innerWidth: number; scrollWidth: number }): number[] {
    const { innerWidth, scrollWidth } = metrics;
    if (scrollWidth <= innerWidth * 1.15) return [0];
    const maxScrollX = Math.max(0, scrollWidth - innerWidth);
    const columns: number[] = [];
    for (let x = 0; x < scrollWidth; x += innerWidth) {
      columns.push(Math.min(x, maxScrollX));
      if (columns.length > 256) break;
    }
    return columns.length ? columns : [0];
  }

  /** 逐帧：滚动 → 稳定等待 → 抓帧 → 换算段内绘制坐标。 */
  private async captureFrames(
    tabId: number,
    segment: SegmentPlanEntry,
    frames: readonly { scrollX: number; scrollY: number; drawX: number; drawY: number }[],
    dpr: number,
  ): Promise<{
    frames: Array<{ dataUrl: string; drawX: number; drawY: number; width: number; height: number }>;
    size: { width: number; height: number };
    truncated: boolean;
  }> {
    const captured: Array<{ dataUrl: string; drawX: number; drawY: number; width: number; height: number }> = [];
    let lastSize = { width: Math.max(1, Math.round(segment.width)), height: 1 };
    for (const frame of frames) {
      await this.deps.scroll(tabId, frame.scrollX, frame.scrollY);
      if (this.settleMs > 0) await this.sleep(this.settleMs);
      const dataUrl = await this.deps.capture();
      const size = pngSize(dataUrl);
      if (size.width > 0 && size.height > 0) lastSize = size;
      captured.push({
        dataUrl,
        drawX: frame.drawX,
        // 段内坐标：负值表示这一帧顶部属于上一段，画布会自然裁掉。
        drawY: frame.drawY - segment.drawY,
        width: size.width || lastSize.width,
        height: size.height || lastSize.height,
      });
    }
    void dpr;
    // 覆盖率检查：最后一帧底边 >= 段页面底边才算采全（帧数上限/横向列不足都会让这里是 false）。
    const last = frames[frames.length - 1];
    const segmentBottom = Math.ceil(segment.cssY + segment.cssHeight);
    const coveredBottom = last ? last.scrollY + lastSize.height / Math.max(1e-6, segment.dpr) : 0;
    const truncated = !last || coveredBottom < segmentBottom - 1;
    return { frames: captured, size: lastSize, truncated };
  }

  /**
   * 固定带重绘：滚到页首/页尾各拍一帧，把带高裁出来贴到首段顶部/末段底部。
   * 返回实际画进去的带高（失败为 0，不阻断截图）。
   */
  private async captureBands(
    tabId: number,
    segment: SegmentPlanEntry,
    bands: { fixedTop: number; fixedBottom: number },
    dpr: number,
    scrollHeight: number,
    innerHeight: number,
  ): Promise<{ overlays: StitchBandOverlay[]; renderedTop: number; renderedBottom: number }> {
    const overlays: StitchBandOverlay[] = [];
    let renderedTop = 0;
    let renderedBottom = 0;
    const topRect = bandRedrawRect(segment, 'top');
    const bottomRect = bandRedrawRect(segment, 'bottom');
    if (!topRect && !bottomRect) return { overlays, renderedTop, renderedBottom };
    const maxScrollY = Math.max(0, Math.round(scrollHeight - innerHeight));
    try {
      if (topRect && bands.fixedTop > 0) {
        await this.deps.scroll(tabId, 0, 0);
        if (this.settleMs > 0) await this.sleep(this.settleMs);
        const bandShot = await this.deps.capture();
        const size = pngSize(bandShot);
        const height = Math.min(topRect.height, size.height || topRect.height);
        if (height > 0) {
          overlays.push({ dataUrl: bandShot, edge: 'top', height, dstY: 0 });
          renderedTop = height;
        }
      }
      if (bottomRect && bands.fixedBottom > 0) {
        await this.deps.scroll(tabId, 0, maxScrollY);
        if (this.settleMs > 0) await this.sleep(this.settleMs);
        const bandShot = await this.deps.capture();
        const size = pngSize(bandShot);
        const height = Math.min(bottomRect.height, size.height || bottomRect.height);
        if (height > 0) {
          overlays.push({ dataUrl: bandShot, edge: 'bottom', height, dstY: Math.max(0, segment.drawHeight - height) });
          renderedBottom = height;
        }
      }
    } catch (error) {
      this.log('固定顶栏/页脚重绘失败（忽略）：' + (error instanceof Error ? error.message : String(error)));
    }
    void dpr;
    return { overlays, renderedTop, renderedBottom };
  }
}

interface SinglePassResult {
  segments: SegmentOutput[];
  width: number;
  height: number;
  dpr: number;
  frames: number;
  fixedTop: number;
  fixedFooter: number;
  fixedBands: number;
  tilesPersisted: number;
  manifest: LongshotManifest;
  plan: Record<string, unknown>;
  notes: string[];
  truncated: boolean;
  scrollHeight: number;
  scrollWidth: number;
}

/** 单帧拼接的便捷函数（恢复流程与页面预览共用；不做分段规划）。 */
export async function stitchPersistedSegments(
  codec: CanvasCodec,
  segments: ReadonlyArray<{ dataUrl: string; drawY: number; width: number; height: number }>,
  height: number,
): Promise<EncodedImage> {
  const width = Math.max(1, ...segments.map((segment) => Math.max(1, Math.round(Number(segment.width) || 1))));
  return codec.stitch(
    segments.map((segment) => ({
      dataUrl: segment.dataUrl,
      drawX: 0,
      drawY: Math.max(0, Math.round(Number(segment.drawY) || 0)),
      width: Math.max(1, Math.round(Number(segment.width) || 1)),
      height: Math.max(1, Math.round(Number(segment.height) || 1)),
    })),
    width,
    Math.max(1, Math.round(Number(height) || 1)),
  );
}

/** 规划层导出（页面/单测共用同一套几何）。 */
export {
  canvasDevicePx,
  normalizeDpr,
  planFixedBands,
  planLongshotSegments,
  planSegmentFrames,
  planStitch,
  staleMetrics,
  validateSegmentPlan,
};
export type { SegmentPlan };
