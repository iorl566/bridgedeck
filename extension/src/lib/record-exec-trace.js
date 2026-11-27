// src/lib/record-exec-trace.js —— 录制 program 执行的轨迹证据（dry-run / 回放共用）。
//
// 执行器（lib/record-exec-plan.js）每推进一步都写一条轨迹；本模块负责把这批轨迹做成
// “可封存、可复算、可对账”的证据：
//   - 归一化 + 参数脱敏（值/密码/token 一律不进轨迹，selector/url 只留截断后的结构）；
//   - 哈希链（FNV-1a，非加密）：entry.digest = h(prevDigest + 规范化 body)，
//     任何一条被事后改动都能定位到 index；
//   - 摘要（按 phase/status/kind 计数、重试/人工/取消次数、首末时间、总 digest），
//     直接挂到录制事件/诊断输出，体积有界；
//   - 两条轨迹的 diff（按 index+ref 对齐），用于“同一 program 两次 dry-run 结果是否一致”；
//   - 文本格式化（CLI/日志），带行数上限，绝不把整条 params 打出来。
//
// 只依赖 record-steps.js 的 stableHash（叶子模块），不 import 执行器/程序模块，避免环。

import { stableHash } from '../record-steps.js';

export const TRACE_VERSION = 1;

/** 单步执行结局。 */
export const TRACE_STATUSES = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  RETRY: 'retry',
  FAILED: 'failed',
  PLANNED: 'planned',
});

export const TRACE_STATUS_LIST = Object.freeze(Object.values(TRACE_STATUSES));

/** 轨迹阶段：串行/分支/并发 arm/取消收尾。 */
export const TRACE_PHASES = Object.freeze({
  SERIAL: 'serial',
  BRANCH: 'branch',
  PARALLEL: 'parallel',
  CANCEL: 'cancel',
});

export const TRACE_PHASE_LIST = Object.freeze(Object.values(TRACE_PHASES));

export const TRACE_CODES = Object.freeze({
  TRACE_EMPTY: 'TRACE_EMPTY',
  TRACE_MISMATCH: 'TRACE_MISMATCH',
  TRACE_TOO_LARGE: 'TRACE_TOO_LARGE',
  TRACE_BAD_ARG: 'TRACE_BAD_ARG',
  TRACE_TRUNCATED: 'TRACE_TRUNCATED',
});

export const TRACE_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxText: 16_000,
  maxFormatLines: 80,
  maxParams: 12,
  maxNote: 160,
});

const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|otp|code|value|credential/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function clip(text, limit) {
  return String(text == null ? '' : text).slice(0, limit);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * 参数脱敏：敏感键整值替换成 `***`（保留“有没有值”这一事实），其余值截断。
 * 旧轨迹里不存在 params 时返回 null（不改变既有字段）。
 * @param {object|null|undefined} params
 * @param {{maxParams?:number, maxValueLength?:number}} [options]
 */
export function redactTraceParams(params, options = {}) {
  if (!isPlainObject(params)) return null;
  const maxParams = Math.max(1, integer(options.maxParams, TRACE_LIMITS.maxParams));
  const maxValueLength = Math.max(8, integer(options.maxValueLength, 120));
  const out = {};
  const keys = Object.keys(params).slice(0, maxParams);
  for (const key of keys) {
    const value = params[key];
    if (value === undefined) continue;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = value === '' || value == null ? '***' : '***:' + clip(String(value).length, 8);
      continue;
    }
    if (typeof value === 'string') {
      out[key] = clip(value, maxValueLength);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = '[array:' + value.length + ']';
    } else if (isPlainObject(value)) {
      out[key] = '[object:' + Object.keys(value).length + ']';
    } else {
      out[key] = clip(String(value), maxValueLength);
    }
  }
  if (Object.keys(params).length > maxParams) out.__truncated = Object.keys(params).length - maxParams;
  return out;
}

function canonicalBody(entry) {
  return {
    seq: entry.seq,
    index: entry.index,
    ref: entry.ref,
    kind: entry.kind,
    method: entry.method,
    phase: entry.phase,
    status: entry.status,
    attempts: entry.attempts,
    at: entry.at,
    note: entry.note,
    params: entry.params,
    ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
    ...(entry.parallel !== undefined ? { parallel: entry.parallel } : {}),
    ...(entry.cancel !== undefined ? { cancel: entry.cancel } : {}),
  };
}

/**
 * 规整一条轨迹（不含链 digest）：非法输入返回 null。
 * @param {object} input
 * @param {{index?:number, redact?:boolean}} [options]
 */
export function normalizeTraceEntry(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  const status = TRACE_STATUS_LIST.includes(input.status) ? input.status : TRACE_STATUSES.OK;
  const phase = TRACE_PHASE_LIST.includes(input.phase) ? input.phase : TRACE_PHASES.SERIAL;
  return {
    seq: Math.max(1, integer(input.seq, integer(options.index, 0) + 1)),
    index: integer(input.index, integer(options.index, 0)),
    ref: clip(input.ref || '', 64),
    kind: clip(input.kind || '', 32),
    method: clip(input.method || '', 64),
    phase,
    status,
    attempts: Math.max(1, integer(input.attempts, 1)),
    at: num(input.at),
    note: clip(input.note || '', TRACE_LIMITS.maxNote),
    params: options.redact === false ? (isPlainObject(input.params) ? { ...input.params } : null) : redactTraceParams(input.params),
    ...(input.branch !== undefined ? { branch: isPlainObject(input.branch) ? { ...input.branch } : input.branch } : {}),
    ...(input.parallel !== undefined ? { parallel: clip(input.parallel || '', 48) } : {}),
    ...(input.cancel !== undefined ? { cancel: clip(input.cancel || '', 48) } : {}),
    ...(input.humanGate !== undefined ? { humanGate: input.humanGate === true } : {}),
  };
}

/**
 * 给一条轨迹补链字段：prevDigest + digest。
 * @param {object|null} previous 上一条（含 digest）
 * @param {object} entry normalizeTraceEntry 的结果
 */
export function chainTraceEntry(previous, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const prevDigest = previous && previous.digest ? previous.digest : 'genesis';
  const body = canonicalBody(entry);
  return {
    ...entry,
    prevDigest,
    digest: 't' + stableHash(JSON.stringify({ prevDigest, body })),
  };
}

/** 重算一条已链轨迹的 digest（校验用）。 */
function expectedDigest(previous, entry) {
  return chainTraceEntry(previous, entry).digest;
}

/**
 * 创建有界轨迹记录器（执行器持有一个；时钟/上限/脱敏可注入）。
 * @param {{now?:() => number, limit?:number, redact?:boolean}} [options]
 */
export function createTraceRecorder(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const limit = Math.max(1, integer(options.limit, TRACE_LIMITS.maxEntries));
  const redact = options.redact !== false;
  const entries = [];
  const counters = { pushed: 0, dropped: 0, byStatus: {}, byPhase: {} };

  /**
   * 追加一条轨迹；返回写入后的链 entry（被丢弃时返回原 entry 但不入链）。
   */
  function push(input) {
    if (!input || typeof input !== 'object') return null;
    const previous = entries.length ? entries[entries.length - 1] : null;
    const normalized = normalizeTraceEntry({
      ...input,
      seq: integers(input),
      at: num(input && input.at) || now(),
    }, { index: entries.length, redact });
    if (!normalized) return null;
    const chained = chainTraceEntry(previous, normalized);
    counters.pushed += 1;
    counters.byStatus[chained.status] = (counters.byStatus[chained.status] || 0) + 1;
    counters.byPhase[chained.phase] = (counters.byPhase[chained.phase] || 0) + 1;
    if (entries.length >= limit) {
      entries.shift();
      counters.dropped += 1;
    }
    entries.push(chained);
    return chained;
  }

  function integers(input) {
    const source = input && typeof input === 'object' ? input : {};
    return Math.max(1, integer(source.seq, entries.length + 1));
  }

  function list() {
    return entries.map((entry) => ({ ...entry }));
  }

  function summary() {
    return summarizeTrace(entries, { dropped: counters.dropped });
  }

  function seal(extra = null) {
    return sealTrace(entries, { ...(isPlainObject(extra) ? extra : {}), dropped: counters.dropped });
  }

  function verify(sealed) {
    return verifyTrace(sealed || seal());
  }

  function clear() {
    const cleared = entries.length;
    entries.length = 0;
    return { ok: true, cleared };
  }

  return {
    push,
    entries: list,
    list,
    size() { return entries.length; },
    summary,
    digest() { return summary().digest; },
    seal,
    verify,
    clear,
    counters() { return { ...counters, size: entries.length, limit }; },
    get limit() { return limit; },
  };
}

/** 摘要：计数 + 首末时间 + 链尾 digest（挂事件/诊断用，体积有界）。 */
export function summarizeTrace(entriesInput, extra = {}) {
  const entries = (Array.isArray(entriesInput) ? entriesInput : []).filter(isPlainObject);
  const byStatus = {};
  const byPhase = {};
  const byKind = {};
  const methods = new Set();
  let retries = 0;
  let humanGates = 0;
  let cancels = 0;
  let branches = 0;
  let parallel = 0;
  let skipped = 0;
  let blocked = 0;
  let failed = 0;
  let minAt = 0;
  let maxAt = 0;
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    byPhase[entry.phase] = (byPhase[entry.phase] || 0) + 1;
    byKind[entry.kind || 'unknown'] = (byKind[entry.kind || 'unknown'] || 0) + 1;
    if (entry.method) methods.add(entry.method);
    if (entry.attempts > 1 || entry.status === TRACE_STATUSES.RETRY) retries += Math.max(0, (entry.attempts || 1) - 1);
    if (entry.humanGate === true) humanGates += 1;
    if (entry.cancel) cancels += 1;
    if (entry.branch !== undefined) branches += 1;
    if (entry.phase === TRACE_PHASES.PARALLEL) parallel += 1;
    if (entry.status === TRACE_STATUSES.SKIPPED) skipped += 1;
    if (entry.status === TRACE_STATUSES.BLOCKED) blocked += 1;
    if (entry.status === TRACE_STATUSES.FAILED) failed += 1;
    if (entry.at > 0) {
      if (minAt === 0 || entry.at < minAt) minAt = entry.at;
      if (entry.at > maxAt) maxAt = entry.at;
    }
  }
  const last = entries.length ? entries[entries.length - 1] : null;
  const digest = last && last.digest ? last.digest : 't' + stableHash('empty');
  return {
    version: TRACE_VERSION,
    count: entries.length,
    byStatus,
    byPhase,
    byKind,
    methods: [...methods].slice(0, 16),
    retries,
    humanGates,
    cancels,
    branches,
    parallel,
    skipped,
    blocked,
    failed,
    firstAt: minAt,
    lastAt: maxAt,
    durationMs: minAt > 0 && maxAt >= minAt ? maxAt - minAt : 0,
    digest,
    dropped: nonNegative(extra && extra.dropped),
    ok: failed === 0 && blocked === 0,
  };
}

/**
 * 封存轨迹：带哈希链条目的证书（entries 一并带上，便于离线复算）。
 * @param {Array} entriesInput
 * @param {object} [extra]
 */
export function sealTrace(entriesInput, extra = {}) {
  const normalized = [];
  let previous = null;
  for (const raw of (Array.isArray(entriesInput) ? entriesInput : [])) {
    const entry = normalizeTraceEntry(raw, { index: normalized.length });
    if (!entry) continue;
    const chained = chainTraceEntry(previous, entry);
    normalized.push(chained);
    previous = chained;
  }
  return {
    version: TRACE_VERSION,
    sealed: true,
    count: normalized.length,
    firstAt: normalized.length ? normalized[0].at : 0,
    lastAt: normalized.length ? normalized[normalized.length - 1].at : 0,
    digest: previous ? previous.digest : 't' + stableHash('empty'),
    extra: isPlainObject(extra) ? { ...extra } : null,
    entries: normalized,
  };
}

/**
 * 校验轨迹链：逐条重算；返回第一条被改动的 index（或空链说明）。
 * @param {{entries?:Array, digest?:string}} sealed
 */
export function verifyTrace(sealed) {
  if (!sealed || !Array.isArray(sealed.entries)) {
    return { ok: false, code: TRACE_CODES.TRACE_BAD_ARG, error: '轨迹证书缺失或结构不对', at: null };
  }
  let previous = null;
  for (let index = 0; index < sealed.entries.length; index += 1) {
    const entry = sealed.entries[index];
    if (!isPlainObject(entry)) continue;
    const expected = expectedDigest(previous, entry);
    if (expected !== entry.digest) {
      return {
        ok: false,
        code: TRACE_CODES.TRACE_MISMATCH,
        error: '轨迹第 ' + index + ' 条被改动',
        index,
        expected: entry.digest,
        actual: expected,
        at: num(entry.at),
      };
    }
    previous = entry;
  }
  const digest = previous && previous.digest ? previous.digest : 't' + stableHash('empty');
  return {
    ok: digest === sealed.digest,
    code: digest === sealed.digest ? null : TRACE_CODES.TRACE_MISMATCH,
    count: sealed.entries.length,
    digest,
    expected: sealed.digest,
    at: sealed.lastAt || null,
  };
}

/**
 * 两条轨迹的 diff：按 [index, ref] 对齐；status/attempts/phase 任一不同即 changed。
 * @returns {{ok:boolean, equal:boolean, added:Array, removed:Array, changed:Array, hunks:Array, stats:object}}
 */
export function diffTraces(leftInput, rightInput) {
  const left = (Array.isArray(leftInput) ? leftInput : []).filter(isPlainObject);
  const right = (Array.isArray(rightInput) ? rightInput : []).filter(isPlainObject);
  const keyOf = (entry) => integer(entry.index, -1) + '|' + clip(entry.ref || '', 64);
  const leftMap = new Map();
  for (const entry of left) leftMap.set(keyOf(entry), entry);
  const rightMap = new Map();
  for (const entry of right) rightMap.set(keyOf(entry), entry);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, entry] of rightMap) {
    if (!leftMap.has(key)) added.push({ key, index: entry.index, ref: entry.ref, status: entry.status, phase: entry.phase });
  }
  for (const [key, entry] of leftMap) {
    if (!rightMap.has(key)) {
      removed.push({ key, index: entry.index, ref: entry.ref, status: entry.status, phase: entry.phase });
      continue;
    }
    const other = rightMap.get(key);
    const fields = [];
    if (entry.status !== other.status) fields.push('status');
    if (entry.phase !== other.phase) fields.push('phase');
    if (integer(entry.attempts, 1) !== integer(other.attempts, 1)) fields.push('attempts');
    if (fields.length) {
      changed.push({
        key,
        index: entry.index,
        ref: entry.ref,
        fields,
        before: { status: entry.status, phase: entry.phase, attempts: entry.attempts },
        after: { status: other.status, phase: other.phase, attempts: other.attempts },
      });
    }
  }
  const hunks = [];
  for (const item of removed) hunks.push({ type: 'removed', index: item.index, ref: item.ref });
  for (const item of added) hunks.push({ type: 'added', index: item.index, ref: item.ref });
  for (const item of changed) hunks.push({ type: 'changed', index: item.index, ref: item.ref, fields: item.fields });
  hunks.sort((first, second) => first.index - second.index);
  return {
    ok: true,
    equal: added.length === 0 && removed.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
    hunks: hunks.slice(0, 64),
    stats: { left: left.length, right: right.length, added: added.length, removed: removed.length, changed: changed.length, hunks: hunks.length },
  };
}

/** 文本轨迹（CLI/日志）：一行一步，最多 maxFormatLines 行。 */
export function formatTrace(traceOrSealed, options = {}) {
  const list = traceOrSealed && Array.isArray(traceOrSealed.entries)
    ? traceOrSealed.entries
    : (Array.isArray(traceOrSealed) ? traceOrSealed : []);
  const maxLines = Math.max(1, integer(options.maxLines, TRACE_LIMITS.maxFormatLines));
  const lines = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (lines.length >= maxLines) break;
    const parts = ['#' + integer(entry.index, 0), entry.phase || 'serial', entry.status || 'ok', entry.kind || '-', entry.method || '-'];
    if (entry.ref) parts.push(entry.ref);
    if (entry.attempts > 1) parts.push('attempts=' + entry.attempts);
    if (entry.note) parts.push('(' + clip(entry.note, 60) + ')');
    lines.push(parts.join(' '));
  }
  if (!lines.length) lines.push('trace: 空');
  return lines.join('\n');
}

/** 一行摘要：诊断输出用。 */
export function describeTrace(trace) {
  if (!trace || typeof trace !== 'object') return 'record-trace: 无轨迹';
  const parts = ['trace=' + integer(trace.count, 0)];
  const byStatus = isPlainObject(trace.byStatus) ? trace.byStatus : {};
  const statuses = Object.keys(byStatus).filter((key) => byStatus[key] > 0).slice(0, 4);
  if (statuses.length) parts.push(statuses.map((key) => key + ':' + byStatus[key]).join(','));
  if (trace.retries > 0) parts.push('retries=' + trace.retries);
  if (trace.humanGates > 0) parts.push('human=' + trace.humanGates);
  if (trace.cancels > 0) parts.push('cancels=' + trace.cancels);
  if (trace.digest) parts.push('digest=' + trace.digest);
  return parts.join(' ');
}
