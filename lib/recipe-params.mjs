// lib/recipe-params.mjs —— recipe 参数化：声明、默认值、类型/枚举/范围校验、类型保持替换。
//
// 和 recipe-store.substituteParams 的区别：
//   - substituteParams 只做 `{{name}} → 字符串` 替换，缺参数就报错（v1 契约，保持不动）；
//   - 这里支持 recipe.params 声明（type/default/required/enum/pattern/min/max/secret），
//     按声明把用户输入强制成数字/布尔/字符串，缺省填默认值，多余参数给出警告；
//   - 结果同时返回「参数指纹」和「脱敏后的值」，供审批/回放证据使用。
//
// 零依赖，纯函数；CLI 与差异报告共用。

export const RECIPE_PARAM_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'enum', 'json']);

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export class RecipeParamError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RecipeParamError';
    this.code = code;
    this.details = details;
  }
}

/** recipe.params 支持对象写法（name → 声明）与数组写法（含 name 字段）。 */
export function normalizeParamDeclarations(input) {
  const list = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') list.push({ name: item, type: 'string' });
      else if (item && typeof item === 'object' && item.name) list.push({ ...item, name: String(item.name) });
    }
  } else if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string') list.push({ name, type: value });
      else if (value && typeof value === 'object') list.push({ ...value, name });
      else list.push({ name, type: 'string' });
    }
  }
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const name = String(raw.name || '');
    if (!PARAM_NAME.test(name)) {
      throw new RecipeParamError('E_BAD_ARG', 'recipe 参数名不合法："' + name + '"（字母开头，字母/数字/下划线/连字符，≤64）', { name });
    }
    if (seen.has(name)) {
      throw new RecipeParamError('E_BAD_ARG', 'recipe 参数重名：' + name, { name });
    }
    seen.add(name);
    const type = RECIPE_PARAM_TYPES.includes(String(raw.type || 'string')) ? String(raw.type || 'string') : 'string';
    const declaration = {
      name,
      type,
      required: raw.required === true,
      default: raw.default,
      enum: Array.isArray(raw.enum) ? raw.enum.map((item) => String(item)) : null,
      pattern: typeof raw.pattern === 'string' && raw.pattern ? raw.pattern : null,
      min: Number.isFinite(Number(raw.min)) ? Number(raw.min) : null,
      max: Number.isFinite(Number(raw.max)) ? Number(raw.max) : null,
      description: String(raw.description || ''),
      secret: raw.secret === true,
    };
    if (declaration.type === 'enum' && (!declaration.enum || !declaration.enum.length)) {
      throw new RecipeParamError('E_ARG_TYPE', 'recipe 参数 ' + name + ' 是 enum 但没有 values/enum', { name });
    }
    if (declaration.pattern) {
      try { new RegExp(declaration.pattern); } catch (error) {
        throw new RecipeParamError('E_ARG_TYPE', 'recipe 参数 ' + name + ' 的 pattern 不是合法正则：' + error.message, { name });
      }
    }
    result.push(Object.freeze(declaration));
  }
  return result;
}

/** 从步骤里收集 {{name}} 占位符（含嵌套块），用于提示漏声明的参数。 */
export function collectRecipeParamNames(steps) {
  const names = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      if (!step || typeof step !== 'object') continue;
      visit(step.params);
      visit(step.when);
      visit(step.until);
      visit(step.expect);
      visit(step.reason);
      const kind = String(step.kind || step.type || '').toLowerCase();
      if (kind === 'if' || kind === 'branch') { walk(step.then); walk(step.else); }
      if (kind === 'loop') walk(step.steps);
    }
  };
  walk(steps);
  return [...names];
}

function coerceScalar(declaration, rawValue) {
  const name = declaration.name;
  if (rawValue === undefined) return undefined;
  if (declaration.type === 'json') {
    if (typeof rawValue !== 'string') return rawValue;
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 需要 JSON：' + error.message, { name });
    }
  }
  if (declaration.type === 'number' || declaration.type === 'integer') {
    let number;
    if (typeof rawValue === 'number') {
      number = rawValue;
    } else {
      const text = String(rawValue).trim();
      if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) {
        throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 需要' + (declaration.type === 'integer' ? '整数' : '数字') + '，收到 "' + text + '"', { name });
      }
      number = Number(text);
    }
    if (!Number.isFinite(number)) {
      throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 不是有效数字', { name });
    }
    if (declaration.type === 'integer' && !Number.isInteger(number)) {
      throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 需要整数，收到 "' + String(rawValue) + '"', { name });
    }
    if (declaration.min !== null && number < declaration.min) {
      throw new RecipeParamError('E_ARG_RANGE', '参数 ' + name + ' 不能小于 ' + declaration.min, { name });
    }
    if (declaration.max !== null && number > declaration.max) {
      throw new RecipeParamError('E_ARG_RANGE', '参数 ' + name + ' 不能大于 ' + declaration.max, { name });
    }
    return number;
  }
  if (declaration.type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    const text = String(rawValue).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 需要布尔值（true/false），收到 "' + rawValue + '"', { name });
  }
  const text = String(rawValue);
  if (declaration.type === 'enum') {
    if (!declaration.enum.includes(text)) {
      throw new RecipeParamError('E_ARG_ENUM', '参数 ' + name + ' 只能是 ' + declaration.enum.join('|') + '，收到 "' + text + '"', { name });
    }
    return text;
  }
  if (declaration.pattern && !new RegExp(declaration.pattern).test(text)) {
    throw new RecipeParamError('E_ARG_TYPE', '参数 ' + name + ' 不符合 pattern ' + declaration.pattern + '：收到 "' + text + '"', { name });
  }
  if (declaration.min !== null && Number(text) < declaration.min) {
    throw new RecipeParamError('E_ARG_RANGE', '参数 ' + name + ' 不能小于 ' + declaration.min, { name });
  }
  if (declaration.max !== null && Number(text) > declaration.max) {
    throw new RecipeParamError('E_ARG_RANGE', '参数 ' + name + ' 不能大于 ' + declaration.max, { name });
  }
  return text;
}

/**
 * 解析 recipe 参数。
 * @param {object[]} declarations normalizeParamDeclarations 的结果
 * @param {object} provided 用户通过 --param 传入的键值（字符串）
 * @param {{templateNames?:string[], allowUnknown?:boolean}} options
 * @returns {{values:object, redacted:object, usedDefaults:string[], warnings:string[], errors:string[]}}
 */
export function resolveRecipeParams(declarations, provided = {}, options = {}) {
  const declList = normalizeParamDeclarations(declarations);
  const declared = new Map(declList.map((item) => [item.name, item]));
  const templateNames = Array.isArray(options.templateNames) ? options.templateNames : [];
  const values = {};
  const redacted = {};
  const usedDefaults = [];
  const warnings = [];
  const errors = [];
  const unknown = [];
  for (const name of Object.keys(provided || {})) {
    if (!declared.has(name) && !templateNames.includes(name)) unknown.push(name);
  }
  if (unknown.length && options.allowUnknown !== true) {
    warnings.push('未声明的参数被忽略：' + unknown.join(', '));
  }
  const known = new Set([...declared.keys(), ...templateNames]);
  for (const [name, raw] of Object.entries(provided || {})) {
    if (!known.has(name)) continue;
    const declaration = declared.get(name) || { name, type: 'string', required: false, default: undefined, enum: null, pattern: null, min: null, max: null, secret: false };
    try {
      const value = coerceScalar(declaration, raw);
      values[name] = value;
      redacted[name] = declaration.secret ? maskSecret(value) : value;
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const declaration of declList) {
    if (Object.prototype.hasOwnProperty.call(values, declaration.name)) continue;
    if (declaration.default !== undefined) {
      try {
        values[declaration.name] = coerceScalar(declaration, declaration.default);
        redacted[declaration.name] = declaration.secret ? maskSecret(values[declaration.name]) : values[declaration.name];
        usedDefaults.push(declaration.name);
      } catch (error) {
        errors.push(error.message);
      }
      continue;
    }
    if (declaration.required) errors.push('缺少必需参数 ' + declaration.name + (declaration.description ? '（' + declaration.description + '）' : ''));
  }
  const missingTemplates = templateNames.filter((name) => !Object.prototype.hasOwnProperty.call(values, name) && !declared.has(name));
  for (const name of missingTemplates) {
    if (!errors.some((item) => item.includes(name))) errors.push('缺少参数 {{' + name + '}}（用 --param ' + name + '=值 传入）');
  }
  return { values, redacted, usedDefaults, warnings, errors, declarations: declList };
}

function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 4) return '***';
  return text.slice(0, 2) + '***' + text.slice(-2);
}

/** 稳定 JSON（用于参数指纹，避免对象键序导致哈希漂移）。 */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

/** 参数指纹：只包含非 secret 值；secret 以掩码参与，避免把明文写进 run marker。 */
export function recipeParamFingerprint(values = {}) {
  const seed = stableJson(values);
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'p' + hash.toString(16).padStart(8, '0');
}

/** 类型保持替换：字符串恰好是 "{{name}}" 时返回原类型（数字/布尔/JSON），否则做字符串插值。 */
export function substituteTypedParams(value, params) {
  if (typeof value === 'string') {
    const exact = /^\{\{(\w+)\}\}$/.exec(value);
    if (exact) {
      if (!Object.prototype.hasOwnProperty.call(params, exact[1])) {
        throw new RecipeParamError('E_BAD_ARG', 'recipe 缺少参数 {{' + exact[1] + '}}（用 --param ' + exact[1] + '=值 传入）', { name: exact[1] });
      }
      return params[exact[1]];
    }
    return value.replace(PLACEHOLDER, (match, key) => {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        throw new RecipeParamError('E_BAD_ARG', 'recipe 缺少参数 {{' + key + '}}（用 --param ' + key + '=值 传入）', { name: key });
      }
      const current = params[key];
      return current === null || typeof current === 'object' ? JSON.stringify(current) : String(current);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substituteTypedParams(item, params));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = substituteTypedParams(value[key], params);
    return out;
  }
  return value;
}

/** 递归替换整份步骤（结构字段 when/then/else/loop 一起替换）。 */
export function substituteRecipeSteps(steps, params) {
  return (Array.isArray(steps) ? steps : []).map((step) => {
    if (!step || typeof step !== 'object') return step;
    const next = { ...step };
    if (next.params !== undefined) next.params = substituteTypedParams(next.params, params);
    if (next.when !== undefined) next.when = substituteTypedParams(next.when, params);
    if (next.expect !== undefined) next.expect = substituteTypedParams(next.expect, params);
    if (next.reason !== undefined) next.reason = substituteTypedParams(next.reason, params);
    if (Array.isArray(next.then)) next.then = substituteRecipeSteps(next.then, params);
    if (Array.isArray(next.else)) next.else = substituteRecipeSteps(next.else, params);
    if (Array.isArray(next.steps)) next.steps = substituteRecipeSteps(next.steps, params);
    return next;
  });
}

/** --param k=v 解析（CLI 复用；错误信息保持 v1 文案）。 */
export function parseParamPairs(rawValues) {
  const pairs = Array.isArray(rawValues) ? rawValues : (rawValues === undefined ? [] : [rawValues]);
  const values = {};
  for (const pair of pairs) {
    const index = String(pair).indexOf('=');
    if (index <= 0) throw new RecipeParamError('E_BAD_ARG', '--param 需要 key=value，收到 "' + pair + '"');
    const key = String(pair).slice(0, index);
    if (!PARAM_NAME.test(key)) throw new RecipeParamError('E_BAD_ARG', '--param 的 key 不合法："' + key + '"', { name: key });
    values[key] = String(pair).slice(index + 1);
  }
  return values;
}
