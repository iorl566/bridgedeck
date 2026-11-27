// tests/unit/protocol-compat-matrix.test.mjs —— 协议兼容矩阵：1.8/1.9 客户端 × 15 个 feature floor。
//
// 全部是纯函数/纯数据断言：不连 daemon、不起浏览器。1.8 客户端由 `{ protocol: '1.8' }`
// 构造（与 daemon hello 帧里的实例字段同形），闸门拒绝必须给 E_PROTOCOL_UNSUPPORTED。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_NAMES,
  METHOD_FEATURE,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  COMPAT_PROBE_VERSIONS,
  FEATURE_MIN_PROTOCOL,
  FEATURE_NAMES_IN_ORDER,
  FEATURE_RECOVERY,
  PROTOCOL_UNSUPPORTED,
  assertProtocolCompatible,
  compatibilityMatrix,
  featureMatrix,
  featureShortfall,
  methodFeature,
  protocolGate,
  requiredFloorFor,
} from '../../lib/protocol-features.mjs';

/** 每个特性门的真实触发调用（构造旧客户端请求用）。 */
export const FEATURE_TRIGGERS = Object.freeze({
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

const OLD = Object.freeze({ protocol: PROTOCOL_BASELINE });
const CURRENT = Object.freeze({ protocol: PROTOCOL_CURRENT });

test('十五个 feature floor：名称与最低协议版本 1.9（基线 1.8）', () => {
  assert.equal(Object.keys(FEATURE_FLOORS).length, 15);
  assert.deepEqual([...FEATURE_NAMES].sort(), [...FEATURE_NAMES_IN_ORDER].sort());
  assert.deepEqual([...FEATURE_NAMES].sort(), Object.keys(FEATURE_FLOORS).sort());
  for (const feature of FEATURE_NAMES) {
    assert.equal(FEATURE_FLOORS[feature], '1.9', feature + ' floor 必须是 1.9');
    assert.equal(FEATURE_MIN_PROTOCOL[feature], '1.9', feature + ' 兼容表必须与目录一致');
    assert.equal(typeof FEATURE_META[feature].label, 'string', feature + ' 缺少可读标签');
    assert.ok(FEATURE_META[feature].label.length >= 2, feature + ' 标签过短');
  }
  assert.equal(PROTOCOL_BASELINE, '1.8');
  assert.equal(PROTOCOL_CURRENT, '1.9');
  assert.deepEqual([...COMPAT_PROBE_VERSIONS], ['1.8', '1.9']);
});

test('每个特性门都有真实触发调用，且该调用只推导出这一个特性', () => {
  for (const feature of FEATURE_NAMES) {
    const trigger = FEATURE_TRIGGERS[feature];
    assert.ok(Array.isArray(trigger), feature + ' 缺少触发用例');
    const [method, params] = trigger;
    const decision = protocolGate(CURRENT, method, params);
    assert.deepEqual(decision.features, [feature], feature + ' 触发调用推导出的特性不唯一：' + JSON.stringify(decision.features));
    assert.equal(decision.ok, true, feature + ' 当前客户端应允许');
  }
});

test('兼容矩阵：1.8 客户端 × 15 floor 全部拒绝，1.9 客户端全部允许', () => {
  const matrix = compatibilityMatrix();
  assert.equal(matrix.ok, true);
  assert.deepEqual(matrix.versions, ['1.8', '1.9']);
  assert.equal(matrix.features.length, 15);
  assert.deepEqual(matrix.counts['1.8'], { allowed: 0, denied: 15 });
  assert.deepEqual(matrix.counts['1.9'], { allowed: 15, denied: 0 });
  for (const row of matrix.features) {
    assert.equal(row.floor, '1.9', row.feature);
    assert.equal(row.allowed['1.8'], false, row.feature + ' 1.8 不应允许');
    assert.equal(row.allowed['1.9'], true, row.feature + ' 1.9 应允许');
    assert.equal(matrix.matrix['1.8'][row.feature], false);
    assert.equal(matrix.matrix['1.9'][row.feature], true);
  }
  for (const feature of FEATURE_NAMES) {
    assert.ok(feature in matrix.matrix['1.8'], feature + ' 不在 1.8 矩阵');
    assert.ok(feature in matrix.matrix['1.9'], feature + ' 不在 1.9 矩阵');
  }
});

test('1.8 客户端请求被 E_PROTOCOL_UNSUPPORTED 拒绝（逐 floor）', () => {
  const denied = [];
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = protocolGate(OLD, method, params);
    assert.equal(decision.ok, false, feature + ' 应被拒绝');
    assert.equal(decision.code, PROTOCOL_UNSUPPORTED, feature + ' 错误码错误');
    assert.equal(decision.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.deepEqual(decision.features, [feature]);
    assert.equal(decision.missing.length, 1);
    assert.equal(decision.missing[0].feature, feature);
    assert.equal(decision.missing[0].required, '1.9');
    assert.equal(decision.missing[0].actual, '1.8');
    assert.equal(decision.floor, '1.9');
    assert.equal(decision.data.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(decision.data.method, method);
    assert.equal(decision.data.feature, feature);
    assert.equal(decision.data.required, '1.9');
    assert.equal(decision.data.actual, '1.8');
    assert.match(decision.message, /E_PROTOCOL_UNSUPPORTED/);
    assert.match(decision.message, /1\.9/);
    denied.push(method);
  }
  assert.equal(denied.length, 15);
});

test('1.9 客户端同一批请求全部放行', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = FEATURE_TRIGGERS[feature];
    const decision = protocolGate(CURRENT, method, params);
    assert.equal(decision.ok, true, feature + ' 1.9 应放行');
    assert.equal(decision.code, null);
    assert.deepEqual(decision.missing, []);
    assert.equal(decision.floor, '1.9');
  }
});

test('缺少 protocol 的旧客户端按 unknown 处理并被拒绝，格式非法同样拒绝', () => {
  for (const peer of [{}, { protocol: '' }, { protocol: null }, { protocol: 'x' }]) {
    const decision = protocolGate(peer, 'video.start');
    assert.equal(decision.ok, false, JSON.stringify(peer) + ' 应拒绝');
    assert.equal(decision.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.ok(decision.missing[0].actual === 'unknown' || decision.missing[0].actual !== '1.9');
  }
  assert.equal(protocolGate({ protocol: '1.10' }, 'video.start').ok, true, '1.10 允许（更高 minor）');
  // 更高 major 的 floor 比较是 >=，但 daemon hello 层仍会以 E_PROTOCOL_UNSUPPORTED 拒绝 major 不兼容；
  // 这里只验证 floor 函数本身不误杀未知格式。
  assert.equal(protocolGate({ protocol: '2.0' }, 'video.start').ok, true);
});

test('没有特性门的方法在旧客户端上照常放行', () => {
  for (const method of ['click', 'navigate', 'screenshot', 'tab.list', 'observe']) {
    assert.deepEqual(protocolGate(OLD, method, {}).features, [], method + ' 不应要求特性');
    assert.equal(protocolGate(OLD, method, {}).ok, true, method + ' 旧客户端应放行');
    assert.equal(protocolGate({}, method, {}).ok, true, method + ' 无版本也应放行');
    assert.equal(methodFeature(method), null);
  }
});

test('assertProtocolCompatible 拒绝时抛错并带 code/data，通过时返回决策', () => {
  assert.throws(
    () => assertProtocolCompatible(OLD, 'video.start', {}),
    (error) => {
      assert.equal(error.code, 'E_PROTOCOL_UNSUPPORTED');
      assert.equal(error.data.feature, 'video');
      assert.equal(error.data.method, 'video.start');
      return true;
    },
  );
  const allowed = assertProtocolCompatible(CURRENT, 'video.start', {});
  assert.equal(allowed.ok, true);
  assert.throws(() => assertProtocolCompatible(OLD, 'network.replay', {}), /E_PROTOCOL_UNSUPPORTED/);
});

test('方法级特性门覆盖：FEATURE_META.methods 里每个方法在 1.8 上都拒绝', () => {
  const methodGated = Object.entries(FEATURE_META)
    .filter(([, meta]) => meta.methods.length > 0);
  assert.equal(methodGated.length, 8, '方法级 gated 特性应有 8 个（read/plan/video/capture.stream/debug.journal/har + interaction_policy/dialog_control）');
  let covered = 0;
  for (const [feature, meta] of methodGated) {
    for (const method of meta.methods) {
      assert.equal(METHOD_FEATURE[method], feature, method + ' 方法级特性门反向表不一致');
      const decision = protocolGate(OLD, method, {});
      assert.equal(decision.code, 'E_PROTOCOL_UNSUPPORTED', method + ' 应被 1.8 拒绝');
      assert.ok(decision.features.includes(feature), method + ' 缺少特性 ' + feature);
      covered += 1;
    }
  }
  assert.equal(covered, 29, 'gated 方法数应为 29');
  assert.equal(Object.keys(METHOD_FEATURE).length, 29);
});

test('参数级 capture.stream：stream / segmented / staleAttempts 三种写法都 gated', () => {
  const variants = [{ stream: true }, { segmented: true }, { stream: true, staleAttempts: 2 }, { staleAttempts: 1 }];
  for (const params of variants) {
    const decision = protocolGate(OLD, 'screenshot', params);
    assert.equal(decision.code, 'E_PROTOCOL_UNSUPPORTED', JSON.stringify(params) + ' 应拒绝');
    assert.deepEqual(decision.features, ['capture.stream']);
    assert.equal(protocolGate(CURRENT, 'screenshot', params).ok, true);
  }
  // false / 未给 不触发
  for (const params of [{ stream: false }, { segmented: false }, {}]) {
    assert.deepEqual(protocolGate(OLD, 'screenshot', params).features, [], JSON.stringify(params));
    assert.equal(protocolGate(OLD, 'screenshot', params).ok, true);
  }
});

test('featureMatrix 与兼容矩阵逐格一致；旧客户端 actual 是 1.8', () => {
  const old = featureMatrix(OLD);
  const current = featureMatrix(CURRENT);
  const matrix = compatibilityMatrix();
  for (const feature of FEATURE_NAMES) {
    assert.equal(old[feature].required, '1.9', feature);
    assert.equal(old[feature].actual, '1.8', feature);
    assert.equal(old[feature].available, matrix.matrix['1.8'][feature], feature);
    assert.equal(current[feature].available, matrix.matrix['1.9'][feature], feature);
    assert.equal(matrix.matrix['1.9'][feature], true);
  }
  const unknown = featureMatrix({});
  for (const feature of FEATURE_NAMES) {
    assert.equal(unknown[feature].actual, 'unknown');
    assert.equal(unknown[feature].available, false);
  }
});

test('requiredFloorFor 取最高 floor，featureShortfall 默认比较器可用', () => {
  assert.equal(requiredFloorFor(['unverified', 'video', 'har']), '1.9');
  assert.equal(requiredFloorFor([]), null);
  assert.deepEqual(featureShortfall(OLD, ['video', 'har']).map((item) => item.feature).sort(), ['har', 'video']);
  assert.deepEqual(featureShortfall(CURRENT, ['video']), []);
  assert.deepEqual(featureShortfall({ protocol: '1.8' }, ['no-such-feature']), [], '未知特性不参与判定');
});

test('兼容矩阵支持自定义探测版本且不误伤未知版本', () => {
  const matrix = compatibilityMatrix(undefined, ['1.0', '1.7', '1.8', '1.9', '1.10']);
  assert.deepEqual(matrix.versions, ['1.0', '1.7', '1.8', '1.9', '1.10']);
  assert.equal(matrix.counts['1.0'].allowed, 0);
  assert.equal(matrix.counts['1.7'].allowed, 0);
  assert.equal(matrix.counts['1.8'].allowed, 0);
  assert.equal(matrix.counts['1.9'].allowed, 15);
  assert.equal(matrix.counts['1.10'].allowed, 15);
  for (const row of matrix.features) {
    assert.equal(row.allowed['1.10'], true);
    assert.equal(row.allowed['1.0'], false);
  }
  // 未包含 baseline/current 的探测集不改变 ok（避免把 probe 集合当成策略）
  const partial = compatibilityMatrix(undefined, ['1.8']);
  assert.deepEqual(partial.versions, ['1.8']);
  assert.equal(partial.counts['1.8'].allowed, 0);
});

test('错误信息包含错误码与升级提示（可被 CLI/MCP 直接展示）', () => {
  assert.ok(FEATURE_RECOVERY.includes('E_PROTOCOL_UNSUPPORTED'));
  assert.ok(FEATURE_RECOVERY.includes('1.9'));
  const decision = protocolGate({ protocol: '1.7' }, 'video.start');
  assert.match(decision.message, /video/);
  assert.match(decision.message, /1\.7/);
  assert.match(decision.message, /1\.9/);
  assert.match(decision.message, /升级/);
  assert.equal(decision.data.code, PROTOCOL_UNSUPPORTED);
});
