// lib/debug-archive-index.mjs —— 调试归档索引与保留期。
export function createArchiveIndex({ maxEntries = 200 } = {}) {
  const entries = new Map();
  const limit = Math.max(1, Number(maxEntries) || 1);
  return {
    add(archive) {
      if (!archive || !archive.id) throw new Error('归档缺少 id');
      entries.set(String(archive.id), archive);
      while (entries.size > limit) {
        const oldest = [...entries.entries()].sort((a, b) => {
          const left = Date.parse(a[1].createdAt || 0) || 0;
          const right = Date.parse(b[1].createdAt || 0) || 0;
          return left - right;
        })[0];
        if (!oldest) break;
        entries.delete(oldest[0]);
      }
      return archive.id;
    },
    get(id) { return entries.get(String(id)) || null; },
    list({ now = Date.now(), includeExpired = false } = {}) {
      return [...entries.values()]
        .filter((archive) => includeExpired || !archive.expiresAt || Date.parse(archive.expiresAt) > now)
        .sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));
    },
    prune(now = Date.now()) {
      let removed = 0;
      for (const [id, archive] of entries) {
        if (archive.expiresAt && Date.parse(archive.expiresAt) <= now) {
          entries.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
    stats(now = Date.now()) {
      const all = [...entries.values()];
      return {
        total: all.length,
        live: all.filter((archive) => !archive.expiresAt || Date.parse(archive.expiresAt) > now).length,
        requests: all.reduce((sum, archive) => sum + Number((archive.summary && archive.summary.requests) || 0), 0),
      };
    },
  };
}

export function archiveSummary(archive) {
  const input = archive && typeof archive === 'object' ? archive : {};
  return {
    id: String(input.id || ''),
    createdAt: input.createdAt || '',
    expiresAt: input.expiresAt || '',
    requests: Number((input.summary && input.summary.requests) || 0),
    console: Number((input.summary && input.summary.console) || 0),
    url: String((input.page && input.page.url) || ''),
  };
}
