// tests/unit/protocol-features-deep.test.mjs —— 特性门/floor/协商的边界与元数据测试。
//
// 已有测试覆盖“主路径”；这里补：
//   1. FEATURE_META 的 kind/params/methods 自洽，方法级门反向映射唯一；
//   2. featuresForCall 的参数触发边界（false/空数组/非数组/null params/未知方法）；
//   3. featureShortfall / requiredFloorFor / compatibilityMatrix 的边界输入；
//   4. protocolGate 可注入 compare（测试构造对端版本，不依赖真实解析）；
//   5. negotiationPlan / gateMatrix 的空请求与子集输入；
//   6. 所有新增返回值都是冻结的纯数据（可安全序列化/缓存）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_METHODS,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_CATALOG,
  METHOD_FEATURE,
  METHOD_FEATURE_FLOOR,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  COMPAT_PROBE_VERSIONS,
  FEATURE_MIN_PROTOCOL,
  FEATURE_NAMES_IN_ORDER,
  compatibilityMatrix,
  degradationForFeature,
  explainNegotiation,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  floorDecision,
  gateMatrix,
  negotiate,
  negotiationPlan,
  protocolGate,
  requiredFloorFor,
} from '../../lib/protocol-features.mjs';
import { compareProtocol } from '../../lib/protocol.mjs';

const CURRENT = Object.freeze({ protocol: PROTOCOL_CURRENT });
const OLD = Object.freeze({ protocol: PROTOCOL_BASELINE });

// ---------------------------------------------------------------------------
// FEATURE_META / FEATURE_PARAM_RULES 元数据
// ---------------------------------------------------------------------------

test('FEATURE_META：15 个门，kind 合法，params/methods 都是冻结数组且不重复', () => {
  assert.equal(Object.keys(FEATURE_META).length, 15);
  assert.deepEqual(Object.keys(FEATURE_META).sort(), [...FEATURE_NAMES].sort());
  const kinds = new Set(['param', 'method', 'method+param']);
  for (const [feature, meta] of Object.entries(FEATURE_META)) {
    assert.ok(kinds.has(meta.kind), feature + ' kind 非法：' + meta.kind);
    assert.equal(typeof meta.label, 'string');
    assert.ok(meta.label.length >= 2, feature);
    assert.ok(Array.isArray(meta.params) && Array.isArray(meta.methods), feature);
    assert.equal(new Set(meta.params).size, meta.params.length, feature + ' params 重复');
    assert.equal(new Set(meta.methods).size, meta.methods.length, feature + ' methods 重复');
    for (const method of meta.methods) assert.ok(METHOD_NAMES.includes(method), feature + ' 引用了目录外方法：' + method);
    if (meta.kind === 'param') assert.equal(meta.methods.length, 0, feature + ' param 门不应有方法');
    if (meta.kind === 'method') assert.equal(meta.params.length, 0, feature + ' method 门不应有参数');
    if (meta.kind === 'method+param') assert.ok(meta.methods.length > 0 && meta.params.length > 0, feature);
  }
  // 参数门与 FEATURE_PARAM_RULES 同源
  for (const rule of FEATURE_PARAM_RULES) {
    assert.ok(FEATURE_META[rule.feature], rule.feature + ' 规则引用了未登记特性');
    assert.ok(FEATURE_META[rule.feature].params.includes(rule.param), rule.feature + ' 规则参数不在 meta.params 里');
    assert.ok(['true', 'defined', 'non-empty-array', 'equals'].includes(rule.kind), rule.kind + ' 规则 kind 非法');
  }
});

test('方法级特性门：29 个方法、反向映射唯一、METHOD_FEATURE_FLOOR 与 FEATURE_FLOORS 一致', () => {
  assert.equal(Object.keys(METHOD_FEATURE).length, 29);
  assert.equal(Object.keys(METHOD_FEATURE_FLOOR).length, 29);
  const seen = new Map();
  for (const [feature, methods] of Object.entries(FEATURE_METHODS)) {
    for (const method of methods) {
      assert.equal(seen.has(method), false, method + ' 出现在两个方法级门');
      seen.set(method, feature);
      assert.equal(METHOD_FEATURE[method], feature, method + ' 反向映射不一致');
      assert.equal(METHOD_FEATURE_FLOOR[method], FEATURE_FLOORS[feature], method);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), Object.keys(METHOD_FEATURE).sort());
  for (const row of METHOD_CATALOG) {
    if (METHOD_FEATURE[row.method]) assert.equal(floorDecision(row.method, {}).floor, '1.9');
  }
});

test('FEATURE_NAMES_IN_ORDER 与 FEATURE_MIN_PROTOCOL 同序同源', () => {
  assert.deepEqual([...FEATURE_NAMES_IN_ORDER], [...FEATURE_NAMES]);
  assert.deepEqual(Object.keys(FEATURE_MIN_PROTOCOL), Object.keys(FEATURE_FLOORS));
  for (const feature of FEATURE_NAMES) assert.equal(FEATURE_MIN_PROTOCOL[feature], FEATURE_FLOORS[feature]);
});

// ---------------------------------------------------------------------------
// featuresForCall 边界
// ---------------------------------------------------------------------------

test('featuresForCall：参数形态边界（false/0/空数组/非数组/null params/未知方法）', () => {
  // 触发要求严格：true / 非空数组 / defined
  assert.deepEqual(featuresForCall('evaluate', { unverified: false }), []);
  assert.deepEqual(featuresForCall('evaluate', { unverified: 'true' }), [], '字符串 true 不触发（严格相等）');
  assert.deepEqual(featuresForCall('click', { expect: [] }), [], '空数组不触发 expect');
  assert.deepEqual(featuresForCall('click', { expect: {} }), [], '非数组不触发 expect');
  assert.deepEqual(featuresForCall('click', { expect: [{ field: 'text' }] }), ['expect']);
  assert.deepEqual(featuresForCall('observe', { delta: true }), ['observe-delta']);
  assert.deepEqual(featuresForCall('observe', { delta: 1 }), [], '非布尔 true 不触发');
  // staleAttempts 是 defined 语义：0 也触发
  assert.deepEqual(featuresForCall('screenshot', { staleAttempts: 0 }), ['capture.stream']);
  assert.deepEqual(featuresForCall('screenshot', { staleAttempts: undefined }), []);
  // null / 数组 / 原始值 params 都安全退化为空参数
  for (const params of [null, undefined, [], 'x', 0, false]) {
    assert.doesNotThrow(() => featuresForCall('click', params));
    assert.deepEqual(featuresForCall('click', params), []);
  }
  // 未知方法只可能被参数规则触发
  assert.deepEqual(featuresForCall('no.such.method', {}), []);
  assert.deepEqual(featuresForCall('no.such.method', { unverified: true }), ['unverified']);
  // 方法级门优先且唯一
  assert.deepEqual(featuresForCall('video.start', {}), ['video']);
  assert.deepEqual(featuresForCall('screenshot', {}), []);
});

test('featuresForCall：同一调用的特性顺序稳定（方法级在前，参数级按规则表）', () => {
  const first = featuresForCall('evaluate', { unverified: true, expect: [{}], delta: true });
  const second = featuresForCall('evaluate', { expect: [{}], delta: true, unverified: true });
  assert.deepEqual(first, second, '参数对象键序不应影响结果');
  assert.equal(first[0], 'unverified', '方法级/规则表顺序必须稳定');
  assert.deepEqual([...first].sort(), ['expect', 'observe-delta', 'unverified']);
});

// ---------------------------------------------------------------------------
// featureShortfall / requiredFloorFor 边界
// ---------------------------------------------------------------------------

test('featureShortfall：自定义 compare 与未知特性输入', () => {
  // 自定义 compare 返回 null 时按“不可比较→缺失”处理
  const alwaysNull = () => null;
  assert.equal(featureShortfall({ protocol: '9.9' }, ['video'], alwaysNull).length, 1);
  // 自定义 compare 永远允许
  const alwaysAllow = () => 1;
  assert.deepEqual(featureShortfall({ protocol: '0.1' }, ['video'], alwaysAllow), []);
  // 未登记特性被忽略（没有 floor 就没有要求）
  assert.deepEqual(featureShortfall(OLD, ['no.such.feature']), []);
  assert.deepEqual(featureShortfall(OLD, []), []);
  // peer 缺失/畸形
  for (const peer of [null, undefined, {}, { protocol: null }, { protocol: '' }]) {
    assert.doesNotThrow(() => featureShortfall(peer, FEATURE_NAMES));
    assert.equal(featureShortfall(peer, FEATURE_NAMES).length, 15);
  }
});

test('requiredFloorFor：空集合/未知特性/全部 floor 取最高', () => {
  assert.equal(requiredFloorFor([]), null);
  assert.equal(requiredFloorFor(['no.such.feature']), null);
  assert.equal(requiredFloorFor(FEATURE_NAMES), '1.9');
  assert.equal(requiredFloorFor(['video']), '1.9');
  const customCompare = (a, b) => compareProtocol(a, b);
  assert.equal(requiredFloorFor(['read', 'video'], customCompare), '1.9');
});

test('compatibilityMatrix：自定义版本子集与空版本列表', () => {
  const single = compatibilityMatrix(undefined, ['1.8']);
  assert.deepEqual(single.versions, ['1.8']);
  assert.equal(single.ok, true, '只有基线探针时：基线全拒即通过');
  assert.deepEqual(single.counts['1.8'], { allowed: 0, denied: 15 });
  const empty = compatibilityMatrix(undefined, []);
  assert.deepEqual(empty.versions, []);
  assert.deepEqual(empty.counts, {});
  assert.equal(empty.ok, true);
  const five = compatibilityMatrix(undefined, ['1.0', '1.7', '1.8', '1.9', '1.10']);
  assert.equal(five.ok, true);
  assert.deepEqual(five.counts['1.9'], { allowed: 15, denied: 0 });
  assert.equal(five.counts['1.0'].allowed, 0);
  assert.deepEqual([...COMPAT_PROBE_VERSIONS], ['1.8', '1.9']);
});

// ---------------------------------------------------------------------------
// protocolGate 注入 compare
// ---------------------------------------------------------------------------

test('protocolGate：可注入 compare 模拟任意对端（不依赖真实版本解析）', () => {
  const alwaysAllow = () => 1;
  const allowed = protocolGate({ protocol: 'odd' }, 'video.start', {}, alwaysAllow);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.floor, '1.9');
  assert.deepEqual(allowed.migration, null);

  const alwaysDeny = () => -1;
  const denied = protocolGate({ protocol: 'odd' }, 'video.start', {}, alwaysDeny);
  assert.equal(denied.ok, false);
  assert.equal(denied.data.actual, 'odd');
  assert.equal(denied.data.required, '1.9');
  assert.equal(denied.explanation.actual, 'odd');
});

test('protocolGate：参数级门与 compare 注入组合（同一方法不同参数）', () => {
  const deny = () => -1;
  assert.equal(protocolGate({ protocol: 'x' }, 'screenshot', {}, deny).ok, true, '无参数时无特性门');
  assert.equal(protocolGate({ protocol: 'x' }, 'screenshot', { stream: true }, deny).ok, false);
  assert.equal(protocolGate({ protocol: 'x' }, 'screenshot', { segmented: true }, deny).ok, false);
  assert.equal(protocolGate({ protocol: 'x' }, 'screenshot', { staleAttempts: 0 }, deny).ok, false);
  assert.equal(protocolGate({ protocol: 'x' }, 'screenshot', { stream: false }, deny).ok, true);
});

// ---------------------------------------------------------------------------
// negotiationPlan / gateMatrix 空输入
// ---------------------------------------------------------------------------

test('negotiationPlan：空请求 → ok=true、无计划、summary 正常', () => {
  const plan = negotiationPlan(OLD, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.plans.length, 0);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.degraded, []);
  assert.deepEqual(plan.steps, []);
  assert.match(plan.summary, /0 个调用|可直接执行/);
  assert.equal(plan.peer.band, 'baseline');
});

test('negotiationPlan：所有 plan 都冻结且可序列化（可缓存/跨进程传输）', () => {
  const plan = negotiationPlan(OLD, {
    calls: [
      { method: 'screenshot', params: { stream: true } },
      { method: 'video.start', params: {} },
    ],
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.plans));
  for (const single of plan.plans) {
    assert.ok(Object.isFrozen(single));
    assert.ok(Object.isFrozen(single.steps));
    assert.ok(Object.isFrozen(single.postconditions));
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(single))).includes('undefined'), false);
  }
});

test('gateMatrix：空方法列表与单方法列表都稳定', () => {
  const empty = gateMatrix(['1.8', '1.9'], []);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.counts['1.8'], { allowed: 0, denied: 0 });
  assert.equal(empty.monotonic, true);
  const single = gateMatrix(['1.8', '1.9'], ['video.start']);
  assert.equal(single.rows.length, 1);
  assert.deepEqual(single.rows[0].cells, { '1.8': false, '1.9': true });
  assert.equal(single.rows[0].floor, '1.9');
  assert.equal(single.rows[0].anyAllowed, true);
  assert.equal(single.rows[0].allAllowed, false);
});

// ---------------------------------------------------------------------------
// 冻结/纯数据
// ---------------------------------------------------------------------------

test('特性相关返回值冻结：featureMatrix / floorDecision / degradationForFeature / explainNegotiation', () => {
  const matrix = featureMatrix(OLD);
  for (const feature of FEATURE_NAMES) {
    assert.ok(Object.isFrozen(matrix[feature].fallback) || matrix[feature].fallback === null);
  }
  const floor = floorDecision('screenshot', { stream: true });
  assert.ok(Object.isFrozen(floor));
  assert.ok(Object.isFrozen(floor.sources));
  const degradation = degradationForFeature('video');
  assert.ok(Object.isFrozen(degradation));
  const explanation = explainNegotiation(protocolGate(OLD, 'video.start', {}));
  assert.ok(Object.isFrozen(explanation));
  assert.ok(Object.isFrozen(explanation.details));
  assert.ok(Object.isFrozen(explanation.remediation));
});

test('negotiate：返回结构含 peer/floor/calls/migration/explanation 五段', () => {
  const result = negotiate(OLD, { calls: [{ method: 'read', params: {} }] });
  assert.deepEqual(Object.keys(result).sort(), ['calls', 'degradations', 'explanation', 'features', 'floor', 'migration', 'missing', 'ok', 'peer', 'verdict'].sort());
  assert.equal(result.peer.band, 'baseline');
  assert.equal(result.floor, '1.9');
  assert.equal(result.calls.length, 1);
  assert.equal(result.migration.upgradeRequired, true);
  assert.equal(result.explanation.ok, false);
  assert.ok(Object.isFrozen(result));
});
