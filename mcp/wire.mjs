// mcp/wire.mjs —— MCP stdio 传输的 JSON-RPC 2.0 信封层（解析 / 分类 / 应答 / 版本协商）。
//
// 目标（第十批-B ①）：把 server.mjs 里散落的 `JSON.parse` + 手写 error 应答收拢成
// 一层可单测的纯函数，明确边界语义：
//   1. 请求 vs 通知 vs 响应：id 缺省即通知（不回响应）；带 result/error 的是响应
//      （本 server 不发请求，收到就当噪声忽略，不能反过来再回一帧）；
//   2. 批量数组：BridgeDeck 不声明 batch 能力，显式以 -32600 拒绝，而不是静默丢弃
//      或按数组逐条执行（MCP 2024-11-05 客户端不做 batch，拒绝比误解安全）；
//   3. 非法信封（jsonrpc 版本不符 / id 类型非法 / params 非对象）→ -32600；纯语法错误
//      → -32700；未知 method → -32601；未知 resource → -32002（与既有行为一致）；
//   4. 协议版本协商：客户端可请求 2024-11-05 / 2025-03-26 / 2025-06-18；不认识就回
//      本 server 的默认版本并带 `supported=false`，绝不假装支持；
//   5. 错误码映射：协议错误码（E_BAD_ARG / E_NOT_FOUND ...）→ JSON-RPC code 的单一
//      来源，resources/prompts/tools 三条错误路径共用，避免各自硬编码 -32602。
//
// 调用点：mcp/server.mjs 的 stdio 读循环（parseWireLine）、initialize（版本协商）、
// resources/prompts 错误映射、tools/call 的 -32603 兜底；tests/unit/mcp-wire.test.mjs 逐项断言。
// 纯函数、无 IO：不读文件、不写 stdout，便于离线测试。

/** JSON-RPC 2.0 固定版本串。 */
export const JSONRPC_VERSION = '2.0';

/** 标准 JSON-RPC 错误码 + MCP 自定义码（resources 相关沿用既有取值）。 */
export const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RESOURCE_NOT_FOUND: -32002,
  RESOURCE_UNAVAILABLE: -32001,
  RESOURCE_FORBIDDEN: -32003,
});

/** 可读的 code → 名称表（自测/_meta 诊断用）。 */
export const JSONRPC_ERROR_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(JSONRPC_ERRORS).map(([name, code]) => [code, name]),
));

/**
 * 本 server 支持的协议版本（新 → 旧）。客户端请求其中任何一个都原样回；
 * 未列出/缺失则回 DEFAULT_PROTOCOL_VERSION。新增版本时只改这张表。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** 默认协商结果（保持既有 initialize 应答不变：仍是 2024-11-05）。 */
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** 线格式限制：单行最大字节数（防止一张超大行撑爆内存）；id 最大长度。 */
export const WIRE_LIMITS = Object.freeze({
  maxLineBytes: 4 * 1024 * 1024,
  maxIdLength: 128,
});

/** 带 JSON-RPC code 的线上错误。 */
export class WireError extends Error {
  constructor(code, message, data = null, { rpcCode = JSONRPC_ERRORS.INTERNAL_ERROR } = {}) {
    super(String(message));
    this.name = 'WireError';
    this.code = code;
    this.rpcCode = rpcCode;
    this.data = data == null ? null : data;
  }
}

/** 标准错误应答对象（server 的 fail() 用）。 */
export function errorResponse(id, rpcCode, message, data = undefined) {
  const error = { code: rpcCode, message: String(message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error };
}

/** 成功应答对象。 */
export function resultResponse(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** 通知对象（无 id）。 */
export function notification(method, params = undefined) {
  const message = { jsonrpc: JSONRPC_VERSION, method: String(method) };
  if (params !== undefined) message.params = params;
  return message;
}

/** 序列化成一行 newline-delimited JSON（stdout 只放这个）。 */
export function serializeMessage(message) {
  return JSON.stringify(message) + '\n';
}

/** id 是否合法：string / number（有限）/ null（仅作为“无 id”的规范化结果）。 */
export function isValidId(id) {
  if (id === null) return true;
  if (typeof id === 'number') return Number.isFinite(id);
  if (typeof id === 'string') return id.length > 0 && id.length <= WIRE_LIMITS.maxIdLength;
  return false;
}

/** 请求/通知的 id 归一化：缺省 → null（通知语义）。 */
export function normalizeId(id) {
  return id === undefined ? null : id;
}

/**
 * 请求 id 的唯一键：字符串 "1" 与数字 1 是不同请求（JSON-RPC 规范），
 * 在途表/取消通知里必须区分，否则会把 1 的取消误投给 "1"。
 */
export function requestIdKey(id) {
  if (id === null || id === undefined) return 'null';
  if (typeof id === 'number') return 'n:' + String(id);
  return 's:' + String(id);
}

/** 判断一个已解析 JSON 值是否是“响应”（含 result 或 error）。 */
export function isResponseMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.prototype.hasOwnProperty.call(value, 'result') || Object.prototype.hasOwnProperty.call(value, 'error');
}

/** 判断是否通知（有 method、无 id）。 */
export function isNotificationMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.method === 'string' && !Object.prototype.hasOwnProperty.call(value, 'id');
}

/** 判断是否请求（有 method、有 id）。 */
export function isRequestMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.method === 'string' && Object.prototype.hasOwnProperty.call(value, 'id');
}

const KNOWN_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'initialized',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'shutdown',
  'exit',
]);

/** 通知型方法（没有 id 也必须被接受；带 id 时按规范忽略 id 不回响应）。 */
export const NOTIFICATION_METHODS = Object.freeze([
  'notifications/initialized',
  'initialized',
  'notifications/cancelled',
]);

/** server 声明支持的方法清单（initialize _meta / 测试核对；新增方法要同步这里）。 */
export const WIRE_METHODS = Object.freeze([...KNOWN_METHODS, 'notifications/cancelled']);

/**
 * 解析一行 stdio 文本。
 * @returns {{ ok:true, message:any } | { ok:false, error:{ rpcCode:number, message:string, id:(string|number|null) } }}
 */
export function parseWireLine(text) {
  const line = String(text == null ? '' : text).trim();
  if (!line) return { ok: false, error: { rpcCode: JSONRPC_ERRORS.PARSE_ERROR, message: 'Parse error: 空行', id: null } };
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > WIRE_LIMITS.maxLineBytes) {
    return {
      ok: false,
      error: {
        rpcCode: JSONRPC_ERRORS.INVALID_REQUEST,
        message: 'Invalid Request: 单行 ' + bytes + ' 字节超过上限 ' + WIRE_LIMITS.maxLineBytes,
        id: null,
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      error: { rpcCode: JSONRPC_ERRORS.PARSE_ERROR, message: 'Parse error: ' + String((error && error.message) || error), id: null },
    };
  }
  return { ok: true, message: parsed };
}

/**
 * 分类一条已解析的 JSON 值。
 * @returns {{
 *   kind:'request'|'notification'|'response'|'invalid',
 *   id:(string|number|null), method:(string|null), params:object|undefined,
 *   error:(null|{ rpcCode:number, code:string, message:string, id:any }),
 *   note:string|null,
 * }}
 */
export function classifyMessage(value) {
  if (Array.isArray(value)) {
    return invalidClassify(null, JSONRPC_ERRORS.INVALID_REQUEST, 'WIRE_BATCH_UNSUPPORTED', 'Invalid Request: 不支持 JSON-RPC batch 数组（逐条发送）');
  }
  if (!value || typeof value !== 'object') {
    return invalidClassify(null, JSONRPC_ERRORS.INVALID_REQUEST, 'WIRE_NOT_OBJECT', 'Invalid Request: 消息必须是 JSON 对象');
  }
  const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
  const id = hasId ? value.id : null;
  if (hasId && !isValidId(id)) {
    return invalidClassify(null, JSONRPC_ERRORS.INVALID_REQUEST, 'WIRE_BAD_ID', 'Invalid Request: id 必须是字符串/有限数字/null');
  }
  if (isResponseMessage(value)) {
    return {
      kind: 'response',
      id,
      method: null,
      params: undefined,
      error: null,
      note: 'server 不发送请求；收到响应按噪声忽略',
    };
  }
  if (typeof value.method !== 'string' || !value.method.trim()) {
    return invalidClassify(hasId ? id : null, JSONRPC_ERRORS.INVALID_REQUEST, 'WIRE_NO_METHOD', 'Invalid Request: 缺少字符串 method');
  }
  if (value.jsonrpc !== undefined && value.jsonrpc !== JSONRPC_VERSION) {
    return invalidClassify(hasId ? id : null, JSONRPC_ERRORS.INVALID_REQUEST, 'WIRE_BAD_VERSION', 'Invalid Request: jsonrpc 必须是 "2.0"');
  }
  let params;
  if (value.params !== undefined) {
    if (!value.params || typeof value.params !== 'object' || Array.isArray(value.params)) {
      return invalidClassify(hasId ? id : null, JSONRPC_ERRORS.INVALID_PARAMS, 'WIRE_BAD_PARAMS', 'Invalid params: params 必须是对象');
    }
    params = value.params;
  }
  const method = value.method;
  if (NOTIFICATION_METHODS.includes(method)) {
    return { kind: 'notification', id: null, method, params, error: null, note: '通知型方法（有 id 也不回响应）' };
  }
  if (!hasId) return { kind: 'notification', id: null, method, params, error: null, note: null };
  return { kind: 'request', id, method, params, error: null, note: null };
}

function invalidClassify(id, rpcCode, code, message) {
  return {
    kind: 'invalid',
    id: id === undefined ? null : id,
    method: null,
    params: undefined,
    error: { rpcCode, code, message, id: id === undefined ? null : id },
    note: null,
  };
}

/**
 * 严格解析 + 分类（server 读循环的一站式入口）。
 * @returns {{ ok:true, kind:string, id:any, method:any, params:any, note:any }
 *          | { ok:false, error:{ rpcCode:number, code:string, message:string, id:any } }}
 */
export function decodeWireLine(text) {
  const parsed = parseWireLine(text);
  if (!parsed.ok) {
    return { ok: false, error: { rpcCode: parsed.error.rpcCode, code: 'WIRE_PARSE', message: parsed.error.message, id: parsed.error.id } };
  }
  const classified = classifyMessage(parsed.message);
  if (classified.kind === 'invalid') return { ok: false, error: classified.error };
  return {
    ok: true,
    kind: classified.kind,
    id: classified.id,
    method: classified.method,
    params: classified.params,
    note: classified.note,
  };
}

/**
 * 协议版本协商。
 * @returns {{ version:string, requested:string|null, supported:boolean, fallback:boolean, reason:string, supportedVersions:ReadonlyArray<string> }}
 */
export function negotiateProtocolVersion(requested) {
  const asked = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  if (asked && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)) {
    return Object.freeze({
      version: asked,
      requested: asked,
      supported: true,
      fallback: false,
      reason: 'requested-version-supported',
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    });
  }
  return Object.freeze({
    version: DEFAULT_PROTOCOL_VERSION,
    requested: asked,
    supported: false,
    fallback: Boolean(asked),
    reason: asked ? 'requested-version-unsupported' : 'client-omitted-version',
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
  });
}

/**
 * 协议错误码 → JSON-RPC 错误码（单一来源）。
 * 语义分工：
 *   - 参数/枚举/用法类 → -32602（Invalid params）；
 *   - 资源缺失/过期类 → -32002（MCP Resource not found）；
 *   - 未知方法/未实现能力 → -32601；
 *   - 其余（session/daemon/internal）→ -32603。
 */
export const PROTOCOL_TO_JSONRPC = Object.freeze({
  E_BAD_ARG: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_MISSING: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_TYPE: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_ENUM: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_CONFLICT: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_REQUIRES: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_RANGE: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_UNEXPECTED: JSONRPC_ERRORS.INVALID_PARAMS,
  E_ARG_USAGE: JSONRPC_ERRORS.INVALID_PARAMS,
  E_UNKNOWN_FLAG: JSONRPC_ERRORS.INVALID_PARAMS,
  E_UNKNOWN_METHOD: JSONRPC_ERRORS.METHOD_NOT_FOUND,
  E_UNSUPPORTED: JSONRPC_ERRORS.METHOD_NOT_FOUND,
  E_UNSUPPORTED_CAPABILITY: JSONRPC_ERRORS.METHOD_NOT_FOUND,
  E_NOT_FOUND: JSONRPC_ERRORS.RESOURCE_NOT_FOUND,
  E_STALE_REF: JSONRPC_ERRORS.RESOURCE_NOT_FOUND,
  E_CURSOR_STALE: JSONRPC_ERRORS.RESOURCE_NOT_FOUND,
  E_OBSERVATION_STALE: JSONRPC_ERRORS.RESOURCE_NOT_FOUND,
  E_RESOURCE_NOT_FOUND: JSONRPC_ERRORS.RESOURCE_NOT_FOUND,
});

/** 取一个协议错误码对应的 JSON-RPC code（未登记 → -32603）。 */
export function jsonRpcCodeFor(errorCode) {
  return PROTOCOL_TO_JSONRPC[String(errorCode || '')] || JSONRPC_ERRORS.INTERNAL_ERROR;
}

/** 把一个带 code 的异常映射成 JSON-RPC 错误应答；未知异常 → -32603。 */
export function errorFromException(error, { fallbackCode = 'E_INTERNAL' } = {}) {
  const code = (error && error.code) || fallbackCode;
  const message = String((error && error.message) || error || 'internal error');
  return { rpcCode: jsonRpcCodeFor(code), code, message };
}

/**
 * 应答分类：server 主循环用它决定“回一帧 / 静默”。
 *  - request → 必须回；
 *  - notification → 绝不回（即使处理失败）；
 *  - response → 忽略；
 *  - invalid → 回错误帧（id 尽量回填，便于客户端关联）。
 */
export function responseMode(classified) {
  if (!classified || typeof classified !== 'object') return 'error';
  if (classified.kind === 'request') return 'reply';
  if (classified.kind === 'notification') return 'silent';
  if (classified.kind === 'response') return 'ignore';
  return 'error';
}

/** 线上能力快照（initialize 的 experimental['browser-bridge/wire'] 与测试共用）。 */
export function wireSnapshot({ negotiated = null } = {}) {
  return Object.freeze({
    jsonrpc: JSONRPC_VERSION,
    batch: false,
    batchErrorCode: JSONRPC_ERRORS.INVALID_REQUEST,
    methods: WIRE_METHODS,
    notificationMethods: Object.freeze([...NOTIFICATION_METHODS]),
    limits: WIRE_LIMITS,
    protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    defaultProtocolVersion: DEFAULT_PROTOCOL_VERSION,
    ...(negotiated ? { negotiated } : {}),
  });
}

/**
 * 自检：错误码映射表本身的一致性（启动期可以跑，也可以被单测直接断言）。
 * @returns {{ ok:boolean, errors:Array<{code:string,message:string}>, mapped:number }}
 */
export function auditWireTables() {
  const errors = [];
  const standard = new Set(Object.values(JSONRPC_ERRORS));
  for (const [code, rpcCode] of Object.entries(PROTOCOL_TO_JSONRPC)) {
    if (!/^E_[A-Z0-9_]+$/.test(code)) errors.push({ code: 'wire-code-shape', message: '协议错误码形状非法：' + code });
    if (!standard.has(rpcCode)) errors.push({ code: 'wire-rpc-code', message: code + ' 映射到未登记的 JSON-RPC code：' + rpcCode });
  }
  for (const method of WIRE_METHODS) {
    if (!/^[a-z]+(\/[a-z]+)+$/i.test(method) && !['initialize', 'initialized', 'ping', 'shutdown', 'exit'].includes(method)) {
      errors.push({ code: 'wire-method-shape', message: '方法名形状非法：' + method });
    }
  }
  for (const method of NOTIFICATION_METHODS) {
    if (!WIRE_METHODS.includes(method)) errors.push({ code: 'wire-method-missing', message: '通知方法未登记在 WIRE_METHODS：' + method });
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(DEFAULT_PROTOCOL_VERSION)) {
    errors.push({ code: 'wire-protocol-default', message: '默认协议版本不在支持列表：' + DEFAULT_PROTOCOL_VERSION });
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors.map((error) => Object.freeze(error))),
    mapped: Object.keys(PROTOCOL_TO_JSONRPC).length,
  });
}

/** strict 包装：映射表漂移时启动即失败（与 schema/策略审计一致的硬门禁风格）。 */
export function assertWireTables() {
  const report = auditWireTables();
  if (!report.ok) {
    throw new Error('MCP wire 表审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.message).join('\n'));
  }
  return report;
}
