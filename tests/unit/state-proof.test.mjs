// tests/unit/state-proof.test.mjs —— 方法可证明性六面（pre / post / effect_state /
// idempotent / replayable / recovery）的目录级单测。
//
// 断言对象：
//   1. 165 个 canonical 方法都有完整六面，且与 owner/effect/unknown 等既有五维一致；
//   2. 每条前置/后置码、每个 effect_state、每个恢复码都已在目录登记；
//   3. 族规则 100% 生效（没有被更早规则遮蔽的死规则），每个方法只命中一条规则；
//   4. 幂等/可重放与意图账本的 NON_IDEMPOTENT 口径一致（不可重放 ⊇ 非幂等副作用）；
//   5. validateMethodProofs 能抓住缺行/越界/非法码/不可证明却可重放/死规则等负例；
//   6. 既有五维 METHOD_STATE 结构完全不变（只加不改）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDEMPOTENT_METHODS,
  IDEMPOTENT_MUTATING_METHODS,
  METHOD_CATALOG,
  METHOD_COUNT,
  METHOD_EFFECT_STATE,
  METHOD_EFFECT_TABLE,
  METHOD_IDEMPOTENT,
  METHOD_NAMES,
  METHOD_POSTCONDITIONS,
  METHOD_PRECONDITIONS,
  METHOD_PROOF,
  METHOD_RECOVERY,
  METHOD_REPLAYABLE,
  PROOF_EFFECT_STATES,
  PROOF_OVERRIDES,
  PROOF_POSTCONDITIONS,
  PROOF_PRECONDITIONS,
  PROOF_RECOVERY_ACTIONS,
  PROOF_RULES,
  RECOVERY_BASE_CODES,
  RECOVERY_PLAYBOOK,
  RECOVERY_PROFILES,
  REPLAYABLE_METHODS,
  describeMethod,
  isMutatingInCatalog,
  listMethods,
  methodStateOf,
  proofOf,
  validateMethodProofs,
} from '../../lib/method-catalog.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';
import { isNonIdempotentAction, NON_IDEMPOTENT_METHODS } from '../../lib/intent-ledger.mjs';

const READ_EFFECTS = new Set(['passive_read', 'read']);
const PROOF_DIMS = ['method', 'rule', 'owner', 'effect', 'effectState', 'pre', 'post', 'idempotent', 'replayable', 'profile', 'recovery'];
const VALID_PROFILES = new Set(Object.keys(RECOVERY_PROFILES));
const VALID_EFFECT_STATES = new Set(Object.keys(PROOF_EFFECT_STATES));
const VALID_PRE = new Set(Object.keys(PROOF_PRECONDITIONS));
const VALID_POST = new Set(Object.keys(PROOF_POSTCONDITIONS));

// 目录的 effect_state 分布（漂移即失败；数字来自 165 方法逐项统计）。
const EXPECTED_EFFECT_STATES = Object.freeze({
  none: 59,
  page: 17,
  debugger: 13,
  session: 11,
  control: 9,
  tab: 7,
  capture: 6,
  pairing: 6,
  video: 6,
  dialog: 5,
  window: 5,
  navigation: 4,
  network: 4,
  transfer: 4,
  focus: 2,
  recording: 2,
  ui: 2,
  plan: 1,
  policy: 1,
  scroll: 1,
});

// ---------------------------------------------------------------------------
// 结构完整性
// ---------------------------------------------------------------------------

test('165 个 canonical 方法都有六面可证明性，键序与方法目录一致', () => {
  assert.equal(METHOD_COUNT, 165);
  assert.equal(Object.keys(METHOD_PROOF).length, 165);
  assert.deepEqual(Object.keys(METHOD_PROOF), [...METHOD_NAMES]);
  for (const row of METHOD_CATALOG) {
    const proof = METHOD_PROOF[row.method];
    assert.ok(proof, row.method + ' 缺少可证明性行');
    for (const dim of PROOF_DIMS) {
      assert.ok(Object.prototype.hasOwnProperty.call(proof, dim), row.method + ' 缺少维度 ' + dim);
    }
    assert.equal(proof.method, row.method);
    assert.equal(proof.owner, row.owner);
    assert.equal(proof.effect, row.effect);
    assert.equal(typeof proof.rule, 'string');
    assert.ok(proof.rule.length >= 3, row.method + ' rule 标识过短');
    assert.equal(typeof proof.effectState, 'string');
    assert.equal(typeof proof.idempotent, 'boolean');
    assert.equal(typeof proof.replayable, 'boolean');
    assert.ok(Array.isArray(proof.pre) && proof.pre.length > 0, row.method + ' 前置条件为空');
    assert.ok(Array.isArray(proof.post) && proof.post.length > 0, row.method + ' 后置条件为空');
    assert.ok(Array.isArray(proof.recovery) && proof.recovery.length > 0, row.method + ' 恢复集为空');
    assert.ok(VALID_PROFILES.has(proof.profile), row.method + ' 恢复族未登记：' + proof.profile);
  }
});

test('六面与既有五维逐项一致：owner/effect/unknown/replayable 不改写旧事实', () => {
  for (const row of METHOD_CATALOG) {
    const proof = proofOf(row.method);
    const state = methodStateOf(row.method);
    assert.equal(proof.owner, state.owner, row.method);
    assert.equal(proof.effect, state.effect, row.method);
    assert.equal(proof.effect, METHOD_EFFECT_TABLE[row.method], row.method);
    assert.equal(proof.effect, METHOD_EFFECT[row.method], row.method);
    assert.equal(proof.replayable, !state.unknown, row.method + ' 可重放必须等价于“结果可证明”');
    assert.equal(isMutatingInCatalog(row.method), state.unknown, row.method);
  }
});

test('既有 METHOD_STATE 仍是五维（六面只在新增表里，不污染生成物）', () => {
  const keys = Object.keys(methodStateOf('click')).sort();
  assert.deepEqual(keys, ['effect', 'owner', 'partial', 'reconcile', 'unknown']);
  for (const row of METHOD_CATALOG) {
    const state = methodStateOf(row.method);
    assert.deepEqual(Object.keys(state).sort(), ['effect', 'owner', 'partial', 'reconcile', 'unknown'], row.method);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'replayable'), false, row.method + ' 五维不应混入六面');
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'idempotent'), false, row.method);
  }
  // describeMethod 也只暴露既有字段 + floor/reconcile，不额外塞六面（保持默认输出稳定）。
  const described = describeMethod('click');
  assert.equal(Object.prototype.hasOwnProperty.call(described, 'replayable'), false);
  assert.equal(listMethods().length, 165);
});

// ---------------------------------------------------------------------------
// 码表登记完整性
// ---------------------------------------------------------------------------

test('前置条件码：目录登记、标签非空、无重复定义', () => {
  const codes = Object.keys(PROOF_PRECONDITIONS);
  assert.ok(codes.length >= 15, '前置条件码过少');
  for (const code of codes) {
    assert.equal(typeof PROOF_PRECONDITIONS[code], 'string', code);
    assert.ok(PROOF_PRECONDITIONS[code].length >= 4, code + ' 标签过短');
    assert.match(code, /^[a-z][a-z0-9.-]*$/, code + ' 命名不规范');
  }
  // 目录用到的每个前置码都必须登记且可解释
  const used = new Set();
  for (const row of METHOD_CATALOG) for (const code of METHOD_PRECONDITIONS[row.method]) used.add(code);
  for (const code of used) assert.ok(VALID_PRE.has(code), '方法引用了未登记前置码：' + code);
  assert.deepEqual([...used].sort(), [...new Set(Object.values(METHOD_PROOF).flatMap((proof) => proof.pre))].sort());
});

test('后置条件码：目录登记、无重复、方法引用的码全部有效', () => {
  const codes = Object.keys(PROOF_POSTCONDITIONS);
  assert.ok(codes.length >= 20, '后置条件码过少');
  for (const code of codes) assert.ok(PROOF_POSTCONDITIONS[code].length >= 4, code);
  const used = new Set();
  for (const row of METHOD_CATALOG) for (const code of METHOD_POSTCONDITIONS[row.method]) used.add(code);
  for (const code of used) assert.ok(VALID_POST.has(code), '方法引用了未登记后置码：' + code);
  assert.ok(used.size >= 15, '被使用的后置码过少：' + used.size);
});

test('effect_state：登记表 20 类，方法分布与预期一致，全部有效', () => {
  assert.equal(Object.keys(PROOF_EFFECT_STATES).length, 20);
  const counts = {};
  for (const row of METHOD_CATALOG) {
    const state = METHOD_EFFECT_STATE[row.method];
    assert.ok(VALID_EFFECT_STATES.has(state), row.method + ' effect_state 非法：' + state);
    counts[state] = (counts[state] || 0) + 1;
    assert.equal(state, METHOD_PROOF[row.method].effectState, row.method);
  }
  assert.deepEqual(counts, EXPECTED_EFFECT_STATES);
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 165);
});

test('恢复动作码：20+ 类，每个 playbook 动作都已登记，说明非空', () => {
  const actions = Object.keys(PROOF_RECOVERY_ACTIONS);
  assert.ok(actions.length >= 20, '恢复动作过少');
  for (const action of actions) assert.ok(PROOF_RECOVERY_ACTIONS[action].length >= 4, action);
  for (const [code, plan] of Object.entries(RECOVERY_PLAYBOOK)) {
    assert.ok(PROOF_RECOVERY_ACTIONS[plan.action], code + ' 动作未登记：' + plan.action);
  }
});

// ---------------------------------------------------------------------------
// 族规则
// ---------------------------------------------------------------------------

test('族规则：69 条、id 唯一、pattern 合法、每条都被真实方法选中（无死规则）', () => {
  assert.equal(PROOF_RULES.length, 69);
  const ids = new Set();
  for (const rule of PROOF_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(rule.id.length >= 3, '规则 id 过短');
    assert.equal(ids.has(rule.id), false, '规则 id 重复：' + rule.id);
    ids.add(rule.id);
    assert.equal(typeof rule.pattern, 'string');
    assert.doesNotThrow(() => new RegExp(rule.pattern), rule.id + ' pattern 非法');
    assert.ok(VALID_EFFECT_STATES.has(rule.effectState), rule.id + ' effectState 非法');
    assert.ok(Array.isArray(rule.pre) && rule.pre.length > 0, rule.id);
    assert.ok(Array.isArray(rule.post) && rule.post.length > 0, rule.id);
    for (const code of rule.pre) assert.ok(VALID_PRE.has(code), rule.id + ' 未登记前置码：' + code);
    for (const code of rule.post) assert.ok(VALID_POST.has(code), rule.id + ' 未登记后置码：' + code);
    assert.ok(VALID_PROFILES.has(rule.profile), rule.id + ' 恢复族未登记：' + rule.profile);
    assert.equal(typeof rule.idempotent, 'boolean', rule.id);
    assert.equal(Object.values(rule).some((value) => typeof value === 'function'), false, rule.id + ' 规则不应包含函数');
  }
  // 每条规则至少选中一个方法；每个方法首个命中规则必须存在。
  const selected = new Map();
  for (const row of METHOD_CATALOG) {
    const hits = PROOF_RULES.filter((rule) => new RegExp(rule.pattern).test(row.method));
    assert.ok(hits.length >= 1, row.method + ' 没有规则命中');
    selected.set(row.method, hits[0].id);
  }
  const usedRules = new Set(selected.values());
  for (const rule of PROOF_RULES) assert.ok(usedRules.has(rule.id), '规则被更早规则遮蔽：' + rule.id);
  assert.equal(usedRules.size, PROOF_RULES.length);
  // 规则不是“一个方法一条”的隐藏手工表：平均每条覆盖 2+ 个方法。
  assert.ok(METHOD_CATALOG.length / PROOF_RULES.length >= 2, '规则粒度太细，退化成手工表');
});

test('单方法例外：47 条全部指向 canonical 方法，且字段合法', () => {
  const overrides = Object.entries(PROOF_OVERRIDES).filter(([, value]) => value && typeof value === 'object');
  assert.equal(overrides.length, 47);
  for (const [method, override] of overrides) {
    assert.ok(METHOD_NAMES.includes(method), '例外指向目录外方法：' + method);
    assert.ok(override && typeof override === 'object', method + ' 例外不是对象');
    for (const key of ['effectState', 'pre', 'post', 'idempotent', 'replayable']) {
      if (override[key] === undefined) continue;
      if (key === 'effectState') assert.ok(VALID_EFFECT_STATES.has(override[key]), method + ' 例外 effectState 非法');
      if (key === 'idempotent' || key === 'replayable') assert.equal(typeof override[key], 'boolean', method + ' ' + key);
      if (key === 'pre') for (const code of override[key]) assert.ok(VALID_PRE.has(code), method + ' 例外前置码未登记：' + code);
      if (key === 'post') for (const code of override[key]) assert.ok(VALID_POST.has(code), method + ' 例外后置码未登记：' + code);
    }
  }
});

// ---------------------------------------------------------------------------
// 幂等 / 可重放
// ---------------------------------------------------------------------------

test('幂等：99 个方法逻辑幂等；只读方法必须幂等；典型交互不幂等', () => {
  assert.equal(IDEMPOTENT_METHODS.length, 99);
  assert.equal(Object.values(METHOD_IDEMPOTENT).filter(Boolean).length, 99);
  for (const row of METHOD_CATALOG) {
    if (READ_EFFECTS.has(row.effect)) assert.equal(METHOD_IDEMPOTENT[row.method], true, row.method + ' 只读方法必须幂等');
  }
  for (const method of ['click', 'fill', 'press', 'select', 'drag', 'upload', 'download', 'navigate', 'reload', 'evaluate', 'plan', 'session.start', 'tab.new', 'tab.close', 'window.close', 'video.start', 'record.start', 'network.replay', 'dialog.accept', 'debug.rule_add', 'pair.create', 'pair.redeem', 'transfer.begin']) {
    assert.equal(METHOD_IDEMPOTENT[method], false, method + ' 不应逻辑幂等');
  }
  for (const method of ['observe', 'read', 'screenshot', 'status', 'tab.list', 'window.list', 'video.verify', 'session.pause', 'session.resume', 'session.stop', 'tab.select', 'focus', 'blur', 'scroll-to', 'dialog.arm', 'network.start', 'debug.start', 'record.stop', 'settings.set', 'pair.revoke']) {
    assert.equal(METHOD_IDEMPOTENT[method], true, method + ' 应逻辑幂等');
  }
});

test('幂等但不自动重放：24 个变异方法逻辑幂等，但结果仍需账本收敛', () => {
  assert.equal(IDEMPOTENT_MUTATING_METHODS.length, 24);
  assert.deepEqual([...IDEMPOTENT_MUTATING_METHODS].sort(), [
    'blur', 'debug.pin', 'debug.start', 'debug.stop', 'debugger.detach', 'debugger.simulate-detach',
    'dialog.arm', 'dialog.disarm', 'emulate', 'focus', 'hover', 'network.start', 'network.stop',
    'record.stop', 'scroll-to', 'session.pause', 'session.stop', 'tab.move', 'tab.select',
    'trace.start', 'trace.stop', 'video.stop', 'window.focus', 'window.resize',
  ].sort());
  for (const method of IDEMPOTENT_MUTATING_METHODS) {
    const row = METHOD_CATALOG.find((item) => item.method === method);
    assert.ok(row && row.unknown, method + ' 应属于结果可能 UNKNOWN 的方法');
    assert.equal(METHOD_REPLAYABLE[method], false, method + ' 逻辑幂等 ≠ 可自动重放');
  }
});

test('可重放：90 个方法可证明结果，且恰好等于“非 unknown”集合', () => {
  assert.equal(REPLAYABLE_METHODS.length, 90);
  assert.equal(Object.values(METHOD_REPLAYABLE).filter(Boolean).length, 90);
  const expected = METHOD_CATALOG.filter((row) => !row.unknown).map((row) => row.method);
  assert.deepEqual([...REPLAYABLE_METHODS].sort(), expected.sort());
  for (const row of METHOD_CATALOG) {
    if (row.unknown) assert.equal(METHOD_REPLAYABLE[row.method], false, row.method + ' 结果不可证明不能标记可重放');
    else assert.equal(METHOD_REPLAYABLE[row.method], true, row.method + ' 结果可证明应允许重放');
  }
});

test('可重放但不幂等：15 个控制面方法的结果由错误码直接证明，无需账本收敛', () => {
  // replayable 的语义是“结果可证明 ⇒ 不需要账本 resolve”，不是“重复执行无副作用”。
  // 这些方法每次调用都是独立控制操作（生成配对/开始传输/打开 UI……），但错误码是确定的，
  // 所以自动重发不会像点击/提交那样产生第二次业务副作用。
  const replayableNotIdempotent = METHOD_NAMES.filter((method) => METHOD_REPLAYABLE[method] && !METHOD_IDEMPOTENT[method]);
  assert.deepEqual([...replayableNotIdempotent].sort(), [
    'cooperate.handback', 'cooperate.hold', 'cooperate.wait', 'daemon.stop', 'diagnostics.ui',
    'pair.create', 'pair.redeem', 'session.claim_control', 'session.handoff',
    'session.request_claim', 'session.request_prepare', 'transfer.begin', 'transfer.chunk',
    'transfer.finish', 'ui.open',
  ].sort());
  for (const method of replayableNotIdempotent) {
    const row = METHOD_CATALOG.find((item) => item.method === method);
    assert.equal(row.unknown, false, method + ' 不应是结果不可证明的方法');
    assert.equal(methodStateOf(method).unknown, false, method);
  }
});

test('与意图账本交叉：canonical 的非幂等动作全部不可自动重放', () => {
  assert.ok(NON_IDEMPOTENT_METHODS.size > 40, '账本非幂等表过小');
  let checked = 0;
  for (const method of METHOD_NAMES) {
    if (!isNonIdempotentAction(method)) continue;
    checked += 1;
    assert.equal(METHOD_REPLAYABLE[method], false, method + ' 账本标记非幂等，但目录允许自动重放');
  }
  assert.ok(checked >= 35, 'canonical 里与账本交叉的方法过少：' + checked);
  // 历史别名不在 canonical，但账本仍保留其非幂等语义（不影响目录）。
  for (const legacy of ['type', 'back', 'forward', 'window.new', 'window.ensure', 'debug.replay']) {
    assert.equal(METHOD_NAMES.includes(legacy), false, legacy + ' 不应进入 canonical');
    assert.equal(isNonIdempotentAction(legacy), true, legacy + ' 账本历史别名语义不应被删');
  }
  // “逻辑幂等”与账本的“非幂等动作”不是同一维度：账本关心“UNKNOWN 后能否自动继续”，
  // 因此 session.stop 逻辑幂等但账本仍要求人工 resolve —— 两者允许不同，禁止互相覆盖。
  assert.equal(METHOD_IDEMPOTENT['session.stop'], true);
  assert.equal(isNonIdempotentAction('session.stop'), true);
  assert.equal(METHOD_REPLAYABLE['session.stop'], false);
});

// ---------------------------------------------------------------------------
// 恢复面
// ---------------------------------------------------------------------------

test('恢复集：每个方法非空、= 通用错误码 + 恢复族、码全在 playbook 且已登记', () => {
  for (const row of METHOD_CATALOG) {
    const proof = METHOD_PROOF[row.method];
    const expected = [...new Set([...RECOVERY_BASE_CODES, ...RECOVERY_PROFILES[proof.profile]])];
    assert.deepEqual([...METHOD_RECOVERY[row.method]], expected, row.method + ' 恢复集与族不一致');
    for (const code of METHOD_RECOVERY[row.method]) {
      assert.ok(RECOVERY_PLAYBOOK[code], row.method + ' 恢复码未登记 playbook：' + code);
    }
  }
  // 覆盖统计合理：单方法 7~34 个适用码
  const lengths = METHOD_NAMES.map((method) => METHOD_RECOVERY[method].length);
  assert.equal(Math.min(...lengths), 7);
  assert.equal(Math.max(...lengths), 35);
});

test('效果分层维度：每个 effect_state 至少有一个方法，且只读方法只允许 none/capture', () => {
  for (const state of Object.keys(PROOF_EFFECT_STATES)) {
    const methods = METHOD_NAMES.filter((method) => METHOD_EFFECT_STATE[method] === state);
    assert.ok(methods.length >= 1, state + ' 没有方法使用，死分类');
  }
  for (const row of METHOD_CATALOG) {
    if (!READ_EFFECTS.has(row.effect)) continue;
    const state = METHOD_EFFECT_STATE[row.method];
    assert.ok(state === 'none' || state === 'capture', row.method + ' 只读方法 effect_state 不合理：' + state);
  }
});

// ---------------------------------------------------------------------------
// 典型方法的语义断言（防止规则漂移）
// ---------------------------------------------------------------------------

test('典型方法六面快照：会话/标签/交互/只读/制品/计划', () => {
  const expectations = [
    ['session.start', { rule: 'session-start', effectState: 'session', idempotent: false, replayable: false, pre: ['daemon.local', 'browser.ready'], post: ['session.created', 'tab.created'] }],
    ['session.stop', { rule: 'session-stop', effectState: 'session', idempotent: true, replayable: false, pre: ['daemon.local', 'session.active'], post: ['session.removed', 'ledger.committed'] }],
    ['session.pause', { rule: 'session-pause', effectState: 'session', idempotent: true, replayable: false }],
    ['tab.new', { rule: 'tab-mutate', effectState: 'tab', idempotent: false, replayable: false, pre: ['instance.connected', 'browser.ready', 'tab.controlled'], post: ['tab.created', 'session.updated'] }],
    ['tab.list', { rule: 'tab-read', effectState: 'none', idempotent: true, replayable: true }],
    ['observe', { rule: 'read-observe', effectState: 'none', idempotent: true, replayable: true, pre: ['session.active', 'tab.bound'], post: ['read.available'] }],
    ['click', { rule: 'interaction', effectState: 'page', idempotent: false, replayable: false, pre: ['session.active', 'tab.bound', 'target.resolved', 'observation.fresh'], post: ['page.mutated'] }],
    ['navigate', { rule: 'navigation', effectState: 'navigation', idempotent: false, replayable: false, post: ['navigation.committed'] }],
    ['hover', { rule: 'hover', effectState: 'page', idempotent: true, replayable: false }],
    ['focus', { rule: 'interaction-set', effectState: 'focus', idempotent: true, replayable: false, post: ['focus.updated'] }],
    ['pdf', { rule: 'pdf', effectState: 'capture', idempotent: true, replayable: true, post: ['artifact.created'] }],
    ['plan', { rule: 'plan', effectState: 'plan', idempotent: false, replayable: false, pre: ['session.active', 'session.unpaused'], post: ['plan.updated'] }],
    ['dialog.accept', { rule: 'dialog-handle', effectState: 'dialog', idempotent: false, replayable: false, pre: ['session.active', 'tab.bound', 'dialog.pending'], post: ['dialog.resolved'] }],
    ['video.start', { rule: 'video-start', effectState: 'video', idempotent: false, replayable: false, post: ['recording.active'] }],
    ['video.verify', { rule: 'video-read', effectState: 'none', idempotent: true, replayable: true, pre: ['daemon.local', 'artifact.present'] }],
    ['network.start', { rule: 'network-control', effectState: 'network', idempotent: true, replayable: false, post: ['network.capturing'] }],
    ['record.stop', { rule: 'record-stop', effectState: 'recording', idempotent: true, replayable: false, post: ['recording.inactive'] }],
    ['transfer.read', { rule: 'transfer-read', effectState: 'none', idempotent: true, replayable: true, pre: ['transport.local', 'transfer.open'] }],
    ['pair.create', { rule: 'pair-create', effectState: 'pairing', idempotent: false, replayable: true }],
    ['settings.set', { rule: 'settings-set', effectState: 'policy', idempotent: true, replayable: true, post: ['policy.updated'] }],
    ['ui.open', { rule: 'ui-open', effectState: 'ui', idempotent: false, replayable: true }],
  ];
  for (const [method, expected] of expectations) {
    const proof = METHOD_PROOF[method];
    assert.ok(proof, method);
    for (const [key, value] of Object.entries(expected)) {
      if (key === 'pre' || key === 'post') assert.deepEqual([...proof[key]], value, method + '.' + key);
      else assert.equal(proof[key], value, method + '.' + key);
    }
  }
});

test('单方法例外确实覆盖了族规则结果（抽样对比）', () => {
  // screenshot.manual.save 属于 screenshot-manual 族（post=capture.available），例外改成 artifact.created
  assert.equal(METHOD_PROOF['screenshot.manual.save'].rule, 'screenshot-manual');
  assert.deepEqual([...METHOD_PROOF['screenshot.manual.save'].post], ['artifact.created']);
  // longshot.recover 属于 read-screenshot 族，例外把产物语义改成 artifact.updated
  assert.equal(METHOD_PROOF['longshot.recover'].rule, 'read-screenshot');
  assert.deepEqual([...METHOD_PROOF['longshot.recover'].post], ['artifact.updated']);
  assert.equal(METHOD_PROOF['longshot.recover'].effectState, 'capture');
  // record.start 非幂等、record.stop 幂等
  assert.equal(METHOD_PROOF['record.start'].idempotent, false);
  assert.equal(METHOD_PROOF['record.stop'].idempotent, true);
  // debug.start/trace.start 是 set 状态语义：逻辑幂等但不可重放
  assert.equal(METHOD_PROOF['debug.start'].idempotent, true);
  assert.equal(METHOD_PROOF['trace.start'].idempotent, true);
  assert.equal(METHOD_PROOF['debug.start'].replayable, false);
});

// ---------------------------------------------------------------------------
// 派生表
// ---------------------------------------------------------------------------

test('按维度派生的表与 METHOD_PROOF 完全一致', () => {
  const byMethod = Object.entries(METHOD_PROOF);
  const tables = [
    [METHOD_EFFECT_STATE, (item) => item.effectState],
    [METHOD_IDEMPOTENT, (item) => item.idempotent],
    [METHOD_REPLAYABLE, (item) => item.replayable],
    [METHOD_PRECONDITIONS, (item) => item.pre],
    [METHOD_POSTCONDITIONS, (item) => item.post],
    [METHOD_RECOVERY, (item) => item.recovery],
  ];
  for (const [table, pick] of tables) {
    assert.equal(Object.keys(table).length, 165);
    for (const [method, item] of byMethod) {
      assert.deepEqual(table[method], pick(item), method);
    }
  }
  // 每条派生表都冻结
  for (const table of tables) assert.ok(Object.isFrozen(table[0]));
});

test('proofOf：未知方法返回 null；已知方法返回冻结对象', () => {
  for (const method of ['no.such.method', '', null, undefined]) assert.equal(proofOf(method), null);
  const proof = proofOf('click');
  assert.ok(Object.isFrozen(proof));
  assert.ok(Object.isFrozen(proof.pre));
  assert.ok(Object.isFrozen(proof.post));
  assert.ok(Object.isFrozen(proof.recovery));
  assert.ok(Object.isFrozen(METHOD_PROOF));
  assert.ok(Object.isFrozen(METHOD_PROOF.click));
});

// ---------------------------------------------------------------------------
// 校验器负例
// ---------------------------------------------------------------------------

test('validateMethodProofs()：真实目录零错误', () => {
  assert.deepEqual(validateMethodProofs(), []);
});

test('validateMethodProofs：缺行/越界/非法 effect_state/未登记码/不可证明却可重放 都能抓住', () => {
  const baseRows = METHOD_CATALOG.map((row) => ({ method: row.method, owner: row.owner, effect: row.effect, unknown: row.unknown }));
  const baseProof = () => Object.fromEntries(Object.entries(METHOD_PROOF).map(([method, item]) => [method, {
    ...item,
    pre: [...item.pre],
    post: [...item.post],
    recovery: [...item.recovery],
  }]));

  const missingRow = baseProof();
  delete missingRow.click;
  assert.ok(validateMethodProofs(baseRows, missingRow).some((message) => message.includes('缺少可证明性行')), '缺行未被抓住');

  const extraRow = baseProof();
  extraRow['ghost.method'] = { ...extraRow.click, method: 'ghost.method' };
  assert.ok(validateMethodProofs(baseRows, extraRow).some((message) => message.includes('目录外方法')), '越界行未被抓住');

  const badState = baseProof();
  badState.click.effectState = 'page.mutated';
  assert.ok(validateMethodProofs(baseRows, badState).some((message) => message.includes('effect_state 非法')), '非法 effect_state 未被抓住');

  const badPre = baseProof();
  badPre.click.pre = ['target.teleported'];
  assert.ok(validateMethodProofs(baseRows, badPre).some((message) => message.includes('前置条件未登记')), '未登记前置码未被抓住');

  const badPost = baseProof();
  badPost.click.post = ['page.exploded'];
  assert.ok(validateMethodProofs(baseRows, badPost).some((message) => message.includes('后置条件未登记')), '未登记后置码未被抓住');

  const replayOnUnknown = baseProof();
  replayOnUnknown.click.replayable = true;
  assert.ok(validateMethodProofs(baseRows, replayOnUnknown).some((message) => message.includes('不能标记可重放')), '不可证明却可重放未被抓住');

  const badProfile = baseProof();
  badProfile.click.profile = 'ghost-profile';
  assert.ok(validateMethodProofs(baseRows, badProfile).some((message) => message.includes('恢复族未登记')), '非法恢复族未被抓住');

  const badRecovery = baseProof();
  badRecovery.click.recovery = ['E_NOT_A_REAL_CODE'];
  assert.ok(validateMethodProofs(baseRows, badRecovery).some((message) => message.includes('playbook 登记')), '未登记恢复码未被抓住');

  const unclassified = baseProof();
  unclassified.click.rule = 'unclassified';
  assert.ok(validateMethodProofs(baseRows, unclassified).some((message) => message.includes('未命中任何可证明性族规则')), '未分类方法未被抓住');

  const badPreEmpty = baseProof();
  badPreEmpty.click.pre = [];
  assert.ok(validateMethodProofs(baseRows, badPreEmpty).some((message) => message.includes('缺少前置条件')), '空前置未被抓住');

  const badPostEmpty = baseProof();
  badPostEmpty.click.post = [];
  assert.ok(validateMethodProofs(baseRows, badPostEmpty).some((message) => message.includes('缺少后置条件')), '空后置未被抓住');

  const badRecoveryEmpty = baseProof();
  badRecoveryEmpty.click.recovery = [];
  assert.ok(validateMethodProofs(baseRows, badRecoveryEmpty).some((message) => message.includes('缺少恢复错误码')), '空恢复集未被抓住');
});

test('validateMethodProofs：规则遮蔽（死规则）能被抓住', () => {
  // 只保留“更晚规则才会命中”的方法，让前面的规则全部失去选中机会。
  const rows = METHOD_CATALOG
    .filter((row) => ['daemon.stop', 'diagnostics.ui'].includes(row.method))
    .map((row) => ({ method: row.method, owner: row.owner, effect: row.effect, unknown: row.unknown }));
  const proof = Object.fromEntries(rows.map((row) => [row.method, { ...METHOD_PROOF[row.method] }]));
  const errors = validateMethodProofs(rows, proof);
  assert.ok(errors.some((message) => message.includes('没有命中任何方法') || message.includes('被更早规则遮蔽')), '死规则未被抓住：' + errors.slice(0, 3).join(' | '));
});

test('validateMethodProofs：注入覆盖名单指向目录外方法会被抓住', () => {
  // PROOF_OVERRIDES 是目录数据，校验函数直接读它；这里通过 rows 缩小到不含该方法来证明越界可被捕获。
  const rows = METHOD_CATALOG.filter((row) => row.method !== 'screenshot.manual.save')
    .map((row) => ({ method: row.method, owner: row.owner, effect: row.effect, unknown: row.unknown }));
  const proof = Object.fromEntries(Object.entries(METHOD_PROOF)
    .filter(([method]) => method !== 'screenshot.manual.save'));
  const errors = validateMethodProofs(rows, proof);
  assert.ok(errors.some((message) => message.includes('PROOF_OVERRIDES 指向目录外方法')), '越界例外未被抓住');
});

test('规则/例外不改变方法目录：ROWS 与 METHOD_NAMES 仍然一一对应', () => {
  assert.equal(METHOD_NAMES.length, 165);
  assert.equal(new Set(METHOD_NAMES).size, 165);
  assert.deepEqual(METHOD_NAMES, METHOD_CATALOG.map((row) => row.method));
  // 规则全部是 {pattern,...} 数据，没有函数字段（防止有人把“判定逻辑”写成第二份代码）。
  assert.equal(PROOF_RULES.every((rule) => typeof rule === 'object'
    && typeof rule.pattern === 'string'
    && !Object.values(rule).some((value) => typeof value === 'function')), true);
});
