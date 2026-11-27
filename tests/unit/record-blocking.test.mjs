// tests/unit/record-blocking.test.mjs —— 阻塞式录制 + ./trace 目录导出（CLI 契约/接线）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('record start --blocking 参数可被 CLI 接受（dry-run）', () => {
  const r = spawnSync(process.execPath, [CLI, 'record', 'start', '--blocking', '--out', 'trace', '--purpose', 'test', '--redact-values', '--trace-version', '3', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout.trim());
  assert.equal(body.ok, true);
  assert.equal(body.result.command, 'record');
});

test('CLI 阻塞流程：轮询 record.status，结束导出 trace.json + states/，并支持 purpose/redact', () => {
  const text = read('cli/commands/record.mjs');
  assert.match(text, /flags\.blocking === true/);
  assert.match(text, /record\.status/);
  assert.match(text, /writeTraceExport/);
  assert.match(text, /trace\.json/);
  assert.match(text, /states/);
  assert.match(text, /redactValues/);
  assert.match(text, /trace-version|traceVersion/);
});

test('录制记录持久化 BSK 兼容字段（purpose/redact/version）', () => {
  const ops = read('extension/src/ops.js');
  assert.match(ops, /purpose: typeof params\.purpose/);
  assert.match(ops, /redactValues: params\.redactValues === true/);
  assert.match(ops, /traceVersion: session\.traceVersion/);
  const dispatch = read('extension/src/dispatch.js');
  assert.match(dispatch, /purpose: params\.purpose/);
  assert.match(dispatch, /redactValues: params\.redactValues/);
});
