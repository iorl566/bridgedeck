// packages/protocol/src/schema.ts —— 方法参数 schema 的类型化运行时：校验 + 派生 + 漂移审计。
//
// 与 lib/schemas.mjs 的 validateSchema / validateMethodParams / buildSchemaKeyTable /
// buildParamAliases / schemaCoverageSummary / schemaDriftReport 逐字段等价（差分测试对拍）。
// 数据全部来自 src/generated-schemas.ts（由 gen.mjs 从 lib/schemas.mjs 生成），本文件只实现
// “怎么校验、怎么派生”，不重复声明任何字段。
//
// 设计取舍：
// - validator 只实现 JS 基线支持的 JSON Schema 子集（type/properties/required/items/长度/
//   范围/枚举/pattern），未知关键字不解释 —— 与 lib/schemas.mjs 行为一致，避免“看起来更严格”；
// - 错误信息是稳定字符串（字段路径 + 中文原因），CLI/MCP 直接透传给用户；
// - 派生表与漂移报告的字段顺序/形态与 JS 完全一致，便于 CLI/门禁共用同一份判定。

import { EXTENSION_METHODS, REQUEST_ENVELOPE_KEYS } from './generated.ts';
import {
  ENVELOPE_PROPERTY_SCHEMAS,
  ENVELOPE_SCHEMA_KEYS,
  METHOD_SCHEMAS,
} from './generated-schemas.ts';
import type {
  JsonSchema,
  SchemaCoverageSummary,
  SchemaDriftOptions,
  SchemaDriftReport,
  SchemaKeyRow,
} from './schema-types.ts';

/** 无显式 schema 的方法使用的通用信封 schema（与 JS 基线同义）。 */
export const GENERIC_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze(envelopeProperties()),
});

/** 方法名 → schema 的宽松查表（未命中返回 undefined，不抛错）。 */
const SCHEMAS_BY_NAME: Readonly<Record<string, JsonSchema | undefined>> =
  METHOD_SCHEMAS as Readonly<Record<string, JsonSchema | undefined>>;

/** 由目录信封键生成 properties（未知键跳过，与 JS 的 envelopeProperties() 一致）。 */
function envelopeProperties(): Record<string, JsonSchema> {
  const properties: Record<string, JsonSchema> = {};
  for (const key of ENVELOPE_SCHEMA_KEYS) {
    const schema = ENVELOPE_PROPERTY_SCHEMAS[key];
    if (schema) properties[key] = schema;
  }
  return properties;
}

/** 请求公共信封键（目录派生；稳定导出名）。 */
export const SCHEMA_ENVELOPE_KEYS = ENVELOPE_SCHEMA_KEYS;

/** 有显式 schema 的方法数（生成时快照）。 */
export const SCHEMA_COUNT = Object.keys(METHOD_SCHEMAS).length;

// ---------------------------------------------------------------------------
// 派生表（生成器与审计共用，不在各处再手写一份 key/别名表）
// ---------------------------------------------------------------------------

/** 方法 → {required, properties}；两个数组都排序（与 JS buildSchemaKeyTable 一致）。 */
export function buildSchemaKeyTable(
  schemas: Readonly<Record<string, JsonSchema>> = METHOD_SCHEMAS,
): Record<string, SchemaKeyRow> {
  const table: Record<string, SchemaKeyRow> = {};
  for (const [method, schema] of Object.entries(schemas)) {
    const properties = schema && schema.properties ? Object.keys(schema.properties).sort() : [];
    table[method] = {
      required: Array.isArray(schema?.required) ? [...schema.required].sort() : [],
      properties,
    };
  }
  return table;
}

/** camelCase → snake_case 参数别名（只保留有驼峰字段的方法）。 */
export function buildParamAliases(
  schemas: Readonly<Record<string, JsonSchema>> = METHOD_SCHEMAS,
): Record<string, Record<string, string>> {
  const aliases: Record<string, Record<string, string>> = {};
  for (const [method, schema] of Object.entries(schemas)) {
    const map: Record<string, string> = {};
    const properties = schema && schema.properties ? Object.keys(schema.properties).sort() : [];
    for (const key of properties) {
      const snake = camelToSnake(key);
      if (snake !== key) map[snake] = key;
    }
    if (Object.keys(map).length) aliases[method] = map;
  }
  return aliases;
}

/** camelCase → snake_case 的换形规则（与 JS 的 replace(/[A-Z]/g, '_x') 一致）。 */
export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase());
}

/** 方法 schema 覆盖与信封派生摘要（CLI/门禁/测试共用）。 */
export function schemaCoverageSummary(
  methods: ReadonlySet<string> | readonly string[] = EXTENSION_METHODS,
  schemas: Readonly<Record<string, JsonSchema>> = METHOD_SCHEMAS,
): SchemaCoverageSummary {
  const names: string[] = methods instanceof Set ? [...(methods as ReadonlySet<string>)] : [...methods];
  const missing = names.filter((method) => !schemas[method]).sort();
  const present = names.filter((method) => schemas[method]);
  const withoutEnvelope = present
    .filter((method) => {
      const properties = (schemas[method] && schemas[method].properties) || {};
      return !REQUEST_ENVELOPE_KEYS.every((key) => key in properties);
    })
    .sort();
  const keyTable = buildSchemaKeyTable(schemas);
  const propertyCount = Object.values(keyTable).reduce((sum, row) => sum + row.properties.length, 0);
  return {
    methods: names.length,
    schemas: Object.keys(schemas).length,
    covered: present.length,
    missing,
    withoutEnvelope,
    validatedMethods: Object.keys(keyTable).length,
    propertyCount,
    aliasedMethods: Object.keys(buildParamAliases(schemas)).length,
    envelope: [...REQUEST_ENVELOPE_KEYS],
  };
}

// ---------------------------------------------------------------------------
// 校验器（lib/schemas.mjs 的最小 JSON Schema 子集）
// ---------------------------------------------------------------------------

/** 运行期值类型名（数组归 array，null 归 null，其余 typeof）。 */
function valueType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** 类型匹配：integer 要求整数，number 要求有限数，其余按运行期类型名比较。 */
function typeMatches(value: unknown, type: string): boolean {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return valueType(value) === type;
}

/** 递归校验单个值（数组元素 / 对象字段 / 标量约束）。 */
function checkValue(
  value: unknown,
  schema: JsonSchema | null | undefined,
  path: string,
  errors: string[],
): void {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(path + ' 应为 ' + schema.type);
    return;
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(path + ' 至少 ' + schema.minItems + ' 项');
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(path + ' 最多 ' + schema.maxItems + ' 项');
    }
    if (schema.items) {
      value.forEach((item, index) => checkValue(item, schema.items, path + '[' + index + ']', errors));
    }
  }
  if (schema.type === 'object' && valueType(value) === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (record[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (record[key] !== undefined) checkValue(record[key], child, path + '.' + key, errors);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(path + ' 长度至少 ' + schema.minLength);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(path + ' 长度最多 ' + schema.maxLength);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(path + ' 不能小于 ' + schema.minimum);
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    errors.push(path + ' 不能大于 ' + schema.maximum);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(path + ' 格式不匹配 ' + schema.pattern);
  }
}

/** 返回 [] 表示通过，否则返回字段错误列表（与 JS validateSchema 逐字符一致）。 */
export function validateSchema(
  schema: JsonSchema | null | undefined,
  value: unknown,
  path = 'params',
): string[] {
  const errors: string[] = [];
  if (!schema) return errors;
  if (schema.type === 'object') {
    if (valueType(value) !== 'object') {
      errors.push(path + ' 应为 object');
      return errors;
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required || []) {
      if (record[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined) checkValue(record[key], child, path + '.' + key, errors);
    }
  } else {
    checkValue(value, schema, path, errors);
  }
  return errors;
}

/** 按方法名校验参数：无显式 schema 时用通用信封 schema（未知方法不抛错）。 */
export function validateMethodParams(method: unknown, params: unknown): string[] {
  const schema = SCHEMAS_BY_NAME[String(method)] || GENERIC_SCHEMA;
  if (!schema) return [];
  return validateSchema(schema, params && typeof params === 'object' ? params : {}, 'params');
}

// ---------------------------------------------------------------------------
// 漂移报告（tools/schema-audit.mjs 与 tests 共用同一份判定）
// ---------------------------------------------------------------------------

/**
 * schema 漂移报告：覆盖、信封派生、字段类型、required 引用。
 * 与 lib/schemas.mjs 的 schemaDriftReport 逐字段一致；`unknownSchemas` 允许非空
 * （daemon 侧 transfer.* / session.* 等 schema 不属于扩展方法集）。
 */
export function schemaDriftReport(options: SchemaDriftOptions = {}): SchemaDriftReport {
  const methods: ReadonlySet<string> = options.methods instanceof Set
    ? (options.methods as ReadonlySet<string>)
    : new Set(options.methods || EXTENSION_METHODS);
  const schemas: Readonly<Record<string, JsonSchema>> =
    options.schemas && typeof options.schemas === 'object' ? options.schemas : METHOD_SCHEMAS;
  const problems: string[] = [];
  let checked = 0;
  const allowedExtra = new Set(options.allowedExtraSchemas || ['status', 'browsers']);
  for (const method of [...methods].sort()) {
    const schema = schemas[method];
    if (!schema) {
      problems.push(method + ' 缺少 METHOD_SCHEMAS 条目');
      continue;
    }
    if (schema.type !== 'object') problems.push(method + ' schema.type 不是 object');
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      problems.push(method + ' schema.properties 缺失或类型错误');
      continue;
    }
    checked += 1;
    for (const [key, value] of Object.entries(properties)) {
      if (!key || typeof key !== 'string') problems.push(method + ' schema 存在空字段名');
      if (!value || typeof value !== 'object') problems.push(method + '.' + key + ' 属性不是对象');
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in properties)) problems.push(method + ' required 引用了未声明字段：' + key);
    }
  }
  const unknownSchemas = Object.keys(schemas)
    .filter((method) => !methods.has(method) && !allowedExtra.has(method))
    .sort();
  const summary = schemaCoverageSummary(methods, schemas);
  return {
    ok: problems.length === 0,
    methods: methods.size,
    schemas: Object.keys(schemas).length,
    checked,
    problems,
    unknownSchemas,
    derived: {
      schemaKeys: Object.keys(buildSchemaKeyTable(schemas)).length,
      paramAliases: Object.keys(buildParamAliases(schemas)).length,
      envelope: [...REQUEST_ENVELOPE_KEYS],
      missing: summary.missing,
      withoutEnvelope: summary.withoutEnvelope,
      propertyCount: summary.propertyCount,
    },
  };
}
