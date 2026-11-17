import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiDir = path.join(ROOT, 'extension', 'ui');
const html = fs.readdirSync(uiDir)
  .filter((file) => file.endsWith('.html'))
  .map((file) => fs.readFileSync(path.join(uiDir, file), 'utf8'))
  .join('\n');
const i18n = fs.readFileSync(path.join(ROOT, 'extension', 'ui', 'i18n.js'), 'utf8');

function dictKeys() {
  const start = i18n.indexOf('const DICT = {');
  const end = i18n.indexOf('\n};\nconst PATTERNS', start);
  return new Set(Object.keys(new Function('return (' + i18n.slice(start + 'const DICT = '.length, end + 2) + ')')()));
}

function visibleChinese() {
  const texts = new Set();
  for (const match of html.matchAll(/>([^<>]*[\u4e00-\u9fa5][^<>]*)</g)) texts.add(match[1].trim());
  for (const match of html.matchAll(/(?:title|placeholder|aria-label)="([^"]*[\u4e00-\u9fa5][^"]*)"/g)) texts.add(match[1].trim());
  return texts;
}

test('所有 ui/*.html 的静态中文都有英文词条', () => {
  const keys = dictKeys();
  const missing = [...visibleChinese()].filter((text) => !keys.has(text) && !keys.has(text.replace(/\s+/g, ' ')));
  assert.deepEqual(missing, []);
});
