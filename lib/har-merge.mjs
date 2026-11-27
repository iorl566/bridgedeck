// lib/har-merge.mjs —— HAR 1.2 深化：多 HAR 合并 / 去重 / 时间归一 / 冲突裁决 /
// 结构校验（pages/pageTimings/entries/timings）/ 往返一致性证据。
//
// 为什么单独一层（而不是塞进 har-normalize.mjs）：
//   * har-normalize 是"单份 HAR 的字段规范化"，在性能门禁 `har.normalize` 的热路径上
//     （tools/performance-budget.mjs），不能再加重；
//   * 合并/校验/往返是"多份来源 + 解释性报告"的离线分析层，只在导入/导出命令里跑，
//     可以承担更多计算与更详细的证据输出。
//
// 设计约束（与既有输出兼容）：
//   * 纯函数：不读文件、不联网、不读时钟以外的环境；输入非法一律结构化报告，不抛异常；
//   * 默认输出只 **新增** `_` 前缀扩展字段，不改动 HAR 1.2 标准字段；
//   * 所有裁决/丢弃都写进 report 的 conflicts / duplicates / failures，可解释、可复现。
//
// 消费点：
//   * lib/har.mjs `buildHar` —— 导出后附 `log._validation`（debug har / MCP browser_debug_har）；
//   * lib/har-import.mjs `importHar` —— 多 HAR 合并、导入校验、往返一致性
//     （debug har-import / MCP browser_debug_har_import）。

import {
  HAR_VERSION,
  DEFAULT_WS_PAYLOAD_LIMIT,
  normalizeHar,
  normalizeHarEntry,
  isoTime,
  parseTime,
  toHeadersArray,
  headersToObject,
  harByteTotal,
  validateHar,
} from './har-normalize.mjs';

export const HAR_MERGE_VERSION = 1;
export const DEFAULT_DEDUP_WINDOW_MS = 1000;
export const DEFAULT_MAX_VALIDATION_ISSUES = 500;
export const DEFAULT_ROUND_TRIP_LIMIT = 200;
export const CONFLICT_POLICIES = Object.freeze(['prefer-complete', 'prefer-first', 'prefer-last']);
export const MERGE_ALIGNMENTS = Object.freeze(['absolute', 'rebase']);

const SEVERITY_ERROR = 'error';
const SEVERITY_WARNING = 'warning';
const SEVERITY_INFO = 'info';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function fnv1a(text) {
  let hash = 0x811c9dc5;
  const value = String(text == null ? '' : text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOf(value) {
  return String(value == null ? '' : value);
}

function methodOf(entry) {
  return textOf(entry && entry.request && entry.request.method || entry && entry.method || 'GET').toUpperCase();
}

function urlOf(entry) {
  return textOf(entry && entry.request && entry.request.url || entry && entry.url || '');
}

function bodyOf(entry) {
  const postData = entry && entry.request && entry.request.postData;
  if (postData && typeof postData.text === 'string') return postData.text;
  if (entry && typeof entry.body === 'string') return entry.body;
  return '';
}

/** 归一 URL：去掉默认端口、hash；query 顺序保留（HAR 里 query 顺序通常有意义）。 */
export function canonicalHarUrl(url) {
  const source = textOf(url);
  if (!source) return '';
  try {
    const parsed = new URL(source);
    parsed.hash = '';
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
    return parsed.toString();
  } catch {
    return source;
  }
}

/** 稳定请求身份键：method + canonical url + body 哈希；用于跨来源去重。 */
export function harRequestKey(entry) {
  return methodOf(entry) + ' ' + canonicalHarUrl(urlOf(entry)) + ' ' + fnv1a(bodyOf(entry));
}

function statusOf(entry) {
  const status = finite(entry && entry.response && entry.response.status != null
    ? entry.response.status
    : entry && entry.status);
  return status == null ? 0 : status;
}

function startedAtOf(entry) {
  return parseTime(entry && entry._startedAt)
    ?? parseTime(entry && entry.startedDateTime)
    ?? parseTime(entry && entry._finishedAt == null ? null : entry._finishedAt);
}

function finishedAtOf(entry) {
  return finite(entry && entry._finishedAt);
}

function contentTextOf(entry) {
  const content = entry && entry.response && entry.response.content;
  return content && typeof content.text === 'string' ? content.text : '';
}

function entryByteSize(entry) {
  return finite(entry && entry._transferSize)
    ?? finite(entry && entry.response && entry.response._transferSize)
    ?? finite(entry && entry.response && entry.response.bodySize)
    ?? 0;
}

function wsMessageKey(message) {
  return [
    textOf(message && message.type),
    textOf(message && message.time),
    textOf(message && message.opcode),
    fnv1a(textOf(message && message.data)),
  ].join('|');
}

/** 深度相等（只用于合并后的冲突证据，不用于业务判定）。 */
export function deepEqualJson(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left && right && typeof left === 'object') {
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      return left.every((item, index) => deepEqualJson(item, right[index]));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqualJson(left[key], right[key]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 来源解析：非法来源结构化报告，绝不抛异常
// ---------------------------------------------------------------------------

/**
 * 解析一个合并来源。支持：
 *   * HAR 文档 `{log:{entries:[...]}}`；
 *   * 只有 entries 的包装 `{entries:[...]}`；
 *   * JSON 字符串（文件内容直接传入）；
 *   * 裸 entry 数组（当作一份只有 entries 的 HAR）。
 * 返回 `{ok:true, har, label}` 或 `{ok:false, failure:{index,code,message,label}}`。
 */
export function parseHarSource(raw, { index = 0, label = '' } = {}) {
  const tag = textOf(label) || 'source[' + index + ']';
  const failureOf = (code, message) => ({
    ok: false,
    failure: { index, label: tag, code, message },
  });
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return failureOf('unparsable-json', '来源不是合法 JSON：' + textOf(error && error.message));
    }
  }
  if (value == null) return failureOf('missing-source', '来源为空');
  if (Array.isArray(value)) {
    if (value.length === 0) return failureOf('empty-entries', '来源是空数组');
    return { ok: true, har: { log: { version: HAR_VERSION, creator: { name: 'BridgeDeck', version: '0.3.1' }, pages: [], entries: value } }, label: tag };
  }
  if (typeof value !== 'object') return failureOf('not-har', '来源不是 HAR 对象（' + typeof value + '）');
  if (value.log && typeof value.log === 'object' && Array.isArray(value.log.entries)) {
    return { ok: true, har: value, label: tag };
  }
  if (Array.isArray(value.entries)) {
    return { ok: true, har: { ...value, log: { version: HAR_VERSION, ...(value.log || {}), entries: value.entries } }, label: tag };
  }
  return failureOf('not-har', '来源缺少 log.entries 数组');
}

// ---------------------------------------------------------------------------
// 结构校验：HAR 1.2 标准字段 + BridgeDeck 扩展字段，带严重级别与解释
// ---------------------------------------------------------------------------

function issue(path, code, message, severity = SEVERITY_WARNING) {
  return { path, code, message, severity };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkHeaders(path, headers, add) {
  if (headers == null) return;
  if (!Array.isArray(headers)) {
    add(issue(path, 'bad-headers', 'headers 必须是 [{name,value}] 数组', SEVERITY_ERROR));
    return;
  }
  headers.forEach((header, index) => {
    if (!isPlainObject(header)) {
      add(issue(path + '[' + index + ']', 'bad-header', 'header 不是对象', SEVERITY_ERROR));
      return;
    }
    if (header.name == null || String(header.name) === '') {
      add(issue(path + '[' + index + '].name', 'missing-header-name', 'header 缺少 name', SEVERITY_WARNING));
    }
    if (header.value != null && typeof header.value !== 'string') {
      add(issue(path + '[' + index + '].value', 'bad-header-value', 'header.value 应该是字符串', SEVERITY_WARNING));
    }
  });
}

function sumTimingFields(timings) {
  let total = 0;
  for (const key of ['blocked', 'dns', 'connect', 'send', 'wait', 'receive']) {
    const value = finite(timings[key]);
    if (value != null && value > 0) total += value;
  }
  return total;
}

const TIMING_FIELDS = ['blocked', 'dns', 'connect', 'ssl', 'send', 'wait', 'receive'];

/**
 * 深度校验 HAR（不抛异常）。
 * 返回 {ok, issues, counts, entries, pages, truncated}；`ok=false` 仅当有 error 级别问题。
 * options: {maxIssues, requirePages}
 */
export function validateHarDeep(har, options = {}) {
  const maxIssues = Math.max(1, Math.floor(finite(options.maxIssues) ?? DEFAULT_MAX_VALIDATION_ISSUES));
  const issues = [];
  let omitted = 0;
  const add = (item) => {
    if (issues.length >= maxIssues) {
      omitted += 1;
      return;
    }
    issues.push(item);
  };
  const base = validateHar(har);
  for (const item of base.issues) add(issue(item.path, item.code, item.message, SEVERITY_ERROR));
  const log = isPlainObject(har) && isPlainObject(har.log) ? har.log : null;
  if (!log) {
    return {
      ok: false,
      issues,
      counts: countSeverities(issues),
      entries: 0,
      pages: 0,
      truncated: false,
      baseCodes: base.issues.map((item) => item.code),
    };
  }
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const pages = Array.isArray(log.pages) ? log.pages : [];
  if (log.pages !== undefined && !Array.isArray(log.pages)) {
    add(issue('log.pages', 'bad-pages', 'pages 必须是数组', SEVERITY_ERROR));
  }
  const pageIds = new Map();
  pages.forEach((page, index) => {
    const path = 'log.pages[' + index + ']';
    if (!isPlainObject(page)) {
      add(issue(path, 'bad-page', 'page 不是对象', SEVERITY_ERROR));
      return;
    }
    if (page.id == null || String(page.id) === '') {
      add(issue(path + '.id', 'missing-page-id', 'page 缺少 id', SEVERITY_ERROR));
    } else {
      const id = String(page.id);
      if (pageIds.has(id)) add(issue(path + '.id', 'duplicate-page-id', 'page id 重复：' + id, SEVERITY_ERROR));
      else pageIds.set(id, index);
    }
    if (parseTime(page.startedDateTime) == null) {
      add(issue(path + '.startedDateTime', 'bad-page-time', 'page.startedDateTime 无法解析', SEVERITY_ERROR));
    }
    if (page.pageTimings !== undefined) {
      if (!isPlainObject(page.pageTimings)) {
        add(issue(path + '.pageTimings', 'bad-page-timings', 'pageTimings 必须是对象', SEVERITY_ERROR));
      } else {
        for (const key of Object.keys(page.pageTimings)) {
          const value = page.pageTimings[key];
          if (value == null) continue;
          if (['onContentLoad', 'onLoad'].includes(key)) {
            const number = finite(value);
            if (number == null || number < -1) {
              add(issue(path + '.pageTimings.' + key, 'bad-page-timing', key + ' 必须 >= -1', SEVERITY_ERROR));
            }
          } else if (!['_startedAt', '_finishedAt'].includes(key)) {
            add(issue(path + '.pageTimings.' + key, 'unknown-page-timing', '未知 pageTimings 字段：' + key, SEVERITY_INFO));
          }
        }
      }
    }
  });

  const requestIds = new Map();
  entries.forEach((entry, index) => {
    const path = 'log.entries[' + index + ']';
    if (!isPlainObject(entry)) return; // validateHar 已报 bad-entry
    const request = isPlainObject(entry.request) ? entry.request : null;
    const response = isPlainObject(entry.response) ? entry.response : null;
    if (request) {
      checkHeaders(path + '.request.headers', request.headers, add);
      if (request.url != null && String(request.url) !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(String(request.url))) {
        add(issue(path + '.request.url', 'relative-url', 'HAR 要求绝对 URL，实际：' + String(request.url).slice(0, 80), SEVERITY_WARNING));
      }
      for (const key of ['headersSize', 'bodySize']) {
        const value = finite(request[key]);
        if (value != null && value < -1) add(issue(path + '.request.' + key, 'bad-size', key + ' 必须 >= -1', SEVERITY_ERROR));
      }
      if (request.postData !== undefined && request.postData !== null && !isPlainObject(request.postData)) {
        add(issue(path + '.request.postData', 'bad-post-data', 'postData 必须是对象', SEVERITY_WARNING));
      }
    }
    if (response) {
      checkHeaders(path + '.response.headers', response.headers, add);
      for (const key of ['headersSize', 'bodySize']) {
        const value = finite(response[key]);
        if (value != null && value < -1) add(issue(path + '.response.' + key, 'bad-size', key + ' 必须 >= -1', SEVERITY_ERROR));
      }
      const content = isPlainObject(response.content) ? response.content : null;
      if (response.content !== undefined && !content) {
        add(issue(path + '.response.content', 'bad-content', 'content 必须是对象', SEVERITY_ERROR));
      }
      if (content) {
        if (content.size != null && (finite(content.size) == null || Number(content.size) < 0)) {
          add(issue(path + '.response.content.size', 'bad-content-size', 'content.size 必须 >= 0', SEVERITY_ERROR));
        }
        if (content.encoding !== undefined && content.encoding !== null && content.encoding !== 'base64') {
          add(issue(path + '.response.content.encoding', 'bad-encoding', "content.encoding 只支持 'base64'", SEVERITY_WARNING));
        }
        if (content.encoding === 'base64' && typeof content.text === 'string' && content.text !== '') {
          const compact = content.text.replace(/\s+/g, '');
          if (/%/.test(compact) && !/^[A-Za-z0-9+/]*={0,2}$/.test(compact.slice(0, 64))) {
            add(issue(path + '.response.content.text', 'bad-base64', 'base64 正文包含非法字符', SEVERITY_WARNING));
          }
        }
      }
    }
    if (entry.cache !== undefined) {
      if (!isPlainObject(entry.cache)) {
        add(issue(path + '.cache', 'bad-cache', 'cache 必须是对象', SEVERITY_ERROR));
      } else {
        for (const key of ['beforeRequest', 'afterRequest']) {
          const value = entry.cache[key];
          if (value != null && !isPlainObject(value)) {
            add(issue(path + '.cache.' + key, 'bad-cache-entry', key + ' 必须是对象或 null', SEVERITY_WARNING));
          }
        }
      }
    }
    const timings = isPlainObject(entry.timings) ? entry.timings : null;
    if (timings) {
      for (const key of TIMING_FIELDS) {
        const value = timings[key];
        if (value == null) continue;
        if (finite(value) == null || Number(value) < -1) {
          add(issue(path + '.timings.' + key, 'bad-timing', 'timing 必须 >= -1', SEVERITY_ERROR));
        }
      }
      const time = finite(entry.time);
      const sum = sumTimingFields(timings);
      // BridgeDeck 自己导出的 HAR 带 _breakdownSumMs（可能已按派生口径对齐），
      // 直接用它对账；只有外部原始 HAR 才用标准分项之和检查。
      const reconciled = finite(timings._breakdownSumMs);
      const comparableSum = reconciled != null ? reconciled : sum;
      if (time != null && comparableSum > 0 && Math.abs(comparableSum - time) > 1) {
        add(issue(path + '.timings', 'timings-sum-mismatch',
          '分项合计 ' + round(comparableSum, 2) + 'ms 与 entry.time ' + round(time, 2) + 'ms 不一致', SEVERITY_WARNING));
      }
      if (timings._reconciled === false) {
        add(issue(path + '.timings._reconciled', 'timings-not-reconciled', '分项派生与总时长未对账', SEVERITY_INFO));
      }
    }
    const startedAt = finite(entry._startedAt);
    const finishedAt = finite(entry._finishedAt);
    const time = finite(entry.time);
    if (startedAt != null && finishedAt != null) {
      if (finishedAt < startedAt) {
        add(issue(path, 'finished-before-start', '_finishedAt 早于 _startedAt', SEVERITY_ERROR));
      } else if (time != null && Math.abs((finishedAt - startedAt) - time) > 2) {
        add(issue(path, 'duration-mismatch',
          '_finishedAt-_startedAt=' + round(finishedAt - startedAt, 1) + 'ms 与 time=' + round(time, 1) + 'ms 不一致', SEVERITY_WARNING));
      }
    }
    const declared = parseTime(entry.startedDateTime);
    if (declared != null && startedAt != null && Math.abs(declared - startedAt) > 1000) {
      add(issue(path + '.startedDateTime', 'started-at-mismatch',
        'startedDateTime 与 _startedAt 相差 ' + Math.round(Math.abs(declared - startedAt)) + 'ms', SEVERITY_WARNING));
    }
    const requestId = entry._requestId == null ? null : String(entry._requestId);
    if (requestId) {
      if (!requestIds.has(requestId)) requestIds.set(requestId, []);
      requestIds.get(requestId).push(index);
    }
    if (entry._webSocketMessages !== undefined) {
      if (!Array.isArray(entry._webSocketMessages)) {
        add(issue(path + '._webSocketMessages', 'bad-ws', '_webSocketMessages 必须是数组', SEVERITY_ERROR));
      } else {
        entry._webSocketMessages.forEach((message, messageIndex) => {
          const messagePath = path + '._webSocketMessages[' + messageIndex + ']';
          if (!isPlainObject(message)) {
            add(issue(messagePath, 'bad-ws-message', 'WS 消息不是对象', SEVERITY_ERROR));
            return;
          }
          if (!['send', 'receive', 'error'].includes(String(message.type))) {
            add(issue(messagePath + '.type', 'bad-ws-type', 'WS type 必须是 send/receive/error', SEVERITY_WARNING));
          }
          if (parseTime(message.time) == null) {
            add(issue(messagePath + '.time', 'bad-ws-time', 'WS 消息 time 无法解析', SEVERITY_WARNING));
          }
          if (message.opcode != null && !Number.isInteger(Number(message.opcode))) {
            add(issue(messagePath + '.opcode', 'bad-ws-opcode', 'opcode 必须是整数', SEVERITY_WARNING));
          }
          if (message.data != null && typeof message.data !== 'string') {
            add(issue(messagePath + '.data', 'bad-ws-data', 'data 必须是字符串', SEVERITY_WARNING));
          }
        });
      }
    }
    const pageref = entry.pageref == null ? null : String(entry.pageref);
    if (pageref && !pageIds.has(pageref)) {
      add(issue(path + '.pageref', 'bad-pageref', 'pageref 指向不存在的 page：' + pageref, SEVERITY_WARNING));
    }
  });
  for (const [requestId, positions] of requestIds) {
    if (positions.length > 1) {
      add(issue('log.entries', 'duplicate-request-id',
        'requestId ' + requestId + ' 出现在 ' + positions.length + ' 个 entry（下标 ' + positions.join(',') + '）', SEVERITY_WARNING));
    }
  }
  const counts = countSeverities(issues);
  return {
    ok: counts.errors === 0,
    issues,
    counts,
    entries: entries.length,
    pages: pages.length,
    truncated: omitted > 0,
    omitted,
  };
}

function countSeverities(issues) {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const item of issues) {
    if (item.severity === SEVERITY_ERROR) counts.errors += 1;
    else if (item.severity === SEVERITY_INFO) counts.infos += 1;
    else counts.warnings += 1;
  }
  return counts;
}

/** 把校验问题压成可读行（最多 limit 条），供 CLI/日志直接打印。 */
export function explainHarIssues(validation, { limit = 20 } = {}) {
  const issues = validation && Array.isArray(validation.issues) ? validation.issues : [];
  const max = Math.max(1, Math.floor(finite(limit) ?? 20));
  const lines = issues.slice(0, max).map((item) => {
    const prefix = item.severity === SEVERITY_ERROR ? 'error' : item.severity === SEVERITY_INFO ? 'info' : 'warn';
    return '[' + prefix + '] ' + item.path + ': ' + item.message + '（' + item.code + '）';
  });
  if (issues.length > max) lines.push('…其余 ' + (issues.length - max) + ' 条见 _validation.issues');
  return lines;
}

// ---------------------------------------------------------------------------
// 合并：时间归一 + 去重 + 冲突裁决
// ---------------------------------------------------------------------------

function rankedRecords(records, policy) {
  const ranked = records.slice();
  if (policy === 'prefer-first') {
    ranked.sort((a, b) => a.sourceIndex - b.sourceIndex || a.indexInSource - b.indexInSource);
    return ranked;
  }
  if (policy === 'prefer-last') {
    ranked.sort((a, b) => b.sourceIndex - a.sourceIndex || b.indexInSource - a.indexInSource);
    return ranked;
  }
  // prefer-complete：先看有没有有效状态码/是否报错/正文/体积/时间戳，再看来源先后。
  const score = (record) => {
    const entry = record.entry;
    const status = statusOf(entry);
    const hasStatus = status >= 100 ? 1 : 0;
    const noError = entry._error ? 0 : 1;
    const hasBody = contentTextOf(entry).length > 0 ? 1 : 0;
    const bytes = entryByteSize(entry);
    const timingsComplete = finite(entry.timings && entry.timings._ttfbMs) != null ? 1 : 0;
    return hasStatus * 100000 + noError * 10000 + timingsComplete * 1000 + hasBody * 100 + Math.min(bytes, 99) + record.sourceIndex / 1000;
  };
  ranked.sort((a, b) => score(b) - score(a) || a.sourceIndex - b.sourceIndex);
  return ranked;
}

function mergeTimings(records, winner) {
  const timings = isPlainObject(winner.entry.timings) ? { ...winner.entry.timings } : {};
  for (const key of TIMING_FIELDS.concat(['totalMs', '_queueingMs', '_ttfbMs', '_contentDownloadMs'])) {
    const winnerValue = finite(timings[key]);
    if (winnerValue != null && winnerValue >= 0) continue;
    for (const record of records) {
      const candidate = finite(record.entry.timings && record.entry.timings[key]);
      if (candidate != null && candidate >= 0) {
        timings[key] = candidate;
        break;
      }
    }
  }
  if (finite(timings._breakdownSumMs) != null || finite(timings.totalMs) != null) {
    const sum = Math.max(0, finite(timings._queueingMs) ?? 0)
      + Math.max(0, finite(timings._ttfbMs) ?? 0)
      + Math.max(0, finite(timings._contentDownloadMs) ?? 0);
    timings._breakdownSumMs = round(sum);
    if (finite(timings.totalMs) != null) timings._reconciled = Math.abs(sum - Number(timings.totalMs)) <= 2;
  }
  return timings;
}

function mergeWebSocketMessages(records, winner) {
  const seen = new Set();
  const messages = [];
  const sources = [winner].concat(records.filter((record) => record !== winner));
  for (const record of sources) {
    const list = Array.isArray(record.entry._webSocketMessages) ? record.entry._webSocketMessages : [];
    for (const message of list) {
      const key = wsMessageKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({ ...message });
    }
  }
  messages.sort((a, b) => (parseTime(a.time) ?? 0) - (parseTime(b.time) ?? 0));
  return messages;
}

/**
 * 对同一逻辑请求的多份记录做冲突裁决，返回合并后的 entry + 冲突证据。
 * 只新增 `_merge` 字段，其它字段保持 normalizeHarEntry 的形状。
 */
export function arbitrateHarEntries(records, { policy = 'prefer-complete' } = {}) {
  const list = Array.isArray(records) ? records.filter((record) => record && isPlainObject(record.entry)) : [];
  if (!list.length) return { entry: null, conflicts: [], winner: null };
  const ranked = rankedRecords(list, policy);
  const winner = ranked[0];
  const merged = normalizeHarEntry(winner.entry, 0);
  const conflicts = [];
  const conflict = (kind, field, reason, extra = {}) => {
    conflicts.push({ kind, field, reason, sources: list.map((record) => record.label), winner: winner.label, ...extra });
  };
  const statuses = [...new Set(list.map((record) => statusOf(record.entry)))];
  if (statuses.length > 1) {
    conflict('status-mismatch', 'response.status', '不同来源状态码不一致，按 ' + policy + ' 取 ' + statusOf(winner.entry), { values: statuses });
  }
  const errors = list.filter((record) => Boolean(record.entry._error));
  if (errors.length && errors.length < list.length) {
    conflict('error-vs-success', '_error', '部分来源记录报错、部分成功，保留获胜来源的 ' + (winner.entry._error ? '错误' : '成功'));
  }
  const bodies = list.map((record) => contentTextOf(record.entry)).filter((body) => body.length > 0);
  if (new Set(bodies).size > 1) {
    conflict('content-mismatch', 'response.content.text', '响应正文不一致，取最长/获胜来源正文', {
      lengths: [...new Set(bodies.map((body) => body.length))].sort((a, b) => a - b),
    });
  }
  const transferSizes = [...new Set(list.map((record) => entryByteSize(record.entry)).filter((size) => size > 0))];
  if (transferSizes.length > 1) {
    conflict('size-mismatch', '_transferSize', '传输体积不一致，取获胜来源', { values: transferSizes.sort((a, b) => a - b) });
  }
  const frameIds = [...new Set(list.map((record) => record.entry._frameId).filter((frameId) => frameId != null).map((frameId) => String(frameId)))];
  if (frameIds.length > 1) {
    conflict('frame-mismatch', '_frameId', 'frame 归属不一致，取获胜来源', { values: frameIds });
  }
  const ttfbValues = [...new Set(list.map((record) => finite(record.entry.timings && record.entry.timings._ttfbMs)).filter((value) => value != null))];
  if (ttfbValues.length > 1) {
    conflict('timings-mismatch', 'timings._ttfbMs', 'TTFB 不一致，获胜来源优先、缺失分项互补', { values: ttfbValues.sort((a, b) => a - b) });
  }
  const winnerHeaders = toHeadersArray(merged.request.headers);
  const otherRequestHeaders = list.filter((record) => record !== winner)
    .map((record) => headersToObject(record.entry.request && record.entry.request.headers));
  const requestHeaderValues = new Map();
  for (const headers of otherRequestHeaders) {
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      const winnerValue = headersToObject(winnerHeaders)[key];
      if (winnerValue == null || winnerValue === value) continue;
      if (!requestHeaderValues.has(key)) requestHeaderValues.set(key, [winnerValue, value]);
    }
  }
  for (const [name, values] of requestHeaderValues) {
    conflict('header-mismatch', 'request.headers.' + name, '同名请求头取值不一致，保留获胜来源', { values });
  }

  // 正文：优先获胜来源；获胜来源没有正文时取其它来源里最长的一份。
  const request = { ...merged.request };
  const winnerBody = contentTextOf(winner.entry);
  let bodyText = winnerBody;
  let bodyEncoding = merged.response.content.encoding;
  if (!bodyText) {
    const fallback = list.find((record) => contentTextOf(record.entry).length > 0);
    if (fallback) {
      bodyText = contentTextOf(fallback.entry);
      bodyEncoding = fallback.entry.response && fallback.entry.response.content
        ? fallback.entry.response.content.encoding
        : undefined;
    }
  }
  const requestHeaders = list.filter((record) => record !== winner)
    .find((record) => Array.isArray(record.entry.request && record.entry.request.headers) && record.entry.request.headers.length > 0);
  if (requestHeaders && merged.request.headers.length === 0) {
    request.headers = toHeadersArray(requestHeaders.entry.request.headers);
  }
  const responseHeaders = list.filter((record) => record !== winner)
    .find((record) => Array.isArray(record.entry.response && record.entry.response.headers) && record.entry.response.headers.length > 0);
  const response = { ...merged.response };
  if (responseHeaders && merged.response.headers.length === 0) {
    response.headers = toHeadersArray(responseHeaders.entry.response.headers);
  }
  if (!response.content || typeof response.content !== 'object') response.content = { size: 0, mimeType: '' };
  response.content = {
    ...response.content,
    ...(bodyText ? { text: bodyText } : {}),
    ...(bodyEncoding === 'base64' ? { encoding: 'base64' } : {}),
  };
  if (!bodyText) delete response.content.text;
  const mergedEntry = {
    ...merged,
    request,
    response,
    timings: mergeTimings(list, winner),
    _transferSize: finite(merged._transferSize) || entryByteSize(winner.entry),
    _webSocketMessages: (() => {
      if (list.length === 1) return merged._webSocketMessages;
      return mergeWebSocketMessages(list, winner);
    })(),
    _merge: {
      version: HAR_MERGE_VERSION,
      policy,
      sources: list.map((record) => ({ label: record.label, sourceIndex: record.sourceIndex, indexInSource: record.indexInSource })),
      duplicates: list.length,
      winner: winner.label,
      conflicts: conflicts.map((item) => ({ ...item })),
    },
  };
  return { entry: mergedEntry, conflicts, winner };
}

function mergePages(prepared, { conflicts }) {
  const byKey = new Map();
  for (const source of prepared) {
    for (const page of source.pages) {
      const id = page.id == null ? '' : String(page.id);
      const startedAt = parseTime(page.startedDateTime);
      const key = id || (startedAt == null ? 'page' : 'page@' + startedAt) + '|' + textOf(page.title);
      if (!byKey.has(key)) {
        byKey.set(key, { page: { ...page }, sources: [source.label], starteds: [startedAt] });
        continue;
      }
      const record = byKey.get(key);
      record.sources.push(source.label);
      record.starteds.push(startedAt);
      if (!record.page.title && page.title) record.page.title = page.title;
      if (!record.page.startedDateTime && page.startedDateTime) record.page.startedDateTime = page.startedDateTime;
      if (isPlainObject(page.pageTimings)) {
        const mergedTimings = isPlainObject(record.page.pageTimings) ? { ...record.page.pageTimings } : {};
        for (const [timingKey, value] of Object.entries(page.pageTimings)) {
          if (mergedTimings[timingKey] == null) mergedTimings[timingKey] = value;
          else if (!deepEqualJson(mergedTimings[timingKey], value)) {
            conflicts.push({
              kind: 'page-timing-mismatch',
              field: 'log.pages.pageTimings.' + timingKey,
              reason: '同一 page 的分项计时不一致，保留先出现来源',
              sources: record.sources.slice(),
              winner: record.sources[0],
              values: [mergedTimings[timingKey], value],
            });
          }
        }
        record.page.pageTimings = mergedTimings;
      }
    }
  }
  return [...byKey.values()].map((record) => {
    const resolved = record.starteds.filter((value) => value != null);
    if (!record.page.startedDateTime && resolved.length) record.page.startedDateTime = isoTime(Math.min(...resolved));
    return record.page;
  }).sort((a, b) => (parseTime(a.startedDateTime) ?? 0) - (parseTime(b.startedDateTime) ?? 0));
}

/**
 * 合并多份 HAR。
 *
 * options:
 *   align            'absolute'（默认，保留原时间）| 'rebase'（各来源按首个 entry 对齐到最早来源）
 *   timeWindowMs     去重时间窗（默认 1000ms）；同 requestId 不受时间窗限制
 *   policy           冲突裁决策略：prefer-complete（默认）/prefer-first/prefer-last
 *   maxPayload       WS 帧截断上限
 *   now              归一化回退时间（固定值便于测试复现）
 *   maxValidationIssues  校验问题上限
 *
 * 返回 `{har, report}`；任何来源失败都进 report.failures，绝不抛异常。
 */
export function mergeHarSources(sources, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const now = finite(opts.now) ?? Date.now();
  const align = MERGE_ALIGNMENTS.includes(opts.align) ? opts.align : 'absolute';
  const policy = CONFLICT_POLICIES.includes(opts.policy) ? opts.policy : 'prefer-complete';
  const timeWindowMs = Math.max(0, finite(opts.timeWindowMs) ?? DEFAULT_DEDUP_WINDOW_MS);
  const maxPayload = Math.max(0, finite(opts.maxPayload) ?? DEFAULT_WS_PAYLOAD_LIMIT);
  const list = Array.isArray(sources) ? sources : (sources == null ? [] : [sources]);
  const failures = [];
  const sourceReports = [];
  const prepared = [];

  list.forEach((raw, index) => {
    const parsed = parseHarSource(raw, { index, label: opts.labels && opts.labels[index] ? opts.labels[index] : '' });
    if (!parsed.ok) {
      failures.push(parsed.failure);
      sourceReports.push({ index, label: parsed.failure.label, ok: false, failure: parsed.failure });
      return;
    }
    const normalized = normalizeHar(parsed.har, { maxPayload, now });
    const entries = normalized.log.entries;
    const pages = normalized.log.pages;
    let firstAt = null;
    for (const entry of entries) {
      const startedAt = startedAtOf(entry);
      if (startedAt == null) continue;
      if (firstAt == null || startedAt < firstAt) firstAt = startedAt;
    }
    sourceReports.push({
      index,
      label: parsed.label,
      ok: true,
      entries: entries.length,
      pages: pages.length,
      creator: normalized.log.creator,
      startedAt: firstAt == null ? null : isoTime(firstAt),
      startedAtMs: firstAt,
      offsetMs: 0,
      bytes: harByteTotal(normalized),
    });
    prepared.push({ index, label: parsed.label, entries, pages, firstAt });
  });

  let globalFirst = null;
  for (const source of prepared) {
    if (source.firstAt == null) continue;
    if (globalFirst == null || source.firstAt < globalFirst) globalFirst = source.firstAt;
  }
  for (const source of prepared) {
    const offset = align === 'rebase' && globalFirst != null && source.firstAt != null
      ? globalFirst - source.firstAt
      : 0;
    const report = sourceReports.find((item) => item.index === source.index);
    if (!report) continue;
    report.offsetMs = offset;
    if (!offset) continue;
    for (const entry of source.entries) {
      const startedAt = finite(entry._startedAt);
      const finishedAt = finite(entry._finishedAt);
      if (startedAt != null) entry._startedAt = startedAt + offset;
      if (finishedAt != null) entry._finishedAt = finishedAt + offset;
      if (startedAt != null) entry.startedDateTime = isoTime(startedAt + offset, now);
      entry._timeShiftMs = offset;
    }
    for (const page of source.pages) {
      const parsed = parseTime(page.startedDateTime);
      if (parsed != null) page.startedDateTime = isoTime(parsed + offset, now);
    }
  }

  // 全局按开始时间排序后聚合：同一逻辑请求在时间邻域内合并成一组。
  const flat = [];
  for (const source of prepared) {
    source.entries.forEach((entry, indexInSource) => {
      flat.push({ entry, sourceIndex: source.index, indexInSource, label: source.label });
    });
  }
  flat.sort((a, b) => {
    const left = startedAtOf(a.entry);
    const right = startedAtOf(b.entry);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return left - right;
  });
  const buckets = new Map(); // key -> [group]
  const groups = [];
  const conflicts = [];
  let duplicateCount = 0;
  for (const record of flat) {
    const key = harRequestKey(record.entry);
    const requestId = record.entry._requestId == null ? null : String(record.entry._requestId);
    const startedAt = startedAtOf(record.entry);
    const bucket = buckets.get(key) || [];
    let group = null;
    for (const candidate of bucket) {
      const sameRequestId = requestId != null && candidate.requestId === requestId;
      const candidateStartedAt = candidate.startedAt;
      const withinWindow = startedAt != null && candidateStartedAt != null
        && Math.abs(startedAt - candidateStartedAt) <= timeWindowMs;
      if (sameRequestId || withinWindow) {
        group = candidate;
        break;
      }
    }
    if (!group) {
      group = { key, requestId, startedAt, records: [] };
      bucket.push(group);
      buckets.set(key, bucket);
      groups.push(group);
    }
    if (group.records.length > 0) duplicateCount += 1;
    group.records.push(record);
  }
  const mergedEntries = [];
  for (const group of groups) {
    if (group.records.length === 1) {
      mergedEntries.push(group.records[0].entry);
      continue;
    }
    const arbitrated = arbitrateHarEntries(group.records, { policy });
    if (!arbitrated.entry) continue;
    for (const item of arbitrated.conflicts) conflicts.push(item);
    mergedEntries.push(arbitrated.entry);
  }
  const pages = mergePages(prepared, { conflicts });
  const har = {
    log: {
      version: HAR_VERSION,
      creator: {
        name: (isPlainObject(opts.creator) && opts.creator.name) || 'BridgeDeck',
        version: (isPlainObject(opts.creator) && opts.creator.version) || '0.3.1',
      },
      pages,
      entries: mergedEntries,
      _merge: {
        version: HAR_MERGE_VERSION,
        align,
        policy,
        timeWindowMs,
        sources: sourceReports.length,
      },
    },
  };
  const validation = validateHarDeep(har, { maxIssues: opts.maxValidationIssues });
  har.log._validation = validation;
  const report = {
    version: HAR_MERGE_VERSION,
    ok: failures.length === 0,
    align,
    policy,
    timeWindowMs,
    sources: sourceReports,
    failures,
    entries: {
      total: flat.length,
      kept: mergedEntries.length,
      duplicates: duplicateCount,
      mergedGroups: groups.filter((group) => group.records.length > 1).length,
    },
    pages: { kept: pages.length, total: sourceReports.reduce((sum, item) => sum + (item.pages || 0), 0) },
    conflicts,
    time: {
      base: globalFirst == null ? null : isoTime(globalFirst),
      baseMs: globalFirst,
      spanMs: (() => {
        let min = null;
        let max = null;
        for (const entry of mergedEntries) {
          const startedAt = finite(entry._startedAt);
          if (startedAt == null) continue;
          if (min == null || startedAt < min) min = startedAt;
          const end = finite(entry._finishedAt) ?? startedAt;
          if (max == null || end > max) max = end;
        }
        return min == null || max == null ? 0 : Math.max(0, Math.round(max - min));
      })(),
    },
    bytes: harByteTotal(har),
    validation: {
      ok: validation.ok,
      errors: validation.counts.errors,
      warnings: validation.counts.warnings,
      infos: validation.counts.infos,
    },
  };
  return { har, report };
}

/** 合并报告的可读摘要（CLI/日志用，纯函数）。 */
export function summarizeHarMergeReport(report) {
  const source = isPlainObject(report) ? report : {};
  const entries = isPlainObject(source.entries) ? source.entries : {};
  return {
    version: Number(source.version) || HAR_MERGE_VERSION,
    ok: source.ok === true,
    sources: Array.isArray(source.sources) ? source.sources.length : 0,
    failedSources: Array.isArray(source.failures) ? source.failures.length : 0,
    totalEntries: Number(entries.total) || 0,
    keptEntries: Number(entries.kept) || 0,
    duplicates: Number(entries.duplicates) || 0,
    conflicts: Array.isArray(source.conflicts) ? source.conflicts.length : 0,
    pages: (source.pages && Number(source.pages.kept)) || 0,
    spanMs: (source.time && Number(source.time.spanMs)) || 0,
    bytes: Number(source.bytes) || 0,
    validation: source.validation || { ok: true, errors: 0, warnings: 0, infos: 0 },
  };
}

// ---------------------------------------------------------------------------
// 往返一致性：export → import → export 的字段级证据
// ---------------------------------------------------------------------------

// 往返保真字段：够用且稳定。`response.bodySize` / `content.size` 不参与比较——BridgeDeck
// 的 HAR 导出把 transferSize 同时写进 bodySize（历史口径），外部 HAR 的两个体积口径可能
// 不同（压缩前/后），拿它做往返判定会误报；正文用 textHash、线上体积用 _transferSize 覆盖。
const ROUND_TRIP_FIELDS = [
  ['request.method', (entry) => textOf(entry.request && entry.request.method)],
  ['request.url', (entry) => textOf(entry.request && entry.request.url)],
  ['response.status', (entry) => Number(entry.response && entry.response.status) || 0],
  ['_resourceType', (entry) => textOf(entry._resourceType)],
  ['_transferSize', (entry) => Number(entry._transferSize) || 0],
  ['_requestId', (entry) => (entry._requestId == null ? null : String(entry._requestId))],
  ['_frameId', (entry) => (entry._frameId == null ? null : String(entry._frameId))],
  ['timings._ttfbMs', (entry) => finite(entry.timings && entry.timings._ttfbMs)],
  ['timings.wait', (entry) => finite(entry.timings && entry.timings.wait)],
  ['response.content.mimeType', (entry) => textOf(entry.response && entry.response.content && entry.response.content.mimeType)],
  ['response.content.textHash', (entry) => fnv1a(contentTextOf(entry))],
  ['_webSocketMessages.length', (entry) => (Array.isArray(entry._webSocketMessages) ? entry._webSocketMessages.length : 0)],
  ['_fromCache', (entry) => entry._fromCache === true],
];

/**
 * 比较两份 HAR 的往返保真度。不抛异常，差异以字段路径 + before/after 报告。
 * options: {now, maxDifferences}
 */
export function compareHarRoundTrip(before, after, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const now = finite(opts.now) ?? Date.parse('2026-01-01T00:00:00.000Z');
  const ignoreGeneratedRequestIds = opts.ignoreGeneratedRequestIds !== false;
  const maxDifferences = Math.max(1, Math.floor(finite(opts.maxDifferences) ?? 100));
  const left = normalizeHar(before, { now });
  const right = normalizeHar(after, { now });
  const leftEntries = left.log.entries;
  const rightEntries = right.log.entries;
  const differences = [];
  let omitted = 0;
  const push = (path, beforeValue, afterValue) => {
    if (differences.length >= maxDifferences) {
      omitted += 1;
      return;
    }
    differences.push({ path, before: beforeValue, after: afterValue });
  };
  if (leftEntries.length !== rightEntries.length) {
    push('log.entries.length', leftEntries.length, rightEntries.length);
  }
  const comparedFields = Math.min(leftEntries.length, rightEntries.length);
  for (let index = 0; index < comparedFields; index += 1) {
    for (const [field, read] of ROUND_TRIP_FIELDS) {
      const beforeValue = read(leftEntries[index]);
      const afterValue = read(rightEntries[index]);
      if (deepEqualJson(beforeValue, afterValue)) continue;
      // importHar 会给缺失 requestId 的 entry 生成 "har-N" 占位 id；那不是往返丢字段。
      if (field === '_requestId' && ignoreGeneratedRequestIds
        && (beforeValue == null || beforeValue === '') && /^har-\d+$/.test(String(afterValue))) {
        continue;
      }
      push('log.entries[' + index + '].' + field, beforeValue, afterValue);
    }
  }
  if (left.log.pages.length !== right.log.pages.length) {
    push('log.pages.length', left.log.pages.length, right.log.pages.length);
  }
  return {
    identical: differences.length === 0,
    compared: { entries: comparedFields, pages: Math.min(left.log.pages.length, right.log.pages.length), fields: ROUND_TRIP_FIELDS.length },
    differences,
    omitted,
  };
}

/** 便捷工具：给一组 entry 生成稳定的去重键（测试/调用方复用）。 */
export function harEntryFingerprint(entry) {
  return [
    harRequestKey(entry),
    textOf(entry && entry._resourceType),
    String(statusOf(entry)),
    fnv1a(JSON.stringify(toHeadersArray(entry && entry.request && entry.request.headers))),
  ].join('#');
}
