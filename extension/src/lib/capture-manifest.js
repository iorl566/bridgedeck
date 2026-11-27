/**
 * 捕获证据 manifest：每次长截图/视频落一条可恢复索引，不把大 dataURL 塞进索引。
 */
export function buildCaptureManifest({ id, kind = 'longshot', width = 0, height = 0, tiles = 0, url = '', now = Date.now() } = {}) {
  if (!id) throw new Error('capture manifest 需要 id');
  return {
    version: 1,
    id: String(id),
    kind: String(kind),
    width: Math.max(0, Math.round(Number(width) || 0)),
    height: Math.max(0, Math.round(Number(height) || 0)),
    tiles: Math.max(0, Math.round(Number(tiles) || 0)),
    url: String(url || ''),
    createdAt: new Date(now).toISOString(),
  };
}

export function pruneManifests(list, { now = Date.now(), ttlMs = 7 * 24 * 60 * 60 * 1000, max = 20 } = {}) {
  const cutoff = now - ttlMs;
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && item.createdAt && Date.parse(item.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, Number(max) || 20));
}

/** 插入/替换一条 manifest，并按 TTL/数量清理；返回新列表（不修改入参）。 */
export function upsertCaptureManifest(list, entry, options = {}) {
  if (!entry || !entry.id) throw new Error('capture manifest 需要 id');
  const next = (Array.isArray(list) ? list : [])
    .filter((item) => item && item.id !== entry.id)
    .concat([entry]);
  return pruneManifests(next, options);
}
