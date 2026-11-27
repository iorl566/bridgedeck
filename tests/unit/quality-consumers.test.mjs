// tests/unit/quality-consumers.test.mjs —— 运行时消费点 file:line 的真实性。
//
// 这是"门禁真的调用了产品模块"的证据层：每个声明的符号都必须在模块里有
// export 定义行，并在 gate 源码里被引用；任何一侧漂移都必须被报告为 problem。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONSUMPTION_POINTS,
  GATE_FILES,
  assertLocationContains,
  collectConsumption,
  findDefinitionLine,
  findReferenceLine,
  gateFiles,
  gatesWithoutConsumption,
  parseLocation,
} from '../../tools/quality/lib/consumers.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('消费点收集：无漂移且条目数量足够', () => {
  const consumption = collectConsumption(ROOT);
  assert.deepEqual(consumption.problems, []);
  assert.ok(consumption.entries.length >= 65, '消费点条目过少：' + consumption.entries.length);
  // 每个 gate 都必须有声明（包括 run 入口自身）。
  const gates = consumption.entries.map((entry) => entry.gate);
  for (const gate of ['determinism', 'idempotency', 'explainability', 'antifragility', 'run']) {
    assert.ok(gates.includes(gate), '缺少 gate 消费点：' + gate);
  }
  // 每个 gate 至少 5 条消费点（防止空 gate）。
  for (const gate of ['determinism', 'idempotency', 'explainability', 'antifragility', 'run']) {
    const count = gates.filter((item) => item === gate).length;
    assert.ok(count >= 5, gate + ' 消费点过少：' + count);
  }
});

test('消费点 location 是真实 file:line，且该行确实含符号', () => {
  const consumption = collectConsumption(ROOT);
  const parsedFiles = new Set();
  for (const entry of consumption.entries) {
    const parsed = parseLocation(entry.location);
    assert(parsed, 'location 不是 file:line：' + entry.location);
    assert.ok(parsed.line >= 1);
    parsedFiles.add(parsed.file);
    const check = assertLocationContains(ROOT, entry.location, entry.symbol);
    assert.equal(check.ok, true, '定义行不含符号：' + entry.location + '（' + check.detail + '）');
    // 调用侧也必须是真实行且含符号。
    const consumed = parseLocation(entry.consumedAt);
    assert(consumed, 'consumedAt 不是 file:line：' + entry.consumedAt);
    const consumedCheck = assertLocationContains(ROOT, entry.consumedAt, entry.symbol);
    assert.equal(consumedCheck.ok, true, '调用行不含符号：' + entry.consumedAt + '（' + consumedCheck.detail + '）');
  }
  assert.ok(parsedFiles.has('lib/har-plan.mjs'));
  assert.ok(parsedFiles.has('lib/intent-ledger.mjs'));
  assert.ok(parsedFiles.has('lib/trace-budget.mjs'));
  assert.ok(parsedFiles.has('lib/error-codes.mjs'));
  assert.ok(parsedFiles.has('cli/lib/json-contract.mjs'));
});

test('消费点解析函数：缺失符号返回 null、格式错误返回 null', () => {
  assert.equal(findDefinitionLine('export function alpha() {}\n', 'alpha'), 1);
  assert.equal(findDefinitionLine('export const beta = 1;\n', 'beta'), 1);
  assert.equal(findDefinitionLine('export class Gamma {}\n', 'Gamma'), 1);
  assert.equal(findDefinitionLine('const delta = 1;\n', 'delta'), null);
  assert.equal(findReferenceLine("import { alpha } from './x.mjs';\n", 'alpha'), 1);
  assert.equal(findReferenceLine('const x = 1;\n', 'alpha'), null);
  assert.equal(parseLocation('lib/a.mjs:12').line, 12);
  assert.equal(parseLocation('lib/a.mjs'), null);
  assert.equal(parseLocation(':12'), null);
});

test('消费点扫描负控制：缺符号/缺 gate 文件会变成 problem', () => {
  const consumption = collectConsumption(path.join(ROOT, 'tools', 'quality', 'lib'), { gates: ['determinism'] });
  // 用错误的 root：所有被消费模块都不存在 → 必须有 missing-module 类问题。
  assert.ok(consumption.problems.length > 0);
  assert.ok(consumption.problems.every((problem) => typeof problem.detail === 'string' && problem.detail.length > 0));
  assert.ok(consumption.problems.some((problem) => problem.kind === 'missing-module'));
});

test('gate 文件映射：四个 gate + run 入口都有文件', () => {
  const files = gateFiles();
  assert.equal(files.length, 5);
  const byGate = new Map(files.map((entry) => [entry.gate, entry.file]));
  assert.equal(byGate.get('determinism'), 'tools/quality/gates/determinism.mjs');
  assert.equal(byGate.get('idempotency'), 'tools/quality/gates/idempotency.mjs');
  assert.equal(byGate.get('explainability'), 'tools/quality/gates/explainability.mjs');
  assert.equal(byGate.get('antifragility'), 'tools/quality/gates/antifragility.mjs');
  assert.equal(byGate.get('run'), 'tools/quality/run.mjs');
  assert.deepEqual(gatesWithoutConsumption(['determinism', 'idempotency', 'explainability', 'antifragility']), []);
  assert.deepEqual(gatesWithoutConsumption(['ghost-gate']), ['ghost-gate']);
});

test('消费点声明本身结构合法（gate 已登记、symbols 非空、模块路径可解析）', () => {
  const knownGates = new Set(Object.keys(GATE_FILES));
  for (const point of CONSUMPTION_POINTS) {
    assert.equal(knownGates.has(point.gate), true, '未知 gate：' + point.gate);
    assert.ok(Array.isArray(point.symbols) && point.symbols.length > 0);
    assert.ok(point.module.endsWith('.mjs'), '模块必须是 .mjs：' + point.module);
    for (const symbol of point.symbols) assert.match(symbol, /^[A-Za-z][A-Za-z0-9_]*$/);
  }
});
