// lib/observation-cache.mjs —— 本地观察基线缓存的生命周期管理。
//
// `--delta` 依赖 `~/.browser-bridge/observations/<id>.json`。文件很小，但长期使用会累积；
// 保存时按 TTL + 数量上限清理，避免无限增长。
import fs from 'node:fs';
import path from 'node:path';

export const OBSERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OBSERVATION_MAX_FILES = 300;

/**
 * 删除过期/超量的观察缓存。
 * @param {string} dir
 * @param {{now?: number, ttlMs?: number, maxFiles?: number}} [options]
 * @returns {{removed: number, kept: number}}
 */
export function pruneObservationCache(dir, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : OBSERVATION_TTL_MS;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : OBSERVATION_MAX_FILES;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { removed: 0, kept: 0 };
  }
  const survivors = [];
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs > ttlMs) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        // 文件可能已被别的进程删掉
      }
      continue;
    }
    survivors.push({ file, mtimeMs: stat.mtimeMs });
  }
  survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of survivors.slice(maxFiles)) {
    try {
      fs.unlinkSync(entry.file);
      removed += 1;
    } catch {
      // 忽略
    }
  }
  return { removed, kept: Math.min(survivors.length, maxFiles) };
}
