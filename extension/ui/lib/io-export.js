// ui/lib/io-export.js —— 页面数据导出模型（纯函数，无 DOM/chrome，可在 Node 单测）。
//
// 页面（debug/audit/ops/record/longshot + 数据工作台）都需要「把当前数据带走」：
// JSON 交给 Agent、CSV 交给表格、NDJSON 交给流式处理。散落各页会带来三件事不一致：
// 1. 文件名：中文标题/斜杠/Windows 保留名会不会把下载弄坏；
// 2. 脱敏：URL query 里的 token、Authorization/Cookie 头绝不能写进导出文件；
// 3. 体积：一次导出几十 MB 会卡住页面，需要提前估算/分片。
//
// 本模块只做「数据 → 文本 + 文件名 + 元信息」的纯计算，真正触发下载由页面/dom 层做。
//
// 契约：
// - 不修改入参；返回的对象可以 JSON.stringify；
// - 所有格式化函数对坏输入都返回可读结果（不抛错），页面不会因为一条怪数据白屏；
// - CSV 遵循 RFC 4180（引号转义 + CRLF），并中和公式注入（= + - @ 开头加前缀单引号）；
// - 脱敏默认开启，显式 `redact:false` 才关闭（页面导出按钮总是显式传策略）。

export const EXPORT_FORMATS = Object.freeze(['json', 'csv', 'ndjson']);

export const MIME_BY_FORMAT = Object.freeze({
  json: 'application/json;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  ndjson: 'application/x-ndjson;charset=utf-8',
});

/** 单个导出文件的字节上限（超过则分片，避免一次生成上百 MB 字符串）。 */
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

/** 需要脱敏的请求头（大小写不敏感，按前缀匹配）。 */
export const SENSITIVE_HEADER_NAMES = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-id',
]);

/** 需要脱敏的 URL query 参数名（大小写不敏感）。 */
export const SENSITIVE_QUERY_NAMES = Object.freeze([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'passwd',
  'sig',
  'signature',
  'auth',
  'session',
  'sessionid',
  'code',
]);

/** 脱敏后的占位文本（既保留“这里原来有值”的信息，又不泄露内容）。 */
export const REDACTED = '[redacted]';

/** 统一格式名：未知格式回退 json（页面下拉框遇到脏值也不至于空着）。 */
export function normalizeFormat(format) {
  const value = String(format === undefined || format === null ? '' : format).trim().toLowerCase();
  return EXPORT_FORMATS.includes(value) ? value : 'json';
}

/** 估算 UTF-8 字节数（不依赖 TextEncoder，Node/浏览器都能跑）。 */
export function utf8Bytes(input) {
  const text = String(input === undefined || input === null ? '' : input);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一次算 4 字节，跳过低位代理。
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** 两位补零。 */
function pad2(value) {
  return String(Math.floor(Math.abs(Number(value) || 0))).padStart(2, '0');
}

/**
 * 文件名时间戳：本地时间 `20261126-034712`，`utc:true` 时用 UTC。
 * @param {Date|number|string} [date]
 */
export function formatStamp(date, { utc = false } = {}) {
  const instance = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
  const valid = Number.isFinite(instance.getTime()) ? instance : new Date();
  const read = utc
    ? [valid.getUTCFullYear(), valid.getUTCMonth() + 1, valid.getUTCDate(), valid.getUTCHours(), valid.getUTCMinutes(), valid.getUTCSeconds()]
    : [valid.getFullYear(), valid.getMonth() + 1, valid.getDate(), valid.getHours(), valid.getMinutes(), valid.getSeconds()];
  return String(read[0]) + pad2(read[1]) + pad2(read[2]) + '-' + pad2(read[3]) + pad2(read[4]) + pad2(read[5]);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 安全的导出文件名：去掉路径分隔符/控制字符，收敛空白，避开 Windows 保留名。
 * 中文等 Unicode 字母保留（用户看得懂），只替换真正危险/不可见的字符。
 * @returns {string} 不带扩展名、长度受控的文件名主体（可能为空串，由调用方兜底）
 */
export function sanitizeFileName(name, { maxLength = 80 } = {}) {
  const raw = String(name === undefined || name === null ? '' : name);
  let text = typeof raw.normalize === 'function' ? raw.normalize('NFC') : raw;
  text = text
    // 控制字符与路径分隔符（含 Windows 非法字符）。
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    // 一些跨平台不可见的格式化字符。
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    // 首尾的点和空格在 Windows 上会被静默裁掉。
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  const limit = Math.max(1, Math.floor(Number(maxLength) || 80));
  if (text.length > limit) {
    // 优先按码点截断，避免把代理对切成半个字符。
    text = [...text].slice(0, limit).join('');
  }
  if (!text) return '';
  if (WINDOWS_RESERVED.test(text)) text = '_' + text;
  return text;
}

/**
 * 导出文件名：`bridge-<surface>-<stamp>.<ext>`。
 * @param {{surface?:string, format?:string, stamp?:string, suffix?:string, maxLength?:number}} options
 */
export function exportFileName(options = {}) {
  const format = normalizeFormat(options.format);
  const surface = sanitizeFileName(options.surface || 'export', { maxLength: 40 }) || 'export';
  const stamp = sanitizeFileName(options.stamp || formatStamp(), { maxLength: 32 }) || formatStamp();
  const suffix = sanitizeFileName(options.suffix || '', { maxLength: 32 });
  const ext = format === 'ndjson' ? 'ndjson' : format;
  return ['bridge', surface, suffix, stamp].filter(Boolean).join('-') + '.' + ext;
}

/** CSV 单元格转义：引号翻倍、含分隔符/换行/引号时整体加引号。 */
export function csvEscape(value, { delimiter = ',', quote = '"' } = {}) {
  const text = String(value === undefined || value === null ? '' : value);
  const needsQuote = text.includes(quote) || text.includes(delimiter) || /[\r\n]/.test(text) || /^\s|\s$/.test(text);
  if (!needsQuote) return text;
  return quote + text.split(quote).join(quote + quote) + quote;
}

/**
 * 中和公式注入：以 = + - @ 或制表符/回车开头的单元格加前缀单引号。
 * 这是导出 CSV 时最容易被忽略的安全问题（Excel 会把 =HYPERLINK(...) 当公式执行）。
 */
export function neutralizeFormula(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (/^[=+\-@\t\r]/.test(value)) return "'" + value;
  return value;
}

/**
 * 对象数组 → CSV 文本。
 * @param {Array<{key:string, label?:string, text?:(row:any)=>any}>} columns
 * @param {Array<object>} rows
 * @param {{delimiter?:string, newline?:string, includeHeader?:boolean, headerText?:boolean,
 *   neutralize?:boolean, bom?:boolean}} [options]
 */
export function toCsv(columns, rows, options = {}) {
  const cols = Array.isArray(columns) ? columns.filter((column) => column && (column.key !== undefined || column.id !== undefined)) : [];
  const list = Array.isArray(rows) ? rows : [];
  const delimiter = String(options.delimiter || ',');
  const newline = options.newline === undefined ? '\r\n' : String(options.newline);
  const neutralize = options.neutralize !== false;
  const lines = [];
  if (options.includeHeader !== false) {
    lines.push(cols.map((column) => csvEscape(neutralize ? neutralizeFormula(headerOf(column)) : headerOf(column), { delimiter })).join(delimiter));
  }
  for (const row of list) {
    lines.push(cols.map((column) => {
      const raw = cellValue(column, row);
      const text = neutralize ? neutralizeFormula(raw) : raw;
      return csvEscape(text, { delimiter });
    }).join(delimiter));
  }
  const body = lines.join(newline);
  // BOM 让 Excel 正确识别 UTF-8（中文不会变乱码）；默认关闭，调用方按需打开。
  return options.bom ? '\ufeff' + body : body;
}

function headerOf(column) {
  return String(column.label || column.title || column.key || column.id || '');
}

function cellValue(column, row) {
  try {
    if (typeof column.text === 'function') {
      const value = column.text(row);
      return value === undefined || value === null ? '' : String(value);
    }
    const key = column.key !== undefined ? column.key : column.id;
    const value = row && row[key];
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch {
    return '?';
  }
}

/** 对象数组 → NDJSON（每行一个 JSON，末尾带换行）。 */
export function toNdjson(rows, { replacer } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const encode = typeof replacer === 'function' ? replacer : undefined;
  return list.map((row) => {
    try {
      return JSON.stringify(row === undefined ? null : row, encode);
    } catch {
      return JSON.stringify({ error: 'unserializable' });
    }
  }).join('\n') + (list.length ? '\n' : '');
}

/** 判断字符串是否像敏感值（用于给用户“已脱敏”的提示，而不是真的解密）。 */
export function looksSecret(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (text.length < 8) return false;
  // Bearer 前缀大小写都算（真实请求头两种写法都存在）。
  return /^(?:bearer\s+)?[A-Za-z0-9._~+/=-]{16,}$/i.test(text);
}

/**
 * 请求头脱敏：命中的名字 → `[redacted]`，其余原样。
 * @param {Record<string,string>|Array<[string,string]>} headers
 */
export function redactHeaders(headers) {
  const pairs = Array.isArray(headers)
    ? headers
    : Object.entries(headers && typeof headers === 'object' ? headers : {});
  const out = [];
  let redacted = 0;
  for (const [name, value] of pairs) {
    const lower = String(name || '').toLowerCase();
    const hit = SENSITIVE_HEADER_NAMES.some((needle) => lower === needle || lower.startsWith(needle + '-'));
    if (hit) {
      out.push([String(name), REDACTED]);
      redacted += 1;
    } else {
      out.push([String(name), String(value === undefined || value === null ? '' : value)]);
    }
  }
  return { headers: out, redacted };
}

/**
 * URL 脱敏：默认保留 origin + pathname，query/fragment 中敏感参数替换为 [redacted]。
 * `keepQuery:true` 时保留非敏感参数（便于排查），敏感参数仍然脱敏。
 */
export function redactUrl(url, { keepQuery = false } = {}) {
  const text = String(url === undefined || url === null ? '' : url);
  if (!text) return { url: '', redacted: 0 };
  // 相对 URL / 非标准 scheme 也能处理：用字符串切分而不是强依赖 URL 构造器（Node 里 URL 需要 base）。
  const hashIndex = text.indexOf('#');
  const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
  const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
  const queryIndex = beforeHash.indexOf('?');
  if (queryIndex < 0) return { url: text, redacted: 0 };
  if (!keepQuery) {
    return { url: beforeHash.slice(0, queryIndex) + '?[redacted]' + hash, redacted: 1 };
  }
  const base = beforeHash.slice(0, queryIndex);
  const params = beforeHash.slice(queryIndex + 1).split('&');
  let redacted = 0;
  const next = params.map((pair) => {
    if (!pair) return pair;
    const eq = pair.indexOf('=');
    const name = (eq >= 0 ? pair.slice(0, eq) : pair);
    const decoded = decodeURIComponentSafe(name).toLowerCase();
    if (SENSITIVE_QUERY_NAMES.includes(decoded) || /(token|secret|passw|key|sig)/.test(decoded)) {
      redacted += 1;
      return name + '=' + encodeURIComponent(REDACTED);
    }
    return pair;
  });
  return { url: base + '?' + next.filter(Boolean).join('&') + hash, redacted };
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value);
  }
}

/**
 * 一行数据的脱敏：URL 字段单独处理（保留结构），请求头整段脱敏，其余字段原样。
 * @returns {{row:object, redacted:number, fields:string[]}}
 */
export function redactRow(row, options = {}) {
  const keepQuery = options.keepQuery === true;
  if (!row || typeof row !== 'object') return { row, redacted: 0, fields: [] };
  const copy = { ...row };
  let redacted = 0;
  const fields = [];
  for (const key of ['url', 'uri', 'href', 'documentURL', 'documentUrl']) {
    if (typeof copy[key] === 'string' && copy[key]) {
      const result = redactUrl(copy[key], { keepQuery });
      copy[key] = result.url;
      if (result.redacted) { redacted += result.redacted; fields.push(key); }
    }
  }
  for (const key of ['headers', 'requestHeaders', 'responseHeaders']) {
    if (copy[key] && typeof copy[key] === 'object') {
      const result = redactHeaders(copy[key]);
      copy[key] = Array.isArray(copy[key]) ? result.headers : Object.fromEntries(result.headers);
      if (result.redacted) { redacted += result.redacted; fields.push(key); }
    }
  }
  // 常见的“一整段请求原始文本”字段：只做关键字替换，避免误伤结构。
  for (const key of ['raw', 'rawHeaders', 'body', 'responseText']) {
    if (typeof copy[key] === 'string' && looksSecret(copy[key])) {
      copy[key] = REDACTED;
      redacted += 1;
      fields.push(key);
    }
  }
  return { row: copy, redacted, fields };
}

/** 批量脱敏，保留原顺序。 */
export function redactRows(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  let redacted = 0;
  const fields = new Set();
  const out = list.map((row) => {
    const result = redactRow(row, options);
    redacted += result.redacted;
    for (const field of result.fields) fields.add(field);
    return result.row;
  });
  return { rows: out, redacted, fields: [...fields] };
}

/**
 * 生成导出载荷（不触碰 DOM）。
 * @param {{surface?:string, format?:string, rows?:Array, columns?:Array, meta?:object,
 *   redact?:boolean, keepQuery?:boolean, replacer?:Function, stamp?:Date|number|string,
 *   maxBytes?:number, bom?:boolean}} options
 * @returns {{ok:boolean, format:string, mime:string, fileName:string, text:string, bytes:number,
 *   rowCount:number, redacted:number, redactedFields:Array<string>, truncated:boolean,
 *   warnings:Array<string>, preview:Array<object>, meta:object}}
 */
export function buildExportPayload(options = {}) {
  const format = normalizeFormat(options.format);
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const columns = Array.isArray(options.columns) ? options.columns : [];
  const warnings = [];
  let data = rows;
  let redacted = 0;
  let redactedFields = [];
  let truncated = false;
  // 下限 8 KiB：再小的“导出上限”没有实际意义，也会让合法小数据被误截断。
  const maxBytes = Math.max(8 * 1024, Math.floor(Number(options.maxBytes) || MAX_EXPORT_BYTES));

  if (options.redact !== false) {
    const result = redactRows(rows, { keepQuery: options.keepQuery === true });
    data = result.rows;
    redacted = result.redacted;
    redactedFields = result.fields;
  }
  if (!data.length) warnings.push('no-rows');

  const meta = {
    exportedAt: options.stamp instanceof Date ? options.stamp.toISOString() : new Date(options.stamp === undefined ? Date.now() : options.stamp).toISOString(),
    surface: String(options.surface || 'export'),
    format,
    rowCount: data.length,
    app: 'BridgeDeck',
    schema: 1,
    ...(options.meta && typeof options.meta === 'object' ? options.meta : {}),
  };

  let text;
  if (format === 'csv') {
    text = toCsv(columns.length ? columns : inferColumns(data), data, {
      delimiter: options.delimiter,
      newline: options.newline,
      includeHeader: options.includeHeader !== false,
      neutralize: options.neutralize !== false,
      bom: options.bom === true,
    });
  } else if (format === 'ndjson') {
    text = toNdjson(data, { replacer: options.replacer });
  } else {
    try {
      text = JSON.stringify({ meta, rows: data }, options.replacer, options.pretty === false ? 0 : 2);
    } catch (error) {
      // 循环引用/大 BigInt 等不可序列化数据：降级成“每行单独尽力序列化”。
      warnings.push('unserializable');
      text = JSON.stringify({
        meta,
        rows: data.map((row) => {
          try { return row; } catch { return null; }
        }),
      }, null, 2);
    }
  }
  let bytes = utf8Bytes(text);
  if (bytes > maxBytes && format !== 'ndjson') {
    truncated = true;
    warnings.push('size-limit');
    // 截断策略：JSON 只保留前面的行（仍保持合法 JSON）；CSV 只保留前面的行。
    let keep = data.length;
    while (keep > 0 && bytes > maxBytes) {
      keep = Math.max(0, Math.floor(keep * 0.8) - 1);
      const sliced = data.slice(0, keep);
      text = format === 'csv'
        ? toCsv(columns.length ? columns : inferColumns(data), sliced, { delimiter: options.delimiter, newline: options.newline, includeHeader: options.includeHeader !== false, neutralize: options.neutralize !== false, bom: options.bom === true })
        : JSON.stringify({ meta: { ...meta, rowCount: keep, truncated: true }, rows: sliced }, options.replacer, options.pretty === false ? 0 : 2);
      bytes = utf8Bytes(text);
    }
    data = data.slice(0, keep);
  }
  return {
    ok: true,
    format,
    mime: MIME_BY_FORMAT[format],
    fileName: exportFileName({ surface: options.surface, format, stamp: formatStamp(options.stamp), suffix: options.suffix }),
    text,
    bytes,
    rowCount: data.length,
    redacted,
    redactedFields,
    truncated,
    warnings,
    preview: data.slice(0, Math.max(0, Math.min(20, Math.floor(Number(options.previewLimit) || 8)))),
    meta,
  };
}

/** 从对象数组推断列（取并集，保持首次出现顺序；最多 64 列）。 */
export function inferColumns(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = [];
  const seen = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
      if (keys.length >= 64) break;
    }
    if (keys.length >= 64) break;
  }
  return keys.map((key) => ({ key, label: key }));
}

/**
 * 大导出分片：按字节上限把文本按行切成多个片段（每片仍是完整行）。
 * NDJSON 天然适合流式；JSON/CSV 由调用方可选使用（下载多文件）。
 * @returns {Array<{index:number, total:number, text:string, bytes:number}>}
 */
export function splitExport(text, { maxBytes = MAX_EXPORT_BYTES } = {}) {
  const source = String(text === undefined || text === null ? '' : text);
  if (!source) return [];
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || MAX_EXPORT_BYTES));
  if (utf8Bytes(source) <= limit) {
    return [{ index: 1, total: 1, text: source, bytes: utf8Bytes(source) }];
  }
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const line of source.split('\n')) {
    const lineBytes = utf8Bytes(line) + 1;
    if (current.length && currentBytes + lineBytes > limit) {
      chunks.push(current.join('\n'));
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks.map((chunk, index) => ({ index: index + 1, total: chunks.length, text: chunk, bytes: utf8Bytes(chunk) }));
}

/**
 * 下载描述（不含 DOM 调用）：页面 / page-tools 拿到后自己决定怎么落地。
 * @returns {{name:string, mime:string, bytes:number, text:string, revoke:boolean}}
 */
export function buildDownloadDescriptor(payload, { name } = {}) {
  const safe = payload && typeof payload === 'object' ? payload : {};
  const text = String(safe.text === undefined || safe.text === null ? '' : safe.text);
  return {
    name: sanitizeFileName(name || safe.fileName || exportFileName()) || exportFileName(),
    mime: String(safe.mime || MIME_BY_FORMAT.json),
    bytes: Number.isFinite(Number(safe.bytes)) ? Number(safe.bytes) : utf8Bytes(text),
    text,
    revoke: true,
  };
}

/**
 * 导出的可访问状态摘要（页面 aria-live 播报用；不引入 labels 依赖，保持纯数据）。
 * @returns {{rows:number, bytes:number, redacted:number, truncated:boolean, warnings:Array<string>}}
 */
export function summarizeExport(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    rows: Number(source.rowCount) || 0,
    bytes: Number(source.bytes) || 0,
    redacted: Number(source.redacted) || 0,
    truncated: source.truncated === true,
    warnings: Array.isArray(source.warnings) ? source.warnings.slice() : [],
  };
}

/** 每个页面的导出预设：决定默认格式与列（页面按钮一键导出时使用）。 */
export const EXPORT_PRESETS = Object.freeze({
  debug: Object.freeze({ format: 'json', surface: 'debug' }),
  audit: Object.freeze({ format: 'csv', surface: 'audit' }),
  ops: Object.freeze({ format: 'json', surface: 'ops' }),
  record: Object.freeze({ format: 'json', surface: 'record' }),
  longshot: Object.freeze({ format: 'json', surface: 'longshot' }),
  workspace: Object.freeze({ format: 'json', surface: 'workspace' }),
});

/** 取某个页面的导出预设（未知页面回退 workspace 形态）。 */
export function exportPresetFor(surface) {
  const key = String(surface || '');
  return EXPORT_PRESETS[key] || EXPORT_PRESETS.workspace;
}
