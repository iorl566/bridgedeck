// tests/unit/protocol-compat-runner.test.mjs —— 兼容矩阵 runner 的行为面测试。
//
// 覆盖：
//   1) 版本 × 方法 × feature floor 三张网格的形状与逐格判定；
//   2) 与既有 protocolGate / featureShortfall 的逐格一致性（不出现第二套门禁事实）；
//   3) monotonicity 报告：同 major 向上封闭、跨 major 单独记录、不可解析版本排除；
//   4) 指纹 / 差分 / 派生校验器（含注入错误的负例）；
//   5) 状态面消费用的压缩画像（featureSupportProfile / compatibilitySnapshot）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURE_FLOORS,
  FEATURE_METHODS,
  FEATURE_NAMES,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  proofOf,
} from '../../lib/method-catalog.mjs';
import { compareProtocol, protocolBand, protocolProbes } from '../../lib/protocol.mjs';
import { featureShortfall, protocolGate } from '../../lib/protocol-features.mjs';
import {
  CELL_STATES,
  MONOTONICITY_DIMENSIONS,
  RUNNER_ABI,
  RUNNER_REPORT_VERSION,
  allowedMethodsAt,
  compatibilitySnapshot,
  defaultRunnerReport,
  defaultRunnerVersions,
  deniedMethodsAt,
  describeVersions,
  featureFloorTable,
  featureGateAt,
  featureSupportProfile,
  gatedMethods,
  matrixDiff,
  matrixFingerprint,
  methodFloor,
  methodGateAt,
  methodSupportProfile,
  methodsForFeature,
  monotonicityReport,
  normalizeRunnerOptions,
  runCompatibilityMatrix,
  runnerSelfCheck,
  validateFloorPolicy,
  validateMatrixReport,
  versionDelta,
} from '../../lib/protocol-compat-runner.mjs';

const ALL_METHODS = [...METHOD_NAMES];
const ALL_FEATURES = [...FEATURE_NAMES];

// ---------------------------------------------------------------------------
// 1. 常量与输入归一化
// ---------------------------------------------------------------------------

test('默认版本集合从目录派生：legacy/baseline/current/ahead/aheadMajor 且升序去重', () => {
  const probes = protocolProbes();
  assert.equal(probes.legacy, '1.7');
  assert.equal(probes.baseline, PROTOCOL_BASELINE);
  assert.equal(probes.current, PROTOCOL_CURRENT);
  assert.equal(probes.ahead, '1.10');
  assert.equal(probes.aheadMajor, '2.0');
  const versions = defaultRunnerVersions();
  assert.deepEqual([...versions], ['1.7', '1.8', '1.9', '1.10', '2.0']);
  assert.ok(Object.isFrozen(versions));
  assert.equal(new Set(versions).size, versions.length);
});

test('normalizeRunnerOptions：默认全量、自定义子集去重、比较器可注入', () => {
  const defaults = normalizeRunnerOptions();
  assert.equal(defaults.methods.length, 165);
  assert.equal(defaults.features.length, 15);
  assert.deepEqual([...defaults.versions], [...defaultRunnerVersions()]);
  assert.equal(defaults.compare, compareProtocol);
  assert.equal(defaults.includeInvalid, false);

  const custom = normalizeRunnerOptions({
    versions: ['1.9', '1.8', '1.9'],
    methods: ['click', 'click', 'video.start'],
    features: ['video', 'video'],
    compare: () => 0,
    includeInvalid: true,
  });
  assert.deepEqual([...custom.versions], ['1.9', '1.8']);
  assert.deepEqual([...custom.methods], ['click', 'video.start']);
  assert.deepEqual([...custom.features], ['video']);
  assert.equal(custom.includeInvalid, true);
  assert.ok(Object.isFrozen(custom));
});

test('gatedMethods / methodFloor：29 个方法级特性门与目录一致', () => {
  const gated = gatedMethods();
  assert.equal(gated.length, 29);
  assert.deepEqual(gated, Object.keys(METHOD_FEATURE).sort());
  for (const method of ALL_METHODS) {
    const feature = METHOD_FEATURE[method] || null;
    assert.equal(methodFloor(method), feature ? FEATURE_FLOORS[feature] : null, method);
  }
  assert.equal(methodFloor('click'), null);
  assert.equal(methodFloor('video.start'), '1.9');
  assert.equal(methodFloor('no.such.method'), null);
});

test('methodsForFeature：方法级清单与参数级作用域', () => {
  const video = methodsForFeature('video');
  assert.equal(video.scope, 'method-list');
  assert.deepEqual([...video.methods], [...FEATURE_METHODS.video].sort());
  const unverified = methodsForFeature('unverified');
  assert.equal(unverified.scope, 'all-methods');
  assert.deepEqual([...unverified.methods], ALL_METHODS);
  const capture = methodsForFeature('capture.stream');
  assert.equal(capture.scope, 'method-list');
  // 方法级清单（FEATURE_METHODS）∪ 参数级规则声明的方法
  const expectedCapture = [...new Set([...(FEATURE_METHODS['capture.stream'] || []), 'screenshot'])].sort();
  assert.deepEqual([...capture.methods], expectedCapture);
});

// ---------------------------------------------------------------------------
// 2. 单格判定
// ---------------------------------------------------------------------------

test('methodGateAt：无门方法全版本放行，gated 方法按 floor 判定', () => {
  for (const version of defaultRunnerVersions()) {
    const click = methodGateAt('click', version);
    assert.equal(click.allowed, true, 'click@' + version);
    assert.equal(click.feature, null);
    assert.equal(click.floor, null);
    assert.equal(click.state, 'allowed');
  }
  assert.equal(methodGateAt('video.start', '1.7').allowed, false);
  assert.equal(methodGateAt('video.start', '1.8').allowed, false);
  assert.equal(methodGateAt('video.start', '1.9').allowed, true);
  assert.equal(methodGateAt('video.start', '1.10').allowed, true);
  assert.equal(methodGateAt('video.start', '2.0').allowed, true);
  const cell = methodGateAt('video.start', '1.8');
  assert.equal(cell.feature, 'video');
  assert.equal(cell.floor, '1.9');
  assert.equal(cell.band, 'baseline');
  assert.match(cell.reason, /1\.9/);
});

test('methodGateAt / featureGateAt：不可解析版本一律拒绝并标 unknown', () => {
  for (const version of ['', 'x', '1.x', 'latest', null, undefined]) {
    const cell = methodGateAt('video.start', version);
    assert.equal(cell.allowed, false, String(version));
    assert.equal(cell.state, 'unknown', String(version));
    const feature = featureGateAt('video', version);
    assert.equal(feature.allowed, false, String(version));
    assert.equal(feature.state, 'unknown', String(version));
  }
  for (const state of CELL_STATES) assert.equal(typeof state, 'string');
});

test('featureGateAt：15 个特性在基线全拒、当前全放；未知特性不参与判定', () => {
  for (const feature of ALL_FEATURES) {
    assert.equal(featureGateAt(feature, PROTOCOL_BASELINE).allowed, false, feature + '@baseline');
    assert.equal(featureGateAt(feature, PROTOCOL_CURRENT).allowed, true, feature + '@current');
    assert.equal(featureGateAt(feature, PROTOCOL_CURRENT).floor, '1.9');
  }
  assert.equal(featureGateAt('no-such-feature', '1.8').allowed, true);
  assert.equal(featureGateAt('no-such-feature', '1.8').floor, null);
});

test('methodGateAt / featureGateAt：注入比较器时不依赖真实版本解析', () => {
  const alwaysAllow = () => 1;
  assert.equal(methodGateAt('video.start', 'odd', alwaysAllow).allowed, true);
  assert.equal(featureGateAt('video', 'odd', alwaysAllow).allowed, true);
  const alwaysDeny = () => -1;
  assert.equal(methodGateAt('click', 'odd', alwaysDeny).allowed, true, '无门方法不受比较器影响');
  assert.equal(methodGateAt('video.start', 'odd', alwaysDeny).allowed, false);
});

// ---------------------------------------------------------------------------
// 3. 完整矩阵
// ---------------------------------------------------------------------------

test('runCompatibilityMatrix：5 版本 × 165 方法 × 9 特性，结构完整', () => {
  const report = runCompatibilityMatrix({});
  assert.equal(report.reportVersion, RUNNER_REPORT_VERSION);
  assert.deepEqual([...report.versions], ['1.7', '1.8', '1.9', '1.10', '2.0']);
  assert.equal(report.methods.length, 165);
  assert.equal(report.features.length, 15);
  assert.equal(report.baseline, PROTOCOL_BASELINE);
  assert.equal(report.current, PROTOCOL_CURRENT);
  assert.equal(report.methodRows.length, 165);
  assert.equal(report.featureRows.length, 15);
  assert.equal(report.methodRows[0].cells['1.8'].state, 'allowed');
  assert.ok(report.summary.includes('5 版本'));
  assert.match(report.fingerprint, /^[0-9a-f]{8}$/);
  const wire = JSON.parse(JSON.stringify(report));
  assert.equal(wire.versions.length, 5);
  assert.equal(wire.methodRows.length, 165);
});

test('runCompatibilityMatrix：方法格与真实 protocolGate（空参数）逐格一致', () => {
  const report = runCompatibilityMatrix({ versions: ['1.7', '1.8', '1.9', '1.10'] });
  for (const row of report.methodRows) {
    for (const version of report.versions) {
      const gate = protocolGate({ protocol: version }, row.method, {});
      assert.equal(
        row.cells[version].allowed,
        gate.ok,
        row.method + '@' + version + ' runner 与 protocolGate 不一致',
      );
    }
  }
});

test('runCompatibilityMatrix：特性格与 featureShortfall 定义的可用性逐格一致', () => {
  const report = runCompatibilityMatrix({});
  for (const row of report.featureRows) {
    for (const version of report.versions) {
      const missing = featureShortfall({ protocol: version }, [row.feature]);
      assert.equal(row.cells[version].allowed, missing.length === 0, row.feature + '@' + version);
    }
  }
});

test('runCompatibilityMatrix：1.8 放行 136 方法 / 拒绝 29 个 gated；4 个探针版本计数正确', () => {
  const report = runCompatibilityMatrix({});
  assert.deepEqual(report.counts['1.8'].methods, { allowed: 136, denied: 29, unknown: 0 });
  assert.deepEqual(report.counts['1.7'].methods, { allowed: 136, denied: 29, unknown: 0 });
  assert.deepEqual(report.counts['1.9'].methods, { allowed: 165, denied: 0, unknown: 0 });
  assert.deepEqual(report.counts['1.8'].features, { allowed: 0, denied: 15, unknown: 0 });
  assert.deepEqual(report.counts['1.9'].features, { allowed: 15, denied: 0, unknown: 0 });
  assert.equal(report.counts['2.0'].methods.allowed, 165);
});

test('runCompatibilityMatrix：风险画像只统计该版本可调用方法', () => {
  const report = runCompatibilityMatrix({});
  const at198 = report.obligations['1.8'];
  const at199 = report.obligations['1.9'];
  assert.equal(at198.allowed, 136);
  assert.equal(at199.allowed, 165);
  assert.equal(at199.safe + at199.guarded + at199.risky, 165);
  assert.equal(at199.requiresResolve, 75);
  assert.equal(at199.gated, 29);
  // 1.8 少掉的 29 个 gated 方法里既有 risky 也有 safe：风险画像必须随放行集合变化
  assert.ok(at199.risky >= at198.risky);
  for (const version of report.versions) {
    const profile = report.obligations[version];
    const allowed = report.methodRows.filter((row) => row.cells[version].allowed);
    assert.equal(profile.allowed, allowed.length);
    assert.equal(profile.requiresResolve, allowed.filter((row) => !proofOf(row.method).replayable).length);
  }
});

test('runCompatibilityMatrix：自定义方法/特性子集与空方法列表', () => {
  const subset = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click', 'video.start'], features: ['video'] });
  assert.equal(subset.methodRows.length, 2);
  assert.equal(subset.featureRows.length, 1);
  assert.deepEqual(subset.counts['1.8'].methods, { allowed: 1, denied: 1, unknown: 0 });
  const empty = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: [], features: [] });
  assert.equal(empty.methodRows.length, 0);
  assert.equal(empty.monotonicity.ok, true);
});

test('runCompatibilityMatrix：不可解析版本计入 unknownVersions 且按拒绝处理', () => {
  const report = runCompatibilityMatrix({ versions: ['1.8', '1.9', 'x'], methods: ['click', 'video.start'], features: ['video'] });
  assert.equal(report.monotonicity.unknownVersions.length, 1);
  assert.equal(report.monotonicity.unknownVersions[0], 'x');
  assert.equal(report.monotonicity.complete, false);
  for (const row of report.methodRows) {
    assert.equal(row.cells.x.allowed, false);
    assert.equal(row.cells.x.state, 'unknown');
  }
  assert.equal(report.counts.x.methods.unknown, 2);
  // 不可解析版本不参与同 major 单调对比，所以 ok 仍然为 true
  assert.equal(report.monotonicity.ok, true);
});

// ---------------------------------------------------------------------------
// 4. 单调性报告
// ---------------------------------------------------------------------------

test('monotonicity：默认矩阵同 major 6 组对照全部向上封闭', () => {
  const report = defaultRunnerReport();
  const mono = report.monotonicity;
  assert.deepEqual([...MONOTONICITY_DIMENSIONS], ['method-allowance', 'feature-allowance']);
  assert.equal(mono.ok, true);
  assert.equal(mono.complete, true);
  assert.deepEqual([...mono.order], ['1.7', '1.8', '1.9', '1.10', '2.0']);
  assert.equal(mono.counts.pairs, 6, '1.x 四个版本应有 6 组同 major 对照');
  assert.equal(mono.crossMajorPairs.length, 4, '1.7/1.8/1.9/1.10 各与 2.0 组成跨 major 对照');
  assert.equal(mono.violations.length, 0);
  assert.match(mono.summary, /单调性通过/);
});

test('monotonicityReport：可对任意报告重算，接受直接传入的行结构', () => {
  const report = defaultRunnerReport();
  const mono = monotonicityReport(report);
  assert.equal(mono.ok, true);
  assert.equal(mono.counts.pairs, report.monotonicity.counts.pairs);
  const handBuilt = monotonicityReport({
    versions: ['1.8', '1.9'],
    methodRows: [{
      method: 'video.start',
      feature: 'video',
      floor: '1.9',
      cells: {
        '1.8': { allowed: false, state: 'denied' },
        '1.9': { allowed: true, state: 'allowed' },
      },
    }],
    featureRows: [],
  });
  assert.equal(handBuilt.ok, true);
});

test('monotonicity 负例：高版本反而拒绝会被检为违规', () => {
  const mono = monotonicityReport({
    versions: ['1.8', '1.9'],
    methodRows: [{
      method: 'click',
      feature: null,
      floor: null,
      cells: {
        '1.8': { allowed: true, state: 'allowed' },
        '1.9': { allowed: false, state: 'denied' },
      },
    }],
    featureRows: [{
      feature: 'video',
      floor: '1.9',
      cells: {
        '1.8': { allowed: true, state: 'allowed' },
        '1.9': { allowed: false, state: 'denied' },
      },
    }],
  });
  assert.equal(mono.ok, false);
  assert.equal(mono.methodViolations.length, 1);
  assert.equal(mono.featureViolations.length, 1);
  assert.equal(mono.violations.length, 2);
  assert.match(mono.violations[0].message, /丢失能力/);
  assert.match(mono.summary, /单调性失败/);
});

test('monotonicity：跨 major 只记录对照、不参与向上封闭判定', () => {
  const mono = monotonicityReport({
    versions: ['1.8', '2.0'],
    methodRows: [{
      method: 'click',
      feature: null,
      floor: null,
      cells: {
        '1.8': { allowed: true, state: 'allowed' },
        '2.0': { allowed: false, state: 'denied' },
      },
    }],
    featureRows: [],
  });
  assert.equal(mono.ok, true, '跨 major 不判定单调');
  assert.equal(mono.crossMajorPairs.length, 1);
  assert.equal(mono.counts.pairs, 0);
});

// ---------------------------------------------------------------------------
// 5. 指纹与差分
// ---------------------------------------------------------------------------

test('matrixFingerprint：同输入同指纹，版本/方法/格子变化会改变指纹', () => {
  const first = runCompatibilityMatrix({ versions: ['1.8', '1.9'] });
  const second = runCompatibilityMatrix({ versions: ['1.9', '1.8'] });
  assert.equal(first.fingerprint, second.fingerprint, '版本顺序不应影响指纹');
  assert.equal(matrixFingerprint(first), first.fingerprint);
  const otherVersions = runCompatibilityMatrix({ versions: ['1.8', '1.9', '1.10'] });
  assert.notEqual(otherVersions.fingerprint, first.fingerprint);
  const otherMethods = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click'] });
  assert.notEqual(otherMethods.fingerprint, first.fingerprint);
  const otherFeatures = runCompatibilityMatrix({ versions: ['1.8', '1.9'], features: ['video'] });
  assert.notEqual(otherFeatures.fingerprint, first.fingerprint);
  // 文案字段不参与指纹
  const copy = JSON.parse(JSON.stringify(first));
  for (const row of copy.methodRows) for (const version of copy.versions) row.cells[version].reason = 'changed';
  assert.equal(matrixFingerprint(copy), first.fingerprint);
});

test('matrixDiff：一致矩阵返回 ok，版本/方法集合变化与格子变化都被计数', () => {
  const base = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click', 'video.start'], features: [] });
  const same = runCompatibilityMatrix({ versions: ['1.9', '1.8'], methods: ['video.start', 'click'], features: [] });
  const identical = matrixDiff(base, same);
  assert.equal(identical.ok, true);
  assert.equal(identical.counts.cells, 0);
  assert.match(identical.summary, /矩阵一致/);

  const changed = matrixDiff(base, runCompatibilityMatrix({ versions: ['1.8', '1.9', '1.10'], methods: ['click'], features: [] }));
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.versions.added, ['1.10']);
  assert.deepEqual(changed.methods.removed, ['video.start']);
  assert.ok(changed.summary.includes('矩阵差异'));
});

test('matrixDiff：手工构造的格子变化能精确定位', () => {
  const before = {
    versions: ['1.8', '1.9'],
    methodRows: [{ method: 'click', cells: { '1.8': { allowed: true, state: 'allowed' }, '1.9': { allowed: true, state: 'allowed' } } }],
    featureRows: [],
  };
  const after = JSON.parse(JSON.stringify(before));
  after.methodRows[0].cells['1.9'] = { allowed: false, state: 'denied' };
  const diff = matrixDiff(before, after);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.cellChanges, [{ kind: 'method', name: 'click', version: '1.9', before: '1', after: '0' }]);
});

// ---------------------------------------------------------------------------
// 6. 派生校验器
// ---------------------------------------------------------------------------

test('validateMatrixReport：默认矩阵零问题；runnerSelfCheck 通过', () => {
  const issues = validateMatrixReport(defaultRunnerReport());
  assert.deepEqual(issues, []);
  const check = runnerSelfCheck({});
  assert.equal(check.ok, true);
  assert.equal(check.issues.length, 0);
  assert.equal(check.methods, 165);
  assert.equal(check.features, 15);
  assert.equal(check.monotonic, true);
  assert.match(check.summary, /自检通过/);
});

test('validateMatrixReport：与真实 protocolGate 交叉校验（gate 注入）', () => {
  const report = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click', 'video.start'], features: ['video'] });
  const issues = validateMatrixReport(report, {
    gate: (peer, method, params, compare) => protocolGate(peer, method, params || {}, compare),
  });
  assert.deepEqual(issues, []);
  const badGate = () => ({ ok: true });
  const crossIssues = validateMatrixReport(report, { gate: badGate });
  assert.ok(crossIssues.some((issue) => issue.scope === 'row.gate'), '与错误 gate 对比应报不一致');
});

test('validateMatrixReport 负例：篡改格子/floor/计数/指纹都会被抓到', () => {
  const tamperedCell = JSON.parse(JSON.stringify(defaultRunnerReport()));
  tamperedCell.methodRows.find((row) => row.method === 'video.start').cells['1.8'].allowed = true;
  const cellIssues = validateMatrixReport(tamperedCell);
  assert.ok(cellIssues.some((issue) => issue.scope === 'row.allowed'), '篡改 allowed 未被发现');
  assert.ok(cellIssues.some((issue) => issue.scope === 'row.state'), 'allowed 与 state 不一致未被发现');
  assert.ok(cellIssues.some((issue) => issue.scope === 'fingerprint'), '指纹不一致未被发现');

  const tamperedFloor = JSON.parse(JSON.stringify(defaultRunnerReport()));
  tamperedFloor.methodRows[0].floor = '9.9';
  const floorIssues = validateMatrixReport(tamperedFloor);
  assert.ok(floorIssues.some((issue) => issue.scope === 'row.floor'), '篡改 floor 未被发现');

  const tamperedCounts = JSON.parse(JSON.stringify(defaultRunnerReport()));
  tamperedCounts.counts['1.8'].methods.allowed = 999;
  const countIssues = validateMatrixReport(tamperedCounts);
  assert.ok(countIssues.some((issue) => issue.scope === 'counts.methods'), '篡改计数未被发现');

  const tamperedObligations = JSON.parse(JSON.stringify(defaultRunnerReport()));
  delete tamperedObligations.obligations['1.9'];
  const obligationIssues = validateMatrixReport(tamperedObligations);
  assert.ok(obligationIssues.some((issue) => issue.scope === 'obligations.missing'), '缺少风险画像未被发现');

  const tamperedMonotonicity = JSON.parse(JSON.stringify(defaultRunnerReport()));
  tamperedMonotonicity.monotonicity.ok = false;
  const monotonicIssues = validateMatrixReport(tamperedMonotonicity);
  assert.ok(monotonicIssues.some((issue) => issue.scope === 'monotonicity'), '单调性失败未被发现');
});

test('validateMatrixReport 负例：版本集合与期望不一致、空版本集合', () => {
  const report = runCompatibilityMatrix({ versions: ['1.8', '1.9'] });
  const issues = validateMatrixReport(report, { expectedVersions: ['1.8', '1.9', '1.10'] });
  assert.ok(issues.some((issue) => issue.scope === 'report.versions'));
  const empty = validateMatrixReport({ versions: [], methods: [], features: [], methodRows: [], featureRows: [], counts: {} });
  assert.ok(empty.some((issue) => issue.scope === 'report.versions'));
});

test('validateFloorPolicy：目录策略成立；注入总是放行的比较器会被抓到', () => {
  assert.deepEqual(validateFloorPolicy(), []);
  const alwaysAllow = () => 1;
  const issues = validateFloorPolicy(alwaysAllow);
  assert.ok(issues.length >= 15, '基线允许特性必须被发现');
  assert.ok(issues.every((issue) => issue.scope === 'floor.baseline' || issue.scope === 'floor.current'));
});

// ---------------------------------------------------------------------------
// 7. 状态面压缩画像
// ---------------------------------------------------------------------------

test('featureSupportProfile：15 个特性首版 1.9、基线拒绝、当前允许、单调', () => {
  for (const feature of ALL_FEATURES) {
    const profile = featureSupportProfile(feature);
    assert.equal(profile.feature, feature);
    assert.equal(profile.known, true);
    assert.equal(profile.floor, '1.9');
    assert.equal(profile.baselineAllowed, false, feature + ' 基线不应允许');
    assert.equal(profile.currentAllowed, true, feature + ' 当前协议应允许');
    assert.equal(profile.firstSupporting, '1.9');
    assert.equal(profile.monotone, true);
    assert.ok(Object.isFrozen(profile.versions));
    assert.equal(profile.scope, methodsForFeature(feature).scope);
    const wire = JSON.parse(JSON.stringify(profile));
    assert.equal(wire.versions['1.9'], true);
  }
  const unknown = featureSupportProfile('no-such-feature');
  assert.equal(unknown.known, false);
  assert.equal(unknown.floor, null);
  assert.equal(unknown.firstSupporting, null);
});

test('methodSupportProfile：gated 方法基线拒绝、无门方法全放行', () => {
  for (const method of ALL_METHODS) {
    const profile = methodSupportProfile(method);
    assert.equal(profile.method, method);
    assert.equal(profile.floor, methodFloor(method));
    assert.equal(profile.currentAllowed, true, method + ' 当前协议应放行');
    if (methodFloor(method) === null) {
      assert.equal(profile.baselineAllowed, true, method + ' 无门方法基线应放行');
      assert.equal(profile.firstSupporting, '1.7');
    } else {
      assert.equal(profile.baselineAllowed, false, method + ' gated 方法基线不应放行');
      assert.equal(profile.firstSupporting, '1.9');
    }
  }
});

test('allowedMethodsAt / deniedMethodsAt：与 gated 方法集合精确互补', () => {
  const at198 = allowedMethodsAt('1.8');
  const denied198 = deniedMethodsAt('1.8');
  assert.equal(at198.length, 136);
  assert.equal(denied198.length, 29);
  assert.deepEqual(denied198.map((item) => item.method).sort(), gatedMethods());
  for (const item of denied198) {
    assert.equal(item.floor, '1.9');
    assert.ok(item.feature);
    assert.match(item.reason, /1\.9/);
  }
  assert.equal(allowedMethodsAt('1.9').length, 165);
  assert.equal(deniedMethodsAt('1.9').length, 0);
  assert.equal(allowedMethodsAt('x').length, 0);
});

test('describeVersions：分带/方向/计数/结论', () => {
  const rows = describeVersions();
  assert.equal(rows.length, 5);
  const byVersion = Object.fromEntries(rows.map((row) => [row.version, row]));
  assert.equal(byVersion['1.7'].band, 'legacy');
  assert.equal(byVersion['1.8'].band, 'baseline');
  assert.equal(byVersion['1.9'].band, 'current');
  assert.equal(byVersion['1.10'].band, 'ahead-minor');
  assert.equal(byVersion['2.0'].band, 'ahead-major');
  assert.equal(byVersion['1.9'].direction, 'same');
  assert.equal(byVersion['1.8'].direction, 'older');
  assert.equal(byVersion['1.9'].verdict, 'compatible');
  assert.equal(byVersion['1.8'].verdict, 'incompatible');
  for (const row of rows) {
    assert.equal(row.methodsAllowed + row.methodsDenied, 165);
    assert.equal(row.featuresAllowed + row.featuresDenied, 15);
    assert.ok(row.obligations);
  }
});

test('featureFloorTable：15 行 floor 与方法清单，供文档/校验复用', () => {
  const rows = featureFloorTable();
  assert.equal(rows.length, 15);
  for (const row of rows) {
    assert.equal(row.floor, FEATURE_FLOORS[row.feature]);
    assert.equal(row.removableAt, row.floor);
    assert.deepEqual([...row.gatedMethods], [...(FEATURE_METHODS[row.feature] || [])].sort());
    assert.equal(typeof row.label, 'string');
  }
});

test('compatibilitySnapshot：压缩报告可 JSON 序列化且自检通过', () => {
  const snapshot = compatibilitySnapshot();
  assert.equal(snapshot.methods, 165);
  assert.equal(snapshot.features, 15);
  assert.equal(snapshot.monotonic, true);
  assert.equal(snapshot.monotonicity.violations, 0);
  assert.equal(snapshot.selfCheck.ok, true);
  assert.equal(snapshot.perVersion.length, 5);
  assert.match(snapshot.fingerprint, /^[0-9a-f]{8}$/);
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.equal(wire.perVersion[2].version, '1.9');
});

test('versionDelta：1.8→1.9 获得 15 特性/29 方法，反向丢失同样数量', () => {
  const up = versionDelta('1.8', '1.9');
  assert.equal(up.direction, 'newer');
  assert.equal(up.counts.gainedFeatures, 15);
  assert.equal(up.counts.gainedMethods, 29);
  assert.equal(up.counts.lostMethods, 0);
  assert.equal(up.gainedFeatures.length, 15);
  for (const item of up.gainedFeatures) assert.equal(item.floor, '1.9');
  const down = versionDelta('1.9', '1.8');
  assert.equal(down.direction, 'older');
  assert.equal(down.counts.lostFeatures, 15);
  assert.equal(down.counts.lostMethods, 29);
  const same = versionDelta('1.9', '1.9');
  assert.equal(same.counts.gainedMethods + same.counts.lostMethods, 0);
});

test('RUNNER_ABI 暴露报告版本与维度常量', () => {
  assert.equal(RUNNER_ABI.reportVersion, RUNNER_REPORT_VERSION);
  assert.deepEqual([...RUNNER_ABI.cellStates], ['allowed', 'denied', 'unknown']);
  assert.deepEqual([...RUNNER_ABI.monotonicityDimensions], ['method-allowance', 'feature-allowance']);
  assert.ok(Object.isFrozen(RUNNER_ABI));
});
