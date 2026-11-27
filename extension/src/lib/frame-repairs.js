// 帧采集失败的修复预算：隐藏帧直接跳过，同一帧在 TTL 内只重试一次，并统计结果。
export function createRepairTracker(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 4000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const attempts = new Map(); // tabId:key -> timestamp
  const stats = { attempted: 0, repaired: 0, failed: 0, skippedHidden: 0, cached: 0, pruned: 0 };

  const idOf = (tabId, key) => String(tabId) + ':' + String(key);

  return {
    plan(tabId, key, { hidden = false } = {}) {
      if (hidden === true) {
        stats.skippedHidden += 1;
        return 'skip';
      }
      const id = idOf(tabId, key);
      const at = attempts.get(id);
      if (Number.isFinite(at) && now() - at < ttlMs) {
        stats.cached += 1;
        return 'cached';
      }
      attempts.set(id, now());
      stats.attempted += 1;
      return 'repair';
    },
    finish(ok) {
      if (ok) stats.repaired += 1;
      else stats.failed += 1;
    },
    summary() {
      return { ...stats, tracked: attempts.size };
    },
    /** 与当前文档清单对账：清掉已消失/被替换 document 的预算，返回清理条数。 */
    reconcile(tabId, liveKeys = new Set()) {
      const prefix = String(tabId) + ':';
      let pruned = 0;
      for (const key of [...attempts.keys()]) {
        if (!key.startsWith(prefix)) continue;
        if (liveKeys.has(key.slice(prefix.length))) continue;
        attempts.delete(key);
        pruned += 1;
      }
      stats.pruned += pruned;
      return pruned;
    },
    clear(tabId) {
      const prefix = String(tabId) + ':';
      for (const key of attempts.keys()) {
        if (key.startsWith(prefix)) attempts.delete(key);
      }
    },
  };
}
