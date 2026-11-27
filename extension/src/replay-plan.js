// extension/src/replay-plan.js —— 回放规划与字段层（第十二批从 replay.js 拆出，保持既有公开 API）。
//
// 本文件承接第一轮 replay.js 的“规划/字段”部分：参数归一与校验、三条命令路径的计划、
// 输出字段（replay/replayFailure）与失败解释挂载，以及 replayOutcomeTemplate 等纯函数。
// 被 extension/src/replay.js（命令接线）与 extension/src/replay-execution.js（第二轮执行包装）单向消费；
// 本文件不 import 任何 replay*.js（避免循环）。

import { preflightReplay } from './record-program.js';
import { DEFAULT_PLAN_LIMITS, buildReplayPlan, planFromPreflight, summarizeReplayPlan } from './lib/replay-plan.js';
import { summarizeBoundaries } from './lib/replay-boundary-plan.js';
import { summarizeTargetPlan } from './lib/replay-target.js';
import { summarizeVerify } from './lib/replay-verify.js';
import { executionFingerprint, summarizeExecution, summarizeSideEffects } from './lib/replay-executor.js';
import { summarizeObservationVerdict } from './lib/replay-diff-exec.js';
import { summarizeBoundaryExecution } from './lib/replay-boundary-exec.js';
import { planOutcomeTemplate } from './lib/replay-plan-view.js';
import { validateStepOutcome, summarizeDifferences } from './lib/replay-diff.js';
import { explainFailure, explainPlanBlockers, buildFailureReport, summarizeFailureReport } from './lib/replay-explain.js';

export const REPLAY_WIRING_VERSION = 1;

/** 附加字段名：成功时写 replay，失败时写 replayFailure；计划原文可选写 replayPlan。 */
export const REPLAY_FIELD = 'replay';
export const REPLAY_FAILURE_FIELD = 'replayFailure';
export const REPLAY_PLAN_FIELD = 'replayPlan';

/** 回放来源标识（输出字段 source 的取值）。 */
export const REPLAY_SOURCES = Object.freeze({
  NETWORK: 'network.replay',
  DEBUG: 'debug.replay',
  RECORD: 'record.export',
});

/** HTTP 方法白名单（与兼容目标 control-model.js 的 METHODS 一致）。 */
export const REPLAY_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** 网络重放的输入上限（超过即阻断，不静默截断）。 */
export const REPLAY_NETWORK_LIMITS = Object.freeze({
  maxUrlChars: 16384,
  maxBodyChars: 65536,
  maxHeaderCount: 40,
  maxHeaderChars: 4096,
  maxHeadersBytes: 8192,
});

/** 脱敏占位：出现即说明录制时被改写，不能直接重放。 */
const REDACTED_PLACEHOLDER = /\[redacted\]|%5bredacted%5d|\[depth limit\]|\[truncated\]/i;

/** 禁止透传的请求头（浏览器/协议层自己管理，透传会破坏请求）。 */
const FORBIDDEN_HEADERS = /^(?:host|content-length|cookie|cookie2|origin|referer|user-agent|accept-encoding|connection|transfer-encoding|upgrade|proxy-.*|sec-.*|access-control-request-.*)$/i;

/**
 * 既有回放入口清单：只列 file + symbol（行号随代码漂移，报告里单独给）。
 * 这些是“接线目标”的机器可读声明，单测用它守卫入口没有被重命名。
 */
export const REPLAY_COMMAND_PATHS = Object.freeze([
  Object.freeze({ id: 'dispatch', command: 'network.replay', surface: 'extension rpc table', file: 'extension/src/dispatch.js', symbol: 'networkReplay', shape: '{tabId, id?, request?, overrides?}' }),
  Object.freeze({ id: 'network', command: 'network.replay', surface: 'extension implementation', file: 'extension/src/network.js', symbol: 'networkReplay', shape: '{tabId, id?, request?, overrides?}' }),
  Object.freeze({ id: 'debug-bridge', command: 'debug replay', surface: 'debug bridge message', file: 'extension/src/bridge.js', symbol: 'bb.debug.replay', shape: '{tabId, id?, overrides?}' }),
  Object.freeze({ id: 'debug-caps', command: 'debug replay', surface: 'capability advertisement', file: 'extension/src/debug.js', symbol: 'debugCapabilities', shape: 'features.replay' }),
  Object.freeze({ id: 'cli-network', command: 'network.replay', surface: 'cli', file: 'cli/commands/network.mjs', symbol: 'callRpc("network.replay")', shape: '{session, id} | {session, request}' }),
  Object.freeze({ id: 'cli-debug', command: 'network.replay', surface: 'cli debug replay', file: 'cli/commands/debug.mjs', symbol: 'callRpc("network.replay")', shape: '{session, id}' }),
  Object.freeze({ id: 'mcp', command: 'network.replay', surface: 'mcp tool', file: 'mcp/tools-debug-a.mjs', symbol: 'rpc("network.replay")', shape: '{session, request, id}' }),
  Object.freeze({ id: 'record-preflight', command: 'record replay', surface: 'record export consumption', file: 'extension/src/record-program.js', symbol: 'preflightReplay', shape: 'steps|program -> {replayPlan, token, blockers}' }),
  Object.freeze({ id: 'record-summary', command: 'record export', surface: 'recorded events', file: 'extension/src/record-events.js', symbol: 'summarizeRecording', shape: 'events[] -> {recordStep, recordProgram}' }),
]);

// ---------------------------------------------------------------------------
// 参数归一 / 校验
// ---------------------------------------------------------------------------

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 生成一次回放的稳定 requestId（确定性；不嵌入原始 URL，避免把 query 里的敏感值带进输出）。 */
function requestIdOf(params) {
  if (params && params.id !== undefined && params.id !== null && params.id !== '') return String(params.id).slice(0, 80);
  const request = isPlainObject(params && params.request) ? params.request : null;
  if (request && typeof request.url === 'string') return 'url-' + simpleHash(request.url);
  return 'adhoc';
}

/** 归一化调用参数：只保留已知键，undefined 不参与。 */
export function normalizeReplayParams(params) {
  const source = isPlainObject(params) ? params : {};
  const out = {};
  if (Number.isInteger(source.tabId)) out.tabId = source.tabId;
  if (source.id !== undefined && source.id !== null && source.id !== '') out.id = source.id;
  if (Number.isInteger(source.frameId)) out.frameId = source.frameId;
  if (isPlainObject(source.request)) out.request = source.request;
  if (isPlainObject(source.overrides)) out.overrides = source.overrides;
  if (isPlainObject(source.options)) out.options = source.options;
  return out;
}

/** 只取 http(s) 绝对 URL 的解析结果；失败返回 null（不抛）。 */
export function parseReplayUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > REPLAY_NETWORK_LIMITS.maxUrlChars) return null;
  if (REDACTED_PLACEHOLDER.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return {
      href: url.href,
      origin: url.origin,
      path: url.pathname || '/',
      hasQuery: Boolean(url.search),
      hasHash: Boolean(url.hash),
      host: url.host,
    };
  } catch {
    return null;
  }
}

/** 归一化 headers：小写键、跳过浏览器保留头、值限长；返回 {headers, dropped, invalid}。 */
export function normalizeReplayHeaders(headers) {
  const result = {};
  const dropped = [];
  const invalid = [];
  if (!isPlainObject(headers)) return { headers: result, dropped, invalid };
  let count = 0;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (count >= REPLAY_NETWORK_LIMITS.maxHeaderCount) break;
    const name = String(rawName || '').trim().toLowerCase();
    if (!name) { invalid.push(String(rawName || '')); continue; }
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || name.length > 128) { invalid.push(name.slice(0, 80)); continue; }
    if (FORBIDDEN_HEADERS.test(name) || name === 'set-cookie') { dropped.push(name); continue; }
    if (rawValue === null || rawValue === undefined) continue;
    const text = String(rawValue);
    if (text.length > REPLAY_NETWORK_LIMITS.maxHeaderChars || /[\r\n\0]/.test(text) || REDACTED_PLACEHOLDER.test(text)) {
      invalid.push(name);
      continue;
    }
    Object.defineProperty(result, name, { value: text, enumerable: true, configurable: true, writable: true });
    count += 1;
  }
  return { headers: result, dropped, invalid };
}

/**
 * 从 network.replay / bb.debug.replay 的参数里提取“要重放的请求事实”。
 * 兼容两种既有形状：{id}（按采集记录重放）与 {request:{url,method,headers,body}}（覆盖重放）。
 * @param {unknown} params
 * @param {{current?:object, overrides?:object}} [context]
 * @returns {object}
 */
export function extractNetworkReplay(params, context = {}) {
  const normalized = normalizeReplayParams(params);
  const overrides = isPlainObject(context.overrides) ? context.overrides : (normalized.overrides || {});
  const request = isPlainObject(normalized.request) ? normalized.request : null;
  const urlInput = overrides.url !== undefined ? overrides.url : (request ? request.url : undefined);
  const parsed = parseReplayUrl(urlInput);
  const method = String(overrides.method !== undefined ? overrides.method : (request && request.method) || 'GET').toUpperCase();
  const bodySource = overrides.body !== undefined ? overrides.body : (request ? request.body : undefined);
  const hasBody = typeof bodySource === 'string' && bodySource.length > 0;
  const headerSource = overrides.headers !== undefined ? overrides.headers : (request && request.headers);
  const headerInfo = normalizeReplayHeaders(headerSource);
  const facts = {
    source: REPLAY_SOURCES.NETWORK,
    id: normalized.id !== undefined ? normalized.id : 0,
    requestId: requestIdOf(normalized),
    hasRecordedEntry: !request,
    url: parsed ? parsed.href : '',
    origin: parsed ? parsed.origin : '',
    path: parsed ? parsed.path : '',
    hasQuery: parsed ? parsed.hasQuery : false,
    urlHash: parsed ? 'u' + simpleHash(parsed.href) : '',
    method,
    headers: headerInfo.headers,
    droppedHeaders: headerInfo.dropped,
    invalidHeaders: headerInfo.invalid,
    hasBody,
    bodyBytes: hasBody ? utf8Bytes(bodySource) : 0,
    redactedBody: typeof bodySource === 'string' && REDACTED_PLACEHOLDER.test(bodySource),
    redactedUrl: Boolean(urlInput) && REDACTED_PLACEHOLDER.test(String(urlInput)),
    crossOrigin: null,
    boundary: context.current ? context.current : null,
  };
  if (parsed && isPlainObject(context.current)) {
    const currentOrigin = typeof context.current.url === 'string' ? parseReplayUrl(context.current.url) : null;
    if (currentOrigin) facts.crossOrigin = currentOrigin.origin !== parsed.origin;
  }
  return facts;
}

function utf8Bytes(text) {
  const value = String(text || '');
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

function simpleHash(text) {
  // 与 record-steps.stableHash 同算法的最小子集（避免本文件多 import 一个符号）。
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 网络重放参数校验：返回 blockers（{code,message,source:'network'}）。
 * 只校验“能不能安全重放”，不执行请求。
 */
export function validateNetworkReplay(facts) {
  const blockers = [];
  const warnings = [];
  const item = facts && typeof facts === 'object' ? facts : {};
  if (!item.url) {
    if (item.hasRecordedEntry) {
      // 只给采集 id 是既有命令的正常用法：URL 由 network.start 的采集记录在运行期解析。
      warnings.push({ code: 'NETWORK_REPLAY_MISSING_ENTRY', index: -1, source: 'network', message: '只给了采集 id：URL 需由 network.start 采集记录提供，计划里不含 URL' });
    } else {
      blockers.push({
        code: item.redactedUrl ? 'NETWORK_REPLAY_REDACTED' : 'NETWORK_REPLAY_BAD_URL',
        index: -1,
        source: 'network',
        message: item.redactedUrl ? 'URL 含脱敏占位，不能直接重放' : '需要绝对 http(s) URL（未被脱敏、无凭据）',
      });
    }
  }
  if (!REPLAY_METHODS.includes(String(item.method || ''))) {
    blockers.push({ code: 'NETWORK_REPLAY_BAD_METHOD', index: -1, source: 'network', message: 'HTTP 方法不受支持：' + String(item.method || '') });
  }
  if (item.hasBody && ['GET', 'HEAD'].includes(String(item.method || ''))) {
    blockers.push({ code: 'NETWORK_REPLAY_BODY_UNSAFE', index: -1, source: 'network', message: 'GET/HEAD 不能携带请求正文' });
  }
  if (item.redactedBody) {
    blockers.push({ code: 'NETWORK_REPLAY_REDACTED', index: -1, source: 'network', message: '请求正文含脱敏占位，重放前需人工补值' });
  }
  if (item.bodyBytes > REPLAY_NETWORK_LIMITS.maxBodyChars) {
    blockers.push({ code: 'NETWORK_REPLAY_LIMIT', index: -1, source: 'network', message: '请求正文超过最大长度' });
  }
  if (item.invalidHeaders && item.invalidHeaders.length) {
    blockers.push({
      code: 'NETWORK_REPLAY_REDACTED',
      index: -1,
      source: 'network',
      message: '存在非法/脱敏请求头：' + item.invalidHeaders.slice(0, 4).join(', '),
    });
  }
  if (item.crossOrigin === true) {
    warnings.push({ code: 'NETWORK_REPLAY_CROSS_ORIGIN', index: -1, source: 'network', message: '重放目标与当前页面不同源，响应可能受 CORS 影响' });
  }
  if (item.droppedHeaders && item.droppedHeaders.length) {
    warnings.push({
      code: 'NETWORK_REPLAY_HEADER_IGNORED',
      index: -1,
      source: 'network',
      message: '已忽略浏览器保留头：' + item.droppedHeaders.slice(0, 6).join(', '),
    });
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

// ---------------------------------------------------------------------------
// 三条命令路径的规划
// ---------------------------------------------------------------------------

/** 网络重放 → 计划节点（不带正文，只带可解释的元信息）。 */
function networkNodeOf(facts) {
  return {
    kind: 'network',
    method: 'network.replay',
    ref: 'network:' + facts.requestId,
    params: {
      id: facts.id,
      origin: facts.origin,
      path: facts.path,
      hasQuery: facts.hasQuery,
      urlHash: facts.urlHash,
      method: facts.method,
      hasBody: facts.hasBody,
      bodyBytes: facts.bodyBytes,
      headerCount: Object.keys(facts.headers || {}).length,
    },
    target: null,
    expect: null,
    fallback: { onError: 'stop', skipReason: '' },
    idempotent: false,
    risk: 'browser_mutation',
    boundary: facts.boundary || null,
    sourceKind: 'network.replay',
  };
}

/**
 * 规划一次 network.replay（纯函数，不发请求）。
 * @param {unknown} params 既有 network.replay 入参
 * @param {{current?:object, frames?:Array<object>, overrides?:object, salt?:string,
 *          snapshots?:unknown, requireSnapshot?:boolean, limits?:object}} [options]
 * @returns {object} 计划（含 network 事实字段）
 */
export function planNetworkReplay(params, options = {}) {
  const facts = extractNetworkReplay(params, { current: options.current, overrides: options.overrides });
  const validation = validateNetworkReplay(facts);
  const node = networkNodeOf(facts);
  const plan = buildReplayPlan([node], {
    ...options,
    source: REPLAY_SOURCES.NETWORK,
    // 回放本身就是显式副作用请求：不因“非幂等”阻断，但仍把它标记在 network 字段里。
    allowNonIdempotent: true,
    requireHumanValues: false,
    dedupeIdempotent: false,
    blockers: validation.blockers,
    current: options.current,
    frames: options.frames,
  });
  for (const warning of validation.warnings) {
    plan.warnings.push({ code: warning.code, index: -1, message: warning.message, source: 'network' });
  }
  return {
    ...plan,
    network: {
      id: facts.id,
      requestId: facts.requestId,
      method: facts.method,
      origin: facts.origin,
      path: facts.path,
      hasQuery: facts.hasQuery,
      hasBody: facts.hasBody,
      bodyBytes: facts.bodyBytes,
      headerCount: Object.keys(facts.headers || {}).length,
      droppedHeaders: facts.droppedHeaders.slice(0, 8),
      crossOrigin: facts.crossOrigin,
      hasRecordedEntry: facts.hasRecordedEntry,
      urlResolved: Boolean(facts.url),
      sideEffect: true,
    },
  };
}

/**
 * 规划一次 debug replay（bb.debug.replay 的消息形状：{tabId,id,overrides}）。
 * @param {unknown} message
 * @param {object} [options]
 */
export function planDebugReplay(message, options = {}) {
  const plan = planNetworkReplay(message, options);
  return {
    ...plan,
    source: REPLAY_SOURCES.DEBUG,
    debug: {
      tabId: message && Number.isInteger(message.tabId) ? message.tabId : null,
      id: message && message.id !== undefined ? message.id : null,
      hasOverrides: Boolean(message && isPlainObject(message.overrides)),
      uiOrigin: 'debug panel replay',
    },
  };
}

/** 从录制导出/事件数组/程序里抽出 step 列表（不依赖 chrome）。 */
export function extractRecordReplaySteps(recording) {
  if (Array.isArray(recording)) {
    if (recording.length && recording[0] && typeof recording[0] === 'object' && recording[0].recordStep) {
      return recording.map((event) => event.recordStep).filter(Boolean);
    }
    return recording.filter(Boolean);
  }
  if (!isPlainObject(recording)) return [];
  if (Array.isArray(recording.events)) {
    return recording.events.map((event) => (event && event.recordStep ? event.recordStep : event)).filter(Boolean);
  }
  if (Array.isArray(recording.steps)) return recording.steps.filter(Boolean);
  if (Array.isArray(recording.nodes)) return recording.nodes.filter(Boolean);
  if (isPlainObject(recording.program) && Array.isArray(recording.program.nodes)) return recording.program.nodes.filter(Boolean);
  return [];
}

/**
 * 规划一次 record export 回放：预检 → 计划（与 preflightReplay 的 token 对齐）。
 * @param {unknown} recording events[] / {events|steps|nodes|program|replayPlan,token}
 * @param {{allowNonIdempotent?:boolean, requireHumanValues?:boolean, knownTokens?:string[],
 *          salt?:string, allowDuplicate?:boolean, current?:object, frames?:Array<object>,
 *          snapshots?:unknown, requireSnapshot?:boolean, limits?:object}} [options]
 */
export function planRecordReplay(recording, options = {}) {
  const explicitPreflight = isPlainObject(recording) && Array.isArray(recording.replayPlan) ? recording : null;
  const steps = extractRecordReplaySteps(recording);
  const preflightOptions = {
    ...(options.allowNonIdempotent === true ? { allowNonIdempotent: true } : {}),
    ...(options.requireHumanValues === false ? { requireHumanValues: false } : {}),
    ...(Array.isArray(options.knownTokens) ? { knownTokens: options.knownTokens } : {}),
    ...(options.salt !== undefined ? { salt: options.salt } : {}),
    ...(options.allowDuplicate === true ? { allowDuplicate: true } : {}),
    ...(options.maxLoopIterations ? { maxLoopIterations: options.maxLoopIterations } : {}),
    ...(options.maxReplayRetries ? { maxReplayRetries: options.maxReplayRetries } : {}),
  };
  let preflight = explicitPreflight;
  if (!preflight) {
    preflight = steps.length ? preflightReplay(steps, preflightOptions) : { ok: false, token: '', replayPlan: [], blockers: [{ code: 'REPLAY_EMPTY', message: '没有可回放的步骤' }], requiresHuman: [], warnings: [] };
  }
  const plan = planFromPreflight(preflight, {
    ...options,
    source: REPLAY_SOURCES.RECORD,
    allowNonIdempotent: options.allowNonIdempotent === true || (preflight && preflight.ok === true) ? true : false,
    requireHumanValues: options.requireHumanValues !== false,
    dedupeIdempotent: false,
  });
  const explanations = explainPlanBlockers(plan.blockers, plan).slice(0, 8);
  return {
    ...plan,
    // planFromPreflight 会把 source 标成 'preflight'；接线层对外统一成 record.export。
    source: REPLAY_SOURCES.RECORD,
    record: {
      steps: plan.steps.length,
      sourceSteps: steps.length,
      preflight: {
        ok: preflight.ok === true,
        token: String(preflight.token || ''),
        blockers: Array.isArray(preflight.blockers) ? preflight.blockers.length : 0,
        warnings: Array.isArray(preflight.warnings) ? preflight.warnings.length : 0,
        requiresHuman: Array.isArray(preflight.requiresHuman) ? preflight.requiresHuman.length : 0,
      },
      failureHints: explanations.map((item) => ({ code: item.code, title: item.title })),
    },
  };
}

/**
 * 统一入口：按来源规划。
 * @param {'network'|'debug'|'record'} source
 * @param {unknown} params
 * @param {object} [options]
 */
export function prepareReplay(source, params, options = {}) {
  const kind = String(source || '').toLowerCase();
  if (kind === 'network') return planNetworkReplay(params, options);
  if (kind === 'debug') return planDebugReplay(params, options);
  if (kind === 'record' || kind === 'export' || kind === 'record.export') return planRecordReplay(params, options);
  // 未知来源不猜：返回空计划 + 明确 blocker。
  return buildReplayPlan([], {
    ...options,
    source: kind || 'unknown',
    validationIssues: [{ severity: 'error', code: 'PLAN_INVALID_INPUT', message: '未知回放来源：' + String(source || '') }],
  });
}

// ---------------------------------------------------------------------------
// 输出字段（只加字段）
// ---------------------------------------------------------------------------

/**
 * 由计划生成要附加到既有结果上的 replay 字段（有界、稳定）。
 * @param {object} plan
 * @param {{verify?:object, outcome?:object, executed?:boolean}} [extra]
 */
export function buildReplayField(plan, extra = {}) {
  const summary = summarizeReplayPlan(plan);
  const field = {
    version: REPLAY_WIRING_VERSION,
    ...summary,
    boundaries: summarizeBoundaries(plan && plan.boundaries),
    targets: summarizeTargetPlan(plan && plan.targets),
    network: plan && plan.network ? { ...plan.network } : null,
    record: plan && plan.record ? { ...plan.record } : null,
    debug: plan && plan.debug ? { ...plan.debug } : null,
    executed: extra.executed === true,
    verify: extra.verify ? summarizeVerify(extra.verify) : null,
  };
  // 第二轮字段（只在调用方显式提供时出现；默认路径逐字节不变）。
  if (extra.execution) {
    field.execution = summarizeExecution(extra.execution);
    field.executionFingerprint = executionFingerprint(extra.execution);
  }
  if (extra.envelope) {
    field.executionEnvelope = {
      version: extra.envelope.version,
      fingerprint: extra.envelope.fingerprint,
      deterministic: extra.envelope.deterministic === true,
      hasWallClock: extra.envelope.hasWallClock === true,
      sideEffects: extra.envelope.sideEffects || null,
    };
  }
  if (extra.sideEffects) field.sideEffects = summarizeSideEffects(extra.sideEffects);
  if (extra.observation) field.observation = extra.observation;
  if (extra.verdict) field.verdict = summarizeObservationVerdict(extra.verdict);
  if (extra.determinism) field.determinism = extra.determinism;
  if (extra.observationDiff) field.observationDiff = extra.observationDiff;
  if (extra.boundaryExecution) field.boundaryExecution = summarizeBoundaryExecution(extra.boundaryExecution);
  if (extra.outcome) {
    const verdict = validateStepOutcome(extra.step || {}, extra.outcome, { tolerance: extra.tolerance });
    field.outcome = {
      ok: verdict.ok === true,
      severity: verdict.severity,
      code: verdict.code,
      summary: verdict.summary,
      differences: summarizeDifferences(verdict.differences, 4),
    };
  }
  return field;
}

/**
 * 只加字段：把 extra 存进 result[field]，其余字段原样保留。
 * - extra 为空 → 返回同一个 result 引用（默认行为不变）；
 * - result 不是对象 → 原样返回；
 * - 不修改入参对象。
 * @param {object} result 既有命令结果
 * @param {object|null|undefined} extra replay 字段内容
 * @param {{field?:string, clone?:boolean}} [options]
 */
export function withReplayFields(result, extra, options = {}) {
  if (extra === null || extra === undefined) return result;
  if (!isPlainObject(result)) return result;
  const field = typeof options.field === 'string' && options.field ? options.field : REPLAY_FIELD;
  return { ...result, [field]: extra };
}

/**
 * 消费一次命令结果：把计划（+可选官方 verdict）附加为 replay 字段。
 * @param {object} result 既有命令返回
 * @param {object} plan buildReplayPlan 结果
 * @param {{outcome?:object, step?:object, verify?:object, executed?:boolean, field?:string}} [options]
 */
export function consumeReplayResult(result, plan, options = {}) {
  if (!plan) return result;
  const field = buildReplayField(plan, {
    outcome: options.outcome,
    step: options.step,
    verify: options.verify,
    executed: options.executed,
  });
  return withReplayFields(result, field, { field: options.field });
}

/**
 * 把失败解释挂到原异常上（字段名 replayFailure），错误本身原样返回/抛出。
 * 只挂在可写对象上；挂不上就原样返回，绝不因为“解释失败”改变主错误。
 * @param {unknown} error
 * @param {object} explanation explainFailure 输出
 */
export function attachReplayFailure(error, explanation) {
  if (!explanation) return error;
  if (!error || typeof error !== 'object') return error;
  try {
    Object.defineProperty(error, REPLAY_FAILURE_FIELD, {
      value: explanation,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // 冻结对象/宿主异常：保留主错误优先。
  }
  return error;
}

/** 从错误上读取失败解释（没有则 null；解释字段不可枚举，避免改变错误序列化）。 */
export function replayFailureOf(error) {
  if (!error || typeof error !== 'object') return null;
  const value = error[REPLAY_FAILURE_FIELD];
  return value && typeof value === 'object' ? value : null;
}

/** 从结果里读回放字段（没有则 null）。 */
export function replayFieldOf(result, field) {
  if (!isPlainObject(result)) return null;
  const key = typeof field === 'string' && field ? field : REPLAY_FIELD;
  return isPlainObject(result[key]) ? result[key] : null;
}

/**
 * 一次回放失败 → 既有错误 + 可解释字段。
 * @param {unknown} error
 * @param {object} plan
 * @param {{step?:object, outcome?:object}} [context]
 */
export function explainReplayError(error, plan, context = {}) {
  const explanation = explainFailure({
    error,
    plan,
    step: context.step,
    outcome: context.outcome,
  });
  return attachReplayFailure(error, explanation);
}

/** 一组失败 → 报告字段（附加到结果/导出用）。 */
export function replayFailureReport(failures, plan) {
  const list = Array.isArray(failures) ? failures : [];
  const report = buildFailureReport(list, { plan });
  return { ...summarizeFailureReport(report), text: '' };
}

/** 计划的执行占位（运行时按 index 记结果；与既有执行器解耦）。 */
export function replayOutcomeTemplate(plan) {
  return planOutcomeTemplate(plan);
}

// ---------------------------------------------------------------------------
