// daemon/read-views.js —— audit/view 只读视图。
import fs from 'node:fs';
import path from 'node:path';

export function createReadViews({ HOME_DIR, BridgeError, resolveSession }) {
function getOperation(id) {
    const wanted = String(id || '');
    if (!wanted) throw new BridgeError('E_BAD_ARG', '需要 operation id');
    const dir = path.join(HOME_DIR, 'audit');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().reverse();
    } catch {
      files = [];
    }
    for (const name of files) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.id === wanted) return { entry: row };
        } catch {
          // 跳过坏行
        }
      }
    }
    throw new BridgeError('E_NOT_FOUND', '找不到 operation ' + wanted);
  }
  
  function listAudit(params) {
    const limitRaw = Number(params.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 100, 1), 500);
    const since = Number(params.since) > 0 ? Number(params.since) : 0;
    const dir = path.join(HOME_DIR, 'audit');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      files = [];
    }
    const entries = [];
    for (const name of files) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row.ts >= since) entries.push(row);
        } catch {
          // 跳过坏行
        }
      }
    }
    entries.sort((a, b) => b.ts - a.ts);
    return { dir, total: entries.length, entries: entries.slice(0, limit) };
  }
  
  /** view：在当前 session 的最近一次 observe 缓存里检索/分页。 */
  function viewCache(params) {
    const session = resolveSession(params.session !== undefined ? params.session : params.sessionId);
    const cache = session.observation;
    if (!cache) {
      throw new BridgeError('E_CACHE_EMPTY', '该 session 还没有 observe 缓存；先运行 bridge observe');
    }
    const lines = (() => {
      // 大 observation 可能数 MB：切行结果缓存在 session 上，view 反复翻页时只切一次。
      if (Array.isArray(cache.lines) && cache.linesText === cache.text) return cache.lines;
      cache.lines = String(cache.text || '').split('\n');
      cache.linesText = cache.text;
      return cache.lines;
    })();
    const needle = typeof params.grep === 'string' && params.grep ? params.grep.toLowerCase() : '';
    const matched = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
    const offset = Math.max(0, Number.isFinite(Number(params.offset)) ? Math.floor(Number(params.offset)) : 0);
    const limitRaw = Number(params.limit);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 200, 1), 2000);
    return {
      lines: matched.slice(offset, offset + limit),
      total: lines.length,
      matched: matched.length,
      offset,
      limit,
      url: cache.url || '',
      title: cache.title || '',
      at: cache.at,
      refs: cache.refs || 0,
    };
  }
  
  
  return { getOperation, listAudit, viewCache };
}
