#!/usr/bin/env node
// docs/store-listing/validate.mjs — 校验各语言商店文案是否满足 Partner Center 限制。
// 用法：node docs/store-listing/validate.mjs [--json]
//
// 检查项：
// - 13 个 locale 文件齐全（en-US、zh-CN、zh-TW、ja-JP、ko-KR、de-DE、fr-FR、es-ES、it-IT、pt-BR、pt-PT、ar-SA、he-IL）
// - Description 长度 250–10,000 字符（Partner Center 硬限制）
// - Search terms ≤7 条、单条 ≤30 字符、总词数 ≤21
// - 包内 manifest 短描述（_locales/*/messages.json）长度提示（Chromium 上限 132 字符，只警告）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'docs', 'store-listing');

const LOCALES = [
  ['en-US', 'en'],
  ['zh-CN', 'zh_CN'],
  ['zh-TW', 'zh_TW'],
  ['ja-JP', 'ja'],
  ['ko-KR', 'ko'],
  ['de-DE', 'de'],
  ['fr-FR', 'fr'],
  ['es-ES', 'es'],
  ['it-IT', 'it'],
  ['pt-BR', 'pt_BR'],
  ['pt-PT', 'pt_PT'],
  ['ar-SA', 'ar'],
  ['he-IL', 'he'],
];

const DESCRIPTION_MIN = 250;
const DESCRIPTION_MAX = 10_000;
const SHORT_DESCRIPTION_MAX = 132;
const SEARCH_MAX_TERMS = 7;
const SEARCH_MAX_TERM_CHARS = 30;
const SEARCH_MAX_WORDS = 21;

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length + 4);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function parseTerms(text) {
  return section(text, 'Search terms')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim());
}

function wordCount(term) {
  // 中日韩等无空格语言按“词”计不现实：按空白分词，非 ASCII 连续串记为 1 词。
  return term.split(/\s+/).filter(Boolean).length;
}

function manifestShortDescription(pkgLocale) {
  const file = path.join(ROOT, 'extension', '_locales', pkgLocale, 'messages.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).extDescription?.message ?? null;
  } catch {
    return null;
  }
}

const results = [];
let failed = 0;

for (const [locale, pkg] of LOCALES) {
  const file = path.join(DIR, `${locale}.md`);
  const problems = [];
  const warnings = [];

  if (!fs.existsSync(file)) {
    results.push({ locale, ok: false, problems: ['缺少文件 docs/store-listing/' + locale + '.md'], warnings: [] });
    failed += 1;
    continue;
  }

  const text = fs.readFileSync(file, 'utf8');
  const description = section(text, 'Description');
  const terms = parseTerms(text);
  const chars = [...description].length;

  if (!description) problems.push('缺少 "## Description" 段');
  if (chars < DESCRIPTION_MIN) problems.push(`Description 只有 ${chars} 字符，少于 ${DESCRIPTION_MIN}`);
  if (chars > DESCRIPTION_MAX) problems.push(`Description ${chars} 字符，超过 ${DESCRIPTION_MAX}`);

  if (terms.length === 0) problems.push('缺少 "## Search terms" 条目');
  if (terms.length > SEARCH_MAX_TERMS) problems.push(`Search terms ${terms.length} 条，超过 ${SEARCH_MAX_TERMS}`);
  for (const term of terms) {
    if ([...term].length > SEARCH_MAX_TERM_CHARS) problems.push(`搜索词过长（>${SEARCH_MAX_TERM_CHARS}）：${term}`);
  }
  const words = terms.reduce((sum, term) => sum + wordCount(term), 0);
  if (words > SEARCH_MAX_WORDS) problems.push(`搜索词总词数 ${words}，超过 ${SEARCH_MAX_WORDS}`);

  const short = manifestShortDescription(pkg);
  if (short !== null) {
    if ([...short].length > SHORT_DESCRIPTION_MAX) {
      warnings.push(`包内短描述 ${[...short].length} 字符（Chromium 上限 ${SHORT_DESCRIPTION_MAX}），Partner Center 可能截断`);
    }
  } else {
    warnings.push(`未找到 extension/_locales/${pkg}/messages.json`);
  }

  results.push({ locale, ok: problems.length === 0, chars, terms: terms.length, words, problems, warnings });
  if (problems.length > 0) failed += 1;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed === 0, results }, null, 2));
} else {
  for (const row of results) {
    const status = row.ok ? 'PASS' : 'FAIL';
    console.log(`${status} ${row.locale.padEnd(6)} description=${String(row.chars ?? '-').padStart(4)} chars  terms=${row.terms ?? '-'} (${row.words ?? '-'} words)`);
    for (const problem of row.problems) console.log(`  - ${problem}`);
    for (const warning of row.warnings) console.log(`  ! ${warning}`);
  }
  console.log(failed === 0 ? '\nAll listing files pass the Partner Center limits.' : `\n${failed} locale(s) need work.`);
}

process.exit(failed === 0 ? 0 : 1);
