// daemon/batch-sessions.js —— 批处理会话编排（配额准入 → 并发启动 → 失败策略 → 收尾报告）。
//
// 为什么需要批处理层：
// - 单条 `session.start` 是"一次一个"的交互式入口；Agent 做矩阵抓取/多标签页任务时
//   往往一次要开 3~10 个会话，逐条调用既没有全局上限，也没有统一的失败/回滚语义；
// - 本模块把"一次请求 = 一个批次（batch）"建模成显式状态机，所有副作用都通过注入的
//   startSession / stopSession / navigate 完成，因此：
//     * 单测可以用假实现精确覆盖并发、重试、abort/rollback、取消；
//     * daemon 里注入真实的 session.start/session.stop 与 dispatch('navigate')，
//       不改变任何既有方法的语义。
//
// 与 session-quota 的分工：
// - session-quota 只算"能开几个"（全局 + 单批 + 并发），本模块负责"先开哪个、失败怎么办"；
// - 准入流程：normalize spec → quota.reserve → 按优先级分配条目 → 并发启动 →
//   每个成功启动 commit 一个名额，失败/取消 release，收尾 finalize（释放残余额度）。
//
// 状态机（BATCH_ITEM_STATES）：
//   pending → starting → succeeded
//                      ↘ failed（重试耗尽；若已创建会话会先 stop 清理）
//   pending → denied（配额不足，未尝试启动）
//   pending → cancelled（batch.cancel 或批次取消）
//   pending → skipped（abort/rollback 策略下未再调度）
//   succeeded → rolled-back（onError=rollback 时被回收）
//
// 批次状态（BATCH_STATES）：planning → running → completed|aborted|cancelled|rolled-back。
// 所有时间通过 now() 注入；重试退避通过 sleep() 注入，单测可以零等待。

import {
  normalizeSessionQuotaPolicy,
  planQuotaAdmission,
  tightenSessionQuotaPolicy,
} from './session-quota.js';

/** 批处理报告结构版本（新增字段只加不改）。 */
export const BATCH_SCHEMA = 1;
export const BATCH_KIND = 'bridge/session-batch';
export const BATCH_PLAN_KIND = 'bridge/session-batch-plan';

/** 失败策略：继续 / 中止后续调度 / 中止并回收本批已建会话。 */
export const BATCH_ON_ERROR = Object.freeze(['continue', 'abort', 'rollback']);

/** 条目状态机取值。 */
export const BATCH_ITEM_STATES = Object.freeze([
  'pending', 'starting', 'succeeded', 'failed', 'denied', 'cancelled', 'skipped', 'rolled-back',
]);

/** 批次状态机取值。 */
export const BATCH_STATES = Object.freeze(['planning', 'running', 'completed', 'aborted', 'cancelled', 'rolled-back']);

/** 批次结论（CLI 退出码映射用）。 */
export const BATCH_OUTCOMES = Object.freeze(['ok', 'partial', 'failed', 'quota-denied', 'cancelled', 'rolled-back']);

/**
 * 可重试错误码：这些是"瞬时/可恢复"的启动失败，重试有意义。
 * 参数错误（E_BAD_ARG）与权限错误（E_FORBIDDEN）永远不重试。
 */
export const BATCH_RETRYABLE_CODES = Object.freeze([
  'E_TIMEOUT', 'E_DAEMON', 'E_NO_BROWSER', 'E_INTERNAL', 'E_START_PENDING', 'E_TAB_LEASE_HELD',
]);

/** 默认值（可由 daemon 侧策略覆盖，但请求不可越过 session-quota 的上限）。 */
export const BATCH_DEFAULTS = Object.freeze({
  maxItems: 50,
  concurrency: 1,
  onError: 'continue',
  retries: 0,
  maxRetries: 3,
  itemTimeoutMs: 60_000,
  minItemTimeoutMs: 1_000,
  maxItemTimeoutMs: 300_000,
  backoffMs: 20,
  maxBackoffMs: 1_000,
  retention: 100,
  batchIdPattern: /^[A-Za-z0-9_.:-]{1,80}$/,
});

/** 参数/规格错误（daemon 侧会被映射成 E_BAD_ARG 的等价语义）。 */
export class BatchSpecError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = 'BatchSpecError';
    this.code = code || 'E_BAD_ARG';
    if (data !== null && data !== undefined) this.data = data;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function toInt(value, fallback, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  if (min !== null && number < min) return null;
  if (max !== null && number > max) return null;
  return number;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

/** 深拷贝成纯 JSON（批次记录里只有 JSON 值，避免调用方改到内部状态）。 */
function toPlain(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toPlain);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = toPlain(item);
  }
  return out;
}

function normalizeUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 2048) throw new BatchSpecError('E_BAD_ARG', 'batch 条目的 url 过长（>2048）');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new BatchSpecError('E_BAD_ARG', 'batch 条目的 url 含控制字符');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) throw new BatchSpecError('E_BAD_ARG', 'batch 条目的 url 需要带 scheme（http/https/about）');
  return text;
}

/**
 * 归一化单个批处理条目。未知字段忽略（向前兼容），非法字段抛 BatchSpecError。
 * @param {object} raw
 * @param {number} index
 */
export function normalizeBatchItem(raw, index = 0) {
  if (!isObject(raw)) throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] 必须是对象');
  const url = normalizeUrl(raw.url);
  const share = raw.share === true;
  const tab = share || raw.tab !== undefined ? toInt(raw.tab, null, { min: 0, max: Number.MAX_SAFE_INTEGER }) : null;
  if (share && (tab === null || tab === undefined)) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] share=true 需要整数 tab');
  }
  if (share && url) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] share=true 不能同时指定 url（共享 tab 会沿用原页面）');
  }
  const browser = raw.browser === undefined || raw.browser === null || raw.browser === '' ? null : String(raw.browser).slice(0, 40);
  const label = raw.label === undefined || raw.label === null ? null : String(raw.label).slice(0, 80);
  const key = raw.key === undefined || raw.key === null ? null : String(raw.key).trim();
  if (key !== null && !BATCH_DEFAULTS.batchIdPattern.test(key)) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] key 只能包含字母数字与 _.:-，长度 1-80');
  }
  const priority = raw.priority === undefined ? 0 : toInt(raw.priority, 0, { min: -10, max: 10 });
  if (priority === null) throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] priority 需要 -10..10 的整数');
  const retries = raw.retries === undefined ? null : toInt(raw.retries, null, { min: 0, max: BATCH_DEFAULTS.maxRetries });
  if (raw.retries !== undefined && retries === null) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] retries 需要 0..' + BATCH_DEFAULTS.maxRetries + ' 的整数');
  }
  const timeoutMs = raw.timeoutMs === undefined ? null : toInt(raw.timeoutMs, null, {
    min: BATCH_DEFAULTS.minItemTimeoutMs, max: BATCH_DEFAULTS.maxItemTimeoutMs,
  });
  if (raw.timeoutMs !== undefined && timeoutMs === null) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items[' + index + '] timeoutMs 需要 ' + BATCH_DEFAULTS.minItemTimeoutMs + '..' + BATCH_DEFAULTS.maxItemTimeoutMs + ' 的整数');
  }
  const group = raw.group === undefined || raw.group === null ? null : String(raw.group).slice(0, 64);
  return {
    index,
    key,
    url,
    browser,
    label,
    share,
    tab: tab === null ? null : tab,
    priority,
    retries,
    timeoutMs,
    group,
  };
}

/**
 * 归一化整批请求。这里只做"结构与策略"校验，不查配额、不启动任何东西。
 * @param {object} params RPC 参数
 * @param {{policy?: object}} [options]
 */
export function normalizeBatchSpec(params = {}, { policy = null } = {}) {
  if (!isObject(params)) throw new BatchSpecError('E_BAD_ARG', 'batch 参数必须是对象');
  const quotaPolicy = normalizeSessionQuotaPolicy(policy || {}).policy;
  const rawItems = params.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items 需要至少 1 个条目');
  }
  if (rawItems.length > quotaPolicy.maxBatchItems) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.items 最多 ' + quotaPolicy.maxBatchItems + ' 个（收到 ' + rawItems.length + '）');
  }
  const items = rawItems.map((raw, index) => normalizeBatchItem(raw, index));
  const seenKeys = new Set();
  for (const item of items) {
    if (!item.key) continue;
    if (seenKeys.has(item.key)) throw new BatchSpecError('E_BAD_ARG', 'batch.items 的 key 重复：' + item.key);
    seenKeys.add(item.key);
  }
  const onError = params.onError === undefined ? BATCH_DEFAULTS.onError : String(params.onError).trim().toLowerCase();
  if (!BATCH_ON_ERROR.includes(onError)) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.onError 需要 ' + BATCH_ON_ERROR.join('|'), { allowed: BATCH_ON_ERROR });
  }
  const concurrencyRaw = params.concurrency === undefined ? quotaPolicy.maxConcurrentStarts : toInt(params.concurrency, null, { min: 1, max: 32 });
  if (concurrencyRaw === null) throw new BatchSpecError('E_BAD_ARG', 'batch.concurrency 需要 1..32 的整数');
  const concurrency = Math.min(concurrencyRaw, quotaPolicy.maxConcurrentStarts);
  const retriesRaw = params.retries === undefined ? BATCH_DEFAULTS.retries : toInt(params.retries, null, { min: 0, max: BATCH_DEFAULTS.maxRetries });
  if (retriesRaw === null) throw new BatchSpecError('E_BAD_ARG', 'batch.retries 需要 0..' + BATCH_DEFAULTS.maxRetries + ' 的整数');
  const timeoutRaw = params.timeoutMs === undefined ? BATCH_DEFAULTS.itemTimeoutMs : toInt(params.timeoutMs, null, {
    min: BATCH_DEFAULTS.minItemTimeoutMs, max: BATCH_DEFAULTS.maxItemTimeoutMs,
  });
  if (timeoutRaw === null) throw new BatchSpecError('E_BAD_ARG', 'batch.timeoutMs 需要 ' + BATCH_DEFAULTS.minItemTimeoutMs + '..' + BATCH_DEFAULTS.maxItemTimeoutMs + ' 的整数');
  const maxRaw = params.max === undefined ? null : toInt(params.max, null, { min: 1, max: quotaPolicy.maxPerBatch });
  if (params.max !== undefined && maxRaw === null) {
    throw new BatchSpecError('E_BAD_ARG', 'batch.max 需要 1..' + quotaPolicy.maxPerBatch + ' 的整数');
  }
  const priorityRaw = params.priority === undefined ? 0 : toInt(params.priority, 0, { min: -10, max: 10 });
  if (priorityRaw === null) throw new BatchSpecError('E_BAD_ARG', 'batch.priority 需要 -10..10 的整数');
  let batchId = null;
  if (params.batchId !== undefined && params.batchId !== null && params.batchId !== '') {
    batchId = String(params.batchId).trim();
    if (!BATCH_DEFAULTS.batchIdPattern.test(batchId)) {
      throw new BatchSpecError('E_BAD_ARG', 'batch.batchId 只能包含字母数字与 _.:-，长度 1-80');
    }
  }
  // 请求级 quota 只允许收紧：maxPerBatch / concurrency 的小值；其它键忽略（daemon 侧策略优先）。
  let quotaPatch = null;
  if (params.quota !== undefined) {
    if (!isObject(params.quota)) throw new BatchSpecError('E_BAD_ARG', 'batch.quota 必须是对象');
    const tightened = tightenSessionQuotaPolicy(quotaPolicy, params.quota);
    quotaPatch = {
      policy: tightened.policy,
      ignored: tightened.ignored,
    };
  }
  const group = params.group === undefined || params.group === null ? null : String(params.group).slice(0, 64);
  return {
    items,
    onError,
    concurrency,
    retries: retriesRaw,
    timeoutMs: timeoutRaw,
    max: maxRaw,
    priority: priorityRaw,
    batchId,
    group,
    dryRun: params.dryRun === true,
    quotaPatch,
    basePolicy: quotaPolicy,
  };
}

/** 是否可重试：只在已知瞬时错误码上重试（未知码按不可重试处理，避免放大副作用）。 */
export function isRetryableBatchError(code) {
  const text = toText(code).toUpperCase();
  return BATCH_RETRYABLE_CODES.includes(text);
}

/**
 * 由批次状态/汇总推导结论。纯函数，CLI 与测试都按它判定退出码。
 * @param {{state?: string, summary?: object}} record
 */
export function classifyBatchOutcome(record = {}) {
  const state = toText(record.state);
  const summary = isObject(record.summary) ? record.summary : {};
  const total = Number(summary.total) || 0;
  const denied = Number(summary.denied) || 0;
  const succeeded = Number(summary.succeeded) || 0;
  const failed = Number(summary.failed) || 0;
  if (state === 'cancelled' || (Number(summary.cancelled) || 0) > 0 && succeeded === 0 && failed === 0) return 'cancelled';
  if (state === 'rolled-back') return 'rolled-back';
  if (total > 0 && denied >= total) return 'quota-denied';
  if (failed > 0) return succeeded > 0 ? 'partial' : 'failed';
  // 部分条目被配额拒绝（其余成功）：同样是"部分完成"，调用方需读 items 才能知道缺口。
  if (denied > 0 && succeeded > 0) return 'partial';
  if (succeeded > 0) return 'ok';
  return total === 0 ? 'ok' : 'failed';
}

/**
 * 构造批处理服务。
 *
 * @param {{
 *   quota: object,                                  // createSessionQuota() 实例（必填）
 *   startSession: (params: object, timeoutMs: number) => Promise<object>,
 *   stopSession: (params: object, timeoutMs: number) => Promise<object>,
 *   navigate?: ((sessionId: string, url: string, timeoutMs: number) => Promise<object>) | null,
 *   now?: () => number,
 *   log?: Function,
 *   BridgeError?: Function,
 *   sleep?: (ms: number) => Promise<void>,
 *   idFactory?: (() => string) | null,
 *   retention?: number,
 * }} options
 */
export function createBatchSessions({
  quota,
  startSession,
  stopSession,
  navigate = null,
  now = () => Date.now(),
  log = () => {},
  BridgeError = BatchSpecError,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  idFactory = null,
  retention = BATCH_DEFAULTS.retention,
} = {}) {
  if (!quota || typeof quota.reserve !== 'function') throw new TypeError('createBatchSessions 需要 quota（createSessionQuota 实例）');
  if (typeof startSession !== 'function') throw new TypeError('createBatchSessions 需要 startSession');
  if (typeof stopSession !== 'function') throw new TypeError('createBatchSessions 需要 stopSession');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const logger = typeof log === 'function' ? log : () => {};
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const errorOf = (code, message, data) => new BridgeError(code, message, data);
  const batches = new Map();
  const maxRetained = Math.max(1, Math.min(1000, Number(retention) || BATCH_DEFAULTS.retention));
  let seq = 0;
  const counters = {
    started: 0,
    completed: 0,
    aborted: 0,
    cancelled: 0,
    rolledBack: 0,
    itemsStarted: 0,
    itemsSucceeded: 0,
    itemsFailed: 0,
    retries: 0,
    quotaDenied: 0,
  };

  function newBatchId() {
    if (typeof idFactory === 'function') {
      const custom = String(idFactory() || '').trim();
      if (custom) return custom;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      seq += 1;
      const id = 'b' + seq.toString(36) + '-' + (Number(clock()) || 0).toString(36).slice(-6);
      if (!batches.has(id)) return id;
    }
    return 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function createRecord(spec, batchId) {
    const at = clock();
    return {
      schema: BATCH_SCHEMA,
      kind: BATCH_KIND,
      batchId,
      state: 'planning',
      outcome: null,
      createdAt: at,
      startedAt: 0,
      finishedAt: 0,
      durationMs: 0,
      group: spec.group,
      onError: spec.onError,
      concurrency: spec.concurrency,
      retries: spec.retries,
      timeoutMs: spec.timeoutMs,
      max: spec.max,
      priority: spec.priority,
      policy: { ...quota.policy },
      quota: {
        requested: 0,
        granted: 0,
        committed: 0,
        released: 0,
        denied: 0,
        reused: false,
      },
      summary: {
        total: spec.items.length,
        admitted: 0,
        denied: 0,
        attempted: 0,
        pending: spec.items.length,
        starting: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        rolledBack: 0,
        retried: 0,
        sessionsCreated: 0,
        navigated: 0,
      },
      items: spec.items.map((item) => ({
        index: item.index,
        key: item.key,
        url: item.url,
        browser: item.browser,
        label: item.label,
        share: item.share,
        tab: item.tab,
        priority: item.priority,
        group: item.group,
        retries: item.retries,
        timeoutMs: item.timeoutMs,
        state: 'pending',
        admission: 'unknown',
        attempts: 0,
        sessionId: null,
        navigated: false,
        cleanup: null,
        startedAt: 0,
        finishedAt: 0,
        durationMs: 0,
        error: null,
      })),
      cancelled: false,
      cancelledAt: 0,
      abortReason: null,
      rollback: null,
      warnings: [],
      meta: spec.batchId ? { requestedBatchId: spec.batchId } : null,
    };
  }

  function recomputeSummary(record) {
    const items = record.items;
    const summary = record.summary;
    summary.pending = 0;
    summary.starting = 0;
    summary.succeeded = 0;
    summary.failed = 0;
    summary.cancelled = 0;
    summary.skipped = 0;
    summary.rolledBack = 0;
    summary.attempted = 0;
    for (const item of items) {
      if (item.state === 'pending') summary.pending += 1;
      else if (item.state === 'starting') summary.starting += 1;
      else if (item.state === 'succeeded') summary.succeeded += 1;
      else if (item.state === 'failed') summary.failed += 1;
      else if (item.state === 'cancelled') summary.cancelled += 1;
      else if (item.state === 'skipped') summary.skipped += 1;
      else if (item.state === 'rolled-back') summary.rolledBack += 1;
      if (item.attempts > 0) summary.attempted += 1;
    }
    summary.denied = items.filter((item) => item.state === 'denied').length;
    summary.retried = items.reduce((sum, item) => sum + Math.max(0, item.attempts - 1), 0);
    summary.sessionsCreated = items.filter((item) => Boolean(item.sessionId)).length;
    summary.navigated = items.filter((item) => item.navigated === true).length;
    summary.admitted = items.filter((item) => item.admission === 'admitted').length;
    return summary;
  }

  function trimRetention() {
    if (batches.size <= maxRetained) return [];
    const finalized = [...batches.values()]
      .filter((record) => record.state !== 'running' && record.state !== 'planning')
      .sort((a, b) => (a.finishedAt || a.createdAt) - (b.finishedAt || b.createdAt));
    const removed = [];
    while (batches.size > maxRetained && finalized.length) {
      const record = finalized.shift();
      batches.delete(record.batchId);
      removed.push(record.batchId);
    }
    // 运行中的批次不删；只有全都在跑时才允许保留超限（容量很小，且最终会收尾）。
    return removed;
  }

  function view(record, extra = {}) {
    const recordView = toPlain({
      schema: record.schema,
      kind: record.kind,
      batchId: record.batchId,
      state: record.state,
      outcome: classifyBatchOutcome(record),
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      group: record.group,
      onError: record.onError,
      concurrency: record.concurrency,
      retries: record.retries,
      timeoutMs: record.timeoutMs,
      max: record.max,
      priority: record.priority,
      policy: record.policy,
      quota: record.quota,
      summary: record.summary,
      items: record.items,
      cancelled: record.cancelled,
      cancelledAt: record.cancelledAt,
      abortReason: record.abortReason,
      rollback: record.rollback,
      warnings: record.warnings,
      meta: record.meta,
    });
    return { ...recordView, ...extra };
  }

  /** 紧凑视图（status 增量视图用：不带完整 items，避免一次 status 太大）。 */
  function summaryView(record) {
    return toPlain({
      batchId: record.batchId,
      state: record.state,
      outcome: classifyBatchOutcome(record),
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      group: record.group,
      onError: record.onError,
      concurrency: record.concurrency,
      quota: record.quota,
      summary: record.summary,
      rollback: record.rollback ? { attempted: record.rollback.attempted, stopped: record.rollback.stopped, failed: record.rollback.failed } : null,
    });
  }

  /**
   * 批次准入计划（dry-run）：完全不改配额、不启动会话。
   * 返回每个条目的 admit/deny 与额度证据，供 CLI `daemon batch plan` 或 `--dry-run`。
   */
  function plan(params = {}) {
    const spec = normalizeBatchSpec(params, { policy: quota.policy });
    const desired = spec.max === null ? spec.items.length : Math.min(spec.items.length, spec.max);
    const admission = planQuotaAdmission({
      policy: quota.policy,
      live: quota.live(),
      reserved: quota.outstanding(),
      requests: [{
        batchId: spec.batchId || '(dry-run)',
        requested: desired,
        priority: spec.priority,
        createdAt: clock(),
      }],
    });
    const decision = admission.decisions[0] || { granted: 0, deniedCount: desired };
    const ordered = spec.items.slice().sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
    const admittedIndexes = new Set(ordered.slice(0, decision.granted).map((item) => item.index));
    const items = spec.items.map((item) => ({
      index: item.index,
      key: item.key,
      url: item.url,
      browser: item.browser,
      label: item.label,
      share: item.share,
      tab: item.tab,
      priority: item.priority,
      admission: admittedIndexes.has(item.index) ? 'admit' : 'deny',
      reason: admittedIndexes.has(item.index) ? 'quota-granted' : (decision.granted === 0 ? 'quota-exhausted' : 'quota-overflow'),
    }));
    const warnings = [];
    if (spec.quotaPatch && spec.quotaPatch.ignored.length) {
      warnings.push('请求级 quota 有 ' + spec.quotaPatch.ignored.length + ' 项被忽略（只能收紧且不包含 reservationTtlMs）');
    }
    if (decision.deniedCount > 0) {
      warnings.push('配额只允许 ' + decision.granted + '/' + desired + ' 个条目启动，其余会被标记 denied（E_QUEUE_FULL）');
    }
    if (spec.items.some((item) => item.share)) {
      warnings.push('share=true 的条目会尝试复用已有 tab，若该 tab 无会话会失败（E_NO_SESSION）');
    }
    return {
      schema: BATCH_SCHEMA,
      kind: BATCH_PLAN_KIND,
      dryRun: true,
      plannedAt: clock(),
      policy: admission.policy,
      quota: admission,
      spec: {
        items: spec.items.length,
        desired,
        onError: spec.onError,
        concurrency: spec.concurrency,
        retries: spec.retries,
        timeoutMs: spec.timeoutMs,
        max: spec.max,
        priority: spec.priority,
        batchId: spec.batchId,
        group: spec.group,
      },
      items,
      summary: {
        total: spec.items.length,
        admissable: admittedIndexes.size,
        denied: spec.items.length - admittedIndexes.size,
        estimatedStarts: admittedIndexes.size,
        concurrency: spec.concurrency,
        maxParallelObserved: Math.min(spec.concurrency, admittedIndexes.size),
        policyMaxSessions: admission.policy.maxSessions,
        liveSessions: admission.live,
        reserved: admission.reserved,
      },
      warnings,
    };
  }

  function buildStartParams(item) {
    const params = {};
    if (item.url) params.url = item.url;
    if (item.browser) params.browser = item.browser;
    if (item.share) params.share = true;
    if (item.tab !== null && item.tab !== undefined) params.tab = item.tab;
    if (item.label) params.label = item.label;
    return params;
  }

  async function cleanupSession(item, timeoutMs) {
    if (!item.sessionId) return;
    try {
      await stopSession({ session: item.sessionId }, timeoutMs);
      item.cleanup = 'stopped';
    } catch (error) {
      item.cleanup = 'stop-failed';
      item.error = {
        ...(item.error || {}),
        cleanup: { code: (error && error.code) || 'E_INTERNAL', message: toText(error && error.message) },
      };
      logger('batch 条目 ' + item.index + ' 清理会话 ' + item.sessionId + ' 失败：' + toText(error && error.message));
    }
    item.sessionId = null;
  }

  async function runItem(record, spec, item, batchTimeoutMs) {
    if (record.cancelled) {
      item.state = 'cancelled';
      item.error = { code: 'E_CANCELLED', message: '批次已取消' };
      return;
    }
    item.state = 'starting';
    item.startedAt = clock();
    const attempts = 1 + (item.retries === null || item.retries === undefined ? spec.retries : item.retries);
    const timeoutMs = item.timeoutMs || spec.timeoutMs || batchTimeoutMs;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      item.attempts = attempt;
      try {
        const started = await startSession(buildStartParams(item), timeoutMs);
        const sessionId = started && started.sessionId ? String(started.sessionId) : null;
        if (!sessionId) throw errorOf('E_INTERNAL', 'session.start 未返回 sessionId');
        item.sessionId = sessionId;
        item.error = null;
        counters.itemsStarted += 1;
        if (item.url) {
          if (typeof navigate !== 'function') {
            throw errorOf('E_UNSUPPORTED', '批处理条目带 url，但 navigator 未接线');
          }
          await navigate(sessionId, item.url, timeoutMs);
          item.navigated = true;
        }
        // 只有启动 + 可选导航都成功后才提交名额（失败路径会释放预约额度）。
        const committed = quota.commit(record.batchId, 1);
        if (committed && committed.ok === true) record.quota.committed += 1;
        item.state = 'succeeded';
        item.finishedAt = clock();
        item.durationMs = Math.max(0, item.finishedAt - item.startedAt);
        counters.itemsSucceeded += 1;
        return;
      } catch (error) {
        lastError = error;
        const code = (error && error.code) || 'E_INTERNAL';
        if (attempt < attempts && isRetryableBatchError(code)) {
          // 重试前清理上一次尝试可能已经建立的会话，避免泄漏窗口。
          if (item.sessionId) await cleanupSession(item, Math.min(timeoutMs, 10_000));
          counters.retries += 1;
          const backoff = Math.min(BATCH_DEFAULTS.maxBackoffMs, BATCH_DEFAULTS.backoffMs * (2 ** (attempt - 1)));
          logger('batch ' + record.batchId + ' 条目 ' + item.index + ' 第 ' + attempt + ' 次启动失败（' + code + '），' + backoff + 'ms 后重试');
          await wait(backoff);
          continue;
        }
        // 失败清理：若已经创建了会话（例如导航失败），先 stop 再释放名额。
        if (item.sessionId) await cleanupSession(item, Math.min(timeoutMs, 10_000));
        const released = quota.release(record.batchId, 1);
        if (released && released.ok === true) record.quota.released += 1;
        item.state = 'failed';
        item.error = {
          code,
          message: toText(error && error.message) || '启动失败',
          ...(error && error.data !== undefined ? { data: toPlain(error.data) } : {}),
        };
        item.finishedAt = clock();
        item.durationMs = Math.max(0, item.finishedAt - item.startedAt);
        counters.itemsFailed += 1;
        return;
      }
    }
    // 理论不可达（循环里每个分支都 return），保留兜底。
    item.state = 'failed';
    item.error = { code: (lastError && lastError.code) || 'E_INTERNAL', message: toText(lastError && lastError.message) || '启动失败' };
    counters.itemsFailed += 1;
  }

  async function runBatch(record, spec) {
    const admitted = record.items
      .filter((item) => item.admission === 'admitted')
      .sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
    let cursor = 0;
    let abort = false;
    let sawFailure = false;
    const workers = [];
    const workerCount = Math.min(spec.concurrency, admitted.length);
    for (let index = 0; index < workerCount; index += 1) {
      workers.push((async () => {
        while (true) {
          if (record.cancelled) return;
          if (abort) return;
          const item = admitted[cursor];
          cursor += 1;
          if (!item) return;
          if (item.state !== 'pending') continue;
          await runItem(record, spec, item, spec.timeoutMs);
          if (item.state === 'failed') {
            sawFailure = true;
            if (spec.onError === 'abort' || spec.onError === 'rollback') {
              abort = true;
              record.abortReason = { index: item.index, code: item.error ? item.error.code : 'E_INTERNAL', policy: spec.onError };
              return;
            }
          }
        }
      })());
    }
    await Promise.all(workers);
    // 未调度的条目：取消 / abort / rollback 三种原因分开标注。
    for (const item of record.items) {
      if (item.state !== 'pending') continue;
      if (record.cancelled) {
        item.state = 'cancelled';
        item.error = { code: 'E_CANCELLED', message: '批次已取消' };
      } else if (abort) {
        item.state = 'skipped';
        item.error = {
          code: spec.onError === 'rollback' ? 'E_CANCELLED' : 'E_CANCELLED',
          message: '批次按 onError=' + spec.onError + ' 停止调度',
        };
      }
    }
    // 回滚：回收本批成功创建的会话（显式 onError=rollback 才做）。
    if (sawFailure && spec.onError === 'rollback') {
      record.state = 'rolled-back';
      const created = record.items.filter((item) => item.state === 'succeeded' && item.sessionId);
      const rollback = {
        requested: true,
        attempted: created.length,
        stopped: 0,
        failed: 0,
        errors: [],
        at: clock(),
      };
      for (const item of created) {
        try {
          await stopSession({ session: item.sessionId }, Math.min(spec.timeoutMs, 10_000));
          rollback.stopped += 1;
          item.state = 'rolled-back';
          item.cleanup = 'rolled-back';
        } catch (error) {
          rollback.failed += 1;
          rollback.errors.push({ index: item.index, sessionId: item.sessionId, code: (error && error.code) || 'E_INTERNAL', message: toText(error && error.message) });
        }
      }
      record.rollback = rollback;
      counters.rolledBack += 1;
      return;
    }
    if (record.cancelled) {
      record.state = 'cancelled';
      counters.cancelled += 1;
      return;
    }
    if (abort) {
      record.state = 'aborted';
      counters.aborted += 1;
      return;
    }
    record.state = 'completed';
    counters.completed += 1;
  }

  /**
   * 启动一个批次并等待其收尾（RPC 语义：返回完整批次报告）。
   * - 同一 batchId 幂等：已存在则直接返回（reused=true），不会重复启动；
   * - dryRun=true 等价 plan()（不占用配额、不启动会话）。
   */
  async function start(params = {}, timeoutMs = 60_000) {
    const spec = normalizeBatchSpec(params, { policy: quota.policy });
    if (spec.dryRun) {
      const planned = plan(params);
      return { ...planned, reused: false };
    }
    if (spec.batchId && batches.has(spec.batchId)) {
      const existing = batches.get(spec.batchId);
      return view(existing, {
        reused: true,
        note: existing.state === 'running' ? 'batch-in-progress' : 'batch-already-finished',
      });
    }
    const batchId = spec.batchId || newBatchId();
    const record = createRecord(spec, batchId);
    batches.set(batchId, record);
    trimRetention();
    counters.started += 1;
    record.state = 'running';
    record.startedAt = clock();
    const desired = spec.max === null ? record.items.length : Math.min(record.items.length, spec.max);
    let reserved;
    try {
      reserved = quota.reserve(batchId, desired, { priority: spec.priority, meta: { group: spec.group, onError: spec.onError } });
    } catch (error) {
      record.state = 'failed';
      record.finishedAt = clock();
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
      record.warnings.push('配额预约失败：' + toText(error && error.message));
      return view(record);
    }
    if (!reserved || reserved.ok === false) {
      record.state = 'failed';
      record.finishedAt = clock();
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
      record.warnings.push('配额预约被拒绝：' + toText(reserved && reserved.message));
      return view(record);
    }
    record.quota.requested = reserved.requested;
    record.quota.granted = reserved.granted;
    record.quota.reused = reserved.reused === true;
    record.quota.denied = Math.max(0, desired - reserved.granted);
    if (reserved.granted === 0) {
      counters.quotaDenied += 1;
      for (const item of record.items) {
        item.state = 'denied';
        item.admission = 'denied';
        item.error = {
          code: 'E_QUEUE_FULL',
          message: '会话配额不足（需要 ' + desired + '，可用 ' + reserved.available + '）',
          data: { requested: desired, granted: 0, available: reserved.available, policy: quota.policy },
        };
      }
      record.state = 'completed';
      record.finishedAt = clock();
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
      quota.finalize(batchId, { state: 'completed' });
      recomputeSummary(record);
      return view(record);
    }
    // 准入分配：按条目优先级 + 原始顺序取前 granted 个；其余 denied。
    const ordered = record.items
      .filter((item) => item.admission === 'unknown')
      .slice()
      .sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
    const admitted = new Set(ordered.slice(0, reserved.granted).map((item) => item.index));
    for (const item of record.items) {
      if (item.admission !== 'unknown') continue;
      if (admitted.has(item.index)) {
        item.admission = 'admitted';
      } else {
        item.admission = 'denied';
        item.state = 'denied';
        item.error = {
          code: 'E_QUEUE_FULL',
          message: '超出本批配额（granted=' + reserved.granted + '，requested=' + desired + '）',
          data: { requested: desired, granted: reserved.granted, policy: quota.policy },
        };
      }
    }
    recomputeSummary(record);
    try {
      await runBatch(record, spec);
    } catch (error) {
      record.state = 'failed';
      record.warnings.push('批处理执行异常：' + toText(error && error.message));
    } finally {
      recomputeSummary(record);
      record.finishedAt = clock();
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt);
      record.quota.finalized = quota.finalize(batchId, { state: record.state });
    }
    return view(record);
  }

  /** 取消批次：运行中的批次在下一个调度点停止；未调度条目标记 cancelled。 */
  function cancel(batchId) {
    const record = batches.get(String(batchId || ''));
    if (!record) {
      return { ok: false, code: 'E_NOT_FOUND', batchId: String(batchId || ''), message: '没有这个批次' };
    }
    if (record.state !== 'running' && record.state !== 'planning') {
      return { ok: true, cancelled: false, batchId: record.batchId, state: record.state, outcome: classifyBatchOutcome(record), reason: 'already-finished' };
    }
    record.cancelled = true;
    record.cancelledAt = clock();
    for (const item of record.items) {
      if (item.state === 'pending') {
        item.state = 'cancelled';
        item.error = { code: 'E_CANCELLED', message: '批次已取消' };
      }
    }
    recomputeSummary(record);
    return { ok: true, cancelled: true, batchId: record.batchId, state: record.state, cancelledItems: record.items.filter((item) => item.state === 'cancelled').length };
  }

  /** 查询单个批次（不存在返回 null）。 */
  function status(batchId) {
    const record = batches.get(String(batchId || ''));
    return record ? view(record) : null;
  }

  /** 列出批次（按创建时间倒序；state 过滤；limit 截断）。 */
  function list({ state = null, limit = 20 } = {}) {
    const wanted = state === null || state === undefined ? null : String(state).toLowerCase();
    const all = [...batches.values()]
      .filter((record) => !wanted || record.state === wanted)
      .sort((a, b) => (b.createdAt - a.createdAt) || (a.batchId < b.batchId ? -1 : 1));
    const max = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
    const batchesView = all.slice(0, max).map((record) => summaryView(record));
    const totals = {
      batches: all.length,
      running: all.filter((record) => record.state === 'running').length,
      completed: all.filter((record) => record.state === 'completed').length,
      aborted: all.filter((record) => record.state === 'aborted').length,
      cancelled: all.filter((record) => record.state === 'cancelled').length,
      rolledBack: all.filter((record) => record.state === 'rolled-back').length,
      itemsSucceeded: all.reduce((sum, record) => sum + (Number(record.summary.succeeded) || 0), 0),
      itemsFailed: all.reduce((sum, record) => sum + (Number(record.summary.failed) || 0), 0),
      itemsDenied: all.reduce((sum, record) => sum + (Number(record.summary.denied) || 0), 0),
    };
    return {
      schema: BATCH_SCHEMA,
      kind: BATCH_KIND,
      at: clock(),
      batches: batchesView,
      totals,
      truncated: all.length > batchesView.length,
      counters: { ...counters },
    };
  }

  /** status 增量视图（batch 视图）：配额 + 最近批次 + 汇总。 */
  function snapshot({ limit = 10 } = {}) {
    const at = clock();
    const recent = [...batches.values()]
      .sort((a, b) => (b.createdAt - a.createdAt) || (a.batchId < b.batchId ? -1 : 1))
      .slice(0, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 10)
      .map((record) => summaryView(record));
    const running = [...batches.values()].filter((record) => record.state === 'running').map((record) => record.batchId);
    return {
      schema: BATCH_SCHEMA,
      kind: BATCH_KIND,
      at,
      generatedAt: new Date(at).toISOString(),
      quota: quota.snapshot({ limit: 20 }),
      running,
      recent,
      totals: {
        batches: batches.size,
        running: running.length,
        succeeded: [...batches.values()].reduce((sum, record) => sum + (Number(record.summary.succeeded) || 0), 0),
        failed: [...batches.values()].reduce((sum, record) => sum + (Number(record.summary.failed) || 0), 0),
        denied: [...batches.values()].reduce((sum, record) => sum + (Number(record.summary.denied) || 0), 0),
      },
      counters: { ...counters },
    };
  }

  /** 测试/daemon 停止用。 */
  function reset() {
    batches.clear();
    for (const key of Object.keys(counters)) counters[key] = 0;
    seq = 0;
    return { batches: 0 };
  }

  return {
    plan,
    start,
    cancel,
    status,
    list,
    snapshot,
    reset,
    normalizeBatchSpec: (params) => normalizeBatchSpec(params, { policy: quota.policy }),
    get counters() { return { ...counters }; },
    get size() { return batches.size; },
  };
}
