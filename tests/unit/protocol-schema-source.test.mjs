// tests/unit/protocol-schema-source.test.mjs —— schema 单源推进：
// 请求信封字段来自方法目录，METHOD_SCHEMA_KEYS / PARAM_ALIASES 只由 lib/schemas.mjs 派生，
// 生成物必须与派生结果逐项相同（tools/protocol-single-source.mjs 的 schema 审计段同源）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXTENSION_METHODS,
  METHOD_CATALOG,
  METHOD_NAMES,
  REQUEST_ENVELOPE_KEYS,
} from '../../lib/method-catalog.mjs';
import {
  ENVELOPE_SCHEMA_KEYS,
  METHOD_SCHEMAS,
  buildParamAliases,
  buildSchemaKeyTable,
  schemaCoverageSummary,
  schemaDriftReport,
  validateMethodParams,
} from '../../lib/schemas.mjs';
import {
  METHOD_SCHEMA_KEYS as GENERATED_SCHEMA_KEYS,
  PARAM_ALIASES as GENERATED_ALIASES,
  normalizeParams,
} from '../../extension/src/generated/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('请求信封字段只有一份：目录 REQUEST_ENVELOPE_KEYS 驱动 schemas 与生成物', () => {
  assert.deepEqual([...ENVELOPE_SCHEMA_KEYS], [...REQUEST_ENVELOPE_KEYS]);
  assert.deepEqual([...REQUEST_ENVELOPE_KEYS], ['session', 'sessionId', 'tabId']);
  assert.ok(Object.isFrozen(REQUEST_ENVELOPE_KEYS));
  // 未单列方法走 GENERIC_SCHEMA，它必须校验目录里的信封键类型。
  assert.deepEqual(validateMethodParams('no.such.method', { session: 's', tabId: 3 }), []);
  assert.ok(validateMethodParams('no.such.method', { tabId: '3' }).length > 0);
  assert.ok(validateMethodParams('no.such.method', { session: 7 }).length > 0);
  assert.ok(validateMethodParams('no.such.method', { sessionId: '' }).length > 0);
});

test('buildSchemaKeyTable 与生成物 METHOD_SCHEMA_KEYS 完全相同（155 方法）', () => {
  const table = buildSchemaKeyTable();
  assert.equal(Object.keys(table).length, 155);
  assert.deepEqual(GENERATED_SCHEMA_KEYS, JSON.parse(JSON.stringify(table)));
  for (const [method, row] of Object.entries(table)) {
    assert.ok(Array.isArray(row.required), method);
    assert.ok(Array.isArray(row.properties), method);
    assert.deepEqual(row.required, [...row.required].sort(), method + ' required 未排序');
    assert.deepEqual(row.properties, [...row.properties].sort(), method + ' properties 未排序');
    for (const required of row.required) {
      assert.ok(row.properties.includes(required), method + ' required 未在 properties：' + required);
    }
  }
  // 目录里的扩展方法必须在派生表里有条目（schema-audit 同一口径）。
  for (const method of EXTENSION_METHODS) {
    assert.ok(table[method], method + ' 缺少 schema key 派生条目');
  }
  assert.equal(Object.keys(GENERATED_SCHEMA_KEYS).length, Object.keys(METHOD_SCHEMAS).length);
});

test('buildParamAliases 与生成物 PARAM_ALIASES 完全相同，且能被 normalizeParams 消费', () => {
  const aliases = buildParamAliases();
  assert.equal(Object.keys(aliases).length, 155);
  assert.deepEqual(GENERATED_ALIASES, JSON.parse(JSON.stringify(aliases)));
  assert.equal(aliases.observe.max_tokens, 'maxTokens');
  assert.equal(aliases.observe.max_depth, 'maxDepth');
  assert.equal(aliases.click.wait_timeout_ms, 'waitTimeoutMs');
  const normalized = normalizeParams('observe', { max_tokens: 12, max_depth: 3 });
  assert.equal(normalized.maxTokens, 12);
  assert.equal(normalized.maxDepth, 3);
  assert.equal(normalized.max_tokens, undefined);
  assert.equal(normalized.max_depth, undefined);
  // 已是 camelCase 时不改写
  const untouched = { maxTokens: 12 };
  assert.equal(normalizeParams('observe', untouched), untouched);
  assert.equal(normalizeParams('no.such.method', { a_b: 1 }).a_b, 1);
});

test('schemaDriftReport：覆盖 126 个扩展方法，无漂移', () => {
  const report = schemaDriftReport();
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.methods, EXTENSION_METHODS.length);
  assert.equal(report.checked, EXTENSION_METHODS.length);
  assert.equal(report.schemas, Object.keys(METHOD_SCHEMAS).length);
  assert.equal(report.derived.schemaKeys, 155);
  assert.equal(report.derived.paramAliases, 155);
  assert.deepEqual(report.derived.envelope, ['session', 'sessionId', 'tabId']);
  assert.deepEqual(report.derived.missing, []);
  assert.equal(report.derived.propertyCount > 600, true);
  // 7 个动作原语的历史 schema 只声明目标字段（daemon 注入 tabId），显式记录而非静默。
  assert.deepEqual(report.derived.withoutEnvelope, ['click', 'drag', 'fill', 'hover', 'press', 'select', 'wheel']);
  // 目录内方法（含 owner=local）都允许有 schema；只剩 daemon 内部历史别名被判为目录外条目。
  assert.deepEqual(report.unknownSchemas, ['network.rule_add']);
});

test('schema 漂移负例：缺方法 / 非 object / required 引用不存在字段都会判 fail', () => {
  const missing = schemaDriftReport({ methods: new Set(['no.such.method']) });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.includes('no.such.method') && problem.includes('缺少')));

  // 用临时 schema 副本注入问题，不碰真实 METHOD_SCHEMAS。
  const clone = structuredClone(METHOD_SCHEMAS);
  clone.click.type = 'array';
  clone.fill.required = ['missingField'];
  clone.navigate.properties.bad = null;
  clone['no.such.method'] = { type: 'object', properties: {} };
  const broken = schemaDriftReport({ methods: new Set(['click', 'fill', 'navigate']), schemas: clone });
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((problem) => problem.includes('click') && problem.includes('object')));
  assert.ok(broken.problems.some((problem) => problem.includes('fill') && problem.includes('missingField')));
  assert.ok(broken.problems.some((problem) => problem.includes('navigate.bad')));
  // 目录外 schema 键仍算漂移（allowedExtra 只放行协议目录里的方法名）。
  assert.deepEqual(broken.unknownSchemas, ['network.rule_add', 'no.such.method']);
  // 真实 METHOD_SCHEMAS 未被污染
  assert.equal(schemaDriftReport().ok, true);
});

test('schemaCoverageSummary 汇总与派生计数一致', () => {
  const summary = schemaCoverageSummary();
  assert.equal(summary.methods, EXTENSION_METHODS.length);
  assert.equal(summary.covered, EXTENSION_METHODS.length);
  assert.deepEqual(summary.missing, []);
  assert.equal(summary.schemas, 155);
  assert.equal(summary.validatedMethods, 155);
  assert.equal(summary.aliasedMethods, 155);
  assert.deepEqual(summary.envelope, ['session', 'sessionId', 'tabId']);
  assert.equal(summary.propertyCount, Object.values(buildSchemaKeyTable()).reduce((sum, row) => sum + row.properties.length, 0));
  // 有 key 条目的 canonical 方法 154 个；第 155 条是遗留别名 network.rule_add（daemon 内部命名）。
  const keyTable = buildSchemaKeyTable();
  const keyed = METHOD_NAMES.filter((method) => keyTable[method]);
  assert.equal(keyed.length, 154);
  assert.ok(keyTable['network.rule_add'], '遗留 network.rule_add schema 应保留');
  assert.ok(!METHOD_NAMES.includes('network.rule_add'), 'network.rule_add 不是 canonical 方法');
  for (const row of METHOD_CATALOG) {
    if (keyTable[row.method]) continue;
    assert.equal(row.owner, 'local', row.method + ' 扩展方法缺少 schema key 条目');
  }
});

test('schema-audit --check 退出码 0（既有门禁保持通过）', () => {
  const result = spawnSync(process.execPath, ['tools/schema-audit.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, String(result.stderr || ''));
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.methods, 126);
  assert.equal(report.checked, 126);
  assert.equal(report.schemas, 155);
  // 派生表的权威判定在 lib/schemas.mjs；schema-audit 仍是覆盖门禁，两者不冲突。
  const derived = schemaDriftReport();
  assert.equal(derived.derived.schemaKeys, report.schemas);
  assert.deepEqual(derived.derived.envelope, ['session', 'sessionId', 'tabId']);
});
