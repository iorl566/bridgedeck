// src/frames/service.ts —— observe --frames / 跨 frame 动作（M-C 第四批 + 第六批 CDP owner 投影）。
//
// 数据来源与边界：
// - frame 清单来自 chrome.webNavigation.getAllFrames（扩展已在 manifest 声明 webNavigation
//   权限）；每个 frame 的语义树由该 frame 自己的内容脚本产出（content script all_frames:true）；
// - **CDP frame owner 投影（第六批）**：跨源（OOPIF）与 3D/perspective owner 的坐标/owner 链
//   由 chrome.debugger 的 Page.getFrameTree + DOM.getFrameOwner 逐层计算（src/cdp/**）。
//   懒 attach、失败即降级：拿不到 CDP 时仍按原语义回 `via:'frame-projected'`；
// - 隐藏 frame 判定来自主文档 iframe 元素的 computed style/几何（frame-inventory）+ 帧 URL
//   对账；帧清单与主文档清单对不上的部分计入 frameGaps/frameRepairs，不静默丢；
// - ref 别名：子帧本地 ref `@eN` → 全局 `@f<frameId>eN`（background 侧 FrameRefStore），
//   动作时按别名解析回具体 frame + 本地 ref，再定向发消息到该帧的内容脚本。

import { RpcMethodError } from '../rpc/registry.ts';
import type { ContentReply, ContentRequest } from '../content/protocol.ts';
import { buildVomFramesFromCaptures } from '../content/vom-frames.ts';
import type { VomFrameCapture, VomFramesBundle } from '../content/vom-frames.ts';
import type { FrameOwnerGeometry, FrameOwnerProjection } from '../cdp/index.ts';
import { createFrameCdpService } from '../cdp/index.ts';

export interface FrameAwareContentTransport {
  request(
    tabId: number,
    request: ContentRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number },
  ): Promise<ContentReply>;
}

export interface WebNavigationApi {
  getAllFrames(details: { tabId: number }): Promise<Array<{
    frameId: number;
    parentFrameId: number;
    url?: string;
    errorOccurred?: boolean;
    documentId?: string;
  }>>;
}

/** frames 域依赖的 CDP 窄接口（结构类型；实现见 src/cdp/frames.ts）。 */
export interface FrameCdpLike {
  available(): boolean;
  status(tabId: number): {
    available: boolean;
    attached: boolean;
    sessions: number;
    cdpFrames: number;
    graphAt: number | null;
    error: string | null;
  };
  projectFramePoint(tabId: number, options: { url: string; x?: number; y?: number; timeoutMs?: number }): Promise<FrameOwnerProjection | null>;
  inspectFrames(tabId: number, urls: readonly string[], options?: { timeoutMs?: number }): Promise<Array<FrameOwnerGeometry | null>>;
  forgetTab?(tabId: number): void;
  dispose?(): void;
}

export interface FrameObservationOptions {
  tabId: number;
  force?: boolean;
  maxFrames?: number;
  timeoutMs?: number;
  /** observe --frames --vom：让每帧的内容脚本 observe 带 vom:true，原样透出 richResult.vom。 */
  vom?: boolean;
}

interface FrameObservePayload {
  url?: string;
  title?: string;
  observation?: string;
  refs?: number;
  revision?: number;
  documentId?: string;
  nodes?: Array<{ ref?: string }>;
  fingerprint?: string;
  /** 内容脚本 observe 的高级面载荷（--vom 等）；vom 原样透传，不在本层实现语义。 */
  richResult?: Record<string, unknown>;
  vom?: unknown;
}

/** 每帧 VOM 子图（装配见 src/content/vom-frames.ts；本层只透传，不算 VOM 语义）。 */
export interface FrameVomView {
  frameId?: number;
  url?: string;
  available?: boolean;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  counts?: Record<string, unknown>;
  [key: string]: unknown;
}

/** observe --frames --vom 的跨帧摘要（vom-deep 的 FrameVomSummary 形状）。 */
export interface FrameVomFramesSummary {
  count: number;
  links: Array<{ fromFrameId: number; toFrameId: number; ownerId: string }>;
  unlinked: number;
  [key: string]: unknown;
}

/** frames 结果里的 CDP 诊断摘要（增强字段；不参与动作语义）。 */
export interface FrameCdpSummary {
  available: boolean;
  attached: boolean;
  sessions: number;
  cdpFrames: number;
  graphAt: number | null;
  error: string | null;
  ownerProjections: number;
  projectionsFailed: number;
}

export interface FrameRecord {
  frameId: number;
  parentFrameId: number;
  url: string;
  title: string;
  refs: number;
  observation: string;
  documentId: string;
  revision: number;
  hidden: boolean;
  hiddenReason: string | null;
  observed: boolean;
  error: string | null;
  /** 该帧 observe 产出的节点（主帧用于登记全局 ref 表；子帧用于生成别名）。 */
  nodes: Array<{ ref?: string }>;
  /** CDP owner/几何（第六批）：跨源 OOPIF 或带变换的 owner 链；CDP 不可用时为 null。 */
  owner: FrameOwnerGeometry | null;
  /** observe --vom 的每帧子图（src/content/vom-frames.ts 装配）；未请求时 null。 */
  vom: FrameVomView | null;
}

export interface FrameAlias {
  frameId: number;
  localRef: string;
  ref: string;
  url: string;
  documentId: string;
}

export interface FrameObservationResult {
  url: string;
  title: string;
  observation: string;
  text: string;
  refs: number;
  frames: FrameRecord[];
  aliases: FrameAlias[];
  hiddenFrames: number;
  frameGaps: Array<{ frameId: number; reason: string }>;
  frameGapCounts: Record<string, number>;
  frameRepairs: { skippedHidden: number; pruned: number; repaired: number };
  fingerprint: string;
  limitations: string[];
  /** observe --frames --vom 的跨帧摘要（vom-deep 形状；未请求时为 null）。 */
  vomFrames?: FrameVomFramesSummary | null;
  /** --vom 的帧/节点/边预算（vom-deep 的 FRAME_VOM_LIMITS；未请求时为 null）。 */
  vomLimits?: Record<string, unknown> | null;
  /** --vom 装配失败时的诊断（失败时 vomFrames=null，记录保留、不阻塞观察）。 */
  vomError?: string;
  /** CDP owner 通道诊断（第六批）。 */
  cdp?: FrameCdpSummary;
  /** background 登记主文档 ref 表后的 observationId / 计数（诊断/CLI 用）。 */
  observationId?: string;
  refsRegistered?: number;
}

const FRAME_LIMITATIONS: readonly string[] = Object.freeze([
  'no-debugger: 没有 CDP frame owner 投影；跨源（OOPIF）的 owner 几何由该帧自身文档坐标给出，不做矩阵/scale 投影',
  '跨 frame 动作通过 chrome.tabs.sendMessage(frameId) 定向派发（via=frame-projected），不是 CDP Input',
  '隐藏 frame 判定来自主文档 iframe 元素 computed style/几何与帧 URL 对账',
]);

const FRAME_LIMITATIONS_CDP: readonly string[] = Object.freeze([
  'CDP frame owner 投影：跨源 OOPIF 与 3D/perspective owner 的坐标/owner 链由 chrome.debugger 的 DOM.getFrameOwner 逐层计算（via=cdp-frame-owner，可降级）；同源无变换仍走页面侧 frame-projected',
  '跨 frame 动作通过 chrome.tabs.sendMessage(frameId) 定向派发到该帧内容脚本（合成事件 trusted:false）；CDP 只做 owner 几何，不派发 Input',
  '隐藏 frame 判定来自主文档 iframe 元素 computed style/几何与帧 URL 对账',
]);

const MAX_FRAMES = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 从调用方超时里取一个 CDP 增强操作自己的预算（未给/非法时返回 null 用默认值）。 */
function budgetOf(timeoutMs: number | undefined, cap: number): number | null {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.max(value, 500), cap);
}

/** 子帧本地 ref → 全局别名（@f<frameId>eN）；已经是别名的 ref 原样返回。 */
export function frameAliasRef(frameId: number, localRef: string): string {
  if (/^@f\d+e\d+$/.test(localRef)) return localRef;
  const match = /^@e(\d+)$/.exec(localRef);
  if (!match) return localRef;
  return '@f' + String(frameId) + 'e' + match[1];
}

/** 解析全局别名 → {frameId, localRef}；不是别名返回 null。 */
export function parseFrameAlias(ref: unknown): { frameId: number; localRef: string } | null {
  if (typeof ref !== 'string') return null;
  const match = /^@f(\d+)e(\d+)$/.exec(ref);
  if (!match) return null;
  return { frameId: Number(match[1]), localRef: '@e' + match[2] };
}

/** 帧 URL 与 iframe 元素 src 的对账（忽略 hash；query 必须一致，避免把 ?hidden=1 当可见帧）。 */
export function urlsMatch(frameUrl: string, elementSrc: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      return url.origin + url.pathname + url.search;
    } catch {
      return value;
    }
  };
  const left = normalize(String(frameUrl ?? ''));
  const right = normalize(String(elementSrc ?? ''));
  if (!left || !right) return false;
  return left === right;
}

/** 从内容脚本 observe 回包里取出 --vom 子图输入（richResult.vom 的 graph/nodes；没有则空）。 */
function frameVomCaptureOf(payload: unknown): { graph: VomFrameCapture['graph']; nodes: VomFrameCapture['nodes'] } {
  if (!isRecord(payload)) return { graph: null, nodes: [] };
  const rich = isRecord(payload['richResult']) ? payload['richResult'] : null;
  const vom = rich && isRecord(rich['vom']) ? rich['vom'] : (isRecord(payload['vom']) ? payload['vom'] : null);
  if (!vom) return { graph: null, nodes: [] };
  const graph = isRecord(vom['graph']) ? vom['graph'] as unknown as VomFrameCapture['graph'] : null;
  const nodes = Array.isArray(vom['nodes']) ? vom['nodes'] as unknown as VomFrameCapture['nodes'] : [];
  return { graph, nodes };
}

/**
 * 跨帧 VOM 装配（单一实现：src/content/vom-frames.ts → packages/vom/frame-vom）。
 * 本层只提供采集输入/写回字段，不自己算 VOM 语义；失败时保持 raw/null，不阻塞观察。
 */
function assembleVomFrames(
  captures: readonly VomFrameCapture[],
): { bundle: VomFramesBundle | null; error: string | null } {
  try {
    return { bundle: buildVomFramesFromCaptures(captures), error: null };
  } catch (error) {
    return { bundle: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface FrameObservationServiceOptions {
  content: FrameAwareContentTransport;
  navigation: WebNavigationApi;
  now?: () => number;
  /**
   * CDP 门面（默认 createFrameCdpService()：惰性解析 chrome.debugger，不可用即降级）。
   * 显式传 null 关闭 CDP 投影（单测/受控环境）。
   */
  cdp?: FrameCdpLike | null;
}

/** 逐帧观察服务。 */
export class FrameObservationService {
  private readonly content: FrameAwareContentTransport;
  private readonly navigation: WebNavigationApi | null;
  private readonly aliases = new Map<number, Map<string, FrameAlias>>();
  private readonly localAliases = new Map<number, Map<string, FrameAlias>>();
  private readonly now: () => number;
  private readonly cdp: FrameCdpLike | null;

  constructor(options: FrameObservationServiceOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('FrameObservationService 需要 content transport');
    }
    // 没有 webNavigation 时构造不抛错（避免 service worker 启动即崩）：观察时明确回 E_NOT_IMPLEMENTED。
    this.content = options.content;
    this.navigation = options.navigation && typeof options.navigation.getAllFrames === 'function' ? options.navigation : null;
    this.now = options.now ?? Date.now;
    this.cdp = options.cdp === null ? null : (options.cdp ?? createFrameCdpService());
  }

  aliasFor(tabId: number, ref: string): FrameAlias | null {
    const map = this.aliases.get(Number(tabId));
    if (!map) return null;
    return map.get(ref) ?? null;
  }

  /** 纯本地 ref（@eN）唯一时映射到子帧（JS observe --frames 的兼容语义）。 */
  aliasForLocal(tabId: number, localRef: string): FrameAlias | null {
    const map = this.localAliases.get(Number(tabId));
    if (!map) return null;
    return map.get(localRef) ?? null;
  }

  forgetTab(tabId: number): void {
    this.aliases.delete(Number(tabId));
    this.localAliases.delete(Number(tabId));
    try {
      this.cdp?.forgetTab?.(Number(tabId));
    } catch {
      // 清理失败不影响别名表清理
    }
  }

  /** 释放 CDP 通道（background 卸载/测试收尾）。 */
  dispose(): void {
    try {
      this.cdp?.dispose?.();
    } catch {
      // 浏览器回收中：忽略
    }
  }

  /** 当前是否具备 CDP owner 投影能力（诊断用）。 */
  cdpAvailable(): boolean {
    try {
      return this.cdp?.available() === true;
    } catch {
      return false;
    }
  }

  /** 向单个 frame 发内容脚本请求（frameId=0 即主文档；无 targetFrameId 的普通调用不受影响）。 */
  async requestInFrame(
    tabId: number,
    frameId: number,
    op: ContentRequest['op'],
    params: Record<string, unknown>,
    options: { timeoutMs?: number; requestId?: string } = {},
  ): Promise<unknown> {
    const request: ContentRequest = {
      type: 'bb.content',
      requestId: options.requestId ?? 'frame-' + op + '-' + String(tabId) + '-' + String(frameId) + '-' + String(this.now()),
      op,
      params,
    };
    const reply = await this.content.request(tabId, request, {
      ...(options.timeoutMs && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
      frameId,
    });
    if (!reply || reply.ok !== true) {
      const failure = reply as { code?: string; message?: string; data?: unknown } | null;
      throw new RpcMethodError(
        failure?.code ?? 'E_CONTENT_ERROR',
        'frame ' + String(frameId) + ' 内容脚本失败：' + (failure?.message ?? '没有回包'),
        { frameId, ...(failure?.data !== undefined ? { data: failure.data } : {}) },
      );
    }
    return reply.result;
  }

  /**
   * observe --frames：主文档 + 每个子帧的语义树摘要，返回帧清单与全局 ref 别名。
   * 第六批：每帧附 CDP owner/几何（跨源 OOPIF 的 owner 链），并支持 --vom 透传。
   */
  async observeFrames(options: FrameObservationOptions): Promise<FrameObservationResult> {
    const tabId = options.tabId;
    const limit = Number.isInteger(options.maxFrames) && Number(options.maxFrames) > 0
      ? Math.min(Number(options.maxFrames), MAX_FRAMES)
      : MAX_FRAMES;
    if (!this.navigation) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时没有 chrome.webNavigation，无法枚举 frame 清单', { method: 'observe-frames' });
    }
    let frames: Array<{ frameId: number; parentFrameId: number; url?: string; documentId?: string }>;
    try {
      frames = await this.navigation.getAllFrames({ tabId });
    } catch (error) {
      throw new RpcMethodError('E_NO_TAB', '读取 frame 清单失败：' + (error instanceof Error ? error.message : String(error)), { tabId });
    }
    const inventory = await this.readInventory(tabId, options.timeoutMs);
    const aliases: FrameAlias[] = [];
    let mainObservation = '';
    let mainUrl = '';
    let mainTitle = '';
    let mainDocumentId = '';
    let mainRevision = 0;
    let mainFingerprint = '';
    let totalRefs = 0;
    const gaps: Array<{ frameId: number; reason: string }> = [];
    const gapCounts: Record<string, number> = {};
    const aliasMap = new Map<string, FrameAlias>();
    const sorted = frames.slice().sort((a, b) => a.frameId - b.frameId);
    const selected = sorted.slice(0, limit);
    for (const frame of sorted.slice(limit)) {
      gaps.push({ frameId: frame.frameId, reason: 'frame-limit' });
    }
    // CDP owner 投影：一次 attach + 一次帧图，批量给每帧算 owner 链（失败位置为 null）。
    const owners = await this.projectOwners(tabId, selected.map((frame) => String(frame.url ?? '')), options.timeoutMs);
    const vomCaptures: VomFrameCapture[] = [];
    const records: FrameRecord[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const frame = selected[index];
      if (!frame) continue;
      const owner = owners[index] ?? null;
      const url = String(frame.url ?? '');
      const matched = inventory.find((entry) => urlsMatch(url, entry.absoluteSrc));
      const hidden = matched ? matched.hidden : false;
      const hiddenReason = matched ? matched.hiddenReason : null;
      if (!url || url === 'about:blank') {
        gaps.push({ frameId: frame.frameId, reason: 'about-blank' });
      }
      try {
        const payload = await this.requestInFrame(tabId, frame.frameId, 'observe', {
          ...(options.force === true ? { force: true } : {}),
          ...(options.vom === true ? { vom: true } : {}),
        }, { timeoutMs: options.timeoutMs ?? 10_000 }) as FrameObservePayload;
        const observation = String(payload?.observation ?? '');
        const frameRefs = Number(payload?.refs ?? 0);
        const documentId = String(payload?.documentId ?? '');
        const revision = Number(payload?.revision ?? 0);
        const frameNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
        if (frame.frameId === 0) {
          mainObservation = observation;
          mainUrl = String(payload?.url ?? url);
          mainTitle = String(payload?.title ?? '');
          mainDocumentId = documentId;
          mainRevision = revision;
          mainFingerprint = String(payload?.fingerprint ?? '');
        }
        totalRefs += frameRefs;
        records.push({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.frameId === 0 ? mainUrl : url,
          title: String(payload?.title ?? ''),
          refs: frameRefs,
          observation,
          documentId,
          revision,
          hidden,
          hiddenReason,
          observed: true,
          error: null,
          nodes: frameNodes.map((node) => ({ ...(typeof node?.ref === 'string' ? { ref: node.ref } : {}) })),
          owner,
          vom: null,
        });
        if (options.vom === true) {
          const capture = frameVomCaptureOf(payload);
          vomCaptures.push({
            frameId: frame.frameId,
            url: frame.frameId === 0 ? mainUrl : url,
            parentFrameId: frame.parentFrameId,
            hidden,
            graph: capture.graph,
            nodes: capture.nodes,
          });
        }
        if (frame.frameId > 0 && frameRefs > 0) {
          for (const node of frameNodes) {
            const localRef = typeof node?.ref === 'string' ? node.ref : '';
            if (!localRef) continue;
            const alias: FrameAlias = {
              frameId: frame.frameId,
              localRef,
              ref: frameAliasRef(frame.frameId, localRef),
              url: url,
              documentId,
            };
            aliases.push(alias);
            if (aliasMap.size < 256) aliasMap.set(alias.ref, alias);
          }
        }
      } catch (error) {
        const failure = error instanceof RpcMethodError ? error : null;
        records.push({
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url,
          title: '',
          refs: 0,
          observation: '',
          documentId: String(frame.documentId ?? ''),
          revision: 0,
          hidden,
          hiddenReason,
          observed: false,
          error: failure ? failure.code : (error instanceof Error ? error.message : String(error)),
          nodes: [],
          owner,
          vom: null,
        });
        if (options.vom === true) {
          vomCaptures.push({
            frameId: frame.frameId,
            url,
            parentFrameId: frame.parentFrameId,
            hidden,
            graph: null,
            nodes: [],
          });
        }
        gaps.push({ frameId: frame.frameId, reason: failure ? failure.code : 'content-error' });
      }
    }
    for (const gap of gaps) gapCounts[gap.reason] = (gapCounts[gap.reason] ?? 0) + 1;
    this.aliases.set(Number(tabId), aliasMap);
    // 本地 ref 的唯一映射：子帧里出现且整体只出现一次的 @eN → 该帧（供测试/CLI 用局部 ref
    // 直接动作；有歧义时不猜，仍要求用 @f<frameId>eN 别名）。
    const localCounts = new Map<string, FrameAlias>();
    const localDup = new Set<string>();
    for (const alias of aliases) {
      if (localCounts.has(alias.localRef)) localDup.add(alias.localRef);
      else localCounts.set(alias.localRef, alias);
    }
    for (const dup of localDup) localCounts.delete(dup);
    this.localAliases.set(Number(tabId), localCounts);
    const hiddenFrames = records.filter((record) => record.hidden).length;
    const lines: string[] = [];
    if (mainObservation) lines.push(mainObservation);
    for (const record of records) {
      if (record.frameId === 0) continue;
      if (!record.observation) continue;
      lines.push('--- frame ' + String(record.frameId) + (record.hidden ? ' (hidden)' : '') + ' ' + record.url + ' ---');
      lines.push(record.observation);
    }
    const text = lines.join('\n');
    // 跨帧 VOM 装配（单一实现由 src/content/vom-frames.ts 提供；失败不阻塞观察）。
    let vomFramesValue: FrameVomFramesSummary | null = null;
    let vomLimitsValue: Record<string, unknown> | null = null;
    let vomError: string | null = null;
    if (options.vom === true) {
      const assembled = assembleVomFrames(vomCaptures);
      if (assembled.bundle) {
        for (const record of records) {
          const graph = assembled.bundle.frames.get(record.frameId);
          record.vom = graph ? (graph as unknown as FrameVomView) : null;
        }
        vomFramesValue = assembled.bundle.vomFrames as unknown as FrameVomFramesSummary;
        vomLimitsValue = { ...assembled.bundle.vomLimits };
      } else {
        vomError = assembled.error;
        vomLimitsValue = { frames: limit };
      }
    }
    const result: FrameObservationResult = {
      url: mainUrl,
      title: mainTitle,
      observation: mainObservation,
      text,
      refs: totalRefs,
      frames: records,
      aliases,
      hiddenFrames,
      frameGaps: gaps,
      frameGapCounts: gapCounts,
      frameRepairs: {
        skippedHidden: 0,
        pruned: Math.max(0, frames.length - records.length),
        repaired: records.filter((record) => record.observed).length,
      },
      fingerprint: mainFingerprint,
      limitations: this.limitations(),
      cdp: this.cdpSummary(tabId, owners),
      ...(options.vom === true
        ? {
          vomFrames: vomFramesValue,
          vomLimits: vomLimitsValue,
          ...(vomError ? { vomError } : {}),
        }
        : {}),
    };
    return result;
  }

  /** 批量 owner 投影（CDP 不可用/失败 → 全 null，不抛错）。 */
  private async projectOwners(
    tabId: number,
    urls: string[],
    timeoutMs?: number,
  ): Promise<Array<FrameOwnerGeometry | null>> {
    const empty = (): Array<FrameOwnerGeometry | null> => urls.map(() => null);
    if (!this.cdp) return empty();
    try {
      if (!this.cdp.available()) return empty();
      // 调用方 timeoutMs 可能是 observe 的超时（例如 120s）：owner 投影是增强，
      // 必须有自己的上限，避免 CDP 卡住把主观察拖死。
      const cdpTimeout = budgetOf(timeoutMs, 8_000);
      return await this.cdp.inspectFrames(tabId, urls, cdpTimeout ? { timeoutMs: cdpTimeout } : {});
    } catch {
      return empty();
    }
  }

  private limitations(): string[] {
    const withCdp = this.cdpAvailable();
    return [...(withCdp ? FRAME_LIMITATIONS_CDP : FRAME_LIMITATIONS)];
  }

  private cdpSummary(tabId: number, owners: Array<FrameOwnerGeometry | null>): FrameCdpSummary {
    let status: FrameCdpSummary = {
      available: false,
      attached: false,
      sessions: 0,
      cdpFrames: 0,
      graphAt: null,
      error: null,
      ownerProjections: 0,
      projectionsFailed: owners.length,
    };
    if (this.cdp) {
      try {
        const raw = this.cdp.status(tabId);
        status = {
          available: raw.available === true,
          attached: raw.attached === true,
          sessions: Number(raw.sessions ?? 0),
          cdpFrames: Number(raw.cdpFrames ?? 0),
          graphAt: raw.graphAt ?? null,
          error: raw.error ?? null,
          ownerProjections: owners.filter((owner) => owner !== null).length,
          projectionsFailed: owners.filter((owner) => owner === null).length,
        };
      } catch {
        // 诊断字段失败不影响观察结果
      }
    }
    return status;
  }

  private async readInventory(tabId: number, timeoutMs?: number): Promise<Array<{ absoluteSrc: string; hidden: boolean; hiddenReason: string | null }>> {
    try {
      const payload = await this.requestInFrame(tabId, 0, 'frame-inventory', {}, { timeoutMs: timeoutMs ?? 8_000 }) as {
        frames?: Array<{ absoluteSrc?: string; src?: string; hidden?: boolean; hiddenReason?: string | null }>;
      };
      return Array.isArray(payload?.frames)
        ? payload.frames.map((entry) => ({
          absoluteSrc: String(entry.absoluteSrc ?? entry.src ?? ''),
          hidden: entry.hidden === true,
          hiddenReason: entry.hiddenReason ?? null,
        }))
        : [];
    } catch {
      return [];
    }
  }

  /** 跨 frame 动作派发：别名 → 定向内容脚本请求；跨源/变换 owner 附 CDP 投影证据。 */
  async dispatchInFrame(
    tabId: number,
    alias: FrameAlias,
    op: ContentRequest['op'],
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const target = await this.requestInFrame(tabId, alias.frameId, op, {
      ...params,
      ref: alias.localRef,
      ...(alias.documentId ? { documentId: alias.documentId } : {}),
    }, options) as Record<string, unknown>;
    const result = isRecord(target) ? target : {};
    const projection = await this.projectActionPoint(tabId, alias.url, op, result, options.timeoutMs);
    const via = projection ? 'cdp-frame-owner' : 'frame-projected';
    const base: Record<string, unknown> = {
      ...result,
      via,
      frameId: alias.frameId,
      localRef: alias.localRef,
      ref: alias.ref,
      url: alias.url,
      trusted: false,
      synthetic: true,
    };
    if (projection) {
      return {
        ...base,
        projected: { x: projection.x, y: projection.y },
        oopif: projection.oopif,
        crossOrigin: projection.crossOrigin,
        transformed: projection.transformed,
        owner_chain: projection.owners.map((link) => ({
          url: link.url,
          oopif: link.oopif,
          crossOrigin: link.crossOrigin,
          transformed: link.transformed,
          perspective: link.perspective,
          rect: link.rect,
        })),
        note: '跨 frame 动作由该帧内容脚本合成派发；owner 链/坐标由 CDP DOM.getFrameOwner 投影（不是 CDP Input；trusted=false）',
      };
    }
    return {
      ...base,
      note: '跨 frame 动作由该帧内容脚本合成派发（未取得 CDP owner 投影；不是 CDP Input）',
    };
  }

  /**
   * 动作点 CDP 投影：只有“页面侧投影不可得”的场景才改标 cdp-frame-owner
   * （跨源 / 跨进程 OOPIF / owner 链带 transform/rotate/scale/perspective）。
   * 同源无变换的纯 rect 保持既有 frame-projected 语义（与 JS 兼容目标的
   * page-lib 快路径 → CDP 兜底分工一致）。
   */
  private async projectActionPoint(
    tabId: number,
    frameUrl: string,
    op: ContentRequest['op'],
    result: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<FrameOwnerProjection | null> {
    const cdp = this.cdp;
    if (!cdp || (op !== 'click' && op !== 'click-point')) return null;
    const x = Number(result['x']);
    const y = Number(result['y']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let projection: FrameOwnerProjection | null = null;
    const cdpBudget = budgetOf(timeoutMs, 5_000);
    try {
      projection = await cdp.projectFramePoint(tabId, {
        url: frameUrl,
        x,
        y,
        ...(cdpBudget ? { timeoutMs: cdpBudget } : {}),
      });
    } catch {
      projection = null;
    }
    if (!projection) return null;
    // 页面侧能投影的情形（同源、无变换）保持既有语义；跨源/跨进程/变换才走 CDP 标。
    if (!projection.oopif && !projection.crossOrigin && !projection.transformed) return null;
    return projection;
  }
}

/** 便捷工厂。 */
export function createFrameObservationService(options: FrameObservationServiceOptions): FrameObservationService {
  return new FrameObservationService(options);
}
