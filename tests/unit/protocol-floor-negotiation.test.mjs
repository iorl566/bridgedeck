// tests/unit/protocol-floor-negotiation.test.mjs —— 协议 floor 判定 / 协商失败解释 /
// 兼容矩阵深化的单测。
//
// 覆盖目标（全部纯函数，不连 daemon、不起浏览器）：
//   1) floorDecision：每个 gated 方法/参数触发都能解释“为什么需要这个最低版本”；
//   2) protocolGate：放行与拒绝两侧都只加字段，既有字段/错误码语义逐项不变；
//   3) explainNegotiation / negotiate / compatibilityReport：对 1.8、1.9、未知、
//      更高 minor/major 给出可解释结论；
//   4) lib/protocol.mjs 的版本分带/偏斜/协商判定；
//   5) 165 个方法 × 多个对端版本：gate 放行集合必须与“features 全部满足”的定义一致，
//      且没有任何既有错误码被改名/新增。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_NAMES,
  METHOD_CATALOG,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  COMPAT_PROBE_VERSIONS,
  FEATURE_MIN_PROTOCOL,
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  assertProtocolCompatible,
  compatibilityMatrix,
  compatibilityReport,
  degradationForFeature,
  explainFeatureGap,
  explainNegotiation,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  floorDecision,
  isProtocolUnsupportedCode,
  methodFeature,
  migrationAdvice,
  negotiate,
  protocolGate,
  requiredFloorFor,
} from '../../lib/protocol-features.mjs';
import {
  PROTOCOL_BANDS,
  PROTOCOL_RANGE,
  compareProtocol,
  isProtocolKnown,
  isSameProtocolMajor,
  maxProtocol,
  minProtocol,
  negotiateProtocolVersion,
  parseProtocol,
  protocolAtLeast,
  protocolBand,
  protocolBandSnapshot,
  protocolSkew,
} from '../../lib/protocol.mjs';

const CURRENT = Object.freeze({ protocol: PROTOCOL_CURRENT });
const OLD = Object.freeze({ protocol: PROTOCOL_BASELINE });
const UNKNOWN_PEER = Object.freeze({});

/** 每个特性门的真实触发调用（与兼容矩阵测试同口径，测试内自备数据）。 */
const FEATURE_TRIGGERS = Object.freeze({
  unverified: ['evaluate', { expression: '1 + 1', unverified: true }],
  expect: ['click', { expect: [{ ref: '@e1', field: 'text', equals: '提交' }] }],
  read: ['read', {}],
  'observe-delta': ['observe', { delta: true }],
  plan: ['plan', { steps: [{ method: 'click', params: { ref: '@e1' } }] }],
  video: ['video.start', {}],
  'capture.stream': ['screenshot', { stream: true }],
  'debug.journal': ['debug.history', {}],
  har: ['network.replay', {}],
  // ---- BSK 0.5.0 对齐的 6 个门 ----
  borrow_confirmation_timeout: ['tab.borrow', { tabId: 123, confirmationTimeoutMs: 30000 }],
  interaction_policy: ['request-help', { reason: 'needs human' }],
  incognito_sessions: ['session.start', { incognito: true }],
  dialog_control: ['dialog.accept', { tabId: 123 }],
  click_move_click: ['drag', { from: '@e1', to: '@e2', mode: 'click-move-click' }],
  target_control: ['cooperate.sync', { policy: 'target' }],
});

const GATED_METHODS = Object.keys(METHOD_FEATURE);

// ---------------------------------------------------------------------------
// floorDecision：最低版本不是魔法数字，要能解释来源
// ---------------------------------------------------------------------------

test('floorDecision：15 个特性触发都判定出 floor=1.9，并带来源种类', () => {
  assert.equal(FEATURE_NAMES.length, 15);
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = floorDecision(method, params);
    assert.equal(decision.method, method, feature);
    assert.equal(decision.floor, FEATURE_FLOORS[feature], feature + ' floor 与目录不一致');
    assert.deepEqual([...decision.features], [feature], feature + ' 触发的特性应当唯一');
    assert.equal(decision.sources.length, 1, feature + ' 应当只有一个 floor 来源');
    const source = decision.sources[0];
    assert.equal(source.feature, feature);
    assert.equal(source.required, FEATURE_FLOORS[feature]);
    assert.ok(['method', 'param'].includes(source.kind), feature + ' 来源种类非法：' + source.kind);
    if (source.kind === 'param') assert.equal(typeof source.param, 'string', feature + ' 参数级来源必须给 param');
    else assert.equal(source.param, null);
  }
});

test('floorDecision：方法级门来自 METHOD_FEATURE，参数级门来自 FEATURE_PARAM_RULES', () => {
  const methodGates = floorDecision('video.start', {});
  assert.equal(methodGates.gated, true);
  assert.equal(methodGates.sources[0].kind, 'method');
  assert.equal(methodGates.sources[0].param, null);

  const paramGate = floorDecision('screenshot', { stream: true });
  assert.equal(paramGate.gated, false);
  assert.equal(paramGate.sources[0].kind, 'param');
  assert.equal(paramGate.sources[0].param, 'stream');
  assert.equal(paramGate.floor, '1.9');

  const deltaGate = floorDecision('observe', { delta: true });
  assert.equal(deltaGate.sources[0].kind, 'param');
  assert.equal(deltaGate.sources[0].param, 'delta');
});

test('floorDecision：同一调用多个参数级门时 floor 取最高，sources 全保留', () => {
  // screenshot 的 stream/segmented/staleAttempts 都属于 capture.stream；evaluate 可同时
  // 带 unverified 与 expect，两个门都要求 1.9 —— floor 唯一但来源必须都列出来。
  const dual = floorDecision('evaluate', { unverified: true, expect: [{ field: 'text' }] });
  assert.equal(dual.floor, '1.9');
  assert.deepEqual([...dual.features].sort(), ['expect', 'unverified']);
  assert.equal(dual.sources.length, 2);
  assert.deepEqual(dual.sources.map((source) => source.kind), ['param', 'param']);
  assert.deepEqual(dual.sources.map((source) => source.param), ['unverified', 'expect']);
});

test('floorDecision：没有特性门的方法 floor=null、features 为空', () => {
  for (const method of ['click', 'navigate', 'observe', 'tab.list', 'status', 'session.start']) {
    const decision = floorDecision(method, {});
    assert.equal(decision.floor, null, method + ' 不应有 floor');
    assert.deepEqual([...decision.features], [], method + ' 不应触发特性');
    assert.deepEqual([...decision.sources], [], method + ' 不应有 floor 来源');
  }
});

test('floorDecision：未知方法安全退化（floor=null，不抛错）', () => {
  for (const method of ['no.such.method', '', null, undefined, 'click ']) {
    const decision = floorDecision(method, {});
    assert.equal(decision.floor, null);
    assert.deepEqual([...decision.features], []);
    assert.equal(decision.gated, false);
  }
});

test('floorDecision：与 featureShortfall/requiredFloorFor 结果一致（同一组特性）', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = floorDecision(method, params);
    assert.deepEqual(featureShortfall(OLD, decision.features).map((item) => item.feature), decision.features);
    assert.equal(requiredFloorFor(decision.features), decision.floor);
    assert.deepEqual(featureShortfall(CURRENT, decision.features), []);
  }
});

// ---------------------------------------------------------------------------
// compatibilityReport：可用/拒绝/可降级计数
// ---------------------------------------------------------------------------

test('compatibilityReport：1.8 全拒绝但 11 个特性可降级，4 个只能升级', () => {
  const report = compatibilityReport(OLD);
  assert.equal(report.protocol, PROTOCOL_BASELINE);
  assert.equal(report.band, 'baseline');
  assert.equal(report.counts.total, 15);
  assert.equal(report.counts.available, 0);
  assert.equal(report.counts.denied, 15);
  assert.equal(report.degradable.length, 11, '可降级特性数量漂移');
  assert.deepEqual([...report.degradable].sort(), [...FEATURE_NAMES].filter((feature) => {
    const fallback = degradationForFeature(feature).fallback;
    return fallback && fallback.kind !== 'none';
  }).sort());
  // 没有等价手段的特性必须诚实标记不可降级（video/har + BSK 对齐的 interaction_policy/dialog_control）。
  assert.deepEqual([...report.denied].filter((feature) => !report.degradable.includes(feature)).sort(), ['dialog_control', 'har', 'interaction_policy', 'video']);
  assert.equal(report.verdict, 'incompatible');
  assert.equal(report.migration.upgradeRequired, true);
  assert.equal(report.migration.upgradeTo, PROTOCOL_CURRENT);
});

test('compatibilityReport：1.9 全可用、verdict=compatible、skew=none', () => {
  const report = compatibilityReport(CURRENT);
  assert.equal(report.counts.available, 15);
  assert.equal(report.counts.denied, 0);
  assert.equal(report.counts.degradable, 0);
  assert.equal(report.verdict, 'compatible');
  assert.equal(report.skew.severity, 'none');
  assert.equal(report.migration.upgradeRequired, false);
  assert.deepEqual([...report.migration.steps].length > 0, true);
});

test('compatibilityReport：未知/非法协议的 band=unknown，全部拒绝且不可降级', () => {
  for (const peer of [UNKNOWN_PEER, { protocol: '' }, { protocol: 'x' }, { protocol: null }]) {
    const report = compatibilityReport(peer);
    assert.equal(report.band, 'unknown', JSON.stringify(peer));
    assert.equal(report.counts.available, 0);
    assert.equal(report.verdict, 'incompatible');
    assert.equal(report.skew.severity, 'fatal');
  }
  // 1.10 是更高 minor：floor 全部满足（同 major 偏斜兼容）。
  const ahead = compatibilityReport({ protocol: '1.10' });
  assert.equal(ahead.counts.available, 15);
  assert.equal(ahead.band, 'ahead-minor');
  assert.equal(ahead.skew.severity, 'info');
});

test('featureMatrix：每个特性带 fallback/migration/blocking/severity，且可用性与 1.8/1.9 反向', () => {
  const old = featureMatrix(OLD);
  const current = featureMatrix(CURRENT);
  for (const feature of FEATURE_NAMES) {
    const row = old[feature];
    assert.equal(row.required, '1.9', feature);
    assert.equal(row.actual, '1.8', feature);
    assert.equal(row.available, false, feature);
    assert.equal(row.label, FEATURE_META[feature].label, feature);
    assert.ok(row.fallback && typeof row.fallback.kind === 'string', feature + ' 缺少降级说明');
    assert.equal(typeof row.migration, 'string', feature + ' 缺少迁移建议');
    assert.equal(row.blocking, true, feature + ' 特性门必须是阻塞式');
    assert.equal(row.severity, 'needs-user', feature);
    assert.equal(current[feature].available, true, feature);
    assert.equal(current[feature].severity, 'none', feature);
  }
  const unknown = featureMatrix({});
  for (const feature of FEATURE_NAMES) {
    assert.equal(unknown[feature].available, false, feature);
    assert.equal(unknown[feature].actual, 'unknown', feature);
  }
});

// ---------------------------------------------------------------------------
// protocolGate：既有字段/错误码不变，只加解释字段
// ---------------------------------------------------------------------------

test('protocolGate 放行：既有 ok/code/features/missing/floor 保持不变，新增解释字段', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = protocolGate(CURRENT, method, params);
    assert.equal(decision.ok, true, feature);
    assert.equal(decision.code, null, feature);
    assert.equal(decision.method, method, feature);
    assert.deepEqual([...decision.features], [feature], feature);
    assert.deepEqual(decision.missing, [], feature);
    assert.equal(decision.floor, '1.9', feature);
    // 新增字段（只加不改）
    assert.equal(decision.severity, 'none', feature);
    assert.deepEqual(decision.degradation, [], feature);
    assert.equal(decision.migration, null, feature);
    assert.ok(Array.isArray(decision.floorSources), feature + ' 缺少 floorSources');
    assert.equal(decision.floorSources.length, 1, feature);
    assert.ok(decision.proof && decision.proof.method === method, feature + ' 缺少六面 proof');
  }
});

test('protocolGate 拒绝：错误码/消息/兼容别名/既有 data 字段逐项保持', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = protocolGate(OLD, method, params);
    assert.equal(decision.ok, false, feature);
    assert.equal(decision.code, PROTOCOL_UNSUPPORTED, feature);
    assert.equal(decision.code, 'E_PROTOCOL_UNSUPPORTED', feature);
    assert.deepEqual([...decision.features], [feature], feature);
    assert.equal(decision.missing.length, 1, feature);
    assert.equal(decision.missing[0].feature, feature);
    assert.equal(decision.missing[0].required, '1.9');
    assert.equal(decision.missing[0].actual, '1.8');
    assert.equal(decision.floor, '1.9');
    assert.match(decision.message, /E_PROTOCOL_UNSUPPORTED/);
    assert.match(decision.message, /1\.9/);
    // 既有 data 字段
    assert.equal(decision.data.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(decision.data.method, method);
    assert.equal(decision.data.feature, feature);
    assert.equal(decision.data.required, '1.9');
    assert.equal(decision.data.actual, '1.8');
    assert.equal(decision.data.legacyCode, LEGACY_CAPABILITY_UNSUPPORTED);
    assert.deepEqual([...decision.data.aliasCodes], [...PROTOCOL_UNSUPPORTED_ALIASES]);
    // 新增解释字段
    assert.equal(decision.data.severity, 'needs-user');
    assert.ok(decision.data.explanation && decision.data.explanation.ok === false);
    assert.equal(decision.data.migration.upgradeTo, '1.9');
    assert.ok(decision.data.proof && decision.data.proof.method === method);
    assert.ok(decision.data.recovery && decision.data.recovery.code === 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(decision.data.recovery.action, 'upgrade-extension');
    assert.equal(isProtocolUnsupportedCode(decision.code), true);
    assert.equal(isProtocolUnsupportedCode(decision.data.legacyCode), true);
  }
});

test('protocolGate 拒绝：可降级调用带可执行降级，不可降级调用带 unresolved', () => {
  const stream = protocolGate(OLD, 'screenshot', { stream: true });
  assert.equal(stream.ok, false);
  assert.equal(stream.degradation.degradable, true);
  assert.equal(stream.degradation.degraded.method, 'screenshot');
  assert.deepEqual([...stream.degradation.degraded.droppedParams], ['stream']);
  assert.deepEqual({ ...stream.degradation.degraded.params }, {});
  assert.equal(stream.data.degradable, true);

  const video = protocolGate(OLD, 'video.start', {});
  assert.equal(video.ok, false);
  assert.equal(video.degradation.degradable, false);
  assert.equal(video.degradation.degraded, null);
  assert.equal(video.data.degradation, null);
});

test('protocolGate：允许多方法跨版本行为与 featuresForCall 完全一致（165 方法全量）', () => {
  const peers = [CURRENT, OLD, UNKNOWN_PEER, { protocol: '1.10' }, { protocol: '1.7' }, { protocol: '2.0' }];
  let checked = 0;
  for (const row of METHOD_CATALOG) {
    const params = {};
    const features = featuresForCall(row.method, params);
    for (const peer of peers) {
      const decision = protocolGate(peer, row.method, params);
      const expectedOk = featureShortfall(peer, features).length === 0;
      assert.equal(decision.ok, expectedOk, row.method + '@' + String(peer.protocol) + ' 放行集合与 featuresForCall 不一致');
      if (expectedOk) {
        assert.equal(decision.code, null, row.method);
        assert.deepEqual(decision.missing, [], row.method);
      } else {
        assert.equal(decision.code, PROTOCOL_UNSUPPORTED, row.method);
        assert.ok(decision.missing.length > 0, row.method);
      }
      checked += 1;
    }
  }
  assert.equal(checked, METHOD_CATALOG.length * peers.length);
});

test('protocolGate：参数级门在旧客户端上拒绝、在当前客户端放行（逐参数规则）', () => {
  const probes = [
    ['screenshot', { stream: true }, 'capture.stream'],
    ['screenshot', { segmented: true }, 'capture.stream'],
    ['screenshot', { staleAttempts: 2 }, 'capture.stream'],
    ['observe', { delta: true }, 'observe-delta'],
    ['evaluate', { unverified: true }, 'unverified'],
    ['click', { expect: [{ field: 'text', equals: 'x' }] }, 'expect'],
  ];
  for (const [method, params, feature] of probes) {
    const old = protocolGate(OLD, method, params);
    assert.equal(old.ok, false, method + ' ' + JSON.stringify(params));
    assert.deepEqual(old.features, [feature], method + ' ' + JSON.stringify(params));
    const current = protocolGate(CURRENT, method, params);
    assert.equal(current.ok, true, method + ' ' + JSON.stringify(params));
    assert.equal(current.floor, FEATURE_FLOORS[feature]);
  }
  // 相同参数形态以外不得误触发
  assert.equal(protocolGate(OLD, 'screenshot', { stream: false }).ok, true);
  assert.equal(protocolGate(OLD, 'observe', { delta: false }).ok, true);
  assert.equal(protocolGate(OLD, 'click', { expect: [] }).ok, true);
});

test('protocolGate：floorSources 解释参数级来源，data.required 仍是最高 floor', () => {
  const decision = protocolGate(OLD, 'evaluate', { unverified: true, expect: [{ field: 'text' }] });
  assert.equal(decision.ok, false);
  assert.equal(decision.floor, '1.9');
  assert.equal(decision.data.required, '1.9');
  assert.equal(decision.floorSources.length, 2);
  assert.deepEqual(decision.floorSources.map((source) => source.param), ['unverified', 'expect']);
  assert.deepEqual([...decision.missing].map((item) => item.feature), ['unverified', 'expect']);
});

test('assertProtocolCompatible：拒绝时 code/data 语义不变，且能检查新增解释字段', () => {
  assert.throws(
    () => assertProtocolCompatible(OLD, 'video.start', {}),
    (error) => {
      assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
      assert.equal(error.data.method, 'video.start');
      assert.equal(error.data.feature, 'video');
      assert.equal(error.data.severity, 'needs-user');
      assert.ok(error.data.explanation.summary.includes('video'));
      return true;
    },
  );
  assert.throws(() => assertProtocolCompatible(UNKNOWN_PEER, 'read', {}), (error) => {
    assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(error.data.actual, 'unknown');
    return true;
  });
  const allowed = assertProtocolCompatible(CURRENT, 'video.start', {});
  assert.equal(allowed.ok, true);
});

// ---------------------------------------------------------------------------
// 协商失败解释
// ---------------------------------------------------------------------------

test('explainNegotiation：通过时给出 ok/summary，拒绝时给出原因+细节+补救', () => {
  const pass = explainNegotiation(protocolGate(CURRENT, 'read', {}));
  assert.equal(pass.ok, true);
  assert.equal(pass.code, null);
  assert.equal(pass.severity, 'none');
  assert.deepEqual(pass.details, []);
  assert.deepEqual(pass.remediation, []);

  const denied = protocolGate(OLD, 'video.start', {});
  const explanation = explainNegotiation(denied);
  assert.equal(explanation.ok, false);
  assert.equal(explanation.code, 'E_PROTOCOL_UNSUPPORTED');
  assert.equal(explanation.severity, 'needs-user');
  assert.equal(explanation.actual, '1.8');
  assert.equal(explanation.floor, '1.9');
  assert.match(explanation.cause, /1\.8/);
  assert.equal(explanation.details.length, 1);
  assert.equal(explanation.details[0].feature, 'video');
  assert.equal(explanation.details[0].required, '1.9');
  assert.ok(explanation.remediation.length >= 2, '补救步骤应包含升级/降级建议');
  assert.ok(explanation.remediation.some((step) => /升级/.test(step)), '不可降级特性必须给升级建议');
});

test('explainNegotiation：可降级特性同时给降级与升级两条补救', () => {
  const explanation = explainNegotiation(protocolGate(OLD, 'screenshot', { stream: true }));
  assert.equal(explanation.details[0].feature, 'capture.stream');
  assert.ok(explanation.remediation.some((step) => step.startsWith('降级：')), '应给降级建议');
  assert.ok(explanation.remediation.some((step) => /升级/.test(step)), '应给升级建议');
  assert.ok(explanation.migration.upgradeRequired);
});

test('explainFeatureGap：无缺失时结构稳定；有缺失时每个特性带 fallback/migration', () => {
  const none = explainFeatureGap([], OLD);
  assert.equal(none.summary, '没有缺失特性');
  assert.deepEqual(none.details, []);
  assert.equal(none.severity, 'none');

  const gap = explainFeatureGap(featureShortfall(OLD, FEATURE_NAMES), OLD);
  assert.equal(gap.actual, '1.8');
  assert.equal(gap.details.length, 15);
  assert.equal(gap.severity, 'needs-user');
  assert.match(gap.summary, /1\.8/);
  for (const detail of gap.details) {
    assert.equal(detail.actual, '1.8');
    assert.equal(detail.required, '1.9');
    assert.ok(Object.prototype.hasOwnProperty.call(detail, 'fallback'));
    assert.equal(typeof detail.migration, 'string');
  }
});

test('migrationAdvice：全量/指定特性两种口径，步骤与缺失特性一一对应', () => {
  const all = migrationAdvice(OLD);
  assert.equal(all.peer, '1.8');
  assert.equal(all.band, 'baseline');
  assert.equal(all.upgradeTo, PROTOCOL_CURRENT);
  assert.equal(all.upgradeRequired, true);
  assert.equal(all.missingCount, 15);
  assert.equal(all.features.length, 15);
  assert.ok(all.steps.length >= 5, '整体升级步骤过少');
  assert.ok(all.steps.some((step) => step.includes('重新加载')), '缺少扩展重载步骤');
  assert.ok(all.steps.some((step) => step.includes('1.9')), '缺少目标协议版本');

  const scoped = migrationAdvice(OLD, { features: ['video'] });
  assert.equal(scoped.missingCount, 1);
  assert.deepEqual(scoped.features.map((item) => item.feature), ['video']);
  assert.equal(scoped.features[0].fallback.kind, 'none');

  const current = migrationAdvice(CURRENT);
  assert.equal(current.upgradeRequired, false);
  assert.equal(current.missingCount, 0);
  assert.deepEqual(current.features, []);
});

test('migrationAdvice：未知协议要升级但 band=unknown，不可假设“旧但可降级”', () => {
  const advice = migrationAdvice(UNKNOWN_PEER);
  assert.equal(advice.peer, 'unknown');
  assert.equal(advice.band, 'unknown');
  assert.equal(advice.upgradeRequired, true);
  assert.equal(advice.skew.severity, 'fatal');
});

// ---------------------------------------------------------------------------
// negotiate：单调用 / 多调用 / 纯特性
// ---------------------------------------------------------------------------

test('negotiate 单调用：compatible / degraded / incompatible 三种 verdict', () => {
  const compatible = negotiate(CURRENT, { method: 'screenshot', params: { stream: true } });
  assert.equal(compatible.ok, true);
  assert.equal(compatible.verdict, 'compatible');
  assert.deepEqual(compatible.missing, []);
  assert.equal(compatible.calls.length, 1);
  assert.equal(compatible.explanation.ok, true);

  const degraded = negotiate(OLD, { method: 'screenshot', params: { stream: true } });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.verdict, 'degraded');
  assert.deepEqual(degraded.missing, ['capture.stream']);
  assert.equal(degraded.degradations.length, 1);
  assert.equal(degraded.degradations[0].method, 'screenshot');
  assert.deepEqual([...degraded.degradations[0].degraded.droppedParams], ['stream']);
  assert.equal(degraded.explanation.ok, false);
  assert.equal(degraded.explanation.severity, 'needs-user');

  const incompatible = negotiate(OLD, { method: 'video.start', params: {} });
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.verdict, 'incompatible');
  assert.deepEqual(incompatible.missing, ['video']);
  assert.deepEqual(incompatible.degradations, []);
});

test('negotiate 多调用：混合调用时只有全部可降级才报 degraded', () => {
  const mixed = negotiate(OLD, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'read', params: {} },
      { method: 'click', params: { ref: '@e1' } },
    ],
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.verdict, 'degraded');
  assert.equal(mixed.calls.length, 3);
  assert.equal(mixed.calls[0].ok, false);
  assert.equal(mixed.calls[1].ok, false);
  assert.equal(mixed.calls[2].ok, true);
  assert.equal(mixed.degradations.length, 2);

  const blocked = negotiate(OLD, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'video.start', params: {} },
    ],
  });
  assert.equal(blocked.verdict, 'incompatible');
  assert.equal(blocked.degradations.length, 1);

  const allOk = negotiate(CURRENT, {
    calls: [{ method: 'click', params: {} }, { method: 'observe', params: {} }],
  });
  assert.equal(allOk.verdict, 'compatible');
  assert.equal(allOk.ok, true);
});

test('negotiate 纯特性：不传方法时按特性集合判定', () => {
  const result = negotiate(OLD, { features: ['video', 'read'] });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'incompatible');
  assert.deepEqual([...result.missing].sort(), ['read', 'video']);
  assert.equal(result.floor, '1.9');
  assert.equal(result.calls.length, 0);
  assert.equal(result.migration.features.length, 2);
});

test('negotiate：每个 call 带 proof（六面）与 decision（既有闸门），未知方法安全', () => {
  const result = negotiate(CURRENT, {
    calls: [
      { method: 'click', params: { ref: '@e1' } },
      { method: 'no.such.method', params: {} },
    ],
  });
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].proof.method, 'click');
  assert.equal(result.calls[0].decision.ok, true);
  assert.equal(result.calls[1].ok, true, '未知方法没有特性门，闸门放行');
  assert.equal(result.calls[1].proof, null, '未知方法没有六面');
});

test('negotiate：对端版本信息来自 protocol.mjs 的分带/偏斜', () => {
  const current = negotiate(CURRENT, { method: 'click', params: {} });
  assert.equal(current.peer.protocol, '1.9');
  assert.equal(current.peer.band, 'current');
  assert.equal(current.peer.skew.severity, 'none');
  const old = negotiate(OLD, { method: 'click', params: {} });
  assert.equal(old.peer.band, 'baseline');
  assert.equal(old.peer.skew.severity, 'warn');
  const unknown = negotiate(UNKNOWN_PEER, { method: 'click', params: {} });
  assert.equal(unknown.peer.protocol, 'unknown');
  assert.equal(unknown.peer.band, 'unknown');
  assert.equal(unknown.peer.skew.severity, 'fatal');
});

// ---------------------------------------------------------------------------
// 版本分带 / 偏斜（lib/protocol.mjs）
// ---------------------------------------------------------------------------

test('protocolBand：baseline=1.8 / current=1.9 / legacy / intermediate / ahead-minor / ahead-major / unknown', () => {
  assert.equal(protocolBand('1.8'), 'baseline');
  assert.equal(protocolBand('1.9'), 'current');
  assert.equal(protocolBand('1.7'), 'legacy');
  assert.equal(protocolBand('1.7.9'), 'unknown', 'patch 版本不在协议格式内，按 unknown');
  assert.equal(protocolBand('1.8.5'), 'unknown', 'patch 版本不在协议格式内，按 unknown');
  assert.equal(protocolBand('1.10'), 'ahead-minor');
  assert.equal(protocolBand('1.99'), 'ahead-minor');
  assert.equal(protocolBand('2.0'), 'ahead-major');
  assert.equal(protocolBand(''), 'unknown');
  assert.equal(protocolBand(null), 'unknown');
  assert.equal(protocolBand(undefined), 'unknown');
  assert.equal(protocolBand('x'), 'unknown');
  assert.equal(protocolBand(1.9), 'current', '数字 1.9 与字符串 1.9 同带');
  assert.deepEqual([...PROTOCOL_BANDS], ['unknown', 'legacy', 'baseline', 'intermediate', 'current', 'ahead-minor', 'ahead-major']);
});

test('protocolBandSnapshot / PROTOCOL_RANGE 与目录常量一致', () => {
  const snapshot = protocolBandSnapshot();
  assert.equal(snapshot.baseline, PROTOCOL_BASELINE);
  assert.equal(snapshot.current, PROTOCOL_CURRENT);
  assert.equal(snapshot.bands['1.8'], 'baseline');
  assert.equal(snapshot.bands['1.9'], 'current');
  assert.equal(snapshot.bands['1.7'], 'legacy');
  assert.equal(snapshot.bands['1.10'], 'ahead-minor');
  assert.equal(snapshot.bands['2.0'], 'ahead-major');
  assert.deepEqual({ ...PROTOCOL_RANGE }, { baseline: PROTOCOL_BASELINE, current: PROTOCOL_CURRENT });
});

test('isProtocolKnown / isSameProtocolMajor / maxProtocol / minProtocol', () => {
  assert.equal(isProtocolKnown('1.9'), true);
  assert.equal(isProtocolKnown(1.9), true);
  assert.equal(isProtocolKnown(''), false);
  assert.equal(isProtocolKnown('x'), false);
  assert.equal(isSameProtocolMajor('1.8', '1.9'), true);
  assert.equal(isSameProtocolMajor('1.9', '2.0'), false);
  assert.equal(isSameProtocolMajor('x', '1.9'), false);
  assert.equal(maxProtocol('1.8', '1.9', '1.10'), '1.10');
  assert.equal(maxProtocol('1.8', null, 'x', '1.9'), '1.9');
  assert.equal(maxProtocol(), null);
  assert.equal(minProtocol('1.8', '1.9', '1.7'), '1.7');
  assert.equal(minProtocol(null), null);
  assert.equal(compareProtocol('1.10', '1.9') > 0, true, 'minor 按数值比较，1.10 > 1.9');
});

test('protocolSkew：equal / older / newer / major-skew / unknown 五类', () => {
  assert.equal(protocolSkew('1.9', '1.9').relation, 'equal');
  assert.equal(protocolSkew('1.9', '1.9').severity, 'none');
  assert.equal(protocolSkew('1.8', '1.9').relation, 'actual-older');
  assert.equal(protocolSkew('1.8', '1.9').severity, 'warn');
  assert.equal(protocolSkew('1.10', '1.9').relation, 'actual-newer');
  assert.equal(protocolSkew('1.10', '1.9').severity, 'info');
  assert.equal(protocolSkew('2.0', '1.9').relation, 'major-skew');
  assert.equal(protocolSkew('2.0', '1.9').severity, 'fatal');
  assert.equal(protocolSkew('', '1.9').relation, 'unknown');
  assert.equal(protocolSkew('', '1.9').severity, 'fatal');
  // 客户端较新的提示必须说明“未知字段会被忽略”，而不是说对方坏。
  assert.match(protocolSkew('1.10', '1.9').message, /忽略/);
  assert.match(protocolSkew('1.8', '1.9').message, /新特性会被 feature floor 拒绝/);
});

test('negotiateProtocolVersion：达到/低于/major 不同/不可解析', () => {
  const ok = negotiateProtocolVersion('1.9', '1.9');
  assert.equal(ok.ok, true);
  assert.equal(ok.sameMajor, true);
  assert.equal(ok.known, true);
  const higher = negotiateProtocolVersion('1.10', '1.9');
  assert.equal(higher.ok, true);
  assert.equal(higher.band, 'ahead-minor');
  const lower = negotiateProtocolVersion('1.8', '1.9');
  assert.equal(lower.ok, false);
  assert.equal(lower.reason, '低于要求的协议版本');
  const major = negotiateProtocolVersion('2.0', '1.9');
  assert.equal(major.ok, false);
  assert.match(major.reason, /major 不同/);
  const unknown = negotiateProtocolVersion('', '1.9');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.known, false);
  assert.equal(unknown.order, null);
  // 既有 protocolAtLeast 语义不能被新函数改变
  assert.equal(protocolAtLeast('1.9', '1.9'), true);
  assert.equal(protocolAtLeast('1.8', '1.9'), false);
  assert.equal(protocolAtLeast('x', '1.9'), null);
});

// ---------------------------------------------------------------------------
// 兼容矩阵深化后的兼容性（不改变既有矩阵结论）
// ---------------------------------------------------------------------------

test('compatibilityMatrix：结论保持不变（基线全拒/当前全允），且每行可映射到降级说明', () => {
  const matrix = compatibilityMatrix();
  assert.equal(matrix.ok, true);
  assert.deepEqual(matrix.counts['1.8'], { allowed: 0, denied: 15 });
  assert.deepEqual(matrix.counts['1.9'], { allowed: 15, denied: 0 });
  assert.deepEqual([...COMPAT_PROBE_VERSIONS], ['1.8', '1.9']);
  for (const row of matrix.features) {
    assert.equal(row.floor, FEATURE_FLOORS[row.feature]);
    assert.equal(row.allowed['1.8'], false);
    assert.equal(row.allowed['1.9'], true);
    const degraded = degradationForFeature(row.feature);
    assert.equal(degraded.floor, row.floor);
    assert.equal(degraded.label, row.label);
  }
});

test('METHOD_FEATURE 的每个方法 floor 都能被 floorDecision 解释且与目录一致', () => {
  assert.equal(GATED_METHODS.length, 29);
  for (const method of GATED_METHODS) {
    const decision = floorDecision(method, {});
    assert.equal(decision.gated, true, method);
    assert.equal(decision.floor, '1.9', method);
    assert.deepEqual([...decision.features], [METHOD_FEATURE[method]], method);
    assert.equal(METHOD_FEATURE[method], methodFeature(method), method + ' 两个入口必须同源');
    assert.equal(protocolGate(OLD, method, {}).ok, false, method + ' 1.8 必须拒绝');
    assert.equal(protocolGate(CURRENT, method, {}).ok, true, method + ' 1.9 必须放行');
  }
});

test('所有 METHOD_NAMES 都能构造 floorDecision；未知版本不抛错（全量健壮性）', () => {
  for (const method of METHOD_NAMES) {
    const decision = floorDecision(method, {});
    assert.equal(typeof decision, 'object');
    assert.ok(Object.isFrozen(decision));
    // 无参数时只有方法级门可能触发
    if (METHOD_FEATURE[method]) assert.equal(decision.floor, '1.9', method);
    else assert.equal(decision.floor, null, method);
  }
  for (const peer of [UNKNOWN_PEER, { protocol: 'x' }, { protocol: '1.8' }, { protocol: '1.9' }]) {
    for (const method of ['screenshot', 'evaluate', 'read', 'click', 'video.start']) {
      assert.doesNotThrow(() => protocolGate(peer, method, { stream: true, unverified: true, expect: [{}] }));
    }
  }
});
