// src/lib/debug-redact.js —— 调试证据的统一脱敏层（持久化前必须调用）。
//
// 单点脱敏：journal 事件、HAR 请求、trace 参数、截图元数据、历史记录在落盘前
// 全部走这里，而不是各调用点各自 redact（漏一个字段就把 secret 写进 storage）。
// 规则分四类：
//   1. 敏感键名（password/token/cookie/session/api_key/… 含中文别名）→ 整值替换；
//   2. 请求头 / 响应头 / Cookie 数组 → 按名字判定，cookie 值一律不落盘；
//   3. URL 类字段 → 交给 redactUrl（只替换敏感 query 值，保留可分析结构）；
//   4. 正文 / 文本类字段 → 交给 redactBody（JSON 递归 + 表单文本正则）。
//
// 脱敏后仍会做深度/键数/数组/字符串长度截断，避免一次异常事件把 storage 写爆
// （截断本身带显式标记，coverage/gaps 能据此报告 dropped 原因）。
import { redactBody, redactUrl } from '../redact.js';

export const REDACTED = '[redacted]';
export const DEBUG_REDACT_VERSION = 1;

/** 敏感键名：值整体替换。覆盖常见英文/下划线/连字符写法 + 中文别名。 */
export const SECRET_KEY_RE = /(?:pass(?:word|wd|code)?|pwd|secret|token|authori[sz]ation|cookie|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|session[-_]?id|sessionid|otp|one[-_]?time[-_]?code|csrf|xsrf|credential|bearer|密码|口令|令牌|密钥|凭证)/i;

const URL_KEYS = new Set(['url', 'pageurl', 'documenturl', 'initiatorurl', 'frameurl', 'start_url', 'requesturl', 'location']);
const HEADER_KEYS = new Set(['headers', 'requestheaders', 'responseheaders', 'extraheaders']);
const COOKIE_KEYS = new Set(['cookies', 'setcookies', 'cookie']);
const BODY_KEYS = new Set(['body', 'bodytext', 'postdata', 'responsetext', 'requestbody', 'responsebody', 'payload', 'content', 'text', 'base64']);
const TEXT_KEYS = new Set(['message', 'error', 'reason', 'detail', 'label', 'title', 'url', 'href', 'description']);

export const DEFAULT_REDACT_OPTIONS = Object.freeze({
  maxDepth: 8,
  maxKeys: 80,
  maxArray: 200,
  maxString: 8192,
  redactText: true,
});

function normalizeOptions(options = {}) {
  const merged = { ...DEFAULT_REDACT_OPTIONS };
  for (const key of Object.keys(DEFAULT_REDACT_OPTIONS)) {
    const value = options[key];
    if (key === 'redactText') {
      if (typeof value === 'boolean') merged[key] = value;
      continue;
    }
    if (Number.isFinite(Number(value)) && Number(value) > 0) merged[key] = Math.floor(Number(value));
  }
  return merged;
}

/** 敏感键名判定（大小写不敏感，含连字符/下划线/中文）。 */
export function isSecretKey(name) {
  return SECRET_KEY_RE.test(String(name == null ? '' : name));
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clip(value, max) {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  return text.slice(0, max) + '…[truncated ' + (text.length - max) + ' chars]';
}

/** 文本脱敏：JSON 走结构递归，普通文本走凭据正则（复用 redactBody）。 */
export function redactText(value, maxString = DEFAULT_REDACT_OPTIONS.maxString) {
  const text = clip(String(value == null ? '' : value), maxString);
  if (!text) return text;
  try {
    // 先处理 "Bearer <token>"（否则凭据正则只吃掉 scheme 词，token 会漏在文本里），
    // 再交给 redactBody 处理 key=value / JSON 形态。
    const schemeRedacted = text.replace(
      /\b(Bearer|Basic|Digest|Bot)\s+[A-Za-z0-9._~+/=-]{4,}/gi,
      (match, scheme) => scheme + ' ' + REDACTED,
    );
    return redactBody(schemeRedacted);
  } catch {
    return REDACTED;
  }
}

function hasTextSignal(value) {
  return /[=:]/.test(value) || /"(?:password|token|secret|authorization|cookie|session)"/i.test(value);
}

/**
 * 请求头/响应头脱敏。兼容两种形态：
 *   - `{ 'Authorization': 'Bearer x' }`
 *   - `[{ name: 'Authorization', value: 'Bearer x' }]`
 * 返回同形态的副本，不修改入参。
 */
export function redactHeadersDeep(headers, options = {}) {
  const settings = normalizeOptions(options);
  if (!headers || typeof headers !== 'object') return headers;
  if (Array.isArray(headers)) {
    return headers.slice(0, settings.maxArray).map((header) => {
      if (!header || typeof header !== 'object') return header;
      const name = header.name == null ? header.key : header.name;
      const secret = isSecretKey(name);
      const out = { ...header };
      if (secret && Object.prototype.hasOwnProperty.call(out, 'value')) out.value = REDACTED;
      else if (secret && Object.prototype.hasOwnProperty.call(out, 'v')) out.v = REDACTED;
      return out;
    });
  }
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(headers)) {
    if (keys >= settings.maxKeys) {
      out.__truncated = keys;
      break;
    }
    keys += 1;
    out[key] = isSecretKey(key) ? REDACTED : (typeof value === 'string' ? clip(value, settings.maxString) : value);
  }
  return out;
}

/**
 * Cookie 脱敏：数组/对象两种形态，cookie 值一律 [redacted]，只保留名字与域/路径等元数据。
 */
export function redactCookiesDeep(cookies, options = {}) {
  const settings = normalizeOptions(options);
  if (!cookies || typeof cookies !== 'object') return cookies;
  if (Array.isArray(cookies)) {
    return cookies.slice(0, settings.maxArray).map((cookie) => {
      if (!cookie || typeof cookie !== 'object') return REDACTED;
      const out = { ...cookie };
      for (const key of Object.keys(out)) {
        if (/^(value|v|val|data|payload)$/i.test(key)) out[key] = REDACTED;
      }
      if (!Object.prototype.hasOwnProperty.call(out, 'value')) out.value = REDACTED;
      return out;
    });
  }
  const out = {};
  for (const [key, value] of Object.entries(cookies)) {
    out[key] = isSecretKey(key) || typeof value === 'string' ? REDACTED : value;
  }
  return out;
}

function walk(value, settings, depth, key, secretParent, seen) {
  if (depth > settings.maxDepth) return '[truncated depth]';
  if (value == null) return value;
  const type = typeof value;
  const name = String(key || '').toLowerCase();
  const compact = name.replace(/[^a-z0-9_]/g, '');
  if (type === 'string') {
    if (secretParent) return REDACTED;
    if (URL_KEYS.has(compact)) return redactUrl(value);
    if (HEADER_KEYS.has(compact) || COOKIE_KEYS.has(compact)) return REDACTED;
    if (BODY_KEYS.has(compact)) return clip(redactText(value, settings.maxString), settings.maxString);
    if (settings.redactText && (TEXT_KEYS.has(compact) || hasTextSignal(value))) {
      return clip(redactText(value, settings.maxString), settings.maxString);
    }
    return clip(value, settings.maxString);
  }
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    // 容器语义优先：headers/cookies 既可能是对象也可能是 [{name,value}] 数组。
    if (HEADER_KEYS.has(compact)) return redactHeadersDeep(value, settings);
    if (COOKIE_KEYS.has(compact)) return redactCookiesDeep(value, settings);
    if (Array.isArray(value)) {
      const out = [];
      const limit = Math.min(value.length, settings.maxArray);
      for (let index = 0; index < limit; index += 1) {
        // 数组元素不继承父键名（否则 [{name,value}] 会被当成 headers map 误判）。
        const item = walk(value[index], settings, depth + 1, '', secretParent, seen);
        if (item !== undefined) out.push(item);
      }
      if (value.length > limit) out.push('[truncated ' + (value.length - limit) + ' items]');
      return out;
    }
    if (isPlainObject(value)) {
      if (secretParent) return REDACTED;
      const out = {};
      let keys = 0;
      for (const [childKey, childValue] of Object.entries(value)) {
        if (keys >= settings.maxKeys) {
          out.__truncated = keys;
          break;
        }
        keys += 1;
        const childCompact = String(childKey).toLowerCase().replace(/[^a-z0-9_]/g, '');
        // headers/cookies 容器交给容器规则处理，不能整块替换（否则丢证据结构）。
        const container = HEADER_KEYS.has(childCompact) || COOKIE_KEYS.has(childCompact);
        if (!container && isSecretKey(childKey)) {
          out[childKey] = REDACTED;
          continue;
        }
        const child = walk(childValue, settings, depth + 1, childKey, false, seen);
        if (child !== undefined) out[childKey] = child;
      }
      return out;
    }
    // 其他对象（Map/Set/typed array 等）：转字符串并做文本脱敏。
    return clip(redactText(String(value), settings.maxString), settings.maxString);
  } finally {
    seen.delete(value);
  }
}

/**
 * 深层脱敏：返回新对象，不修改入参。
 * @param {unknown} value
 * @param {Partial<typeof DEFAULT_REDACT_OPTIONS>} [options]
 */
export function redactDeep(value, options = {}) {
  const settings = normalizeOptions(options);
  return walk(value, settings, 0, '', false, new WeakSet());
}

/** journal 事件脱敏：严格模式，文本一律过凭据正则。 */
export function redactJournalEvent(event, options = {}) {
  return redactDeep(event, { ...options, redactText: true });
}

/** 持久化前脱敏：预算放宽（历史记录里有 200 条请求 + 200 条 console），但仍强制脱敏。 */
export function redactForPersistence(value, options = {}) {
  return redactDeep(value, {
    maxDepth: 10,
    maxKeys: 400,
    maxArray: 1000,
    maxString: 16384,
    redactText: true,
    ...options,
  });
}

/** 创建绑定参数的脱敏函数（storage store 注入用）。 */
export function createRedactor(options = {}) {
  const settings = normalizeOptions(options);
  return (value) => redactDeep(value, settings);
}

/**
 * 秘密泄漏扫描：返回 `{ leaked, paths }`，供自检/测试断言持久化文本不含明文 secret。
 * `secrets` 是需要确认不出现的明文值列表；空字符串会被忽略。
 */
export function scanForPlaintextSecrets(text, secrets = []) {
  const haystack = String(text == null ? '' : text);
  const leaked = [];
  const needles = (Array.isArray(secrets) ? secrets : [])
    .map((item) => String(item == null ? '' : item))
    .filter((item) => item.length > 0);
  for (const needle of needles) {
    if (haystack.includes(needle)) leaked.push(needle);
  }
  return { clean: leaked.length === 0, leaked };
}
