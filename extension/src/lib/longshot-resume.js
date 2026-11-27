// lib/longshot-resume.js —— 长截图断点（checkpoint）与恢复决策（纯函数）。
//
// 现状：lib/longshot-manifest.js 的 resumeLongshotManifest() 只回答“每个段能不能复用/要不要重取”，
// 它是**单次恢复**的判定，没有“这次 capture 的进度到哪、还能不能接着拍、拍下去要多少预算”的
// 语义。真实运行时（tiled-capture 分段 / 滚动长截图）需要的是：
//   1) 断点：拍完第 k 段时把进度、预算、段 hash、DPR、页面签名落一份 checkpoint，
//      浏览器/SW 崩溃后能判断“接着拍”还是“必须重拍”；
//   2) 恢复决策：checkpoint 新鲜 + 段还在 → resume（只补缺段）；checkpoint 过期但分片还在
//      → restart（重拍，但可复用已校验通过的段做对比证据）；没有分片 → skip；
//   3) 幂等重放：恢复过程中重复收到的段不能重复计数（网络/消息重发），也不能把乱序段算进去；
//   4) 预算延续：恢复也要吃同一份预算，剩余 tile 数 × 单 tile 字节 > 剩余预算时必须降级/放弃。
//
// 本模块只做决策与状态推演，不碰 IndexedDB/画布：
//   createCheckpoint()/checkpointFromManifest() —— 造断点（运行时落盘用）；
//   validateCheckpoint()/checkpointDigest()    —— 结构与摘要自检；
//   planResume()        —— 决策：done/continue/resume/rewrite/restart/skip + 待拍段 + 预算证据；
//   applyResumeSegments() —— 幂等吸收恢复出来的段（重复/越界只记证据，不重复计数）；
//   resumeProgress()/resumeSummary()/resumeWire()/describeResume()。

import { hashLongshotBytes } from './longshot-manifest.js';

export const CHECKPOINT_VERSION = 1;

export const RESUME_ACTIONS = Object.freeze(['done', 'continue', 'resume', 'rewrite', 'restart', 'skip']);

export const CHECKPOINT_DEFAULTS = Object.freeze({
  // 断点默认新鲜期：和 longshot-manifest 的 TTL 同量级，但更短（页面布局半小时内大概率变了）。
  maxAgeMs: 30 * 60 * 1000,
  // 同一次 capture 最多续拍次数（超过说明页面一直在变，应该放弃而不是无限续）。
  maxAttempts: 3,
  // 恢复时单个 tile 的估算字节（预算换算用；与 capture-stream 的 chunk 量级一致）。
  estimatedTileBytes: 96 * 1024,
});

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isoAt(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return new Date(number).toISOString();
  const date = typeof value === 'string' ? new Date(value) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  return new Date(fallback).toISOString();
}

function timeOf(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDone(done) {
  const list = Array.isArray(done) ? done : [];
  const set = new Set();
  for (const value of list) {
    const index = intOr(value && typeof value === 'object' ? value.index : value, -1);
    if (index >= 0) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 造断点。
 * @param {{
 *   captureId: string, total: number, done?: Array<number|object>, dpr?: number,
 *   width?: number, height?: number, url?: string, tabId?: number,
 *   segments?: Array<object>, budget?: object, used?: object, attempts?: number,
 *   state?: string, now?: number, signature?: string,
 * }} params
 */
export function createCheckpoint(params = {}) {
  const captureId = String(params.captureId || params.longshotId || '');
  if (!captureId) throw new Error('checkpoint 需要 captureId');
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  const segments = (Array.isArray(params.segments) ? params.segments : []).map((segment, index) => ({
    index: Math.max(0, intOr(segment && segment.index, index)),
    offset: Math.max(0, intOr(segment && (segment.offset != null ? segment.offset : segment.drawY), 0)),
    bytes: Math.max(0, intOr(segment && segment.bytes, 0)),
    hash: String(segment && segment.hash || '').toLowerCase(),
  }));
  const done = normalizeDone(params.done != null ? params.done : segments);
  const total = Math.max(0, intOr(params.total, Math.max(done.length, segments.length)));
  return {
    version: CHECKPOINT_VERSION,
    captureId,
    url: String(params.url || '').slice(0, 2048),
    tabId: Number.isInteger(Number(params.tabId)) ? Number(params.tabId) : null,
    dpr: numOr(params.dpr, 1) > 0 ? Math.round(numOr(params.dpr, 1) * 1000) / 1000 : 1,
    width: Math.max(0, intOr(params.width, 0)),
    height: Math.max(0, intOr(params.height, 0)),
    total,
    done,
    segments,
    used: {
      tiles: Math.max(0, intOr(params.used && params.used.tiles, done.length)),
      bytes: Math.max(0, intOr(params.used && params.used.bytes, segments.reduce((sum, segment) => sum + segment.bytes, 0))),
      elapsedMs: Math.max(0, intOr(params.used && params.used.elapsedMs, 0)),
    },
    budget: params.budget && typeof params.budget === 'object' ? {
      maxTiles: Math.max(0, intOr(params.budget.maxTiles, 0)),
      maxBytes: Math.max(0, intOr(params.budget.maxBytes, 0)),
      maxSegmentHeight: Math.max(0, intOr(params.budget.maxSegmentHeight, 0)),
    } : null,
    attempts: Math.max(0, intOr(params.attempts, 0)),
    state: String(params.state || 'capturing'),
    signature: String(params.signature || ''),
    createdAt: isoAt(params.createdAt != null ? params.createdAt : now, now),
    updatedAt: isoAt(now, now),
  };
}

/** 从 manifest 反推断点（恢复路径：只有索引没有 checkpoint 时用）。 */
export function checkpointFromManifest(manifest, options = {}) {
  const source = manifest && typeof manifest === 'object' ? manifest : null;
  if (!source) return null;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return createCheckpoint({
    captureId: source.captureId,
    url: source.url,
    tabId: source.tabId,
    total: Math.max(0, intOr(source.total, 0)),
    dpr: source.dpr,
    width: source.width,
    height: source.height,
    segments: Array.isArray(source.segments) ? source.segments : [],
    done: (Array.isArray(source.segments) ? source.segments : []).map((segment) => intOr(segment && segment.index, 0)),
    budget: options.budget,
    attempts: options.attempts,
    state: source.sealed === true ? 'sealed' : 'capturing',
    createdAt: timeOf(source.createdAt, now),
    now: Math.min(now, timeOf(source.updatedAt, now)),
    signature: 'manifest:' + String(source.sealed === true ? 'sealed' : 'partial'),
  });
}

/** 结构自检：版本/序号/覆盖率/时间。 */
export function validateCheckpoint(checkpoint) {
  const errors = [];
  const push = (code, message) => errors.push({ code, message });
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
    return { ok: false, errors: [{ code: 'not-object', message: 'checkpoint 不是对象' }] };
  }
  if (intOr(checkpoint.version, -1) !== CHECKPOINT_VERSION) {
    push('version', 'checkpoint 版本应为 ' + CHECKPOINT_VERSION + '，实际 ' + checkpoint.version);
  }
  if (!checkpoint.captureId || typeof checkpoint.captureId !== 'string') push('captureId', 'checkpoint 缺少 captureId');
  const total = intOr(checkpoint.total, -1);
  if (total < 0) push('total', 'checkpoint total 必须非负');
  const done = Array.isArray(checkpoint.done) ? checkpoint.done : null;
  if (!done) push('done', 'checkpoint done 必须是数组');
  else {
    const seen = new Set();
    for (const raw of done) {
      const index = intOr(raw, -1);
      if (index < 0 || index >= Math.max(total, 0)) push('done-range', 'done 中的序号越界：' + raw);
      if (seen.has(index)) push('done-dup', 'done 中序号重复：' + index);
      seen.add(index);
    }
    if (total > 0 && done.length > total) push('done-overflow', 'done 数量超过 total');
  }
  const dpr = Number(checkpoint.dpr);
  if (!Number.isFinite(dpr) || dpr < 1 || dpr > 3) push('dpr', 'checkpoint dpr 必须在 1–3，实际 ' + checkpoint.dpr);
  if (!Number.isFinite(Date.parse(String(checkpoint.createdAt)))) push('createdAt', 'checkpoint createdAt 非法');
  if (!Number.isFinite(Date.parse(String(checkpoint.updatedAt)))) push('updatedAt', 'checkpoint updatedAt 非法');
  if (checkpoint.budget && intOr(checkpoint.budget.maxTiles, -1) < 0) push('budget', 'checkpoint budget 非法');
  return { ok: errors.length === 0, errors };
}

/** 断点摘要：不含时间字段，用于去重/比对（落到 storage 前后不应变化）。 */
export function checkpointDigest(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const segments = Array.isArray(checkpoint.segments) ? checkpoint.segments : [];
  const canonical = [
    intOr(checkpoint.version, 0),
    String(checkpoint.captureId || ''),
    intOr(checkpoint.total, 0),
    numOr(checkpoint.dpr, 1),
    intOr(checkpoint.width, 0),
    intOr(checkpoint.height, 0),
    normalizeDone(checkpoint.done).join(','),
    segments.map((segment) => intOr(segment.index, 0) + ':' + intOr(segment.offset, 0) + ':' + intOr(segment.bytes, 0) + ':' + String(segment.hash || '')).join(';'),
    String(checkpoint.signature || ''),
  ].join('|');
  return hashLongshotBytes(canonical);
}

/**
 * 恢复决策（核心）。
 *
 * @param {{
 *   checkpoint: object|null,
 *   manifest?: object|null,
 *   total?: number,
 *   available?: Array<number|object>,
 *   now?: number, maxAgeMs?: number, attempts?: number,
 *   budget?: object|null,
 *   pageSignature?: string,
 * }} params
 * @returns {{
 *   ok: boolean, action: string, total: number, done: number[], pending: number[],
 *   tiles: Array<object>, reasons: string[], expired: boolean, ageMs: number,
 *   budget: object|null, evidence: object,
 * }}
 */
export function planResume(params = {}) {
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  const maxAgeMs = Math.max(0, intOr(params.maxAgeMs, CHECKPOINT_DEFAULTS.maxAgeMs));
  const maxAttempts = Math.max(1, clampInt(params.maxAttempts, 1, 100, CHECKPOINT_DEFAULTS.maxAttempts));
  const estimatedTileBytes = Math.max(1, intOr(params.estimatedTileBytes, CHECKPOINT_DEFAULTS.estimatedTileBytes));
  const checkpoint = params.checkpoint && typeof params.checkpoint === 'object' ? params.checkpoint : null;
  const manifest = params.manifest && typeof params.manifest === 'object' ? params.manifest : null;
  const availableList = Array.isArray(params.available) ? params.available : [];
  const available = new Set();
  for (const item of availableList) {
    const index = intOr(item && typeof item === 'object' ? item.index : item, -1);
    if (index >= 0) available.add(index);
  }
  const total = Math.max(
    0,
    intOr(params.total, checkpoint ? intOr(checkpoint.total, 0) : intOr(manifest && manifest.total, 0)),
  );
  const doneFromCheckpoint = checkpoint ? normalizeDone(checkpoint.done) : [];
  // 区分“调用方没报盘上分片”（available 未提供 → 信任 checkpoint）与
  // “报了但一个都没有”（available: [] → checkpoint 的段全丢了，必须重拍）。
  const availableProvided = params.available != null;
  const done = availableProvided ? doneFromCheckpoint.filter((index) => available.has(index)) : doneFromCheckpoint;
  const pending = [];
  for (let index = 0; index < total; index += 1) if (!done.includes(index)) pending.push(index);
  const attempts = Math.max(0, intOr(params.attempts, checkpoint ? intOr(checkpoint.attempts, 0) : 0));
  const evidence = {
    now,
    checkpointVersion: checkpoint ? intOr(checkpoint.version, 0) : 0,
    checkpointDigest: checkpointDigest(checkpoint),
    total,
    doneCount: done.length,
    pendingCount: pending.length,
    availableCount: available.size,
    attempts,
    maxAttempts,
    maxAgeMs,
  };
  const budgetPlan = planResumeBudget({
    checkpoint,
    manifest,
    pending,
    used: checkpoint ? checkpoint.used : null,
    budget: params.budget || (checkpoint ? checkpoint.budget : null),
    estimatedTileBytes,
  });
  const reasons = [];
  if (!checkpoint && !manifest) {
    return {
      ok: true, action: 'skip', total, done: [], pending, tiles: pending.map((index) => ({ index, reason: 'no-checkpoint' })),
      reasons: ['没有 checkpoint/manifest，无法断点恢复'], expired: false, ageMs: 0, budget: budgetPlan, evidence,
    };
  }
  if (!(total > 0)) {
    return {
      ok: true, action: 'skip', total: 0, done: [], pending: [],
      reasons: ['total 未知（0），不能判断缺哪些段'], expired: false, ageMs: 0, budget: budgetPlan, evidence,
    };
  }
  if (!pending.length) {
    const sealed = (checkpoint && checkpoint.state === 'sealed') || (manifest && manifest.sealed === true);
    return {
      ok: true, action: 'done', total, done, pending: [],
      reasons: [sealed ? '断点显示所有段已拍完并封版' : '断点显示所有段已拍完'],
      expired: false, ageMs: 0, budget: budgetPlan, evidence,
    };
  }
  if (attempts >= maxAttempts) {
    return {
      ok: true, action: 'skip', total, done, pending,
      reasons: ['续拍次数已达上限 ' + attempts + '/' + maxAttempts + '，放弃而不是无限续'],
      expired: false, ageMs: 0, budget: budgetPlan, evidence,
    };
  }
  const updatedAt = checkpoint ? timeOf(checkpoint.updatedAt, now) : timeOf(manifest && manifest.updatedAt, now);
  const ageMs = Math.max(0, now - updatedAt);
  const expired = ageMs > maxAgeMs;
  const pageSignature = String(params.pageSignature || '');
  const signatureChanged = Boolean(pageSignature && checkpoint && checkpoint.signature && checkpoint.signature !== pageSignature);
  const style = checkpoint ? String(checkpoint.state || '') : '';
  if (expired) reasons.push('checkpoint 过期（' + Math.round(ageMs / 1000) + 's > ' + Math.round(maxAgeMs / 1000) + 's）');
  if (signatureChanged) reasons.push('页面签名变化（' + checkpoint.signature + ' → ' + pageSignature + '）');
  if (!available.size && doneFromCheckpoint.length && availableProvided) {
    // checkpoint 说拍过、但盘上一段都没有：分片被清理，必须整页重拍。
    return {
      ok: true, action: 'restart', total, done: [], pending: pending.length ? pending : [...Array(total).keys()],
      tiles: pending.map((index) => ({ index, reason: 'missing-shard' })),
      reasons: reasons.concat(['checkpoint 记录的段在存储中全部缺失，整页重拍']),
      expired, ageMs, budget: budgetPlan, evidence,
    };
  }
  if (expired || signatureChanged) {
    return {
      ok: true, action: 'restart', total, done: [], pending,
      tiles: pending.map((index) => ({ index, reason: expired ? 'expired' : 'signature' })),
      reasons: reasons.concat(['断点不可信，从第 0 段重拍（已有段保留为对照证据）']),
      expired, ageMs, budget: budgetPlan, evidence,
    };
  }
  if (budgetPlan && budgetPlan.exhausted) {
    return {
      ok: true, action: 'rewrite', total, done, pending,
      tiles: pending.map((index) => ({ index, reason: 'budget' })),
      reasons: reasons.concat(['恢复预算不足：待拍 ' + pending.length + ' 段需要约 ' + budgetPlan.estimatedBytes + ' 字节，剩余 ' + budgetPlan.remainingBytes]),
      expired, ageMs, budget: budgetPlan, evidence,
    };
  }
  if (style === 'stale') reasons.push('上次 capture 以 stale 状态中断');
  return {
    ok: true,
    action: done.length ? 'resume' : 'continue',
    total,
    done,
    pending,
    tiles: pending.map((index) => ({ index, reason: available.size && doneFromCheckpoint.length ? 'missing' : 'pending' })),
    reasons: reasons.concat([done.length ? '复用以校验通过的 ' + done.length + ' 段，只补 ' + pending.length + ' 段' : '断点新鲜但还没有可用段，从头拍']),
    expired: false,
    ageMs,
    budget: budgetPlan,
    evidence,
  };
}

/** 恢复预算：剩余字节/剩余 tile 数与预计成本（不超预算才允许 resume）。 */
export function planResumeBudget(params = {}) {
  const checkpoint = params.checkpoint && typeof params.checkpoint === 'object' ? params.checkpoint : null;
  const budget = params.budget && typeof params.budget === 'object' ? params.budget : null;
  const pending = Array.isArray(params.pending) ? params.pending : [];
  const estimatedTileBytes = Math.max(1, intOr(params.estimatedTileBytes, CHECKPOINT_DEFAULTS.estimatedTileBytes));
  const used = params.used && typeof params.used === 'object' ? params.used : (checkpoint ? checkpoint.used || {} : {});
  const usedTiles = Math.max(0, intOr(used.tiles, 0));
  const usedBytes = Math.max(0, intOr(used.bytes, 0));
  if (!budget) {
    return {
      known: false,
      exhausted: false,
      remainingTiles: 0,
      remainingBytes: 0,
      estimatedTiles: pending.length,
      estimatedBytes: pending.length * estimatedTileBytes,
      usedTiles,
      usedBytes,
    };
  }
  const maxTiles = Math.max(0, intOr(budget.maxTiles, 0));
  const maxBytes = Math.max(0, intOr(budget.maxBytes, 0));
  const remainingTiles = maxTiles > 0 ? Math.max(0, maxTiles - usedTiles) : Infinity;
  const remainingBytes = maxBytes > 0 ? Math.max(0, maxBytes - usedBytes) : Infinity;
  const estimatedBytes = pending.length * estimatedTileBytes;
  const exhausted = pending.length > remainingTiles || estimatedBytes > remainingBytes;
  return {
    known: true,
    exhausted,
    remainingTiles: Number.isFinite(remainingTiles) ? remainingTiles : -1,
    remainingBytes: Number.isFinite(remainingBytes) ? remainingBytes : -1,
    estimatedTiles: pending.length,
    estimatedBytes,
    usedTiles,
    usedBytes,
    maxTiles,
    maxBytes,
  };
}

/**
 * 幂等吸收恢复出来的段：重复/越界/乱序都只记证据，不重复计数。
 * @returns {{checkpoint: object, accepted: number[], duplicates: number[], outOfRange: number[], changed: boolean}}
 */
export function applyResumeSegments(checkpoint, received, options = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { checkpoint, accepted: [], duplicates: [], outOfRange: [], changed: false };
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const total = Math.max(0, intOr(checkpoint.total, 0));
  const done = new Set(normalizeDone(checkpoint.done));
  const segments = (Array.isArray(checkpoint.segments) ? checkpoint.segments : []).slice();
  const byIndex = new Map(segments.map((segment) => [intOr(segment.index, 0), segment]));
  const accepted = [];
  const duplicates = [];
  const outOfRange = [];
  for (const raw of Array.isArray(received) ? received : []) {
    const segment = raw && typeof raw === 'object' ? raw : { index: raw };
    const index = intOr(segment.index, -1);
    if (index < 0 || (total > 0 && index >= total)) {
      outOfRange.push(index);
      continue;
    }
    if (done.has(index)) {
      duplicates.push(index);
      continue;
    }
    done.add(index);
    accepted.push(index);
    byIndex.set(index, {
      index,
      offset: Math.max(0, intOr(segment.offset != null ? segment.offset : segment.drawY, 0)),
      bytes: Math.max(0, intOr(segment.bytes, 0)),
      hash: String(segment.hash || '').toLowerCase(),
    });
  }
  const nextDone = [...done].sort((a, b) => a - b);
  const nextSegments = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const usedBytes = nextSegments.reduce((sum, segment) => sum + intOr(segment.bytes, 0), 0);
  const changed = accepted.length > 0;
  return {
    checkpoint: changed ? {
      ...checkpoint,
      done: nextDone,
      segments: nextSegments,
      used: { tiles: nextDone.length, bytes: usedBytes, elapsedMs: Math.max(0, intOr(checkpoint.used && checkpoint.used.elapsedMs, 0)) },
      updatedAt: isoAt(now, now),
    } : checkpoint,
    accepted,
    duplicates,
    outOfRange,
    changed,
  };
}

/** 进度：done/total + 比例（total 未知时比例记 0，不伪造 100%）。 */
export function resumeProgress(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return { done: 0, total: 0, ratio: 0, complete: false };
  const total = Math.max(0, intOr(checkpoint.total, 0));
  const done = normalizeDone(checkpoint.done).length;
  const ratio = total > 0 ? Math.min(1, Math.round((done / total) * 1000) / 1000) : 0;
  return { done, total, ratio, complete: total > 0 && done >= total };
}

/** 协议 wire：断点摘要（不含大字段 segments 明细，最多 8 条）。 */
export function resumeWire(resumePlan, options = {}) {
  const plan = resumePlan && typeof resumePlan === 'object' ? resumePlan : {};
  const maxTiles = Math.max(0, Math.min(64, intOr(options.maxTiles, 8)));
  return {
    action: String(plan.action || 'skip'),
    total: Math.max(0, intOr(plan.total, 0)),
    done: (Array.isArray(plan.done) ? plan.done : []).slice(0, maxTiles),
    pending: (Array.isArray(plan.pending) ? plan.pending : []).slice(0, maxTiles),
    pendingCount: (Array.isArray(plan.pending) ? plan.pending : []).length,
    tiles: (Array.isArray(plan.tiles) ? plan.tiles : []).slice(0, maxTiles).map((tile) => ({
      index: intOr(tile && tile.index, 0),
      reason: String(tile && tile.reason || 'pending'),
    })),
    expired: plan.expired === true,
    ageMs: Math.max(0, intOr(plan.ageMs, 0)),
    reasons: (Array.isArray(plan.reasons) ? plan.reasons : []).slice(-4),
    budget: plan.budget && plan.budget.known !== false ? {
      exhausted: plan.budget.exhausted === true,
      estimatedBytes: intOr(plan.budget.estimatedBytes, 0),
      remainingBytes: intOr(plan.budget.remainingBytes, 0),
      remainingTiles: intOr(plan.budget.remainingTiles, 0),
    } : null,
    evidence: plan.evidence || {},
  };
}

/** 一行日志：'断点恢复 resume：已拍 12/40，补 28 段（新鲜 3.2s）'。 */
export function describeResume(resumePlan) {
  if (!resumePlan || typeof resumePlan !== 'object') return '断点 无';
  const total = intOr(resumePlan.total, 0);
  const done = Array.isArray(resumePlan.done) ? resumePlan.done.length : 0;
  const pending = Array.isArray(resumePlan.pending) ? resumePlan.pending.length : 0;
  const age = intOr(resumePlan.ageMs, 0);
  return '断点恢复 ' + String(resumePlan.action || 'skip') + '：已拍 ' + done + '/' + total +
    '，补 ' + pending + ' 段' + (age > 0 ? '（断点 ' + Math.round(age / 100) / 10 + 's 前）' : '') +
    (resumePlan.expired ? ' [过期]' : '');
}

/** 断点清单：用于两次恢复之间比对“哪些段是新拍的”。 */
export function checkpointDiff(before, after) {
  const left = new Set(normalizeDone(before && before.done));
  const right = new Set(normalizeDone(after && after.done));
  const added = [...right].filter((index) => !left.has(index)).sort((a, b) => a - b);
  const removed = [...left].filter((index) => !right.has(index)).sort((a, b) => a - b);
  return { added, removed, unchanged: [...left].filter((index) => right.has(index)).length };
}
