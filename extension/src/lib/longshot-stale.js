// lib/longshot-stale.js —— 长截图 stale 分类、重试阶梯与重试预算（纯函数）。
//
// 现状：lib/capture-freshness.js 只有两件事——staleMetrics() 比对 5 个布局字段、
// planStaleRecovery() 给出 accept/extend/rewrite/retry 四种动作。运行时（tiled-capture /
// screenshot.captureFullPage）拿到这两个结果后只能“重试一次”，于是：
//   1) 页面持续增长（无限滚动列表）时会陷入“拍一半→stale→重拍整页”的循环，没有重试阶梯；
//   2) 不同 stale 原因（高度增长/宽度变化/仅 revision 变/固定带漂移/dpr 变化）处理代价差几个
//      数量级，却都走同一个分支，日志里只有 changed 字段名，看不出“为什么”；
//   3) 重试本身吃预算（tile 数、字节、时间），没有预算闸门就会在超大页上反复重拍把预算打穿。
//
// 本模块不重造 stale 检测（继续用 capture-freshness 的字段比对与动作判定），只在其上做：
//   staleSignature()   —— 比 capture-freshness 更宽的页面签名（含 dpr/固定带/滚动位置无关字段）；
//   classifyStaleChange()/classifyStale() —— 逐字段归因（growth/width/revision/bands/dpr/viewport）；
//   planStaleRetry()   —— 动作 + 尝试次数 + 阶梯退避 + 是否降级/放弃（带预算闸门）；
//   staleWave()        —— 一次 stale 波及了哪些段（哪些段必须重画）；
//   staleBudgetGate()  —— 重试预算（tile/字节/时间）剩余量；
//   summarizeStaleRetries()/describeStaleRetry()/staleRetryWire()。
//
// 重要约束：本模块的 classify* 只**附加**归因信息，不改变 capture-freshness 的 stale 判定；
// 旧路径不传 options 时行为完全不变（capture-freshness 只在有 longshot-stale 时才附加字段）。

export const STALE_DEFAULTS = Object.freeze({
  // 与 capture-freshness 默认容差一致。
  tolerance: 1,
  // 同一张贴图内最多重试次数（超了就接受现状并标记 degraded，而不是无限重拍）。
  maxAttempts: 2,
  // 阶梯退避（毫秒）：第 1 次立即重拍、第 2 次等 200ms、第 3 次等 600ms；运行时 sleep 用。
  backoffMs: Object.freeze([0, 200, 600]),
  // 重试预算：最多再多拍多少 tile / 多少字节。
  maxRetryTiles: 96,
  maxRetryBytes: 96 * 1024 * 1024,
  maxRetryMs: 120000,
});

export const STALE_KINDS = Object.freeze([
  'growth',
  'shrink',
  'width',
  'viewport',
  'revision',
  'bands',
  'dpr',
  'unknown',
]);

const COMPARED_FIELDS = Object.freeze([
  'scrollHeight',
  'scrollWidth',
  'innerWidth',
  'innerHeight',
  'dpr',
  'fixedTopHeight',
  'fixedBottomHeight',
  'revision',
]);

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 页面签名：比 capture-freshness 的比对面更宽（含 dpr / 固定带高度 / 文档元素尺寸）。
 * 不含 scrollY —— 滚动位置变化不是 stale。
 */
export function staleSignature(metrics) {
  if (!metrics || typeof metrics !== 'object') return 'stale:none';
  const fields = [
    intOr(metrics.scrollHeight, 0),
    intOr(metrics.scrollWidth, 0),
    intOr(metrics.innerWidth, 0),
    intOr(metrics.innerHeight, 0),
    Math.round(numOr(metrics.dpr, 1) * 1000) / 1000,
    intOr(metrics.fixedTopHeight, 0),
    intOr(metrics.fixedBottomHeight, 0),
    intOr(metrics.revision, 0),
  ];
  return 'stale:' + fields.join(':');
}

/** 逐字段归因：一个 field 变化 → 一个 kind + 影响面。 */
export function classifyStaleChange(change) {
  const field = String(change && change.field || '');
  const before = numOr(change && change.before, 0);
  const after = numOr(change && change.after, 0);
  const delta = Math.round((after - before) * 1000) / 1000;
  let kind = 'unknown';
  let costs = 'full'; // full=整页重拍, extend=只补新增, rewrite=逐段重写, accept=可接受
  let severity = 1;
  switch (field) {
    case 'scrollHeight':
      kind = delta > 0 ? 'growth' : 'shrink';
      costs = delta > 0 ? 'extend' : 'full';
      severity = Math.min(3, 1 + Math.floor(Math.abs(delta) / 2000));
      break;
    case 'scrollWidth':
      kind = 'width';
      costs = 'full';
      severity = 3;
      break;
    case 'innerWidth':
    case 'innerHeight':
      kind = 'viewport';
      costs = 'full';
      severity = 2;
      break;
    case 'dpr':
      kind = 'dpr';
      costs = 'full';
      severity = 3;
      break;
    case 'fixedTopHeight':
    case 'fixedBottomHeight':
      kind = 'bands';
      costs = 'rewrite';
      severity = 2;
      break;
    case 'revision':
      kind = 'revision';
      costs = 'rewrite';
      severity = 1;
      break;
    default:
      kind = 'unknown';
      costs = 'full';
      severity = 2;
  }
  return { field, before, after, delta, kind, costs, severity };
}

/**
 * 批量归因：返回 kinds 集合、主导原因（severity 最高者）与建议动作。
 * 建议动作不替代 planStaleRecovery，只用于日志/降级决策。
 */
export function classifyStale(changed) {
  const list = Array.isArray(changed) ? changed : [];
  const classified = list.map((item) => classifyStaleChange(item));
  const kinds = [...new Set(classified.map((item) => item.kind))];
  const severity = classified.reduce((max, item) => Math.max(max, item.severity), 0);
  const dominant = classified.slice().sort((a, b) => b.severity - a.severity || Math.abs(b.delta) - Math.abs(a.delta))[0] || null;
  let suggestion = 'accept';
  if (classified.some((item) => item.costs === 'full')) suggestion = 'retry-full';
  else if (classified.some((item) => item.costs === 'rewrite')) suggestion = 'rewrite-regions';
  else if (classified.some((item) => item.costs === 'extend')) suggestion = 'extend-tail';
  return {
    kinds,
    severity,
    dominant: dominant ? dominant.kind : null,
    detail: classified,
    suggestion,
    // 只靠 revision 变化（尺寸没动）时是“同尺寸重排”，必须逐段重写而不是重新滚动整页。
    revisionOnly: classified.length > 0 && classified.every((item) => item.kind === 'revision'),
  };
}

/** 把 longshot-segments 的段规划 + 归因结果映射成“哪些段要重画”。 */
export function staleWave(plan, classification, options = {}) {
  const segments = plan && Array.isArray(plan.segments) ? plan.segments : [];
  const kinds = classification && Array.isArray(classification.kinds) ? classification.kinds : [];
  const suggestion = classification && classification.suggestion ? classification.suggestion : 'accept';
  if (!segments.length || suggestion === 'accept') {
    return { wave: 'none', segmentIndexes: [], reason: suggestion, cost: 0 };
  }
  if (suggestion === 'extend-tail') {
    // 只向下增长：只有最后一段（以及新增区间）需要重画。
    const last = segments[segments.length - 1];
    return { wave: 'tail', segmentIndexes: [intOr(last.index, 0)], reason: suggestion, cost: 1 };
  }
  if (suggestion === 'rewrite-regions') {
    // 同尺寸重排 / 固定带漂移：按 options.affected 指定受影响的页面区间，映射到段。
    const ranges = Array.isArray(options.affected) ? options.affected : [];
    if (!ranges.length) {
      // 没有区间证据时保守重写全部段（宁可多拍也不出错图）。
      return { wave: 'all', segmentIndexes: segments.map((segment) => intOr(segment.index, 0)), reason: 'rewrite-no-range', cost: segments.length };
    }
    const indexes = new Set();
    for (const range of ranges) {
      const start = Math.max(0, intOr(range && (range.pageY != null ? range.pageY : range.y), 0));
      const height = Math.max(0, intOr(range && (range.pageHeight != null ? range.pageHeight : range.height), 0));
      for (const segment of segments) {
        const segmentStart = intOr(segment.pageY, 0);
        const segmentEnd = segmentStart + Math.max(0, intOr(segment.pageHeight, 0));
        const end = start + Math.max(1, height);
        if (start < segmentEnd && end > segmentStart) indexes.add(intOr(segment.index, 0));
      }
    }
    return {
      wave: indexes.size === segments.length ? 'all' : 'partial',
      segmentIndexes: [...indexes].sort((a, b) => a - b),
      reason: suggestion,
      cost: indexes.size,
    };
  }
  return {
    wave: 'all',
    segmentIndexes: segments.map((segment) => intOr(segment.index, 0)),
    reason: kinds.length ? kinds.join('+') : 'retry-full',
    cost: segments.length,
  };
}

/** 重试预算闸门：tiles/bytes/ms 三个维度任一耗尽即降级。 */
export function staleBudgetGate(used, options = {}) {
  const maxTiles = Math.max(0, intOr(options.maxRetryTiles, STALE_DEFAULTS.maxRetryTiles));
  const maxBytes = Math.max(0, intOr(options.maxRetryBytes, STALE_DEFAULTS.maxRetryBytes));
  const maxMs = Math.max(0, intOr(options.maxRetryMs, STALE_DEFAULTS.maxRetryMs));
  const u = used && typeof used === 'object' ? used : {};
  const tiles = Math.max(0, intOr(u.tiles, 0));
  const bytes = Math.max(0, intOr(u.bytes, 0));
  const elapsedMs = Math.max(0, intOr(u.elapsedMs, 0));
  const tilesLeft = maxTiles > 0 ? Math.max(0, maxTiles - tiles) : Infinity;
  const bytesLeft = maxBytes > 0 ? Math.max(0, maxBytes - bytes) : Infinity;
  const msLeft = maxMs > 0 ? Math.max(0, maxMs - elapsedMs) : Infinity;
  const exhausted = tilesLeft <= 0 || bytesLeft <= 0 || msLeft <= 0;
  return {
    exhausted,
    tilesLeft: Number.isFinite(tilesLeft) ? tilesLeft : -1,
    bytesLeft: Number.isFinite(bytesLeft) ? bytesLeft : -1,
    msLeft: Number.isFinite(msLeft) ? msLeft : -1,
    used: { tiles, bytes, elapsedMs },
    max: { tiles: maxTiles, bytes: maxBytes, ms: maxMs },
    reason: exhausted ? (tilesLeft <= 0 ? 'tiles' : (bytesLeft <= 0 ? 'bytes' : 'time')) : '',
  };
}

/**
 * 重试决策：动作 + 阶梯 + 是否降级/放弃。
 *
 * @param {{
 *   action?: string,           // capture-freshness.planStaleRecovery 的 action（可选）
 *   classification?: object,   // classifyStale() 结果
 *   attempt?: number,          // 本贴图第几次重试（0 基）
 *   maxAttempts?: number,
 *   waveCost?: number,         // 重试要重画的段数
 *   used?: object,             // 已用预算
 *   budget?: object,           // 覆盖默认预算
 *   now?: number,
 * }} params
 */
export function planStaleRetry(params = {}) {
  const attempt = Math.max(0, intOr(params.attempt, 0));
  const maxAttempts = Math.max(0, Math.min(8, intOr(params.maxAttempts, STALE_DEFAULTS.maxAttempts)));
  const action = String(params.action || 'retry');
  const classification = params.classification && typeof params.classification === 'object' ? params.classification : null;
  const waveCost = Math.max(0, intOr(params.waveCost, 0));
  const backoffTable = Array.isArray(params.backoffMs) && params.backoffMs.length ? params.backoffMs : STALE_DEFAULTS.backoffMs;
  const backoffMs = Math.max(0, intOr(backoffTable[Math.min(attempt, backoffTable.length - 1)], 0));
  const budget = staleBudgetGate({
    tiles: intOr(params.used && params.used.tiles, 0) + waveCost,
    bytes: intOr(params.used && params.used.bytes, 0),
    elapsedMs: intOr(params.used && params.used.elapsedMs, 0),
  }, params.budget || {});
  const reasons = [];
  if (action === 'accept') {
    return { retry: false, action: 'accept', attempt, maxAttempts, backoffMs: 0, degrade: false, reasons: ['没有 stale，直接接受'], budget };
  }
  if (attempt >= maxAttempts) {
    reasons.push('重试次数 ' + attempt + '/' + maxAttempts + ' 用尽，接受现状并标记 degraded');
    return { retry: false, action: 'accept', attempt, maxAttempts, backoffMs: 0, degrade: true, reasons, budget };
  }
  if (budget.exhausted) {
    reasons.push('重试预算耗尽（' + budget.reason + '），降级为接受并标记 truncated');
    return { retry: false, action: 'accept', attempt, maxAttempts, backoffMs: 0, degrade: true, reasons, budget };
  }
  const effectiveAction = classification && classification.revisionOnly ? 'rewrite' : action;
  reasons.push('第 ' + (attempt + 1) + ' 次 stale 重试：' + effectiveAction +
    (classification && classification.kinds.length ? '（' + classification.kinds.join('+') + '）' : '') +
    (waveCost > 0 ? '，重画 ' + waveCost + ' 段' : ''));
  if (backoffMs > 0) reasons.push('退避 ' + backoffMs + 'ms 后重试');
  return {
    retry: true,
    action: effectiveAction,
    attempt: attempt + 1,
    maxAttempts,
    backoffMs,
    degrade: false,
    reasons,
    budget,
    // 重试时是否必须丢弃已拍帧：宽度/DPR 变化时旧帧坐标全部失效。
    discardFrames: effectiveAction === 'retry' || effectiveAction === 'restart',
  };
}

/**
 * 汇总一次 capture 的 stale 重试序列（日志/结果字段用）：
 * attempts 是 planStaleRetry() 的返回数组。
 */
export function summarizeStaleRetries(attempts, options = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const retried = list.filter((item) => item && item.retry === true).length;
  const degraded = list.some((item) => item && item.degrade === true);
  const kinds = [];
  const actions = [];
  for (const item of list) {
    if (!item) continue;
    if (item.action) actions.push(String(item.action));
    if (item.classification && Array.isArray(item.classification.kinds)) kinds.push(...item.classification.kinds);
  }
  const maxAttempts = Math.max(0, intOr(options.maxAttempts, STALE_DEFAULTS.maxAttempts));
  return {
    attempts: list.length,
    retried,
    degraded,
    exhausted: list.length > 0 && retried >= Math.max(1, maxAttempts),
    kinds: [...new Set(kinds)],
    actions: [...new Set(actions)],
    lastBackoffMs: list.length ? intOr(list[list.length - 1] && list[list.length - 1].backoffMs, 0) : 0,
  };
}

/** 协议 wire：重试决策精简版。 */
export function staleRetryWire(decision, options = {}) {
  if (!decision || typeof decision !== 'object') return { retry: false, action: 'accept', attempt: 0 };
  const maxReasons = Math.max(0, Math.min(8, intOr(options.maxReasons, 3)));
  return {
    retry: decision.retry === true,
    action: String(decision.action || 'accept'),
    attempt: intOr(decision.attempt, 0),
    max_attempts: intOr(decision.maxAttempts, STALE_DEFAULTS.maxAttempts),
    backoff_ms: intOr(decision.backoffMs, 0),
    degrade: decision.degrade === true,
    discard_frames: decision.discardFrames === true,
    reasons: (Array.isArray(decision.reasons) ? decision.reasons : []).slice(0, maxReasons),
    budget: decision.budget ? {
      exhausted: decision.budget.exhausted === true,
      tiles_left: intOr(decision.budget.tilesLeft, 0),
      bytes_left: intOr(decision.budget.bytesLeft, 0),
    } : null,
  };
}

/** 一行日志：'stale 重试 1/2 次（growth，退避 200ms，预算剩 90 tile）'。 */
export function describeStaleRetry(decision) {
  if (!decision || typeof decision !== 'object') return 'stale 无决策';
  const kinds = decision.classification && Array.isArray(decision.classification.kinds) && decision.classification.kinds.length
    ? '（' + decision.classification.kinds.join('+') + '）'
    : '';
  if (!decision.retry) {
    return 'stale 不重试：' + (decision.degrade ? '降级接受' : String(decision.action || 'accept')) +
      ' ' + intOr(decision.attempt, 0) + '/' + intOr(decision.maxAttempts, STALE_DEFAULTS.maxAttempts) + kinds;
  }
  const budget = decision.budget && Number.isFinite(Number(decision.budget.tilesLeft)) && Number(decision.budget.tilesLeft) >= 0
    ? '，预算剩 ' + decision.budget.tilesLeft + ' tile'
    : '';
  return 'stale 重试 ' + intOr(decision.attempt, 0) + '/' + intOr(decision.maxAttempts, STALE_DEFAULTS.maxAttempts) +
    ' 次（' + String(decision.action || 'retry') + kinds +
    (decision.backoffMs > 0 ? '，退避 ' + decision.backoffMs + 'ms' : '') + budget + '）';
}

/** 便于运行时构造 used 计数：把一次重试的代价加进预算用量。 */
export function addStaleCost(used, cost) {
  const current = used && typeof used === 'object' ? used : {};
  const delta = cost && typeof cost === 'object' ? cost : {};
  return {
    tiles: Math.max(0, intOr(current.tiles, 0) + intOr(delta.tiles, 0)),
    bytes: Math.max(0, intOr(current.bytes, 0) + intOr(delta.bytes, 0)),
    elapsedMs: Math.max(0, intOr(current.elapsedMs, 0) + intOr(delta.elapsedMs, 0)),
  };
}

/** 与 capture-freshness 的比对面对齐（供测试断言“分类覆盖了全部比对字段”）。 */
export const STALE_COMPARED_FIELDS = COMPARED_FIELDS;
