// src/actions/extended.ts —— M-C 第三批扩展动作面：只读事实、薄动作、结构化提取与等待。
//
// 与 src/actions/registry.ts（第二批的 observe/click/fill/read/select/get-html/evaluate）
// 的分工：
// - 这一层只注册**第三批**新增的方法：scroll-to / hover / focus / press / wheel / blur /
//   drag / click-point / snapshot / actionable / extract 家族 / wait-* / cancel /
//   operation.cancel / request-help / cooperate.*（最小实现）；
// - 参数校验、feature gate、ref 生命周期、错误映射与第二批同一套语义（复用 params.ts 的
//   别名表与 refs 注册表），所以 daemon 看到的错误码不会因为方法换了实现层而变化；
// - 结果字段按 CLI/E2E 契约补齐（例如 wait-for-element 的 satisfied/timedOut/elapsedMs、
//   extract 的 rowCount/columns/rows/budget/cursor）。
//
// 不使用 chrome.debugger：所有页面动作都是内容脚本里的合成事件，证据里 via:'content-script'
// 与 trusted:false 如实标注；等待类方法通过 AbortController 支持 daemon 的 cancel 帧。

import {
  assertProtocolCompatible,
  type ProtocolPeer,
} from '../protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { RpcMethodError } from '../rpc/registry.ts';
import { RefRegistry, type RefExpectation } from '../refs/index.ts';
import { makeCdpSessionId } from '../refs/registry.ts';
import {
  makeContentRequest,
  normalizeContentReply,
  type ContentReply,
  type ContentRequest,
  type ContentExtractPayload,
  type ContentScrollResult,
  type ContentThinActionResult,
} from '../content/protocol.ts';
import { applyParamAliases, normalizeTarget, type NormalizedTarget } from './params.ts';
import { newObservationId, toObserveActionResult } from './observation.ts';
import { normalizeSignatures, ReceiptStore } from './receipts.ts';
import {
  ActionInputBridge,
  modifiersToBits,
  sharedTrustedInputClock,
  type TrustedInputClock,
  type TrustedInputPort,
} from './trusted-input.ts';
import type { BackendNodeLocatorPort, BackendTargetDescriptor } from './backend-locator.ts';

/** 内容脚本传输的最小形状（与 ActionContentTransport 同义；单独声明避免循环依赖）。 */
export interface ExtendedContentTransport {
  request(tabId: number, request: ContentRequest, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ContentReply>;
}

/** 截图 capture（click-point 需要：图像像素 → 页面坐标）。 */
export interface CaptureRecordView {
  id: string;
  tabId: number;
  scale: number;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  at: number;
}

export interface CaptureLookup {
  /** 单次消费：取走 capture（同一张图只允许派发一次坐标动作）。 */
  consume(id: string): CaptureRecordView | null;
}

export interface ExtendedRegistryOptions {
  content: ExtendedContentTransport;
  refs?: RefRegistry;
  peer?: ProtocolPeer;
  now?: () => number;
  random?: () => number;
  defaultTimeoutMs?: number;
  captures?: CaptureLookup | null;
  /** settings 读取（request-help 的 allowHelp 开关）。 */
  readSettings?: (() => Promise<{ allowHelp?: boolean }>) | null;
  /** per-tab 策略授权（cooperate.sync 的 authority.four.action 使用）。 */
  authorize?: ((tabId: number, method: string) => { ok: true } | { ok: false; code: string; message: string; data?: unknown }) | null;
  /** 观察收据/context（cooperate.sync 换发 context 与 observation 收据）。 */
  receipts?: ReceiptStore | null;
  /** 人工接管 hold 闸门状态（cooperate.hold 使用，动作侧由 background authorize 拒绝）。 */
  control?: { isHeld(tabId: number): boolean; setHeld(tabId: number, held: boolean): void } | null;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 可信输入（20z）：CDP Input 原语；与 backend 同时可用才路由。 */
  input?: TrustedInputPort | null;
  /** CDP DOM 节点定位器（backend-locator.ts）。 */
  backend?: BackendNodeLocatorPort | null;
  /** 原生输入归因时钟（缺省共享实例；cooperate.sync 取走增量）。 */
  inputClock?: TrustedInputClock | null;
}

export interface ExtendedDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

/** 方法清单（注册到 router 的顺序即这里的顺序）。 */
export const EXTENDED_METHODS: readonly string[] = Object.freeze([
  'scroll-to',
  'hover',
  'focus',
  'press',
  'wheel',
  'blur',
  'drag',
  'click-point',
  'snapshot',
  'actionable',
  'extract',
  'extract.discover',
  'extract.table',
  'extract.list',
  'wait-ms',
  'wait-for-element',
  'wait-for-navigation',
  'cancel',
  'operation.cancel',
  'request-help',
  'cooperate.sync',
  'cooperate.wait',
  'cooperate.handback',
  'cooperate.hold',
]);

const METHOD_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'scroll-to': '滚动到目标元素/坐标，返回元素边界与视口',
  hover: '悬停目标：合成 mouseover/mouseenter/mousemove',
  focus: '聚焦目标元素（缺省 body）',
  press: '向目标派发键盘 keydown/keypress/keyup',
  wheel: '在目标/窗口派发 wheel 并滚动',
  blur: '取消当前焦点（blur/focusout）',
  drag: '从目标中心按 dx/dy 派发合成拖拽序列',
  'click-point': '按截图 capture 的图像坐标换算页面坐标并点击',
  snapshot: '页面快照文本（带 @eN ref，并重建 ref 表）',
  actionable: '查询目标是否可操作（attached/visible/enabled）',
  extract: '提取当前页面表格/列表（默认最大表格）',
  'extract.discover': '发现可导出的表格/列表目标',
  'extract.table': '按 target/selector/ref 提取表格',
  'extract.list': '按 selector/ref + itemSelector 提取列表',
  'wait-ms': '等待指定毫秒（可被 cancel 中止）',
  'wait-for-element': '等待元素满足状态（attached/visible/hidden/detached，可取消）',
  'wait-for-navigation': '等待页面导航（URL/document 变化）',
  cancel: 'daemon 取消转发：按 rpc_id 中止一个进行中的等待',
  'operation.cancel': '按 operationId 取消等待',
  'request-help': '请求人工协助（allowHelp 关闭时明确拒绝）',
  'cooperate.sync': '协作同步：页面观察 + 四类权威快照（最小实现）',
  'cooperate.wait': '协作等待：轮询人类是否在操作（最小实现）',
  'cooperate.handback': '人工交回控制权',
  'cooperate.hold': '请求人工接管（最小实现）',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireTabId(params: Record<string, unknown>): number {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new RpcMethodError('E_BAD_ARG', '扩展动作需要整数 tabId（由 daemon 按会话注入）', { tabId: params.tabId ?? null });
  }
  return tabId;
}

function optionalInteger(params: Record<string, unknown>, key: string, min: number): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new RpcMethodError('E_BAD_ARG', key + ' 必须是 ≥' + String(min) + ' 的整数', { [key]: raw });
  }
  return value;
}

/** 方法是否需要“恰好一个目标”。 */
const TARGET_METHODS: ReadonlySet<string> = new Set(['hover', 'press', 'drag', 'focus', 'blur', 'scroll-to', 'wheel', 'actionable', 'click-point', 'press']);

/** 只读方法（feature gate 与只读策略都用同一分类）。 */
const READONLY_METHODS: ReadonlySet<string> = new Set([
  'scroll-to', 'hover', 'focus', 'press', 'wheel', 'blur', 'drag', 'click-point',
  'snapshot', 'actionable', 'extract', 'extract.discover', 'extract.table', 'extract.list',
  'wait-ms', 'wait-for-element', 'wait-for-navigation', 'cancel', 'operation.cancel',
  'request-help', 'cooperate.sync', 'cooperate.wait', 'cooperate.handback', 'cooperate.hold',
]);

/** extract 的默认预算（与 JS 提取器的上限口径一致）。 */
const EXTRACT_DEFAULTS = Object.freeze({ maxRows: 200, maxCells: 20_000, maxBytes: 1_000_000 });

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, method: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcMethodError('E_TIMEOUT', '扩展动作 ' + method + ' 超时（' + String(timeoutMs) + 'ms）', { method }));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface PendingOperation {
  controller: AbortController;
  method: string;
  at: number;
}

/** wait-for-element 轮询时用到的元素状态子集。 */
interface WaitElementView {
  attached?: boolean;
  visible?: boolean;
  rect?: { width: number; height: number };
}

/**
 * 第三批扩展动作注册表。
 *
 * ```ts
 * const registry = new ExtendedActionRegistry({ content, refs });
 * await registry.dispatch('extract.discover', { tabId: 7 });
 * await registry.dispatch('wait-for-element', { tabId: 7, selector: '#out', state: 'visible', timeoutMs: 2000 });
 * ```
 */
export class ExtendedActionRegistry {
  readonly refs: RefRegistry;
  private readonly content: ExtendedContentTransport;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly captures: CaptureLookup | null;
  private readonly readSettings: (() => Promise<{ allowHelp?: boolean }>) | null;
  private readonly authorize: ((tabId: number, method: string) => { ok: true } | { ok: false; code: string; message: string; data?: unknown }) | null;
  private readonly receipts: ReceiptStore | null;
  private readonly control: { isHeld(tabId: number): boolean; setHeld(tabId: number, held: boolean): void } | null;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly inputBridge: ActionInputBridge | null;
  private readonly inputClock: TrustedInputClock;
  /** cooperate.sync 的控制策略是会话级固定值（只有显式 --policy 才换，见 23w）。 */
  private readonly controlPolicy = new Map<number, 'auto' | 'strict' | 'target'>();
  private peerValue: ProtocolPeer;
  private readonly methodsValue: readonly string[];
  private readonly specs = new Map<string, { method: string; description: string; mutating: boolean; timeoutMs: number }>();
  private readonly pending = new Map<string, PendingOperation>();
  private readonly operations = new Map<string, PendingOperation>();
  private readonly cooperation = new Map<number, { generation: number; revision: number; controlRevision: number; authorityRevision: number }>();

  constructor(options: ExtendedRegistryOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('ExtendedActionRegistry 需要一个 content transport（request 方法）');
    }
    this.content = options.content;
    this.refs = options.refs ?? new RefRegistry({ now: options.now ?? Date.now });
    this.peerValue = options.peer ?? { protocol: PROTOCOL_VERSION };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.defaultTimeoutMs = Number(options.defaultTimeoutMs) > 0 ? Math.floor(Number(options.defaultTimeoutMs)) : DEFAULT_TIMEOUT_MS;
    this.captures = options.captures ?? null;
    this.readSettings = options.readSettings ?? null;
    this.authorize = options.authorize ?? null;
    this.receipts = options.receipts ?? null;
    this.control = options.control ?? null;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.inputClock = options.inputClock ?? sharedTrustedInputClock;
    this.inputBridge = ActionInputBridge.from({
      input: options.input ?? null,
      locator: options.backend ?? null,
      clock: this.inputClock,
      now: this.now,
    });
    this.methodsValue = EXTENDED_METHODS;
    for (const method of EXTENDED_METHODS) {
      this.specs.set(method, {
        method,
        description: METHOD_DESCRIPTIONS[method] ?? '',
        mutating: !READONLY_METHODS.has(method),
        timeoutMs: method === 'wait-for-element' || method === 'wait-for-navigation' ? 60_000 : this.defaultTimeoutMs,
      });
    }
  }

  methods(): string[] {
    return [...this.methodsValue];
  }

  specsList(): Array<{ method: string; description: string; mutating: boolean; timeoutMs: number }> {
    return [...this.specs.values()];
  }

  has(method: unknown): boolean {
    return typeof method === 'string' && this.specs.has(method);
  }

  setPeer(peer: ProtocolPeer | null | undefined): void {
    this.peerValue = peer ?? {};
  }

  /** 进行中的等待操作数（诊断用）。 */
  pendingCount(): number {
    return this.pending.size + this.operations.size;
  }

  /** 进行中的 operationId（诊断用）。 */
  pendingOperationIds(): string[] {
    return [...this.operations.keys()];
  }

  /**
   * 分派一个扩展方法。
   *
   * @throws RpcMethodError 参数/ref/内容脚本业务错误
   * @throws ProtocolError feature gate 拒绝
   */
  async dispatch(method: string, rawParams: unknown, options: ExtendedDispatchOptions = {}): Promise<unknown> {
    const spec = this.specs.get(method);
    if (!spec) {
      throw new RpcMethodError('E_UNKNOWN_METHOD', '扩展未实现命令：' + String(method), { method: String(method) });
    }
    const aliased = applyParamAliases(method, rawParams);
    const params = aliased.params;
    assertProtocolCompatible(this.peerValue, method, params);
    const timeoutMs = options.timeoutMs ?? spec.timeoutMs;
    switch (method) {
      case 'scroll-to':
        return this.scrollTo(params, options);
      case 'hover':
        return this.thin(params, 'hover', options);
      case 'focus':
        return this.thin(params, 'focus', options);
      case 'blur':
        return this.thin(params, 'blur', options);
      case 'press':
        return this.press(params, options);
      case 'wheel':
        return this.wheel(params, options);
      case 'drag':
        return this.drag(params, options);
      case 'click-point':
        return this.clickPoint(params, options);
      case 'snapshot':
        return this.snapshot(params, options);
      case 'actionable':
        return this.actionable(params, options);
      case 'extract':
        return this.extract(params, 'extract', options);
      case 'extract.discover':
        return this.extract(params, 'discover', options);
      case 'extract.table':
        return this.extract(params, 'table', options);
      case 'extract.list':
        return this.extract(params, 'list', options);
      case 'wait-ms':
        return this.waitMs(params, options);
      case 'wait-for-element':
        return this.waitForElement(params, options, timeoutMs);
      case 'wait-for-navigation':
        return this.waitForNavigation(params, options, timeoutMs);
      case 'cancel':
        return this.cancelByRpcId(params);
      case 'operation.cancel':
        return this.cancelByOperationId(params);
      case 'request-help':
        return this.requestHelp(params);
      case 'cooperate.sync':
        return this.cooperateSync(params, options);
      case 'cooperate.wait':
        return this.cooperateWait(params);
      case 'cooperate.handback':
        return this.cooperateHandback(params);
      case 'cooperate.hold':
        return this.cooperateHold(params);
      default:
        throw new RpcMethodError('E_UNKNOWN_METHOD', '扩展未实现命令：' + method, { method });
    }
  }

  // -------------------------------------------------------------------------
  // 目标与内容脚本调用
  // -------------------------------------------------------------------------

  private normalTarget(params: Record<string, unknown>): NormalizedTarget {
    return normalizeTarget(params);
  }

  /**
   * 目标 → 内容脚本参数（ref/selector/text + documentId/expectRevision）。
   * stableRef 在 background 注册表里解析成 @eN；解析失败回 E_STALE_REF。
   */
  private targetParams(tabId: number, target: NormalizedTarget, params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let ref = target.ref;
    if (!ref && target.stableRef) {
      const byStable = this.refs.getByStableRef(tabId, target.stableRef);
      if (!byStable) {
        throw new RpcMethodError('E_STALE_REF', 'stableRef 不在当前观察里，请重新 observe', { stableRef: target.stableRef });
      }
      ref = byStable.ref;
    }
    if (ref) {
      const expectation: RefExpectation = {};
      const expectRevision = Number(params.expectRevision);
      if (Number.isInteger(expectRevision)) expectation.revision = expectRevision;
      const resolved = this.refs.resolve(tabId, ref, expectation);
      if (!resolved.ok) {
        throw new RpcMethodError(resolved.code, resolved.message, { ref, reason: resolved.reason });
      }
      out.ref = ref;
      out.documentId = resolved.meta.key.documentId;
      if (Number.isInteger(expectRevision)) out.expectRevision = expectRevision;
      return out;
    }
    if (target.selector) out.selector = target.selector;
    if (target.text) out.text = target.text;
    const expectRevision = Number(params.expectRevision);
    if (Number.isInteger(expectRevision)) out.expectRevision = expectRevision;
    return out;
  }

  /**
   * ref/stableRef → CDP 节点描述符（内容脚本 element-state 提供 tag/id/role/name）。
   * selector 目标直接返回 selector；文本目标（--text）不走 CDP。
   * 返回 null 时调用方回退内容脚本路径。
   */
  private async nativeDescriptor(
    tabId: number,
    contentParams: Record<string, unknown>,
    selector: string | null,
    options: ExtendedDispatchOptions,
  ): Promise<BackendTargetDescriptor | null> {
    const ref = typeof contentParams.ref === 'string' && contentParams.ref ? contentParams.ref : '';
    if (ref) {
      let view: Record<string, unknown> | null = null;
      try {
        const result = await this.callContent(tabId, 'element-state', contentParams, options, 5000);
        view = isRecord(result) ? result : null;
      } catch {
        view = null;
      }
      if (!view) return null;
      return {
        ref,
        tag: typeof view.tag === 'string' && view.tag ? view.tag : null,
        id: typeof view.id === 'string' && view.id ? view.id : null,
        role: typeof view.role === 'string' && view.role ? view.role : null,
        name: typeof view.name === 'string' && view.name ? view.name : null,
      };
    }
    if (selector) return { selector };
    return null;
  }

  private async callContent(    tabId: number,
    op: ContentRequest['op'],
    contentParams: Record<string, unknown>,
    options: ExtendedDispatchOptions,
    timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs,
  ): Promise<unknown> {
    const request = makeContentRequest(op, contentParams, options.requestId ?? ('ext-' + op + '-' + String(tabId) + '-' + Math.floor(this.now()).toString(36)));
    const reply = await withTimeout(
      this.content.request(tabId, request, {
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      timeoutMs,
      op,
    );
    const normalized = normalizeContentReply(reply);
    if (!normalized.ok) throw new RpcMethodError(normalized.code, normalized.message, normalized.data);
    return normalized.result;
  }

  // -------------------------------------------------------------------------
  // 薄动作
  // -------------------------------------------------------------------------

  private async scrollTo(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const target = this.normalTarget(params);
    const contentParams: Record<string, unknown> = {};
    const hasTarget = Boolean(target.ref || target.selector || target.stableRef || target.text);
    if (hasTarget) Object.assign(contentParams, this.targetParams(tabId, target, params));
    const x = optionalInteger(params, 'x', -1_000_000);
    const y = optionalInteger(params, 'y', -1_000_000);
    if (x !== undefined) contentParams.x = x;
    if (y !== undefined) contentParams.y = y;
    if (!hasTarget && x === undefined && y === undefined) {
      throw new RpcMethodError('E_BAD_ARG', 'scroll-to 需要 ref/selector/text 或 x/y');
    }
    const result = await this.callContent(tabId, 'scroll', contentParams, options) as ContentScrollResult;
    return result;
  }

  private async thin(params: Record<string, unknown>, op: 'hover' | 'focus' | 'blur', options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const target = this.normalTarget(params);
    const hasTarget = Boolean(target.ref || target.selector || target.stableRef || target.text);
    if (hasTarget === false && op !== 'focus' && op !== 'blur') {
      throw new RpcMethodError('E_BAD_ARG', op + ' 需要 ref/selector/text 目标');
    }
    // 20z：hover --trusted 走 CDP 可信 mousemove（antibot 需要 ≥3 次 isTrusted mousemove）。
    if (op === 'hover' && this.inputBridge && params.trusted === true && hasTarget && !target.text) {
      const routed = await this.tryTrustedHover(tabId, target, params, options);
      if (routed) return routed;
    }
    const contentParams: Record<string, unknown> = hasTarget ? this.targetParams(tabId, target, params) : {};
    const result = await this.callContent(tabId, op, contentParams, options) as ContentThinActionResult;
    return { ...result, effectState: 'none' };
  }

  /** 可信悬停：内容脚本 element-state 取描述符 → CDP 节点定位 → hoverPoint。 */
  private async tryTrustedHover(
    tabId: number,
    target: NormalizedTarget,
    params: Record<string, unknown>,
    options: ExtendedDispatchOptions,
  ): Promise<Record<string, unknown> | null> {
    const bridge = this.inputBridge;
    if (!bridge) return null;
    const contentParams = this.targetParams(tabId, target, params);
    const descriptor = await this.nativeDescriptor(tabId, contentParams, target.selector, options);
    if (!descriptor) return null;
    return bridge.hover(tabId, descriptor, {
      ref: contentParams.ref as string | undefined ?? null,
      selector: target.selector,
      human: params.human === true,
    });
  }

  private async press(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const key = typeof params.key === 'string' ? params.key.trim() : '';
    if (!key) throw new RpcMethodError('E_BAD_ARG', 'press 需要非空 key');
    const target = this.normalTarget(params);
    const hasTarget = Boolean(target.ref || target.selector || target.stableRef || target.text);
    const contentParams: Record<string, unknown> = { key };
    if (hasTarget) Object.assign(contentParams, this.targetParams(tabId, target, params));
    // 20z：press --trusted 走 CDP 可信按键；有目标时用 DOM.focus 聚焦（不派发 pointer 事件，
    // 23h4 依赖这一点：press --ref 不应产生点击）。
    if (this.inputBridge && params.trusted === true) {
      const descriptor = hasTarget && !target.text
        ? await this.nativeDescriptor(tabId, contentParams, target.selector, options)
        : null;
      if (!hasTarget || descriptor) {
        const routed = await this.inputBridge.press(tabId, key, descriptor);
        if (routed) return routed;
      }
    }
    const result = await this.callContent(tabId, 'press', contentParams, options) as ContentThinActionResult;
    return { ...result, effectState: 'committed' };
  }

  private async wheel(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const deltaX = Number(params.deltaX ?? 0);
    const deltaY = Number(params.deltaY ?? 0);
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new RpcMethodError('E_BAD_ARG', 'wheel 需要数值 deltaX/deltaY');
    const target = this.normalTarget(params);
    const hasTarget = Boolean(target.ref || target.selector || target.stableRef || target.text);
    const contentParams: Record<string, unknown> = { deltaX, deltaY };
    if (hasTarget) Object.assign(contentParams, this.targetParams(tabId, target, params));
    const result = await this.callContent(tabId, 'wheel', contentParams, options) as ContentThinActionResult;
    return { ...result, effectState: 'committed' };
  }

  private async drag(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    // CLI drag 的起点走 `from`（目标对象），也接受直接给 ref/selector；`to` 只用作终点语义，
    // 本实现的合成拖拽按 dx/dy 位移派发（没有原生输入通道，不做惯性/多点轨迹）。
    const source = isRecord(params.from) ? params.from : params;
    const target = this.normalTarget(source);
    if (!target.ref && !target.selector && !target.stableRef && !target.text) {
      throw new RpcMethodError('E_BAD_ARG', 'drag 需要 from（ref/selector）或直接的 ref/selector 目标', {
        from: params.from ?? null,
      });
    }
    const dx = Number(params.dx ?? 0);
    const dy = Number(params.dy ?? 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RpcMethodError('E_BAD_ARG', 'drag 需要数值 dx/dy');
    const toTarget = isRecord(params.to) ? this.normalTarget(params.to) : null;
    // CLI 的 --modifiers 是位掩码（alt=1/ctrl=2/meta=4/shift=8），也接受数组形式。
    const modifiers: string[] = (() => {
      const raw = params.modifiers;
      if (Array.isArray(raw)) return raw.map((item) => String(item).toLowerCase());
      const bits = Number(raw);
      if (!Number.isInteger(bits) || bits <= 0) return [];
      const names: string[] = [];
      if (bits & 1) names.push('alt');
      if (bits & 2) names.push('ctrl');
      if (bits & 4) names.push('meta');
      if (bits & 8) names.push('shift');
      return names;
    })();
    const contentParams: Record<string, unknown> = {
      ...this.targetParams(tabId, target, params),
      dx,
      dy,
      steps: optionalInteger(params, 'steps', 2) ?? 6,
      holdMs: optionalInteger(params, 'holdMs', 0) ?? 0,
      durationMs: optionalInteger(params, 'durationMs', 0) ?? 0,
      ...(toTarget && toTarget.selector ? { toSelector: toTarget.selector } : {}),
      ...(toTarget && toTarget.ref ? { toRef: toTarget.ref } : {}),
      ...(modifiers.length ? { modifiers } : {}),
    };
    // 20z：drag --trusted 走 CDP 可信鼠标序列（pointerdown/pointerup 由输入管线产生），
    // 终点用 --to 目标或 dx/dy 位移；任一目标定位失败就回退内容脚本。
    if (this.inputBridge && params.trusted === true && !target.text) {
      const routed = await this.tryTrustedDrag(tabId, target, toTarget, contentParams, { dx, dy, modifiers, options });
      if (routed) return routed;
    }
    const result = await this.callContent(tabId, 'drag', contentParams, options) as ContentThinActionResult;
    return {
      ...result,
      mode: 'hold',
      points: Number(result.steps ?? 0),
      effectState: 'committed',
    };
  }

  private async tryTrustedDrag(
    tabId: number,
    target: NormalizedTarget,
    toTarget: NormalizedTarget | null,
    contentParams: Record<string, unknown>,
    input: { dx: number; dy: number; modifiers: string[]; options: ExtendedDispatchOptions },
  ): Promise<Record<string, unknown> | null> {
    const bridge = this.inputBridge;
    if (!bridge) return null;
    const fromDescriptor = await this.nativeDescriptor(tabId, contentParams, target.selector, input.options);
    if (!fromDescriptor) return null;
    let toDescriptor: BackendTargetDescriptor | null = null;
    if (toTarget) {
      if (toTarget.text && !toTarget.ref && !toTarget.selector && !toTarget.stableRef) return null;
      const toParams = this.targetParams(tabId, toTarget, {});
      toDescriptor = await this.nativeDescriptor(tabId, toParams, toTarget.selector, input.options);
      if (!toDescriptor) return null;
    }
    return bridge.drag(tabId, fromDescriptor, {
      ref: fromDescriptor.ref ?? null,
      selector: target.selector,
      to: toDescriptor,
      dx: input.dx,
      dy: input.dy,
      steps: Number(contentParams.steps ?? 6),
      modifiers: modifiersToBits(input.modifiers),
    });
  }

  private async clickPoint(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const captureId = typeof params.capture === 'string' ? params.capture : '';
    if (!captureId) throw new RpcMethodError('E_BAD_ARG', 'click-point 需要 capture');
    const imageX = Number(params.imageX);
    const imageY = Number(params.imageY);
    if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) {
      throw new RpcMethodError('E_BAD_ARG', 'click-point 需要 imageX/imageY');
    }
    if (!this.captures) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时未启用截图 capture 存储，无法按图坐标点击');
    }
    const capture = this.captures.consume(captureId);
    if (!capture) throw new RpcMethodError('E_CAPTURE_STALE', 'capture 不存在或已过期，请重新截图', { capture: captureId });
    if (capture.tabId !== tabId) {
      throw new RpcMethodError('E_BAD_ARG', 'capture 属于另一个标签页', { capture: captureId, captureTabId: capture.tabId, tabId });
    }
    // 截图之后页面滚动过就作废：否则坐标会打到错误位置。
    const metrics = await this.callContent(tabId, 'metrics', {}, options) as { scrollX?: number; scrollY?: number };
    if (Math.abs(Number(metrics?.scrollX ?? 0) - capture.scrollX) > 1 || Math.abs(Number(metrics?.scrollY ?? 0) - capture.scrollY) > 1) {
      throw new RpcMethodError('E_CAPTURE_STALE', '截图后页面已滚动，capture 作废（请重新截图）', {
        capture: captureId,
        captureScroll: { x: capture.scrollX, y: capture.scrollY },
        currentScroll: { x: Number(metrics?.scrollX ?? 0), y: Number(metrics?.scrollY ?? 0) },
      });
    }
    const scale = capture.scale > 0 ? capture.scale : 1;
    const pageX = capture.scrollX + imageX / scale;
    const pageY = capture.scrollY + imageY / scale;
    const result = await this.callContent(tabId, 'click-point', { x: pageX, y: pageY }, options) as ContentThinActionResult;
    return {
      ...result,
      x: Math.round(pageX),
      y: Math.round(pageY),
      capture: captureId,
      effectState: 'committed',
    };
  }

  // -------------------------------------------------------------------------
  // 只读事实
  // -------------------------------------------------------------------------

  private async snapshot(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const result = await this.callContent(tabId, 'observe', { force: true }, options) as {
      url?: string;
      title?: string;
      observation?: string;
      refs?: number;
      revision?: number;
      documentId?: string;
      nodes?: Array<{ ref: string; role: string | null; name: string | null; tag: string; id: string | null }>;
    };
    const observationId = newObservationId(tabId, this.random);
    const { action, input } = toObserveActionResult(result as never, {
      tabId,
      observationId,
      random: this.random,
      context: { documentId: result?.documentId ?? null },
    });
    this.refs.registerObservation(tabId, input);
    return {
      ok: true,
      text: String(result?.observation ?? ''),
      url: String(result?.url ?? ''),
      title: String(result?.title ?? ''),
      refs: Number(action.refs ?? 0),
      revision: Number(action.revision ?? 0),
      documentId: String(action.documentId ?? ''),
      observationId,
      at: this.now(),
    };
  }

  private async actionable(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const target = this.normalTarget(params);
    if (!target.ref && !target.selector && !target.stableRef && !target.text) {
      throw new RpcMethodError('E_BAD_ARG', 'actionable 需要 ref/selector/text 目标');
    }
    const state = await this.callContent(tabId, 'element-state', this.targetParams(tabId, target, params), options) as {
      attached?: boolean;
      visible?: boolean;
      disabled?: boolean;
      tag?: string;
      rect?: unknown;
      inViewport?: boolean;
    };
    const visible = state?.visible === true;
    const attached = state?.attached === true;
    const disabled = state?.disabled === true;
    const ok = attached && visible && !disabled;
    return {
      ok,
      reason: ok ? null : (!attached ? 'detached' : (!visible ? 'hidden' : 'disabled')),
      attached,
      visible,
      enabled: attached && !disabled,
      inViewport: state?.inViewport === true,
      tag: state?.tag ?? null,
      rect: state?.rect ?? null,
      effectState: 'none',
    };
  }

  // -------------------------------------------------------------------------
  // 提取
  // -------------------------------------------------------------------------

  private async extract(
    params: Record<string, unknown>,
    mode: 'extract' | 'discover' | 'table' | 'list',
    options: ExtendedDispatchOptions,
  ): Promise<unknown> {
    const tabId = requireTabId(params);
    const target = this.normalTarget(params);
    const frameId = optionalInteger(params, 'frameId', 0);
    if (frameId !== undefined && frameId !== 0) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', 'TS 运行时暂未迁移跨 frame 提取（仅主文档 frameId=0）', { frameId });
    }
    if (mode === 'discover') {
      const payload = await this.callContent(tabId, 'extract', { mode: 'discover' }, options) as ContentExtractPayload;
      return {
        ok: true,
        targets: payload.targets,
        frameCount: payload.frameCount,
        framesScanned: payload.framesScanned,
        framesSeen: payload.framesSeen,
        limits: payload.limits,
        truncated: payload.truncated,
        totalTables: payload.totalTables,
      };
    }
    if (mode === 'list') {
      // 游标类型必须与提取方法一致（同一个游标跨方法复用会被明确拒绝）。
      this.assertCursorKind(params, 'extract.list');
      if (!target.ref && !target.selector && !target.stableRef && !target.text) {
        throw new RpcMethodError('E_BAD_ARG', 'extract.list 需要 selector/ref 目标');
      }
      const itemSelector = typeof params.itemSelector === 'string' && params.itemSelector ? params.itemSelector : 'li';
      const fields = parseFields(params.fields);
      const contentParams: Record<string, unknown> = {
        mode: 'list',
        ...this.targetParams(tabId, target, params),
        itemSelector,
        ...(fields ? { fields } : {}),
      };
      const payload = await this.callContent(tabId, 'extract', contentParams, options) as ContentExtractPayload;
      return this.budgetExtract('list', payload, params, this.extractCursorKind('extract.list'));
    }
    // extract / extract.table
    const methodKind = this.extractCursorKind(mode === 'extract' ? 'extract' : 'extract.table');
    this.assertCursorKind(params, methodKind);
    const contentParams: Record<string, unknown> = { mode: 'auto' };
    if (params.target !== undefined && params.target !== null) {
      const targetId = Number(params.target);
      if (!Number.isInteger(targetId) || targetId < 0) {
        throw new RpcMethodError('E_BAD_ARG', 'extract.table 的 target 需要 ≥0 的整数 id', { target: params.target });
      }
      contentParams.target = String(targetId);
    } else if (target.ref || target.selector || target.stableRef || target.text) {
      Object.assign(contentParams, this.targetParams(tabId, target, params));
    } else if (mode === 'table') {
      throw new RpcMethodError('E_BAD_ARG', 'extract.table 需要 --target 或 selector/ref');
    }
    const payload = await this.callContent(tabId, 'extract', contentParams, options) as ContentExtractPayload;
    return this.budgetExtract('table', payload, params, this.extractCursorKind(mode === 'extract' ? 'extract' : 'extract.table'));
  }

  /** cursor 里的 kind：同一个游标不能跨方法复用（CLI/E2E 明确验证 E_CURSOR_STALE）。 */
  private extractCursorKind(method: string): 'extract' | 'extract.list' | 'extract.table' {
    return method === 'extract.list' ? 'extract.list' : method === 'extract.table' ? 'extract.table' : 'extract';
  }

  /** 提前校验游标类型；无效/跨方法都回 E_CURSOR_STALE（不先做目标解析）。 */
  private assertCursorKind(params: Record<string, unknown>, kind: 'extract' | 'extract.list' | 'extract.table'): void {
    const cursor = typeof params.cursor === 'string' && params.cursor ? params.cursor : '';
    if (!cursor) return;
    const match = /^x1\.([a-z.]+)\.(\d+)\.([a-z0-9-]+)$/i.exec(cursor);
    if (!match) throw new RpcMethodError('E_CURSOR_STALE', 'extract 游标无效或已过期，请重新提取', { cursor });
    const actualKind = match[1];
    if (actualKind !== kind) {
      throw new RpcMethodError('E_CURSOR_STALE', 'extract 游标属于另一种提取方法（' + String(actualKind) + '），不能复用', {
        cursor,
        expectedKind: kind,
        actualKind,
      });
    }
  }

  /**
   * 把内容脚本返回的完整行列按预算裁剪，并生成 budget/coverage/cursor。
   *
   * 预算顺序与 JS 提取器一致：rows → cells → bytes；任何一项命中都会写 stopReason，
   * complete=false 且 truncated=true（不静默丢行）。
   */
  private budgetExtract(
    kind: 'table' | 'list',
    payload: ContentExtractPayload,
    params: Record<string, unknown>,
    methodKind: 'extract' | 'extract.table' | 'extract.list',
  ): unknown {
    const maxRows = optionalInteger(params, 'maxRows', 1) ?? EXTRACT_DEFAULTS.maxRows;
    const maxCells = optionalInteger(params, 'maxCells', 1) ?? EXTRACT_DEFAULTS.maxCells;
    const maxBytes = optionalInteger(params, 'maxBytes', 1) ?? EXTRACT_DEFAULTS.maxBytes;
    const cursor = typeof params.cursor === 'string' && params.cursor ? params.cursor : '';
    let offset = 0;
    if (cursor) {
      const match = /^x1\.([a-z.]+)\.(\d+)\.([a-z0-9-]+)$/i.exec(cursor);
      if (!match) throw new RpcMethodError('E_CURSOR_STALE', 'extract 游标无效或已过期，请重新提取', { cursor });
      const cursorKind = match[1];
      if (cursorKind !== methodKind) {
        throw new RpcMethodError('E_CURSOR_STALE', 'extract 游标属于另一种提取方法（' + String(cursorKind) + '），不能复用', {
          cursor,
          expectedKind: methodKind,
          actualKind: cursorKind,
        });
      }
      // DOM 指纹不一致 = 提取之后页面变过：游标里的 offset 已经没有意义，明确失效。
      if (payload.fingerprint && match[3] !== payload.fingerprint) {
        throw new RpcMethodError('E_CURSOR_STALE', 'extract 游标已失效（页面在提取后发生变化），请重新提取', {
          cursor,
          reason: 'dom-changed',
          expectedFingerprint: match[3],
          actualFingerprint: payload.fingerprint,
        });
      }
      offset = Number(match[2]);
    }
    const allRows = Array.isArray(payload.rows) ? payload.rows : [];
    const totalRows = Math.max(Number(payload.totalRows) || allRows.length, allRows.length);
    const columns = Array.isArray(payload.columns) ? payload.columns : [];
    const width = Math.max(columns.length, 1);
    const rows: Array<Record<string, string | null>> = [];
    let cells = 0;
    let bytes = 0;
    let stopReason: 'end' | 'max-rows' | 'max-cells' | 'max-bytes' | 'source-truncated' = 'end';
    for (let index = offset; index < allRows.length; index += 1) {
      if (rows.length >= maxRows) {
        stopReason = 'max-rows';
        break;
      }
      const row = allRows[index];
      if (!row) continue;
      if (cells + width > maxCells) {
        stopReason = 'max-cells';
        break;
      }
      const rowBytes = BufferByteLength(JSON.stringify(row));
      if (bytes + rowBytes > maxBytes) {
        stopReason = 'max-bytes';
        break;
      }
      rows.push(row);
      cells += width;
      bytes += rowBytes;
    }
    if (stopReason === 'end' && payload.truncated === true) stopReason = 'source-truncated';
    const consumedTo = offset + rows.length;
    const hasMore = consumedTo < allRows.length;
    const truncated = stopReason !== 'end' || hasMore;
    const cursorOut = hasMore
      ? 'x1.' + methodKind + '.' + String(consumedTo) + '.' + (payload.fingerprint || '0')
      : null;
    const omitted = Math.max(0, totalRows - (offset + rows.length));
    return {
      ok: true,
      kind,
      sourceLabel: payload.sourceLabel,
      rowCount: rows.length,
      totalRows,
      complete: !truncated,
      truncated,
      stopReason,
      columns,
      rows,
      cells,
      offset,
      hasMore,
      cursor: cursorOut,
      budget: { maxRows, maxCells, maxBytes, rows: rows.length, cells, bytes, stopReason },
      coverage: { stopReason, omitted: stopReason === 'end' && !hasMore ? null : omitted },
    };
  }

  // -------------------------------------------------------------------------
  // 等待 / 取消
  // -------------------------------------------------------------------------

  private async waitMs(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const ms = optionalInteger(params, 'ms', 0);
    if (ms === undefined) throw new RpcMethodError('E_BAD_ARG', 'wait-ms 需要整数 ms');
    const controller = new AbortController();
    const startedAt = this.now();
    if (options.signal?.aborted) throw new RpcMethodError('E_CANCELLED', 'wait-ms 已取消');
    const pending = this.registerPending(options.requestId, 'wait-ms', controller);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = this.setTimer(() => resolve(), ms);
        const onAbort = (): void => {
          this.clearTimer(timer);
          reject(new RpcMethodError('E_CANCELLED', 'wait-ms 已取消', { method: 'wait-ms' }));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      this.unregisterPending(pending);
    }
    return { ok: true, ms, elapsedMs: this.now() - startedAt };
  }

  private async waitForElement(
    params: Record<string, unknown>,
    options: ExtendedDispatchOptions,
    timeoutMs: number,
  ): Promise<unknown> {
    const tabId = requireTabId(params);
    const target = this.normalTarget(params);
    if (!target.ref && !target.selector && !target.stableRef && !target.text) {
      throw new RpcMethodError('E_BAD_ARG', 'wait-for-element 需要 ref/selector/text 目标');
    }
    const state = normalizeWaitState(params.state);
    const waitTimeout = optionalInteger(params, 'timeoutMs', 0) ?? Math.max(1000, Math.min(timeoutMs, 30_000));
    const operationId = typeof params.operationId === 'string' && params.operationId ? params.operationId : '';
    const contentParams = this.targetParams(tabId, target, params);
    const controller = new AbortController();
    const pending = this.registerPending(options.requestId, 'wait-for-element', controller);
    const operation = operationId ? this.registerOperation(operationId, 'wait-for-element', controller) : null;
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const startedAt = this.now();
    let last: WaitElementView | null = null;
    let satisfied = false;
    let timedOut = false;
    let cancelled = false;
    let lastError: unknown = null;
    try {
      for (;;) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        try {
          last = await this.callContent(tabId, 'element-state', contentParams, options, 10_000) as WaitElementView | null;
          lastError = null;
        } catch (error) {
          last = null;
          lastError = error;
          // 等待场景下“目标不存在/ref 失效/内容脚本暂时不可用”都不是失败：继续轮询到超时。
          // 只有真正的调用错误（例如 tab 关闭）才向上抛。
          const code = error instanceof RpcMethodError ? error.code : '';
          if (!/E_NO_CONTENT|E_TIMEOUT|E_CONTENT_ERROR|E_NOT_FOUND|E_STALE_REF|E_BAD_ARG/.test(code)) throw error;
        }
        if (stateMet(state, last)) {
          satisfied = true;
          break;
        }
        if (this.now() - startedAt >= waitTimeout) {
          timedOut = true;
          break;
        }
        await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, waitTimeout - (this.now() - startedAt))), controller.signal);
      }
    } finally {
      this.unregisterPending(pending);
      if (operation) this.unregisterOperation(operationId);
    }
    return {
      ok: true,
      satisfied,
      timedOut,
      cancelled,
      state,
      elapsedMs: this.now() - startedAt,
      attempted: true,
      attached: last?.attached === true,
      visible: last?.visible === true,
      inViewport: Number(last?.rect?.width ?? 0) > 0 && Number(last?.rect?.height ?? 0) > 0,
      ...(operationId ? { operationId } : {}),
      ...(lastError ? { lastError: lastError instanceof RpcMethodError ? lastError.code : 'E_INTERNAL' } : {}),
    };
  }

  private async waitForNavigation(
    params: Record<string, unknown>,
    options: ExtendedDispatchOptions,
    timeoutMs: number,
  ): Promise<unknown> {
    const tabId = requireTabId(params);
    const waitUntil = typeof params.waitUntil === 'string' && params.waitUntil ? params.waitUntil : 'load';
    const waitTimeout = optionalInteger(params, 'timeoutMs', 0) ?? Math.max(1000, Math.min(timeoutMs, 30_000));
    const initial = await this.callContent(tabId, 'metrics', {}, options) as { url?: string; documentId?: string };
    const startedAt = this.now();
    const controller = new AbortController();
    const pending = this.registerPending(options.requestId, 'wait-for-navigation', controller);
    if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let current = initial;
    let timedOut = false;
    try {
      for (;;) {
        if (controller.signal.aborted) break;
        current = await this.callContent(tabId, 'metrics', {}, options) as typeof initial;
        if (String(current?.url ?? '') !== String(initial?.url ?? '')) break;
        if (this.now() - startedAt >= waitTimeout) {
          timedOut = true;
          break;
        }
        await this.sleep(Math.min(150, Math.max(1, waitTimeout - (this.now() - startedAt))), controller.signal);
      }
    } finally {
      this.unregisterPending(pending);
    }
    return {
      ok: true,
      url: String(current?.url ?? ''),
      phase: waitUntil,
      navigated: String(current?.url ?? '') !== String(initial?.url ?? ''),
      timedOut,
      elapsedMs: this.now() - startedAt,
    };
  }

  private cancelByRpcId(params: Record<string, unknown>): unknown {
    const rpcId = typeof params.rpc_id === 'string' ? params.rpc_id : (typeof params.rpcId === 'string' ? params.rpcId : '');
    const target = rpcId ? this.pending.get(rpcId) : null;
    if (!target) return { ok: true, cancelled: false, reason: 'not-found' };
    target.controller.abort();
    return { ok: true, cancelled: true, method: target.method, rpcId };
  }

  private cancelByOperationId(params: Record<string, unknown>): unknown {
    const operationId = typeof params.operationId === 'string'
      ? params.operationId
      : String(params.operation_id ?? params.id ?? '');
    const target = operationId ? this.operations.get(operationId) : null;
    if (!target) {
      throw new RpcMethodError('E_NOT_FOUND', 'operation 不存在或已完成：' + operationId, {
        operationId,
        pendingOperations: [...this.operations.keys()],
      });
    }
    target.controller.abort();
    return { ok: true, cancelled: true, operationId, method: target.method };
  }

  private registerPending(requestId: string | undefined, method: string, controller: AbortController): PendingOperation | null {
    if (!requestId) return null;
    const entry: PendingOperation = { controller, method, at: this.now() };
    this.pending.set(requestId, entry);
    // 挂到操作表也便于诊断（requestId 与 operationId 是两套 id，daemon cancel 用前者）。
    return entry;
  }

  private unregisterPending(entry: PendingOperation | null): void {
    if (!entry) return;
    for (const [key, value] of this.pending) {
      if (value === entry) this.pending.delete(key);
    }
  }

  private registerOperation(operationId: string, method: string, controller: AbortController): PendingOperation {
    const entry: PendingOperation = { controller, method, at: this.now() };
    this.operations.set(operationId, entry);
    return entry;
  }

  private unregisterOperation(operationId: string): void {
    this.operations.delete(operationId);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let timer: unknown = null;
      const done = (): void => {
        if (timer !== null) this.clearTimer(timer);
        resolve();
      };
      timer = this.setTimer(done, Math.max(1, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // 人工协助 / 协作最小面
  // -------------------------------------------------------------------------

  private async requestHelp(params: Record<string, unknown>): Promise<unknown> {
    requireTabId(params);
    const settings = this.readSettings ? await this.readSettings() : { allowHelp: true };
    if (settings.allowHelp === false) {
      throw new RpcMethodError('E_HELP_DISABLED', 'request-help 已被设置关闭（settings set --allow-help off）', {
        reason: 'allowHelp=false',
      });
    }
    throw new RpcMethodError(
      'E_NOT_IMPLEMENTED',
      'TS 运行时尚未迁移人工协助卡片（需要浮层 UI + UIA 交还监听）；allowHelp 关闭时的拒绝语义已实现',
      { method: 'request-help' },
    );
  }

  private nextCooperation(tabId: number): { generation: number; revision: number; controlRevision: number; authorityRevision: number } {
    const current = this.cooperation.get(tabId) ?? { generation: 0, revision: 0, controlRevision: 0, authorityRevision: 0 };
    const next = {
      generation: current.generation + 1,
      revision: current.revision + 1,
      controlRevision: current.controlRevision + 1,
      authorityRevision: current.authorityRevision + 1,
    };
    this.cooperation.set(tabId, next);
    return next;
  }

  private async cooperateSync(params: Record<string, unknown>, options: ExtendedDispatchOptions): Promise<unknown> {
    const tabId = requireTabId(params);
    const cdpSessionId = makeCdpSessionId(tabId, 0);
    const observeResult = await this.callContent(tabId, 'observe', { force: true, cdpSessionId }, options) as {
      url?: string;
      title?: string;
      observation?: string;
      refs?: number;
      revision?: number;
      documentId?: string;
      fingerprint?: string;
      signatures?: unknown;
    };
    const observationId = newObservationId(tabId, this.random);
    const { action, input } = toObserveActionResult(observeResult as never, {
      tabId,
      observationId,
      random: this.random,
      context: { documentId: observeResult?.documentId ?? null, frameId: 0, cdpSessionId },
    });
    this.refs.registerObservation(tabId, input);
    const counters = this.nextCooperation(tabId);
    const revision = Number(action.revision ?? 0);
    // 控制策略是会话级固定值：只有显式 --policy 才换（23w：strict 之后的普通 sync
    // 不能把策略退回 auto，否则 context 单次消费语义会丢）。
    const requestedPolicy = typeof params.policy === 'string' ? String(params.policy) : '';
    const policy: 'auto' | 'strict' | 'target' = requestedPolicy === 'strict'
      ? 'strict'
      : requestedPolicy === 'target'
        ? 'target'
        : requestedPolicy === 'auto'
          ? 'auto'
          : (this.controlPolicy.get(tabId) ?? 'auto');
    this.controlPolicy.set(tabId, policy);
    this.receipts?.setPolicy(tabId, policy);
    // 页面协作时钟（MutationObserver/事件监听）：内容脚本不支持该 op 时降级为空计数器
    // （旧版本的 stub/旧内容脚本仍可用，不把“没有计数器”变成动作失败）。
    type CoopStatePayload = {
      frameState?: Record<string, unknown>;
      fingerprint?: string;
      documentId?: string;
      url?: string;
      nodeScope?: { count?: number; signatures?: unknown };
    };
    let coopState: CoopStatePayload | null = null;
    try {
      coopState = await this.callContent(tabId, 'cooperation-state', { signatures: true }, options) as CoopStatePayload | null;
    } catch {
      coopState = null;
    }
    const trackerFrame = coopState && coopState.frameState ? coopState.frameState : {};
    // 原生（CDP）输入不经过内容脚本的 begin/endAgentInput 窗口，归因由 background 时钟补上：
    // 一次 sync 汇报「自上次 sync 以来」的可信输入，与 tracker 的计数相加（23h3/23h4）。
    const nativeInput = this.inputClock.take(tabId);
    const trackerAgent = Number(trackerFrame.agentAttributed ?? 0);
    const trackerClock = Number(trackerFrame.inputClock ?? 0);
    const agentAttributed = trackerAgent + nativeInput.agent;
    const inputClock = trackerClock + nativeInput.inputClock;
    const attribution = nativeInput.last
      ? { owner: 'agent', kind: nativeInput.last.kind, at: nativeInput.last.at, by: 'command' }
      : (trackerFrame.attribution ?? { owner: null, kind: null, at: null, by: null });
    const frameState: Record<string, unknown> = {
      revision,
      mutations: Number(trackerFrame.mutations ?? 0),
      structure: Number(trackerFrame.structure ?? 0),
      texts: Array.isArray(trackerFrame.texts) ? trackerFrame.texts : [],
      scroll: Number(trackerFrame.scroll ?? 0),
      document: String(trackerFrame.document ?? observeResult?.url ?? ''),
      events: Array.isArray(trackerFrame.events) ? trackerFrame.events : [],
      focusNeutral: trackerFrame.focusNeutral !== false,
      selection: String(trackerFrame.selection ?? ''),
      media: Array.isArray(trackerFrame.media) ? trackerFrame.media : [],
      mediaComplete: trackerFrame.mediaComplete !== false,
      textsComplete: trackerFrame.textsComplete !== false,
      eventsComplete: trackerFrame.eventsComplete !== false,
      fieldsComplete: trackerFrame.fieldsComplete !== false,
      focusIsDocument: trackerFrame.focusIsDocument !== false,
      agentAttributed,
      humanAttributed: Number(trackerFrame.humanAttributed ?? 0),
      lastHumanKind: trackerFrame.lastHumanKind ?? null,
      inputClock,
      timeToleranceMs: Number(trackerFrame.timeToleranceMs ?? 1.5),
      attribution,
      expectationPending: false,
      lastHumanAt: null,
      agentAttributedByTimestamp: trackerAgent,
      agentAttributedByCoordinate: 0,
      trustedInputAttributed: nativeInput.agent,
    };
    const documentId = String(coopState?.documentId ?? observeResult?.documentId ?? '');
    const url = String(coopState?.url ?? observeResult?.url ?? '');
    const fingerprint = String(coopState?.fingerprint ?? observeResult?.fingerprint ?? '');
    const nodeSignatures = normalizeSignatures(coopState?.nodeScope ? coopState.nodeScope.signatures : observeResult?.signatures);
    const nodeScopeCount = Number(coopState?.nodeScope?.count ?? Object.keys(nodeSignatures).length);
    this.receipts?.addObservation(tabId, {
      observationId,
      documentId,
      revision,
      url,
      fingerprint,
      signatures: nodeSignatures,
      nodeScope: { count: nodeScopeCount, signatures: nodeSignatures },
    });
    const contextId = 'ctx_' + counters.generation + '_' + Math.floor(this.now()).toString(36);
    this.receipts?.addContext(tabId, {
      contextId,
      documentId,
      url,
      generation: counters.generation,
      policy,
    });
    const matchText = typeof params.matchText === 'string' && params.matchText
      ? params.matchText
      : (typeof params.match_text === 'string' ? params.match_text : '');
    const contextLines = optionalInteger(params, 'contextLines', 0) ?? 1;
    const rawObservation = String(observeResult?.observation ?? '');
    const observationText = matchText ? foldObservationText(rawObservation, matchText, contextLines) : rawObservation;
    const denial = this.authorize ? this.authorize(tabId, 'click') : { ok: true as const };
    const actionAllowed = denial.ok === true;
    const deniedReason = actionAllowed ? null : String((denial.data as { reason?: unknown } | undefined)?.reason ?? 'read-only');
    const held = this.control ? this.control.isHeld(tabId) : false;
    return {
      ok: true,
      cooperation: {
        frameState,
        frames: [{ frameId: 0, url, revision, observationId, state: frameState }],
        aggregateFrameState: {
          revision,
          frames: 1,
          mutations: frameState.mutations,
          structure: frameState.structure,
          scroll: frameState.scroll,
          texts: frameState.texts,
        },
        frameGaps: [],
        control: {
          inputLocked: held,
          humanActive: held,
          mode: held ? 'human' : 'agent',
          authorityRevision: counters.authorityRevision,
        },
      },
      authority: {
        generation: counters.generation,
        revision,
        controlRevision: counters.controlRevision,
        authorityRevision: counters.authorityRevision,
        epoch: counters.generation,
        frameEpoch: counters.generation,
        four: {
          tab: { tabId, epoch: counters.generation, allowed: true },
          control: { controlRevision: counters.controlRevision, allowed: true },
          observation: { epoch: counters.generation, revision, observationId },
          action: { authorityRevision: counters.authorityRevision, allowed: actionAllowed, deniedReason },
        },
      },
      control_policy: policy === 'strict' ? 'strict' : 'target',
      context_id: contextId,
      observation_id: observationId,
      node_scope: { count: nodeScopeCount, refs: Object.keys(nodeSignatures) },
      observation: { text: observationText, refs: Number(action.refs ?? 0), url },
      held,
      held_reason: held ? 'cooperate-hold' : null,
    };
  }

  private cooperateWait(params: Record<string, unknown>): unknown {
    const tabId = requireTabId(params);
    const timeoutMs = optionalInteger(params, 'timeoutMs', 0) ?? 0;
    const held = this.control ? this.control.isHeld(tabId) : false;
    return {
      ok: true,
      ready: !held,
      timeoutMs,
      held,
      state: { mode: held ? 'human' : 'agent', humanInput: false, lastHumanAt: null },
      note: 'TS 运行时用页面事件/协作 hold 判定是否可写；没有 UIA 级人工输入监听（human-watch 未迁移）',
    };
  }

  private cooperateHandback(params: Record<string, unknown>): unknown {
    const tabId = requireTabId(params);
    if (this.control) this.control.setHeld(tabId, false);
    return { ok: true, handedBack: true, held: false, at: this.now() };
  }

  private cooperateHold(params: Record<string, unknown>): unknown {
    const tabId = requireTabId(params);
    // CLI 发送 `held`（cooperate hold → held:true；cooperate hold --release → held:false）；
    // 同时接受 release:true 的旧形态。
    const release = params.release === true || params.held === false;
    if (this.control) this.control.setHeld(tabId, !release);
    const held = this.control ? this.control.isHeld(tabId) : !release;
    return {
      ok: true,
      held,
      released: release,
      at: this.now(),
      note: held
        ? '人工接管中：变更动作会被 background 授权闸门以 E_SESSION_PAUSED 拒绝'
        : '已交回 Agent（held=false）',
    };
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * --match-text 折叠：只保留命中行与上下文行，省略段用 `… (N lines omitted) …` 标记。
 * 折叠是“显示层”的，不影响 ref 表（命中行里的 @eN 仍然可用）。
 */
function foldObservationText(text: string, matchText: string, contextLines: number): string {
  const lines = String(text ?? '').split('\n');
  if (!matchText || lines.length === 0) return String(text ?? '');
  const wanted = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!String(lines[index] ?? '').includes(matchText)) continue;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(lines.length - 1, index + contextLines);
    for (let cursor = from; cursor <= to; cursor += 1) wanted.add(cursor);
  }
  if (wanted.size === 0) return String(text ?? '');
  const out: string[] = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (wanted.has(index)) {
      if (skipped > 0) {
        out.push('… (' + String(skipped) + ' lines omitted) …');
        skipped = 0;
      }
      out.push(String(lines[index] ?? ''));
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push('… (' + String(skipped) + ' lines omitted) …');
  return out.join('\n');
}

/** UTF-8 字节数（不引入 Node Buffer：SW 里没有）。 */
function BufferByteLength(text: string): number {  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function normalizeWaitState(raw: unknown): 'attached' | 'visible' | 'hidden' | 'detached' {
  const text = String(raw ?? 'visible').toLowerCase();
  if (text === 'attached' || text === 'hidden' || text === 'detached') return text;
  return 'visible';
}

function stateMet(state: 'attached' | 'visible' | 'hidden' | 'detached', view: { attached?: boolean; visible?: boolean } | null): boolean {
  const attached = view?.attached === true;
  const visible = view?.visible === true;
  switch (state) {
    case 'attached':
      return attached;
    case 'visible':
      return attached && visible;
    case 'hidden':
      return attached && !visible;
    case 'detached':
      return !attached;
    default:
      return false;
  }
}

/** extract list 的 fields 参数归一（接受数组或 {fields:[...]}）。 */
function parseFields(raw: unknown): Array<{ key: string; read?: string; attribute?: string }> | null {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : (isRecord(raw) && Array.isArray(raw.fields) ? raw.fields : null);
  if (!list) return null;
  const out: Array<{ key: string; read?: string; attribute?: string }> = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const key = typeof item.key === 'string' ? item.key : (typeof item.name === 'string' ? item.name : '');
    if (!key) continue;
    const spec: { key: string; read?: string; attribute?: string } = { key };
    if (typeof item.read === 'string') spec.read = item.read;
    if (typeof item.attribute === 'string') spec.attribute = item.attribute;
    out.push(spec);
  }
  return out.length ? out : null;
}

/** TARGET_METHODS 目前只用于自描述；保留导出便于将来做参数策略表。 */
export const EXTENDED_TARGET_METHODS: readonly string[] = [...TARGET_METHODS];
