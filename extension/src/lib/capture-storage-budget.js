// lib/capture-storage-budget.js —— 采集产物的存储预算/配额/淘汰策略（纯函数；长截图与视频共用）。
//
// 背景：长截图分片（IndexedDB tile + manifest）与视频（OPFS 分段 + 分片日记）都会长期占用
// chrome.storage.local / IndexedDB / OPFS。0.3.0 只按“条数/天数”清理，没有配额视图：
//   * 不知道当前用量离配额多远，采集写满后才失败（分片半途丢失）；
//   * 删除顺序按时间，可能删掉“未封版、仍可恢复”的 capture，留下已封版的大文件；
//   * 新采集进来前不做“够不够、要淘汰谁、淘汰多少”的决策，只能失败重试。
//
// 本模块把存储预算收敛成可单测的纯函数：
//   resolveStorageBudget()   —— 默认配额/水位/各 kind 份额；
//   captureFootprint()       —— 单条产物的字节足迹（kind/segments/bytes 归并）；
//   estimateStorageUsage()   —— 总用量/分 kind 用量/压力等级；
//   selectEvictions()        —— 给定需要腾出的字节，选最少代价的淘汰集合（保护未封版/pinned）；
//   planStorageBudget()      —— 新产物进来前的决策：accept / warn / evict / reject + 证据；
//   storageBudgetWire()/describeStorageBudget() —— 协议字段与一行日志。
//
// 约束：纯计算，不碰 chrome.*/IDB/OPFS；运行时（capture-persist / video-persist）拿计划后执行删除。

export const STORAGE_BUDGET_VERSION = 1;

export const STORAGE_ACTIONS = Object.freeze(['accept', 'warn', 'evict', 'reject']);

export const STORAGE_PRESSURE = Object.freeze(['ok', 'warn', 'critical', 'full']);

export const STORAGE_CODES = Object.freeze({
  OK: 'storage.ok',
  WARN: 'storage.warn',
  CRITICAL: 'storage.critical',
  EVICT: 'storage.evict',
  REJECT: 'storage.reject',
  PROTECTED: 'storage.protected',
  UNKNOWN: 'storage.unknown',
});

export const STORAGE_DEFAULTS = Object.freeze({
  // 默认给采集产物留 512MB（浏览器配额因 profile/磁盘而异，这是保守内部分配额而不是浏览器真配额）。
  quotaBytes: 512 * 1024 * 1024,
  // 水位：warn 85%，critical 95%；到 100% 直接 reject。
  warnRatio: 0.85,
  criticalRatio: 0.95,
  // 预留：给 manifest/journal/元数据等小文件的固定余量。
  reserveBytes: 4 * 1024 * 1024,
  // 单次采集最多占配额的比例（防止一次 300MB 的长截图把历史全挤掉）。
  maxCaptureRatio: 0.5,
  // 各 kind 的配额份额（未命中 kind 的按 'other'）。
  shares: Object.freeze({ longshot: 0.55, video: 0.4, other: 0.05 }),
  // 清理时至少保留的条数与天数（与 capture-manifest 的默认 TTL 对齐：7 天）。
  minKeep: 1,
  minAgeMs: 60 * 60 * 1000,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** 归一化 kind：长截图/视频/其它（未知 kind 归 other，便于份额计算）。 */
export function normalizeStorageKind(kind) {
  const text = String(kind == null ? '' : kind).trim().toLowerCase();
  if (text === 'longshot' || text === 'screenshot' || text === 'capture') return 'longshot';
  if (text === 'video' || text === 'recording') return 'video';
  return 'other';
}

/** 合并调用方的配额覆盖项；非法值回落默认（0/NaN 不当作“无上限”）。 */
export function resolveStorageBudget(options = {}) {
  const sharesSource = isPlainObject(options.shares) ? options.shares : {};
  const shares = {};
  for (const kind of ['longshot', 'video', 'other']) {
    const value = clampRatio(sharesSource[kind], STORAGE_DEFAULTS.shares[kind]);
    shares[kind] = value;
  }
  const totalShare = shares.longshot + shares.video + shares.other;
  if (totalShare > 0 && Math.abs(totalShare - 1) > 1e-6) {
    // 份额和不为 1 时按比例归一（调用方可以只给 longshot 0.8，其余按默认权重分配）。
    for (const kind of Object.keys(shares)) shares[kind] = Number((shares[kind] / totalShare).toFixed(6));
  }
  const quotaInput = intOr(options.quotaBytes, STORAGE_DEFAULTS.quotaBytes);
  // quotaBytes<=0 不是“无上限”，而是非法值：回落默认，避免 0 配额让所有采集被拒。
  const quotaBytes = Math.max(1, quotaInput > 0 ? quotaInput : STORAGE_DEFAULTS.quotaBytes);
  const warnRatio = clampRatio(options.warnRatio, STORAGE_DEFAULTS.warnRatio);
  const criticalRatio = Math.max(warnRatio, clampRatio(options.criticalRatio, STORAGE_DEFAULTS.criticalRatio));
  return {
    quotaBytes,
    warnRatio,
    criticalRatio,
    reserveBytes: Math.max(0, intOr(options.reserveBytes, STORAGE_DEFAULTS.reserveBytes)),
    maxCaptureRatio: clampRatio(options.maxCaptureRatio, STORAGE_DEFAULTS.maxCaptureRatio),
    shares,
    minKeep: clampInt(options.minKeep, 0, 1000, STORAGE_DEFAULTS.minKeep),
    minAgeMs: Math.max(0, intOr(options.minAgeMs, STORAGE_DEFAULTS.minAgeMs)),
    ttlMs: Math.max(0, intOr(options.ttlMs, STORAGE_DEFAULTS.ttlMs)),
  };
}

/** 单条产物的字节足迹：优先 bytes/size，其次按 segments/tiles × 平均字节估算。 */
export function captureFootprint(item) {
  if (!isPlainObject(item)) return { id: '', kind: 'other', bytes: 0, segments: 0, sealed: false, pinned: false, at: 0, estimated: false };
  const kind = normalizeStorageKind(item.kind || item.type);
  const segments = Math.max(0, intOr(item.segments, intOr(item.tiles, Array.isArray(item.frames) ? item.frames.length : 0)));
  const direct = Math.max(
    finiteNonNegative(item.bytes),
    finiteNonNegative(item.size),
    finiteNonNegative(item.totalBytes),
    finiteNonNegative(item.encodedBytes),
  );
  let bytes = direct;
  let estimated = false;
  if (!(bytes > 0) && segments > 0) {
    const average = finiteNonNegative(item.averageBytes) || finiteNonNegative(item.segmentBytes) || 96 * 1024;
    bytes = segments * average;
    estimated = true;
  }
  return {
    id: String(item.id || item.captureId || item.recordingId || ''),
    kind,
    bytes: Math.max(0, Math.round(bytes)),
    segments,
    sealed: item.sealed === true || item.state === 'sealed',
    pinned: item.pinned === true || item.keep === true,
    at: Math.max(0, intOr(item.at != null ? item.at : item.createdAt, 0)),
    estimated,
  };
}

/** 压力等级：按 total/quota 与阈值给出，越界优先 full。 */
export function classifyStoragePressure(usedBytes, budgetInput = {}) {
  const budget = isPlainObject(budgetInput) && budgetInput.quotaBytes ? budgetInput : resolveStorageBudget(budgetInput);
  const used = Math.max(0, finiteNonNegative(usedBytes));
  const quota = Math.max(1, Number(budget.quotaBytes) || STORAGE_DEFAULTS.quotaBytes);
  const ratio = Math.min(1.5, used / quota);
  let pressure = 'ok';
  if (ratio >= 1) pressure = 'full';
  else if (ratio >= budget.criticalRatio) pressure = 'critical';
  else if (ratio >= budget.warnRatio) pressure = 'warn';
  return {
    pressure,
    ratio: Number(ratio.toFixed(6)),
    usedBytes: used,
    quotaBytes: quota,
    remainingBytes: Math.max(0, quota - used),
    warnRatio: budget.warnRatio,
    criticalRatio: budget.criticalRatio,
  };
}

/** 汇总当前用量：总/分 kind/条数/压力；items 可以是 map/list，元素形状同 captureFootprint。 */
export function estimateStorageUsage(items, options = {}) {
  const budget = isPlainObject(options.budget) ? options.budget : resolveStorageBudget(options);
  const list = Array.isArray(items) ? items : (items && typeof items === 'object' ? Object.values(items) : []);
  const byKind = { longshot: { bytes: 0, captures: 0 }, video: { bytes: 0, captures: 0 }, other: { bytes: 0, captures: 0 } };
  const footprints = [];
  let totalBytes = 0;
  let estimatedCaptures = 0;
  for (const item of list) {
    const footprint = captureFootprint(item);
    if (footprint.bytes <= 0 && !footprint.id) continue;
    byKind[footprint.kind].bytes += footprint.bytes;
    byKind[footprint.kind].captures += 1;
    totalBytes += footprint.bytes;
    if (footprint.estimated) estimatedCaptures += 1;
    footprints.push(footprint);
  }
  const pressure = classifyStoragePressure(totalBytes, budget);
  return {
    version: STORAGE_BUDGET_VERSION,
    captures: footprints.length,
    totalBytes,
    byKind,
    footprints,
    estimatedCaptures,
    shares: budget.shares,
    quotaBytes: budget.quotaBytes,
    reserveBytes: budget.reserveBytes,
    pressure: pressure.pressure,
    ratio: pressure.ratio,
    remainingBytes: pressure.remainingBytes,
    codes: [
      ...(pressure.pressure === 'full' ? [STORAGE_CODES.CRITICAL] : []),
      ...(pressure.pressure === 'critical' ? [STORAGE_CODES.CRITICAL] : []),
      ...(pressure.pressure === 'warn' ? [STORAGE_CODES.WARN] : []),
      ...(pressure.pressure === 'ok' ? [STORAGE_CODES.OK] : []),
      ...(estimatedCaptures ? [STORAGE_CODES.UNKNOWN] : []),
    ],
  };
}

/** 单个 kind 的剩余配额（考虑份额与已用量）。 */
export function kindAllowance(usage, kind, budgetInput = {}) {
  const budget = isPlainObject(budgetInput) && budgetInput.quotaBytes ? budgetInput : resolveStorageBudget(budgetInput);
  const normalized = normalizeStorageKind(kind);
  const share = budget.shares[normalized] != null ? budget.shares[normalized] : 0;
  const allowance = Math.floor(budget.quotaBytes * share);
  const used = usage && usage.byKind && usage.byKind[normalized] ? usage.byKind[normalized].bytes : 0;
  return {
    kind: normalized,
    share,
    allowanceBytes: allowance,
    usedBytes: used,
    remainingBytes: Math.max(0, allowance - used),
    over: used > allowance,
  };
}

/**
 * 淘汰选择：给定需要腾出的字节，从候选里挑“代价最小”的一批。
 * 保护规则：pinned、未封版且未过期（仍可恢复）、小于 minAgeMs 的新产物都不参与淘汰。
 * 排序：过期 → 已封版 → 越旧越先；同条件下先删小的（少牺牲一个 capture 就能腾出空间）。
 */
export function selectEvictions(captures, needBytes, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const budget = isPlainObject(options.budget) && options.budget.quotaBytes ? options.budget : resolveStorageBudget(options);
  const needed = Math.max(0, intOr(needBytes, 0));
  const footprints = (Array.isArray(captures) ? captures : []).map(captureFootprint);
  const candidates = [];
  const protectedEntries = [];
  for (const footprint of footprints) {
    const age = footprint.at > 0 ? Math.max(0, now - footprint.at) : 0;
    const expired = budget.ttlMs > 0 && footprint.at > 0 && age > budget.ttlMs;
    if (footprint.pinned) {
      protectedEntries.push({ ...footprint, protect: 'pinned' });
      continue;
    }
    // 写入时间未知（老索引没有 at）的产物不能当作“最旧”淘汰：先保留并在证据里标明。
    if (footprint.at <= 0) {
      protectedEntries.push({ ...footprint, protect: 'unknown-age' });
      continue;
    }
    if (!footprint.sealed && !expired) {
      protectedEntries.push({ ...footprint, protect: 'unsealed' });
      continue;
    }
    if (age < budget.minAgeMs && !expired) {
      protectedEntries.push({ ...footprint, protect: 'fresh' });
      continue;
    }
    candidates.push({ ...footprint, age, expired, priority: expired ? 0 : (footprint.sealed ? 1 : 2) });
  }
  candidates.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.at !== right.at) return left.at - right.at;
    return left.bytes - right.bytes;
  });
  const evicted = [];
  let freed = 0;
  for (const candidate of candidates) {
    if (freed >= needed) break;
    const remainingSlots = footprints.length - evicted.length;
    if (remainingSlots <= budget.minKeep) break;
    evicted.push({
      id: candidate.id,
      kind: candidate.kind,
      bytes: candidate.bytes,
      at: candidate.at,
      expired: candidate.expired,
      reason: candidate.expired ? 'expired' : (candidate.sealed ? 'sealed-oldest' : 'unsealed-oldest'),
    });
    freed += candidate.bytes;
  }
  return {
    neededBytes: needed,
    freedBytes: freed,
    satisfied: freed >= needed,
    shortfallBytes: Math.max(0, needed - freed),
    evicted,
    protected: protectedEntries.slice(0, 32),
    candidates: candidates.length,
  };
}

function decisionOf({ incomingBytes, allowanceBytes, pressure, eviction, budget }) {
  const overQuota = incomingBytes > 0 && pressure.remainingBytes + eviction.freedBytes < incomingBytes;
  if (overQuota) return { action: 'reject', code: STORAGE_CODES.REJECT, detail: '即使淘汰也放不下这次采集' };
  if (incomingBytes > 0 && incomingBytes > allowanceBytes) return { action: 'reject', code: STORAGE_CODES.REJECT, detail: '单次采集超过该 kind 的配额份额' };
  if (incomingBytes > 0 && incomingBytes > budget.quotaBytes * budget.maxCaptureRatio) return { action: 'reject', code: STORAGE_CODES.REJECT, detail: '单次采集超过配额比例上限' };
  if (eviction.evicted.length > 0) return { action: 'evict', code: STORAGE_CODES.EVICT, detail: '先淘汰过期/最旧产物再写入' };
  if (incomingBytes > 0 && pressure.remainingBytes < incomingBytes) return { action: 'evict', code: STORAGE_CODES.EVICT, detail: '剩余空间不足，需要淘汰' };
  if (pressure.pressure === 'critical') return { action: 'warn', code: STORAGE_CODES.CRITICAL, detail: '配额接近用完，允许写入但需告警' };
  if (pressure.pressure === 'warn') return { action: 'warn', code: STORAGE_CODES.WARN, detail: '配额已过告警水位' };
  return { action: 'accept', code: STORAGE_CODES.OK, detail: '配额充足' };
}

/**
 * 新采集进来前的存储预算决策。
 *
 * @param {{
 *   captures?: object[], usedBytes?: number, incomingBytes?: number,
 *   kind?: string, quotaBytes?: number, ...budget,
 * }} [options]
 * @returns {object} plan（action/allowance/eviction/pressure/evidence）
 */
export function planStorageBudget(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const budget = resolveStorageBudget(options);
  const usage = estimateStorageUsage(options.captures || [], { budget });
  const usedBytes = Math.max(finiteNonNegative(options.usedBytes), usage.totalBytes);
  const pressure = classifyStoragePressure(usedBytes, budget);
  const kind = normalizeStorageKind(options.kind || 'longshot');
  const allowance = kindAllowance({ ...usage, byKind: usage.byKind }, kind, budget);
  const incomingBytes = Math.max(0, intOr(options.incomingBytes, 0));
  const needToFree = Math.max(0, usedBytes + incomingBytes + budget.reserveBytes - budget.quotaBytes);
  const eviction = needToFree > 0
    ? selectEvictions(options.captures || [], needToFree, { now, budget })
    : { neededBytes: 0, freedBytes: 0, satisfied: true, shortfallBytes: 0, evicted: [], protected: [], candidates: 0 };
  const decision = decisionOf({ incomingBytes, allowanceBytes: allowance.allowanceBytes, pressure, eviction, budget });
  const projectedBytes = Math.max(0, usedBytes + incomingBytes - eviction.freedBytes);
  return {
    version: STORAGE_BUDGET_VERSION,
    ok: decision.action !== 'reject',
    action: decision.action,
    code: decision.code,
    detail: decision.detail,
    kind,
    now,
    budget,
    usage: {
      captures: usage.captures,
      totalBytes: usedBytes,
      byKind: usage.byKind,
      estimatedCaptures: usage.estimatedCaptures,
    },
    pressure,
    allowance,
    incomingBytes,
    eviction,
    projectedBytes,
    projectedRatio: Number((projectedBytes / budget.quotaBytes).toFixed(6)),
    evidence: {
      now,
      action: decision.action,
      code: decision.code,
      usedBytes,
      incomingBytes,
      freedBytes: eviction.freedBytes,
      projectedBytes,
      pressure: pressure.pressure,
      evicted: eviction.evicted.length,
      protected: eviction.protected.length,
      quotaBytes: budget.quotaBytes,
    },
  };
}

/** 预算计划 → 协议字段（列表截断，键集稳定）。 */
export function storageBudgetWire(plan, options = {}) {
  if (!isPlainObject(plan)) {
    return { version: STORAGE_BUDGET_VERSION, ok: false, action: 'accept', code: STORAGE_CODES.UNKNOWN };
  }
  const limit = clampInt(options.maxListed, 0, 32, 6);
  return {
    version: STORAGE_BUDGET_VERSION,
    ok: plan.ok === true,
    action: String(plan.action || 'accept'),
    code: plan.code || STORAGE_CODES.UNKNOWN,
    kind: plan.kind || 'longshot',
    detail: String(plan.detail || ''),
    usage: plan.usage ? { captures: plan.usage.captures, totalBytes: plan.usage.totalBytes, byKind: plan.usage.byKind } : null,
    pressure: plan.pressure ? { pressure: plan.pressure.pressure, ratio: plan.pressure.ratio, remainingBytes: plan.pressure.remainingBytes } : null,
    incomingBytes: plan.incomingBytes || 0,
    projectedBytes: plan.projectedBytes || 0,
    projectedRatio: plan.projectedRatio || 0,
    evicted: (plan.eviction && Array.isArray(plan.eviction.evicted) ? plan.eviction.evicted : []).slice(0, limit),
    protectedCount: plan.eviction && Array.isArray(plan.eviction.protected) ? plan.eviction.protected.length : 0,
    text: describeStorageBudget(plan),
  };
}

/** 一行日志：'存储预算 accept：已用 120.0MB/512.0MB（warn 水位未到）'。 */
export function describeStorageBudget(plan) {
  if (!isPlainObject(plan)) return '存储预算 无';
  const usage = plan.usage || {};
  const toMb = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);
  return '存储预算 ' + String(plan.action || 'accept') +
    '：已用 ' + toMb(usage.totalBytes) + 'MB/' + toMb(plan.budget ? plan.budget.quotaBytes : 0) + 'MB' +
    (plan.incomingBytes ? '，新增 ' + toMb(plan.incomingBytes) + 'MB' : '') +
    (plan.eviction && plan.eviction.evicted.length ? '，淘汰 ' + plan.eviction.evicted.length + ' 条（' + toMb(plan.eviction.freedBytes) + 'MB）' : '') +
    '（' + String(plan.detail || '') + '）';
}
