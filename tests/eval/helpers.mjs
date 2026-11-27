/**
 * tests/eval/helpers.mjs -- shared helpers for the eval property-test suites.
 *
 * Kept dependency-free: node builtins only. Tests must be runnable with
 *   node --test tests/unit/eval-pbt-*.test.mjs
 * from the repository root (or any cwd, because paths are derived from
 * `import.meta.url`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Repository root (tests/eval -> repo root). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path from a repo-relative path. */
export function repoPath(relative) {
  return path.join(ROOT, ...String(relative).split('/'));
}

/** Read a UTF-8 fixture from tests/eval/fixtures. */
export function readFixture(name) {
  return JSON.parse(fs.readFileSync(repoPath('tests/eval/fixtures/' + name), 'utf8'));
}

/** Read a source file's lines (1-based helper below). */
export function readLines(relative) {
  return fs.readFileSync(repoPath(relative), 'utf8').split(/\r?\n/);
}

/** Return the trimmed text of `file:line` (1-based). */
export function lineAt(relative, line) {
  const lines = readLines(relative);
  const index = Number(line) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= lines.length) return null;
  return lines[index];
}

/** Assert helper: the resolved location text really contains the symbol. */
export function assertLocationContains(location, symbol) {
  const match = /^(.+):(\d+)$/.exec(String(location));
  if (!match) throw new Error('location 不是 file:line：' + String(location));
  const text = lineAt(match[1], Number(match[2]));
  if (text === null) throw new Error('location 指向不存在的行：' + String(location));
  if (!text.includes(symbol)) throw new Error('location ' + location + ' 不含符号 ' + symbol + '：' + text);
  return text.trim();
}

/** Run the eval CLI as a real child process (gate consumption test). */
export function runEvalCli(args = [], { timeout = 120_000, env = {} } = {}) {
  const result = spawnSync(process.execPath, [repoPath('tools/eval/run.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    signal: result.signal,
    error: result.error || null,
  };
}

/** Run CLI with `--json` and parse stdout; fails loudly with captured stderr. */
export function runEvalJson(args = [], options = {}) {
  const result = runEvalCli([...args, '--json'], options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('run.mjs ' + args.join(' ') + ' 退出码 ' + result.status + '\n' + result.stderr);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('run.mjs 输出不是 JSON：' + String(error && error.message) + '\n' + result.stdout.slice(0, 500));
  }
}

/** Create a temp directory under the OS temp dir (never inside the repo). */
export function tempDir(label = 'dsh-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

/** Deterministic JSON (sorted keys) used to compare report payloads. */
export function stableJson(value) {
  const sort = (input) => {
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(sort);
    const out = {};
    for (const key of Object.keys(input).sort()) out[key] = sort(input[key]);
    return out;
  };
  return JSON.stringify(sort(value));
}

/** Sleep-free microtask drain for async tests. */
export async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < Math.max(1, turns); index += 1) await Promise.resolve();
}

/** All property ids in the loaded corpus (async import). */
export async function loadCorpusForTest() {
  const { loadCorpus } = await import('../../tools/eval/lib/corpus.mjs');
  return loadCorpus({ root: ROOT });
}

/** The required invariant areas (mirrors lib/report.mjs; asserted by tests). */
export const REQUIRED_AREAS = Object.freeze([
  'vom-geometry',
  'observe-diff',
  'session-queue',
  'intent-ledger',
  'protocol-state',
]);

/** Parse a `file:line` string. */
export function parseLocation(location) {
  const match = /^(.+):(\d+)$/.exec(String(location));
  if (!match) return null;
  return { file: match[1], line: Number(match[2]) };
}
