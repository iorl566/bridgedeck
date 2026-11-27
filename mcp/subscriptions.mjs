// mcp/subscriptions.mjs —— MCP resources/subscribe 的订阅集合与变更推送。
//
// 背景（W7-C 第 1 项）：
//   观察/证据/时间线快照由 tools/call 成功后回填，客户端此前只能轮询 resources/read 才知道
//   内容变了（capabilities.resources.subscribe=false）。本模块把 subscribe 能力提升为 true：
//   维护“客户端订阅了哪些 URI”的有界集合，并在快照真正更新时发送
//   `notifications/resources/updated`，params 里带被更新的 uri 与更新来源元数据。
//
// 设计约束：
//   1. 订阅是 URI 级的精确匹配（不做前缀/模板展开）：客户端订阅什么 URI，通知就回什么 URI；
//      分页查询串（?limit=&cursor=）在接入层被归一掉，通知永远指 baseUri，客户端重新 read 时
//      自行决定分页参数；
//   2. 有界：默认最多 256 条订阅；超出时按“最早订阅优先”淘汰一条，并在返回报告里如实给出
//      evicted，避免客户端异常重连后无限堆积；
//   3. 单批有界：一次快照更新最多通知 maxNotificationsPerUpdate 条（默认 64），
//      防止一个批量动作把 stdio 通道刷满；
//   4. 失败隔离：notify 抛错（客户端断开 / stdout 已关闭）只记计数与 lastError，
//      绝不影响触发更新的工具结果；server 的 send() 本身也不应抛，但这里仍做防御；
//   5. 不伪造：未订阅的 URI 不发通知，只计入 skippedUnsubscribed，便于诊断“为什么没收到”；
//   6. 幂等：重复订阅同一 URI 返回 added=false，不重置订阅时间也不重复计数；
//   7. 断开清理：server 在 stdin close / shutdown 时调用 clear(reason)，订阅不会跨会话残留。
//
// 调用点：
//   - mcp/server.mjs：initialize 能力声明、resources/list 的订阅计数、
//     resources/subscribe / resources/unsubscribe、stdio 关闭时的 clear()；
//   - mcp/resources.mjs 的快照更新 sink（server 把事件转给 notifyUpdated）。
// 单测：tests/unit/mcp-subscriptions.test.mjs。

/** 订阅变更通知的方法名（MCP 标准方法，不放进 experimental 面）。 */
export const RESOURCE_UPDATED_NOTIFICATION = 'notifications/resources/updated';

/** 订阅集合的默认上限。 */
export const SUBSCRIPTION_LIMITS = Object.freeze({
  /** 最多同时保留多少条订阅（超出淘汰最早订阅的一条）。 */
  maxSubscriptions: 256,
  /** 单条 URI 的长度上限（防止把通知通道当日志用）。 */
  maxUriLength: 2048,
  /** 一次快照更新最多通知多少条订阅。 */
  maxNotificationsPerUpdate: 64,
});

/** 环境变量：BB_MCP_SUBSCRIPTIONS=off 关闭推送；其余为收紧上限（只能收紧不能放大）。 */
export const SUBSCRIPTION_ENV = Object.freeze({
  disable: 'BB_MCP_SUBSCRIPTIONS',
  maxSubscriptions: 'BB_MCP_SUBSCRIPTIONS_MAX',
  maxPerUpdate: 'BB_MCP_SUBSCRIPTIONS_BATCH',
});

/**
 * 订阅相关错误码（server 映射为 JSON-RPC -32602）。
 * 复用协议已有码而不是新增幽灵码：E_BAD_ARG 对应“URI 形状/参数非法”，
 * E_ARG_RANGE 对应“超过订阅上限”，两者都已在错误码清单登记。
 */
export const SUBSCRIPTION_ERRORS = Object.freeze({
  BAD_URI: 'E_BAD_ARG',
  LIMIT: 'E_ARG_RANGE',
});

function envValue(env, name) {
  const bag = env && typeof env === 'object' ? env : {};
  const value = bag[name];
  return value == null ? '' : String(value).trim();
}

function positiveInt(value, fallback) {
  if (!/^\d+$/.test(String(value))) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/** 订阅推送总开关（off/0/false/disabled 关闭）。 */
export function subscriptionDisabled(env = process.env) {
  const value = envValue(env, SUBSCRIPTION_ENV.disable).toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

/**
 * 解析订阅上限：环境变量只能收紧，不能把上限放大到默认值以上。
 * @returns {{ enabled:boolean, maxSubscriptions:number, maxUriLength:number, maxNotificationsPerUpdate:number }}
 */
export function resolveSubscriptionLimits(env = process.env) {
  const requestedMax = positiveInt(envValue(env, SUBSCRIPTION_ENV.maxSubscriptions), SUBSCRIPTION_LIMITS.maxSubscriptions);
  const requestedBatch = positiveInt(envValue(env, SUBSCRIPTION_ENV.maxPerUpdate), SUBSCRIPTION_LIMITS.maxNotificationsPerUpdate);
  return Object.freeze({
    enabled: !subscriptionDisabled(env),
    maxSubscriptions: Math.min(requestedMax, SUBSCRIPTION_LIMITS.maxSubscriptions),
    maxUriLength: SUBSCRIPTION_LIMITS.maxUriLength,
    maxNotificationsPerUpdate: Math.min(requestedBatch, SUBSCRIPTION_LIMITS.maxNotificationsPerUpdate),
  });
}

/** 带 code 的订阅错误（server 转成 -32602）。 */
export class SubscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
  }
}

/**
 * 归一化订阅 URI：去空白、长度/控制字符校验。
 * URI 的语义（是否 bridge://、资源是否存在）由接入层用资源目录先校验，这里只管形状。
 * @returns {string}
 */
export function normalizeSubscriptionUri(uri, limits = SUBSCRIPTION_LIMITS) {
  if (typeof uri !== 'string') {
    throw new SubscriptionError(SUBSCRIPTION_ERRORS.BAD_URI, '订阅 URI 必须是字符串');
  }
  const text = uri.trim();
  if (!text) throw new SubscriptionError(SUBSCRIPTION_ERRORS.BAD_URI, '订阅 URI 不能为空');
  const maxUriLength = Number(limits && limits.maxUriLength) > 0 ? Number(limits.maxUriLength) : SUBSCRIPTION_LIMITS.maxUriLength;
  if (text.length > maxUriLength) {
    throw new SubscriptionError(SUBSCRIPTION_ERRORS.BAD_URI, '订阅 URI 超过 ' + maxUriLength + ' 字符上限');
  }
  // 控制字符/换行会污染 newline-delimited JSON-RPC 帧，直接拒绝而不是悄悄替换。
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new SubscriptionError(SUBSCRIPTION_ERRORS.BAD_URI, '订阅 URI 含控制字符');
  }
  return text;
}

/**
 * 构造一条 resources/updated 通知（纯函数，便于单测与复用）。
 * @param {string} uri
 * @param {{kind?:string, key?:string, action?:string, tool?:string, at?:string, sequence?:number}} [detail]
 */
export function updatedNotification(uri, detail = {}) {
  const source = detail && typeof detail === 'object' ? detail : {};
  const meta = {};
  for (const name of ['kind', 'key', 'action', 'tool', 'at']) {
    const value = source[name];
    if (typeof value === 'string' && value) meta[name] = value;
  }
  if (Number.isInteger(source.sequence) && source.sequence >= 0) meta.sequence = source.sequence;
  return {
    jsonrpc: '2.0',
    method: RESOURCE_UPDATED_NOTIFICATION,
    params: {
      uri: String(uri),
      _meta: { 'browser-bridge/resource-update': meta },
    },
  };
}

/**
 * 创建订阅集合。
 *
 * 传入 notify 时，每次通知以完整 JSON-RPC 消息调用 notify(message)；单测可注入收集器。
 * 订阅集合内部不使用定时器（快照更新是事件驱动的），也不持有 URI 内容之外的引用。
 *
 * @param {{
 *   notify?: (message:object)=>void,
 *   env?: object,
 *   limits?: object,
 *   now?: ()=>number,
 *   log?: (message:string)=>void,
 * }} [options]
 */
export function createSubscriptionRegistry({
  notify = null,
  env = process.env,
  limits,
  now = () => Date.now(),
  log = null,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const resolvedLimits = limits && typeof limits === 'object'
    ? Object.freeze({ ...resolveSubscriptionLimits(env), ...limits })
    : resolveSubscriptionLimits(env);
  /** @type {Map<string, {uri:string, subscribedAt:number, notifications:number, lastNotifiedAt:number|null}>} */
  const entries = new Map();
  const counters = {
    subscribed: 0,
    unsubscribed: 0,
    evicted: 0,
    updates: 0,
    notifications: 0,
    skippedUnsubscribed: 0,
    capped: 0,
    failed: 0,
    cleared: 0,
    duplicateSubscribes: 0,
  };
  const state = { lastError: null, lastClear: null, lastNotifiedAt: null };

  function reportError(error) {
    state.lastError = String((error && error.message) || error);
    if (typeof log === 'function') {
      try { log('resources/updated 通知失败：' + state.lastError); } catch { /* 诊断日志不应抛 */ }
    }
  }

  /**
   * 订阅一个 URI（已归一化）。
   * - 重复订阅：added=false，保留原订阅时间；
   * - 达到上限：淘汰最早订阅的一条，返回 evicted；
   * - 推送被环境关闭：added=false，enabled=false（不伪造订阅成功）。
   */
  function subscribe(uri) {
    const key = normalizeSubscriptionUri(uri, resolvedLimits);
    if (!resolvedLimits.enabled) {
      return Object.freeze({ uri: key, added: false, enabled: false, count: entries.size, max: resolvedLimits.maxSubscriptions, evicted: null });
    }
    const existing = entries.get(key);
    if (existing) {
      counters.duplicateSubscribes += 1;
      return Object.freeze({ uri: key, added: false, enabled: true, count: entries.size, max: resolvedLimits.maxSubscriptions, evicted: null, subscribedAt: new Date(existing.subscribedAt).toISOString() });
    }
    let evicted = null;
    while (entries.size >= resolvedLimits.maxSubscriptions) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
      counters.evicted += 1;
      evicted = oldest;
    }
    entries.set(key, { uri: key, subscribedAt: clock(), notifications: 0, lastNotifiedAt: null });
    counters.subscribed += 1;
    return Object.freeze({
      uri: key,
      added: true,
      enabled: true,
      count: entries.size,
      max: resolvedLimits.maxSubscriptions,
      evicted,
      subscribedAt: new Date(clock()).toISOString(),
    });
  }

  /** 取消订阅；未订阅过也按规范返回成功（幂等），用 found 区分。 */
  function unsubscribe(uri) {
    const key = normalizeSubscriptionUri(uri, resolvedLimits);
    const found = entries.delete(key);
    if (found) counters.unsubscribed += 1;
    return Object.freeze({ uri: key, found, removed: found, count: entries.size, max: resolvedLimits.maxSubscriptions });
  }

  function has(uri) {
    try {
      return entries.has(normalizeSubscriptionUri(uri, resolvedLimits));
    } catch {
      return false;
    }
  }

  function size() {
    return entries.size;
  }

  /** 订阅列表（按订阅时间升序；只读快照）。 */
  function list() {
    const at = clock();
    return [...entries.values()].map((entry) => Object.freeze({
      uri: entry.uri,
      subscribedAt: new Date(entry.subscribedAt).toISOString(),
      ageMs: Math.max(0, at - entry.subscribedAt),
      notifications: entry.notifications,
      lastNotifiedAt: entry.lastNotifiedAt == null ? null : new Date(entry.lastNotifiedAt).toISOString(),
    }));
  }

  /**
   * 快照更新后推送 `notifications/resources/updated`。
   * @param {string|string[]} uris 本次更新的 baseUri 列表（重复项自动去重）
   * @param {object} [detail] 更新来源元数据（kind/key/action/tool/at）
   * @returns {{ updated:number, uris:string[], skipped:number, capped:number, active:number, enabled:boolean }}
   */
  function notifyUpdated(uris, detail = {}) {
    const source = Array.isArray(uris) ? uris : [uris];
    const report = { updated: 0, uris: [], skipped: 0, capped: 0, active: entries.size, enabled: resolvedLimits.enabled };
    if (!resolvedLimits.enabled) return Object.freeze(report);
    counters.updates += 1;
    const seen = new Set();
    const targets = [];
    for (const raw of source) {
      let key;
      try {
        key = normalizeSubscriptionUri(raw, resolvedLimits);
      } catch {
        report.skipped += 1;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = entries.get(key);
      if (!entry) {
        counters.skippedUnsubscribed += 1;
        report.skipped += 1;
        continue;
      }
      targets.push(entry);
    }
    const batch = targets.slice(0, resolvedLimits.maxNotificationsPerUpdate);
    report.capped = targets.length - batch.length;
    counters.capped += report.capped;
    for (const entry of batch) {
      counters.notifications += 1;
      const message = updatedNotification(entry.uri, {
        at: new Date(clock()).toISOString(),
        ...detail,
        sequence: counters.notifications,
      });
      try {
        if (typeof notify === 'function') notify(message);
        entry.notifications += 1;
        entry.lastNotifiedAt = clock();
        state.lastNotifiedAt = entry.lastNotifiedAt;
        report.updated += 1;
        report.uris.push(entry.uri);
      } catch (error) {
        counters.notifications -= 1;
        counters.failed += 1;
        reportError(error);
      }
    }
    return Object.freeze({ ...report, uris: Object.freeze(report.uris) });
  }

  /** 清理全部订阅（stdio 断开/shutdown）；返回被清理的数量与原因。 */
  function clear(reason = '') {
    const cleared = entries.size;
    entries.clear();
    counters.cleared += cleared;
    state.lastClear = Object.freeze({ cleared, reason: String(reason || ''), at: new Date(clock()).toISOString() });
    return Object.freeze({ cleared, reason: String(reason || ''), count: entries.size });
  }

  /** 只读统计（server 的 resources/list 与单测使用）。 */
  function stats() {
    return Object.freeze({
      enabled: resolvedLimits.enabled,
      active: entries.size,
      limits: resolvedLimits,
      notification: RESOURCE_UPDATED_NOTIFICATION,
      counters: Object.freeze({ ...counters }),
      lastError: state.lastError,
      lastClear: state.lastClear,
      lastNotifiedAt: state.lastNotifiedAt == null ? null : new Date(state.lastNotifiedAt).toISOString(),
    });
  }

  return Object.freeze({
    subscribe,
    unsubscribe,
    has,
    size,
    list,
    notifyUpdated,
    clear,
    stats,
    limits: resolvedLimits,
    notification: RESOURCE_UPDATED_NOTIFICATION,
  });
}
