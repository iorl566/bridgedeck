/** 长截图期间页面是否“过期”：关键布局指标变化超过容差即视为 stale。
 *  超大页分块/滚动截图可能持续数百毫秒，页面自行增长或重排时需要重拍一次。
 *
 *  第十批-D：在既有 stale 判定之上接 lib/longshot-stale 的归因（growth/width/revision/
 *  bands/dpr/viewport）与重试阶梯。既有字段 stale/changed 的判定逐字不变（判定仍只看原来
 *  那 5 个字段），只新增签名/归因/严重度等字段；新增的 planStaleRecoveryDetailed() 与
 *  staleRetryPlan() 是可选入口，既有调用方（screenshot/tiled-capture）不传新选项时行为不变。
 */
import { classifyStale, planStaleRetry, staleSignature, summarizeStaleRetries } from './longshot-stale.js';

export function staleMetrics(before, after, options = {}) {
  const tolerance = Number.isFinite(Number(options.tolerance)) ? Math.max(0, Number(options.tolerance)) : 1;
  if (!before || !after) return { stale: false, changed: [] };
  const fields = ['scrollHeight', 'scrollWidth', 'innerWidth', 'innerHeight', 'revision'];
  const changed = [];
  for (const field of fields) {
    const a = Number(before[field]);
    const b = Number(after[field]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) > tolerance) changed.push({ field, before: a, after: b });
  }
  // 归因只加字段：stale 仍是“原来 5 个字段里有没有变化”，归因不会把 stale 翻成 true。
  const classification = classifyStale(changed);
  return {
    stale: changed.length > 0,
    changed,
    // 更宽的页面签名（含 dpr/固定带/文档尺寸），用于日志去重与两次 capture 的对照。
    signature: { before: staleSignature(before), after: staleSignature(after) },
    kinds: classification.kinds,
    dominant: classification.dominant,
    severity: classification.severity,
    suggestion: classification.suggestion,
    classification,
  };
}

/** stale 后的恢复策略：页面向下增长时只补拍新增 tile；宽度变化/缩小则整页重拍。 */
export function planStaleRecovery(before, after, options = {}) {
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 1;
  const device = options.device || {};
  const oldWidth = Number(device.width) > 0 ? Number(device.width) : Math.ceil((Number(before && before.scrollWidth) || 0) * scale);
  const oldHeight = Number(device.height) > 0 ? Number(device.height) : Math.ceil((Number(before && before.scrollHeight) || 0) * scale);
  const nextWidth = Math.ceil((Number(after && after.scrollWidth) || 0) * scale);
  const nextHeight = Math.ceil((Number(after && after.scrollHeight) || 0) * scale);
  if (!after || nextWidth <= 0 || nextHeight <= 0) return { action: 'accept' };
  if (nextWidth === oldWidth && nextHeight === oldHeight) {
    const beforeRevision = Number(before && before.revision);
    const afterRevision = Number(after.revision);
    if (Number.isFinite(beforeRevision) && Number.isFinite(afterRevision) && beforeRevision !== afterRevision) {
      return { action: 'rewrite', width: nextWidth, height: nextHeight };
    }
    return { action: 'accept' };
  }
  if (nextWidth === oldWidth && nextHeight > oldHeight) {
    return { action: 'extend', width: nextWidth, height: nextHeight, y0: oldHeight };
  }
  return { action: 'retry', width: nextWidth, height: nextHeight };
}

/**
 * 恢复策略 + 归因 + 重试决策（可选入口，默认路径不调用）：
 * 调用方已有 planStaleRecovery 的 action 时，用这个拿到“第几次重试/退避多久/预算是否够”。
 * @returns {{recovery: object, classification: object, retry: object, stale: boolean}}
 */
export function staleRetryPlan(before, after, options = {}) {
  const recovery = planStaleRecovery(before, after, options);
  const metrics = staleMetrics(before, after, options);
  const classification = metrics.classification || classifyStale(metrics.changed);
  const retry = planStaleRetry({
    action: recovery.action === 'accept' ? 'accept' : recovery.action,
    classification,
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    waveCost: options.waveCost,
    used: options.used,
    budget: options.budget,
    backoffMs: options.backoffMs,
  });
  return { recovery, classification, retry, stale: metrics.stale };
}

/** 汇总一次 capture 内的 stale 重试序列（结果字段用；无重试时返回零值）。 */
export function summarizeStaleAttempts(attempts, options = {}) {
  return summarizeStaleRetries(attempts, options);
}
