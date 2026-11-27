// lib/video-journal.js —— 录制分片日记（append-only 日记 / 密封 / 重放恢复，纯函数 + 原生持久化字段）。
//
// 现状：录制过程的持久化只在两处：offscreen 落一条 IndexedDB 记录（video-store）与
// mp4-fragments 的 in-stream 分片日记（FRAGMENT_JOURNAL_CODES）。这两者都是“整条记录写成功
// 才有意义”，SW 被回收/浏览器崩溃时缺的是“**录到第几片、每片多少字节、hash 是多少**”的
// 增量事实——于是：
//   1) recoverVideo 只能看到“记录里有没有 blob”，判断不出“拍到一半还是写完了”；
//   2) 中途写坏的片没有链式摘要，无法定位是哪一片坏掉（只能整条判死）；
//   3) 恢复出来的记录缺“当时预算/降级到哪一档/帧校验结论”，evidence 不闭环。
//
// 本模块定义“录制持久化日记”的数据模型与纯函数（落盘由 video.js 负责，写 chrome.storage 与
// record 字段，不新增 object store）：
//   createJournal()/appendEntry()  —— 建日记、追加分片条目（幂等：同 sequence 重复写只记 duplicate）；
//   sealJournal()                  —— 密封：条目连续、字节齐、链摘要一致才允许 sealed；
//   validateJournal()              —— 结构/顺序/缺口/链摘要自检；
//   replayJournal()                —— 重放：结合盘上可用分片算出 resume/rebuild/restart/sealed；
//   resumeJournal()                —— 幂等吸收恢复出来的条目；
//   journalChainDigest()           —— 链式摘要（每片 digest = hash(prevDigest + 条目规范串)）；
//   journalRecordFields()/summarizeJournal()/describeJournal()/journalFromRecord()。
//
// 说明：链摘要用 FNV-1a + djb2 双 32 位（与 longshot-manifest/hashLongshotBytes 同一实现思路），
// 只用于“片是否被改写/错位”的完整性判断，不是密码学签名；真正的内容校验仍走 video-verify 的
// SHA-256。这里不新增 E_ 前缀证据码，避免污染 wire 错误码 registry。

export const JOURNAL_VERSION = 1;

export const JOURNAL_STATES = Object.freeze(['open', 'sealing', 'sealed', 'recovered', 'failed']);

export const JOURNAL_ACTIONS = Object.freeze(['continue', 'resume', 'rebuild', 'restart', 'sealed', 'skip']);

export const JOURNAL_DEFAULTS = Object.freeze({
  // 一条录制的分片条目上限（10 分钟 @ 2s 一片 = 300 片，4096 足够且能挡住坏数据）。
  maxEntries: 4096,
  // 日记覆盖的字节上限（与 video.js 的 MAX_BYTES 对齐：256MB）。
  maxBytes: 256 * 1024 * 1024,
  // 允许的序号缺口（0 = 必须连续；恢复出来的日记可以带缺口语义，但必须显式记录）。
  maxGapTolerance: 0,
  // 密封宽限：封版时间早于最后一条条目时间时判失败（时钟乱序证据）。
  sealGraceMs: 5000,
  // 日记 TTL：超过一天未密封的日记只用于恢复证据，不再续写。
  maxAgeMs: 24 * 60 * 60 * 1000,
});

/** 日记内部证据码（不带 E_ 前缀，不进 wire 错误码 registry）。 */
export const JOURNAL_CODES = Object.freeze({
  ENTRY_DUPLICATE: 'journal-entry-duplicate',
  ENTRY_SEQUENCE_BACKWARDS: 'journal-sequence-backwards',
  ENTRY_GAP: 'journal-entry-gap',
  ENTRY_AFTER_SEAL: 'journal-entry-after-seal',
  ENTRY_INDEX_DUPLICATE: 'journal-index-duplicate',
  ENTRY_BYTES_ZERO: 'journal-entry-bytes-zero',
  BYTES_OVERFLOW: 'journal-bytes-overflow',
  ENTRIES_OVERFLOW: 'journal-entries-overflow',
  CHAIN_BROKEN: 'journal-chain-broken',
  SEAL_INCOMPLETE: 'journal-seal-incomplete',
  SEAL_TIME: 'journal-seal-time',
  MISSING_PARTS: 'journal-missing-parts',
  ORPHAN_PARTS: 'journal-orphan-parts',
});

function intOr(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number);
}

function clampInt(value, min, max, fallback) {
  const number = intOr(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hex32(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** 字符串/字节 → 16 hex 摘要（FNV-1a + djb2）。 */
export function journalDigestOf(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input == null) text = '';
  else text = String(input);
  const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(text) : null;
  let fnv = 2166136261 >>> 0;
  let djb = 5381 >>> 0;
  if (bytes) {
    for (let index = 0; index < bytes.length; index += 1) {
      fnv = Math.imul(fnv ^ bytes[index], 16777619) >>> 0;
      djb = ((Math.imul(djb, 33) >>> 0) + bytes[index]) >>> 0;
    }
  } else {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index) & 0xff;
      fnv = Math.imul(fnv ^ code, 16777619) >>> 0;
      djb = ((Math.imul(djb, 33) >>> 0) + code) >>> 0;
    }
  }
  return hex32(fnv) + hex32(djb);
}

function isoAt(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return new Date(number).toISOString();
  const date = typeof value === 'string' ? new Date(value) : null;
  if (date && Number.isFinite(date.getTime())) return date.toISOString();
  return new Date(fallback).toISOString();
}

function timeOf(value, fallback) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 分片键：片在 OPFS/IndexedDB 里的稳定名字（恢复时按它找 blob）。 */
export function journalPartKey(index) {
  return 'part-' + String(Math.max(0, intOr(index, 0))).padStart(6, '0');
}

/** 条目的规范串：链摘要与 wire 都用它，保证“同样的片得到同样的摘要”。 */
export function journalEntryCanonical(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  return [
    intOr(value.sequence, 0),
    intOr(value.index, 0),
    intOr(value.bytes, 0),
    String(value.hash || '').toLowerCase(),
    intOr(value.tMs, 0),
    intOr(value.durationMs, 0),
    intOr(value.frames, 0),
    String(value.key || journalPartKey(value.index)),
  ].join('|');
}

/** 归一化条目（append 与 replay 共用；越界字段一律收敛，不抛）。 */
export function normalizeJournalEntry(entry, fallbackSequence = 0) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const index = Math.max(0, intOr(value.index, fallbackSequence));
  return {
    sequence: Math.max(0, intOr(value.sequence, fallbackSequence)),
    index,
    bytes: Math.max(0, intOr(value.bytes, 0)),
    hash: String(value.hash || '').toLowerCase(),
    key: String(value.key || journalPartKey(index)),
    tMs: Math.max(0, intOr(value.tMs, 0)),
    durationMs: Math.max(0, intOr(value.durationMs, 0)),
    frames: Math.max(0, intOr(value.frames, 0)),
    keyframe: value.keyframe === true,
    at: isoAt(value.at, Date.now()),
  };
}

/**
 * 建日记。recordingId 必需；budget 只做证据保存，不在此处校验。
 * @returns {object} journal
 */
export function createJournal(params = {}) {
  const recordingId = String(params.recordingId || '');
  if (!recordingId) throw new Error('录制日记需要 recordingId');
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  return {
    version: JOURNAL_VERSION,
    recordingId,
    state: 'open',
    mime: String(params.mime || ''),
    mode: String(params.mode || ''),
    entries: [],
    nextSequence: 0,
    totalBytes: 0,
    indexes: [],
    chain: '',
    budget: params.budget && typeof params.budget === 'object' ? { ...params.budget } : null,
    degradeLevel: String(params.degradeLevel || 'none'),
    createdAt: isoAt(params.createdAt != null ? params.createdAt : now, now),
    updatedAt: isoAt(now, now),
    sealedAt: null,
    seal: null,
  };
}

function recompute(entries) {
  let chain = '';
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    chain = journalDigestOf(chain + journalEntryCanonical(entry));
  }
  return { chain, totalBytes, indexes: entries.map((entry) => entry.index) };
}

/**
 * 追加条目（幂等）：同 sequence 已存在 → duplicate，不重复计数；
 * 序号倒退 → 直接拒绝（防止乱序写把链摘要搞坏）；已封版 → 拒绝。
 * @returns {{journal: object, entry: object|null, duplicate: boolean, accepted: boolean, code: string|null}}
 */
export function appendEntry(journal, entry, options = {}) {
  if (!journal || typeof journal !== 'object') throw new Error('appendEntry 需要 journal');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const entries = Array.isArray(journal.entries) ? journal.entries.slice() : [];
  if (journal.state === 'sealed') {
    return { journal, entry: null, duplicate: false, accepted: false, code: JOURNAL_CODES.ENTRY_AFTER_SEAL };
  }
  const normalized = normalizeJournalEntry(entry, journal.nextSequence != null ? journal.nextSequence : entries.length);
  // 条目时间取“追加时刻”，而不是 normalize 的默认 now：密封时要用它判时钟乱序。
  normalized.at = isoAt(now, now);
  // 幂等键有两个：sequence（重发的同一条）与 index（同一分片重复落库）。
  const existingBySequence = entries.find((item) => intOr(item.sequence, -1) === normalized.sequence);
  if (existingBySequence) {
    return { journal, entry: existingBySequence, duplicate: true, accepted: false, code: JOURNAL_CODES.ENTRY_DUPLICATE };
  }
  const existingByIndex = entries.find((item) => intOr(item.index, -1) === normalized.index);
  if (existingByIndex) {
    return { journal, entry: existingByIndex, duplicate: true, accepted: false, code: JOURNAL_CODES.ENTRY_INDEX_DUPLICATE };
  }
  const last = entries.length ? entries[entries.length - 1] : null;
  if (last && normalized.sequence < intOr(last.sequence, 0)) {
    return { journal, entry: null, duplicate: false, accepted: false, code: JOURNAL_CODES.ENTRY_SEQUENCE_BACKWARDS };
  }
  const maxEntries = clampInt(options.maxEntries, 1, 1 << 20, JOURNAL_DEFAULTS.maxEntries);
  const maxBytes = Math.max(1, intOr(options.maxBytes, JOURNAL_DEFAULTS.maxBytes));
  if (entries.length >= maxEntries) {
    return { journal, entry: null, duplicate: false, accepted: false, code: JOURNAL_CODES.ENTRIES_OVERFLOW };
  }
  if (journal.totalBytes + normalized.bytes > maxBytes) {
    return { journal, entry: null, duplicate: false, accepted: false, code: JOURNAL_CODES.BYTES_OVERFLOW };
  }
  entries.push(normalized);
  entries.sort((a, b) => intOr(a.sequence, 0) - intOr(b.sequence, 0));
  const recalculated = recompute(entries);
  return {
    journal: {
      ...journal,
      entries,
      nextSequence: Math.max(...entries.map((item) => intOr(item.sequence, 0))) + 1,
      totalBytes: recalculated.totalBytes,
      indexes: recalculated.indexes,
      chain: recalculated.chain,
      updatedAt: isoAt(now, now),
    },
    entry: normalized,
    duplicate: false,
    accepted: true,
    code: null,
  };
}

/**
 * 密封：条目必须从 0 连续、字节合计与调用方给的总字节一致（给了才校验）、
 * 链摘要重算一致；失败返回 {ok:false, errors}，不改入参。
 * @returns {{journal: object, ok: boolean, errors: Array<object>, summary: object}}
 */
export function sealJournal(journal, options = {}) {
  if (!journal || typeof journal !== 'object') throw new Error('sealJournal 需要 journal');
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const validation = validateJournal(journal, { requireSealed: false, allowGaps: options.allowGaps === true });
  const errors = validation.errors.slice();
  const recalculated = recompute(entries.map((entry) => normalizeJournalEntry(entry, 0)));
  if (journal.chain && journal.chain !== recalculated.chain) {
    errors.push({ code: JOURNAL_CODES.CHAIN_BROKEN, message: '日记链摘要与条目不一致（可能被改写/错位）' });
  }
  const totalBytes = intOr(options.totalBytes, recalculated.totalBytes);
  if (intOr(options.totalBytes, -1) >= 0 && Math.abs(totalBytes - recalculated.totalBytes) > 0) {
    errors.push({
      code: JOURNAL_CODES.SEAL_INCOMPLETE,
      message: '总字节不一致：记录 ' + totalBytes + ' vs 日记 ' + recalculated.totalBytes,
    });
  }
  if (!entries.length && options.requireEntries !== false) {
    errors.push({ code: JOURNAL_CODES.SEAL_INCOMPLETE, message: '日记没有条目，不能密封' });
  }
  const lastAt = entries.length ? timeOf(entries[entries.length - 1].at, now) : now;
  if (now + JOURNAL_DEFAULTS.sealGraceMs < lastAt) {
    errors.push({ code: JOURNAL_CODES.SEAL_TIME, message: '密封时间早于最后一条条目（时钟乱序）' });
  }
  const sealedJournal = errors.length
    ? journal
    : {
      ...journal,
      state: 'sealed',
      entries: entries.map((entry) => normalizeJournalEntry(entry, 0)),
      totalBytes: recalculated.totalBytes,
      indexes: recalculated.indexes,
      chain: recalculated.chain,
      sealedAt: isoAt(options.sealedAt != null ? options.sealedAt : now, now),
      updatedAt: isoAt(now, now),
      seal: {
        entries: entries.length,
        bytes: recalculated.totalBytes,
        chain: recalculated.chain,
        digest: journalDigestOf(recalculated.chain + '|seal|' + entries.length + '|' + recalculated.totalBytes),
        at: isoAt(options.sealedAt != null ? options.sealedAt : now, now),
      },
    };
  return {
    journal: sealedJournal,
    ok: errors.length === 0,
    errors,
    summary: summarizeJournal(sealedJournal),
  };
}

/**
 * 结构自检：版本/状态/序号连续性/重复/字节/时间。
 * @returns {{ok: boolean, errors: Array<object>, gaps: number[], duplicates: number[], count: number, bytes: number, chain: string}}
 */
export function validateJournal(journal, options = {}) {
  const errors = [];
  const gaps = [];
  const duplicates = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    return { ok: false, errors: [{ code: 'not-object', message: '日记不是对象' }], gaps, duplicates, count: 0, bytes: 0, chain: '' };
  }
  if (intOr(journal.version, -1) !== JOURNAL_VERSION) {
    push('version', '日记版本应为 ' + JOURNAL_VERSION + '，实际 ' + journal.version);
  }
  if (!journal.recordingId || typeof journal.recordingId !== 'string') push('recordingId', '日记缺少 recordingId');
  if (!JOURNAL_STATES.includes(String(journal.state))) push('state', '日记状态未知：' + journal.state);
  const entries = Array.isArray(journal.entries) ? journal.entries : null;
  if (!entries) {
    push('entries', '日记 entries 必须是数组');
    return { ok: false, errors, gaps, duplicates, count: 0, bytes: 0, chain: journal.chain || '' };
  }
  const seenSequences = new Set();
  const seenIndexes = new Set();
  let previousSequence = -1;
  let bytes = 0;
  const allowGaps = options.allowGaps === true;
  const maxGapTolerance = allowGaps
    ? clampInt(options.maxGapTolerance, 0, 1 << 20, JOURNAL_DEFAULTS.maxGapTolerance)
    : 0;
  for (let position = 0; position < entries.length; position += 1) {
    const entry = normalizeJournalEntry(entries[position], position);
    if (seenSequences.has(entry.sequence)) {
      duplicates.push(entry.sequence);
      push(JOURNAL_CODES.ENTRY_DUPLICATE, '条目序号重复：' + entry.sequence, { sequence: entry.sequence });
    }
    seenSequences.add(entry.sequence);
    if (entry.sequence < previousSequence) {
      push(JOURNAL_CODES.ENTRY_SEQUENCE_BACKWARDS, '条目序号倒退：' + previousSequence + '→' + entry.sequence, { sequence: entry.sequence });
    }
    if (previousSequence >= 0 && entry.sequence > previousSequence + 1 + maxGapTolerance) {
      for (let missing = previousSequence + 1; missing < entry.sequence; missing += 1) gaps.push(missing);
      push(JOURNAL_CODES.ENTRY_GAP, '条目序号缺口：' + (previousSequence + 1) + '..' + (entry.sequence - 1), { sequence: entry.sequence });
    }
    if (seenIndexes.has(entry.index)) {
      push(JOURNAL_CODES.ENTRY_INDEX_DUPLICATE, '分片序号重复：' + entry.index, { index: entry.index });
    }
    seenIndexes.add(entry.index);
    if (entry.bytes <= 0) push(JOURNAL_CODES.ENTRY_BYTES_ZERO, '分片 ' + entry.index + ' 字节为 0', { index: entry.index });
    if (!entry.hash) push('hash-missing', '分片 ' + entry.index + ' 缺少 hash', { index: entry.index });
    bytes += entry.bytes;
    previousSequence = Math.max(previousSequence, entry.sequence);
  }
  if (intOr(journal.totalBytes, 0) !== bytes) {
    push('bytes-total', '日记 totalBytes ' + journal.totalBytes + ' 与条目合计 ' + bytes + ' 不一致');
  }
  if (options.requireEntries !== false && entries.length === 0) push('empty', '日记没有条目');
  if (String(journal.state) === 'sealed' && options.requireSealed !== false) {
    if (!journal.sealedAt) push('sealed-at', '已密封日记缺少 sealedAt');
    if (!journal.seal || !journal.seal.digest) push('seal', '已密封日记缺少 seal 摘要');
  }
  return {
    ok: errors.length === 0,
    errors,
    gaps: [...new Set(gaps)].sort((a, b) => a - b),
    duplicates: [...new Set(duplicates)].sort((a, b) => a - b),
    count: entries.length,
    bytes,
    chain: journal.chain || '',
  };
}

/**
 * 重放/恢复决策：日记 + 盘上可用分片 → 该继续、续写、重建、重来还是已封版。
 * @param {{
 *   journal: object|null, available?: Array<string|number|object>, now?: number,
 *   maxAgeMs?: number, manifest?: object|null,
 * }} params
 * @returns {{
 *   ok: boolean, action: string, state: string, sealed: boolean, missing: number[], orphan: number[],
 *   recovered: Array<number>, entries: number, bytes: number, reasons: string[], ageMs: number,
 * }}
 */
export function replayJournal(params = {}) {
  const journal = params.journal && typeof params.journal === 'object' ? params.journal : null;
  const now = Number.isFinite(Number(params.now)) ? Number(params.now) : Date.now();
  const maxAgeMs = Math.max(0, intOr(params.maxAgeMs, JOURNAL_DEFAULTS.maxAgeMs));
  const availableList = Array.isArray(params.available) ? params.available : [];
  const availableKeys = new Set();
  const availableIndexes = new Set();
  for (const item of availableList) {
    if (item == null) continue;
    if (typeof item === 'object') {
      if (item.key != null) availableKeys.add(String(item.key));
      const index = intOr(item.index, -1);
      if (index >= 0) availableIndexes.add(index);
    } else if (typeof item === 'number' || /^\d+$/.test(String(item))) {
      availableIndexes.add(intOr(item, 0));
    } else {
      availableKeys.add(String(item));
      const match = /(\d+)$/.exec(String(item));
      if (match) availableIndexes.add(intOr(match[1], 0));
    }
  }
  if (!journal) {
    const manifestEntries = params.manifest && Array.isArray(params.manifest.segments) ? params.manifest.segments.length : 0;
    return {
      ok: false,
      action: manifestEntries ? 'rebuild' : 'skip',
      state: 'missing',
      sealed: false,
      missing: [],
      orphan: [],
      recovered: [],
      entries: 0,
      bytes: 0,
      reasons: [manifestEntries ? '没有日记但有分片索引，按索引重建' : '没有日记也没有分片索引，无法恢复'],
      ageMs: 0,
    };
  }
  const entries = (Array.isArray(journal.entries) ? journal.entries : []).map((entry, index) => normalizeJournalEntry(entry, index));
  const expected = entries.length;
  const recovered = [];
  const missing = [];
  for (const entry of entries) {
    const reachable = availableKeys.size
      ? (availableKeys.has(entry.key) || availableIndexes.size === 0)
      : availableIndexes.has(entry.index);
    if (reachable) recovered.push(entry.index);
    else missing.push(entry.index);
  }
  const listed = new Set(entries.map((entry) => entry.index));
  const orphan = [...availableIndexes].filter((index) => !listed.has(index)).sort((a, b) => a - b);
  const updatedAt = timeOf(journal.updatedAt, now);
  const ageMs = Math.max(0, now - updatedAt);
  const reasons = [];
  if (journal.state === 'sealed') {
    if (missing.length) reasons.push('日记已密封但盘上缺 ' + missing.length + ' 片：完整性存疑');
    return {
      ok: missing.length === 0,
      action: missing.length ? 'rebuild' : 'sealed',
      state: String(journal.state),
      sealed: true,
      missing,
      orphan,
      recovered,
      entries: expected,
      bytes: intOr(journal.totalBytes, 0),
      reasons,
      ageMs,
    };
  }
  if (ageMs > maxAgeMs) {
    reasons.push('日记过期（' + Math.round(ageMs / 1000) + 's > ' + Math.round(maxAgeMs / 1000) + 's）');
    return {
      ok: true,
      action: 'restart',
      state: 'stale',
      sealed: false,
      missing: entries.map((entry) => entry.index),
      orphan,
      recovered: [],
      entries: expected,
      bytes: intOr(journal.totalBytes, 0),
      reasons,
      ageMs,
    };
  }
  if (!entries.length) {
    reasons.push('日记为空（录制还没写出第一片）');
    return { ok: true, action: 'continue', state: 'empty', sealed: false, missing: [], orphan, recovered: [], entries: 0, bytes: 0, reasons, ageMs };
  }
  if (missing.length) {
    reasons.push('日记记录 ' + expected + ' 片，盘上缺 ' + missing.length + ' 片：可恢复前缀/洞');
    // 第一片就缺 → 容器没有 init segment，只能重来。
    if (missing.includes(0)) {
      reasons.push('首片缺失（没有 init 分片），无法重建容器');
      return { ok: false, action: 'restart', state: 'broken', sealed: false, missing, orphan, recovered, entries: expected, bytes: intOr(journal.totalBytes, 0), reasons, ageMs };
    }
    return { ok: true, action: 'rebuild', state: 'partial', sealed: false, missing, orphan, recovered, entries: expected, bytes: intOr(journal.totalBytes, 0), reasons, ageMs };
  }
  if (orphan.length) reasons.push('盘上有 ' + orphan.length + ' 片不在日记里（旧录制残留？）');
  return {
    ok: true,
    action: 'resume',
    state: 'open',
    sealed: false,
    missing: [],
    orphan,
    recovered,
    entries: expected,
    bytes: intOr(journal.totalBytes, 0),
    reasons: reasons.concat(['日记完整：可补写密封并恢复为可播放记录']),
    ageMs,
  };
}

/** 幂等吸收恢复出来的条目（重复/倒序只记证据）。 */
export function resumeJournal(journal, entries, options = {}) {
  if (!journal || typeof journal !== 'object') return { journal, accepted: [], duplicates: [], rejected: [], changed: false };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  let current = journal;
  const accepted = [];
  const duplicates = [];
  const rejected = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const result = appendEntry(current, entry, { ...options, now });
    if (result.accepted) {
      current = result.journal;
      accepted.push(intOr(result.entry && result.entry.sequence, 0));
    } else if (result.duplicate) {
      duplicates.push(intOr(result.entry && result.entry.sequence, 0));
    } else {
      rejected.push({ entry, code: result.code });
    }
  }
  return { journal: current, accepted, duplicates, rejected, changed: accepted.length > 0 };
}

/**
 * 落盘字段（写进 video record / chrome.storage 的扁平结构，读记录即可重建日记）。
 * 只放摘要与条目列表，不放 blob。
 */
export function journalRecordFields(journal, options = {}) {
  if (!journal || typeof journal !== 'object') return {};
  const maxEntries = clampInt(options.maxEntries, 0, 4096, 256);
  const entries = (Array.isArray(journal.entries) ? journal.entries : []).slice(-maxEntries).map((entry) => {
    const value = normalizeJournalEntry(entry, 0);
    return {
      seq: value.sequence,
      index: value.index,
      bytes: value.bytes,
      hash: value.hash,
      key: value.key,
      t: value.tMs,
      frames: value.frames,
    };
  });
  const summary = summarizeJournal(journal);
  return {
    journal_version: JOURNAL_VERSION,
    journal_state: String(journal.state || 'open'),
    journal_entries: entries.length,
    journal_bytes: intOr(journal.totalBytes, 0),
    journal_chain: String(journal.chain || ''),
    journal_digest: summary.digest,
    journal_parts: entries,
    journal_recovered: journal.state === 'recovered' ? true : undefined,
  };
}

/** 从 record 还原日记（remux/恢复路径：只有落盘字段时用）。 */
export function journalFromRecord(record, options = {}) {
  const source = record && typeof record === 'object' ? record : {};
  if (!source.recordingId && !source.id) return null;
  const base = createJournal({
    recordingId: String(source.recordingId || source.id || ''),
    mime: source.mime,
    mode: source.mode,
    now: options.now,
    budget: source.budget,
  });
  const parts = Array.isArray(source.journal_parts) ? source.journal_parts : [];
  let journal = base;
  for (const part of parts) {
    const appended = appendEntry(journal, {
      sequence: part.seq,
      index: part.index,
      bytes: part.bytes,
      hash: part.hash,
      key: part.key,
      tMs: part.t,
      frames: part.frames,
    }, { now: options.now });
    journal = appended.journal;
  }
  if (source.journal_state === 'sealed') {
    journal = { ...journal, state: 'recovered', recoveredFrom: 'record' };
  } else if (source.journal_state) {
    journal = { ...journal, state: String(source.journal_state), recoveredFrom: 'record' };
  }
  return journal;
}

/** 协议 wire：日记摘要（条目只带前几片）。 */
export function summarizeJournal(journal, options = {}) {
  if (!journal || typeof journal !== 'object') return null;
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const maxListed = clampInt(options.maxListed, 0, 64, 6);
  const validation = validateJournal(journal, { requireEntries: false, requireSealed: false, allowGaps: true });
  return {
    version: intOr(journal.version, JOURNAL_VERSION),
    recordingId: String(journal.recordingId || ''),
    state: String(journal.state || 'open'),
    entries: entries.length,
    bytes: intOr(journal.totalBytes, 0),
    chain: String(journal.chain || ''),
    digest: journalDigestOf(String(journal.chain || '') + '|' + entries.length + '|' + intOr(journal.totalBytes, 0)),
    indexes: (Array.isArray(journal.indexes) ? journal.indexes : entries.map((entry) => intOr(entry.index, 0))).slice(-maxListed),
    gaps: validation.gaps.slice(0, maxListed),
    duplicates: validation.duplicates.slice(0, maxListed),
    valid: validation.ok,
    sealed: journal.state === 'sealed',
    sealedAt: journal.sealedAt || null,
    degradeLevel: String(journal.degradeLevel || 'none'),
    budget: journal.budget || null,
  };
}

/** 一行日志：'录制日记 open 12 片 / 24.5MB / chain=abc12345'。 */
export function describeJournal(journal) {
  const summary = summarizeJournal(journal);
  if (!summary) return '录制日记 无';
  const mb = (summary.bytes / (1024 * 1024)).toFixed(1);
  return '录制日记 ' + summary.state + ' ' + summary.entries + ' 片 / ' + mb + 'MB / chain=' + summary.chain.slice(0, 8) +
    (summary.sealed ? '（已密封）' : '') + (summary.valid ? '' : '（校验失败）');
}

/** 链摘要的快照（用于 record 持久化后二次校验）；与 appendEntry 的增量链同一算法。 */
export function journalChainDigest(journal) {
  const entries = journal && Array.isArray(journal.entries) ? journal.entries : [];
  let chain = '';
  for (const entry of entries) {
    chain = journalDigestOf(chain + journalEntryCanonical(normalizeJournalEntry(entry, 0)));
  }
  return chain;
}

/** 合并两次结果（启动时既有落盘日记又有内存日记）：以较新/较长者为准并保留差异证据。 */
export function mergeJournals(persisted, memory) {
  const left = persisted && typeof persisted === 'object' ? persisted : null;
  const right = memory && typeof memory === 'object' ? memory : null;
  if (!left) return { journal: right, source: 'memory', merged: false };
  if (!right) return { journal: left, source: 'persisted', merged: false };
  const leftEntries = Array.isArray(left.entries) ? left.entries : [];
  const rightEntries = Array.isArray(right.entries) ? right.entries : [];
  const merged = leftEntries.length >= rightEntries.length ? left : right;
  const dropped = (leftEntries.length >= rightEntries.length ? rightEntries : leftEntries)
    .filter((entry) => !merged.entries.some((item) => intOr(item.sequence, -1) === intOr(entry.sequence, -2)));
  return {
    journal: merged,
    source: leftEntries.length >= rightEntries.length ? 'persisted' : 'memory',
    merged: dropped.length > 0,
    dropped: dropped.map((entry) => intOr(entry.sequence, 0)),
  };
}

/** 分片键列表（清理/核对盘上分片用）。 */
export function journalPartKeys(journal) {
  const entries = journal && Array.isArray(journal.entries) ? journal.entries : [];
  return entries.map((entry) => String(entry.key || journalPartKey(intOr(entry.index, 0))));
}

export const JOURNAL_STATE_LIST = JOURNAL_STATES;
export const JOURNAL_ACTION_LIST = JOURNAL_ACTIONS;
