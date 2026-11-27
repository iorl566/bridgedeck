#!/usr/bin/env node
// tools/build-page-lib.mjs —— 把 injected/parts/*.js 按序合并成 injected/page-lib.js。
// 运行时仍是单文件注入（同一 IIFE 闭包）；分块只改善源码组织，合并产物必须与分块完全一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = path.join(ROOT, 'extension', 'injected', 'parts');
const TARGET = path.join(ROOT, 'extension', 'injected', 'page-lib.js');
const check = process.argv.includes('--check');

const files = fs.readdirSync(PARTS).filter((name) => name.endsWith('.part')).sort();
if (!files.length) throw new Error('injected/parts 没有分块文件');
const built = files.map((name) => fs.readFileSync(path.join(PARTS, name), 'utf8')).join('');
const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';

if (check) {
  if (built !== current) {
    console.error('page-lib 分块与合并产物不一致；运行 npm run build:page-lib 重新生成');
    process.exit(1);
  }
  console.log('page-lib parts: clean (' + files.length + ' parts, ' + built.split('\n').length + ' lines)');
  process.exit(0);
}

fs.writeFileSync(TARGET, built, 'utf8');
console.log('page-lib built: ' + files.length + ' parts, ' + built.split('\n').length + ' lines');
