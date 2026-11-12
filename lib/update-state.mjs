// lib/update-state.mjs —— 更新操作的状态记录（check/fetch/stage/apply/rollback）。
import fs from 'node:fs';
import path from 'node:path';

export function readUpdateState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function writeUpdateState(file, patch) {
  const current = readUpdateState(file);
  const next = { ...current, ...(patch || {}), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  return next;
}
