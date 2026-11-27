// extension/src/lib/replay-diff.js —— 回放差异校验（纯函数，零 chrome 依赖）。
//
// 回放“成功”不能只看命令没报错：录制时给每条 step 记了 expect（URL/字段值/文本/计数…），
// 回放后要拿真实观测去对。本模块负责：
//   - checkExpect：把 record-steps 产生的 expect 形状逐项校验，未知键显式标 unsupported
//     而不是静默通过；
//   - validateStepOutcome：单步判决（pass / warn / fail），带差异证据与稳定错误码；
//   - diffObservation / diffTextLines：文本观测的 LCS 行级差异（只看“多了/少了几行”）；
//   - diffSnapshots：结构快照的 added/removed/changed；
//   - aggregateOutcomes / verdictForPlan：整条计划的结果聚合与首次分叉位置。
//
// 设计约束：
//   - 纯函数：不读时钟、不访问 chrome；同输入同输出（差异顺序稳定）；
//   - 容差显式：exact / normalized / fuzzy 三档，模糊比较有上限，不做“差不多就过”；
//   - 只做校验，不改既有命令结果；输出字段命名与 replay-explain 对齐。

import { stableHash } from '../record-steps.js';

/** 差异模型版本。 */
export const REPLAY_DIFF_VERSION = 1;

/** 严重度（pass < info < warning < fail）。 */
export const DIFF_SEVERITIES = Object.freeze(['pass', 'info', 'warning', 'fail']);

const SEVERITY_RANK = new Map(DIFF_SEVERITIES.map((severity, index) => [severity, index]));

/** 差异/判决码（与 replay-explain 的 DIFF_* 目录对齐）。 */
export const DIFF_CODES = Object.freeze({
  OK: 'DIFF_OK',
  EXPECT_MISSING_ACTUAL: 'DIFF_MISSING_ACTUAL',
  OUTCOME_ERROR: 'DIFF_OUTCOME_ERROR',
  EXPECT_UNSUPPORTED: 'DIFF_UNSUPPORTED_EXPECTATION',
  URL_MISMATCH: 'DIFF_URL_MISMATCH',
  VALUE_MISMATCH: 'DIFF_VALUE_MISMATCH',
  TEXT_MISMATCH: 'DIFF_TEXT_MISMATCH',
  TEXT_WARNING: 'DIFF_TEXT_WARNING',
  STATUS_MISMATCH: 'DIFF_STATUS_MISMATCH',
  COUNT_MISMATCH: 'DIFF_COUNT_MISMATCH',
  ATTRIBUTE_MISMATCH: 'DIFF_ATTRIBUTE_MISMATCH',
  EXISTS_MISMATCH: 'DIFF_EXISTS_MISMATCH',
  VISIBILITY_MISMATCH: 'DIFF_VISIBILITY_MISMATCH',
  ENABLED_MISMATCH: 'DIFF_ENABLED_MISMATCH',
  SHAPE_MISMATCH: 'DIFF_SHAPE_MISMATCH',
  OBSERVATION_CHANGED: 'DIFF_OBSERVATION_CHANGED',
  SNAPSHOT_CHANGED: 'DIFF_SNAPSHOT_CHANGED',
  NUMERIC_TOLERATED: 'DIFF_NUMERIC_TOLERATED',
});

/** 默认容差：文本按空白归一后精确；数值允许极小相对误差；模糊比较要求 0.9 相似度。 */
export const DEFAULT_TOLERANCE = Object.freeze({
  profile: 'normalized',
  whitespace: 'collapse',
  caseInsensitive: false,
  minRatio: 0.9,
  numeric: Object.freeze({ abs: 0, rel: 1e-6 }),
  maxDepth: 4,
  maxItems: 64,
  maxTextLength: 4096,
});

/** 文本容差档位说明（输出/解释用）。 */
export const TOLERANCE_PROFILES = Object.freeze({
  exact: Object.freeze({ profile: 'exact', whitespace: 'keep', caseInsensitive: false, minRatio: 1, numeric: Object.freeze({ abs: 0, rel: 0 }) }),
  normalized: Object.freeze({ profile: 'normalized', whitespace: 'collapse', caseInsensitive: false, minRatio: 1, numeric: Object.freeze({ abs: 0, rel: 1e-9 }) }),
  fuzzy: Object.freeze({ profile: 'fuzzy', whitespace: 'collapse', caseInsensitive: true, minRatio: 0.9, numeric: Object.freeze({ abs: 0.5, rel: 0.01 }) }),
});

/** 把字符串/对象归一成容差配置。 */
export function toleranceProfile(input) {
  if (typeof input === 'string' && TOLERANCE_PROFILES[input]) return { ...TOLERANCE_PROFILES[input] };
  if (input && typeof input === 'object') {
    const base = TOLERANCE_PROFILES[input.profile] || TOLERANCE_PROFILES.normalized;
    return {
      ...base,
      ...input,
      numeric: { ...base.numeric, ...(input.numeric && typeof input.numeric === 'object' ? input.numeric : {}) },
    };
  }
  return { ...TOLERANCE_PROFILES.normalized };
}

/** 按容差档位归一化文本（不改变“是否相等”的语义，只统一比较口径）。 */
export function normalizeComparableText(value, tolerance = DEFAULT_TOLERANCE) {
  const config = toleranceProfile(tolerance);
  let text = value === null || value === undefined ? '' : String(value);
  if (config.whitespace === 'collapse') text = text.replace(/\s+/g, ' ').trim();
  else if (config.whitespace === 'trim') text = text.trim();
  if (config.caseInsensitive) text = text.toLowerCase();
  const limit = Number(config.maxTextLength) > 0 ? Number(config.maxTextLength) : DEFAULT_TOLERANCE.maxTextLength;
  return text.length > limit ? text.slice(0, limit) : text;
}

// ---------------------------------------------------------------------------
// 标量比较
// ---------------------------------------------------------------------------

/** 有上界的编辑距离：超过 max 提前返回 max+1（避免长文本 O(n*m) 爆掉）。 */
export function boundedLevenshtein(left, right, max = 64) {
  const a = String(left === null || left === undefined ? '' : left);
  const b = String(right === null || right === undefined ? '' : right);
  const limit = Math.max(1, Math.floor(Number(max) || 64));
  if (a === b) return 0;
  if (!a.length) return b.length <= limit ? b.length : limit + 1;
  if (!b.length) return a.length <= limit ? a.length : limit + 1;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > limit) return limit + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] > limit ? limit + 1 : previous[b.length];
}

/** 相似度 0..1（基于有上界编辑距离）。 */
export function textSimilarity(left, right, max = 256) {
  const a = String(left === null || left === undefined ? '' : left);
  const b = String(right === null || right === undefined ? '' : right);
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  const distance = boundedLevenshtein(a, b, max);
  if (distance > max) return 0;
  return Math.max(0, 1 - distance / longest);
}

/**
 * 文本比较：exact → 归一后相等；fuzzy → 相似度达到 minRatio 也算通过（降级为 warning）。
 * @returns {{equal:boolean, kind:string, similarity:number, expected:string, actual:string, tolerated:boolean}}
 */
export function compareText(expected, actual, tolerance = DEFAULT_TOLERANCE) {
  const config = toleranceProfile(tolerance);
  const left = normalizeComparableText(expected, config);
  const right = normalizeComparableText(actual, config);
  if (left === right) return { equal: true, kind: config.profile, similarity: 1, expected: left, actual: right, tolerated: false };
  if (config.profile === 'fuzzy') {
    const similarity = textSimilarity(left, right, Math.max(8, Math.ceil(left.length * (1 - Number(config.minRatio || 0.9)) + 8)));
    if (similarity >= Number(config.minRatio || 0.9)) {
      return { equal: true, kind: 'fuzzy', similarity, expected: left, actual: right, tolerated: true };
    }
    return { equal: false, kind: 'fuzzy', similarity, expected: left, actual: right, tolerated: false };
  }
  return { equal: false, kind: config.profile, similarity: textSimilarity(left, right), expected: left, actual: right, tolerated: false };
}

/** 数值比较：精确或容差内（abs/rel）；非法数字 → not-number。 */
export function compareNumber(expected, actual, tolerance = DEFAULT_TOLERANCE) {
  const config = toleranceProfile(tolerance);
  const left = Number(expected);
  const right = Number(actual);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { equal: false, kind: 'not-number', delta: null, expected: left, actual: right, tolerated: false };
  }
  const delta = right - left;
  const abs = Number(config.numeric.abs) || 0;
  const rel = Number(config.numeric.rel) || 0;
  const allowed = Math.max(abs, Math.abs(left) * rel);
  if (delta === 0) return { equal: true, kind: 'exact', delta: 0, expected: left, actual: right, tolerated: false };
  if (Math.abs(delta) <= allowed) return { equal: true, kind: 'tolerated', delta, expected: left, actual: right, tolerated: true };
  return { equal: false, kind: 'value', delta, expected: left, actual: right, tolerated: false };
}

/** 深比较：返回差异列表（path 用 a.b[0] 形式，便于解释定位）。 */
export function deepDiff(expected, actual, options = {}) {
  const tolerance = toleranceProfile(options.tolerance || DEFAULT_TOLERANCE);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : tolerance.maxDepth;
  const maxItems = Number.isInteger(options.maxItems) ? options.maxItems : tolerance.maxItems;
  const differences = [];
  walk(expected, actual, '', 0);
  return differences;

  function walk(left, right, path, depth) {
    if (differences.length >= maxItems * 4) return;
    if (depth > maxDepth) {
      differences.push({ path, kind: 'depth-limit', severity: 'warning', expected: typeName(left), actual: typeName(right) });
      return;
    }
    if (Object.is(left, right)) return;
    const leftType = typeName(left);
    const rightType = typeName(right);
    if (leftType !== rightType) {
      differences.push({ path, kind: 'type', severity: 'fail', expected: leftType, actual: rightType });
      return;
    }
    if (leftType === 'number') {
      const comparison = compareNumber(left, right, tolerance);
      if (!comparison.equal) {
        differences.push({ path, kind: 'value', severity: 'fail', expected: left, actual: right, delta: comparison.delta });
      } else if (comparison.tolerated) {
        differences.push({ path, kind: 'tolerated', severity: 'warning', expected: left, actual: right, delta: comparison.delta });
      }
      return;
    }
    if (leftType === 'string') {
      const comparison = compareText(left, right, tolerance);
      if (!comparison.equal) {
        differences.push({ path, kind: 'value', severity: 'fail', expected: comparison.expected, actual: comparison.actual, similarity: round(comparison.similarity) });
      }
      return;
    }
    if (leftType === 'array') {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < Math.min(length, maxItems); index += 1) {
        if (index >= left.length) differences.push({ path: path + '[' + index + ']', kind: 'extra', severity: 'fail', actual: right[index] });
        else if (index >= right.length) differences.push({ path: path + '[' + index + ']', kind: 'missing', severity: 'fail', expected: left[index] });
        else walk(left[index], right[index], path + '[' + index + ']', depth + 1);
      }
      if (length > maxItems) {
        differences.push({ path, kind: 'truncated', severity: 'warning', expected: left.length, actual: right.length });
      }
      return;
    }
    if (leftType === 'object') {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys.slice(0, maxItems)) {
        const childPath = path ? path + '.' + key : key;
        if (!Object.prototype.hasOwnProperty.call(left, key)) differences.push({ path: childPath, kind: 'extra', severity: 'fail', actual: right[key] });
        else if (!Object.prototype.hasOwnProperty.call(right, key)) differences.push({ path: childPath, kind: 'missing', severity: 'fail', expected: left[key] });
        else walk(left[key], right[key], childPath, depth + 1);
      }
      if (keys.length > maxItems) differences.push({ path, kind: 'truncated', severity: 'warning', expected: keys.length, actual: keys.length });
    }
  }
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------
// expect 校验
// ---------------------------------------------------------------------------

/** 逐项检查：把一条 check 收敛成统一结构（严重度决定整体是否通过）。 */
function pushCheck(checks, key, ok, code, expected, actual, options = {}) {
  const severity = ok ? (options.info ? 'info' : 'pass') : (options.severity || 'fail');
  checks.push({
    key,
    ok,
    code: ok ? DIFF_CODES.OK : code,
    severity,
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
    ...(options.note ? { note: String(options.note).slice(0, 200) } : {}),
  });
  return ok;
}

/** 状态码匹配：数字、'2xx' 通配、{min,max,oneOf}、'ok'。 */
export function statusMatches(expected, actual) {
  const value = Number(actual);
  if (!Number.isFinite(value)) return { ok: false, reason: 'not-number' };
  if (typeof expected === 'number') return { ok: value === expected, reason: 'exact' };
  const text = String(expected || '').trim().toLowerCase();
  if (!text) return { ok: false, reason: 'empty' };
  if (text === 'ok' || text === 'success') return { ok: value >= 200 && value < 300, reason: '2xx' };
  const wildcard = text.match(/^([1-5])xx$/);
  if (wildcard) {
    const family = Number(wildcard[1]);
    return { ok: value >= family * 100 && value < (family + 1) * 100, reason: family + 'xx' };
  }
  if (expected && typeof expected === 'object') {
    const min = Number(expected.min);
    const max = Number(expected.max);
    if (Number.isFinite(min) && value < min) return { ok: false, reason: 'below-min' };
    if (Number.isFinite(max) && value > max) return { ok: false, reason: 'above-max' };
    if (Array.isArray(expected.oneOf) && !expected.oneOf.map(Number).includes(value)) return { ok: false, reason: 'not-one-of' };
    return { ok: true, reason: 'range' };
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return { ok: value === numeric, reason: 'exact' };
  return { ok: false, reason: 'unsupported' };
}

/** 计数匹配：数字、数组长度、{min,max,equals}。 */
export function countMatches(expected, actual) {
  const value = Number(Array.isArray(actual) ? actual.length : actual);
  if (!Number.isFinite(value)) return { ok: false, reason: 'not-number' };
  if (Array.isArray(expected)) return { ok: value === expected.length, reason: 'from-array', expected: expected.length };
  if (typeof expected === 'number') return { ok: value === expected, reason: 'exact' };
  if (expected && typeof expected === 'object') {
    const equals = Number(expected.equals !== undefined ? expected.equals : expected.count);
    const min = Number(expected.min);
    const max = Number(expected.max);
    if (Number.isFinite(equals)) return { ok: value === equals, reason: 'equals' };
    if (Number.isFinite(min) && value < min) return { ok: false, reason: 'below-min' };
    if (Number.isFinite(max) && value > max) return { ok: false, reason: 'above-max' };
    if (Number.isFinite(min) || Number.isFinite(max)) return { ok: true, reason: 'range' };
  }
  return { ok: false, reason: 'unsupported' };
}

/** 属性匹配：expect.attribute = {name, value} / {name, includes} / 'name=value'。 */
export function attributeMatches(expected, actualAttributes) {
  const attributes = actualAttributes && typeof actualAttributes === 'object' ? actualAttributes : {};
  let name = '';
  let wanted;
  let mode = 'equals';
  if (typeof expected === 'string') {
    const parts = expected.split('=');
    name = parts[0] ? parts[0].trim() : '';
    wanted = parts.length > 1 ? parts.slice(1).join('=') : undefined;
  } else if (expected && typeof expected === 'object') {
    name = String(expected.name || expected.attribute || '').trim();
    wanted = expected.value !== undefined ? expected.value : expected.equals;
    if (expected.includes !== undefined) {
      wanted = expected.includes;
      mode = 'includes';
    }
    if (expected.exists === true && wanted === undefined) mode = 'exists';
  }
  if (!name) return { ok: false, reason: 'no-name', name };
  const lower = name.toLowerCase();
  const has = Object.prototype.hasOwnProperty.call(attributes, lower) || Object.prototype.hasOwnProperty.call(attributes, name);
  const actual = has ? (attributes[lower] !== undefined ? attributes[lower] : attributes[name]) : undefined;
  if (mode === 'exists') return { ok: has, reason: has ? 'exists' : 'missing', name, actual };
  if (wanted === undefined) return { ok: has, reason: has ? 'present' : 'missing', name, actual };
  if (!has) return { ok: false, reason: 'missing', name, actual: null };
  if (mode === 'includes') {
    return { ok: String(actual).includes(String(wanted)), reason: 'includes', name, actual };
  }
  return { ok: String(actual) === String(wanted), reason: 'equals', name, actual };
}

/** URL 包含判定（对 origin+path+search 做归一，忽略 hash）。 */
export function urlIncludes(actualUrl, expectedPart) {
  const actual = String(actualUrl || '');
  const part = String(expectedPart || '');
  if (!part) return { ok: true, reason: 'empty' };
  const key = stripHash(actual);
  if (key.includes(part)) return { ok: true, reason: 'includes' };
  return { ok: false, reason: 'missing', actual: key };
}

function stripHash(url) {
  const text = String(url || '');
  const index = text.indexOf('#');
  return index >= 0 ? text.slice(0, index) : text;
}

/**
 * 校验一条录制 expect（record-steps 的 expect 形状 + 常见扩展键）。
 * 未知键 → unsupported（warning，不静默通过也不误判失败）。
 * @param {unknown} expect
 * @param {object} actual 实际观测事实（url/status/text/value/count/attributes/...）
 * @param {{tolerance?:object|string}} [options]
 * @returns {{ok:boolean, checked:number, failed:number, warnings:number, checks:Array<object>, unsupported:string[], differences:Array<object>}}
 */
export function checkExpect(expect, actual, options = {}) {
  const checks = [];
  const unsupported = [];
  const facts = actual && typeof actual === 'object' ? actual : {};
  const tolerance = toleranceProfile(options.tolerance || DEFAULT_TOLERANCE);
  if (!expect || typeof expect !== 'object') {
    return { ok: true, checked: 0, failed: 0, warnings: 0, checks, unsupported, differences: [] };
  }
  const actualUrl = facts.url !== undefined ? facts.url : facts.finalUrl;
  const actualText = facts.text !== undefined ? facts.text : facts.selectorText;
  const actualValue = facts.value !== undefined ? facts.value : facts.selectorValue;
  const actualAttributes = facts.attributes || facts.attrs || {};
  for (const key of Object.keys(expect)) {
    const expected = expect[key];
    switch (key) {
      case 'urlIncludes':
        pushCheck(checks, key, urlIncludes(actualUrl, expected).ok, DIFF_CODES.URL_MISMATCH, expected, stripHash(String(actualUrl || '')).slice(0, 300));
        break;
      case 'url':
        pushCheck(checks, key, stripHash(String(actualUrl || '')) === String(expected), DIFF_CODES.URL_MISMATCH, expected, stripHash(String(actualUrl || '')).slice(0, 300));
        break;
      case 'urlStartsWith':
        pushCheck(checks, key, stripHash(String(actualUrl || '')).startsWith(String(expected)), DIFF_CODES.URL_MISMATCH, expected, stripHash(String(actualUrl || '')).slice(0, 300));
        break;
      case 'selectorValue':
      case 'value': {
        const comparison = compareText(expected, actualValue, tolerance);
        pushCheck(checks, key, comparison.equal, DIFF_CODES.VALUE_MISMATCH, comparison.expected, comparison.actual, comparison.tolerated ? { severity: 'warning', note: 'fuzzy' } : {});
        break;
      }
      case 'textIncludes': {
        const expectedText = normalizeComparableText(expected, tolerance);
        const actualNormalized = normalizeComparableText(actualText, tolerance);
        pushCheck(checks, key, actualNormalized.includes(expectedText), DIFF_CODES.TEXT_MISMATCH, expectedText.slice(0, 200), actualNormalized.slice(0, 200));
        break;
      }
      case 'text': {
        const comparison = compareText(expected, actualText, tolerance);
        pushCheck(checks, key, comparison.equal, DIFF_CODES.TEXT_MISMATCH, comparison.expected.slice(0, 200), comparison.actual.slice(0, 200), comparison.tolerated ? { severity: 'warning', note: 'fuzzy' } : {});
        break;
      }
      case 'title':
      case 'titleIncludes': {
        const rawTitle = String(facts.title || '');
        const ok = key === 'title'
          ? compareText(expected, rawTitle, tolerance).equal
          : normalizeComparableText(rawTitle, tolerance).includes(normalizeComparableText(expected, tolerance));
        pushCheck(checks, key, ok, DIFF_CODES.TEXT_MISMATCH, expected, rawTitle.slice(0, 200));
        break;
      }
      case 'status': {
        const result = statusMatches(expected, facts.status);
        pushCheck(checks, key, result.ok, DIFF_CODES.STATUS_MISMATCH, expected, facts.status, { note: result.reason });
        break;
      }
      case 'count':
      case 'rowCount': {
        const result = countMatches(expected, facts.count !== undefined ? facts.count : facts.rows);
        pushCheck(checks, key, result.ok, DIFF_CODES.COUNT_MISMATCH, expected, facts.count !== undefined ? facts.count : facts.rows, { note: result.reason });
        break;
      }
      case 'exists':
        pushCheck(checks, key, Boolean(facts.exists) === Boolean(expected), DIFF_CODES.EXISTS_MISMATCH, Boolean(expected), Boolean(facts.exists));
        break;
      case 'visible':
        pushCheck(checks, key, Boolean(facts.visible) === Boolean(expected), DIFF_CODES.VISIBILITY_MISMATCH, Boolean(expected), Boolean(facts.visible));
        break;
      case 'enabled':
        pushCheck(checks, key, Boolean(facts.enabled) === Boolean(expected), DIFF_CODES.ENABLED_MISMATCH, Boolean(expected), Boolean(facts.enabled));
        break;
      case 'disabled':
        pushCheck(checks, key, Boolean(facts.disabled) === Boolean(expected), DIFF_CODES.ENABLED_MISMATCH, Boolean(expected), Boolean(facts.disabled));
        break;
      case 'checked':
        pushCheck(checks, key, Boolean(facts.checked) === Boolean(expected), DIFF_CODES.VALUE_MISMATCH, Boolean(expected), Boolean(facts.checked));
        break;
      case 'selected':
        pushCheck(checks, key, Boolean(facts.selected) === Boolean(expected), DIFF_CODES.VALUE_MISMATCH, Boolean(expected), Boolean(facts.selected));
        break;
      case 'classIncludes': {
        const classes = String(facts.className || facts.classNameText || '').split(/\s+/).filter(Boolean);
        pushCheck(checks, key, classes.includes(String(expected)), DIFF_CODES.ATTRIBUTE_MISMATCH, expected, classes.slice(0, 16));
        break;
      }
      case 'attribute':
      case 'attr': {
        const result = attributeMatches(expected, actualAttributes);
        pushCheck(checks, key, result.ok, DIFF_CODES.ATTRIBUTE_MISMATCH, expected, result.actual !== undefined ? result.actual : null, { note: result.reason });
        break;
      }
      case 'htmlIncludes': {
        const html = String(facts.html || '');
        pushCheck(checks, key, html.includes(String(expected)), DIFF_CODES.TEXT_MISMATCH, String(expected).slice(0, 120), html.slice(0, 120));
        break;
      }
      case 'changed':
        pushCheck(checks, key, Boolean(facts.changed) === Boolean(expected), DIFF_CODES.OBSERVATION_CHANGED, Boolean(expected), Boolean(facts.changed));
        break;
      case 'values': {
        const actualValues = Array.isArray(facts.values) ? facts.values : [];
        const expectedValues = Array.isArray(expected) ? expected : [expected];
        const equal = expectedValues.length === actualValues.length && expectedValues.every((item, index) => compareText(item, actualValues[index], tolerance).equal);
        pushCheck(checks, key, equal, DIFF_CODES.VALUE_MISMATCH, expectedValues.slice(0, 16), actualValues.slice(0, 16));
        break;
      }
      default:
        unsupported.push(key);
        checks.push({
          key,
          ok: false,
          code: DIFF_CODES.EXPECT_UNSUPPORTED,
          severity: 'warning',
          expected: null,
          actual: null,
          note: 'unknown-expectation-key',
        });
        break;
    }
  }
  const failed = checks.filter((check) => check.severity === 'fail').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  const differences = checks
    .filter((check) => check.severity === 'fail')
    .map((check) => ({ path: 'expect.' + check.key, kind: 'value', severity: 'fail', expected: check.expected, actual: check.actual, code: check.code }));
  return {
    ok: failed === 0,
    checked: checks.length,
    failed,
    warnings,
    checks,
    unsupported,
    differences,
  };
}

// ---------------------------------------------------------------------------
// 观测/快照/结果差分
// ---------------------------------------------------------------------------

/** 文本行差异（LCS；超过 maxLines 时退化为前缀/后缀对齐，保证有界）。 */
export function diffTextLines(beforeText, afterText, options = {}) {
  const maxLines = Number.isInteger(options.maxLines) ? options.maxLines : 2000;
  const before = splitLines(beforeText, maxLines);
  const after = splitLines(afterText, maxLines);
  const operations = lcsOperations(before, after);
  const added = [];
  const removed = [];
  for (const operation of operations) {
    if (operation.op === 'add') added.push({ line: operation.line, afterIndex: operation.bIndex });
    else if (operation.op === 'del') removed.push({ line: operation.line, beforeIndex: operation.aIndex });
  }
  return {
    operations,
    added,
    removed,
    unchanged: operations.filter((operation) => operation.op === 'same').length,
    similarity: operations.length ? round(operations.filter((operation) => operation.op === 'same').length / Math.max(before.length, after.length, 1)) : 1,
    truncated: beforeText !== undefined && splitLines(beforeText, maxLines + 1).length > maxLines,
  };
}

function splitLines(value, maxLines) {
  if (value === null || value === undefined) return [];
  const text = typeof value === 'string' ? value : String(value);
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(0, maxLines) : lines;
}

function lcsOperations(before, after) {
  // 行数大到 DP 会爆：用“公共前缀 + 公共后缀 + 中间替换”的确定性近似。
  if (before.length * after.length > 250000) return approximateOperations(before, after);
  const table = new Array(before.length + 1);
  for (let i = 0; i <= before.length; i += 1) table[i] = new Uint32Array(after.length + 1);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      operations.push({ op: 'same', line: before[i], aIndex: i, bIndex: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ op: 'del', line: before[i], aIndex: i, bIndex: j });
      i += 1;
    } else {
      operations.push({ op: 'add', line: after[j], aIndex: i, bIndex: j });
      j += 1;
    }
  }
  while (i < before.length) { operations.push({ op: 'del', line: before[i], aIndex: i, bIndex: j }); i += 1; }
  while (j < after.length) { operations.push({ op: 'add', line: after[j], aIndex: i, bIndex: j }); j += 1; }
  return operations;
}

function approximateOperations(before, after) {
  const operations = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    operations.push({ op: 'same', line: before[start], aIndex: start, bIndex: start });
    start += 1;
  }
  let endBefore = before.length - 1;
  let endAfter = after.length - 1;
  while (endBefore >= start && endAfter >= start && before[endBefore] === after[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  for (let i = start; i <= endBefore; i += 1) operations.push({ op: 'del', line: before[i], aIndex: i, bIndex: start });
  for (let j = start; j <= endAfter; j += 1) operations.push({ op: 'add', line: after[j], aIndex: endBefore + 1, bIndex: j });
  for (let i = endBefore + 1, j = endAfter + 1; i < before.length && j < after.length; i += 1, j += 1) {
    operations.push({ op: 'same', line: before[i], aIndex: i, bIndex: j });
  }
  return operations;
}

/** 观测差异：把 before/after 文本做成行级 added/removed/hunks（observe 步骤校验用）。 */
export function diffObservation(beforeText, afterText, options = {}) {
  const lines = diffTextLines(beforeText, afterText, options);
  const hunks = [];
  let open = null;
  for (const operation of lines.operations) {
    if (operation.op === 'same') {
      if (open) { hunks.push(open); open = null; }
      continue;
    }
    if (!open) open = { beforeStart: operation.aIndex, afterStart: operation.bIndex, added: [], removed: [] };
    if (operation.op === 'add') open.added.push(operation.line);
    else open.removed.push(operation.line);
  }
  if (open) hunks.push(open);
  return {
    changed: lines.added.length > 0 || lines.removed.length > 0,
    added: lines.added.slice(0, 200),
    removed: lines.removed.slice(0, 200),
    hunks: hunks.slice(0, 100),
    counts: { added: lines.added.length, removed: lines.removed.length, unchanged: lines.unchanged },
    similarity: lines.similarity,
    truncated: lines.truncated,
    code: lines.added.length || lines.removed.length ? DIFF_CODES.OBSERVATION_CHANGED : DIFF_CODES.OK,
  };
}

/** 快照节点键：优先 key，其次 selector/name/text/role 的稳定哈希。 */
export function snapshotNodeKey(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.key) return String(node.key);
  const parts = [node.selector, node.id, node.testid, node.role, node.name, node.text].map((item) => (item === null || item === undefined ? '' : String(item)));
  return 'k' + stableHash(parts.join('\u0001'));
}

/**
 * 结构快照差异：按 key 对齐，输出 added/removed/changed。
 * @param {Array<object>} beforeNodes
 * @param {Array<object>} afterNodes
 * @param {{signature?:(node:object)=>string}} [options]
 */
export function diffSnapshots(beforeNodes, afterNodes, options = {}) {
  const beforeList = Array.isArray(beforeNodes) ? beforeNodes : [];
  const afterList = Array.isArray(afterNodes) ? afterNodes : [];
  const signature = typeof options.signature === 'function' ? options.signature : snapshotNodeSignature;
  const before = new Map();
  for (const node of beforeList) before.set(snapshotNodeKey(node), { node, signature: signature(node) });
  const after = new Map();
  for (const node of afterList) after.set(snapshotNodeKey(node), { node, signature: signature(node) });
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, entry] of after) {
    if (!before.has(key)) {
      added.push({ key, node: entry.node });
      continue;
    }
    const previous = before.get(key);
    if (previous.signature !== entry.signature) changed.push({ key, before: previous.node, after: entry.node });
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) removed.push({ key, node: entry.node });
  }
  const total = Math.max(before.size, after.size, 1);
  return {
    added: added.slice(0, options.maxItems || 200),
    removed: removed.slice(0, options.maxItems || 200),
    changed: changed.slice(0, options.maxItems || 200),
    counts: { before: before.size, after: after.size, added: added.length, removed: removed.length, changed: changed.length },
    similarity: round(1 - (added.length + removed.length + changed.length) / total),
    code: added.length || removed.length || changed.length ? DIFF_CODES.SNAPSHOT_CHANGED : DIFF_CODES.OK,
  };
}

/** 快照节点签名：可见性 + 文本 + 角色 + 名字 + 属性小计。 */
export function snapshotNodeSignature(node) {
  if (!node || typeof node !== 'object') return '';
  return [
    node.visible === false ? 'hidden' : 'visible',
    node.role || '',
    node.name || '',
    node.text || '',
    node.value === undefined ? '' : String(node.value),
  ].join('|');
}

// ---------------------------------------------------------------------------
// 单步判决 / 聚合
// ---------------------------------------------------------------------------

/** 严重度取最大。 */
export function maxSeverity(severities) {
  let max = 'pass';
  for (const severity of severities) {
    if ((SEVERITY_RANK.get(String(severity)) || 0) > (SEVERITY_RANK.get(max) || 0)) max = String(severity);
  }
  return max;
}

/**
 * 单步判决：step.expect 校验 + 观测差异 + 执行错误收敛。
 * @param {object} step 计划/录制 step
 * @param {object} actual 运行结果事实（ok/status/url/text/value/…；observe 可带 before/after）
 * @param {{tolerance?:object|string}} [options]
 * @returns {{ok:boolean, severity:string, code:string, checks:Array<object>, differences:Array<object>,
 *   unsupported:string[], observation:object|null, summary:{checked:number, failed:number, warnings:number}}}
 */
export function validateStepOutcome(step, actual, options = {}) {
  const target = step && typeof step === 'object' ? step : {};
  const facts = actual && typeof actual === 'object' ? actual : null;
  const checks = [];
  const differences = [];
  const unsupported = [];
  let observation = null;

  if (!facts) {
    return {
      ok: false,
      severity: 'fail',
      code: DIFF_CODES.EXPECT_MISSING_ACTUAL,
      checks,
      differences: [{ path: 'outcome', kind: 'missing', severity: 'fail', expected: 'result', actual: null }],
      unsupported,
      observation: null,
      summary: { checked: 0, failed: 1, warnings: 0 },
    };
  }
  if (facts.ok === false || facts.error) {
    checks.push({
      key: 'outcome.ok',
      ok: false,
      code: DIFF_CODES.OUTCOME_ERROR,
      severity: 'fail',
      expected: true,
      actual: Boolean(facts.ok),
      note: String(facts.error || 'execution-error').slice(0, 200),
    });
    differences.push({ path: 'outcome', kind: 'error', severity: 'fail', expected: true, actual: false });
  }
  if (target.expect && typeof target.expect === 'object') {
    const expectResult = checkExpect(target.expect, facts, options);
    checks.push(...expectResult.checks);
    differences.push(...expectResult.differences);
    unsupported.push(...expectResult.unsupported);
  }
  if (target.kind === 'observe' || target.method === 'observe-text') {
    const before = facts.before !== undefined ? facts.before : facts.previousObservation;
    const after = facts.after !== undefined ? facts.after : facts.observation;
    if (before !== undefined || after !== undefined) {
      observation = diffObservation(before === undefined ? '' : before, after === undefined ? '' : after);
      if (observation.changed) {
        checks.push({
          key: 'observation.changed',
          ok: true,
          code: DIFF_CODES.OBSERVATION_CHANGED,
          severity: 'info',
          expected: 'observation',
          actual: { added: observation.counts.added, removed: observation.counts.removed },
          note: '观测发生变化（observe 步骤的预期行为）',
        });
      }
    }
  }
  // 几何/内容类事实如果既没有 expect 也没有校验，不算失败，但要标 warning 以示“未验证”。
  const failed = checks.filter((check) => check.severity === 'fail').length;
  const warnings = checks.filter((check) => check.severity === 'warning').length;
  const severity = maxSeverity(checks.map((check) => check.severity));
  return {
    ok: failed === 0,
    severity,
    code: failed ? (differences[0] && differences[0].code || DIFF_CODES.VALUE_MISMATCH) : warnings ? DIFF_CODES.EXPECT_UNSUPPORTED : DIFF_CODES.OK,
    checks,
    differences,
    unsupported,
    observation,
    summary: { checked: checks.length, failed, warnings },
  };
}

/** 聚合单步判决：总数、通过/失败/告警、按码统计、首次失败位置。 */
export function aggregateOutcomes(outcomesIn) {
  const outcomes = Array.isArray(outcomesIn) ? outcomesIn : [];
  const byCode = {};
  const bySeverity = { pass: 0, info: 0, warning: 0, fail: 0 };
  let failed = 0;
  let warned = 0;
  let passed = 0;
  let firstFailureIndex = -1;
  let firstFailureCode = '';
  for (let position = 0; position < outcomes.length; position += 1) {
    const outcome = outcomes[position];
    const verdict = outcome && typeof outcome === 'object' ? outcome : {};
    const severity = verdict.severity || (verdict.ok === false ? 'fail' : 'pass');
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
    if (severity === 'fail') {
      failed += 1;
      if (firstFailureIndex < 0) {
        firstFailureIndex = Number.isInteger(verdict.index) ? verdict.index : position;
        firstFailureCode = verdict.code || '';
      }
    } else if (severity === 'warning') {
      warned += 1;
    } else {
      passed += 1;
    }
    if (verdict.code) byCode[verdict.code] = (byCode[verdict.code] || 0) + 1;
  }
  return {
    total: outcomes.length,
    passed,
    failed,
    warned,
    byCode,
    bySeverity,
    firstFailureIndex,
    firstFailureCode,
    ok: failed === 0,
    severity: failed ? 'fail' : warned ? 'warning' : 'pass',
  };
}

/**
 * 整条计划的结果判决：把 outcomes 对回 plan.steps，标出首个分叉位置。
 * @param {object} plan buildReplayPlan 结果（或 {steps}）
 * @param {Array<object>} outcomes 每步 {index, ok, severity, code, checks,...}
 * @param {{stopAtFirstFailure?:boolean}} [options]
 */
export function verdictForPlan(plan, outcomesIn, options = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const byIndex = new Map();
  for (const outcome of Array.isArray(outcomesIn) ? outcomesIn : []) {
    if (outcome && Number.isInteger(outcome.index)) byIndex.set(outcome.index, outcome);
  }
  const verdicts = steps.map((step, index) => {
    const outcome = byIndex.get(step.index !== undefined ? step.index : index) || null;
    return {
      index: step.index !== undefined ? step.index : index,
      ref: step.ref || '',
      kind: step.kind,
      status: outcome ? (outcome.ok === false ? 'failed' : outcome.severity === 'warning' ? 'warned' : 'passed') : 'missing',
      severity: outcome ? (outcome.severity || (outcome.ok === false ? 'fail' : 'pass')) : 'warning',
      code: outcome ? outcome.code || (outcome.ok === false ? DIFF_CODES.OUTCOME_ERROR : DIFF_CODES.OK) : 'DIFF_OUTCOME_MISSING',
    };
  });
  const aggregate = aggregateOutcomes(verdicts.map((verdict) => ({ ...verdict, ok: verdict.status !== 'failed' })));
  const divergedAt = verdicts.findIndex((verdict) => verdict.status === 'failed');
  return {
    ok: aggregate.failed === 0 && !verdicts.some((verdict) => verdict.status === 'missing' && options.requireAll === true),
    divergedAt,
    verdicts,
    aggregate,
    missing: verdicts.filter((verdict) => verdict.status === 'missing').length,
    steps: steps.length,
  };
}

/** 差异是否在容差内可接受（用于“模糊通过”与告警分流）。 */
export function isAcceptableDifference(difference, tolerance = DEFAULT_TOLERANCE) {
  if (!difference) return true;
  if (difference.kind === 'truncated' || difference.kind === 'depth-limit') return true;
  if (difference.severity === 'warning') return true;
  if (difference.kind === 'tolerated') return true;
  const config = toleranceProfile(tolerance);
  if (typeof difference.expected === 'number' && typeof difference.actual === 'number') {
    return compareNumber(difference.expected, difference.actual, config).equal;
  }
  if (typeof difference.expected === 'string' && typeof difference.actual === 'string' && config.profile === 'fuzzy') {
    return compareText(difference.expected, difference.actual, config).equal;
  }
  return false;
}

/** 差异摘要（有界、稳定排序）。 */
export function summarizeDifferences(differences, limit = 16) {
  const list = Array.isArray(differences) ? differences : [];
  const ordered = list.slice().sort((left, right) => {
    const rank = (SEVERITY_RANK.get(right && right.severity) || 0) - (SEVERITY_RANK.get(left && left.severity) || 0);
    if (rank !== 0) return rank;
    return String(left && left.path || '').localeCompare(String(right && right.path || ''));
  });
  const counts = { fail: 0, warning: 0, info: 0, pass: 0 };
  for (const item of ordered) counts[item && item.severity || 'info'] = (counts[item && item.severity || 'info'] || 0) + 1;
  return {
    total: ordered.length,
    counts,
    severity: maxSeverity(ordered.map((item) => item && item.severity)),
    top: ordered.slice(0, limit).map((item) => ({
      path: String(item && item.path || '').slice(0, 120),
      kind: String(item && item.kind || ''),
      severity: String(item && item.severity || ''),
      expected: compactValue(item && item.expected),
      actual: compactValue(item && item.actual),
    })),
  };
}

function compactValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 120 ? value.slice(0, 120) : value;
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue);
  try {
    return stableStringifyValue(value).slice(0, 160);
  } catch {
    return '[value]';
  }
}

function stableStringifyValue(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableStringifyValue).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringifyValue(value[key])).join(',') + '}';
}

/** 两个观测的相似度（整段文本，不逐行；报告用）。 */
export function observationSimilarity(beforeText, afterText) {
  const before = String(beforeText === null || beforeText === undefined ? '' : beforeText);
  const after = String(afterText === null || afterText === undefined ? '' : afterText);
  return textSimilarity(before, after, 512);
}

/** 一组判决的稳定签名（用于去重/缓存键）。 */
export function diffSignature(differences) {
  const list = Array.isArray(differences) ? differences : [];
  return stableHash(list.map((item) => [item && item.path, item && item.kind, item && item.severity].join('|')).join('>'));
}
