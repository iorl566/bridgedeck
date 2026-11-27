// tests/unit/protocol-version-matrix.test.mjs —— 版本 × 方法 × 特性 的穷举矩阵。
//
// 目标：
//   1. gateMatrix 覆盖 4 个可解析版本 × 165 方法，放行集合必须等于 featureShortfall 定义；
//   2. 单调性：同 major 内更高 minor 不应丢失能力（1.7 ⊆ 1.8 ⊆ 1.9 ⊆ 1.10）；
//   3. 对每个版本 × 每个特性触发调用：negotiationPlan 的 allowed/degraded/blocked
//      与 degradationOfCall + protocolGate 完全一致；
//   4. 降级推荐调用在同一版本上必须真的放行；blocked 调用必须给升级步骤；
//   5. 版本分带/偏斜/协商判定与 compareProtocol 交叉一致；
//   6. 1.9 当前版本对全部 9 个触发调用 compatible，1.8/1.7 只允许降级或升级。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_NAMES,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  compatibilityReport,
  degradationForFeature,
  degradationOfCall,
  featureShortfall,
  featuresForCall,
  gateMatrix,
  migrationAdvice,
  negotiate,
  negotiationPlan,
  protocolGate,
} from '../../lib/protocol-features.mjs';
import {
  compareProtocol,
  isProtocolKnown,
  protocolBand,
  protocolSkew,
} from '../../lib/protocol.mjs';

const VERSIONS = Object.freeze(['1.0', '1.7', '1.8', '1.9', '1.10', '1.11', '2.0', '', 'x']);
const PARSEABLE = Object.freeze(['1.0', '1.7', '1.8', '1.9', '1.10', '1.11', '2.0']);
const MONOTONIC_SET = Object.freeze(['1.7', '1.8', '1.9', '1.10']);

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
  // ---- BSK 0.5.0 对齐的 6 个门 ----
  borrow_confirmation_timeout: ['tab.borrow', { tabId: 123, confirmationTimeoutMs: 30000 }],
  interaction_policy: ['request-help', { reason: 'needs human' }],
  incognito_sessions: ['session.start', { incognito: true }],
  dialog_control: ['dialog.accept', { tabId: 123 }],
  click_move_click: ['drag', { from: '@e1', to: '@e2', mode: 'click-move-click' }],
  target_control: ['cooperate.sync', { policy: 'target' }],
});

const DEgRADABLE = Object.freeze(FEATURE_NAMES.filter((feature) => FEATURE_FALLBACKS[feature].kind !== 'none'));

// ---------------------------------------------------------------------------
// gateMatrix：版本 × 方法
// ---------------------------------------------------------------------------

test('gateMatrix：4 版本 × 165 方法，放行集合与 featureShortfall 定义完全一致', () => {
  const matrix = gateMatrix(MONOTONIC_SET);
  assert.deepEqual([...matrix.versions], [...MONOTONIC_SET]);
  assert.equal(matrix.methods.length, 165);
  assert.equal(matrix.rows.length, 165);
  assert.deepEqual(matrix.rows.map((row) => row.method), METHOD_NAMES);
  for (const row of matrix.rows) {
    const features = featuresForCall(row.method, {});
    for (const version of MONOTONIC_SET) {
      const expected = featureShortfall({ protocol: version }, features).length === 0;
      assert.equal(row.cells[version], expected, row.method + '@' + version);
      assert.equal(row.cells[version], protocolGate({ protocol: version }, row.method, {}).ok, row.method + '@' + version);
    }
    assert.equal(row.allowed, MONOTONIC_SET.filter((version) => row.cells[version]).length);
    assert.equal(row.floor, METHOD_FEATURE[row.method] ? FEATURE_FLOORS[METHOD_FEATURE[row.method]] : null, row.method);
  }
  assert.deepEqual(matrix.counts['1.7'], { allowed: 136, denied: 29 });
  assert.deepEqual(matrix.counts['1.8'], { allowed: 136, denied: 29 });
  assert.deepEqual(matrix.counts['1.9'], { allowed: 165, denied: 0 });
  assert.deepEqual(matrix.counts['1.10'], { allowed: 165, denied: 0 });
});

test('gateMatrix：单调性成立——同 major 更高 minor 不丢能力，且无违反项', () => {
  const matrix = gateMatrix(MONOTONIC_SET);
  assert.equal(matrix.monotonic, true);
  assert.deepEqual(matrix.violations, []);
  for (const row of matrix.rows) {
    const flags = MONOTONIC_SET.map((version) => row.cells[version]);
    // 一旦某版本放行，后续（更高）版本必须全部放行。
    const firstAllowed = flags.indexOf(true);
    if (firstAllowed === -1) continue;
    for (let index = firstAllowed; index < flags.length; index += 1) {
      assert.equal(flags[index], true, row.method + ' 在更高版本上丢能力');
    }
  }
});

test('gateMatrix：无 floor 的方法在所有可解析版本都放行；gated 方法只在 >= 1.9 放行', () => {
  const matrix = gateMatrix(PARSEABLE);
  for (const row of matrix.rows) {
    if (!row.floor) {
      assert.equal(row.allAllowed, true, row.method + ' 无方法级 floor 应在所有可解析版本放行');
      assert.equal(row.cells['1.0'], true, row.method);
      continue;
    }
    assert.equal(row.floor, '1.9', row.method);
    assert.equal(row.cells['1.8'], false, row.method + ' 1.8 必须拒绝 gated 方法');
    assert.equal(row.cells['1.9'], true, row.method);
    assert.equal(row.cells['1.10'], true, row.method);
    assert.equal(row.cells['1.11'], true, row.method);
    assert.equal(row.cells['2.0'], true, row.method, 'floor 函数本身不拒绝 major 偏斜（hello 层负责）');
  }
  // 版本不可解析时：gated 全拒、非 gated 全放（与 protocolGate 的 unknown 处理一致）。
  const unknownMatrix = gateMatrix(['', 'x']);
  for (const row of unknownMatrix.rows) {
    assert.equal(row.cells[''], !row.floor, row.method + ' 未知协议应拒绝 gated 方法');
    assert.equal(row.cells['x'], !row.floor, row.method);
  }
});

test('gateMatrix：可以只传方法子集（诊断页按工具分组展示）', () => {
  const subset = ['click', 'video.start', 'screenshot', 'observe'];
  const matrix = gateMatrix(['1.8', '1.9'], subset);
  assert.deepEqual([...matrix.methods], subset);
  assert.equal(matrix.rows.length, 4);
  assert.deepEqual(matrix.rows.map((row) => row.method), subset);
  assert.equal(matrix.rows.find((row) => row.method === 'click').cells['1.8'], true);
  assert.equal(matrix.rows.find((row) => row.method === 'video.start').cells['1.8'], false);
});

// ---------------------------------------------------------------------------
// 版本分带 / 偏斜矩阵
// ---------------------------------------------------------------------------

test('版本矩阵：band 与 compareProtocol 交叉一致', () => {
  for (const version of VERSIONS) {
    const band = protocolBand(version);
    if (version === '' || version === 'x') {
      assert.equal(band, 'unknown', version);
      assert.equal(isProtocolKnown(version), false, version);
      continue;
    }
    assert.equal(isProtocolKnown(version), true, version);
    const baselineOrder = compareProtocol(version, PROTOCOL_BASELINE);
    const currentOrder = compareProtocol(version, PROTOCOL_CURRENT);
    const expected = baselineOrder < 0 ? 'legacy' : baselineOrder === 0 ? 'baseline'
      : currentOrder < 0 ? 'intermediate' : currentOrder === 0 ? 'current'
        : String(version).split('.')[0] === String(PROTOCOL_CURRENT).split('.')[0] ? 'ahead-minor' : 'ahead-major';
    assert.equal(band, expected, version + ' band 计算错误');
  }
});

test('版本矩阵：skew severity 与相对关系一致（unknown/major 致命，旧版 warn，新版 info）', () => {
  for (const version of PARSEABLE) {
    const skew = protocolSkew(version, PROTOCOL_CURRENT);
    const order = compareProtocol(version, PROTOCOL_CURRENT);
    if (order === 0) {
      assert.equal(skew.relation, 'equal');
      assert.equal(skew.severity, 'none');
    } else if (String(version).split('.')[0] !== String(PROTOCOL_CURRENT).split('.')[0]) {
      assert.equal(skew.relation, 'major-skew');
      assert.equal(skew.severity, 'fatal');
    } else if (order < 0) {
      assert.equal(skew.relation, 'actual-older');
      assert.equal(skew.severity, 'warn');
    } else {
      assert.equal(skew.relation, 'actual-newer');
      assert.equal(skew.severity, 'info');
    }
  }
  for (const version of ['', 'x']) {
    const skew = protocolSkew(version, PROTOCOL_CURRENT);
    assert.equal(skew.relation, 'unknown');
    assert.equal(skew.severity, 'fatal');
    assert.equal(skew.known, false);
  }
});

// ---------------------------------------------------------------------------
// negotiate / negotiationPlan：版本 × 特性触发
// ---------------------------------------------------------------------------

test('negotiate：1.9/1.10 全触发 compatible，1.8/1.7 降级或阻断，未知版本全不兼容', () => {
  for (const feature of FEATURE_NAMES) {
    const [method, params] = TRIGGERS[feature];
    for (const version of ['1.9', '1.10']) {
      const result = negotiate({ protocol: version }, { method, params });
      assert.equal(result.verdict, 'compatible', feature + '@' + version);
      assert.equal(result.ok, true);
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.degradations, []);
    }
    for (const version of ['1.7', '1.8']) {
      const result = negotiate({ protocol: version }, { method, params });
      assert.deepEqual([...result.missing], [feature], feature + '@' + version);
      const degradable = FEATURE_FALLBACKS[feature].kind !== 'none';
      if (feature === 'plan') {
        // plan 的降级是“调用方拆步骤”，不是可执行替代调用 → 不报 degraded。
        assert.equal(result.verdict, 'incompatible', feature + '@' + version);
      } else if (degradable) {
        assert.equal(result.verdict, 'degraded', feature + '@' + version);
        assert.equal(result.degradations.length, 1);
      } else {
        assert.equal(result.verdict, 'incompatible', feature + '@' + version);
        assert.deepEqual(result.degradations, []);
      }
    }
    for (const version of ['', 'x']) {
      const result = negotiate({ protocol: version }, { method, params });
      assert.equal(result.ok, false, feature + '@unknown');
      assert.ok(result.missing.includes(feature), feature + '@unknown');
    }
  }
});

test('negotiationPlan：allowed 计划直接给原调用 + 后置条件；degraded 给可执行替代；blocked 给升级步骤', () => {
  // 当前协议：全部 allowed
  for (const feature of FEATURE_NAMES) {
    const [method, params] = TRIGGERS[feature];
    const plan = negotiationPlan({ protocol: PROTOCOL_CURRENT }, { method, params });
    assert.equal(plan.ok, true, feature);
    assert.equal(plan.plans.length, 1);
    const single = plan.plans[0];
    assert.equal(single.method, method);
    assert.equal(single.verdict, 'allowed');
    assert.equal(single.recommendedCall.method, method);
    assert.deepEqual({ ...single.recommendedCall.params }, { ...params });
    assert.deepEqual(single.droppedParams, []);
    assert.ok(single.steps.length >= 1);
    assert.ok(single.postconditions.length >= 1, feature + ' 缺少后置条件');
  }

  // 1.8：可降级的给替代调用，不可降级的 blocked 并给升级步骤
  for (const feature of FEATURE_NAMES) {
    const [method, params] = TRIGGERS[feature];
    const degradation = degradationOfCall({ protocol: PROTOCOL_BASELINE }, method, params);
    if (degradation.degradable) {
      const plan = negotiationPlan({ protocol: PROTOCOL_BASELINE }, { method, params });
      const single = plan.plans[0];
      assert.equal(single.verdict, 'degraded', feature);
      assert.equal(single.recommendedCall.method, degradation.degraded.method);
      assert.deepEqual({ ...single.recommendedCall.params }, { ...degradation.degraded.params });
      assert.deepEqual([...single.droppedParams], [...degradation.degraded.droppedParams]);
      // 推荐调用必须在同一版本上真的放行。
      assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, single.recommendedCall.method, single.recommendedCall.params).ok, true, feature + ' 降级推荐调用被拒绝');
      if (degradation.degraded.verification) assert.equal(single.verification.method, degradation.degraded.verification.method);
    } else if (FEATURE_FALLBACKS[feature].kind === 'none') {
      const plan = negotiationPlan({ protocol: PROTOCOL_BASELINE }, { method, params });
      const single = plan.plans[0];
      assert.equal(single.verdict, 'blocked', feature);
      assert.equal(single.recommendedCall, null);
      assert.ok(single.steps.some((step) => /升级|重载|重连/.test(step)), feature + ' blocked 缺少升级步骤');
      assert.deepEqual([...single.missing], [feature]);
    }
  }
});

test('negotiationPlan：混合调用按顺序给三态计划，summary 指明必须升级的缺口', () => {
  const plan = negotiationPlan({ protocol: PROTOCOL_BASELINE }, {
    calls: [
      { method: 'click', params: { ref: '@e1' } },
      { method: 'screenshot', params: { stream: true } },
      { method: 'read', params: {} },
      { method: 'video.start', params: {} },
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.plans.length, 4);
  assert.deepEqual(plan.plans.map((item) => item.verdict), ['allowed', 'degraded', 'degraded', 'blocked']);
  assert.deepEqual(plan.plans.map((item) => item.method), ['click', 'screenshot', 'read', 'video.start']);
  assert.equal(plan.plans[0].recommendedCall.method, 'click');
  assert.equal(plan.plans[1].recommendedCall.method, 'screenshot');
  assert.equal(plan.plans[2].recommendedCall.method, 'observe');
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.degraded.length, 2);
  assert.match(plan.summary, /video/);
  assert.ok(plan.steps.length >= 1);
});

test('negotiationPlan：当前协议下 summary 为“可直接执行”，没有 degraded/blocked', () => {
  const plan = negotiationPlan({ protocol: PROTOCOL_CURRENT }, {
    calls: [{ method: 'video.start', params: {} }, { method: 'screenshot', params: { stream: true } }],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.verdict, 'compatible');
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.degraded, []);
  assert.match(plan.summary, /可直接执行/);
  for (const single of plan.plans) assert.equal(single.verdict, 'allowed');
});

test('negotiationPlan：未知协议不谎报 compatible（缺口全部 blocked 或降级都依赖无特性调用）', () => {
  const plan = negotiationPlan({ protocol: 'x' }, { calls: [{ method: 'video.start', params: {} }, { method: 'read', params: {} }] });
  assert.equal(plan.ok, false);
  const video = plan.plans.find((item) => item.method === 'video.start');
  const read = plan.plans.find((item) => item.method === 'read');
  assert.equal(video.verdict, 'blocked');
  // read → observe 是无特性调用，未知协议下闸门也放行（与既有 unknown 处理一致）。
  assert.equal(read.verdict, 'degraded');
  assert.equal(read.recommendedCall.method, 'observe');
});

// ---------------------------------------------------------------------------
// 全量一致性：每个版本 × 每个触发调用
// ---------------------------------------------------------------------------

test('全量：版本 × 特性触发，negotiate 的 missing/floor 与闸门逐项一致', () => {
  for (const version of VERSIONS) {
    const peer = { protocol: version };
    for (const feature of FEATURE_NAMES) {
      const [method, params] = TRIGGERS[feature];
      const decision = protocolGate(peer, method, params);
      const result = negotiate(peer, { method, params });
      assert.equal(result.ok, decision.ok, feature + '@' + version);
      if (decision.ok) {
        assert.deepEqual(result.missing, []);
        assert.equal(result.floor, decision.floor);
        continue;
      }
      assert.deepEqual([...result.missing], [...decision.missing].map((item) => item.feature), feature + '@' + version);
      assert.equal(result.floor, decision.floor, feature + '@' + version);
      assert.equal(result.explanation.ok, false);
      assert.equal(result.migration.upgradeRequired, true);
      assert.ok(result.migration.features.length >= 1);
    }
  }
});

test('全量：165 方法 × 9 版本，protocolGate 放行 ⇔ features 全满足（无特例）', () => {
  let checked = 0;
  for (const version of VERSIONS) {
    const peer = { protocol: version };
    for (const method of METHOD_NAMES) {
      const decision = protocolGate(peer, method, {});
      const expected = featureShortfall(peer, featuresForCall(method, {})).length === 0;
      assert.equal(decision.ok, expected, method + '@' + version);
      checked += 1;
    }
  }
  assert.equal(checked, VERSIONS.length * METHOD_NAMES.length);
});

test('全量：可降级特性的候选调用在 1.7/1.8/未知协议上复核放行', () => {
  for (const feature of DEgRADABLE) {
    const [method, params] = TRIGGERS[feature];
    for (const version of ['1.7', '1.8', '', 'x']) {
      const plan = degradationOfCall({ protocol: version }, method, params);
      if (!plan.degradable) continue; // plan 的 decompose 不可执行
      const candidate = plan.degraded;
      assert.equal(protocolGate({ protocol: version }, candidate.method, candidate.params).ok, true, feature + '@' + version);
    }
  }
});

// ---------------------------------------------------------------------------
// compatibilityReport / migrationAdvice：版本矩阵
// ---------------------------------------------------------------------------

test('compatibilityReport：版本矩阵里只有 1.9/1.10 兼容，其余都要升级', () => {
  for (const version of VERSIONS) {
    const report = compatibilityReport({ protocol: version });
    const order = compareProtocol(version, PROTOCOL_CURRENT);
    if (order !== null && order >= 0) {
      assert.equal(report.verdict, 'compatible', version);
      assert.equal(report.counts.available, 15, version);
      assert.equal(report.migration.upgradeRequired, false, version);
    } else {
      assert.equal(report.verdict, 'incompatible', version);
      assert.equal(report.counts.available, 0, version);
      assert.equal(report.migration.upgradeRequired, true, version);
      assert.equal(report.degradable.length, 11, version);
    }
  }
});

test('migrationAdvice：旧版本给出全部 15 个特性缺口；2.0 不需要升级但 major 偏斜致命', () => {
  for (const version of ['1.0', '1.7', '1.8', '', 'x']) {
    const advice = migrationAdvice({ protocol: version });
    assert.equal(advice.upgradeRequired, true, version);
    assert.equal(advice.missingCount, 15, version);
    assert.equal(advice.upgradeTo, PROTOCOL_CURRENT, version);
    assert.ok(advice.steps.length >= 5, version);
  }
  const major = migrationAdvice({ protocol: '2.0' });
  assert.equal(major.upgradeRequired, false, '2.0 的 floor 已满足');
  assert.equal(major.missingCount, 0);
  assert.equal(major.skew.severity, 'fatal', '但 major 偏斜需要 daemon hello 层拒绝');
});

test('特性降级声明与版本矩阵一致：floor 全部 1.9，低版本全部不可用', () => {
  for (const feature of FEATURE_NAMES) {
    assert.equal(FEATURE_FLOORS[feature], '1.9');
    for (const version of ['1.0', '1.7', '1.8', '', 'x']) {
      assert.equal(protocolBand(version) === 'current' || protocolBand(version) === 'ahead-minor' || protocolBand(version) === 'ahead-major', false, version);
      const info = degradationForFeature(feature);
      assert.equal(info.floor, '1.9');
      const gate = protocolGate({ protocol: version }, ...TRIGGERS[feature]);
      assert.equal(gate.ok, false, feature + '@' + version);
    }
  }
});
