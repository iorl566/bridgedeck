// ui/lib/io-import.js —— 页面数据导入模型（纯函数，无 DOM/chrome，可在 Node 单测）。
//
// 导入看起来只是 JSON.parse，真实页面会连续踩到这些坑：
// 1. 用户从表格里复制的是 TSV，从日志里复制的是 NDJSON，从导出文件拿到的是带 meta 的 JSON 信封；
// 2. CSV 有 BOM、CRLF、引号里的换行、末尾空行；
// 3. 列类型不一致（"1" vs 1、时间戳字符串 vs 数字），逐行报错要给到行列；
// 4. 同一个 key 重复导入要能去重/合并，且合并前后行数可解释；
// 5. 一次导入 50 万行会把页面卡死，需要上限与预览截断。
//
// 本模块把「解析 → 归一化 → 校验 → 合并」拆成纯函数，页面/测试可以逐段断言，
// 错误信息统一形如 {index, line, field, code, message}，UI 只负责渲染。

import { looksSecret } from './io-export.js';

export const IMPORT_FORMATS = Object.freeze(['json', 'ndjson', 'csv']);

/** 导入上限：超过就拒绝（页面给“拆开导入”的提示），而不是偷偷截断。 */
export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 64,
  maxCellLength: 100_000,
  previewRows: 20,
});

/** 支持的字段类型（与列配置/过滤器的类型口径一致）。 */
export const IMPORT_TYPES = Object.freeze(['string', 'number', 'boolean', 'timestamp', 'json']);

/** 按文件名后缀识别格式（识别不了返回空串，交给内容嗅探）。 */
export function formatFromFileName(fileName) {
  const name = String(fileName === undefined || fileName === null ? '' : fileName).toLowerCase();
  if (name.endsWith('.ndjson') || name.endsWith('.jsonl')) return 'ndjson';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  if (name.endsWith('.json')) return 'json';
  return '';
}

/**
 * 内容嗅探：先看首个非空字符，再看行结构。
 * - `{` / `[` → JSON；每行都是对象 → NDJSON；含制表符或逗号且多行 → CSV。
 */
export function sniffFormat(text) {
  const source = String(text === undefined || text === null ? '' : text).replace(/^\ufeff/, '');
  const trimmed = source.trim();
  if (!trimmed) return '';
  const first = trimmed[0];
  if (first === '[' || first === '{') {
    // 多行且每行都以 { 开头，更像 NDJSON（JSON 整体只有一层首字符）。
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 1 && lines[0].trim().startsWith('{') && trimmed[0] === '{') {
      const second = lines[1].trim();
      if (second.startsWith('{')) return 'ndjson';
    }
    return 'json';
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length >= 1) {
    if (lines[0].includes('\t')) return 'csv';
    if (lines[0].includes(',')) return 'csv';
  }
  return '';
}

/** 识别导入格式：显式 format 优先，其次文件名，最后内容嗅探。 */
export function detectImportFormat(text, { fileName = '', format = '' } = {}) {
  const explicit = String(format || '').toLowerCase();
  if (IMPORT_FORMATS.includes(explicit)) return { format: explicit, by: 'explicit' };
  const byName = formatFromFileName(fileName);
  if (byName) return { format: byName, by: 'file-name' };
  const byContent = sniffFormat(text);
  if (byContent) return { format: byContent, by: 'content' };
  return { format: 'json', by: 'fallback' };
}

/**
 * CSV 解析（RFC 4180 子集）：支持引号转义、引号内换行、CRLF/LF、BOM。
 * @returns {{cells:string[][], errors:Array<{line:number, code:string, message:string}>, delimiter:string}}
 */
export function parseCsvRows(text, { delimiter } = {}) {
  const source = String(text === undefined || text === null ? '' : text).replace(/^\ufeff/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const detected = delimiter ? String(delimiter) : (firstLine.includes('\t') ? '\t' : ',');
  const sep = detected;
  const cells = [];
  const errors = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowStartLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else {
        field += char;
        if (char === '\n') line += 1;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      continue;
    }
    if (char === sep) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      cells.push(row);
      row = [];
      field = '';
      line += 1;
      rowStartLine = line;
      continue;
    }
    field += char;
  }
  if (quoted) {
    // 未闭合的引号：把已读内容作为一行返回，同时给出可定位的错误。
    errors.push({ line: rowStartLine, code: 'E_CSV_UNCLOSED_QUOTE', message: 'CSV 引号没有闭合' });
  }
  if (field !== '' || row.length) {
    row.push(field);
    cells.push(row);
  }
  // 去掉末尾全空行（Excel 导出常见）。
  while (cells.length && cells[cells.length - 1].every((cell) => cell === '')) cells.pop();
  return { cells, errors, delimiter: sep };
}

/** 解析 NDJSON：逐行 JSON.parse，坏行给出真实行号。 */
export function parseNdjson(text) {
  const source = String(text === undefined || text === null ? '' : text).replace(/^\ufeff/, '');
  const lines = source.split(/\r?\n/);
  const objects = [];
  const errors = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && !Array.isArray(value)) objects.push(value);
      else errors.push({ line: index + 1, index: objects.length, code: 'E_NDJSON_NOT_OBJECT', message: 'NDJSON 行不是对象' });
    } catch {
      errors.push({ line: index + 1, index: objects.length, code: 'E_NDJSON_BAD_JSON', message: 'NDJSON 行不是合法 JSON' });
    }
  });
  return { objects, errors };
}

/** 从 JSON 信封里取数组：兼容 `{rows}` / `{entries}` / `{data}` / `{result:{...}}`。 */
export function unwrapJsonArray(value) {
  if (Array.isArray(value)) return { rows: value, path: '$' };
  if (!value || typeof value !== 'object') return { rows: [], path: '' };
  for (const key of ['rows', 'entries', 'records', 'items', 'data', 'result']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return { rows: candidate, path: '$.' + key, meta: value.meta || null };
    // `{result:{entries:[...]}}` 是后台 RPC 的常见形状：向下解一层再试。
    if (key === 'result' && candidate && typeof candidate === 'object') {
      const nested = unwrapJsonArray(candidate);
      if (nested.rows.length) return { rows: nested.rows, path: '$.result' + nested.path.slice(1), meta: nested.meta || value.meta || null };
    }
  }
  // 单对象（一条记录）也接受，行数 1 比“导入失败”更符合直觉。
  if (Object.keys(value).length) return { rows: [value], path: '$' };
  return { rows: [], path: '' };
}

/** JSON 解析 + 解包。 */
export function parseJsonRows(text) {
  const source = String(text === undefined || text === null ? '' : text).replace(/^\ufeff/, '');
  const errors = [];
  try {
    const value = JSON.parse(source);
    const unwrapped = unwrapJsonArray(value);
    if (unwrapped.meta && typeof unwrapped.meta === 'object') return { objects: unwrapped.rows, errors, meta: unwrapped.meta, path: unwrapped.path };
    return { objects: unwrapped.rows, errors, meta: null, path: unwrapped.path };
  } catch (error) {
    // 不是合法 JSON：如果每行独立对象，降级成 NDJSON 再试一次（用户粘贴多段 JSON 很常见）。
    const fallback = parseNdjson(source);
    if (fallback.objects.length) {
      return { objects: fallback.objects, errors: fallback.errors, meta: null, path: 'ndjson-fallback' };
    }
    errors.push({ line: 1, index: 0, code: 'E_JSON_PARSE', message: (error && error.message) || 'JSON 解析失败' });
    return { objects: [], errors, meta: null, path: '' };
  }
}

/** CSV → 对象数组（首行表头；表头重复时自动加 `_2` 后缀）。 */
export function csvToObjects(cells, { header = true } = {}) {
  const rows = Array.isArray(cells) ? cells : [];
  if (!rows.length) return { objects: [], headers: [], errors: [] };
  const errors = [];
  if (!header) {
    return {
      objects: rows.map((row) => Object.fromEntries(row.map((cell, index) => ['c' + (index + 1), cell]))),
      headers: rows[0].map((_cell, index) => 'c' + (index + 1)),
      errors,
    };
  }
  const rawHeaders = rows[0].map((cell, index) => {
    const text = String(cell === undefined || cell === null ? '' : cell).trim();
    return text || 'column' + (index + 1);
  });
  const headers = [];
  const seen = new Map();
  for (const name of rawHeaders) {
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    headers.push(count === 1 ? name : name + '_' + count);
  }
  const objects = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.every((cell) => cell === '')) continue;
    if (row.length !== headers.length) {
      errors.push({
        line: index + 1,
        index: objects.length,
        code: 'E_CSV_COLUMN_COUNT',
        message: '第 ' + (index + 1) + ' 行有 ' + row.length + ' 列，表头有 ' + headers.length + ' 列',
      });
    }
    const object = {};
    headers.forEach((name, columnIndex) => {
      object[name] = row[columnIndex] === undefined ? '' : row[columnIndex];
    });
    objects.push(object);
  }
  return { objects, headers, errors };
}

/**
 * 解析各种格式的统一入口。
 * @returns {{ok:boolean, format:string, by:string, objects:Array<object>, headers:Array<string>,
 *   errors:Array, warnings:Array<string>, meta:object|null, bytes:number, truncated:boolean}}
 */
export function parseImport(text, options = {}) {
  const source = String(text === undefined || text === null ? '' : text);
  const bytes = byteLength(source);
  const warnings = [];
  const limits = { ...IMPORT_LIMITS, ...(options.limits || {}) };
  if (!source.trim()) {
    return { ok: false, format: 'json', by: 'empty', objects: [], headers: [], errors: [{ line: 0, index: 0, code: 'E_IMPORT_EMPTY', message: '没有可导入的内容' }], warnings, meta: null, bytes, truncated: false };
  }
  if (bytes > limits.maxBytes) {
    return { ok: false, format: 'json', by: 'too-large', objects: [], headers: [], errors: [{ line: 0, index: 0, code: 'E_IMPORT_TOO_LARGE', message: '文件超过 ' + limits.maxBytes + ' 字节' }], warnings, meta: null, bytes, truncated: false };
  }
  const detected = detectImportFormat(source, { fileName: options.fileName, format: options.format });
  let objects = [];
  let headers = [];
  let errors = [];
  let meta = null;
  if (detected.format === 'csv') {
    const parsed = parseCsvRows(source, { delimiter: options.delimiter });
    const converted = csvToObjects(parsed.cells, { header: options.header !== false });
    objects = converted.objects;
    headers = converted.headers;
    errors = [...parsed.errors, ...converted.errors];
  } else if (detected.format === 'ndjson') {
    const parsed = parseNdjson(source);
    objects = parsed.objects;
    errors = parsed.errors;
  } else {
    const parsed = parseJsonRows(source);
    objects = parsed.objects;
    errors = parsed.errors;
    meta = parsed.meta;
    if (parsed.path === 'ndjson-fallback') warnings.push('json-fallback-ndjson');
  }
  // 超长单元格：截断并记警告（不因一条脏数据拒绝整个导入）。
  let truncatedCells = 0;
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (typeof value === 'string' && value.length > limits.maxCellLength) {
        object[key] = value.slice(0, limits.maxCellLength);
        truncatedCells += 1;
      }
    }
  }
  if (truncatedCells) warnings.push('cell-truncated:' + truncatedCells);
  let truncated = false;
  if (objects.length > limits.maxRows) {
    objects = objects.slice(0, limits.maxRows);
    truncated = true;
    warnings.push('row-limit');
  }
  const inferred = headers.length ? headers : inferHeaders(objects, limits.maxColumns);
  return {
    ok: errors.filter((error) => error.code !== 'E_CSV_COLUMN_COUNT').length === 0 && objects.length > 0,
    format: detected.format,
    by: detected.by,
    objects,
    headers: inferred,
    errors,
    warnings,
    meta,
    bytes,
    truncated,
  };
}

function byteLength(text) {
  // 只需要“大致的字节数”，避免把 50MB 字符串展开成数组；上限判断允许 4 倍误差。
  return String(text).length * 4;
}

/** 推断表头（并集，保持首次出现顺序，最多 maxColumns 列）。 */
export function inferHeaders(objects, maxColumns = IMPORT_LIMITS.maxColumns) {
  const headers = [];
  const seen = new Set();
  for (const object of Array.isArray(objects) ? objects : []) {
    if (!object || typeof object !== 'object') continue;
    for (const key of Object.keys(object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
      if (headers.length >= maxColumns) return headers;
    }
  }
  return headers;
}

/** 类型推断：一列里多数非空值的形态。 */
export function inferTypes(objects) {
  const list = Array.isArray(objects) ? objects : [];
  const headers = inferHeaders(list);
  const types = {};
  for (const header of headers) {
    let number = 0;
    let boolean = 0;
    let timestamp = 0;
    let objectsSeen = 0;
    let total = 0;
    for (const row of list) {
      const value = row ? row[header] : undefined;
      if (value === undefined || value === null || value === '') continue;
      total += 1;
      if (typeof value === 'number') number += 1;
      else if (typeof value === 'boolean') boolean += 1;
      else if (typeof value === 'object') objectsSeen += 1;
      else {
        const text = String(value).trim();
        if (/^(true|false)$/i.test(text)) boolean += 1;
        else if (/^\d{10}(\d{3})?$/.test(text) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) timestamp += 1;
        else if (/^-?\d+(\.\d+)?$/.test(text)) number += 1;
      }
    }
    if (!total) types[header] = 'string';
    else if (objectsSeen) types[header] = 'json';
    else if (boolean === total) types[header] = 'boolean';
    else if (timestamp > total / 2 && number <= timestamp) types[header] = 'timestamp';
    else if (number === total) types[header] = 'number';
    else types[header] = 'string';
  }
  return types;
}

/** 单值强制转换；转换失败返回 {ok:false, value:原值}。 */
export function coerceValue(raw, type) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  switch (type) {
    case 'number': {
      if (typeof raw === 'number') return { ok: Number.isFinite(raw), value: raw };
      const text = String(raw).trim();
      if (!text) return { ok: true, value: null };
      const number = Number(text);
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, value: raw };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const text = String(raw).trim().toLowerCase();
      if (text === 'true' || text === '1' || text === 'yes') return { ok: true, value: true };
      if (text === 'false' || text === '0' || text === 'no') return { ok: true, value: false };
      return { ok: false, value: raw };
    }
    case 'timestamp': {
      if (typeof raw === 'number') return { ok: Number.isFinite(raw), value: raw };
      const text = String(raw).trim();
      if (/^\d+$/.test(text)) return { ok: true, value: Number(text) };
      const time = Date.parse(text);
      return Number.isFinite(time) ? { ok: true, value: time } : { ok: false, value: raw };
    }
    case 'json': {
      if (typeof raw === 'object') return { ok: true, value: raw };
      try { return { ok: true, value: JSON.parse(String(raw)) }; } catch { return { ok: false, value: raw }; }
    }
    default:
      return { ok: true, value: String(raw) };
  }
}

/**
 * 字段 schema：`[{key, type, required, oneOf, pattern, maxLength, label}]`。
 * 校验结果按行给出，UI 可以定位到具体单元格。
 */
export function normalizeSchema(schema) {
  const fields = Array.isArray(schema && schema.fields) ? schema.fields : Array.isArray(schema) ? schema : [];
  return fields
    .filter((field) => field && (field.key !== undefined || field.name !== undefined))
    .map((field) => ({
      key: String(field.key !== undefined ? field.key : field.name),
      type: IMPORT_TYPES.includes(field.type) ? field.type : 'string',
      required: field.required === true,
      oneOf: Array.isArray(field.oneOf) ? field.oneOf.map(String) : null,
      pattern: field.pattern instanceof RegExp ? field.pattern : (typeof field.pattern === 'string' ? new RegExp(field.pattern) : null),
      maxLength: field.maxLength === undefined || field.maxLength === null
        ? null
        : (Number.isFinite(Number(field.maxLength)) ? Math.max(0, Number(field.maxLength)) : null),
      label: field.label ? String(field.label) : String(field.key !== undefined ? field.key : field.name),
    }));
}

/**
 * 校验行：类型转换 + 必填 + 枚举 + 正则 + 长度 + 唯一性（可选 key 字段）。
 * @returns {{ok:boolean, rows:Array<object>, valid:number, invalid:number,
 *   errors:Array<{index:number, line:number, field:string|null, code:string, message:string}>,
 *   warnings:Array<string>, duplicates:number}}
 */
export function validateImport(objects, schema, options = {}) {
  const list = Array.isArray(objects) ? objects : [];
  const fields = normalizeSchema(schema);
  const errors = [];
  const warnings = [];
  const rows = [];
  const keyField = String(options.keyField || '');
  const keys = new Map();
  let duplicates = 0;
  list.forEach((object, index) => {
    const row = {};
    let rowOk = true;
    for (const field of fields) {
      const raw = object ? object[field.key] : undefined;
      const missing = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
      if (missing) {
        if (field.required) {
          errors.push({ index, line: index + 2, field: field.key, code: 'E_REQUIRED', message: field.label + ' 必填' });
          rowOk = false;
        } else {
          row[field.key] = null;
        }
        continue;
      }
      const coerced = coerceValue(raw, field.type);
      if (!coerced.ok) {
        errors.push({ index, line: index + 2, field: field.key, code: 'E_TYPE', message: field.label + ' 应为 ' + field.type + '：' + String(raw).slice(0, 60) });
        rowOk = false;
        row[field.key] = raw;
        continue;
      }
      const value = coerced.value;
      if (field.oneOf && !field.oneOf.includes(String(value))) {
        errors.push({ index, line: index + 2, field: field.key, code: 'E_ENUM', message: field.label + ' 只能是 ' + field.oneOf.join(' / ') });
        rowOk = false;
      }
      if (field.pattern && typeof value === 'string' && !field.pattern.test(value)) {
        errors.push({ index, line: index + 2, field: field.key, code: 'E_PATTERN', message: field.label + ' 格式不匹配' });
        rowOk = false;
      }
      if (field.maxLength !== null && typeof value === 'string' && value.length > field.maxLength) {
        errors.push({ index, line: index + 2, field: field.key, code: 'E_TOO_LONG', message: field.label + ' 超过 ' + field.maxLength + ' 字' });
        rowOk = false;
      }
      row[field.key] = value;
    }
    // 保留 schema 之外的原始字段（导入时用户往往希望“原样保留”），但标记未知字段。
    for (const key of Object.keys(object && typeof object === 'object' ? object : {})) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) row[key] = object[key];
    }
    if (keyField && object) {
      const key = String(object[keyField]);
      if (keys.has(key)) {
        duplicates += 1;
        warnings.push('duplicate-key:' + key);
      } else keys.set(key, index);
    }
    rows.push(row);
    if (!rowOk && options.dropInvalid === true) rows.pop();
  });
  const fatal = errors.filter((error) => error.code !== 'E_UNKNOWN_FIELD');
  // 有错的行在 rows 里保留（调用方可选择丢弃）；统计“有问题的行数”按不重复行号算。
  const invalidIndices = new Set(errors.map((error) => error.index));
  return {
    ok: fatal.length === 0,
    rows,
    valid: Math.max(0, rows.length - invalidIndices.size),
    invalid: invalidIndices.size,
    errors,
    warnings,
    duplicates,
  };
}

/** 去重：保留第一次出现的行。 */
export function dedupeRows(rows, { keyOf } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const pick = typeof keyOf === 'function'
    ? keyOf
    : (row) => JSON.stringify(row);
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const row of list) {
    let key;
    try { key = String(pick(row)); } catch { key = 'row-' + unique.length; }
    if (seen.has(key)) duplicates.push({ key, row });
    else { seen.add(key); unique.push(row); }
  }
  return { unique, duplicates, total: list.length };
}

/**
 * 合并导入数据与既有数据。
 * @param {Array<object>} existing
 * @param {Array<object>} imported
 * @param {{strategy?:'append'|'replace'|'merge', keyOf?:(row:any)=>string}} options
 * @returns {{rows:Array<object>, stats:{existing:number, imported:number, appended:number,
 *   replaced:number, unchanged:number, result:number}}}
 */
export function mergeImported(existing, imported, options = {}) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  const incoming = Array.isArray(imported) ? imported.slice() : [];
  const strategy = options.strategy === 'replace' || options.strategy === 'merge' ? options.strategy : 'append';
  if (strategy === 'replace') {
    return {
      rows: incoming,
      stats: { existing: base.length, imported: incoming.length, appended: incoming.length, replaced: base.length, unchanged: 0, result: incoming.length },
    };
  }
  if (strategy === 'append') {
    return {
      rows: base.concat(incoming),
      stats: { existing: base.length, imported: incoming.length, appended: incoming.length, replaced: 0, unchanged: 0, result: base.length + incoming.length },
    };
  }
  const keyOf = typeof options.keyOf === 'function' ? options.keyOf : (row) => JSON.stringify(row);
  const index = new Map();
  const rows = base.slice();
  rows.forEach((row, position) => {
    let key;
    try { key = String(keyOf(row)); } catch { key = 'existing-' + position; }
    if (!index.has(key)) index.set(key, position);
  });
  let appended = 0;
  let replaced = 0;
  let unchanged = 0;
  for (const row of incoming) {
    let key;
    try { key = String(keyOf(row)); } catch { key = 'imported-' + appended; }
    if (index.has(key)) {
      const position = index.get(key);
      const same = JSON.stringify(rows[position]) === JSON.stringify(row);
      if (same) unchanged += 1;
      else { rows[position] = row; replaced += 1; }
    } else {
      index.set(key, rows.length);
      rows.push(row);
      appended += 1;
    }
  }
  return {
    rows,
    stats: { existing: base.length, imported: incoming.length, appended, replaced, unchanged, result: rows.length },
  };
}

/** 预览：列 + 前 N 行 + 是否截断。 */
export function buildImportPreview(parsed, { limit = IMPORT_LIMITS.previewRows } = {}) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const objects = Array.isArray(source.objects) ? source.objects : [];
  const max = Math.max(1, Math.floor(Number(limit) || IMPORT_LIMITS.previewRows));
  const headers = Array.isArray(source.headers) && source.headers.length ? source.headers : inferHeaders(objects);
  const types = inferTypes(objects);
  return {
    headers,
    types,
    rows: objects.slice(0, max),
    total: objects.length,
    truncated: objects.length > max,
    format: source.format || '',
    errors: Array.isArray(source.errors) ? source.errors.slice(0, 50) : [],
    warnings: Array.isArray(source.warnings) ? source.warnings.slice() : [],
    bytes: Number(source.bytes) || 0,
  };
}

/** 导入载荷版本：页面把数据存进 storage 时带上版本，升级时按迁移表改写。 */
export const IMPORT_SCHEMA_VERSION = 2;

/**
 * 版本迁移表：v1 是早期导出（顶层数组），v2 是 `{meta, rows}` 信封。
 * 每条迁移必须是纯函数 `(payload) => payload`。
 */
export const IMPORT_MIGRATIONS = Object.freeze({
  1: (payload) => ({ meta: { schema: 1 }, rows: Array.isArray(payload) ? payload : (payload && payload.rows) || [] }),
  2: (payload) => payload,
});

/** 把任意历史载荷迁移到当前版本；未知版本返回原对象 + 警告。 */
export function migrateImportPayload(payload) {
  let current = payload;
  let version = 1;
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const meta = current.meta && typeof current.meta === 'object' ? current.meta : {};
    version = Number.isFinite(Number(meta.schema)) ? Number(meta.schema) : (Array.isArray(current.rows) ? 2 : 1);
  }
  const applied = [];
  const warnings = [];
  let guard = 0;
  while (version < IMPORT_SCHEMA_VERSION && guard < 10) {
    const migrate = IMPORT_MIGRATIONS[version];
    if (typeof migrate !== 'function') {
      warnings.push('missing-migration:' + version);
      break;
    }
    current = migrate(current);
    applied.push(version);
    version += 1;
    guard += 1;
  }
  if (version > IMPORT_SCHEMA_VERSION) warnings.push('future-version:' + version);
  return { payload: current, version, applied, warnings, ok: version <= IMPORT_SCHEMA_VERSION };
}

/** 导入时敏感值提示：导入文件里如果有 token，提醒用户“导入会落盘”。 */
export function scanSecrets(objects) {
  const list = Array.isArray(objects) ? objects : [];
  let hits = 0;
  for (const object of list) {
    if (!object || typeof object !== 'object') continue;
    for (const value of Object.values(object)) {
      if (typeof value === 'string' && looksSecret(value)) hits += 1;
    }
  }
  return { hits, warning: hits > 0 };
}

/** 文件扩展名（下载/导入共用）。 */
export function extensionOf(fileName) {
  const name = String(fileName === undefined || fileName === null ? '' : fileName).trim();
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/** 人类可读的格式名（页面下拉框用，不含翻译）。 */
export function formatLabelText(format) {
  const value = String(format || '').toLowerCase();
  if (value === 'csv') return 'CSV';
  if (value === 'ndjson') return 'NDJSON';
  if (value === 'json') return 'JSON';
  return 'JSON';
}
