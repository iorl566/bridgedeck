// src/record/service.ts —— 操作录制服务层（record.start/stop/list/export/status）。
//
// 结构：
//   - RecordService 只做编排：会话表（内存）+ 事件接入 + 持久化 + 导出；
//   - 注入依赖（deps）负责真正碰 chrome.* 的部分（tabs.get / 注入页面录制器 / 浮层 /
//     截图 / 最终观察），因此单测可以完全离线（fake chrome）驱动；
//   - 事件来源见 sources.ts；step 模型见 steps.ts；Trace v3 见 trace.ts。
//
// MV3 限制（风险已在报告里写明）：
//   - service worker 会被回收：活跃会话只在内存，事件落库/导出依赖 store（session/local）；
//   - 页面录制器在导航/新文档后需要 background 的 webNavigation.onCommitted 钩子重新注入
//     （service.reattach）；
//   - 跨窗口/标签页切换由 background 的 tabs.onActivated / windows.onFocusChanged 钩子注入
//     （service.recordTabSwitch），页面录制器看不到“别的窗口”。

import {
  RECORD_MAX_EVENTS,
  type ActiveRecordingSummary,
  type Recording,
  type RecordingSummary,
  type RecordEvent,
  type RecordObservation,
  type RecordSessionState,
  type TraceV3,
} from './types.ts';
import { isAgentFiltered, kindCounts, mergeIntoPending, normalizeRecordEvent, type NormalizeContext, type RecordEventSender } from './sources.ts';
import { stepSignature } from './steps.ts';
import { summarizeRecording, RecordStore, type RecordStoreBackend } from './store.ts';
import { buildTraceV3, makeTraceScreenshot, serializeTrace, summarizeTrace, traceStateFiles, type TraceSummary } from './trace.ts';

/** 受限页面：浏览器内部页/扩展页不能注入录制器（与 JS 运行时 ops.js 同口径）。 */
const RESTRICTED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension):/i;

/** 结构化服务错误（background 路由/页面消息处理器统一转成信封）。 */
export class RecordServiceError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'RecordServiceError';
    this.code = code;
    this.data = data;
  }

  toPayload(): { code: string; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export interface RecordTabInfo {
  tabId: number;
  windowId: number | null;
  url: string;
  title: string;
}

export interface RecordOverlayPort {
  show(tabId: number, startedAt: number): Promise<boolean>;
  hide(tabId: number): Promise<boolean>;
}

export interface RecordCapturePort {
  /** 返回成功注入的 frame 数（0 = 没有可用注入通道）。 */
  start(tabId: number, options: { startedAt: number; includeAgent: boolean }): Promise<number>;
  /** 返回收到 deactivate 的 frame 数（0 = 页面已关/不可达）。 */
  stop(tabId: number): Promise<number>;
}

export interface RecordScreenshot {
  dataUrl: string;
  width?: number | null;
  height?: number | null;
}

export interface RecordServiceDeps {
  now?: () => number;
  newId?: () => string;
  store?: RecordStore;
  tabs?: { get(tabId: number): Promise<RecordTabInfo | null> } | null;
  overlay?: RecordOverlayPort | null;
  capture?: RecordCapturePort | null;
  /** 最终观察（stop 时补一次页面状态；失败/页面已关允许返回 null）。 */
  observe?: (tabId: number) => Promise<RecordObservation | null> | null;
  /** 导出时补拍一张页面截图（E2E 20d2 的 trace.screenshots）。 */
  captureScreenshot?: (tabId: number) => Promise<RecordScreenshot | null> | null;
  /** 最近一次可信 Agent 输入时间戳（TrustedInputClock.peek(tabId).last.at）。 */
  agentInputAt?: (tabId: number) => number;
  /** 页面消息来自扩展上下文之外的兜底目标标签页（CLI 没显式给 tabId 时用）。 */
  activeTab?: () => Promise<number | null>;
  log?: (message: string) => void;
}

export interface RecordStartParams {
  tabId?: unknown;
  includeAgent?: unknown;
  screenshots?: unknown;
}

export interface RecordStartResult {
  ok: true;
  tabId: number;
  startedAt: number;
  includeAgent: boolean;
  captureFrames: number;
  overlay: boolean;
  existing?: boolean;
}

export interface RecordStopResult {
  ok: true;
  recording: { id: string; events: number; url: string; startedAt: number; endedAt: number };
  recordingId: string;
  saved: boolean;
  backend: RecordStoreBackend;
  warning?: string;
}

export interface RecordListResult {
  ok: true;
  recordings: Array<Recording | RecordingSummary>;
  total: number;
  backend: RecordStoreBackend;
  includeEvents: boolean;
}

export interface RecordExportParams {
  id?: unknown;
  screenshot?: unknown;
  cli?: unknown;
  out?: unknown;
}

export interface RecordExportResult extends TraceSummary {
  ok: true;
  id: string;
  tracePathHint: string | null;
  stateFiles: Array<{ id: string; body: string }>;
  /** trace.json 内容（浏览器侧不写文件；CLI/下载器负责落盘）。 */
  traceJson: string;
  trace: TraceV3;
}

export interface RecordStatusResult {
  ok: true;
  active: ActiveRecordingSummary[];
  backend: RecordStoreBackend;
}

export interface RecordPushResult {
  recorded: boolean;
  merged?: boolean;
  filtered?: boolean;
  reason?: string;
  seq?: number;
}

export interface RecordReattachResult {
  ok: boolean;
  tabId: number;
  captureFrames: number;
  overlay: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** 最近一条 tab/window 切换步骤（去重与“切回”起点都靠它）。 */
function lastBoundaryEvent(events: RecordEvent[]): RecordEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item && (item.kind === 'tab-switch' || item.kind === 'window-switch')) return item;
  }
  return null;
}

/**
 * 最近一次“切走”的切换步骤：toTabId 不是录制 tab 的那一条。
 * 用户可能先切到别的 tab/window，再切回录制 tab；返回的 to* 就是回来时的 from。
 */
function lastBoundaryAway(events: RecordEvent[], sessionTabId: number): RecordEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (!item || (item.kind !== 'tab-switch' && item.kind !== 'window-switch')) continue;
    if (Number(item.toTabId) !== Number(sessionTabId)) return item;
  }
  return null;
}

function defaultId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') return cryptoLike.randomUUID();
  return 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * 录制服务。
 *
 * ```ts
 * const service = new RecordService({ store: new RecordStore(areas), tabs, capture, overlay });
 * const started = await service.start({ tabId: 12, includeAgent: true });
 * service.pushEvent(event, { tab: { id: 12 }, frameId: 0 });
 * const stopped = await service.stop({ tabId: 12 });
 * ```
 */
export class RecordService {
  private readonly deps: RecordServiceDeps;
  private readonly store: RecordStore;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sessions = new Map<number, RecordSessionState>();
  private readonly agentInputs = new Map<number, number>();
  private totalRecorded = 0;

  constructor(deps: RecordServiceDeps = {}) {
    this.deps = deps;
    this.store = deps.store ?? new RecordStore({}, {});
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? defaultId;
  }

  /** 当前活跃录制（record.status）。 */
  status(): RecordStatusResult {
    return {
      ok: true,
      active: [...this.sessions.values()].map((session) => ({
        tabId: session.tabId,
        url: session.url,
        title: session.title,
        startedAt: session.startedAt,
        events: session.events.length,
        includeAgent: session.includeAgent,
        screenshots: session.screenshots,
      })),
      backend: this.store.backendKind(),
    };
  }

  /** 某 tab 的活跃会话（诊断/单测）。 */
  sessionOf(tabId: number): RecordSessionState | null {
    return this.sessions.get(Number(tabId)) ?? null;
  }

  /** 已记录事件总数（诊断）。 */
  recordedTotal(): number {
    return this.totalRecorded;
  }

  /** 最近一次可信 Agent 输入时间（页面事件归因兜底）。 */
  noteAgentInput(tabId: number): void {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return;
    this.agentInputs.set(id, this.now());
  }

  private agentInputAt(tabId: number): number {
    const external = Number(this.deps.agentInputAt?.(Number(tabId)) ?? 0);
    const local = Number(this.agentInputs.get(Number(tabId)) ?? 0);
    return Math.max(Number.isFinite(external) ? external : 0, Number.isFinite(local) ? local : 0);
  }

  private async resolveTab(tabId: number): Promise<RecordTabInfo> {
    const fromDeps = await this.deps.tabs?.get(tabId) ?? null;
    if (fromDeps) return fromDeps;
    throw new RecordServiceError('E_NOT_FOUND', '标签页不存在或已关闭', { tabId });
  }

  /** 开始录制（record.start）。受限页面/活跃重复录制都给出结构化错误。 */
  async start(params: RecordStartParams = {}): Promise<RecordStartResult> {
    let tabId = toInteger(params.tabId);
    if (tabId === null && this.deps.activeTab) tabId = toInteger(await this.deps.activeTab());
    if (tabId === null) throw new RecordServiceError('E_BAD_ARG', 'record.start 需要正整数 tabId');
    const existing = this.sessions.get(tabId);
    if (existing) {
      return {
        ok: true,
        tabId,
        startedAt: existing.startedAt,
        includeAgent: existing.includeAgent,
        captureFrames: 0,
        overlay: false,
        existing: true,
      };
    }
    const tab = await this.resolveTab(tabId);
    if (RESTRICTED_URL.test(tab.url || '')) {
      throw new RecordServiceError('E_BAD_ARG', '受限页面不能录制（浏览器内部页/扩展页）', { tabId, url: tab.url });
    }
    const startedAt = this.now();
    const includeAgent = params.includeAgent === true;
    const screenshots = params.screenshots === true;
    const session: RecordSessionState = {
      tabId,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      startedAt,
      includeAgent,
      screenshots,
      events: [],
      nextSeq: 1,
      lastStepAt: 0,
      lastSignature: '',
      repeat: 0,
      shotted: 0,
    };
    this.sessions.set(tabId, session);
    let captureFrames = 0;
    try {
      captureFrames = await this.deps.capture?.start(tabId, { startedAt, includeAgent }) ?? 0;
    } catch (error) {
      this.deps.log?.('录制器注入失败 tab=' + tabId + '：' + (error instanceof Error ? error.message : String(error)));
    }
    let overlay = false;
    try {
      overlay = await this.deps.overlay?.show(tabId, startedAt) ?? false;
    } catch (error) {
      this.deps.log?.('录制浮层注入失败 tab=' + tabId + '：' + (error instanceof Error ? error.message : String(error)));
    }
    this.deps.log?.('操作录制开始 tab=' + tabId + ' includeAgent=' + includeAgent + ' frames=' + captureFrames);
    return { ok: true, tabId, startedAt, includeAgent, captureFrames, overlay };
  }

  /**
   * 停止录制（record.stop）：先停页面录制器（让队列 flush 落库），再补最终观察，
   * 最后落库。即使页面已关闭也尽量把已捕获事件保存下来。
   */
  async stop(params: { tabId?: unknown } = {}): Promise<RecordStopResult> {
    const tabId = toInteger(params.tabId);
    if (tabId === null) throw new RecordServiceError('E_BAD_ARG', 'record.stop 需要正整数 tabId');
    const session = this.sessions.get(tabId);
    if (!session) {
      throw new RecordServiceError('E_NOT_FOUND', '该标签页没有进行中的录制', { tabId, active: [...this.sessions.keys()] });
    }
    try {
      await this.deps.capture?.stop(tabId);
    } catch (error) {
      this.deps.log?.('停止录制器失败 tab=' + tabId + '：' + (error instanceof Error ? error.message : String(error)));
    }
    try {
      await this.deps.overlay?.hide(tabId);
    } catch (error) {
      this.deps.log?.('移除录制浮层失败 tab=' + tabId + '：' + (error instanceof Error ? error.message : String(error)));
    }
    let finalObservation: RecordObservation | null = null;
    try {
      finalObservation = await this.deps.observe?.(tabId) ?? null;
    } catch {
      finalObservation = null;
    }
    if (finalObservation && finalObservation.text && session.events.length) {
      const last = this.lastNonStateEvent(session.events);
      if (last && !last.observation) {
        last.observation = String(finalObservation.text).slice(0, 20_000);
        last.refs = Number(finalObservation.refs) || 0;
        last.stateAt = finalObservation.at ?? this.now();
        last.stateUrl = finalObservation.url || last.url || '';
      }
    }
    this.sessions.delete(tabId);
    const endedAt = this.now();
    const recording: Recording = {
      id: this.newId(),
      tabId,
      url: session.url,
      title: session.title,
      startedAt: session.startedAt,
      endedAt,
      events: session.events,
      includeAgent: session.includeAgent,
      screenshots: session.screenshots,
      ...(finalObservation ? { finalObservation } : {}),
      stoppedBy: 'cli_stop',
      cli: '0.3.0',
    };
    const saved = await this.store.save(recording);
    this.totalRecorded += 1;
    this.deps.log?.('操作录制结束 tab=' + tabId + ' events=' + recording.events.length + ' saved=' + saved.saved + ' backend=' + saved.backend);
    return {
      ok: true,
      recording: {
        id: recording.id,
        events: recording.events.length,
        url: recording.url,
        startedAt: recording.startedAt,
        endedAt,
      },
      recordingId: recording.id,
      saved: saved.saved,
      backend: saved.backend,
      ...(saved.warning ? { warning: saved.warning } : {}),
    };
  }

  /** 列出历史录制（默认带完整 events；includeEvents=false 只给摘要）。 */
  async list(params: { includeEvents?: unknown; limit?: unknown } = {}): Promise<RecordListResult> {
    const includeEvents = params.includeEvents !== false;
    const list = await this.store.load();
    const limit = toInteger(params.limit);
    const sliced = limit === null ? list : list.slice(0, limit);
    return {
      ok: true,
      recordings: includeEvents
        ? sliced
        : sliced.map((recording) => summarizeRecording(recording)),
      total: sliced.length,
      backend: this.store.backendKind(),
      includeEvents,
    };
  }

  /** 导出 Trace v3（record.export）。可选补拍一张页面截图（E2E 20d2 的 screenshots[0]）。 */
  async export(params: RecordExportParams = {}): Promise<RecordExportResult> {
    const list = await this.store.load();
    if (!list.length) throw new RecordServiceError('E_NOT_FOUND', '没有历史录制，无法导出');
    const wanted = typeof params.id === 'string' ? params.id : '';
    const recording = wanted
      ? list.find((item) => item.id === wanted || item.id.startsWith(wanted))
      : list[0];
    if (!recording) throw new RecordServiceError('E_NOT_FOUND', '找不到录制：' + wanted, { id: wanted });
    const trace = buildTraceV3(recording, { cli: typeof params.cli === 'string' ? params.cli : '0.3.0' });
    if (params.screenshot === true && this.deps.captureScreenshot && recording.tabId !== null) {
      try {
        const shot = await this.deps.captureScreenshot(recording.tabId);
        if (shot && typeof shot.dataUrl === 'string' && /^data:image\//.test(shot.dataUrl)) {
          trace.screenshots = [makeTraceScreenshot(shot)];
        }
      } catch (error) {
        // 截图是可选增强，失败不阻断 trace 导出
        this.deps.log?.('导出截图失败：' + (error instanceof Error ? error.message : String(error)));
      }
    }
    const summary = summarizeTrace(trace);
    const out = typeof params.out === 'string' && params.out ? params.out : null;
    return {
      ...summary,
      ok: true,
      id: recording.id,
      tracePathHint: out ? out.replace(/[\\/]+$/, '') + '/trace.json' : null,
      stateFiles: traceStateFiles(trace),
      traceJson: serializeTrace(trace),
      trace,
    };
  }

  /** 删除一条历史录制。 */
  async remove(id: string): Promise<{ ok: true; removed: number; backend: RecordStoreBackend }> {
    const removed = await this.store.remove(String(id ?? ''));
    return { ok: true, removed, backend: this.store.backendKind() };
  }

  /**
   * 页面事件接入（`bb.record.event` → background）。sender 必须来自内容脚本
   * （tab.id 可信）；非法形状/非活跃 tab/Agent 过滤都返回 recorded=false 而不是抛错。
   */
  pushEvent(raw: unknown, sender?: RecordEventSender | null): RecordPushResult {
    const tabId = Number(sender?.tab?.id);
    if (!Number.isInteger(tabId) || tabId <= 0) return { recorded: false, reason: 'no-tab' };
    const session = this.sessions.get(tabId);
    if (!session) return { recorded: false, reason: 'not-recording' };
    const context: NormalizeContext = {
      now: this.now(),
      nextSeq: session.nextSeq,
      frameId: Number.isInteger(sender?.frameId) ? Number(sender?.frameId) : 0,
      documentId: typeof sender?.documentId === 'string' && sender.documentId ? sender.documentId : null,
      url: typeof sender?.url === 'string' && sender.url
        ? sender.url
        : (typeof sender?.tab?.url === 'string' ? sender.tab.url : session.url),
      agentInputAt: this.agentInputAt(tabId),
    };
    const event = normalizeRecordEvent(raw, context);
    if (!event) return { recorded: false, reason: 'bad-event' };
    if (isAgentFiltered(event, session.includeAgent)) {
      return { recorded: false, filtered: true, reason: 'agent-filtered', seq: event.seq };
    }
    const outcome = mergeIntoPending(session.events, event);
    if (outcome === 'merged') {
      // 伴随事件（text/media/state）不占用新序号：序号推进由主体动作负责。
      return { recorded: true, merged: true, seq: event.seq };
    }
    if (session.events.length >= RECORD_MAX_EVENTS) return { recorded: false, reason: 'full', seq: event.seq };
    this.applyStepTiming(session, event);
    session.events.push(event);
    this.syncNextSeq(session, event.seq);
    return { recorded: true, merged: false, seq: event.seq };
  }

  /** Agent 动作记录入口（runtime 动作层可选直接调用；等价于一条 actor=agent 的事件）。 */
  recordAgentAction(tabId: number, kind: string, payload: Record<string, unknown> = {}): RecordPushResult {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return { recorded: false, reason: 'no-tab' };
    const raw = { actor: 'agent', kind, ts: this.now(), ...payload };
    return this.pushEvent(raw, { tab: { id }, frameId: Number.isInteger(payload.frameId) ? Number(payload.frameId) : 0 });
  }

  /**
   * 标签页/窗口切换 → 在当前录制里补 tab-switch / window-switch 边界步骤。
   *
   * background 在 tabs.onActivated / windows.onFocusChanged 时调用；返回注入的会话数。
   *
   * 三个边界口径（20d5）：
   *   - **去重**：同一次切换会被两条钩子各调一次（激活 + 窗口聚焦），与最近一条切换步骤
   *     相同（from/to tab+window 一致）就跳过，避免同一步骤录两遍；
   *   - **往返两程**：切走记一条，切回录制 tab 也记一条（`from` 用最近一次切走的目标），
   *     否则回放里只剩单程、看不到用户回来；
   *   - **跨窗口判定**：用「切换前所在 window」比对目标的 windowId；会话 window 缺失时
   *     先按 session.tab 回读一次，避免整条 window-switch 退化成 tab-switch。
   */
  async recordTabSwitch(tabId: number): Promise<number> {
    const targetId = toInteger(tabId);
    if (targetId === null || !this.sessions.size) return 0;
    let target: RecordTabInfo | null = null;
    try {
      target = await this.deps.tabs?.get(targetId) ?? null;
    } catch {
      target = null;
    }
    if (!target) return 0;
    let injected = 0;
    for (const session of this.sessions.values()) {
      const from = await this.switchOriginOf(session, targetId);
      if (!from) continue;
      const previous = lastBoundaryEvent(session.events);
      if (previous
        && Number(previous.fromTabId) === from.tabId
        && Number(previous.toTabId) === targetId
        && Number(previous.toWindowId) === Number(target.windowId)) {
        continue; // 同一次切换的另一条钩子：不重复记步
      }
      const crossWindow = Number.isInteger(from.windowId)
        && Number.isInteger(target.windowId)
        && from.windowId !== target.windowId;
      const event = normalizeRecordEvent({
        kind: crossWindow ? 'window-switch' : 'tab-switch',
        actor: 'human',
        ts: this.now(),
        url: target.url,
        title: target.title,
        fromTabId: from.tabId,
        toTabId: target.tabId,
        fromWindowId: from.windowId,
        toWindowId: target.windowId,
      }, {
        now: this.now(),
        nextSeq: session.nextSeq,
        frameId: 0,
        documentId: null,
        url: target.url,
      });
      if (!event) continue;
      this.applyStepTiming(session, event);
      session.events.push(event);
      this.syncNextSeq(session, event.seq);
      injected += 1;
    }
    return injected;
  }

  /**
   * 切换步骤的起点（from）。
   * - 目标是别的 tab/window：起点就是会话自己的 tab/window（缺失时回读一次）；
   * - 目标就是录制 tab（用户切回来）：起点用最近一次「切走」的目标；从没切走过则返回
   *   null（普通的“激活录制 tab”不插步骤，避免开录就多一条噪声边界）。
   */
  private async switchOriginOf(session: RecordSessionState, targetId: number): Promise<{ tabId: number; windowId: number | null } | null> {
    if (!Number.isInteger(session.windowId)) {
      try {
        const self = await this.deps.tabs?.get(session.tabId) ?? null;
        if (self && Number.isInteger(self.windowId)) session.windowId = self.windowId;
      } catch {
        // 回读失败按未知 window 处理：仍记步骤（退化成 tab-switch），只是不标跨窗口
      }
    }
    if (session.tabId !== targetId) return { tabId: session.tabId, windowId: session.windowId };
    const away = lastBoundaryAway(session.events, session.tabId);
    if (!away) return null;
    const awayTabId = Number(away.toTabId);
    const awayWindowId = Number(away.toWindowId);
    return {
      tabId: Number.isInteger(awayTabId) && awayTabId > 0 ? awayTabId : session.tabId,
      windowId: Number.isInteger(awayWindowId) ? awayWindowId : null,
    };
  }

  /**
   * 导航/新文档后恢复页面录制器（background 的 webNavigation.onCommitted 钩子调用）。
   * `overlay=true` 时同步重挂录制浮层（导航会把浮层一起销毁）。
   */
  async reattach(tabId: number, options: { overlay?: boolean } = {}): Promise<RecordReattachResult> {
    const id = toInteger(tabId);
    const session = id === null ? null : this.sessions.get(id);
    if (!session || id === null) return { ok: false, tabId: id ?? 0, captureFrames: 0, overlay: false };
    let captureFrames = 0;
    try {
      captureFrames = await this.deps.capture?.start(id, { startedAt: session.startedAt, includeAgent: session.includeAgent }) ?? 0;
    } catch {
      captureFrames = 0;
    }
    let overlay = false;
    if (options.overlay === true) {
      try {
        overlay = await this.deps.overlay?.show(id, session.startedAt) ?? false;
      } catch {
        overlay = false;
      }
    }
    this.deps.log?.('导航后恢复录制器 tab=' + id + ' frames=' + captureFrames);
    return { ok: captureFrames > 0, tabId: id, captureFrames, overlay };
  }

  /** 浮层“结束”按钮 → 停录（bb.record.finish；tab 来自 sender）。 */
  async finishFromOverlay(tabId: number): Promise<RecordStopResult> {
    return this.stop({ tabId });
  }

  /** 历史录制摘要列表（诊断；不读 storage 之外的数据）。 */
  async summaries(): Promise<RecordingSummary[]> {
    const list = await this.store.load();
    return list.map((recording) => summarizeRecording(recording));
  }

  /** 事件种类计数（诊断）。 */
  kindsOf(tabId: number): Record<string, number> {
    const session = this.sessions.get(Number(tabId));
    return session ? kindCounts(session.events) : {};
  }

  private syncNextSeq(session: RecordSessionState, seq: number): void {
    if (Number.isInteger(seq) && seq >= session.nextSeq) session.nextSeq = seq + 1;
    else session.nextSeq += 1;
  }

  private applyStepTiming(session: RecordSessionState, event: RecordEvent): void {
    const at = Number.isFinite(Number(event.ts)) ? Number(event.ts) : this.now();
    const gap = session.lastStepAt > 0 ? at - session.lastStepAt : 0;
    const step = event.recordStep;
    if (step && gap > 1200) {
      step.waitBeforeMs = Math.min(gap, 60_000);
    }
    if (step) {
      const signature = stepSignature(step);
      if (signature && signature === session.lastSignature) {
        session.repeat += 1;
        step.repeat = session.repeat + 1;
      } else {
        session.repeat = 0;
      }
      session.lastSignature = signature;
    }
    session.lastStepAt = at;
  }

  private lastNonStateEvent(events: RecordEvent[]): RecordEvent | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && event.kind !== 'state') return event;
    }
    return null;
  }
}

/** 判断消息是否来自内容脚本（有可信 tab.id）。 */
export function senderTabId(sender: unknown): number | null {
  if (!isRecord(sender)) return null;
  const tab = isRecord(sender.tab) ? sender.tab : null;
  return toInteger(tab?.id);
}
