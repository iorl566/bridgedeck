// packages/protocol/test/catalog-parity.test.ts —— TS 生成物 ↔ JS 单一源差分测试。
//
// 口径：同一份 lib/method-catalog.mjs，JS 运行时导出与 TS 生成物必须逐字段 deepEqual。
// 这是“生成物由 gen.mjs 产出、不得手改语义”的回归闸门：一旦有人手改 generated.ts，
// 或者 JS 源改了而没重生成，下面的断言会立刻失败。
//
// 差分对象刻意包含：
// - 常量表（方法名/顺序/特性门/参数规则/收敛表/owner 分桶）；
// - 165 个方法的五维状态与派生查询（methodState / floorOf / ownerOf / isMutating）；
// - 不变量校验结果（TS 实现 vs JS validateMethodStates 都必须是空数组）。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';
import type { MethodName } from '../src/generated.ts';

const js: any = await import('../../../lib/method-catalog.mjs');

const METHOD_NAMES = ts.METHOD_NAMES as readonly MethodName[];

test('方法名/顺序/数量与 JS 单一源一致', () => {
  assert.equal(ts.METHOD_COUNT, js.METHOD_COUNT);
  assert.equal(ts.METHOD_COUNT, 165);
  assert.deepEqual([...ts.METHOD_NAMES], [...js.METHOD_NAMES]);
  assert.deepEqual([...ts.METHOD_NAMES_SORTED], [...js.SORTED_METHOD_NAMES]);
  assert.deepEqual([...ts.METHOD_NAMES], [...js.METHOD_CATALOG.map((row: any) => row.method)]);
  assert.equal(new Set(ts.METHOD_NAMES).size, ts.METHOD_COUNT, '方法名必须唯一');
});

test('特性门/参数规则/收敛表与 JS 单一源一致', () => {
  assert.equal(ts.PROTOCOL_BASELINE, js.PROTOCOL_BASELINE);
  assert.equal(ts.PROTOCOL_CURRENT, js.PROTOCOL_CURRENT);
  assert.deepEqual([...ts.FEATURE_NAMES], [...js.FEATURE_NAMES]);
  assert.deepEqual({ ...ts.FEATURE_FLOORS }, { ...js.FEATURE_FLOORS });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.FEATURE_META)), JSON.parse(JSON.stringify(js.FEATURE_META)));
  assert.deepEqual(JSON.parse(JSON.stringify(ts.FEATURE_METHODS)), JSON.parse(JSON.stringify(js.FEATURE_METHODS)));
  assert.deepEqual(JSON.parse(JSON.stringify(ts.METHOD_FEATURE)), JSON.parse(JSON.stringify(js.METHOD_FEATURE)));
  assert.deepEqual(JSON.parse(JSON.stringify(ts.FEATURE_PARAM_RULES)), JSON.parse(JSON.stringify(js.FEATURE_PARAM_RULES)));
  assert.deepEqual([...ts.RECEIPT_EFFECTS], [...js.RECEIPT_EFFECTS]);
  assert.deepEqual([...ts.MUTATING_OVERRIDES], [...js.MUTATING_OVERRIDES]);
  assert.deepEqual([...ts.REQUEST_ENVELOPE_KEYS], [...js.REQUEST_ENVELOPE_KEYS]);
  assert.deepEqual([...ts.PARTIAL_METHODS], [...js.PARTIAL_METHODS]);
  assert.deepEqual([...ts.RECONCILE_STRATEGIES], [...js.RECONCILE_STRATEGIES]);
  assert.deepEqual({ ...ts.RECONCILE_DEFAULT }, { ...js.RECONCILE_DEFAULT });
  assert.deepEqual({ ...ts.RECONCILE_OVERRIDES }, { ...js.RECONCILE_OVERRIDES });
});

test('目录/状态/派生表逐字段一致', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(ts.METHOD_STATES)),
    JSON.parse(JSON.stringify(js.METHOD_STATE)),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ts.METHOD_CATALOG)),
    JSON.parse(JSON.stringify(js.METHOD_CATALOG)),
  );
  assert.deepEqual({ ...ts.METHOD_EFFECT_TABLE }, { ...js.METHOD_EFFECT_TABLE });
  assert.deepEqual({ ...ts.METHOD_OWNER_TABLE }, { ...js.METHOD_OWNER_TABLE });
  assert.deepEqual({ ...ts.METHOD_FEATURE_FLOOR }, { ...js.METHOD_FEATURE_FLOOR });
  assert.deepEqual([...ts.METHOD_PARTIAL], [...js.METHOD_PARTIAL]);
  assert.deepEqual([...ts.METHOD_UNKNOWN], [...js.METHOD_UNKNOWN]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ts.OWNER_METHODS)),
    JSON.parse(JSON.stringify(js.OWNER_METHODS)),
  );
  assert.deepEqual([...ts.DAEMON_ONLY_METHODS], [...js.DAEMON_ONLY_METHODS]);
  assert.deepEqual([...ts.DAEMON_METHODS], [...js.DAEMON_METHODS]);
  assert.deepEqual([...ts.EXTENSION_METHODS], [...js.EXTENSION_METHODS]);
});

test('逐方法：五维状态/owner/floor/变异口径与 JS 查询函数一致', () => {
  for (const method of METHOD_NAMES) {
    const state = ts.methodState(method);
    assert.ok(state, method + ' 必须在 TS 状态表里');
    assert.deepEqual(JSON.parse(JSON.stringify(state)), JSON.parse(JSON.stringify(js.methodStateOf(method))), method + ' 五维状态不一致');
    assert.equal(ts.ownerOf(method), js.ownerOf(method), method + ' owner 不一致');
    assert.equal(ts.floorOf(method), js.floorOf(method), method + ' floor 不一致');
    assert.equal(ts.isMutatingInCatalog(method), js.isMutatingInCatalog(method), method + ' 变异口径不一致');
    const row = ts.catalogRow(method);
    assert.ok(row, method + ' 必须有目录行');
    assert.equal(row.floor, js.METHOD_FEATURE_FLOOR[method] ?? null, method + ' 目录行 floor 不一致');
    assert.equal(row.receipt, js.RECEIPT_EFFECTS.includes(row.effect), method + ' receipt 派生位不一致');
    assert.equal(row.partial, js.METHOD_PARTIAL.includes(method), method + ' partial 派生位不一致');
    assert.equal(row.unknown, js.METHOD_UNKNOWN.includes(method), method + ' unknown 派生位不一致');
  }
});

test('聚合派生查询与 JS 过滤口径一致', () => {
  assert.deepEqual([...ts.partialMethodNames()], [...js.METHOD_PARTIAL]);
  assert.deepEqual([...ts.unknownMethodNames()], [...js.METHOD_UNKNOWN]);
  assert.deepEqual(
    [...ts.ownerBuckets().local],
    [...js.OWNER_METHODS.local],
  );
  assert.deepEqual([...ts.ownerBuckets().session], [...js.OWNER_METHODS.session]);
  assert.deepEqual([...ts.ownerBuckets().instance], [...js.OWNER_METHODS.instance]);
  const receipt = ts.receiptMethodNames();
  assert.deepEqual(
    [...receipt],
    js.METHOD_CATALOG.filter((row: any) => row.receipt).map((row: any) => row.method),
  );
});

test('未知方法：TS 返回 null 且不把原型链键当方法', () => {
  for (const method of ['', null, undefined, 0, false, 'bogus.method', 'session', 'METHOD_COUNT']) {
    assert.equal(ts.methodState(method), null, String(method) + ' 必须是未知方法');
    assert.equal(ts.catalogRow(method), null);
    assert.equal(ts.ownerOf(method), null, String(method) + ' 必须是未知 owner');
    assert.equal(ts.floorOf(method), null);
  }
  // daemon 专用方法不在 canonical 目录，但 owner 按 local 处理。
  for (const method of ts.DAEMON_ONLY_METHODS) {
    assert.equal(ts.methodState(method), null, method + ' 不进入 canonical 目录');
    assert.equal(ts.ownerOf(method), 'local', method + ' 属于 daemon 自处理');
  }
  // 原型链键（'constructor'/'toString'）在 TS 侧一律 null：显式 Object.hasOwn 硬化，
  // 避免 JS 侧 CATALOG_BY_METHOD[name] 的 prototype 泄漏被带进 TS 栈。
  for (const method of ['constructor', 'toString', '__proto__']) {
    assert.equal(ts.methodState(method), null);
    assert.equal(ts.catalogRow(method), null);
    assert.equal(ts.floorOf(method), null);
    assert.equal(ts.isMutatingInCatalog(method), false);
  }
});

test('五维状态不变量：TS 校验与 JS 一致且目录合法', () => {
  const tsErrors = ts.stateInvariantErrors();
  const jsErrors = js.validateMethodStates();
  assert.deepEqual(tsErrors, jsErrors);
  assert.equal(tsErrors.length, 0, '目录不变量必须干净：' + tsErrors.join('；'));
  assert.doesNotThrow(() => ts.assertCatalogInvariants());

  // 负例：手工构造坏行必须被抓到（证明校验器不是恒真）。
  const broken = [
    { method: 'read', owner: 'localx', effect: 'passive_read', partial: false, unknown: false, reconcile: { strategy: 'none', method: null } },
    { method: 'click', owner: 'session', effect: 'browser_mutation', partial: true, unknown: false, reconcile: { strategy: 'none', method: null } },
    { method: 'observe', owner: 'session', effect: 'passive_read', partial: true, unknown: false, reconcile: { strategy: 'observe', method: null } },
    { method: 'fill', owner: 'session', effect: 'browser_mutation', partial: false, unknown: true, reconcile: { strategy: 'status', method: 'click' } },
  ];
  const errors = ts.stateInvariantErrors(broken);
  assert.ok(errors.length >= 5, '坏行必须产生至少 5 条错误，实际：' + errors.length);
  assert.ok(errors.some((message) => message.includes('owner 非法')), '必须抓到非法 owner');
  assert.ok(errors.some((message) => message.includes('只有只读方法可以 partial')), '必须抓到变异方法 partial');
  assert.ok(errors.some((message) => message.includes('非变异方法 reconcile 必须是 none')), '必须抓到只读方法带收敛');
  assert.ok(errors.some((message) => message.includes('reconcile 目标必须是只读方法')), '必须抓到收敛目标不是只读');
  assert.throws(() => ts.assertCatalogInvariants(broken), /E_CATALOG_INVARIANT/);
});

test('requireCatalogRow：存在返回行，未知方法抛 E_UNKNOWN_METHOD', () => {
  const row = ts.requireCatalogRow('video.start');
  assert.equal(row.method, 'video.start');
  assert.equal(row.floor, '1.9');
  assert.throws(() => ts.requireCatalogRow('nope.nope'), /E_UNKNOWN_METHOD/);
});

test('收敛状态与 JS reconcile 字段一致', () => {
  for (const method of METHOD_NAMES) {
    const state = ts.methodState(method);
    assert.ok(state);
    const jsReconcile = js.METHOD_STATE[method].reconcile;
    assert.equal(state.reconcile.strategy, jsReconcile.strategy, method + ' 收敛策略不一致');
    assert.equal(state.reconcile.method, jsReconcile.method, method + ' 收敛目标不一致');
    const expected = jsReconcile.method
      ? jsReconcile.strategy + ':' + jsReconcile.method
      : jsReconcile.strategy;
    assert.equal(js.METHOD_RECONCILE[method], expected, method + ' 字符串化收敛表示不一致');
  }
});
