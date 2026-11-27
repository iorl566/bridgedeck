#!/usr/bin/env node
// translation/build-dynamic-texts.mjs —— 动态文案单一数据源 → 运行时查表模块。
//
// 背景：页面/后台里大量用户可见文案是“中文片段 + 变量”拼出来的（例如
// `'已拍第 ' + n + ' 帧（' + w + '×' + h + '）'`）。这类文案无法被静态 HTML
// 词表覆盖，也不会出现在 error-hints 里，于是 12 语言界面在这些位置会回退中文。
//
// 本模块做两件事：
//   1. 从 translation/dynamic-texts.mjs（唯一数据源）生成 extension/src/overlay-dynamic-locales.js；
//   2. 提供“缺 key 门禁”所需的扫描器：把声明表面里仍然拼接的中文片段抽出来，
//      与 catalog 的 zh 模板逐条比对，没收录的片段即失败。
//
// 用法：
//   node translation/build-dynamic-texts.mjs --check   # 默认；生成物与源不一致时 exit 1
//   node translation/build-dynamic-texts.mjs --write   # 重新生成
//   node translation/build-dynamic-texts.mjs --audit   # 只跑文案覆盖审计（打印缺口）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SOURCE_PATH = path.join(ROOT, 'translation', 'dynamic-texts.mjs');
export const GENERATED_PATH = path.join(ROOT, 'extension', 'src', 'overlay-dynamic-locales.js');

/** 每个词条分片文件最多容纳的词条数：保证单个生成物不超过 src 文件复杂度预算（1100 行）。 */
export const SHARD_ENTRIES = 60;

/** 第 index 个数据分片的生成路径（index 从 0 开始，对外文件名从 1 开始）。 */
export function shardPath(index) {
  return path.join(ROOT, 'extension', 'src', 'overlay-dynamic-locales-' + (index + 1) + '.js');
}

/** 生成物固定文件头：source-guard / 漂移检查 / 手改检测都依赖它。 */
export const GENERATED_HEADER = '// 该文件由 translation/build-dynamic-texts.mjs 从 translation/dynamic-texts.mjs 生成；请勿手改。';

/** 产品 12 语言（与 overlay/error-hints 同序）。 */
export const CATALOG_LANGUAGES = Object.freeze(['zh', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'it', 'pt', 'zh-TW', 'ar', 'he']);

/** 非拉丁文字语言：这些语言的本地化必须真的含本语言文字（不能只有英文）。 */
export const CATALOG_SCRIPT = Object.freeze({
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
});

/** 诊断调用：这些函数里的中文是日志，不是用户可见文案，不进 catalog。 */
export const DIAGNOSTIC_CALLEES = Object.freeze(new Set([
  'log', 'warn', 'debug', 'trace',
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug',
]));

/** 模板占位符：{name} / {0}；文案渲染时按参数替换。 */
export const PLACEHOLDER = /\{([a-zA-Z_$][\w$]*|\d+)\}/g;

/** 从模板里取占位符集合（排序后便于比较）。 */
export function placeholdersOf(template) {
  const found = new Set();
  for (const match of String(template || '').matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found].sort();
}

/** 模板静态片段（去掉占位符后按占位符切分），用于“条目必须能在源码里找到出处”。 */
export function staticSegments(template) {
  return String(template || '')
    .split(PLACEHOLDER)
    .filter((segment, index) => index % 2 === 0)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2);
}

// ---------------------------------------------------------------------------
// 扫描器：从源码里抽取“拼接中文片段”（真实 tokenizer，注释/字符串/模板/正则都处理）
// ---------------------------------------------------------------------------

const CHINESE = /[\u4e00-\u9fa5]/;

function isIdentifierStart(ch) {
  return /[A-Za-z_$]/.test(ch || '');
}
function isIdentifierPart(ch) {
  return /[\w$]/.test(ch || '');
}

/**
 * 词法扫描源码，返回带括号调用栈上下文的字符串字面量列表。
 * 只关心“这个字面量落在哪个调用里”，因此不需要完整 AST。
 * @returns {Array<{literal:string, inner:string, kind:'single'|'double'|'template', callees:string[]}>}
 */
export function scanStringLiterals(sourceText) {
  const text = String(sourceText || '');
  const literals = [];
  const callees = [];
  let lastIdentifier = '';
  let i = 0;

  const readIdentifier = () => {
    let j = i;
    while (j < text.length && (isIdentifierPart(text[j]) || text[j] === '.')) j += 1;
    return text.slice(i, j);
  };

  const readString = (quote) => {
    let j = i + 1;
    let inner = '';
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\') { inner += text[j] + (text[j + 1] || ''); j += 2; continue; }
      if (ch === quote) { j += 1; break; }
      if (quote === '`' && ch === '$' && text[j + 1] === '{') {
        // 模板表达式：跳过 ${...}（内部括号/字符串不影响外层调用栈归属）
        let depth = 1;
        j += 2;
        while (j < text.length && depth > 0) {
          const c = text[j];
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          else if (c === "'" || c === '"' || c === '`') {
            const nested = c;
            j += 1;
            while (j < text.length) {
              if (text[j] === '\\') { j += 2; continue; }
              if (text[j] === nested) break;
              j += 1;
            }
          }
          j += 1;
        }
        inner += '${}';
        continue;
      }
      inner += ch;
      j += 1;
    }
    return { literal: text.slice(i, j), inner, end: j, kind: quote === '`' ? 'template' : quote === "'" ? 'single' : 'double' };
  };

  const isRegexStart = () => {
    const previous = text.slice(Math.max(0, i - 2), i).trim();
    if (!previous) return true;
    return /[(,=:[!&|?{};+\-*%~^<>]$/.test(previous) || /return$/.test(previous) || /=>$/.test(previous);
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      const read = readString(ch);
      const after = text.slice(read.end, read.end + 40).replace(/^\s+/, '');
      const before = text.slice(Math.max(0, start - 40), start).replace(/\s+$/, '');
      literals.push({
        literal: read.literal,
        inner: read.inner,
        kind: read.kind,
        concatenated: /\+$/.test(before) || /^\+/.test(after) || read.kind === 'template',
        callees: [...callees],
      });
      i = read.end;
      lastIdentifier = '';
      continue;
    }
    if (ch === '/') {
      if (isRegexStart()) {
        let j = i + 1;
        let inClass = false;
        while (j < text.length) {
          const c = text[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          else if (c === '\n') break;
          j += 1;
        }
        i = j + 1;
        lastIdentifier = '';
        continue;
      }
      i += 1;
      lastIdentifier = '';
      continue;
    }
    if (ch === '(') {
      callees.push(lastIdentifier || '?');
      lastIdentifier = '';
      i += 1;
      continue;
    }
    if (ch === ')') {
      callees.pop();
      lastIdentifier = '';
      i += 1;
      continue;
    }
    if (isIdentifierStart(ch)) {
      const identifier = readIdentifier();
      lastIdentifier = identifier;
      i += identifier.length;
      continue;
    }
    if (!/\s/.test(ch) && ch !== '.') lastIdentifier = '';
    i += 1;
  }
  return literals;
}

/** 最内层非匿名调用名；没有则返回空串。 */
export function innermostCallee(callees) {
  for (let index = callees.length - 1; index >= 0; index -= 1) {
    if (callees[index] && callees[index] !== '?') return callees[index];
  }
  return '';
}

/**
 * 抽取某段源码里“仍然靠拼接/模板组装的中文文案片段”。
 * 诊断日志（log/warn/console.*）不算用户可见文案，直接跳过。
 * @returns {string[]} 去重后的片段（已 trim，按出现顺序）
 */
export function extractDynamicFragments(sourceText) {
  const seen = new Set();
  const fragments = [];
  for (const literal of scanStringLiterals(sourceText)) {
    if (!literal.concatenated) continue;
    if (!CHINESE.test(literal.inner)) continue;
    const callee = innermostCallee(literal.callees);
    if (DIAGNOSTIC_CALLEES.has(callee)) continue;
    const inner = literal.inner.trim();
    if (!inner || seen.has(inner)) continue;
    seen.add(inner);
    fragments.push(inner);
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// 审计：12 语言结构 + 门禁（缺 key / 空值 / 没本地化 / 占位符漂移 / 源码覆盖）
// ---------------------------------------------------------------------------

function failure(surface, key, lang, reason) {
  return { surface, key, lang, reason, message: '[' + surface + '] ' + key + ' / ' + lang + '：' + reason };
}

/** 校验数据源结构（生成器与测试共用）。返回 { ok, failures }。 */
export function validateDynamicSource(source, { languages = CATALOG_LANGUAGES } = {}) {
  const failures = [];
  const entries = (source && source.entries) || {};
  const keys = Object.keys(entries);
  if (!keys.length) failures.push(failure('dynamic', '(all)', '(all)', '没有任何词条'));
  for (const key of keys) {
    const row = entries[key];
    if (!row || typeof row !== 'object') {
      failures.push(failure('dynamic', key, '(all)', '词条不是对象'));
      continue;
    }
    const zh = row.zh;
    if (typeof zh !== 'string' || !zh.trim()) failures.push(failure('dynamic', key, 'zh', '缺中文源'));
    else if (!CHINESE.test(zh)) failures.push(failure('dynamic', key, 'zh', '中文源不含中文'));
    const expected = placeholdersOf(zh);
    for (const lang of languages) {
      const value = row[lang];
      if (typeof value !== 'string' || !value.trim()) {
        failures.push(failure('dynamic', key, lang, '缺该语言文案'));
        continue;
      }
      const pattern = CATALOG_SCRIPT[lang];
      if (pattern && !pattern.test(value)) failures.push(failure('dynamic', key, lang, '没有本语言文字（疑似只写英文）：' + JSON.stringify(value)));
      const actual = placeholdersOf(value);
      if (actual.join(',') !== expected.join(',')) {
        failures.push(failure('dynamic', key, lang, '占位符不一致：期望 ' + expected.join(',') + ' 实际 ' + actual.join(',')));
      }
    }
  }
  return { ok: failures.length === 0, failures, keys: keys.length };
}

/** 返回 catalog 里某语言的完整表（缺语言回退 en）。 */
export function tableFor(source, lang) {
  const key = lang === 'zh' || lang === 'zh-TW' ? lang : lang;
  const entries = (source && source.entries) || {};
  const table = {};
  for (const [name, row] of Object.entries(entries)) {
    table[name] = row[key] !== undefined ? row[key] : row.en;
  }
  return table;
}

/** 把模板里的 {name}/{0} 换成参数；缺失参数原样保留（便于诊断）。 */
export function formatDynamic(template, params = {}) {
  const text = String(template || '');
  if (!params || typeof params !== 'object') return text;
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) return String(params[name]);
    const numeric = Number(name);
    if (Number.isInteger(numeric) && Object.prototype.hasOwnProperty.call(params, numeric)) return String(params[numeric]);
    return whole;
  });
}

/**
 * 缺 key 门禁：把声明表面里所有“拼接中文片段”与 catalog 的 zh 模板对齐。
 * 一条片段只要出现在任一条目的 zh 模板（或其静态片段）里就算已收录；
 * 显式豁免（exemptions）必须写明原因，且豁免的片段必须真的还在源码里（否则是死豁免）。
 * @param {{source:object, readFile:(file:string)=>string, files?:string[]}} options
 */
export function auditDynamicCoverage({ source, readFile, files } = {}) {
  const failures = [];
  const entries = (source && source.entries) || {};
  const surfaces = files || (source && source.surfaces) || [];
  const exemptions = (source && source.exemptions) || {};
  const templates = Object.values(entries).map((row) => String(row.zh || ''));
  const allStatic = templates.flatMap((template) => staticSegments(template));
  const covered = (fragment) => templates.some((template) => template.includes(fragment))
    || allStatic.some((segment) => segment.includes(fragment) || fragment.includes(segment));
  const exempted = (file, fragment) => {
    const list = exemptions[file];
    return Array.isArray(list) && list.some((item) => item && item.fragment === fragment);
  };
  let checked = 0;
  for (const file of surfaces) {
    let text = '';
    try {
      text = readFile(file);
    } catch {
      failures.push(failure('dynamic', file, '(source)', '声明表面文件不存在'));
      continue;
    }
    for (const fragment of extractDynamicFragments(text)) {
      checked += 1;
      if (covered(fragment)) continue;
      if (exempted(file, fragment)) continue;
      failures.push(failure('dynamic', file, '(zh)', '拼接中文片段没有 catalog 词条：' + JSON.stringify(fragment)));
    }
    // 死豁免：豁免的片段必须仍然存在，避免豁免表变成藏污纳垢的地方
    for (const item of (exemptions[file] || [])) {
      if (!item || typeof item.fragment !== 'string') {
        failures.push(failure('dynamic', file, '(exempt)', '豁免条目缺 fragment'));
        continue;
      }
      if (!text.includes(item.fragment)) failures.push(failure('dynamic', file, '(exempt)', '豁免片段已不在源码里：' + JSON.stringify(item.fragment)));
    }
  }
  // 反向：每个词条都要能在声明的源码里找到出处（防止凭空造词条）。
  // 模板可能把多个源码片段/变量拼成一句，因此只要求“至少一个静态片段”能在
  // 声明来源里找到锚点，而不是要求最长片段逐字存在。
  for (const [key, row] of Object.entries(entries)) {
    if (row && row.grounding === false) continue;
    const declared = Array.isArray(row.source) ? row.source : [];
    if (!declared.length) {
      failures.push(failure('dynamic', key, '(source)', '词条没有声明来源文件'));
      continue;
    }
    const segments = staticSegments(row.zh);
    if (!segments.length) continue;
    const grounded = declared.some((file) => {
      let text = '';
      try { text = readFile(file); } catch { return false; }
      return segments.some((segment) => text.includes(segment));
    });
    if (!grounded) failures.push(failure('dynamic', key, '(source)', '静态片段在声明来源里找不到锚点：' + JSON.stringify(segments.slice(0, 3))));
  }
  return { ok: failures.length === 0, checked, keys: Object.keys(entries).length, failures };
}

// ---------------------------------------------------------------------------
// 渲染 + 漂移检查
// ---------------------------------------------------------------------------

const HELPERS = String.raw`
const CATALOG_SCRIPT = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
};
const PLACEHOLDER = /\{([a-zA-Z_$][\w$]*|\d+)\}/g;

/** 语言标签归一化：与 overlay 语言包 / 错误提示同一套写法（zh-TW、iw、zh-Hant 等）。 */
export function normalizeDynamicLang(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return DYNAMIC_DEFAULT_LANG;
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('iw') || lower.startsWith('he')) return 'he';
  for (const lang of DYNAMIC_LANGS) {
    if (lang === 'zh' || lang === 'zh-TW') continue;
    if (lower === lang || lower.startsWith(lang + '-')) return lang;
  }
  return DYNAMIC_DEFAULT_LANG;
}

/** 词条是否存在。 */
export function hasDynamicText(key) {
  return Object.prototype.hasOwnProperty.call(DYNAMIC_TEXT, key);
}

/** 词条是否存在真正本地化的文案（12 语言门禁的自检入口）。 */
export function hasLocalizedDynamicText(key, lang) {
  const key2 = normalizeDynamicLang(lang);
  const row = DYNAMIC_TEXT[key];
  if (!row) return false;
  const value = row[key2];
  if (typeof value !== 'string' || !value.trim()) return false;
  const pattern = CATALOG_SCRIPT[key2];
  return pattern ? pattern.test(value) : true;
}

/** 把模板里的 {name}/{0} 换成参数；缺参数原样保留，便于发现调用点漏传。 */
export function formatDynamic(template, params) {
  const text = String(template || '');
  if (!params || typeof params !== 'object') return text;
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) return String(params[name]);
    const numeric = Number(name);
    if (Number.isInteger(numeric) && Object.prototype.hasOwnProperty.call(params, numeric)) return String(params[numeric]);
    return whole;
  });
}

/** 动态文案查表入口：语言归一化 → 词条 → 参数渲染；未知词条返回空串（由调用点兜底）。 */
export function dynamicText(lang, key, params) {
  const table = DYNAMIC_TEXT[key];
  if (!table) return '';
  const normalized = normalizeDynamicLang(lang);
  const template = table[normalized] !== undefined ? table[normalized] : table[DYNAMIC_DEFAULT_LANG];
  if (template === undefined) return '';
  return formatDynamic(template, params);
}

/** 返回某语言下全部缺词条 key（门禁/诊断用）。 */
export function missingDynamicKeys(keys, lang) {
  const normalized = normalizeDynamicLang(lang);
  return (Array.isArray(keys) ? keys : []).filter((key) => {
    const row = DYNAMIC_TEXT[key];
    if (!row) return true;
    const value = row[normalized];
    return typeof value !== 'string' || !value.trim();
  });
}
`;

/** 读数据源（动态 import，便于测试替换）。 */
export async function loadDynamicTexts(file = SOURCE_PATH) {
  const module = await import(pathToFileURL(file).href + '?t=' + Date.now());
  const source = module.DYNAMIC_SOURCE;
  if (!source || typeof source !== 'object') throw new Error('dynamic-texts.mjs 缺 DYNAMIC_SOURCE');
  if (!Array.isArray(source.languages) || !source.languages.length) throw new Error('DYNAMIC_SOURCE 缺 languages');
  if (!source.entries || typeof source.entries !== 'object') throw new Error('DYNAMIC_SOURCE 缺 entries');
  return source;
}

/** 把词条按固定大小切成数据分片（确定性输出；避免单个生成物超过复杂度预算）。 */
export function chunkEntries(entries, size = SHARD_ENTRIES) {
  const keys = Object.keys(entries);
  const chunks = [];
  for (let index = 0; index < keys.length; index += size) {
    const chunk = {};
    for (const key of keys.slice(index, index + size)) chunk[key] = entries[key];
    chunks.push(chunk);
  }
  return chunks;
}

/** 渲染一个数据分片模块（只有数据，没有逻辑）。 */
export function renderDynamicShard(entries, index) {
  const moduleName = 'DYNAMIC_TEXT_SHARD_' + (index + 1);
  const languages = Object.keys(Object.values(entries)[0] || {}).filter((key) => key !== 'source' && key !== 'grounding');
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push('// 动态文案分片 ' + (index + 1) + '：仅数据，由 overlay-dynamic-locales.js 汇总。');
  lines.push('export const ' + moduleName + ' = {');
  for (const [key, row] of Object.entries(entries)) {
    lines.push('  ' + JSON.stringify(key) + ': {');
    for (const lang of languages) {
      const value = row[lang];
      if (typeof value !== 'string' || !value.trim()) throw new Error('动态文案 ' + key + ' 缺语言 ' + lang);
      lines.push('    ' + JSON.stringify(lang) + ': ' + JSON.stringify(value) + ',');
    }
    lines.push('  },');
  }
  lines.push('};');
  return lines.join('\n');
}

/** 把所有数据分片渲染成 { 路径: 文本 }（含主模块）。 */
export function renderDynamicFiles(source) {
  const languages = (source && source.languages) || CATALOG_LANGUAGES;
  const entries = (source && source.entries) || {};
  const chunks = chunkEntries(entries);
  const files = new Map();
  chunks.forEach((chunk, index) => files.set(shardPath(index), renderDynamicShard(chunk, index)));
  files.set(GENERATED_PATH, renderDynamicModule(source, chunks.length));
  return files;
}

/** 读取目录里已经存在的分片文件（用于清理过期分片 / 漂移检测）。 */
export function listGeneratedShards() {
  const dir = path.dirname(GENERATED_PATH);
  const prefix = 'overlay-dynamic-locales-';
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.js'))
    .map((name) => path.join(dir, name))
    .sort();
}

/** 把数据源渲染成 extension/src/overlay-dynamic-locales.js 的完整文本（确定性输出）。 */
export function renderDynamicModule(source, shardCount) {
  const languages = (source && source.languages) || CATALOG_LANGUAGES;
  const entries = (source && source.entries) || {};
  const chunks = shardCount === undefined ? chunkEntries(entries).length : shardCount;
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push('// 动态文案（拼接句子）12 语言查表：与 overlay-locales.js / error-hints.js 共用语言归一化与回退策略。');
  lines.push('// 词条数据按分片文件存放（每个生成物都受 src 文件复杂度预算约束）。');
  lines.push('');
  for (let index = 0; index < chunks; index += 1) {
    lines.push("import { DYNAMIC_TEXT_SHARD_" + (index + 1) + " } from './overlay-dynamic-locales-" + (index + 1) + ".js';");
  }
  lines.push('');
  lines.push('export const DYNAMIC_LANGS = ' + JSON.stringify(languages) + ';');
  lines.push('export const DYNAMIC_DEFAULT_LANG = ' + JSON.stringify('en') + ';');
  lines.push('');
  lines.push('export const DYNAMIC_KEYS = [');
  for (const key of Object.keys(entries)) lines.push('  ' + JSON.stringify(key) + ',');
  lines.push('];');
  lines.push('');
  lines.push('export const DYNAMIC_TEXT = {');
  for (let index = 0; index < chunks; index += 1) {
    lines.push('  ...DYNAMIC_TEXT_SHARD_' + (index + 1) + ',');
  }
  lines.push('};');
  lines.push('');
  lines.push(HELPERS.replace(/^\n/, ''));
  return lines.join('\n');
}

/** 检查磁盘生成物（主模块 + 全部分片）是否与源一致。 */
export async function checkDynamicTexts(sourcePath = SOURCE_PATH) {
  const source = await loadDynamicTexts(sourcePath);
  const expectedFiles = renderDynamicFiles(source);
  const mismatches = [];
  for (const [file, expected] of expectedFiles) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (actual !== expected) mismatches.push(path.relative(ROOT, file));
  }
  const expectedPaths = new Set([...expectedFiles.keys()]);
  const stale = listGeneratedShards().filter((file) => !expectedPaths.has(file));
  return {
    ok: mismatches.length === 0 && stale.length === 0,
    mismatches,
    stale,
    expected: expectedFiles.get(GENERATED_PATH),
    actual: fs.existsSync(GENERATED_PATH) ? fs.readFileSync(GENERATED_PATH, 'utf8') : '',
    source,
    files: expectedFiles,
  };
}

/** 写生成物（--write），并清理过期分片。 */
export async function writeDynamicTexts(sourcePath = SOURCE_PATH) {
  const source = await loadDynamicTexts(sourcePath);
  const validation = validateDynamicSource(source, { languages: source.languages });
  if (!validation.ok) throw new Error('动态文案数据源校验失败：\n' + validation.failures.slice(0, 20).map((item) => item.message).join('\n'));
  const files = renderDynamicFiles(source);
  for (const [file, text] of files) fs.writeFileSync(file, text, 'utf8');
  const expectedPaths = new Set([...files.keys()]);
  const stale = listGeneratedShards().filter((file) => !expectedPaths.has(file));
  for (const file of stale) fs.rmSync(file, { force: true });
  return { files, stale, source, text: files.get(GENERATED_PATH) };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const source = await loadDynamicTexts();
  const validation = validateDynamicSource(source, { languages: source.languages });
  const coverage = auditDynamicCoverage({ source, readFile: (file) => fs.readFileSync(path.join(ROOT, file), 'utf8') });
  const failures = [...validation.failures, ...coverage.failures];
  const write = process.argv.includes('--write');
  if (failures.length) {
    console.error('dynamic texts: FAILED —— ' + failures.length + ' 条问题');
    for (const item of failures.slice(0, 40)) console.error('  - ' + item.message);
    process.exit(1);
  }
  if (write) {
    const result = await writeDynamicTexts();
    console.log('dynamic texts: 已生成 extension/src/overlay-dynamic-locales.js + ' + (result.files.size - 1) + ' 个数据分片（' + Object.keys(source.entries).length + ' 词条 / ' + source.languages.length + ' 语言 / ' + result.text.length + ' 字符主模块）');
    if (result.stale.length) console.log('dynamic texts: 已清理过期分片 ' + result.stale.map((file) => path.relative(ROOT, file)).join(', '));
    process.exit(0);
  }
  if (process.argv.includes('--audit')) {
    console.log('dynamic texts: audit OK（' + coverage.keys + ' 词条，' + coverage.checked + ' 个拼接片段全覆盖）');
    process.exit(0);
  }
  const drift = await checkDynamicTexts();
  if (drift.ok) {
    console.log('dynamic texts: clean（生成物与 translation/dynamic-texts.mjs 一致；' + coverage.checked + ' 个拼接片段全覆盖）');
    process.exit(0);
  }
  console.error('dynamic texts: FAILED —— 生成物与源不一致：' + [...drift.mismatches, ...drift.stale.map((file) => path.relative(ROOT, file))].join(', ')
    + '；请运行 node translation/build-dynamic-texts.mjs --write');
  process.exit(1);
}
