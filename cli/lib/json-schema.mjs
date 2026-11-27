// cli/lib/json-schema.mjs —— CLI 侧结构化 JSON 契约（schema 注册表 + 校验 + 形状摘要）。
//
// 为什么 CLI 需要自己的 schema 层：
// - `--json` 的输出契约（cli/lib/json-contract.mjs）只约束"信封"，不约束 `result` 的形状；
// - 批处理/租约裁决这类新结果层级很深（items/steps/verdicts），一旦 daemon 字段漂移，
//   jq/脚本消费方会静默拿到 undefined。本模块给这些结果登记**显式 schema**，
//   新命令可以用 `--strict` 在输出前自检（不通过 → 退出码 1，并在 stderr 指出字段路径）；
// - 同时提供 schema 文档（`--print-schema`）与 shape 摘要（digest），便于测试断言"只增字段"。
//
// 设计约束：
// - 零依赖、纯函数：校验器是手写的小型 JSON Schema 子集（type/required/properties/items/
//   enum/oneOf/const/数值区间/字符串长度/正则/可空），足够覆盖本仓库的 result 形状；
// - 未知字段默认允许（additionalProperties=true）：daemon 只做加法，CLI 不应因新字段失败；
// - schema 只描述"必须存在且类型正确"，不参与业务计算；默认不启用，只有 --strict 才校验。
//
// 用法（CLI 命令层）：
//   import { validateSchema, assertSchema, describeSchema, schemaDigest } from '../lib/json-schema.mjs';
//   const checked = validateSchema('bb.session-batch/1', result);
//   if (!checked.ok) throw new BridgeError('E_INTERNAL', checked.problems.join('; '));

/** schema 子集支持的节点类型。 */
export const SCHEMA_TYPES = Object.freeze([
  'object', 'array', 'string', 'number', 'integer', 'boolean', 'null',
]);

/** 已登记 schema 的版本 id（顺序稳定）。 */
export const SCHEMA_IDS = Object.freeze([
  'bb.session-batch/1',
  'bb.session-batch-plan/1',
  'bb.session-quota/1',
  'bb.lease-arbitration/1',
  'bb.status-views/1',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSchemaNode(value) {
  return isPlainObject(value);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function describeValue(value, depth = 0) {
  if (depth > 2) return '<deep>';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  const type = typeof value;
  if (type === 'string') return 'string(' + value.length + ')';
  if (type === 'number' || type === 'boolean') return type + '(' + String(value) + ')';
  if (type === 'object') {
    const keys = Object.keys(value).slice(0, 6);
    return 'object{' + keys.join(',') + (Object.keys(value).length > keys.length ? ',…' : '') + '}';
  }
  return type;
}

/** 单字段 schema 节点校验（内部递归）。 */
function validateNode(schema, value, path, problems) {
  if (!isSchemaNode(schema)) {
    problems.push(path + ': schema 节点不是对象');
    return;
  }
  if (schema.oneOf !== undefined) {
    const candidates = Array.isArray(schema.oneOf) ? schema.oneOf : [];
    const matches = candidates.filter((candidate) => {
      const nested = [];
      validateNode(candidate, value, path, nested);
      return nested.length === 0;
    });
    if (matches.length !== 1) problems.push(path + ': oneOf 需要恰好匹配 1 个分支（实际 ' + matches.length + '）');
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(path + ': 期望常量 ' + JSON.stringify(schema.const) + '，实际 ' + JSON.stringify(value));
    return;
  }
  if (value === null) {
    if (schema.nullable === true || schema.type === 'null') return;
    problems.push(path + ': 不允许为 null');
    return;
  }
  const expected = schema.type;
  const actual = typeOf(value);
  if (expected && expected !== actual && !(expected === 'number' && actual === 'integer')) {
    problems.push(path + ': 类型应为 ' + expected + '，实际 ' + actual + '（' + describeValue(value) + '）');
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(path + ': 取值 ' + JSON.stringify(value) + ' 不在枚举 [' + schema.enum.join(',') + ']');
    return;
  }
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(path + ': 字符串长度 < ' + schema.minLength);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(path + ': 字符串长度 > ' + schema.maxLength);
    if (schema.pattern !== undefined && !(schema.pattern instanceof RegExp) && !new RegExp(schema.pattern).test(value)) {
      problems.push(path + ': 字符串不匹配 ' + String(schema.pattern));
    }
    if (schema.pattern instanceof RegExp && !schema.pattern.test(value)) problems.push(path + ': 字符串不匹配 ' + schema.pattern);
  }
  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(path + ': 数值 < ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(path + ': 数值 > ' + schema.maximum);
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(path + ': 数组长度 < ' + schema.minItems);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(path + ': 数组长度 > ' + schema.maxItems);
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateNode(schema.items, item, path + '[' + index + ']', problems));
    }
  }
  if (actual === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(path + '.' + key + ': 缺少必填字段');
    }
    const properties = isSchemaNode(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      validateNode(childSchema, value[key], path + '.' + key, problems);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) problems.push(path + '.' + key + ': 未登记字段（additionalProperties=false）');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// schema 注册表
// ---------------------------------------------------------------------------

const ITEM_SCHEMA = Object.freeze({
  type: 'object',
  required: ['index', 'state', 'attempts'],
  properties: {
    index: { type: 'integer', minimum: 0 },
    key: { type: 'string', nullable: true },
    url: { type: 'string', nullable: true },
    browser: { type: 'string', nullable: true },
    label: { type: 'string', nullable: true },
    share: { type: 'boolean' },
    tab: { type: 'integer', nullable: true, minimum: 0 },
    priority: { type: 'integer', minimum: -10, maximum: 10 },
    group: { type: 'string', nullable: true },
    retries: { type: 'integer', nullable: true, minimum: 0, maximum: 3 },
    timeoutMs: { type: 'integer', nullable: true, minimum: 1000, maximum: 300_000 },
    state: { type: 'string', enum: ['pending', 'starting', 'succeeded', 'failed', 'denied', 'cancelled', 'skipped', 'rolled-back'] },
    admission: { type: 'string', enum: ['unknown', 'admitted', 'denied'] },
    attempts: { type: 'integer', minimum: 0, maximum: 4 },
    sessionId: { type: 'string', nullable: true },
    navigated: { type: 'boolean' },
    cleanup: { type: 'string', nullable: true },
    startedAt: { type: 'integer', minimum: 0 },
    finishedAt: { type: 'integer', minimum: 0 },
    durationMs: { type: 'integer', minimum: 0 },
    error: {
      type: 'object',
      nullable: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string' },
        data: { type: 'object', nullable: true, additionalProperties: true },
        cleanup: { type: 'object', nullable: true, additionalProperties: true },
      },
    },
  },
});

const SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  required: ['total', 'succeeded', 'failed'],
  properties: {
    total: { type: 'integer', minimum: 0 },
    admitted: { type: 'integer', minimum: 0 },
    denied: { type: 'integer', minimum: 0 },
    attempted: { type: 'integer', minimum: 0 },
    pending: { type: 'integer', minimum: 0 },
    starting: { type: 'integer', minimum: 0 },
    succeeded: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    cancelled: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    rolledBack: { type: 'integer', minimum: 0 },
    retried: { type: 'integer', minimum: 0 },
    sessionsCreated: { type: 'integer', minimum: 0 },
    navigated: { type: 'integer', minimum: 0 },
  },
});

const QUOTA_SCHEMA = Object.freeze({
  type: 'object',
  required: ['policy', 'live', 'reserved', 'available'],
  properties: {
    schema: { type: 'integer', minimum: 1 },
    kind: { type: 'string' },
    at: { type: 'integer', minimum: 0 },
    generatedAt: { type: 'string' },
    policy: {
      type: 'object',
      required: ['maxSessions', 'maxPerBatch', 'maxConcurrentStarts'],
      properties: {
        maxSessions: { type: 'integer', minimum: 1 },
        maxPerBatch: { type: 'integer', minimum: 1 },
        maxConcurrentStarts: { type: 'integer', minimum: 1 },
        maxPerInstance: { type: 'integer', minimum: 1 },
        maxBatchItems: { type: 'integer', minimum: 1 },
        reservationTtlMs: { type: 'integer', minimum: 1 },
      },
    },
    live: { type: 'integer', minimum: 0 },
    reserved: { type: 'integer', minimum: 0 },
    used: { type: 'integer', minimum: 0 },
    available: { type: 'integer', minimum: 0 },
    usagePercent: { type: 'number', minimum: 0 },
    saturated: { type: 'boolean' },
    instances: { type: 'array', items: { type: 'object', required: ['instanceId', 'live'], properties: { instanceId: { type: 'string' }, live: { type: 'integer', minimum: 0 } } } },
    batches: { type: 'array', items: { type: 'object', additionalProperties: true } },
    totals: { type: 'object', additionalProperties: true },
    counters: { type: 'object', additionalProperties: true },
  },
});

/** 注册表：schema id → 校验结构。新增字段只加不改；id 里的 /1 是版本号。 */
export const SCHEMAS = Object.freeze({
  'bb.session-batch/1': Object.freeze({
    id: 'bb.session-batch/1',
    title: 'session batch（batch.start / batch.status 的 result）',
    schema: Object.freeze({
      type: 'object',
      required: ['batchId', 'state', 'items', 'summary', 'quota'],
      properties: {
        schema: { type: 'integer', minimum: 1 },
        kind: { type: 'string', const: 'bridge/session-batch' },
        batchId: { type: 'string', minLength: 1, maxLength: 80 },
        state: { type: 'string', enum: ['planning', 'running', 'completed', 'aborted', 'cancelled', 'rolled-back', 'failed'] },
        outcome: { type: 'string', enum: ['ok', 'partial', 'failed', 'quota-denied', 'cancelled', 'rolled-back'] },
        createdAt: { type: 'integer', minimum: 0 },
        startedAt: { type: 'integer', minimum: 0 },
        finishedAt: { type: 'integer', minimum: 0 },
        durationMs: { type: 'integer', minimum: 0 },
        group: { type: 'string', nullable: true },
        onError: { type: 'string', enum: ['continue', 'abort', 'rollback'] },
        concurrency: { type: 'integer', minimum: 1, maximum: 32 },
        retries: { type: 'integer', minimum: 0 },
        timeoutMs: { type: 'integer', minimum: 1000 },
        priority: { type: 'integer', minimum: -10, maximum: 10 },
        quota: { type: 'object', additionalProperties: true },
        summary: SUMMARY_SCHEMA,
        items: { type: 'array', items: ITEM_SCHEMA },
        cancelled: { type: 'boolean' },
        rollback: { type: 'object', nullable: true, additionalProperties: true },
        warnings: { type: 'array', items: { type: 'string' } },
        reused: { type: 'boolean' },
      },
    }),
  }),
  'bb.session-batch-plan/1': Object.freeze({
    id: 'bb.session-batch-plan/1',
    title: 'session batch plan（batch.plan / batch.start dryRun 的 result）',
    schema: Object.freeze({
      type: 'object',
      required: ['dryRun', 'items', 'summary', 'quota'],
      properties: {
        schema: { type: 'integer', minimum: 1 },
        kind: { type: 'string', const: 'bridge/session-batch-plan' },
        dryRun: { type: 'boolean', const: true },
        plannedAt: { type: 'integer', minimum: 0 },
        policy: { type: 'object', additionalProperties: true },
        quota: {
          type: 'object',
          required: ['decisions', 'totals'],
          properties: {
            decisions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            totals: { type: 'object', additionalProperties: true },
          },
        },
        spec: { type: 'object', additionalProperties: true },
        items: { type: 'array', items: {
          type: 'object',
          required: ['index', 'admission'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            admission: { type: 'string', enum: ['admit', 'deny'] },
            reason: { type: 'string' },
            key: { type: 'string', nullable: true },
            url: { type: 'string', nullable: true },
          },
        } },
        summary: {
          type: 'object',
          required: ['total', 'admissable', 'denied'],
          properties: {
            total: { type: 'integer', minimum: 0 },
            admissable: { type: 'integer', minimum: 0 },
            denied: { type: 'integer', minimum: 0 },
            estimatedStarts: { type: 'integer', minimum: 0 },
            concurrency: { type: 'integer', minimum: 1 },
            maxParallelObserved: { type: 'integer', minimum: 0 },
            policyMaxSessions: { type: 'integer', minimum: 1 },
            liveSessions: { type: 'integer', minimum: 0 },
            reserved: { type: 'integer', minimum: 0 },
          },
        },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    }),
  }),
  'bb.session-quota/1': Object.freeze({
    id: 'bb.session-quota/1',
    title: 'session quota（batch.quota / status views=batch.quota 的 result）',
    schema: QUOTA_SCHEMA,
  }),
  'bb.lease-arbitration/1': Object.freeze({
    id: 'bb.lease-arbitration/1',
    title: 'lease arbitration（lease.report / lease.arbitrate 的 result）',
    schema: Object.freeze({
      type: 'object',
      required: ['kind', 'verdicts', 'steps', 'summary'],
      properties: {
        schema: { type: 'integer', minimum: 1 },
        kind: { type: 'string', const: 'bridge/lease-arbitration' },
        mode: { type: 'string', nullable: true },
        at: { type: 'integer', minimum: 0 },
        generatedAt: { type: 'string' },
        policy: {
          type: 'object',
          required: ['strategy', 'limit'],
          properties: {
            strategy: { type: 'string', enum: ['fifo', 'lru', 'priority', 'holder'] },
            preempt: { type: 'boolean' },
            allowForce: { type: 'boolean' },
            reviveWindowMs: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            includeClean: { type: 'boolean' },
            by: { type: 'string' },
          },
        },
        tabId: { type: 'integer', nullable: true },
        verdicts: { type: 'array', items: {
          type: 'object',
          required: ['tabId', 'action', 'severity', 'conflictCodes'],
          properties: {
            tabId: { type: 'integer', minimum: 0 },
            action: { type: 'string', enum: ['promote', 'release', 'attach', 'adopt', 'prune', 'repair', 'dedupe', 'drop-control', 'none'] },
            severity: { type: 'string', enum: ['high', 'warn', 'info'] },
            conflictCodes: { type: 'array', items: { type: 'string' } },
            reportOnly: { type: 'boolean' },
            deferred: { type: 'boolean' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            winner: { type: 'object', nullable: true, additionalProperties: true },
            losers: { type: 'array', items: { type: 'object', additionalProperties: true } },
            candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
            steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        } },
        steps: { type: 'array', items: {
          type: 'object',
          required: ['index', 'op', 'tabId'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            op: { type: 'string', enum: ['transfer', 'release', 'acquire', 'join', 'prune', 'drop-control', 'repair'] },
            tabId: { type: 'integer', minimum: 0 },
            reason: { type: 'string' },
            args: { type: 'object', additionalProperties: true },
          },
        } },
        summary: {
          type: 'object',
          required: ['verdicts', 'actionable', 'reportOnly', 'conflicts'],
          properties: {
            tabs: { type: 'integer', minimum: 0 },
            leases: { type: 'integer', minimum: 0 },
            sessions: { type: 'integer', minimum: 0 },
            conflicts: { type: 'integer', minimum: 0 },
            verdicts: { type: 'integer', minimum: 0 },
            cleanTabs: { type: 'integer', minimum: 0 },
            actionable: { type: 'integer', minimum: 0 },
            reportOnly: { type: 'integer', minimum: 0 },
            deferred: { type: 'integer', minimum: 0 },
            steps: { type: 'integer', minimum: 0 },
            highSeverity: { type: 'integer', minimum: 0 },
            warnSeverity: { type: 'integer', minimum: 0 },
            infoSeverity: { type: 'integer', minimum: 0 },
            byAction: { type: 'object', additionalProperties: true },
            byCode: { type: 'object', additionalProperties: true },
            winners: { type: 'array', items: { type: 'string' } },
          },
        },
        applied: { type: 'object', nullable: true, additionalProperties: true },
        residual: { type: 'object', nullable: true, additionalProperties: true },
        truncated: { type: 'boolean' },
        controls: { type: 'integer', minimum: 0 },
      },
    }),
  }),
  'bb.status-views/1': Object.freeze({
    id: 'bb.status-views/1',
    title: 'status 增量视图信封（views 请求后的 daemon.status result）',
    schema: Object.freeze({
      type: 'object',
      required: ['service', 'version', 'browsers', 'sessions', 'views'],
      properties: {
        service: { type: 'string' },
        version: { type: 'string' },
        protocol: { type: 'string' },
        pid: { type: 'integer', minimum: 1 },
        port: { type: 'integer', minimum: 0 },
        uptimeMs: { type: 'integer', minimum: 0 },
        browsers: { type: 'array' },
        sessions: { type: 'array' },
        inflight: { type: 'array' },
        queues: { type: 'array' },
        auth: { type: 'object', additionalProperties: true },
        recovery: { type: 'object', additionalProperties: true },
        compatibility: { type: 'object', additionalProperties: true },
        views: { type: 'array', items: { type: 'string' } },
        unknownViews: { type: 'array', items: { type: 'string' } },
        ledger: { type: 'object', nullable: true, additionalProperties: true },
        transfers: { type: 'object', nullable: true, additionalProperties: true },
        queue: { type: 'object', nullable: true, additionalProperties: true },
        doctor: { type: 'object', nullable: true, additionalProperties: true },
        leases: { type: 'object', nullable: true, additionalProperties: true },
        boundary: { type: 'object', nullable: true, additionalProperties: true },
        batch: {
          type: 'object',
          nullable: true,
          required: ['quota', 'recent', 'totals'],
          properties: {
            schema: { type: 'integer', minimum: 1 },
            kind: { type: 'string' },
            quota: QUOTA_SCHEMA,
            recent: { type: 'array', items: { type: 'object', additionalProperties: true } },
            running: { type: 'array', items: { type: 'string' } },
            totals: { type: 'object', additionalProperties: true },
          },
        },
        arbitration: {
          type: 'object',
          nullable: true,
          required: ['kind', 'verdicts', 'summary'],
          properties: {
            kind: { type: 'string' },
            verdicts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
            summary: { type: 'object', additionalProperties: true },
          },
        },
      },
    }),
  }),
});

/** 取一份 schema 的说明（未知 id 返回 null）。 */
export function getSchema(schemaId) {
  return SCHEMAS[String(schemaId || '')] || null;
}

/** 列出全部 schema 的元信息（顺序稳定）。 */
export function listSchemas() {
  return SCHEMA_IDS.map((id) => {
    const entry = SCHEMAS[id];
    return { id, title: entry.title };
  });
}

/**
 * 校验任意值是否符合 schema 节点。
 * @returns {string[]} 问题列表（空数组 = 合规）
 */
export function validateAgainstSchema(schema, value) {
  const problems = [];
  validateNode(schema, value, '$', problems);
  return problems;
}

/**
 * 按 id 校验。
 * @returns {{ok: boolean, schemaId: string, problems: string[], checkedAt: number}}
 */
export function validateSchema(schemaId, value) {
  const entry = getSchema(schemaId);
  if (!entry) {
    return { ok: false, schemaId: String(schemaId || ''), problems: ['未登记的 schema id：' + String(schemaId || '')], checkedAt: Date.now() };
  }
  const problems = validateAgainstSchema(entry.schema, value);
  return { ok: problems.length === 0, schemaId: entry.id, problems, checkedAt: Date.now() };
}

/**
 * 断言校验通过；失败时抛出 ErrorType（默认 Error），错误对象带 code=E_INTERNAL 与 problems。
 * CLI 命令层在 --strict 模式下调用它，把 schema 漂移升级为可诊断错误。
 */
export function assertSchema(schemaId, value, { ErrorType = Error, code = 'E_INTERNAL' } = {}) {
  const result = validateSchema(schemaId, value);
  if (result.ok) return result;
  const message = 'JSON schema 校验失败（' + result.schemaId + '）：' + result.problems.join('；');
  const error = ErrorType === Error ? new Error(message) : new ErrorType(code, message);
  if (error.code === undefined) error.code = code;
  error.problems = result.problems;
  error.schemaId = result.schemaId;
  throw error;
}

/** 取 schema 的深拷贝（CLI --print-schema 输出用）。 */
export function describeSchema(schemaId) {
  const entry = getSchema(schemaId);
  if (!entry) return null;
  return { id: entry.id, title: entry.title, schema: entry.schema };
}

/** schema 说明表：id + 标题 + 顶层必填字段。 */
export function schemaTable() {
  return SCHEMA_IDS.map((id) => {
    const entry = SCHEMAS[id];
    const schema = entry.schema || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    return { id, title: entry.title, required: required.join(',') };
  });
}

/** FNV-1a 32 位摘要 → 8 位十六进制（测试/日志里对"形状"做稳定指纹）。 */
export function schemaDigest(value) {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 稳定序列化：对象键排序、数组保序、跳过函数；用于 digest 与测试断言。 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'function') return '"[fn]"';
      if (typeof node === 'bigint') return JSON.stringify(String(node));
      return JSON.stringify(node);
    }
    if (seen.has(node)) return '"<cycle>"';
    seen.add(node);
    if (Array.isArray(node)) return '[' + node.map(walk).join(',') + ']';
    const keys = Object.keys(node).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + walk(node[key])).join(',') + '}';
  };
  return walk(value);
}

/**
 * 形状摘要：只保留类型与键名（截断深度），用于断言"字段只增不减"与日志排障。
 * 例：{a:1, b:[{c:true}]} → {a:'number', b:['object{c:boolean}']}
 */
export function compactShape(value, { depth = 3, maxKeys = 30 } = {}) {
  const walk = (node, level) => {
    if (node === null) return 'null';
    if (Array.isArray(node)) {
      if (level >= depth) return 'array(' + node.length + ')';
      return node.slice(0, 3).map((item) => walk(item, level + 1));
    }
    if (typeof node === 'object') {
      if (level >= depth) return 'object';
      const keys = Object.keys(node).sort().slice(0, maxKeys);
      const out = {};
      for (const key of keys) out[key] = walk(node[key], level + 1);
      out.__keys = Object.keys(node).length;
      return out;
    }
    return typeof node;
  };
  return walk(value, 0);
}

/** 两个形状摘要的差异（只报告"消失的键"与"类型变化"，新增键不算问题）。 */
export function diffShape(expected, actual, path = '$') {
  const differences = [];
  if (expected === null || typeof expected !== 'object') {
    // compactShape 对基础类型返回类型字符串（'number' / 'boolean' / ...），直接按值比较。
    if (expected !== actual) differences.push({ path, expected, actual });
    return differences;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      differences.push({ path, expected: 'array', actual: typeof actual });
      return differences;
    }
    if (actual.length) differences.push(...diffShape(expected[0], actual[0], path + '[0]'));
    return differences;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    differences.push({ path, expected: 'object', actual: actual === null ? 'null' : typeof actual });
    return differences;
  }
  const expectedKeys = Object.keys(expected).filter((key) => key !== '__keys');
  for (const key of expectedKeys) {
    if (!(key in actual)) {
      differences.push({ path: path + '.' + key, expected: 'present', actual: 'missing' });
      continue;
    }
    differences.push(...diffShape(expected[key], actual[key], path + '.' + key));
  }
  return differences;
}
