#!/usr/bin/env node
// tools/protocol-sections.mjs —— 协议面文档一致性：每个 canonical 方法都必须在文档里出现。
//
// 默认只读检查（--fail 时缺失/文档过期即退出 1）；--write 调 tools/gen-protocol.mjs 的
// renderMethodsDoc() 重新生成 docs/PROTOCOL-METHODS.md（单一源 = lib/method-catalog.mjs），
// 保证新增方法不会只在代码里“隐身”，也保证文档不是手改出来的第二份事实。
import fs from 'node:fs';
import path from 'node:path';
import {
  DAEMON_ONLY_METHODS,
  FEATURE_NAMES,
  METHOD_CATALOG,
} from '../lib/method-catalog.mjs';
import { GENERATED_DOCS_PATH, renderMethodsDoc } from './gen-protocol.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PROTOCOL.md');
const INDEX = GENERATED_DOCS_PATH;
const writeMode = process.argv.includes('--write');
const failMode = process.argv.includes('--fail');

const methods = new Set([
  ...METHOD_CATALOG.map((row) => row.method),
  ...DAEMON_ONLY_METHODS,
]);
const features = new Set(FEATURE_NAMES);

if (writeMode) {
  fs.writeFileSync(INDEX, renderMethodsDoc(), 'utf8');
  console.log('已生成 ' + path.relative(ROOT, INDEX) + '（' + methods.size + ' 个方法，' + features.size + ' 个特性门）');
  process.exit(0);
}

const docs = [DOC, INDEX]
  .filter((file) => fs.existsSync(file))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
const missing = [...methods].filter((method) => !new RegExp('`' + method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`').test(docs)).sort();
const mentioned = new Set(docs.match(/`[a-z][a-z0-9]*(?:\.[a-z0-9_]+)+`/g) || []);
const unknown = [...mentioned]
  .map((item) => item.slice(1, -1))
  .filter((method) => !methods.has(method) && !features.has(method) && !method.startsWith('bb.'))
  .sort();
const stale = fs.existsSync(INDEX) && fs.readFileSync(INDEX, 'utf8') !== renderMethodsDoc();

console.log('methods=' + methods.size + ' documented=' + (methods.size - missing.length) + ' missing=' + missing.length
  + ' unknownRefs=' + unknown.length + ' features=' + features.size + ' stale=' + (stale ? 'yes' : 'no'));
for (const item of missing.slice(0, 40)) console.log('  MISSING ' + item);
for (const item of unknown.slice(0, 20)) console.log('  UNKNOWN ' + item);
if (stale) console.log('  STALE docs/PROTOCOL-METHODS.md（运行 node tools/gen-protocol.mjs 或 --write）');
if (failMode && (missing.length || stale)) process.exit(1);
