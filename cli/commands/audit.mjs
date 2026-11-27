// cli/commands/audit.mjs —— `bridge audit list|export|prune|clear`（本地 JSONL 审计）。
import fs from 'node:fs';
import path from 'node:path';

export function createAuditCommand({
  auditDir,
  writeFileAtomic,
  parseSince,
  intFlag,
  ArgError,
  parseDurationMs,
  emitJson,
  isJson,
  print,
  renderTable,
  formatTime,
  truncateText,
}) {
  function fileNames() {
    try {
      return fs.readdirSync(auditDir).filter((name) => name.endsWith('.jsonl')).sort();
    } catch {
      return [];
    }
  }

  function readEntries(since = 0) {
    const entries = [];
    for (const name of fileNames()) {
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(auditDir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (Number(row.ts) >= since) entries.push(row);
        } catch {
          // 跳过损坏行
        }
      }
    }
    entries.sort((a, b) => Number(a.ts) - Number(b.ts));
    return entries;
  }

  function list(flags) {
    const since = parseSince(flags.since);
    const limit = intFlag(flags, 'limit', { min: 1 }) ?? 50;
    const offset = intFlag(flags, 'offset', { min: 0 }) ?? 0;
    const entries = readEntries(since).sort((a, b) => Number(b.ts) - Number(a.ts));
    const sliced = entries.slice(offset, offset + limit);
    if (isJson()) {
      emitJson({ ok: true, result: { dir: auditDir, total: entries.length, offset, limit, entries: sliced } });
      return 0;
    }
    if (!sliced.length) {
      print('没有审计记录（目录 ' + auditDir + '）');
      return 0;
    }
    print(renderTable(['time', 'method', 'ok', 'ms', 'session', 'url'], sliced.map((row) => [
      formatTime(row.ts),
      row.method || '',
      row.ok ? 'ok' : (row.code || 'fail'),
      row.durationMs != null ? String(row.durationMs) : '',
      row.sessionId || '',
      truncateText(row.url || '', 44),
    ])));
    print('');
    print('共 ' + entries.length + ' 条（offset ' + offset + '，显示 ' + sliced.length + ' 条）');
    return 0;
  }

  function exportAudit(flags) {
    if (flags.out === undefined) throw new ArgError('audit export 需要 --out <file>');
    const since = parseSince(flags.since);
    const format = flags.format === 'json' ? 'json' : 'jsonl';
    const entries = readEntries(since);
    const out = path.resolve(process.cwd(), String(flags.out));
    const content = format === 'json'
      ? JSON.stringify(entries, null, 2) + '\n'
      : entries.map((row) => JSON.stringify(row)).join('\n') + (entries.length ? '\n' : '');
    writeFileAtomic(out, content, 0o600);
    const result = { dir: auditDir, out, format, entries: entries.length, bytes: Buffer.byteLength(content) };
    if (isJson()) {
      emitJson({ ok: true, result });
      return 0;
    }
    print('已导出 ' + entries.length + ' 条审计 → ' + out + '（' + format + '，' + result.bytes + 'B）');
    return 0;
  }

  function prune(flags) {
    let cutoff;
    if (flags.before !== undefined) {
      cutoff = Date.parse(String(flags.before));
      if (!Number.isFinite(cutoff)) throw new ArgError('--before 需要可解析的日期，例如 2026-10-01');
    } else if (flags['older-than'] !== undefined) {
      cutoff = Date.now() - parseDurationMs(flags['older-than'], 0);
    } else {
      throw new ArgError('audit prune 需要 --older-than <30d> 或 --before <日期>');
    }
    const dryRun = flags['dry-run'] === true;
    const kept = [];
    let removed = 0;
    let emptied = 0;
    for (const name of fileNames()) {
      const file = path.join(auditDir, name);
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const rows = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (Number(row.ts) >= cutoff) rows.push(row);
          else removed += 1;
        } catch {
          removed += 1;
        }
      }
      kept.push(...rows);
      if (dryRun) continue;
      if (!rows.length) {
        fs.rmSync(file, { force: true });
        emptied += 1;
      } else {
        writeFileAtomic(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 0o600);
      }
    }
    const result = { dir: auditDir, cutoff: new Date(cutoff).toISOString(), kept: kept.length, removed, emptied, dryRun };
    if (isJson()) {
      emitJson({ ok: true, result });
      return 0;
    }
    print((dryRun ? '[dry-run] ' : '') + '审计清理：保留 ' + kept.length + ' 条，删除 ' + removed + ' 条' + (emptied ? '，移除 ' + emptied + ' 个空文件' : ''));
    return 0;
  }

  function clearAudit(flags) {
    if (flags.yes !== true) throw new ArgError('audit clear 需要 --yes 确认');
    const files = fileNames();
    let removed = 0;
    for (const name of files) {
      fs.rmSync(path.join(auditDir, name), { force: true });
      removed += 1;
    }
    const result = { dir: auditDir, files: removed };
    if (isJson()) {
      emitJson({ ok: true, result });
      return 0;
    }
    print('已删除 ' + removed + ' 个审计文件');
    return 0;
  }

  return async function cmdAudit(flags, pos) {
    const sub = pos[1] || 'list';
    if (sub === 'export') return exportAudit(flags);
    if (sub === 'prune') return prune(flags);
    if (sub === 'clear') return clearAudit(flags);
    if (sub !== 'list') throw new ArgError('用法：bridge audit list|export|prune|clear');
    return list(flags);
  };
}
