#!/usr/bin/env node
// tools/protocol-single-source.mjs —— 协议单一目录硬审计。
//
// 单一源：lib/method-catalog.mjs（方法名 / owner / effect / feature floor / 五维状态）。
// 本工具扫描所有手工重复表与生成物，逐项比对；任何不一致都打印“方法名 / 期望 / 实际”
// 并以 1 退出：
//   1) lib/protocol.mjs 的 METHOD_EFFECT
//   2) lib/methods.mjs 的 LOCAL/SESSION/INSTANCE 与 isMutating
//   3) lib/protocol-features.mjs 的 FEATURE_MIN_PROTOCOL 与方法级特性门
//   4) 方法状态机五维：partial / unknown / reconcile 与不变量
//   5) schema 单源：METHOD_SCHEMA_KEYS / PARAM_ALIASES 必须等于 lib/schemas.mjs 的派生
//   6) extension/src/generated/protocol.js（生成物：表 + 逐字节比对）
//   7) docs/PROTOCOL-METHODS.md（生成索引 + 逐字节比对）
//   8) mcp/tool-methods.mjs 与 mcp/server.mjs 的 TOOLS（MCP 工具 → 方法映射）
//   9) 兼容策略：feature floor 必须让 1.8 基线客户端全部拒绝、1.9 客户端全部允许
//  10) 运行时单源收口：lib/protocol.mjs / lib/methods.mjs 不得再含手工方法 MAP，
//      METHOD_EFFECT/LOCAL/SESSION/INSTANCE/EXT/BYPASS/isMutating/methodScope 必须由目录派生，
//      且依赖方向只能是 method-catalog → protocol → methods（禁止反向/循环）
//
// 用法：node tools/protocol-single-source.mjs [--json]
// 审计函数是纯函数（输入全部为普通对象/Set），测试可构造临时不一致对象做负例，不写真实文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DAEMON_ONLY_METHODS,
  FEATURE_FLOORS,
  FEATURE_METHODS,
  FEATURE_NAMES,
  LEGACY_MUTATING_METHODS,
  METHOD_CATALOG,
  METHOD_EFFECT_TABLE,
  METHOD_FEATURE,
  METHOD_PARTIAL,
  METHOD_RECONCILE,
  METHOD_UNKNOWN,
  MUTATING_OVERRIDES,
  OWNER_METHODS,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  RECEIPT_EFFECTS,
  RECONCILE_STRATEGIES,
  REQUEST_ENVELOPE_KEYS,
  SESSION_QUEUE_BYPASS_METHODS,
  methodStateOf,
  validateMethodStates,
  validateRuntimeLists,
} from '../lib/method-catalog.mjs';
import { METHOD_EFFECT, compareProtocol, effectOf } from '../lib/protocol.mjs';
import {
  EXT_METHODS,
  INSTANCE_METHODS,
  LOCAL_METHODS,
  SESSION_METHODS,
  SESSION_QUEUE_BYPASS,
  isMutating,
  methodScope,
  validateMethodRegistry,
} from '../lib/methods.mjs';
import { FEATURE_MIN_PROTOCOL, compatibilityMatrix, featuresForCall } from '../lib/protocol-features.mjs';
import { buildParamAliases, buildSchemaKeyTable, schemaDriftReport } from '../lib/schemas.mjs';
import { TOOLS } from '../mcp/server.mjs';
import { TOOL_METHODS } from '../mcp/tool-methods.mjs';
import {
  GENERATED_DOCS_PATH,
  GENERATED_PROTOCOL_PATH,
  renderMethodsDoc,
  renderProtocolSource,
} from './gen-protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_EFFECT_SET = new Set(RECEIPT_EFFECTS);
const MUTATING_OVERRIDE_SET = new Set(MUTATING_OVERRIDES);
const OWNER_KINDS = ['local', 'session', 'instance'];
const READ_EFFECTS = new Set(['passive_read', 'read']);

/** 运行时源码快照（审计输入；测试可替换成含手工表的假源码做负例）。 */
export const RUNTIME_SOURCE_PATHS = Object.freeze({
  protocol: path.join(ROOT, 'lib', 'protocol.mjs'),
  methods: path.join(ROOT, 'lib', 'methods.mjs'),
  catalog: path.join(ROOT, 'lib', 'method-catalog.mjs'),
});

/**
 * 每个运行时文件允许出现多少个“方法名字符串字面量”/一张 MAP 至少多少项算手工表。
 * - protocol：0（METHOD_EFFECT 与文件传输方法都从目录派生，源码里不应再出现方法名）；
 * - methods：1。`remoteScopeAllows` 里的 'read' 是远程作用域取值，恰好与方法名 read 同名；
 *   这是唯一的合法碰撞，预算仍只留 1，因此任何第二处方法名（更不用说成段 MAP）都会 fail。
 * 结构扫描阈值 8 只抓“大段手工 MAP”；两者叠加覆盖 2 项以上的小表。
 */
export const RUNTIME_SOURCE_BUDGETS = Object.freeze({
  protocol: Object.freeze({ maxMethodLiterals: 0, maxTableEntries: 8 }),
  methods: Object.freeze({ maxMethodLiterals: 1, maxTableEntries: 8 }),
});

/** 未知方法探针：effectOf 默认 browser_mutation、methodScope 默认 null。 */
export const RUNTIME_UNKNOWN_METHODS = Object.freeze(['no.such.method', 'not-a-method', '']);

/** effectOf 探针：覆盖四类 effect + read 细分 + 未知方法（含 null）。 */
export const RUNTIME_EFFECT_PROBES = Object.freeze(['click', 'observe', 'plan', 'type', 'no.such.method', '', null]);

function push(differences, scope, method, message, expected, actual) {
  const entry = { scope, method, message };
  if (expected !== undefined) entry.expected = expected;
  if (actual !== undefined) entry.actual = actual;
  differences.push(entry);
}

function isMutatingRow(row) {
  return RECEIPT_EFFECT_SET.has(row.effect) || MUTATING_OVERRIDE_SET.has(row.method);
}

/** 从目录行派生全部聚合表（审计与生成器共用同一套推导）。 */
function deriveTables(rows) {
  const names = rows.map((row) => row.method);
  return {
    names,
    effect: Object.fromEntries(rows.map((row) => [row.method, row.effect])),
    owner: Object.fromEntries(rows.map((row) => [row.method, row.owner])),
    local: rows.filter((row) => row.owner === 'local').map((row) => row.method),
    session: rows.filter((row) => row.owner === 'session').map((row) => row.method),
    instance: rows.filter((row) => row.owner === 'instance').map((row) => row.method),
    mutating: rows.filter(isMutatingRow).map((row) => row.method),
  };
}

function diffMap(differences, scope, expected, actual) {
  if (!expected || !actual) return;
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    if (!(key in expected)) { push(differences, scope, key, '手工表多出方法 ' + key, '<无>', actual[key]); continue; }
    if (!(key in actual)) { push(differences, scope, key, '手工表缺少方法 ' + key + '（目录=' + expected[key] + '）', expected[key], '<无>'); continue; }
    if (expected[key] !== actual[key]) push(differences, scope, key, '目录=' + expected[key] + '，手工=' + actual[key], expected[key], actual[key]);
  }
}

/** 深比较两个“方法 → 结构化行”的表（状态五维、schema 键、别名）。 */
function diffTable(differences, scope, expected, actual, label) {
  if (!expected || !actual) return;
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const hasExpected = Object.prototype.hasOwnProperty.call(expected, key);
    const hasActual = Object.prototype.hasOwnProperty.call(actual, key);
    if (!hasExpected) { push(differences, scope + '.extra', key, label + '多出 ' + key, '<无>', JSON.stringify(actual[key])); continue; }
    if (!hasActual) { push(differences, scope + '.missing', key, label + '缺少 ' + key, JSON.stringify(expected[key]), '<无>'); continue; }
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      push(differences, scope, key, label + '不一致', JSON.stringify(expected[key]), JSON.stringify(actual[key]));
    }
  }
}

function diffSet(differences, scope, expected, actual, label) {
  if (!expected || !actual) return;
  const left = new Set(expected);
  const right = new Set(actual);
  for (const item of [...left].sort()) {
    if (!right.has(item)) push(differences, scope, item, label + '缺少方法 ' + item);
  }
  for (const item of [...right].sort()) {
    if (!left.has(item)) push(differences, scope, item, label + '多出方法 ' + item);
  }
}

// ---------------------------------------------------------------------------
// 源码级审计：证明“运行时不再存在手工表”。
//
// 收口前 lib/protocol.mjs / lib/methods.mjs 各自维护一份方法名 MAP；收口后方法名
// 只允许出现在 lib/method-catalog.mjs。这里用轻量词法扫描（跳过注释/字符串内容/
// 正则）做两种独立证据：
//   1) 字面量预算：源码里出现多少个“方法名字符串字面量”；
//   2) 结构扫描：文件里是否还存在包含 N 个以上方法名字面量的 Map/Set/对象/数组。
// 两个证据都只看源码文本、不执行被审计模块，便于测试注入任意负例（不写真实文件）。
// 词法器不追求完整 JS 语法；对现状文件的注释、模板串、正则、转义都已覆盖，
// 未知语法最坏情况是“多报”（审计更严），不会漏掉整段 Map 字面量。
// ---------------------------------------------------------------------------

// 正则起始判定：前一个有效字符是这些符号时，`/` 视为正则而不是除号。
const REGEX_PREFIX_CHARS = new Set([
  '', '(', '[', '{', ':', ';', ',', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>', '\n',
]);

function isRegexStart(text, index, previousSignificant) {
  if (text[index] !== '/') return false;
  if (text[index + 1] === '/' || text[index + 1] === '*') return false;
  return REGEX_PREFIX_CHARS.has(previousSignificant);
}

/**
 * 轻量词法扫描：返回字符串字面量（含行号/区间/种类）与“被隐藏区间”（注释、正则）。
 * 纯函数，不执行源码；模板串的 `${...}` 表达式内部会递归扫描字符串。
 */
export function scanSourceText(source) {
  const text = String(source == null ? '' : source);
  const literals = [];
  const hidden = [];
  let index = 0;
  let line = 1;
  let previousSignificant = '';

  const skipLineComment = () => {
    const start = index;
    while (index < text.length && text[index] !== '\n') index++;
    hidden.push([start, index]);
  };
  const skipBlockComment = () => {
    const start = index;
    index += 2;
    while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
      if (text[index] === '\n') line++;
      index++;
    }
    index = Math.min(index + 2, text.length);
    hidden.push([start, index]);
  };
  const skipRegex = () => {
    const start = index;
    index++;
    let inClass = false;
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\\') { index += 2; continue; }
      if (ch === '\n') break;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { index++; break; }
      index++;
    }
    hidden.push([start, index]);
  };
  const readQuoted = (quote) => {
    const start = index;
    const startLine = line;
    index++;
    let value = '';
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\\') {
        value += ch + (text[index + 1] || '');
        if (text[index + 1] === '\n') line++;
        index += 2;
        continue;
      }
      if (ch === '\n') line++;
      if (ch === quote) { index++; break; }
      value += ch;
      index++;
    }
    literals.push({ value, line: startLine, start, end: index, kind: 'string' });
    previousSignificant = quote;
  };
  const readTemplateExpression = () => {
    let depth = 1;
    while (index < text.length && depth > 0) {
      const ch = text[index];
      if (ch === '/' && text[index + 1] === '/') { skipLineComment(); continue; }
      if (ch === '/' && text[index + 1] === '*') { skipBlockComment(); continue; }
      if (ch === "'" || ch === '"') { readQuoted(ch); continue; }
      if (ch === '`') { readTemplate(); continue; }
      if (ch === '{') { depth++; index++; continue; }
      if (ch === '}') { depth--; index++; continue; }
      if (ch === '\n') line++;
      index++;
    }
  };
  const readTemplate = () => {
    const start = index;
    const startLine = line;
    index++;
    let value = '';
    while (index < text.length) {
      const ch = text[index];
      if (ch === '\\') {
        value += ch + (text[index + 1] || '');
        if (text[index + 1] === '\n') line++;
        index += 2;
        continue;
      }
      if (ch === '`') { index++; break; }
      if (ch === '$' && text[index + 1] === '{') {
        index += 2;
        readTemplateExpression();
        value += '${}';
        continue;
      }
      if (ch === '\n') line++;
      value += ch;
      index++;
    }
    literals.push({ value, line: startLine, start, end: index, kind: 'template' });
    previousSignificant = '`';
  };

  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    if (ch === '/' && next === '/') { skipLineComment(); continue; }
    if (ch === '/' && next === '*') { skipBlockComment(); continue; }
    if (ch === "'" || ch === '"') { readQuoted(ch); continue; }
    if (ch === '`') { readTemplate(); continue; }
    if (ch === '/' && isRegexStart(text, index, previousSignificant)) { skipRegex(); continue; }
    if (ch === '\n') { line++; previousSignificant = '\n'; index++; continue; }
    if (!/\s/.test(ch)) previousSignificant = ch;
    index++;
  }
  return { text, literals, hidden, lineCount: line };
}

/** 去掉注释（保留字符串）——用于依赖方向扫描；import 说明符本身是字符串，不能删。 */
export function stripSourceComments(source) {
  const scan = scanSourceText(source);
  const chars = scan.text.split('');
  for (const [start, end] of scan.hidden) {
    for (let k = start; k < end && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  }
  return chars.join('');
}

/** 收集 import/export from、动态 import()、裸 import 的说明符（去重，保持出现顺序）。 */
export function importSpecifiers(source) {
  const text = stripSourceComments(source);
  const specs = new Set();
  for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.add(match[1]);
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(match[1]);
  for (const match of text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.add(match[1]);
  return [...specs];
}

/** 把字符串字面量与注释替换成空格（保留换行与位置/行号），得到可做括号配对的骨架。 */
export function maskSourceText(source) {
  const scan = scanSourceText(source);
  const chars = scan.text.split('');
  const blank = (start, end) => {
    for (let k = start; k < end && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  };
  for (const [start, end] of scan.hidden) blank(start, end);
  for (const literal of scan.literals) blank(literal.start, literal.end);
  return { masked: chars.join(''), scan };
}

function lineAt(text, index) {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text[k] === '\n') line++;
  return line;
}

const methodNameSet = (names) => new Set((Array.isArray(names) ? names : []).map((name) => String(name)));

/** 源码中出现的“方法名字符串字面量”（含行号）；用于字面量预算审计。 */
export function countMethodLiterals(source, methodNames) {
  const names = methodNameSet(methodNames);
  const scan = scanSourceText(source);
  return scan.literals
    .filter((literal) => names.has(literal.value))
    .map((literal) => ({ method: literal.value, line: literal.line, kind: literal.kind }));
}

/**
 * 结构扫描：找出源码中“包含 >= minEntries 个方法名字面量”的括号组（Map/Set/对象/数组）。
 * 返回 {open, close, line, closeLine, entries, methods}；嵌套组会各自报出（证据更全）。
 */
export function findMethodLiteralGroups(source, methodNames, options = {}) {
  const names = methodNameSet(methodNames);
  const minEntries = Number.isInteger(options.minEntries) ? options.minEntries : 8;
  const { masked, scan } = maskSourceText(source);
  const stack = [];
  const groups = [];
  for (let index = 0; index < masked.length; index++) {
    const ch = masked[index];
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, index });
      continue;
    }
    if (ch !== ')' && ch !== ']' && ch !== '}') continue;
    const open = stack.pop();
    if (!open) continue;
    const hits = scan.literals.filter((literal) => (
      literal.start > open.index && literal.end <= index + 1 && names.has(literal.value)
    ));
    if (hits.length < minEntries) continue;
    groups.push({
      open: open.ch,
      close: ch,
      line: lineAt(masked, open.index),
      closeLine: lineAt(masked, index),
      entries: hits.length,
      methods: hits.map((literal) => literal.value),
    });
  }
  groups.sort((a, b) => a.line - b.line || b.entries - a.entries);
  return groups;
}


/** 目录状态行的不变量（负例可破坏 inputs.state 验证这里会 fail）。 */
function auditState(differences, rows, state, partial, unknown, reconcile) {
  const byMethod = new Map(rows.map((row) => [row.method, row]));
  const names = new Set(byMethod.keys());
  for (const [method, entry] of Object.entries(state || {})) {
    if (!names.has(method)) { push(differences, 'state', method, '状态表包含目录外方法'); continue; }
    if (!entry || typeof entry !== 'object') { push(differences, 'state', method, '状态行不是对象'); continue; }
    const row = byMethod.get(method);
    if (!OWNER_KINDS.includes(entry.owner)) push(differences, 'state', method, 'owner 非法：' + entry.owner);
    if (entry.owner !== row.owner) push(differences, 'state.owner', method, '状态 owner=' + entry.owner + '，目录=' + row.owner);
    if (entry.effect !== row.effect) push(differences, 'state.effect', method, '状态 effect=' + entry.effect + '，目录=' + row.effect);
    const mutating = isMutatingRow(row);
    if (Boolean(entry.unknown) !== mutating) push(differences, 'state.unknown', method, 'unknown=' + entry.unknown + '，目录口径=' + mutating);
    if (entry.partial && !READ_EFFECTS.has(String(entry.effect))) push(differences, 'state.partial', method, '只有只读方法可以 partial');
    const rec = entry.reconcile;
    if (!rec || typeof rec !== 'object') { push(differences, 'state.reconcile', method, '缺少 reconcile'); continue; }
    if (!RECONCILE_STRATEGIES.includes(rec.strategy)) push(differences, 'state.reconcile', method, '策略非法：' + rec.strategy);
    if (!mutating && rec.strategy !== 'none') push(differences, 'state.reconcile', method, '非变异方法必须是 none');
    if (mutating && rec.strategy === 'none') push(differences, 'state.reconcile', method, '变异方法必须有收敛策略');
    if (rec.strategy === 'status' && !rec.method) push(differences, 'state.reconcile', method, 'status 收敛缺少目标方法');
    if (rec.method) {
      const target = byMethod.get(rec.method);
      if (!target && !DAEMON_ONLY_METHODS.includes(rec.method)) push(differences, 'state.reconcile', method, '收敛目标不在目录：' + rec.method);
      else if (target && isMutatingRow(target)) push(differences, 'state.reconcile', method, '收敛目标必须是只读方法：' + rec.method);
    }
  }
  const expectedPartial = Object.entries(state || {}).filter(([, entry]) => entry && entry.partial === true).map(([method]) => method);
  diffSet(differences, 'state.partial', expectedPartial, partial, 'partial 表 ');
  const expectedUnknown = Object.entries(state || {}).filter(([, entry]) => entry && entry.unknown === true).map(([method]) => method);
  diffSet(differences, 'state.unknown', expectedUnknown, unknown, 'unknown 表 ');
  const expectedReconcile = Object.fromEntries(Object.entries(state || {}).map(([method, entry]) => {
    const rec = (entry && entry.reconcile) || {};
    return [method, rec.method ? rec.strategy + ':' + rec.method : rec.strategy];
  }));
  diffMap(differences, 'state.reconcile-table', expectedReconcile, reconcile);
}

/**
 * 纯审计函数：inputs 为普通数据，便于测试构造负例。
 * @returns {{ok: boolean, counts: object, checks: Array<{name: string, ok: boolean, issues: number}>, differences: Array<object>}}
 */
export function auditSingleSource(inputs = {}) {
  const rows = Array.isArray(inputs.rows) ? inputs.rows : [];
  const daemonOnly = Array.isArray(inputs.daemonOnly) ? inputs.daemonOnly : [];
  const floors = inputs.floors && typeof inputs.floors === 'object' ? inputs.floors : {};
  const gated = inputs.gated && typeof inputs.gated === 'object' ? inputs.gated : {};
  const legacy = inputs.legacy && typeof inputs.legacy === 'object' ? inputs.legacy : {};
  const generated = inputs.generated && typeof inputs.generated === 'object' ? inputs.generated : null;
  const docsRows = Array.isArray(inputs.docsRows) ? inputs.docsRows : null;
  const state = inputs.state && typeof inputs.state === 'object' ? inputs.state : {};
  const partial = Array.isArray(inputs.partial) ? inputs.partial : [];
  const unknown = Array.isArray(inputs.unknown) ? inputs.unknown : [];
  const reconcile = inputs.reconcile && typeof inputs.reconcile === 'object' ? inputs.reconcile : {};
  const schemaKeys = inputs.schemaKeys && typeof inputs.schemaKeys === 'object' ? inputs.schemaKeys : {};
  const paramAliases = inputs.paramAliases && typeof inputs.paramAliases === 'object' ? inputs.paramAliases : {};
  const envelopeKeys = Array.isArray(inputs.envelope) ? inputs.envelope : [];
  const featureMethods = inputs.featureMethods && typeof inputs.featureMethods === 'object' ? inputs.featureMethods : {};
  const policy = inputs.policy && typeof inputs.policy === 'object' ? inputs.policy : {};
  const schemaReport = inputs.schemaReport && typeof inputs.schemaReport === 'object' ? inputs.schemaReport : null;
  const compat = inputs.compat && typeof inputs.compat === 'object' ? inputs.compat : null;
  const mcp = inputs.mcp && typeof inputs.mcp === 'object' ? inputs.mcp : null;
  const runtime = inputs.runtime && typeof inputs.runtime === 'object' ? inputs.runtime : null;
  const tables = deriveTables(rows);
  const differences = [];
  const checks = [];

  function section(name, run) {
    const before = differences.length;
    run();
    checks.push({ name, ok: differences.length === before, issues: differences.length - before });
  }

  section('catalog', () => {
    const seen = new Set();
    for (const row of rows) {
      const method = String((row && row.method) || '');
      if (!method) { push(differences, 'catalog', '<空>', '目录行缺少方法名'); continue; }
      if (seen.has(method)) push(differences, 'catalog', method, '目录方法重复');
      seen.add(method);
      if (!OWNER_KINDS.includes(row.owner)) push(differences, 'catalog', method, 'owner 非法：' + row.owner, 'local|session|instance', row.owner);
      if (!row.effect) push(differences, 'catalog', method, 'effect 为空');
    }
    const daemonSeen = new Set();
    for (const method of daemonOnly) {
      if (daemonSeen.has(method)) push(differences, 'catalog', method, 'daemon 专用方法重复');
      daemonSeen.add(method);
      if (seen.has(method)) push(differences, 'catalog', method, 'daemon 专用方法不应进入 canonical 目录');
    }
  });

  section('effect', () => {
    diffMap(differences, 'effect', tables.effect, legacy.effects);
  });

  section('owner', () => {
    if (!legacy.owners) return;
    const localExpected = [...tables.local, ...daemonOnly];
    diffSet(differences, 'owner.local', localExpected, legacy.owners.local, 'LOCAL_METHODS ');
    diffSet(differences, 'owner.session', tables.session, legacy.owners.session, 'SESSION_METHODS ');
    diffSet(differences, 'owner.instance', tables.instance, legacy.owners.instance, 'INSTANCE_METHODS ');
    const owners = new Map();
    for (const row of rows) {
      if (owners.has(row.method)) push(differences, 'owner', row.method, '方法在目录中重复出现');
      owners.set(row.method, row.owner);
    }
  });

  section('mutating', () => {
    if (!legacy.mutating) return;
    const expected = Object.fromEntries(rows.map((row) => [row.method, isMutatingRow(row)]));
    const actual = Object.fromEntries(Object.entries(legacy.mutating).map(([method, value]) => [method, Boolean(value)]));
    for (const [method, mutating] of Object.entries(expected)) {
      if (!(method in actual)) { push(differences, 'mutating', method, '手工表缺少 isMutating 结果'); continue; }
      if (Boolean(actual[method]) !== mutating) push(differences, 'mutating', method, '目录=' + mutating + '，手工=' + actual[method], mutating, actual[method]);
    }
  });

  section('feature-floor', () => {
    diffMap(differences, 'feature-floor', floors, legacy.floors);
    diffMap(differences, 'method-feature', gated, legacy.gated);
    for (const [feature, version] of Object.entries(floors)) {
      if (!/^\d+\.\d+$/.test(String(version))) push(differences, 'feature-floor', feature, 'floor 不是 <major>.<minor>：' + version);
    }
    // 特性 → 方法 与 方法 → 特性 必须互为逆映射（同一份 FEATURE_META 派生）。
    const inverse = {};
    for (const [method, feature] of Object.entries(gated)) {
      if (!(feature in floors)) { push(differences, 'feature-floor', method, '方法级特性门引用了未定义特性：' + feature); continue; }
      (inverse[feature] = inverse[feature] || []).push(method);
    }
    for (const feature of Object.keys(floors)) {
      const expected = [...(inverse[feature] || [])].sort();
      const actual = [...(Array.isArray(featureMethods[feature]) ? featureMethods[feature] : [])].sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        push(differences, 'feature-methods', feature, '特性方法表与 METHOD_FEATURE 互逆不一致', JSON.stringify(expected), JSON.stringify(actual));
      }
    }
    // 兼容策略：基线客户端必须被全部 floor 拒绝；当前协议必须满足全部 floor。
    const baseline = policy.baseline || PROTOCOL_BASELINE;
    const current = policy.current || PROTOCOL_CURRENT;
    for (const [feature, version] of Object.entries(floors)) {
      const baselineOrder = compareProtocol(baseline, version);
      const currentOrder = compareProtocol(current, version);
      if (baselineOrder === null || baselineOrder >= 0) {
        push(differences, 'feature-floor', feature, '基线协议 ' + baseline + ' 不应满足特性门 ' + version + '（旧客户端必须被拒绝）');
      }
      if (currentOrder === null || currentOrder < 0) {
        push(differences, 'feature-floor', feature, '当前协议 ' + current + ' 不满足特性门 ' + version);
      }
    }
  });

  section('state', () => {
    if (!Object.keys(state).length) return;
    const catalogErrors = validateMethodStates().filter(Boolean);
    for (const message of catalogErrors) push(differences, 'state.invariant', '<目录>', message);
    auditState(differences, rows, state, partial, unknown, reconcile);
  });

  section('schema', () => {
    if (!Object.keys(schemaKeys).length) return;
    const extMethods = rows.filter((row) => row.owner === 'session' || row.owner === 'instance').map((row) => row.method);
    for (const method of extMethods) {
      if (!schemaKeys[method]) push(differences, 'schema.keys', method, '扩展方法缺少 schema key 派生条目');
    }
    for (const [method, row] of Object.entries(schemaKeys)) {
      if (!row || !Array.isArray(row.properties) || !Array.isArray(row.required)) {
        push(differences, 'schema.keys', method, 'schema key 行结构错误（需要 required/properties 数组）');
        continue;
      }
      const properties = row.properties.map(String);
      if (new Set(properties).size !== properties.length) push(differences, 'schema.keys', method, 'schema properties 有重复键');
      if (properties.some((key) => !key)) push(differences, 'schema.keys', method, 'schema properties 有空键');
      for (const required of row.required) {
        if (!properties.includes(required)) push(differences, 'schema.keys', method, 'required 引用了未声明字段：' + required);
      }
    }
    if (envelopeKeys.length) {
      for (const key of envelopeKeys) {
        if (typeof key !== 'string' || !key) push(differences, 'schema.envelope', String(key), 'REQUEST_ENVELOPE_KEYS 含非法键');
      }
    } else {
      push(differences, 'schema.envelope', '<目录>', '目录未声明 REQUEST_ENVELOPE_KEYS，schema 信封无法单源派生');
    }
    if (schemaReport && schemaReport.ok === false) {
      for (const problem of schemaReport.problems || []) push(differences, 'schema.audit', '<schema>', problem);
      for (const method of schemaReport.unknownSchemas || []) {
        push(differences, 'schema.extra', method, 'schema 没有对应扩展方法');
      }
    }
  });

  section('generated', () => {
    if (!generated) return;
    if (generated.text && generated.renderText && generated.text !== generated.renderText) {
      push(differences, 'generated.text', '<文件>', '生成物与生成器渲染不一致，请运行 node tools/gen-protocol.mjs');
    }
    diffMap(differences, 'generated.effect', tables.effect, generated.METHOD_EFFECT);
    diffSet(differences, 'generated.methods', tables.names, generated.METHODS, 'METHODS ');
    diffSet(differences, 'generated.mutating', tables.mutating, generated.MUTATING_METHODS, 'MUTATING_METHODS ');
    diffSet(differences, 'generated.local', [...tables.local, ...daemonOnly], generated.LOCAL_METHODS, 'LOCAL_METHODS ');
    diffSet(differences, 'generated.session', tables.session, generated.SESSION_METHODS, 'SESSION_METHODS ');
    diffSet(differences, 'generated.instance', tables.instance, generated.INSTANCE_METHODS, 'INSTANCE_METHODS ');
    diffSet(differences, 'generated.ext', [...tables.session, ...tables.instance], generated.EXT_METHODS, 'EXT_METHODS ');
    diffSet(differences, 'generated.daemon-only', daemonOnly, generated.DAEMON_ONLY_METHODS, 'DAEMON_ONLY_METHODS ');
    diffMap(differences, 'generated.owner', tables.owner, generated.METHOD_OWNER);
    const gatedFloors = Object.fromEntries(Object.entries(gated)
      .map(([method, feature]) => [method, floors[feature]])
      .filter(([, version]) => version !== undefined));
    diffMap(differences, 'generated.floor', gatedFloors, generated.METHOD_FEATURE_FLOOR);
    diffMap(differences, 'generated.feature-floor', floors, generated.FEATURE_MIN_PROTOCOL);
    diffMap(differences, 'generated.method-feature', gated, generated.METHOD_FEATURE);
    diffSet(differences, 'generated.feature-names', Object.keys(floors), generated.FEATURE_NAMES, 'FEATURE_NAMES ');
    diffTable(differences, 'generated.state', state, generated.METHOD_STATE, 'METHOD_STATE ');
    diffSet(differences, 'generated.partial', partial, generated.METHOD_PARTIAL, 'METHOD_PARTIAL ');
    diffSet(differences, 'generated.unknown', unknown, generated.METHOD_UNKNOWN, 'METHOD_UNKNOWN ');
    diffMap(differences, 'generated.reconcile', reconcile, generated.METHOD_RECONCILE);
    if (generated.METHOD_COUNT !== rows.length) {
      push(differences, 'generated.count', '<文件>', 'METHOD_COUNT=' + generated.METHOD_COUNT + '，目录=' + rows.length, rows.length, generated.METHOD_COUNT);
    }
  });

  section('schema-generated', () => {
    if (!generated || !Object.keys(schemaKeys).length) return;
    diffTable(differences, 'schema.keys', schemaKeys, generated.METHOD_SCHEMA_KEYS, 'METHOD_SCHEMA_KEYS ');
    diffTable(differences, 'schema.aliases', paramAliases, generated.PARAM_ALIASES, 'PARAM_ALIASES ');
  });

  section('docs', () => {
    if (!docsRows) return;
    const expected = [
      ...rows.map((row) => ({ method: row.method, scope: row.owner, mutating: isMutatingRow(row) })),
      ...daemonOnly.map((method) => ({ method, scope: 'local', mutating: MUTATING_OVERRIDE_SET.has(method) })),
    ];
    if (docsRows.length !== expected.length) {
      push(differences, 'docs.count', '<文档>', '文档索引行数=' + docsRows.length + '，目录=' + expected.length, expected.length, docsRows.length);
    }
    const byMethod = new Map(docsRows.map((row) => [row.method, row]));
    const expectedNames = new Set(expected.map((row) => row.method));
    for (const row of expected) {
      const doc = byMethod.get(row.method);
      if (!doc) { push(differences, 'docs', row.method, '文档索引缺少该方法'); continue; }
      if (doc.scope !== row.scope) push(differences, 'docs.scope', row.method, '文档 scope=' + doc.scope + '，目录=' + row.scope, row.scope, doc.scope);
      if (Boolean(doc.mutating) !== Boolean(row.mutating)) push(differences, 'docs.mutating', row.method, '文档=' + (row.mutating ? 'mutation' : 'read') + '，目录=' + (row.mutating ? 'mutation' : 'read'));
    }
    for (const doc of docsRows) {
      if (!expectedNames.has(doc.method)) push(differences, 'docs', doc.method, '文档索引多出该方法');
    }
    if (typeof inputs.docsText === 'string' && typeof inputs.docsRenderText === 'string' && inputs.docsText !== inputs.docsRenderText) {
      push(differences, 'docs.text', '<文档>', 'docs/PROTOCOL-METHODS.md 与生成器渲染不一致，请运行 node tools/gen-protocol.mjs');
    }
  });

  section('mcp', () => {
    if (!mcp) return;
    const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
    const toolMethods = mcp.toolMethods && typeof mcp.toolMethods === 'object' ? mcp.toolMethods : null;
    if (toolMethods) {
      diffSet(differences, 'mcp.tool-name', Object.keys(toolMethods), tools.map((tool) => tool.name), 'MCP 工具 ');
      if (tools.length !== Object.keys(toolMethods).length) {
        push(differences, 'mcp.count', '<工具表>', 'TOOLS=' + tools.length + '，TOOL_METHODS=' + Object.keys(toolMethods).length);
      }
    }
    const known = new Set([...tables.names, ...daemonOnly]);
    for (const tool of tools) {
      const own = Array.isArray(tool.methods) ? tool.methods : [];
      const mapped = toolMethods && Array.isArray(toolMethods[tool.name]) ? toolMethods[tool.name] : null;
      if (mapped && JSON.stringify([...mapped].sort()) !== JSON.stringify([...own].sort())) {
        push(differences, 'mcp.tool', tool.name, '工具方法映射不一致：tool-methods=' + JSON.stringify(mapped) + '，tool.methods=' + JSON.stringify(own));
      }
      for (const method of own) {
        if (!known.has(method)) push(differences, 'mcp.method', method, 'MCP 工具 ' + tool.name + ' 引用了目录外的方法');
      }
    }
  });

  section('compat', () => {
    if (!compat) return;
    const versions = Array.isArray(compat.versions) ? compat.versions : [];
    if (versions.length < 2) push(differences, 'compat', '<矩阵>', '兼容矩阵至少需要基线/当前两个版本');
    const perFeature = Array.isArray(compat.perFeature) ? compat.perFeature : [];
    if (perFeature.length !== Object.keys(floors).length) {
      push(differences, 'compat.count', '<矩阵>', '兼容矩阵特性数=' + perFeature.length + '，floor=' + Object.keys(floors).length);
    }
    for (const item of perFeature) {
      const feature = item && item.feature;
      if (!(feature in floors)) { push(differences, 'compat', String(feature), '兼容矩阵包含未定义特性'); continue; }
      if (item.floor !== floors[feature]) push(differences, 'compat.floor', feature, '矩阵 floor=' + item.floor + '，目录=' + floors[feature]);
      if (item.baselineAllowed === true) push(differences, 'compat.baseline', feature, '基线客户端被错误地允许：' + feature);
      if (item.currentAllowed !== true) push(differences, 'compat.current', feature, '当前协议缺少特性：' + feature);
    }
    const matrix = compatibilityMatrix(compareProtocol);
    if (matrix.ok !== true) push(differences, 'compat.matrix', '<矩阵>', 'compatibilityMatrix 出现基线允许/当前拒绝');
  });

  section('runtime', () => {
    if (!runtime) return;
    const sources = runtime.sources && typeof runtime.sources === 'object' ? runtime.sources : {};
    const budgets = runtime.budgets && typeof runtime.budgets === 'object' ? runtime.budgets : RUNTIME_SOURCE_BUDGETS;
    const labels = { protocol: 'lib/protocol.mjs', methods: 'lib/methods.mjs', catalog: 'lib/method-catalog.mjs' };
    const methodNames = [...tables.names, ...daemonOnly, ...LEGACY_MUTATING_METHODS];
    for (const key of ['protocol', 'methods', 'catalog']) {
      if (typeof sources[key] !== 'string' || !sources[key].trim()) {
        push(differences, 'runtime.sources', labels[key], '缺少运行时源码快照，无法审计手工表回流');
      }
    }

    // (a0) 派生快照必须齐全：diffMap/diffSet 对“输入不存在”会跳过，
    // 缺快照不能被误判成通过（审计自身的“跳过即通过”防护）。
    const protocolRuntime = runtime.protocol && typeof runtime.protocol === 'object' ? runtime.protocol : {};
    const methodsRuntime = runtime.methods && typeof runtime.methods === 'object' ? runtime.methods : {};
    const requiredSnapshots = [
      ['METHOD_EFFECT', protocolRuntime.methodEffect, 'object'],
      ['METHOD_EFFECT_KEYS', protocolRuntime.methodEffectKeys, 'array'],
      ['effectOf 探针', protocolRuntime.effectProbes, 'array'],
      ['LOCAL_METHODS', methodsRuntime.local, 'array'],
      ['SESSION_METHODS', methodsRuntime.session, 'array'],
      ['INSTANCE_METHODS', methodsRuntime.instance, 'array'],
      ['EXT_METHODS', methodsRuntime.ext, 'array'],
      ['SESSION_QUEUE_BYPASS', methodsRuntime.bypass, 'array'],
      ['isMutating 表', methodsRuntime.mutating, 'object'],
      ['methodScope 表', methodsRuntime.scope, 'object'],
      ['未知方法 scope 探针', methodsRuntime.scopeProbes, 'array'],
      ['validateMethodRegistry 结果', methodsRuntime.validateErrors, 'array'],
      ['frozen 标志', runtime.frozen, 'object'],
    ];
    for (const [label, value, kind] of requiredSnapshots) {
      const present = kind === 'array' ? Array.isArray(value) : Boolean(value && typeof value === 'object');
      if (!present) push(differences, 'runtime.exports', label, '缺少运行时派生快照（输入不完整不能当作通过）');
    }
    if (!Number.isInteger(runtime.methodCount)) {
      push(differences, 'runtime.exports', 'methodCount', '缺少运行时方法数快照');
    }

    // (a) 依赖方向：目录是叶子；protocol → 目录；methods → 目录 + protocol。
    const catalogDeps = importSpecifiers(sources.catalog || '');
    const protocolDeps = importSpecifiers(sources.protocol || '');
    const methodsDeps = importSpecifiers(sources.methods || '');
    for (const dep of ['./protocol.mjs', './methods.mjs', './protocol-features.mjs']) {
      if (catalogDeps.includes(dep)) {
        push(differences, 'runtime.deps', labels.catalog, '单一目录反向依赖 ' + dep + '（会形成循环，必须保持单向）');
      }
    }
    if (!protocolDeps.includes('./method-catalog.mjs')) {
      push(differences, 'runtime.deps', labels.protocol, 'METHOD_EFFECT 未从 ./method-catalog.mjs 派生');
    }
    if (protocolDeps.includes('./methods.mjs')) {
      push(differences, 'runtime.deps', labels.protocol, '反向依赖 ./methods.mjs（应与 methods 解耦）');
    }
    if (!methodsDeps.includes('./method-catalog.mjs')) {
      push(differences, 'runtime.deps', labels.methods, '路由/变异清单未从 ./method-catalog.mjs 派生');
    }

    // (b) 手工表回流：字面量预算 + 结构扫描（两份独立证据，任一命中即 fail）。
    for (const key of ['protocol', 'methods']) {
      const budget = budgets[key] && typeof budgets[key] === 'object' ? budgets[key] : RUNTIME_SOURCE_BUDGETS[key];
      const maxLiterals = Number.isInteger(budget.maxMethodLiterals) ? budget.maxMethodLiterals : 0;
      const minEntries = Number.isInteger(budget.maxTableEntries) ? budget.maxTableEntries : 8;
      const hits = countMethodLiterals(sources[key] || '', methodNames);
      if (hits.length > maxLiterals) {
        for (const hit of hits) {
          push(differences, 'runtime.literal-budget', hit.method,
            labels[key] + ' 第 ' + hit.line + ' 行出现方法名字面量（预算 ' + maxLiterals + ' 个，实际 ' + hits.length + ' 个）');
        }
      }
      for (const group of findMethodLiteralGroups(sources[key] || '', methodNames, { minEntries })) {
        push(differences, 'runtime.literal-table', '<' + group.open + '@' + group.line + '>',
          labels[key] + ' 第 ' + group.line + '–' + group.closeLine + ' 行仍有 ' + group.entries
          + ' 项方法名 MAP/集合（如 ' + group.methods.slice(0, 3).join(' / ') + ' …）；方法名只允许在目录声明');
      }
    }

    // (c) 派生结果必须与目录逐项一致（运行时值 pass-through，不再有第二份判定）。
    diffMap(differences, 'runtime.effect', tables.effect, protocolRuntime.methodEffect);
    const effectKeys = Array.isArray(protocolRuntime.methodEffectKeys) ? protocolRuntime.methodEffectKeys : [];
    if (JSON.stringify(effectKeys) !== JSON.stringify(tables.names)) {
      push(differences, 'runtime.effect.order', 'METHOD_EFFECT',
        '运行时 effect 键序与目录不一致（生成物稳定性依赖该顺序）',
        JSON.stringify(tables.names.slice(0, 3)), JSON.stringify(effectKeys.slice(0, 3)));
    }
    for (const probe of Array.isArray(protocolRuntime.effectProbes) ? protocolRuntime.effectProbes : []) {
      const expected = tables.effect[probe.method] || 'browser_mutation';
      if (probe.effect !== expected) {
        push(differences, 'runtime.effect.probe', String(probe.method), '运行时 effectOf=' + probe.effect + '，目录=' + expected);
      }
    }
    diffSet(differences, 'runtime.owner.local', [...tables.local, ...daemonOnly], methodsRuntime.local, 'LOCAL_METHODS ');
    diffSet(differences, 'runtime.owner.session', tables.session, methodsRuntime.session, 'SESSION_METHODS ');
    diffSet(differences, 'runtime.owner.instance', tables.instance, methodsRuntime.instance, 'INSTANCE_METHODS ');
    diffSet(differences, 'runtime.owner.ext', [...tables.session, ...tables.instance], methodsRuntime.ext, 'EXT_METHODS ');
    diffSet(differences, 'runtime.bypass', [...SESSION_QUEUE_BYPASS_METHODS], methodsRuntime.bypass, 'SESSION_QUEUE_BYPASS ');
    const expectedMutating = Object.fromEntries(rows.map((row) => [row.method, isMutatingRow(row)]));
    for (const method of LEGACY_MUTATING_METHODS) expectedMutating[method] = true;
    diffMap(differences, 'runtime.mutating', expectedMutating, methodsRuntime.mutating);
    const expectedScope = Object.fromEntries(rows.map((row) => [row.method, row.owner]));
    for (const method of daemonOnly) expectedScope[method] = 'local';
    diffMap(differences, 'runtime.scope', expectedScope, methodsRuntime.scope);
    for (const probe of Array.isArray(methodsRuntime.scopeProbes) ? methodsRuntime.scopeProbes : []) {
      if (probe.scope !== null) {
        push(differences, 'runtime.scope.probe', String(probe.method), '未知方法 methodScope 应为 null，实际 ' + JSON.stringify(probe.scope));
      }
    }
    for (const message of Array.isArray(methodsRuntime.validateErrors) ? methodsRuntime.validateErrors : []) {
      push(differences, 'runtime.validate', '<派生清单>', message);
    }
    for (const message of validateRuntimeLists()) push(differences, 'runtime.invariant', '<目录清单>', message);
    const frozen = runtime.frozen && typeof runtime.frozen === 'object' ? runtime.frozen : {};
    if (frozen.methodEffect !== true) {
      push(differences, 'runtime.frozen', 'METHOD_EFFECT', '运行时 effect 表必须冻结（不可再被 Object.assign 改写）');
    }
    if (frozen.methodEffectTable !== true) {
      push(differences, 'runtime.frozen', 'METHOD_EFFECT_TABLE', '目录 effect 表必须冻结');
    }
    if (runtime.methodCount !== rows.length) {
      push(differences, 'runtime.count', '<运行时>', 'METHOD_EFFECT 方法数=' + runtime.methodCount + '，目录=' + rows.length, rows.length, runtime.methodCount);
    }
  });

  return {
    ok: differences.length === 0,
    counts: {
      methods: rows.length,
      floors: Object.keys(floors).length,
      gatedMethods: Object.keys(gated).length,
      featureMethods: Object.keys(featureMethods).length,
      daemonOnly: daemonOnly.length,
      states: Object.keys(state).length,
      partial: partial.length,
      unknown: unknown.length,
      schemaKeys: Object.keys(schemaKeys).length,
      paramAliases: Object.keys(paramAliases).length,
      mcpTools: mcp && Array.isArray(mcp.tools) ? mcp.tools.length : null,
      runtimeMethodLiterals: runtime && runtime.sources
        ? (() => {
          const names = [...tables.names, ...daemonOnly, ...LEGACY_MUTATING_METHODS];
          return {
            protocol: countMethodLiterals(runtime.sources.protocol || '', names).length,
            methods: countMethodLiterals(runtime.sources.methods || '', names).length,
          };
        })()
        : null,
    },
    checks,
    differences,
  };
}

/** 解析 docs/PROTOCOL-METHODS.md 的方法索引行（| `method` | read|mutation | scope |）。 */
export function parseDocsIndex(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, -1))
    .filter((cells) => cells.length === 3)
    .map(([methodCell, mutatingCell, scopeCell]) => ({
      method: methodCell.replace(/^`|`$/g, ''),
      mutating: mutatingCell === 'mutation',
      scope: scopeCell,
    }));
}

function readGenerated(module) {
  const arrayOf = (value) => {
    if (Array.isArray(value)) return [...value];
    if (value instanceof Set) return [...value];
    return [];
  };
  const tableOf = (value) => (value && typeof value === 'object' ? { ...value } : undefined);
  return {
    text: fs.readFileSync(GENERATED_PROTOCOL_PATH, 'utf8'),
    renderText: renderProtocolSource(),
    METHOD_EFFECT: tableOf(module.METHOD_EFFECT),
    METHODS: arrayOf(module.METHODS),
    MUTATING_METHODS: arrayOf(module.MUTATING_METHODS),
    LOCAL_METHODS: arrayOf(module.LOCAL_METHODS),
    SESSION_METHODS: arrayOf(module.SESSION_METHODS),
    INSTANCE_METHODS: arrayOf(module.INSTANCE_METHODS),
    EXT_METHODS: arrayOf(module.EXT_METHODS),
    METHOD_OWNER: tableOf(module.METHOD_OWNER),
    METHOD_FEATURE_FLOOR: tableOf(module.METHOD_FEATURE_FLOOR),
    METHOD_FEATURE: tableOf(module.METHOD_FEATURE),
    FEATURE_MIN_PROTOCOL: tableOf(module.FEATURE_MIN_PROTOCOL),
    FEATURE_NAMES: arrayOf(module.FEATURE_NAMES),
    FEATURE_METHODS: tableOf(module.FEATURE_METHODS),
    METHOD_STATE: tableOf(module.METHOD_STATE),
    METHOD_PARTIAL: arrayOf(module.METHOD_PARTIAL),
    METHOD_UNKNOWN: arrayOf(module.METHOD_UNKNOWN),
    METHOD_RECONCILE: tableOf(module.METHOD_RECONCILE),
    METHOD_SCHEMA_KEYS: tableOf(module.METHOD_SCHEMA_KEYS),
    PARAM_ALIASES: tableOf(module.PARAM_ALIASES),
    DAEMON_ONLY_METHODS: arrayOf(module.DAEMON_ONLY_METHODS),
    METHOD_COUNT: module.METHOD_COUNT,
  };
}

/** 收集真实仓库的审计输入（只读；不写任何文件）。 */
export async function collectSingleSourceInputs() {
  const rows = METHOD_CATALOG.map((row) => ({ method: row.method, owner: row.owner, effect: row.effect }));
  const daemonOnly = [...DAEMON_ONLY_METHODS];
  const floors = { ...FEATURE_FLOORS };
  const gated = { ...METHOD_FEATURE };
  const state = Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, { ...methodStateOf(row.method) }]));
  const legacy = {
    effects: { ...METHOD_EFFECT },
    owners: {
      local: new Set(LOCAL_METHODS),
      session: new Set(SESSION_METHODS),
      instance: new Set(INSTANCE_METHODS),
    },
    floors: { ...FEATURE_MIN_PROTOCOL },
    gated: {},
    mutating: {},
  };
  for (const row of rows) {
    legacy.gated[row.method] = featuresForCall(row.method, {})[0];
    if (!legacy.gated[row.method]) delete legacy.gated[row.method];
    legacy.mutating[row.method] = isMutating(row.method);
  }
  const generatedModule = await import(pathToFileURL(GENERATED_PROTOCOL_PATH).href);
  const docsText = fs.existsSync(GENERATED_DOCS_PATH) ? fs.readFileSync(GENERATED_DOCS_PATH, 'utf8') : '';
  const schemaReport = schemaDriftReport();
  // 运行时快照：值（派生结果）+ 源码（证明没有手工表回流）都要进审计输入。
  const runtimeMutating = {};
  for (const row of rows) runtimeMutating[row.method] = isMutating(row.method);
  for (const method of LEGACY_MUTATING_METHODS) runtimeMutating[method] = isMutating(method);
  const runtimeScope = {};
  for (const row of rows) runtimeScope[row.method] = methodScope(row.method);
  for (const method of daemonOnly) runtimeScope[method] = methodScope(method);
  const runtime = {
    methodCount: Object.keys(METHOD_EFFECT).length,
    sources: {
      protocol: fs.readFileSync(RUNTIME_SOURCE_PATHS.protocol, 'utf8'),
      methods: fs.readFileSync(RUNTIME_SOURCE_PATHS.methods, 'utf8'),
      catalog: fs.readFileSync(RUNTIME_SOURCE_PATHS.catalog, 'utf8'),
    },
    budgets: {
      protocol: { ...RUNTIME_SOURCE_BUDGETS.protocol },
      methods: { ...RUNTIME_SOURCE_BUDGETS.methods },
    },
    frozen: {
      methodEffect: Object.isFrozen(METHOD_EFFECT),
      methodEffectTable: Object.isFrozen(METHOD_EFFECT_TABLE),
    },
    protocol: {
      methodEffect: { ...METHOD_EFFECT },
      methodEffectKeys: Object.keys(METHOD_EFFECT),
      effectProbes: RUNTIME_EFFECT_PROBES.map((method) => ({ method, effect: effectOf(method) })),
    },
    methods: {
      local: [...LOCAL_METHODS],
      session: [...SESSION_METHODS],
      instance: [...INSTANCE_METHODS],
      ext: [...EXT_METHODS],
      bypass: [...SESSION_QUEUE_BYPASS],
      mutating: runtimeMutating,
      scope: runtimeScope,
      scopeProbes: RUNTIME_UNKNOWN_METHODS.map((method) => ({ method, scope: methodScope(method) })),
      validateErrors: validateMethodRegistry(),
    },
  };
  return {
    rows,
    daemonOnly,
    floors,
    gated,
    state,
    partial: [...METHOD_PARTIAL],
    unknown: [...METHOD_UNKNOWN],
    reconcile: { ...METHOD_RECONCILE },
    schemaKeys: buildSchemaKeyTable(),
    paramAliases: buildParamAliases(),
    envelope: [...REQUEST_ENVELOPE_KEYS],
    featureMethods: Object.fromEntries(Object.entries(FEATURE_METHODS).map(([feature, methods]) => [feature, [...methods]])),
    policy: { baseline: PROTOCOL_BASELINE, current: PROTOCOL_CURRENT },
    schemaReport,
    compat: {
      versions: [PROTOCOL_BASELINE, PROTOCOL_CURRENT],
      perFeature: FEATURE_NAMES.map((feature) => {
        const baselineOrder = compareProtocol(PROTOCOL_BASELINE, floors[feature]);
        const currentOrder = compareProtocol(PROTOCOL_CURRENT, floors[feature]);
        return {
          feature,
          floor: floors[feature],
          baselineAllowed: baselineOrder !== null && baselineOrder >= 0,
          currentAllowed: currentOrder !== null && currentOrder >= 0,
        };
      }),
    },
    legacy,
    generated: readGenerated(generatedModule),
    docsText,
    docsRows: parseDocsIndex(docsText),
    docsRenderText: renderMethodsDoc(),
    mcp: {
      tools: TOOLS.map((tool) => ({ name: tool.name, methods: Array.isArray(tool.methods) ? [...tool.methods] : [] })),
      toolMethods: Object.fromEntries(Object.entries(TOOL_METHODS).map(([name, methods]) => [name, [...methods]])),
    },
    runtime,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const inputs = await collectSingleSourceInputs();
  const report = auditSingleSource(inputs);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const counts = report.counts;
    console.log('protocol single source: ' + (report.ok ? 'OK' : 'FAIL')
      + '（' + counts.methods + ' 方法 / ' + counts.floors + ' feature floor / '
      + (counts.mcpTools === null ? '-' : counts.mcpTools) + ' MCP 工具 / ' + counts.daemonOnly + ' daemon 专用方法 / '
      + counts.states + ' 状态行 / ' + counts.partial + ' partial / ' + counts.unknown + ' unknown）');
    for (const check of report.checks) {
      console.log('  [' + (check.ok ? 'ok' : 'FAIL') + '] ' + check.name + (check.issues ? '（' + check.issues + ' 处不一致）' : ''));
    }
    for (const item of report.differences.slice(0, 80)) {
      console.log('  - [' + item.scope + '] ' + item.method + '：' + item.message);
    }
    if (report.differences.length > 80) {
      console.log('  ... 其余 ' + (report.differences.length - 80) + ' 处省略');
    }
  }
  process.exit(report.ok ? 0 : 1);
}
