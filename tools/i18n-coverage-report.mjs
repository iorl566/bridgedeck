#!/usr/bin/env node
// tools/i18n-coverage-report.mjs —— 扫描 extension/ui 下所有 HTML 的静态中文，
// 对比 i18n.js 的 DICT，输出缺口清单（只读，不改文件）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'extension', 'ui');
const i18n = fs.readFileSync(path.join(UI, 'i18n.js'), 'utf8');
const start = i18n.indexOf('const DICT = {');
const end = i18n.indexOf('\n};\nconst PATTERNS', start);
const dict = new Function('return (' + i18n.slice(start + 'const DICT = '.length, end + 2) + ')')();
const keys = new Set(Object.keys(dict));

const report = {};
let total = 0;
for (const file of fs.readdirSync(UI).filter((name) => name.endsWith('.html')).sort()) {
  const html = fs.readFileSync(path.join(UI, file), 'utf8');
  const texts = new Set();
  for (const match of html.matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) texts.add(match[1].trim());
  for (const match of html.matchAll(/(?:title|placeholder|aria-label)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) texts.add(match[1].trim());
  const missing = [...texts].filter((text) => !keys.has(text) && !keys.has(text.replace(/\s+/g, ' ')));
  total += missing.length;
  report[file] = { texts: texts.size, missing };
}

const out = path.join(ROOT, 'docs', 'I18N-COVERAGE.md');
const lines = ['# i18n 覆盖报告', '', '由 `node tools/i18n-coverage-report.mjs` 生成。', '', `DICT 词条：${keys.size}`, '', '| 页面 | 静态中文 | 缺失 |', '| --- | ---: | ---: |'];
for (const [file, item] of Object.entries(report)) lines.push(`| ${file} | ${item.texts} | ${item.missing.length} |`);
lines.push('', '## 缺失文本', '');
for (const [file, item] of Object.entries(report)) {
  if (!item.missing.length) continue;
  lines.push('### ' + file, '');
  for (const text of item.missing) lines.push('- `' + text.replace(/`/g, '\\`') + '`');
  lines.push('');
}
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(JSON.stringify({ ok: true, dictKeys: keys.size, missing: total, out: path.relative(ROOT, out), report }, null, 2));
