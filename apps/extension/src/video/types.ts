// src/video/types.ts —— video 服务的公共契约（纯类型 + 错误工厂）。
//
// 设计取向（与 src/capture、src/cdp 一致）：
// - 不在模块加载期读 `chrome`/`browser` 全局：所有外部能力都由调用方注入，Node 单测可离线 import；
// - 记录的可序列化字段（list/status 公开面）与内部字段（blob/bytes）分开：
//   公开面只回可 JSON 化的值，二进制只在 fetch/verify/recover 内部使用；
// - 字段命名与 CLI/daemon 侧 `bridge video *`（cli/commands/video.mjs）的既有契约对齐：
//   completeness / stop_reason / chunks / fragments / journal / faststart / finish_via /
//   complete_frames / durability_policy / fsync_supported / storage_persisted。

/** 录制生命周期（idle → recording → finalizing → ready/failed；恢复进入 recovered）。 */
export type RecordingPhase = 'idle' | 'recording' | 'finalizing' | 'ready' | 'failed' | 'recovered';

/** 停止原因：用户手动 / 到时自动 / 崩溃恢复 / 中断。 */
export type StopReason = 'user' | 'duration' | 'recovered' | 'interrupted';

/** 完帧重封装来源：encoder=WebCodecs 编码、worker=离屏重封装、main=主线程兜底。 */
export type FinishVia = 'encoder' | 'worker' | 'main';

/** 完整性：complete=有完整尾帧；partial=只拼到可用前缀/恢复。 */
export type Completeness = 'complete' | 'partial';

/** 存储后端：真实落盘用 IndexedDB；不可用时纯内存兜底并如实标注。 */
export type StorageBackend = 'indexeddb' | 'memory';

/** 分片日记的一条：字节数 + SHA-256（64 位小写十六进制）+ 序号 + 落片时间。 */
export interface FragmentEntry {
  index: number;
  at: number;
  bytes: number;
  sha256: string;
}

/** 分片日记摘要（与 extension/src/lib/video-meta.js journalSummary 字段一致）。 */
export interface JournalSummary {
  fragmented: boolean;
  init_bytes: number;
  fragments: number;
  complete_bytes: number;
  trailing_bytes: number;
  complete_frames: boolean;
  open_fragment: boolean;
}

/** 容器概览（与 extension/src/lib/mp4-boxes.js analyzeMp4 字段一致，全小写入口）。 */
export interface ContainerAnalysis {
  format: 'mp4' | 'webm' | 'unknown';
  fragmented: boolean;
  boxes: string[];
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMoof: boolean;
  hasSidx: boolean;
  moovOffset: number | null;
  mdatOffset: number | null;
  firstMoofOffset: number | null;
  faststart: boolean;
  parsedBytes: number;
  truncated: boolean;
}

/** 一次录制的完整记录（内部；blob 只在扩展内部流转，不进 RPC 公开面）。 */
export interface VideoRecord {
  id: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  mime: string;
  bytes: number;
  completeness: Completeness;
  stop_reason: StopReason;
  chunk_count: number;
  fragments: FragmentEntry[];
  finish_via: FinishVia;
  complete_frames: boolean;
  faststart: boolean;
  journal: JournalSummary | null;
  indexed?: boolean;
  sidx_bytes?: number;
  raw_bytes?: number;
  trimmed_bytes?: number;
  durability: 'verified' | 'unverified';
  durability_parts?: number;
  durability_reason?: string;
  durability_policy: 'browser-readback';
  fsync_supported: boolean;
  storage_persisted: boolean;
  storage_quota: number | null;
  storage_backend: StorageBackend;
  recording_state: RecordingPhase;
  recovered?: boolean;
  sealed?: boolean;
  seal?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  mode?: string;
  blob: Blob;
}

/** 公开面（list/status/save 结果）：去掉 blob，其余字段原样（CLI 直接读这些字段）。 */
export type PublicVideoRecord = Omit<VideoRecord, 'blob'>;

/** 存储能力探测结果（navigator.storage.persist/estimate；失败一律如实降级）。 */
export interface StorageState {
  backend: StorageBackend;
  persisted: boolean;
  quota: number | null;
  usage: number | null;
}

/** 录制选项目标标签页信息（只依赖注入的 tabs.get）。 */
export interface VideoTabInfo {
  id: number;
  url?: string;
  title?: string;
  windowId?: number;
}

/** video.start 入参（CLI 与页面共用；durationMs 由 CLI --duration 换算）。 */
export interface VideoStartParams {
  tabId?: number;
  durationMs?: number;
  quality?: string;
  encoder?: string;
  forceFrames?: boolean;
  maxDurationMs?: number;
  maxTotalBytes?: number;
}

/** 进行一次录制时活动态的公开面（SW 重启后从 chrome.storage 还原）。 */
export interface ActiveRecording {
  id: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  mime: string;
  mode: string;
  durationMs: number;
  deadline: number;
  machineState: RecordingPhase;
}

/** 状态机事件（用户可见的迁移名）。 */
export type RecordingEvent = 'start' | 'stop' | 'seal' | 'fail' | 'recover' | 'pause' | 'resume';

/** 带 code 的错误（RPC 层按 code 归类；不吞掉原始 message）。 */
export type CodedError = Error & { code?: string; data?: unknown };

export function videoError(code: string, message: string, data?: unknown): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

/** 已知错误码（集中在这里，便于 CLI/页面/单测对齐；不静默改语义）。 */
export const VIDEO_CODES = Object.freeze({
  BUSY: 'E_SESSION_BUSY',
  IDLE: 'E_VIDEO_IDLE',
  BAD_ARG: 'E_BAD_ARG',
  NOT_FOUND: 'E_NOT_FOUND',
  RESTRICTED_PAGE: 'E_VIDEO_RESTRICTED_PAGE',
  CAPTURE: 'E_VIDEO_CAPTURE',
  UNSUPPORTED: 'E_VIDEO_UNSUPPORTED',
  TOO_LARGE: 'E_TOO_LARGE',
  STOP_TIMEOUT: 'E_VIDEO_STOP_TIMEOUT',
  NO_FRAGMENTS: 'E_VIDEO_NO_FRAGMENTS',
  STORE: 'E_VIDEO_STORE',
});

/** 默认时长/字节上限（与 extension/src/video.js 的 MAX_DURATION_MS / MAX_BYTES 对齐）。 */
export const VIDEO_LIMITS = Object.freeze({
  maxDurationMs: 10 * 60 * 1000,
  maxBytes: 256 * 1024 * 1024,
  defaultTtlMs: 24 * 60 * 60 * 1000,
});
