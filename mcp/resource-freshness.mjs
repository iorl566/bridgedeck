// mcp/resource-freshness.mjs —— resources 新鲜度分级（状态机 / 汇总 / 复核建议）。
//
// 目标（第十批-B ①：resources 新鲜度）：resources/read 之前只给一个布尔 `stale`
// （mcp/resources.mjs 的 snapshotFreshness）。客户端真正需要的是“这个快照处于哪个阶段、
// 还能不能用、该不该重新采集”：
//   - fresh     ：窗口内（默认 5 分钟内）——直接用；
//   - recent    ：可选复核窗口内（默认 30 分钟内）——可用，建议动作前复核；
//   - stale     ：超过复核窗口但数据仍在——先重读/重新 observe 再决策；
//   - expired   ：超过 TTL / 时间戳非法——视为无数据，必须重新采集；
//   - static    ：静态资源（技能文档/协议摘要/更新状态）——不参与新鲜度分级；
//   - unknown   ：拿不到 capturedAt（例如订阅前刚发生淘汰）。
//
// 本模块从 RESOURCES 的三个 SnapshotStore 派生条目表（不复制快照内容），给
// resources/list 汇总、resources/read 的 _meta 扩展、initialize 的 experimental 声明用。
//
// 纯函数（除了 buildFreshnessEntries 只调用 registry 的只读方法）；不写盘、不访问 daemon。
// 调用点：mcp/server.mjs 的 resources/list / resources/read / initialize；
// 单测 tests/unit/mcp-resource-freshness.test.mjs。

import { SNAPSHOT_FRESH_MS, snapshotEtag } from './resources.mjs';
import { INDEX_KINDS, isDynamicResource, resourceKindOf } from './resource-index.mjs';

/** 新鲜度状态。 */
export const FRESHNESS_STATES = Object.freeze({
  FRESH: 'fresh',
  RECENT: 'recent',
  STALE: 'stale',
  EXPIRED: 'expired',
  STATIC: 'static',
  UNKNOWN: 'unknown',
});

/** 新鲜度窗口默认值：fresh 沿用 resources.mjs 的 5 分钟；recent 给它 6 倍。 */
export const FRESHNESS_WINDOWS = Object.freeze({
  freshMs: SNAPSHOT_FRESH_MS,
  recentMs: SNAPSHOT_FRESH_MS * 6,
  expiredMs: SNAPSHOT_FRESH_MS * 24,
});

/** 环境变量：BB_MCP_FRESH_MS（毫秒）可整体缩放窗口，便于演示/测试。 */
export const FRESHNESS_ENV = 'BB_MCP_FRESH_MS';

/** 每个状态的建议动作。 */
export const FRESHNESS_ACTIONS = Object.freeze({
  [FRESHNESS_STATES.FRESH]: 'use',
  [FRESHNESS_STATES.RECENT]: 'revalidate',
  [FRESHNESS_STATES.STALE]: 'refresh',
  [FRESHNESS_STATES.EXPIRED]: 'recollect',
  [FRESHNESS_STATES.STATIC]: 'use',
  [FRESHNESS_STATES.UNKNOWN]: 'recollect',
});

/** 解析窗口：env 只影响 fresh 窗口，recent/expired 按比例缩放，保证单调。 */
export function resolveFreshnessWindows(env = process.env) {
  const raw = env && env[FRESHNESS_ENV];
  const override = Number(String(raw == null ? '' : raw).trim());
  if (Number.isFinite(override) && override > 0) {
    return Object.freeze({
      freshMs: Math.round(override),
      recentMs: Math.round(override * 6),
      expiredMs: Math.round(override * 24),
      source: FRESHNESS_ENV,
    });
  }
  return Object.freeze({
    freshMs: FRESHNESS_WINDOWS.freshMs,
    recentMs: FRESHNESS_WINDOWS.recentMs,
    expiredMs: FRESHNESS_WINDOWS.expiredMs,
    source: 'default',
  });
}

/** 把任意 capturedAt 解析成毫秒时间戳；非法返回 null。 */
export function parseCapturedAt(capturedAt) {
  if (capturedAt == null || capturedAt === '') return null;
  const value = typeof capturedAt === 'number' ? capturedAt : Date.parse(String(capturedAt));
  return Number.isFinite(value) ? value : null;
}

/**
 * 单个快照的新鲜度分级。
 * @returns {{ state:string, action:string, capturedAt:(string|null), ageMs:(number|null),
 *             ageSeconds:(number|null), freshMs:number, recentMs:number, expiredMs:number,
 *             fresh:boolean, stale:boolean, expired:boolean, hint:string }}
 */
export function classifyFreshness(capturedAt, { now = Date.now(), windows = null, kind = null } = {}) {
  const resolved = windows || resolveFreshnessWindows({});
  const kindValue = kind || null;
  const staticKind = kindValue == null ? false : !(kindValue === INDEX_KINDS.OBSERVATION || kindValue === INDEX_KINDS.EVIDENCE || kindValue === INDEX_KINDS.JOURNAL);
  const timestamp = parseCapturedAt(capturedAt);
  const base = {
    capturedAt: capturedAt == null ? null : String(capturedAt),
    freshMs: resolved.freshMs,
    recentMs: resolved.recentMs,
    expiredMs: resolved.expiredMs,
  };
  if (staticKind) {
    return Object.freeze({
      ...base,
      state: FRESHNESS_STATES.STATIC,
      action: FRESHNESS_ACTIONS[FRESHNESS_STATES.STATIC],
      ageMs: timestamp == null ? null : Math.max(0, now - timestamp),
      ageSeconds: timestamp == null ? null : Math.round(Math.max(0, now - timestamp) / 1000),
      fresh: true,
      stale: false,
      expired: false,
      hint: '静态资源：不随会话变化，不需要复核',
    });
  }
  if (timestamp == null) {
    return Object.freeze({
      ...base,
      state: FRESHNESS_STATES.UNKNOWN,
      action: FRESHNESS_ACTIONS[FRESHNESS_STATES.UNKNOWN],
      ageMs: null,
      ageSeconds: null,
      fresh: false,
      stale: true,
      expired: true,
      hint: '没有可用的 capturedAt：按“无数据”处理，重新采集',
    });
  }
  const ageMs = Math.max(0, now - timestamp);
  let state;
  if (ageMs <= resolved.freshMs) state = FRESHNESS_STATES.FRESH;
  else if (ageMs <= resolved.recentMs) state = FRESHNESS_STATES.RECENT;
  else if (ageMs <= resolved.expiredMs) state = FRESHNESS_STATES.STALE;
  else state = FRESHNESS_STATES.EXPIRED;
  return Object.freeze({
    ...base,
    state,
    action: FRESHNESS_ACTIONS[state],
    ageMs,
    ageSeconds: Math.round(ageMs / 1000),
    fresh: state === FRESHNESS_STATES.FRESH,
    stale: state !== FRESHNESS_STATES.FRESH && state !== FRESHNESS_STATES.RECENT,
    expired: state === FRESHNESS_STATES.EXPIRED,
    hint: freshnessHint(state),
  });
}

/** 状态 → 一句可读建议。 */
export function freshnessHint(state) {
  switch (state) {
    case FRESHNESS_STATES.FRESH:
      return '快照新鲜：可直接使用';
    case FRESHNESS_STATES.RECENT:
      return '快照较新但已过新鲜窗口：可读，动作前建议复核';
    case FRESHNESS_STATES.STALE:
      return '快照已过期（仍可读）：先用 browser_observe 复核再决策';
    case FRESHNESS_STATES.EXPIRED:
      return '快照超过 TTL：视为无数据，重新采集';
    case FRESHNESS_STATES.STATIC:
      return '静态资源：不需要复核';
    default:
      return '未知新鲜度：按无数据处理';
  }
}

const STORE_SPECS = Object.freeze([
  { store: 'observations', kind: INDEX_KINDS.OBSERVATION, label: 'observation' },
  { store: 'evidence', kind: INDEX_KINDS.EVIDENCE, label: 'evidence' },
  { store: 'journals', kind: INDEX_KINDS.JOURNAL, label: 'journal' },
]);

/**
 * 从资源注册表派生条目表（只读：keys() + get() + uriFor()）。
 * 每条：{ uri, kind, key, capturedAt, ageMs, persisted, etag, state, action }
 * 注意：'latest' 是存储里的别名 key（无 session 时就是它），也会作为一条普通条目出现；
 * 客户端按 uri 去重即可。
 */
export function buildFreshnessEntries(registry, { now = Date.now(), windows = null } = {}) {
  if (!registry || typeof registry !== 'object') throw new Error('buildFreshnessEntries 需要资源注册表');
  const resolved = windows || resolveFreshnessWindows({});
  const entries = [];
  for (const spec of STORE_SPECS) {
    const store = registry[spec.store];
    if (!store || typeof store.keys !== 'function' || typeof store.get !== 'function') continue;
    for (const key of store.keys()) {
      const entry = store.get(key);
      const capturedAt = entry && entry.at ? entry.at : null;
      const classification = classifyFreshness(capturedAt, { now, windows: resolved, kind: spec.kind });
      const uri = typeof registry.uriFor === 'function' ? registry.uriFor(spec.kind, key) : null;
      entries.push(Object.freeze({
        uri: uri || null,
        kind: spec.kind,
        key,
        capturedAt: classification.capturedAt,
        ageMs: classification.ageMs,
        persisted: Boolean(entry && entry.meta && entry.meta.persisted),
        etag: entry ? snapshotEtag(entry) : null,
        state: classification.state,
        action: classification.action,
      }));
    }
  }
  return Object.freeze(entries.map(Object.freeze));
}

/**
 * 汇总新鲜度（resources/list 的 _meta 用）。
 * @returns {{ windows:object, total:number, byState:object, stale:Array<string>,
 *             expired:Array<string>, oldestAgeMs:(number|null), newestCapturedAt:(string|null),
 *             dynamicResources:number }}
 */
export function summarizeFreshness(items, { now = Date.now(), windows = null } = {}) {
  const list = Array.isArray(items) ? items : [];
  const resolved = windows || resolveFreshnessWindows({});
  const byState = {};
  for (const state of Object.values(FRESHNESS_STATES)) byState[state] = 0;
  const stale = [];
  const expired = [];
  let oldestAgeMs = null;
  let newestAt = null;
  let dynamic = 0;
  for (const item of list) {
    const classification = item && item.state
      ? { state: item.state, capturedAt: item.capturedAt, ageMs: item.ageMs }
      : classifyFreshness(item && (item.capturedAt || item.at), { now, windows: resolved, kind: item && item.kind });
    byState[classification.state] = (byState[classification.state] || 0) + 1;
    if (classification.state === FRESHNESS_STATES.STALE) stale.push(item && item.uri ? String(item.uri) : String((item && item.key) || ''));
    if (classification.state === FRESHNESS_STATES.EXPIRED) expired.push(item && item.uri ? String(item.uri) : String((item && item.key) || ''));
    if (Number.isFinite(classification.ageMs)) {
      oldestAgeMs = oldestAgeMs == null ? classification.ageMs : Math.max(oldestAgeMs, classification.ageMs);
    }
    const parsed = parseCapturedAt(classification.capturedAt);
    if (parsed != null && (newestAt == null || parsed > newestAt)) newestAt = parsed;
    if (item && item.uri && isDynamicResource(item.uri)) dynamic += 1;
  }
  return Object.freeze({
    windows: resolved,
    total: list.length,
    byState: Object.freeze(byState),
    stale: Object.freeze(stale),
    expired: Object.freeze(expired),
    oldestAgeMs,
    newestCapturedAt: newestAt == null ? null : new Date(newestAt).toISOString(),
    dynamicResources: dynamic,
  });
}

/**
 * 单个资源的复核建议（客户端可据此选择“直接用 / 先重读 / 重新 observe”）。
 * @returns {{ uri:string, state:string, action:string, tool:(string|null), hint:string }}
 */
export function revalidationAdvice(uri, capturedAt, { now = Date.now(), windows = null } = {}) {
  const kind = resourceKindOf(uri);
  const classification = classifyFreshness(capturedAt, { now, windows, kind });
  const tools = {
    [INDEX_KINDS.OBSERVATION]: 'browser_observe',
    [INDEX_KINDS.EVIDENCE]: 'browser_debug_evidence',
    [INDEX_KINDS.JOURNAL]: 'browser_debug_journal',
  };
  return Object.freeze({
    uri: String(uri || ''),
    state: classification.state,
    action: classification.action,
    tool: tools[kind] || null,
    hint: classification.hint,
  });
}

/** 新鲜度能力快照（initialize experimental['browser-bridge/freshness'] 与测试共用）。 */
export function freshnessSnapshot({ windows = null } = {}) {
  const resolved = windows || resolveFreshnessWindows({});
  return Object.freeze({
    states: Object.freeze(Object.values(FRESHNESS_STATES)),
    actions: FRESHNESS_ACTIONS,
    windows: resolved,
    env: FRESHNESS_ENV,
    readMetaKey: 'browser-bridge/freshness',
    listMetaKey: 'browser-bridge/resources',
    staticKinds: Object.freeze([INDEX_KINDS.SKILL_MAIN, INDEX_KINDS.SKILL_REFERENCE, INDEX_KINDS.UPDATE_STATE, INDEX_KINDS.PROTOCOL_SUMMARY]),
    dynamicKinds: Object.freeze([INDEX_KINDS.OBSERVATION, INDEX_KINDS.EVIDENCE, INDEX_KINDS.JOURNAL]),
  });
}
