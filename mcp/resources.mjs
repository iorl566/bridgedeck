// mcp/resources.mjs —— MCP resources（只读、按需读取、可分页）与 resources/templates。
//
// 目标（W5-A 第 1 项）：把「页面观察快照 / 调试证据 / 调试 journal / 技能文档 / 本地状态」
// 暴露成 MCP resources，让客户端按需拉取大块文本，而不是塞进 tools/call 的返回里；
// 同时给大文本一个可续读的分页协议（?limit=&cursor=），避免一次打满 MCP 通道。
//
// 设计约束：
//   1. 全部只读：不提供 resources/write，不修改页面/文件状态；但支持订阅变更通知
//      （capabilities.subscribe=true）：快照更新后由订阅集合发 notifications/resources/updated，
//      详见 mcp/subscriptions.mjs；
//   2. 按需读取：技能文档只在 resources/read 时从磁盘读（不做启动期全量加载）；
//   3. 路径安全：技能文档只允许 skill/SKILL.md 与 skill/references/*.md，参考名必须在
//      磁盘上真实存在，禁止 ../ 穿越；
//   4. 大小上限：单段文本上限 256 KiB（UTF-8），超出截断并保留可读标记；
//   5. 分页：`?limit=`（1..65536 字符）与 `?cursor=`/`?offset=`（非负字符偏移）在
//      resources/read 前完成校验；结果 _meta 带 totalChars/nextCursor/nextUri，
//      客户端不需要猜“还有没有下一页”；
//   6. 快照有界：观察/证据/journal 快照按 session 做 LRU（默认 32/16/16 条）；
//   7. 无 daemon 依赖：resources/read 不启动会话、不访问网络，可离线使用。
//
// 调用点：mcp/server.mjs 的 resources/list、resources/templates/list、resources/read、
// capabilities 声明，以及 tools/call 成功后的 recordToolResult（工具结果 → 最新快照）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpdateState } from '../lib/update-state.mjs';
import { METHOD_CATALOG, FEATURE_FLOORS, METHOD_PARTIAL, METHOD_UNKNOWN, PROTOCOL_CURRENT, PROTOCOL_BASELINE } from '../lib/method-catalog.mjs';
import {
  SnapshotPersistence,
  resolveSnapshotDir,
  resolveSnapshotLimits,
} from './snapshots.mjs';
import { RESOURCE_UPDATED_NOTIFICATION, SUBSCRIPTION_LIMITS } from './subscriptions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 资源文本上限（字节，按 UTF-8 计）。 */
export const MAX_RESOURCE_BYTES = 256 * 1024;

/** 分页默认单段字符数（32 KiB 字符；UTF-8 最坏 4 字节/字符仍小于 256 KiB 字节上限）。 */
export const DEFAULT_PAGE_CHARS = 32 * 1024;

/** 分页单段字符数上限。 */
export const MAX_PAGE_CHARS = 64 * 1024;

/** journal 快照最多保留的事件条数（其余只保留计数与序号范围）。 */
export const JOURNAL_MAX_EVENTS = 500;

/**
 * 快照“新鲜度”窗口：超过该时长未更新的观察/证据在 _meta 标记 stale，客户端可据此决定
 * 是否重新采集。与磁盘 TTL 不同——TTL 决定是否恢复，新鲜度只影响提示。
 */
export const SNAPSHOT_FRESH_MS = 5 * 60 * 1000;

export const RESOURCE_ERRORS = Object.freeze({
  NOT_FOUND: 'E_NOT_FOUND',
  BAD_URI: 'E_BAD_ARG',
  TOO_LARGE: 'E_TOO_LARGE',
});

/**
 * resources 能力声明（server 的 initialize 与 resources/list 共用，单一来源）。
 * subscribe=true：客户端可订阅动态快照 URI；快照更新时服务端推送
 * `notifications/resources/updated`（订阅集合见 mcp/subscriptions.mjs）。
 * listChanged 仍为 false：resources/list 的行集合由快照 LRU 决定，客户端按 updated 通知重读即可。
 */
export const RESOURCE_CAPABILITIES = Object.freeze({
  subscribe: true,
  listChanged: false,
  subscription: Object.freeze({
    notification: RESOURCE_UPDATED_NOTIFICATION,
    uriScoped: true,
    maxSubscriptions: SUBSCRIPTION_LIMITS.maxSubscriptions,
    cleanupOnDisconnect: true,
  }),
  pagination: Object.freeze({
    cursorParam: 'cursor',
    limitParam: 'limit',
    offsetParam: 'offset',
    defaultLimit: DEFAULT_PAGE_CHARS,
    maxLimit: MAX_PAGE_CHARS,
    unit: 'char',
  }),
});

/** 资源种类（解析结果的 kind）。 */
export const RESOURCE_KINDS = Object.freeze({
  SKILL_MAIN: 'skill-main',
  SKILL_REFERENCE: 'skill-reference',
  UPDATE_STATE: 'update-state',
  PROTOCOL_SUMMARY: 'protocol-summary',
  OBSERVATION: 'observation',
  EVIDENCE: 'evidence',
  JOURNAL: 'journal',
});

const PAGING_PARAMS = new Set(['limit', 'offset', 'cursor']);

/** 带 code 的 resource 错误（server 转成 MCP 错误码）。 */
export class ResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
  }
}

/**
 * 有界快照存储：按 key LRU，value 保留原始对象。
 * 读取不修改内容，写入才更新顺序；超过 limit 淘汰最久未写的一条。
 * 传入 persistence 时每次写入都会原子落盘（失败降级为仅内存），进程重启后可 hydrate 恢复。
 */
export class SnapshotStore {
  constructor({ limit = 32, label = 'snapshot', persistence = null, now = () => Date.now(), ttlMs = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('SnapshotStore limit 必须是正整数');
    this.limit = limit;
    this.label = label;
    this.persistence = persistence || null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.ttlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : null;
    this.entries = new Map();
    this.lastPersist = null;
    this.lastPersistError = null;
    this.restored = 0;
  }

  /**
   * 写入一条快照（同 key 覆盖并刷新 LRU 顺序）。
   * 返回描述里额外带 evicted：本次因超过 limit 被淘汰的 key 列表，供上层发资源删除式更新通知
   * （被淘汰的 URI 再 read 会得到 E_NOT_FOUND，如实让客户端知道“它没了”）。
   */
  record(key, payload, meta = {}) {
    const name = String(key || 'latest');
    if (this.entries.has(name)) this.entries.delete(name);
    const at = new Date(this.now()).toISOString();
    this.entries.set(name, Object.freeze({
      key: name,
      at,
      label: this.label,
      meta: Object.freeze({ ...(meta && typeof meta === 'object' ? meta : {}) }),
      payload,
    }));
    const evicted = [];
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
      evicted.push(oldest);
    }
    this.persistNow();
    return Object.freeze({ ...this.describe(name), evicted: Object.freeze(evicted) });
  }

  /** 落盘当前全部条目；任何磁盘错误只记录，不影响内存快照。 */
  persistNow() {
    if (!this.persistence) return null;
    try {
      this.lastPersist = this.persistence.save(this.label, [...this.entries.values()]);
      return this.lastPersist;
    } catch (error) {
      this.lastPersistError = error;
      return null;
    }
  }

  /**
   * 从磁盘条目恢复（保持文件中的 LRU 顺序；同 key 以磁盘为准）。
   * @returns {{ restored:number, skipped:number }}
   */
  hydrate(loadedEntries) {
    let restored = 0;
    let skipped = 0;
    for (const entry of Array.isArray(loadedEntries) ? loadedEntries : []) {
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key) {
        skipped += 1;
        continue;
      }
      const at = Date.parse(String(entry.at || ''));
      if (!Number.isFinite(at)) {
        skipped += 1;
        continue;
      }
      this.entries.delete(entry.key);
      this.entries.set(entry.key, Object.freeze({
        key: entry.key,
        at: new Date(at).toISOString(),
        label: String(entry.label || this.label),
        meta: Object.freeze({
          ...(entry.meta && typeof entry.meta === 'object' ? entry.meta : {}),
          persisted: true,
          persistedTruncated: entry.truncated === true,
        }),
        payload: entry.payload,
      }));
      restored += 1;
    }
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.restored += restored;
    return { restored, skipped };
  }

  /** 丢弃超过 TTL 的条目并落盘；返回被丢弃的 key 列表。 */
  pruneExpired() {
    if (!this.ttlMs) return [];
    const cutoff = this.now() - this.ttlMs;
    const removed = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at) || at < cutoff) {
        this.entries.delete(key);
        removed.push(key);
      }
    }
    if (removed.length) this.persistNow();
    return removed;
  }

  get(key) {
    const name = String(key || 'latest');
    if (name === 'latest') {
      const last = [...this.entries.values()].at(-1);
      return last || null;
    }
    return this.entries.get(name) || null;
  }

  has(key) {
    return Boolean(this.get(key));
  }

  keys() {
    return [...this.entries.keys()];
  }

  size() {
    return this.entries.size;
  }

  describe(key) {
    const entry = this.get(key);
    if (!entry) return null;
    return Object.freeze({
      key: entry.key,
      at: entry.at,
      label: this.label,
      meta: entry.meta,
      ageMs: snapshotAgeMs(entry, this.now()),
      persisted: entry.meta && entry.meta.persisted === true,
    });
  }

  describeAll() {
    return this.keys().map((key) => this.describe(key)).filter(Boolean);
  }

  stats() {
    return Object.freeze({ label: this.label, size: this.entries.size, limit: this.limit });
  }
}

/** 条目年龄（毫秒，非法时间返回 null）。 */
function snapshotAgeMs(entry, now = Date.now()) {
  const at = Date.parse(String(entry && entry.at || ''));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/**
 * 稳定内容标识（FNV-1a 32 位，十六进制）：客户端轮询时用它判断快照是否变化，
 * 不必比较整段文本。内容相同 → 标识相同（at 相同也保持一致）。
 */
export function snapshotEtag(entry) {
  if (!entry) return null;
  const seed = String(entry.key || '') + '|' + String(entry.at || '') + '|';
  let text;
  try {
    text = seed + jsonText(entry.payload);
  } catch {
    return null;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'W/"' + hash.toString(16).padStart(8, '0') + '"';
}

/** 快照新鲜度描述（用于 resources/read _meta；不改变快照内容）。 */
export function snapshotFreshness(entry, { now = Date.now(), freshMs = SNAPSHOT_FRESH_MS } = {}) {
  const ageMs = snapshotAgeMs(entry, now);
  return Object.freeze({
    capturedAt: entry ? String(entry.at || '') : null,
    ageMs,
    stale: ageMs == null ? true : ageMs > freshMs,
    freshMs,
    etag: snapshotEtag(entry),
    persisted: Boolean(entry && entry.meta && entry.meta.persisted),
    persistedTruncated: Boolean(entry && entry.meta && entry.meta.persistedTruncated),
  });
}

function truncateText(text, uri) {
  const value = String(text);
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= MAX_RESOURCE_BYTES) return value;
  const clipped = buffer.subarray(0, MAX_RESOURCE_BYTES).toString('utf8');
  return clipped + '\n\n…[truncated] resource ' + uri + ' 超过 ' + MAX_RESOURCE_BYTES + ' 字节，已截断；请用 CLI 读取完整内容。';
}

function jsonText(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '资源内容无法序列化为 JSON：' + String((error && error.message) || error));
  }
}

function skillRoot() {
  return path.join(ROOT, 'skill');
}

/** 已安装的技能参考文档名（只列 .md，按名字排序）。 */
export function listSkillReferences(root = skillRoot()) {
  try {
    return fs.readdirSync(path.join(root, 'references'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把资源 URI 拆成「去查询串的 baseUri + 原始查询串」。
 * 只接受 bridge://，空 base 视为未知资源。
 */
export function splitResourceUri(uri) {
  const raw = String(uri == null ? '' : uri).trim();
  if (!raw.startsWith('bridge://')) throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '只支持 bridge:// 资源：' + raw);
  const rest = raw.slice('bridge://'.length);
  const mark = rest.indexOf('?');
  const base = mark >= 0 ? rest.slice(0, mark) : rest;
  const queryText = mark >= 0 ? rest.slice(mark + 1) : '';
  if (!base) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '资源 URI 缺少路径：' + raw);
  return { raw, base, baseUri: 'bridge://' + base, queryText };
}

function decodeComponent(value, uri) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '资源 URI 含非法百分号编码：' + uri);
  }
}

function parseOffsetName(name, value, uri) {
  if (!/^\d+$/.test(value)) {
    throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '资源分页参数 ' + name + ' 必须是非负整数：' + JSON.stringify(value) + '（' + uri + '）');
  }
  return Number(value);
}

/**
 * 校验并归一化分页查询串：只允许 limit/offset/cursor，且 offset 与 cursor 互斥。
 * @returns {{ paged:boolean, offset:number, limit:number, limitSpecified:boolean }}
 */
export function parsePagingQuery(queryText, uri = '') {
  const values = new Map();
  const text = String(queryText || '');
  if (text) {
    for (const piece of text.split('&')) {
      if (!piece) continue;
      const eq = piece.indexOf('=');
      const rawName = eq < 0 ? piece : piece.slice(0, eq);
      const rawValue = eq < 0 ? '' : piece.slice(eq + 1);
      const name = decodeComponent(rawName, uri);
      if (!PAGING_PARAMS.has(name)) {
        throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '未知资源查询参数 ' + name + '（只支持 limit/offset/cursor）：' + uri);
      }
      if (values.has(name)) throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '资源查询参数重复：' + name + '（' + uri + '）');
      values.set(name, decodeComponent(rawValue, uri));
    }
  }
  if (values.has('offset') && values.has('cursor')) {
    throw new ResourceError(RESOURCE_ERRORS.BAD_URI, 'offset 与 cursor 不能同时出现（cursor 是 offset 的别名）：' + uri);
  }
  let limit = DEFAULT_PAGE_CHARS;
  const limitSpecified = values.has('limit');
  if (limitSpecified) {
    limit = parseOffsetName('limit', values.get('limit'), uri);
    if (limit < 1 || limit > MAX_PAGE_CHARS) {
      throw new ResourceError(RESOURCE_ERRORS.BAD_URI, 'limit 必须在 1..' + MAX_PAGE_CHARS + ' 之间，实际 ' + limit + '（' + uri + '）');
    }
  }
  let offset = 0;
  if (values.has('cursor')) offset = parseOffsetName('cursor', values.get('cursor'), uri);
  if (values.has('offset')) offset = parseOffsetName('offset', values.get('offset'), uri);
  return { paged: values.size > 0, offset, limit, limitSpecified };
}

/**
 * 解析资源 URI：返回 kind/key/分页信息，非法 URI 抛 ResourceError。
 * @returns {{ raw:string, baseUri:string, kind:string, key:string|null, paging:object }}
 */
export function parseResourceUri(uri) {
  const { raw, base, baseUri, queryText } = splitResourceUri(uri);
  const paging = parsePagingQuery(queryText, raw);
  const segments = base.split('/');
  const head = segments[0];
  const requireExact = (expected) => {
    if (base !== expected) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '未知资源：' + raw + '（期望 ' + expected + '）');
    return { raw, baseUri, kind: null, key: null, paging };
  };
  if (head === 'skill') {
    if (base === 'skill/SKILL.md') return { raw, baseUri, kind: RESOURCE_KINDS.SKILL_MAIN, key: 'SKILL.md', paging };
    if (base.startsWith('skill/references/')) {
      const rest = base.slice('skill/references/'.length);
      if (!rest || rest.includes('/')) throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '技能参考名非法：' + raw);
      const name = decodeComponent(rest, raw);
      // 与 readSkillReference 同一规则：非法名字在解析阶段就拒绝（含 ../ 穿越）。
      if (!/^[a-z0-9._-]+\.md$/i.test(name)) throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '技能参考名非法：' + raw);
      return { raw, baseUri, kind: RESOURCE_KINDS.SKILL_REFERENCE, key: name, paging };
    }
    throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '未知技能资源：' + raw);
  }
  if (head === 'update') return { ...requireExact('update/state'), kind: RESOURCE_KINDS.UPDATE_STATE };
  if (head === 'protocol') return { ...requireExact('protocol/summary'), kind: RESOURCE_KINDS.PROTOCOL_SUMMARY };
  if (head === 'observation') {
    if (segments.length !== 2 || !segments[1]) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '观察资源需要 /bridge://observation/{session}：' + raw);
    return { raw, baseUri, kind: RESOURCE_KINDS.OBSERVATION, key: decodeComponent(segments[1], raw), paging };
  }
  if (head === 'debug') {
    const section = segments[1];
    if (section !== 'evidence' && section !== 'journal') {
      throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '未知调试资源：' + raw + '（支持 debug/evidence/{session} 与 debug/journal/{session}）');
    }
    if (segments.length !== 3 || !segments[2]) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '调试资源需要 /bridge://debug/' + section + '/{session}：' + raw);
    return {
      raw,
      baseUri,
      kind: section === 'evidence' ? RESOURCE_KINDS.EVIDENCE : RESOURCE_KINDS.JOURNAL,
      key: decodeComponent(segments[2], raw),
      paging,
    };
  }
  throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '未知资源：' + raw);
}

function buildNextUri(baseUri, { limit, nextOffset }) {
  return baseUri + '?limit=' + limit + '&cursor=' + nextOffset;
}

/**
 * 按分页参数切段；未带分页参数时退化为「整段 + 字节截断」，与旧行为一致。
 * @returns {{ text:string, meta:object }}
 */
export function pageResourceText(text, paging, uri) {
  const value = String(text == null ? '' : text);
  const totalChars = value.length;
  if (!paging || !paging.paged) {
    const clipped = truncateText(value, uri);
    return {
      text: clipped,
      meta: {
        paged: false,
        totalChars,
        returnedChars: totalChars,
        truncatedBytes: clipped !== value,
        nextCursor: null,
        nextUri: null,
      },
    };
  }
  if (paging.offset > totalChars) {
    throw new ResourceError(
      RESOURCE_ERRORS.BAD_URI,
      '分页 offset ' + paging.offset + ' 超过内容长度 ' + totalChars + '（' + uri + '）',
    );
  }
  const end = Math.min(totalChars, paging.offset + paging.limit);
  const chunk = value.slice(paging.offset, end);
  const hasMore = end < totalChars;
  const nextUri = hasMore ? buildNextUri(splitResourceUri(uri).baseUri, { limit: paging.limit, nextOffset: end }) : null;
  const clipped = truncateText(chunk, uri);
  const marker = hasMore
    ? '\n\n…[paged] 本段字符 ' + paging.offset + '–' + end + ' / ' + totalChars + '；续读 ' + nextUri
    : '';
  return {
    text: clipped + marker,
    meta: {
      paged: true,
      offset: paging.offset,
      limit: paging.limit,
      totalChars,
      returnedChars: end - paging.offset,
      truncatedBytes: clipped !== chunk,
      hasMore,
      nextCursor: hasMore ? String(end) : null,
      nextUri,
    },
  };
}

function resourceUriFor(kind, key) {
  const encoded = encodeURIComponent(String(key));
  if (kind === RESOURCE_KINDS.OBSERVATION) return 'bridge://observation/' + encoded;
  if (kind === RESOURCE_KINDS.EVIDENCE) return 'bridge://debug/evidence/' + encoded;
  if (kind === RESOURCE_KINDS.JOURNAL) return 'bridge://debug/journal/' + encoded;
  return null;
}

function eventArrayOf(raw) {
  for (const name of ['events', 'journal', 'entries', 'timeline']) {
    if (Array.isArray(raw[name])) return raw[name];
  }
  return null;
}

function journalPayload(tool, raw, events) {
  const list = events || [];
  const kept = list.slice(-JOURNAL_MAX_EVENTS);
  const sequences = kept
    .map((event) => Number(event && (event.seq !== undefined ? event.seq : event.sequence)))
    .filter((value) => Number.isFinite(value));
  const stages = [...new Set(kept
    .map((event) => (event && (event.stage || event.phase)) || null)
    .filter((value) => typeof value === 'string' && value.length > 0))].sort();
  const payload = {
    tool: tool || null,
    count: list.length || Number(raw.count) || 0,
    kept: kept.length,
    dropped: Math.max(0, (list.length || Number(raw.count) || 0) - kept.length),
    firstSeq: sequences.length ? Math.min(...sequences) : null,
    lastSeq: sequences.length ? Math.max(...sequences) : null,
    stages,
    gaps: Array.isArray(raw.gaps) ? raw.gaps : [],
    truncated: Boolean(raw.truncated || list.length > JOURNAL_MAX_EVENTS),
    events: kept,
  };
  if (!events) payload.raw = raw;
  return payload;
}

/**
 * 创建资源注册表。
 *
 * 传入 home 时默认开启磁盘持久化（`home/mcp-snapshots`）：
 *   - 启动时 maybeSweep() 清理过期/损坏/临时文件；
 *   - 每个 store 读回自己的快照文件并 hydrate，进程重启后 latest 仍可读；
 *   - 之后每次 record 原子落盘（见 mcp/snapshots.mjs）。
 * 单测/离线场景可用 persist:false 或 persistence:null 关闭；自定义 store 的持久化由调用方负责。
 *
 * @param {{
 *   home: string,
 *   observations?: SnapshotStore,
 *   evidence?: SnapshotStore,
 *   journals?: SnapshotStore,
 *   persistence?: SnapshotPersistence|null,
 *   persist?: boolean,
 *   limits?: object,
 *   now?: () => number,
 *   onUpdate?: (event:object)=>void,
 * }} options
 */
export function createResourceRegistry({
  home,
  observations,
  evidence,
  journals,
  persistence,
  persist = true,
  limits,
  now = () => Date.now(),
  onUpdate = null,
} = {}) {
  if (!home) throw new Error('createResourceRegistry 需要 home 目录');
  const clock = typeof now === 'function' ? now : () => Date.now();
  const resolvedLimits = limits && typeof limits === 'object' ? limits : resolveSnapshotLimits();
  const snapshotPersistence = persistence === undefined
    ? (persist ? new SnapshotPersistence({ dir: resolveSnapshotDir(home), limits: resolvedLimits, now: clock }) : null)
    : persistence;
  const makeStore = (store, limit, label) => store || new SnapshotStore({
    limit,
    label,
    persistence: snapshotPersistence,
    now: clock,
    ttlMs: resolvedLimits.ttlMs,
  });
  const observationStore = makeStore(observations, 32, 'observation');
  const evidenceStore = makeStore(evidence, 16, 'debug-evidence');
  const journalStore = makeStore(journals, 16, 'debug-journal');

  const loadReports = { observation: null, evidence: null, journal: null };
  const restored = { observation: 0, evidence: 0, journal: 0, skipped: 0, corrupt: 0 };
  const persistenceActive = Boolean(snapshotPersistence && snapshotPersistence.enabled);
  const sweepReport = persistenceActive ? snapshotPersistence.maybeSweep() : null;
  if (persistenceActive) {
    for (const [kind, store] of [
      ['observation', observationStore],
      ['evidence', evidenceStore],
      ['journal', journalStore],
    ]) {
      if (typeof store.hydrate !== 'function') continue;
      let report;
      try {
        report = snapshotPersistence.load(store.label);
      } catch (error) {
        report = { ok: false, error: String((error && error.message) || error), entries: [] };
      }
      loadReports[kind] = report;
      if (report && report.ok && Array.isArray(report.entries) && report.entries.length) {
        const hydrated = store.hydrate(report.entries);
        restored[kind] = hydrated.restored;
        restored.skipped += hydrated.skipped;
      } else if (report && report.ok === false) {
        restored.corrupt += 1;
      }
    }
    // 恢复后按 TTL 再剪一次（文件可能来自更早的进程）。
    for (const store of [observationStore, evidenceStore, journalStore]) {
      if (typeof store.pruneExpired === 'function') store.pruneExpired();
    }
  }
  const persistenceDir = snapshotPersistence ? snapshotPersistence.dir : null;

  // -------------------------------------------------------------------------
  // 快照更新事件（W7-C）：每次记录/淘汰/过期剪枝都产生一个 update 事件，事件里给出
  // 语义上“内容已变化”的 baseUri 列表；server 把它转成 resources/updated 通知。
  // 事件只描述事实（哪些 URI 变了、因为什么动作），不关心客户端是否订阅。
  // -------------------------------------------------------------------------
  const updateSinks = [];
  const updateState = { emitted: 0, sinkErrors: 0, lastUpdate: null };
  if (typeof onUpdate === 'function') updateSinks.push(onUpdate);

  /** 注册一个更新事件接收器；返回取消函数（server 用来只为一轮工具调用收集事件）。 */
  function addUpdateSink(sink) {
    if (typeof sink !== 'function') throw new Error('addUpdateSink 需要函数');
    updateSinks.push(sink);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const index = updateSinks.indexOf(sink);
      if (index >= 0) updateSinks.splice(index, 1);
      return true;
    };
  }

  /** 发一个快照更新事件；接收器异常只计数，不影响写入结果。 */
  function emitSnapshotUpdate(event) {
    const frozen = Object.freeze({
      ...event,
      uris: Object.freeze([...new Set((Array.isArray(event && event.uris) ? event.uris : []).filter((uri) => typeof uri === 'string' && uri))]),
      at: (event && event.at) || new Date(clock()).toISOString(),
    });
    updateState.emitted += 1;
    updateState.lastUpdate = frozen;
    for (const sink of [...updateSinks]) {
      try {
        sink(frozen);
      } catch {
        updateState.sinkErrors += 1;
      }
    }
    return frozen;
  }

  /** kind/key → 订阅 URI；未知 kind 返回 null（不伪造 URI）。 */
  function uriFor(kind, key) {
    return resourceUriFor(kind, key);
  }

  /**
   * 写入 store 并发出更新事件。
   * uris 同时包含“具体会话 URI”和“latest 别名”：订阅任一者都应收到通知，
   * 因为 latest 永远指向刚写入的那条。被 LRU 淘汰的 key 也一并通知（再读会 E_NOT_FOUND）。
   */
  function recordWithUpdate(store, kind, key, payload, meta = {}) {
    const entry = store.record(key, payload, meta);
    const uris = [];
    const sessionUri = uriFor(kind, entry.key);
    if (sessionUri) uris.push(sessionUri);
    const latestUri = uriFor(kind, 'latest');
    if (latestUri) uris.push(latestUri);
    const evicted = Array.isArray(entry.evicted) ? entry.evicted : [];
    for (const evictedKey of evicted) {
      const evictedUri = uriFor(kind, evictedKey);
      if (evictedUri) uris.push(evictedUri);
    }
    emitSnapshotUpdate({
      action: 'record',
      kind,
      key: entry.key,
      uris,
      evicted: Object.freeze([...evicted]),
      tool: meta.tool || null,
    });
    return entry;
  }

  function skillReferences() {
    return listSkillReferences();
  }

  function skillResource(uri, relative, title) {
    return Object.freeze({
      uri,
      name: title,
      title,
      description: 'BridgeDeck 技能文档（只读，按需读取；工具用法/恢复策略/证据约定；支持 ?limit=&cursor= 分页）',
      mimeType: 'text/markdown',
      annotations: Object.freeze({ audience: Object.freeze(['assistant', 'user']), priority: 0.8 }),
      dynamic: false,
      relative,
    });
  }

  function staticResources() {
    return [
      skillResource('bridge://skill/SKILL.md', 'SKILL.md', '技能主文档'),
      Object.freeze({
        uri: 'bridge://update/state',
        name: 'update-state',
        title: '更新状态',
        description: '本地 update check/fetch/stage/apply/rollback 状态（只读 JSON）',
        mimeType: 'application/json',
        annotations: Object.freeze({ audience: Object.freeze(['assistant', 'user']), priority: 0.4 }),
        dynamic: false,
      }),
      Object.freeze({
        uri: 'bridge://protocol/summary',
        name: 'protocol-summary',
        title: '协议摘要',
        description: '协议版本、方法数、feature floor、分页/未知态方法清单（只读 JSON；支持 ?limit=&cursor= 分页）',
        mimeType: 'application/json',
        annotations: Object.freeze({ audience: Object.freeze(['assistant']), priority: 0.6 }),
        dynamic: false,
      }),
      Object.freeze({
        uri: 'bridge://observation/latest',
        name: 'latest-observation',
        title: '最近一次页面观察',
        description: '最近一次 browser_observe / browser_brief 的页面快照（只读；会话结束后仍保留到淘汰；支持分页）',
        mimeType: 'application/json',
        annotations: Object.freeze({ audience: Object.freeze(['assistant']), priority: 0.9 }),
        dynamic: true,
      }),
      Object.freeze({
        uri: 'bridge://debug/evidence/latest',
        name: 'latest-debug-evidence',
        title: '最近一次调试证据包',
        description: '最近一次 browser_debug_evidence 的结果摘要（只读；支持分页）',
        mimeType: 'application/json',
        annotations: Object.freeze({ audience: Object.freeze(['assistant']), priority: 0.7 }),
        dynamic: true,
      }),
      Object.freeze({
        uri: 'bridge://debug/journal/latest',
        name: 'latest-debug-journal',
        title: '最近一次调试时间线',
        description: '最近一次 browser_debug_journal / browser_debug_query 的合并时间线（只读；事件数有界，支持分页）',
        mimeType: 'application/json',
        annotations: Object.freeze({ audience: Object.freeze(['assistant']), priority: 0.7 }),
        dynamic: true,
      }),
    ];
  }

  const PAGING_HINT = '；大文本可用 ?limit=<1..65536>&cursor=<offset> 分段读取（cursor 是字符偏移，nextCursor 来自上次结果）';

  function templates() {
    return [
      Object.freeze({
        uriTemplate: 'bridge://skill/references/{name}',
        name: 'skill-reference',
        title: '技能参考文档',
        description: '按名字读取技能参考文档；name 必须是 skill/references 下真实存在的 .md 文件' + PAGING_HINT,
        mimeType: 'text/markdown',
        annotations: Object.freeze({ audience: Object.freeze(['assistant', 'user']), priority: 0.7 }),
      }),
      Object.freeze({
        uriTemplate: 'bridge://observation/{session}',
        name: 'session-observation',
        title: '指定会话的页面观察',
        description: '读取指定会话缓存的最近一次观察快照（session 为 sessionId）' + PAGING_HINT,
        mimeType: 'application/json',
      }),
      Object.freeze({
        uriTemplate: 'bridge://debug/evidence/{session}',
        name: 'session-debug-evidence',
        title: '指定会话的调试证据',
        description: '读取指定会话缓存的最近一次调试证据结果' + PAGING_HINT,
        mimeType: 'application/json',
      }),
      Object.freeze({
        uriTemplate: 'bridge://debug/journal/{session}',
        name: 'session-debug-journal',
        title: '指定会话的调试时间线',
        description: '读取指定会话缓存的最近一次调试时间线（请求/控制台/操作合并；事件数有界）' + PAGING_HINT,
        mimeType: 'application/json',
      }),
    ];
  }

  function liveRow(kind, key, label) {
    const descriptions = {
      observation: '页面观察快照（只读）',
      evidence: '调试证据结果（只读）',
      journal: '调试时间线（只读；事件数有界）',
    };
    const priorities = { observation: 0.9, evidence: 0.7, journal: 0.7 };
    return Object.freeze({
      uri: resourceUriFor(kind, key),
      name: kind + '-' + key,
      title: label + ' ' + key,
      description: '会话 ' + key + ' 的最近一次' + descriptions[kind],
      mimeType: 'application/json',
      annotations: Object.freeze({ audience: Object.freeze(['assistant']), priority: priorities[kind] }),
    });
  }

  function list() {
    const staticRows = staticResources();
    const observationRows = observationStore.keys().map((key) => liveRow(RESOURCE_KINDS.OBSERVATION, key, '观察快照'));
    const evidenceRows = evidenceStore.keys().map((key) => liveRow(RESOURCE_KINDS.EVIDENCE, key, '调试证据'));
    const journalRows = journalStore.keys().map((key) => liveRow(RESOURCE_KINDS.JOURNAL, key, '调试时间线'));
    return [...staticRows, ...observationRows, ...evidenceRows, ...journalRows];
  }

  function readSkill(relative) {
    const root = skillRoot();
    const target = path.resolve(root, relative);
    const relativeTarget = path.relative(root, target);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '技能资源路径越界：' + relative);
    }
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '技能文档不存在：' + relative);
    }
    return text;
  }

  function readSkillReference(name) {
    const base = String(name || '');
    if (!/^[a-z0-9._-]+\.md$/i.test(base)) {
      throw new ResourceError(RESOURCE_ERRORS.BAD_URI, '技能参考名非法：' + name);
    }
    if (!skillReferences().includes(base)) {
      throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '技能参考不存在：' + base + '（可用：' + skillReferences().join(', ') + '）');
    }
    return readSkill(path.join('references', base));
  }

  function readUpdateStateResource() {
    const file = path.join(home, 'update-state.json');
    const state = readUpdateState(file);
    return jsonText({ file, present: fs.existsSync(file), state });
  }

  function readProtocolSummary() {
    const byEffect = {};
    const byOwner = {};
    for (const row of METHOD_CATALOG) {
      byEffect[row.effect] = (byEffect[row.effect] || 0) + 1;
      byOwner[row.owner] = (byOwner[row.owner] || 0) + 1;
    }
    return jsonText({
      protocol: { current: PROTOCOL_CURRENT, baseline: PROTOCOL_BASELINE },
      methods: { total: METHOD_CATALOG.length, byEffect, byOwner },
      features: FEATURE_FLOORS,
      partialMethods: METHOD_PARTIAL,
      unknownMethods: METHOD_UNKNOWN,
    });
  }

  function readSnapshot(store, key, uri) {
    const entry = store.get(key);
    if (!entry) {
      throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '没有缓存的 ' + store.label + '：' + key + '（先调用对应工具，再读 ' + uri + '）');
    }
    return jsonText({ key: entry.key, capturedAt: entry.at, label: entry.label, payload: entry.payload });
  }

  function finish(parsed, mimeType, text, extraMeta = {}) {
    const entry = extraMeta.entry || null;
    const rest = { ...extraMeta };
    delete rest.entry;
    const freshness = entry ? snapshotFreshness(entry, { now: clock() }) : null;
    const paged = pageResourceText(text, parsed.paging, parsed.raw);
    const meta = {
      kind: parsed.kind,
      uri: parsed.raw,
      capabilities: {
        subscribe: RESOURCE_CAPABILITIES.subscribe,
        listChanged: RESOURCE_CAPABILITIES.listChanged,
        subscription: RESOURCE_CAPABILITIES.subscription,
        persistence: Boolean(snapshotPersistence && snapshotPersistence.enabled),
      },
      ...(snapshotPersistence && snapshotPersistence.enabled ? { snapshotDir: persistenceDir, snapshotTtlMs: resolvedLimits.ttlMs } : {}),
      ...(freshness || {}),
      ...rest,
      ...paged.meta,
    };
    return {
      contents: [{
        uri: parsed.raw,
        mimeType,
        text: paged.text,
        _meta: { 'browser-bridge/resource': meta },
      }],
      _meta: { 'browser-bridge/resource': meta },
    };
  }

  /** 解析并读取一个 resource URI；返回 MCP resources/read 的 contents。 */
  function read(uri) {
    const parsed = parseResourceUri(uri);
    if (parsed.kind === RESOURCE_KINDS.SKILL_MAIN) {
      return finish(parsed, 'text/markdown', readSkill('SKILL.md'), { key: 'SKILL.md' });
    }
    if (parsed.kind === RESOURCE_KINDS.SKILL_REFERENCE) {
      return finish(parsed, 'text/markdown', readSkillReference(parsed.key), { key: parsed.key });
    }
    if (parsed.kind === RESOURCE_KINDS.UPDATE_STATE) {
      return finish(parsed, 'application/json', readUpdateStateResource());
    }
    if (parsed.kind === RESOURCE_KINDS.PROTOCOL_SUMMARY) {
      return finish(parsed, 'application/json', readProtocolSummary());
    }
    if (parsed.kind === RESOURCE_KINDS.OBSERVATION) {
      if (parsed.key === 'latest' && !observationStore.has('latest')) {
        throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '还没有观察快照（先调用 browser_observe / browser_brief）');
      }
      const entry = observationStore.get(parsed.key);
      if (!entry) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '没有缓存的 observation：' + parsed.key + '（先调用 browser_observe / browser_brief）');
      return finish(parsed, 'application/json', readSnapshot(observationStore, entry.key, parsed.raw), { key: entry.key, entry });
    }
    if (parsed.kind === RESOURCE_KINDS.EVIDENCE) {
      if (parsed.key === 'latest' && !evidenceStore.has('latest')) {
        throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '还没有调试证据（先调用 browser_debug_evidence）');
      }
      const entry = evidenceStore.get(parsed.key);
      if (!entry) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '没有缓存的 debug-evidence：' + parsed.key + '（先调用 browser_debug_evidence）');
      return finish(parsed, 'application/json', readSnapshot(evidenceStore, entry.key, parsed.raw), { key: entry.key, entry });
    }
    if (parsed.kind === RESOURCE_KINDS.JOURNAL) {
      if (parsed.key === 'latest' && !journalStore.has('latest')) {
        throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '还没有调试时间线（先调用 browser_debug_journal / browser_debug_query）');
      }
      const entry = journalStore.get(parsed.key);
      if (!entry) throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '没有缓存的 debug-journal：' + parsed.key + '（先调用 browser_debug_journal / browser_debug_query）');
      return finish(parsed, 'application/json', readSnapshot(journalStore, entry.key, parsed.raw), { key: entry.key, entry });
    }
    throw new ResourceError(RESOURCE_ERRORS.NOT_FOUND, '未知资源：' + parsed.raw);
  }

  /** 工具成功后缓存观察快照；只存可序列化的裁剪结果，避免把整个返回原文塞进内存。 */
  function recordObservation(sessionId, result, { tool = null } = {}) {
    const raw = result && typeof result === 'object' ? result : {};
    const observation = raw.observation;
    const observationText = typeof observation === 'string' ? observation : String((observation && observation.text) || '');
    const page = raw.page && typeof raw.page === 'object' ? raw.page : {};
    const key = String(raw.session || sessionId || 'latest');
    const payload = {
      tool: tool || null,
      url: String(raw.url || page.url || ''),
      title: String(raw.title || page.title || ''),
      refs: Number(raw.refs) || Number(observation && observation.refs) || 0,
      elements: Array.isArray(raw.elements) ? raw.elements.length : null,
      truncated: Boolean(raw.truncated || (observation && observation.truncated)),
      cursor: raw.cursor || (observation && observation.cursor) || null,
      observation: observationText,
      observationChars: observationText.length,
      truncatedAt: raw.truncatedAt != null ? raw.truncatedAt : null,
    };
    return recordWithUpdate(observationStore, RESOURCE_KINDS.OBSERVATION, key, payload, { tool: tool || null, kind: RESOURCE_KINDS.OBSERVATION });
  }

  function recordEvidence(sessionId, result, { tool = null } = {}) {
    const raw = result && typeof result === 'object' ? result : { result };
    const key = String(sessionId || raw.session || 'latest');
    const payload = { tool: tool || null, ...raw };
    return recordWithUpdate(evidenceStore, RESOURCE_KINDS.EVIDENCE, key, payload, { tool: tool || null, kind: RESOURCE_KINDS.EVIDENCE });
  }

  /**
   * 归一化调试时间线：保留最近 JOURNAL_MAX_EVENTS 条事件，其余只留计数/序号范围，
   * 避免一次把几十万条事件复制进内存与 MCP 文本。
   */
  function recordJournal(sessionId, result, { tool = null } = {}) {
    const raw = result && typeof result === 'object' ? result : { result };
    const events = eventArrayOf(raw);
    const key = String(raw.session || sessionId || 'latest');
    return recordWithUpdate(journalStore, RESOURCE_KINDS.JOURNAL, key, journalPayload(tool, raw, events), { tool: tool || null, kind: RESOURCE_KINDS.JOURNAL });
  }

  /**
   * 工具成功后的快照回填（server tools/call 的唯一入口）。
   * 返回 { kind, key, uri } 或 null；不认识的成功结果不做任何事。
   */
  function recordToolResult(toolName, args = {}, result = null) {
    const name = String(toolName || '');
    const argsBag = args && typeof args === 'object' ? args : {};
    const sessionKey = (result && typeof result === 'object' && result.session) || argsBag.session || 'latest';
    if (name === 'browser_observe' || name === 'browser_brief') {
      const entry = recordObservation(sessionKey, result, { tool: name });
      return entry ? { kind: RESOURCE_KINDS.OBSERVATION, key: entry.key, uri: resourceUriFor(RESOURCE_KINDS.OBSERVATION, entry.key) } : null;
    }
    if (name === 'browser_debug_evidence') {
      const entry = recordEvidence(sessionKey, result, { tool: name });
      return entry ? { kind: RESOURCE_KINDS.EVIDENCE, key: entry.key, uri: resourceUriFor(RESOURCE_KINDS.EVIDENCE, entry.key) } : null;
    }
    if (name === 'browser_debug_journal') {
      const entry = recordJournal(sessionKey, result, { tool: name });
      return entry ? { kind: RESOURCE_KINDS.JOURNAL, key: entry.key, uri: resourceUriFor(RESOURCE_KINDS.JOURNAL, entry.key) } : null;
    }
    if (name === 'browser_debug_query') {
      // 离线归档查询不是“最新时间线”：用 archive:<文件名> 作 key，避免覆盖实时 journal。
      const file = String(argsBag.file || '').trim();
      const key = file ? 'archive:' + path.basename(file) : String(sessionKey || 'archive');
      const entry = recordJournal(key, result, { tool: name });
      return entry ? { kind: RESOURCE_KINDS.JOURNAL, key: entry.key, uri: resourceUriFor(RESOURCE_KINDS.JOURNAL, entry.key) } : null;
    }
    return null;
  }

  function stats() {
    return Object.freeze({
      observations: observationStore.stats(),
      evidence: evidenceStore.stats(),
      journals: journalStore.stats(),
      staticResources: staticResources().length,
      templates: templates().length,
      restored: Object.freeze({ ...restored }),
      persistence: snapshotPersistence ? snapshotPersistence.stats() : Object.freeze({ enabled: false, dir: null }),
      loadReports: Object.freeze({ ...loadReports }),
      sweepReport,
      updates: Object.freeze({
        emitted: updateState.emitted,
        sinkErrors: updateState.sinkErrors,
        sinks: updateSinks.length,
        lastUpdate: updateState.lastUpdate,
      }),
    });
  }

  /**
   * 手动过期清理（测试/运维用）：剪掉三个 store 中超过 TTL 的条目并落盘。
   * 每条被剪掉的快照都会产生一个 action=prune-expired 的更新事件（latest 也在通知里），
   * 订阅客户端据此重读并看到 E_NOT_FOUND，而不是继续用过期缓存。
   */
  function pruneSnapshots() {
    const removed = Object.freeze({
      observation: observationStore.pruneExpired ? observationStore.pruneExpired() : [],
      evidence: evidenceStore.pruneExpired ? evidenceStore.pruneExpired() : [],
      journal: journalStore.pruneExpired ? journalStore.pruneExpired() : [],
    });
    const kinds = {
      observation: RESOURCE_KINDS.OBSERVATION,
      evidence: RESOURCE_KINDS.EVIDENCE,
      journal: RESOURCE_KINDS.JOURNAL,
    };
    for (const [name, keys] of Object.entries(removed)) {
      if (!Array.isArray(keys) || keys.length === 0) continue;
      const kind = kinds[name];
      const uris = keys.map((key) => uriFor(kind, key)).filter(Boolean);
      const latestUri = uriFor(kind, 'latest');
      if (latestUri) uris.push(latestUri);
      emitSnapshotUpdate({ action: 'prune-expired', kind, key: null, uris, removed: Object.freeze([...keys]) });
    }
    return removed;
  }

  /** 只读更新事件统计（server 的 resources/list 与单测使用）。 */
  function updateStats() {
    return Object.freeze({
      emitted: updateState.emitted,
      sinkErrors: updateState.sinkErrors,
      sinks: updateSinks.length,
      lastUpdate: updateState.lastUpdate,
    });
  }

  return Object.freeze({
    list,
    templates,
    read,
    parseUri: parseResourceUri,
    recordObservation,
    recordEvidence,
    recordJournal,
    recordToolResult,
    stats,
    updateStats,
    addUpdateSink,
    uriFor,
    pruneSnapshots,
    observations: observationStore,
    evidence: evidenceStore,
    journals: journalStore,
    persistence: snapshotPersistence,
    restored: Object.freeze({ ...restored }),
    loadReports: Object.freeze({ ...loadReports }),
    skillReferences,
    capabilities: RESOURCE_CAPABILITIES,
    home,
  });
}
