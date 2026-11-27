// src/video/service.ts —— video.* 服务层：录制状态机 + 离屏采集编排 + 分片日记 + 存储/恢复。
//
// 方法面（与 cli/commands/video.mjs 的 RPC 对齐）：
// - video.start / video.stop / video.status
// - video.fetch（CLI 的 video.save 走 fetch → 本机写文件） / video.save（同义别名）
// - video.list / video.prune / video.discard / video.recover / video.verify
//
// 采集路径（离屏文档实现见 offscreen.ts）：
// 1) 常态：chrome.tabCapture.getMediaStreamId → 离屏 getUserMedia → WebCodecs(mediabunny) 编码 MP4；
//    编码器不可用时离屏回退 MediaRecorder(MP4/WebM) + 能重封装才声明 faststart；
// 2) --force-frames：chrome.debugger 的 Page.startScreencast 逐帧 → 离屏 canvas → 编码器；
//    debugger 不可用/attach 失败则回退 1) 的 tabCapture 编码路径（仍然 finish_via='encoder'）。
//
// 所有外部能力（tabs/离屏端口/store/存储探测/cdp/tabCapture）都注入，Node 单测用 fake。

import { sha256Hex, sha256OfBlob, isSha256Hex, base64FromBytes, newRecordingId, toArrayBuffer } from './hash.ts';
import { buildManifest } from './manifest.ts';
import { analyzeContainer, fragmentJournal, journalSummary } from './mp4.ts';
import { createVideoStateMachine, type StateMachineResult, type VideoStateMachine } from './state.ts';
import { storeError, toPublicRecord, type StoredChunk, type VideoStore } from './store.ts';
import type { VideoStorage, OffscreenPort } from './runtime.ts';
import { OFFSCREEN_MESSAGES, decodeOffscreenResultBytes, type OffscreenRecordingResult, type OffscreenStartReply } from './offscreen-protocol.ts';
import { verifyRecording } from './verify.ts';
import type {
  ActiveRecording,
  CodedError,
  FragmentEntry,
  JournalSummary,
  PublicVideoRecord,
  RecordingPhase,
  StorageBackend,
  StorageState,
  VideoRecord,
  VideoStartParams,
  VideoTabInfo,
} from './types.ts';
import { VIDEO_CODES, VIDEO_LIMITS, videoError } from './types.ts';

export const VIDEO_ACTIVE_KEY = 'bb.video.active';
export const VIDEO_STATE_KEY = 'bb.video.state';

/** CDP 适配（只用到 send / onEvent / acquire / release；由 background 的 CdpClient 注入）。 */
export interface VideoCdp {
  send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(tabId: number, method: string, handler: (params: Record<string, unknown>) => void): () => void;
  acquire?(tabId: number, feature: string): Promise<void>;
  release?(tabId: number, feature: string): void;
}

/** chrome.tabCapture 最小面（模块级不引用全局；background 注入）。 */
export interface TabCaptureApi {
  getMediaStreamId(options: { targetTabId: number }): Promise<string>;
}

export interface VideoTabsApi {
  get(tabId: number): Promise<VideoTabInfo>;
}

export interface VideoServiceDeps {
  tabs: VideoTabsApi;
  port: OffscreenPort;
  store: VideoStore;
  storage: VideoStorage;
  /** 存储能力探测（默认 navigator.storage；单测注入固定值）。 */
  probeStorage?: (backend: StorageBackend) => Promise<StorageState>;
  tabCapture?: TabCaptureApi;
  cdp?: VideoCdp;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  log?: (message: string) => void;
  limits?: { maxDurationMs?: number; maxBytes?: number; defaultTtlMs?: number };
}

interface ActiveRuntime extends Omit<ActiveRecording, 'machineState'> {
  machine: VideoStateMachine;
  screencast: { tabId: number; unsubscribe: () => void } | null;
}

type Liveness = 'live' | 'dead' | 'unknown';

const RESTRICTED_PAGE = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i;

/** 失去采集端/到时期满的判定宽限：给离屏自动收尾与结果回传留时间，但不允许永久占位。 */
const STALE_GRACE_MS = 5000;
const RECORDER_AGE_GRACE_MS = 60_000;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return String((error as { message: string }).message);
  return String(error);
}

function clampDuration(requested: unknown, maxDurationMs: number): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), maxDurationMs);
}

function sortNewestFirst(records: VideoRecord[]): VideoRecord[] {
  return records.slice().sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
}

export class VideoService {
  private readonly deps: VideoServiceDeps;
  private readonly maxDurationMs: number;
  private readonly maxBytes: number;
  private readonly defaultTtlMs: number;
  private active: ActiveRuntime | null = null;
  private detachPort: (() => void) | null = null;
  private lastError: string | null = null;
  private screencast: ActiveRuntime['screencast'] = null;
  /** duration 到期的 SW 侧兜底定时器（不依赖离屏定时器，headless 下也不会永久占位）。 */
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: VideoServiceDeps) {
    this.deps = deps;
    this.maxDurationMs = Number(deps.limits?.maxDurationMs) > 0 ? Number(deps.limits?.maxDurationMs) : VIDEO_LIMITS.maxDurationMs;
    this.maxBytes = Number(deps.limits?.maxBytes) > 0 ? Number(deps.limits?.maxBytes) : VIDEO_LIMITS.maxBytes;
    this.defaultTtlMs = Number.isFinite(Number(deps.limits?.defaultTtlMs)) ? Number(deps.limits?.defaultTtlMs) : VIDEO_LIMITS.defaultTtlMs;
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, ms)); });
  }
  private newId(): string { return this.deps.newId ? this.deps.newId() : newRecordingId(); }
  private log(message: string): void { this.deps.log?.(message); }

  /** 注册离屏 → SW 消息（bb.rec.done / bb.rec.error）。background 初始化时同步调用一次。 */
  attach(): () => void {
    this.detachPort?.();
    this.detachPort = this.deps.port.onMessage((message) => { this.handleMessage(message); });
    return () => { this.detachPort?.(); this.detachPort = null; };
  }

  /** 现有 listener 也可以直接转发消息；返回 true 表示已消费。 */
  handleMessage(raw: unknown): boolean {
    const bag = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (!bag || bag.from !== 'offscreen') return false;
    if (bag.type === OFFSCREEN_MESSAGES.DONE) {
      void this.onOffscreenDone(bag.result);
      return true;
    }
    if (bag.type === OFFSCREEN_MESSAGES.ERROR) {
      void this.onOffscreenError(String(bag.error ?? bag.message ?? '离屏录制失败'));
      return true;
    }
    return false;
  }

  private async onOffscreenDone(payload: unknown): Promise<void> {
    let record: VideoRecord;
    try {
      record = await this.settleResult(payload);
    } catch (error) {
      // 结果无法落库时也必须清掉活动态，否则后续 start 会被「已有录制进行中」永久挡住。
      this.lastError = messageOf(error);
      this.log('离屏结果落库失败，清理活动录制：' + this.lastError);
      await this.failActive('offscreen_result_invalid', this.lastError);
      return;
    }
    try {
      if (!this.active || this.active.id === record.id) {
        if (this.active?.machine) this.active.machine.send('seal', { reason: record.stop_reason, bytes: record.bytes });
        await this.finishActive(record.id);
      } else {
        // 结果属于更早的一条录制：只落库，不动当前活动录制；离屏文档留给当前录制使用。
        this.log('离屏结果属于旧录制 id=' + record.id + '，保留当前活动录制');
      }
      this.log('录制完成 id=' + record.id + ' bytes=' + record.bytes + ' mime=' + record.mime);
    } catch (error) {
      this.lastError = messageOf(error);
      this.log('录制收尾失败：' + this.lastError);
      await this.failActive('offscreen_finalize_failed', this.lastError);
    }
  }

  private async onOffscreenError(message: string): Promise<void> {
    await this.failActive('offscreen_error', message);
  }

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  async start(params: VideoStartParams = {}): Promise<Record<string, unknown>> {
    // 先处理可能残留的活动录制：活着的拒绝并发；已失去采集端/到时未收尾的清理后接管，
    // 保证「失败/超时的旧录制」不会永久阻塞新的 start（E2E 20c2/20g/35 的僵尸问题）。
    const restoredActive = await this.restoreActive();
    if (restoredActive) {
      const liveness = await this.probeLiveness();
      if (liveness === 'live') {
        throw videoError(VIDEO_CODES.BUSY, '已有录制进行中（' + restoredActive.id + '）', { recordingId: restoredActive.id });
      }
      const settled = await this.settleActive();
      if (!settled && this.active) {
        if (this.isStaleActive(this.active, liveness)) {
          await this.failActive('interrupted', '旧录制已失去采集端或已超时，清理后再启动');
        } else {
          throw videoError(VIDEO_CODES.BUSY, '已有录制进行中（' + this.active.id + '）', { recordingId: this.active.id, liveness });
        }
      }
    }
    const tabId = this.requireTabId(params);
    let tab: VideoTabInfo;
    try {
      tab = await this.deps.tabs.get(tabId);
    } catch (error) {
      throw videoError(VIDEO_CODES.BAD_ARG, '标签页不存在或已关闭：' + tabId + '（' + messageOf(error) + '）');
    }
    const url = String(tab.url ?? '');
    if (RESTRICTED_PAGE.test(url)) {
      throw videoError(VIDEO_CODES.RESTRICTED_PAGE, '受限页面不能录制：' + url, { tabId, url });
    }
    const durationMs = clampDuration(params.durationMs, this.maxDurationMs);
    const quality = params.quality === 'high' ? 'high' : 'normal';
    const bitrate = quality === 'high' ? 8_000_000 : 4_000_000;
    const recordingId = this.newId();
    const forceFrames = params.forceFrames === true;
    const errors: string[] = [];
    const cdp = this.deps.cdp;

    await this.deps.port.ensure();
    let started: OffscreenStartReply | null = null;
    let mode = '';

    /**
     * 每次采集尝试：成功返回 reply+mode；抛错或离屏回 ok:false 都归一为错误证据，
     * 并复位离屏（ABORT）+ 停掉 CDP 截帧，避免半启动状态挡住下一条路径。
     */
    const attempt = async (
      label: string,
      run: () => Promise<OffscreenStartReply>,
      modeName: string,
    ): Promise<{ reply: Extract<OffscreenStartReply, { ok: true }>; mode: string } | null> => {
      try {
        const reply = await run();
        if (reply && reply.ok === true) return { reply, mode: modeName };
        errors.push(label + '：' + (reply && reply.ok === false ? reply.error : '离屏没有返回成功'));
      } catch (error) {
        errors.push(label + '：' + messageOf(error));
      }
      await this.deps.port.post({ type: OFFSCREEN_MESSAGES.ABORT }, { retries: 1, intervalMs: 0 }).catch(() => {});
      await this.stopScreencast();
      return null;
    };

    if (forceFrames && cdp) {
      const outcome = await attempt('逐帧录制', () => this.startFrames(recordingId, tab, tabId, durationMs, bitrate), 'debugger');
      if (outcome) { started = outcome.reply; mode = outcome.mode; }
    }
    if (!started) {
      const outcome = await attempt('tabCapture 录制', () => this.startStream(recordingId, tab, tabId, durationMs, bitrate), 'tabCapture');
      if (outcome) { started = outcome.reply; mode = outcome.mode; }
    }
    if (!started && cdp) {
      // tabCapture 无手势拒绝 / 离屏编码不可用时的真实兜底：CDP 截帧 → 离屏编码器。
      const outcome = await attempt('调试器截帧兜底', () => this.startFrames(recordingId, tab, tabId, durationMs, bitrate), 'debugger');
      if (outcome) { started = outcome.reply; mode = outcome.mode; }
    }
    if (!started) {
      throw videoError(VIDEO_CODES.CAPTURE, '录制启动失败：' + errors.join(' | '), { tabId, errors, forceFrames, hasCdp: Boolean(cdp) });
    }
    const accepted = started;

    const startedAt = Number(accepted.startedAt) > 0 ? Number(accepted.startedAt) : this.now();
    const deadline = durationMs > 0 ? startedAt + durationMs : 0;
    const machine = createVideoStateMachine({ id: recordingId, now: () => this.now() });
    machine.send('start', { reason: mode, bytes: 0 });
    this.active = {
      id: recordingId,
      tabId,
      url,
      title: String(tab.title ?? ''),
      startedAt,
      mime: accepted.mime,
      mode,
      durationMs,
      deadline,
      machine,
      screencast: this.screencast,
    };
    await this.persistActive();
    this.armDeadline();
    this.log('视频录制开始 id=' + recordingId + ' tab=' + tabId + ' mime=' + accepted.mime + ' mode=' + mode + (durationMs ? ' durationMs=' + durationMs : ''));
    return {
      ok: true,
      recordingId,
      tabId,
      mime: accepted.mime,
      startedAt,
      mode,
      encoder: accepted.encoder ?? null,
      durationMs,
      deadlineMs: deadline,
      recording_state: machine.state,
    };
  }

  private async startStream(
    recordingId: string,
    tab: VideoTabInfo,
    tabId: number,
    durationMs: number,
    bitrate: number,
  ): Promise<OffscreenStartReply> {
    if (!this.deps.tabCapture) {
      throw videoError(VIDEO_CODES.UNSUPPORTED, '当前运行时没有注入 chrome.tabCapture，无法走 tabCapture 采集', { tabId });
    }
    const streamId = await this.deps.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (!streamId) throw videoError(VIDEO_CODES.CAPTURE, 'tabCapture 没有返回 streamId', { tabId });
    const reply = await this.deps.port.post<OffscreenStartReply>({
      type: OFFSCREEN_MESSAGES.START,
      streamId,
      recordingId,
      tabId,
      url: String(tab.url ?? ''),
      title: String(tab.title ?? ''),
      bitrate,
      durationMs,
      encoder: 'avc',
    }, { retries: 10, intervalMs: 150 });
    if (!reply) throw videoError(VIDEO_CODES.CAPTURE, '离屏文档没有响应录制启动', { tabId });
    return reply;
  }

  private async startFrames(
    recordingId: string,
    tab: VideoTabInfo,
    tabId: number,
    durationMs: number,
    bitrate: number,
  ): Promise<OffscreenStartReply> {
    const cdp = this.deps.cdp;
    if (!cdp) throw videoError(VIDEO_CODES.UNSUPPORTED, '当前运行时没有注入 chrome.debugger/CDP 适配', { tabId });
    await cdp.acquire?.(tabId, 'record');
    let unsubscribe: (() => void) | null = null;
    try {
      await cdp.send(tabId, 'Page.enable', {});
      const reply = await this.deps.port.post<OffscreenStartReply>({
        type: OFFSCREEN_MESSAGES.START_FRAMES,
        recordingId,
        tabId,
        url: String(tab.url ?? ''),
        title: String(tab.title ?? ''),
        durationMs,
        bitrate,
        fps: 10,
        width: 1280,
        height: 800,
        encoder: 'avc',
      }, { retries: 10, intervalMs: 150 });
      if (!reply || reply.ok !== true) {
        throw videoError(VIDEO_CODES.CAPTURE, reply && reply.ok === false ? reply.error : '逐帧录制未启动');
      }
      unsubscribe = cdp.onEvent(tabId, 'Page.screencastFrame', (frame) => {
        const data = typeof frame.data === 'string' ? frame.data : '';
        if (!data) return;
        void this.deps.port.post({
          type: OFFSCREEN_MESSAGES.FRAME,
          data: 'data:image/jpeg;base64,' + data,
        }, { retries: 1, intervalMs: 0 }).catch(() => {});
        void cdp.send(tabId, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      });
      await cdp.send(tabId, 'Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 1,
      });
      this.screencast = { tabId, unsubscribe };
      return reply;
    } catch (error) {
      try { unsubscribe?.(); } catch { /* 忽略 */ }
      await cdp.send(tabId, 'Page.stopScreencast', {}).catch(() => {});
      cdp.release?.(tabId, 'record');
      this.screencast = null;
      // 离屏可能已经开了 canvas/编码器：显式撤销，避免残留录制。
      await this.deps.port.post({ type: OFFSCREEN_MESSAGES.ABORT }, { retries: 2, intervalMs: 50 }).catch(() => {});
      throw error;
    }
  }

  async stop(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.restoreActive();
    if (!this.active) {
      throw videoError(VIDEO_CODES.IDLE, '当前没有录制', { lastError: this.lastError });
    }
    const current = this.active;
    const wanted = params.recording === undefined || params.recording === null ? '' : String(params.recording);
    if (wanted && wanted !== current.id) {
      throw videoError(VIDEO_CODES.NOT_FOUND, 'recording 不存在：' + wanted, { recordingId: wanted });
    }
    this.clearDeadlineTimer();
    current.machine.send('stop', { reason: String(params.reason ?? 'user') });
    await this.persistActive();
    try {
      const reply = await this.deps.port.post<{ ok?: boolean; result?: unknown; error?: string }>(
        { type: OFFSCREEN_MESSAGES.STOP },
        { retries: 6, intervalMs: 200 },
      );
      let record: VideoRecord | null = null;
      if (reply && reply.ok === true && reply.result) {
        try {
          record = await this.settleResult(reply.result);
        } catch (error) {
          // 回包存在但不可用（缺字节/落库失败）：保留原因，继续用 LAST/store 兜底。
          this.lastError = messageOf(error);
          this.log('STOP 回包不可用：' + this.lastError);
        }
      } else if (reply && reply.ok === false && reply.error) {
        this.lastError = '离屏停止失败：' + reply.error;
      }
      // STOP 回包丢失/被并发的离屏定时器抢走时，用 LAST + store 多探几次（不急着判超时）。
      for (let attempt = 0; attempt < 3 && !record; attempt += 1) {
        if (attempt > 0) await this.sleep(150);
        record = await this.settleFromLast();
        if (!record) record = await this.deps.store.getRecord(current.id).catch(() => null);
      }
      if (!record) record = await this.deps.store.getRecord(current.id).catch(() => null);
      if (record && record.id !== current.id) record = null;
      await this.stopScreencast();
      if (!record) {
        await this.failActive('stop_timeout', '等待录制文件超时');
        throw videoError(VIDEO_CODES.STOP_TIMEOUT, '等待录制文件超时', { recordingId: current.id });
      }
      const sealed = current.machine.send(record.completeness === 'partial' ? 'recover' : 'seal', {
        reason: record.stop_reason,
        bytes: record.bytes,
      });
      // 只清理「本 recording」的活动态：若离屏 DONE 已经并发收尾（active=null）则不再重复关文档，
      // 避免误关可能刚被新录制重新创建的离屏文档。
      if (this.active?.id === current.id) await this.finishActive(current.id);
      return {
        ok: true,
        recordingId: record.id,
        bytes: record.bytes,
        mime: record.mime,
        durationMs: current.machine.elapsedMs(),
        state: 'ready',
        completeness: record.completeness,
        stop_reason: record.stop_reason,
        chunk_count: record.chunk_count,
        fragments: record.fragments,
        finish_via: record.finish_via,
        complete_frames: record.complete_frames,
        faststart: record.faststart,
        journal: record.journal,
        ...(record.faststart ? { faststart_bytes: record.bytes } : {}),
        ...(sealed.ok === false ? { state_rejection: sealed.evidence } : {}),
        ...current.machine.toRecordFields(),
      };
    } catch (error) {
      // 任何异常路径都要清掉活动态：否则下一条 start 永久被「已有录制进行中」挡住。
      if (this.active?.id === current.id) {
        await this.failActive('stop_failed', messageOf(error));
      }
      throw error;
    }
  }

  /** 读离屏 last 结果并落库；解码/落库失败返回 null 并把原因记进 lastError（不抛给调用方）。 */
  private async settleFromLast(): Promise<VideoRecord | null> {
    let last: { ok?: boolean; result?: unknown } | null = null;
    try {
      last = await this.deps.port.post<{ ok?: boolean; result?: unknown }>(
        { type: OFFSCREEN_MESSAGES.LAST },
        { retries: 4, intervalMs: 150 },
      );
    } catch (error) {
      this.lastError = messageOf(error);
      return null;
    }
    if (!last || last.ok !== true || !last.result) return null;
    try {
      return await this.settleResult(last.result);
    } catch (error) {
      this.lastError = messageOf(error);
      this.log('离屏结果落库失败：' + this.lastError);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // status / list / prune / discard
  // -------------------------------------------------------------------------

  async status(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.pruneExpired().catch(() => 0);
    await this.restoreActive();
    if (this.active) {
      const current = this.active;
      if (current.deadline > 0 && this.now() > current.deadline + 1500) {
        // 到时未自动收尾：SW 主动 stop（stop 内部保证异常也清活动态）。
        await this.stop({ recording: current.id, reason: 'duration' }).catch(() => {});
      } else {
        const live = await this.deps.port.post<{ active?: boolean; state?: string }>({ type: OFFSCREEN_MESSAGES.STATUS }, { retries: 1, intervalMs: 0 }).catch(() => null);
        if (live && live.active === true) {
          return {
            ok: true,
            active: true,
            state: 'recording',
            recordingId: current.id,
            tabId: current.tabId,
            startedAt: current.startedAt,
            deadlineMs: current.deadline,
            mime: current.mime,
            mode: current.mode,
            url: current.url,
            title: current.title,
            durationMs: current.machine.elapsedMs(),
            recording_state: current.machine.state,
          };
        }
        const settled = await this.settleActive();
        if (settled) return { ok: true, active: false, state: 'ready', ...toPublicRecord(settled) };
        if (!this.active) {
          // settleActive 已按失败清理（离屏结果缺失/中断）：继续走 store 取证，不抛 E_INTERNAL。
        } else {
          return {
            ok: true,
            active: true,
            state: 'finalizing',
            recordingId: current.id,
            tabId: current.tabId,
            startedAt: current.startedAt,
            mime: current.mime,
            mode: current.mode,
            url: current.url,
            title: current.title,
            recording_state: current.machine.state,
          };
        }
      }
    }
    const id = params.recording === undefined || params.recording === null ? '' : String(params.recording);
    const records = sortNewestFirst(await this.deps.store.listRecords());
    const record = id ? records.find((item) => item.id === id) ?? null : records[0] ?? null;
    if (!record) {
      return { ok: true, active: false, state: 'none', ...(this.lastError ? { last_error: this.lastError } : {}) };
    }
    return { ok: true, active: false, state: 'ready', ...toPublicRecord(record) };
  }

  /**
   * video.list：只读 store 为主。活动录制只做「尽力收尾」——离屏缺失/结果缺失时
   * 也不能让整个 list 报错（E2E 35r 在失败过的 store 状态下仍要能列出恢复记录）。
   */
  async list(): Promise<Record<string, unknown>> {
    await this.pruneExpired().catch(() => 0);
    await this.restoreActive().catch(() => null);
    if (this.active) await this.settleActive().catch(() => null);
    let records: VideoRecord[];
    try {
      records = await this.deps.store.listRecords();
    } catch (error) {
      throw storeError(error, '读取录制列表');
    }
    return { ok: true, recordings: sortNewestFirst(records).map((record) => toPublicRecord(record)) };
  }

  async prune(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const raw = params.ttlMs;
    const ttl = Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : this.defaultTtlMs;
    const removed = await this.pruneExpired(ttl);
    const remaining = (await this.deps.store.listRecords()).length;
    if (removed > 0) this.log('已清理过期录制 ' + removed + ' 条');
    return { ok: true, removed, remaining, ttlMs: ttl };
  }

  async discard(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = params.recording === undefined || params.recording === null ? '' : String(params.recording);
    if (!id) throw videoError(VIDEO_CODES.BAD_ARG, 'video.discard 需要 recordingId');
    const wasActive = this.active?.id === id;
    await this.deps.store.deleteRecord(id);
    await this.deps.store.clearChunks(id).catch(() => {});
    if (wasActive) {
      // 丢弃活动录制：先让离屏停止采集，再清活动态，避免离屏文档继续录。
      await this.deps.port.post({ type: OFFSCREEN_MESSAGES.ABORT }, { retries: 1, intervalMs: 0 }).catch(() => {});
      await this.finishActive();
    }
    return { ok: true, recordingId: id, recording: id };
  }

  // -------------------------------------------------------------------------
  // fetch（save）/ verify / recover
  // -------------------------------------------------------------------------

  async fetch(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.pruneExpired();
    await this.restoreActive();
    if (this.active) await this.settleActive();
    const id = String(params.recording ?? '');
    const records = sortNewestFirst(await this.deps.store.listRecords());
    const record = id ? await this.deps.store.getRecord(id) : records[0] ?? null;
    if (!record) throw videoError(VIDEO_CODES.NOT_FOUND, '找不到录制：' + (id || ''), { recordingId: id || null });
    if (Number(record.bytes) > this.maxBytes) {
      throw videoError(VIDEO_CODES.TOO_LARGE, '录制过大（' + record.bytes + ' 字节），上限 ' + this.maxBytes, { recordingId: record.id, bytes: record.bytes, maxBytes: this.maxBytes });
    }
    const data = new Uint8Array(await record.blob.arrayBuffer());
    return {
      ok: true,
      recordingId: record.id,
      mime: record.mime,
      bytes: data.length,
      base64: base64FromBytes(data),
      completeness: record.completeness,
      stop_reason: record.stop_reason,
      chunk_count: record.chunk_count,
      fragments: record.fragments,
      finish_via: record.finish_via,
      complete_frames: record.complete_frames,
      faststart: record.faststart,
      journal: record.journal,
      ...(record.indexed === true ? { indexed: true, sidx_bytes: record.sidx_bytes ?? 0 } : {}),
      ...(record.raw_bytes !== undefined ? { raw_bytes: record.raw_bytes } : {}),
      ...(record.trimmed_bytes !== undefined ? { trimmed_bytes: record.trimmed_bytes } : {}),
      ...(record.sealed === true && record.seal ? { seal: record.seal } : {}),
      recording_state: record.recording_state,
    };
  }

  /** video.save 别名：CLI 侧保存文件，扩展侧只负责取字节（语义与 fetch 完全一致）。 */
  async save(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.fetch(params);
  }

  async verify(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = String(params.recording ?? '');
    const record = id ? await this.deps.store.getRecord(id) : null;
    if (!record) throw videoError(VIDEO_CODES.NOT_FOUND, '找不到录制：' + id, { recordingId: id });
    const report = await verifyRecording(record, {
      maxAnalyzeBytes: Number(params.maxAnalyzeBytes) > 0 ? Number(params.maxAnalyzeBytes) : undefined,
      requireComplete: params.requireComplete !== false,
    });
    return {
      ok: report.ok,
      recordingId: record.id,
      chunks: report.chunks,
      verified: report.verified,
      bytes: report.bytes,
      container: report.container,
      mismatches: report.mismatches,
      hash: report.hash,
      journal: report.journal,
      journal_integrity: report.journal_integrity,
      seek: report.seek,
      problems: report.problems,
      recording_state: record.recording_state,
      ...(record.completeness ? { completeness: record.completeness, stop_reason: record.stop_reason, chunk_count: record.chunk_count } : {}),
      ...(record.faststart ? { faststart: true } : {}),
    };
  }

  /**
   * video.recover：扫描分片库 → 按 index 拼回可播放文件 → 落库为 partial/recovered。
   * 不依赖离屏文档（SW 内完成），保证 E2E 的 seed 分片在页面关闭后仍可恢复。
   */
  async recover(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const chunks = await this.deps.store.listChunks();
    const groups = new Map<string, StoredChunk[]>();
    for (const chunk of chunks) {
      const id = String(chunk?.recordingId ?? '');
      if (!id || !chunk.blob || !(chunk.blob.size > 0)) continue;
      const list = groups.get(id) ?? [];
      list.push(chunk);
      groups.set(id, list);
    }
    if (groups.size === 0) {
      throw videoError(VIDEO_CODES.NO_FRAGMENTS, '没有可恢复的录制分片', { scanned: chunks.length });
    }
    let chosenId = '';
    let chosenAt = -1;
    for (const [id, list] of groups) {
      const meta = list[0]?.meta ?? {};
      const at = Number(meta.startedAt) || Number(list[0]?.at) || 0;
      if (at > chosenAt) { chosenAt = at; chosenId = id; }
    }
    const list = (groups.get(chosenId) ?? []).slice().sort((a, b) => Number(a.index) - Number(b.index));
    const meta = list[0]?.meta ?? {};
    const parts = list.map((item) => item.blob);
    const data = new Uint8Array(await new Blob(parts, { type: 'video/mp4' }).arrayBuffer());
    if (data.length === 0) throw videoError(VIDEO_CODES.NO_FRAGMENTS, '恢复分片为空', { recordingId: chosenId });
    const fragments: FragmentEntry[] = [];
    for (const chunk of list) {
      fragments.push({
        index: Number(chunk.index) || 0,
        at: Number(chunk.at) || Number(meta.startedAt) || this.now(),
        bytes: chunk.blob.size,
        sha256: await sha256OfBlob(chunk.blob),
      });
    }
    const container = analyzeContainer(data, String(meta.mime ?? ''));
    const journal = container.format === 'mp4' ? fragmentJournal(data) : null;
    const mime = typeof meta.mime === 'string' && meta.mime
      ? meta.mime
      : (container.format === 'mp4' ? 'video/mp4' : 'video/webm');
    const storage = await this.probe();
    const record: VideoRecord = {
      id: chosenId,
      tabId: Number.isInteger(Number(meta.tabId)) ? Number(meta.tabId) : null,
      url: String(meta.url ?? ''),
      title: String(meta.title ?? ''),
      startedAt: Number(meta.startedAt) || this.now(),
      endedAt: this.now(),
      mime,
      bytes: data.length,
      completeness: 'partial',
      stop_reason: 'recovered',
      chunk_count: fragments.length,
      fragments,
      finish_via: 'main',
      complete_frames: journal ? journal.completeFrames : false,
      faststart: container.faststart === true,
      journal: journalSummary(journal),
      durability: fragments.length > 0 && fragments.every((item) => isSha256Hex(item.sha256)) ? 'verified' : 'unverified',
      durability_parts: fragments.length,
      durability_policy: 'browser-readback',
      fsync_supported: false,
      storage_persisted: storage.persisted,
      storage_quota: storage.quota,
      storage_backend: this.deps.store.backend,
      recording_state: 'recovered',
      recovered: true,
      mode: 'recover',
      blob: new Blob([toArrayBuffer(data)], { type: mime }),
    };
    record.manifest = buildManifest({
      recordingId: record.id,
      mime: record.mime,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      bytes: record.bytes,
      completeness: record.completeness,
      stopReason: record.stop_reason,
      finishVia: record.finish_via,
      faststart: record.faststart,
      fragments: record.fragments,
      completeBytes: journal ? journal.completeBytes : record.bytes,
      storageBackend: this.deps.store.backend,
    }) as unknown as Record<string, unknown>;
    try {
      await this.deps.store.putRecord(record);
    } catch (error) {
      throw storeError(error, '写入恢复记录');
    }
    await this.deps.store.clearChunks(chosenId).catch(() => {});
    this.log('已恢复录制 id=' + record.id + ' bytes=' + record.bytes + ' fragments=' + fragments.length);
    return {
      ok: true,
      ...toPublicRecord(record),
      recordingId: record.id,
      id: record.id,
      recovery_scan: {
        candidates: groups.size,
        chunks: chunks.length,
        chosen: chosenId,
      },
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 内部：结果落库 / 活动态恢复 / 清扫
  // -------------------------------------------------------------------------

  private async settleResult(raw: unknown): Promise<VideoRecord> {
    const bag = raw && typeof raw === 'object' ? raw as Partial<OffscreenRecordingResult> & Record<string, unknown> : null;
    if (!bag || typeof bag.id !== 'string' || !bag.id) {
      throw videoError(VIDEO_CODES.CAPTURE, '离屏结果缺少 recordingId', {
        shape: bag ? Object.keys(bag).slice(0, 24) : typeof raw,
      });
    }
    // 字节经 messaging 只会是 JSON：优先 data_base64，同时兼容同上下文 Uint8Array/ArrayBuffer。
    const decoded = decodeOffscreenResultBytes(raw);
    if (!decoded.bytes) {
      throw videoError(VIDEO_CODES.CAPTURE, '离屏结果缺少视频字节：' + String(decoded.reason ?? '未知原因'), {
        recordingId: bag.id,
        decode_reason: decoded.reason,
        transport: decoded.transport,
      });
    }
    const data = decoded.bytes;
    const mime = typeof bag.mime === 'string' && bag.mime ? bag.mime : 'video/mp4';
    const bytes = data.byteLength;
    let fragments: FragmentEntry[] = Array.isArray(bag.fragments)
      ? bag.fragments.filter((item): item is FragmentEntry => Boolean(item) && typeof item === 'object')
      : [];
    const fragmentSum = fragments.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    const fragmentsUsable = fragments.length > 0
      && fragments.every((item) => isSha256Hex(item.sha256) && Number(item.bytes) > 0)
      && fragmentSum === bytes;
    if (!fragmentsUsable) {
      // 分片日记与整段字节对不上（缺 hash / 字节和不等）：退化成「整段一片」，保证 verify 可核对真实字节。
      fragments = [{ index: 0, at: this.now(), bytes, sha256: await sha256Hex(data) }];
    }
    const journal = bag.journal ?? null;
    const storage = await this.probe();
    const record: VideoRecord = {
      id: bag.id,
      tabId: Number.isInteger(Number(bag.tabId)) ? Number(bag.tabId) : null,
      url: String(bag.url ?? ''),
      title: String(bag.title ?? ''),
      startedAt: Number(bag.startedAt) || this.now(),
      endedAt: Number(bag.endedAt) || this.now(),
      mime,
      bytes,
      completeness: bag.completeness === 'complete' ? 'complete' : 'partial',
      stop_reason: bag.stop_reason === 'duration' ? 'duration' : 'user',
      chunk_count: fragments.length,
      fragments,
      finish_via: bag.finish_via === 'encoder' || bag.finish_via === 'worker' ? bag.finish_via : 'main',
      complete_frames: bag.complete_frames === true,
      faststart: bag.faststart === true,
      journal: (journal as JournalSummary | null) ?? null,
      durability: fragments.length > 0 && fragments.every((item) => isSha256Hex(item.sha256)) ? 'verified' : 'unverified',
      durability_parts: fragments.length,
      durability_policy: 'browser-readback',
      fsync_supported: false,
      storage_persisted: storage.persisted,
      storage_quota: storage.quota,
      storage_backend: this.deps.store.backend,
      recording_state: 'ready',
      mode: String(bag.mode ?? ''),
      ...(bag.indexed === true ? { indexed: true, sidx_bytes: Number(bag.sidx_bytes) || 0 } : {}),
      ...(Number(bag.raw_bytes) > 0 ? { raw_bytes: Number(bag.raw_bytes) } : {}),
      ...(Number(bag.trimmed_bytes) > 0 ? { trimmed_bytes: Number(bag.trimmed_bytes) } : {}),
      sealed: true,
      seal: { at: Number(bag.endedAt) || this.now(), backend: this.deps.store.backend, bytes, durability: fragments.length > 0 ? 'verified' : 'unverified' },
      blob: new Blob([toArrayBuffer(data)], { type: mime }),
    };
    record.manifest = buildManifest({
      recordingId: record.id,
      mime: record.mime,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      bytes: record.bytes,
      completeness: record.completeness,
      stopReason: record.stop_reason,
      finishVia: record.finish_via,
      faststart: record.faststart,
      fragments: record.fragments,
      completeBytes: record.journal ? record.journal.complete_bytes : record.bytes,
      storageBackend: this.deps.store.backend,
    }) as unknown as Record<string, unknown>;
    try {
      await this.deps.store.putRecord(record);
    } catch (error) {
      throw storeError(error, '写入录制');
    }
    return record;
  }

  private async settleActive(): Promise<VideoRecord | null> {
    const current = this.active;
    if (!current) return null;
    const last = await this.settleFromLast();
    if (last && last.id === current.id) {
      await this.finishActive(current.id);
      return last;
    }
    const stored = await this.deps.store.getRecord(current.id).catch(() => null);
    if (stored) {
      await this.finishActive(current.id);
      return stored;
    }
    const liveness = await this.probeLiveness();
    if (liveness === 'dead') {
      // 离屏文档已不在：给结果回传留一点时间，再多探一次（不急着丢数据）。
      await this.sleep(120);
      const retry = await this.settleFromLast();
      if (retry && retry.id === current.id) {
        await this.finishActive(current.id);
        return retry;
      }
      const storedRetry = await this.deps.store.getRecord(current.id).catch(() => null);
      if (storedRetry) {
        await this.finishActive(current.id);
        return storedRetry;
      }
    }
    if (this.isStaleActive(current, liveness)) {
      await this.failActive('interrupted', this.lastError ?? '录制中断且没有可用结果（离屏文档/结果缺失）');
    }
    return null;
  }

  /** 活动录制是否已不可救（失去采集端/到时未收尾/超过最大时长）：允许新 start 接管。 */
  private isStaleActive(current: ActiveRuntime, liveness: Liveness): boolean {
    const now = this.now();
    const age = now - current.startedAt;
    if (current.deadline > 0 && now > current.deadline + STALE_GRACE_MS) return true;
    if (liveness === 'dead' && age > 2000) return true;
    return age > this.maxDurationMs + RECORDER_AGE_GRACE_MS;
  }

  /** 离屏文档是否真的还在录：live=在录；dead=离屏文档/录制端已不存在；unknown=拿不到明确回包。 */
  private async probeLiveness(): Promise<Liveness> {
    let reply: { active?: unknown } | null = null;
    try {
      reply = await this.deps.port.post<{ active?: unknown }>({ type: OFFSCREEN_MESSAGES.STATUS }, { retries: 2, intervalMs: 30 });
    } catch {
      return 'dead';
    }
    if (!reply || typeof reply !== 'object') return 'dead';
    if (reply.active === true) return 'live';
    if (reply.active === false) return 'dead';
    return 'unknown';
  }

  /** 清活动态（正常收尾）：停截帧、停到期定时器、删 chrome.storage 活动键、关闭离屏文档。 */
  private async finishActive(expectedId?: string): Promise<void> {
    if (expectedId && this.active && this.active.id !== expectedId) return;
    await this.stopScreencast();
    this.clearDeadlineTimer();
    this.active = null;
    await this.clearActiveStorage();
    await this.deps.port.close().catch(() => {});
  }

  private async failActive(reason: string, message: string): Promise<void> {
    this.lastError = message;
    const current = this.active;
    if (current) {
      try { current.machine.send('fail', { reason, bytes: 0 }); } catch { /* 忽略 */ }
      this.active = null;
    }
    await this.stopScreencast();
    this.clearDeadlineTimer();
    await this.clearActiveStorage();
    // 让离屏文档撤销残留的编码器/录制器，再关闭文档；失败一律忽略（清理不能反过来报错）。
    await this.deps.port.post({ type: OFFSCREEN_MESSAGES.ABORT }, { retries: 1, intervalMs: 0 }).catch(() => {});
    await this.deps.port.close().catch(() => {});
    this.log('录制失败（' + reason + '）：' + message);
  }

  /** duration 到期的 SW 侧兜底：离屏定时器被节流/丢消息时也能收尾，不让活动态永久占位。 */
  private armDeadline(): void {
    this.clearDeadlineTimer();
    const current = this.active;
    if (!current || current.deadline <= 0) return;
    const delay = Math.max(0, current.deadline - this.now()) + 100;
    const timer = setTimeout(() => {
      this.deadlineTimer = null;
      const active = this.active;
      if (!active || active.deadline <= 0) return;
      if (this.now() < active.deadline - 50) {
        // 时钟未走到（单测假时钟/系统回拨）：重新排，不误停。
        this.armDeadline();
        return;
      }
      void this.stop({ recording: active.id, reason: 'duration' }).catch(async (error: unknown) => {
        this.lastError = messageOf(error);
        if (this.active?.id === active.id) {
          await this.failActive('duration_timeout', '到时自动停止失败：' + messageOf(error));
        }
      });
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.deadlineTimer = timer;
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer) {
      try { clearTimeout(this.deadlineTimer); } catch { /* 忽略 */ }
      this.deadlineTimer = null;
    }
  }

  private async pruneExpired(ttlOverride?: number): Promise<number> {
    const ttl = Number.isFinite(Number(ttlOverride)) && Number(ttlOverride) >= 0 ? Number(ttlOverride) : this.defaultTtlMs;
    const records = await this.deps.store.listRecords().catch(() => [] as VideoRecord[]);
    const now = this.now();
    let removed = 0;
    for (const record of records) {
      const at = Number(record.endedAt) || Number(record.startedAt) || 0;
      if (at > 0 && now - at > ttl) {
        await this.deps.store.deleteRecord(record.id).catch(() => {});
        await this.deps.store.clearChunks(record.id).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }

  private requireTabId(params: VideoStartParams): number {
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw videoError(VIDEO_CODES.BAD_ARG, 'video.start 需要 tabId（会话路由会自动注入）', { tabId: params.tabId ?? null });
    }
    return tabId;
  }

  private async probe(): Promise<StorageState> {
    if (this.deps.probeStorage) return this.deps.probeStorage(this.deps.store.backend);
    return { backend: this.deps.store.backend, persisted: false, quota: null, usage: null };
  }

  private activePublic(active: ActiveRuntime): ActiveRecording {
    return {
      id: active.id,
      tabId: active.tabId,
      url: active.url,
      title: active.title,
      startedAt: active.startedAt,
      mime: active.mime,
      mode: active.mode,
      durationMs: active.durationMs,
      deadline: active.deadline,
      machineState: active.machine.state,
    };
  }

  private async persistActive(): Promise<void> {
    if (!this.active) return;
    await this.deps.storage.setJson(VIDEO_ACTIVE_KEY, this.activePublic(this.active));
    await this.deps.storage.setJson(VIDEO_STATE_KEY, this.active.machine.snapshot());
  }

  private async clearActiveStorage(): Promise<void> {
    await this.deps.storage.remove(VIDEO_ACTIVE_KEY);
    await this.deps.storage.remove(VIDEO_STATE_KEY);
  }

  private async restoreActive(): Promise<ActiveRuntime | null> {
    if (this.active) return this.active;
    const stored = await this.deps.storage.getJson<ActiveRecording>(VIDEO_ACTIVE_KEY);
    if (!stored || typeof stored.id !== 'string' || !stored.id) return null;
    const machine = createVideoStateMachine({
      id: stored.id,
      initial: stored.machineState === 'finalizing' ? 'finalizing' : 'recording',
      startedAt: Number(stored.startedAt) || this.now(),
      now: () => this.now(),
    });
    this.active = {
      id: stored.id,
      tabId: Number.isInteger(Number(stored.tabId)) ? Number(stored.tabId) : null,
      url: String(stored.url ?? ''),
      title: String(stored.title ?? ''),
      startedAt: Number(stored.startedAt) || this.now(),
      mime: String(stored.mime ?? ''),
      mode: String(stored.mode ?? ''),
      durationMs: Number(stored.durationMs) || 0,
      deadline: Number(stored.deadline) || 0,
      machine,
      screencast: null,
    };
    return this.active;
  }

  /** 停止逐帧录制的 CDP 截帧（幂等；SW 重启后没有 screencast 时什么也不做）。 */
  private async stopScreencast(): Promise<void> {
    const current = this.screencast;
    this.screencast = null;
    if (!current) return;
    try { current.unsubscribe(); } catch { /* 忽略 */ }
    const cdp = this.deps.cdp;
    if (cdp) {
      try { await cdp.send(current.tabId, 'Page.stopScreencast', {}); } catch { /* 忽略 */ }
      try { cdp.release?.(current.tabId, 'record'); } catch { /* 忽略 */ }
    }
  }

  // -------------------------------------------------------------------------
  // 诊断
  // -------------------------------------------------------------------------

  /** 供 doctor/页面读取的服务自述（不含 blob）。 */
  describe(): Record<string, unknown> {
    return {
      ok: true,
      backend: this.deps.store.backend,
      active: this.active ? this.activePublic(this.active) : null,
      last_error: this.lastError,
      has_tab_capture: Boolean(this.deps.tabCapture),
      has_debugger: Boolean(this.deps.cdp),
      max_duration_ms: this.maxDurationMs,
      max_bytes: this.maxBytes,
      default_ttl_ms: this.defaultTtlMs,
    };
  }

  /** 当前状态机阶段（诊断/单测用）。 */
  phase(): RecordingPhase {
    if (!this.active) return 'idle';
    return this.active.machine.state;
  }

  /** 让状态机显式接收一个事件（诊断/单测用；非法迁移原样返回证据）。 */
  transition(event: Parameters<VideoStateMachine['send']>[0], detail?: Parameters<VideoStateMachine['send']>[1]): StateMachineResult | null {
    if (!this.active) return null;
    return this.active.machine.send(event, detail);
  }
}

export type { OffscreenPort, VideoStorage, StoredChunk, PublicVideoRecord, CodedError };
