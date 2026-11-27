// src/lib/debug-export.js —— 调试证据导出（JSON envelope：schema 版本 + checksum）。
//
// 导出物是**可校验**的离线证据：任何拿到 JSON 的人都能重算 checksum，确认数据没被
// 截断/篡改。checksum 不追求密码学强度（哈希算法用同步的 FNV-1a 64，浏览器/Node
// 同一实现、不需要 await crypto.subtle），目标是 integrity 而非签名；签名仍走发布侧
// 的 release-sign。约定：
//
//   { schema: { name, version }, generatedAt, session, journal, requests, coverage,
//     correlation, gaps, counts, integrity: { algorithm, digest, bytes } }
//
// checksum 覆盖除 integrity 以外的全部字段，用 canonicalJson（键排序、无 undefined）
// 序列化，保证同一份数据在任何机器上得到同一个 digest。导出前统一过
// redactForPersistence（持久化前脱敏的单点），因此不会导出明文 secret。
import { redactForPersistence, scanForPlaintextSecrets } from './debug-redact.js';
import { summarizeCoverage } from './debug-coverage.js';
import { normalizeRequestRecord, summarizeCorrelation } from './debug-correlation.js';

export const DEBUG_EXPORT_SCHEMA = Object.freeze({
  name: 'bridgedeck.debug.journal',
  version: 1,
});

export const CHECKSUM_ALGORITHM = 'fnv1a64';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const TEXT_ENCODER = typeof globalThis.TextEncoder === 'function' ? new globalThis.TextEncoder() : null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function encodeUtf8(text) {
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(String(text));
  const bytes = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

/** UTF-8 字节数（导出 integrity.bytes 用）。 */
export function utf8Bytes(text) {
  return encodeUtf8(text).length;
}

/**
 * 确定性 JSON：对象键排序、跳过 undefined、数组里的 undefined 记 null、循环记
 * '[circular]'、BigInt 转字符串。用于 checksum 的规范形式。
 */
export function canonicalJson(value, options = {}) {
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 32;
  const seen = new WeakSet();
  const walk = (node, depth) => {
    if (depth > maxDepth) return '"[truncated-depth]"';
    if (node === undefined) return null;
    if (node === null) return 'null';
    const type = typeof node;
    if (type === 'boolean') return node ? 'true' : 'false';
    if (type === 'number') return Number.isFinite(node) ? JSON.stringify(node) : 'null';
    if (type === 'bigint') return JSON.stringify(node.toString());
    if (type === 'string') return JSON.stringify(node);
    if (type === 'function' || type === 'symbol') return 'null';
    if (node instanceof Date) return JSON.stringify(node.toISOString());
    if (seen.has(node)) return '"[circular]"';
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        const parts = node.map((item) => {
          const text = walk(item, depth + 1);
          return text == null ? 'null' : text;
        });
        return '[' + parts.join(',') + ']';
      }
      if (isPlainObject(node)) {
        const keys = Object.keys(node).sort();
        const parts = [];
        for (const key of keys) {
          const item = walk(node[key], depth + 1);
          if (item == null) continue;
          parts.push(JSON.stringify(key) + ':' + item);
        }
        return '{' + parts.join(',') + '}';
      }
      return JSON.stringify(String(node));
    } finally {
      seen.delete(node);
    }
  };
  const text = walk(value, 0);
  return text == null ? 'null' : text;
}

/** FNV-1a 64 位十六进制摘要（同步、跨平台一致）。 */
export function fnv1a64Hex(text) {
  const bytes = encodeUtf8(text);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 对任意值做 checksum：{ algorithm, digest, bytes }。 */
export function checksumOf(value) {
  const text = canonicalJson(value);
  return {
    algorithm: CHECKSUM_ALGORITHM,
    digest: fnv1a64Hex(text),
    bytes: utf8Bytes(text),
  };
}

function checksumPayload(envelope) {
  const payload = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === 'integrity') continue;
    payload[key] = value;
  }
  return payload;
}

function countByType(events) {
  const byType = {};
  for (const event of events) {
    const type = String((event && event.type) || 'event');
    byType[type] = (byType[type] || 0) + 1;
  }
  return byType;
}

function normalizeJournalInput(journal) {
  if (journal == null) return { events: [], byType: {}, evictions: null, seq: null, timeRange: null, bytes: null };
  if (Array.isArray(journal)) {
    return { events: journal, byType: countByType(journal), evictions: null, seq: null, timeRange: null, bytes: null };
  }
  const events = Array.isArray(journal.events) ? journal.events : [];
  return {
    events,
    byType: isPlainObject(journal.byType) ? { ...journal.byType } : countByType(events),
    evictions: isPlainObject(journal.evictions) ? journal.evictions : null,
    seq: Number.isFinite(Number(journal.seq)) ? Number(journal.seq) : null,
    timeRange: isPlainObject(journal.timeRange) ? { ...journal.timeRange } : null,
    bytes: Number.isFinite(Number(journal.bytes)) ? Number(journal.bytes) : null,
  };
}

/**
 * 构建可校验的 journal 导出 envelope。
 * @param {{
 *   session?: object,
 *   journal?: object|object[],
 *   requests?: object[],
 *   coverage?: object,
 *   correlation?: object,
 *   generatedAt?: number,
 *   now?: number,
 *   redact?: (value: unknown) => unknown,
 *   extra?: object,
 * }} [input]
 */
export function buildJournalExport(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const now = Number.isFinite(Number(source.generatedAt))
    ? Number(source.generatedAt)
    : (Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now());
  const journal = normalizeJournalInput(source.journal);
  const requests = (Array.isArray(source.requests) ? source.requests : [])
    .map((raw, index) => normalizeRequestRecord(raw, index))
    .filter(Boolean);
  const coverage = source.coverage && typeof source.coverage === 'object'
    ? {
      version: Number.isFinite(Number(source.coverage.version)) ? Number(source.coverage.version) : null,
      coverage: source.coverage.coverage || null,
      gaps: Array.isArray(source.coverage.gaps) ? source.coverage.gaps : [],
      complete: source.coverage.complete === true,
      summary: summarizeCoverage(source.coverage),
    }
    : null;
  const correlation = source.correlation && typeof source.correlation === 'object'
    ? summarizeCorrelation(source.correlation)
    : null;
  const session = isPlainObject(source.session)
    ? {
      id: source.session.id == null ? null : String(source.session.id),
      tabId: source.session.tabId == null ? null : Number(source.session.tabId),
      name: source.session.name == null ? '' : String(source.session.name),
      url: source.session.url == null ? '' : String(source.session.url),
      startedAt: Number.isFinite(Number(source.session.startedAt)) ? Number(source.session.startedAt) : null,
      endedAt: Number.isFinite(Number(source.session.endedAt)) ? Number(source.session.endedAt) : null,
      bodies: source.session.bodies === true,
    }
    : null;
  const gaps = coverage ? coverage.gaps : [];
  const payload = {
    schema: { ...DEBUG_EXPORT_SCHEMA },
    generatedAt: new Date(now).toISOString(),
    session,
    counts: {
      events: journal.events.length,
      byType: journal.byType,
      requests: requests.length,
      gaps: gaps.length,
      coverageComplete: coverage ? coverage.complete : null,
    },
    journal: {
      seq: journal.seq,
      bytes: journal.bytes,
      timeRange: journal.timeRange,
      events: journal.events,
      evictions: journal.evictions,
    },
    requests,
    coverage,
    correlation,
    gaps,
    ...(isPlainObject(source.extra) ? { extra: source.extra } : {}),
  };
  // 最后一道脱敏：即使兼容目标漏了 redact，导出物也不会带明文 secret。
  const redacted = (typeof source.redact === 'function' ? source.redact : redactForPersistence)(payload);
  const integrity = checksumOf(redacted);
  return { ...redacted, integrity };
}

/**
 * 校验导出物。接受对象或 JSON 文本：
 *   - schema 名称/版本不匹配 → unsupported-schema；
 *   - integrity 缺失 → missing-integrity；
 *   - digest 或 bytes 不符 → checksum-mismatch（expected/actual 都给）。
 */
export function verifyJournalExport(input) {
  let envelope = input;
  if (typeof input === 'string') {
    try {
      envelope = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }
  if (!isPlainObject(envelope)) return { ok: false, reason: 'invalid-envelope' };
  const schema = isPlainObject(envelope.schema) ? envelope.schema : null;
  if (!schema || schema.name !== DEBUG_EXPORT_SCHEMA.name) {
    return { ok: false, reason: 'unsupported-schema', schema };
  }
  if (Number(schema.version) !== DEBUG_EXPORT_SCHEMA.version) {
    return { ok: false, reason: 'unsupported-schema', schema, expectedVersion: DEBUG_EXPORT_SCHEMA.version };
  }
  const integrity = isPlainObject(envelope.integrity) ? envelope.integrity : null;
  if (!integrity) return { ok: false, reason: 'missing-integrity' };
  if (String(integrity.algorithm || '') !== CHECKSUM_ALGORITHM) {
    return { ok: false, reason: 'unsupported-checksum', algorithm: integrity.algorithm == null ? null : String(integrity.algorithm) };
  }
  const expected = checksumOf(checksumPayload(envelope));
  const actualDigest = String(integrity.digest || '');
  const actualBytes = Number(integrity.bytes);
  if (actualDigest !== expected.digest) {
    return { ok: false, reason: 'checksum-mismatch', expected: expected.digest, actual: actualDigest };
  }
  if (Number.isFinite(actualBytes) && actualBytes !== expected.bytes) {
    return { ok: false, reason: 'bytes-mismatch', expected: expected.bytes, actual: actualBytes };
  }
  return {
    ok: true,
    reason: 'verified',
    schema: { ...schema },
    digest: expected.digest,
    bytes: expected.bytes,
    events: Number((envelope.counts && envelope.counts.events) || 0),
    requests: Number((envelope.counts && envelope.counts.requests) || 0),
    generatedAt: envelope.generatedAt || null,
  };
}

/** 序列化导出物：pretty=false 时是紧凑单行 JSON。 */
export function serializeJournalExport(envelope, { pretty = false } = {}) {
  const value = isPlainObject(envelope) ? envelope : {};
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** 解析导出 JSON 文本，返回 { ok, envelope } / { ok:false, reason }。 */
export function parseJournalExport(text) {
  try {
    const parsed = JSON.parse(String(text == null ? '' : text));
    if (!isPlainObject(parsed)) return { ok: false, reason: 'not-an-object' };
    return { ok: true, envelope: parsed };
  } catch (error) {
    return { ok: false, reason: 'invalid-json', error: String((error && error.message) || error) };
  }
}

/** 导出摘要：日志/索引里只放这个，不重复存事件正文。 */
export function summarizeJournalExport(envelope) {
  const source = isPlainObject(envelope) ? envelope : {};
  const integrity = isPlainObject(source.integrity) ? source.integrity : {};
  const counts = isPlainObject(source.counts) ? source.counts : {};
  const verify = verifyJournalExport(source);
  return {
    schema: isPlainObject(source.schema) ? { ...source.schema } : null,
    generatedAt: source.generatedAt || null,
    session: source.session ? { id: source.session.id || null, url: source.session.url || '' } : null,
    events: Number(counts.events || 0),
    requests: Number(counts.requests || 0),
    gaps: Number(counts.gaps || 0),
    digest: integrity.digest == null ? null : String(integrity.digest),
    bytes: Number.isFinite(Number(integrity.bytes)) ? Number(integrity.bytes) : null,
    verified: verify.ok === true,
    verifyReason: verify.ok === true ? 'verified' : String(verify.reason || 'unknown'),
  };
}

/**
 * 自检：确认导出文本里没有明文 secret（debug.stop / 导出命令可调用）。
 * @param {string} text
 * @param {string[]} secrets 期望不出现的明文值
 */
export function assertExportRedacted(text, secrets = []) {
  const scan = scanForPlaintextSecrets(text, secrets);
  return {
    clean: scan.clean,
    leakedCount: scan.leaked.length,
    leaked: scan.leaked.slice(0, 8),
  };
}
