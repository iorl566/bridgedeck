// src/refs/registry.ts —— 每个 tab 的 ref 生命周期注册表（TS 版，语义对齐 JS RefRegistry）。
//
// 职责边界：
// - register：observe 时把 ref → 节点身份（backendNodeId/documentId/revision/generation/
//   稳定性签名）写进注册表；
// - resolve：动作前校验 document/generation/签名/revision/frame/backend，失效返回
//   E_STALE_REF 的结构化原因（判定本身在 signature.ts 的纯函数里）；
// - noteDocument：documentId 变化即推进 generation（旧引用自然过期）；
// - negotiate：稳定引用（stableRef）跨 revision 协商，给 old/stale 原因与 renegotiate 标记；
// - invalidateDocument / invalidateTab / sweep：导航、tab 关闭、长时间未用时的清理。
//
// 这里不读页面、不碰 CDP：页面侧 ref 表由内容脚本持有，注册表只存“可核验的身份”。
// 依赖 now() 注入，因此超时清理（sweep）可以在单测里精确推进。

import {
  assessRefMatch,
  makeFenceKey,
  makeStabilitySignature,
  nonEmpty,
  positiveInteger,
  sameRef,
  signatureHash,
  staleRefCode,
  STALE_REF_MESSAGES,
  type RefAssessment,
  type RefExpectation,
  type RefKey,
  type RefKeyParts,
  type RefSignatureEntry,
  type StaleReason,
} from './signature.ts';

/**
 * ref 的来源（动作路由依据）：
 * - `dom`：页面侧 page-lib 观察出来的 ref（内容脚本能解析，走内容脚本动作）；
 * - `closed-shadow`：CDP DOM.pierce 枚举出来的 closed shadow 元素（内容脚本看不到，
 *   动作必须走 `scripting/pierce.ts` 的 clickRefNode/readRefNode，via='closed-shadow-ref'）。
 */
export type RefSource = 'dom' | 'closed-shadow';

/** 注册表里的一条 ref 记录。 */
export interface RefEntry extends RefSignatureEntry {
  /** 页面内短句柄：`@e1`。 */
  readonly ref: string;
  role: string | null;
  name: string | null;
  stableRef: string | null;
  /** TS 无 CDP 时的节点身份；有 backendNodeId 时可为空。 */
  identity: string | null;
  documentId: string;
  /** ref 来源；closed shadow ref 必须由 background 走 CDP pierce 路由。 */
  source: RefSource;
  at: number;
}

export interface RegisterMeta {
  role?: string | null;
  name?: string | null;
  stableRef?: string | null;
  identity?: string | null;
  source?: RefSource;
}

export interface RefResolveSuccess {
  ok: true;
  key: RefKey;
  meta: RefEntry;
}

export interface RefResolveFailure {
  ok: false;
  code: string;
  message: string;
  reason: StaleReason;
}

export type RefResolveResult = RefResolveSuccess | RefResolveFailure;

/** observe 结果里单个 ref 的登记输入（identity/stableRef 由 observation 层算好）。 */
export interface ObservationRefInput {
  ref: string;
  role?: string | null;
  name?: string | null;
  identity?: string | null;
  stableRef?: string | null;
  backendNodeId?: number | null;
  /** ref 来源（缺省 dom）；closed-shadow 的 ref 由 CDP pierce 路径驱动。 */
  source?: RefSource;
}

/** observe 结果的登记输入。 */
export interface ObservationInput {
  documentId?: string | null;
  revision?: number | null;
  frameId?: number | null;
  cdpSessionId?: string | null;
  refs: readonly ObservationRefInput[];
}

export interface ObservationRegistration {
  /** 成功登记的 ref 数。 */
  registered: number;
  /** 因为没有 documentId 等原因跳过的 ref 数（不阻塞 observe）。 */
  skipped: number;
  /** 本次登记使用的 generation。 */
  generation: number;
  documentId: string | null;
}

export interface NegotiateRefView {
  stableRef: string;
  ok: boolean;
  reason: 'not_found' | 'stale_document' | 'stale_generation' | 'stale_revision' | null;
  renegotiate: boolean;
  ref: string | null;
  role: string | null;
  name: string | null;
  documentId: string | null;
  frameId: number;
  cdpSessionId: string | null;
  backendNodeId: number | null;
  revision: number | null;
  generation: number | null;
  signature: string | null;
  source: RefSource;
}

export interface NegotiateResult {
  ok: true;
  tabId: number;
  revision: number | null;
  generation: number;
  documentId: string | null;
  refs: NegotiateRefView[];
}

export interface RefRegistryOptions {
  now?: () => number;
}

// 主文档 ref：@eN；跨 frame 别名：@f<frameId>e<localN>（第四批 observe-frames 生成）。
const REF_PATTERN = /^@(?:f\d+)?e\d+$/;

function entrySignature(key: RefKey, meta: RegisterMeta): string {
  // identity 只有拿不到 backendNodeId 时才参与签名（见 signature.ts 的取舍说明）。
  const parts: RefKeyParts = { ...key, identity: key.backendNodeId ? null : (meta.identity ?? null) };
  return makeStabilitySignature(parts);
}

/**
 * 每个 tab 的 ref 注册表。
 *
 * ```ts
 * const refs = new RefRegistry();
 * refs.registerObservation(1, { documentId: 'doc-a', revision: 3, refs: [{ ref: '@e1', identity: 'b|#go' }] });
 * refs.resolve(1, '@e1'); // { ok: true, ... }
 * ```
 */
export class RefRegistry {
  private readonly now: () => number;
  private readonly byTab = new Map<number, Map<string, RefEntry>>();
  private readonly generations = new Map<number, number>();
  private readonly documents = new Map<number, string>();

  constructor(options: RefRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** 当前 tab 的登记代际（没有记录时为 0）。 */
  generationOf(tabId: number): number {
    return this.generations.get(Number(tabId)) ?? 0;
  }

  /** 推进登记代际，返回新值。 */
  bumpGeneration(tabId: number): number {
    const id = Number(tabId);
    const next = this.generationOf(id) + 1;
    this.generations.set(id, next);
    return next;
  }

  /** 记录当前文档；documentId 与上次不同则推进 generation（旧引用自然过期）。 */
  noteDocument(tabId: number, documentId: unknown): { changed: boolean; generation: number } {
    const id = Number(tabId);
    const doc = nonEmpty(documentId);
    if (!Number.isInteger(id) || !doc) return { changed: false, generation: this.generationOf(tabId) };
    const previous = this.documents.get(id);
    this.documents.set(id, doc);
    if (previous && previous !== doc) return { changed: true, generation: this.bumpGeneration(id) };
    return { changed: false, generation: this.generationOf(id) };
  }

  /** 当前登记的 documentId（没有则为 null）。 */
  documentOf(tabId: number): string | null {
    return this.documents.get(Number(tabId)) ?? null;
  }

  /**
   * 登记一条 ref。
   * @throws Error tabId 非整数、ref 不是 `@eN`、documentId 缺失（与 JS 相同的硬校验）。
   */
  register(tabId: number, ref: string, parts: RefKeyParts, meta: RegisterMeta = {}): RefKey {
    const id = Number(tabId);
    if (!Number.isInteger(id)) throw new Error('RefRegistry 需要 tabId');
    if (typeof ref !== 'string' || !ref.startsWith('@e')) throw new Error('ref 必须是 @eN');
    const noted = this.noteDocument(id, parts.documentId);
    const key = makeFenceKey({
      ...parts,
      generation: parts.generation !== undefined && parts.generation !== null ? parts.generation : noted.generation,
    });
    const signature = entrySignature(key, meta);
    const entry: RefEntry = {
      ref,
      key,
      signature,
      generation: key.generation === null ? noted.generation : key.generation,
      documentId: key.documentId,
      role: meta.role ?? null,
      name: meta.name ?? null,
      stableRef: meta.stableRef ?? null,
      identity: meta.identity ?? null,
      source: meta.source ?? 'dom',
      at: this.now(),
    };
    let map = this.byTab.get(id);
    if (!map) {
      map = new Map();
      this.byTab.set(id, map);
    }
    map.set(ref, entry);
    return key;
  }

  /**
   * 用一次 observe 的结果整体重建该 tab 的 ref 表（先失效旧表，再逐条登记）。
   * 没有 documentId 的观察不登记（不阻塞 observe），计入 skipped。
   */
  registerObservation(tabId: number, observation: ObservationInput): ObservationRegistration {
    const id = Number(tabId);
    const documentId = nonEmpty(observation?.documentId);
    if (!Number.isInteger(id) || !documentId) {
      return { registered: 0, skipped: Array.isArray(observation?.refs) ? observation.refs.length : 0, generation: this.generationOf(tabId), documentId };
    }
    this.invalidateTab(id);
    const list = Array.isArray(observation.refs) ? observation.refs : [];
    let registered = 0;
    let skipped = 0;
    for (const item of list) {
      if (!item || typeof item.ref !== 'string' || !item.ref.startsWith('@e')) {
        skipped += 1;
        continue;
      }
      try {
        this.register(id, item.ref, {
          backendNodeId: positiveInteger(item.backendNodeId),
          frameId: observation.frameId ?? 0,
          cdpSessionId: observation.cdpSessionId ?? null,
          documentId,
          revision: observation.revision ?? null,
        }, {
          role: item.role ?? null,
          name: item.name ?? null,
          stableRef: item.stableRef ?? null,
          identity: item.identity ?? null,
          source: item.source ?? 'dom',
        });
        registered += 1;
      } catch {
        skipped += 1;
      }
    }
    return { registered, skipped, generation: this.generationOf(id), documentId };
  }

  /** 按 stableRef 找记录（同 tab 内第一个匹配；跨 revision 命中）。 */
  getByStableRef(tabId: number, stableRef: unknown): RefEntry | null {
    if (!stableRef) return null;
    const map = this.byTab.get(Number(tabId));
    if (!map) return null;
    for (const entry of map.values()) {
      if (entry.stableRef === stableRef) return entry;
    }
    return null;
  }

  /** 按稳定性签名找记录（同文档同节点，跨 revision 命中）。 */
  getBySignature(tabId: number, signature: unknown): RefEntry | null {
    if (!signature) return null;
    const map = this.byTab.get(Number(tabId));
    if (!map) return null;
    for (const entry of map.values()) {
      if (entry.signature === signature) return entry;
    }
    return null;
  }

  /** 按 ref 取记录（不会自动跨文档重算）。 */
  get(tabId: number, ref: unknown): RefEntry | null {
    if (typeof ref !== 'string') return null;
    const map = this.byTab.get(Number(tabId));
    return map?.get(ref) ?? null;
  }

  /** 动作前校验：条目存在 + assessRefMatch 的六项比较。 */
  resolve(tabId: number, ref: unknown, expected: RefExpectation = {}): RefResolveResult {
    const entry = this.get(tabId, ref);
    const assessment: RefAssessment = assessRefMatch(entry, expected);
    if (assessment.ok) {
      if (!entry) {
        // 不可达：assessRefMatch 对空条目一定返回 missing；这里防御性兜底。
        return { ok: false, code: staleRefCode(), message: STALE_REF_MESSAGES.missing, reason: 'missing' };
      }
      return { ok: true, key: entry.key, meta: entry };
    }
    return { ok: false, code: staleRefCode(), message: assessment.message, reason: assessment.reason };
  }

  /**
   * 稳定引用协商：按当前 document/revision/generation 判断每个 stableRef 是否仍可用。
   * 任何 stale 都带 renegotiate:true（调用方必须重新 observe 后再动作）。
   */
  negotiate(tabId: number, stableRefs: readonly unknown[], current: { documentId?: unknown; revision?: unknown; generation?: unknown } = {}): NegotiateResult {
    const id = Number(tabId);
    const list = (Array.isArray(stableRefs) ? stableRefs : [])
      .map((item) => String(item ?? ''))
      .filter(Boolean);
    const currentDocument = nonEmpty(current.documentId);
    const generation = this.generationOf(id);
    const revision = Number.isInteger(Number(current.revision)) ? Number(current.revision) : null;
    const refs = list.map((stableRef): NegotiateRefView => {
      const entry = this.getByStableRef(id, stableRef);
      if (!entry) {
        return {
          stableRef,
          ok: false,
          reason: 'not_found',
          renegotiate: true,
          ref: null,
          role: null,
          name: null,
          documentId: null,
          frameId: 0,
          cdpSessionId: null,
          backendNodeId: null,
          revision: null,
          generation: null,
          signature: null,
          source: 'dom',
        };
      }
      const key = entry.key;
      const staleDocument = Boolean(currentDocument && key.documentId && key.documentId !== currentDocument);
      const staleGeneration = Number.isInteger(current.generation) && Number.isInteger(entry.generation)
        && entry.generation !== Number(current.generation);
      const staleRevision = revision !== null && key.revision !== null && Number(key.revision) !== revision;
      const reason = staleDocument ? 'stale_document'
        : staleGeneration ? 'stale_generation'
          : staleRevision ? 'stale_revision'
            : null;
      return {
        stableRef,
        ok: reason === null,
        reason,
        renegotiate: reason !== null,
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        documentId: key.documentId,
        frameId: key.frameId,
        cdpSessionId: key.cdpSessionId,
        backendNodeId: key.backendNodeId,
        revision: key.revision,
        generation: entry.generation,
        signature: entry.signature,
        source: entry.source,
      };
    });
    return { ok: true, tabId: id, revision, generation, documentId: currentDocument, refs };
  }

  /** 观察拿到 backendNodeId 后补全身份（页面内回退路径用）。 */
  upgradeBackend(tabId: number, ref: string, backendNodeId: unknown): RefKey | null {
    const entry = this.get(tabId, ref);
    const backend = positiveInteger(backendNodeId);
    if (!entry || backend === null) return null;
    const map = this.byTab.get(Number(tabId));
    if (!map) return null;
    const key = makeFenceKey({ ...entry.key, backendNodeId: backend });
    const signature = makeStabilitySignature({ ...key, identity: null });
    const next: RefEntry = { ...entry, key, signature };
    map.set(ref, next);
    return key;
  }

  /** 某 tab 上是否登记过给定 ref 的同一节点（诊断用）。 */
  hasSameNode(tabId: number, ref: string, other: RefKey | null): boolean {
    const entry = this.get(tabId, ref);
    if (!entry || !other) return false;
    return sameRef(entry.key, other);
  }

  /** 文档重建时整批失效（默认失效该 tab 全部 ref）。返回移除条数。 */
  invalidateDocument(tabId: number, documentId?: string | null): number {
    const id = Number(tabId);
    const map = this.byTab.get(id);
    if (!map) return 0;
    let removed = 0;
    for (const [ref, entry] of map) {
      if (!documentId || entry.key.documentId === documentId) {
        map.delete(ref);
        removed += 1;
      }
    }
    if (map.size === 0) this.byTab.delete(id);
    if (removed > 0) {
      this.bumpGeneration(id);
      if (documentId) this.documents.delete(id);
    }
    return removed;
  }

  /** tab 关闭/导航：清空并推进代际。 */
  invalidateTab(tabId: number): boolean {
    const id = Number(tabId);
    this.bumpGeneration(id);
    this.documents.delete(id);
    return this.byTab.delete(id);
  }

  /** 清理超过 maxAgeMs 未更新的 ref；返回移除条数。 */
  sweep(maxAgeMs = 5 * 60 * 1000): number {
    const at = this.now();
    let removed = 0;
    for (const [tabId, map] of this.byTab) {
      for (const [ref, entry] of map) {
        if (at - entry.at > maxAgeMs) {
          map.delete(ref);
          removed += 1;
        }
      }
      if (map.size === 0) this.byTab.delete(tabId);
    }
    return removed;
  }

  /** 某 tab 当前 ref 数。 */
  size(tabId: number): number {
    return this.byTab.get(Number(tabId))?.size ?? 0;
  }

  /** 有登记的 tab 数。 */
  tabCount(): number {
    return this.byTab.size;
  }

  /** 当前全部 ref 条数（诊断/断言用）。 */
  total(): number {
    let count = 0;
    for (const map of this.byTab.values()) count += map.size;
    return count;
  }

  /** 某 tab 的 ref 列表（诊断页/测试用，顺序为登记顺序）。 */
  list(tabId: number): RefEntry[] {
    const map = this.byTab.get(Number(tabId));
    return map ? [...map.values()] : [];
  }

  /** 清空全部状态（测试/会话重置用）。 */
  clear(): void {
    this.byTab.clear();
    this.generations.clear();
    this.documents.clear();
  }
}

/** ref 是否形如 `@eN`（动作入参校验用）。 */
export function isPageRef(value: unknown): value is string {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 跨模块共用的 ref 身份 / cdpSessionId / closed-shadow 登记
//
// 这几个纯函数放在注册表旁边，是因为 stableRef 的语义只应该有一个实现：
// - background（actions/observation）用 refIdentityOf/refStableRefOf 生成 refDetails；
// - 内容脚本（content/rich）用同一对函数给 observe --vom 的节点补 stableRef，
//   这样 `refs negotiate <node.stableRef>` 才能命中注册表（5b）；
// - cdpSessionId 的语义固定为 `tabId:frameId`（主文档 frameId=0 → 以 `:0` 结尾，35b）。
// ---------------------------------------------------------------------------

/** CDP session 标识：`tabId:frameId`；主文档（frameId=0）以 `:0` 结尾。 */
export function makeCdpSessionId(tabId: unknown, frameId: unknown = 0): string {
  const id = Number(tabId);
  const frame = Number.isInteger(Number(frameId)) ? Number(frameId) : 0;
  if (!Number.isInteger(id) || id <= 0) return '0:' + String(frame);
  return String(id) + ':' + String(frame);
}

/** 稳定身份的分段输入（与 JS ref-details.js 的 identity 字段顺序一致）。 */
export interface RefIdentityParts {
  cdpSessionId?: string | null;
  documentId?: string | null;
  frameId?: number | null;
  tag?: string | null;
  id?: string | null;
  role?: string | null;
  name?: string | null;
}

/**
 * ref 的稳定身份字符串：`cdpSessionId|documentId|frameId|tag|id|role|name`。
 * name 截断到 120 字符（与 JS buildRefDetails 同口径，避免长文本把身份撑爆）。
 */
export function refIdentityOf(parts: RefIdentityParts): string {
  const frameId = Number.isInteger(Number(parts.frameId)) ? Number(parts.frameId) : 0;
  return [
    parts.cdpSessionId ?? '',
    parts.documentId ?? '',
    frameId,
    parts.tag ?? '',
    parts.id ?? '',
    parts.role ?? '',
    parts.name ? String(parts.name).slice(0, 120) : '',
  ].join('|');
}

/** identity 的分组键（`i-<hash>`；同 identity 的重复节点用出现序号区分）。 */
export function refIdentityKeyOf(identity: string): string {
  return 'i-' + signatureHash(identity);
}

/** stableRef：`s-<hash(identity + '#' + 出现序号)>`（与 JS buildRefDetails 逐字符一致）。 */
export function refStableRefOf(identity: string, occurrence = 1): string {
  const count = Number.isInteger(occurrence) && occurrence > 0 ? occurrence : 1;
  return 's-' + signatureHash(identity + '#' + count);
}

/** closed shadow 元素 → ref 的登记输入（CDP pierce 枚举结果）。 */
export interface ClosedShadowRefInput {
  ref: string;
  text?: string | null;
  tag?: string | null;
  role?: string | null;
  name?: string | null;
  backendNodeId?: number | null;
}

/** closed shadow 登记上下文（与同一次 observe 的 document/revision 对齐）。 */
export interface ClosedShadowRefContext {
  documentId?: string | null;
  revision?: number | null;
  frameId?: number | null;
  cdpSessionId?: string | null;
}

/**
 * 把 CDP pierce 枚举出的 closed shadow 条目登记为 ref（source='closed-shadow'）。
 *
 * 调用顺序必须是：先 registerObservation(主文档 ref) → 再 registerClosedShadowRefs。
 * registerObservation 会整体失效旧表，后登记不会被清掉；反过来顺序会被清空。
 */
export function registerClosedShadowRefs(
  registry: Pick<RefRegistry, 'register'>,
  tabId: number,
  context: ClosedShadowRefContext,
  entries: readonly ClosedShadowRefInput[],
): { registered: number; skipped: number; refs: string[] } {
  const documentId = nonEmpty(context.documentId);
  const list = Array.isArray(entries) ? entries : [];
  if (!documentId) return { registered: 0, skipped: list.length, refs: [] };
  const refs: string[] = [];
  let registered = 0;
  let skipped = 0;
  for (const entry of list) {
    const ref = typeof entry?.ref === 'string' && entry.ref.startsWith('@e') ? entry.ref : '';
    if (!ref) {
      skipped += 1;
      continue;
    }
    try {
      registry.register(tabId, ref, {
        backendNodeId: positiveInteger(entry.backendNodeId),
        frameId: Number.isInteger(Number(context.frameId)) ? Number(context.frameId) : 0,
        cdpSessionId: nonEmpty(context.cdpSessionId),
        documentId,
        revision: Number.isInteger(Number(context.revision)) ? Number(context.revision) : null,
      }, {
        role: entry.role ?? null,
        name: entry.name ?? (entry.text ? String(entry.text).slice(0, 120) : null),
        source: 'closed-shadow',
      });
      registered += 1;
      refs.push(ref);
    } catch {
      skipped += 1;
    }
  }
  return { registered, skipped, refs };
}

/** ref 的 CDP backendNodeId（closed shadow 动作路由用；没有时为 null）。 */
export function backendNodeIdOf(registry: Pick<RefRegistry, 'get'>, tabId: number, ref: unknown): number | null {
  const entry = registry.get(tabId, ref);
  return entry ? entry.key.backendNodeId : null;
}

/** ref 的来源；未登记返回 null。 */
export function refSourceOf(registry: Pick<RefRegistry, 'get'>, tabId: number, ref: unknown): RefSource | null {
  return registry.get(tabId, ref)?.source ?? null;
}

export type { RefSignatureEntry };
