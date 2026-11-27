// src/lib/action-journal.js —— 动作预写日志（write-ahead journal / WAL）。
//
// 目标：动作**在派发到页面之前**先落一条 intent 记录；动作结束再落 commit / unknown。
// 如果扩展 service worker 在动作中途被杀（MV3 常见）、浏览器崩溃或 debugger 断连，
// 重启后能读到「有 begin、没有终态」的记录，把它们一律标成 UNKNOWN：页面效果未知，
// **不得自动重放**，必须由人或 Agent 检查页面后显式 resolve。
//
// 三种落地形态（同一套记录格式，均为 JSONL 行）：
//   - memory  ：无持久化环境（node 单测/没有 storage 的宿主），只留内存；
//   - file    ：node/daemon 场景，append 后 fsync，验证 <3ms 预算（见单测计时）；
//   - storage ：扩展 service worker，写 chrome.storage.session（同一浏览器会话内
//               跨 SW 重启存活，正好覆盖“SW 被杀”的崩溃面）。
//
// 隐私：只记录方法名、参数**键名**、目标定位（ref/selector/数字坐标）、行锚点摘要
// （索引 + 文本/键的哈希），绝不落输入值、密码、剪贴板文本、页面正文。

import { createActionTransaction } from './transaction-ledger.js';

const JOURNAL_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_LATENCY_SAMPLES = 256;
const DEFAULT_LATENCY_BUDGET_MS = 3;
const STORAGE_KEY = '__bb_action_journal__';
const TERMINAL_KINDS = new Set(['commit', 'abort', 'unknown', 'recovered', 'resolve', 'cleanup']);

// 参数键里不允许落盘的内容（值一律丢弃，键名本身也脱敏）。
const SECRET_KEY = /token|password|passwd|secret|value|text|clipboard|cookie|authorization/i;
const TARGET_KEYS = ['ref', 'selector', 'key', 'url', 'tabId', 'frameId', 'windowId', 'backendNodeId', 'visualIndex'];

function defaultMonotonic() {
  try {
    if (globalThis.performance && typeof globalThis.performance.now === 'function') {
      return () => globalThis.performance.now();
    }
  } catch {
    // 忽略：回退到 Date.now
  }
  return () => Date.now();
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** FNV-1a 32 位哈希：给日志做不可逆摘要（行文本/键不落原文）。 */
export function fnv1a(value) {
  const text = String(value == null ? '' : value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
}

/** 参数键名：过滤秘密类键，保持稳定排序，便于跨记录比对。 */
export function journalKeys(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params).filter((key) => !SECRET_KEY.test(key)).sort();
}

/** 目标摘要：只保留能定位目标的字段，不保存文本内容。 */
export function journalTarget(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const summary = {};
  for (const key of TARGET_KEYS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      summary[key] = value.slice(0, 120);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      summary[key] = value;
    } else if (typeof value === 'boolean') {
      summary[key] = value;
    }
  }
  return Object.keys(summary).length ? summary : null;
}

/**
 * 行锚点摘要：虚拟列表的 aria-rowindex/data-index/rowKey/rowText/transform 用来证明
 * “动作打的是同一行”。文本与键只留哈希，避免把页面正文写进磁盘日志。
 */
export function rowAnchorDigest(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const pick = (name) => (anchor[name] === undefined || anchor[name] === null ? null : anchor[name]);
  const numbers = (name) => {
    const value = Number(pick(name));
    return Number.isFinite(value) ? value : null;
  };
  const rowText = pick('rowText') !== null ? pick('rowText') : pick('text');
  const rowKey = pick('rowKey');
  return {
    ariaRowIndex: numbers('ariaRowIndex'),
    dataIndex: numbers('dataIndex'),
    rowKeyHash: rowKey === null ? null : fnv1a(rowKey),
    rowTextHash: rowText === null ? null : fnv1a(rowText),
    rowTextLength: rowText === null ? null : String(rowText).length,
    transform: pick('transform') === null ? null : String(pick('transform')).slice(0, 120),
    containerScrollTop: numbers('containerScrollTop'),
    recycled: pick('recycled') === true,
  };
}

function iso(value) {
  const ms = Number(value);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function serializeRecords(records) {
  return (records || []).map((record) => JSON.stringify(record)).join('\n') + ((records || []).length ? '\n' : '');
}

function parseRecords(text) {
  const records = [];
  let invalid = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && typeof record.id === 'string') records.push(record);
      else invalid += 1;
    } catch {
      // 崩溃时最后一行可能只写了一半：忽略残行，不阻断恢复。
      invalid += 1;
    }
  }
  return { records, invalid };
}

// ---------------------------------------------------------------------------
// Sink：append(record) / readAll() / truncate(records)，全部 async（storage 必须等待完成
// 才算“预写成功”）。memory/file 形态内部同步，await 只花一个微任务。
// ---------------------------------------------------------------------------

export function createMemorySink({ maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  let records = [];
  return {
    kind: 'memory',
    durable: false,
    async append(record) {
      records.push(record);
      if (records.length > maxEntries * 4) records = records.slice(-maxEntries * 2);
      return { ok: true, bytes: JSON.stringify(record).length };
    },
    async readAll() {
      return { records: records.slice(), invalid: 0, source: 'memory' };
    },
    async truncate(next) {
      records = (next || []).slice();
    },
    snapshot() {
      return { kind: 'memory', records: records.length, now: iso(now()) };
    },
  };
}

/**
 * JSONL 文件 sink：每次 append 用 O_APPEND + fsync 落盘，再返回。
 * fs、fsync 均可注入，方便单测证明“写前日志已持久化”和 <3ms 预算。
 * fd 常驻复用（每次 open/close 会多一次元数据开销）；fsyncMode:
 *   'fsync'（默认，fsync 存在时）/ 'fdatasync' / false（只 append，不保证介质落盘）。
 */
export function createFileSink({ file, fs, fsync = true, fsyncMode = null, mode = 0o600, now = Date.now } = {}) {
  if (!file) throw new Error('createFileSink 需要 file 路径');
  const nodeFs = fs || (globalThis.__BB_FS__ ? globalThis.__BB_FS__ : null);
  if (!nodeFs) throw new Error('createFileSink 需要注入 fs（扩展 service worker 请用 storage sink）');
  let ready = false;
  let fd = null;
  let fsyncCalls = 0;
  let bytesWritten = 0;
  const resolvedFsyncMode = fsync !== true
    ? false
    : (fsyncMode === 'fdatasync' || fsyncMode === 'fsync' ? fsyncMode : 'fsync');
  function ensureDir() {
    if (ready) return;
    const dir = String(file).replace(/[\\/][^\\/]+$/, '');
    if (dir && nodeFs.mkdirSync) nodeFs.mkdirSync(dir, { recursive: true });
    ready = true;
  }
  function ensureFd() {
    ensureDir();
    if (fd !== null) return fd;
    if (typeof nodeFs.openSync !== 'function') return null;
    fd = nodeFs.openSync(file, 'a', mode);
    return fd;
  }
  function closeFd() {
    if (fd === null) return;
    try {
      nodeFs.closeSync(fd);
    } catch {
      // 已关闭/进程退出竞态：忽略
    }
    fd = null;
  }
  return {
    kind: 'file',
    durable: resolvedFsyncMode !== false,
    fsyncMode: resolvedFsyncMode,
    fsyncCalls() {
      return fsyncCalls;
    },
    bytesWritten() {
      return bytesWritten;
    },
    close: closeFd,
    async append(record) {
      const line = JSON.stringify(record) + '\n';
      bytesWritten += Buffer.byteLength(line, 'utf8');
      const opened = ensureFd();
      if (opened !== null) {
        nodeFs.writeSync(opened, line);
        if (resolvedFsyncMode === 'fdatasync' && typeof nodeFs.fdatasyncSync === 'function') {
          nodeFs.fdatasyncSync(opened);
          fsyncCalls += 1;
        } else if (resolvedFsyncMode === 'fsync' && typeof nodeFs.fsyncSync === 'function') {
          nodeFs.fsyncSync(opened);
          fsyncCalls += 1;
        }
        return { ok: true, bytes: line.length, fsynced: resolvedFsyncMode !== false };
      }
      nodeFs.appendFileSync(file, line, { encoding: 'utf8', mode });
      return { ok: true, bytes: line.length, fsynced: false };
    },
    async readAll() {
      let text = '';
      try {
        text = nodeFs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') return { records: [], invalid: 0, source: 'file', created: false };
        throw error;
      }
      const parsed = parseRecords(text);
      return { ...parsed, source: 'file', bytes: text.length };
    },
    async truncate(next) {
      // 换文件前必须先关旧 fd，否则新 fd 会写到被 rename 掉的旧 inode。
      closeFd();
      ensureDir();
      const temp = file + '.tmp';
      const text = serializeRecords(next);
      nodeFs.writeFileSync(temp, text, { encoding: 'utf8', mode });
      if (nodeFs.renameSync) nodeFs.renameSync(temp, file);
      else nodeFs.writeFileSync(file, text, { encoding: 'utf8', mode });
      bytesWritten = Buffer.byteLength(text, 'utf8');
    },
    snapshot() {
      return { kind: 'file', file: String(file), fsync: resolvedFsyncMode, fsyncCalls, now: iso(now()) };
    },
  };
}

/**
 * chrome.storage 形态：整段 JSONL 文本存在一个 key 下（session/local 均可）。
 * 每次 append 做 read-modify-write 并 await，保证“预写完成”先于动作派发。
 */
export function createStorageSink({ storage, key = STORAGE_KEY, area = 'session', now = Date.now } = {}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new Error('createStorageSink 需要 chrome.storage 形状的对象（get/set）');
  }
  let records = [];
  let initialized = false;
  let writes = 0;
  async function ensureLoaded() {
    if (initialized) return;
    initialized = true;
    try {
      const box = await storage.get(key);
      const text = box && typeof box === 'object' ? box[key] : null;
      if (typeof text === 'string' && text) {
        const parsed = parseRecords(text);
        records = parsed.records;
      }
    } catch {
      // 读失败保持空账本：预写日志是可降级能力，但不能阻断动作。
    }
  }
  async function flush() {
    writes += 1;
    await storage.set({ [key]: serializeRecords(records) });
    return writes;
  }
  return {
    kind: 'storage:' + area,
    durable: true,
    async append(record) {
      await ensureLoaded();
      records.push(record);
      await flush();
      return { ok: true, bytes: JSON.stringify(record).length };
    },
    async readAll() {
      await ensureLoaded();
      return { records: records.slice(), invalid: 0, source: 'storage:' + area };
    },
    async truncate(next) {
      await ensureLoaded();
      records = (next || []).slice();
      await flush();
    },
    snapshot() {
      return { kind: 'storage:' + area, key, records: records.length, writes, now: iso(now()) };
    },
  };
}

export function createNullSink() {
  return {
    kind: 'null',
    durable: false,
    async append() {
      return { ok: true, bytes: 0 };
    },
    async readAll() {
      return { records: [], invalid: 0, source: 'null' };
    },
    async truncate() {},
    snapshot() {
      return { kind: 'null' };
    },
  };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export function createActionJournal(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const monotonic = typeof options.monotonic === 'function' ? options.monotonic : defaultMonotonic();
  const sink = options.sink || createMemorySink({ now });
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const sampleLimit = Number.isInteger(options.latencySamples) && options.latencySamples > 0 ? options.latencySamples : DEFAULT_LATENCY_SAMPLES;
  const budgetMs = Number.isFinite(options.latencyBudgetMs) ? options.latencyBudgetMs : DEFAULT_LATENCY_BUDGET_MS;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const idPrefix = typeof options.idPrefix === 'string' && options.idPrefix ? options.idPrefix : 'aj';
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : null;

  let records = [];
  let loaded = false;
  let loadPromise = null;
  let recoverPromise = null;
  let recoveryReport = null;
  let idSeq = 0;
  let appendFailures = 0;
  let lastAppendMs = null;
  let maxAppendMs = 0;
  const latencies = [];
  const states = new Map();

  const counters = { begins: 0, commits: 0, unknowns: 0, aborts: 0, resolved: 0, recovered: 0, writeErrors: 0 };

  function warn(error) {
    if (onError) {
      try {
        onError(error);
      } catch {
        // 日志回调本身失败也不能影响主流程。
      }
    }
  }

  function nextId() {
    if (idFactory) return String(idFactory(++idSeq));
    idSeq += 1;
    // 随机后缀：多个 journal 实例/进程在同一毫秒写同一账本时 id 不能撞。
    const randomPart = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    return idPrefix + '_' + Number(now()).toString(36) + '_' + randomPart + '_' + idSeq.toString(36).padStart(3, '0');
  }

  function applyRecord(record) {
    if (!record || typeof record.id !== 'string') return;
    const kind = String(record.kind || '');
    let state = states.get(record.id);
    // 只有 begin 能开一条账目；孤立终态（begin 已被压缩丢弃）直接忽略，
    // 否则会凭空造出 UNKNOWN 把正常动作误判成“结果未知”。
    if (!state && kind !== 'begin') return;
    if (kind === 'begin') {
      states.set(record.id, {
        id: record.id,
        method: record.method || '',
        tabId: record.tabId == null ? null : Number(record.tabId),
        phase: record.phase || 'pointer',
        at: record.at || null,
        state: 'pending',
        cleanupState: 'pending',
        startedMono: record.started_mp || null,
        records: 1,
      });
      counters.begins += 1;
      return;
    }
    if (!state) return;
    state.records = (state.records || 0) + 1;
    if (kind === 'commit') {
      state.state = 'committed';
      state.cleanupState = 'ok';
      state.finishedAt = record.at || null;
      state.durationMs = record.duration_ms == null ? null : Number(record.duration_ms);
      counters.commits += 1;
    } else if (kind === 'abort') {
      state.state = 'aborted';
      state.cleanupState = 'ok';
      state.finishedAt = record.at || null;
      state.reason = record.reason || null;
      counters.aborts += 1;
    } else if (kind === 'unknown') {
      state.state = 'unknown';
      state.cleanupState = 'failed';
      state.finishedAt = record.at || null;
      state.reason = record.reason || null;
      state.evidence = record.evidence || null;
      counters.unknowns += 1;
    } else if (kind === 'recovered') {
      state.state = 'unknown';
      state.cleanupState = 'failed';
      state.recoveredAt = record.at || null;
      state.reason = record.reason || 'journal-restart';
      counters.recovered += 1;
    } else if (kind === 'cleanup') {
      state.cleanupState = record.state === 'ok' ? 'ok' : 'failed';
    } else if (kind === 'resolve') {
      state.state = 'resolved';
      state.outcome = record.outcome || 'confirmed';
      state.resolvedAt = record.at || null;
      state.resolvedBy = record.by || null;
      counters.resolved += 1;
    }
  }

  function rebuild() {
    states.clear();
    for (const record of records) applyRecord(record);
  }

  async function ensureLoaded() {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const read = await sink.readAll();
          records = Array.isArray(read && read.records) ? read.records.slice() : [];
          rebuild();
        } catch (error) {
          warn(error);
        } finally {
          loaded = true;
        }
      })();
    }
    await loadPromise;
  }

  async function append(record, { measure = true } = {}) {
    const started = measure ? monotonic() : 0;
    let durable = true;
    try {
      await sink.append(record);
    } catch (error) {
      // 持久化失败降级为内存账本：动作可用性优先，但在 stats/结果里标 degraded。
      durable = false;
      appendFailures += 1;
      counters.writeErrors += 1;
      warn(error);
    }
    const elapsed = measure ? Math.max(0, monotonic() - started) : 0;
    records.push(record);
    if (records.length > maxEntries * 4) {
      // 压缩时保留“已存在 UNKNOWN/未确认”的账目，避免丢掉仍需 resolve 的预写记录。
      const unresolvedIds = new Set();
      for (const state of states.values()) {
        if (state.state === 'unknown' || state.state === 'pending') unresolvedIds.add(state.id);
      }
      if (record.kind === 'begin') unresolvedIds.add(record.id);
      const kept = records.filter((item) => unresolvedIds.has(item.id));
      const rest = records.filter((item) => !unresolvedIds.has(item.id));
      records = [...kept, ...rest.slice(-maxEntries * 2)];
    }
    applyRecord(record);
    if (measure) {
      lastAppendMs = elapsed;
      if (elapsed > maxAppendMs) maxAppendMs = elapsed;
      latencies.push(elapsed);
      if (latencies.length > sampleLimit) latencies.shift();
    }
    return { ok: true, durable, latencyMs: elapsed };
  }

  function latencySummary() {
    const sorted = latencies.slice().sort((a, b) => a - b);
    const at = (ratio) => (sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]) : null);
    const mean = sorted.length ? sorted.reduce((sum, item) => sum + item, 0) / sorted.length : 0;
    return {
      samples: sorted.length,
      lastMs: round(lastAppendMs),
      maxMs: round(maxAppendMs),
      meanMs: round(mean),
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      budgetMs,
      withinBudget: sorted.length ? Math.max(...sorted) <= budgetMs : null,
      appendFailures,
    };
  }

  /** 崩溃恢复：把“有 begin、没终态”的账目一律标 UNKNOWN，返回 reconcile 结果。 */
  async function recover(options = {}) {
    await ensureLoaded();
    const startedAt = monotonic();
    const reason = String(options.reason || 'service-worker-restart');
    const stale = [];
    for (const state of states.values()) {
      if (state.state === 'pending') stale.push(state);
    }
    const report = {
      ok: true,
      journal: sink.kind,
      durable: sink.durable === true,
      at: iso(now()),
      scanned: records.length,
      pending: stale.length,
      unknown: [],
      reconcile: [],
      durationMs: 0,
    };
    for (const state of stale) {
      const ageMs = state.at ? Math.max(0, Number(now()) - Date.parse(state.at)) : null;
      const evidence = {
        journal_restart: true,
        last_state: 'pending',
        phase: state.phase,
        method: state.method,
        age_ms: Number.isFinite(ageMs) ? ageMs : null,
      };
      await append({
        v: JOURNAL_VERSION,
        id: state.id,
        kind: 'recovered',
        at: iso(now()),
        state: 'unknown',
        reason,
        method: state.method,
        tabId: state.tabId,
        phase: state.phase,
        evidence,
      });
      state.state = 'unknown';
      state.cleanupState = 'failed';
      report.unknown.push({
        id: state.id,
        method: state.method,
        tabId: state.tabId,
        phase: state.phase,
        at: state.at,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        effectState: 'unknown',
        cleanupState: 'failed',
        replay: false,
      });
      report.reconcile.push({
        id: state.id,
        method: state.method,
        phase: state.phase,
        // 明确给出“下一步”：先观察页面，再显式 resolve；不允许自动重放。
        action: 'observe-then-resolve',
        outcomes: ['confirmed', 'not-applied'],
        hint: '页面可能已被修改：先 observe/截图核对，再调用 resolve 标 confirmed 或 not-applied',
      });
    }
    // counters.recovered 已由 applyRecord 在 append 时累加，这里不再重复。
    report.durationMs = round(Math.max(0, monotonic() - startedAt));
    report.cleanupState = report.unknown.length ? 'needs-resolve' : 'ok';
    recoveryReport = report;
    if (report.unknown.length) {
      // 恢复后压缩一次：保留未确认 + 最近终态记录，避免日志无限增长。
      await compact({ keepTerminal: 40 });
    }
    return report;
  }

  async function ensureRecovered() {
    if (!recoverPromise) recoverPromise = recover();
    return recoverPromise;
  }

  /** 动作派发前的预写：调用方 await 它完成后再派发。 */
  async function begin(entry = {}) {
    await ensureRecovered();
    const id = nextId();
    const startedMono = round(monotonic());
    const target = entry.target && typeof entry.target === 'object' ? entry.target : journalTarget(entry.params);
    const anchor = rowAnchorDigest(entry.rowAnchor || (entry.params && entry.params.rowAnchor));
    const record = {
      v: JOURNAL_VERSION,
      id,
      kind: 'begin',
      at: iso(now()),
      started_mp: startedMono,
      method: String(entry.method || ''),
      tabId: entry.tabId == null ? null : Number(entry.tabId),
      phase: String(entry.phase || 'pointer'),
      keys: journalKeys(entry.params),
      ...(target ? { target } : {}),
      ...(anchor ? { row_anchor: anchor } : {}),
      ...(entry.txId ? { tx_id: String(entry.txId) } : {}),
      state: 'pending',
    };
    const written = await append(record);
    return {
      ok: true,
      id,
      at: record.at,
      state: 'pending',
      durable: written.durable,
      latencyMs: round(written.latencyMs),
      ...(recoveryReport && recoveryReport.unknown.length ? { recovered: recoveryReport.unknown.slice(0, 20) } : {}),
    };
  }

  async function finish(id, kind, payload = {}) {
    await ensureLoaded();
    const state = states.get(String(id));
    if (!state) return { ok: false, code: 'E_NOT_FOUND', message: '账本没有这个预写记录：' + id };
    if (state.state !== 'pending') {
      return { ok: false, code: 'E_BAD_ARG', message: '预写记录已终态（' + state.state + '）：' + id, state: state.state };
    }
    const durationMs = state.at ? Math.max(0, Number(now()) - Date.parse(state.at)) : null;
    const record = {
      v: JOURNAL_VERSION,
      id: state.id,
      kind,
      at: iso(now()),
      method: state.method,
      tabId: state.tabId,
      phase: state.phase,
      duration_ms: Number.isFinite(durationMs) ? durationMs : null,
      ...(payload.reason ? { reason: String(payload.reason) } : {}),
      ...(payload.outcome ? { outcome: String(payload.outcome) } : {}),
      ...(payload.evidence ? { evidence: payload.evidence } : {}),
      ...(payload.details && typeof payload.details === 'object' ? { details: payload.details } : {}),
    };
    const written = await append(record);
    return { ok: true, id: state.id, state: kind === 'commit' ? 'committed' : kind === 'abort' ? 'aborted' : 'unknown', durable: written.durable, latencyMs: round(written.latencyMs) };
  }

  function commit(id, details = {}) {
    return finish(id, 'commit', { details: details.details || details, evidence: details.evidence });
  }

  function abort(id, reason = 'no-effect', evidence = null) {
    return finish(id, 'abort', { reason, evidence });
  }

  function unknown(id, evidence = null, reason = 'effect-unknown') {
    return finish(id, 'unknown', { reason, evidence });
  }

  /**
   * 清理结果单独记账：清理发生在 commit/unknown 之后，不能再走 finish 的 pending 闸门。
   */
  async function cleanup(id, ok, evidence = null) {
    await ensureLoaded();
    const state = states.get(String(id));
    if (!state) return { ok: false, code: 'E_NOT_FOUND', message: '账本没有这个记录：' + id };
    const record = {
      v: JOURNAL_VERSION,
      id: state.id,
      kind: 'cleanup',
      at: iso(now()),
      method: state.method,
      tabId: state.tabId,
      phase: state.phase,
      state: ok ? 'ok' : 'failed',
      ...(evidence ? { evidence } : {}),
    };
    const written = await append(record);
    return { ok: true, id: state.id, cleanupState: ok ? 'ok' : 'failed', durable: written.durable };
  }

  /** 显式 resolve：只有 UNKNOWN 账目需要，且必须由调用方给出结论。 */
  async function resolve(id, options = {}) {
    await ensureLoaded();
    const state = states.get(String(id));
    if (!state) return { ok: false, code: 'E_NOT_FOUND', message: '账本没有这个记录：' + id };
    if (state.state !== 'unknown') {
      return { ok: false, code: 'E_BAD_ARG', message: '只有 UNKNOWN 账目需要 resolve（当前 ' + state.state + '）' };
    }
    const outcome = String(options.outcome || 'confirmed');
    const record = {
      v: JOURNAL_VERSION,
      id: state.id,
      kind: 'resolve',
      at: iso(now()),
      outcome,
      by: options.by ? String(options.by).slice(0, 80) : 'agent',
      ...(options.note ? { note: String(options.note).slice(0, 300) } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
    };
    const written = await append(record);
    return { ok: true, id: state.id, state: 'resolved', outcome, durable: written.durable };
  }

  /** tab 上是否有未确认的 UNKNOWN：动作层据此提示，但不自动重放。 */
  function blocksTab(tabId) {
    const id = Number(tabId);
    if (!Number.isInteger(id)) return null;
    for (const state of states.values()) {
      if (state.tabId === id && state.state === 'unknown') {
        return {
          id: state.id,
          method: state.method,
          phase: state.phase,
          at: state.at,
          cleanupState: state.cleanupState,
          recurrence: 'requires-explicit-resolve',
        };
      }
    }
    return null;
  }

  function pending(options = {}) {
    const id = options.tabId == null ? null : Number(options.tabId);
    const list = [];
    for (const state of states.values()) {
      if (state.state !== 'unknown') continue;
      if (id !== null && state.tabId !== id) continue;
      list.push({ ...state });
    }
    return list;
  }

  function stateOf(id) {
    const state = states.get(String(id));
    return state ? { ...state } : null;
  }

  function status() {
    return {
      journal: sink.kind,
      durable: sink.durable === true,
      version: JOURNAL_VERSION,
      records: records.length,
      ...counters,
      pendingUnknown: pending().length,
      latency: latencySummary(),
      recovered: recoveryReport ? { at: recoveryReport.at, unknown: recoveryReport.unknown.length, cleanupState: recoveryReport.cleanupState } : null,
    };
  }

  async function compact(options = {}) {
    await ensureLoaded();
    const keepTerminal = Number.isInteger(options.keepTerminal) && options.keepTerminal >= 0 ? options.keepTerminal : 40;
    const unresolved = [];
    const terminal = [];
    for (const record of records) {
      const state = states.get(record.id);
      if (state && state.state === 'unknown') unresolved.push(record);
      else terminal.push(record);
    }
    const kept = [...unresolved, ...terminal.slice(-keepTerminal)];
    try {
      await sink.truncate(kept);
      records = kept;
      rebuild();
      return { ok: true, kept: kept.length, dropped: unresolved.length + terminal.length - kept.length };
    } catch (error) {
      warn(error);
      return { ok: false, code: 'E_INTERNAL', message: String((error && error.message) || error) };
    }
  }

  function exportJSONL() {
    return serializeRecords(records);
  }

  function entries() {
    return records.slice();
  }

  async function flush() {
    if (typeof sink.flush === 'function') return sink.flush();
    return { ok: true };
  }

  return {
    begin,
    commit,
    abort,
    unknown,
    cleanup,
    resolve,
    recover,
    ensureRecovered,
    blocksTab,
    pending,
    stateOf,
    status,
    latency: latencySummary,
    compact,
    exportJSONL,
    entries,
    flush,
    get recoveredReport() {
      return recoveryReport;
    },
    _sink: sink,
  };
}

// ---------------------------------------------------------------------------
// 单例：扩展运行时用 chrome.storage.session（跨 SW 重启存活），其它宿主退内存。
// ---------------------------------------------------------------------------

let singleton = null;
let singletonError = null;

export function selectDefaultSink() {
  try {
    const storage = globalThis.chrome && globalThis.chrome.storage;
    const session = storage && (storage.session || storage.local);
    if (session && typeof session.get === 'function' && typeof session.set === 'function') {
      return createStorageSink({ storage: session, area: storage.session ? 'session' : 'local' });
    }
  } catch (error) {
    singletonError = String((error && error.message) || error);
  }
  return createMemorySink();
}

export function getActionJournal() {
  if (!singleton) {
    singleton = createActionJournal({ sink: selectDefaultSink() });
  }
  return singleton;
}

/** 测试注入：替换单例（传 null 复位）。 */
export function setActionJournal(journal) {
  singleton = journal || null;
  return singleton;
}

export function actionJournalError() {
  return singletonError;
}

/**
 * 动作事务入口：预写 journal（await 完成后调用方才能派发）→ 返回事务句柄。
 * journal 不可用时降级为纯内存事务，绝不阻断动作。
 */
export async function beginJournaledTransaction({ method = '', params = null, phase = 'pointer', journal = null } = {}) {
  const instance = journal || getActionJournal();
  const source = params && typeof params === 'object' ? params : {};
  const tabId = Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : null;
  const rowAnchor = source.rowAnchor && typeof source.rowAnchor === 'object' ? source.rowAnchor
    : (source.row_anchor && typeof source.row_anchor === 'object' ? source.row_anchor : null);
  try {
    const transaction = createActionTransaction({
      phase,
      journal: instance,
      method,
      tabId,
      params: source,
      rowAnchor,
    });
    const begun = await transaction.begin();
    return {
      tx: transaction,
      journal: instance,
      begun,
      degraded: false,
      // 重启后恢复出的 UNKNOWN 记录（reconcile 建议随动作结果返回，提示先核对再 resolve）。
      recovered: begun && Array.isArray(begun.recovered) ? begun.recovered : [],
    };
  } catch (error) {
    // 预写失败（存储不可用/被禁用）：降级成不落盘的事务，动作仍可执行，但结果里带 degraded。
    const transaction = createActionTransaction({ phase, journal: null, method, tabId, params: source, rowAnchor });
    const begun = await transaction.begin();
    return { tx: transaction, journal: null, begun, degraded: true, recovered: [], error: String((error && error.message) || error) };
  }
}

/** 崩溃恢复入口：启动/首个动作前调用，返回 reconcile 报告。 */
export async function recoverActionJournal(journal = null) {
  const instance = journal || getActionJournal();
  return instance.recover();
}

export { JOURNAL_VERSION, TERMINAL_KINDS };
