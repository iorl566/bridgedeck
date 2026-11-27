// tests/unit/protocol-degradation.test.mjs —— 兼容性降级与迁移建议的单测。
//
// 目标：证明“降级”不是文案，而是可执行、可复核的调用计划。
//   1) 15 个特性门的降级声明完整（kind/参数/目标方法/说明）；
//   2) 每个可降级触发的 degraded 调用都能在 1.8 上通过同一个 featureShortfall 复核；
//   3) 没有等价手段的特性（video/har）必须诚实返回不可降级，绝不编造替代；
//   4) 批量计划、迁移建议、兼容报告都把“可用/降级/必须升级”分开；
//   5) 降级不改原参数对象、不引入新的 gated 特性、不改变既有错误码。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_MIGRATION,
  FEATURE_NAMES,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  PROTOCOL_MIGRATION_STEPS,
} from '../../lib/method-catalog.mjs';
import {
  PROTOCOL_UNSUPPORTED,
  compatibilityReport,
  degradationForFeature,
  degradationOfCall,
  degradationPlan,
  explainNegotiation,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  migrationAdvice,
  negotiate,
  protocolGate,
} from '../../lib/protocol-features.mjs';

const OLD = Object.freeze({ protocol: PROTOCOL_BASELINE });
const CURRENT = Object.freeze({ protocol: PROTOCOL_CURRENT });
const UNKNOWN = Object.freeze({});
const AHEAD = Object.freeze({ protocol: '1.10' });

/** 每个特性门的真实触发调用。 */
const TRIGGERS = Object.freeze({
  unverified: ['evaluate', { expression: '1 + 1', unverified: true }],
  expect: ['click', { expect: [{ ref: '@e1', field: 'text', equals: '提交' }] }],
  read: ['read', { ref: '@e1' }],
  'observe-delta': ['observe', { delta: true }],
  plan: ['plan', { steps: [] }],
  video: ['video.start', {}],
  'capture.stream': ['screenshot', { stream: true }],
  'debug.journal': ['debug.history', {}],
  har: ['network.replay', {}],
  // ---- 兼容基线对齐的 6 个门 ----
  borrow_confirmation_timeout: ['tab.borrow', { tabId: 123, confirmationTimeoutMs: 30000 }],
  interaction_policy: ['request-help', { reason: 'needs human confirm' }],
  incognito_sessions: ['session.start', { incognito: true }],
  dialog_control: ['dialog.accept', { tabId: 123 }],
  click_move_click: ['drag', { from: '@e1', to: '@e2', mode: 'click-move-click' }],
  target_control: ['cooperate.sync', { policy: 'target' }],
});

const DEGRADABLE = Object.freeze(FEATURE_NAMES.filter((feature) => FEATURE_FALLBACKS[feature].kind !== 'none'));

// ---------------------------------------------------------------------------
// 声明完整性
// ---------------------------------------------------------------------------

test('FEATURE_FALLBACKS：15 个特性全部有降级声明，kind 合法、说明非空', () => {
  assert.equal(Object.keys(FEATURE_FALLBACKS).length, 15);
  assert.deepEqual(Object.keys(FEATURE_FALLBACKS).sort(), [...FEATURE_NAMES].sort());
  const kinds = new Set(['omit-param', 'omit-params', 'param+verify', 'method', 'decompose', 'none']);
  for (const feature of FEATURE_NAMES) {
    const fallback = FEATURE_FALLBACKS[feature];
    assert.ok(kinds.has(fallback.kind), feature + ' kind 非法：' + fallback.kind);
    assert.equal(typeof fallback.note, 'string');
    assert.ok(fallback.note.length >= 6, feature + ' 降级说明过短');
    if (fallback.kind === 'omit-param') assert.equal(typeof fallback.param, 'string', feature);
    if (fallback.kind === 'omit-params') assert.ok(Array.isArray(fallback.params) && fallback.params.length > 0, feature);
    if (fallback.kind === 'method') assert.ok(METHOD_NAMES.includes(fallback.method), feature + ' 降级目标不在目录：' + fallback.method);
    if (fallback.kind === 'param+verify') assert.ok(METHOD_NAMES.includes(fallback.method), feature + ' 校验方法不在目录');
    if (fallback.kind === 'none') assert.equal(fallback.method, null, feature + ' 不可降级不应给目标方法');
  }
  // 可降级 11 个 / 不可降级 4 个（video、har 与 兼容对齐的 interaction_policy、dialog_control）
  assert.equal(DEGRADABLE.length, 11);
  assert.deepEqual([...FEATURE_NAMES].filter((feature) => FEATURE_FALLBACKS[feature].kind === 'none').sort(), ['dialog_control', 'har', 'interaction_policy', 'video']);
});

test('FEATURE_MIGRATION / PROTOCOL_MIGRATION_STEPS：每个特性都有迁移建议，整体步骤非空', () => {
  assert.equal(Object.keys(FEATURE_MIGRATION).length, 15);
  assert.deepEqual(Object.keys(FEATURE_MIGRATION).sort(), [...FEATURE_NAMES].sort());
  for (const feature of FEATURE_NAMES) {
    assert.equal(typeof FEATURE_MIGRATION[feature], 'string');
    assert.ok(FEATURE_MIGRATION[feature].length >= 8, feature + ' 迁移建议过短');
  }
  assert.ok(Array.isArray(PROTOCOL_MIGRATION_STEPS));
  assert.ok(PROTOCOL_MIGRATION_STEPS.length >= 4, '整体迁移步骤过少');
  assert.ok(PROTOCOL_MIGRATION_STEPS.some((step) => step.includes(PROTOCOL_CURRENT)), '迁移步骤必须给出目标协议');
  assert.ok(PROTOCOL_MIGRATION_STEPS.some((step) => /重新加载/.test(step)), '迁移步骤必须提醒重载扩展');
});

test('degradationForFeature：floor/label/fallback/degradable 与目录逐项一致', () => {
  for (const feature of FEATURE_NAMES) {
    const info = degradationForFeature(feature);
    assert.equal(info.feature, feature);
    assert.equal(info.floor, FEATURE_FLOORS[feature]);
    assert.equal(info.label, FEATURE_META[feature].label);
    assert.deepEqual(info.fallback, FEATURE_FALLBACKS[feature]);
    assert.equal(info.kind, FEATURE_FALLBACKS[feature].kind);
    assert.equal(info.degradable, FEATURE_FALLBACKS[feature].kind !== 'none');
    assert.equal(info.migration, FEATURE_MIGRATION[feature]);
    assert.ok(Object.isFrozen(info));
  }
  // 未知特性安全退化
  const unknown = degradationForFeature('no.such.feature');
  assert.equal(unknown.floor, null);
  assert.equal(unknown.fallback, null);
  assert.equal(unknown.kind, 'none');
  assert.equal(unknown.degradable, false);
});

test('featureMatrix 的 fallback 字段与 FEATURE_FALLBACKS 同源', () => {
  const matrix = featureMatrix(OLD);
  for (const feature of FEATURE_NAMES) {
    assert.deepEqual(matrix[feature].fallback, FEATURE_FALLBACKS[feature], feature);
  }
});

// ---------------------------------------------------------------------------
// 单调用降级：可执行性复核
// ---------------------------------------------------------------------------

test('degradationOfCall：7 个可降级特性都能在 1.8 上得到放行的降级调用', () => {
  for (const feature of DEGRADABLE) {
    const [method, params] = TRIGGERS[feature];
    const plan = degradationOfCall(OLD, method, params);
    assert.equal(plan.ok, false, feature + ' 原始调用应被拒绝');
    assert.deepEqual(plan.missing.map((item) => item.feature), [feature], feature);
    if (FEATURE_FALLBACKS[feature].kind === 'decompose') {
      assert.equal(plan.degradable, false, feature + ' decompose 需要调用方拆步骤');
      assert.equal(plan.decomposable, true, feature + ' 应标记可分解执行');
      assert.match(plan.note, /逐条|拆/);
      continue;
    }
    assert.equal(plan.degradable, true, feature + ' 应可降级');
    assert.ok(plan.degraded, feature + ' 缺少降级调用');
    assert.ok(METHOD_NAMES.includes(plan.degraded.method), feature + ' 降级方法必须存在');
    // 用同一个 featureShortfall 复核：降级调用在 1.8 上确实放行。
    const candidateFeatures = featuresForCall(plan.degraded.method, plan.degraded.params);
    assert.deepEqual(featureShortfall(OLD, candidateFeatures), [], feature + ' 降级调用仍被拒绝');
    assert.equal(plan.degradedOk, true, feature);
    assert.ok(plan.degraded.droppedParams.length >= 1 || plan.degraded.method !== method, feature + ' 降级必须去掉参数或换方法');
  }
});

test('degradationOfCall：parameter 级门只去掉触发参数，其余参数原样保留', () => {
  const plan = degradationOfCall(OLD, 'screenshot', { stream: true, ref: '@e1', format: 'png' });
  assert.equal(plan.degradable, true);
  assert.equal(plan.degraded.method, 'screenshot');
  assert.deepEqual([...plan.degraded.droppedParams], ['stream']);
  assert.deepEqual({ ...plan.degraded.params }, { ref: '@e1', format: 'png' });
  assert.equal(plan.degraded.kind, 'omit-parameter');
  // 多个参数级门一次性清掉
  const multi = degradationOfCall(OLD, 'screenshot', { stream: true, segmented: true, staleAttempts: 2, ref: '@e1' });
  assert.equal(multi.degradable, true);
  assert.deepEqual([...multi.degraded.droppedParams].sort(), ['segmented', 'staleAttempts', 'stream']);
  assert.deepEqual({ ...multi.degraded.params }, { ref: '@e1' });
});

test('degradationOfCall：unverified 去掉参数走常规校验；expect 去掉后给校验方法', () => {
  const unverified = degradationOfCall(OLD, 'evaluate', { expression: '1 + 1', unverified: true });
  assert.equal(unverified.degraded.method, 'evaluate');
  assert.deepEqual([...unverified.degraded.droppedParams], ['unverified']);
  assert.deepEqual({ ...unverified.degraded.params }, { expression: '1 + 1' });
  assert.equal(unverified.degraded.verification, null);

  const expect = degradationOfCall(OLD, 'click', { ref: '@e1', expect: [{ field: 'text', equals: 'x' }] });
  assert.equal(expect.degradable, true);
  assert.equal(expect.degraded.method, 'click');
  assert.deepEqual([...expect.degraded.droppedParams], ['expect']);
  assert.ok(expect.degraded.verification, 'expect 降级必须给动作后的校验方法');
  assert.equal(expect.degraded.verification.method, 'observe');
  assert.deepEqual({ ...expect.degraded.verification.params }, {});
});

test('degradationOfCall：read/debug.journal 换方法后参数保留且在旧协议放行', () => {
  const read = degradationOfCall(OLD, 'read', { ref: '@e1', format: 'text' });
  assert.equal(read.degraded.method, 'observe');
  assert.equal(read.degraded.kind, 'method');
  assert.deepEqual({ ...read.degraded.params }, { ref: '@e1', format: 'text' });

  const journal = degradationOfCall(OLD, 'debug.history', { limit: 10 });
  assert.equal(journal.degraded.method, 'debug.request');
  assert.equal(journal.degraded.kind, 'method');
  assert.deepEqual({ ...journal.degraded.params }, { limit: 10 });
  assert.equal(featureShortfall(OLD, featuresForCall(journal.degraded.method, journal.degraded.params)).length, 0);
});

test('degradationOfCall：video/har 没有等价降级，必须诚实不可降级', () => {
  for (const feature of ['video', 'har']) {
    const [method, params] = TRIGGERS[feature];
    const plan = degradationOfCall(OLD, method, params);
    assert.equal(plan.ok, false, feature);
    assert.equal(plan.degradable, false, feature + ' 不应编造降级');
    assert.equal(plan.degraded, null, feature);
    assert.equal(plan.degradedOk, false, feature);
    assert.deepEqual([...plan.unresolved], [feature], feature + ' 未解决特性必须列出');
    assert.match(plan.note, /只能升级/);
    const decision = protocolGate(OLD, method, params);
    assert.equal(decision.data.degradable, false, feature);
    assert.equal(decision.data.degradation, null, feature);
    assert.equal(explainNegotiation(decision).remediation.some((step) => step.startsWith('降级：')), false, feature);
  }
});

test('degradationOfCall：plan 标记 decomposable（调用方拆步骤），不伪造替代方法', () => {
  const plan = degradationOfCall(OLD, 'plan', { steps: [{ method: 'click' }] });
  assert.equal(plan.degradable, false);
  assert.equal(plan.decomposable, true);
  assert.equal(plan.degraded, null);
  assert.deepEqual([...plan.unresolved], []);
  assert.match(plan.note, /计划执行器|逐条/);
});

test('degradationOfCall：当前协议无需降级；未知协议与闸门口径保持一致', () => {
  const current = degradationOfCall(CURRENT, 'screenshot', { stream: true });
  assert.equal(current.ok, true);
  assert.equal(current.degradable, false);
  assert.equal(current.degraded, null);
  assert.deepEqual(current.missing, []);

  const ahead = degradationOfCall(AHEAD, 'screenshot', { stream: true });
  assert.equal(ahead.ok, true, '1.10 满足 1.9 floor');

  // 未知协议：闸门对“无特性门的方法”本来就放行，因此降级候选也按同一口径放行；
  // 但“不可降级”的方法仍然不可降级（不会把 video 说成能跑）。
  for (const peer of [UNKNOWN, { protocol: '' }, { protocol: 'x' }]) {
    const plan = degradationOfCall(peer, 'screenshot', { stream: true });
    assert.equal(plan.ok, false, String(peer.protocol));
    assert.equal(plan.degraded.method, 'screenshot');
    assert.equal(plan.degradedOk, true, '与 protocolGate 对无特性调用的放行口径一致');
    assert.equal(protocolGate(peer, plan.degraded.method, plan.degraded.params).ok, true);
    const video = degradationOfCall(peer, 'video.start', {});
    assert.equal(video.degradable, false, String(peer.protocol) + ' 未知协议不能声称 video 可降级');
    assert.equal(video.degraded, null);
  }
});

test('degradationOfCall：多缺失特性组合要么整体降级，要么整体不可降级', () => {
  // unverified + expect 同时出现：两个参数都可去掉 → 整体可降级。
  const both = degradationOfCall(OLD, 'evaluate', { expression: '1', unverified: true, expect: [{ field: 'text' }] });
  assert.equal(both.missing.length, 2);
  assert.equal(both.degradable, true);
  assert.deepEqual({ ...both.degraded.params }, { expression: '1' });
  assert.deepEqual(featureShortfall(OLD, featuresForCall(both.degraded.method, both.degraded.params)), []);

  // 一个可降级 + 一个不可降级：不能只降一半（会给人“成功”的错觉）。
  const mixed = degradationOfCall(OLD, 'screenshot', { stream: true, unverified: true });
  assert.equal(mixed.degradable, true, '两个都可降级');
  // 人为不可降级组合：network.replay（har）+ expect
  const impossible = degradationOfCall(OLD, 'network.replay', { expect: [{}] });
  assert.equal(impossible.missing.length, 2);
  assert.equal(impossible.degradable, false);
  assert.deepEqual([...impossible.unresolved], ['har']);
});

test('degradationOfCall：不修改调用方传入的参数对象', () => {
  const params = { stream: true, ref: '@e1' };
  const snapshot = JSON.stringify(params);
  degradationOfCall(OLD, 'screenshot', params);
  assert.equal(JSON.stringify(params), snapshot, '降级计算不得改写入参');
  const multi = { stream: true, segmented: true, staleAttempts: 1, ref: '@e1' };
  const multiSnapshot = JSON.stringify(multi);
  degradationOfCall(OLD, 'screenshot', multi);
  assert.equal(JSON.stringify(multi), multiSnapshot);
});

test('degradationOfCall：未知方法安全返回（无特性 → 无需降级）', () => {
  const plan = degradationOfCall(OLD, 'no.such.method', { x: 1 });
  assert.equal(plan.ok, true);
  assert.equal(plan.degradable, false);
  assert.deepEqual(plan.features, []);
});

// ---------------------------------------------------------------------------
// 批量降级计划
// ---------------------------------------------------------------------------

test('degradationPlan：批量调用给出 blocked/degradable/allowed 三类计数', () => {
  const plan = degradationPlan(OLD, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'read', params: { ref: '@e1' } },
      { method: 'click', params: { ref: '@e1' } },
      { method: 'video.start', params: {} },
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.peer, '1.8');
  assert.equal(plan.calls.length, 4);
  assert.equal(plan.counts.total, 4);
  assert.equal(plan.counts.allowed, 1, 'click 不受特性门影响');
  assert.equal(plan.counts.degradable, 2, 'screenshot/read 可降级');
  assert.equal(plan.counts.blocked, 1, 'video 不可降级');
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].call.method, 'video.start');
  assert.equal(plan.degradable.length, 2);
  assert.deepEqual(plan.blocked[0].plan.unresolved, ['video']);
});

test('degradationPlan：单调用形态与空请求形态都稳定', () => {
  const single = degradationPlan(OLD, { method: 'screenshot', params: { stream: true } });
  assert.equal(single.calls.length, 1);
  assert.equal(single.ok, false, '原调用不能直接执行');
  assert.equal(single.satisfiable, true, '但可以降级执行');
  const empty = degradationPlan(OLD, {});
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.ok, true);
  assert.equal(empty.satisfiable, true);
  assert.equal(empty.counts.total, 0);
});

test('degradationPlan：1.9 对端全部 allowed，没有降级项', () => {
  const plan = degradationPlan(CURRENT, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'read', params: {} },
      { method: 'video.start', params: {} },
    ],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.counts.allowed, 3);
  assert.equal(plan.counts.degradable, 0);
  assert.equal(plan.counts.blocked, 0);
  assert.deepEqual(plan.degradable, []);
  assert.deepEqual(plan.blocked, []);
});

// ---------------------------------------------------------------------------
// negotiate / compatibilityReport 的降级面
// ---------------------------------------------------------------------------

test('negotiate degraded：degradations 数组带原方法 + 降级调用 + 复核说明', () => {
  const result = negotiate(OLD, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'read', params: {} },
    ],
  });
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.degradations.length, 2);
  const methods = result.degradations.map((item) => item.method).sort();
  assert.deepEqual(methods, ['read', 'screenshot']);
  for (const item of result.degradations) {
    assert.ok(item.degraded);
    assert.ok(METHOD_NAMES.includes(item.degraded.method));
    assert.match(item.note, /复核/);
  }
  const screenshot = result.degradations.find((item) => item.method === 'screenshot');
  assert.equal(screenshot.degraded.method, 'screenshot');
  assert.deepEqual([...screenshot.degraded.droppedParams], ['stream']);
});

test('negotiate incompatible：不可降级调用不出现在 degradations 里', () => {
  const result = negotiate(OLD, {
    calls: [
      { method: 'video.start', params: {} },
      { method: 'network.replay', params: {} },
    ],
  });
  assert.equal(result.verdict, 'incompatible');
  assert.deepEqual(result.degradations, []);
  assert.deepEqual([...result.missing].sort(), ['har', 'video']);
});

test('compatibilityReport：可降级特性列表与 FEATURE_FALLBACKS 同源', () => {
  const report = compatibilityReport(OLD);
  assert.equal(report.counts.degradable, 11);
  for (const feature of report.degradable) {
    assert.notEqual(FEATURE_FALLBACKS[feature].kind, 'none', feature);
  }
  for (const feature of report.denied) {
    if (!report.degradable.includes(feature)) assert.equal(FEATURE_FALLBACKS[feature].kind, 'none', feature);
  }
  assert.equal(report.verdict, 'incompatible');
});

test('降级候选不会再引入新的 gated 特性（逐特性全量）', () => {
  for (const feature of DEGRADABLE) {
    const [method, params] = TRIGGERS[feature];
    const plan = degradationOfCall(OLD, method, params);
    if (!plan.degradable) continue;
    const candidateFeatures = featuresForCall(plan.degraded.method, plan.degraded.params);
    for (const candidate of candidateFeatures) {
      assert.equal(featureShortfall(OLD, [candidate]).length, 0, feature + ' 降级引入了新 gated 特性：' + candidate);
    }
  }
});

test('降级说明是“降低能力”而不是“等价成功”：note 必须描述损失', () => {
  const expectations = {
    unverified: /校验/,
    expect: /observe|核对/,
    read: /observe|提取/,
    'observe-delta': /全量|增量/,
    plan: /步骤|执行器/,
    'capture.stream': /一次性|退回/,
    'debug.journal': /历史|实时|持久/,
    har: /人工|不能/,
    video: /升级|不存在/,
    borrow_confirmation_timeout: /60s|确认/,
    interaction_policy: /升级|等价降级/,
    incognito_sessions: /隐私|普通窗口/,
    dialog_control: /人工|升级/,
    click_move_click: /手势|语义/,
    target_control: /strict|归一化/,
  };
  for (const feature of FEATURE_NAMES) {
    assert.match(FEATURE_FALLBACKS[feature].note, expectations[feature], feature + ' 降级说明没有讲清代价');
  }
});

// ---------------------------------------------------------------------------
// 错误码/闸门语义不回退
// ---------------------------------------------------------------------------

test('降级字段不改变拒绝错误码：data.code 仍是 E_PROTOCOL_UNSUPPORTED', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = TRIGGERS[feature];
    const decision = protocolGate(OLD, method, params);
    assert.equal(decision.code, PROTOCOL_UNSUPPORTED, feature);
    assert.equal(decision.data.code, PROTOCOL_UNSUPPORTED, feature);
    assert.equal(decision.data.feature, feature, feature);
    assert.equal(decision.data.required, '1.9', feature);
    assert.equal(decision.data.actual, '1.8', feature);
  }
});
