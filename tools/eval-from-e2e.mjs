#!/usr/bin/env node
// tools/eval-from-e2e.mjs —— 用真实 Edge E2E 执行 eval case 清单。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge } from '../lib/eval-oracle.mjs';
import { parseE2EResults, summarizeCases } from '../lib/eval-e2e.mjs';

const ROOT = process.cwd();
const manifest = path.join(ROOT, 'tests', 'eval', 'cases', 'core.json');
const cases = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const env = { ...process.env, BB_E2E_SYNC_DOCS: '0' };
const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'e2e.mjs')], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const output = [run.stdout || '', run.stderr || ''].join('\n');
const results = parseE2EResults(output);
const { checks, unverified } = summarizeCases(cases, results);
const verdict = judge({ checks, unverified });
const payload = { status: verdict.status, checks, unverified: verdict.unverified, exitCode: run.status };
console.log(JSON.stringify(payload, null, 2));
process.exit(verdict.status === 'passed' && run.status === 0 ? 0 : 1);
