// src/record/types.ts —— 操作录制（record.*）的数据模型（纯类型 + 常量，无运行时依赖）。
//
// 分层关系：
//   sources.ts  页面事件 / Agent 动作 → RecordEvent（含 actor/过滤/边界）
//   steps.ts    RecordEvent → RecordStep（action/observe/wait/branch/human-gate）
//   store.ts    Recording（内存 + chrome.storage.session/local）
//   trace.ts    Recording → Trace v3（states/steps/截图引用）
//   service.ts  record.start/stop/list/export 编排 + 会话内活跃表
//
// 设计取向：所有模型都是可 JSON 序列化的普通对象（导出 trace.json、跨 MV3 进程
// 持久化、页面上报消息都走结构化克隆），不引入 Date/Map 等无法直传的实例。

/** 录制 step 模型版本（与 0.3.0 JS 运行时 record-steps.js v2 对齐）。 */
export const RECORD_STEP_VERSION = 2;

/** 单条录制最多保留的事件数（与 JS 运行时 MAX_EVENTS 一致）。 */
export const RECORD_MAX_EVENTS = 500;

/** 历史录制最多保留条数（与 JS 运行时 MAX_RECORDINGS 一致）。 */
export const RECORD_MAX_RECORDINGS = 20;

/** 单个 tab 的 step 计数状态上限（防 SW 长期运行 Map 无界增长）。 */
export const RECORD_STEP_STATE_MAX_TABS = 50;

/** 录制 step 的最小种类集：动作 / 观察 / 等待 / 上下文边界 / 人工闸门。 */
export const RECORD_STEP_KINDS = Object.freeze(['action', 'observe', 'wait', 'branch', 'human-gate'] as const);

export type RecordStepKind = (typeof RECORD_STEP_KINDS)[number];

export type RecordActor = 'human' | 'agent';

/** 事件目标（selector 优先，其次可见文本/名字；与 run log 的 target 同形）。 */
export interface RecordEventTarget {
  selector?: string;
  text?: string;
  name?: string;
}

export interface RecordStepFallback {
  onError: 'stop' | 'skip' | 'retry';
  skipReason?: string;
  retries?: number;
  retryDelayMs?: number;
}

export interface RecordStepEvidence {
  seq: number;
  index: number | null;
  frameId: number;
  documentId: string;
  revision: number | null;
  actor: string;
  url: string;
  at: number;
}

export interface RecordStepHumanGate {
  reason: string;
  valueKind: 'text' | 'file' | 'select' | 'other';
}

export interface RecordStepBranch {
  boundary: string;
  source?: string;
  url?: string;
  tabId?: number | null;
  windowId?: number | null;
}

/** 可回放、可审计的录制步骤。 */
export interface RecordStep {
  model: number;
  ref: string;
  kind: RecordStepKind;
  type: string;
  method: string;
  params: Record<string, unknown>;
  target: RecordEventTarget | null;
  idempotent: boolean;
  fallback: RecordStepFallback;
  risk: string;
  evidence: RecordStepEvidence;
  sourceKind: string;
  expect?: Record<string, unknown>;
  humanGate?: RecordStepHumanGate;
  branch?: RecordStepBranch;
  /** 与上一条事件的时间间隔（>1.2s 才写；只作为证据，不自动插等待步骤）。 */
  waitBeforeMs?: number;
  /** 连续同签名动作的重复计数（只给 loop 建议，不猜测意图）。 */
  repeat?: number;
}

/** 事件所属文档/帧的边界（导航后 replay 必须换文档身份）。 */
export interface RecordBoundary {
  documentId: string | null;
  frameId: number;
  revision: number | null;
}

/**
 * 归一化后的录制事件。
 *
 * 除固定字段外允许携带原始事件字段（页面录制器/Agent 动作层会追加 kind 专属字段），
 * 因此保留 `[key: string]: unknown`：导出/合并时不需要再写一张白名单表。
 */
export interface RecordEvent {
  kind: string;
  seq: number;
  ts: number;
  actor: string;
  url: string;
  frameId: number;
  documentId: string | null;
  boundary: RecordBoundary;
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  type?: string;
  parent?: string;
  parentSelector?: string;
  parentToken?: string;
  dwellMs?: number;
  expectsPopup?: boolean;
  token?: string;
  source?: string;
  files?: string[];
  /** kind=text 时的文本变化列表（归并到上一条动作）。 */
  changes?: Array<Record<string, unknown>>;
  /** 归并后的文本变化（trace/观测用）。 */
  textChanges?: Array<Record<string, unknown>>;
  /** 归并后的媒体进度（trace/观测用）。 */
  media?: Array<Record<string, unknown>>;
  observation?: string;
  refs?: number;
  stateAt?: number;
  stateUrl?: string;
  fromTabId?: number;
  toTabId?: number;
  fromWindowId?: number;
  toWindowId?: number;
  screenshot?: string;
  revision?: number | null;
  recordStep?: RecordStep;
  recordStepVersion?: number;
  [key: string]: unknown;
}

/** 录制过程中的一次页面观察（初始/最终状态；trace states 的来源之一）。 */
export interface RecordObservation {
  text: string;
  url?: string;
  title?: string;
  refs?: number;
  at?: number;
  frameId?: number;
}

/** trace.frames 的一项（跨 frame 注册表）。 */
export interface RecordFrameInfo {
  frameId: number;
  parentFrameId?: number | null;
  url?: string;
  depth?: number;
  stepCount?: number;
  stateCount?: number;
}

/** 一次完整录制（落库单元）。 */
export interface Recording {
  id: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  events: RecordEvent[];
  includeAgent: boolean;
  screenshots?: boolean;
  initialObservation?: RecordObservation | null;
  finalObservation?: RecordObservation | null;
  frames?: RecordFrameInfo[];
  purpose?: string;
  name?: string;
  stoppedBy?: 'user_finish' | 'cli_stop';
  cli?: string;
}

/** `record.list` 的轻量摘要（页面/诊断用，不带 events 数组）。 */
export interface RecordingSummary {
  id: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  events: number;
  includeAgent: boolean;
  kinds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Trace v3（与 lib/trace-v3.mjs 的对外结构兼容的最小集）
// ---------------------------------------------------------------------------

export const TRACE_VERSION = 3;
export const VOM_FORMAT_VERSION = 1;

export interface TraceState {
  id: string;
  at: string;
  url: string;
  title?: string;
  body: string;
  truncated: boolean;
  frameId?: number;
}

export interface TraceScreenshot {
  id: string;
  at: string;
  label: string;
  width: number | null;
  height: number | null;
  dataUrl: string;
}

export interface TraceStepTarget {
  ref?: string;
  role?: string;
  name?: string;
  ctx?: string;
}

export interface TraceStep {
  id: number;
  at: string;
  state: string;
  result: { state: string };
  op: string;
  target?: TraceStepTarget;
  value?: string;
  commit?: 'enter' | 'blur';
  redacted?: boolean;
  selection?: Array<{ value: string; label?: string }>;
  screenshot?: string;
  frameId?: number;
  frame?: RecordFrameInfo;
  causedBy?: number[];
}

export interface TraceCausalChain {
  id: string;
  steps: number[];
  inferred: boolean;
  reason?: string;
}

export interface TraceV3 {
  version: 3;
  purpose?: string;
  started_at: string;
  recorded_at: string;
  stopped_by: 'user_finish' | 'cli_stop';
  entry: {
    start_url: string;
    frames?: RecordFrameInfo[];
  };
  recorder: { cli: string; vom: number };
  states: TraceState[];
  steps: TraceStep[];
  frames?: RecordFrameInfo[];
  causalChains: TraceCausalChain[];
  screenshots?: TraceScreenshot[];
}

/** 录制中某个 tab 的活跃会话（只在 service 内存里；不落库）。 */
export interface RecordSessionState {
  tabId: number;
  windowId: number | null;
  url: string;
  title: string;
  startedAt: number;
  includeAgent: boolean;
  screenshots: boolean;
  events: RecordEvent[];
  nextSeq: number;
  lastStepAt: number;
  lastSignature: string;
  repeat: number;
  shotted: number;
}

/** 活跃录制摘要（record.status）。 */
export interface ActiveRecordingSummary {
  tabId: number;
  url: string;
  title: string;
  startedAt: number;
  events: number;
  includeAgent: boolean;
  screenshots: boolean;
}

/** 页面录制器安装结果（executeScript 的返回值，必须可结构化克隆）。 */
export interface RecordCaptureInstallResult {
  ok: boolean;
  existing?: boolean | string;
  reason?: string;
}

/** 录制浮层注入结果（executeScript 的返回值，必须可结构化克隆）。 */
export interface RecordOverlayInstallResult {
  ok: boolean;
  existing?: boolean;
  reason?: string;
}
