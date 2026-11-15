// lib/start-journal.mjs —— 可恢复会话启动的请求 token 与预写日志。
//
// token 形态与 BrowserSkill 0.5.0 对齐：`<expiry-unix-ms>:<8-80 位 id>`。
// 调用方在发起 window 创建前生成并传入；daemon 在创建前写 starting，
// 成功后写 ready（含 sessionId/tabId/windowId），失败写 failed。
// 同一个 token 重试 start 会返回既有会话，不会重复开窗；过期 token 拒绝。
import fs from 'node:fs';
import path from 'node:path';

export const START_TOKEN_TTL_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

/** 校验并返回规范化 token；不合法直接抛 Error（daemon 转 E_BAD_ARG）。 */
export function normalizeStartToken(value, now = Date.now()) {
  if (typeof value !== 'string') throw new Error('requestId 需要字符串');
  const raw = value.trim();
  const match = /^(\d{10,16}):([A-Za-z0-9_-]{8,80})$/.exec(raw);
  if (!match) throw new Error('requestId 需要 <expiry-unix-ms>:<8-80 位 id> 形式');
  const expiry = Number(match[1]);
  if (!Number.isFinite(expiry)) throw new Error('requestId 过期时间不合法');
  if (expiry <= now) throw new Error('requestId 已过期，请重新生成');
  if (expiry > now + START_TOKEN_TTL_MS) throw new Error('requestId 的过期时间不能超过 10 分钟');
  return raw;
}

/** 生成一个可直接传入的 token（插件/agent 用）。 */
export function createStartToken(now = Date.now(), ttlMs = 5 * 60 * 1000, id) {
  const suffix = id || Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `${now + Math.min(ttlMs, START_TOKEN_TTL_MS)}:${suffix}`;
}

/**
 * 文件日志：每次写入都是 temp + rename，避免半截文件。
 * entries: token -> { state: 'starting'|'ready'|'failed', at, result?, error?, meta? }
 */
export function createStartJournal(filePath, { now = () => Date.now() } = {}) {
  let entries = load();
  let dirty = false;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && raw.version === 1 && raw.entries && typeof raw.entries === 'object') return raw.entries;
    } catch {
      // 缺失/损坏：从空日志开始
    }
    return {};
  }

  function prune() {
    const current = now();
    for (const [token, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') {
        delete entries[token];
        continue;
      }
      if (entry.state !== 'starting' && current - Number(entry.at || 0) > PRUNE_AFTER_MS) delete entries[token];
    }
    const sorted = Object.entries(entries).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0));
    for (const [token] of sorted.slice(MAX_ENTRIES)) delete entries[token];
  }

  function save() {
    prune();
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
      fs.renameSync(temp, filePath);
    } catch {
      // 日志写失败不应阻断启动；幂等性退化但不破坏会话
    }
  }

  return {
    get(token) {
      const entry = entries[token];
      return entry && typeof entry === 'object' ? { ...entry } : null;
    },
    begin(token, meta) {
      entries[token] = { state: 'starting', at: now(), meta: meta || null };
      save();
      return entries[token];
    },
    /** 预登记：不创建窗口，只占住 token。 */
    prepare(token, meta) {
      entries[token] = { state: 'prepared', at: now(), meta: meta || null };
      save();
      return entries[token];
    },
    /** 任意状态迁移；调用方负责校验合法迁移。 */
    setState(token, state, patch = {}) {
      entries[token] = { ...(entries[token] || {}), ...patch, state, at: now() };
      save();
      return entries[token];
    },
    ready(token, result) {
      entries[token] = { ...(entries[token] || {}), state: 'ready', at: now(), result, error: undefined };
      save();
    },
    fail(token, message) {
      entries[token] = { ...(entries[token] || {}), state: 'failed', at: now(), error: String(message || 'start failed') };
      save();
    },
    remove(token) {
      delete entries[token];
      save();
    },
    snapshot() {
      return Object.fromEntries(Object.entries(entries).map(([token, entry]) => [token, { ...entry }]));
    },
    /** 重新读取文件（多进程/测试用）。 */
    reload() {
      entries = load();
      return this.snapshot();
    },
  };
}
