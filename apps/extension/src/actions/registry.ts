// src/actions/registry.ts —— 扩展侧动作注册表：参数校验 → feature gate → ref 生命周期 → 页面桥。
//
// 一次动作的数据流（以 click @e3 为例）：
//   1) daemon 通过 WS `{type:'cmd', method:'click', params:{tabId, ref:'@e3', ...}}` 派发；
//   2) 本注册表先做别名归一 + 参数校验（params.ts），非法入参回 E_BAD_ARG；
//   3) packages/protocol 的 assertProtocolCompatible 做 feature gate（1.8 对端不能用
//      1.9 参数，明确 E_PROTOCOL_UNSUPPORTED 而不是静默忽略）；
//   4) ref 生命周期：stableRef → @eN 解析、expectRevision 校验、document/generation/
//      签名比较；失效回 E_STALE_REF（该重新 observe），整页观察失效回 E_OBSERVATION_STALE；
//   5) 把 refKey（documentId/revision/generation/signature）随命令下发给内容脚本，
//      页面侧再校验一次 documentId/expectRevision，防止 background 表与页面错位；
//   6) observe 成功后用结果整体重建 ref 表（registerObservation），并返回
//      observationId/refDetails 供 CLI 直接使用。
//
// 第四批在本层加了四个闸门（都不需要 chrome.debugger）：
// - --context / --observation / --node-scope 收据校验（receipts.ts）；
// - --expect / --depends-on 事实校验（内容脚本 check-facts，失败不派发动作）；
// - --settle 动作后等待（返回 settledMs 证据）；
// - 跨 frame 别名（@f<frameId>eN）定向派发（frames/service.ts，via=frame-projected）。

import {
  assertProtocolCompatible,
  type ProtocolPeer,
} from '../protocol.ts';
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import { RpcMethodError } from '../rpc/registry.ts';
import {
  assessObservationFreshness,
  RefRegistry,
  type RefExpectation,
} from '../refs/index.ts';
import { makeCdpSessionId, registerClosedShadowRefs } from '../refs/registry.ts';
import {
  makeContentRequest,
  normalizeContentReply,
  type ContentClickResult,
  type ContentEvaluateResult,
  type ContentFillResult,
  type ContentGetHtmlResult,
  type ContentObserveResult,
  type ContentOp,
  type ContentReadResult,
  type ContentReply,
  type ContentRequest,
  type ContentSelectResult,
} from '../content/protocol.ts';
import { normalizePageAction, type NormalizedPageAction, type NormalizedTarget, UNSUPPORTED_OBSERVE_FLAGS } from './params.ts';
import { newObservationId, toObserveActionResult, type ObservationRefDetail, type ObserveActionResult } from './observation.ts';
import { evaluateInMainWorld, type ScriptingApi } from '../scripting/evaluate.ts';
import {
  expectFailed,
  normalizeChecks,
  normalizeSignatures,
  observationChanged,
  staleContext,
  staleObservation,
  targetDetached,
  ReceiptStore,
  type NodeSignatureView,
} from './receipts.ts';
import type { FrameObservationService } from '../frames/service.ts';
import {
  ActionInputBridge,
  type TrustedInputClock,
  type TrustedInputPort,
  sharedTrustedInputClock,
} from './trusted-input.ts';
import type { BackendNodeLocatorPort, BackendTargetDescriptor } from './backend-locator.ts';

/** background 侧实现的内容脚本传输（浏览器里用 tabs.sendMessage；单测注入 stub）。 */
export interface ActionContentTransport {
  request(
    tabId: number,
    request: ContentRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number },
  ): Promise<ContentReply>;
}

/** 动作授权（per-tab read-only 等策略）；拒绝时动作不会下发给页面。 */
export type ActionAuthorizer = (tabId: number, method: string) => { ok: true } | { ok: false; code: string; message: string; data?: unknown };

/** 动作方法名（本批迁移面）。 */
export type ActionMethod = 'observe' | 'click' | 'fill' | 'read' | 'select' | 'get-html' | 'evaluate';

export const ACTION_METHODS: readonly ActionMethod[] = Object.freeze([
  'observe',
  'click',
  'fill',
  'read',
  'select',
  'get-html',
  'evaluate',
]);

/** 方法 → 内容脚本 op。 */
const CONTENT_OP_BY_METHOD: Readonly<Record<ActionMethod, ContentOp>> = Object.freeze({
  observe: 'observe',
  click: 'click',
  fill: 'fill',
  read: 'read',
  select: 'select',
  'get-html': 'get-html',
  evaluate: 'evaluate',
});

/** 有副作用的动作（daemon 侧会据此标注 effectState；这里用于日志/测试断言）。 */
const MUTATING_ACTIONS: ReadonlySet<ActionMethod> = new Set(['click', 'fill', 'select']);

export interface ActionSpec {
  method: ActionMethod;
  description: string;
  /** 是否产生浏览器副作用。 */
  mutating: boolean;
  /** 单次内容脚本调用的默认超时。 */
  timeoutMs: number;
}

export interface ActionDispatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 调用方（router）注入的关联 id，只用于内容脚本消息与日志。 */
  requestId?: string;
}

export interface ActionRegistryOptions {
  content: ActionContentTransport;
  refs?: RefRegistry;
  /** 观察收据/context/期望校验（第四批）。 */
  receipts?: ReceiptStore | null;
  /** 跨 frame 动作（observe --frames 生成的别名）。 */
  frames?: FrameObservationService | null;
  /** feature gate 的对端投影：默认本扩展自身协议（1.9）。 */
  peer?: ProtocolPeer;
  now?: () => number;
  random?: () => number;
  defaultTimeoutMs?: number;
  /** evaluate 的主世界执行器（chrome.scripting）；缺省时 evaluate 明确不可用。 */
  scripting?: ScriptingApi | null;
  /** per-tab 策略授权；缺省全部放行。 */
  authorize?: ActionAuthorizer | null;
  /**
   * 可信输入（20z/7/7b）：background 注入的 InputService（CDP Input 原语）。
   * 只有 input + backend 同时可用时才会路由 CDP；缺省保持内容脚本路径。
   */
  input?: TrustedInputPort | null;
  /** CDP DOM 节点定位器（backend-locator.ts；与 input 配套）。 */
  backend?: BackendNodeLocatorPort | null;
  /** 原生输入归因时钟（缺省用 background 共享实例；cooperate.sync 会取走增量）。 */
  inputClock?: TrustedInputClock | null;
  /**
   * closed shadow ref 的 CDP pierce 路由（20v）：background 注入 PierceService 的两个方法。
   * closed-shadow ref 内容脚本看不到，click/read 必须走这里；缺省时明确 E_UNSUPPORTED_CAPABILITY。
   */
  pierce?: PierceRefRouter | null;
}

/** closed shadow ref 动作路由（scripting/pierce.ts 的 clickRefNode/readRefNode 子集）。 */
export interface PierceRefRouter {
  clickRefNode(tabId: number, backendNodeId: number): Promise<Record<string, unknown>>;
  readRefNode(tabId: number, backendNodeId: number): Promise<Record<string, unknown>>;
}

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/** 内容脚本调用的超时包装：内容传输自身超时之外的最后一道防线。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, method: string): Promise<T> {
  if (!(timeoutMs > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcMethodError('E_TIMEOUT', '内容脚本动作 ' + method + ' 超时（' + String(timeoutMs) + 'ms）', { method }));
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

function targetParams(target: NormalizedTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (target.ref) out.ref = target.ref;
  if (target.selector) out.selector = target.selector;
  if (target.text) out.text = target.text;
  return out;
}

/**
 * 扩展侧动作注册表。
 *
 * ```ts
 * const registry = new ActionRegistry({ content: transport, refs: new RefRegistry() });
 * await registry.dispatch('observe', { tabId: 7 });       // 页面侧观察 + 建 ref 表
 * await registry.dispatch('click', { tabId: 7, ref: '@e3' });
 * ```
 */
export class ActionRegistry {
  readonly refs: RefRegistry;
  private readonly content: ActionContentTransport;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly scripting: ScriptingApi | null;
  private readonly authorize: ActionAuthorizer | null;
  private readonly receipts: ReceiptStore | null;
  private readonly frames: FrameObservationService | null;
  private readonly inputBridge: ActionInputBridge | null;
  private pierceValue: PierceRefRouter | null;
  private peerValue: ProtocolPeer;
  private readonly specs = new Map<string, ActionSpec>();

  constructor(options: ActionRegistryOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('ActionRegistry 需要一个 content transport（request 方法）');
    }
    this.content = options.content;
    this.refs = options.refs ?? new RefRegistry({ now: options.now ?? Date.now });
    this.peerValue = options.peer ?? { protocol: PROTOCOL_VERSION };
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.scripting = options.scripting ?? null;
    this.authorize = options.authorize ?? null;
    this.receipts = options.receipts ?? null;
    this.frames = options.frames ?? null;
    this.inputBridge = ActionInputBridge.from({
      input: options.input ?? null,
      locator: options.backend ?? null,
      clock: options.inputClock ?? sharedTrustedInputClock,
      now: this.now,
    });
    this.pierceValue = options.pierce ?? null;
    this.defaultTimeoutMs = Number(options.defaultTimeoutMs) > 0
      ? Math.floor(Number(options.defaultTimeoutMs))
      : DEFAULT_ACTION_TIMEOUT_MS;
    for (const method of ACTION_METHODS) {
      this.specs.set(method, {
        method,
        description: describeAction(method),
        mutating: MUTATING_ACTIONS.has(method),
        timeoutMs: method === 'observe' ? this.defaultTimeoutMs * 2 : this.defaultTimeoutMs,
      });
    }
  }

  get size(): number {
    return this.specs.size;
  }

  /** evaluate 执行器是否可用（诊断用；不暴露对象本身）。 */
  scriptingAvailable(): { api: boolean; executeScript: string; chromeScripting: string } {
    const scripting = this.scripting?.scripting as { executeScript?: unknown } | undefined;
    return {
      api: Boolean(this.scripting),
      executeScript: typeof scripting?.executeScript,
      chromeScripting: typeof (globalThis as { chrome?: { scripting?: unknown } }).chrome?.scripting,
    };
  }

  get peer(): ProtocolPeer {
    return this.peerValue;
  }

  /** background 延迟注入 pierce（closed shadow ref 路由；20v）。 */
  setPierce(pierce: PierceRefRouter | null | undefined): void {
    this.pierceValue = pierce ?? null;
  }

  setPeer(peer: ProtocolPeer | null | undefined): void {
    this.peerValue = peer ?? {};
  }

  has(method: unknown): boolean {
    return typeof method === 'string' && this.specs.has(method);
  }

  spec(method: unknown): ActionSpec | null {
    return typeof method === 'string' ? this.specs.get(method) ?? null : null;
  }

  methods(): string[] {
    return [...this.specs.keys()];
  }

  specsList(): ActionSpec[] {
    return [...this.specs.values()];
  }

  /** 本批尚未迁移的 observe 能力开关（诊断/报告用；第四批迁移后为空）。 */
  unsupportedObserveFlags(): readonly string[] {
    return UNSUPPORTED_OBSERVE_FLAGS;
  }

  /**
   * 用 observe --frames 的主文档结果登记 ref 表与收据（与单文档 observe 同一套生命周期）。
   * 子帧 ref 仍由 FrameObservationService 的别名表负责。
   */
  registerFrameObservation(tabId: number, payload: {
    url?: string;
    title?: string;
    observation?: string;
    revision?: number;
    documentId?: string;
    fingerprint?: string;
    nodes?: ContentObserveResult['nodes'];
  }): { observationId: string; registered: number; skipped: number } {
    const observationId = newObservationId(tabId, this.random);
    const { action, input } = toObserveActionResult({
      url: String(payload?.url ?? ''),
      title: String(payload?.title ?? ''),
      observation: String(payload?.observation ?? ''),
      refs: Array.isArray(payload?.nodes) ? payload.nodes.length : 0,
      revision: Number(payload?.revision ?? 0),
      documentId: String(payload?.documentId ?? ''),
      nodes: Array.isArray(payload?.nodes) ? payload.nodes : [],
    } as ContentObserveResult, {
      tabId,
      observationId,
      random: this.random,
      context: { documentId: payload?.documentId ?? null, frameId: 0, cdpSessionId: makeCdpSessionId(tabId, 0) },
    });
    const registration = this.refs.registerObservation(tabId, input);
    this.receipts?.addObservation(tabId, {
      observationId,
      documentId: String(payload?.documentId ?? ''),
      revision: Number(payload?.revision ?? 0),
      url: String(payload?.url ?? ''),
      fingerprint: String(payload?.fingerprint ?? ''),
      signatures: {},
    });
    void action;
    return { observationId, registered: registration.registered, skipped: registration.skipped };
  }

  /**
   * 分派一个动作。
   *
   * @throws ProtocolError feature gate 拒绝
   * @throws RpcMethodError 参数/ref/内容脚本业务错误（E_BAD_ARG、E_STALE_REF、…）
   */
  async dispatch(method: string, rawParams: unknown, options: ActionDispatchOptions = {}): Promise<unknown> {
    const spec = this.spec(method);
    if (!spec) {
      throw new RpcMethodError('E_UNKNOWN_METHOD', '扩展未注册动作：' + String(method), { method: String(method) });
    }
    const normalized = normalizePageAction(method, rawParams);

    // feature gate：用“别名展开后的原始参数 + 目标参数”判定，参数级门（expect/unverified）
    // 才不会被归一化窄化掉。
    const gateParams: Record<string, unknown> = { ...normalized.source, ...targetParams(normalized.target) };
    assertProtocolCompatible(this.peerValue, method, gateParams);

    // per-tab 策略（read-only 等）：动作一律在派发前被拒绝，页面收不到任何命令。
    if (this.authorize) {
      const decision = this.authorize(normalized.tabId, method);
      if (!decision.ok) throw new RpcMethodError(decision.code, decision.message, decision.data);
    }

    // 收据/期望闸门（observe 自身不需要）：--context / --observation / --node-scope /
    // --expect / --depends-on 全部在派发前判定，失败时不派发动作。
    if (method !== 'observe') await this.preflightGuards(method, normalized, options);

    // 跨 frame 别名（observe --frames 生成的 @f<frameId>eN）：定向到该帧内容脚本派发。
    let frameAlias = method !== 'observe' && normalized.target.ref
      ? this.frames?.aliasFor(normalized.tabId, normalized.target.ref) ?? null
      : null;
    // 兼容 JS observe --frames 语义：子帧里唯一的本地 @eN 也可以直接动作
    // （主文档 ref 表里没有该 ref 时才回退，避免抢走主文档的同名 ref）。
    if (!frameAlias && method !== 'observe' && normalized.target.ref) {
      const ref = String(normalized.target.ref);
      let known = true;
      try {
        known = this.refs.resolve(normalized.tabId, ref, {}).ok === true;
      } catch {
        known = false;
      }
      if (!known) frameAlias = this.frames?.aliasForLocal(normalized.tabId, ref) ?? null;
    }
    if (frameAlias) {
      const dispatched = await this.frames?.dispatchInFrame(
        normalized.tabId,
        frameAlias,
        CONTENT_OP_BY_METHOD[spec.method],
        { ...targetParams(normalized.target), ...normalized.params },
        { timeoutMs: options.timeoutMs ?? spec.timeoutMs },
      );
      const settled = await this.settleIfRequested(dispatched ?? {}, Number(normalized.params.settleMs));
      return { ...(settled as Record<string, unknown>), method, frameAlias: { frameId: frameAlias.frameId, localRef: frameAlias.localRef } };
    }

    // closed shadow ref（20v）：内容脚本看不到闭树节点，只能由 background 注入的 pierce
    // 路由（clickRefNode/readRefNode）。必须在原生输入路由之前判定，避免被 CDP 节点
    // 定位路径抢走（那样 via 会变成 cdp-backend，丢失 closed-shadow 语义）。
    if (method === 'click' || method === 'read') {
      const closed = this.closedShadowTarget(normalized);
      if (closed) {
        const pierce = this.pierceValue;
        if (!pierce) {
          throw new RpcMethodError(
            'E_UNSUPPORTED_CAPABILITY',
            'closed shadow ref 需要 CDP DOM.pierce 路由（background 未注入 pierce service）',
            {
              ref: closed.ref,
              backendNodeId: closed.backendNodeId,
              capability: 'DOM.pierce',
              alternatives: ['background 注入 pierce: pierceService（clickRefNode/readRefNode）', '改用 --closed-shadow-text 文本路径'],
              effect_state: 'none',
              dispatched: false,
            },
          );
        }
        if (method === 'click') {
          const clicked = await pierce.clickRefNode(normalized.tabId, closed.backendNodeId);
          const result = {
            ...clicked,
            ref: closed.ref,
            selector: null,
            trusted: true,
            synthetic: false,
            effectState: 'committed',
          };
          return this.settleIfRequested(result, Number(normalized.params.settleMs));
        }
        const read = await pierce.readRefNode(normalized.tabId, closed.backendNodeId);
        return { ...read, ref: closed.ref, fields: [], count: 1, all: false };
      }
    }

    // 可信输入 / CDP 节点路由（20z、7、7b）：目标可解析时优先 CDP Input，解析不了就回退
    // 内容脚本（返回 null 表示未派发任何事件）。--synthetic / 不带 trusted 的调用保持
    // 内容脚本路径（35d 的 fail-closed 语义不变）。
    if (method === 'click' || method === 'fill') {
      const routed = await this.tryNativeRoute(method, normalized, options);
      if (routed) return this.settleIfRequested(routed, Number(normalized.params.settleMs));
    }

    // evaluate 走 page 主世界（chrome.scripting），不经内容脚本隔离世界（扩展页 CSP 禁 eval）。
    if (method === 'evaluate') {
      const outcome = await withTimeout(
        evaluateInMainWorld(this.scripting, normalized.tabId, normalized.params.expression, this.now),
        options.timeoutMs ?? spec.timeoutMs,
        method,
      );
      const evaluated = {
        ok: true,
        value: outcome.value,
        expression: outcome.expression,
        world: outcome.world,
        verified: false,
        at: outcome.at,
        note: 'TS 运行时 evaluate 在页面主世界执行（chrome.scripting MAIN world，无 chrome.debugger）',
      };
      return this.settleIfRequested(evaluated, Number(normalized.params.settleMs));
    }

    const request = this.buildContentRequest(spec, normalized, options);
    const reply = await withTimeout(
      this.content.request(normalized.tabId, request, {
        timeoutMs: options.timeoutMs ?? spec.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      options.timeoutMs ?? spec.timeoutMs,
      method,
    );
    const normalizedReply = normalizeContentReply(reply);
    if (!normalizedReply.ok) {
      const failure = normalizedReply;
      throw new RpcMethodError(failure.code, failure.message, failure.data);
    }
    let actionResult = this.finish(spec, normalized, normalizedReply.result, options);
    if (method === 'observe') {
      const observeResult = actionResult as ObserveActionResult & {
        fingerprint?: string;
        signatures?: unknown;
        url?: string;
        revision?: number;
        documentId?: string;
        refsPipeline?: boolean;
      };
      // AX 兜底/AX 管线不产生 ref（refs=0），也不应清空上一次真实 observe 的 ref 表：
      // 这类管线只做“读”，不参与 ref 生命周期（与 JS 扩展的 --fallback-ax/--pipeline 同义）。
      if (observeResult.refsPipeline !== true) {
        this.receipts?.addObservation(normalized.tabId, {
          observationId: observeResult.observationId,
          documentId: String(observeResult.documentId ?? ''),
          revision: Number(observeResult.revision ?? 0),
          url: String(observeResult.url ?? ''),
          fingerprint: String(observeResult.fingerprint ?? ''),
          signatures: normalizeSignatures(observeResult.signatures),
        });
      }
    }
    actionResult = await this.settleIfRequested(actionResult, Number(normalized.params.settleMs));
    return actionResult;
  }

  /**
   * closed shadow ref 路由目标：ref（或 stableRef 解析出的 ref）在注册表里 source='closed-shadow'
   * 且有 backendNodeId 时返回；否则 null（主文档 ref 继续走内容脚本/CDP 路径）。
   */
  private closedShadowTarget(normalized: NormalizedPageAction): { ref: string; backendNodeId: number } | null {
    const target = normalized.target;
    if (target.text && !target.ref && !target.selector && !target.stableRef) return null;
    let ref = target.ref;
    if (!ref && target.stableRef) {
      ref = this.refs.getByStableRef(normalized.tabId, target.stableRef)?.ref ?? null;
    }
    if (!ref) return null;
    const entry = this.refs.get(normalized.tabId, ref);
    if (!entry || entry.source !== 'closed-shadow') return null;
    const backendNodeId = Number(entry.key.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;
    return { ref, backendNodeId };
  }

  /**
   * 原生输入路由（click/fill）：`trusted:true` 且非 `--synthetic` 时尝试 CDP。
   *
   * 返回 null = 不路由（未派发事件，调用方继续走内容脚本）：
   * - 未注入 input/backend；
   * - 目标是文本/无目标可解析；
   * - ref 在页面侧已失效（内容脚本会给原口径的 E_STALE_REF）；
   * - CDP DOM 里找不到同一个节点。
   *
   * 抛错 = 权威失败：遮挡（E_OCCLUDED）、CDP 中途错误（不重放）。
   */
  private async tryNativeRoute(
    method: 'click' | 'fill',
    normalized: NormalizedPageAction,
    options: ActionDispatchOptions,
  ): Promise<unknown | null> {
    const bridge = this.inputBridge;
    if (!bridge) return null;
    const source = normalized.source;
    if (source.trusted !== true || source.synthetic === true) return null;
    const target = normalized.target;
    if (target.text && !target.ref && !target.selector && !target.stableRef) return null;

    // ref 生命周期预检与内容脚本路径共用同一套语义（stableRef → @eN、expectRevision）。
    let ref = target.ref;
    let documentId: string | null = null;
    let expectRevision: number | null = null;
    const preflight = this.preflightRef(normalized);
    if (preflight) {
      ref = preflight.ref;
      documentId = preflight.documentId;
      expectRevision = preflight.expectRevision;
    }
    const descriptor: BackendTargetDescriptor = {
      ref,
      selector: target.selector,
    };
    if (ref) {
      const described = await this.describeRefTarget(normalized.tabId, ref, documentId, expectRevision, options);
      if (!described) return null;
      descriptor.tag = described.tag;
      descriptor.id = described.id;
      descriptor.role = described.role;
      descriptor.name = described.name;
    }
    const nativeTarget = { ref, selector: target.selector };
    let routed: Record<string, unknown> | null;
    if (method === 'click') {
      routed = await bridge.click(normalized.tabId, descriptor, {
        ...nativeTarget,
        human: normalized.params.human === true,
        force: normalized.params.force === true,
      });
    } else {
      routed = await bridge.fill(normalized.tabId, descriptor, String(normalized.params.value ?? ''), {
        ...nativeTarget,
        noClear: normalized.params.noClear === true,
      });
    }
    // CDP 解析出真实 backendNodeId 后回填注册表：同 ref 的后续动作不再重新定位
    // （closed shadow ref 也靠这里补全身份，供 pierce/读取路径复用）。
    if (routed && ref) {
      const backendNodeId = Number(routed.backendNodeId);
      if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
        try {
          this.refs.upgradeBackend(normalized.tabId, ref, backendNodeId);
        } catch {
          // 回填失败不影响本次动作结果（下一次动作仍会重新定位）
        }
      }
    }
    return routed;
  }

  /**
   * 内容脚本 element-state → 节点描述符（tag/id/role/name）。
   * 只用来把 @eN 映射到 CDP 里的同一个 DOM 节点；失败返回 null（回退内容脚本）。
   */
  private async describeRefTarget(
    tabId: number,
    ref: string,
    documentId: string | null,
    expectRevision: number | null,
    options: ActionDispatchOptions,
  ): Promise<{ tag: string | null; id: string | null; role: string | null; name: string | null } | null> {
    try {
      const params: Record<string, unknown> = { ref };
      if (documentId) params.documentId = documentId;
      if (expectRevision !== null) params.expectRevision = expectRevision;
      const request = makeContentRequest('element-state', params, 'native-describe-' + String(tabId) + '-' + ref);
      const reply = await this.content.request(tabId, request, {
        timeoutMs: Math.min(options.timeoutMs ?? 5000, 5000),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const normalizedReply = normalizeContentReply(reply);
      if (!normalizedReply.ok) return null;
      const result = normalizedReply.result;
      if (!result || typeof result !== 'object') return null;
      const view = result as Record<string, unknown>;
      return {
        tag: typeof view.tag === 'string' && view.tag ? view.tag : null,
        id: typeof view.id === 'string' && view.id ? view.id : null,
        role: typeof view.role === 'string' && view.role ? view.role : null,
        name: typeof view.name === 'string' && view.name ? view.name : null,
      };
    } catch {
      return null;
    }
  }

  /** --settle：动作成功后固定等待（返回 settledMs 证据；不是伪造的“页面已稳定”）。 */
  private async settleIfRequested(result: unknown, settleMs?: number): Promise<unknown> {
    if (!result || typeof result !== 'object') return result;
    const ms = Number(settleMs);
    if (!Number.isFinite(ms) || ms <= 0) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(ms)));
    return { ...(result as Record<string, unknown>), settledMs: Math.floor(ms) };
  }

  /**
   * 派发前闸门：context 收据、observation 收据（整页/节点级）、expect/depends-on 事实校验。
   * 任何失败都不派发动作（证据 data.effect_state='none' / dispatched=false）。
   */
  private async preflightGuards(method: string, normalized: NormalizedPageAction, options: ActionDispatchOptions): Promise<void> {
    const params = normalized.params;
    const tabId = normalized.tabId;
    const context = typeof params.context === 'string' ? params.context : '';
    const observationId = typeof params.observation === 'string' ? params.observation : '';
    const nodeScope = params.nodeScope === true;
    const mutating = method === 'click' || method === 'fill' || method === 'select';
    if (this.receipts) {
      const policy = this.receipts.getPolicy(tabId);
      if (context) {
        const receipt = this.receipts.getContext(tabId, context);
        if (!receipt) throw staleContext('未知 context', { context });
        if (receipt.used) throw staleContext('context 已使用（strict 单次）', { context });
        if (receipt.current !== true) throw staleContext('已被新的 cooperate sync 取代', { context });
        const state = await this.pageState(normalized, options);
        if (state && receipt.documentId && state.documentId !== receipt.documentId) {
          throw staleContext('文档已变化（导航后旧 context 失效）', {
            context,
            expectedDocumentId: receipt.documentId,
            actualDocumentId: state.documentId,
          });
        }
        if (policy === 'strict') this.receipts.markContextUsed(tabId, context);
      } else if (policy === 'strict' && mutating) {
        throw new RpcMethodError('E_CONTEXT_REQUIRED', 'strict 控制策略要求动作携带 --context（先 cooperate sync）', {
          policy: 'strict',
          method,
          effect_state: 'none',
          dispatched: false,
        });
      }
    }
    if (observationId && this.receipts) {
      const found = this.receipts.getObservation(tabId, observationId);
      if (!found.known || !found.receipt) throw staleObservation('未知 observation', { observation: observationId });
      const receipt = found.receipt;
      if (found.superseded || receipt.current !== true) {
        throw staleObservation('已被更新的观察取代', { observation: observationId });
      }
      const state = await this.pageState(normalized, options);
      if (state && receipt.documentId && state.documentId !== receipt.documentId) {
        throw staleObservation('文档已变化（导航后旧 observation 失效）', {
          observation: observationId,
          observed_changes: { scope: 'page', kinds: ['document'] },
          expectedDocumentId: receipt.documentId,
          actualDocumentId: state.documentId,
        });
      }
      if (nodeScope) {
        const targetRef = normalized.target.ref;
        const stored: NodeSignatureView | undefined = targetRef ? receipt.signatures[targetRef] : undefined;
        if (stored && state && state.target === null) throw targetDetached({ ref: targetRef });
        if (stored && state && state.target) {
          const current = normalizeSignatures({ k: state.target }).k;
          if (current) {
            // target_detached 的语义是“目标节点已不属于文档”：必须先于签名比较判定。
            // 脱离文档的节点仍保留 tag/id/text/value/checked，签名可能与观察时完全相同，
            // 只看签名会把“节点被移除”误报成“没变化”，最终落到内容脚本的 E_STALE_REF。
            if (current.attached === false) throw targetDetached({ ref: targetRef });
            const kinds: string[] = [];
            if (current.signature !== stored.signature) {
              if (current.text !== stored.text) kinds.push('text');
              if (current.value !== stored.value) kinds.push('value');
              if (current.checked !== stored.checked) kinds.push('checked');
              if (!current.attached) kinds.push('detached');
            }
            if (kinds.length) {
              throw observationChanged(kinds, {
                ref: targetRef,
                before: { signature: stored.signature, text: stored.text, value: stored.value },
                after: { signature: current.signature, text: current.text, value: current.value },
              });
            }
          }
        }
      } else if (state && receipt.fingerprint && state.fingerprint && state.fingerprint !== receipt.fingerprint) {
        throw staleObservation('页面已变化', {
          observation: observationId,
          observed_changes: {
            scope: 'page',
            kinds: ['text', 'structure'],
            before: receipt.fingerprint,
            after: state.fingerprint,
          },
        });
      }
    }
    const expectChecks = normalizeChecks(params.expect, '--expect');
    if (expectChecks.length) {
      const fact = await this.checkFacts(normalized, expectChecks, options);
      if (!fact.ok) throw expectFailed('expect', fact.mismatches);
    }
    const dependsChecks = normalizeChecks(params.dependsOn, '--depends-on');
    if (dependsChecks.length) {
      const fact = await this.checkFacts(normalized, dependsChecks, options);
      if (!fact.ok) throw expectFailed('depends-on', fact.mismatches);
    }
  }

  private async pageState(normalized: NormalizedPageAction, options: ActionDispatchOptions): Promise<{ documentId: string; fingerprint: string; url: string; target: Record<string, unknown> | null } | null> {
    const params: Record<string, unknown> = {};
    if (normalized.target.ref) params.ref = normalized.target.ref;
    else if (normalized.target.selector) params.selector = normalized.target.selector;
    const request = makeContentRequest('page-state', params, 'guard-page-state-' + String(normalized.tabId) + '-' + String(Math.floor(this.now())));
    try {
      const reply = await this.content.request(normalized.tabId, request, {
        timeoutMs: Math.min(options.timeoutMs ?? 8000, 8000),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const normalizedReply = normalizeContentReply(reply);
      if (!normalizedReply.ok) return null;
      const result = normalizedReply.result as { documentId?: string; fingerprint?: string; url?: string; target?: unknown } | null;
      return {
        documentId: String(result?.documentId ?? ''),
        fingerprint: String(result?.fingerprint ?? ''),
        url: String(result?.url ?? ''),
        target: result?.target && typeof result.target === 'object' ? result.target as Record<string, unknown> : null,
      };
    } catch {
      return null;
    }
  }

  private async checkFacts(
    normalized: NormalizedPageAction,
    checks: Array<{ target: string; field: string; equals: unknown }>,
    options: ActionDispatchOptions,
  ): Promise<{ ok: boolean; mismatches: Array<{ target: string; field: string; expected: unknown; actual: unknown; kind: string }> }> {
    const request = makeContentRequest('check-facts', { checks }, 'guard-facts-' + String(normalized.tabId) + '-' + String(Math.floor(this.now())));
    const reply = await this.content.request(normalized.tabId, request, {
      timeoutMs: Math.min(options.timeoutMs ?? 8000, 8000),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const normalizedReply = normalizeContentReply(reply);
    if (!normalizedReply.ok) {
      return {
        ok: false,
        mismatches: [{ target: checks[0]?.target ?? '', field: checks[0]?.field ?? '', expected: checks[0]?.equals, actual: null, kind: 'unavailable' }],
      };
    }
    const result = normalizedReply.result as { ok?: boolean; mismatches?: Array<{ target: string; field: string; expected: unknown; actual: unknown; kind: string }> } | null;
    return { ok: result?.ok === true, mismatches: Array.isArray(result?.mismatches) ? result.mismatches : [] };
  }

  /** 组装下发给内容脚本的请求（含 refKey 与页面侧二次校验字段）。 */
  private buildContentRequest(
    spec: ActionSpec,
    normalized: NormalizedPageAction,
    options: ActionDispatchOptions,
  ): ContentRequest {
    const params: Record<string, unknown> = { ...targetParams(normalized.target), ...normalized.params };
    // observe（含 --vom/--closed-shadow）：把主文档 cdpSessionId 一起下发给内容脚本，
    // 让 rich 节点 stableRef 与 background refDetails 用同一 identity（5b/35b）。
    if (spec.method === 'observe' && (typeof params.cdpSessionId !== 'string' || !params.cdpSessionId)) {
      params.cdpSessionId = makeCdpSessionId(normalized.tabId, 0);
    }
    const preflight = this.preflightRef(normalized);
    if (preflight) {
      params.ref = preflight.ref;
      params.documentId = preflight.documentId;
      if (preflight.expectRevision !== null) params.expectRevision = preflight.expectRevision;
      params.refKey = {
        documentId: preflight.documentId,
        revision: preflight.revision,
        generation: preflight.generation,
        signature: preflight.signature,
      };
    }
    const requestId = options.requestId
      ?? 'cmd-' + spec.method + '-' + normalized.tabId + '-' + Math.floor(this.now()).toString(36);
    return makeContentRequest(CONTENT_OP_BY_METHOD[spec.method], params, requestId);
  }

  /**
   * ref 生命周期预检：
   * - stableRef → @eN；两个都没给（selector/text 路径）时返回 null；
   * - 注册表里没有该 ref / expectRevision 不符 → E_STALE_REF（动作不会下发给页面）；
   * - 调用方显式给了 observation 的 documentId/revision 时做整页观察校验，
   *   失败回 E_OBSERVATION_STALE（旧观察收据不可用）。
   */
  private preflightRef(normalized: NormalizedPageAction): {
    ref: string;
    documentId: string;
    revision: number | null;
    generation: number;
    signature: string;
    expectRevision: number | null;
  } | null {
    const target = normalized.target;
    if (target.text && !target.ref && !target.selector && !target.stableRef) return null;
    let ref = target.ref;
    if (!ref && target.stableRef) {
      const byStable = this.refs.getByStableRef(normalized.tabId, target.stableRef);
      if (!byStable) {
        throw new RpcMethodError('E_STALE_REF', 'stableRef 不在当前观察里，请重新 observe', {
          stableRef: target.stableRef,
        });
      }
      ref = byStable.ref;
    }
    if (!ref) return null;

    const expectation: RefExpectation = {};
    const expectRevision = Number(normalized.params.expectRevision);
    if (Number.isInteger(expectRevision)) expectation.revision = expectRevision;
    const resolved = this.refs.resolve(normalized.tabId, ref, expectation);
    if (!resolved.ok) {
      throw new RpcMethodError(resolved.code, resolved.message, {
        ref,
        reason: resolved.reason,
        ...(Number.isInteger(expectRevision) ? { expectRevision } : {}),
      });
    }

    // 整页观察校验（read --node-scope / 显式 observationRevision 场景）：ref 级通过但
    // 调用方给的是旧 observation 时回 E_OBSERVATION_STALE，与 JS 的错误语义一致。
    const observedDocument = typeof normalized.params.observationDocumentId === 'string' ? normalized.params.observationDocumentId : null;
    const observedRevision = Number(normalized.params.observationRevision);
    if (observedDocument || Number.isInteger(observedRevision)) {
      const freshness = assessObservationFreshness(
        { documentId: observedDocument, revision: Number.isInteger(observedRevision) ? observedRevision : null },
        { documentId: resolved.meta.key.documentId, revision: resolved.meta.key.revision },
      );
      if (!freshness.ok) {
        throw new RpcMethodError(freshness.code, freshness.message, {
          ref,
          reason: freshness.reason,
          observedDocumentId: observedDocument,
          observedRevision: Number.isInteger(observedRevision) ? observedRevision : null,
          actualDocumentId: resolved.meta.key.documentId,
          actualRevision: resolved.meta.key.revision,
        });
      }
    }

    return {
      ref,
      documentId: resolved.meta.key.documentId,
      revision: resolved.meta.key.revision,
      generation: resolved.meta.generation,
      signature: resolved.meta.signature,
      expectRevision: Number.isInteger(expectRevision) ? expectRevision : null,
    };
  }

  /** 动作成功后的收尾：observe 建 ref 表；其它动作原样返回（含合成事件证据）。 */
  private finish(
    spec: ActionSpec,
    normalized: NormalizedPageAction,
    result: unknown,
    _options: ActionDispatchOptions,
  ): unknown {
    switch (spec.method) {
      case 'observe':
        return this.finishObserve(normalized, result as ContentObserveResult);
      case 'click':
        return finishClick(normalized, result as ContentClickResult);
      case 'fill':
        return finishFill(normalized, result as ContentFillResult);
      case 'read':
        return finishRead(normalized, result as ContentReadResult);
      case 'select':
        return finishSelect(normalized, result as ContentSelectResult);
      case 'get-html':
        return finishGetHtml(normalized, result as ContentGetHtmlResult);
      case 'evaluate':
        return finishEvaluate(result as ContentEvaluateResult);
      default:
        return result;
    }
  }

  private finishObserve(normalized: NormalizedPageAction, result: ContentObserveResult): ObserveActionResult & {
    refsRegistered: number;
    refsSkipped: number;
    closedShadowRegistered: number;
    depthOmitted: number;
    cursor: string | null;
    offset: number;
    budget: { chars: number; omittedChars: number; truncated: boolean };
  } {
    const observationId = newObservationId(normalized.tabId, this.random);
    // cdpSessionId 语义固定为 `tabId:frameId`（主文档 :0，35b）；同一值会随 observe 请求
    // 下发给内容脚本，因此 rich 节点 stableRef 与这里的 refDetails 逐字符一致（5b）。
    const cdpSessionId = makeCdpSessionId(normalized.tabId, 0);
    const { action, input } = toObserveActionResult(result, {
      tabId: normalized.tabId,
      observationId,
      random: this.random,
      context: { documentId: result?.documentId ?? null, frameId: 0, cdpSessionId },
    });
    // refDetails 展示字段补齐（35b）：命中测试/遮挡/视口/pointer-events 来自同一次观察的
    // 节点事实；节点没有这些字段时显式 null（不伪造）。identity/stableRef 不改。
    const nodeByRef = new Map<string, Record<string, unknown>>();
    for (const node of Array.isArray(result?.nodes) ? result.nodes : []) {
      if (!node || typeof node !== 'object') continue;
      const view = node as unknown as Record<string, unknown>;
      if (typeof view.ref === 'string' && view.ref) nodeByRef.set(view.ref, view);
    }
    for (const detail of action.refDetails) {
      const node = nodeByRef.get(detail.ref);
      detail.cdpSessionId = cdpSessionId;
      detail.hitTest = node && typeof node.hitTest === 'string' ? node.hitTest : null;
      detail.occludedBy = node && node.occludedBy && typeof node.occludedBy === 'object'
        ? node.occludedBy as ObservationRefDetail['occludedBy']
        : null;
      detail.inViewport = node && typeof node.inViewport === 'boolean' ? node.inViewport : null;
      detail.pointerEvents = node && typeof node.pointerEvents === 'string' ? node.pointerEvents : null;
    }
    const rich = result?.richResult && typeof result.richResult === 'object' ? result.richResult as Record<string, unknown> : null;
    const refsPipeline = rich?.fallback === 'ax' || rich?.pipeline === 'ax';
    // AX 兜底/管线：结果里没有 ref，保持上一次真实 observe 的 ref 表（不静默清空）。
    const registration = refsPipeline
      ? { registered: 0, skipped: input.refs.length }
      : this.refs.registerObservation(normalized.tabId, input);
    // closed shadow ref 必须**在 registerObservation 之后**登记（后者整体失效旧表）：
    // 这里把 CDP pierce 枚举出的候选按 `tabId:frameId` 上下文写成 source='closed-shadow'
    // 的可路由 ref（20v）；click/read 在 dispatch 里走 pierce。
    const closedShadowEntries = rich && Array.isArray(rich.closedShadow) ? rich.closedShadow : [];
    let closedShadowRegistered = 0;
    if (closedShadowEntries.length) {
      const shadowRegistration = registerClosedShadowRefs(this.refs, normalized.tabId, {
        documentId: String(result?.documentId ?? ''),
        revision: Number.isInteger(result?.revision) ? Number(result.revision) : null,
        frameId: 0,
        cdpSessionId,
      }, closedShadowEntries as Array<{ ref: string; text?: string; tag?: string; role?: string; name?: string; backendNodeId?: number }>);
      closedShadowRegistered = shadowRegistration.registered;
    }
    const observation = rich && typeof rich.observation === 'string' && rich.observation.length > 0
      ? rich.observation
      : action.observation;
    const merged: Record<string, unknown> = {
      ...action,
      observation,
      refsPipeline,
      refsRegistered: registration.registered,
      refsSkipped: registration.skipped,
      closedShadowRegistered,
      depthOmitted: Number.isInteger(result?.depthOmitted) ? Number(result.depthOmitted) : 0,
      cursor: typeof result?.cursor === 'string' ? result.cursor : null,
      offset: Number.isInteger(result?.offset) ? Number(result.offset) : 0,
      fingerprint: typeof result?.fingerprint === 'string' ? result.fingerprint : '',
      signatures: result?.signatures && typeof result.signatures === 'object' ? result.signatures : {},
      budget: {
        chars: Number.isInteger(result?.chars) ? Number(result.chars) : 0,
        omittedChars: Number.isInteger(result?.omittedChars) ? Number(result.omittedChars) : 0,
        truncated: result?.truncated === true,
      },
    };
    if (rich) {
      const { nodes: richNodes, observation: _richObservation, ...rest } = rich;
      void _richObservation;
      Object.assign(merged, rest);
      if (Array.isArray(richNodes)) merged.nodes = richNodes;
    }
    return merged as unknown as ObserveActionResult & {
      refsRegistered: number;
      refsSkipped: number;
      closedShadowRegistered: number;
      depthOmitted: number;
      cursor: string | null;
      offset: number;
      budget: { chars: number; omittedChars: number; truncated: boolean };
    };
  }
}

// ---------------------------------------------------------------------------
// 结果收尾（补齐 CLI/E2E 依赖的字段；不伪造未迁移的证据）
// ---------------------------------------------------------------------------

function targetLabel(normalized: NormalizedPageAction): { ref: string | null; selector: string | null } {
  return {
    ref: normalized.target.ref ?? null,
    selector: normalized.target.selector ?? null,
  };
}

function finishClick(normalized: NormalizedPageAction, result: ContentClickResult): Record<string, unknown> {
  const label = targetLabel(normalized);
  return {
    ok: true,
    ref: result?.ref ?? label.ref,
    selector: result?.selector ?? label.selector,
    tag: result?.tag ?? null,
    x: result?.x ?? null,
    y: result?.y ?? null,
    via: result?.via ?? 'content-script',
    hit: result?.hit ?? null,
    isConnected: result?.isConnected !== false,
    trusted: false,
    synthetic: true,
    human: normalized.params.human === true,
    effectState: 'committed',
    evidence: {
      inputMode: normalized.params.human === true ? 'content-script-human-track' : 'content-script',
      trustedRequested: normalized.params.trustedRequested === true,
      at: null,
    },
  };
}

function finishFill(normalized: NormalizedPageAction, result: ContentFillResult): Record<string, unknown> {
  const label = targetLabel(normalized);
  return {
    ok: true,
    ref: result?.ref ?? label.ref,
    selector: result?.selector ?? label.selector,
    tag: result?.tag ?? null,
    expected_value: result?.expected_value ?? normalized.params.value,
    actual_value: result?.actual_value ?? null,
    matches: result?.matches === true,
    cleared: result?.cleared === true,
    via: result?.via ?? 'content-script',
    trusted: false,
    synthetic: true,
    effectState: result?.matches === true ? 'committed' : 'unknown',
  };
}

function finishRead(normalized: NormalizedPageAction, result: ContentReadResult): Record<string, unknown> {
  const label = targetLabel(normalized);
  // --fields-json：内容脚本给扁平对象（键来自字段规格）；background 直接透出，
  // 不再包成 {key,tag,text,value} 的默认字段形状（CLI 用 read.fields[0].<key> 读取）。
  if (Array.isArray(result?.flatFields) && result.flatFields.length) {
    return {
      ok: true,
      ref: result.ref ?? label.ref,
      selector: result.selector ?? label.selector,
      fields: result.flatFields,
      count: result.flatFields.length,
      value: null,
      fieldsMode: 'spec',
    };
  }
  const fields = Array.isArray(result?.fields) ? result.fields : [];
  return {
    ok: true,
    ref: result?.ref ?? label.ref,
    selector: result?.selector ?? label.selector,
    fields,
    count: fields.length,
    // 与 JS read 的字段口径对齐：单目标读取时把第一个字段摊平，CLI 历史输出依赖 value。
    value: fields.length === 1 ? fields[0]?.value ?? null : null,
    all: normalized.params.all === true,
  };
}

function finishSelect(normalized: NormalizedPageAction, result: ContentSelectResult): Record<string, unknown> {
  const label = targetLabel(normalized);
  return {
    ok: true,
    ref: result?.ref ?? label.ref,
    selector: result?.selector ?? label.selector,
    expected_value: result?.expected_value ?? normalized.params.value,
    actual_value: result?.actual_value ?? null,
    matches: result?.matches === true,
    via: result?.via ?? 'content-script',
  };
}

function finishGetHtml(normalized: NormalizedPageAction, result: ContentGetHtmlResult): Record<string, unknown> {
  const label = targetLabel(normalized);
  return {
    ok: true,
    html: typeof result?.html === 'string' ? result.html : '',
    tag: result?.tag ?? null,
    ref: result?.ref ?? label.ref,
    selector: result?.selector ?? label.selector,
    ...(result?.outer === true ? { outer: true } : {}),
    truncated: result?.truncated === true,
    ...(typeof result?.fullLength === 'number' ? { fullLength: result.fullLength, bytes: result.fullLength } : {}),
    ...(result?.facts ? { facts: result.facts } : {}),
  };
}

function finishEvaluate(result: ContentEvaluateResult): Record<string, unknown> {
  const expression = typeof result?.expression === 'string' ? result.expression : '';
  return {
    ok: true,
    value: result?.value ?? null,
    expression,
    world: result?.world ?? 'content-script',
    // TS 运行时没有 CDP，evaluate 走内容脚本隔离世界；页面主世界变量不可见，如实标注。
    verified: false,
    note: 'TS 运行时 evaluate 在内容脚本隔离世界执行（无 chrome.debugger）',
  };
}

/** 方法说明（诊断/注册表自描述用，不含水分）。 */
function describeAction(method: ActionMethod): string {
  switch (method) {
    case 'observe':
      return '页面语义树观察：可见节点 → 文本行 + @eN ref，并重建 ref 签名表（VOM/AX/facts 摘要由 rich.ts 提供）';
    case 'click':
      return '点击 ref/selector 目标：elementFromPoint 命中校验后派发合成 click（dialog 近似包装在 background）';
    case 'fill':
      return '填写输入框：原生 value setter + input/change 事件 + 读回校验';
    case 'read':
      return '读取字段值/文本/属性（支持单目标与 --all 枚举）';
    case 'select':
      return '选择 select 选项（按 value 其次文本匹配）+ input/change';
    case 'get-html':
      return '读取目标元素内部 HTML';
    case 'evaluate':
      return '在页面主世界执行表达式（chrome.scripting MAIN；无 chrome.debugger）';
    default:
      return '';
  }
}
