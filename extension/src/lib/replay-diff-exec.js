// extension/src/lib/replay-diff-exec.js —— 回放差异校验执行层（第二轮：消费真实 replay 结果）。
//
// 第一轮 replay-diff 提供纯比较原语（expect 校验 / 文本差异 / 数字容差 / 快照差异），
// 但它不关心“真实 network.replay 返回什么”。本模块把两侧接起来：
//
//   1) 观测归一：network.replay 的真实结果（{status,statusText,headers,body,durationMs,url}）
//      或既有错误 → 有界、脱敏、可指纹的 observation；
//   2) expect 判定：把网络期待（status/bodyJson/bodyIncludes/headers/bodyBytes/latency/
//      redirected/finalUrl…）收敛到第一轮 validateStepOutcome / checkExpect，再补网络专属项；
//   3) 确定性 diff：同一请求两次真实回放的观测差异（状态/正文/JSON/headers），
//      固定排除易变 header 与显式 volatile JSON 路径，耗时永不参与判定；
//   4) 消费入口：consumeReplayObservation(plan, {result,error}) → 可挂到 RPC 输出的字段。
//
// 不变量：
//   - 纯函数：同输入同输出；不读时钟（耗时只作为观测值，不进语义指纹）；
//   - 有界：正文/JSON/header/差异全部有上限，避免把 200KB 正文塞进 RPC；
//   - 只加字段：不改既有命令结果；失败判定用显式差异码，未知 expect 键标 unsupported。
//
// 运行时消费者：extension/src/replay.js（replayNetworkCommand / replayDebugCommand 的
// replay.observation 与 replay.outcome 字段；replayObservationCommand）。

import { stableHash } from '../record-steps.js';
import {
  DIFF_CODES,
  compareNumber,
  compareText,
  deepDiff,
  isAcceptableDifference,
  maxSeverity,
  normalizeComparableText,
  statusMatches,
  summarizeDifferences,
  toleranceProfile,
  urlIncludes,
  validateStepOutcome,
} from './replay-diff.js';
import { explainFailure } from './replay-explain.js';
import { stableStringify } from './replay-plan.js';

/** 观测层版本。 */
export const REPLAY_OBSERVATION_VERSION = 2;

/** 观测上限。 */
export const OBSERVATION_LIMITS = Object.freeze({
  maxBodyChars: 65536,
  maxJsonDepth: 6,
  maxJsonItems: 128,
  maxHeaderCount: 64,
  maxHeaderChars: 2048,
  maxDifferences: 64,
  maxChecks: 64,
  maxEvidence: 24,
  maxText: 300,
});

/** 观测/差异结果码（网络专属；通用差异沿用 replay-diff 的 DIFF_CODES）。 */
export const OBSERVATION_CODES = Object.freeze({
  OK: 'OBSERVATION_OK',
  FAILED: 'OBSERVATION_FAILED',
  INVALID_RESULT: 'OBSERVATION_INVALID_RESULT',
  STATUS_CLASS_MISMATCH: 'OBSERVATION_STATUS_CLASS_MISMATCH',
  BODY_INCLUDES_MISMATCH: 'OBSERVATION_BODY_INCLUDES_MISMATCH',
  BODY_JSON_MISMATCH: 'OBSERVATION_BODY_JSON_MISMATCH',
  HEADER_MISMATCH: 'OBSERVATION_HEADER_MISMATCH',
  HEADER_VOLATILE: 'OBSERVATION_HEADER_VOLATILE',
  BODY_BYTES_MISMATCH: 'OBSERVATION_BODY_BYTES_MISMATCH',
  LATENCY_EXCEEDED: 'OBSERVATION_LATENCY_EXCEEDED',
  LATENCY_UNMEASURED: 'OBSERVATION_LATENCY_UNMEASURED',
  REDIRECT_MISMATCH: 'OBSERVATION_REDIRECT_MISMATCH',
  UNCERTAIN_KEY: 'OBSERVATION_UNSUPPORTED_EXPECT',
  DIVERGED: 'OBSERVATION_DIVERGED',
  DETERMINISTIC: 'OBSERVATION_DETERMINISTIC',
  TRUNCATED: 'OBSERVATION_TRUNCATED',
});

/** 已知易变响应头（每次请求都会变；默认不参与确定性比较）。 */
export const VOLATILE_HEADERS = Object.freeze([
  'date',
  'age',
  'expires',
  'etag',
  'last-modified',
  'set-cookie',
  'server-timing',
  'request-id',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'traceparent',
  'x-amzn-requestid',
  'x-amz-cf-id',
  'cf-ray',
  'x-runtime',
  'x-served-by',
  'via',
]);

const VOLATILE_HEADER_SET = new Set(VOLATILE_HEADERS);
const VOLATILE_HEADER_PREFIX = /^(?:x-amz-|cf-|x-goog-)/i;

/** 第一轮 checkExpect 已经支持的 expect 键（网络期待里允许复用）。 */
const STANDARD_EXPECT_KEYS = new Set([
  'url', 'urlIncludes', 'urlStartsWith', 'text', 'textIncludes', 'title', 'titleIncludes',
  'status', 'count', 'rowCount', 'exists', 'visible', 'enabled', 'disabled', 'checked',
  'selected', 'classIncludes', 'attribute', 'attr', 'htmlIncludes', 'changed', 'values',
  'value', 'selectorValue',
]);

/** 网络专属 expect 键（本模块实现）。 */
const NETWORK_EXPECT_KEYS = new Set([
  'statusClass', 'bodyIncludes', 'bodyText', 'bodyJson', 'headers', 'contentType',
  'bodyBytes', 'maxLatencyMs', 'minLatencyMs', 'redirected', 'finalUrl', 'finalUrlIncludes',
]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortText(value, max = OBSERVATION_LIMITS.maxText) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function utf8Bytes(text) {
  const value = String(text === null || text === undefined ? '' : text);
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

function urlFacts(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { url: '', origin: '', key: '', valid: false };
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { url: text, origin: '', key: text, valid: false };
    }
    return {
      url: text,
      origin: parsed.origin,
      key: parsed.origin + parsed.pathname + parsed.search,
      valid: true,
    };
  } catch {
    return { url: text, origin: '', key: text, valid: false };
  }
}

// ---------------------------------------------------------------------------
// 观测归一
// ---------------------------------------------------------------------------

/** 归一化响应头：小写键、字符串值、有界、标出易变头。 */
export function normalizeHeaderFacts(headers) {
  const source = isObject(headers) ? headers : {};
  const out = {};
  const volatile = [];
  const dropped = [];
  let count = 0;
  // 原始键名 → 小写名，按小写名稳定排序（同小写名只取第一处，确定性）。
  const pairs = Object.keys(source)
    .map((rawName) => ({ rawName, name: String(rawName).trim().toLowerCase(), value: source[rawName] }))
    .filter((pair) => pair.name)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const seen = new Set();
  for (const pair of pairs) {
    const name = pair.name;
    if (count >= OBSERVATION_LIMITS.maxHeaderCount) break;
    if (seen.has(name)) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || name.length > 128) {
      dropped.push(name.slice(0, 80));
      continue;
    }
    if (VOLATILE_HEADER_SET.has(name) || VOLATILE_HEADER_PREFIX.test(name)) {
      volatile.push(name);
      continue;
    }
    const rawValue = pair.value;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (value.length > OBSERVATION_LIMITS.maxHeaderChars || /[\r\n\0]/.test(value)) {
      dropped.push(name);
      continue;
    }
    Object.defineProperty(out, name, { value, enumerable: true, configurable: true, writable: true });
    seen.add(name);
    count += 1;
  }
  return {
    headers: out,
    volatileHeaders: volatile.slice(0, OBSERVATION_LIMITS.maxEvidence),
    droppedHeaders: dropped.slice(0, OBSERVATION_LIMITS.maxEvidence),
    count,
    digest: stableHash(Object.keys(out).map((name) => name + '=' + out[name]).join('&')),
  };
}

/** 有界 JSON 归一（深度/条目/字符串长度都截断；不抛异常）。 */
export function sanitizeJson(value, depth = 0, limits = OBSERVATION_LIMITS) {
  if (value === null || value === undefined) return null;
  if (depth > (limits.maxJsonDepth || OBSERVATION_LIMITS.maxJsonDepth)) return '[depth]';
  const type = typeof value;
  if (type === 'string') return value.length > 400 ? value.slice(0, 400) : value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxJsonItems || OBSERVATION_LIMITS.maxJsonItems).map((item) => sanitizeJson(item, depth + 1, limits));
  }
  if (type === 'object') {
    const out = {};
    const keys = Object.keys(value).slice(0, limits.maxJsonItems || OBSERVATION_LIMITS.maxJsonItems);
    for (const key of keys) out[shortText(key, 120)] = sanitizeJson(value[key], depth + 1, limits);
    return out;
  }
  return null;
}

/** 判定 content-type 是否 JSON。 */
export function isJsonContentType(contentType) {
  const text = String(contentType || '').toLowerCase();
  return text.includes('application/json') || text.includes('+json') || text.includes('text/json');
}

/**
 * 解析正文 JSON（有界；失败返回 null 而不是抛异常）。
 * @returns {{json:object|Array|null, parsed:boolean, kind:string}}
 */
export function parseBodyJson(body, contentType) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { json: null, parsed: false, kind: 'empty' };
  if (text.length > OBSERVATION_LIMITS.maxBodyChars) {
    return { json: null, parsed: false, kind: 'json-too-large' };
  }
  if (!isJsonContentType(contentType) && !/^[\[{]/.test(text)) {
    return { json: null, parsed: false, kind: 'not-json' };
  }
  try {
    const parsed = JSON.parse(text);
    return { json: sanitizeJson(parsed), parsed: true, kind: Array.isArray(parsed) ? 'json-array' : 'json-object' };
  } catch {
    return { json: null, parsed: false, kind: 'json-invalid' };
  }
}

/** 从既有命令结果里解包（兼容 {ok:true,result:{...}} 与直接结果）。 */
export function unwrapReplayResult(result) {
  if (!isObject(result)) return null;
  const inner = isObject(result.result) && result.status === undefined && result.statusText === undefined
    ? result.result
    : null;
  if (inner) return inner;
  return result;
}

/**
 * 归一化一次真实 network.replay 的结果（或失败）。
 * @param {unknown} result 既有命令返回 / 抛出的错误对象
 * @param {{request?:object, plan?:object}} [context] 请求事实（method/url），用于判重定向与跨源
 * @returns {object}
 */
export function normalizeReplayObservation(result, context = {}) {
  const source = isObject(result) ? result : null;
  const request = isObject(context.request)
    ? context.request
    : (isObject(context.plan && context.plan.network) ? context.plan.network : {});
  if (!source) {
    return {
      version: REPLAY_OBSERVATION_VERSION,
      ok: false,
      error: { code: 'OBSERVATION_INVALID_RESULT', message: '回放结果不是对象', category: 'internal' },
      request: { method: String(request.method || ''), urlKey: urlFacts(request.url).key },
      digest: stableHash([REPLAY_OBSERVATION_VERSION, 'invalid', String(request.method || '')].join('|')),
      hasWallClock: false,
    };
  }
  if (source.error || source.ok === false || source instanceof Error || (typeof source.stack === 'string' && typeof source.message === 'string')) {
    const error = isObject(source.error)
      ? source.error
      : { message: String(source.error || source.message || '回放失败'), code: source.code, name: source.name };
    const message = String(error.message || source.error || '回放失败');
    return {
      version: REPLAY_OBSERVATION_VERSION,
      ok: false,
      httpStatus: finiteNumber(source.status),
      error: {
        code: shortText(error.code || '', 80),
        message: message.length > OBSERVATION_LIMITS.maxText ? message.slice(0, OBSERVATION_LIMITS.maxText) : message,
        name: shortText(error.name, 80),
      },
      request: { method: String(request.method || ''), urlKey: urlFacts(request.url).key },
      digest: stableHash([REPLAY_OBSERVATION_VERSION, 'error', String(error.code || ''), shortText(message, 120)].join('|')),
      hasWallClock: false,
    };
  }
  const inner = unwrapReplayResult(source);
  const status = finiteNumber(inner.status);
  const statusClass = status === null ? null : Math.floor(status / 100) * 100;
  const headerFacts = normalizeHeaderFacts(inner.headers);
  const contentType = headerFacts.headers['content-type'] || '';
  const rawBody = typeof inner.body === 'string' ? inner.body : (inner.body === undefined || inner.body === null ? '' : String(inner.body));
  const truncated = rawBody.length > OBSERVATION_LIMITS.maxBodyChars;
  const body = truncated ? rawBody.slice(0, OBSERVATION_LIMITS.maxBodyChars) : rawBody;
  const jsonInfo = parseBodyJson(body, contentType);
  const finalUrl = urlFacts(inner.url);
  const requestUrl = urlFacts(request.url);
  const redirected = Boolean(requestUrl.key && finalUrl.key && requestUrl.key !== finalUrl.key);
  const bodyDigest = stableHash(body);
  const observation = {
    version: REPLAY_OBSERVATION_VERSION,
    ok: true,
    status,
    statusText: shortText(inner.statusText, 80),
    statusClass,
    url: finalUrl.url,
    urlKey: finalUrl.key,
    origin: finalUrl.origin,
    finalUrl: finalUrl.url,
    finalUrlKey: finalUrl.key,
    requestUrlKey: requestUrl.key,
    requestMethod: String(request.method || '').toUpperCase(),
    redirected,
    crossOrigin: Boolean(requestUrl.origin && finalUrl.origin && requestUrl.origin !== finalUrl.origin),
    headers: headerFacts.headers,
    headerCount: headerFacts.count,
    volatileHeaders: headerFacts.volatileHeaders,
    droppedHeaders: headerFacts.droppedHeaders,
    contentType: shortText(contentType, 200),
    body,
    bodyBytes: utf8Bytes(body),
    bodyTruncated: truncated,
    bodyKind: jsonInfo.parsed ? jsonInfo.kind : (body ? (String(contentType).includes('html') ? 'html' : 'text') : 'empty'),
    json: jsonInfo.parsed ? jsonInfo.json : null,
    jsonParsed: jsonInfo.parsed,
    durationMs: finiteNumber(inner.durationMs),
    hasWallClock: true, // 结果里可能带 durationMs，但它不进语义指纹
  };
  observation.semantic = {
    version: REPLAY_OBSERVATION_VERSION,
    status: observation.status,
    statusClass: observation.statusClass,
    urlKey: observation.urlKey,
    redirected: observation.redirected,
    bodyKind: observation.bodyKind,
    bodyBytes: observation.bodyBytes,
    bodyDigest,
    jsonDigest: jsonInfo.parsed ? stableHash(stableStringify(jsonInfo.json)) : '',
    headersDigest: headerFacts.digest,
    headerCount: headerFacts.count,
  };
  observation.digest = stableHash(stableStringify(observation.semantic));
  observation.bodyDigest = bodyDigest;
  return observation;
}

/** 观测 → 第一轮 checkExpect 需要的“可比较事实”（正文只在内存里比较）。 */
export function observationFacts(observation) {
  if (!isObject(observation) || observation.ok !== true) {
    return { ok: false, status: null, url: '', finalUrl: '', headers: {}, text: '', changed: false };
  }
  return {
    ok: true,
    status: observation.status,
    url: observation.finalUrl || observation.url,
    finalUrl: observation.finalUrl || observation.url,
    headers: observation.headers || {},
    text: observation.body || '',
    body: observation.body || '',
    count: observation.jsonParsed && Array.isArray(observation.json) ? observation.json.length : undefined,
    changed: observation.redirected === true,
  };
}

/** 观测摘要（RPC 字段：有界、脱敏）。 */
export function summarizeObservation(observation) {
  if (!isObject(observation)) return null;
  if (observation.ok !== true) {
    return {
      version: REPLAY_OBSERVATION_VERSION,
      ok: false,
      error: {
        code: String((observation.error && observation.error.code) || ''),
        message: shortText(observation.error && observation.error.message, 200),
      },
      httpStatus: observation.httpStatus === null || observation.httpStatus === undefined ? null : observation.httpStatus,
      digest: String(observation.digest || ''),
    };
  }
  return {
    version: REPLAY_OBSERVATION_VERSION,
    ok: true,
    status: observation.status,
    statusClass: observation.statusClass,
    urlKey: shortText(observation.urlKey, 300),
    redirected: observation.redirected === true,
    crossOrigin: observation.crossOrigin === true,
    bodyKind: String(observation.bodyKind || ''),
    bodyBytes: nonNegativeInt(observation.bodyBytes),
    bodyTruncated: observation.bodyTruncated === true,
    headerCount: nonNegativeInt(observation.headerCount),
    volatileHeaders: Array.isArray(observation.volatileHeaders) ? observation.volatileHeaders.slice(0, 8) : [],
    durationMs: observation.durationMs === null || observation.durationMs === undefined ? null : nonNegativeInt(observation.durationMs),
    jsonParsed: observation.jsonParsed === true,
    digest: String(observation.digest || ''),
    bodyDigest: String(observation.bodyDigest || ''),
  };
}

/** 观测语义指纹（有则用缓存，无则现场算）。 */
export function observationDigest(observation) {
  if (!isObject(observation)) return '';
  if (observation.digest) return String(observation.digest);
  return stableHash(stableStringify({ status: observation.status, urlKey: observation.urlKey, body: observation.body }));
}

// ---------------------------------------------------------------------------
// expect 归一 / JSON 子集比较
// ---------------------------------------------------------------------------

/**
 * 归一化网络 expect：标准键交给第一轮 checkExpect，网络专属键由本模块校验，
 * 未知键显式 unsupported（不静默通过）。
 */
export function normalizeReplayExpectation(expect) {
  const source = isObject(expect) ? expect : {};
  const standard = {};
  const network = {};
  const unsupported = [];
  for (const key of Object.keys(source)) {
    if (STANDARD_EXPECT_KEYS.has(key)) {
      standard[key] = source[key];
      continue;
    }
    if (NETWORK_EXPECT_KEYS.has(key)) {
      network[key] = source[key];
      continue;
    }
    unsupported.push(key);
  }
  return {
    version: REPLAY_OBSERVATION_VERSION,
    standard,
    network,
    unsupported,
    keys: Object.keys(source).length,
    empty: Object.keys(source).length === 0,
  };
}

/**
 * JSON 子集比较：expected 里出现的键才比较（数组按长度 + 逐项，标量按容差）。
 * 返回 {differences, compared, volatileSkipped}。
 */
export function jsonSubsetDiff(expected, actual, options = {}) {
  const tolerance = toleranceProfile(options.tolerance || { profile: 'normalized' });
  const volatilePaths = new Set(Array.isArray(options.volatileJsonPaths) ? options.volatileJsonPaths.map(String) : []);
  const differences = [];
  let compared = 0;
  let volatileSkipped = 0;
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
  walk(expected, actual, '', 0);
  return { differences: differences.slice(0, OBSERVATION_LIMITS.maxDifferences), compared, volatileSkipped };

  function pathKey(path) {
    return path.replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
  }

  function walk(left, right, path, depth) {
    if (differences.length >= OBSERVATION_LIMITS.maxDifferences) return;
    if (volatilePaths.has(pathKey(path))) {
      volatileSkipped += 1;
      return;
    }
    if (depth > maxDepth) {
      differences.push({ path, kind: 'depth-limit', severity: 'warning' });
      return;
    }
    if (left === null || typeof left !== 'object') {
      if (typeof right === 'object' && right !== null) {
        differences.push({ path, kind: 'type', severity: 'fail', expected: typeof left, actual: Array.isArray(right) ? 'array' : 'object' });
        return;
      }
      compared += 1;
      if (typeof left === 'number') {
        const comparison = compareNumber(left, right, tolerance);
        // 容差内的数值差异视为一致（不作为差异项返回）。
        if (!comparison.equal) differences.push({ path, kind: 'value', severity: 'fail', expected: left, actual: right });
        return;
      }
      const comparison = compareText(left, right, tolerance);
      if (!comparison.equal) {
        differences.push({
          path,
          kind: 'value',
          severity: 'fail',
          expected: shortText(left, 120),
          actual: shortText(right, 120),
          similarity: Math.round(comparison.similarity * 1000) / 1000,
        });
      }
      return;
    }
    if (Array.isArray(left)) {
      if (!Array.isArray(right)) {
        differences.push({ path, kind: 'type', severity: 'fail', expected: 'array', actual: typeof right });
        return;
      }
      if (right.length < left.length && options.requireAllItems !== false) {
        differences.push({ path, kind: 'missing', severity: 'fail', expected: left.length, actual: right.length });
      }
      const length = Math.min(left.length, right.length);
      for (let index = 0; index < length; index += 1) walk(left[index], right[index], path + '[' + index + ']', depth + 1);
      return;
    }
    if (!right || typeof right !== 'object' || Array.isArray(right)) {
      differences.push({ path, kind: 'type', severity: 'fail', expected: 'object', actual: Array.isArray(right) ? 'array' : typeof right });
      return;
    }
    for (const key of Object.keys(left)) {
      const childPath = path ? path + '.' + key : key;
      if (volatilePaths.has(childPath)) {
        volatileSkipped += 1;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        differences.push({ path: childPath, kind: 'missing', severity: 'fail', expected: shortText(left[key], 120) });
        continue;
      }
      walk(left[key], right[key], childPath, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// expect 判定（消费真实观测）
// ---------------------------------------------------------------------------

function pushCheck(checks, key, ok, code, expected, actual, options = {}) {
  const severity = ok
    ? (options.severity || (options.info ? 'info' : 'pass'))
    : (options.severity || 'fail');
  checks.push({
    key,
    ok,
    code: ok ? DIFF_CODES.OK : code,
    severity,
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
    ...(options.note ? { note: shortText(options.note, 200) } : {}),
  });
  return ok;
}

function statusClassOfExpected(expected) {
  if (typeof expected === 'number') return String(Math.floor(expected / 100)) + 'xx';
  const text = String(expected || '').trim();
  return /^[1-5]xx$/i.test(text) ? text.toLowerCase() : text;
}

/**
 * 用真实观测判定网络 expect。
 * 标准 expect 键交给第一轮 validateStepOutcome（expect 判决），网络专属键逐项补充；
 * 观测本身失败（fetch 抛错）→ 直接 OUTCOME_ERROR。
 *
 * @param {object} plan buildReplayPlan / planNetworkReplay 结果（可为 null）
 * @param {object|string} observationInput 归一化观测（或原始 network.replay 结果）
 * @param {{expect?:object, tolerance?:object|string, volatileJsonPaths?:string[],
 *          ignoreHeaders?:string[], requireAllItems?:boolean}} [options]
 */
export function evaluateReplayObservation(plan, observationInput, options = {}) {
  const observation = isObject(observationInput) && observationInput.version === REPLAY_OBSERVATION_VERSION
    ? observationInput
    : normalizeReplayObservation(observationInput, { plan });
  const expectSource = options.expect !== undefined && options.expect !== null
    ? options.expect
    : (plan && Array.isArray(plan.steps) && plan.steps[0] && isObject(plan.steps[0].expect) ? plan.steps[0].expect : null);
  const expectation = normalizeReplayExpectation(expectSource);
  const tolerance = options.tolerance || 'normalized';
  const checks = [];
  const differences = [];
  const unsupported = expectation.unsupported.slice();

  if (observation.ok !== true) {
    checks.push({
      key: 'observation.ok',
      ok: false,
      code: OBSERVATION_CODES.FAILED,
      severity: 'fail',
      expected: true,
      actual: false,
      note: shortText(observation.error && observation.error.message, 200),
    });
    differences.push({ path: 'observation', kind: 'error', severity: 'fail', expected: true, actual: false, code: OBSERVATION_CODES.FAILED });
    return {
      version: REPLAY_OBSERVATION_VERSION,
      ok: false,
      severity: 'fail',
      code: OBSERVATION_CODES.FAILED,
      checks,
      differences,
      unsupported,
      summary: { checked: 1, failed: 1, warnings: 0 },
      observed: summarizeObservation(observation),
      request: observation.request || null,
      expectation: { keys: expectation.keys, network: Object.keys(expectation.network), unsupported },
      tolerance: { profile: String(typeof tolerance === 'string' ? tolerance : tolerance.profile || 'normalized') },
      explanation: explainFailure({ error: observation.error, detail: '回放观测失败：' + shortText(observation.error && observation.error.message, 200) }),
      digest: stableHash([REPLAY_OBSERVATION_VERSION, observation.digest, 'failed'].join('|')),
    };
  }

  const facts = observationFacts(observation);
  // 标准 expect：走第一轮 validateStepOutcome（消费既有 diff 判决链路）。
  const standardVerdict = validateStepOutcome({ expect: expectation.standard, kind: 'network' }, facts, { tolerance });
  checks.push(...standardVerdict.checks);
  differences.push(...standardVerdict.differences);
  unsupported.push(...standardVerdict.unsupported);

  const network = expectation.network;
  // 1) 状态族（2xx/3xx…，与具体状态码分开表达）
  if (network.statusClass !== undefined) {
    const result = statusMatches(statusClassOfExpected(network.statusClass), observation.status);
    pushCheck(checks, 'statusClass', result.ok, OBSERVATION_CODES.STATUS_CLASS_MISMATCH, network.statusClass, observation.status, { note: result.reason });
  }
  // 2) 正文包含 / 正文精确
  if (network.bodyIncludes !== undefined) {
    const wanted = Array.isArray(network.bodyIncludes) ? network.bodyIncludes : [network.bodyIncludes];
    const haystack = normalizeComparableText(observation.body, tolerance);
    for (const item of wanted.slice(0, 8)) {
      const needle = normalizeComparableText(item, tolerance);
      pushCheck(checks, 'bodyIncludes:' + shortText(item, 40), needle ? haystack.includes(needle) : true, OBSERVATION_CODES.BODY_INCLUDES_MISMATCH, shortText(item, 120), shortText(observation.body, 120));
    }
  }
  if (network.bodyText !== undefined) {
    const comparison = compareText(network.bodyText, observation.body, tolerance);
    pushCheck(checks, 'bodyText', comparison.equal, OBSERVATION_CODES.BODY_INCLUDES_MISMATCH, comparison.expected, comparison.actual, comparison.tolerated ? { severity: 'warning', note: 'fuzzy' } : {});
  }
  // 3) JSON 子集
  if (network.bodyJson !== undefined) {
    if (!observation.jsonParsed) {
      differences.push({ path: 'bodyJson', kind: 'missing', severity: 'fail', expected: 'json', actual: observation.bodyKind, code: OBSERVATION_CODES.BODY_JSON_MISMATCH });
      pushCheck(checks, 'bodyJson', false, OBSERVATION_CODES.BODY_JSON_MISMATCH, 'json', observation.bodyKind);
    } else {
      const jsonDiff = jsonSubsetDiff(network.bodyJson, observation.json, {
        tolerance,
        volatileJsonPaths: options.volatileJsonPaths,
        requireAllItems: options.requireAllItems,
      });
      for (const item of jsonDiff.differences) {
        differences.push({ ...item, path: 'bodyJson.' + item.path, code: OBSERVATION_CODES.BODY_JSON_MISMATCH });
        pushCheck(checks, 'bodyJson:' + shortText(item.path, 60), item.severity !== 'fail', item.code || OBSERVATION_CODES.BODY_JSON_MISMATCH, item.expected, item.actual, { severity: item.severity });
      }
      if (!jsonDiff.differences.length) {
        pushCheck(checks, 'bodyJson', true, OBSERVATION_CODES.BODY_JSON_MISMATCH, expectation.keys, jsonDiff.compared, { info: true });
      }
    }
  }
  // 4) 响应头（易变头标 warning，不假装验证过）
  if (network.headers !== undefined) {
    const wanted = isObject(network.headers) ? network.headers : {};
    const ignore = new Set((options.ignoreHeaders || []).map((name) => String(name).toLowerCase()));
    for (const rawName of Object.keys(wanted).slice(0, 16)) {
      const name = String(rawName).toLowerCase();
      if (ignore.has(name)) continue;
      const actual = observation.headers ? observation.headers[name] : undefined;
      if (VOLATILE_HEADER_SET.has(name) || VOLATILE_HEADER_PREFIX.test(name) || (observation.volatileHeaders || []).includes(name)) {
        pushCheck(checks, 'headers:' + name, false, OBSERVATION_CODES.HEADER_VOLATILE, shortText(wanted[rawName], 120), null, { severity: 'warning', note: 'volatile-header-skipped' });
        continue;
      }
      const spec = wanted[rawName];
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        if (spec.exists === true) {
          pushCheck(checks, 'headers:' + name, actual !== undefined, OBSERVATION_CODES.HEADER_MISMATCH, 'exists', actual === undefined ? null : shortText(actual, 120));
          continue;
        }
        if (spec.includes !== undefined) {
          pushCheck(checks, 'headers:' + name, actual !== undefined && String(actual).includes(String(spec.includes)), OBSERVATION_CODES.HEADER_MISMATCH, spec.includes, actual === undefined ? null : shortText(actual, 120));
          continue;
        }
        if (spec.equals !== undefined) {
          pushCheck(checks, 'headers:' + name, actual !== undefined && String(actual) === String(spec.equals), OBSERVATION_CODES.HEADER_MISMATCH, spec.equals, actual === undefined ? null : shortText(actual, 120));
          continue;
        }
      }
      pushCheck(checks, 'headers:' + name, actual !== undefined && String(actual) === String(spec), OBSERVATION_CODES.HEADER_MISMATCH, shortText(spec, 120), actual === undefined ? null : shortText(actual, 120));
    }
  }
  // 5) content-type
  if (network.contentType !== undefined) {
    const actualType = String(observation.contentType || '');
    pushCheck(checks, 'contentType', actualType.toLowerCase().includes(String(network.contentType).toLowerCase()), OBSERVATION_CODES.HEADER_MISMATCH, network.contentType, shortText(actualType, 120));
  }
  // 6) 正文大小
  if (network.bodyBytes !== undefined) {
    const spec = network.bodyBytes;
    if (isObject(spec)) {
      const min = finiteNumber(spec.min);
      const max = finiteNumber(spec.max);
      const equals = finiteNumber(spec.equals);
      let ok = true;
      let note = 'range';
      if (equals !== null) { ok = observation.bodyBytes === equals; note = 'equals'; }
      else {
        if (min !== null && observation.bodyBytes < min) ok = false;
        if (max !== null && observation.bodyBytes > max) ok = false;
        note = 'range';
      }
      pushCheck(checks, 'bodyBytes', ok, OBSERVATION_CODES.BODY_BYTES_MISMATCH, spec, observation.bodyBytes, { note });
    } else {
      pushCheck(checks, 'bodyBytes', Number(network.bodyBytes) === observation.bodyBytes, OBSERVATION_CODES.BODY_BYTES_MISMATCH, network.bodyBytes, observation.bodyBytes);
    }
  }
  // 7) 耗时（只在有真实 durationMs 时判定；测不到记 warning）
  if (network.maxLatencyMs !== undefined || network.minLatencyMs !== undefined) {
    if (observation.durationMs === null) {
      pushCheck(checks, 'latency', false, OBSERVATION_CODES.LATENCY_UNMEASURED, network.maxLatencyMs, null, { severity: 'warning', note: 'no-duration-observed' });
    } else {
      if (network.maxLatencyMs !== undefined) {
        pushCheck(checks, 'maxLatencyMs', observation.durationMs <= Number(network.maxLatencyMs), OBSERVATION_CODES.LATENCY_EXCEEDED, network.maxLatencyMs, observation.durationMs);
      }
      if (network.minLatencyMs !== undefined) {
        pushCheck(checks, 'minLatencyMs', observation.durationMs >= Number(network.minLatencyMs), OBSERVATION_CODES.LATENCY_EXCEEDED, network.minLatencyMs, observation.durationMs);
      }
    }
  }
  // 8) 重定向与最终 URL
  if (network.redirected !== undefined) {
    pushCheck(checks, 'redirected', observation.redirected === Boolean(network.redirected), OBSERVATION_CODES.REDIRECT_MISMATCH, Boolean(network.redirected), observation.redirected);
  }
  if (network.finalUrl !== undefined) {
    pushCheck(checks, 'finalUrl', urlFacts(observation.finalUrl).key === urlFacts(network.finalUrl).key, OBSERVATION_CODES.REDIRECT_MISMATCH, shortText(urlFacts(network.finalUrl).key, 120), shortText(observation.finalUrlKey, 120));
  }
  if (network.finalUrlIncludes !== undefined) {
    const result = urlIncludes(observation.finalUrl, network.finalUrlIncludes);
    pushCheck(checks, 'finalUrlIncludes', result.ok, OBSERVATION_CODES.REDIRECT_MISMATCH, network.finalUrlIncludes, shortText(observation.finalUrlKey, 120));
  }

  // 失败的 check 全部落成差异项（带路径与码），便于解释层/报告直接消费。
  for (const check of checks) {
    if (check.severity !== 'fail') continue;
    if (differences.length >= OBSERVATION_LIMITS.maxDifferences) break;
    differences.push({
      path: 'check.' + check.key,
      kind: 'check-failed',
      severity: 'fail',
      expected: check.expected,
      actual: check.actual,
      code: check.code,
    });
  }
  const failed = checks.filter((check) => check.severity === 'fail').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  const severity = maxSeverity(checks.map((check) => check.severity));
  const firstFailure = checks.find((check) => check.severity === 'fail') || null;
  const code = failed ? (firstFailure && firstFailure.code) || OBSERVATION_CODES.FAILED : (warnings ? OBSERVATION_CODES.UNCERTAIN_KEY : OBSERVATION_CODES.OK);
  const verdict = {
    version: REPLAY_OBSERVATION_VERSION,
    ok: failed === 0,
    severity,
    code,
    checks: checks.slice(0, OBSERVATION_LIMITS.maxChecks),
    differences: differences.slice(0, OBSERVATION_LIMITS.maxDifferences),
    unsupported,
    summary: { checked: checks.length, failed, warnings, unsupported: unsupported.length },
    observed: summarizeObservation(observation),
    request: { method: observation.requestMethod, urlKey: shortText(observation.requestUrlKey, 300) },
    expectation: {
      keys: expectation.keys,
      standard: Object.keys(expectation.standard),
      network: Object.keys(expectation.network),
      unsupported,
    },
    tolerance: { profile: String(typeof tolerance === 'string' ? tolerance : (tolerance && tolerance.profile) || 'normalized') },
  };
  verdict.digest = stableHash(stableStringify({
    version: REPLAY_OBSERVATION_VERSION,
    ok: verdict.ok,
    code: verdict.code,
    observed: observation.digest,
    checks: verdict.checks.map((item) => [item.key, item.ok, item.code].join(':')),
  }));
  verdict.explanation = verdict.ok
    ? null
    : explainFailure({
      code: firstFailure ? (firstFailure.code && firstFailure.code.startsWith('DIFF_') ? firstFailure.code : 'DIFF_EXPECTATION_FAILED') : 'DIFF_EXPECTATION_FAILED',
      outcome: { ok: false, severity: 'fail', code: verdict.code, differences: verdict.differences, summary: verdict.summary },
      detail: firstFailure ? firstFailure.key + ' expected ' + shortText(firstFailure.expected, 80) : '',
    });
  return verdict;
}

// ---------------------------------------------------------------------------
// 两次真实回放的观测 diff（确定性）
// ---------------------------------------------------------------------------

/** 从 headers 里剔除易变头与调用方忽略的头，得到稳定子集。 */
function stableHeaders(observation, ignoreHeaders) {
  const ignore = new Set((ignoreHeaders || []).map((name) => String(name).toLowerCase()));
  const out = {};
  const source = isObject(observation.headers) ? observation.headers : {};
  for (const name of Object.keys(source).sort()) {
    if (ignore.has(name)) continue;
    if (VOLATILE_HEADER_SET.has(name) || VOLATILE_HEADER_PREFIX.test(name)) continue;
    out[name] = source[name];
  }
  return out;
}

/**
 * 两次真实回放的观测差异（确定性判定）。
 * 比较：成功/失败、状态码/状态族、最终 URL、正文（容差）、JSON（剔除 volatile 路径）、
 * 稳定响应头、正文大小、重定向。
 * 不比较：耗时（只作为观测值）、易变响应头（date/etag/request-id…）。
 *
 * @param {object} leftInput 第一次观测/结果
 * @param {object} rightInput 第二次观测/结果
 * @param {{tolerance?:object|string, ignoreHeaders?:string[], volatileJsonPaths?:string[],
 *          ignoreQuery?:boolean, request?:object}} [options]
 */
export function diffReplayObservations(leftInput, rightInput, options = {}) {
  const context = { request: options.request };
  const left = isObject(leftInput) && leftInput.version === REPLAY_OBSERVATION_VERSION ? leftInput : normalizeReplayObservation(leftInput, context);
  const right = isObject(rightInput) && rightInput.version === REPLAY_OBSERVATION_VERSION ? rightInput : normalizeReplayObservation(rightInput, context);
  const differences = [];
  const push = (path, expected, actual, kind = 'value', severity = 'fail') => {
    if (differences.length >= OBSERVATION_LIMITS.maxDifferences) return;
    differences.push({ path, kind, severity, expected, actual });
  };
  if (left.ok !== true || right.ok !== true) {
    const leftCode = left.ok === true ? 'ok' : String((left.error && left.error.code) || 'error');
    const rightCode = right.ok === true ? 'ok' : String((right.error && right.error.code) || 'error');
    if (leftCode !== rightCode) push('error.code', leftCode, rightCode);
    return {
      version: REPLAY_OBSERVATION_VERSION,
      same: differences.length === 0,
      deterministic: differences.length === 0,
      differences,
      compared: { errorOnly: true },
      ignored: { headers: [], jsonPaths: [], latency: true },
      digests: { left: observationDigest(left), right: observationDigest(right) },
      code: differences.length === 0 ? OBSERVATION_CODES.DETERMINISTIC : OBSERVATION_CODES.DIVERGED,
      summary: { differences: differences.length },
    };
  }
  const tolerance = options.tolerance || { profile: 'exact' };
  if (left.status !== right.status) push('status', left.status, right.status);
  if (left.statusClass !== right.statusClass) push('statusClass', left.statusClass, right.statusClass);
  const keyOf = (observation) => {
    const key = String(observation.urlKey || '');
    if (!options.ignoreQuery) return key;
    return key.split('?')[0];
  };
  if (keyOf(left) !== keyOf(right)) push('urlKey', shortText(keyOf(left), 200), shortText(keyOf(right), 200));
  if ((left.redirected === true) !== (right.redirected === true)) push('redirected', left.redirected === true, right.redirected === true);
  if (left.bodyBytes !== null && right.bodyBytes !== null && left.bodyBytes !== right.bodyBytes) push('bodyBytes', left.bodyBytes, right.bodyBytes);
  if (left.bodyKind !== right.bodyKind) push('bodyKind', left.bodyKind, right.bodyKind);
  if (left.jsonParsed === true && right.jsonParsed === true) {
    const volatilePaths = new Set((options.volatileJsonPaths || []).map(String));
    const stripped = (value) => stripVolatileJson(value, volatilePaths, '', 0);
    const jsonDiff = deepDiff(stripped(left.json), stripped(right.json), { tolerance, maxDepth: OBSERVATION_LIMITS.maxJsonDepth, maxItems: OBSERVATION_LIMITS.maxJsonItems });
    for (const item of jsonDiff) {
      if (isAcceptableDifference(item, tolerance)) continue;
      push('bodyJson' + (item.path ? '.' + item.path : ''), item.expected, item.actual, item.kind, item.severity);
    }
  } else if (left.body !== right.body) {
    const comparison = compareText(left.body, right.body, tolerance);
    if (!comparison.equal) {
      push('body', shortText(comparison.expected, 200), shortText(comparison.actual, 200), 'value', 'fail');
    }
  }
  const leftHeaders = stableHeaders(left, options.ignoreHeaders);
  const rightHeaders = stableHeaders(right, options.ignoreHeaders);
  const headerKeys = [...new Set([...Object.keys(leftHeaders), ...Object.keys(rightHeaders)])].sort();
  for (const name of headerKeys) {
    if (leftHeaders[name] === rightHeaders[name]) continue;
    push('headers.' + name, shortText(leftHeaders[name], 120), shortText(rightHeaders[name], 120));
  }
  const same = differences.length === 0;
  return {
    version: REPLAY_OBSERVATION_VERSION,
    same,
    deterministic: same,
    differences,
    compared: {
      status: true,
      urlKey: true,
      redirected: true,
      body: true,
      json: left.jsonParsed === true && right.jsonParsed === true,
      headers: headerKeys.length,
      bodyBytes: true,
    },
    ignored: {
      headers: [...VOLATILE_HEADERS].concat(options.ignoreHeaders || []).slice(0, OBSERVATION_LIMITS.maxEvidence),
      jsonPaths: (options.volatileJsonPaths || []).slice(0, OBSERVATION_LIMITS.maxEvidence),
      latency: true,
    },
    digests: { left: observationDigest(left), right: observationDigest(right) },
    code: same ? OBSERVATION_CODES.DETERMINISTIC : OBSERVATION_CODES.DIVERGED,
    summary: { differences: differences.length },
  };
}

/** 按路径剔除易变 JSON 字段（仅用于确定性比较，不改变观测本身）。 */
function stripVolatileJson(value, paths, prefix, depth) {
  if (depth > OBSERVATION_LIMITS.maxJsonDepth) return '[depth]';
  if (Array.isArray(value)) {
    return value.slice(0, OBSERVATION_LIMITS.maxJsonItems).map((item) => stripVolatileJson(item, paths, prefix + '[]', depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, OBSERVATION_LIMITS.maxJsonItems)) {
      const childPath = (prefix ? prefix + '.' : '') + key;
      if (paths.has(childPath) || paths.has('*.' + key)) continue;
      out[key] = stripVolatileJson(value[key], paths, childPath, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 消费入口 / 文本
// ---------------------------------------------------------------------------

/**
 * 一次回放（可含第二次重放）→ 可挂到 RPC 输出的观测字段。
 * @param {object} plan
 * @param {{result?:unknown, error?:unknown, secondResult?:unknown, secondError?:unknown}} runs
 * @param {object} [options] 透传 evaluateReplayObservation / diffReplayObservations
 */
export function consumeReplayObservation(plan, runs, options = {}) {
  const source = isObject(runs) ? runs : {};
  const firstObservation = source.error !== undefined && source.result === undefined
    ? normalizeReplayObservation({ error: source.error }, { plan })
    : normalizeReplayObservation(source.result, { plan });
  const verdict = evaluateReplayObservation(plan, firstObservation, options);
  let determinism = null;
  const hasSecond = source.secondResult !== undefined || source.secondError !== undefined;
  if (hasSecond) {
    const secondObservation = source.secondError !== undefined && source.secondResult === undefined
      ? normalizeReplayObservation({ error: source.secondError }, { plan })
      : normalizeReplayObservation(source.secondResult, { plan });
    determinism = diffReplayObservations(firstObservation, secondObservation, {
      ...options,
      request: plan && plan.network ? plan.network : options.request,
    });
  }
  const ok = verdict.ok === true && (determinism === null || determinism.deterministic === true);
  return {
    version: REPLAY_OBSERVATION_VERSION,
    ok,
    verdict,
    determinism,
    observed: summarizeObservation(firstObservation),
    digest: stableHash([
      REPLAY_OBSERVATION_VERSION,
      verdict.digest || '',
      determinism ? determinism.code : '',
      ok ? 'ok' : 'fail',
    ].join('|')),
  };
}

/** 文本 diff（日志/CLI 展示；有界）。 */
export function formatObservationDiff(diff, options = {}) {
  if (!isObject(diff)) return '观测 diff：无结果';
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 20;
  const lines = [];
  lines.push('观测 diff ' + (diff.deterministic ? '一致' : '不一致（' + diff.summary.differences + ' 处）')
    + (diff.compared && diff.compared.errorOnly ? '（两侧都失败）' : ''));
  for (const item of (diff.differences || []).slice(0, 10)) {
    lines.push('- ' + item.path + ': expected=' + shortText(item.expected, 80) + ' actual=' + shortText(item.actual, 80));
  }
  if (diff.ignored) {
    lines.push('已排除：易变 header ' + (diff.ignored.headers || []).length + ' 个，JSON 路径 ' + (diff.ignored.jsonPaths || []).length + ' 个，耗时不计');
  }
  return lines.slice(0, maxLines).join('\n');
}

/** 观测判定摘要（RPC 字段：有界）。 */
export function summarizeObservationVerdict(verdict) {
  if (!isObject(verdict)) return null;
  return {
    version: REPLAY_OBSERVATION_VERSION,
    ok: verdict.ok === true,
    severity: String(verdict.severity || ''),
    code: String(verdict.code || ''),
    summary: isObject(verdict.summary)
      ? {
        checked: nonNegativeInt(verdict.summary.checked),
        failed: nonNegativeInt(verdict.summary.failed),
        warnings: nonNegativeInt(verdict.summary.warnings),
        unsupported: nonNegativeInt(verdict.summary.unsupported),
      }
      : null,
    differences: summarizeDifferences(verdict.differences, 4),
    checks: (verdict.checks || []).slice(0, 6).map((check) => ({
      key: String(check.key || ''),
      ok: check.ok === true,
      code: String(check.code || ''),
      severity: String(check.severity || ''),
    })),
    observed: verdict.observed || null,
    tolerance: verdict.tolerance || null,
    digest: String(verdict.digest || ''),
  };
}
