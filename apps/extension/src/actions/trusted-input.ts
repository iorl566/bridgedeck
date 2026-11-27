// src/actions/trusted-input.ts —— 动作层的「可信输入」路由（20z / 7 / 7b / 16 / 23h3 / 23h4）。
//
// 分工：
// - `src/scripting/input.ts` 的 `InputService` 只负责 CDP Input 的事件序列原语；
// - 本模块负责「动作语义 → 原语」：目标定位（backend-locator.ts）、命中/遮挡 fail-closed、
//   填写的读回校验、按键的无指针聚焦，以及可选的原生输入证据；
// - 所有路由都是「优先 CDP、失败回退内容脚本」：拿不到节点/坐标时返回 null，调用方保持
//   原来的内容脚本路径（35d 的 --synthetic fail-closed、旧客户端不带 trusted 的行为不变）。
//
// 归因：内容脚本的 CooperationTracker 只把「内容脚本 click/press 的派发窗口」记为 Agent
// 输入；CDP 派发的可信事件在页面看来与真人输入相同（这是 --trusted 的目的），但归因时钟
// 不能因此把 Agent 动作算成人类动作。`TrustedInputClock` 在 background 侧记账，由
// cooperate.sync 合并进 frameState（见 extended.ts），23h3/23h4 才能继续成立。

import { RpcMethodError } from '../rpc/registry.ts';
import {
  isCdpChannelError,
  isCdpPreDispatchError,
  type BackendNodeHit,
  type BackendNodeLocatorPort,
  type BackendTargetDescriptor,
  type HitTestResult,
  type NodePoint,
} from './backend-locator.ts';

/** `InputService` 的可注入子集（单测用假实现；运行时就是 InputService）。 */
export interface TrustedInputPort {
  clickPoint(tabId: number, point: { x: number; y: number }, options?: { human?: boolean; steps?: number; modifiers?: number }): Promise<Record<string, unknown>>;
  hoverPoint(tabId: number, point: { x: number; y: number }, options?: { steps?: number; human?: boolean; durationMs?: number }): Promise<Record<string, unknown>>;
  pressKey(tabId: number, spec: unknown): Promise<Record<string, unknown>>;
  insertText(tabId: number, text: string): Promise<Record<string, unknown>>;
  selectAll(tabId: number): Promise<void>;
  dragPath(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }, options?: { steps?: number; modifiers?: number }): Promise<Record<string, unknown>>;
  clickBackendNode(tabId: number, backendNodeId: number, options?: { human?: boolean; modifiers?: number }): Promise<Record<string, unknown>>;
}

/** 归因时钟：每个 tab 自上次 cooperate.sync 以来的原生输入计数。 */
export interface TrustedInputTick {
  /** 计入 Agent 的动作数（click/press 各一次，与内容脚本 begin/endAgentInput 同口径）。 */
  agent: number;
  /** 输入时钟推进量（与内容脚本 inputClock 同口径，一次动作 +1）。 */
  inputClock: number;
  /** 最近一次原生输入（给 attribution.owner/kind/at 用）。 */
  last: { kind: string; at: number } | null;
  /** 按种类计数（诊断用）。 */
  byKind: Record<string, number>;
}

interface TrustedClockState {
  agent: number;
  inputClock: number;
  last: { kind: string; at: number } | null;
  byKind: Record<string, number>;
}

function emptyClock(): TrustedClockState {
  return { agent: 0, inputClock: 0, last: null, byKind: {} };
}

/**
 * 原生输入归因时钟（background 侧）。
 *
 * - `note(tabId, kind)`：一次成功的可信输入动作；
 * - `take(tabId)`：cooperate.sync 时取走并清零（与内容脚本 tracker 的快照同口径：
 *   一次 sync 汇报「自上次 sync 以来」的增量）。
 */
export class TrustedInputClock {
  private readonly state = new Map<number, TrustedClockState>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  note(tabId: number, kind: string): void {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return;
    const current = this.state.get(id) ?? emptyClock();
    const normalized = String(kind || 'input');
    current.agent += 1;
    current.inputClock += 1;
    current.last = { kind: normalized, at: this.now() };
    current.byKind[normalized] = (current.byKind[normalized] ?? 0) + 1;
    this.state.set(id, current);
  }

  take(tabId: number): TrustedInputTick {
    const id = Number(tabId);
    const current = this.state.get(id) ?? emptyClock();
    this.state.delete(id);
    return {
      agent: current.agent,
      inputClock: current.inputClock,
      last: current.last ? { ...current.last } : null,
      byKind: { ...current.byKind },
    };
  }

  /** 只读查看（诊断；不清零）。 */
  peek(tabId: number): TrustedInputTick {
    const current = this.state.get(Number(tabId)) ?? emptyClock();
    return {
      agent: current.agent,
      inputClock: current.inputClock,
      last: current.last ? { ...current.last } : null,
      byKind: { ...current.byKind },
    };
  }

  forget(tabId: number): void {
    this.state.delete(Number(tabId));
  }
}

/** 共享时钟：background 里两个注册表默认共用同一份（lead 无需额外接线也能成立）。 */
export const sharedTrustedInputClock = new TrustedInputClock();

export interface ActionInputBridgeOptions {
  input: TrustedInputPort;
  locator: BackendNodeLocatorPort;
  clock?: TrustedInputClock | null;
  now?: () => number;
}

export interface NativeTarget {
  ref?: string | null;
  selector?: string | null;
}

export interface ClickOptions extends NativeTarget {
  human?: boolean;
  force?: boolean;
  modifiers?: number;
}

export interface FillOptions extends NativeTarget {
  noClear?: boolean;
}

export interface HoverOptions extends NativeTarget {
  human?: boolean;
  steps?: number;
}

export interface DragOptions extends NativeTarget {
  to?: BackendTargetDescriptor | null;
  dx?: number;
  dy?: number;
  steps?: number;
  modifiers?: number;
}

const NON_FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color', 'hidden',
]);

function numberOr(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pointOf(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const x = Number(record['x']);
  const y = Number(record['y']);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * 动作层可信输入桥。
 *
 * 所有方法返回 `null` 表示「无法/不宜走 CDP」——调用方必须回退内容脚本路径
 * （不伪造成功）；抛错表示权威失败（遮挡 E_OCCLUDED、CDP 中途错误）。
 */
export class ActionInputBridge {
  private readonly input: TrustedInputPort;
  private readonly locator: BackendNodeLocatorPort;
  private readonly clock: TrustedInputClock | null;
  private readonly now: () => number;

  constructor(options: ActionInputBridgeOptions) {
    if (!options || !options.input || !options.locator) throw new TypeError('ActionInputBridge 需要 input 与 locator');
    this.input = options.input;
    this.locator = options.locator;
    this.clock = options.clock ?? null;
    this.now = options.now ?? Date.now;
  }

  /** 两个依赖都在才可路由。 */
  static from(options: {
    input?: TrustedInputPort | null;
    locator?: BackendNodeLocatorPort | null;
    clock?: TrustedInputClock | null;
    now?: () => number;
  } | null | undefined): ActionInputBridge | null {
    if (!options || !options.input || !options.locator) return null;
    return new ActionInputBridge({
      input: options.input,
      locator: options.locator,
      clock: options.clock ?? sharedTrustedInputClock,
      now: options.now,
    });
  }

  available(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // click
  // -------------------------------------------------------------------------

  /**
   * 可信点击：定位 → 命中/遮挡 fail-closed → CDP 节点路由点击。
   * 返回 null 时调用方回退内容脚本（未派发任何事件）。
   */
  async click(tabId: number, target: BackendTargetDescriptor, options: ClickOptions = {}): Promise<Record<string, unknown> | null> {
    const hit = await this.locate(tabId, target);
    if (!hit) return null;
    const point = await this.locator.point(tabId, hit.backendNodeId, { scroll: true }).catch(() => null);
    if (!point || point.width < 1 || point.height < 1 || point.connected === false) return null;
    const test = options.force === true ? null : await this.safeHitTest(tabId, hit, point);
    if (test && test.relation === 'obstructed') {
      throw new RpcMethodError('E_OCCLUDED', '点击点被其它元素遮挡，拒绝点击（可用 --force 跳过）', {
        reason: 'obstructed',
        x: point.x,
        y: point.y,
        hitTag: test.occludedBy?.tag ?? null,
        hitId: test.occludedBy?.id ?? null,
        occludedBy: test.occludedBy,
        target: { ref: options.ref ?? target.ref ?? null, selector: options.selector ?? target.selector ?? null },
        effect_state: 'none',
        dispatched: false,
        inputMode: 'cdp-input',
      });
    }
    let clicked: Record<string, unknown>;
    try {
      clicked = await this.input.clickBackendNode(tabId, hit.backendNodeId, {
        human: options.human === true,
        ...(Number.isInteger(options.modifiers) && Number(options.modifiers) > 0 ? { modifiers: Number(options.modifiers) } : {}),
      });
    } catch (error) {
      if (isCdpPreDispatchError(error)) return null;
      throw error;
    }
    this.clock?.note(tabId, 'pointer');
    const via = hit.inClosedShadow ? 'closed-shadow-ref' : 'cdp-backend';
    const x = numberOr(clicked['x'], point.x);
    const y = numberOr(clicked['y'], point.y);
    return {
      ok: true,
      ref: options.ref ?? target.ref ?? null,
      selector: options.selector ?? target.selector ?? null,
      tag: String(clicked['tag'] ?? hit.tag ?? ''),
      x,
      y,
      via,
      hit: test?.relation ?? 'self',
      isConnected: true,
      trusted: true,
      synthetic: false,
      human: options.human === true,
      effectState: 'committed',
      backendNodeId: hit.backendNodeId,
      inputMode: 'cdp-input',
      evidence: {
        inputMode: 'cdp-input',
        trustedRequested: true,
        backendNodeId: hit.backendNodeId,
        moves: Number.isFinite(Number(clicked['moves'])) ? Number(clicked['moves']) : null,
        inClosedShadow: hit.inClosedShadow,
        at: this.now(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // hover
  // -------------------------------------------------------------------------

  async hover(tabId: number, target: BackendTargetDescriptor, options: HoverOptions = {}): Promise<Record<string, unknown> | null> {
    const hit = await this.locate(tabId, target);
    if (!hit) return null;
    const point = await this.locator.point(tabId, hit.backendNodeId, { scroll: true }).catch(() => null);
    if (!point || point.connected === false) return null;
    let hovered: Record<string, unknown>;
    try {
      hovered = await this.input.hoverPoint(tabId, { x: point.x, y: point.y }, {
        human: options.human === true,
        steps: Math.max(3, Math.min(24, Math.floor(Number(options.steps) || (options.human === true ? 5 : 3)))),
      });
    } catch (error) {
      if (isCdpPreDispatchError(error)) return null;
      throw error;
    }
    return {
      ok: true,
      via: 'cdp-input',
      trusted: true,
      synthetic: false,
      human: options.human === true,
      tag: hit.tag,
      ref: options.ref ?? target.ref ?? null,
      selector: options.selector ?? target.selector ?? null,
      x: point.x,
      y: point.y,
      targetTag: hit.tag,
      moves: numberOr(hovered['moves'], 1),
      generated: numberOr(hovered['moves'], 1),
      effectState: 'none',
      backendNodeId: hit.backendNodeId,
      inputMode: 'cdp-input',
      evidence: {
        inputMode: 'cdp-input',
        trustedRequested: true,
        backendNodeId: hit.backendNodeId,
        at: this.now(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // fill
  // -------------------------------------------------------------------------

  /**
   * 可信填写：定位 → 可填写性预检 → 聚焦（可信点击）→ 全选/定位光标 → insertText
   * → 读回校验（matches 如实上报）。
   *
   * 不可填写（checkbox/file/disabled/readonly/非表单元素）时返回 null，让内容脚本给出
   * 原口径的 E_NOT_ACTIONABLE（错误语义不因换路径而漂移）。
   */
  async fill(tabId: number, target: BackendTargetDescriptor, value: string, options: FillOptions = {}): Promise<Record<string, unknown> | null> {
    const hit = await this.locate(tabId, target);
    if (!hit) return null;
    const before = await this.locator.describeValue(tabId, hit.backendNodeId).catch(() => null);
    if (!before || !before.editable || before.disabled || before.readOnly) return null;
    if (before.tag === 'input' && NON_FILLABLE_INPUT_TYPES.has(before.type.toLowerCase())) return null;
    const point = await this.locator.point(tabId, hit.backendNodeId, { scroll: true }).catch(() => null);
    if (!point || point.width < 1 || point.height < 1) return null;
    try {
      // 聚焦走可信点击（与真人路径一致）；press 才用 DOM.focus，不用点击代替。
      await this.input.clickBackendNode(tabId, hit.backendNodeId, { human: false });
      if (options.noClear === true) {
        await this.moveCaretToEnd(tabId, hit.backendNodeId);
      } else {
        await this.input.selectAll(tabId);
      }
      await this.input.insertText(tabId, String(value ?? ''));
    } catch (error) {
      if (isCdpPreDispatchError(error)) return null;
      throw error;
    }
    const after = await this.locator.describeValue(tabId, hit.backendNodeId).catch(() => null);
    const expected = options.noClear === true ? before.value + String(value ?? '') : String(value ?? '');
    const actual = after ? after.value : '';
    const matches = after !== null && actual === expected;
    this.clock?.note(tabId, 'input');
    return {
      ok: true,
      ref: options.ref ?? target.ref ?? null,
      selector: options.selector ?? target.selector ?? null,
      tag: before.tag,
      expected_value: expected,
      actual_value: actual,
      matches,
      cleared: options.noClear !== true,
      via: 'cdp-input',
      trusted: true,
      synthetic: false,
      effectState: matches ? 'committed' : 'unknown',
      backendNodeId: hit.backendNodeId,
      inputMode: 'cdp-input',
      evidence: {
        inputMode: 'cdp-input',
        trustedRequested: true,
        backendNodeId: hit.backendNodeId,
        verified: after !== null,
        at: this.now(),
      },
    };
  }

  private async moveCaretToEnd(tabId: number, backendNodeId: number): Promise<void> {
    // 追加语义：先把光标放到末尾，再 insertText；拿不到光标位置时不阻塞（matches 会如实反映）。
    try {
      await this.locator.caretToEnd(tabId, backendNodeId);
    } catch {
      // 忽略：insertText 仍会插入到当前光标处，matches 如实上报
    }
  }

  // -------------------------------------------------------------------------
  // press
  // -------------------------------------------------------------------------

  /**
   * 可信按键：可选目标用 DOM.focus（不派发 pointer 事件，23h4 的语义），再 keyDown/keyUp。
   */
  async press(tabId: number, key: string, target: BackendTargetDescriptor | null = null): Promise<Record<string, unknown> | null> {
    let focusedHit: BackendNodeHit | null = null;
    if (target) {
      focusedHit = await this.locate(tabId, target);
      if (!focusedHit) return null;
      try {
        await this.locator.focus(tabId, focusedHit.backendNodeId);
      } catch (error) {
        if (isCdpPreDispatchError(error)) return null;
        throw error;
      }
    }
    let pressed: Record<string, unknown>;
    try {
      pressed = await this.input.pressKey(tabId, key);
    } catch (error) {
      if (isCdpPreDispatchError(error)) return null;
      throw error;
    }
    this.clock?.note(tabId, 'keydown');
    return {
      ok: true,
      via: 'cdp-input',
      trusted: true,
      synthetic: false,
      key: String(pressed['key'] ?? key),
      code: String(pressed['code'] ?? ''),
      tag: focusedHit?.tag ?? null,
      ref: target?.ref ?? null,
      selector: target?.selector ?? null,
      x: null,
      y: null,
      targetTag: focusedHit?.tag ?? null,
      generated: 2,
      effectState: 'committed',
      backendNodeId: focusedHit?.backendNodeId ?? null,
      inputMode: 'cdp-input',
      evidence: {
        inputMode: 'cdp-input',
        trustedRequested: true,
        focused: focusedHit !== null,
        at: this.now(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // drag
  // -------------------------------------------------------------------------

  /**
   * 可信拖拽：起点/终点各自定位（目标式 --to）或 dx/dy 位移，CDP 按住移动释放。
   * pointerdown/pointerup 由浏览器输入管线产生（16/16b 的 dropped+ctrl+shift 依赖修饰键）。
   */
  async drag(tabId: number, from: BackendTargetDescriptor, options: DragOptions = {}): Promise<Record<string, unknown> | null> {
    const fromHit = await this.locate(tabId, from);
    if (!fromHit) return null;
    let fromPoint = await this.locator.point(tabId, fromHit.backendNodeId, { scroll: true }).catch(() => null);
    if (!fromPoint || fromPoint.width < 1 || fromPoint.height < 1) return null;
    let toHit: BackendNodeHit | null = null;
    let toPoint: { x: number; y: number } | null = null;
    if (options.to) {
      toHit = await this.locate(tabId, options.to);
      if (!toHit) return null;
      const targetPoint = await this.locator.point(tabId, toHit.backendNodeId, { scroll: true }).catch(() => null);
      if (!targetPoint) return null;
      toPoint = { x: targetPoint.x, y: targetPoint.y };
      // 滚动到终点可能移动了起点：重新取一次起点坐标（不再滚动）。
      const refreshed = await this.locator.point(tabId, fromHit.backendNodeId, { scroll: false }).catch(() => null);
      if (refreshed) fromPoint = refreshed;
    } else {
      const dx = numberOr(options.dx, 0);
      const dy = numberOr(options.dy, 0);
      if (dx === 0 && dy === 0) return null;
      toPoint = { x: fromPoint.x + dx, y: fromPoint.y + dy };
    }
    const steps = Math.max(2, Math.min(32, Math.floor(Number(options.steps) || 8)));
    let dragged: Record<string, unknown>;
    try {
      dragged = await this.input.dragPath(tabId, { x: fromPoint.x, y: fromPoint.y }, toPoint, {
        steps,
        ...(Number.isInteger(options.modifiers) && Number(options.modifiers) > 0 ? { modifiers: Number(options.modifiers) } : {}),
      });
    } catch (error) {
      if (isCdpPreDispatchError(error)) return null;
      throw error;
    }
    this.clock?.note(tabId, 'pointer');
    return {
      ok: true,
      via: 'cdp-input',
      trusted: true,
      synthetic: false,
      mode: 'hold',
      tag: fromHit.tag,
      ref: options.ref ?? null,
      selector: options.selector ?? null,
      x: fromPoint.x,
      y: fromPoint.y,
      from: { x: fromPoint.x, y: fromPoint.y },
      to: { x: toPoint.x, y: toPoint.y },
      steps: numberOr(dragged['steps'], steps),
      points: numberOr(dragged['steps'], steps),
      targetTag: toHit?.tag ?? null,
      effectState: 'committed',
      inputMode: 'cdp-input',
      evidence: {
        inputMode: 'cdp-input',
        trustedRequested: true,
        fromBackendNodeId: fromHit.backendNodeId,
        toBackendNodeId: toHit?.backendNodeId ?? null,
        at: this.now(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async locate(tabId: number, target: BackendTargetDescriptor | null | undefined): Promise<BackendNodeHit | null> {
    if (!target || typeof target !== 'object') return null;
    try {
      return await this.locator.locate(tabId, target);
    } catch {
      return null;
    }
  }

  private async safeHitTest(tabId: number, hit: BackendNodeHit, point: NodePoint): Promise<HitTestResult | null> {
    try {
      const result = await this.locator.hitTest(tabId, { backendNodeId: hit.backendNodeId, nodeId: hit.nodeId }, { x: point.x, y: point.y });
      if (!result) return null;
      // unknown：命中测试拿不到权威结论（旧 CDP/受限页面）→ 不阻断（不谎报遮挡）。
      if (result.relation === 'unknown') return null;
      return result;
    } catch {
      return null;
    }
  }
}

/** 便捷工厂（background 注入用）。 */
export function createActionInputBridge(options: {
  input?: TrustedInputPort | null;
  locator?: BackendNodeLocatorPort | null;
  clock?: TrustedInputClock | null;
  now?: () => number;
}): ActionInputBridge | null {
  return ActionInputBridge.from(options);
}

/** 修饰键名数组 → Input.dispatchMouseEvent 的 bit 掩码（alt=1/ctrl=2/meta=4/shift=8）。 */
export function modifiersToBits(modifiers: readonly string[] | unknown): number {
  const list = Array.isArray(modifiers) ? modifiers.map((item) => String(item).toLowerCase()) : [];
  let bits = 0;
  for (const token of list) {
    if (token === 'alt' || token === 'option') bits |= 1;
    else if (token === 'ctrl' || token === 'control') bits |= 2;
    else if (token === 'meta' || token === 'cmd' || token === 'win') bits |= 4;
    else if (token === 'shift') bits |= 8;
  }
  return bits;
}

/** 便捷：把 input 服务的 CDP 错误暴露给单测断言（不引入额外类型依赖）。 */
export function isFallbackError(error: unknown): boolean {
  return isCdpChannelError(error);
}

/** 坐标点提取（测试/诊断用）。 */
export function trustedPointOf(value: unknown): { x: number; y: number } | null {
  return pointOf(value);
}
