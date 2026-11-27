#!/usr/bin/env node
// translation/build-error-hints.mjs —— 从 translation/error-hints.json 生成
// extension/ui/error-hints.js（单一数据源 + 漂移检查）。
//
// 用法：
//   node translation/build-error-hints.mjs --check   # 默认；生成物与源不一致时 exit 1
//   node translation/build-error-hints.mjs --write   # 重新生成
//
// 设计说明：扩展页面不能读 translation/*.json（不是扩展资源），所以运行时模块必须
// 是构建产物。这里把“渲染”做成纯函数，测试直接 import 并与磁盘文件逐字节比较，
// 任何手改生成物的行为都会让门禁失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_PATH = path.join(ROOT, 'translation', 'error-hints.json');
export const GENERATED_PATH = path.join(ROOT, 'extension', 'ui', 'error-hints.js');

/** 生成物的固定提示前缀：source-guard 与漂移检查都依赖它。 */
export const GENERATED_HEADER = '// 该文件由 translation/build-error-hints.mjs 从 translation/error-hints.json 生成；请勿手改。';

/** 读取并校验源文件，返回 { languages, codes, unknown }。 */
export function loadErrorHints(file = SOURCE_PATH) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.languages) || !data.languages.length) throw new Error('error-hints.json 缺 languages');
  if (!data.codes || typeof data.codes !== 'object') throw new Error('error-hints.json 缺 codes');
  if (!data.unknown || typeof data.unknown !== 'object') throw new Error('error-hints.json 缺 unknown');
  return data;
}

/** 生成器渲染的运行时辅助函数（与数据同源，避免“数据在 JSON、逻辑在 JS”两处漂移）。 */
const HELPERS = String.raw`
const CODE_PATTERN = /(?:^|[^A-Z0-9_])(E_[A-Z][A-Z0-9_]*)(?![A-Z0-9_])/;
const SCRIPT_PATTERNS = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
  'zh-TW': /[\u4e00-\u9fff]/,
};

/** 语言标签归一化：接受浏览器/存储里的 zh-TW、zh-tw、zh-Hant、iw 等写法。 */
export function normalizeHintLang(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return 'en';
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('iw') || lower.startsWith('he')) return 'he';
  for (const lang of HINT_LANGS) {
    if (lang === 'zh-TW' || lang === 'zh') continue;
    if (lower === lang || lower.startsWith(lang + '-')) return lang;
  }
  return 'en';
}

/** 从 { code } / Error / 字符串里提取协议错误码；没有则返回 null。 */
export function errorCodeOf(input) {
  if (!input) return null;
  const direct = typeof input === 'object' && typeof input.code === 'string' ? input.code : '';
  if (direct) return direct.toUpperCase();
  const text = typeof input === 'string' ? input : String(input.message || '');
  const match = CODE_PATTERN.exec(text);
  return match ? match[1] : null;
}

/** 返回某语言的未知错误兜底文案。 */
export function unknownHint(lang) {
  const key = normalizeHintLang(lang);
  return UNKNOWN_HINTS[key] || UNKNOWN_HINTS.en;
}

/** 错误码 + 语言 → 用户可读提示；未收录的码回退到该语言的未知错误文案。 */
export function hintForCode(code, lang) {
  const key = normalizeHintLang(lang);
  const normalized = errorCodeOf(code) || (typeof code === 'string' ? String(code).toUpperCase() : '');
  const entry = normalized ? ERROR_HINTS[normalized] : null;
  if (entry && entry[key]) return entry[key];
  if (entry && entry.en) return entry.en;
  return unknownHint(key);
}

/** 该语言下是否存在真正本地化的提示（用于 12 语言覆盖门禁的自检）。 */
export function hasLocalizedHint(code, lang) {
  const key = normalizeHintLang(lang);
  const entry = ERROR_HINTS[String(code || '').toUpperCase()];
  if (!entry || typeof entry[key] !== 'string' || !entry[key].trim()) return false;
  return true;
}

/**
 * 把 { code, message } / Error / 原始字符串转成结构化提示。
 * 有错误码时优先使用本地化提示（原始英文/中文 message 仅保留在 message 字段，
 * 便于诊断，不直接展示给用户）；没有错误码时才回退到原始 message。
 */
export function describeError(input, lang) {
  const code = errorCodeOf(input);
  const rawMessage = typeof input === 'string'
    ? input
    : String((input && (input.message || input.error)) || '');
  const hint = code ? hintForCode(code, lang) : '';
  const fallback = hint || rawMessage || unknownHint(lang);
  return {
    code: code || null,
    hint: hint || null,
    message: rawMessage,
    text: code ? fallback + ' (' + code + ')' : fallback,
  };
}

/** 只要一行展示文案时的便捷入口。 */
export function localizeErrorText(input, lang) {
  return describeError(input, lang).text;
}

/** 门禁用：判断某段文案是否是“只有英文”（给本地化语言用）。 */
export function isEnglishOnlyHint(text) {
  const value = String(text || '');
  const latinWords = value.match(/[A-Za-z]{2,}/g) || [];
  if (!latinWords.length) return false;
  for (const pattern of Object.values(SCRIPT_PATTERNS)) {
    if (pattern.test(value)) return false;
  }
  return true;
}
`;

/** 把 JSON 数据渲染成 extension/ui/error-hints.js 的完整文本（确定性输出）。 */
export function renderErrorHintsModule(data) {
  const languages = data.languages;
  const codes = data.codes;
  const lines = [];
  lines.push(GENERATED_HEADER);
  lines.push('// 错误码→用户提示的 12 语言文案；UI 只展示提示，不直接展示英文协议错误。');
  lines.push('');
  lines.push('export const HINT_LANGS = ' + JSON.stringify(languages) + ';');
  lines.push('export const HINT_FALLBACK_LANG = ' + JSON.stringify('en') + ';');
  lines.push('export const ERROR_HINT_CODES = [');
  for (const code of Object.keys(codes)) lines.push('  ' + JSON.stringify(code) + ',');
  lines.push('];');
  lines.push('');
  lines.push('export const ERROR_HINTS = {');
  for (const [code, row] of Object.entries(codes)) {
    lines.push('  ' + JSON.stringify(code) + ': {');
    for (const lang of languages) {
      if (typeof row[lang] !== 'string') throw new Error('错误码 ' + code + ' 缺语言 ' + lang);
      lines.push('    ' + JSON.stringify(lang) + ': ' + JSON.stringify(row[lang]) + ',');
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('export const UNKNOWN_HINTS = {');
  for (const lang of languages) {
    if (typeof data.unknown[lang] !== 'string') throw new Error('unknown 缺语言 ' + lang);
    lines.push('  ' + JSON.stringify(lang) + ': ' + JSON.stringify(data.unknown[lang]) + ',');
  }
  lines.push('};');
  lines.push(HELPERS.replace(/^\n/, ''));
  return lines.join('\n');
}

/** 检查磁盘生成物是否与源一致；返回 { ok, expected, actual }。 */
export function checkErrorHints(file = GENERATED_PATH, source = SOURCE_PATH) {
  const expected = renderErrorHintsModule(loadErrorHints(source));
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return { ok: actual === expected, expected, actual };
}

/** 写生成物（--write）。 */
export function writeErrorHints(file = GENERATED_PATH, source = SOURCE_PATH) {
  const text = renderErrorHintsModule(loadErrorHints(source));
  fs.writeFileSync(file, text, 'utf8');
  return text.length;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const write = process.argv.includes('--write');
  if (write) {
    const size = writeErrorHints();
    console.log('error-hints: 已生成 extension/ui/error-hints.js（' + size + ' 字符）');
    process.exit(0);
  }
  const result = checkErrorHints();
  if (result.ok) {
    console.log('error-hints: clean（生成物与 translation/error-hints.json 一致）');
    process.exit(0);
  }
  console.error('error-hints: FAILED —— extension/ui/error-hints.js 与源不一致，请运行 node translation/build-error-hints.mjs --write');
  process.exit(1);
}
