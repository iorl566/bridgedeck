// daemon/session-quota.js —— 批处理会话的全局配额分配器（纯内存 + 可注入时钟）。
//
// 背景：`session.start` 单条启动由 daemon 直接处理，但如果 Agent 一次要开 N 个会话
// （批处理/矩阵/多标签页任务），直接并发 `session.start` 会带来两个问题：
//   1) 没有任何全局上限：几十个 session 同时启动会把浏览器/扩展打爆；
//   2) 没有公平性：先到的批次可以占满全部额度，后到的批次只能失败重试。
//
// 本模块只负责"配额"这一层，与真正的 session.start/stop 完全解耦：
// - `createSessionQuota()` 维护**预约（reservation）→ 提交（commit）→ 释放（release）**
//   三段式账本：批次先用 reserve 拿到额度，每成功启动一个会话 commit 一个名额
//   （此时 live 会话数增加、预约额减少，总量不变），失败/取消的名额 release 回池子；
// - `planQuotaAdmission()` 是纯函数：给一组请求（batchId/requested/priority/createdAt）
//   按优先级 + 先来先服务算出每个批次能拿多少，供 `batch.plan`（dry-run）与单测使用；
// - `quotaPolicyFromEnv()` 从 BB_SESSION_QUOTA / BB_BATCH_QUOTA / BB_BATCH_CONCURRENCY /
//   BB_INSTANCE_QUOTA 读策略，非法值忽略（回退默认），且启动日志可读。
//
// 约束：
// - 本模块不引用 daemon 其它模块，不读写文件，不启动定时器；时间通过 now() 注入，
//   因此 tests/unit/batch-quota.test.mjs 可以完全确定性地断言配额账本。
// - 所有对外返回都是普通 JSON 对象（无函数/Map），可以直接进 status 增量视图。
// - 配额只做"限流"，绝不替代 session.start 自己的错误语义：额度不足时返回结构化
//   denied 证据（code=E_QUEUE_FULL），由 batch 层决定把条目标记为 denied。

/** 配额报告结构版本（新增字段只加不改）。 */
export const SESSION_QUOTA_SCHEMA = 1;
export const SESSION_QUOTA_KIND = 'bridge/session-quota';

/**
 * 默认策略。数值刻意保守：
 * - maxSessions：daemon 同时存活的会话上限（默认 12，与常见单机浏览器窗口数匹配）；
 * - maxPerBatch：单个批次一次最多启动的会话数（默认 4）；
 * - maxConcurrentStarts：单批次内并行启动的并发度（默认 2）；
 * - maxPerInstance：单个浏览器实例的会话上限（默认 8，按 instanceId 统计 live）；
 * - maxBatchItems：一次 batch 请求允许的条目上限（默认 50，纯输入规模保护）；
 * - reservationTtlMs：预约多久没提交就自动回收（默认 120s，防止批次卡死占额）。
 */
export const SESSION_QUOTA_DEFAULTS = Object.freeze({
  maxSessions: 12,
  maxPerBatch: 4,
  maxConcurrentStarts: 2,
  maxPerInstance: 8,
  maxBatchItems: 50,
  reservationTtlMs: 120_000,
});

/**
 * 每个策略键的合法区间。超出区间不是"报错"而是**夹取并记录 clamped 证据**：
 * 配额是运维旋钮，环境变量写错不应该让 daemon 起不来。
 */
export const SESSION_QUOTA_BOUNDS = Object.freeze({
  maxSessions: Object.freeze({ min: 1, max: 200 }),
  maxPerBatch: Object.freeze({ min: 1, max: 100 }),
  maxConcurrentStarts: Object.freeze({ min: 1, max: 32 }),
  maxPerInstance: Object.freeze({ min: 1, max: 200 }),
  maxBatchItems: Object.freeze({ min: 1, max: 500 }),
  reservationTtlMs: Object.freeze({ min: 1_000, max: 3_600_000 }),
});

/** 策略键（顺序固定，CLI/JSON 输出稳定）。 */
export const SESSION_QUOTA_POLICY_KEYS = Object.freeze(Object.keys(SESSION_QUOTA_DEFAULTS));

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toCount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function clampInt(value, bounds, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { value: fallback, clamped: false };
  const rounded = Math.round(number);
  if (!Number.isInteger(rounded)) return { value: fallback, clamped: false };
  if (rounded < bounds.min) return { value: bounds.min, clamped: true, direction: 'min' };
  if (rounded > bounds.max) return { value: bounds.max, clamped: true, direction: 'max' };
  return { value: rounded, clamped: false };
}

/**
 * 归一化一份配额策略。
 * @param {object} input 原始策略（缺失键用 base 补）
 * @param {{base?: object}} [options]
 * @returns {{policy: object, clamped: Array<{key: string, from: any, to: number, direction: string}>}}
 */
export function normalizeSessionQuotaPolicy(input = {}, { base = SESSION_QUOTA_DEFAULTS } = {}) {
  const source = isObject(input) ? input : {};
  const fallback = isObject(base) ? base : SESSION_QUOTA_DEFAULTS;
  const policy = {};
  const clamped = [];
  for (const key of SESSION_QUOTA_POLICY_KEYS) {
    const bounds = SESSION_QUOTA_BOUNDS[key];
    const raw = source[key] === undefined ? fallback[key] : source[key];
    const baseValue = clampInt(fallback[key], bounds, SESSION_QUOTA_DEFAULTS[key]);
    const result = clampInt(raw, bounds, baseValue.value);
    policy[key] = result.value;
    if (result.clamped) {
      clamped.push({ key, from: raw, to: result.value, direction: result.direction || 'max' });
    }
  }
  return { policy: Object.freeze(policy), clamped };
}

/**
 * 只允许"收紧"的策略覆盖：批处理请求可以把自己的额度调小，但绝不能绕过
 * daemon 的全局上限（否则任意客户端都能通过 batch.start 把配额抬高）。
 * - 只接受 SESSION_QUOTA_POLICY_KEYS 里的键；
 * - 取值 = min(base[key], patch[key])；非数字/负数忽略并记入 ignored；
 * - reservationTtlMs 不参与收紧（它是内部回收参数，保持 daemon 侧值）。
 */
export function tightenSessionQuotaPolicy(base, patch = {}) {
  const normalizedBase = normalizeSessionQuotaPolicy(base).policy;
  const source = isObject(patch) ? patch : {};
  const policy = { ...normalizedBase };
  const ignored = [];
  for (const [key, raw] of Object.entries(source)) {
    if (!SESSION_QUOTA_POLICY_KEYS.includes(key)) {
      ignored.push({ key, reason: 'unknown-key' });
      continue;
    }
    if (key === 'reservationTtlMs') {
      ignored.push({ key, reason: 'daemon-owned' });
      continue;
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number <= 0) {
      ignored.push({ key, reason: 'not-positive-number' });
      continue;
    }
    const bounds = SESSION_QUOTA_BOUNDS[key];
    const bounded = clampInt(number, bounds, normalizedBase[key]).value;
    policy[key] = Math.min(normalizedBase[key], bounded);
  }
  return { policy: Object.freeze(policy), ignored };
}

function readEnvInt(env, name) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return { invalid: true, raw: text };
  return { value: Number(text), raw: text };
}

/**
 * 从环境变量构造策略。环境变量是"冷启动旋钮"，写错时忽略并记录证据（不抛错）。
 * @returns {{policy: object, source: object, ignored: Array<{key: string, reason: string, raw?: string}>}}
 */
export function quotaPolicyFromEnv(env = process.env) {
  const source = {};
  const ignored = [];
  const read = (envName, policyKey) => {
    const result = readEnvInt(env, envName);
    if (result === null) return;
    if (result.invalid) {
      ignored.push({ key: policyKey, env: envName, reason: 'not-integer', raw: result.raw });
      return;
    }
    source[policyKey] = result.value;
  };
  read('BB_SESSION_QUOTA', 'maxSessions');
  read('BB_BATCH_QUOTA', 'maxPerBatch');
  read('BB_BATCH_CONCURRENCY', 'maxConcurrentStarts');
  read('BB_INSTANCE_QUOTA', 'maxPerInstance');
  read('BB_BATCH_MAX_ITEMS', 'maxBatchItems');
  read('BB_BATCH_RESERVATION_TTL_MS', 'reservationTtlMs');
  const normalized = normalizeSessionQuotaPolicy(source);
  return {
    policy: normalized.policy,
    source: Object.freeze({
      ...(env && env.BB_SESSION_QUOTA !== undefined ? { BB_SESSION_QUOTA: String(env.BB_SESSION_QUOTA) } : {}),
      ...(env && env.BB_BATCH_QUOTA !== undefined ? { BB_BATCH_QUOTA: String(env.BB_BATCH_QUOTA) } : {}),
      ...(env && env.BB_BATCH_CONCURRENCY !== undefined ? { BB_BATCH_CONCURRENCY: String(env.BB_BATCH_CONCURRENCY) } : {}),
      ...(env && env.BB_INSTANCE_QUOTA !== undefined ? { BB_INSTANCE_QUOTA: String(env.BB_INSTANCE_QUOTA) } : {}),
    }),
    ignored: [...ignored, ...normalized.clamped.map((item) => ({ key: item.key, reason: 'clamped-' + item.direction, raw: String(item.from) }))],
  };
}

/**
 * 纯函数：一次**准入规划**。给一批请求（按优先级 + 先来先服务）分配额度。
 *
 * 规则：
 * 1) 请求按 priority 降序、createdAt 升序、batchId 升序排序（确定性）；
 * 2) 每个请求最多拿 min(requested, maxPerBatch, 当前可用)；
 * 3) 可用额度 = max(0, maxSessions - live - reserved)；
 * 4) 拿不满的请求带 deniedCount 与 waiting 证据（不是错误，由调用方决定降级方式）。
 *
 * @param {{policy?: object, live?: number, reserved?: number, requests?: object[]}} input
 */
export function planQuotaAdmission({
  policy = SESSION_QUOTA_DEFAULTS,
  live = 0,
  reserved = 0,
  requests = [],
} = {}) {
  const normalized = normalizeSessionQuotaPolicy(policy).policy;
  const liveCount = toCount(live);
  const reservedCount = toCount(reserved);
  const available0 = Math.max(0, normalized.maxSessions - liveCount - reservedCount);
  let available = available0;
  const ordered = (Array.isArray(requests) ? requests : [])
    .map((request, index) => ({
      batchId: String((request && request.batchId) || ('anonymous-' + index)),
      requested: Math.max(0, toCount(request && request.requested)),
      priority: Number.isFinite(Number(request && request.priority)) ? Number(request.priority) : 0,
      createdAt: Number(request && request.createdAt) || 0,
      index,
    }))
    .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt) || (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0));
  const decisions = [];
  let totalGranted = 0;
  let totalDenied = 0;
  for (const request of ordered) {
    const grantable = Math.min(request.requested, normalized.maxPerBatch, available);
    const granted = Math.max(0, grantable);
    const deniedCount = Math.max(0, request.requested - granted);
    available -= granted;
    totalGranted += granted;
    totalDenied += deniedCount;
    decisions.push({
      batchId: request.batchId,
      index: request.index,
      priority: request.priority,
      requested: request.requested,
      granted,
      deniedCount,
      waiting: deniedCount > 0,
      reason: deniedCount === 0
        ? (request.requested === 0 ? 'empty' : 'granted')
        : (granted === 0 ? 'quota-exhausted' : 'quota-partial'),
      remainingAvailable: available,
    });
  }
  return {
    policy: normalized,
    live: liveCount,
    reserved: reservedCount,
    availableBefore: available0,
    availableAfter: available,
    decisions,
    totals: {
      requests: decisions.length,
      requested: decisions.reduce((sum, item) => sum + item.requested, 0),
      granted: totalGranted,
      denied: totalDenied,
      fullyGranted: decisions.filter((item) => item.requested > 0 && item.deniedCount === 0).length,
      partiallyGranted: decisions.filter((item) => item.granted > 0 && item.deniedCount > 0).length,
      rejected: decisions.filter((item) => item.requested > 0 && item.granted === 0).length,
    },
  };
}

/**
 * 构造运行期配额分配器。
 * @param {{policy?: object, liveSessions?: () => number, liveInstances?: () => (Map|object|null),
 *          now?: () => number, log?: Function}} options
 */
export function createSessionQuota({ policy: policyInput = SESSION_QUOTA_DEFAULTS, liveSessions = () => 0, liveInstances = null, now = () => Date.now(), log = () => {} } = {}) {
  const normalized = normalizeSessionQuotaPolicy(policyInput);
  // 策略允许 tighten 热更新，因此持有可变副本（normalize 返回的是 frozen 对象）。
  const activePolicy = { ...normalized.policy };
  const liveFn = typeof liveSessions === 'function' ? liveSessions : () => 0;
  const liveInstancesFn = typeof liveInstances === 'function' ? liveInstances : null;
  const clock = typeof now === 'function' ? now : () => Date.now();
  const logger = typeof log === 'function' ? log : () => {};
  /** batchId -> 预约记录（内部含状态；对外 snapshot 时会脱敏成普通对象）。 */
  const reservations = new Map();
  const counters = {
    reserveCalls: 0,
    deniedReservations: 0,
    partialReservations: 0,
    commits: 0,
    releases: 0,
    expiredReservations: 0,
    finalized: 0,
  };
  let seq = 0;
  let lastPolicyClamped = normalized.clamped;

  function live() {
    try {
      return Math.max(0, toCount(liveFn()));
    } catch {
      return 0;
    }
  }

  /** 单实例用量：liveInstances() 返回 Map<instanceId, count> 或数组时都支持。 */
  function instanceUsage() {
    const list = [];
    if (!liveInstancesFn) return list;
    let raw;
    try { raw = liveInstancesFn(); } catch { return list; }
    const iterable = raw instanceof Map
      ? [...raw.entries()]
      : (Array.isArray(raw) ? raw.map((item) => [item && item.instanceId, item && (item.count ?? (Array.isArray(item.sessions) ? item.sessions.length : item.sessions))]) : []);
    for (const [instanceId, count] of iterable) {
      const id = instanceId === undefined || instanceId === null ? '' : String(instanceId);
      if (!id) continue;
      list.push({ instanceId: id, live: toCount(count) });
    }
    list.sort((a, b) => (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
    return list;
  }

  function outstanding() {
    let total = 0;
    for (const reservation of reservations.values()) {
      if (reservation.state === 'reserved') total += reservation.granted;
    }
    return total;
  }

  function available() {
    return Math.max(0, activePolicy.maxSessions - live() - outstanding());
  }

  function usage() {
    const liveCount = live();
    const reservedCount = outstanding();
    const used = liveCount + reservedCount;
    return {
      policy: { ...activePolicy },
      live: liveCount,
      reserved: reservedCount,
      used,
      available: Math.max(0, activePolicy.maxSessions - used),
      usagePercent: activePolicy.maxSessions > 0 ? Math.round((used / activePolicy.maxSessions) * 1000) / 10 : 0,
      instances: instanceUsage(),
      maxPerInstance: activePolicy.maxPerInstance,
      saturated: used >= activePolicy.maxSessions,
    };
  }

  function publicReservation(reservation) {
    if (!reservation) return null;
    return {
      batchId: reservation.batchId,
      state: reservation.state,
      seq: reservation.seq,
      priority: reservation.priority,
      requested: reservation.requested,
      granted: reservation.granted,
      used: reservation.used,
      released: reservation.released,
      waiting: Math.max(0, reservation.requested - reservation.used - reservation.granted),
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
      expiresAt: reservation.expiresAt,
      finalizedAt: reservation.finalizedAt,
      meta: reservation.meta ? { ...reservation.meta } : null,
    };
  }

  /**
   * 预约额度（幂等：同一 batchId 重复调用返回同一预约，不重复扣减）。
   * @returns {{ok: boolean, batchId: string, requested: number, granted: number, denied: boolean,
   *            partial: boolean, available: number, position: number, reused: boolean, reservation: object}}
   */
  function reserve(batchId, requested, { priority = 0, meta = null } = {}) {
    const id = String(batchId === undefined || batchId === null ? '' : batchId).trim();
    if (!id) return { ok: false, code: 'E_BAD_ARG', message: 'reserve 需要非空 batchId' };
    const wanted = Math.max(0, toCount(requested));
    const existing = reservations.get(id);
    if (existing && existing.state === 'reserved') {
      return {
        ok: true,
        batchId: id,
        requested: existing.requested,
        granted: existing.granted,
        denied: Math.max(0, existing.requested - existing.granted) > 0,
        partial: existing.granted > 0 && existing.requested > existing.granted,
        available: available(),
        position: reservations.size,
        reused: true,
        reservation: publicReservation(existing),
      };
    }
    const free = available();
    const granted = Math.max(0, Math.min(wanted, activePolicy.maxPerBatch, free));
    const at = clock();
    const record = {
      batchId: id,
      state: 'reserved',
      seq: seq += 1,
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
      requested: wanted,
      granted,
      used: 0,
      released: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at + activePolicy.reservationTtlMs,
      finalizedAt: 0,
      meta: isObject(meta) ? { ...meta } : null,
    };
    reservations.set(id, record);
    counters.reserveCalls += 1;
    if (granted === 0 && wanted > 0) counters.deniedReservations += 1;
    else if (granted < wanted) counters.partialReservations += 1;
    if (granted < wanted) logger('会话配额：批次 ' + id + ' 申请 ' + wanted + ' 只获得 ' + granted + '（可用 ' + free + '）');
    return {
      ok: true,
      batchId: id,
      requested: wanted,
      granted,
      denied: granted === 0 && wanted > 0,
      partial: granted > 0 && granted < wanted,
      available: available(),
      position: record.seq,
      reused: false,
      reservation: publicReservation(record),
    };
  }

  /** 每成功启动一个会话提交一个名额：预约额度 -1、used +1（total 不变）。 */
  function commit(batchId, count = 1) {
    const reservation = reservations.get(String(batchId || ''));
    if (!reservation || reservation.state !== 'reserved') {
      return { ok: false, code: 'E_INTERNAL', batchId: String(batchId || '') };
    }
    const amount = Math.max(0, Math.min(toCount(count, 1) || 1, reservation.granted));
    reservation.granted -= amount;
    reservation.used += amount;
    reservation.updatedAt = clock();
    counters.commits += amount;
    return { ok: true, batchId: reservation.batchId, committed: amount, granted: reservation.granted, used: reservation.used };
  }

  /** 释放未使用的预约额度（失败/取消/降级）。 */
  function release(batchId, count = null) {
    const reservation = reservations.get(String(batchId || ''));
    if (!reservation || reservation.state !== 'reserved') {
      return { ok: false, code: 'E_INTERNAL', batchId: String(batchId || '') };
    }
    const amount = count === null || count === undefined
      ? reservation.granted
      : Math.max(0, Math.min(toCount(count), reservation.granted));
    reservation.granted -= amount;
    reservation.released += amount;
    reservation.updatedAt = clock();
    counters.releases += amount;
    return { ok: true, batchId: reservation.batchId, released: amount, granted: reservation.granted, used: reservation.used };
  }

  /** 批次收尾：释放残余预约，保留 used 统计，状态置 finalState。 */
  function finalize(batchId, { state = 'completed' } = {}) {
    const reservation = reservations.get(String(batchId || ''));
    if (!reservation) return { ok: false, code: 'E_INTERNAL', batchId: String(batchId || '') };
    if (reservation.state !== 'reserved') {
      return { ok: true, batchId: reservation.batchId, state: reservation.state, released: 0, alreadyFinalized: true };
    }
    const released = reservation.granted;
    reservation.granted = 0;
    reservation.released += released;
    reservation.state = String(state || 'completed');
    reservation.updatedAt = clock();
    reservation.finalizedAt = reservation.updatedAt;
    counters.finalized += 1;
    return { ok: true, batchId: reservation.batchId, state: reservation.state, released, used: reservation.used };
  }

  /** 回收"超时未收尾"的预约（批次卡死/客户端断连遗留），返回被回收的批次。 */
  function expireReservations({ now: atOverride = null } = {}) {
    const at = atOverride === null || atOverride === undefined ? clock() : Number(atOverride) || clock();
    const expired = [];
    for (const reservation of reservations.values()) {
      if (reservation.state !== 'reserved') continue;
      if (reservation.expiresAt > 0 && at >= reservation.expiresAt) {
        const released = reservation.granted;
        reservation.granted = 0;
        reservation.released += released;
        reservation.state = 'expired';
        reservation.updatedAt = at;
        reservation.finalizedAt = at;
        counters.expiredReservations += 1;
        expired.push({ batchId: reservation.batchId, released, used: reservation.used, at });
        logger('会话配额：批次 ' + reservation.batchId + ' 预约超时回收 ' + released + ' 个名额');
      }
    }
    return { at, expired };
  }

  function get(batchId) {
    return publicReservation(reservations.get(String(batchId || '')) || null);
  }

  /**
   * 完整快照（status 增量视图 / batch.status / CLI quota 共用）。
   * 只包含仍需要对外可见的预约（默认全部；limit 截断按 updatedAt 倒序）。
   */
  function snapshot({ limit = 50, includeFinalized = true } = {}) {
    const nowMs = clock();
    const all = [...reservations.values()]
      .filter((reservation) => includeFinalized || reservation.state === 'reserved')
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.seq - a.seq));
    const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
    const batches = all.slice(0, max).map(publicReservation);
    const totals = {
      reservations: all.length,
      activeReservations: all.filter((item) => item.state === 'reserved').length,
      granted: all.reduce((sum, item) => sum + item.granted, 0),
      used: all.reduce((sum, item) => sum + item.used, 0),
      released: all.reduce((sum, item) => sum + item.released, 0),
      requested: all.reduce((sum, item) => sum + item.requested, 0),
    };
    return {
      schema: SESSION_QUOTA_SCHEMA,
      kind: SESSION_QUOTA_KIND,
      at: nowMs,
      generatedAt: new Date(nowMs).toISOString(),
      policy: { ...activePolicy },
      policyClamped: lastPolicyClamped.map((item) => ({ ...item })),
      ...usage(),
      batches,
      truncated: all.length > batches.length,
      totals,
      counters: { ...counters },
    };
  }

  /** 策略热更新（只允许收紧；返回生效前后差异，不做"提升上限"）。 */
  function tighten(patch) {
    const result = tightenSessionQuotaPolicy(activePolicy, patch);
    const before = { ...activePolicy };
    for (const key of SESSION_QUOTA_POLICY_KEYS) activePolicy[key] = result.policy[key];
    lastPolicyClamped = [];
    if (log && Object.keys(patch || {}).length) logger('会话配额策略覆盖：' + JSON.stringify(result.ignored));
    return { before, after: { ...activePolicy }, ignored: result.ignored };
  }

  /** 测试/daemon 停止用：清空预约与计数器，不改变策略。 */
  function reset() {
    reservations.clear();
    for (const key of Object.keys(counters)) counters[key] = 0;
    seq = 0;
    lastPolicyClamped = [];
    return { policy: { ...activePolicy } };
  }

  return {
    get policy() { return { ...activePolicy }; },
    live,
    outstanding,
    available,
    usage,
    reserve,
    commit,
    release,
    finalize,
    expireReservations,
    get,
    snapshot,
    tighten,
    planAdmission: (requests) => planQuotaAdmission({ policy: activePolicy, live: live(), reserved: outstanding(), requests }),
    reset,
  };
}

/** 人类可读的一行摘要（CLI quota 表头 / 日志共用，纯函数）。 */
export function describeQuotaUsage(usage = {}) {
  const policy = usage.policy || {};
  const live = toCount(usage.live);
  const reserved = toCount(usage.reserved);
  const available = toCount(usage.available);
  return {
    text: '会话配额：存活 ' + live + '/' + (policy.maxSessions ?? '?')
      + '，预约 ' + reserved + '，可用 ' + available
      + '（单批 ' + (policy.maxPerBatch ?? '?') + '，并发启动 ' + (policy.maxConcurrentStarts ?? '?') + '）',
    live,
    reserved,
    available,
    saturated: usage.saturated === true || (available <= 0 && reserved === 0),
  };
}
