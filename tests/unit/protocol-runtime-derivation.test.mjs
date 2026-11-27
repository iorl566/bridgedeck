// tests/unit/protocol-runtime-derivation.test.mjs —— 协议运行时单源收口的差分与派生测试。
//
// W6-E 收口前的逐项事实冻结在 tests/unit/protocol-differential-baseline.mjs；
// 本文件验证收口后 lib/protocol.mjs / lib/methods.mjs 的运行时导出：
//  1. 165 方法 × owner/effect/floor/mutating/partial/unknown/reconcile 与基线逐项一致；
//  2. 15 个 feature floor、METHOD_EFFECT 键序/值、LOCAL/SESSION/INSTANCE/EXT/BYPASS 集合一致；
//  3. isMutating / methodScope / remoteScopeAllows / isAllowedWhilePaused 的派生语义与目录口径一致；
//  4. 导入顺序无关（目录是叶子，protocol → 目录，methods → 目录 + protocol，无 TDZ 循环）；
//  5. 消费路径（生成物、schema-info）看到的协议事实不回退；
//  6. 差分比较器本身有牙齿：任一维人为漂移都必须被抓住（负例，不写真实文件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_FEATURE_FLOORS,
  BASELINE_LEGACY_MUTATING,
  BASELINE_METHOD_EFFECT,
  BASELINE_METHOD_EFFECT_TABLE,
  BASELINE_METHOD_NAMES,
  BASELINE_METHOD_RECONCILE,
  BASELINE_METHOD_ROWS,
  BASELINE_METHOD_STATE,
  BASELINE_OWNER_SETS,
  BASELINE_PROTOCOL,
  BASELINE_UNKNOWN_PROBES,
} from './protocol-differential-baseline.mjs';
import {
  CATALOG_BY_METHOD,
  DAEMON_ONLY_METHODS,
  FEATURE_FLOORS,
  FILE_TRANSFER_METHODS,
  LEGACY_MUTATING_METHODS,
  METHOD_CATALOG,
  METHOD_COUNT,
  METHOD_EFFECT_TABLE,
  METHOD_NAMES,
  METHOD_OWNER_TABLE,
  METHOD_RECONCILE,
  METHOD_STATE,
  MUTATING_OVERRIDES,
  OWNER_METHODS,
  RECEIPT_EFFECTS,
  SESSION_QUEUE_BYPASS_METHODS,
  describeMethod as describeCatalogMethod,
  isMutatingInCatalog,
  listMethods as listCatalogMethods,
  methodStateOf,
  validateRuntimeLists,
} from '../../lib/method-catalog.mjs';
import {
  METHOD_EFFECT,
  effectOf,
  isAllowedWhilePaused,
  isFileTransferMethod,
  shouldRejectRemoteTransfer,
} from '../../lib/protocol.mjs';
import {
  EXT_METHODS,
  INSTANCE_METHODS,
  LOCAL_METHODS,
  SESSION_METHODS,
  SESSION_QUEUE_BYPASS,
  isMutating,
  methodScope,
  remoteScopeAllows,
  validateMethodRegistry,
} from '../../lib/methods.mjs';
import {
  METHOD_EFFECT as GENERATED_METHOD_EFFECT,
  METHOD_STATE as GENERATED_STATE,
  METHOD_OWNER as GENERATED_OWNER,
  MUTATING_METHODS as GENERATED_MUTATING,
  METHODS as GENERATED_METHODS,
  LOCAL_METHODS as GENERATED_LOCAL,
  SESSION_METHODS as GENERATED_SESSION,
  INSTANCE_METHODS as GENERATED_INSTANCE,
  EXT_METHODS as GENERATED_EXT,
  METHOD_COUNT as GENERATED_COUNT,
  methodEffect as generatedMethodEffect,
  isKnownMethod as generatedIsKnownMethod,
  methodState as generatedMethodState,
  methodFloor as generatedMethodFloor,
} from '../../extension/src/generated/protocol.js';
import { describeMethod as describeSchemaInfo, listMethods as listSchemaInfoMethods } from '../../lib/schema-info.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROW_FIELDS = ['method', 'owner', 'effect', 'floor', 'mutating', 'partial', 'unknown', 'reconcile'];
const RECEIPT_EFFECT_SET = new Set(RECEIPT_EFFECTS);

/** 从收口后的运行时 + 目录重建 8 元组行，字段顺序与基线完全一致。 */
function liveRows() {
  return METHOD_CATALOG.map((row) => {
    const state = METHOD_STATE[row.method];
    return [
      row.method,
      row.owner,
      row.effect,
      row.floor === undefined ? null : row.floor,
      isMutating(row.method),
      state.partial,
      state.unknown,
      state.reconcile.method ? state.reconcile.strategy + ':' + state.reconcile.method : state.reconcile.strategy,
    ];
  });
}

/** 逐行逐字段差分；返回问题列表（空 = 一致）。 */
function diffRows(expected, actual) {
  const problems = [];
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (!left) { problems.push({ index, field: '<extra>', expected: '<无>', actual: right && right[0] }); continue; }
    if (!right) { problems.push({ index, field: '<missing>', expected: left[0], actual: '<无>' }); continue; }
    for (let field = 0; field < ROW_FIELDS.length; field++) {
      if (left[field] !== right[field]) {
        problems.push({ index, method: left[0], field: ROW_FIELDS[field], expected: left[field], actual: right[field] });
      }
    }
  }
  return problems;
}

const sortedSet = (set) => [...set].sort();
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

test('差分基线：165 方法 × owner/effect/floor/mutating/partial/unknown/reconcile 逐项一致', () => {
  const actual = liveRows();
  const problems = diffRows(BASELINE_METHOD_ROWS, actual);
  assert.deepEqual(problems, [], JSON.stringify(problems.slice(0, 8)));
  assert.equal(actual.length, 165);
  assert.deepEqual(actual.map((row) => row[0]), BASELINE_METHOD_NAMES);
  for (let index = 0; index < BASELINE_METHOD_ROWS.length; index++) {
    assert.deepEqual(actual[index], BASELINE_METHOD_ROWS[index], '第 ' + index + ' 行漂移');
  }
});

test('差分基线：15 个 feature floor 与协议版本常量逐项一致', () => {
  assert.equal(Object.keys(FEATURE_FLOORS).length, 15);
  assert.deepEqual({ ...FEATURE_FLOORS }, { ...BASELINE_FEATURE_FLOORS });
  assert.deepEqual(Object.keys(FEATURE_FLOORS), Object.keys(BASELINE_FEATURE_FLOORS));
  assert.equal(BASELINE_PROTOCOL.methodCount, 165);
  assert.equal(BASELINE_PROTOCOL.daemonOnlyCount, DAEMON_ONLY_METHODS.length);
  assert.equal(BASELINE_PROTOCOL.featureFloorCount, Object.keys(FEATURE_FLOORS).length);
});

test('差分基线：METHOD_EFFECT 键序、165 个值与目录表逐项一致', () => {
  assert.deepEqual({ ...METHOD_EFFECT }, { ...BASELINE_METHOD_EFFECT });
  assert.deepEqual({ ...METHOD_EFFECT_TABLE }, { ...BASELINE_METHOD_EFFECT_TABLE });
  assert.deepEqual(Object.keys(METHOD_EFFECT), BASELINE_METHOD_NAMES);
  assert.equal(Object.keys(METHOD_EFFECT).length, 165);
  // 生成物也必须是同一份值（daemon/扩展消费路径不变）。
  assert.deepEqual({ ...GENERATED_METHOD_EFFECT }, { ...BASELINE_METHOD_EFFECT });
});

test('差分基线：LOCAL/SESSION/INSTANCE/EXT/BYPASS 集合成员逐一一致', () => {
  assert.deepEqual(sortedSet(LOCAL_METHODS), BASELINE_OWNER_SETS.local);
  assert.deepEqual(sortedSet(SESSION_METHODS), BASELINE_OWNER_SETS.session);
  assert.deepEqual(sortedSet(INSTANCE_METHODS), BASELINE_OWNER_SETS.instance);
  assert.deepEqual(sortedSet(EXT_METHODS), BASELINE_OWNER_SETS.ext);
  assert.deepEqual(sortedSet(SESSION_QUEUE_BYPASS), BASELINE_OWNER_SETS.bypass);
  assert.deepEqual([...DAEMON_ONLY_METHODS].sort(), BASELINE_OWNER_SETS.daemonOnly);
  assert.equal(LOCAL_METHODS.size, 46);
  assert.equal(SESSION_METHODS.size, 109);
  assert.equal(INSTANCE_METHODS.size, 17);
  assert.equal(EXT_METHODS.size, 126);
  assert.equal(SESSION_QUEUE_BYPASS.size, 14);
});

test('差分基线：isMutating 对 165 方法与 6 个历史别名逐项一致', () => {
  for (const row of METHOD_CATALOG) {
    const baselineRow = BASELINE_METHOD_ROWS.find((entry) => entry[0] === row.method);
    assert.ok(baselineRow, row.method + ' 不在收口前基线里');
    assert.equal(isMutating(row.method), baselineRow[4], row.method + ' mutating 漂移');
  }
  for (const [method, expected] of BASELINE_LEGACY_MUTATING) {
    assert.equal(isMutating(method), expected, method);
    assert.equal(expected, true, method + ' 历史别名应为变异');
  }
  // 历史别名不得混入 canonical 目录。
  for (const [method] of BASELINE_LEGACY_MUTATING) {
    assert.equal(Object.prototype.hasOwnProperty.call(CATALOG_BY_METHOD, method), false, method);
    assert.equal(methodScope(method), null, method);
  }
});

test('差分基线：未知/空方法名探针（effect / mutating / scope）行为不变', () => {
  for (const probe of BASELINE_UNKNOWN_PROBES) {
    assert.equal(effectOf(probe.method), probe.effect, String(probe.method) + ' effect');
    assert.equal(isMutating(probe.method), probe.mutating, String(probe.method) + ' mutating');
    assert.equal(methodScope(probe.method), probe.scope, String(probe.method) + ' scope');
  }
  assert.equal(effectOf('no.such.method'), 'browser_mutation');
  assert.equal(isAllowedWhilePaused('no.such.method'), false);
});

test('差分比较器负例：8 个维度任一漂移都必须被 diffRows 抓住', () => {
  const baseline = structuredClone(BASELINE_METHOD_ROWS.map((row) => [...row]));
  const mutations = [
    { field: 'method', index: 3, value: 'session.request_prepare_renamed' },
    { field: 'owner', index: 3, value: 'session' },
    { field: 'effect', index: 3, value: 'browser_mutation' },
    { field: 'floor', index: 3, value: '1.9' },
    { field: 'mutating', index: 3, value: true },
    { field: 'partial', index: 3, value: true },
    { field: 'unknown', index: 3, value: true },
    { field: 'reconcile', index: 3, value: 'observe' },
  ];
  for (const mutation of mutations) {
    const broken = structuredClone(baseline);
    broken[mutation.index][ROW_FIELDS.indexOf(mutation.field)] = mutation.value;
    const problems = diffRows(broken, baseline);
    assert.ok(problems.length > 0, mutation.field + ' 漂移未被发现');
    assert.ok(problems.some((problem) => problem.field === mutation.field), mutation.field + ' 未被定位：' + JSON.stringify(problems));
    assert.equal(problems[0].index, mutation.index, mutation.field + ' 行号定位错误');
  }
  // 行数变化也必须被发现：期望短 → 实际多出；期望长 → 实际缺少。
  assert.equal(diffRows(baseline.slice(0, 3), baseline)[0].field, '<extra>');
  assert.equal(diffRows(baseline, baseline.slice(0, 3))[0].field, '<missing>');
});

test('派生：METHOD_EFFECT 就是目录表本身（同一对象、冻结、不可再被改写）', () => {
  assert.equal(METHOD_EFFECT, METHOD_EFFECT_TABLE);
  assert.equal(Object.isFrozen(METHOD_EFFECT), true);
  assert.equal(Object.isFrozen(METHOD_EFFECT_TABLE), true);
  assert.throws(() => { METHOD_EFFECT.click = 'passive_read'; }, TypeError);
  assert.equal(METHOD_EFFECT.click, 'browser_mutation');
  assert.equal(METHOD_EFFECT_TABLE.click, 'browser_mutation');
});

test('派生：LOCAL/SESSION/INSTANCE 三桶互斥且穷尽 canonical 目录', () => {
  const localOwners = OWNER_METHODS.local;
  const sessionOwners = OWNER_METHODS.session;
  const instanceOwners = OWNER_METHODS.instance;
  assert.equal(localOwners.length + sessionOwners.length + instanceOwners.length, METHOD_COUNT);
  for (const method of localOwners) {
    assert.equal(METHOD_OWNER_TABLE[method], 'local', method);
    assert.equal(LOCAL_METHODS.has(method), true, method);
    assert.equal(SESSION_METHODS.has(method), false, method);
    assert.equal(INSTANCE_METHODS.has(method), false, method);
  }
  for (const method of sessionOwners) {
    assert.equal(SESSION_METHODS.has(method), true, method);
    assert.equal(LOCAL_METHODS.has(method), false, method);
    assert.equal(INSTANCE_METHODS.has(method), false, method);
  }
  for (const method of instanceOwners) {
    assert.equal(INSTANCE_METHODS.has(method), true, method);
    assert.equal(LOCAL_METHODS.has(method), false, method);
    assert.equal(SESSION_METHODS.has(method), false, method);
  }
  // LOCAL 比目录 local 多出的正好是 daemon 专用方法。
  const localOnly = [...LOCAL_METHODS].filter((method) => !OWNER_METHODS.local.includes(method)).sort();
  assert.deepEqual(localOnly, [...DAEMON_ONLY_METHODS].sort());
  for (const method of EXT_METHODS) {
    assert.equal(SESSION_METHODS.has(method) || INSTANCE_METHODS.has(method), true, method);
  }
});

test('派生：isMutating 与目录 receipt effect + MUTATING_OVERRIDES 同口径（逐方法）', () => {
  for (const row of METHOD_CATALOG) {
    const expected = RECEIPT_EFFECT_SET.has(row.effect) || MUTATING_OVERRIDES.includes(row.method);
    assert.equal(isMutating(row.method), expected, row.method + ' 派生口径漂移');
    assert.equal(isMutatingInCatalog(row.method), expected, row.method + ' 目录口径漂移');
  }
  // 生成物 MUTATING_METHODS 与运行时逐项一致（daemon 账本与扩展消费同一集合）。
  assert.deepEqual([...GENERATED_MUTATING].sort(ascending), METHOD_CATALOG.filter((row) => isMutating(row.method)).map((row) => row.method).sort(ascending));
});

test('派生：isMutating 语义矩阵（effect × owner）只允许目录声明的特例', () => {
  const matrix = {};
  for (const row of METHOD_CATALOG) {
    const key = row.effect + '↔' + row.owner;
    matrix[key] = matrix[key] || { total: 0, mutating: 0, methods: [] };
    matrix[key].total += 1;
    if (isMutating(row.method)) { matrix[key].mutating += 1; matrix[key].methods.push(row.method); }
  }
  for (const row of METHOD_CATALOG) {
    const expected = RECEIPT_EFFECT_SET.has(row.effect) || MUTATING_OVERRIDES.includes(row.method);
    assert.equal(isMutating(row.method), expected, row.method);
    if (row.effect === 'browser_mutation' || row.effect === 'transient_input') {
      assert.equal(isMutating(row.method), true, row.method + ' 变异 effect 必须算变异');
    }
    if (row.effect === 'passive_read' || row.effect === 'read') {
      assert.equal(isMutating(row.method), false, row.method + ' 只读 effect 不得算变异');
    }
  }
  // control_plane 里只有 6 个显式 override 算变异，其余（含 status/tab.list 等查询）都是非变异。
  const controlPlaneMutating = METHOD_CATALOG
    .filter((row) => row.effect === 'control_plane' && isMutating(row.method))
    .map((row) => row.method)
    .sort(ascending);
  assert.deepEqual(controlPlaneMutating, [...MUTATING_OVERRIDES].sort(ascending));
  assert.equal(controlPlaneMutating.length, 6);
  assert.deepEqual(Object.keys(matrix).sort(ascending), [
    'browser_mutation↔instance',
    'browser_mutation↔session',
    'control_plane↔instance',
    'control_plane↔local',
    'control_plane↔session',
    'passive_read↔local',
    'passive_read↔session',
    'read↔session',
    'transient_input↔session',
  ]);
  assert.equal(matrix['read↔session'].mutating, 0);
  assert.equal(matrix['passive_read↔session'].mutating, 0);
  assert.equal(matrix['control_plane↔local'].mutating, 5);
});

test('派生：methodScope 与目录 owner 一致，未知方法为 null；remote read 作用域只放行非变异', () => {
  for (const row of METHOD_CATALOG) {
    assert.equal(methodScope(row.method), row.owner, row.method);
    assert.equal(methodScope(row.method), METHOD_OWNER_TABLE[row.method], row.method);
  }
  for (const method of DAEMON_ONLY_METHODS) assert.equal(methodScope(method), 'local', method);
  for (const method of ['no.such.method', 'not-a-method', '']) assert.equal(methodScope(method), null, method);
  for (const row of METHOD_CATALOG) {
    assert.equal(remoteScopeAllows('read', row.method), !isMutating(row.method), row.method);
    assert.equal(remoteScopeAllows('control', row.method), true, row.method);
    assert.equal(remoteScopeAllows(undefined, row.method), true, row.method);
  }
});

test('派生：isAllowedWhilePaused 与 effect 分类逐项一致（暂停只放行只读/控制面）', () => {
  let allowed = 0;
  for (const row of METHOD_CATALOG) {
    const expected = row.effect === 'passive_read' || row.effect === 'control_plane';
    assert.equal(isAllowedWhilePaused(row.method), expected, row.method + ' 暂停闸门漂移');
    if (expected) allowed += 1;
    if (row.effect === 'browser_mutation' || row.effect === 'transient_input' || row.effect === 'read') {
      assert.equal(isAllowedWhilePaused(row.method), false, row.method + ' 必须被暂停阻断');
    }
  }
  assert.equal(allowed, METHOD_CATALOG.filter((row) => row.effect === 'passive_read' || row.effect === 'control_plane').length);
  assert.equal(isAllowedWhilePaused('observe'), true);
  assert.equal(isAllowedWhilePaused('session.list'), true);
  assert.equal(isAllowedWhilePaused('click'), false);
});

test('派生：SESSION_QUEUE_BYPASS 全部有路由归属且与目录声明逐项一致', () => {
  assert.deepEqual([...SESSION_QUEUE_BYPASS], [...SESSION_QUEUE_BYPASS_METHODS]);
  assert.equal(new Set(SESSION_QUEUE_BYPASS_METHODS).size, SESSION_QUEUE_BYPASS_METHODS.length);
  for (const method of SESSION_QUEUE_BYPASS_METHODS) {
    assert.ok(SESSION_METHODS.has(method) || LOCAL_METHODS.has(method), method + ' 没有路由归属');
    assert.equal(methodScope(method), SESSION_METHODS.has(method) ? 'session' : 'local', method);
  }
  // 等待/解除类方法必须留在旁路表里（否则会在队列里死锁）。
  for (const method of ['operation.await', 'operation.cancel', 'dialog.status', 'dialog.accept', 'dialog.dismiss', 'cooperate.wait', 'cooperate.handback', 'cooperate.sync']) {
    assert.ok(SESSION_QUEUE_BYPASS.has(method), method);
  }
});

test('派生：daemon 专用方法不进 canonical，但保持 local 路由与展示默认值', () => {
  for (const method of DAEMON_ONLY_METHODS) {
    assert.equal(Object.prototype.hasOwnProperty.call(METHOD_EFFECT, method), false, method);
    assert.equal(methodScope(method), 'local', method);
    // effectOf 的未知方法默认值是保守的 browser_mutation；目录解释器对 daemon 专用方法展示 control_plane。
    assert.equal(effectOf(method), 'browser_mutation', method);
    assert.equal(describeCatalogMethod(method).effect, 'control_plane', method);
    assert.equal(isMutating(method), false, method);
    assert.equal(describeCatalogMethod(method).owner, 'local', method);
    assert.equal(describeCatalogMethod(method).floor, null, method);
  }
  // 目录解释器对完全未知的方法也保持历史默认，不抛错。
  assert.equal(describeCatalogMethod('not-a-method').effect, 'control_plane');
  assert.equal(describeCatalogMethod('not-a-method').owner, null);
});

test('派生：文件传输协议事实由目录派生，远程拒绝语义不变', () => {
  assert.deepEqual([...FILE_TRANSFER_METHODS], ['upload', 'download']);
  for (const row of METHOD_CATALOG) {
    assert.equal(isFileTransferMethod(row.method), FILE_TRANSFER_METHODS.includes(row.method), row.method);
  }
  assert.equal(isFileTransferMethod('click'), false);
  assert.equal(shouldRejectRemoteTransfer({ remote: true }, 'upload'), true);
  assert.equal(shouldRejectRemoteTransfer({ remote: true }, 'download'), true);
  assert.equal(shouldRejectRemoteTransfer({ remote: true }, 'click'), false);
  assert.equal(shouldRejectRemoteTransfer({ remote: false }, 'upload'), false);
});

test('派生：validateMethodRegistry() 为空；catalog 派生不再产生手工表漂移', () => {
  assert.deepEqual(validateMethodRegistry(), []);
  assert.deepEqual(validateRuntimeLists(), []);
  assert.equal(METHOD_COUNT, 165);
  assert.deepEqual(METHOD_NAMES, BASELINE_METHOD_NAMES);
  assert.deepEqual({ ...METHOD_RECONCILE }, { ...BASELINE_METHOD_RECONCILE });
  assert.deepEqual(
    Object.fromEntries(Object.entries(METHOD_STATE).map(([method, state]) => [method, { ...state }])),
    Object.fromEntries(Object.entries(BASELINE_METHOD_STATE).map(([method, state]) => [method, { ...state }])),
  );
});

test('派生：catalog 的 listMethods/describeMethod 覆盖全部 165 且与基线逐项一致', () => {
  const rows = listCatalogMethods();
  assert.equal(rows.length, 165);
  assert.deepEqual(rows.map((row) => row.method), [...METHOD_NAMES].sort(ascending));
  assert.equal(new Set(rows.map((row) => row.method)).size, 165);
  for (const entry of rows) {
    const baselineRow = BASELINE_METHOD_ROWS.find((row) => row[0] === entry.method);
    const state = methodStateOf(entry.method);
    assert.ok(baselineRow);
    assert.equal(entry.owner, baselineRow[1], entry.method);
    assert.equal(entry.effect, baselineRow[2], entry.method);
    assert.equal(entry.floor, baselineRow[3], entry.method);
    assert.equal(entry.receipt, RECEIPT_EFFECT_SET.has(entry.effect), entry.method);
    assert.deepEqual({ ...entry.reconcile }, { ...state.reconcile }, entry.method);
    assert.equal(entry.partial, baselineRow[5], entry.method);
    assert.equal(entry.unknown, baselineRow[6], entry.method);
    assert.equal(typeof entry.feature, 'string', entry.method);
    assert.ok(entry.feature.length > 0, entry.method);
  }
});

test('派生：validateRuntimeLists 负例——重复/非法 owner/混入/旁路无归属/特性门反向缺失都能抓住', () => {
  const duplicateRows = [...METHOD_CATALOG, METHOD_CATALOG[0]];
  assert.ok(validateRuntimeLists(duplicateRows).some((message) => message.includes('目录方法重复')));

  const badOwnerRows = METHOD_CATALOG.map((row, index) => (index === 0 ? { ...row, owner: 'remote' } : row));
  assert.ok(validateRuntimeLists(badOwnerRows).some((message) => message.includes('owner 非法')));

  assert.ok(validateRuntimeLists(METHOD_CATALOG, { daemonOnly: ['click'] })
    .some((message) => message.includes('daemon 专用方法不得进入 canonical')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { legacyMutating: ['click'] })
    .some((message) => message.includes('历史变异别名不得进入 canonical')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { bypass: ['ghost.method'] })
    .some((message) => message.includes('队列旁路方法没有路由归属')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { bypass: ['click', 'click'] })
    .some((message) => message.includes('SESSION_QUEUE_BYPASS_METHODS 有重复')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { daemonOnly: ['command.cancel', 'command.cancel'] })
    .some((message) => message.includes('DAEMON_ONLY_METHODS 有重复')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { featureMeta: { har: { methods: ['ghost.method'] } } })
    .some((message) => message.includes('引用了目录外方法')));
  assert.ok(validateRuntimeLists(METHOD_CATALOG, { methodFeature: {} })
    .some((message) => message.includes('反向映射不一致')));
});

test('导入顺序无关：目录优先 / protocol 优先 / methods 优先三种顺序都能加载（无 TDZ 循环）', () => {
  const orders = [
    ['./lib/method-catalog.mjs', './lib/protocol.mjs', './lib/methods.mjs'],
    ['./lib/protocol.mjs', './lib/method-catalog.mjs', './lib/methods.mjs'],
    ['./lib/methods.mjs', './lib/protocol.mjs', './lib/method-catalog.mjs'],
  ];
  for (const order of orders) {
    const script = order.map((specifier) => 'await import(' + JSON.stringify(specifier) + ');').join(' ')
      + ' const p = await import("./lib/protocol.mjs");'
      + ' const m = await import("./lib/methods.mjs");'
      + ' const c = await import("./lib/method-catalog.mjs");'
      + ' console.log(JSON.stringify([Object.keys(p.METHOD_EFFECT).length, m.LOCAL_METHODS.size, m.SESSION_METHODS.size, c.METHOD_COUNT]));';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, order.join(' → ') + '：' + String(result.stderr || ''));
    assert.deepEqual(JSON.parse(result.stdout.trim()), [165, 46, 109, 165], order.join(' → '));
  }
});

test('消费路径：扩展生成物（protocol.js）与运行时派生逐项相同', () => {
  assert.equal(GENERATED_COUNT, METHOD_COUNT);
  assert.deepEqual([...GENERATED_METHODS], [...METHOD_NAMES].sort(ascending));
  assert.deepEqual([...GENERATED_LOCAL], sortedSet(LOCAL_METHODS));
  assert.deepEqual([...GENERATED_SESSION], sortedSet(SESSION_METHODS));
  assert.deepEqual([...GENERATED_INSTANCE], sortedSet(INSTANCE_METHODS));
  assert.deepEqual([...GENERATED_EXT], sortedSet(EXT_METHODS));
  assert.deepEqual({ ...GENERATED_OWNER }, Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.owner])));
  assert.deepEqual(
    Object.fromEntries(Object.entries(GENERATED_STATE).map(([method, state]) => [method, { ...state }])),
    Object.fromEntries(Object.entries(BASELINE_METHOD_STATE).map(([method, state]) => [method, { ...state }])),
  );
});

test('消费路径：生成物 helper（methodEffect/isKnownMethod/methodState/methodFloor）与目录一致', () => {
  for (const row of METHOD_CATALOG) {
    assert.equal(generatedMethodEffect(row.method), row.effect, row.method);
    assert.equal(generatedIsKnownMethod(row.method), true, row.method);
    assert.equal(generatedMethodFloor(row.method), row.floor, row.method);
    assert.deepEqual({ ...generatedMethodState(row.method) }, { ...METHOD_STATE[row.method] }, row.method);
  }
  for (const method of DAEMON_ONLY_METHODS) {
    assert.equal(generatedMethodEffect(method), null, method);
    assert.equal(generatedIsKnownMethod(method), false, method);
    assert.equal(generatedMethodState(method), null, method);
    assert.equal(generatedMethodFloor(method), null, method);
  }
  assert.equal(generatedMethodEffect('not-a-method'), null);
  assert.equal(generatedMethodState('not-a-method'), null);
});

test('消费路径：schema-info（CLI bridge schema）看到 scope/effect/mutating 不回退', () => {
  const info = describeSchemaInfo('click');
  assert.equal(info.scope, 'session');
  assert.equal(info.effect, 'browser_mutation');
  assert.equal(info.mutating, true);
  assert.equal(describeSchemaInfo('status').scope, 'local');
  assert.equal(describeSchemaInfo('window.focus').scope, 'instance');
  assert.equal(describeSchemaInfo('not.a.method'), null);
  const rows = listSchemaInfoMethods();
  assert.equal(rows.length, 165);
  assert.deepEqual(rows.map((row) => row.method), [...METHOD_NAMES].sort(ascending));
  for (const row of rows) {
    assert.equal(row.effect, METHOD_EFFECT[row.method], row.method);
    assert.equal(row.scope, METHOD_OWNER_TABLE[row.method], row.method);
    assert.equal(row.mutating, isMutating(row.method), row.method);
  }
});
