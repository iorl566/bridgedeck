// lib/intent-ledger.mjs —— 预写意图账本（write-ahead intent ledger）v2。
//
// 目的：所有会改变页面/浏览器状态的操作，先在本机落一条脱敏的意图记录；
// 如果操作超时、被取消或连接断开，把它标记为 unknown/stale。
// 之后同一个 tab 上新的变异操作会被拦截，直到用户/Agent 明确 resolve，
// 避免"状态未知时盲目重放"。只读与诊断命令不受影响。
//
// v2 在 0.3.0 的 snapshot + 裸 JSONL 基础上补齐兼容目标同级的持久化语义：
//   1) 记录帧带 v/seq/kind/at/sum（sha256 截断），可检测损坏行与乱序/重复记录；
//   2) 可注入存储（memory / file），文件存储 append 后 fsync，snapshot 用
//      temp + fsync + rename + 目录 fsync，崩溃时 WAL 是权威增量；
//   3) recover() 把上次进程遗留的 pending（active）按要求升级为 unknown，
//      并带上 recovered/recoveryReason/replayBlocked 证据；load() 保持 0.3.0 的
//      stale 语义，供既有调用方与测试继续使用；
//   4) 非幂等动作（click/fill/upload/...）在 UNKNOWN 恢复后禁止自动重放，
//      必须显式 resolve('confirmed' | 'not-applied')；
//   5) resolve 幂等：同结论重复 resolve 返回 duplicate 证据、不重复写 WAL；
//      结论冲突抛 E_LEDGER_CONFLICT（含双方证据）。
//
// 记录只保存方法名、参数键名、session/tab id，不保存参数值（填表内容、token、密码等）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMutating } from './methods.mjs';

export { isMutating };

/** 条目生命周期：active=已预写未结算；stale=超时未结算；unknown=崩溃/断连后未知。 */
export const LEDGER_STATES = Object.freeze(['active', 'stale', 'unknown', 'done', 'failed', 'resolved']);

/** WAL 帧版本：v2 = { v, seq, kind, id, at, entry, sum }；无 v 的行按 0.3.0 裸条目兼容。 */
export const WAL_FRAME_VERSION = 2;

/** 写入 WAL 的结算种类。 */
export const WAL_KINDS = Object.freeze(['begin', 'commit', 'unknown', 'failed', 'resolve']);

const UNKNOWN_OUTCOMES = new Set([
  'E_TIMEOUT', 'E_DAEMON_TIMEOUT', 'E_EXTENSION_GONE', 'E_DISCONNECTED', 'E_CANCELLED',
]);

// 这些错误在派发前就已判定失败（找不到目标、参数不合法、选项不匹配、禁用控件等），
// 页面不会被改动，因此不需要冻结标签页等待人工 resolve。
const NO_EFFECT_CODES = new Set([
  'E_BAD_ARG', 'E_INVALID_PARAMS', 'E_NOT_FOUND', 'E_TARGET_NOT_FILLABLE',
  'E_NOT_ACTIONABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS', 'E_NOT_SELECT', 'E_FORBIDDEN', 'E_CURSOR_STALE',
  'E_TARGET_MISMATCH',
  // 共享 tab 控制权拒绝发生在派发前，页面没有被改动。
  'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_CONTROL_STALE',
]);

/**
 * 非幂等动作：一旦结果 UNKNOWN，重放可能产生第二次真实副作用（双击提交、重复上传、
 * 重复输入/导航）。这些动作恢复后必须由人/Agent 明确 resolve 才能解锁同 tab。
 */
export const NON_IDEMPOTENT_METHODS = new Set([
  'click', 'click-backend', 'click-point', 'hover', 'fill', 'type', 'press', 'select', 'focus', 'blur',
  'drag', 'wheel', 'scroll-to', 'upload', 'download', 'navigate', 'navigate-back', 'navigate-forward',
  'reload', 'back', 'forward', 'evaluate', 'plan', 'step', 'webmcp.call',
  'dialog.accept', 'dialog.dismiss', 'tab.new', 'tab.close', 'tab.select', 'tab.move', 'tab.borrow',
  'window.new', 'window.close', 'window.focus', 'window.resize', 'window.ensure',
  'session.start', 'session.stop', 'session.rebind', 'session.pause',
  'video.start', 'video.stop', 'debug.fetch_probe', 'debug.rule_add', 'debug.rule_clear', 'debug.replay',
]);

/** 该动作是否属于“不可自动重放”的非幂等副作用。 */
export function isNonIdempotentAction(method) {
  return NON_IDEMPOTENT_METHODS.has(String(method || ''));
}

const RESOLVE_OUTCOMES = Object.freeze({
  confirmed: { effect: 'applied', explicit: true },
  'not-applied': { effect: 'none', explicit: true },
  applied: { effect: 'applied', explicit: true },
  none: { effect: 'none', explicit: true },
  // 0.3.0 的旧结论：仍接受（CLI 默认 outcome=abandoned），但不是显式二选一。
  abandoned: { effect: 'unknown', explicit: false },
  reconciled: { effect: 'unknown', explicit: false },
});

export const LEDGER_RESOLVE_OUTCOMES = Object.freeze(Object.keys(RESOLVE_OUTCOMES));

export function normalizeResolveOutcome(outcome) {
  const text = String(outcome === undefined || outcome === null || outcome === '' ? 'abandoned' : outcome).trim().toLowerCase();
  return RESOLVE_OUTCOMES[text] ? { outcome: text, ...RESOLVE_OUTCOMES[text] } : null;
}

export function isExplicitResolveOutcome(outcome) {
  const normalized = normalizeResolveOutcome(outcome);
  return Boolean(normalized && normalized.explicit);
}

export function isUnknownOutcome(error) {
  if (!error) return false;
  // effect_state / dispatched 可能落在 error 顶层，也可能在 error.data 里（daemon 新格式）。
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  const none = error.effectState === 'none' || error.effect_state === 'none'
    || data.effect_state === 'none' || data.effectState === 'none'
    || error.dispatched === false || data.dispatched === false;
  if (none) return false;
  if (NO_EFFECT_CODES.has(error.code)) return false;
  if (UNKNOWN_OUTCOMES.has(error.code)) return true;
  const text = String(error.message || '');
  return /timeout|timed out|ECONNRESET|socket|disconnected|断开/i.test(text);
}

/** 该错误是否可证明"页面/浏览器状态没有改变"（派发前就失败）。 */
export function hasNoEffect(error) {
  if (!error) return false;
  const data = error.data && typeof error.data === 'object' ? error.data : {};
  return NO_EFFECT_CODES.has(error.code)
    || error.effectState === 'none' || error.effect_state === 'none'
    || data.effect_state === 'none' || data.effectState === 'none'
    || error.dispatched === false || data.dispatched === false;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function checksumOf(frame) {
  const payload = JSON.stringify({
    v: frame.v,
    seq: frame.seq,
    kind: frame.kind,
    id: frame.id,
    at: frame.at,
    entry: frame.entry,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function cloneEntry(entry) {
  return entry && typeof entry === 'object' ? JSON.parse(JSON.stringify(entry)) : entry;
}

// ---------------------------------------------------------------------------
// 可注入存储：内存（测试/降级）与文件（daemon 默认，带 fsync）
// ---------------------------------------------------------------------------

/**
 * 内存 WAL 存储：测试崩溃注入用。`failAppendAfter` 模拟部分写入失败的存储；
 * `injectRaw()` 可写入损坏行/截断行/乱序行。
 */
export function createMemoryLedgerStorage({ snapshot = null, wal = '', failAppendAfter = Infinity, failSync = false } = {}) {
  let snapshotText = snapshot;
  let walText = wal;
  let appendCount = 0;
  const storage = {
    kind: 'memory',
    paths: { snapshot: null, wal: null },
    reads: 0,
    writes: 0,
    appends: 0,
    truncates: 0,
    syncs: 0,
    readSnapshot() {
      storage.reads += 1;
      return snapshotText;
    },
    readWal() {
      storage.reads += 1;
      return walText;
    },
    writeSnapshot(text) {
      storage.writes += 1;
      snapshotText = String(text);
    },
    appendWal(line) {
      appendCount += 1;
      if (appendCount > failAppendAfter) {
        const error = new Error('模拟 WAL 写入失败（磁盘满/拔盘）');
        error.code = 'E_LEDGER_WAL_IO';
        throw error;
      }
      storage.appends += 1;
      walText += String(line);
    },
    truncateWal() {
      storage.truncates += 1;
      walText = '';
    },
    sync() {
      storage.syncs += 1;
      if (failSync) {
        const error = new Error('模拟 fsync 失败');
        error.code = 'E_LEDGER_FSYNC';
        throw error;
      }
      return true;
    },
    /** 测试钩子：直接注入原始文本（损坏行/半行/乱序）。 */
    injectRaw(text) {
      walText += String(text);
    },
    /** 测试钩子：读取原始 WAL 文本。 */
    readWalRaw() {
      return walText;
    },
    snapshotText() {
      return snapshotText;
    },
  };
  return storage;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fsyncPath(target, flags = 'r') {
  let fd = null;
  try {
    fd = fs.openSync(target, flags);
    fs.fsyncSync(fd);
    return true;
  } catch {
    // Windows 上目录 fsync 会抛 EPERM/EISDIR：文件本身已 fsync，目录项丢失窗口可接受。
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

/**
 * 文件 WAL 存储。
 * - appendWal：open('a') → write → fsync → close（预写持久化，先于动作派发）。
 * - writeSnapshot：mkdtemp 同目录 temp → write → fsync → rename → 目录 fsync。
 * - truncateWal：snapshot 已覆盖全部状态后才截断；截断后 fsync。
 */
export function createFileLedgerStorage(dir, { fsync = true } = {}) {
  if (!dir) throw new Error('FileLedgerStorage needs a directory');
  const snapshotPath = path.join(dir, 'ledger.json');
  const walPath = path.join(dir, 'ledger.wal');
  let dirReady = false;
  const storage = {
    kind: 'file',
    fsync: fsync === true,
    dir,
    paths: { snapshot: snapshotPath, wal: walPath },
    syncs: 0,
    appends: 0,
    writes: 0,
    truncates: 0,
    lastError: null,
    prepare() {
      if (!dirReady) {
        ensureDir(dir);
        dirReady = true;
      }
    },
    readSnapshot() {
      try { return fs.readFileSync(snapshotPath, 'utf8'); } catch { return null; }
    },
    readWal() {
      try { return fs.readFileSync(walPath, 'utf8'); } catch { return ''; }
    },
    appendWal(line) {
      storage.prepare();
      const fd = fs.openSync(walPath, 'a', 0o600);
      try {
        fs.writeSync(fd, String(line));
        if (storage.fsync) {
          fs.fsyncSync(fd);
          storage.syncs += 1;
        }
      } finally {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
      }
      storage.appends += 1;
    },
    writeSnapshot(text) {
      storage.prepare();
      const temp = snapshotPath + '.tmp';
      fs.writeFileSync(temp, String(text), { encoding: 'utf8', mode: 0o600 });
      if (storage.fsync) {
        fsyncPath(temp, 'r+');
        storage.syncs += 1;
      }
      fs.renameSync(temp, snapshotPath);
      if (storage.fsync) fsyncPath(dir);
      storage.writes += 1;
    },
    truncateWal() {
      storage.prepare();
      // 没有 WAL 是正常状态。
      try { fs.truncateSync(walPath, 0); } catch { return; }
      if (storage.fsync) {
        fsyncPath(walPath, 'r+');
        storage.syncs += 1;
      }
      storage.truncates += 1;
    },
    sync() {
      if (!storage.fsync) return true;
      storage.prepare();
      try { fsyncPath(walPath, 'r+'); } catch { /* 忽略 */ }
      storage.syncs += 1;
      return true;
    },
  };
  return storage;
}

// ---------------------------------------------------------------------------
// WAL 解析：容错、去重、乱序重排、损坏证据
// ---------------------------------------------------------------------------

/**
 * 解析 WAL 文本。返回按 seq 排序、去重后的帧，以及审计计数。
 * 容错策略：
 * - JSON 损坏 / checksum 不匹配 / 缺 id → corrupted +1 并跳过；
 * - 末尾没有换行的半行 → 记为 tornTail（部分写入的正常形态，不算损坏）；
 * - 乱序 seq → outOfOrder +1，仍按 seq 重排后应用；
 * - 重复帧 → duplicates +1，只应用一次。
 * 0.3.0 的裸条目行（无 v/kind）按出现顺序当 legacy 帧读取。
 */
export function parseWalRecords(text, { now = Date.now } = {}) {
  const stats = {
    lines: 0,
    parsed: 0,
    corrupted: 0,
    tornTail: false,
    duplicates: 0,
    outOfOrder: 0,
    legacy: 0,
    lastSeq: 0,
    corruptSamples: [],
  };
  const raw = String(text === undefined || text === null ? '' : text);
  if (!raw.trim()) return { records: [], stats };
  const lines = raw.split(/\r?\n/);
  // split 后最后一个空串表示文本以换行结尾；否则最后一段可能是半行。
  const endsWithNewline = /\r?\n$/.test(raw);
  const records = [];
  const seen = new Set();
  let lineNo = 0;
  let lastSeq = -1;
  for (const line of lines) {
    lineNo += 1;
    if (!line.trim()) continue;
    stats.lines += 1;
    const isLast = lineNo === lines.length;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline) stats.tornTail = true;
      else {
        stats.corrupted += 1;
        if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'json' });
      }
      continue;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      stats.corrupted += 1;
      if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'shape' });
      continue;
    }
    if (frame.v === WAL_FRAME_VERSION) {
      const seq = Number(frame.seq);
      if (!Number.isInteger(seq) || seq < 0 || typeof frame.id !== 'string' || !frame.id) {
        stats.corrupted += 1;
        if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'frame' });
        continue;
      }
      if (frame.sum !== undefined && frame.sum !== checksumOf(frame)) {
        stats.corrupted += 1;
        if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'checksum' });
        continue;
      }
      if (!WAL_KINDS.includes(frame.kind)) {
        stats.corrupted += 1;
        if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'kind' });
        continue;
      }
      const key = seq + '|' + frame.kind + '|' + frame.id;
      if (seen.has(key)) {
        stats.duplicates += 1;
        continue;
      }
      seen.add(key);
      if (seq < lastSeq) stats.outOfOrder += 1;
      lastSeq = seq;
      stats.parsed += 1;
      records.push({
        seq,
        kind: frame.kind,
        id: frame.id,
        at: typeof frame.at === 'string' ? frame.at : iso(now()),
        entry: frame.entry,
        frame,
      });
    } else {
      // 0.3.0 兼容：整行就是 entry 快照。
      const entry = frame;
      if (typeof entry.id !== 'string' || !entry.id) {
        stats.corrupted += 1;
        if (stats.corruptSamples.length < 5) stats.corruptSamples.push({ line: lineNo, reason: 'legacy-id' });
        continue;
      }
      const seq = lineNo;
      if (seq < lastSeq) stats.outOfOrder += 1;
      lastSeq = seq;
      stats.legacy += 1;
      stats.parsed += 1;
      records.push({ seq, kind: 'legacy', id: entry.id, at: entry.at || iso(now()), entry });
    }
  }
  records.sort((a, b) => a.seq - b.seq);
  stats.lastSeq = records.length ? records[records.length - 1].seq : 0;
  return { records, stats };
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class LedgerBlockedError extends Error {
  constructor(entry, { reason = 'pending' } = {}) {
    const age = Math.max(0, Math.round((Date.now() - Date.parse(entry.at)) / 1000));
    const state = entry.state || 'active';
    const recovered = entry.recovered === true ? '，由上次进程崩溃恢复' : '';
    const nonIdempotent = entry.nonIdempotent === true ? '（非幂等动作，已禁止自动重放）' : '';
    super(
      `同一标签页存在未确认的变异操作（${entry.method}，${entry.id}，${state}，${age}s 前${recovered}${nonIdempotent}），已拦截重放。` +
      `确认页面状态后执行 bridge ledger resolve ${entry.id} confirmed|not-applied`,
    );
    this.code = 'E_LEDGER_PENDING';
    this.id = entry.id;
    this.method = entry.method;
    this.tabId = entry.tabId;
    this.ageMs = age * 1000;
    this.reason = reason;
    this.state = state;
    this.data = {
      id: entry.id,
      method: entry.method,
      tabId: entry.tabId,
      sessionId: entry.sessionId ?? null,
      state,
      at: entry.at,
      ageMs: age * 1000,
      recovered: entry.recovered === true,
      recoveryReason: entry.recoveryReason || null,
      replayBlocked: entry.replayBlocked === true,
      nonIdempotent: entry.nonIdempotent === true,
      allowedOutcomes: entry.replayBlocked === true ? ['confirmed', 'not-applied'] : LEDGER_RESOLVE_OUTCOMES,
    };
  }
}

export class LedgerResolveConflictError extends Error {
  constructor(entry, attempted) {
    super(
      `账本记录 ${entry.id} 已经有结论 "${entry.outcome}"（${entry.resolution?.at || entry.resolvedAt || '未知时间'}），` +
      `再次 resolve 为 "${attempted}" 被拒绝；如需修改结论请先人工核对页面状态。`,
    );
    this.code = 'E_LEDGER_CONFLICT';
    this.id = entry.id;
    this.data = {
      id: entry.id,
      existing: {
        outcome: entry.outcome,
        effect: entry.resolution?.effect || 'unknown',
        at: entry.resolution?.at || entry.resolvedAt || null,
        by: entry.resolution?.by || null,
      },
      attempted: attempted,
      allowedOutcomes: LEDGER_RESOLVE_OUTCOMES,
    };
  }
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

function sanitizeKeys(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).filter((key) => !/token|password|secret|value|text|clipboard/i.test(key)).sort();
}

/** 目标摘要：只保留能定位的字段（ref/selector/视觉坐标），不保存文本值。 */
function sanitizeTarget(params) {
  if (!params || typeof params !== 'object') return null;
  const summary = {};
  for (const key of ['ref', 'selector', 'capture', 'imageX', 'imageY', 'imageDx', 'imageDy', 'key', 'url', 'tabId', 'windowId']) {
    if (params[key] === undefined || params[key] === null) continue;
    if (typeof params[key] === 'string') summary[key] = params[key].slice(0, 120);
    else if (typeof params[key] === 'number' || typeof params[key] === 'boolean') summary[key] = params[key];
  }
  return Object.keys(summary).length ? summary : null;
}

/** plan 的每步摘要：只记 method 与目标，便于 resolve 时知道"哪几步可能已经发生"。 */
function sanitizeSteps(params) {
  if (!params || !Array.isArray(params.steps)) return null;
  return params.steps.slice(0, 50).map((step) => {
    const source = step && typeof step === 'object' ? (step.action && typeof step.action === 'object' ? step.action : step) : {};
    const method = typeof source.method === 'string' ? source.method : (typeof step.action === 'string' ? step.action : '');
    const target = source.params && typeof source.params === 'object' ? source.params : source;
    return {
      method: method || '(unknown)',
      ...(target.ref ? { ref: String(target.ref) } : {}),
      ...(target.selector ? { selector: String(target.selector).slice(0, 120) } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export class IntentLedger {
  constructor({
    dir,
    staleMs = 15_000,
    maxEntries = 300,
    now = () => Date.now(),
    storage = null,
    fsync = true,
  } = {}) {
    if (!storage && !dir) throw new Error('IntentLedger needs a directory');
    this.dir = dir || null;
    this.storage = storage || createFileLedgerStorage(dir, { fsync: fsync === true });
    this.file = this.storage.paths ? this.storage.paths.snapshot : null;
    this.wal = this.storage.paths ? this.storage.paths.wal : null;
    this.staleMs = staleMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.seq = 1;
    this.entries = [];
    this.dirReady = false;
    this.writeTimer = null;
    // 持久化审计：daemon 启动恢复与 ledger.status 都会带上，便于定位“为什么写丢了”。
    this.walStats = {
      lines: 0,
      parsed: 0,
      corrupted: 0,
      tornTail: false,
      duplicates: 0,
      outOfOrder: 0,
      legacy: 0,
      lastSeq: 0,
      corruptSamples: [],
    };
    this.durability = {
      fsync: this.storage.kind === 'file' && this.storage.fsync === true,
      appends: 0,
      syncs: 0,
      degraded: false,
      lastError: null,
      snapshotAt: 0,
      recoveredAt: 0,
    };
    this.recovery = null;
    this.entries = this.#read();
  }

  // —— 读取 / 回放 ——

  #read() {
    const snapshotRaw = (() => {
      try { return this.storage.readSnapshot(); } catch { return null; }
    })();
    let entries = [];
    let snapshotCorrupt = 0;
    const snapshotSamples = [];
    if (snapshotRaw) {
      try {
        const parsed = JSON.parse(snapshotRaw);
        if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries.filter((item) => item && typeof item.id === 'string');
        if (parsed && typeof parsed.version === 'number') this.snapshotVersion = parsed.version;
      } catch {
        snapshotCorrupt = 1;
        snapshotSamples.push({ line: 0, reason: 'snapshot' });
      }
    }
    let walRaw = '';
    try { walRaw = this.storage.readWal() || ''; } catch { walRaw = ''; }
    const { records, stats } = parseWalRecords(walRaw, { now: this.now });
    stats.corrupted += snapshotCorrupt;
    stats.corruptSamples.push(...snapshotSamples);
    this.walStats = { ...stats, snapshotEntries: entries.length };
    this.seq = Math.max(1, Number(stats.lastSeq) || 0, 0) + 1;
    for (const record of records) {
      if (!record.entry || typeof record.entry.id !== 'string') continue;
      const index = entries.findIndex((item) => item.id === record.id);
      if (index >= 0) entries[index] = cloneEntry(record.entry);
      else entries.push(cloneEntry(record.entry));
    }
    return entries;
  }

  #ensureDir() {
    if (this.dirReady) return;
    if (this.storage && typeof this.storage.prepare === 'function') this.storage.prepare();
    else if (this.dir) ensureDir(this.dir);
    this.dirReady = true;
  }

  #appendRecord(kind, entry) {
    if (!entry || typeof entry.id !== 'string') return null;
    this.#ensureDir();
    const frame = {
      v: WAL_FRAME_VERSION,
      seq: this.seq,
      kind,
      id: entry.id,
      at: iso(this.now()),
      entry: cloneEntry(entry),
    };
    frame.sum = checksumOf(frame);
    this.seq += 1;
    try {
      this.storage.appendWal(JSON.stringify(frame) + '\n');
      this.durability.appends += 1;
      if (this.durability.fsync) {
        this.durability.syncs += 1;
        this.durability.lastSyncAt = this.now();
      }
      return frame;
    } catch (error) {
      // 持久化失败不阻断主流程：内存态仍然生效，但必须留下降级证据。
      this.durability.degraded = true;
      this.durability.lastError = { code: (error && error.code) || 'E_LEDGER_WAL_IO', message: String((error && error.message) || error) };
      return null;
    }
  }

  #write() {
    const entries = this.entries.slice(-this.maxEntries);
    try {
      this.#ensureDir();
      this.storage.writeSnapshot(JSON.stringify({ version: WAL_FRAME_VERSION, savedAt: iso(this.now()), entries }));
      // snapshot 已经包含 WAL 的全部状态，可以安全截断 WAL。
      this.storage.truncateWal();
      try { this.storage.sync(); } catch { /* 目录/文件 fsync 失败不阻断 */ }
      if (this.durability.fsync) {
        this.durability.syncs += 1;
        this.durability.lastSyncAt = this.now();
      }
      this.durability.snapshotAt = this.now();
    } catch (error) {
      // 账本写入失败不应阻断主流程；内存态仍然生效。
      this.durability.degraded = true;
      this.durability.lastError = { code: (error && error.code) || 'E_LEDGER_IO', message: String((error && error.message) || error) };
    }
  }

  #writeSoon() {
    // finish/resolve/reconcile 是“结算”写入：合并 25ms 内多次变更（一次动作只同步落一次 begin 账）。
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.#write();
    }, 25);
    if (this.writeTimer.unref) this.writeTimer.unref();
  }

  /** 立即把挂起的结算写入落盘（daemon 停止/退出前调用）。 */
  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.#write();
    return this.stats();
  }

  // —— 恢复 ——

  /**
   * 启动恢复：上次进程遗留的 active（已预写、未结算）记录一律升级为 unknown/stale。
   * 默认 unknown（参考语义：结果未知），并给非幂等动作打 replayBlocked。
   * load() 是 0.3.0 兼容入口，使用 legacyState='stale'。
   */
  recover({ legacyState = 'unknown', reason = 'daemon-restart' } = {}) {
    const at = this.now();
    const recovered = [];
    for (const entry of this.entries) {
      if (entry.state !== 'active') continue;
      const nonIdempotent = entry.nonIdempotent === true || isNonIdempotentAction(entry.method);
      entry.state = legacyState === 'stale' ? 'stale' : 'unknown';
      entry.previousState = 'active';
      entry.recovered = true;
      entry.recoveredAt = iso(at);
      entry.recoveryReason = String(reason);
      entry.replayBlocked = legacyState !== 'stale' && nonIdempotent;
      if (entry.state === 'stale') entry.staleAt = iso(at);
      recovered.push({
        id: entry.id,
        method: entry.method,
        tabId: entry.tabId,
        sessionId: entry.sessionId ?? null,
        from: 'active',
        to: entry.state,
        recoveredAt: entry.recoveredAt,
        reason: entry.recoveryReason,
        nonIdempotent,
        replayBlocked: entry.replayBlocked === true,
      });
    }
    const summary = {
      at: iso(at),
      reason: String(reason),
      recovered: recovered.length,
      unknown: recovered.filter((item) => item.to === 'unknown').length,
      stale: recovered.filter((item) => item.to === 'stale').length,
      replayBlocked: recovered.filter((item) => item.replayBlocked).length,
      entries: recovered,
      wal: { ...this.walStats },
      durability: { ...this.durability },
    };
    this.recovery = summary;
    this.durability.recoveredAt = at;
    if (recovered.length) this.#write();
    return { ...summary, entriesAll: this.entries };
  }

  /** 0.3.0 兼容：启动时把 active 记为 stale（既有测试与调用方依赖）。 */
  load() {
    this.recover({ legacyState: 'stale', reason: 'daemon-restart-legacy' });
    return this.entries;
  }

  // —— 生命周期 ——

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

  /** 该 tab 当前是否被未结算意图阻塞；返回结构化证据（不抛错）。 */
  checkReplay(method, { tabId = null, sessionId = null } = {}) {
    if (!isMutating(method)) return { ok: true, replayable: true, reason: 'read-only' };
    this.#touchStale(tabId);
    const blocker = this.#blocking(tabId);
    if (!blocker) return { ok: true, replayable: true, reason: 'clear' };
    return {
      ok: false,
      replayable: false,
      reason: 'unknown-pending',
      code: 'E_LEDGER_PENDING',
      blocker: {
        id: blocker.id,
        method: blocker.method,
        tabId: blocker.tabId,
        sessionId: blocker.sessionId ?? null,
        state: blocker.state,
        at: blocker.at,
        recovered: blocker.recovered === true,
        replayBlocked: blocker.replayBlocked === true,
        nonIdempotent: blocker.nonIdempotent === true,
        requestedMethod: String(method),
        requestedBy: sessionId == null ? null : String(sessionId),
      },
    };
  }

  /** 非幂等动作 + 恢复后的 UNKNOWN：禁止自动重放，抛 E_LEDGER_PENDING 并带证据。 */
  assertReplayAllowed(method, target = {}) {
    const decision = this.checkReplay(method, target);
    if (!decision.ok) {
      const blocker = this.entries.find((entry) => entry.id === decision.blocker.id);
      throw new LedgerBlockedError(blocker || decision.blocker, { reason: decision.reason });
    }
    return decision;
  }

  begin(method, params, { tabId = null, sessionId = null } = {}) {
    if (!isMutating(method)) return null;
    this.assertReplayAllowed(method, { tabId, sessionId });
    const entry = {
      id: 'lt_' + crypto.randomBytes(4).toString('hex'),
      at: new Date(this.now()).toISOString(),
      method: String(method),
      tabId: tabId == null ? null : Number(tabId),
      sessionId: sessionId == null ? null : String(sessionId),
      keys: sanitizeKeys(params),
      target: sanitizeTarget(params),
      ...(sanitizeSteps(params) ? { steps: sanitizeSteps(params) } : {}),
      state: 'active',
      nonIdempotent: isNonIdempotentAction(method),
      replayBlocked: false,
    };
    this.entries.push(entry);
    // 预写：begin 帧必须先于动作派发持久化（file 存储内 fsync）。
    this.#appendRecord('begin', entry);
    return entry;
  }

  finish(entry, outcome = 'done') {
    if (!entry) return null;
    const record = this.entries.find((item) => item.id === entry.id);
    if (!record || record.state !== 'active') return record || null;
    const state = ['done', 'failed', 'unknown'].includes(outcome) ? outcome : 'done';
    record.state = state;
    record.finishedAt = new Date(this.now()).toISOString();
    if (state === 'unknown') {
      record.replayBlocked = true;
      record.nonIdempotent = record.nonIdempotent === true;
    }
    this.#appendRecord(state === 'unknown' ? 'unknown' : state === 'failed' ? 'failed' : 'commit', record);
    this.#writeSoon();
    return record;
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
      recovery: this.recovery,
      wal: { ...this.walStats },
      durability: { ...this.durability },
    };
  }

  /** 同步成功后自动和解：把该 tab 上 unknown/stale 的记录标记为 resolved。 */
  reconcile(tabId, outcome = 'reconciled') {
    if (tabId == null) return 0;
    let count = 0;
    let skipped = 0;
    for (const entry of this.entries) {
      if (entry.tabId !== tabId || (entry.state !== 'stale' && entry.state !== 'unknown')) continue;
      // 崩溃恢复后的非幂等动作只能由显式 confirmed/not-applied 解锁；自动和解不得代劳。
      if (entry.recovered === true && entry.nonIdempotent === true && !isExplicitResolveOutcome(outcome)) {
        entry.replayBlocked = true;
        skipped += 1;
        continue;
      }
      this.#resolveEntry(entry, outcome);
      count += 1;
    }
    if (count || skipped) this.#writeSoon();
    if (skipped) this.lastReconcileSkipped = skipped;
    return count;
  }

  #resolveEntry(entry, outcome) {
    const normalized = normalizeResolveOutcome(outcome);
    entry.state = 'resolved';
    entry.outcome = normalized ? normalized.outcome : String(outcome || 'abandoned');
    entry.resolvedAt = new Date(this.now()).toISOString();
    entry.replayBlocked = false;
    entry.resolution = {
      outcome: entry.outcome,
      effect: normalized ? normalized.effect : 'unknown',
      explicit: normalized ? normalized.explicit : false,
      at: entry.resolvedAt,
    };
    return entry;
  }

  resolve(id, outcome = 'abandoned', { by = null } = {}) {
    const entry = this.entries.find((item) => item.id === String(id || ''));
    if (!entry) {
      const error = new Error('没有这个账本记录：' + id);
      error.code = 'E_NOT_FOUND';
      throw error;
    }
    const normalized = normalizeResolveOutcome(outcome);
    // 崩溃恢复的非幂等 UNKNOWN：必须显式二选一，否则会重新打开自动重放通道。
    if (entry.recovered === true && entry.nonIdempotent === true && !(normalized && normalized.explicit)) {
      const error = new Error(
        `账本记录 ${entry.id} 是崩溃恢复后的非幂等动作（${entry.method}），结果未知，不能用 "${outcome}" 解锁；` +
        '请确认页面状态后 resolve confirmed|not-applied',
      );
      error.code = 'E_LEDGER_RESOLVE_REQUIRED';
      error.data = {
        id: entry.id,
        method: entry.method,
        tabId: entry.tabId,
        state: entry.state,
        recovered: true,
        allowedOutcomes: ['confirmed', 'not-applied'],
      };
      throw error;
    }
    if (entry.state === 'resolved') {
      const existing = normalizeResolveOutcome(entry.outcome);
      const same = normalized && existing
        ? (normalized.outcome === existing.outcome || normalized.effect === existing.effect)
        : String(entry.outcome) === String(outcome);
      if (same) {
        // 幂等重复 resolve：不重复写 WAL，返回已有结论 + duplicate 证据。
        return { ...entry, duplicate: true, duplicateResolve: true };
      }
      throw new LedgerResolveConflictError(entry, outcome);
    }
    this.#resolveEntry(entry, outcome);
    if (by) entry.resolution.by = String(by);
    this.#appendRecord('resolve', entry);
    this.#writeSoon();
    return entry;
  }

  /** 持久化/恢复审计：ledger.status 与 daemon 启动日志共用。 */
  stats() {
    return {
      entries: {
        total: this.entries.length,
        active: this.entries.filter((entry) => entry.state === 'active').length,
        stale: this.entries.filter((entry) => entry.state === 'stale').length,
        unknown: this.entries.filter((entry) => entry.state === 'unknown').length,
        unresolved: this.entries.filter((entry) => entry.state === 'unknown' || entry.state === 'stale').length,
        replayBlocked: this.entries.filter((entry) => entry.replayBlocked === true).length,
      },
      wal: { ...this.walStats },
      durability: { ...this.durability },
      recovery: this.recovery,
      nextSeq: this.seq,
    };
  }

  /** 停止前 checkpoint：快照 + 截断 WAL + 可选最终 fsync。 */
  checkpoint() {
    this.flush();
    try { this.storage.sync(); } catch { /* 忽略 */ }
    return this.stats();
  }
}
