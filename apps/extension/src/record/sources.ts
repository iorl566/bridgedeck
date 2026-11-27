// src/record/sources.ts —— 录制事件来源归一化 + 归并 + Agent 动作过滤（纯函数）。
//
// 三个来源：
//   1) 页面事件上报：内容脚本（src/record/capture.ts）把 click/input/select/hover/media/
//      text/navigate/... 通过 `bb.record.event` 发回 background；sender 带 tab/frame/documentId；
//   2) Agent 动作记录：runtime 动作层（click/fill/hover/...）可以在派发后直接调
//      service.recordAgentAction 或由内容事件 + 可信输入时钟（TrustedInputClock）归因成 agent；
//   3) 边界事件：tabs/windows 焦点变化由 background 钩子调 service.recordTabSwitch 注入
//      tab-switch / window-switch（属于 branch 类步骤，不受 Agent 过滤影响）。
//
// 过滤口径（与 0.3.0 JS 运行时 ops.js pushEvent 一致）：
//   - 默认（includeAgent=false）**过滤掉 Agent 的交互动作**（click/hover/input/key/drag/...），
//     但保留观察类事件（state/media/text）与边界事件；
//   - record.start 带 includeAgent=true 时全量记录；
//   - 过滤发生在 background（服务层），页面上报端不做最终裁决（避免页面侧伪造 actor）。

import type { RecordEvent, RecordEventTarget, RecordBoundary } from './types.ts';
import { buildRecordStep, type RecordStepContext } from './steps.ts';

/** 默认过滤的 Agent 交互动作种类（观察类与边界类不在其中）。 */
export const AGENT_FILTERED_KINDS: ReadonlySet<string> = new Set([
  'click',
  'hover',
  'input',
  'key',
  'drag',
  'dragstart',
  'drop',
  'select',
  'file',
]);

/** Agent 输入归因窗口：上次可信输入在 10s 内，页面事件视为 Agent 动作。 */
export const AGENT_INPUT_WINDOW_MS = 10_000;

export interface NormalizeContext {
  now?: number;
  /** 会话单调序号（事件没带合法 seq 时使用）。 */
  nextSeq?: number;
  /** sender 的 frameId / documentId（Chrome 内容脚本消息可信来源）。 */
  frameId?: number;
  documentId?: string | null;
  url?: string;
  tabId?: number | null;
  revision?: number | null;
  /** 最近一次可信 Agent 输入的时间戳（0/缺省 = 没有）。 */
  agentInputAt?: number;
}

export interface RecordEventSender {
  tab?: { id?: number; windowId?: number; url?: string };
  frameId?: number;
  documentId?: string;
  url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(raw: Record<string, unknown>, key: string, max = 500): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string' || !value) return undefined;
  return value.slice(0, max);
}

function integerField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = Number(raw[key]);
  return Number.isInteger(value) ? value : undefined;
}

function numberField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = Number(raw[key]);
  return Number.isFinite(value) ? value : undefined;
}

/** 事件是否属于 Actor=agent 且应被默认过滤（includeAgent=false）。 */
export function isAgentFiltered(event: Pick<RecordEvent, 'kind' | 'actor'>, includeAgent: boolean): boolean {
  if (includeAgent === true) return false;
  if (String(event.actor) !== 'agent') return false;
  return AGENT_FILTERED_KINDS.has(String(event.kind));
}

/**
 * 页面原始事件 → 归一化 RecordEvent（含 boundary + step v2）。
 *
 * 返回 null 表示事件形状非法（缺 kind / 非对象）——调用方按“忽略并计数”处理，
 * 绝不因为一条坏消息让整段录制失败。
 */
export function normalizeRecordEvent(raw: unknown, context: NormalizeContext = {}): RecordEvent | null {
  if (!isRecord(raw)) return null;
  const kind = String(raw.kind ?? '').trim().toLowerCase();
  if (!kind || kind.length > 40) return null;
  const now = Number.isFinite(context.now) ? Number(context.now) : Date.now();
  const reportedActor = String(raw.actor ?? '').trim().toLowerCase();
  const agentInputAt = Number(context.agentInputAt ?? 0);
  const agentRecent = agentInputAt > 0 && now >= agentInputAt && now - agentInputAt <= AGENT_INPUT_WINDOW_MS;
  // 归因以 background 的可信输入时钟为准（TrustedInputClock）：页面录制器分不清
  // “Agent 用 CDP 派发的可信点击”和“真人点击”，页面自报的 actor 只作为兜底。
  // 这与 0.3.0 JS 运行时内容脚本的 10s agent 输入窗口同口径。
  const actor = agentRecent
    ? 'agent'
    : (reportedActor === 'human' ? 'human' : (reportedActor || 'human'));
  const seq = integerField(raw, 'seq') && Number(integerField(raw, 'seq')) > 0
    ? Number(integerField(raw, 'seq'))
    : Math.max(1, Number.isInteger(context.nextSeq) ? Number(context.nextSeq) : 1);
  const ts = numberField(raw, 'ts') ?? now;
  const frameId = Number.isInteger(context.frameId)
    ? Number(context.frameId)
    : (integerField(raw, 'frameId') ?? 0);
  const documentId = (typeof raw.documentId === 'string' && raw.documentId)
    ? raw.documentId
    : (context.documentId ?? null);
  const revision = integerField(raw, 'revision') ?? (Number.isInteger(context.revision) ? Number(context.revision) : null);
  const boundary: RecordBoundary = { documentId, frameId, revision };
  const url = stringField(raw, 'url', 2000)
    ?? stringField(raw, 'frameUrl', 2000)
    ?? String(context.url ?? '');
  const event: RecordEvent = {
    kind,
    seq,
    ts,
    actor,
    url,
    frameId,
    documentId,
    boundary,
    revision,
  };
  copyOptionalFields(raw, event);
  const stepContext: RecordStepContext = {
    seq,
    index: Number.isInteger(raw.index) ? Number(raw.index) : undefined,
    frameId,
    documentId: documentId ?? undefined,
    now: ts,
  };
  const step = buildRecordStep(event, stepContext);
  if (step) {
    event.recordStep = step;
    event.recordStepVersion = step.model;
  }
  return event;
}

const COPY_STRING_FIELDS: ReadonlyArray<[string, number]> = [
  ['selector', 500],
  ['tag', 40],
  ['role', 60],
  ['name', 200],
  ['text', 200],
  ['value', 200],
  ['type', 40],
  ['parent', 500],
  ['parentSelector', 500],
  ['parentToken', 120],
  ['token', 120],
  ['source', 80],
  ['from', 500],
  ['to', 500],
];

function copyOptionalFields(raw: Record<string, unknown>, event: RecordEvent): void {
  for (const [key, max] of COPY_STRING_FIELDS) {
    const value = stringField(raw, key, max);
    if (value !== undefined) event[key] = value;
  }
  const dwellMs = integerField(raw, 'dwellMs');
  if (dwellMs !== undefined && dwellMs >= 0) event.dwellMs = Math.min(dwellMs, 60_000);
  if (raw.expectsPopup === true) event.expectsPopup = true;
  const files = Array.isArray(raw.files) ? raw.files.filter((item): item is string => typeof item === 'string').slice(0, 20) : null;
  if (files && files.length) event.files = files;
  if (Array.isArray(raw.changes)) {
    const changes = raw.changes.filter(isRecord).slice(0, 20);
    if (changes.length) event.changes = changes;
  }
  if (Array.isArray(raw.media)) {
    const media = raw.media.filter(isRecord).slice(0, 20);
    if (media.length) event.media = media;
  } else if (isRecord(raw.media)) {
    event.media = [raw.media];
  }
  const observation = stringField(raw, 'observation', 20_000);
  if (observation !== undefined) event.observation = observation;
  const refs = integerField(raw, 'refs');
  if (refs !== undefined && refs >= 0) event.refs = refs;
  const stateAt = numberField(raw, 'stateAt');
  if (stateAt !== undefined) event.stateAt = stateAt;
  const stateUrl = stringField(raw, 'stateUrl', 2000);
  if (stateUrl !== undefined) event.stateUrl = stateUrl;
  const fromTabId = integerField(raw, 'fromTabId');
  if (fromTabId !== undefined) event.fromTabId = fromTabId;
  const toTabId = integerField(raw, 'toTabId');
  if (toTabId !== undefined) event.toTabId = toTabId;
  const fromWindowId = integerField(raw, 'fromWindowId');
  if (fromWindowId !== undefined) event.fromWindowId = fromWindowId;
  const toWindowId = integerField(raw, 'toWindowId');
  if (toWindowId !== undefined) event.toWindowId = toWindowId;
  const ms = numberField(raw, 'ms');
  if (ms !== undefined) event.ms = ms;
  const screenshot = stringField(raw, 'screenshot', 2_000_000);
  if (screenshot !== undefined && /^data:image\//.test(screenshot)) event.screenshot = screenshot;
}

export type MergeOutcome = 'appended' | 'merged';

/**
 * 把 text/media/state 这类“伴随事件”归并到最近一条主体事件上（不单独成步）：
 * - text  → 上一条非 state/text 事件的 textChanges（20d8 文本 diff）；
 * - media → 上一条非 state/media 事件的 media（20d8 媒体进度）；
 * - state → 上一条同 frame 非 state 事件的 observation/refs/stateUrl；
 * - click 带 parentToken → 找到对应 hover 事件回填 parent（20d7 跨 frame popup 归属）。
 *
 * 返回 merged 表示未把事件追加进数组；appended 表示需要追加。
 */
export function mergeIntoPending(events: RecordEvent[], event: RecordEvent): MergeOutcome {
  const list = Array.isArray(events) ? events : [];
  if (event.kind === 'media') {
    const media = Array.isArray(event.media) ? event.media : [];
    if (!media.length) return 'merged';
    const target = findLast(list, (item) => item.seq <= event.seq && item.kind !== 'state' && item.kind !== 'media');
    if (!target) return 'merged';
    target.media = [...(Array.isArray(target.media) ? target.media : []), ...media].slice(-20);
    return 'merged';
  }
  if (event.kind === 'text') {
    const changes = Array.isArray(event.changes) ? event.changes : [];
    if (!changes.length) return 'merged';
    const target = findLast(list, (item) => item.seq <= event.seq && item.kind !== 'state' && item.kind !== 'text');
    if (!target) return 'merged';
    target.textChanges = [...(Array.isArray(target.textChanges) ? target.textChanges : []), ...changes].slice(-20);
    return 'merged';
  }
  if (event.kind === 'state') {
    const target = findLast(list, (item) => item.seq <= event.seq && item.kind !== 'state' && item.frameId === event.frameId);
    if (!target) return 'merged';
    target.observation = String(event.observation ?? '').slice(0, 20_000);
    target.refs = Number(event.refs) || 0;
    target.stateAt = event.ts || Date.now();
    target.stateUrl = event.url || target.url || '';
    return 'merged';
  }
  if (event.kind === 'click' && typeof event.parentToken === 'string' && event.parentToken) {
    const hover = findLast(list, (item) => item.kind === 'hover' && item.token === event.parentToken);
    if (hover) {
      event.parent = String(hover.selector || event.parentSelector || '');
      event.parentFrameId = hover.frameId;
    }
    delete event.parentToken;
  }
  return 'appended';
}

function findLast<T>(list: T[], predicate: (item: T) => boolean): T | null {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (item !== undefined && predicate(item)) return item;
  }
  return null;
}

/** 事件种类计数（录制摘要/诊断）。 */
export function kindCounts(events: RecordEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.kind !== 'string' || !event.kind) continue;
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

/** sender → 归一化上下文（背景消息来源是可信的；页面不能自报 tabId）。 */
export function contextFromSender(sender: RecordEventSender | null | undefined, extra: { now?: number; nextSeq?: number; agentInputAt?: number } = {}): NormalizeContext {
  const context: NormalizeContext = {};
  if (!sender) return { ...context, ...extra };
  const tabId = Number(sender.tab?.id);
  if (Number.isInteger(tabId) && tabId > 0) context.tabId = tabId;
  if (Number.isInteger(sender.frameId)) context.frameId = Number(sender.frameId);
  if (typeof sender.documentId === 'string' && sender.documentId) context.documentId = sender.documentId;
  else context.documentId = null;
  const url = typeof sender.url === 'string' && sender.url
    ? sender.url
    : (typeof sender.tab?.url === 'string' ? sender.tab.url : '');
  if (url) context.url = url;
  return { ...context, ...extra };
}

/** 供单测/外部构造目标对象用（避免各处重复拼 selector/text/name 口径）。 */
export function eventTargetOf(event: Pick<RecordEvent, 'selector' | 'text' | 'name'>): RecordEventTarget | null {
  if (event.selector) return { selector: String(event.selector) };
  if (event.text) return { text: String(event.text) };
  if (event.name) return { name: String(event.name) };
  return null;
}
