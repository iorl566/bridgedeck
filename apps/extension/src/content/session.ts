// src/content/session.ts —— 页面侧会话：ref 表、revision、动作分派。
//
// 内容脚本每次注入都是新实例（导航/重载即重建），所以就是天然的一次 observe 生命周期：
// - documentId 由注入时生成并保持不变（同文档多次 observe 的签名可比较）；
// - 每次 observe 推进 revision 并整体重建 ref 表（旧 @eN 立即失效 → E_STALE_REF）；
// - 动作命令带 background 侧的 documentId/expectRevision 时在这里做二次校验，
//   防止 background 注册表与页面实际文档错位（例如导航后的迟到命令）。

import {
  buildObservation,
  clickElement,
  evaluateExpression,  fillElement,
  findByText,
  getHtmlOf,
  pageInfo,
  PageError,
  readFields,
  resolveTarget,
  selectOption,
  setNativeValue,
  type DomEnvironment,
  type ElementLike,
  type ObservationOptions,
} from './dom.ts';
import { handleTakeoverOverlayOp } from './takeover-overlay.ts';
import {
  blurElement,
  clickPoint,
  dragElement,
  elementStateOf,
  extractPage,
  focusElement,
  hoverElement,
  pageMetrics,
  pressKey,
  readFieldSpecs,
  readResourceEntries,
  scrollPage,
  visualRefsOf,
  wheelScroll,
  type FieldSpec,
} from './advanced.ts';
import { buildRichObservation, mergeClosedShadowEntries, mergeUnmappedAxEntries, closedShadowAsUnmappedAx, type RichOptions, type RichResult } from './rich.ts';
import { vomWeightOptionsOf } from './vom-weights.ts';
import {
  CooperationTracker,
  fingerprintOf,
  frameInventory,
  setManualOverlay,
  signatureOfElement,
  type NodeSignature,
} from './track.ts';
import { applyUpload, assembleFileBatches, classifyUploadTarget, validateUploadFiles, type StagedUpload } from './files.ts';
import type {
  ContentCheckFactsResult,
  ContentClickResult,
  ContentClosedShadowCandidate,
  ContentCooperationStateResult,
  ContentElementState,
  ContentEvaluateResult,
  ContentExtractPayload,
  ContentFillResult,
  ContentFrameInventoryResult,
  ContentGetHtmlResult,
  ContentManualOverlayResult,
  ContentMetricsResult,
  ContentNetworkEntriesResult,
  ContentObserveResult,
  ContentPageStateResult,
  ContentPingResult,
  ContentReadResult,
  ContentReply,
  ContentRequest,
  ContentScrollResult,
  ContentSelectResult,
  ContentThinActionResult,
  ContentUnmappedAxCandidate,
  ContentUnmappedAxEntry,
  ContentUploadCommitResult,
  ContentUploadPrepareResult,
  ContentVisualRefsResult,
  ContentOp,
} from './protocol.ts';

export interface ContentSessionOptions {
  protocol: string;
  /** 测试注入：固定 documentId；缺省随机生成。 */
  documentId?: string;
  /** observe 预算覆盖（测试/大页面）。 */
  observation?: ObservationOptions;
  now?: () => number;
  random?: () => number;
}

export interface ObserveParams extends ObservationOptions {
  [key: string]: unknown;
}

export interface GetHtmlParams {
  ref?: unknown;
  selector?: unknown;
  documentId?: unknown;
  expectRevision?: unknown;
  outer?: unknown;
  maxChars?: unknown;
  [key: string]: unknown;
}

export interface ScrollParams {
  ref?: unknown;
  selector?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  documentId?: unknown;
  expectRevision?: unknown;
  [key: string]: unknown;
}

export interface DragParams extends PageTargetParams {
  dx?: unknown;
  dy?: unknown;
  holdMs?: unknown;
  durationMs?: unknown;
  steps?: unknown;
  [key: string]: unknown;
}

export interface ClickPointParams {
  x?: unknown;
  y?: unknown;
  [key: string]: unknown;
}

export interface WheelParams extends PageTargetParams {
  deltaX?: unknown;
  deltaY?: unknown;
  [key: string]: unknown;
}

export interface PressParams extends PageTargetParams {
  key?: unknown;
  [key: string]: unknown;
}

export interface ExtractRawParams {
  mode?: unknown;
  target?: unknown;
  ref?: unknown;
  selector?: unknown;
  itemSelector?: unknown;
  fields?: unknown;
  [key: string]: unknown;
}

export interface PageTargetParams {
  ref?: unknown;
  selector?: unknown;
  text?: unknown;
  documentId?: unknown;
  expectRevision?: unknown;
  force?: unknown;
}

export interface ClickParams extends PageTargetParams {
  [key: string]: unknown;
}

export interface FillParams extends PageTargetParams {
  value?: unknown;
  noClear?: unknown;
  [key: string]: unknown;
}

export interface ReadParams extends PageTargetParams {
  all?: unknown;
  key?: unknown;
  attribute?: unknown;
  fields?: unknown;
  [key: string]: unknown;
}

export interface SelectParams extends PageTargetParams {
  value?: unknown;
  [key: string]: unknown;
}

export interface EvaluateParams {
  expression?: unknown;
  [key: string]: unknown;
}

interface TargetRefEntry {
  element: ElementLike;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** thenable 判定（click 的有界异步复核回包；其它操作保持同步）。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}

/** 生成文档 id：同一内容脚本实例内稳定（时间 + 随机，不参与安全判定）。 */
export function newDocumentId(now: () => number = Date.now, random: () => number = Math.random): string {
  const time = Math.floor(Math.max(0, now())).toString(36);
  const salt = Math.floor(Math.max(0, random()) * 0xffffffff).toString(36);
  return 'doc-' + time + '-' + salt;
}

/**
 * 页面侧会话。
 *
 * ```ts
 * const session = new ContentSession({ document: fakeDoc, window: fakeWin }, { protocol: '1.9' });
 * const reply = session.handle({ type: 'bb.content', requestId: 'r1', op: 'observe', params: {} });
 * ```
 */
export class ContentSession {
  readonly documentId: string;
  readonly tracker: CooperationTracker;
  private readonly env: DomEnvironment;
  private readonly protocolValue: string;
  private readonly observationOptions: ObservationOptions;
  private revisionValue = 0;
  private refs = new Map<string, TargetRefEntry>();
  private readonly uploads = new Map<string, StagedUpload>();
  private uploadSeq = 0;

  constructor(env: DomEnvironment, options: ContentSessionOptions) {
    this.env = env;
    this.protocolValue = String(options.protocol || '');
    this.documentId = options.documentId && options.documentId.trim()
      ? options.documentId.trim()
      : newDocumentId(options.now ?? Date.now, options.random ?? Math.random);
    this.observationOptions = options.observation ?? {};
    this.tracker = new CooperationTracker(env);
  }

  /** 当前文档 revision（每次成功 observe +1）。 */
  get revision(): number {
    return this.revisionValue;
  }

  /** 当前 ref 表大小。 */
  get refCount(): number {
    return this.refs.size;
  }

  /** 清空 ref 表（导航/文档重建时内容脚本会被重建，此处仅供单测/诊断）。 */
  reset(): void {
    this.refs.clear();
    this.revisionValue = 0;
  }

  /** 页面内 ref 表快照（只读，便于测试断言）。 */
  refHandles(): string[] {
    return [...this.refs.keys()];
  }

  /**
   * 分派一条请求（同步口径）；任何异常都转成结构化失败回包。
   *
   * 注意：click 在 focus 后需要 ≤50ms 的有界复核（捕获异步替换），返回的其实是 thenable。
   * 历史的同步测试仍可直接 `await session.handle(...)`；新入口统一用 {@link handleAsync}
   * 拿到明确的 Promise 回包（content bridge 用异步 sendResponse 保持消息通道）。
   */
  handle(request: ContentRequest): ContentReply {
    return this.replyOf(request) as ContentReply;
  }

  /** 明确的异步回包入口（click 的有界复核是异步的；其它操作也统一按 Promise 返回）。 */
  async handleAsync(request: ContentRequest): Promise<ContentReply> {
    const reply = this.replyOf(request);
    if (isPromiseLike(reply)) return await (reply as Promise<ContentReply>);
    return reply as ContentReply;
  }

  private replyOf(request: ContentRequest): ContentReply | Promise<ContentReply> {
    try {
      const result = this.dispatch(request.op, request.params);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (value) => ({ ok: true, result: value } as ContentReply),
          (error: unknown) => failureOf(error),
        );
      }
      return { ok: true, result };
    } catch (error) {
      return failureOf(error);
    }
  }

  private dispatch(op: ContentOp, params: Record<string, unknown>): unknown {
    switch (op) {
      case 'ping':
        return this.ping();
      case 'observe':
        return this.observe(params as ObserveParams);
      case 'click':
        return this.click(params as ClickParams);
      case 'fill':
        return this.fill(params as FillParams);
      case 'read':
        return this.read(params as ReadParams);
      case 'select':
        return this.select(params as SelectParams);
      case 'get-html':
        return this.getHtml(params as GetHtmlParams);
      case 'evaluate':
        return this.evaluate(params as EvaluateParams);
      case 'metrics':
        return this.metrics();
      case 'scroll':
        return this.scroll(params as ScrollParams);
      case 'element-state':
        return this.elementState(params as PageTargetParams);
      case 'visual-refs':
        return this.visualRefs();
      case 'hover':
        return this.hover(params as PageTargetParams);
      case 'focus':
        return this.focusTarget(params as PageTargetParams);
      case 'press':
        return this.press(params as PressParams);
      case 'wheel':
        return this.wheel(params as WheelParams);
      case 'blur':
        return this.blur(params as PageTargetParams);
      case 'drag':
        return this.drag(params as DragParams);
      case 'click-point':
        return this.clickAtPoint(params as ClickPointParams);
      case 'extract':
        return this.extract(params as ExtractRawParams);
      case 'network-entries':
        return this.networkEntries();
      case 'cooperation-state':
        return this.cooperationState(params);
      case 'page-state':
        return this.pageState(params);
      case 'check-facts':
        return this.checkFacts(params);
      case 'frame-inventory':
        return this.frameInventory();
      case 'manual-overlay':
        return this.manualOverlay(params);
      // M-C 第八批：截图期间隐藏/恢复 takeover 浮层（隐藏、恢复、查询三态）。
      case 'overlay-suppress':
        return handleTakeoverOverlayOp(params);
      case 'upload-prepare':
        return this.uploadPrepare(params);
      case 'upload-chunk':
        return this.uploadChunk(params);
      case 'upload-commit':
        return this.uploadCommit(params);
      default:
        // ContentOp 是闭合联合，正常不可达；防御性兜底避免未来加 op 时静默成功。
        throw new PageError('E_UNKNOWN_OP', '内容脚本不支持的操作：' + String(op));
    }
  }

  private ping(): ContentPingResult {
    const info = pageInfo(this.env);
    return {
      runtime: 'ts',
      protocol: this.protocolValue,
      documentId: this.documentId,
      revision: this.revisionValue,
      url: info.url,
    };
  }

  private observe(params: ObserveParams): ContentObserveResult {
    const built = buildObservation(this.env, { ...this.observationOptions, ...budgetOf(params) });
    this.revisionValue += 1;
    this.refs = new Map();
    for (const [handle, element] of built.refsByHandle) {
      this.refs.set(handle, { element, revision: this.revisionValue });
    }
    const cdpSessionId = cdpSessionIdOf(params);
    // closed shadow 的候选来自 background（CDP DOM.pierce）；内容脚本只做接收/合并。
    const closedShadowCandidates = closedShadowCandidatesOf(params);
    const unmappedCandidates = unmappedAxCandidatesOf(params);
    const richOptions: RichOptions = {
      vom: params.vom === true,
      vomDeep: params.vomDeep === true,
      ax: params.ax === true,
      facts: params.facts === true,
      fallbackAx: params.fallbackAx === true,
      compareAx: params.compareAx === true,
      debugSurfaces: params.debugSurfaces === true,
      closedShadow: params.closedShadow === true || closedShadowCandidates.length > 0,
      weights: vomWeightOptionsOf(params),
      ...(typeof params.pipeline === 'string' ? { pipeline: params.pipeline } : {}),
    };
    const wantsRich = richOptions.vom || richOptions.vomDeep || richOptions.ax || richOptions.facts
      || richOptions.fallbackAx || richOptions.compareAx || richOptions.debugSurfaces
      || richOptions.pipeline === 'ax';
    const signatures: Record<string, NodeSignature> = {};
    for (const [handle, element] of built.refsByHandle) signatures[handle] = signatureOfElement(element);
    const rich = wantsRich
      ? buildRichObservation(this.env, built, richOptions, {
        documentId: this.documentId,
        frameId: 0,
        cdpSessionId,
      })
      : null;
    let observation = rich && typeof rich.observation === 'string' && rich.observation.length > 0
      ? rich.observation
      : built.observation;
    // closed shadow 只读并入：编号接在主文档 ref 之后（@eN），观察行与 JS 页面库同形。
    // 条目随 richResult 回给 background 登记（source='closed-shadow' → 动作走 CDP pierce）。
    const closedShadow = closedShadowCandidates.length
      ? mergeClosedShadowEntries({ observation, startRef: built.refs, candidates: closedShadowCandidates })
      : null;
    if (closedShadow) observation = closedShadow.observation;
    const unmappedAx = mergeUnmappedAxSection({
      observation,
      candidates: unmappedCandidates,
      closedShadowCandidates,
      ax: richOptions.ax === true,
    });
    if (unmappedAx) observation = unmappedAx.observation;
    const richBag = (rich ?? {}) as RichResult & Record<string, unknown>;
    if (closedShadow) richBag.closedShadow = closedShadow.entries;
    if (unmappedAx) richBag.unmappedAx = unmappedAx.entries;
    if (rich || closedShadow || unmappedAx) richBag.observation = observation;
    const result: ContentObserveResult = {
      url: built.url,
      title: built.title,
      observation,
      refs: richOptions.fallbackAx === true || richOptions.pipeline === 'ax' ? 0 : built.refs,
      revision: this.revisionValue,
      documentId: this.documentId,
      nodes: richOptions.fallbackAx === true || richOptions.pipeline === 'ax'
        ? []
        : (rich && Array.isArray(rich.nodes) ? (rich.nodes as unknown as ContentObserveResult['nodes']) : built.nodes),
      filtered: built.filtered,
      truncated: built.truncated,
      depthOmitted: built.depthOmitted,
      chars: built.chars,
      omittedChars: built.omittedChars,
      offset: built.offset,
      cursor: built.truncated && built.observation.length > 0
        ? 'o1.' + String(built.offset + built.observation.split('\n').length)
        : null,
      fingerprint: fingerprintOf(this.env.document as unknown as Document, this.env.window as unknown as Window),
      signatures,
      ...(cdpSessionId ? { cdpSessionId } : {}),
      ...(closedShadow ? { closedShadow: closedShadow.entries } : {}),
      ...(unmappedAx ? { unmappedAx: unmappedAx.entries } : {}),
    };
    if (rich || closedShadow || unmappedAx) result.richResult = richBag as unknown as Record<string, unknown>;
    return result;
  }

  /** 目标解析 + 文档/revision 二次校验（background 注册表之外的页面侧防线）。 */
  private resolve(params: PageTargetParams) {
    const expectedDocument = typeof params.documentId === 'string' && params.documentId ? params.documentId : null;
    if (expectedDocument && expectedDocument !== this.documentId) {
      throw new PageError('E_STALE_REF', 'ref 属于旧 document，请重新 observe', {
        expectedDocumentId: expectedDocument,
        actualDocumentId: this.documentId,
      });
    }
    const ref = typeof params.ref === 'string' && params.ref ? params.ref : null;
    const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;
    const text = typeof params.text === 'string' && params.text ? params.text : null;
    if (!ref && !selector && text) {
      const byText = findByText(this.env, text);
      if (!byText) throw new PageError('E_NOT_FOUND', '没有找到文本匹配的元素：' + text, { text });
      return { element: byText, ref: null, selector: null };
    }
    const resolved = resolveTarget(this.env.document, elementMapOf(this.refs), { ref, selector });
    if (ref) {
      const expectedRevision = Number(params.expectRevision);
      const entry = this.refs.get(ref);
      if (entry && Number.isInteger(expectedRevision) && entry.revision !== expectedRevision) {
        throw new PageError('E_STALE_REF', 'ref 与 expectRevision 不匹配，请重新 observe', {
          ref,
          expectRevision: expectedRevision,
          actualRevision: entry.revision,
        });
      }
    }
    return resolved;
  }

  private click(params: ClickParams): Promise<ContentClickResult> {
    const resolved = this.resolve(params);
    const human = params.human === true;
    return clickElement(this.env, resolved, {
      force: params.force === true,
      human,
      onAgentDispatch: (phase, kind) => {
        if (phase === 'begin') this.tracker.beginAgentInput(kind);
        else this.tracker.endAgentInput();
      },
    });
  }

  private fill(params: FillParams): ContentFillResult {
    const resolved = this.resolve(params);
    return fillElement(this.env, resolved, params.value, { noClear: params.noClear === true });
  }

  private read(params: ReadParams): ContentReadResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    const resolved = hasTarget ? this.resolve(params) : null;
    if (resolved && Array.isArray(params.fields) && params.fields.length) {
      const specs = fieldsOf(params.fields);
      if (specs.length) return readFieldSpecs(this.env, resolved, specs);
    }
    return readFields(this.env, resolved, {
      all: params.all === true,
      key: typeof params.key === 'string' ? params.key : undefined,
      attribute: typeof params.attribute === 'string' ? params.attribute : null,
    });
  }

  private select(params: SelectParams): ContentSelectResult {
    const resolved = this.resolve(params);
    return selectOption(this.env, resolved, params.value);
  }

  private getHtml(params: GetHtmlParams): ContentGetHtmlResult {
    const outer = params.outer === true;
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    const resolved = hasTarget ? this.resolve(params) : null;
    return getHtmlOf(resolved, this.env, {
      outer: outer || !hasTarget,
      maxChars: Number.isFinite(Number(params.maxChars)) ? Number(params.maxChars) : undefined,
    });
  }

  private evaluate(params: EvaluateParams): ContentEvaluateResult {
    return evaluateExpression(params.expression);
  }

  // -- 第三批：只读事实 ------------------------------------------------------

  private metrics(): ContentMetricsResult {
    // revision 由会话的 DOM tracker 维护（长截图的 stale 判定需要"同尺寸但内容变了"的信号）。
    return { ...pageMetrics(this.env, this.documentId), revision: this.revisionValue };
  }

  private elementState(params: PageTargetParams): ContentElementState {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    return elementStateOf(this.env, hasTarget ? this.resolve(params) : null);
  }

  private visualRefs(): ContentVisualRefsResult {
    const entries: Array<{ ref: string; element: ElementLike }> = [];
    for (const [ref, entry] of this.refs) entries.push({ ref, element: entry.element });
    return visualRefsOf(this.env, entries, String(this.env.document.URL ?? ''));
  }

  private scroll(params: ScrollParams): ContentScrollResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    return scrollPage(this.env, {
      resolved: hasTarget ? this.resolve(params) : null,
      x: Number.isFinite(Number(params.x)) ? Number(params.x) : null,
      y: Number.isFinite(Number(params.y)) ? Number(params.y) : null,
    });
  }

  // -- 第三批：薄动作 --------------------------------------------------------

  private hover(params: PageTargetParams): ContentThinActionResult {
    return hoverElement(this.env, this.resolve(params));
  }

  private focusTarget(params: PageTargetParams): ContentThinActionResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    return focusElement(this.env, hasTarget ? this.resolve(params) : null);
  }

  private press(params: PressParams): ContentThinActionResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    this.tracker.beginAgentInput('keydown');
    try {
      return pressKey(this.env, hasTarget ? this.resolve(params) : null, String(params.key ?? ''));
    } finally {
      this.tracker.endAgentInput();
    }
  }

  private wheel(params: WheelParams): ContentThinActionResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    return wheelScroll(
      this.env,
      hasTarget ? this.resolve(params) : null,
      Number(params.deltaX) || 0,
      Number(params.deltaY) || 0,
    );
  }

  private blur(params: PageTargetParams): ContentThinActionResult {
    const hasTarget = (typeof params.ref === 'string' && params.ref) || (typeof params.selector === 'string' && params.selector);
    return blurElement(this.env, hasTarget ? this.resolve(params) : null);
  }

  private drag(params: DragParams): ContentThinActionResult {
    const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map((item) => String(item)) : [];
    return dragElement(this.env, this.resolve(params), {
      dx: Number(params.dx) || 0,
      dy: Number(params.dy) || 0,
      steps: Number(params.steps) || 6,
      holdMs: Number(params.holdMs) || 0,
      durationMs: Number(params.durationMs) || 0,
      toSelector: typeof params.toSelector === 'string' ? params.toSelector : null,
      modifiers,
    });
  }

  private clickAtPoint(params: ClickPointParams): ContentThinActionResult {
    return clickPoint(this.env, Number(params.x), Number(params.y));
  }

  private extract(params: ExtractRawParams): ContentExtractPayload {
    return extractPage(this.env, elementMapOf(this.refs), {
      mode: ((): 'auto' | 'discover' | 'table' | 'list' => {
        const mode = String(params.mode ?? 'auto');
        return mode === 'discover' || mode === 'table' || mode === 'list' ? mode : 'auto';
      })(),
      target: typeof params.target === 'string' ? params.target : null,
      ref: typeof params.ref === 'string' ? params.ref : null,
      selector: typeof params.selector === 'string' ? params.selector : null,
      itemSelector: typeof params.itemSelector === 'string' ? params.itemSelector : null,
      fields: fieldsOf(params.fields),
    });
  }

  private networkEntries(): ContentNetworkEntriesResult {
    return readResourceEntries(this.env);
  }

  // -- 第四批：页面事实 / 协作时钟 / 收据校验 / 文件 / 手动浮层 -------------

  private cooperationState(params: Record<string, unknown>): ContentCooperationStateResult {
    this.tracker.start();
    const elementMap = elementMapOf(this.refs);
    const frameState = this.tracker.snapshot() as unknown as Record<string, unknown>;
    const signatures: Record<string, unknown> = params.signatures === false ? {} : this.tracker.signaturesOf(elementMap);
    const doc = this.env.document as unknown as Document;
    return {
      frameState,
      fingerprint: fingerprintOf(doc, this.env.window as unknown as Window),
      url: String(this.env.document.URL ?? ''),
      documentId: this.documentId,
      revision: this.revisionValue,
      nodeScope: { count: Object.keys(signatures).length, signatures },
      agentDispatch: false,
    };
  }

  private pageState(params: Record<string, unknown>): ContentPageStateResult {
    this.tracker.start();
    const doc = this.env.document as unknown as Document;
    const ref = typeof params.ref === 'string' && params.ref ? params.ref : null;
    const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;
    let target: Record<string, unknown> | null = null;
    if (ref) {
      const entry = this.refs.get(ref);
      target = signatureOfElement(entry ? entry.element : null) as unknown as Record<string, unknown>;
    } else if (selector) {
      let element: ElementLike | null = null;
      try {
        element = doc.querySelector(selector) as unknown as ElementLike | null;
      } catch {
        element = null;
      }
      target = signatureOfElement(element) as unknown as Record<string, unknown>;
    }
    return {
      url: String(this.env.document.URL ?? ''),
      documentId: this.documentId,
      revision: this.revisionValue,
      fingerprint: fingerprintOf(doc, this.env.window as unknown as Window),
      target,
    };
  }

  /** --expect / --depends-on：动作派发前的事实校验（不派发动作，只回 mismatch）。 */
  private checkFacts(params: Record<string, unknown>): ContentCheckFactsResult {
    const checks = Array.isArray(params.checks) ? params.checks : [];
    const mismatches: ContentCheckFactsResult['mismatches'] = [];
    const doc = this.env.document as unknown as Document;
    let checked = 0;
    for (const raw of checks.slice(0, 32)) {
      const bag = (raw ?? {}) as Record<string, unknown>;
      const target = bag.target;
      const targetLabel = typeof target === 'string' ? target : '';
      const field = typeof bag.field === 'string' ? bag.field : 'exists';
      const expected = bag.equals;
      const element = (() => {
        if (!targetLabel) return null;
        if (targetLabel.startsWith('@')) {
          const entry = this.refs.get(targetLabel);
          return entry ? entry.element : null;
        }
        try {
          return doc.querySelector(targetLabel) as unknown as ElementLike | null;
        } catch {
          return null;
        }
      })();
      checked += 1;
      const fact = factOf(element, field);
      const matches = factMatches(fact, expected);
      if (!matches) mismatches.push({ target: targetLabel, field, expected, actual: fact, kind: 'mismatch' });
    }
    return { ok: mismatches.length === 0, mismatches, checked };
  }

  private frameInventory(): ContentFrameInventoryResult {
    const frames = frameInventory(this.env);
    return {
      frames,
      count: frames.length,
      hiddenCount: frames.filter((frame) => frame.hidden).length,
    };
  }

  private manualOverlay(params: Record<string, unknown>): ContentManualOverlayResult {
    return setManualOverlay(this.env, params.show === true);
  }

  private uploadPrepare(params: Record<string, unknown>): ContentUploadPrepareResult {
    const mode: 'input' | 'drop' = params.mode === 'drop' ? 'drop' : 'input';
    const files = validateUploadFiles(params.files);
    const ref = typeof params.ref === 'string' && params.ref ? params.ref : null;
    const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;
    let target: ElementLike | null = null;
    if (ref || selector) {
      target = this.resolve({ ...(ref ? { ref } : {}), ...(selector ? { selector } : {}) } as PageTargetParams).element;
    }
    this.uploadSeq += 1;
    const uploadId = 'up-' + String(this.uploadSeq) + '-' + this.documentId.slice(-6);
    const staged: StagedUpload = {
      id: uploadId,
      files: files.map((file) => ({ ...file, chunks: [], received: 0 })),
      mode,
      targetSelector: selector,
      targetRef: ref,
    };
    this.uploads.set(uploadId, staged);
    return {
      uploadId,
      files: files.length,
      target: classifyUploadTarget(target, mode),
      mode,
    };
  }

  private uploadChunk(params: Record<string, unknown>): { ok: true; received: number; eof: boolean } {
    const uploadId = String(params.uploadId ?? '');
    const staged = this.uploads.get(uploadId);
    if (!staged) throw new PageError('E_TRANSFER_NOT_FOUND', 'upload 会话不存在：' + uploadId, { uploadId });
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= staged.files.length) {
      throw new PageError('E_BAD_ARG', 'upload chunk 的 index 越界', { index, files: staged.files.length });
    }
    const file = staged.files[index];
    if (!file) throw new PageError('E_BAD_ARG', 'upload chunk 的 index 越界', { index });
    const base64 = String(params.base64 ?? '');
    if (!base64) throw new PageError('E_BAD_ARG', 'upload chunk 缺少 base64');
    const bytes = base64.length ? decodeBase64Bytes(base64) : new Uint8Array(0);
    file.chunks.push(base64);
    file.received += bytes.length;
    if (file.received > file.size) {
      throw new PageError('E_TRANSFER_LIMIT', '文件写入超过声明大小：' + file.name, { name: file.name, size: file.size, received: file.received });
    }
    return { ok: true, received: file.received, eof: file.received === file.size };
  }

  private uploadCommit(params: Record<string, unknown>): ContentUploadCommitResult {
    const uploadId = String(params.uploadId ?? '');
    const staged = this.uploads.get(uploadId);
    if (!staged) throw new PageError('E_TRANSFER_NOT_FOUND', 'upload 会话不存在：' + uploadId, { uploadId });
    try {
      const files = assembleFileBatches(staged);
      const ref = staged.targetRef;
      const selector = staged.targetSelector;
      let target: ElementLike | null = null;
      if (ref || selector) {
        try {
          target = this.resolve({ ...(ref ? { ref } : {}), ...(selector ? { selector } : {}) } as PageTargetParams).element;
        } catch {
          target = null;
        }
      }
      const applied = applyUpload({ env: this.env, target, files, mode: staged.mode, selector, ref });
      return {
        ok: true,
        via: applied.via,
        names: applied.names,
        files: applied.files,
        tag: applied.tag,
        selector: applied.selector,
        effectState: 'committed',
        trusted: false,
        synthetic: true,
        note: applied.note,
      };
    } finally {
      this.uploads.delete(uploadId);
    }
  }
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function factOf(element: ElementLike | null, field: string): unknown {
  if (!element) return null;
  const tag = String(element.tagName ?? '').toLowerCase();
  switch (field) {
    case 'exists':
      return element.isConnected !== false;
    case 'text':
      return String(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    case 'value':
      return (element as { value?: unknown }).value ?? null;
    case 'checked':
      return (element as { checked?: unknown }).checked ?? null;
    case 'tag':
      return tag;
    case 'attribute':
      return element.getAttribute('data-fact');
    case 'visible':
      return element.isConnected !== false;
    default:
      return String(element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}

function factMatches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return actual !== null && actual !== undefined;
  if (typeof expected === 'boolean') return Boolean(actual) === expected;
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'string') return String(actual ?? '') === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** 把 fields 参数（对象数组）归一成字段规格；非法项被丢弃（空则用默认 text）。 */
function fieldsOf(raw: unknown): FieldSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const bag = item as Record<string, unknown>;
    const key = typeof bag.key === 'string' && bag.key ? bag.key : (typeof bag.name === 'string' ? bag.name : '');
    if (!key) continue;
    const spec: FieldSpec = { key };
    const read = typeof bag.read === 'string' ? bag.read : 'text';
    if (read === 'text' || read === 'value' || read === 'attribute' || read === 'html' || read === 'checked' || read === 'exists') {
      spec.read = read;
    }
    if (typeof bag.attribute === 'string') spec.attribute = bag.attribute;
    out.push(spec);
  }
  return out.slice(0, 32);
}

function elementMapOf(refs: Map<string, TargetRefEntry>): Map<string, ElementLike> {
  const map = new Map<string, ElementLike>();
  for (const [handle, entry] of refs) map.set(handle, entry.element);
  return map;
}

function budgetOf(params: ObserveParams): ObservationOptions {
  const budget: ObservationOptions = {};
  const maxNodes = Number(params.maxNodes);
  if (Number.isFinite(maxNodes) && maxNodes > 0) budget.maxNodes = Math.floor(maxNodes);
  const maxRefs = Number(params.maxRefs);
  if (Number.isFinite(maxRefs) && maxRefs > 0) budget.maxRefs = Math.floor(maxRefs);
  const maxChars = Number(params.maxChars);
  if (Number.isFinite(maxChars) && maxChars > 0) budget.maxChars = Math.floor(maxChars);
  const maxDepth = Number(params.maxDepth);
  if (Number.isInteger(maxDepth) && maxDepth >= 0) budget.maxDepth = maxDepth;
  const offset = Number(params.offset);
  if (Number.isInteger(offset) && offset > 0) budget.offset = offset;
  return budget;
}

/** 任意异常 → ContentReplyFailure。 */
export function failureOf(error: unknown): { ok: false; code: string; message: string; data?: unknown } {
  if (error instanceof PageError) return error.toFailure();
  if (error && typeof error === 'object') {
    const bag = error as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof bag.code === 'string' && bag.code ? bag.code : 'E_INTERNAL';
    const message = typeof bag.message === 'string' && bag.message ? bag.message : String(error);
    return bag.data === undefined ? { ok: false, code, message } : { ok: false, code, message, data: bag.data };
  }
  return { ok: false, code: 'E_INTERNAL', message: String(error) };
}

/** 生产入口用：把真实 document/window 包装成 DomEnvironment（原生 setter + Event）。 */
export function browserDomEnvironment(doc: Document, win: Window): DomEnvironment {
  return {
    document: doc as unknown as DomEnvironment['document'],
    window: win as unknown as DomEnvironment['window'],
    setValue: (el, value) => {
      const tag = String((el as { tagName?: string }).tagName ?? '').toUpperCase();
      // 按控件类型取对应原型的 value setter：用错原型会抛 "Illegal invocation"
      // （例如对 <select> 调用 HTMLInputElement.prototype 的 setter）。
      const ctor = tag === 'TEXTAREA'
        ? (typeof HTMLTextAreaElement === 'function' ? HTMLTextAreaElement : null)
        : tag === 'SELECT'
          ? (typeof HTMLSelectElement === 'function' ? HTMLSelectElement : null)
          : (typeof HTMLInputElement === 'function' ? HTMLInputElement : null);
      const proto = ctor ? ctor.prototype : null;
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(el, value);
        return;
      }
      setNativeValue(el, value);
    },
    createEvent: (type, init) => {
      try {
        if (type === 'input' && typeof InputEvent === 'function') {
          return new InputEvent('input', init as unknown as InputEventInit);
        }
        if (/^(mouse|click|dblclick|contextmenu)/.test(type) && typeof MouseEvent === 'function') {
          return new MouseEvent(type, init as unknown as MouseEventInit);
        }
        if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
          return new PointerEvent(type, init as unknown as PointerEventInit);
        }
        if (type.startsWith('key') && typeof KeyboardEvent === 'function') {
          return new KeyboardEvent(type, init as unknown as KeyboardEventInit);
        }
        if (type === 'wheel' && typeof WheelEvent === 'function') {
          return new WheelEvent('wheel', init as unknown as WheelEventInit);
        }
        // focus/focusin/blur/focusout：用 FocusEvent（与真实焦点事件同类），
        // 供后台文档的 fail-closed 复核补发合成焦点事件时页面按真实类型处理。
        if ((type === 'focus' || type === 'blur' || type === 'focusin' || type === 'focusout')
          && typeof FocusEvent === 'function') {
          return new FocusEvent(type, init as unknown as FocusEventInit);
        }
        return new Event(type, init as unknown as EventInit);
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// observe 高级面透传字段的解析（closed shadow / unmapped AX / cdpSessionId）
// ---------------------------------------------------------------------------

/**
 * cdpSessionId 语义：`tabId:frameId`；主文档以 `:0` 结尾（35b）。
 *
 * 只接受 background 显式透传的 `cdpSessionId`：内容脚本不自己从 tabId 推导，避免
 * stableRef 与 background refDetails 的 identity 在“是否已接线 35b”两种状态下漂移。
 */
function cdpSessionIdOf(params: Record<string, unknown>): string | null {
  const raw = params.cdpSessionId;
  return typeof raw === 'string' && raw ? raw : null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** background 透传的 closed shadow 候选（`closedShadowNodes`；兼容数组形式的 closedShadow）。 */
function closedShadowCandidatesOf(params: Record<string, unknown>): ContentClosedShadowCandidate[] {
  const raw = Array.isArray(params.closedShadowNodes)
    ? params.closedShadowNodes
    : (Array.isArray(params.closedShadow) ? params.closedShadow : []);
  const out: ContentClosedShadowCandidate[] = [];
  for (const item of raw) {
    if (!isRecordValue(item)) continue;
    const text = String(item.text ?? item.name ?? '').trim().slice(0, 160);
    if (!text) continue;
    const backendNodeId = Number(item.backendNodeId);
    const bounds = item.bounds;
    const candidate: ContentClosedShadowCandidate = {
      text,
      tag: String(item.tag ?? 'div').toLowerCase(),
      backendNodeId: Number.isInteger(backendNodeId) && backendNodeId > 0 ? backendNodeId : null,
      ...(typeof item.role === 'string' && item.role ? { role: item.role } : {}),
      ...(typeof item.name === 'string' && item.name ? { name: item.name.slice(0, 160) } : {}),
      ...(isRecordValue(bounds) ? {
        bounds: {
          x: Number(bounds.x ?? 0) || 0,
          y: Number(bounds.y ?? 0) || 0,
          width: Number(bounds.width ?? bounds.w ?? 0) || 0,
          height: Number(bounds.height ?? bounds.h ?? 0) || 0,
        },
      } : {}),
    };
    out.push(candidate);
  }
  return out;
}

/** background 透传的未映射可交互元素（`unmappedAx`；兼容 axUnmapped 别名）。 */
function unmappedAxCandidatesOf(params: Record<string, unknown>): ContentUnmappedAxCandidate[] {
  const raw = Array.isArray(params.unmappedAx)
    ? params.unmappedAx
    : (Array.isArray(params.axUnmapped) ? params.axUnmapped : []);
  const out: ContentUnmappedAxCandidate[] = [];
  for (const item of raw) {
    if (!isRecordValue(item)) continue;
    const backendNodeId = Number(item.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) continue;
    const bounds = item.bounds;
    out.push({
      role: typeof item.role === 'string' && item.role ? item.role : 'generic',
      name: String(item.name ?? item.text ?? '').trim().slice(0, 100),
      backendNodeId,
      bounds: isRecordValue(bounds) ? {
        x: Number(bounds.x ?? 0) || 0,
        y: Number(bounds.y ?? 0) || 0,
        width: Number(bounds.width ?? bounds.w ?? 0) || 0,
        height: Number(bounds.height ?? bounds.h ?? 0) || 0,
      } : null,
      source: item.source === 'closed-shadow' ? 'closed-shadow' : 'dom-aria',
    });
  }
  return out;
}

/**
 * 合并“未映射的可交互元素”段：
 * 1) 优先用 background 给的 unmappedAx（AX 树未映射项）；
 * 2) 只开了 --ax 且只给了 closed shadow 候选时，用闭合子树候选作为补充证据。
 */
function mergeUnmappedAxSection(input: {
  observation: string;
  candidates: readonly ContentUnmappedAxCandidate[];
  closedShadowCandidates: readonly ContentClosedShadowCandidate[];
  ax: boolean;
}): { observation: string; entries: ContentUnmappedAxEntry[] } | null {
  if (input.candidates.length) {
    return mergeUnmappedAxEntries({ observation: input.observation, candidates: input.candidates });
  }
  if (!input.ax || !input.closedShadowCandidates.length) return null;
  const derived = closedShadowAsUnmappedAx(input.closedShadowCandidates);
  if (!derived.length) return null;
  return mergeUnmappedAxEntries({ observation: input.observation, candidates: derived, source: 'closed-shadow' });
}
