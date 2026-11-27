#!/usr/bin/env node
// tools/compare-bsk.mjs —— 生成 上游 0.5.0 vs BridgeDeck 的源码对比指标（只读）。
// 用法：node tools/compare-bsk.mjs [--bsk <目录>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIndex = process.argv.indexOf('--bsk');
const BSK = path.resolve(ROOT, argIndex >= 0 && process.argv[argIndex + 1] ? process.argv[argIndex + 1] : 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0');
const SKIP = new Set(['node_modules', 'dist', 'target', 'coverage', '.git', 'vendor', 'reference', 'ref', '.ref', '.tmp', '.tmp-bench']);

function collect(dir, predicate) {
  const files = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (predicate(full)) files.push(full);
    }
  }
  walk(dir);
  let lines = 0;
  for (const file of files) lines += fs.readFileSync(file, 'utf8').split('\n').length;
  return { files: files.length, lines };
}

const isCode = (file) => ['.rs', '.ts', '.tsx', '.js', '.mjs'].includes(path.extname(file));
const isTest = (file) => /\.(test|spec)\./.test(path.basename(file)) || /[\\/]tests?[\\/]/.test(file) || /_test\.rs$/.test(file);

function bskStats() {
  const extensionAll = collect(path.join(BSK, 'apps/extension'), isCode);
  const extensionTest = collect(path.join(BSK, 'apps/extension'), (file) => isCode(file) && isTest(file));
  const rustAll = collect(path.join(BSK, 'crates'), (file) => path.extname(file) === '.rs');
  const rustTest = collect(path.join(BSK, 'crates'), (file) => path.extname(file) === '.rs' && isTest(file));
  const ds = collect(path.join(BSK, 'packages/dsh-plugin-browserskill'), isCode);
  const vom = collect(path.join(BSK, 'packages/vom'), (file) => ['.ts', '.tsx'].includes(path.extname(file)) && !isTest(file));
  const evals = collect(path.join(BSK, 'evals/browser'), isCode);
  return {
    extensionRuntime: extensionAll.lines - extensionTest.lines,
    extensionTests: extensionTest.lines,
    rustRuntime: rustAll.lines - rustTest.lines,
    rustTests: rustTest.lines,
    dshPlugin: ds.lines,
    vom: vom.lines,
    evals: evals.lines,
  };
}

function bridgeDeckStats() {
  const dirs = ['extension', 'daemon', 'cli', 'mcp', 'lib', 'sdk', 'dsh-plugin', 'tests', 'tools'];
  let all = { files: 0, lines: 0 };
  for (const dir of dirs) {
    const stat = collect(path.join(ROOT, dir), isCode);
    all = { files: all.files + stat.files, lines: all.lines + stat.lines };
  }
  const extension = collect(path.join(ROOT, 'extension'), isCode);
  const daemon = collect(path.join(ROOT, 'daemon'), isCode);
  const cli = collect(path.join(ROOT, 'cli'), isCode);
  const mcp = collect(path.join(ROOT, 'mcp'), isCode);
  const lib = collect(path.join(ROOT, 'lib'), isCode);
  const dsh = collect(path.join(ROOT, 'dsh-plugin'), isCode);
  const vom = collect(path.join(ROOT, 'extension/src/lib'), (file) => /vom-.*\.js$/.test(file));
  return {
    all,
    extension: extension.lines,
    daemon: daemon.lines,
    cli: cli.lines,
    mcp: mcp.lines,
    lib: lib.lines,
    dshPlugin: dsh.lines,
    vom: vom.lines,
  };
}

function countBskMethods() {
  const file = path.join(BSK, 'crates/bsk-protocol/src/method.rs');
  if (!fs.existsSync(file)) return null;
  return (fs.readFileSync(file, 'utf8').match(/^\s+[A-Z][A-Za-z0-9]* => \("/gm) || []).length;
}

const bsk = bskStats();
const bd = bridgeDeckStats();
const bskMethods = countBskMethods();
const bskAll = collect(BSK, isCode);
const bskCode = bskAll.lines;
const bdCode = bd.all.lines;

console.log('指标'.padEnd(22), 'BSK 0.5.0'.padStart(14), 'BridgeDeck'.padStart(14));
console.log('全部代码（含测试/工具）'.padEnd(22), String(bskCode).padStart(14), String(bdCode).padStart(14));
console.log('扩展运行时'.padEnd(22), String(bsk.extensionRuntime).padStart(14), String(bd.extension).padStart(14));
console.log('扩展测试'.padEnd(22), String(bsk.extensionTests).padStart(14), '-'.padStart(14));
console.log('CLI/daemon/协议'.padEnd(22), String(bsk.rustRuntime).padStart(14), String(bd.daemon + bd.cli + bd.mcp + bd.lib).padStart(14));
console.log('DSH 插件'.padEnd(22), String(bsk.dshPlugin).padStart(14), String(bd.dshPlugin).padStart(14));
console.log('VOM 专用模块'.padEnd(22), String(bsk.vom).padStart(14), String(bd.vom).padStart(14));
console.log('Eval 源码'.padEnd(22), String(bsk.evals).padStart(14), '-'.padStart(14));
console.log('Wire 方法'.padEnd(22), String(bskMethods ?? '?').padStart(14), String(165).padStart(14));
console.log('代码比例'.padEnd(22), '-'.padStart(14), `${(bdCode / bskCode * 100).toFixed(1)}%`.padStart(14));
