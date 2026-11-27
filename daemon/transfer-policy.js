// daemon/transfer-policy.js —— transfer 配额 / 断点续传 / 校验 / 失败清理的纯策略层。
//
// 本模块不做任何 IO：输入是 transfer 条目的内部快照（数组），输出是"允许/拒绝/清理计划"，
// 由 daemon/transfer.mjs 负责执行。这样：
//   1) 配额与续传判定可以完全单测（不需要临时目录/文件句柄）；
//   2) 默认配额足够宽松，既有单流上传/下载行为与 0.3.0 完全一致；
//   3) 拒绝原因、用量证据结构化返回，CLI/doctor 直接消费。
//
// 与既有语义的边界：
// - 单个 transfer 的体积上限仍是 daemon/transfer.mjs 的 TRANSFER_MAX_BYTES（E_BAD_ARG）；
// - 配额拒绝复用已登记错误码 E_TRANSFER_LIMIT（data.reason 区分 max-concurrent 等），不新增错误码；
// - 续传只在调用方显式置 resume=true 时生效，旧调用（offset 必须等于已收字节）行为不变。

import crypto from 'node:crypto';

export const MB = 1024 * 1024;

/** 默认配额：同时最多 16 份、总量 512MB、单会话 8 份/256MB；空闲 10 分钟清理。 */
export const TRANSFER_DEFAULT_POLICY = Object.freeze({
  maxConcurrent: 16,
  maxTotalBytes: 512 * MB,
  maxPerSession: 8,
  maxSessionBytes: 256 * MB,
  idleTtlMs: 10 * 60 * 1000,
  finishedTtlMs: 10 * 60 * 1000,
  sweepIntervalMs: 60 * 1000,
});

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

/** TTL 允许 0 = 关闭该维度的自动清理（配额上限不允许 0）。 */
function nonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

/** 合并调用方覆盖项；非法值退回默认（配额不因坏配置变成 0 而误伤所有传输）。 */
export function normalizeTransferPolicy(policy = {}) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const base = TRANSFER_DEFAULT_POLICY;
  return {
    maxConcurrent: positiveInt(source.maxConcurrent, base.maxConcurrent),
    maxTotalBytes: positiveInt(source.maxTotalBytes, base.maxTotalBytes),
    maxPerSession: positiveInt(source.maxPerSession, base.maxPerSession),
    maxSessionBytes: positiveInt(source.maxSessionBytes, base.maxSessionBytes),
    idleTtlMs: nonNegativeInt(source.idleTtlMs, base.idleTtlMs),
    finishedTtlMs: nonNegativeInt(source.finishedTtlMs, base.finishedTtlMs),
    sweepIntervalMs: positiveInt(source.sweepIntervalMs, base.sweepIntervalMs),
  };
}

/** 运维/测试：从 BB_TRANSFER_* 环境变量读取配额覆盖（未设置项用默认）。 */
export function transferPolicyFromEnv(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const pick = (name) => {
    const raw = source[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    const number = Number(String(raw).trim());
    return Number.isFinite(number) ? number : undefined;
  };
  return normalizeTransferPolicy({
    maxConcurrent: pick('BB_TRANSFER_MAX_CONCURRENT'),
    maxTotalBytes: pick('BB_TRANSFER_MAX_TOTAL_BYTES'),
    maxPerSession: pick('BB_TRANSFER_MAX_PER_SESSION'),
    maxSessionBytes: pick('BB_TRANSFER_MAX_SESSION_BYTES'),
    idleTtlMs: pick('BB_TRANSFER_IDLE_TTL_MS'),
    finishedTtlMs: pick('BB_TRANSFER_FINISHED_TTL_MS'),
    sweepIntervalMs: pick('BB_TRANSFER_SWEEP_INTERVAL_MS'),
  });
}

/** 未完成条目占用配额；已完成/下载暂存文件只按会话展示，不阻塞新上传。 */
export function isActiveTransfer(entry) {
  return Boolean(entry) && entry.finished !== true;
}

function entryBytes(entry) {
  const declared = Number(entry && entry.byteSize);
  return Number.isFinite(declared) && declared > 0 ? declared : 0;
}

function entryReceived(entry) {
  const received = Number(entry && entry.received);
  return Number.isFinite(received) && received > 0 ? received : 0;
}

/**
 * 配额用量：并发槽位按"未完成条目"计，字节按"声明大小"预留（避免边写边超）。
 * incoming 为待准入条目的预估值（begin 时还没有条目）。
 * @param {Array<object>} entries 内部 transfer 条目
 * @param {{sessionId?: string, byteSize?: number}} incoming
 */
export function transferUsage(entries, incoming = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const usage = {
    active: 0,
    total: list.length,
    reservedBytes: 0,
    receivedBytes: 0,
    bySession: Object.create(null),
    sessions: 0,
  };
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const sessionId = entry.sessionId == null ? '(none)' : String(entry.sessionId);
    if (!usage.bySession[sessionId]) {
      usage.bySession[sessionId] = { active: 0, reservedBytes: 0, receivedBytes: 0 };
      usage.sessions += 1;
    }
    usage.receivedBytes += entryReceived(entry);
    if (!isActiveTransfer(entry)) continue;
    const bytes = entryBytes(entry);
    usage.active += 1;
    usage.reservedBytes += bytes;
    usage.bySession[sessionId].active += 1;
    usage.bySession[sessionId].reservedBytes += bytes;
    usage.bySession[sessionId].receivedBytes += entryReceived(entry);
  }
  const incomingSession = incoming && incoming.sessionId != null ? String(incoming.sessionId) : null;
  const incomingBytes = Number(incoming && incoming.byteSize);
  const planned = {
    active: usage.active,
    reservedBytes: usage.reservedBytes,
    sessionActive: incomingSession && usage.bySession[incomingSession] ? usage.bySession[incomingSession].active : 0,
    sessionBytes: incomingSession && usage.bySession[incomingSession] ? usage.bySession[incomingSession].reservedBytes : 0,
    incomingBytes: Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0,
  };
  return {
    ...usage,
    planned: {
      active: planned.active + 1,
      reservedBytes: planned.reservedBytes + planned.incomingBytes,
      sessionActive: planned.sessionActive + 1,
      sessionBytes: planned.sessionBytes + planned.incomingBytes,
    },
  };
}

/**
 * 准入判定：返回 {allowed, code, reason, limit, usage}。
 * code 只在拒绝时出现，且复用已登记错误码 E_TRANSFER_LIMIT（data.reason 区分具体维度）。
 */
export function evaluateTransferAdmission(entries, { sessionId = null, byteSize = 0, policy = TRANSFER_DEFAULT_POLICY } = {}) {
  const limits = normalizeTransferPolicy(policy);
  const usage = transferUsage(entries, { sessionId, byteSize });
  const planned = usage.planned;
  const reject = (reason, limit) => ({ allowed: false, code: 'E_TRANSFER_LIMIT', reason, limit, usage, limits });
  if (planned.active > limits.maxConcurrent) return reject('max-concurrent', limits.maxConcurrent);
  if (planned.sessionActive > limits.maxPerSession) return reject('max-per-session', limits.maxPerSession);
  if (planned.reservedBytes > limits.maxTotalBytes) return reject('max-total-bytes', limits.maxTotalBytes);
  if (planned.sessionBytes > limits.maxSessionBytes) return reject('max-session-bytes', limits.maxSessionBytes);
  return { allowed: true, code: null, reason: null, limit: null, usage, limits };
}

/**
 * 续传判定：
 * - mode='append'：offset === received，正常追加；
 * - mode='replay'：offset < received 且重叠区间字节一致 → 只写 [overlap, chunkLength) 的尾巴；
 * - allowed=false 时 reason ∈ gap|overflow|empty|bad-offset|not-contiguous。
 * 旧语义（未开 resume）由 transfer.mjs 直接判 offset !== received 并抛 E_TRANSFER_OFFSET。
 */
export function evaluateResumeChunk({ received = 0, offset = 0, chunkLength = 0, byteSize = 0, resume = false } = {}) {
  const head = Number.isInteger(received) && received > 0 ? received : 0;
  const start = Number.isInteger(offset) && offset >= 0 ? offset : -1;
  const length = Number.isInteger(chunkLength) && chunkLength > 0 ? chunkLength : 0;
  const total = Number.isInteger(byteSize) && byteSize > 0 ? byteSize : 0;
  if (start < 0) return { allowed: false, mode: 'reject', reason: 'bad-offset' };
  if (!length) return { allowed: false, mode: 'reject', reason: 'empty' };
  if (start > head) return { allowed: false, mode: 'reject', reason: 'gap', expectedOffset: head };
  if (!resume && start !== head) return { allowed: false, mode: 'reject', reason: 'not-contiguous', expectedOffset: head };
  if (start + length > total) return { allowed: false, mode: 'reject', reason: 'overflow', expectedOffset: head };
  if (start === head) {
    return { allowed: true, mode: 'append', offset: start, overlap: 0, tailOffset: length, writeFrom: 0, writeLength: length };
  }
  // replay：offset 落在已收区间内。重叠段必须与磁盘内容比对（由调用方执行）。
  const overlap = Math.min(length, head - start);
  return {
    allowed: true,
    mode: 'replay',
    offset: start,
    overlap,
    tailOffset: Math.max(0, length - overlap),
    writeFrom: overlap,
    writeLength: Math.max(0, length - overlap),
  };
}

/** 续传重叠区字节比较：磁盘读回 vs 客户端重发。 */
export function compareResumeOverlap(onDisk, resent) {
  const left = Buffer.isBuffer(onDisk) ? onDisk : Buffer.alloc(0);
  const right = Buffer.isBuffer(resent) ? resent : Buffer.alloc(0);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return { ok: false, reason: 'checksum-mismatch', at: index };
  }
  if (left.length !== right.length) return { ok: false, reason: 'checksum-mismatch', at: length };
  return { ok: true, reason: null, at: -1 };
}

/** sha256 摘要（传输校验用；只做摘要，不算 HMAC）。 */
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 校验声明摘要：expected 缺省视为不校验，返回 {ok:true, skipped:true}。 */
export function verifyChecksum(expected, actual) {
  const want = expected == null ? '' : String(expected).trim().toLowerCase();
  if (!want) return { ok: true, skipped: true, reason: null };
  if (!/^[0-9a-f]{64}$/.test(want)) return { ok: false, skipped: false, reason: 'bad-digest' };
  const got = String(actual || '').toLowerCase();
  return { ok: got === want, skipped: false, reason: got === want ? null : 'checksum-mismatch' };
}

/** 校验失败时的清理计划：失败条目一律释放（半成品不能留在 staging 里被 upload 复用）。 */
export function planFailureCleanup(entry, reason = 'failure') {
  if (!entry || typeof entry !== 'object') return null;
  return {
    id: entry.id,
    sessionId: entry.sessionId == null ? null : entry.sessionId,
    reason,
    bytes: entryReceived(entry),
    needsUnlink: true,
  };
}

/**
 * 清理计划：未完成且空闲超过 idleTtlMs → 回收槽位；已完成且超过 finishedTtlMs → 回收磁盘。
 * 返回 {remove, keep, bytes, reasons}，不直接删文件。
 */
export function planTransferSweep(entries, { now = Date.now(), policy = TRANSFER_DEFAULT_POLICY } = {}) {
  const limits = normalizeTransferPolicy(policy);
  const list = Array.isArray(entries) ? entries : [];
  const remove = [];
  let keep = 0;
  let bytes = 0;
  const reasons = Object.create(null);
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { keep += 1; continue; }
    const lastAt = Number(entry.lastActivityAt || entry.updatedAt || entry.createdAt || 0);
    const ageMs = lastAt > 0 ? Math.max(0, Number(now) - lastAt) : 0;
    let reason = null;
    if (isActiveTransfer(entry)) {
      if (limits.idleTtlMs > 0 && lastAt > 0 && ageMs >= limits.idleTtlMs) reason = 'idle-unfinished';
    } else if (limits.finishedTtlMs > 0 && lastAt > 0 && ageMs >= limits.finishedTtlMs) {
      reason = 'stale-finished';
    }
    if (!reason) { keep += 1; continue; }
    const size = entryBytes(entry);
    remove.push({ id: entry.id, sessionId: entry.sessionId == null ? null : entry.sessionId, reason, bytes: size, ageMs, finished: entry.finished === true });
    reasons[reason] = (reasons[reason] || 0) + 1;
    bytes += size;
  }
  return { remove, keep, bytes, reasons, scanned: list.length, at: Number(now) };
}

/** 对外的 transfer 公共视图：不包含 filePath（staging 路径只在 daemon 内部/daemon→扩展出现）。 */
export function transferPublicView(entry, { now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const byteSize = entryBytes(entry);
  const received = entryReceived(entry);
  const lastAt = Number(entry.lastActivityAt || entry.updatedAt || entry.createdAt || 0);
  const percent = byteSize > 0 ? Math.min(100, Math.round((received / byteSize) * 1000) / 10) : 0;
  return {
    transferId: entry.id,
    sessionId: entry.sessionId == null ? null : entry.sessionId,
    name: entry.name == null ? '' : String(entry.name),
    byteSize,
    received,
    remaining: Math.max(0, byteSize - received),
    percent,
    finished: entry.finished === true,
    direction: entry.direction === 'download' ? 'download' : 'upload',
    createdAt: Number(entry.createdAt) || 0,
    lastActivityAt: lastAt,
    ageMs: Number(now) > 0 && Number(entry.createdAt) > 0 ? Math.max(0, Number(now) - Number(entry.createdAt)) : 0,
    idleMs: lastAt > 0 && Number(now) > 0 ? Math.max(0, Number(now) - lastAt) : 0,
    verified: entry.verified === true,
    checksum: entry.checksum ? String(entry.checksum).slice(0, 16) : null,
  };
}

/**
 * transfer 域快照：列表 + 配额用量 + 方向/会话汇总。limit 只截列表，不影响汇总。
 * @param {Array<object>} entries
 * @param {{now?: number, policy?: object, limit?: number}} options
 */
export function buildTransferSnapshot(entries, { now = Date.now(), policy = TRANSFER_DEFAULT_POLICY, limit = 20 } = {}) {
  const limits = normalizeTransferPolicy(policy);
  const list = Array.isArray(entries) ? entries : [];
  const usage = transferUsage(list);
  const views = list
    .map((entry) => transferPublicView(entry, { now }))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  const max = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const sessions = Object.keys(usage.bySession)
    .map((sessionId) => ({ sessionId, ...usage.bySession[sessionId] }))
    .sort((a, b) => b.active - a.active || b.reservedBytes - a.reservedBytes);
  return {
    at: Number(now),
    counts: {
      total: views.length,
      active: usage.active,
      finished: views.filter((item) => item.finished).length,
      uploads: views.filter((item) => item.direction === 'upload').length,
      downloads: views.filter((item) => item.direction === 'download').length,
      sessions: usage.sessions,
    },
    bytes: {
      reserved: usage.reservedBytes,
      received: usage.receivedBytes,
      totalDeclared: views.reduce((sum, item) => sum + item.byteSize, 0),
    },
    quota: {
      maxConcurrent: limits.maxConcurrent,
      maxTotalBytes: limits.maxTotalBytes,
      maxPerSession: limits.maxPerSession,
      maxSessionBytes: limits.maxSessionBytes,
      idleTtlMs: limits.idleTtlMs,
      finishedTtlMs: limits.finishedTtlMs,
      usagePercent: limits.maxTotalBytes > 0 ? Math.round((usage.reservedBytes / limits.maxTotalBytes) * 1000) / 10 : 0,
      slotsPercent: limits.maxConcurrent > 0 ? Math.round((usage.active / limits.maxConcurrent) * 1000) / 10 : 0,
    },
    sessions,
    transfers: views.slice(0, max),
    truncated: views.length > max,
  };
}
