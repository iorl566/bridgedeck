// tests/unit/protocol-state-machine.test.mjs —— 方法状态机五维（owner/effect/partial/unknown/reconcile）。
//
// 断言对象：
//  1. lib/method-catalog.mjs 是五维唯一源，165 个方法都有完整状态；
//  2. 不变量：partial 只出现在只读方法；unknown 只出现在需要回执的变异；reconcile 与 unknown 匹配；
//  3. 生成物 extension/src/generated/protocol.js 必须与目录逐项相同（只由生成器产出）；
//  4. docs/PROTOCOL-METHODS.md 的索引/特性门/状态机三张表都完整。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_FLOORS,
  FEATURE_METHODS,
  FEATURE_NAMES,
  METHOD_CATALOG,
  METHOD_COUNT,
  METHOD_EFFECT_TABLE,
  METHOD_FEATURE,
  METHOD_FEATURE_FLOOR,
  METHOD_NAMES,
  METHOD_OWNER_TABLE,
  METHOD_PARTIAL,
  METHOD_RECONCILE,
  METHOD_STATE,
  METHOD_UNKNOWN,
  PARTIAL_METHODS,
  RECONCILE_DEFAULT,
  RECONCILE_OVERRIDES,
  RECONCILE_STRATEGIES,
  describeMethod,
  isMutatingInCatalog,
  listMethods,
  methodStateOf,
  validateMethodStates,
} from '../../lib/method-catalog.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';
import { isMutating } from '../../lib/methods.mjs';
import {
  METHOD_PARTIAL as GENERATED_PARTIAL,
  METHOD_RECONCILE as GENERATED_RECONCILE,
  METHOD_STATE as GENERATED_STATE,
  METHOD_UNKNOWN as GENERATED_UNKNOWN,
  METHOD_FEATURE as GENERATED_METHOD_FEATURE,
  METHOD_FEATURE_FLOOR as GENERATED_FEATURE_FLOOR,
  FEATURE_MIN_PROTOCOL as GENERATED_FEATURE_FLOORS,
  FEATURE_METHODS as GENERATED_FEATURE_METHODS,
  FEATURE_NAMES as GENERATED_FEATURE_NAMES,
  PROTOCOL_BASELINE as GENERATED_BASELINE,
  PROTOCOL_CURRENT as GENERATED_CURRENT,
  methodState as generatedMethodState,
} from '../../extension/src/generated/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS_TEXT = fs.readFileSync(path.join(ROOT, 'docs', 'PROTOCOL-METHODS.md'), 'utf8');
const READ_EFFECTS = new Set(['passive_read', 'read']);

test('165 个方法都有五维状态，且与 owner/effect 手工表一致', () => {
  assert.equal(METHOD_COUNT, 165);
  assert.equal(METHOD_CATALOG.length, 165);
  assert.equal(Object.keys(METHOD_STATE).length, 165);
  assert.equal(METHOD_CATALOG.filter((row) => row.owner).length, 165);
  for (const row of METHOD_CATALOG) {
    const state = METHOD_STATE[row.method];
    assert.ok(state, row.method + ' 缺少状态行');
    assert.equal(state.owner, row.owner);
    assert.equal(state.effect, row.effect);
    assert.equal(state.owner, METHOD_OWNER_TABLE[row.method]);
    assert.equal(state.effect, METHOD_EFFECT_TABLE[row.method]);
    assert.equal(state.effect, METHOD_EFFECT[row.method]);
    assert.equal(typeof state.partial, 'boolean', row.method + ' partial 不是布尔');
    assert.equal(typeof state.unknown, 'boolean', row.method + ' unknown 不是布尔');
    assert.ok(RECONCILE_STRATEGIES.includes(state.reconcile.strategy), row.method + ' reconcile 策略非法');
  }
  assert.equal(methodStateOf('click').owner, 'session');
  assert.equal(methodStateOf('tab.list').owner, 'instance');
  assert.equal(methodStateOf('status').owner, 'local');
  assert.equal(methodStateOf('no.such.method'), null);
  assert.equal(generatedMethodState('video.start').reconcile.method, 'video.status');
  assert.equal(generatedMethodState('no.such.method'), null);
});

test('partial 维度：12 个分页/分片/流式只读方法，不变量成立', () => {
  assert.equal(PARTIAL_METHODS.length, 12);
  assert.deepEqual([...METHOD_PARTIAL].sort(), [...PARTIAL_METHODS].sort());
  assert.equal(new Set(PARTIAL_METHODS).size, PARTIAL_METHODS.length, 'partial 表有重复');
  for (const method of PARTIAL_METHODS) {
    const state = METHOD_STATE[method];
    assert.ok(state, method + ' 不在目录');
    assert.equal(state.partial, true, method + ' 应标记 partial');
    assert.ok(READ_EFFECTS.has(state.effect), method + ' partial 必须是只读方法，实际 ' + state.effect);
  }
  for (const method of ['observe', 'observe-frames', 'extract', 'extract.discover', 'extract.table', 'extract.list', 'console', 'network.list', 'network.waterfall', 'screenshot', 'screenshot.read', 'longshot.recover']) {
    assert.equal(describeMethod(method).partial, true, method + ' 应为 partial');
  }
  for (const method of ['click', 'navigate', 'fill', 'video.start', 'plan', 'read', 'session.start']) {
    assert.equal(describeMethod(method).partial, false, method + ' 不应是 partial');
  }
});

test('unknown 维度：需要回执的变异才可能 UNKNOWN，只读方法永远 known', () => {
  assert.equal(METHOD_UNKNOWN.length, 75);
  assert.deepEqual([...METHOD_UNKNOWN].sort(), [...GENERATED_UNKNOWN].sort());
  for (const row of METHOD_CATALOG) {
    assert.equal(row.unknown, isMutatingInCatalog(row.method), row.method + ' unknown 与目录口径不一致');
  }
  for (const method of ['click', 'fill', 'navigate', 'video.start', 'tab.new', 'session.start', 'plan']) {
    assert.equal(describeMethod(method).unknown, true, method + ' 应 unknown');
  }
  for (const method of ['observe', 'read', 'status', 'screenshot', 'tab.list', 'view']) {
    assert.equal(describeMethod(method).unknown, false, method + ' 不应 unknown');
  }
  // 与 lib/methods.mjs 的历史 isMutating 分类保持一致（协议-check 也同时校验）。
  for (const row of METHOD_CATALOG) {
    assert.equal(isMutating(row.method), isMutatingInCatalog(row.method), row.method + ' isMutating 漂移');
  }
});

test('reconcile 维度：策略与目标合法，status 目标只读且真实存在', () => {
  const localMutations = [];
  for (const row of METHOD_CATALOG) {
    const rec = row.reconcile;
    assert.ok(RECONCILE_STRATEGIES.includes(rec.strategy), row.method + ' reconcile 策略非法');
    if (!row.unknown) {
      assert.equal(rec.strategy, 'none', row.method + ' 非变异必须是 none');
      assert.equal(rec.method, null, row.method + ' 非变异不应带收敛目标');
    } else {
      assert.notEqual(rec.strategy, 'none', row.method + ' 变异必须有收敛策略');
      if (rec.strategy === 'status') {
        assert.ok(rec.method, row.method + ' status 收敛缺少目标');
        const target = METHOD_STATE[rec.method];
        assert.ok(target, row.method + ' 收敛目标不在目录：' + rec.method);
        assert.ok(READ_EFFECTS.has(target.effect) || target.effect === 'control_plane', row.method + ' 收敛目标必须是只读：' + rec.method);
        assert.equal(isMutatingInCatalog(rec.method), false, row.method + ' 收敛目标不应是变异方法');
      } else {
        assert.equal(rec.method, null, row.method + ' ' + rec.strategy + ' 收敛不应带目标');
      }
    }
    if (row.owner === 'local' && row.unknown) localMutations.push(row.method);
  }
  assert.deepEqual(localMutations.sort(), ['session.pause', 'session.rebind', 'session.start', 'session.start_tracked', 'session.stop']);
  assert.deepEqual(describeMethod('video.start').reconcile, { strategy: 'status', method: 'video.status' });
  assert.deepEqual(describeMethod('video.fetch').reconcile, { strategy: 'status', method: 'video.status' });
  assert.deepEqual(describeMethod('tab.new').reconcile, { strategy: 'status', method: 'tab.list' });
  assert.deepEqual(describeMethod('dialog.accept').reconcile, { strategy: 'status', method: 'dialog.status' });
  assert.deepEqual(describeMethod('navigate').reconcile, { strategy: 'observe', method: null });
  assert.deepEqual(describeMethod('session.start').reconcile, { strategy: 'ledger', method: null });
  assert.deepEqual(describeMethod('observe').reconcile, { strategy: 'none', method: null });
  assert.deepEqual(describeMethod('click').reconcile, { strategy: 'observe', method: null });
  assert.equal(RECONCILE_DEFAULT.browser_mutation, 'observe');
  assert.equal(RECONCILE_DEFAULT.control_plane, 'ledger');
  assert.equal(RECONCILE_DEFAULT.passive_read, 'none');
  for (const [method, override] of Object.entries(RECONCILE_OVERRIDES)) {
    assert.ok(METHOD_STATE[method], 'reconcile override 指向目录外方法：' + method);
    assert.ok(typeof override === 'string' && override.length >= 4, method + ' override 非法');
  }
});

test('目录不变量校验：validateMethodStates() 为空；破坏任一面都能被抓住', () => {
  assert.deepEqual(validateMethodStates(), []);
  const baseRows = METHOD_CATALOG.map((row) => ({
    method: row.method,
    owner: row.owner,
    effect: row.effect,
    partial: row.partial,
    unknown: row.unknown,
    reconcile: { ...row.reconcile },
  }));
  const find = (rows, method) => rows.find((row) => row.method === method);

  const unknownBroken = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(unknownBroken, 'click').unknown = false;
  assert.ok(validateMethodStates(unknownBroken).some((message) => message.includes('click') && message.includes('unknown')), 'unknown 篡改未被抓住');

  const partialBroken = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(partialBroken, 'observe').partial = false;
  assert.ok(validateMethodStates(partialBroken).some((message) => message.includes('observe') && message.includes('partial')), 'partial 篡改未被抓住');

  const partialOnMutation = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(partialOnMutation, 'click').partial = true;
  assert.ok(validateMethodStates(partialOnMutation).some((message) => message.includes('click') && message.includes('只读')), '变异上的 partial 未被抓住');

  const reconcileBroken = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(reconcileBroken, 'observe').reconcile = { strategy: 'ledger', method: null };
  assert.ok(validateMethodStates(reconcileBroken).some((message) => message.includes('observe') && message.includes('none')), '只读方法的 reconcile 未被抓住');

  const targetBroken = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(targetBroken, 'video.start').reconcile = { strategy: 'status', method: 'not.a.method' };
  assert.ok(validateMethodStates(targetBroken).some((message) => message.includes('not.a.method')), '收敛目标越界未被抓住');

  const ownerBroken = baseRows.map((row) => ({ ...row, reconcile: { ...row.reconcile } }));
  find(ownerBroken, 'click').owner = 'remote';
  assert.ok(validateMethodStates(ownerBroken).some((message) => message.includes('click') && message.includes('owner')), '非法 owner 未被抓住');
});

test('生成物五维表与目录逐项相同（只允许生成器写）', () => {
  assert.deepEqual(GENERATED_STATE, JSON.parse(JSON.stringify(METHOD_STATE)));
  assert.deepEqual([...GENERATED_PARTIAL].sort(), [...METHOD_PARTIAL].sort());
  assert.deepEqual([...GENERATED_UNKNOWN].sort(), [...METHOD_UNKNOWN].sort());
  assert.deepEqual(GENERATED_RECONCILE, JSON.parse(JSON.stringify(METHOD_RECONCILE)));
  assert.equal(Object.keys(GENERATED_STATE).length, 165);
  for (const method of METHOD_NAMES) {
    assert.deepEqual(generatedMethodState(method), JSON.parse(JSON.stringify(methodStateOf(method))), method);
  }
});

test('生成物特性表与目录相同：15 floor / 8 个方法级特性 / 29 gated 方法', () => {
  assert.equal(Object.keys(GENERATED_FEATURE_FLOORS).length, 15);
  assert.deepEqual(GENERATED_FEATURE_FLOORS, JSON.parse(JSON.stringify(FEATURE_FLOORS)));
  assert.deepEqual([...GENERATED_FEATURE_NAMES].sort(), [...FEATURE_NAMES].sort());
  assert.deepEqual(GENERATED_METHOD_FEATURE, JSON.parse(JSON.stringify(METHOD_FEATURE)));
  assert.deepEqual(GENERATED_FEATURE_METHODS, JSON.parse(JSON.stringify(FEATURE_METHODS)));
  assert.deepEqual(GENERATED_FEATURE_FLOOR, JSON.parse(JSON.stringify(METHOD_FEATURE_FLOOR)));
  assert.equal(Object.keys(METHOD_FEATURE).length, 29);
  assert.equal(Object.keys(METHOD_FEATURE_FLOOR).length, 29);
  for (const [method, feature] of Object.entries(METHOD_FEATURE)) {
    assert.equal(FEATURE_FLOORS[feature], '1.9', method + ' floor 必须是 1.9');
    assert.equal(METHOD_FEATURE_FLOOR[method], '1.9');
    assert.ok(FEATURE_METHODS[feature].includes(method), method + ' 未出现在特性的正表');
  }
  assert.equal(GENERATED_BASELINE, '1.8');
  assert.equal(GENERATED_CURRENT, '1.9');
});

test('docs/PROTOCOL-METHODS.md：索引 172 行 / 特性门 15 行 / 状态机 165 行', () => {
  const tables = DOCS_TEXT.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('| `'));
  const cells = tables.map((line) => line.split('|').map((cell) => cell.trim()).slice(1, -1));
  assert.equal(cells.filter((row) => row.length === 3).length, 172, '方法索引行数');
  assert.equal(cells.filter((row) => row.length === 4).length, 15, '特性门行数');
  assert.equal(cells.filter((row) => row.length === 6).length, 165, '状态机行数');
  const stateRows = cells.filter((row) => row.length === 6).map((row) => row[0].replace(/^`|`$/g, ''));
  assert.deepEqual([...stateRows].sort(), [...METHOD_NAMES].sort());
  for (const feature of FEATURE_NAMES) {
    assert.ok(DOCS_TEXT.includes('| `' + feature + '` | 1.9 |'), feature + ' 未出现在特性门表');
  }
  assert.match(DOCS_TEXT, /unknown=派发后可能无法证明是否生效/);
  assert.match(DOCS_TEXT, /由 `node tools\/gen-protocol.mjs` 生成/);
});

test('listMethods/describeMethod 暴露五维，状态对象不可变', () => {
  const rows = listMethods();
  assert.equal(rows.length, 165);
  assert.equal(new Set(rows.map((row) => row.method)).size, 165);
  for (const entry of rows) {
    assert.equal(typeof entry.partial, 'boolean', entry.method);
    assert.equal(typeof entry.unknown, 'boolean', entry.method);
    assert.ok(RECONCILE_STRATEGIES.includes(entry.reconcile.strategy), entry.method);
    assert.equal(typeof entry.floor === 'string' || entry.floor === null, true);
  }
  assert.ok(Object.isFrozen(METHOD_STATE));
  assert.ok(Object.isFrozen(METHOD_STATE.click));
  assert.ok(Object.isFrozen(methodStateOf('click')));
  assert.ok(Object.isFrozen(RECONCILE_STRATEGIES));
  assert.ok(Object.isFrozen(PARTIAL_METHODS));
});
