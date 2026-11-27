// mcp/subscription-diff.mjs —— 订阅集合的差量 / 覆盖 / 健康 / 对账计划。
//
// 目标（第十一批-C ①：resource graph 与订阅 diff）：
//   mcp/subscriptions.mjs 维护“客户端订阅了哪些 URI”，但客户端看不到三类关键事实：
//     1. 差量：我上一次 list/subscribe 之后，订阅集合到底变了什么（added/removed/kept）；
//     2. 覆盖：动态资源里哪些被订阅了、哪些没有、哪些订阅已经悬空（快照 LRU 淘汰后）；
//     3. 健康：哪些订阅长时间没收到任何通知（可能漏订阅/已失联）、哪些是重复/过期订阅。
//   本模块把这三件事做成纯函数，并给出“声明式对账计划”（desired vs current → toSubscribe/toUnsubscribe），
//   供 Node/Python SDK 做 `syncResourceSubscriptions()`。
//
// 设计约束：
//   1. 纯函数、无 IO：输入是 subscriptions.list() 的条目（或 URI 数组）+ resources/list 的行；
//   2. 不改变订阅语义：本模块只“建议”，真正的 subscribe/unsubscribe 仍走 MCP 方法；
//   3. 有界输出：建议列表默认最多 8 条、健康问题最多 32 条，避免 _meta 膨胀；
//   4. 稳定排序：所有输出按 URI 字典序（差量增删列表按输入顺序保留，便于看出时间序）；
//   5. 悬空订阅不自动删除：`orphanSubscriptions` 只报告，客户端/用户决定何时退订。
//
// 调用点（真实消费）：
//   - mcp/server.mjs：resources/list 的 _meta['browser-bridge/resources'].subscriptionCoverage；
//     resources/subscribe|unsubscribe 回执 _meta['browser-bridge/subscription'].diff / .health；
//     initialize experimental['browser-bridge/subscription-diff']；
//   - sdk/mcp-client.mjs 的 syncResourceSubscriptions()（对账计划）；
//   - 单测 tests/unit/mcp-subscription-diff.test.mjs。

import { INDEX_KINDS, resourceKindOf, DYNAMIC_KINDS } from './resource-index.mjs';
import { relatedUris } from './resource-graph.mjs';

/** 订阅对账/健康阈值默认值（环境变量可收紧，见 resolveSubscriptionDiffLimits）。 */
export const SUBSCRIPTION_DIFF_LIMITS = Object.freeze({
  maxSuggestions: 8,
  maxHealthItems: 32,
  /** 订阅超过该时长且从未收到通知 → idle（默认 5 分钟）。 */
  idleAfterMs: 5 * 60 * 1000,
  /** 订阅超过该时长（无论是否通知过）→ stale，建议重新 read 校验（默认 30 分钟）。 */
  staleAfterMs: 30 * 60 * 1000,
  maxTrackedUris: 512,
});

/** 差量原因码（回执/诊断可解释）。 */
export const SUBSCRIPTION_DIFF_REASONS = Object.freeze({
  NEW: 'new',
  DUPLICATE: 'duplicate',
  ORPHAN: 'orphan-resource-gone',
  ALIAS: 'latest-alias',
  SESSION: 'session-scoped',
  STATIC: 'static-resource',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLimits(limits) {
  const bag = isPlainObject(limits) ? limits : {};
  const pickInt = (value, fallback, minimum = 0) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum ? Math.floor(number) : fallback;
  };
  return Object.freeze({
    maxSuggestions: Math.min(pickInt(bag.maxSuggestions, SUBSCRIPTION_DIFF_LIMITS.maxSuggestions, 1), 64),
    maxHealthItems: Math.min(pickInt(bag.maxHealthItems, SUBSCRIPTION_DIFF_LIMITS.maxHealthItems, 1), 256),
    idleAfterMs: pickInt(bag.idleAfterMs, SUBSCRIPTION_DIFF_LIMITS.idleAfterMs, 0),
    staleAfterMs: pickInt(bag.staleAfterMs, SUBSCRIPTION_DIFF_LIMITS.staleAfterMs, 0),
    maxTrackedUris: Math.min(pickInt(bag.maxTrackedUris, SUBSCRIPTION_DIFF_LIMITS.maxTrackedUris, 1), 4096),
  });
}

/**
 * 归一化订阅条目：接受 registry.list() 的条目、URI 字符串数组或 Set。
 * 输出按 URI 去重（保留第一条）、按输入顺序；条目统一成
 * { uri, subscribedAt:string|null, ageMs:number|null, notifications:number, lastNotifiedAt:string|null }。
 */
export function normalizeSubscriptionEntries(input) {
  const raw = input instanceof Set ? [...input] : (Array.isArray(input) ? input : []);
  const seen = new Set();
  const entries = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const uri = item.trim();
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      entries.push(Object.freeze({ uri, subscribedAt: null, ageMs: null, notifications: 0, lastNotifiedAt: null }));
      continue;
    }
    if (!isPlainObject(item)) continue;
    // 条目对象的 uri 必须是字符串（数字/对象是坏输入，直接跳过而不是 String() 成 "42"）。
    if (typeof item.uri !== 'string') continue;
    const uri = item.uri.trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    entries.push(Object.freeze({
      uri,
      subscribedAt: typeof item.subscribedAt === 'string' ? item.subscribedAt : null,
      ageMs: Number.isFinite(Number(item.ageMs)) ? Number(item.ageMs) : null,
      notifications: Number.isFinite(Number(item.notifications)) ? Number(item.notifications) : 0,
      lastNotifiedAt: typeof item.lastNotifiedAt === 'string' ? item.lastNotifiedAt : null,
    }));
  }
  return Object.freeze(entries);
}

function uriSet(entries) {
  return new Set(entries.map((entry) => entry.uri));
}

/**
 * 订阅集合差量（before → after）。
 * @returns {{ added:string[], removed:string[], kept:string[],
 *             changed:Array<{uri:string,field:string,from:any,to:any}>,
 *             counts:{before:number,after:number,added:number,removed:number,kept:number,churn:number},
 *             unchanged:boolean }}
 */
export function diffSubscriptions(before, after) {
  const previous = normalizeSubscriptionEntries(before);
  const next = normalizeSubscriptionEntries(after);
  const beforeMap = new Map(previous.map((entry) => [entry.uri, entry]));
  const afterMap = new Map(next.map((entry) => [entry.uri, entry]));
  const added = [];
  const kept = [];
  const changed = [];
  for (const entry of next) {
    const old = beforeMap.get(entry.uri);
    if (!old) {
      added.push(entry.uri);
      continue;
    }
    kept.push(entry.uri);
    for (const field of ['notifications', 'lastNotifiedAt']) {
      if (old[field] !== entry[field]) changed.push(Object.freeze({ uri: entry.uri, field, from: old[field], to: entry[field] }));
    }
  }
  const removed = [];
  for (const entry of previous) if (!afterMap.has(entry.uri)) removed.push(entry.uri);
  const churn = added.length + removed.length;
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    kept: Object.freeze(kept),
    changed: Object.freeze(changed),
    counts: Object.freeze({ before: previous.length, after: next.length, added: added.length, removed: removed.length, kept: kept.length, churn }),
    unchanged: churn === 0 && changed.length === 0,
  });
}

/**
 * 一次快照更新影响的订阅：精确匹配 / 未订阅 / “近失”（同一会话兄弟、latest 别名）。
 * nearMiss 需要 graph 才能算（没有 graph 时只按 URI 形状推断同会话）。
 * @returns {{ matched:string[], missing:string[], nearMiss:Array<{uri:string,reason:string,relatedTo:string}>,
 *             matchedCount:number, missingCount:number }}
 */
export function affectedByUpdate(entries, uris, { graph = null } = {}) {
  const subscribed = uriSet(normalizeSubscriptionEntries(entries));
  const updated = Array.isArray(uris) ? uris : (uris == null ? [] : [uris]);
  const matched = [];
  const missing = [];
  const nearMiss = [];
  const seen = new Set();
  for (const raw of updated) {
    const uri = String(raw || '').trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    if (subscribed.has(uri)) {
      matched.push(uri);
      continue;
    }
    missing.push(uri);
    // 近失只对“同一会话”或“latest 别名”这种可解释关系报告，不猜无关 URI。
    const related = graph ? relatedUris(graph, uri, { depth: 1, types: ['session-sibling', 'latest-shadow'] }) : [];
    for (const item of related) {
      if (!subscribed.has(item.uri)) continue;
      nearMiss.push(Object.freeze({ uri: item.uri, reason: item.edge, relatedTo: uri }));
    }
  }
  return Object.freeze({
    matched: Object.freeze(matched),
    missing: Object.freeze(missing),
    nearMiss: Object.freeze(nearMiss),
    matchedCount: matched.length,
    missingCount: missing.length,
  });
}

function isAliasUri(uri) {
  return /^bridge:\/\/(observation|debug\/(evidence|journal))\/latest$/.test(String(uri).split('?')[0]);
}

function isDynamicUri(uri) {
  return DYNAMIC_KINDS.includes(resourceKindOf(uri));
}

/**
 * 订阅覆盖报告：以 resources/list 的行为“应订阅集合”，说明覆盖/悬空/建议。
 * @param {Array<object>} entries subscriptions.list()
 * @param {Array<object>} rows resources/list 的行
 * @param {{graph?:object, limits?:object}} [options]
 * @returns {{ total:number, subscribedDynamic:number, unsubscribedDynamic:number,
 *             coverage:number, aliasesCovered:number, staticSubscriptions:string[],
 *             orphanSubscriptions:string[], duplicateSubscriptions:string[],
 *             suggestions:Array<{uri:string, reason:string, priority:number}>,
 *             byKind:object }}
 */
export function coverageReport(entries, rows, { graph = null, limits = null } = {}) {
  const resolved = normalizeLimits(limits);
  const list = normalizeSubscriptionEntries(entries);
  const subscribed = uriSet(list);
  const resourceRows = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row.uri === 'string');
  const resourceUris = new Set(resourceRows.map((row) => String(row.uri).split('?')[0]));
  const dynamicRows = resourceRows.filter((row) => isDynamicUri(row.uri));
  const dynamicUris = new Set(dynamicRows.map((row) => String(row.uri).split('?')[0]));
  const subscribedDynamic = [...subscribed].filter((uri) => dynamicUris.has(uri)).length;
  const unsubscribedDynamic = [...dynamicUris].filter((uri) => !subscribed.has(uri));
  // 静态订阅 = 订阅了“仍在行集合里、但不是动态资源”的 URI；不存在的 URI 归入 orphan，
  // 避免同一个 URI 同时被报告成 static 与 orphan（会让客户端收到互相矛盾的建议）。
  const staticSubscriptions = [...subscribed].filter((uri) => resourceUris.has(uri) && !dynamicUris.has(uri));
  const orphanSubscriptions = [...subscribed].filter((uri) => !resourceUris.has(uri) && !isAliasUri(uri));
  const duplicateSubscriptions = [];
  const seen = new Set();
  for (const entry of list) {
    if (seen.has(entry.uri)) duplicateSubscriptions.push(entry.uri);
    seen.add(entry.uri);
  }
  const byKind = {};
  for (const row of dynamicRows) {
    const kind = resourceKindOf(row.uri);
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  // 建议顺序：latest 别名（最容易漏、更新最频繁）→ 会话级 observation → 其它动态。
  const suggestions = unsubscribedDynamic
    .map((uri) => ({
      uri,
      reason: isAliasUri(uri) ? SUBSCRIPTION_DIFF_REASONS.ALIAS : SUBSCRIPTION_DIFF_REASONS.SESSION,
      priority: isAliasUri(uri) ? 0.9 : (resourceKindOf(uri) === INDEX_KINDS.OBSERVATION ? 0.8 : 0.6),
    }))
    .sort((a, b) => b.priority - a.priority || a.uri.localeCompare(b.uri))
    .slice(0, resolved.maxSuggestions);
  const totalDynamic = dynamicUris.size;
  return Object.freeze({
    total: list.length,
    subscribedDynamic,
    unsubscribedDynamic: unsubscribedDynamic.length,
    coverage: totalDynamic ? Number((subscribedDynamic / totalDynamic).toFixed(4)) : 1,
    aliasesCovered: [...subscribed].filter(isAliasUri).length,
    staticSubscriptions: Object.freeze(staticSubscriptions.sort()),
    orphanSubscriptions: Object.freeze(orphanSubscriptions.sort()),
    duplicateSubscriptions: Object.freeze(duplicateSubscriptions),
    suggestions: Object.freeze(suggestions.map((item) => Object.freeze(item))),
    byKind: Object.freeze(byKind),
    dynamicResources: totalDynamic,
    graphFingerprint: graph && typeof graph.fingerprint === 'string' ? graph.fingerprint : null,
  });
}

/**
 * 声明式对账计划：desired 与 current 的差异 → 客户端该发哪些 subscribe/unsubscribe。
 * 用于 SDK 的 syncResourceSubscriptions()：幂等、可重放，不依赖服务端新增批量方法。
 * @param {Array<string>|Set<string>} desired
 * @param {Array<string>|Set<string>} current
 * @returns {{ toSubscribe:string[], toUnsubscribe:string[], unchanged:string[],
 *             desired:number, current:number, ops:number }}
 */
export function planSubscriptionChanges(desired, current) {
  const desiredSet = new Set(normalizeSubscriptionEntries(desired instanceof Set ? [...desired] : desired).map((entry) => entry.uri));
  const currentSet = new Set(normalizeSubscriptionEntries(current instanceof Set ? [...current] : current).map((entry) => entry.uri));
  const toSubscribe = [...desiredSet].filter((uri) => !currentSet.has(uri)).sort();
  const toUnsubscribe = [...currentSet].filter((uri) => !desiredSet.has(uri)).sort();
  const unchanged = [...desiredSet].filter((uri) => currentSet.has(uri)).sort();
  return Object.freeze({
    toSubscribe: Object.freeze(toSubscribe),
    toUnsubscribe: Object.freeze(toUnsubscribe),
    unchanged: Object.freeze(unchanged),
    desired: desiredSet.size,
    current: currentSet.size,
    ops: toSubscribe.length + toUnsubscribe.length,
  });
}

/**
 * 订阅健康报告。
 * @param {Array<object>} entries subscriptions.list()
 * @param {{now?:number, limits?:object}} [options]
 * @returns {{ total:number, idle:string[], stale:string[], neverNotified:number,
 *             notified:number, longestIdleMs:number, issues:Array<{uri:string,code:string,message:string}>,
 *             healthy:boolean }}
 */
export function subscriptionHealth(entries, { now = Date.now(), limits = null } = {}) {
  const resolved = normalizeLimits(limits);
  const list = normalizeSubscriptionEntries(entries).slice(0, resolved.maxTrackedUris);
  const at = Number(now) || Date.now();
  const idle = [];
  const stale = [];
  const issues = [];
  let neverNotified = 0;
  let notified = 0;
  let longestIdleMs = 0;
  for (const entry of list) {
    const ageMs = entry.ageMs != null ? entry.ageMs : (entry.subscribedAt ? Math.max(0, at - Date.parse(entry.subscribedAt)) : 0);
    if (!Number.isFinite(ageMs)) continue;
    longestIdleMs = Math.max(longestIdleMs, ageMs);
    if (entry.notifications > 0) notified += 1;
    else neverNotified += 1;
    if (entry.notifications === 0 && ageMs >= resolved.idleAfterMs) {
      idle.push(entry.uri);
      issues.push(Object.freeze({ uri: entry.uri, code: 'subscription-idle', message: '订阅 ' + Math.round(ageMs / 1000) + 's 未收到任何更新通知（可能资源未变化或订阅失效）' }));
    } else if (ageMs >= resolved.staleAfterMs) {
      stale.push(entry.uri);
      issues.push(Object.freeze({ uri: entry.uri, code: 'subscription-stale', message: '订阅已存在 ' + Math.round(ageMs / 1000) + 's，建议重新 read 校验内容' }));
    }
  }
  return Object.freeze({
    total: list.length,
    idle: Object.freeze(idle.sort()),
    stale: Object.freeze(stale.sort()),
    neverNotified,
    notified,
    longestIdleMs,
    issues: Object.freeze(issues.slice(0, resolved.maxHealthItems)),
    healthy: idle.length === 0 && stale.length === 0,
  });
}

/**
 * 由 subscriptions.stats().counters 派生 churn 指标（server 回执/快照用）。
 * @returns {{ subscribed:number, unsubscribed:number, evicted:number, capped:number,
 *             failed:number, churnRate:number, cleanupRate:number }}
 */
export function churnReport(counters) {
  const bag = isPlainObject(counters) ? counters : {};
  const pick = (name) => (Number.isFinite(Number(bag[name])) ? Number(bag[name]) : 0);
  const subscribed = pick('subscribed');
  const unsubscribed = pick('unsubscribed');
  const evicted = pick('evicted');
  const capped = pick('capped');
  const failed = pick('failed');
  const cleared = pick('cleared');
  const churnRate = subscribed ? Number(((evicted + unsubscribed) / subscribed).toFixed(4)) : 0;
  return Object.freeze({
    subscribed,
    unsubscribed,
    evicted,
    capped,
    failed,
    cleared,
    churnRate,
    cleanupRate: subscribed ? Number(((unsubscribed + cleared) / subscribed).toFixed(4)) : 0,
  });
}

/**
 * 订阅 diff 自检（server 启动期 assertSubscriptionDiff 与单测共用）。
 * 用合成数据验证：差量对称性、对账收敛性、覆盖数学、健康阈值。
 * @returns {{ ok:boolean, errors:Array<{code:string,message:string}>, checks:number }}
 */
export function auditSubscriptionDiff() {
  const errors = [];
  const check = (condition, code, message) => { if (!condition) errors.push(Object.freeze({ code, message })); };
  let checks = 0;

  const before = [{ uri: 'bridge://observation/s1', notifications: 1 }, { uri: 'bridge://observation/latest' }];
  const after = [{ uri: 'bridge://observation/s1', notifications: 3 }, { uri: 'bridge://observation/s2' }];
  const diff = diffSubscriptions(before, after);
  checks += 1; check(diff.counts.added === 1 && diff.added[0] === 'bridge://observation/s2', 'diff-added', '差量没识别新增订阅');
  checks += 1; check(diff.counts.removed === 1 && diff.removed[0] === 'bridge://observation/latest', 'diff-removed', '差量没识别移除订阅');
  checks += 1; check(diff.counts.kept === 1 && diff.changed.length === 1, 'diff-changed', '差量没识别通知计数变化');
  const identity = diffSubscriptions(after, after);
  checks += 1; check(identity.unchanged === true && identity.counts.churn === 0, 'diff-identity', '相同集合的差量不是 unchanged');

  const plan = planSubscriptionChanges(['bridge://observation/latest', 'bridge://observation/s1'], ['bridge://observation/s1']);
  checks += 1; check(plan.toSubscribe.length === 1 && plan.toUnsubscribe.length === 0, 'plan-converge', '对账计划没有收敛');
  const converged = planSubscriptionChanges(['bridge://observation/latest', 'bridge://observation/s1'], ['bridge://observation/s1', 'bridge://observation/latest']);
  checks += 1; check(converged.ops === 0, 'plan-idempotent', '对账计划不幂等');

  const rows = [
    { uri: 'bridge://observation/latest' },
    { uri: 'bridge://observation/s1' },
    { uri: 'bridge://debug/journal/s1' },
    { uri: 'bridge://skill/SKILL.md' },
  ];
  const coverage = coverageReport([{ uri: 'bridge://observation/s1' }, { uri: 'bridge://observation/gone' }], rows);
  checks += 1; check(coverage.subscribedDynamic === 1 && coverage.dynamicResources === 3, 'coverage-math', '覆盖数学不对：' + JSON.stringify({ subscribedDynamic: coverage.subscribedDynamic, dynamicResources: coverage.dynamicResources }));
  checks += 1; check(coverage.orphanSubscriptions.includes('bridge://observation/gone'), 'coverage-orphan', '悬空订阅没被报告');
  checks += 1; check(coverage.suggestions.some((item) => item.uri === 'bridge://observation/latest'), 'coverage-suggest', '没有建议订阅 latest 别名');

  const healthy = subscriptionHealth([{ uri: 'bridge://observation/s1', ageMs: 1000, notifications: 2 }], { now: 10_000 });
  checks += 1; check(healthy.healthy === true, 'health-fresh', '刚通知过的订阅被判为不健康');
  const idleReport = subscriptionHealth([{ uri: 'bridge://observation/s1', ageMs: 10 * 60 * 1000, notifications: 0 }], { now: 0 });
  checks += 1; check(idleReport.idle.length === 1, 'health-idle', '长期无通知的订阅没被判为 idle');

  const affected = affectedByUpdate([{ uri: 'bridge://observation/s1' }], ['bridge://observation/s1', 'bridge://observation/s2']);
  checks += 1; check(affected.matchedCount === 1 && affected.missingCount === 1, 'affected-split', '更新影响分析不对');

  const churn = churnReport({ subscribed: 10, unsubscribed: 2, evicted: 3, capped: 1, failed: 0, cleared: 0 });
  checks += 1; check(churn.churnRate === 0.5 && churn.cleanupRate === 0.2, 'churn-rate', 'churn 指标计算不对：' + JSON.stringify(churn));

  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), checks });
}

/** strict 包装：自检不过时启动即失败。 */
export function assertSubscriptionDiff() {
  const report = auditSubscriptionDiff();
  if (!report.ok) {
    throw new Error('MCP 订阅 diff 自检失败：\n' + report.errors.map((error) => error.code + ' ' + error.message).join('\n'));
  }
  return report;
}

/** 订阅 diff 能力快照（initialize experimental['browser-bridge/subscription-diff']）。 */
export function subscriptionDiffSnapshot() {
  return Object.freeze({
    supported: true,
    limits: SUBSCRIPTION_DIFF_LIMITS,
    reasons: SUBSCRIPTION_DIFF_REASONS,
    fields: Object.freeze({
      diff: Object.freeze(['added', 'removed', 'kept', 'changed', 'counts', 'unchanged']),
      coverage: Object.freeze(['total', 'subscribedDynamic', 'unsubscribedDynamic', 'coverage', 'aliasesCovered', 'orphanSubscriptions', 'suggestions']),
      health: Object.freeze(['total', 'idle', 'stale', 'neverNotified', 'notified', 'healthy']),
    }),
    plan: Object.freeze({ fields: Object.freeze(['toSubscribe', 'toUnsubscribe', 'unchanged', 'ops']) }),
    reconcile: 'sdk.syncResourceSubscriptions(desired)',
  });
}
