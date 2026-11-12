// lib/debug-archive-store.mjs —— 归档目录索引文件（原子写入、去重、过期清理）。
import fs from 'node:fs';
import path from 'node:path';
import { archiveSummary } from './debug-archive-index.mjs';

export const ARCHIVE_INDEX_FILE = '.bb-debug-index.json';

export function archiveIndexPath(dir) {
  return path.join(String(dir), ARCHIVE_INDEX_FILE);
}

export function readArchiveIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(archiveIndexPath(dir), 'utf8'));
    return Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function updateArchiveIndex(dir, archive, { now = Date.now(), maxEntries = 200 } = {}) {
  const entries = readArchiveIndex(dir).filter((entry) => entry && entry.expiresAt && Date.parse(entry.expiresAt) > now);
  const summary = archiveSummary(archive);
  const next = entries.filter((entry) => entry.id !== summary.id);
  next.push(summary);
  next.sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));
  const limited = next.slice(0, Math.max(1, Number(maxEntries) || 1));
  fs.mkdirSync(String(dir), { recursive: true });
  const target = archiveIndexPath(dir);
  const temp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), entries: limited }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, target);
  return limited;
}
