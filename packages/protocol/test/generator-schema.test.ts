// packages/protocol/test/generator-schema.test.ts —— schema 生成器契约测试。
//
// 这里断言的不是“某个字符串长什么样”，而是四条硬约束：
// 1. `src/generated-schemas.ts` 的内容必须逐字符等于当前 JS 单源的重渲染结果（手改即失败）；
// 2. 生成物里的 schema 签名必须等于对当前 JS 单源算出的签名（源改了没重生成即失败）；
// 3. `--check` 子进程在仓库根目录运行 exit 0 且输出 clean 并同时覆盖两份生成物；
// 4. 生成器连续跑两次结果逐字节一致（决定论输出），且生成前校验能拒绝被篡改的快照。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as ts from '../src/index.ts';
import {
  buildSchemaSnapshot,
  describeDrift,
  renderSchemaModule,
  validateSchemaSnapshot,
} from '../scripts/gen.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/gen.mjs', import.meta.url));
const SCHEMAS_OUTPUT_PATH = fileURLToPath(new URL('../src/generated-schemas.ts', import.meta.url));
const PROTOCOL_OUTPUT_PATH = fileURLToPath(new URL('../src/generated.ts', import.meta.url));

const EXTENSION_METHODS = [...ts.EXTENSION_METHODS] as string[];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('生成物 == 当前 JS 单源的重渲染结果（手改/漏生成都会失败）', async () => {
  const { snapshot, signature } = await buildSchemaSnapshot();
  const rendered = renderSchemaModule(snapshot, signature);
  const onDisk = readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8');
  const drift = describeDrift(rendered, onDisk);
  assert.equal(drift, null, drift
    ? 'generated-schemas.ts 漂移：第 ' + drift.line + ' 行\n  期望: ' + drift.expected + '\n  实际: ' + drift.actual
    : '');
  assert.ok(onDisk.startsWith('// AUTO-GENERATED FILE — DO NOT EDIT.'), '缺少生成物告示头');
  assert.ok(onDisk.includes('export const SCHEMA_METHOD_COUNT = 137;'), 'SCHEMA_METHOD_COUNT 必须是 137');
  assert.ok(onDisk.includes('export const METHOD_SCHEMAS:'), '缺少全量 schema 表');
  assert.ok(onDisk.includes("import type { JsonSchema, SchemaCoverageSummary, SchemaKeyRow } from './schema-types.ts';"));
});

test('schema 签名与 JS 单源一致', async () => {
  const { signature } = await buildSchemaSnapshot();
  assert.equal(ts.SCHEMA_SIGNATURE, 'sha256:' + signature);
  assert.match(ts.SCHEMA_SIGNATURE, /^sha256:[0-9a-f]{64}$/);
  // 与协议目录签名不同（两份单源各算各的）。
  assert.notEqual(ts.SCHEMA_SIGNATURE, ts.CATALOG_SIGNATURE);
});

test('--check 子进程在仓库根目录 exit 0 且同时覆盖两份生成物', () => {
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(stdout, /protocol gen: clean/);
  assert.match(stdout, /generated\.ts/);
  assert.match(stdout, /generated-schemas\.ts/);
  assert.match(stdout, /137 方法 schema/);
  assert.match(stdout, /3 信封键/);
  assert.match(stdout, /165 方法/);
  assert.match(stdout, /9 特性门/);
});

test('--help 输出用法且不写两份生成物', () => {
  const beforeProtocol = readFileSync(PROTOCOL_OUTPUT_PATH, 'utf8');
  const beforeSchemas = readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8');
  const protocolMtime = statSync(PROTOCOL_OUTPUT_PATH).mtimeMs;
  const schemasMtime = statSync(SCHEMAS_OUTPUT_PATH).mtimeMs;
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(stdout, /generated-schemas\.ts/);
  assert.equal(readFileSync(PROTOCOL_OUTPUT_PATH, 'utf8'), beforeProtocol, '--help 不得改 generated.ts');
  assert.equal(readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8'), beforeSchemas, '--help 不得改 generated-schemas.ts');
  assert.equal(statSync(PROTOCOL_OUTPUT_PATH).mtimeMs, protocolMtime);
  assert.equal(statSync(SCHEMAS_OUTPUT_PATH).mtimeMs, schemasMtime);
});

test('生成器连续跑两次结果逐字节一致（决定论）', async () => {
  execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, encoding: 'utf8' });
  const firstProtocol = readFileSync(PROTOCOL_OUTPUT_PATH, 'utf8');
  const firstSchemas = readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8');
  const secondRun = execFileSync(process.execPath, [SCRIPT_PATH], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(secondRun, /wrote packages\/protocol\/src\/generated\.ts/);
  assert.match(secondRun, /wrote packages\/protocol\/src\/generated-schemas\.ts/);
  assert.equal(readFileSync(PROTOCOL_OUTPUT_PATH, 'utf8'), firstProtocol, '第二次生成改动了 generated.ts');
  assert.equal(readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8'), firstSchemas, '第二次生成改动了 generated-schemas.ts');
  // 重渲染同样稳定。
  const { snapshot, signature } = await buildSchemaSnapshot();
  assert.equal(renderSchemaModule(snapshot, signature), renderSchemaModule(snapshot, signature));
});

test('生成前校验能拒绝被篡改的 schema 快照（防止坏数据固化）', async () => {
  const { snapshot } = await buildSchemaSnapshot();
  const options = { extensionMethods: EXTENSION_METHODS };

  // key 表条目缺失。
  const missingRow = clone(snapshot);
  delete missingRow.schemaKeyTable.observe;
  assert.throws(() => validateSchemaSnapshot(missingRow, options), /未通过生成前校验[\s\S]*key 表|未通过生成前校验/);

  // key 表与 schema 不一致。
  const badRow = clone(snapshot);
  badRow.schemaKeyTable.observe.properties = ['ghost'];
  assert.throws(() => validateSchemaSnapshot(badRow, options), /key 表 properties 与 schema 不一致/);

  // 别名指向未声明字段。
  const badAlias = clone(snapshot);
  badAlias.paramAliases.observe = { ...badAlias.paramAliases.observe, ghost_alias: 'ghostField' };
  assert.throws(() => validateSchemaSnapshot(badAlias, options), /别名 ghost_alias 指向未声明字段/);

  // 信封键集合不一致。
  const badEnvelope = clone(snapshot);
  badEnvelope.envelopeKeys = ['session', 'sessionId'];
  assert.throws(() => validateSchemaSnapshot(badEnvelope, options), /信封|不一致/);

  // drift.ok=false 必须被拒绝。
  const badDrift = clone(snapshot);
  badDrift.drift = { ...badDrift.drift, ok: false, problems: ['fake problem'] };
  assert.throws(() => validateSchemaSnapshot(badDrift, options), /schemaDriftReport/);

  // required 引用未声明字段。
  const badRequired = clone(snapshot);
  badRequired.schemas.click = { ...badRequired.schemas.click, required: ['ghostRequired'] };
  assert.throws(() => validateSchemaSnapshot(badRequired, options), /required 引用了未声明字段/);

  // 同一个快照配同参数仍然通过（证明失败来自被篡改的字段）。
  assert.doesNotThrow(() => validateSchemaSnapshot(snapshot, options));
  // 省略 extensionMethods 时跳过交叉校验，但自身一致性仍会检查。
  assert.doesNotThrow(() => validateSchemaSnapshot(snapshot));
});

test('生成物覆盖：137 个方法 each 有 key 表/schema/别名投影', () => {
  const keyTable = ts.METHOD_SCHEMA_KEYS;
  const methods = Object.keys(keyTable);
  assert.equal(methods.length, 137);
  for (const method of methods) {
    assert.ok(ts.METHOD_SCHEMAS[method as keyof typeof ts.METHOD_SCHEMAS], method + ' 缺 schema');
    assert.ok(Array.isArray(keyTable[method as keyof typeof keyTable]?.properties), method + ' 缺 properties 数组');
  }
  // 生成物里不得出现 undefined/NaN 这类渲染残留。
  const content = readFileSync(SCHEMAS_OUTPUT_PATH, 'utf8');
  assert.ok(!content.includes('undefined'), '生成物含 undefined 渲染残留');
  assert.ok(!content.includes('NaN'), '生成物含 NaN 渲染残留');
  assert.ok(content.split('\n').length > 1000, '生成物行数异常');
});
