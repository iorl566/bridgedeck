// lib/intent-ledger.mjs —— 预写意图账本（write-ahead intent ledger）
//
// 目的：所有会改变页面/浏览器状态的操作，先在本机落一条脱敏的意图记录；
// 如果操作超时、被取消或连接断开，把它标记为 unknown/stale。
// 之后同一个 tab 上新的变异操作会被拦截，直到用户/Agent 明确 resolve，
// 避免"状态未知时盲目重放"。只读与诊断命令不受影响。
//
// 记录只保存方法名、参数键名、session/tab id，不保存参数值（填表内容、token、密码等）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMutating } from './methods.mjs';

export { isMutating };

const UNKNOWN_OUTCOMES = new Set([
  'E_TIMEOUT', 'E_DAEMON_TIMEOUT', 'E_EXTENSION_GONE', 'E_DISCONNECTED', 'E_CANCELLED',
]);

// 这些错误在派发前就已判定失败（找不到目标、参数不合法、选项不匹配、禁用控件等），
// 页面不会被改动，因此不需要冻结标签页等待人工 resolve。
const NO_EFFECT_CODES = new Set([
  'E_BAD_ARG', 'E_INVALID_PARAMS', 'E_NOT_FOUND', 'E_TARGET_NOT_FILLABLE',
  'E_NOT_ACTIONABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS', 'E_NOT_SELECT', 'E_FORBIDDEN', 'E_CURSOR_STALE',
]);

export function isUnknownOutcome(error) {
  if (!error) return false;
  if (error.effectState === 'none' || error.dispatched === false) return false;
  if (NO_EFFECT_CODES.has(error.code)) return false;
  if (UNKNOWN_OUTCOMES.has(error.code)) return true;
  const text = String(error.message || '');
  return /timeout|timed out|ECONNRESET|socket|disconnected|断开/i.test(text);
}

export class LedgerBlockedError extends Error {
  constructor(entry) {
    const age = Math.max(0, Math.round((Date.now() - Date.parse(entry.at)) / 1000));
    super(
      `同一标签页存在未确认的变异操作（${entry.method}，${entry.id}，${age}s 前），已拦截重放。` +
      `确认页面状态后执行 bridge ledger resolve ${entry.id}`,
    );
    this.code = 'E_LEDGER_PENDING';
    this.id = entry.id;
    this.method = entry.method;
    this.tabId = entry.tabId;
    this.ageMs = age * 1000;
  }
}

function sanitizeKeys(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).filter((key) => !/token|password|secret|value|text|clipboard/i.test(key)).sort();
}

export class IntentLedger {
  constructor({ dir, staleMs = 15_000, maxEntries = 300, now = () => Date.now() } = {}) {
    if (!dir) throw new Error('IntentLedger needs a directory');
    this.dir = dir;
    this.file = path.join(dir, 'ledger.json');
    this.staleMs = staleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = this.#read();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw?.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  #write() {
    const entries = this.entries.slice(-this.maxEntries);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      fs.renameSync(temp, this.file);
    } catch {
      // 账本写入失败不应阻断主流程；内存态仍然生效。
    }
  }

  /** daemon 启动时调用：上次进程遗留的 active 记录一律视为 stale。 */
  load() {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.state === 'active') {
        entry.state = 'stale';
        entry.staleAt = new Date(this.now()).toISOString();
        changed = true;
      }
    }
    if (changed) this.#write();
    return this.entries;
  }

  #touchStale(tabId) {
    const now = this.now();
    for (const entry of this.entries) {
      if (entry.tabId !== tabId) continue;
      if (entry.state === 'active' && now - Date.parse(entry.at) > this.staleMs) {
        entry.state = 'stale';
        entry.staleAt = new Date(now).toISOString();
      }
    }
  }

  #blocking(tabId) {
    if (tabId == null) return null;
    return this.entries.find((entry) => entry.tabId === tabId && (entry.state === 'stale' || entry.state === 'unknown')) || null;
  }

  begin(method, params, { tabId = null, sessionId = null } = {}) {
    if (!isMutating(method)) return null;
    this.#touchStale(tabId);
    const blocker = this.#blocking(tabId);
    if (blocker) {
      this.#write();
      throw new LedgerBlockedError(blocker);
    }
    const entry = {
      id: 'lt_' + crypto.randomBytes(4).toString('hex'),
      at: new Date(this.now()).toISOString(),
      method: String(method),
      tabId: tabId == null ? null : Number(tabId),
      sessionId: sessionId == null ? null : String(sessionId),
      keys: sanitizeKeys(params),
      state: 'active',
    };
    this.entries.push(entry);
    this.#write();
    return entry;
  }

  finish(entry, outcome = 'done') {
    if (!entry) return;
    const record = this.entries.find((item) => item.id === entry.id);
    if (!record || record.state !== 'active') return;
    record.state = outcome;
    record.finishedAt = new Date(this.now()).toISOString();
    this.#write();
  }

  status({ limit = 20 } = {}) {
    const now = this.now();
    const pending = [];
    for (const entry of this.entries) {
      if (entry.state === 'active' && now - Date.parse(entry.at) > this.staleMs) {
        entry.state = 'stale';
        entry.staleAt = new Date(now).toISOString();
      }
      if (entry.state === 'active' || entry.state === 'stale' || entry.state === 'unknown') pending.push(entry);
    }
    return {
      staleMs: this.staleMs,
      pending,
      recent: this.entries.slice(-Math.max(1, Number(limit) || 20)).reverse(),
    };
  }

  /** 同步成功后自动和解：把该 tab 上 unknown/stale 的记录标记为 resolved。 */
  reconcile(tabId, outcome = 'reconciled') {
    if (tabId == null) return 0;
    let count = 0;
    for (const entry of this.entries) {
      if (entry.tabId === tabId && (entry.state === 'stale' || entry.state === 'unknown')) {
        entry.state = 'resolved';
        entry.outcome = outcome;
        entry.resolvedAt = new Date(this.now()).toISOString();
        count += 1;
      }
    }
    if (count) this.#write();
    return count;
  }

  resolve(id, outcome = 'abandoned') {    const entry = this.entries.find((item) => item.id === String(id || ''));
    if (!entry) {
      const error = new Error('没有这个账本记录：' + id);
      error.code = 'E_NOT_FOUND';
      throw error;
    }
    entry.state = 'resolved';
    entry.outcome = String(outcome || 'abandoned');
    entry.resolvedAt = new Date(this.now()).toISOString();
    this.#write();
    return entry;
  }
}
