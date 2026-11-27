// mcp/snapshots.mjs —— MCP resources 观察/证据/时间线快照的磁盘持久化。
//
// 为什么需要它：
//   1. resources 里的 observation/evidence/journal 原本只在进程内存里，MCP server 是被客户端
//      按需拉起的短命进程；客户端重连一次，之前的快照就全部丢失，只能重新跑巡检工具。
//   2. 快照是“大块文本”的主要来源，必须有磁盘上限和过期清理，否则长期运行的桌面端会把
//      ~/.browser-bridge 撑爆。
//
// 设计约束：
//   1. 目录固定为 `BB_HOME/mcp-snapshots`（可用 BB_MCP_SNAPSHOT_DIR 覆盖，主要用于测试）；
//   2. 原子写：同目录临时文件 → fsync → rename；任何时刻磁盘上要么是旧完整文件，要么是新
//      完整文件，进程被杀不会留下半截 JSON 被误读；
//   3. 每个快照文件带 version/label/savedAt/limits 头，损坏文件不阻塞启动（读不到就当空）；
//   4. 过期清理：条目超过 TTL 在写入/加载时丢弃；目录扫描会删除过期空文件与遗留临时文件；
//   5. 大小上限：单条目超过 maxEntryBytes 时只保留可读预览（标记 persistedTruncated），
//      整文件超过 maxTotalBytes 时按 LRU 顺序淘汰最旧条目；
//   6. 不做跨进程锁：MCP server 通常单实例；多实例共享同一 HOME 时按“最后写入者胜”处理，
//      rename 保证不会读到撕裂文件。
//
// 调用点：mcp/resources.mjs 的 SnapshotStore.record/hydrate 与 createResourceRegistry 启动恢复。

import fs from 'node:fs';
import path from 'node:path';

/** 快照目录名（位于 BB_HOME 下）。 */
export const SNAPSHOT_DIRNAME = 'mcp-snapshots';

/** 快照文件格式版本；不匹配的文件按损坏处理（不猜测旧格式）。 */
export const SNAPSHOT_VERSION = 1;

/** 磁盘快照默认上限与过期参数。 */
export const SNAPSHOT_LIMITS = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1000,
  maxTotalBytes: 4 * 1024 * 1024,
  maxEntryBytes: 192 * 1024,
  cleanupIntervalMs: 60 * 1000,
  tmpMaxAgeMs: 5 * 60 * 1000,
});

/**
 * 快照写锁参数（W7-C 第 3 项：并发保护）。
 *
 * 为什么需要锁：MCP server 可能被多个客户端各拉起一个进程（Claude Desktop + CLI + 编辑器插件），
 * 它们共享同一个 BB_HOME。原子写（tmp+rename）保证“不会读到撕裂文件”，但两个进程
 * “各自读旧文件 → 各自写新文件”会丢更新（后写者覆盖先写者）。这里对同一个 label 的
 * 落盘加一把同目录 `.lock` 文件锁：
 *   - 用 O_EXCL（wx）创建，抢不到就按 retryMs 重试；
 *   - 锁文件 mtime 超过 staleMs 视为进程崩溃遗留，允许接管（staleTaken）；
 *   - 重试用尽仍抢不到时不阻塞写入（退回原子写、last-writer-wins），只在 stats 记
 *     lockFallbacks：证明“并发时降级而不是失败”，避免把只读工具拖死。
 */
export const SNAPSHOT_LOCK_LIMITS = Object.freeze({
  enabled: true,
  retries: 12,
  retryMs: 8,
  staleMs: 5_000,
});

/** 环境变量名（全部为可选；非法值回退默认，不抛异常）。 */
export const SNAPSHOT_ENV = Object.freeze({
  disable: 'BB_MCP_SNAPSHOT',
  dir: 'BB_MCP_SNAPSHOT_DIR',
  ttl: 'BB_MCP_SNAPSHOT_TTL_MS',
  maxBytes: 'BB_MCP_SNAPSHOT_MAX_BYTES',
  entryBytes: 'BB_MCP_SNAPSHOT_ENTRY_BYTES',
  cleanupInterval: 'BB_MCP_SNAPSHOT_CLEANUP_MS',
  lockDisable: 'BB_MCP_SNAPSHOT_LOCK',
  lockRetries: 'BB_MCP_SNAPSHOT_LOCK_RETRIES',
  lockRetryMs: 'BB_MCP_SNAPSHOT_LOCK_RETRY_MS',
  lockStaleMs: 'BB_MCP_SNAPSHOT_LOCK_STALE_MS',
  quarantine: 'BB_MCP_SNAPSHOT_QUARANTINE',
});

export const SNAPSHOT_ERRORS = Object.freeze({
  DISABLED: 'E_SNAPSHOT_DISABLED',
  WRITE_FAILED: 'E_SNAPSHOT_WRITE',
  CORRUPT: 'E_SNAPSHOT_CORRUPT',
});

function envValue(env, name) {
  const bag = env && typeof env === 'object' ? env : {};
  const value = bag[name];
  return value == null ? '' : String(value).trim();
}

function positiveInt(value, fallback) {
  if (!/^\d+$/.test(String(value))) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/** 磁盘快照是否被环境变量关闭（off/0/false/disabled）。 */
export function snapshotsDisabled(env = process.env) {
  const value = envValue(env, SNAPSHOT_ENV.disable).toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

/**
 * 解析磁盘持久化上限：每个字段都允许环境变量覆盖，非法/缺省回退默认值。
 * @returns {{ ttlMs:number, maxTotalBytes:number, maxEntryBytes:number, cleanupIntervalMs:number, tmpMaxAgeMs:number }}
 */
export function resolveSnapshotLimits(env = process.env) {
  return Object.freeze({
    ttlMs: positiveInt(envValue(env, SNAPSHOT_ENV.ttl), SNAPSHOT_LIMITS.ttlMs),
    maxTotalBytes: positiveInt(envValue(env, SNAPSHOT_ENV.maxBytes), SNAPSHOT_LIMITS.maxTotalBytes),
    maxEntryBytes: positiveInt(envValue(env, SNAPSHOT_ENV.entryBytes), SNAPSHOT_LIMITS.maxEntryBytes),
    cleanupIntervalMs: positiveInt(envValue(env, SNAPSHOT_ENV.cleanupInterval), SNAPSHOT_LIMITS.cleanupIntervalMs),
    tmpMaxAgeMs: SNAPSHOT_LIMITS.tmpMaxAgeMs,
  });
}

/** 快照目录：环境变量优先，否则 `home/mcp-snapshots`。 */
export function resolveSnapshotDir(home, env = process.env) {
  const configured = envValue(env, SNAPSHOT_ENV.dir);
  if (configured) return path.resolve(configured);
  return path.join(String(home || ''), SNAPSHOT_DIRNAME);
}

/**
 * 解析快照写锁参数：环境变量只能收紧（重试次数/等待时间只能变小，stale 窗口只能变短）。
 * @returns {{ enabled:boolean, retries:number, retryMs:number, staleMs:number }}
 */
export function resolveSnapshotLock(env = process.env) {
  const disable = envValue(env, SNAPSHOT_ENV.lockDisable).toLowerCase();
  const disabled = disable === 'off' || disable === '0' || disable === 'false' || disable === 'disabled';
  const retries = Math.min(
    positiveInt(envValue(env, SNAPSHOT_ENV.lockRetries), SNAPSHOT_LOCK_LIMITS.retries),
    SNAPSHOT_LOCK_LIMITS.retries * 4,
  );
  const retryMs = Math.min(
    positiveInt(envValue(env, SNAPSHOT_ENV.lockRetryMs), SNAPSHOT_LOCK_LIMITS.retryMs),
    SNAPSHOT_LOCK_LIMITS.retryMs * 10,
  );
  const staleMs = Math.min(
    positiveInt(envValue(env, SNAPSHOT_ENV.lockStaleMs), SNAPSHOT_LOCK_LIMITS.staleMs),
    SNAPSHOT_LOCK_LIMITS.staleMs * 4,
  );
  return Object.freeze({ enabled: !disabled, retries, retryMs, staleMs });
}

/** 损坏文件是否先迁移到 `<name>.<ts>.corrupt` 再继续（默认关闭：保留现场供排查）。 */
export function snapshotsQuarantineCorrupt(env = process.env) {
  const value = envValue(env, SNAPSHOT_ENV.quarantine).toLowerCase();
  return value === 'on' || value === '1' || value === 'true' || value === 'yes';
}

/**
 * 同步睡眠（锁重试需要阻塞等待；MCP 的写入路径本身就是同步 fs 调用）。
 * 优先用 Atomics.wait（不占 CPU）；环境不支持时退化为忙等，保证语义一致。
 */
export function sleepSync(ms) {
  const waitMs = Math.floor(Number(ms) || 0);
  if (waitMs <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    return;
  } catch {
    // SharedArrayBuffer/Atomics 不可用（极少见）时忙等，仍然是确定性的有限等待。
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    // 忙等兜底
  }
}

function lockFileName(file) {
  return path.join(path.dirname(file), '.' + path.basename(file) + '.lock');
}

/**
 * 抢一个同目录 `.lock` 文件锁（O_EXCL 创建；抢不到按 retryMs 重试，可接管过期锁）。
 *
 * @returns {{ ok:boolean, lockFile:string, attempts:number, staleTaken:number, waitedMs:number,
 *             timedOut:boolean, error:Error|null }}
 */
export function acquireFileLock(file, {
  fsImpl = fs,
  retries = SNAPSHOT_LOCK_LIMITS.retries,
  retryMs = SNAPSHOT_LOCK_LIMITS.retryMs,
  staleMs = SNAPSHOT_LOCK_LIMITS.staleMs,
  now = () => Date.now(),
  sleep = sleepSync,
} = {}) {
  const target = path.resolve(String(file));
  const lockFile = lockFileName(target);
  try { fsImpl.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* 目录已存在 */ }
  const startedAt = now();
  const maxAttempts = Math.max(1, Math.floor(Number(retries) || 0) + 1);
  let attempts = 0;
  let staleTaken = 0;
  let lastError = null;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      // wx = O_CREAT|O_EXCL|O_WRONLY：原子抢锁，两个进程只有一个能成功。
      const fd = fsImpl.openSync(lockFile, 'wx', 0o600);
      try {
        fsImpl.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString(), file: target }), 'utf8');
        try { fsImpl.fsyncSync(fd); } catch { /* 个别文件系统不支持 fsync */ }
      } catch { /* 锁内容只是诊断信息，写不进去不影响锁语义 */ }
      try { fsImpl.closeSync(fd); } catch { /* 忽略 */ }
      return { ok: true, lockFile, attempts, staleTaken, waitedMs: Math.max(0, now() - startedAt), timedOut: false, error: null };
    } catch (error) {
      lastError = error;
      if (!error || error.code !== 'EEXIST') {
        // 权限/磁盘错误：不重试，交给调用方降级（原子写仍然安全）。
        return { ok: false, lockFile, attempts, staleTaken, waitedMs: Math.max(0, now() - startedAt), timedOut: false, error };
      }
      // 抢不到：判断锁是否过期（进程被杀 → 锁文件留了下来）。
      let stale = false;
      try {
        const stat = fsImpl.statSync(lockFile);
        stale = (now() - stat.mtimeMs) > staleMs;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          fsImpl.unlinkSync(lockFile);
          staleTaken += 1;
          // 接管后立即重试（不占等待预算里的 sleep）。
          attempts -= 1;
          if (attempts < 0) attempts = 0;
          continue;
        } catch { /* 另一个进程刚释放/抢走：继续按正常重试走 */ }
      }
      if (attempts >= maxAttempts) break;
      if (typeof sleep === 'function') sleep(Math.max(0, Number(retryMs) || 0));
    }
  }
  return { ok: false, lockFile, attempts, staleTaken, waitedMs: Math.max(0, now() - startedAt), timedOut: true, error: lastError };
}

/** 释放锁（忽略失败：文件可能已被清理，或另一个进程已接管）。 */
export function releaseFileLock(lock, { fsImpl = fs } = {}) {
  const lockFile = lock && lock.lockFile;
  if (!lockFile) return false;
  try {
    fsImpl.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/** 写锁结果的可序列化摘要（不暴露绝对路径，便于 stats / 测试断言）。 */
export function lockReport(held, { enabled = true } = {}) {
  return Object.freeze({
    enabled,
    acquired: Boolean(held && held.ok),
    skipped: enabled === false,
    fallback: enabled === true && !(held && held.ok),
    attempts: held ? Number(held.attempts) || 0 : 0,
    staleTaken: held ? Number(held.staleTaken) || 0 : 0,
    waitedMs: held ? Number(held.waitedMs) || 0 : 0,
    timedOut: Boolean(held && held.timedOut),
  });
}

/** 资源 label → 磁盘文件名（只允许安全字符，禁止路径穿越）。 */
export function snapshotFileName(label) {
  const safe = String(label == null ? '' : label).trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!safe || safe === '.' || safe === '..') throw new Error('快照 label 非法：' + String(label));
  return safe + '.json';
}

function clipUtf8(text, maxBytes) {
  const value = String(text);
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  // 从 UTF-8 字节边界回退，避免把多字节字符切成替换字符。
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch {
    return JSON.stringify({ persistedTruncated: true, unserializable: true });
  }
}

/**
 * 原子写：同目录临时文件（wx 独占）→ 写入 → fsync → rename。
 * 默认先抢同目录 `<name>.lock` 文件锁（可 `lock:false` 关闭），让“读-改-写”在进程间串行；
 * 抢不到锁时不失败：退回纯原子写（last-writer-wins），并在返回的 lock 报告里如实标记 fallback。
 * 失败时清理临时文件并抛出原错误；不会留下半截目标文件。
 * @returns {{ file:string, tmp:string, bytes:number, lock:object }}
 */
export function atomicWriteFileSync(file, text, { fsImpl = fs, lock = true, lockOptions = {} } = {}) {
  const target = path.resolve(String(file));
  const dir = path.dirname(target);
  fsImpl.mkdirSync(dir, { recursive: true });
  const held = lock
    ? acquireFileLock(target, { fsImpl, ...(lockOptions || {}) })
    : { ok: false, lockFile: null, attempts: 0, staleTaken: 0, waitedMs: 0, timedOut: false, error: null };
  try {
    const token = process.pid + '.' + Date.now().toString(36) + '.' + Math.random().toString(16).slice(2, 8);
    const tmp = path.join(dir, '.' + path.basename(target) + '.' + token + '.tmp');
    let fd = null;
    try {
      fd = fsImpl.openSync(tmp, 'wx', 0o600);
      fsImpl.writeFileSync(fd, String(text), 'utf8');
      try {
        fsImpl.fsyncSync(fd);
      } catch {
        // 某些文件系统/沙箱不支持 fsync；写入本身已经成功，不为此失败。
      }
      fsImpl.closeSync(fd);
      fd = null;
      fsImpl.renameSync(tmp, target);
      return { file: target, tmp, bytes: Buffer.byteLength(String(text), 'utf8'), lock: lockReport(held, { enabled: lock }) };
    } catch (error) {
      if (fd !== null) {
        try { fsImpl.closeSync(fd); } catch { /* 忽略清理失败 */ }
      }
      try { fsImpl.unlinkSync(tmp); } catch { /* 临时文件可能未创建 */ }
      throw error;
    }
  } finally {
    if (held.ok) releaseFileLock(held, { fsImpl });
  }
}

/**
 * 把内存快照条目裁剪成可落盘条目：
 *   - 过期条目丢弃；
 *   - 单条 payload 超过 maxEntryBytes 时写成 { persistedTruncated, originalBytes, preview }；
 *   - 保留 label/meta/at，重启后仍能判断来源与时间。
 * @returns {{ entries:Array, droppedExpired:number, truncatedEntries:number }}
 */
export function buildSnapshotEntries(entries, { limits = SNAPSHOT_LIMITS, now = Date.now() } = {}) {
  const rows = [];
  let droppedExpired = 0;
  let truncatedEntries = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const key = String(entry.key == null ? 'latest' : entry.key);
    const at = Date.parse(String(entry.at || ''));
    if (!Number.isFinite(at) || now - at > limits.ttlMs) {
      droppedExpired += 1;
      continue;
    }
    const serialized = safeStringify(entry.payload);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');
    let payload = entry.payload;
    let truncated = false;
    if (payloadBytes > limits.maxEntryBytes) {
      truncated = true;
      truncatedEntries += 1;
      payload = {
        persistedTruncated: true,
        originalBytes: payloadBytes,
        preview: clipUtf8(serialized, Math.max(64, limits.maxEntryBytes - 256)),
      };
    }
    rows.push({
      key,
      at: new Date(at).toISOString(),
      label: String(entry.label || ''),
      meta: entry.meta && typeof entry.meta === 'object' ? { ...entry.meta } : {},
      payload,
      payloadBytes,
      truncated,
    });
  }
  return { entries: rows, droppedExpired, truncatedEntries };
}

/** 编码快照文件（紧凑 JSON + 换行；体积优先于可读性，调试可用 CLI 读）。 */
export function encodeSnapshotDocument({ label, savedAt, limits, entries }) {
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    label,
    savedAt,
    limits: { ...limits },
    entries: Array.isArray(entries) ? entries : [],
  }) + '\n';
}

/**
 * 解码并校验快照文件；任何形状不符都返回 { ok:false, corrupt:true }，由调用方决定清理。
 * @returns {{ ok:boolean, label?:string, savedAt?:string, entries?:Array, expired?:number, corrupt?:boolean, error?:string }}
 */
export function decodeSnapshotDocument(text, { label, limits = SNAPSHOT_LIMITS, now = Date.now() } = {}) {
  let document;
  try {
    document = JSON.parse(String(text));
  } catch (error) {
    return { ok: false, corrupt: true, error: 'JSON 解析失败：' + String((error && error.message) || error) };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, corrupt: true, error: '快照文件根节点不是对象' };
  }
  if (document.version !== SNAPSHOT_VERSION) {
    return { ok: false, corrupt: true, error: '快照文件版本不匹配：' + JSON.stringify(document.version) };
  }
  if (label != null && String(document.label || '') !== String(label)) {
    return { ok: false, corrupt: true, error: '快照 label 不匹配：' + JSON.stringify(document.label) };
  }
  if (!Array.isArray(document.entries)) {
    return { ok: false, corrupt: true, error: '快照 entries 不是数组' };
  }
  const entries = [];
  let expired = 0;
  for (const row of document.entries) {
    if (!row || typeof row !== 'object' || typeof row.key !== 'string') continue;
    const at = Date.parse(String(row.at || ''));
    if (!Number.isFinite(at)) continue;
    if (now - at > limits.ttlMs) {
      expired += 1;
      continue;
    }
    entries.push({
      key: row.key,
      at: new Date(at).toISOString(),
      label: typeof row.label === 'string' ? row.label : '',
      meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
      payload: row.payload === undefined ? null : row.payload,
      payloadBytes: Number(row.payloadBytes) || 0,
      truncated: row.truncated === true,
      persisted: true,
    });
  }
  return {
    ok: true,
    label: typeof document.label === 'string' ? document.label : null,
    savedAt: typeof document.savedAt === 'string' ? document.savedAt : null,
    entries,
    expired,
  };
}

/**
 * 快照持久化句柄。所有方法都不应让调用方失败：磁盘错误只记录到 stats/lastError，
 * 内存里的 resources 仍然可用（降级为“本次进程内有效”）。
 */
export class SnapshotPersistence {
  constructor({ dir, limits = SNAPSHOT_LIMITS, env = process.env, now = () => Date.now(), fsImpl = fs, quarantineCorrupt } = {}) {
    if (!dir) throw new Error('SnapshotPersistence 需要 dir');
    this.dir = path.resolve(String(dir));
    this.limits = Object.freeze({ ...SNAPSHOT_LIMITS, ...(limits || {}) });
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.fs = fsImpl;
    this.enabled = !snapshotsDisabled(env);
    // 写锁参数可由 limits.lock 注入（单测精确控制重试），否则读环境变量。
    this.lock = Object.freeze({
      ...resolveSnapshotLock(env),
      ...(limits && limits.lock && typeof limits.lock === 'object' ? limits.lock : {}),
    });
    this.quarantineCorrupt = quarantineCorrupt === undefined
      ? snapshotsQuarantineCorrupt(env)
      : quarantineCorrupt === true;
    this.lastSweepAt = 0;
    this.lastLoad = null;
    this.lastSave = null;
    this.lastError = null;
    this.counters = {
      loads: 0,
      loadFailures: 0,
      saves: 0,
      saveFailures: 0,
      corruptFiles: 0,
      quarantinedFiles: 0,
      truncatedEntries: 0,
      droppedExpired: 0,
      droppedForSize: 0,
      prunedEntries: 0,
      removedTmp: 0,
      removedLocks: 0,
      removedFiles: 0,
      lockAcquired: 0,
      lockStaleTaken: 0,
      lockFallbacks: 0,
      lockWaits: 0,
    };
  }

  filePath(label) {
    return path.join(this.dir, snapshotFileName(label));
  }

  /** 损坏文件迁移到 `<file>.<timestamp>.corrupt`，保留现场供排查；返回新路径或 null。 */
  quarantine(file) {
    const target = file + '.' + this.now() + '.corrupt';
    try {
      this.fs.renameSync(file, target);
      this.counters.quarantinedFiles += 1;
      return target;
    } catch (error) {
      this.lastError = error;
      return null;
    }
  }

  /**
   * 读一个 label 的快照文件；不存在/损坏都返回可判断的结构，不抛异常。
   * 损坏时若开启 quarantineCorrupt（BB_MCP_SNAPSHOT_QUARANTINE=on）先把文件改名留证，
   * 之后的新写入会重新生成合法文件（自愈）；默认只报告不移动，交给 sweep 按 TTL 清理。
   */
  load(label) {
    const file = this.filePath(label);
    if (!this.enabled) return { ok: false, disabled: true, file, entries: [] };
    let text;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, missing: true, file, entries: [] };
      this.counters.loadFailures += 1;
      this.lastError = error;
      return { ok: false, file, entries: [], error: String((error && error.message) || error) };
    }
    const decoded = decodeSnapshotDocument(text, { label, limits: this.limits, now: this.now() });
    if (!decoded.ok) {
      this.counters.corruptFiles += 1;
      this.lastError = new Error(decoded.error || '快照损坏');
      const quarantined = this.quarantineCorrupt ? this.quarantine(file) : null;
      this.lastLoad = { file, ok: false, corrupt: true, quarantined, at: new Date(this.now()).toISOString() };
      return { ...decoded, file, entries: [], quarantined };
    }
    this.counters.loads += 1;
    this.lastLoad = {
      file,
      ok: true,
      entries: decoded.entries.length,
      expired: decoded.expired || 0,
      bytes: Buffer.byteLength(text, 'utf8'),
      at: new Date(this.now()).toISOString(),
    };
    return { ...decoded, file };
  }

  /**
   * 原子写一个 label 的全部快照条目；总大小超限时按最旧优先淘汰。
   * @returns {{ skipped?:boolean, file?:string, bytes?:number, entries?:number, droppedExpired?:number, droppedForSize?:number, truncatedEntries?:number, error?:string }}
   */
  save(label, entries) {
    if (!this.enabled) return { skipped: true, disabled: true };
    const now = this.now();
    let built;
    try {
      built = buildSnapshotEntries(entries, { limits: this.limits, now });
    } catch (error) {
      this.counters.saveFailures += 1;
      this.lastError = error;
      return { error: String((error && error.message) || error) };
    }
    const document = {
      label: String(label),
      savedAt: new Date(now).toISOString(),
      limits: this.limits,
      entries: built.entries,
    };
    let text = encodeSnapshotDocument(document);
    let droppedForSize = 0;
    while (Buffer.byteLength(text, 'utf8') > this.limits.maxTotalBytes && document.entries.length > 0) {
      document.entries.shift();
      droppedForSize += 1;
      text = encodeSnapshotDocument(document);
    }
    try {
      const written = atomicWriteFileSync(this.filePath(label), text, {
        fsImpl: this.fs,
        lock: this.lock.enabled,
        lockOptions: { retries: this.lock.retries, retryMs: this.lock.retryMs, staleMs: this.lock.staleMs },
      });
      this.counters.saves += 1;
      this.counters.truncatedEntries += built.truncatedEntries;
      this.counters.droppedExpired += built.droppedExpired;
      this.counters.droppedForSize += droppedForSize;
      this.recordLockReport(written.lock);
      this.lastSave = {
        file: written.file,
        bytes: written.bytes,
        entries: document.entries.length,
        droppedExpired: built.droppedExpired,
        droppedForSize,
        truncatedEntries: built.truncatedEntries,
        lock: written.lock,
        at: new Date(now).toISOString(),
      };
      return {
        file: written.file,
        bytes: written.bytes,
        entries: document.entries.length,
        droppedExpired: built.droppedExpired,
        droppedForSize,
        truncatedEntries: built.truncatedEntries,
        lock: written.lock,
      };
    } catch (error) {
      this.counters.saveFailures += 1;
      this.lastError = error;
      return { error: String((error && error.message) || error), code: SNAPSHOT_ERRORS.WRITE_FAILED };
    }
  }

  /** 把一次写锁结果计入 counters（降级/接管/等待都要能解释）。 */
  recordLockReport(report) {
    if (!report || report.skipped) return;
    if (report.acquired) {
      this.counters.lockAcquired += 1;
      if (report.waitedMs > 0 || report.attempts > 1) this.counters.lockWaits += 1;
      if (report.staleTaken > 0) this.counters.lockStaleTaken += report.staleTaken;
    } else {
      this.counters.lockFallbacks += 1;
      this.lastError = new Error('快照写锁未能获取（已降级为原子写，可能发生并发覆盖）：' + report.attempts + ' 次尝试');
    }
  }

  /**
   * 目录清理：删除遗留临时文件、过期锁文件、损坏文件、条目已全部过期的文件，并把部分过期的
   * 文件重写为只剩未过期条目。只处理本目录下的 `*.json` / `*.tmp` / `*.lock`，不递归。
   * @returns {{ scanned:number, removedTmp:number, removedLocks:number, removedFiles:number,
   *             rewrittenFiles:number, prunedEntries:number }}
   */
  sweep() {
    const report = { scanned: 0, removedTmp: 0, removedLocks: 0, removedFiles: 0, rewrittenFiles: 0, prunedEntries: 0 };
    if (!this.enabled) return report;
    this.lastSweepAt = this.now();
    let names;
    try {
      names = this.fs.readdirSync(this.dir);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') this.lastError = error;
      return report;
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith('.lock')) {
        // 过期锁（持有进程被杀）会阻塞后续写锁，按 staleMs 清理；新鲜锁可能是别的进程正在写，保留。
        report.scanned += 1;
        try {
          const stat = this.fs.statSync(file);
          if (this.now() - stat.mtimeMs > this.lock.staleMs) {
            this.fs.unlinkSync(file);
            report.removedLocks += 1;
          }
        } catch { /* 并发释放/不可 stat 的锁忽略 */ }
        continue;
      }
      if (name.endsWith('.corrupt')) {
        // 隔离出来的损坏文件同样按 TTL 清理（保留窗口内供人工排查）。
        report.scanned += 1;
        try {
          const stat = this.fs.statSync(file);
          if (this.now() - stat.mtimeMs > this.limits.ttlMs) {
            this.fs.unlinkSync(file);
            report.removedFiles += 1;
          }
        } catch { /* 忽略 */ }
        continue;
      }
      if (name.endsWith('.tmp')) {
        report.scanned += 1;
        try {
          const stat = this.fs.statSync(file);
          if (this.now() - stat.mtimeMs > this.limits.tmpMaxAgeMs) {
            this.fs.unlinkSync(file);
            report.removedTmp += 1;
          }
        } catch { /* 并发删除/不可 stat 的临时文件忽略 */ }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      report.scanned += 1;
      let text;
      try {
        text = this.fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const decoded = decodeSnapshotDocument(text, { limits: this.limits, now: this.now() });
      if (!decoded.ok) {
        // 损坏文件：先保留一段时间供人工排查，超过 TTL 再删。
        let old = false;
        try {
          const stat = this.fs.statSync(file);
          old = this.now() - stat.mtimeMs > this.limits.ttlMs;
        } catch { old = false; }
        if (old) {
          try { this.fs.unlinkSync(file); report.removedFiles += 1; } catch { /* 忽略 */ }
        }
        continue;
      }
      if (decoded.expired > 0) {
        report.prunedEntries += decoded.expired;
        this.counters.prunedEntries += decoded.expired;
        if (decoded.entries.length === 0) {
          try {
            this.fs.unlinkSync(file);
            report.removedFiles += 1;
          } catch { /* 忽略 */ }
          continue;
        }
        // 把 label 从文件名还原（避免信任文件内 label 造成路径问题）。
        const label = name.slice(0, -'.json'.length);
        const text2 = encodeSnapshotDocument({
          label,
          savedAt: new Date(this.now()).toISOString(),
          limits: this.limits,
          entries: decoded.entries,
        });
        try {
          const rewritten = atomicWriteFileSync(file, text2, {
            fsImpl: this.fs,
            lock: this.lock.enabled,
            lockOptions: { retries: this.lock.retries, retryMs: this.lock.retryMs, staleMs: this.lock.staleMs },
          });
          this.recordLockReport(rewritten.lock);
          report.rewrittenFiles += 1;
        } catch (error) {
          this.lastError = error;
        }
      }
    }
    this.counters.removedTmp += report.removedTmp;
    this.counters.removedLocks += report.removedLocks;
    this.counters.removedFiles += report.removedFiles;
    return report;
  }

  /** 按 cleanupIntervalMs 节流地清理；返回 null 表示本次跳过。 */
  maybeSweep() {
    if (!this.enabled) return null;
    if (this.now() - this.lastSweepAt < this.limits.cleanupIntervalMs) return null;
    return this.sweep();
  }

  /** 统计（只读快照；每次计算目录体积，目录很小）。 */
  stats() {
    let files = 0;
    let bytes = 0;
    try {
      for (const name of this.fs.readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        files += 1;
        try { bytes += this.fs.statSync(path.join(this.dir, name)).size; } catch { /* 忽略 */ }
      }
    } catch { /* 目录尚未创建 */ }
    return Object.freeze({
      enabled: this.enabled,
      dir: this.dir,
      files,
      bytes,
      limits: this.limits,
      lock: this.lock,
      quarantineCorrupt: this.quarantineCorrupt,
      lastSweepAt: this.lastSweepAt ? new Date(this.lastSweepAt).toISOString() : null,
      lastLoad: this.lastLoad,
      lastSave: this.lastSave,
      lastError: this.lastError ? String((this.lastError && this.lastError.message) || this.lastError) : null,
      counters: Object.freeze({ ...this.counters }),
    });
  }
}
