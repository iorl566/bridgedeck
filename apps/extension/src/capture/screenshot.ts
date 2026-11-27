// src/capture/screenshot.ts —— 只读截图面（M-C 第三批）。
//
// 语义边界（与 JS 扩展的差别必须显式）：
// - 只用 `chrome.tabs.captureVisibleTab`，**不接 chrome.debugger**：因此能拍“可见区域”、
//   能通过滚动 + 拼接得到整页、能按元素/区域裁剪，但不能拍到被别的标签页挡住的窗口、
//   也不能在页面未激活时后台拍（本实现会在拍之前临时激活目标 tab，拍完还原本来的活动 tab）；
// - 明确不迁移的能力（`--visual` 候选、`--annotate` 之外的网格/剖面、CDP 分块 tiling）
//   返回 E_NOT_IMPLEMENTED，而不是悄悄降级成别的图；
// - 大图走 `--stream`：dataUrl 暂存在扩展内存，CLI 用 screenshot.read 分块取；
// - 区域截图按 CSS 像素输出（与 JS 的 CDP clip scale=1 口径一致），元素截图按设备像素输出。
//
// 依赖全部注入（browser api / 内容脚本传输 / CanvasCodec / 时钟），因此可以在 Node 单测里
// 精确驱动“滚动到位 → 抓帧 → 拼接 → 裁剪”的全过程。

import { RpcMethodError } from '../rpc/registry.ts';
import { assertProtocolCompatible, type ProtocolPeer } from '../protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { ContentReply, ContentRequest, ContentVisualRefsResult, ContentMetricsResult } from '../content/protocol.ts';
import {
  CaptureStore,
  CaptureStreamStore,
  type CaptureRecord,
  type StreamReadResult,
} from './store.ts';
import {
  diffRgba,
  pngSize,
  type CanvasCodec,
  type DecodedImage,
  type PixelDiff,
} from './codec.ts';
import { LongshotCapture } from './longshot.ts';
import { LongshotStore, type LongshotStoreOptions } from './longshot-store.ts';
import { TAKEOVER_SUPPRESS_OP } from '../content/takeover-overlay.ts';

/**
 * 截图期间抑制扩展浮层的内容脚本 op（实现在 `src/content/takeover-overlay.ts`）。
 * 内容脚本 op 白名单由 lead 在 `src/content/protocol.ts` / `session.ts` 登记。
 */
export const OVERLAY_SUPPRESS_OP = TAKEOVER_SUPPRESS_OP;

/**
 * 浮层抑制的单跳超时：它只是截图前的 best-effort 装饰，不能把截图拖到内容脚本默认
 * 10s 超时；没有内容脚本/op 未登记都会很快返回结构化失败。
 */
const OVERLAY_SUPPRESS_TIMEOUT_MS = 1_500;

/** 截图用到的 browser API 最小形状。 */
export interface CaptureTabLike {
  id?: number | null;
  windowId?: number | null;
  url?: string | null;
  title?: string | null;
  active?: boolean | null;
}

export interface CaptureTabsApi {
  tabs: {
    get(tabId: number): Promise<CaptureTabLike>;
    query(queryInfo: Record<string, unknown>): Promise<CaptureTabLike[]>;
    update(tabId: number, props: Record<string, unknown>): Promise<unknown>;
    captureVisibleTab(windowId?: number, options?: Record<string, unknown>): Promise<string>;
  };
}

export interface CaptureContentTransport {
  request(tabId: number, request: ContentRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ContentReply>;
}

export interface ScreenshotServiceOptions {
  api: CaptureTabsApi;
  /** 窗口能力（可选）：readback 失败时把窗口拉回 normal/focused 再重试（与 JS 基线一致）。 */
  windows?: { update(windowId: number, props: Record<string, unknown>): Promise<unknown> };
  content: CaptureContentTransport;
  codec: CanvasCodec;
  captures?: CaptureStore;
  streams?: CaptureStreamStore;
  /** 长截图分片仓库（默认按 IndexedDB 自动创建；单测注入内存后端）。 */
  longshots?: LongshotStore;
  longshotOptions?: LongshotStoreOptions;
  peer?: ProtocolPeer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 两帧 captureVisibleTab 的最小间隔（浏览器限速约 2 次/秒）。 */
  captureIntervalMs?: number;
  maxFullPageFrames?: number;
  /** 单张画布的最大高度（超过则按段输出；长截图单画布上限 40000）。 */
  maxCanvasHeight?: number;
  /** 分段输出时的段高（默认 20000，控制单段内存）。 */
  segmentHeight?: number;
  /** 单次 captureVisibleTab 的硬超时。 */
  captureTimeoutMs?: number;
  captureRetries?: number;
}

export interface ScreenshotOptions {
  timeoutMs?: number;
  requestId?: string;
}

export interface ScreenshotFrameState {
  dataUrl: string;
  width: number;
  height: number;
  at: number;
  /** 截图 scope（viewport/document/region/element）；差分容差只对视口截图生效。 */
  scope?: string;
}

const DEFAULT_INTERVAL_MS = 550;
const DEFAULT_MAX_FRAMES = 600;
/** 单张画布的最大设备像素高度（与 JS 基线一致；超过则按段输出）。 */
const DEFAULT_MAX_CANVAS_HEIGHT = 40_000;

/**
 * 视口截图差分允许的尺寸漂移（每维度，px）。
 *
 * 为什么需要：设备仿真（Emulation.setDeviceMetricsOverride）清除后，Edge 的窗口 chrome /
 * 合成器会重排一次，同一页面相邻两次 captureVisibleTab 可能差 4px 级高度（31g 回归实测
 * 1256x761 vs 1256x757）。这不是页面几何变化，却会让严格等尺寸差分判成 sizeMatch=false。
 * 只对「viewport 对 viewport」生效：整页/区域/元素截图仍严格等尺寸（它们才是真实几何证据）。
 */
export const VIEWPORT_DIFF_SIZE_TOLERANCE_PX = 8;

/** 左上角对齐裁剪（差分容差路径用；纯函数，单测覆盖）。 */
export function cropTopLeftImage(image: DecodedImage, width: number, height: number): DecodedImage {
  const targetWidth = Math.max(1, Math.min(Math.floor(width), image.width));
  const targetHeight = Math.max(1, Math.min(Math.floor(height), image.height));
  const rowBytes = targetWidth * 4;
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let row = 0; row < targetHeight; row += 1) {
    const sourceStart = row * image.width * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
  }
  return { width: targetWidth, height: targetHeight, data };
}

/** 是否对该尺寸漂移走「视口容差」路径（只允许 viewport↔viewport；其它 scope 严格等尺寸）。 */
export function tolerantViewportSizeDelta(
  scope: unknown,
  previousScope: unknown,
  deltaWidth: number,
  deltaHeight: number,
): boolean {
  if (String(scope) !== 'viewport' || String(previousScope) !== 'viewport') return false;
  return Math.abs(deltaWidth) <= VIEWPORT_DIFF_SIZE_TOLERANCE_PX
    && Math.abs(deltaHeight) <= VIEWPORT_DIFF_SIZE_TOLERANCE_PX;
}
/** 分段 PNG 的单段设备像素高度（控制单段画布内存）。 */
const DEFAULT_SEGMENT_HEIGHT = 20_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const STREAM_INLINE_LIMIT = 1_500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** 浏览器截图错误 → 结构化业务错误（可重试的标记 retryable）。 */
export function mapCaptureError(error: unknown): RpcMethodError {
  const message = errorMessageOf(error);
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|too many capture/i.test(message)) {
    return new RpcMethodError('E_CAPTURE_RATE_LIMIT', 'captureVisibleTab 触发浏览器限速：' + message, { retryable: true, reason: message });
  }
  if (/No window with id|Invalid window|window.*closed|Invalid tab ID|No tab with id/i.test(message)) {
    return new RpcMethodError('E_NO_WINDOW', '截图目标窗口/标签页已关闭：' + message, { reason: message });
  }
  if (/readback|failed to capture|image.*capture/i.test(message)) {
    return new RpcMethodError('E_CAPTURE_FAILED', '截图失败（窗口可能被最小化或页面未完成绘制）：' + message, {
      retryable: true,
      reason: message,
    });
  }
  return new RpcMethodError('E_CAPTURE_FAILED', '截图失败：' + message, { reason: message });
}

/** dataURL 的字符长度近似（stream 决策用）。 */
function dataUrlLength(dataUrl: unknown): number {
  return typeof dataUrl === 'string' ? dataUrl.length : 0;
}

/**
 * 截图服务。
 *
 * ```ts
 * const service = new ScreenshotService({ api: browser, content, codec });
 * const shot = await service.takeScreenshot({ tabId: 7, fullPage: true });
 * ```
 */
export class ScreenshotService {
  readonly captures: CaptureStore;
  readonly streams: CaptureStreamStore;
  readonly longshots: LongshotStore;
  private readonly api: CaptureTabsApi;
  private readonly windows: { update(windowId: number, props: Record<string, unknown>): Promise<unknown> } | null;
  private readonly content: CaptureContentTransport;
  private readonly codec: CanvasCodec;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly captureIntervalMs: number;
  private readonly maxFullPageFrames: number;
  private readonly maxCanvasHeight: number;
  private readonly segmentHeight: number;
  private readonly captureTimeoutMs: number;
  private readonly captureRetries: number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private peerValue: ProtocolPeer;
  private readonly lastCaptureAt = new Map<number, number>();
  private readonly lastShots = new Map<number, ScreenshotFrameState>();
  private readonly manualFrames = new Map<number, string[]>();

  constructor(options: ScreenshotServiceOptions) {
    if (!options || !options.api || !options.api.tabs || typeof options.api.tabs.captureVisibleTab !== 'function') {
      throw new TypeError('ScreenshotService 需要 tabs.captureVisibleTab');
    }
    if (!options.codec) throw new TypeError('ScreenshotService 需要 CanvasCodec');
    this.api = options.api;
    this.windows = options.windows && typeof options.windows.update === 'function' ? options.windows : null;
    this.content = options.content;
    this.codec = options.codec;
    this.now = options.now ?? Date.now;
    this.setTimer = (handler, ms) => setTimeout(handler, ms);
    this.clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
      this.setTimer(() => resolve(), Math.max(0, ms));
    }));
    this.captureIntervalMs = Number(options.captureIntervalMs) > 0 ? Math.floor(Number(options.captureIntervalMs)) : DEFAULT_INTERVAL_MS;
    this.maxFullPageFrames = positiveInt(options.maxFullPageFrames) ?? DEFAULT_MAX_FRAMES;
    this.maxCanvasHeight = positiveInt(options.maxCanvasHeight) ?? DEFAULT_MAX_CANVAS_HEIGHT;
    this.segmentHeight = positiveInt(options.segmentHeight) ?? DEFAULT_SEGMENT_HEIGHT;
    this.captureTimeoutMs = positiveInt(options.captureTimeoutMs) ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.captureRetries = positiveInt(options.captureRetries) ?? DEFAULT_RETRIES;
    this.peerValue = options.peer ?? { protocol: PROTOCOL_VERSION };
    this.captures = options.captures ?? new CaptureStore({ now: this.now });
    this.streams = options.streams ?? new CaptureStreamStore({ now: this.now });
    this.longshots = options.longshots ?? new LongshotStore({ now: this.now, ...(options.longshotOptions ?? {}) });
  }

  setPeer(peer: ProtocolPeer | null | undefined): void {
    this.peerValue = peer ?? {};
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  /** screenshot 命令入口（参数校验 → 抓取 → 后处理）。 */
  async takeScreenshot(rawParams: unknown, options: ScreenshotOptions = {}): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'screenshot 需要正整数 tabId（由 daemon 按会话注入）', { tabId: params.tabId ?? null });
    // feature gate：stream/segmented/staleAttempts 是 1.9 参数，旧扩展会被明确拒绝。
    assertProtocolCompatible(this.peerValue, 'screenshot', params);
    this.assertSupportedParams(params);

    const tab = await this.getTab(tabId);
    const windowId = positiveInt(tab.windowId);
    if (windowId === null) throw new RpcMethodError('E_NO_WINDOW', 'tab ' + String(tabId) + ' 没有 windowId，无法截图', { tabId });

    const scope = normalizeScope(params.scope);
    const fullPage = params.fullPage === true || scope === 'document' || scope === 'follow' || scope === 'current';
    const region = parseRegion(params.region);
    const elementTarget = parseElementTarget(params);
    const annotate = params.annotate === true;
    const wantDiff = params.diff === true;
    const wantStream = params.stream === true;

    if (annotate && (fullPage || region)) {
      throw new RpcMethodError('E_ARG_CONFLICT', 'screenshot --annotate 只能用于视口截图（不能与整页/区域同时使用）', {
        annotate: true,
        fullPage,
        region: Boolean(region),
      });
    }

    const activeTabId = await this.activeTabOf(windowId);
    const activated = activeTabId !== null && activeTabId !== tabId;
    if (activated) {
      try {
        await this.api.tabs.update(tabId, { active: true });
      } catch (error) {
        throw mapCaptureError(error);
      }
    }

    const visualBefore = annotate ? await this.visualRefs(tabId, options) : null;
    // 24d：截图前隐藏接管浮层，截图后恢复（hide → capture → restore）。
    // 抑制失败（没有内容脚本/op 未登记/超时）不阻塞截图；恢复在 finally 里无条件执行，
    // 即使 capture 抛错也不会把浮层永久留在隐藏状态。
    const overlaySuppressed = await this.setOverlaySuppressed(tabId, true, options);
    let base: Record<string, unknown>;
    try {
      if (region) base = await this.captureRegion(tab, windowId, region, options);
      else if (elementTarget) base = await this.captureElement(tab, windowId, elementTarget, options);
      else if (fullPage) base = await this.captureFullPage(tab, windowId, scope, params, options);
      else base = await this.captureSingle(tab, windowId, options);
    } finally {
      await this.setOverlaySuppressed(tabId, false, options);
      if (activated && activeTabId !== null) {
        try {
          await this.api.tabs.update(activeTabId, { active: true });
        } catch {
          // 原活动 tab 可能已关闭：忽略
        }
      }
    }

    let result: Record<string, unknown> = {
      ok: true,
      tabId,
      windowId,
      via: base.via ?? 'capture-visible-tab',
      capturedAt: this.now(),
      // 浮层抑制证据（24d）：true = 内容脚本确认在截图窗口内隐藏了扩展浮层。
      overlaySuppressed,
      ...base,
      // scope 以入口判定为权威：整页采集的 base 里也带 scope（滚动规划的入参），
      // 不能在 spread 后把 'document' 覆盖回 'viewport'（差分容差按 scope 区分，见 computeDiff）。
      scope: fullPage ? 'document' : (region ? 'region' : (elementTarget ? 'element' : 'viewport')),
    };

    if (annotate && visualBefore) {
      const after = await this.visualRefs(tabId, options);
      const geometryStable = after.innerWidth === visualBefore.innerWidth
        && Math.abs(after.scrollX - visualBefore.scrollX) < 1
        && Math.abs(after.scrollY - visualBefore.scrollY) < 1;
      if (geometryStable) {
        const annotated = await this.annotateResult(result, visualBefore, tabId);
        result = { ...result, ...annotated };
      } else {
        result = { ...result, capture_skipped: 'geometry-changed', note: '截图期间页面几何变化，capture 作废' };
      }
    }

    if (wantDiff) {
      result = { ...result, diff: await this.computeDiff(tabId, result) };
    } else {
      this.rememberShot(tabId, result);
    }

    if (wantStream || dataUrlLength(result.dataUrl) > STREAM_INLINE_LIMIT) {
      result = this.streamResult(result);
    }
    return result;
  }

  /** screenshot.read：按 base64 字符 offset 分块读取流式暂存的大截图。 */
  readChunk(rawParams: unknown): StreamReadResult {
    const params = isRecord(rawParams) ? rawParams : {};
    const captureId = typeof params.captureId === 'string' ? params.captureId : (typeof params.capture_id === 'string' ? params.capture_id : '');
    if (!captureId) throw new RpcMethodError('E_BAD_ARG', 'screenshot.read 需要 captureId');
    const chunk = this.streams.read(captureId, { offset: params.offset, length: params.length });
    if (!chunk) throw new RpcMethodError('E_NOT_FOUND', '截图 capture 不存在或已过期（重新截图）', { captureId });
    return chunk;
  }

  /** screenshot.release：释放暂存的大截图。 */
  releaseStream(rawParams: unknown): Record<string, unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    const captureId = typeof params.captureId === 'string' ? params.captureId : (typeof params.capture_id === 'string' ? params.capture_id : '');
    if (!captureId) throw new RpcMethodError('E_BAD_ARG', 'screenshot.release 需要 captureId');
    return { ok: true, released: this.streams.release(captureId) };
  }

  /** screenshot.manual.frame：手动画布的一帧（可见区域），按 tab 暂存。 */
  async manualFrame(rawParams: unknown, options: ScreenshotOptions = {}): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'screenshot.manual.frame 需要正整数 tabId');
    const tab = await this.getTab(tabId);
    const windowId = positiveInt(tab.windowId);
    if (windowId === null) throw new RpcMethodError('E_NO_WINDOW', 'tab 没有 windowId');
    const shot = await this.captureSingle(tab, windowId, options);
    // 手动长截图浮层（占位 UI）：让用户/测试看到“正在手动截长图”的可见状态，
    // 拼接完成后移除；浮层不参与像素结果。
    await this.requestContent(tabId, 'manual-overlay', { show: true }, options).catch(() => null);
    const frames = this.manualFrames.get(tabId) ?? [];
    frames.push(String(shot.dataUrl ?? ''));
    if (frames.length > 64) frames.shift();
    this.manualFrames.set(tabId, frames);
    return {
      ok: true,
      tabId,
      frames: frames.length,
      width: Number(shot.width) || null,
      height: Number(shot.height) || null,
      overlay: '__bb_manual_host',
      note: '手动长截图浮层为占位 UI（__bb_manual_host）；帧由本服务按 tab 暂存，--stitch 后移除浮层',
    };
  }

  /** screenshot.manual.save：把暂存帧纵向拼成一张 PNG 并清空。 */
  async manualSave(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'screenshot.manual.save 需要正整数 tabId');
    const frames = this.manualFrames.get(tabId) ?? [];
    if (!frames.length) throw new RpcMethodError('E_NOT_FOUND', '没有手动截图帧（先 screenshot --mode manual 拍至少一帧）', { tabId });
    const sizes = frames.map((dataUrl) => pngSize(dataUrl));
    const width = Math.max(...sizes.map((size) => size.width), 1);
    let drawY = 0;
    const stitchFrames = frames.map((dataUrl, index) => {
      const size = sizes[index] ?? { width: 0, height: 0 };
      const frame = { dataUrl, drawY, width: size.width, height: size.height };
      drawY += size.height;
      return frame;
    });
    const height = Math.min(Math.max(drawY, 1), this.maxCanvasHeight);
    const encoded = await this.codec.stitch(stitchFrames, width, height);
    this.manualFrames.delete(tabId);
    await this.requestContent(tabId, 'manual-overlay', { show: false }, {}).catch(() => null);
    return {
      ok: true,
      tabId,
      dataUrl: encoded.dataUrl,
      width: encoded.width,
      height: encoded.height,
      frames: frames.length,
      truncated: drawY > height,
      via: 'capture-visible-tab',
    };
  }

  // -------------------------------------------------------------------------
  // 参数
  // -------------------------------------------------------------------------

  private assertSupportedParams(params: Record<string, unknown>): void {
    if (params.visualIndex !== undefined && params.visualIndex !== null) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时尚未迁移视觉候选截图（--visual 需要 visual-scan）', {
        visualIndex: params.visualIndex,
      });
    }
    if (params.grid === true || (params.profile !== undefined && params.profile !== null) || params.gridStep !== undefined) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时尚未迁移截图网格/剖面叠加（--grid/--profile/--grid-step）');
    }
    // 第四批：--tile-size / --segmented 已迁移（captureVisibleTab 分块拼接）；--stale-attempts
    // 需要 CDP 的稳定页快照，本批仍不补拍，但参数不再整体拒绝（结果里带 stale_attempts 证据）。
  }

  private async getTab(tabId: number): Promise<CaptureTabLike> {
    try {
      return await this.api.tabs.get(tabId);
    } catch (error) {
      throw new RpcMethodError('E_NO_TAB', 'tabId ' + String(tabId) + ' 不存在或已关闭：' + errorMessageOf(error), { tabId });
    }
  }

  private async activeTabOf(windowId: number): Promise<number | null> {
    try {
      const tabs = await this.api.tabs.query({ windowId, active: true });
      const first = Array.isArray(tabs) ? tabs[0] : null;
      return first && Number.isInteger(Number(first.id)) ? Number(first.id) : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // captureVisibleTab 底座（限速 + 重试 + 硬超时）
  // -------------------------------------------------------------------------

  private async captureVisibleRaw(windowId: number): Promise<string> {
    const last = this.lastCaptureAt.get(windowId) ?? 0;
    const waitMs = last + this.captureIntervalMs - this.now();
    if (waitMs > 0) await this.sleep(waitMs);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.captureRetries; attempt += 1) {
      try {
        const dataUrl = await this.withCaptureTimeout(this.api.tabs.captureVisibleTab(windowId, { format: 'png' }));
        this.lastCaptureAt.set(windowId, this.now());
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
          throw new RpcMethodError('E_CAPTURE_FAILED', 'captureVisibleTab 没有返回图片 dataUrl', { windowId });
        }
        return dataUrl;
      } catch (error) {
        lastError = error;
        const mapped = mapCaptureError(error);
        const retryable = mapped.code === 'E_CAPTURE_RATE_LIMIT' || (mapped.data as { retryable?: boolean } | undefined)?.retryable === true;
        if (!retryable || attempt >= this.captureRetries) throw mapped;
        // readback 类失败通常是窗口被最小化/遮挡导致合成器没有可读帧：先把窗口拉回
        // normal + focused 并激活 tab，再退避重试（JS 基线同样在重试前 normalize 窗口）。
        if (mapped.code === 'E_CAPTURE_FAILED') await this.normalizeWindowVisibility(windowId);
        // 限速退避更久；readback 类错误短退避后重试。
        const backoff = mapped.code === 'E_CAPTURE_RATE_LIMIT'
          ? 1200 + this.captureIntervalMs * attempt
          : 700 + this.captureIntervalMs * (attempt - 1);
        await this.sleep(backoff);
      }
    }
    throw mapCaptureError(lastError);
  }

  /**
   * readback 失败时的窗口/标签页归一：窗口最小化或被遮挡会导致 captureVisibleTab
   * 返回 "image readback failed"。这里把窗口拉回 normal 且 focused，再激活窗口内 tab，
   * 给合成器一个可读帧（失败只记日志不阻断重试流程）。
   */
  private async normalizeWindowVisibility(windowId: number): Promise<void> {
    if (!this.windows) return;
    try {
      await this.windows.update(windowId, { state: 'normal', focused: true });
    } catch {
      // 窗口已关闭/无权限：继续走普通退避重试。
    }
    try {
      const tabs = await this.api.tabs.query({ windowId, active: true });
      const active = Array.isArray(tabs) && tabs[0] && Number.isInteger(tabs[0].id) ? Number(tabs[0].id) : null;
      if (active !== null) await this.api.tabs.update(active, { active: true });
    } catch {
      // tabs.query/update 失败不阻断重试。
    }
    await this.sleep(200);
  }

  private withCaptureTimeout(promise: Promise<string>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new RpcMethodError('E_TIMEOUT', 'captureVisibleTab 超时（' + String(this.captureTimeoutMs) + 'ms）', {
          retryable: true,
          reason: 'capture-timeout',
        }));
      }, this.captureTimeoutMs);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          this.clearTimer(timer);
          reject(error);
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // 内容脚本只读事实
  // -------------------------------------------------------------------------

  private async requestContent<T>(tabId: number, op: ContentRequest['op'], params: Record<string, unknown>, options: ScreenshotOptions): Promise<T> {
    const request: ContentRequest = { type: 'bb.content', requestId: options.requestId ?? ('shot-' + op + '-' + String(tabId)), op, params };
    const timeoutMs = options.timeoutMs ?? 15_000;
    const reply = await this.content.request(tabId, request, { timeoutMs });
    if (!reply || reply.ok !== true) {
      const failure = reply ?? { ok: false, code: 'E_CONTENT_ERROR', message: '内容脚本没有回包' };
      throw new RpcMethodError(
        (failure as { code?: string }).code ?? 'E_CONTENT_ERROR',
        (failure as { message?: string }).message ?? '内容脚本调用失败',
        (failure as { data?: unknown }).data,
      );
    }
    return reply.result as T;
  }

  private async metrics(tabId: number, options: ScreenshotOptions): Promise<ContentMetricsResult> {
    return this.requestContent<ContentMetricsResult>(tabId, 'metrics', {}, options);
  }

  private async scroll(tabId: number, params: Record<string, unknown>, options: ScreenshotOptions): Promise<void> {
    await this.requestContent(tabId, 'scroll', params, options);
  }

  private async visualRefs(tabId: number, options: ScreenshotOptions): Promise<ContentVisualRefsResult> {
    return this.requestContent<ContentVisualRefsResult>(tabId, 'visual-refs', {}, options);
  }

  // -------------------------------------------------------------------------
  // 24d：截图期间隐藏接管浮层（best-effort，恢复必须执行）
  // -------------------------------------------------------------------------

  /**
   * 通知内容脚本隐藏/恢复扩展浮层（takeover 等）。
   *
   * 语义：
   * - 内容脚本没有这个 op（E_UNKNOWN_OP）/没有内容脚本（E_NO_CONTENT）/超时，都只当
   *   “这个页面没有可抑制的浮层”，**绝不阻塞截图**；
   * - `hidden=false` 的恢复由调用方在 finally 里无条件调用（哪怕 hide 回包丢了，也可能
   *   已经生效），保证浮层不会永久消失；
   * - 返回是否拿到内容脚本的成功回包（作为 result.overlaySuppressed 证据）。
   */
  private async setOverlaySuppressed(tabId: number, hidden: boolean, options: ScreenshotOptions): Promise<boolean> {
    try {
      // op 名与内容脚本侧共用 `src/content/takeover-overlay.ts` 的常量；ContentRequest
      // 的 op 联合类型需要 lead 在 protocol 白名单里登记后才不用这层断言。
      const request: ContentRequest = {
        type: 'bb.content',
        requestId: (options.requestId ?? 'shot') + '-overlay-' + (hidden ? 'hide' : 'restore') + '-' + String(tabId),
        op: OVERLAY_SUPPRESS_OP as unknown as ContentRequest['op'],
        params: { hidden },
      };
      const timeoutMs = Math.max(500, Math.min(OVERLAY_SUPPRESS_TIMEOUT_MS, options.timeoutMs ?? OVERLAY_SUPPRESS_TIMEOUT_MS));
      const reply = await this.content.request(tabId, request, { timeoutMs });
      return Boolean(reply && reply.ok === true);
    } catch {
      // 浮层抑制失败不能影响截图本身
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 采集模式
  // -------------------------------------------------------------------------

  private async captureSingle(tab: CaptureTabLike, windowId: number, _options: ScreenshotOptions): Promise<Record<string, unknown>> {
    const dataUrl = await this.captureVisibleRaw(windowId);
    const size = pngSize(dataUrl);
    return {
      dataUrl,
      width: size.width,
      height: size.height,
      via: 'capture-visible-tab',
      tabId: tab.id ?? null,
      windowId,
    };
  }

  /**
   * 整页截图：交给 LongshotCapture（滚动分段 + 拼接 + 固定带重绘 + stale 重拍 + 分片落盘）。
   *
   * 与旧实现的差别（M-C 第五批）：
   * - 规划/几何/降级全部收敛到 `longshot-plan.ts` 纯函数，并用 `LongshotCapture` 驱动；
   * - 单画布上限从 32000 提到 40000（与 JS 基线一致），超过 40000 才分段输出；
   * - 每段结束都落盘成分片并写 manifest，`longshot.recover` 可跨进程拼回来；
   * - stale 检测变成真实重拍（不再只是"回执参数"）。
   */
  private async captureFullPage(
    tab: CaptureTabLike,
    windowId: number,
    scope: string,
    params: Record<string, unknown>,
    options: ScreenshotOptions,
  ): Promise<Record<string, unknown>> {
    if (!tab.id) throw new RpcMethodError('E_NO_TAB', '整页截图缺少 tabId');
    const tabId = Number(tab.id);
    const tileSizeRaw = Number(params.tileSize);
    const tileSize = Number.isFinite(tileSizeRaw) && tileSizeRaw >= 256 ? Math.floor(tileSizeRaw) : null;
    const staleAttemptsRaw = Number(params.staleAttempts);
    const staleAttempts = Number.isFinite(staleAttemptsRaw) && staleAttemptsRaw > 0 ? Math.min(3, Math.floor(staleAttemptsRaw)) : 1;
    const overlapRaw = Number(params.overlap);
    const overlap = Number.isFinite(overlapRaw) && overlapRaw > 0 ? Math.floor(overlapRaw) : 0;
    const engine = new LongshotCapture({
      metrics: (targetTabId) => this.metrics(targetTabId, options),
      scroll: (targetTabId, x, y) => this.scroll(targetTabId, { x, y }, options),
      capture: () => this.captureVisibleRaw(windowId),
      codec: this.codec,
      store: this.longshots,
      now: this.now,
      sleep: this.sleep,
      maxSingleCanvasHeight: this.maxCanvasHeight,
      segmentHeight: this.segmentHeight,
      maxFrames: this.maxFullPageFrames,
      log: () => undefined,
    });
    let result: Awaited<ReturnType<LongshotCapture['capture']>>;
    try {
      result = await engine.capture({
        tabId,
        windowId,
        url: String(tab.url ?? ''),
        tileSize,
        overlap,
        segmented: params.segmented === true,
        staleAttempts,
        growth: params.growth === true || scope === 'follow',
        persist: true,
      });
    } catch (error) {
      throw mapCaptureError(error);
    }
    const base: Record<string, unknown> = {
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      via: result.via,
      fullPage: true,
      full_page: true,
      frames: result.frames,
      tiled: result.tiled,
      dpr: result.dpr,
      fixedTop: result.fixedTop,
      fixedFooter: result.fixedFooter,
      fixedBands: result.fixedBands,
      stale: result.stale,
      stale_attempts: result.staleAttempts,
      stale_repairs: result.staleRepairs,
      stale_changes: result.staleChanges,
      longshot_id: result.longshotId,
      tiles_persisted: result.tilesPersisted,
      truncated: result.truncated,
      extended: result.extended,
      rewritten_tiles: result.rewrittenTiles,
      scrollHeight: result.scrollHeight,
      scrollWidth: result.scrollWidth,
      scale: result.scale,
      overlap,
      scope,
      manifest: result.manifest,
      plan: result.plan,
      notes: result.notes,
      ...(result.tileSize !== null ? { tile_size: result.tileSize } : {}),
      ...(params.growth === true || scope === 'follow' ? { growth: true } : {}),
    };
    if (result.segmented) {
      return {
        ...base,
        segmented: true,
        segment_count: result.segmentCount,
        segments: result.segments.map((segment) => ({
          dataUrl: segment.dataUrl,
          height: segment.height,
          offsetY: segment.offsetY,
          fixedTop: segment.fixedTop,
          fixedBottom: segment.fixedBottom,
        })),
      };
    }
    return base;
  }

  /**
   * longshot.recover：按分片把整页拼回来（CLI `bridge longshot recover <id>` / MCP 共用）。
   * 不带 id 时恢复最近一张；分片不完整时仍尽力拼接并标 `complete:false`。
   */
  async longshotRecover(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const engine = new LongshotCapture({
      metrics: (tabId) => this.metrics(tabId, {}),
      scroll: async () => undefined,
      capture: async () => {
        throw new RpcMethodError('E_CAPTURE_FAILED', 'longshot.recover 不需要重新截图');
      },
      codec: this.codec,
      store: this.longshots,
      now: this.now,
      sleep: this.sleep,
    });
    try {
      const recovered = await engine.recover({ ...params });
      return { ...recovered };
    } catch (error) {
      if (error instanceof RpcMethodError) throw error;
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && code) {
        throw new RpcMethodError(code, error instanceof Error ? error.message : String(error), (error as { data?: unknown }).data);
      }
      throw new RpcMethodError('E_CAPTURE_FAILED', '长截图恢复失败：' + errorMessageOf(error));
    }
  }

  /** 本地可恢复的长截图清单（长截图页展示用）。 */
  async longshotManifests(): Promise<Record<string, unknown>> {
    const engine = new LongshotCapture({
      metrics: async () => ({}) as never,
      scroll: async () => undefined,
      capture: async () => {
        throw new RpcMethodError('E_CAPTURE_FAILED', 'longshot.list 不需要重新截图');
      },
      codec: this.codec,
      store: this.longshots,
      now: this.now,
    });
    const list = await engine.manifests();
    return { ok: true, backend: this.longshots.backendKind(), longshots: list, total: list.length };
  }

  private async captureElement(
    tab: CaptureTabLike,
    windowId: number,
    target: { ref?: string; selector?: string },
    options: ScreenshotOptions,
  ): Promise<Record<string, unknown>> {
    if (!tab.id) throw new RpcMethodError('E_NO_TAB', '元素截图缺少 tabId');
    const tabId = Number(tab.id);
    const metrics = await this.metrics(tabId, options);
    const original = { x: metrics.scrollX, y: metrics.scrollY };
    let state = await this.requestContent<{ attached?: boolean; visible?: boolean; rect?: { x: number; y: number; width: number; height: number }; tag?: string; inViewport?: boolean }>(
      tabId,
      'element-state',
      { ...target },
      options,
    );
    if (state?.attached !== true) throw new RpcMethodError('E_NOT_FOUND', '元素不在文档里（无法截图）', { ...target });
    const rect = state.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    if (rect.width < 1 || rect.height < 1) {
      throw new RpcMethodError('E_NOT_FOUND', '元素没有可截图的区域（尺寸为 0 或不可见）', { ...target, rect });
    }
    let scrolled = false;
    if (state.inViewport !== true) {
      try {
        await this.scroll(tabId, { ...target }, options);
        scrolled = true;
        state = await this.requestContent(tabId, 'element-state', { ...target }, options);
      } catch {
        // 滚动失败时继续尝试按当前几何裁剪
      }
    }
    try {
      const shot = await this.captureVisibleRaw(windowId);
      const size = pngSize(shot);
      const scale = metrics.innerWidth > 0 && size.width > 0 ? size.width / metrics.innerWidth : 1;
      const liveRect = state?.rect ?? rect;
      const sx = Math.max(0, Math.round(liveRect.x * scale));
      const sy = Math.max(0, Math.round(liveRect.y * scale));
      const sw = Math.min(size.width - sx, Math.round(liveRect.width * scale));
      const sh = Math.min(size.height - sy, Math.round(liveRect.height * scale));
      if (sw <= 0 || sh <= 0) {
        throw new RpcMethodError('E_NOT_FOUND', '元素在当前视口外，无法截图', { ...target, rect: liveRect, viewport: { width: size.width, height: size.height } });
      }
      const clipped = Math.round(liveRect.width * scale) > sw || Math.round(liveRect.height * scale) > sh;
      const cropped = await this.codec.crop(shot, { x: sx, y: sy, width: sw, height: sh });
      return {
        dataUrl: cropped.dataUrl,
        width: cropped.width,
        height: cropped.height,
        via: 'capture-visible-tab+crop',
        element: { ...target, tag: state?.tag ?? null },
        scale,
        clipped,
      };
    } finally {
      if (scrolled) {
        try {
          await this.scroll(tabId, { x: original.x, y: original.y }, options);
        } catch {
          // 忽略
        }
      }
    }
  }

  private async captureRegion(
    tab: CaptureTabLike,
    windowId: number,
    region: { x: number; y: number; width: number; height: number },
    options: ScreenshotOptions,
  ): Promise<Record<string, unknown>> {
    if (!tab.id) throw new RpcMethodError('E_NO_TAB', '区域截图缺少 tabId');
    const tabId = Number(tab.id);
    const metrics = await this.metrics(tabId, options);
    if (region.x + region.width > metrics.innerWidth || region.y + region.height > metrics.innerHeight) {
      throw new RpcMethodError(
        'E_NOT_IMPLEMENTED',
        'TS 运行时只支持视口内的区域截图（--region 超出当前视口需要 CDP clip，本批不接 debugger）',
        { region, viewport: { width: metrics.innerWidth, height: metrics.innerHeight } },
      );
    }
    const shot = await this.captureVisibleRaw(windowId);
    const size = pngSize(shot);
    const scale = metrics.innerWidth > 0 && size.width > 0 ? size.width / metrics.innerWidth : 1;
    const cropped = await this.codec.crop(
      shot,
      { x: region.x * scale, y: region.y * scale, width: region.width * scale, height: region.height * scale },
      { width: Math.round(region.width), height: Math.round(region.height) },
    );
    return {
      dataUrl: cropped.dataUrl,
      width: cropped.width,
      height: cropped.height,
      via: 'capture-visible-tab+crop',
      region,
      scale,
    };
  }

  // -------------------------------------------------------------------------
  // 后处理：标注 / 差分 / 流式
  // -------------------------------------------------------------------------

  private async annotateResult(
    result: Record<string, unknown>,
    refs: ContentVisualRefsResult,
    tabId: number,
  ): Promise<Record<string, unknown>> {
    const dataUrl = String(result.dataUrl ?? '');
    if (!dataUrl) return { capture_skipped: 'no-data-url' };
    const width = Number(result.width) || refs.innerWidth;
    const scale = refs.innerWidth > 0 && width > 0 ? width / refs.innerWidth : 1;
    const boxes = refs.refs.map((ref) => ({
      x: ref.rect.x * scale,
      y: ref.rect.y * scale,
      width: ref.rect.width * scale,
      height: ref.rect.height * scale,
      label: ref.ref + (ref.name ? ' ' + String(ref.name).slice(0, 24) : ''),
    }));
    const annotated = await this.codec.annotate(dataUrl, boxes);
    const capture = this.captures.put({
      tabId,
      scale,
      scrollX: refs.scrollX,
      scrollY: refs.scrollY,
      width: annotated.width,
      height: annotated.height,
      url: refs.url,
      refs: refs.refs,
    });
    const visualRefs = refs.refs.map((ref) => ({
      ref: ref.ref,
      role: ref.role,
      name: ref.name,
      image_x: Math.round((ref.rect.x + ref.rect.width / 2) * scale),
      image_y: Math.round((ref.rect.y + ref.rect.height / 2) * scale),
      x: Math.round(ref.rect.x * scale),
      y: Math.round(ref.rect.y * scale),
      width: Math.round(ref.rect.width * scale),
      height: Math.round(ref.rect.height * scale),
    }));
    // 坐标 capture 只以 snake_case 的 `capture_id` 暴露：camelCase 的 `captureId` 是
    // “分块流暂存”的 id 契约（CLI 会拿它调 screenshot.read）。以前这里把坐标 capture 的 id
    // 也塞进 captureId，CLI 见 captureId 就按流式读取 → screenshot.read 找不到流 →
    // E_NOT_FOUND「读取截图块失败」（真实 E2E 23q 的根因）。数据量超过内联上限时，
    // streamResult() 会把 captureId 覆盖成真正的流 id，同时保留 capture_id 不变。
    return {
      dataUrl: annotated.dataUrl,
      width: annotated.width,
      height: annotated.height,
      capture_id: capture.id,
      visual_refs: visualRefs,
      scale,
      scroll: { x: refs.scrollX, y: refs.scrollY },
    };
  }

  private rememberShot(tabId: number, result: Record<string, unknown>): void {
    const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : '';
    if (!dataUrl) return;
    if (this.lastShots.size >= 12 && !this.lastShots.has(tabId)) {
      const oldest = this.lastShots.keys().next().value;
      if (oldest !== undefined) this.lastShots.delete(oldest);
    }
    this.lastShots.set(tabId, {
      dataUrl,
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      at: this.now(),
      scope: typeof result.scope === 'string' ? result.scope : '',
    });
  }

  private async computeDiff(tabId: number, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    const dataUrl = typeof result.dataUrl === 'string' ? result.dataUrl : '';
    const previous = this.lastShots.get(tabId) ?? null;
    this.rememberShot(tabId, result);
    if (!dataUrl) return { baseline: true, changed: 0, total: 0, ratio: 0, sizeMatch: true, reason: 'no-data-url' };
    if (!previous || this.now() - previous.at > 5 * 60 * 1000) {
      return { baseline: true, changed: 0, total: 0, ratio: 0, sizeMatch: true };
    }
    try {
      const [before, after] = await Promise.all([this.codec.decode(previous.dataUrl), this.codec.decode(dataUrl)]);
      if (before.width !== after.width || before.height !== after.height) {
        const scope = typeof result.scope === 'string' ? result.scope : '';
        const deltaWidth = Math.abs(before.width - after.width);
        const deltaHeight = Math.abs(before.height - after.height);
        // 视口截图容差：窗口 chrome/合成器重排造成的几像素漂移不算几何变化 → 左上角对齐裁剪后再差分。
        if (tolerantViewportSizeDelta(scope, previous.scope, deltaWidth, deltaHeight)) {
          const width = Math.min(before.width, after.width);
          const height = Math.min(before.height, after.height);
          const beforeCropped = cropTopLeftImage(before, width, height);
          const afterCropped = cropTopLeftImage(after, width, height);
          const tolerant = diffRgba(beforeCropped.data, afterCropped.data, width, height, { threshold: 0.1 });
          return tolerant
            ? { sizeMatch: true, cropped: true, sizeDelta: { width: deltaWidth, height: deltaHeight }, ...tolerant }
            : { sizeMatch: false, changed: 0, total: 0, ratio: 0 };
        }
        const viewportLike = String(scope) === 'viewport' && String(previous.scope) === 'viewport';
        return {
          sizeMatch: false,
          changed: 0,
          total: 0,
          ratio: 0,
          before: { width: before.width, height: before.height },
          after: { width: after.width, height: after.height },
          ...(viewportLike ? { sizeDelta: { width: deltaWidth, height: deltaHeight } } : {}),
        };
      }
      const diff: PixelDiff | null = diffRgba(before.data, after.data, after.width, after.height, { threshold: 0.1 });
      return diff ? { sizeMatch: true, ...diff } : { sizeMatch: false, changed: 0, total: 0, ratio: 0 };
    } catch (error) {
      return { baseline: false, changed: 0, total: 0, ratio: 0, sizeMatch: false, error: errorMessageOf(error) };
    }
  }

  private streamResult(result: Record<string, unknown>): Record<string, unknown> {
    const stored = this.streams.put({
      dataUrl: result.dataUrl,
      width: Number.isInteger(Number(result.width)) ? Number(result.width) : null,
      height: Number.isInteger(Number(result.height)) ? Number(result.height) : null,
      via: typeof result.via === 'string' ? result.via : null,
    });
    if (!stored) return result;
    const streamed: Record<string, unknown> = { ...result };
    delete streamed.dataUrl;
    return {
      ...streamed,
      captureId: stored.captureId,
      capture_id: typeof streamed.capture_id === 'string' ? streamed.capture_id : stored.captureId,
      streamed: true,
      bytes: stored.bytes,
      width: stored.width ?? streamed.width ?? null,
      height: stored.height ?? streamed.height ?? null,
    };
  }

  /** 最近一次截图（诊断用）。 */
  lastShotOf(tabId: number): ScreenshotFrameState | null {
    return this.lastShots.get(Number(tabId)) ?? null;
  }

  /** 坐标 capture 查询（click-point 用；单次消费由调用方负责）。 */
  captureOf(id: unknown): CaptureRecord | null {
    return this.captures.get(id);
  }

  consumeCapture(id: unknown): CaptureRecord | null {
    return this.captures.consume(id);
  }
}

function normalizeScope(raw: unknown): 'viewport' | 'document' | 'follow' | 'current' {
  const text = String(raw ?? '').toLowerCase();
  if (text === 'document' || text === 'follow' || text === 'current') return text;
  return 'viewport';
}

function parseRegion(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (raw === undefined || raw === null) return null;
  const bag = isRecord(raw) ? raw : {};
  const x = Number(bag.x);
  const y = Number(bag.y);
  const width = Number(bag.width);
  const height = Number(bag.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    throw new RpcMethodError('E_BAD_ARG', 'region 需要数值 x/y/width/height');
  }
  if (width <= 0 || height <= 0) throw new RpcMethodError('E_BAD_ARG', 'region 的 width/height 必须大于 0', { region: raw });
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

function parseElementTarget(params: Record<string, unknown>): { ref?: string; selector?: string } | null {
  const ref = typeof params.ref === 'string' && params.ref ? params.ref : '';
  const selector = typeof params.selector === 'string' && params.selector ? params.selector : '';
  if (!ref && !selector) return null;
  return {
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
  };
}
