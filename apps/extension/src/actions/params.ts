// src/actions/params.ts —— 动作入参归一与校验（四个核心动作 + 三个薄动作）。
//
// 为什么要单独一层：
// - daemon 只做 JSON schema 级校验（lib/schemas.mjs），扩展侧还要做“本运行时支持面”
//   的判定：哪些 observe 参数已迁移、哪些仍需要 CDP/VOM（明确 E_NOT_IMPLEMENTED，
//   而不是静默丢参数后假装成功）；
// - CLI/daemon 历史上用 snake_case（`tab_id`/`stable_ref`/`no_clear`），JS 扩展用
//   PARAM_ALIASES 归一。TS 侧把同一张表里本批用到的方法抄过来（只抄用到的键，
//   并在测试里与 JS 生成表对拍关键别名），避免两套命名长期漂移；
// - 目标必须“恰好一个”（ref / selector / stableRef / text），与 CLI resolveTarget 同义。
//
// 错误统一用 RpcMethodError：background 的 rpcErrorPayloadOf 已经能把 code/data/message
// 原样映射成 `{ok:false,code,message,data}`，不需要再引入一套错误类型。

import { RpcMethodError } from '../rpc/registry.ts';
import { isPageRef } from '../refs/registry.ts';

/**
 * 参数别名：snake_case → camelCase（对齐 extension/src/generated/protocol.js 的
 * PARAM_ALIASES，只保留本批注册的方法）。
 */
export const PARAM_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  observe: Object.freeze({
    closed_shadow: 'closedShadow',
    compare_ax: 'compareAx',
    debug_surfaces: 'debugSurfaces',
    deep_max_tokens: 'deepMaxTokens',
    fallback_ax: 'fallbackAx',
    max_depth: 'maxDepth',
    max_tokens: 'maxTokens',
    probe_hover: 'probeHover',
    session_id: 'sessionId',
    tab_id: 'tabId',
    vom_deep: 'vomDeep',
    vom_max_nodes: 'vomMaxNodes',
    vom_max_tokens: 'vomMaxTokens',
    vom_min_score: 'vomMinScore',
    vom_profile: 'vomProfile',
    vom_rank: 'vomRank',
    vom_top: 'vomTop',
  }),
  click: Object.freeze({
    expect_revision: 'expectRevision',
    stable_ref: 'stableRef',
    wait_timeout_ms: 'waitTimeoutMs',
  }),
  fill: Object.freeze({
    expect_revision: 'expectRevision',
    no_clear: 'noClear',
    stable_ref: 'stableRef',
    wait_timeout_ms: 'waitTimeoutMs',
  }),
  read: Object.freeze({
    expect_revision: 'expectRevision',
    fields_json: 'fieldsJson',
    session_id: 'sessionId',
    stable_ref: 'stableRef',
    tab_id: 'tabId',
  }),
  select: Object.freeze({
    expect_revision: 'expectRevision',
    stable_ref: 'stableRef',
    wait_timeout_ms: 'waitTimeoutMs',
  }),
  'get-html': Object.freeze({
    expect_revision: 'expectRevision',
    max_chars: 'maxChars',
    stable_ref: 'stableRef',
    session_id: 'sessionId',
    tab_id: 'tabId',
  }),
  evaluate: Object.freeze({
    session_id: 'sessionId',
    tab_id: 'tabId',
  }),
  navigate: Object.freeze({
    session_id: 'sessionId',
    tab_id: 'tabId',
  }),
  reload: Object.freeze({
    session_id: 'sessionId',
    tab_id: 'tabId',
  }),
  'tab.list': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId' }),
  'tab.new': Object.freeze({
    allowed_origins: 'allowedOrigins',
    new_window: 'newWindow',
    no_focus: 'noFocus',
    session_id: 'sessionId',
    tab_id: 'tabId',
    window_id: 'windowId',
  }),
  'tab.close': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId' }),
  'tab.select': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId' }),
  'tab.move': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId', window_id: 'windowId' }),
  'window.list': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId' }),
  'window.close': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId', window_id: 'windowId' }),
  'window.focus': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId', window_id: 'windowId' }),
  'window.ensureAgent': Object.freeze({ no_focus: 'noFocus', session_id: 'sessionId', tab_id: 'tabId' }),
  'window.newAgent': Object.freeze({ no_focus: 'noFocus', session_id: 'sessionId', tab_id: 'tabId' }),
  'settings.get': Object.freeze({ session_id: 'sessionId', tab_id: 'tabId' }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 应用别名表；已显式给出 camelCase 时不覆盖 snake_case（与 JS normalizeParams 一致）。 */
export function applyParamAliases(method: string, params: unknown): { params: Record<string, unknown>; applied: string[] } {
  if (!isRecord(params)) return { params: {}, applied: [] };
  const map = PARAM_ALIASES[method];
  if (!map) return { params: { ...params }, applied: [] };
  const out: Record<string, unknown> = { ...params };
  const applied: string[] = [];
  for (const [snake, camel] of Object.entries(map)) {
    if (out[camel] === undefined && out[snake] !== undefined) {
      out[camel] = out[snake];
      delete out[snake];
      applied.push(snake + '→' + camel);
    }
  }
  return { params: out, applied };
}

function badArg(message: string, data?: unknown): RpcMethodError {
  return new RpcMethodError('E_BAD_ARG', message, data);
}

/** 目标（ref/selector/stableRef/text）规范化结果。 */
export interface NormalizedTarget {
  ref: string | null;
  selector: string | null;
  stableRef: string | null;
  text: string | null;
}

/**
 * 解析目标：四种写法最多给一个，全部缺省时返回全 null（read --all / observe 允许无目标）。
 * 与 CLI 的 resolveTarget 同义；非法形态回 E_BAD_ARG。
 */
export function normalizeTarget(params: Record<string, unknown>): NormalizedTarget {
  const candidates: Array<{ key: keyof NormalizedTarget; value: string }> = [];
  const ref = params.ref;
  const selector = params.selector;
  const stableRef = params.stableRef;
  const text = params.text;
  if (ref !== undefined && ref !== null) {
    if (!isPageRef(ref)) throw badArg('ref 必须是 @eN 形式的页面引用', { ref, expected: '@eN' });
    candidates.push({ key: 'ref', value: ref });
  }
  if (selector !== undefined && selector !== null) {
    if (typeof selector !== 'string' || selector.trim().length === 0) throw badArg('selector 必须是非空字符串');
    candidates.push({ key: 'selector', value: selector });
  }
  if (stableRef !== undefined && stableRef !== null) {
    if (typeof stableRef !== 'string' || !/^s-[A-Za-z0-9]+$/.test(stableRef)) {
      throw badArg('stableRef 必须是 s-<base36> 形式的稳定引用', { stableRef });
    }
    candidates.push({ key: 'stableRef', value: stableRef });
  }
  if (text !== undefined && text !== null) {
    if (typeof text !== 'string' || text.trim().length === 0) throw badArg('text 必须是非空字符串', { text });
    candidates.push({ key: 'text', value: text });
  }
  if (candidates.length > 1) {
    throw badArg('ref / selector / stableRef / text 只能给一个', { given: candidates.map((item) => item.key) });
  }
  const target: NormalizedTarget = { ref: null, selector: null, stableRef: null, text: null };
  const first = candidates[0];
  if (first) target[first.key] = first.value;
  return target;
}

/**
 * observe 参数里**尚未迁移**的开关（第四批已迁移 VOM/AX/facts 等，因此这里为空；
 * 保留常量是为了给诊断/测试一个“未迁移面”的单一来源）。
 */
export const UNSUPPORTED_OBSERVE_FLAGS: readonly string[] = Object.freeze([]);

/** 归一后的页面动作请求。 */
export interface NormalizedPageAction {
  method: string;
  tabId: number;
  target: NormalizedTarget;
  /** 归一后的参数（别名已展开；handler 取自己需要的字段）。 */
  params: Record<string, unknown>;
  /** 别名展开后的原始参数（保留 expect/unverified 等未被本批消费的键，供 feature gate 判定）。 */
  source: Record<string, unknown>;
  /** 已应用的别名，便于日志/证据。 */
  appliedAliases: string[];
}

const PAGE_ACTIONS: ReadonlySet<string> = new Set(['observe', 'click', 'fill', 'read', 'select', 'get-html', 'evaluate']);

export function isPageAction(method: unknown): boolean {
  return typeof method === 'string' && PAGE_ACTIONS.has(method);
}

function requireTabId(params: Record<string, unknown>): number {
  const tabId = Number(params.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw badArg('页面动作需要整数 tabId（由 daemon 按会话注入）', { tabId: params.tabId ?? null });
  }
  return tabId;
}

function optionalInteger(params: Record<string, unknown>, key: string, min: number): number | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min) {
    throw badArg(key + ' 必须是 ≥' + String(min) + ' 的整数', { [key]: raw });
  }
  return number;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') throw badArg(key + ' 必须是布尔值', { [key]: raw });
  return raw;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw badArg(key + ' 必须是字符串', { [key]: raw });
  return raw;
}

/**
 * read --fields-json：字符串 JSON 或已解析数组 → 字段规格数组。
 * 非法 JSON/非法条目回 E_BAD_ARG（不静默降级成默认读取）。
 */
export function parseFieldsJson(raw: unknown): Array<{ key: string; read?: string; attribute?: string }> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch (error) {
      throw badArg('fields-json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)), { fieldsJson: raw });
    }
  }
  if (!Array.isArray(list)) throw badArg('fields-json 必须是数组');
  const out: Array<{ key: string; read?: string; attribute?: string }> = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw badArg('fields-json 的每一项都必须是对象');
    const bag = item as Record<string, unknown>;
    const key = typeof bag.key === 'string' && bag.key ? bag.key : (typeof bag.name === 'string' ? bag.name : '');
    if (!key) throw badArg('fields-json 的每一项都需要 key');
    const spec: { key: string; read?: string; attribute?: string } = { key };
    if (typeof bag.read === 'string') spec.read = bag.read;
    if (typeof bag.attribute === 'string') spec.attribute = bag.attribute;
    out.push(spec);
  }
  if (out.length > 32) throw badArg('fields-json 最多 32 个字段');
  return out;
}

/** 期望/依赖/收据/延迟字段：第四批所有页面动作共用（值原样保留，由动作层闸门消费）。 */
function controlFields(params: Record<string, unknown>, normalized: Record<string, unknown>): void {
  if (params.expect !== undefined) normalized.expect = params.expect;
  if (params.dependsOn !== undefined) normalized.dependsOn = params.dependsOn;
  if (typeof params.observation === 'string' && params.observation) normalized.observation = params.observation;
  if (typeof params.context === 'string' && params.context) normalized.context = params.context;
  if (params.nodeScope === true) normalized.nodeScope = true;
  const settle = Number(params.settleMs);
  if (Number.isFinite(settle) && settle >= 0) normalized.settleMs = Math.floor(settle);
}

/** background CDP 侧候选（closed shadow / unmapped AX）的上限与字段收敛。 */
export const MAX_SHADOW_CANDIDATES = 100;

/**
 * CDP 候选条目 → 内容脚本可消费的最小形状（只保留已知字段，截断文本）。
 * 非法条目直接丢弃（内容脚本侧还会再校验一次；这里不允许把任意对象透传进页面）。
 */
export function sanitizeShadowCandidates(raw: readonly unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw.slice(0, MAX_SHADOW_CANDIDATES)) {
    if (!isRecord(item)) continue;
    const entry: Record<string, unknown> = {};
    if (typeof item.ref === 'string' && /^@e\d+$/.test(item.ref)) entry.ref = item.ref;
    if (typeof item.text === 'string' && item.text.trim()) entry.text = item.text.trim().slice(0, 160);
    if (typeof item.tag === 'string' && item.tag.trim()) entry.tag = item.tag.trim().toLowerCase();
    if (typeof item.role === 'string' && item.role.trim()) entry.role = item.role.trim();
    if (typeof item.name === 'string' && item.name.trim()) entry.name = item.name.trim().slice(0, 160);
    if (typeof item.source === 'string' && item.source.trim()) entry.source = item.source.trim();
    const backendNodeId = Number(item.backendNodeId);
    if (Number.isInteger(backendNodeId) && backendNodeId > 0) entry.backendNodeId = backendNodeId;
    if (isRecord(item.bounds)) {
      const bounds: Record<string, number> = {};
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        const value = Number(item.bounds[key]);
        if (Number.isFinite(value)) bounds[key] = value;
      }
      if (Object.keys(bounds).length) entry.bounds = bounds;
    }
    if (Object.keys(entry).length) out.push(entry);
  }
  return out;
}

/**
 * 归一并校验一个页面动作的入参。
 *
 * @throws RpcMethodError（E_BAD_ARG / E_NOT_IMPLEMENTED），由注册表统一映射成回包。
 */
export function normalizePageAction(method: string, raw: unknown): NormalizedPageAction {
  const aliased = applyParamAliases(method, raw);
  const params = aliased.params;
  const tabId = requireTabId(params);
  const target = normalizeTarget(params);
  const expectRevision = optionalInteger(params, 'expectRevision', 0);

  switch (method) {
    case 'observe': {
      const maxTokens = params.maxTokens === undefined ? undefined : optionalInteger(params, 'maxTokens', 1);
      const normalized: Record<string, unknown> = { tabId };
      if (maxTokens !== undefined) {
        normalized.maxTokens = maxTokens;
        // 近似换算：1 token ≈ 4 字符（TS 侧只做字符/行预算，不做分词）。
        normalized.maxChars = Math.min(Math.max(maxTokens * 4, 400), 200_000);
        normalized.maxNodes = Math.min(Math.max(Math.floor(maxTokens / 2), 40), 4000);
      }
      const maxDepth = optionalInteger(params, 'maxDepth', 0);
      if (maxDepth !== undefined) normalized.maxDepth = maxDepth;
      // --cursor：只支持本运行时产生的 o1.<行号> 分页游标；其它游标格式明确未实现。
      if (typeof params.cursor === 'string' && params.cursor) {
        const match = /^o1\.(\d+)$/.exec(params.cursor);
        if (!match) {
          throw new RpcMethodError(
            'E_NOT_IMPLEMENTED',
            'TS 运行时只支持本运行时产生的 observe cursor（o1.<offset>）；收到 cursor: ' + params.cursor,
            { cursor: params.cursor, supported: 'o1.<offset>' },
          );
        }
        normalized.offset = Number(match[1]);
      }
      // 第四批 observe 高级面：VOM/AX/facts/fallback-ax/compare-ax/pipeline/debug-surfaces。
      // 这些能力全部由内容脚本从 DOM/ARIA 计算（无 debugger），结果字段由 rich.ts 提供。
      for (const key of ['vom', 'vomDeep', 'vomTree', 'vomRank', 'vomExplain', 'vomExcludeHidden',
        'vomGroupContext', 'ax', 'facts', 'fallbackAx', 'compareAx', 'debugSurfaces', 'closedShadow', 'probeHover']) {
        if (params[key] === true) normalized[key] = true;
      }
      for (const key of ['vomTop', 'vomMinScore', 'vomMaxNodes', 'vomMaxTokens', 'deepMaxTokens']) {
        const value = Number(params[key]);
        if (params[key] !== undefined && Number.isFinite(value)) normalized[key] = value;
      }
      for (const key of ['vomProfile', 'pipeline']) {
        if (typeof params[key] === 'string' && params[key]) normalized[key] = params[key];
      }
      for (const key of ['vomPerGroup', 'vomGroupTokens', 'vomSemanticMaxGroups', 'vomSemanticMinScore', 'vomSemanticMaxTokens']) {
        const value = Number(params[key]);
        if (params[key] !== undefined && Number.isFinite(value)) normalized[key] = value;
      }
      if (params.vomBillingModel !== undefined) normalized.vomBillingModel = params.vomBillingModel;
      if (params.vomWeights !== undefined) normalized.vomWeights = params.vomWeights;
      // M-C 第七批 R2b 跨路接线：background 的 CDP 侧候选（closed shadow / unmapped AX）
      // 与 cdpSessionId（`tabId:frameId`，主文档 :0）原样透传给内容脚本合并；
      // 未提供时保持旧行为（不伪造会话标识）。
      if (Array.isArray(params.closedShadowNodes)) normalized.closedShadowNodes = sanitizeShadowCandidates(params.closedShadowNodes);
      if (Array.isArray(params.unmappedAx)) normalized.unmappedAx = sanitizeShadowCandidates(params.unmappedAx);
      if (typeof params.cdpSessionId === 'string' && params.cdpSessionId.trim()) {
        normalized.cdpSessionId = params.cdpSessionId.trim();
      }
      if (params.force === true) normalized.force = true;
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'click': {
      if (!target.ref && !target.selector && !target.stableRef && !target.text) {
        throw badArg('click 需要 ref / selector / stableRef / text 之一');
      }
      const normalized: Record<string, unknown> = { tabId };
      if (expectRevision !== undefined) normalized.expectRevision = expectRevision;
      const force = optionalBoolean(params, 'force');
      if (force !== undefined) normalized.force = force;
      if (params.human === true) normalized.human = true;
      // 合成输入模式：本批没有任何原生输入通道，如实记录而不是谎报 trusted。
      normalized.trusted = false;
      normalized.synthetic = true;
      if (params.trusted === true) normalized.trustedRequested = true;
      controlFields(params, normalized);
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'fill': {
      if (!target.ref && !target.selector && !target.stableRef && !target.text) {
        throw badArg('fill 需要 ref / selector / stableRef / text 之一');
      }
      if (params.value === undefined || params.value === null) throw badArg('fill 需要 value');
      if (typeof params.value !== 'string') throw badArg('fill 的 value 必须是字符串', { value: params.value });
      const normalized: Record<string, unknown> = { tabId, value: params.value };
      if (expectRevision !== undefined) normalized.expectRevision = expectRevision;
      const noClear = optionalBoolean(params, 'noClear');
      if (noClear !== undefined) normalized.noClear = noClear;
      normalized.trusted = false;
      normalized.synthetic = true;
      if (params.trusted === true) normalized.trustedRequested = true;
      controlFields(params, normalized);
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'read': {
      const all = optionalBoolean(params, 'all');
      const fields = parseFieldsJson(params.fieldsJson ?? params.fields);
      if (!target.ref && !target.selector && !target.stableRef && !target.text && all !== true && !fields) {
        throw badArg('read 需要 ref / selector / stableRef / text，或者 all:true');
      }
      const normalized: Record<string, unknown> = { tabId };
      if (all !== undefined) normalized.all = all;
      if (expectRevision !== undefined) normalized.expectRevision = expectRevision;
      if (fields) normalized.fields = fields;
      const key = optionalString(params, 'key');
      if (key !== undefined) normalized.key = key;
      const attribute = optionalString(params, 'attribute');
      if (attribute !== undefined) normalized.attribute = attribute;
      // 旧 observation 收据：调用方显式给了 observation 的 document/revision 时，
      // 动作层在派发前做整页校验（失败回 E_OBSERVATION_STALE）。
      const observationDocumentId = optionalString(params, 'observationDocumentId');
      if (observationDocumentId !== undefined) normalized.observationDocumentId = observationDocumentId;
      const observationRevision = optionalInteger(params, 'observationRevision', 0);
      if (observationRevision !== undefined) normalized.observationRevision = observationRevision;
      controlFields(params, normalized);
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'select': {
      if (!target.ref && !target.selector && !target.stableRef && !target.text) {
        throw badArg('select 需要 ref / selector / stableRef / text 之一');
      }
      // 选择值：`value` 优先（按 option value 精确匹配），其次 `label`（可见文本/label）。
      // 内容脚本的 select 语义是「先 value、再文本」，所以 label 作为 value 的兜底输入；
      // 两者都给时 value 优先、label 只作为证据/回退建议（不静默改语义）。
      const hasValue = params.value !== undefined && params.value !== null;
      const hasLabel = params.label !== undefined && params.label !== null;
      if (!hasValue && !hasLabel) throw badArg('select 需要 value 或 label');
      const raw = hasValue ? params.value : params.label;
      if (typeof raw !== 'string') throw badArg('select 的 value/label 必须是字符串', { value: params.value, label: params.label });
      const normalized: Record<string, unknown> = { tabId, value: raw };
      if (hasValue && hasLabel) {
        if (typeof params.label !== 'string') throw badArg('select 的 label 必须是字符串', { label: params.label });
        normalized.label = params.label;
      }
      if (expectRevision !== undefined) normalized.expectRevision = expectRevision;
      controlFields(params, normalized);
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'get-html': {
      const normalized: Record<string, unknown> = { tabId };
      if (expectRevision !== undefined) normalized.expectRevision = expectRevision;
      const outer = optionalBoolean(params, 'outer');
      if (outer !== undefined) normalized.outer = outer;
      const maxChars = optionalInteger(params, 'maxChars', 1);
      if (maxChars !== undefined) normalized.maxChars = maxChars;
      // 无目标时返回整页 outerHTML（CLI `get-html` 不带目标即整页）。
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    case 'evaluate': {
      const expression = optionalString(params, 'expression');
      if (!expression || !expression.trim()) throw badArg('evaluate 需要非空 expression');
      const normalized: Record<string, unknown> = { tabId, expression };
      if (params.unverified === true) normalized.unverified = true;
      controlFields(params, normalized);
      return { method, tabId, target, params: normalized, source: params, appliedAliases: aliased.applied };
    }
    default:
      throw new RpcMethodError('E_UNKNOWN_METHOD', '未注册的页面动作：' + method, { method });
  }
}
