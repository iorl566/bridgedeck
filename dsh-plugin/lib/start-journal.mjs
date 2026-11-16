// dsh-plugin/lib/start-journal.mjs —— 插件侧的启动所有权日志。
//
// 目的：插件在 spawn CLI 之前先记录 token，
// 进程崩溃/回复丢失后仍能凭 token 找回或清理已经创建的 Agent 窗口。
// 与 daemon 的 session-starts.json 互补：daemon 管会话所有权，这里管“插件调用过什么”。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

/** 插件 journal 默认落在 BB_HOME（与 daemon 同目录），便于一起清理。 */
export function defaultJournalPath(home) {
  const base = home || process.env.BB_HOME || path.join(os.homedir(), '.browser-bridge');
  return path.join(base, 'dsh-starts.json');
}

export function createPluginStartJournal({ filePath, now = () => Date.now() } = {}) {
  let entries = load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object') return raw.entries;
    } catch {
      // 缺失/损坏从空开始
    }
    return {};
  }

  function prune() {
    const current = now();
    for (const [token, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object' || current - Number(entry.at || 0) > MAX_AGE_MS) delete entries[token];
    }
    const sorted = Object.entries(entries).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0));
    for (const [token] of sorted.slice(MAX_ENTRIES)) delete entries[token];
  }

  function save() {
    prune();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      fs.renameSync(temp, filePath);
    } catch {
      // journal 写失败不应阻断工具调用
    }
  }

  return {
    filePath,
    add(token, meta) {
      entries[token] = { state: 'starting', at: now(), meta: meta || null };
      save();
      return entries[token];
    },
    ready(token, result) {
      entries[token] = { ...(entries[token] || {}), state: 'ready', at: now(), result: result || null };
      save();
    },
    fail(token, error) {
      entries[token] = { ...(entries[token] || {}), state: 'failed', at: now(), error: String(error || 'failed') };
      save();
    },
    update(token, patch) {
      entries[token] = {
        ...(entries[token] || {}),
        ...patch,
        at: patch && patch.at !== undefined ? patch.at : now(),
      };
      save();
      return entries[token];
    },
    get(token) {
      const entry = entries[token];
      return entry ? { ...entry } : null;
    },
    list() {
      return Object.entries(entries).map(([token, entry]) => ({ token, ...entry }));
    },
    /** 重启后待认领的 starting 记录（超过 staleMs）。 */
    stale(staleMs = 120000) {
      const current = now();
      return this.list().filter((entry) => entry.state === 'starting' && current - Number(entry.at || 0) >= staleMs);
    },
    reload() {
      entries = load();
      return this.list();
    },
  };
}

/**
 * 插件启动时回收孤儿窗口：
 * 对每条过期 starting 记录用同一 token 查询 daemon；ready 且存活 → stop 清理；
 * cancelled/failed/未知 → 标记 stale。返回处理结果，调用方自行记日志。
 */
export async function recoverOrphanStarts({ run, journal, staleMs = 120000 } = {}) {
  const results = [];
  const candidates = journal.stale(staleMs);
  for (const entry of candidates) {
    try {
      const status = await run(['session', 'request', '--request-id', entry.token], {});
      const state = status && status.entry ? status.entry.state : null;
      if (state === 'ready' && status.entry.result && status.entry.result.sessionId) {
        await run(['session', 'stop', status.entry.result.sessionId], {});
        journal.update(entry.token, { state: 'recovered', recoveredSessionId: status.entry.result.sessionId });
        results.push({ token: entry.token, recovered: true, sessionId: status.entry.result.sessionId });
      } else {
        journal.update(entry.token, { state: 'stale', lastState: state });
        results.push({ token: entry.token, recovered: false, state });
      }
    } catch (error) {
      results.push({ token: entry.token, recovered: false, error: String((error && error.code) || error) });
    }
  }
  return results;
}
