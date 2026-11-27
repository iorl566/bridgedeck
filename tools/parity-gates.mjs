#!/usr/bin/env node
// tools/parity-gates.mjs —— 对标波次的标准门禁批量执行器。
//
// 用途：每轮对标结束跑同一套门禁，输出一张表；任一失败整体 exit 1。
// 用法：
//   node tools/parity-gates.mjs            # 全套（单测 + selftest + 静态门禁）
//   node tools/parity-gates.mjs --quick    # 跳过单测全量（只跑静态 + selftest）
//   node tools/parity-gates.mjs --with-e2e # 追加真实 Edge E2E（约 15 分钟）
// 说明：E2E 会重写 docs/assets/ui/breathing-glow-*.png，跑完需要从备份还原（见 docs/ARCH-TRACK.md）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const quick = process.argv.includes('--quick');
const withE2e = process.argv.includes('--with-e2e');

function run(args, { env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(node, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 45 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - startedAt });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error && error.message), ms: Date.now() - startedAt });
    });
  });
}

const tail = (text, lines = 2) => text.trim().split(/\r?\n/).slice(-lines).join(' | ');

const counts = (text) => {
  const pick = (label) => (text.match(new RegExp('ℹ ' + label + ' (\\d+)')) || [])[1] || '?';
  return `tests ${pick('tests')} / pass ${pick('pass')} / fail ${pick('fail')}`;
};

const gates = [
  { name: 'unit', args: ['--test', 'tests/unit/*.test.mjs'], skip: quick, summary: (r) => counts(r.stdout) },
  { name: 'cli', args: ['tests/cli/selftest.mjs'], summary: (r) => tail(r.stdout, 2) },
  { name: 'mcp', args: ['tests/mcp/selftest.mjs'], summary: (r) => tail(r.stdout, 2) },
  { name: 'plugin', args: ['tests/plugin/selftest.mjs'], summary: (r) => tail(r.stdout, 2) },
  { name: 'pairing', args: ['tests/pairing/selftest.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'tls', args: ['tests/tls/selftest.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'ws', args: ['tests/ws-selftest.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'module-load', args: ['tests/extension/module-load.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'page-guard', args: ['tests/extension/page-guard.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'overlay-dom', args: ['tools/overlay-dom-selftest.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'page-lib', args: ['tools/build-page-lib.mjs', '--check'], summary: (r) => tail(r.stdout, 1) },
  { name: 'protocol-gen', args: ['tools/gen-protocol.mjs', '--check'], summary: (r) => tail(r.stdout, 1) },
  { name: 'protocol-single', args: ['tools/protocol-single-source.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'protocol-check', args: ['tools/protocol-check.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'protocol-docs', args: ['tools/protocol-sections.mjs', '--fail'], summary: (r) => tail(r.stdout, 1) },
  { name: 'schema-audit', args: ['tools/schema-audit.mjs', '--check'], summary: (r) => tail(r.stdout, 1) },
  { name: 'vom-bench', args: ['tools/vom-bench.mjs', '--check'], summary: (r) => tail(r.stdout, 1) },
  { name: 'source-guard', args: ['tools/source-guard.mjs'], summary: (r) => tail(r.stdout, 1) },
  { name: 'ts-packages', args: ['--test', 'packages/**/test/*.test.ts'], summary: (r) => counts(r.stdout) },
];
if (withE2e) gates.push({ name: 'e2e', args: ['tools/e2e.mjs', '--browser', 'edge', '--ext-dir', 'extension'], env: { BB_E2E_SYNC_DOCS: '0' }, summary: (r) => tail(r.stdout, 2) });

const results = [];
for (const gate of gates) {
  if (gate.skip) { results.push({ ...gate, code: 0, skipped: true, text: '(skipped --quick)' }); continue; }
  process.stdout.write(`… ${gate.name}\n`);
  const result = await run(gate.args, { env: gate.env });
  const text = result.code === 0 ? (gate.summary(result) || 'ok') : tail((result.stderr || '') + ' ' + (result.stdout || ''), 3);
  results.push({ name: gate.name, code: result.code, ms: result.ms, text });
}

let failed = 0;
console.log('\n== parity gates ==');
for (const item of results) {
  if (item.code !== 0) failed += 1;
  const status = item.skipped ? 'SKIP' : item.code === 0 ? 'PASS' : 'FAIL(' + item.code + ')';
  console.log(`${status.padEnd(10)} ${item.name.padEnd(16)} ${String(item.ms || 0).padStart(7)}ms  ${item.text}`);
}
console.log(failed ? `\n${failed} gate(s) failed` : '\nall parity gates passed');
process.exit(failed ? 1 : 0);
