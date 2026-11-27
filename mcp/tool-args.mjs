// mcp/tool-args.mjs —— MCP 工具入参的运行时校验（JSON Schema 子集）。
//
// 为什么需要：inputSchema 已经声明了类型/枚举/范围/必填，但 server 之前的 tools/call
// 直接把 arguments 丢给 run()——模型把 `tab_id` 写成字符串、把 `limit` 写成 -1、或塞
// 一个 schema 没声明的字段，都会被静默忽略/带进 RPC。这里在调用前做一次与 schema
// 完全同源的校验，错误按协议错误码分类返回（E_ARG_MISSING / E_ARG_TYPE / ...）。
//
// 只实现工具 schema 实际用到的那部分 JSON Schema：
//   type（含 type 数组联合）、required、properties、additionalProperties:false、
//   enum、minimum/maximum、minLength、minItems/maxItems、items（字符串数组）。
// 不依赖第三方库（冻结约束：不新增依赖）。
//
// 调用点：mcp/server.mjs tools/call（运行时门禁）；sdk/index.mjs 的 tool 调用复用同一
// 校验器（SDK 与 MCP 客户端看到的错误码一致）。

/** 校验错误 → 协议错误码。 */
export const ARG_ERROR_CODES = Object.freeze({
  MISSING: 'E_ARG_MISSING',
  TYPE: 'E_ARG_TYPE',
  ENUM: 'E_ARG_ENUM',
  RANGE: 'E_ARG_RANGE',
  UNEXPECTED: 'E_ARG_UNEXPECTED',
});

/** 单个值的 JSON 类型（整数单独判定，因为 schema 用 integer 而不是 number）。 */
export function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = valueType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (Array.isArray(value)) return 'array(' + value.length + ')';
  return typeof value;
}

function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  const expected = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  if (expected && !expected.some((type) => typeMatches(type, value))) {
    errors.push({ code: ARG_ERROR_CODES.TYPE, path, message: '期望 ' + expected.join('|') + '，实际 ' + valueType(value) + '（' + describe(value) + '）' });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
    errors.push({ code: ARG_ERROR_CODES.ENUM, path, message: '取值必须是 ' + schema.enum.map((item) => JSON.stringify(item)).join('|') + '，实际 ' + describe(value) });
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ code: ARG_ERROR_CODES.RANGE, path, message: '不能小于 ' + schema.minimum + '，实际 ' + value });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ code: ARG_ERROR_CODES.RANGE, path, message: '不能大于 ' + schema.maximum + '，实际 ' + value });
    }
  }
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ code: ARG_ERROR_CODES.RANGE, path, message: '长度不能小于 ' + schema.minLength + '，实际 ' + value.length });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ code: ARG_ERROR_CODES.RANGE, path, message: '至少需要 ' + schema.minItems + ' 项，实际 ' + value.length });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ code: ARG_ERROR_CODES.RANGE, path, message: '最多允许 ' + schema.maxItems + ' 项，实际 ' + value.length });
    }
    if (schema.items) value.forEach((item, index) => validateValue(schema.items, item, path + '[' + index + ']', errors));
  }
  if (valueType(value) === 'object' && schema.properties) {
    validateObject(schema, value, path, errors);
  }
}

function validateObject(schema, value, path, errors) {
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const name of required) {
    if (value[name] === undefined) {
      errors.push({ code: ARG_ERROR_CODES.MISSING, path: path ? path + '.' + name : name, message: '缺少必填参数' });
    }
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!(name in properties)) {
        errors.push({ code: ARG_ERROR_CODES.UNEXPECTED, path: path ? path + '.' + name : name, message: 'schema 未声明该参数' });
      }
    }
  }
  for (const [name, definition] of Object.entries(properties)) {
    if (value[name] !== undefined) validateValue(definition, value[name], path ? path + '.' + name : name, errors);
  }
}

/**
 * 校验工具入参。
 * @param {{properties?:object, required?:string[], additionalProperties?:boolean, type?:string}} schema
 * @param {object} args
 * @returns {{ ok:boolean, errors:Array<{code:string,path:string,message:string}> }}
 */
export function validateToolArgs(schema, args) {
  const errors = [];
  if (!schema || typeof schema !== 'object') {
    return { ok: false, errors: [{ code: ARG_ERROR_CODES.TYPE, path: '', message: '工具缺少 inputSchema' }] };
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: [{ code: ARG_ERROR_CODES.TYPE, path: '', message: 'arguments 必须是对象' }] };
  }
  const schemaTypes = Array.isArray(schema.type) ? schema.type : [schema.type || 'object'];
  if (!schemaTypes.some((type) => typeMatches(type, args))) {
    return { ok: false, errors: [{ code: ARG_ERROR_CODES.TYPE, path: '', message: 'arguments 必须是对象' }] };
  }
  validateObject(schema, args, '', errors);
  return { ok: errors.length === 0, errors };
}

/** 校验失败时抛出的错误（带协议错误码与结构化清单）。 */
export class ToolArgumentError extends Error {
  constructor(errors) {
    const first = errors[0] || { code: ARG_ERROR_CODES.TYPE, path: '', message: '参数非法' };
    super(first.code + ': ' + (first.path || '<arguments>') + ' — ' + first.message);
    this.name = 'ToolArgumentError';
    this.code = first.code;
    this.errors = errors;
  }
}

/** 运行时门禁入口：schema + args → 通过返回 args，否则抛 ToolArgumentError。 */
export function assertToolArgs(schema, args) {
  const result = validateToolArgs(schema, args);
  if (!result.ok) throw new ToolArgumentError(result.errors);
  return args === undefined || args === null ? {} : args;
}

/** 把校验错误渲染成一行可读文本（server 返回 isError 时使用）。 */
export function formatArgErrors(errors) {
  return errors.map((error) => error.code + ' ' + (error.path || '<arguments>') + ': ' + error.message).join('; ');
}
