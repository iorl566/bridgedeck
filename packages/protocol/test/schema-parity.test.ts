// packages/protocol/test/schema-parity.test.ts —— schema 单源生成物 ↔ JS 单一源差分测试。
//
// 口径：同一份 lib/schemas.mjs，JS 运行时派生与 TS 生成物必须逐字段 deepEqual：
// - 137 个方法 schema 的 key 表（required + 排序后的 properties）逐项比对；
// - 公共请求信封键（来自 method-catalog）与 camelCase 参数别名表；
// - 全量 METHOD_SCHEMAS 本体（含嵌套 items/枚举/范围）；
// - schemaCoverageSummary / schemaDriftReport（派生表 + 漂移判定）；
// - 生成物签名与统计常量。
//
// 这是“生成物由 gen.mjs 产出、不得手改语义”的回归闸门：手改 generated-schemas.ts
// 或改 lib/schemas.mjs 后忘记重生成，下面的断言会立刻失败。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';

const js: any = await import('../../../lib/schemas.mjs');
const jsCatalog: any = await import('../../../lib/method-catalog.mjs');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('137 个 schema key 逐项一致（required + 排序后的 properties）', () => {
  const tsTable = ts.buildSchemaKeyTable();
  const jsTable = clone(js.buildSchemaKeyTable());
  assert.equal(Object.keys(tsTable).length, 137);
  assert.equal(Object.keys(tsTable).length, Object.keys(jsTable).length);
  assert.deepEqual(clone(ts.METHOD_SCHEMA_KEYS), jsTable, '生成物 key 表与 JS 派生不一致');
  assert.deepEqual(clone(tsTable), jsTable);
  for (const method of Object.keys(jsTable)) {
    const row = tsTable[method];
    assert.ok(row, 'TS key 表缺少方法：' + method);
    assert.deepEqual(clone(row.required), jsTable[method].required, method + ' 的 required 不一致');
    assert.deepEqual(clone(row.properties), jsTable[method].properties, method + ' 的 properties 不一致');
    assert.deepEqual(clone(row.properties), clone([...row.properties].sort()), method + ' 的 properties 未排序');
  }
  const propertyCount = Object.values(tsTable).reduce((sum, row) => sum + row.properties.length, 0);
  assert.equal(propertyCount, 687, '参数键总数应为 687');
});

test('公共请求信封键与 method-catalog 一致', () => {
  assert.deepEqual([...ts.ENVELOPE_SCHEMA_KEYS], [...js.ENVELOPE_SCHEMA_KEYS]);
  assert.deepEqual([...ts.ENVELOPE_SCHEMA_KEYS], [...ts.REQUEST_ENVELOPE_KEYS]);
  assert.deepEqual([...ts.ENVELOPE_SCHEMA_KEYS], [...jsCatalog.REQUEST_ENVELOPE_KEYS]);
  // lib/schemas.mjs 的 ENVELOPE_PROPERTY_SCHEMAS 未导出：用 observe 的同名字段反查对照。
  for (const key of ts.ENVELOPE_SCHEMA_KEYS) {
    assert.deepEqual(
      clone(ts.ENVELOPE_PROPERTY_SCHEMAS[key]),
      clone(js.METHOD_SCHEMAS.observe.properties[key]),
      '信封键 ' + key + ' 的属性 schema 不一致',
    );
  }
  // 无显式 schema 的方法用生成物里的信封属性构造通用 schema。
  assert.deepEqual(clone(ts.GENERIC_SCHEMA), { type: 'object', properties: clone(ts.ENVELOPE_PROPERTY_SCHEMAS) });
  assert.equal(ts.SCHEMA_COUNT, ts.SCHEMA_METHOD_COUNT);
  assert.equal(ts.SCHEMA_METHOD_COUNT, 137);
});

test('参数别名表逐字段一致（camelCase → snake_case）', () => {
  const tsAliases = clone(ts.buildParamAliases());
  const jsAliases = clone(js.buildParamAliases());
  assert.deepEqual(tsAliases, jsAliases);
  assert.deepEqual(clone(ts.PARAM_ALIASES), jsAliases);
  assert.equal(Object.keys(tsAliases).length, 137, '有驼峰字段的方法数应为 137');
  // 抽两个已知映射硬断言。
  assert.equal(tsAliases.observe?.vom_profile, 'vomProfile');
  assert.equal(tsAliases['click-backend']?.backend_id, 'backendId');
  for (const [method, map] of Object.entries(jsAliases)) {
    for (const [snake, camel] of Object.entries(map as Record<string, string>)) {
      assert.equal(ts.camelToSnake(camel), snake, method + ' 的别名换形不一致');
    }
  }
});

test('全量 METHOD_SCHEMAS 本体逐字段一致（含嵌套 items/枚举/范围）', () => {
  assert.deepEqual(clone(ts.METHOD_SCHEMAS), clone(js.METHOD_SCHEMAS));
  const plan = clone(ts.METHOD_SCHEMAS.plan);
  assert.equal(plan.properties?.steps?.maxItems, 50);
  assert.deepEqual(clone(plan.properties?.steps?.items?.required), ['method']);
  const observe = clone(ts.METHOD_SCHEMAS.observe);
  assert.deepEqual(clone(observe.properties?.vomProfile?.enum), ['balanced', 'compact', 'all']);
  assert.equal(observe.properties?.vomTop?.maximum, 500);
  const transfer = clone(ts.METHOD_SCHEMAS['transfer.chunk']);
  assert.equal(transfer.properties?.transferId?.pattern, '^tr_[0-9a-f]{16}$');
});

test('schemaCoverageSummary 与 JS 一致（覆盖/缺信封/字段总数）', () => {
  assert.deepEqual(clone(ts.SCHEMA_COVERAGE), clone(js.schemaCoverageSummary()));
  assert.deepEqual(clone(ts.schemaCoverageSummary()), clone(js.schemaCoverageSummary()));
  const summary = ts.schemaCoverageSummary();
  assert.equal(summary.methods, 126);
  assert.equal(summary.schemas, 137);
  assert.equal(summary.covered, 126);
  assert.deepEqual(clone(summary.missing), []);
  assert.deepEqual(clone(summary.withoutEnvelope), ['click', 'drag', 'fill', 'hover', 'press', 'select', 'wheel']);
  assert.equal(summary.propertyCount, 687);
  assert.equal(summary.aliasedMethods, 137);
  // 自定义输入：只给两个方法时与 JS 行为一致。
  const subset = { click: clone(ts.METHOD_SCHEMAS.click), 'no.such': { type: 'object', properties: {} } };
  assert.deepEqual(
    clone(ts.schemaCoverageSummary(['click', 'no.such', 'ghost'], subset as never)),
    clone(js.schemaCoverageSummary(['click', 'no.such', 'ghost'], subset)),
  );
});

test('schemaDriftReport 与 JS 逐字段一致（默认与自定义入参）', () => {
  assert.deepEqual(clone(ts.schemaDriftReport()), clone(js.schemaDriftReport()));
  const report = ts.schemaDriftReport();
  assert.equal(report.ok, true);
  assert.equal(report.methods, 126);
  assert.equal(report.schemas, 137);
  assert.equal(report.checked, 126);
  assert.deepEqual(clone(report.problems), []);
  assert.equal(report.derived.schemaKeys, 137);
  assert.equal(report.derived.paramAliases, 137);
  assert.deepEqual(clone(report.derived.envelope), ['session', 'sessionId', 'tabId']);
  assert.deepEqual(clone(report.unknownSchemas), [
    'network.rule_add',
    'session.claim_control',
    'session.control_mode',
    'session.control_status',
    'session.handoff',
    'session.release_control',
    'transfer.begin',
    'transfer.chunk',
    'transfer.finish',
    'transfer.read',
    'transfer.release',
  ]);

  // 未知方法 → 缺 schema 条目。
  const missing = ts.schemaDriftReport({ methods: new Set(['no.such.method']) });
  assert.deepEqual(clone(missing), clone(js.schemaDriftReport({ methods: new Set(['no.such.method']) })));
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0] ?? '', /缺少 METHOD_SCHEMAS 条目/);

  // required 引用未声明字段 → 报错。
  const broken = clone(ts.METHOD_SCHEMAS);
  (broken.click as { required?: string[] }).required = ['ghostField'];
  assert.deepEqual(
    clone(ts.schemaDriftReport({ methods: new Set(['click']), schemas: broken })),
    clone(js.schemaDriftReport({ methods: new Set(['click']), schemas: broken })),
  );
  assert.match(ts.schemaDriftReport({ methods: new Set(['click']), schemas: broken }).problems.join(''), /required 引用了未声明字段/);

  // allowedExtraSchemas 生效。
  const allowed = ts.schemaDriftReport({ methods: new Set(['click']), allowedExtraSchemas: ['transfer.begin'] });
  assert.deepEqual(clone(allowed), clone(js.schemaDriftReport({ methods: new Set(['click']), allowedExtraSchemas: ['transfer.begin'] })));
  assert.ok(!allowed.unknownSchemas.includes('transfer.begin'));
});

test('生成物签名与统计常量', () => {
  assert.match(ts.SCHEMA_SIGNATURE, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ts.SCHEMA_METHOD_COUNT, 137);
  assert.deepEqual(clone(ts.SCHEMA_ENVELOPE_KEYS), clone(ts.ENVELOPE_SCHEMA_KEYS));
});

test('生成物未手改：key/别名/schema 三种投影互相自洽', () => {
  for (const [method, row] of Object.entries(ts.METHOD_SCHEMA_KEYS)) {
    const schema = ts.METHOD_SCHEMAS[method as keyof typeof ts.METHOD_SCHEMAS];
    assert.ok(schema, method + ' 缺少 METHOD_SCHEMAS 条目');
    assert.deepEqual(clone(row.properties), Object.keys(schema.properties ?? {}).sort(), method + ' key 表与 schema 不一致');
    assert.deepEqual(
      clone(row.required),
      [...(schema.required ?? [])].sort(),
      method + ' key 表 required 与 schema 不一致',
    );
    const aliases = ts.PARAM_ALIASES[method as keyof typeof ts.PARAM_ALIASES];
    if (aliases) {
      for (const [snake, camel] of Object.entries(aliases)) {
        assert.ok(row.properties.includes(camel), method + ' 别名 ' + snake + ' 指向未声明字段');
      }
    }
  }
});
