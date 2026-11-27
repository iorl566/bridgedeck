// src/runtime/cooperation.ts —— 人工协作运行时（human-watch + hold/handback + 人工协助卡片）。
//
// 背景（为什么需要这一层）：
// - 0.3.0 JS 扩展里，`cooperate wait` 靠常驻内容脚本（content/human-watch.js）回传
//   `bb.human.activity`，`request-help` 靠页面浮层 + `bb.help.resolved` 消息（tabs-help.js）；
//   TS 运行时此前只有“显式 cooperate hold”的闸门，没有真实人工输入检测，也没有协助卡片。
// - 本模块补齐这两块：页面侧采集/浮层在 `src/content/cooperation.ts`（可 inject 的自包含函数），
//   后台侧在这里维护 per-tab 的人工活动状态、静默窗口判定、交回清零与“自上次 sync 以来的人工编辑数”。
//
// 设计约束：
// - 全部依赖注入（时钟/sleep/页面注入/设置读取/hold 闸门/扩展动作面 dispatch），可在 Node 单测里
//   精确驱动“检测到人 → hold → 静默 → ready”和“卡片出现 → 完成 → 自动交还”。
// - 不谎报能力：没有 UIA/OS 输入队列监听，只有页面可信事件（isTrusted）；结果里带 input 证据
//   与 note，说明这是近似语义。Agent 自己派发的可信输入用 `markAgentInput` 标记窗口排除。
// - handback 语义：人工交回后**立刻** ready（清掉静默窗口的“从此刻起算”边界），不等人自然静默。

import { RpcMethodError } from '../rpc/registry.ts';
import type { CommandContext, CommandHandler, RegisteredCommand } from './router.ts';
import {
  HUMAN_ACTIVE_WINDOW_MS,
  checkHelpCriteria,
  hideHelpOverlay,
  installHumanWatch,
  markAgentInput as pageMarkAgentInput,
  measureTarget,
  readHelpState,
  readHumanActivity,
  showHelpOverlay,
  type HelpCriterion,
  type HelpOverlayOptions,
  type HelpPageState,
  type HumanActivityEvent,
  type HumanActivityState,
  type TargetRect,
} from '../content/cooperation.ts';

/** 协助卡片宿主 id（与页面侧/CLI 诊断共用；E2E 按它查 DOM）。 */
export const HELP_OVERLAY_HOST_ID = '__bb_help_host';

/** request-help 的默认等待上限（与 0.3.0 JS 一致：5s 下限 / 10min 上限）。 */
const HELP_TIMEOUT_MIN_MS = 5_000;
const HELP_TIMEOUT_MAX_MS = 600_000;
const HELP_TIMEOUT_DEFAULT_MS = 180_000;
/** 人工协助卡片可见性/完成条件的轮询间隔。 */
const HELP_POLL_INTERVAL_MS = 250;
/** cooperate.wait 的活动轮询间隔（与扩展动作面的 POLL_INTERVAL_MS 同量级）。 */
const WAIT_POLL_INTERVAL_MS = 100;
/** cooperate.wait 的 timeout 上限（防止一个命令占住 daemon 回包预算）。 */
const WAIT_TIMEOUT_MAX_MS = 30_000;
/** 窗口失焦（blur）只在“确实静默了一小段”后才清掉活动标记，避免页面内焦点切换误清。 */
const BLUR_IDLE_QUIET_MS = 600;

/** 一次人工输入的页面证据（只有事件类型/目标标签，不读值）。 */
export interface HumanActivityView {
  at: number;
  kind: string;
  label: string;
  sensitive: boolean;
  editable: boolean;
  inputClock: number;
}

/** per-tab 人工活动快照（诊断/结果证据用）。 */
export interface HumanWatchSnapshot {
  tabId: number;
  active: boolean;
  lastHumanAt: number;
  kind: string;
  label: string;
  sensitive: boolean;
  editable: boolean;
  inputClock: number;
  received: number;
  pendingEdits: number;
  totalAttributed: number;
  clearedAt: number;
  silentWindowMs: number;
  at: number;
}

/** sync 的“人工编辑”对账结果（cooperate sync reconciliation 字段）。 */
export interface HumanReconciliation {
  humanEdits: number;
  totalHumanAttributed: number;
  lastHumanAt: number | null;
  inputClock: number;
  received: number;
  clearedAt: number;
  at: number;
}

interface HumanTabState {
  tabId: number;
  lastHumanAt: number;
  lastKind: string;
  lastLabel: string;
  lastSensitive: boolean;
  lastEditable: boolean;
  inputClock: number;
  received: number;
  pendingEdits: number;
  totalAttributed: number;
  clearedAt: number;
  lastReconciledHumanAt: number;
}

/**
 * per-tab 人工活动状态机。
 *
 * 判定口径（与 0.3.0 的近似语义对齐）：
 * - `active`：最近一次可信输入距 now ≤ 静默窗口，且晚于最近一次 handback 的 clearedAt；
 * - `handback`：clearedAt = now —— 人工刚交回，之前的事件不再算“正在操作”（23x 依赖）；
 * - `reconcile`：返回“自上次 sync 以来的人工编辑数”并清零累加器；没有收到消息但活动时间更晚时
 *   至少记 1（与 JS control.js 的 `humanAt > previousHumanAt ? 1 : 0` 同义）。
 */
export class HumanWatchStore {
  private readonly states = new Map<number, HumanTabState>();
  private readonly now: () => number;
  readonly silentWindowMs: number;

  constructor(options: { now?: () => number; silentWindowMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.silentWindowMs = Number(options.silentWindowMs) > 0
      ? Math.floor(Number(options.silentWindowMs))
      : HUMAN_ACTIVE_WINDOW_MS;
  }

  private stateOf(tabId: number): HumanTabState {
    const existing = this.states.get(tabId);
    if (existing) return existing;
    const created: HumanTabState = {
      tabId,
      lastHumanAt: 0,
      lastKind: '',
      lastLabel: '',
      lastSensitive: false,
      lastEditable: false,
      inputClock: 0,
      received: 0,
      pendingEdits: 0,
      totalAttributed: 0,
      clearedAt: 0,
      lastReconciledHumanAt: 0,
    };
    this.states.set(tabId, created);
    return created;
  }

  /** 记录一条人工活动（来自页面 human-watch 的 runtime 消息或兜底轮询）。返回是否计入。 */
  note(tabId: number, message: Partial<HumanActivityEvent> & { at?: unknown }): boolean {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const state = this.stateOf(id);
    const rawAt = Number((message as { at?: unknown }).at);
    const at = Number.isFinite(rawAt) && rawAt > 0 ? Math.floor(rawAt) : this.now();
    // handback 之前的事件不再代表“正在操作”，但历史证据（lastHumanAt）保留给 sync 对账。
    if (at <= state.clearedAt) return false;
    const isNewest = at >= state.lastHumanAt;
    if (isNewest) {
      state.lastHumanAt = at;
      state.lastKind = typeof message.kind === 'string' ? message.kind : '';
      state.lastLabel = typeof message.label === 'string' ? message.label : '';
      state.lastSensitive = message.sensitive === true;
      state.lastEditable = message.editable === true;
    }
    const clock = Number(message.inputClock);
    state.inputClock = Math.max(state.inputClock, Number.isFinite(clock) && clock > 0 ? Math.floor(clock) : state.inputClock + 1);
    state.received += 1;
    state.totalAttributed += 1;
    state.pendingEdits = Math.min(state.pendingEdits + 1, 999);
    return true;
  }

  /** 窗口失焦：确实静默后才清活动标记（页面内焦点切换不误清）。 */
  noteBlur(tabId: number, at?: unknown): void {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return;
    const state = this.stateOf(id);
    const when = Number(at);
    const now = Number.isFinite(when) && when > 0 ? Math.floor(when) : this.now();
    if (state.lastHumanAt > 0 && now - state.lastHumanAt > BLUR_IDLE_QUIET_MS) state.lastHumanAt = 0;
  }

  /** 人工是否仍在操作（静默窗口内，且晚于最近一次 handback）。 */
  isActive(tabId: number): boolean {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return false;
    const state = this.states.get(id);
    if (!state) return false;
    if (state.lastHumanAt <= 0 || state.lastHumanAt <= state.clearedAt) return false;
    return this.now() - state.lastHumanAt <= this.silentWindowMs;
  }

  /** wait 观察到人工操作时补一条“待对账”标记，保证 sync 至少报 1 次人工编辑。 */
  markPending(tabId: number): void {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return;
    const state = this.stateOf(id);
    if (state.pendingEdits < 1) state.pendingEdits = 1;
    if (state.totalAttributed < 1) state.totalAttributed = 1;
  }

  /** handback：人工交回后立刻可写（清掉“从此刻起算”的活动边界），返回 clearedAt。 */
  handback(tabId: number): number {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return 0;
    const state = this.stateOf(id);
    const at = this.now();
    state.clearedAt = at;
    // 交回前的人工输入已经由 handback 结算，避免下一次 sync 重复报同一批编辑。
    state.pendingEdits = 0;
    state.lastReconciledHumanAt = Math.max(state.lastReconciledHumanAt, state.lastHumanAt);
    return at;
  }

  /** 对账并清零：返回自上次 sync 以来的人工编辑数。 */
  reconcile(tabId: number): HumanReconciliation {
    const id = Number(tabId);
    const at = this.now();
    if (!Number.isInteger(id) || id <= 0) {
      return { humanEdits: 0, totalHumanAttributed: 0, lastHumanAt: null, inputClock: 0, received: 0, clearedAt: 0, at };
    }
    const state = this.stateOf(id);
    const newerThanLastSync = state.lastHumanAt > 0 && state.lastHumanAt > state.lastReconciledHumanAt;
    const humanEdits = Math.max(state.pendingEdits, newerThanLastSync ? 1 : 0);
    state.pendingEdits = 0;
    state.lastReconciledHumanAt = Math.max(state.lastReconciledHumanAt, state.lastHumanAt);
    return {
      humanEdits,
      totalHumanAttributed: state.totalAttributed,
      lastHumanAt: state.lastHumanAt > 0 ? state.lastHumanAt : null,
      inputClock: state.inputClock,
      received: state.received,
      clearedAt: state.clearedAt,
      at,
    };
  }

  snapshot(tabId: number): HumanWatchSnapshot {
    const id = Number(tabId);
    const at = this.now();
    const state = Number.isInteger(id) && id > 0 ? this.states.get(id) : undefined;
    if (!state) {
      return {
        tabId: id,
        at,
        active: false,
        lastHumanAt: 0,
        kind: '',
        label: '',
        sensitive: false,
        editable: false,
        inputClock: 0,
        received: 0,
        pendingEdits: 0,
        totalAttributed: 0,
        clearedAt: 0,
        silentWindowMs: this.silentWindowMs,
      };
    }
    return {
      tabId: id,
      at,
      active: this.isActive(id),
      lastHumanAt: state.lastHumanAt,
      kind: state.lastKind,
      label: state.lastLabel,
      sensitive: state.lastSensitive,
      editable: state.lastEditable,
      inputClock: state.inputClock,
      received: state.received,
      pendingEdits: state.pendingEdits,
      totalAttributed: state.totalAttributed,
      clearedAt: state.clearedAt,
      silentWindowMs: this.silentWindowMs,
    };
  }

  forget(tabId: number): boolean {
    return this.states.delete(Number(tabId));
  }

  clear(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }
}

/** 页面注入器：把自包含函数注入目标 tab（由 background 用 chrome.scripting.executeScript 包装）。 */
export type CooperationInjector = (
  tabId: number,
  func: (...args: never[]) => unknown,
  args?: unknown[],
) => Promise<unknown>;

/** 扩展动作面 dispatch（cooperate.sync 复用既有实现，避免两套 context/authority 语义）。 */
export type CooperationExtendedDispatch = (
  method: string,
  params: Record<string, unknown>,
  options: { timeoutMs?: number; requestId?: string },
) => Promise<unknown>;

export interface CooperationRuntimeDeps {
  /** 页面注入（缺省时 request-help 明确报能力缺口，wait 退化为只看已有活动状态）。 */
  inject?: CooperationInjector | null;
  /** 既有扩展动作面（cooperate.sync 的 context/observation/authority 由它产出）。 */
  dispatchExtended?: CooperationExtendedDispatch | null;
  /** 设置读取（request-help 的 allowHelp 开关；关闭时保持既有拒绝语义）。 */
  readSettings?: (() => Promise<{ allowHelp?: boolean }>) | null;
  /** 人工 hold 闸门（与 background authorize 共用同一 Set）。 */
  control?: { isHeld(tabId: number): boolean; setHeld(tabId: number, held: boolean): void } | null;
  /** 把目标 tab 置前（协助卡片需要用户能点到；best-effort）。 */
  activateTab?: ((tabId: number) => Promise<void>) | null;
  /** 目标表达式（@eN / CSS selector）→ CSS selector 解析（协助卡片高亮用；可缺省）。 */
  resolveSelector?: ((tabId: number, target: string) => Promise<string | null>) | null;
  human?: HumanWatchStore | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  pollIntervalMs?: number;
}

interface HelpDecision {
  action: 'done' | 'skip';
  note: string;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireTabId(params: Record<string, unknown>, method: string): number {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new RpcMethodError('E_BAD_ARG', method + ' 需要正整数 tabId（由 daemon 按会话注入）', {
      tabId: params.tabId ?? null,
    });
  }
  return tabId;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

/** 完成条件归一（与 CLI `--until` 的形状一致；未知 kind 明确标 unsupported，不静默通过）。 */
export function normalizeHelpCriteria(raw: unknown): HelpCriterion[] {
  if (!Array.isArray(raw)) return [];
  const out: HelpCriterion[] = [];
  for (const item of raw.slice(0, 10)) {
    if (!isRecord(item)) continue;
    const kind = String(item.kind ?? item.type ?? '');
    if (kind === 'selector_exists' || kind === 'selector_visible') {
      const selector = typeof item.selector === 'string' ? item.selector : '';
      if (selector) out.push({ kind, selector });
      continue;
    }
    if (kind === 'text_exists' || kind === 'url_contains') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) out.push({ kind, text });
      continue;
    }
    out.push({ kind: kind || 'unknown' });
  }
  return out;
}

/**
 * 人工协作运行时（background 侧单例）。
 *
 * ```ts
 * const cooperation = new CooperationRuntime({ inject, dispatchExtended, readSettings, control });
 * router.register('cooperate.wait', (ctx) => cooperation.wait(ctx.params), { serialized: false });
 * ```
 */
export class CooperationRuntime {
  readonly human: HumanWatchStore;
  private readonly deps: CooperationRuntimeDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly decisions = new Map<string, HelpDecision>();

  constructor(deps: CooperationRuntimeDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.pollIntervalMs = Number(deps.pollIntervalMs) > 0 ? Math.floor(Number(deps.pollIntervalMs)) : WAIT_POLL_INTERVAL_MS;
    this.human = deps.human ?? new HumanWatchStore({ now: this.now });
  }

  /** 页面注入（失败返回 null，不把页面不可注入变成业务异常）。 */
  private async injectSafe(
    tabId: number,
    func: (...args: never[]) => unknown,
    args: unknown[] = [],
  ): Promise<unknown> {
    if (!this.deps.inject) return null;
    try {
      return await this.deps.inject(tabId, func, args);
    } catch {
      return null;
    }
  }

  /** 兜底：直接问页面 human-watch 最近有没有人工输入（runtime 消息丢失/SW 重启后的补偿）。 */
  private async probePageHumanActivity(tabId: number): Promise<HumanActivityState | null> {
    const probed = await this.injectSafe(tabId, readHumanActivity, []);
    if (!isRecord(probed) || probed.installed !== true) return null;
    const state = probed as unknown as HumanActivityState;
    if (state.active && Number(state.lastInputAt) > 0) {
      this.human.note(tabId, {
        type: 'bb.human.activity',
        at: state.lastInputAt,
        kind: state.lastKind,
        label: state.lastLabel,
        sensitive: state.sensitive === true,
        editable: state.editable === true,
        inputClock: state.inputClock,
        active: true,
      });
    }
    return state;
  }

  /**
   * cooperate wait：等人工停手（默认 timeout=0 立即返回当前判断）。
   * ready=false + state.mode='human' 表示正在人工操作（或显式 hold）。
   */
  async wait(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabId = requireTabId(params, 'cooperate.wait');
    const timeoutMs = clampInt(params.timeoutMs, 0, WAIT_TIMEOUT_MAX_MS, 0);
    const started = this.now();
    // 每次 wait 只补一次页面探测：消息通道正常时这里不会改变判定，只覆盖 SW 重启/消息丢失。
    const probed = await this.probePageHumanActivity(tabId);
    if (probed === null) {
      // 页面还没有 human-watch：顺手装一次（只对“之后”的输入生效，历史输入无从得知）。
      await this.injectSafe(tabId, installHumanWatch, []);
    }
    const limitations = probed === null
      ? '页面级 human-watch 尚未安装（本次已补装）：只能看到安装之后的可信输入，历史人工操作无法追溯；没有 UIA/OS 级输入监听'
      : '基于页面可信输入事件（isTrusted）与静默窗口近似判定；没有 UIA/OS 级人工输入监听';
    let sawHuman = false;
    for (;;) {
      const active = this.human.isActive(tabId);
      if (active) {
        sawHuman = true;
        this.human.markPending(tabId);
      }
      const held = this.deps.control ? this.deps.control.isHeld(tabId) : false;
      const human = this.human.snapshot(tabId);
      const ready = !active && !held;
      if (ready || this.now() - started >= timeoutMs) {
        return {
          ok: true,
          ready,
          timeoutMs,
          held,
          waitedMs: Math.max(0, this.now() - started),
          humanDetected: sawHuman,
          state: {
            mode: ready ? (held ? 'human' : 'agent') : 'human',
            humanInput: active,
            lastHumanAt: human.lastHumanAt > 0 ? human.lastHumanAt : null,
            lastKind: human.kind || null,
            sensitive: human.sensitive,
            editable: human.editable,
            clearedAt: human.clearedAt,
            silentWindowMs: human.silentWindowMs,
          },
          human,
          input: { source: 'page-events', trustedOnly: true, uia: false },
          note: limitations,
        };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** cooperate handback：人工把控制权交回 → 立刻 ready（清活动边界 + 释放显式 hold）。 */
  async handback(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabId = requireTabId(params, 'cooperate.handback');
    if (this.deps.control) this.deps.control.setHeld(tabId, false);
    const clearedAt = this.human.handback(tabId);
    return {
      ok: true,
      handedBack: true,
      held: false,
      at: this.now(),
      clearedAt,
      state: { mode: 'ready' },
      human: this.human.snapshot(tabId),
      note: '已交回 Agent：人工输入静默边界清零，之后新的可信输入会重新触发人工接管判定',
    };
  }

  /**
   * cooperate sync：复用既有扩展动作面的实现（context/observation/authority 语义单源），
   * 再补上“自上次 sync 以来的人工编辑”对账与 human_input 证据（23u 依赖 reconciliation.humanEdits）。
   */
  async sync(params: Record<string, unknown>, options: { timeoutMs?: number; requestId?: string } = {}): Promise<Record<string, unknown>> {
    const tabId = requireTabId(params, 'cooperate.sync');
    const extended = this.deps.dispatchExtended
      ? await this.deps.dispatchExtended('cooperate.sync', params, options)
      : null;
    const base = isRecord(extended) ? extended : {};
    const reconciliation = this.human.reconcile(tabId);
    const snapshot = this.human.snapshot(tabId);
    const control = isRecord(base.control) ? base.control : {};
    return {
      ok: true,
      ...base,
      reconciliation: {
        ...(isRecord(base.reconciliation) ? base.reconciliation : {}),
        ...reconciliation,
        silentWindowMs: snapshot.silentWindowMs,
      },
      human_input: snapshot,
      control: {
        ...control,
        humanActive: snapshot.active || control.humanActive === true,
        mode: snapshot.active ? 'human' : (typeof control.mode === 'string' ? control.mode : 'agent'),
      },
    };
  }

  /**
   * request-help：页面浮层（关闭 allowHelp 时保持既有拒绝语义）→ 等人工点“完成并交还”或
   * 完成条件满足 → 自动交还（释放 hold、清人工静默边界）。
   */
  async requestHelp(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabId = requireTabId(params, 'request-help');
    const reason = String(params.reason ?? params.prompt ?? '').trim();
    if (!reason) {
      throw new RpcMethodError('E_BAD_ARG', 'request-help 需要 reason/prompt（给用户看的协助原因）', {
        param: params.reason === undefined ? 'prompt' : 'reason',
      });
    }
    const settings = this.deps.readSettings ? await this.deps.readSettings().catch(() => null) : null;
    if (settings && settings.allowHelp === false) {
      throw new RpcMethodError('E_HELP_DISABLED', 'request-help 已被设置关闭（settings set --allow-help off）', {
        reason: 'allowHelp=false',
      });
    }
    if (!this.deps.inject) {
      throw new RpcMethodError(
        'E_NOT_IMPLEMENTED',
        'TS 运行时未接 scripting 注入（chrome.scripting），无法在页面显示人工协助卡片',
        { method: 'request-help' },
      );
    }
    const timeoutMs = clampInt(params.timeoutMs, HELP_TIMEOUT_MIN_MS, HELP_TIMEOUT_MAX_MS, HELP_TIMEOUT_DEFAULT_MS);
    const criteria = normalizeHelpCriteria(params.criteria);
    const requestId = 'help_' + this.now().toString(36) + '_' + Math.floor((this.deps.random ?? Math.random)() * 1e9).toString(36);
    const title = typeof params.title === 'string' ? params.title : '';
    const target = typeof params.target === 'string' ? params.target : '';
    // 目标高亮：@eN 先由调用方解析成 CSS selector；纯 selector 直接量视口矩形。
    let targetRect: TargetRect | null = null;
    if (target) {
      const resolved = this.deps.resolveSelector
        ? await this.deps.resolveSelector(tabId, target).catch(() => null)
        : null;
      const selector = resolved || (target.startsWith('@') ? '' : target);
      if (selector) targetRect = await this.injectSafe(tabId, measureTarget, [selector]) as TargetRect | null;
    }
    const overlayOptions: HelpOverlayOptions = { requestId, reason, title, targetRect };
    const shown = await this.injectSafe(tabId, showHelpOverlay, [overlayOptions]);
    if (!isRecord(shown) || shown.ok !== true) {
      throw new RpcMethodError(
        'E_HELP_UNAVAILABLE',
        '页面无法注入人工协助卡片（受限页面/文档尚未就绪/被页面策略拒绝）',
        { tabId, method: 'request-help' },
      );
    }
    if (this.deps.activateTab) await this.deps.activateTab(tabId).catch(() => undefined);
    const started = this.now();
    let outcome: { action: 'done' | 'skip' | 'timeout'; note: string } | null = null;
    try {
      for (;;) {
        const decision = this.decisions.get(requestId);
        if (decision) {
          outcome = { action: decision.action, note: decision.note };
          break;
        }
        const pageState = await this.injectSafe(tabId, readHelpState, []) as HelpPageState | null;
        if (isRecord(pageState) && pageState.requestId === requestId
          && (pageState.action === 'done' || pageState.action === 'skip')) {
          outcome = { action: pageState.action, note: typeof pageState.note === 'string' ? pageState.note : '' };
          break;
        }
        if (criteria.length > 0) {
          const checked = await this.injectSafe(tabId, checkHelpCriteria, [criteria]);
          if (isRecord(checked) && checked.ok === true) {
            outcome = { action: 'done', note: '' };
            break;
          }
        }
        if (this.now() - started >= timeoutMs) {
          outcome = { action: 'timeout', note: '' };
          break;
        }
        await this.sleep(HELP_POLL_INTERVAL_MS);
      }
    } finally {
      this.decisions.delete(requestId);
      await this.injectSafe(tabId, hideHelpOverlay, []);
    }
    const waitedMs = Math.max(0, this.now() - started);
    const final = outcome ?? { action: 'timeout' as const, note: '' };
    if (final.action === 'done') {
      // 人工点“完成并交还”/完成条件满足 = 明确交回：释放 hold 并清人工静默边界。
      if (this.deps.control) this.deps.control.setHeld(tabId, false);
      this.human.handback(tabId);
    }
    return {
      ok: true,
      action: final.action,
      note: final.note,
      requestId,
      timeoutMs,
      waitedMs,
      criteria: criteria.length,
      criteriaSatisfied: final.action === 'done' && criteria.length > 0,
      at: this.now(),
      host: HELP_OVERLAY_HOST_ID,
    };
  }

  /** 后台 runtime 消息面：`bb.human.activity` / `bb.human.blur` / `bb.help.resolved`。 */
  handleRuntimeMessage(raw: unknown, senderTabId: unknown): boolean {
    if (!isRecord(raw)) return false;
    const type = String(raw.type ?? '');
    if (type === 'bb.human.activity' || type === 'bb.human.blur') {
      const tabId = Number(senderTabId);
      if (!Number.isInteger(tabId) || tabId <= 0) return false;
      if (type === 'bb.human.blur') {
        this.human.noteBlur(tabId, raw.at);
      } else {
        this.human.note(tabId, raw as unknown as Partial<HumanActivityEvent>);
      }
      return true;
    }
    if (type === 'bb.help.resolved') {
      const requestId = typeof raw.requestId === 'string' ? raw.requestId : '';
      if (!requestId) return false;
      const action = raw.action === 'done' ? 'done' : 'skip';
      this.decisions.set(requestId, {
        action,
        note: typeof raw.note === 'string' ? raw.note : '',
        at: this.now(),
      });
      return true;
    }
    return false;
  }

  /** 可信 Agent 输入的标记窗口（background 在 click-backend/shadow.click 等 CDP 输入前调用）。 */
  async markAgentInput(tabId: number): Promise<boolean> {
    const marked = await this.injectSafe(tabId, pageMarkAgentInput, []);
    return typeof marked === 'number' && marked > 0;
  }

  /** 诊断快照（doctor/__bbTsRuntime 用）。 */
  snapshot(tabId: unknown): Record<string, unknown> {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) {
      return { human: this.human.snapshot(0), pendingDecisions: [...this.decisions.keys()] };
    }
    return {
      tabId: id,
      human: this.human.snapshot(id),
      pendingDecisions: [...this.decisions.keys()],
      host: HELP_OVERLAY_HOST_ID,
    };
  }

  forget(tabId: number): void {
    this.human.forget(tabId);
  }
}

/**
 * 把协作运行时的四个方法包装成 router 注册项（给 background 直接 registerAll）。
 *
 * 为什么不让 background 手写这四个 handler：方法名/串行性/超时口径必须与既有动作面一致，
 * 集中在这里可以避免接线时漏掉 `request-help` 的 serialized:false（它等待人工，绝不能
 * 排在同 tab 的动作链后面，否则 get-html/observe 会自锁）。
 *
 * 使用方式（background.ts）：
 * ```ts
 * for (const spec of extended.specsList()) {
 *   if (COOPERATION_METHODS.has(spec.method)) continue; // 由 CooperationRuntime 接管
 *   router.register(spec.method, ...);
 * }
 * router.registerAll(createCooperationCommands(cooperation));
 * ```
 */
export const COOPERATION_METHODS: readonly string[] = Object.freeze([
  'cooperate.wait',
  'cooperate.handback',
  'cooperate.sync',
  'request-help',
]);

export function createCooperationCommands(runtime: CooperationRuntime): RegisteredCommand[] {
  const specs: Array<{ method: string; serialized: boolean; description: string; handler: CommandHandler }> = [
    {
      method: 'cooperate.wait',
      serialized: false,
      description: '协作等待：检测页面真实人工输入（isTrusted）并等到人工停手；ready=false 表示正在人工操作',
      handler: async (context: CommandContext) => runtime.wait(context.params),
    },
    {
      method: 'cooperate.handback',
      serialized: false,
      description: '人工交回控制权：释放 hold 并清人工静默边界，之后立刻可写',
      handler: async (context: CommandContext) => runtime.handback(context.params),
    },
    {
      method: 'cooperate.sync',
      serialized: true,
      description: '协作同步：复用扩展动作面的 sync，并补人工编辑对账（reconciliation.humanEdits）',
      handler: async (context: CommandContext) => runtime.sync(context.params, {
        timeoutMs: context.timeoutMs,
        requestId: context.requestId,
      }),
    },
    {
      method: 'request-help',
      serialized: false,
      description: '请求人工协助：页面浮层（shadow DOM）→ 用户完成/条件满足后自动交还；allowHelp 关闭时拒绝',
      handler: async (context: CommandContext) => runtime.requestHelp(context.params),
    },
  ];
  return specs.map((spec) => ({
    method: spec.method,
    handler: spec.handler,
    serialized: spec.serialized,
    timeoutMs: null,
    description: spec.description,
  }));
}
