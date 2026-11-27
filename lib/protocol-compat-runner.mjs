// lib/protocol-compat-runner.mjs —— 兼容矩阵 runner：版本 × 方法 × feature floor。
//
// 第一轮的兼容面是三张静态表：
//   - lib/protocol-features.mjs 的 compatibilityMatrix（版本 × 9 个特性）；
//   - gateMatrix（版本 × 165 个方法）；
//   - protocolGate（单次调用的门禁）。
// 它们各自能回答一个问题，但没有一个“跑一遍完整矩阵并自证单调性”的执行器：
// 谁都不能保证“更高协议不会丢失已有能力”，也没法把矩阵差异做成可回归的报告。
//
// 本文件就是那个 runner：
//   1) 归一化输入（版本集合 / 方法集合 / 特性集合 / 比较器）；
//   2) 跑三张网格：
//        version × method —— 方法级 feature floor 放行矩阵；
//        version × feature —— 特性 floor 可用矩阵；
//        version × obligation —— 可调用方法的幂等/可重放风险画像；
//   3) 产出 monotonicity 报告：同 major 内，低版本的放行集合必须是高版本放行集合的子集；
//   4) 产出派生校验（validateMatrixReport / runnerSelfCheck）：
//        逐格与 floor 独立推导比对、基线/当前协议策略比对、单调性自证；
//   5) 提供稳定指纹与矩阵差分（同输入必须同指纹，便于缓存与回归）。
//
// 依赖方向：本文件只 import lib/method-catalog.mjs（事实）、lib/protocol.mjs（版本序）
// 与 lib/protocol-proof.mjs（风险画像）；protocol-features.mjs 反向 import 本文件
// 把 support 画像带进 /health、daemon.status 与 SDK/CLI 输出，避免循环依赖。
//
// 默认语义不变：纯增量模块。它不 dispatch、不改任何既有门禁结果，只把门禁结果
// 组织成可执行报告；现有 compatibilityMatrix / gateMatrix / protocolGate 行为逐项不变。

import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_METHODS,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  proofOf,
} from './method-catalog.mjs';
import {
  compareProtocol,
  isProtocolKnown,
  parseProtocol,
  protocolBand,
  protocolDirection,
  protocolProbes,
  sortProtocolVersions,
} from './protocol.mjs';
import { obligationSummary } from './protocol-proof.mjs';

// ===========================================================================
// 一、常量与输入归一化
// ===========================================================================

/** runner 报告格式版本（字段只增不改；消费方可据此判断结构）。 */
export const RUNNER_REPORT_VERSION = 1;

/** 单元格状态：allowed=放行；denied=拒绝；unknown=版本不可解析（按拒绝处理但单独计数）。 */
export const CELL_STATES = Object.freeze(['allowed', 'denied', 'unknown']);

/** 单调性维度。 */
export const MONOTONICITY_DIMENSIONS = Object.freeze(['method-allowance', 'feature-allowance']);

/** 默认探针版本：legacy / baseline / current / ahead / aheadMajor，全部从目录派生。 */
export function defaultRunnerVersions() {
  const probes = protocolProbes();
  const versions = new Set();
  for (const version of Object.values(probes)) {
    if (version === null || version === undefined) continue;
    versions.add(String(version));
  }
  return Object.freeze(sortProtocolVersions([...versions]));
}

/** 目录派生出的命令名称集合（runner 默认只跑方法级 floor，参数级 floor 需要显式参数）。 */
export function gatedMethods() {
  return Object.freeze(Object.keys(METHOD_FEATURE).sort());
}

/** 特性 → 需要该特性的方法（方法级 + 参数级规则里声明了方法的部分）。 */
export function methodsForFeature(feature) {
  const key = String(feature || '');
  const set = new Set(FEATURE_METHODS[key] || []);
  let scopedToAll = false;
  for (const rule of FEATURE_PARAM_RULES) {
    if (rule.feature !== key) continue;
    if (Array.isArray(rule.methods) && rule.methods.length) for (const method of rule.methods) set.add(method);
    else scopedToAll = true;
  }
  const methods = scopedToAll ? [...METHOD_NAMES] : [...set].sort();
  return Object.freeze({
    feature: key,
    scope: scopedToAll ? 'all-methods' : 'method-list',
    methods: Object.freeze(methods),
  });
}

function uniqueStrings(list) {
  return Object.freeze([...new Set((list || []).map((item) => String(item)))]);
}

/**
 * 归一化 runner 输入。
 * @param {{
 *   versions?: string[], methods?: string[], features?: string[],
 *   compare?: Function, includeInvalid?: boolean,
 * }} [options]
 */
export function normalizeRunnerOptions(options = {}) {
  const bag = options && typeof options === 'object' ? options : {};
  const versions = Array.isArray(bag.versions) && bag.versions.length
    ? bag.versions.map((version) => String(version))
    : [...defaultRunnerVersions()];
  // 显式空数组 = 空矩阵（测试/差分需要）；省略才是全量。
  const methods = Array.isArray(bag.methods)
    ? bag.methods.map((method) => String(method))
    : [...METHOD_NAMES];
  const features = Array.isArray(bag.features)
    ? bag.features.map((feature) => String(feature))
    : [...FEATURE_NAMES];
  const compare = typeof bag.compare === 'function' ? bag.compare : compareProtocol;
  return Object.freeze({
    versions: uniqueStrings(versions),
    methods: uniqueStrings(methods),
    features: uniqueStrings(features),
    compare,
    includeInvalid: bag.includeInvalid === true,
  });
}

/** 方法级 floor（无方法级特性门返回 null；参数级门需要真实调用参数，不在矩阵里猜）。 */
export function methodFloor(method) {
  const feature = METHOD_FEATURE[String(method || '')] || null;
  return feature ? FEATURE_FLOORS[feature] : null;
}

/** 方法级特性门名称（无门返回 null）。 */
export function methodFeature(method) {
  return METHOD_FEATURE[String(method || '')] || null;
}

// ===========================================================================
// 二、单格判定：methodGateAt / featureGateAt
//
// 这两条是本模块唯一的“判定事实”：allowed 只由 feature floor 的比较决定，
// 与 lib/protocol-features.mjs 的 protocolGate（空参数）逐格等价。runner 不复制
// 参数级规则；参数级特性由 protocol-features 的单调用闸门负责。
// ===========================================================================

/**
 * 某方法在某协议版本下是否放行（空参数口径）。
 * @returns {{method:string, version:string, feature:string|null, floor:string|null,
 *   allowed:boolean, state:string, band:string, order:number|null, reason:string}}
 */
export function methodGateAt(method, version, compare = compareProtocol) {
  const name = String(method || '');
  const feature = methodFeature(name);
  const floor = feature ? FEATURE_FLOORS[feature] : null;
  const raw = String(version);
  // 注入自定义比较器时（测试/模拟对端）不强制解析版本：与 protocolGate 的口径一致。
  const customCompare = typeof compare === 'function' && compare !== compareProtocol;
  if (parseProtocol(raw) === null && !customCompare) {
    return Object.freeze({
      method: name, version: raw, feature, floor, allowed: false, state: 'unknown',
      band: 'unknown', order: null, reason: '协议版本不可解析：按不兼容处理',
    });
  }
  if (!floor || typeof compare !== 'function') {
    return Object.freeze({
      method: name, version: raw, feature, floor, allowed: true, state: 'allowed',
      band: protocolBand(raw), order: null, reason: feature ? '无可用比较器，按放行兜底' : '该方法没有方法级特性门',
    });
  }
  const order = compare(raw, floor);
  const allowed = order !== null && order >= 0;
  return Object.freeze({
    method: name,
    version: raw,
    feature,
    floor,
    allowed,
    state: allowed ? 'allowed' : 'denied',
    band: protocolBand(raw),
    order,
    reason: allowed
      ? '版本 ' + raw + ' ≥ 特性 ' + feature + ' 的最低协议 ' + floor
      : '版本 ' + raw + ' < 特性 ' + feature + ' 的最低协议 ' + floor,
  });
}

/** 某特性在某协议版本下是否可用（floor 比较；未知特性按可用，与 featureShortfall 口径一致）。 */
export function featureGateAt(feature, version, compare = compareProtocol) {
  const key = String(feature || '');
  const floor = FEATURE_FLOORS[key] || null;
  const raw = String(version);
  const customCompare = typeof compare === 'function' && compare !== compareProtocol;
  if (parseProtocol(raw) === null && !customCompare) {
    return Object.freeze({
      feature: key, version: raw, floor, allowed: false, state: 'unknown', band: 'unknown', order: null,
      reason: '协议版本不可解析：按不可用处理',
    });
  }
  if (!floor) {
    return Object.freeze({
      feature: key, version: raw, floor: null, allowed: true, state: 'allowed', band: protocolBand(raw), order: null,
      reason: '未登记的特性不参与判定',
    });
  }
  const order = typeof compare === 'function' ? compare(raw, floor) : null;
  const allowed = order !== null && order >= 0;
  return Object.freeze({
    feature: key,
    version: raw,
    floor,
    allowed,
    state: allowed ? 'allowed' : 'denied',
    band: protocolBand(raw),
    order,
    reason: allowed ? '版本 ' + raw + ' ≥ 最低协议 ' + floor : '版本 ' + raw + ' < 最低协议 ' + floor,
  });
}

// ===========================================================================
// 三、网格构造
// ===========================================================================

function matrixRowForMethod(method, versions, compare) {
  const feature = methodFeature(method);
  const floor = feature ? FEATURE_FLOORS[feature] : null;
  const cells = {};
  const allowedVersions = [];
  const deniedVersions = [];
  for (const version of versions) {
    const cell = methodGateAt(method, version, compare);
    cells[version] = cell;
    if (cell.allowed) allowedVersions.push(version);
    else deniedVersions.push(version);
  }
  const proof = proofOf(method);
  const risk = proof ? obligationSummary(method).risk : 'risky';
  return Object.freeze({
    method,
    feature,
    floor,
    cells: Object.freeze(cells),
    allowedVersions: Object.freeze(allowedVersions),
    deniedVersions: Object.freeze(deniedVersions),
    gated: Boolean(feature),
    risk,
    replayable: proof ? proof.replayable : false,
    idempotent: proof ? proof.idempotent : false,
    effectState: proof ? proof.effectState : null,
    recoveryCount: proof ? proof.recovery.length : 0,
  });
}

function matrixRowForFeature(feature, versions, compare) {
  const floor = FEATURE_FLOORS[feature] || null;
  const cells = {};
  const allowedVersions = [];
  const deniedVersions = [];
  for (const version of versions) {
    const cell = featureGateAt(feature, version, compare);
    cells[version] = cell;
    if (cell.allowed) allowedVersions.push(version);
    else deniedVersions.push(version);
  }
  const scoped = methodsForFeature(feature);
  return Object.freeze({
    feature,
    label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature,
    floor,
    cells: Object.freeze(cells),
    allowedVersions: Object.freeze(allowedVersions),
    deniedVersions: Object.freeze(deniedVersions),
    scope: scoped.scope,
    methods: scoped.methods,
  });
}

function countCells(rows, versions) {
  const counts = {};
  for (const version of versions) counts[version] = { allowed: 0, denied: 0, unknown: 0 };
  for (const row of rows) {
    for (const version of versions) {
      const cell = row.cells[version];
      if (!cell) continue;
      if (cell.state === 'allowed') counts[version].allowed += 1;
      else if (cell.state === 'unknown') counts[version].unknown += 1;
      else counts[version].denied += 1;
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(counts).map(([version, value]) => [version, Object.freeze({ ...value })]),
  ));
}

/**
 * 每个版本“可调用方法”的风险画像：allowed 集合里有多少 risky/guarded/safe，
 * 以及其中多少必须 resolve 账本（非可重放）。这是给状态面看的“当前风险敞口”。
 */
function obligationProfileByVersion(methodRows, versions) {
  const profile = {};
  for (const version of versions) {
    const entry = { allowed: 0, safe: 0, guarded: 0, risky: 0, requiresResolve: 0, gated: 0 };
    for (const row of methodRows) {
      const cell = row.cells[version];
      if (!cell || !cell.allowed) continue;
      entry.allowed += 1;
      entry[row.risk] = (entry[row.risk] || 0) + 1;
      if (!row.replayable) entry.requiresResolve += 1;
      if (row.gated) entry.gated += 1;
    }
    profile[version] = Object.freeze(entry);
  }
  return Object.freeze(profile);
}

// ===========================================================================
// 四、runner 主入口：runCompatibilityMatrix
// ===========================================================================

/**
 * 跑完整兼容矩阵。
 * @param {object} [options] normalizeRunnerOptions 的输入
 * @returns {{
 *   reportVersion:number, versions:string[], methods:string[], features:string[],
 *   baseline:string, current:string,
 *   methodRows:Array<object>, featureRows:Array<object>,
 *   counts:object, obligations:object,
 *   monotonicity:object, fingerprint:string, summary:string,
 * }}
 */
export function runCompatibilityMatrix(options = {}) {
  const config = normalizeRunnerOptions(options);
  const versions = config.versions;
  const methodRows = Object.freeze(config.methods.map((method) => matrixRowForMethod(method, versions, config.compare)));
  const featureRows = Object.freeze(config.features.map((feature) => matrixRowForFeature(feature, versions, config.compare)));
  const methodCounts = countCells(methodRows, versions, 'methods');
  const featureCounts = countCells(featureRows, versions, 'features');
  const counts = Object.freeze(Object.fromEntries(versions.map((version) => [version, Object.freeze({
    methods: methodCounts[version],
    features: featureCounts[version],
  })])));
  const obligations = obligationProfileByVersion(methodRows, versions);
  const monotonicity = analyzeMonotonicity(methodRows, featureRows, versions);
  const report = {
    reportVersion: RUNNER_REPORT_VERSION,
    versions,
    methods: config.methods,
    features: config.features,
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    methodRows,
    featureRows,
    counts,
    obligations,
    monotonicity,
    summary: '',
    fingerprint: '',
  };
  const fingerprint = matrixFingerprint(report);
  const summary = '兼容矩阵：' + versions.length + ' 版本 × ' + config.methods.length + ' 方法 × '
    + config.features.length + ' 特性；单调性=' + (monotonicity.ok ? 'OK' : 'FAIL(' + monotonicity.violations.length + ')')
    + '，未知版本=' + monotonicity.unknownVersions.length;
  return Object.freeze({
    ...report,
    summary,
    fingerprint,
  });
}

// ===========================================================================
// 五、单调性报告
//
// 不变量：同 major 内，如果某方法在 v1 放行、在 v2（v1<v2）被拒，那一定是 bug
// （更高协议不可能丢失能力）。跨 major 的对照单独记录，不参与 ok 判定。
// ===========================================================================

function versionOrder(versions) {
  const known = [];
  const unknown = [];
  for (const version of versions) {
    if (isProtocolKnown(version)) known.push(String(version));
    else unknown.push(String(version));
  }
  return { known: [...sortProtocolVersions(known)], unknown: [...unknown].sort() };
}

function sameMajor(left, right) {
  const a = parseProtocol(left);
  const b = parseProtocol(right);
  return Boolean(a && b && a.major === b.major);
}

function analyzeMonotonicity(methodRows, featureRows, versions) {
  const { known, unknown } = versionOrder(versions);
  const methodViolations = [];
  const featureViolations = [];
  const crossMajorPairs = [];
  const sameMajorPairs = [];
  for (let index = 0; index < known.length; index += 1) {
    for (let later = index + 1; later < known.length; later += 1) {
      const left = known[index];
      const right = known[later];
      if (!sameMajor(left, right)) {
        crossMajorPairs.push(Object.freeze({ from: left, to: right }));
        continue;
      }
      sameMajorPairs.push(Object.freeze({ from: left, to: right }));
      for (const row of methodRows) {
        const fromCell = row.cells[left];
        const toCell = row.cells[right];
        if (!fromCell || !toCell) continue;
        if (fromCell.allowed && !toCell.allowed && toCell.state !== 'unknown') {
          methodViolations.push(Object.freeze({
            kind: 'method-allowance', method: row.method, allowedAt: left, deniedAt: right,
            feature: row.feature, floor: row.floor,
            message: row.method + ' 在 ' + left + ' 放行却在 ' + right + ' 被拒（高协议丢失能力）',
          }));
        }
      }
      for (const row of featureRows) {
        const fromCell = row.cells[left];
        const toCell = row.cells[right];
        if (!fromCell || !toCell) continue;
        if (fromCell.allowed && !toCell.allowed && toCell.state !== 'unknown') {
          featureViolations.push(Object.freeze({
            kind: 'feature-allowance', feature: row.feature, allowedAt: left, deniedAt: right,
            floor: row.floor,
            message: row.feature + ' 在 ' + left + ' 可用却在 ' + right + ' 不可用',
          }));
        }
      }
    }
  }
  const violations = Object.freeze([...methodViolations, ...featureViolations]);
  return Object.freeze({
    dimensions: MONOTONICITY_DIMENSIONS,
    order: Object.freeze(known),
    unknownVersions: Object.freeze(unknown),
    sameMajorPairs: Object.freeze(sameMajorPairs),
    crossMajorPairs: Object.freeze(crossMajorPairs),
    methodViolations: Object.freeze(methodViolations),
    featureViolations: Object.freeze(featureViolations),
    violations,
    counts: Object.freeze({
      versions: known.length,
      unknownVersions: unknown.length,
      pairs: sameMajorPairs.length,
      methodViolations: methodViolations.length,
      featureViolations: featureViolations.length,
    }),
    complete: unknown.length === 0,
    ok: violations.length === 0,
    summary: violations.length
      ? '单调性失败：' + violations.length + ' 处（' + violations.slice(0, 3).map((item) => item.message).join('；') + '）'
      : '单调性通过：' + known.length + ' 个版本 × ' + sameMajorPairs.length + ' 组同 major 对照全部向上封闭'
        + (unknown.length ? '；另有 ' + unknown.length + ' 个不可解析版本未参与' : ''),
  });
}

/**
 * 对已有报告重算单调性报告（报告可来自 runCompatibilityMatrix 或兼容结构）。
 * @param {{versions?:string[], methodRows?:Array, featureRows?:Array}} report
 */
export function monotonicityReport(report = {}) {
  const versions = Array.isArray(report.versions) ? report.versions.map(String) : [...defaultRunnerVersions()];
  const methodRows = Array.isArray(report.methodRows) ? report.methodRows : [];
  const featureRows = Array.isArray(report.featureRows) ? report.featureRows : [];
  return analyzeMonotonicity(methodRows, featureRows, versions);
}

// ===========================================================================
// 六、稳定指纹与矩阵差分
//
// 同输入必须同指纹：既能做缓存键，也能把“协议面有没有悄悄变化”变成可回归断言。
// 指纹只覆盖会改变放行结论的字段（版本/方法/特性集合 + 每格 allowed 状态），
// 不覆盖 label/reason 这类文案字段（文案改动不应让缓存失效）。
// ===========================================================================

/** FNV-1a 32 位（确定性、无依赖；仅用于指纹/差分，不做安全用途）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function cellCode(cell) {
  if (!cell) return '-';
  if (cell.state === 'unknown') return '?';
  return cell.allowed ? '1' : '0';
}

/**
 * 矩阵指纹：`<报告版本>|<版本集合>|<方法集合>|<特性集合>|<方法格串>|<特性格串>`。
 * @param {{versions?:string[], methods?:string[], features?:string[], methodRows?:Array, featureRows?:Array}} report
 */
export function matrixFingerprint(report = {}) {
  // 版本按版本序排列后再进指纹：同一集合不同书写顺序必须得到同一指纹。
  const versions = [...sortProtocolVersions((report.versions || []).map(String))];
  const parts = [
    'v' + RUNNER_REPORT_VERSION,
    versions.join(','),
    (report.methods || []).map(String).join(','),
    (report.features || []).map(String).join(','),
  ];
  for (const row of report.methodRows || []) {
    parts.push('m:' + row.method + '=' + versions.map((version) => cellCode(row.cells && row.cells[version])).join(''));
  }
  for (const row of report.featureRows || []) {
    parts.push('f:' + row.feature + '=' + versions.map((version) => cellCode(row.cells && row.cells[version])).join(''));
  }
  return fnv1a(parts.join('|'));
}

/**
 * 比较两份 runner 报告的语义差异。
 * @returns {{
 *   versions:object, methods:object, features:object, cellChanges:Array<object>,
 *   counts:object, ok:boolean, summary:string,
 * }}
 */
export function matrixDiff(before = {}, after = {}) {
  const beforeVersions = new Set((before.versions || []).map(String));
  const afterVersions = new Set((after.versions || []).map(String));
  const beforeMethods = new Set((before.methodRows || []).map((row) => row.method));
  const afterMethods = new Set((after.methodRows || []).map((row) => row.method));
  const beforeFeatures = new Set((before.featureRows || []).map((row) => row.feature));
  const afterFeatures = new Set((after.featureRows || []).map((row) => row.feature));
  const setDiff = (left, right) => ({
    added: [...right].filter((item) => !left.has(item)).sort(),
    removed: [...left].filter((item) => !right.has(item)).sort(),
    common: [...left].filter((item) => right.has(item)).sort(),
  });
  const versions = setDiff(beforeVersions, afterVersions);
  const methods = setDiff(beforeMethods, afterMethods);
  const features = setDiff(beforeFeatures, afterFeatures);
  const cellChanges = [];
  const compareRow = (kind, beforeRow, afterRow) => {
    if (!beforeRow || !afterRow) return;
    for (const version of versions.common) {
      const left = beforeRow.cells && beforeRow.cells[version];
      const right = afterRow.cells && afterRow.cells[version];
      const leftCode = cellCode(left);
      const rightCode = cellCode(right);
      if (leftCode === rightCode) continue;
      cellChanges.push(Object.freeze({
        kind,
        name: kind === 'method' ? beforeRow.method : beforeRow.feature,
        version,
        before: leftCode,
        after: rightCode,
      }));
    }
  };
  const beforeMethodMap = new Map((before.methodRows || []).map((row) => [row.method, row]));
  const afterMethodMap = new Map((after.methodRows || []).map((row) => [row.method, row]));
  for (const method of methods.common) compareRow('method', beforeMethodMap.get(method), afterMethodMap.get(method));
  const beforeFeatureMap = new Map((before.featureRows || []).map((row) => [row.feature, row]));
  const afterFeatureMap = new Map((after.featureRows || []).map((row) => [row.feature, row]));
  for (const feature of features.common) compareRow('feature', beforeFeatureMap.get(feature), afterFeatureMap.get(feature));
  const counts = Object.freeze({
    versions: versions.added.length + versions.removed.length,
    methods: methods.added.length + methods.removed.length,
    features: features.added.length + features.removed.length,
    cells: cellChanges.length,
  });
  const changed = counts.versions + counts.methods + counts.features + counts.cells > 0;
  return Object.freeze({
    versions, methods, features, cellChanges: Object.freeze(cellChanges), counts,
    ok: !changed,
    summary: changed
      ? '矩阵差异：+' + counts.versions + ' 版本 / +' + counts.methods + ' 方法 / +' + counts.features + ' 特性 / ' + counts.cells + ' 格变化'
      : '矩阵一致：没有语义变化',
  });
}

// ===========================================================================
// 七、派生校验器
//
// 校验对象是 runner 自己：每格必须能被 floor 独立重新推导；计数必须等于重算值；
// 基线/当前协议的特性策略必须成立；单调性必须通过；指纹必须可复现。
// ===========================================================================

function runnerIssue(scope, code, message, expected, actual) {
  return Object.freeze({
    scope,
    code: String(code),
    message,
    expected: expected === undefined ? null : String(expected),
    actual: actual === undefined ? null : String(actual),
  });
}

function expectedAllowed(floor, version, compare) {
  if (!floor) return true;
  const order = compare(String(version), floor);
  return order !== null && order >= 0;
}

/**
 * 特性 floor 策略校验：兼容基线必须拒绝全部特性、当前协议必须允许全部特性。
 * 这是单一源 compat 门禁的 runner 版表达（数据仍来自目录，不新增策略）。
 */
export function validateFloorPolicy(compare = compareProtocol) {
  const issues = [];
  for (const feature of FEATURE_NAMES) {
    const floor = FEATURE_FLOORS[feature];
    if (!floor) { issues.push(runnerIssue('floor.missing', feature, '特性缺少 floor')); continue; }
    const baselineOrder = compare(PROTOCOL_BASELINE, floor);
    if (baselineOrder === null || baselineOrder >= 0) {
      issues.push(runnerIssue('floor.baseline', feature, '兼容基线不该允许该特性', 'denied', 'allowed'));
    }
    const currentOrder = compare(PROTOCOL_CURRENT, floor);
    if (currentOrder === null || currentOrder < 0) {
      issues.push(runnerIssue('floor.current', feature, '当前协议必须允许该特性', 'allowed', 'denied'));
    }
  }
  for (const rule of FEATURE_PARAM_RULES) {
    if (!Object.prototype.hasOwnProperty.call(FEATURE_FLOORS, rule.feature)) {
      issues.push(runnerIssue('floor.rule', rule.feature, '参数规则引用了未登记特性'));
    }
  }
  return issues;
}

/**
 * 矩阵报告校验（派生校验器主入口）。
 * @param {object} report runCompatibilityMatrix 的结构
 * @param {{compare?:Function, gate?:Function, expectedVersions?:string[]}} [options]
 * @returns {ReadonlyArray<object>} 空数组 = 通过
 */
export function validateMatrixReport(report = {}, options = {}) {
  const issues = [];
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  const versions = Array.isArray(report.versions) ? report.versions.map(String) : [];
  const methods = Array.isArray(report.methods) ? report.methods.map(String) : [];
  const features = Array.isArray(report.features) ? report.features.map(String) : [];
  if (!versions.length) issues.push(runnerIssue('report.versions', '<矩阵>', '版本集合为空'));
  if (new Set(versions).size !== versions.length) issues.push(runnerIssue('report.versions', '<矩阵>', '版本集合有重复'));
  if (report.reportVersion !== RUNNER_REPORT_VERSION) {
    issues.push(runnerIssue('report.version', '<矩阵>', '报告格式版本不一致', RUNNER_REPORT_VERSION, report.reportVersion));
  }
  const methodRows = Array.isArray(report.methodRows) ? report.methodRows : [];
  const featureRows = Array.isArray(report.featureRows) ? report.featureRows : [];
  if (methodRows.length !== methods.length) {
    issues.push(runnerIssue('report.methodRows', '<矩阵>', '方法行数与 methods 不一致', methods.length, methodRows.length));
  }
  if (featureRows.length !== features.length) {
    issues.push(runnerIssue('report.featureRows', '<矩阵>', '特性行数与 features 不一致', features.length, featureRows.length));
  }
  if (typeof options.expectedVersions !== 'undefined') {
    const expected = [...options.expectedVersions].map(String);
    if (expected.join(',') !== versions.join(',')) {
      issues.push(runnerIssue('report.versions', '<矩阵>', '版本集合与期望不一致', expected.join(','), versions.join(',')));
    }
  }
  for (const row of methodRows) {
    if (!row || typeof row !== 'object') { issues.push(runnerIssue('row.method', '<行>', '方法行不是对象')); continue; }
    const rowFloor = methodFloor(row.method);
    if (row.floor !== rowFloor) issues.push(runnerIssue('row.floor', row.method, '方法 floor 与目录不一致', rowFloor === null ? '<null>' : rowFloor, row.floor === null ? '<null>' : row.floor));
    const cellKeys = Object.keys(row.cells || {});
    if (cellKeys.sort().join(',') !== [...versions].sort().join(',')) {
      issues.push(runnerIssue('row.cells', row.method, '单元格版本集合与矩阵版本不一致'));
    }
    for (const version of versions) {
      const cell = row.cells && row.cells[version];
      if (!cell) { issues.push(runnerIssue('row.cells', row.method, '缺少单元格：' + version)); continue; }
      if (!CELL_STATES.includes(cell.state)) issues.push(runnerIssue('row.state', row.method, '单元格状态非法：' + String(cell.state)));
      const allowed = expectedAllowed(rowFloor, version, compare);
      const unknownVersion = parseProtocol(version) === null && compare === compareProtocol;
      if (unknownVersion) {
        if (cell.allowed || cell.state !== 'unknown') issues.push(runnerIssue('row.unknown', row.method, '不可解析版本必须按 unknown 拒绝处理'));
        continue;
      }
      if (cell.allowed !== allowed) {
        issues.push(runnerIssue('row.allowed', row.method + '@' + version, '单元格与 floor 推导不一致', allowed ? 'allowed' : 'denied', cell.allowed ? 'allowed' : 'denied'));
      }
      if (cell.allowed !== (cell.state === 'allowed')) {
        issues.push(runnerIssue('row.state', row.method + '@' + version, 'allowed 与 state 不一致'));
      }
      if (typeof options.gate === 'function') {
        const external = options.gate({ protocol: version }, row.method, {}, options.compare || compareProtocol);
        if (Boolean(external && external.ok) !== Boolean(cell.allowed)) {
          issues.push(runnerIssue('row.gate', row.method + '@' + version, '与真实协议闸门不一致', external && external.ok ? 'allowed' : 'denied', cell.allowed ? 'allowed' : 'denied'));
        }
      }
    }
    if (row.allowedVersions.length + row.deniedVersions.length !== versions.length) {
      issues.push(runnerIssue('row.index', row.method, '放行/拒绝索引覆盖不全'));
    }
  }
  for (const row of featureRows) {
    if (!row || typeof row !== 'object') { issues.push(runnerIssue('row.feature', '<行>', '特性行不是对象')); continue; }
    const floor = FEATURE_FLOORS[row.feature] || null;
    if (row.floor !== floor) issues.push(runnerIssue('row.floor', row.feature, '特性 floor 与目录不一致'));
    for (const version of versions) {
      const cell = row.cells && row.cells[version];
      if (!cell) { issues.push(runnerIssue('row.cells', row.feature, '缺少单元格：' + version)); continue; }
      const allowed = expectedAllowed(floor, version, compare);
      const unknownVersion = parseProtocol(version) === null && compare === compareProtocol;
      if (unknownVersion) {
        if (cell.allowed) issues.push(runnerIssue('row.unknown', row.feature, '不可解析版本必须按不可用处理'));
        continue;
      }
      if (cell.allowed !== allowed) {
        issues.push(runnerIssue('row.allowed', row.feature + '@' + version, '特性格与 floor 推导不一致', allowed ? 'allowed' : 'denied', cell.allowed ? 'allowed' : 'denied'));
      }
    }
  }
  for (const version of versions) {
    const entry = report.counts && report.counts[version];
    if (!entry) { issues.push(runnerIssue('counts.missing', version, '缺少版本计数')); continue; }
    const expectedMethods = methodRows.filter((row) => row.cells && row.cells[version] && row.cells[version].allowed).length;
    if (entry.methods && entry.methods.allowed !== expectedMethods) {
      issues.push(runnerIssue('counts.methods', version, '方法放行计数与重算不一致', expectedMethods, entry.methods.allowed));
    }
    const expectedFeatures = featureRows.filter((row) => row.cells && row.cells[version] && row.cells[version].allowed).length;
    if (entry.features && entry.features.allowed !== expectedFeatures) {
      issues.push(runnerIssue('counts.features', version, '特性可用计数与重算不一致', expectedFeatures, entry.features.allowed));
    }
    const obligation = report.obligations && report.obligations[version];
    if (!obligation) issues.push(runnerIssue('obligations.missing', version, '缺少风险画像'));
  }
  const monotonicity = report.monotonicity || analyzeMonotonicity(methodRows, featureRows, versions);
  if (!monotonicity.ok) issues.push(runnerIssue('monotonicity', '<矩阵>', '单调性失败：' + monotonicity.violations.length + ' 处'));
  if (report.fingerprint) {
    const recomputed = matrixFingerprint(report);
    if (recomputed !== report.fingerprint) {
      issues.push(runnerIssue('fingerprint', '<矩阵>', '指纹不可复现', recomputed, report.fingerprint));
    }
  }
  issues.push(...validateFloorPolicy(compare));
  return Object.freeze(issues);
}

/** 默认矩阵（惰性缓存；165 方法 × 5 版本只算一次）。 */
let DEFAULT_MATRIX = null;

/** 默认矩阵报告（模块级缓存；默认探针版本 × 全部方法 × 全部特性）。 */
export function defaultRunnerReport() {
  if (!DEFAULT_MATRIX) DEFAULT_MATRIX = runCompatibilityMatrix({});
  return DEFAULT_MATRIX;
}

/**
 * runner 自检：跑默认矩阵 + 全部派生校验，返回可直接断言的结论。
 * @param {object} [options]
 */
export function runnerSelfCheck(options = {}) {
  const report = runCompatibilityMatrix(options);
  const issues = validateMatrixReport(report, options);
  return Object.freeze({
    ok: issues.length === 0,
    issues,
    versions: report.versions,
    methods: report.methods.length,
    features: report.features.length,
    monotonic: report.monotonicity.ok,
    fingerprint: report.fingerprint,
    summary: issues.length ? 'runner 自检失败：' + issues.length + ' 处' : 'runner 自检通过',
  });
}

// ===========================================================================
// 八、面向状态面的画像（health / daemon.status / SDK / CLI）
//
// featureMatrix 每个特性行会带 support：它必须小、可 JSON、且与矩阵同源。
// 因此这里给的是“压缩画像”而不是完整网格（完整网格留给 runner 报告）。
// ===========================================================================

const FEATURE_SUPPORT_CACHE = new Map();
const METHOD_SUPPORT_CACHE = new Map();

function supportVersions(feature, compare) {
  const versions = [...defaultRunnerVersions()];
  const map = {};
  const allowed = [];
  for (const version of versions) {
    const cell = featureGateAt(feature, version, compare);
    map[version] = cell.allowed;
    if (cell.allowed) allowed.push(version);
  }
  const sorted = sortProtocolVersions(allowed);
  return { versions, map, firstSupporting: sorted.length ? sorted[0] : null };
}

function isMonotoneSupport(versions, map, compare) {
  for (let index = 0; index < versions.length; index += 1) {
    for (let later = index + 1; later < versions.length; later += 1) {
      const left = versions[index];
      const right = versions[later];
      if (!sameMajor(left, right)) continue;
      if (map[left] === true && map[right] === false) return false;
    }
  }
  return true;
}

/**
 * 特性支持画像（压缩）：featureMatrix 的 `support` 字段来源。
 * @param {string} feature
 * @param {Function} [compare]
 */
export function featureSupportProfile(feature, compare = compareProtocol) {
  const key = String(feature || '');
  const cached = FEATURE_SUPPORT_CACHE.get(key);
  if (cached) return cached;
  const known = Object.prototype.hasOwnProperty.call(FEATURE_FLOORS, key);
  if (!known) {
    // 未登记特性不是“全版本可用”，而是“不参与判定”：画像明确标 unknown，避免
    // 状态面把拼错的特性名读成 available=true。
    const unknownProfile = Object.freeze({
      feature: key,
      known: false,
      floor: null,
      versions: Object.freeze({}),
      baselineAllowed: false,
      currentAllowed: false,
      firstSupporting: null,
      monotone: true,
      scope: 'unknown',
      methods: 0,
    });
    FEATURE_SUPPORT_CACHE.set(key, unknownProfile);
    return unknownProfile;
  }
  const floor = FEATURE_FLOORS[key] || null;
  const { versions, map, firstSupporting } = supportVersions(key, compare);
  const scoped = methodsForFeature(key);
  const profile = Object.freeze({
    feature: key,
    known: true,
    floor,
    versions: Object.freeze(map),
    baselineAllowed: Boolean(map[PROTOCOL_BASELINE]),
    currentAllowed: Boolean(map[PROTOCOL_CURRENT]),
    firstSupporting,
    monotone: isMonotoneSupport(versions, map, compare),
    scope: scoped.scope,
    methods: scoped.methods.length,
  });
  FEATURE_SUPPORT_CACHE.set(key, profile);
  return profile;
}

/**
 * 方法支持画像（压缩）：版本 × 方法级 floor。
 * @param {string} method
 */
export function methodSupportProfile(method, compare = compareProtocol) {
  const key = String(method || '');
  const cached = METHOD_SUPPORT_CACHE.get(key);
  if (cached) return cached;
  const versions = [...defaultRunnerVersions()];
  const map = {};
  const allowed = [];
  for (const version of versions) {
    const cell = methodGateAt(key, version, compare);
    map[version] = cell.allowed;
    if (cell.allowed) allowed.push(version);
  }
  const sortedAllowed = sortProtocolVersions(allowed);
  const profile = Object.freeze({
    method: key,
    feature: methodFeature(key),
    floor: methodFloor(key),
    versions: Object.freeze(map),
    baselineAllowed: Boolean(map[PROTOCOL_BASELINE]),
    currentAllowed: Boolean(map[PROTOCOL_CURRENT]),
    firstSupporting: sortedAllowed.length ? sortedAllowed[0] : null,
    monotone: isMonotoneSupport(versions, map, compare),
  });
  METHOD_SUPPORT_CACHE.set(key, profile);
  return profile;
}

/** 某协议版本下放行的方法名（空参数口径）。 */
export function allowedMethodsAt(version, options = {}) {
  const methods = Array.isArray(options.methods) && options.methods.length ? options.methods.map(String) : [...METHOD_NAMES];
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  return Object.freeze(methods.filter((method) => methodGateAt(method, version, compare).allowed));
}

/** 某协议版本下被拒绝的方法名（含 floor 与触发特性，便于错误信息）。 */
export function deniedMethodsAt(version, options = {}) {
  const methods = Array.isArray(options.methods) && options.methods.length ? options.methods.map(String) : [...METHOD_NAMES];
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  return Object.freeze(methods
    .map((method) => methodGateAt(method, version, compare))
    .filter((cell) => !cell.allowed)
    .map((cell) => Object.freeze({ method: cell.method, feature: cell.feature, floor: cell.floor, band: cell.band, reason: cell.reason })));
}

/** 版本画像：每个探针版本的放行计数 + 风险画像（供 CLI status 文本模式）。 */
export function describeVersions(report = defaultRunnerReport()) {
  const versions = report.versions || [];
  return Object.freeze(versions.map((version) => Object.freeze({
    version,
    band: protocolBand(version),
    direction: protocolDirection(version, PROTOCOL_CURRENT),
    methodsAllowed: report.counts && report.counts[version] ? report.counts[version].methods.allowed : 0,
    methodsDenied: report.counts && report.counts[version] ? report.counts[version].methods.denied : 0,
    featuresAllowed: report.counts && report.counts[version] ? report.counts[version].features.allowed : 0,
    featuresDenied: report.counts && report.counts[version] ? report.counts[version].features.denied : 0,
    obligations: report.obligations && report.obligations[version] ? report.obligations[version] : null,
    verdict: report.counts && report.counts[version] && report.counts[version].features.denied === 0 ? 'compatible' : 'incompatible',
  })));
}

/** 特性 floor 表（floor + 触发方法 + 策略；供文档/校验共用）。 */
export function featureFloorTable(features = FEATURE_NAMES) {
  return Object.freeze([...features].map((feature) => {
    const scope = methodsForFeature(feature);
    return Object.freeze({
      feature,
      label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature,
      floor: FEATURE_FLOORS[feature] || null,
      scope: scope.scope,
      methods: scope.methods,
      gatedMethods: Object.freeze([...(FEATURE_METHODS[feature] || [])].sort()),
      removableAt: FEATURE_FLOORS[feature] || null,
    });
  }));
}

/** 兼容面压缩快照（status/doctor 可原样序列化）。 */
export function compatibilitySnapshot() {
  const report = defaultRunnerReport();
  const selfCheck = runnerSelfCheck({});
  return Object.freeze({
    reportVersion: RUNNER_REPORT_VERSION,
    versions: report.versions,
    methods: report.methods.length,
    features: report.features.length,
    monotonic: report.monotonicity.ok,
    monotonicity: Object.freeze({
      order: report.monotonicity.order,
      pairs: report.monotonicity.counts.pairs,
      violations: report.monotonicity.violations.length,
      unknownVersions: report.monotonicity.unknownVersions,
    }),
    perVersion: describeVersions(report),
    fingerprint: report.fingerprint,
    selfCheck: Object.freeze({ ok: selfCheck.ok, issues: selfCheck.issues.length }),
  });
}

/** 版本对比：两个版本之间“新获得/失去”的方法与特性（迁移规划器的输入）。 */
export function versionDelta(from, to, options = {}) {
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  const gainedMethods = [];
  const lostMethods = [];
  for (const method of (options.methods && options.methods.length ? options.methods : METHOD_NAMES)) {
    const before = methodGateAt(method, from, compare);
    const after = methodGateAt(method, to, compare);
    if (!before.allowed && after.allowed) gainedMethods.push(Object.freeze({ method, feature: after.feature, floor: after.floor }));
    if (before.allowed && !after.allowed) lostMethods.push(Object.freeze({ method, feature: after.feature, floor: after.floor }));
  }
  const gainedFeatures = [];
  const lostFeatures = [];
  for (const feature of (options.features && options.features.length ? options.features : FEATURE_NAMES)) {
    const before = featureGateAt(feature, from, compare);
    const after = featureGateAt(feature, to, compare);
    if (!before.allowed && after.allowed) gainedFeatures.push(Object.freeze({ feature, floor: after.floor }));
    if (before.allowed && !after.allowed) lostFeatures.push(Object.freeze({ feature, floor: after.floor }));
  }
  return Object.freeze({
    from: String(from),
    to: String(to),
    direction: protocolDirection(to, from),
    gainedMethods: Object.freeze(gainedMethods),
    lostMethods: Object.freeze(lostMethods),
    gainedFeatures: Object.freeze(gainedFeatures),
    lostFeatures: Object.freeze(lostFeatures),
    counts: Object.freeze({
      gainedMethods: gainedMethods.length,
      lostMethods: lostMethods.length,
      gainedFeatures: gainedFeatures.length,
      lostFeatures: lostFeatures.length,
    }),
  });
}

/** runner ABI（消费方/测试据此判断能力，不改既有导出）。 */
export const RUNNER_ABI = Object.freeze({
  reportVersion: RUNNER_REPORT_VERSION,
  cellStates: CELL_STATES,
  monotonicityDimensions: MONOTONICITY_DIMENSIONS,
});

// ===========================================================================
// 九、风险网格与能力获得时间表（runner 的两种“横向视图”）
//
// 矩阵是“版本 × 方法”的二维事实；真实决策还要两个横向视图：
//   1) 风险网格：每个版本可调用集合里有多少 safe/guarded/risky、多少必须 resolve；
//   2) 能力时间表：相邻版本之间“新获得”的特性/方法（迁移批次的最小单位）。
// 两者都从矩阵与目录派生，不引入新事实，只做聚合。
// ===========================================================================

/**
 * 风险网格：版本 → 可调用方法的幂等/可重放风险分布。
 * @param {{versions?:string[], methods?:string[]}} [options]
 * @returns {{versions:string[], rows:Array<object>, totals:object}}
 */
export function riskGrid(options = {}) {
  const config = normalizeRunnerOptions(options);
  const rows = config.versions.map((version) => {
    const entry = { version, band: protocolBand(version), allowed: 0, safe: 0, guarded: 0, risky: 0, gated: 0, requiresResolve: 0 };
    for (const method of config.methods) {
      const cell = methodGateAt(method, version, config.compare);
      if (!cell.allowed) continue;
      const proof = proofOf(method);
      if (!proof) continue;
      entry.allowed += 1;
      const risk = proof.replayable ? 'safe' : proof.idempotent ? 'guarded' : 'risky';
      entry[risk] += 1;
      if (cell.feature) entry.gated += 1;
      if (!proof.replayable) entry.requiresResolve += 1;
    }
    return Object.freeze(entry);
  });
  const totals = { allowed: 0, safe: 0, guarded: 0, risky: 0, gated: 0, requiresResolve: 0 };
  for (const row of rows) {
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return Object.freeze({
    versions: config.versions,
    rows: Object.freeze(rows),
    totals: Object.freeze(totals),
  });
}

/**
 * 某版本下按风险分组的可调用方法名（诊断/恢复顺序用）。
 * @param {string} version
 * @param {{methods?:string[], compare?:Function}} [options]
 */
export function riskMethodsAt(version, options = {}) {
  const methods = Array.isArray(options.methods) && options.methods.length ? options.methods.map(String) : [...METHOD_NAMES];
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  const groups = { safe: [], guarded: [], risky: [] };
  for (const method of methods) {
    if (!methodGateAt(method, version, compare).allowed) continue;
    const proof = proofOf(method);
    if (!proof) continue;
    const risk = proof.replayable ? 'safe' : proof.idempotent ? 'guarded' : 'risky';
    groups[risk].push(method);
  }
  return Object.freeze({
    version: String(version),
    safe: Object.freeze(groups.safe),
    guarded: Object.freeze(groups.guarded),
    risky: Object.freeze(groups.risky),
    counts: Object.freeze({ safe: groups.safe.length, guarded: groups.guarded.length, risky: groups.risky.length }),
  });
}

/**
 * 能力获得时间表：相邻版本之间新获得的特性/方法（升序；不可解析版本跳过）。
 * @param {{versions?:string[], methods?:string[], features?:string[], compare?:Function}} [options]
 * @returns {{steps:Array<{from:string, to:string, gainedFeatures:Array, gainedMethods:Array, delta:object}>, summary:string}}
 */
export function capabilitySchedule(options = {}) {
  const config = normalizeRunnerOptions(options);
  const known = sortProtocolVersions(config.versions.filter((version) => isProtocolKnown(version)));
  const steps = [];
  for (let index = 0; index < known.length - 1; index += 1) {
    const from = known[index];
    const to = known[index + 1];
    const delta = versionDelta(from, to, { methods: config.methods, features: config.features, compare: config.compare });
    steps.push(Object.freeze({
      from,
      to,
      gainedFeatures: delta.gainedFeatures,
      gainedMethods: delta.gainedMethods,
      lostFeatures: delta.lostFeatures,
      lostMethods: delta.lostMethods,
      delta,
    }));
  }
  const gainedFeatures = new Set();
  const gainedMethods = new Set();
  for (const step of steps) {
    for (const item of step.gainedFeatures) gainedFeatures.add(item.feature);
    for (const item of step.gainedMethods) gainedMethods.add(item.method);
  }
  return Object.freeze({
    steps: Object.freeze(steps),
    summary: steps.length
      ? '能力时间表：' + steps.length + ' 段，累计获得 ' + gainedFeatures.size + ' 特性 / ' + gainedMethods.size + ' 方法'
      : '能力时间表：少于两个可解析版本，没有时间表',
  });
}

/**
 * 矩阵文本摘要（CLI 文本模式/日志；不改 JSON 报告）。
 * @param {object} [report]
 * @returns {ReadonlyArray<string>}
 */
export function matrixSummaryLines(report = defaultRunnerReport()) {
  const lines = [report.summary || ('兼容矩阵 ' + report.versions.length + ' 版本')];
  lines.push('version  band          methods(allowed/denied)  features(allowed/denied)  risky');
  for (const row of describeVersions(report)) {
    const risky = row.obligations ? row.obligations.risky : 0;
    lines.push(
      row.version.padEnd(8)
      + ' ' + String(row.band).padEnd(13)
      + ' ' + String(row.methodsAllowed + '/' + row.methodsDenied).padEnd(23)
      + ' ' + String(row.featuresAllowed + '/' + row.featuresDenied).padEnd(25)
      + ' ' + risky,
    );
  }
  const mono = report.monotonicity;
  if (mono) lines.push('monotonicity: ' + (mono.ok ? 'OK' : 'FAIL') + '（' + mono.counts.pairs + ' 组同 major 对照）');
  lines.push('fingerprint: ' + report.fingerprint);
  return Object.freeze(lines);
}

/**
 * 风险画像自证：每个版本的 allowed 必须等于风险分桶之和，且与矩阵放行集合一致。
 * @param {object} report
 * @returns {ReadonlyArray<object>} 空数组 = 通过
 */
export function validateRiskProfile(report = {}) {
  const issues = [];
  const versions = Array.isArray(report.versions) ? report.versions : [];
  for (const version of versions) {
    const profile = report.obligations && report.obligations[version];
    if (!profile) { issues.push(runnerIssue('risk.missing', version, '缺少风险画像')); continue; }
    if (profile.safe + profile.guarded + profile.risky !== profile.allowed) {
      issues.push(runnerIssue('risk.sum', version, '风险分桶之和与 allowed 不一致',
        profile.allowed, profile.safe + profile.guarded + profile.risky));
    }
    const allowedRows = (report.methodRows || []).filter((row) => row.cells && row.cells[version] && row.cells[version].allowed);
    const expectedRisky = allowedRows.filter((row) => row.risk === 'risky').length;
    const expectedSafe = allowedRows.filter((row) => row.risk === 'safe').length;
    const expectedGuarded = allowedRows.filter((row) => row.risk === 'guarded').length;
    if (profile.risky !== expectedRisky) issues.push(runnerIssue('risk.risky', version, 'risky 计数不一致', expectedRisky, profile.risky));
    if (profile.safe !== expectedSafe) issues.push(runnerIssue('risk.safe', version, 'safe 计数不一致', expectedSafe, profile.safe));
    if (profile.guarded !== expectedGuarded) issues.push(runnerIssue('risk.guarded', version, 'guarded 计数不一致', expectedGuarded, profile.guarded));
    if (profile.requiresResolve !== allowedRows.filter((row) => !row.replayable).length) {
      issues.push(runnerIssue('risk.resolve', version, 'requiresResolve 计数不一致'));
    }
  }
  return Object.freeze(issues);
}

/** 风险网格的文本摘要（供 status 文本模式/日志）。 */
export function riskSummaryLines(options = {}) {
  const grid = riskGrid(options);
  const lines = ['version  allowed  safe  guarded  risky  requiresResolve  gated'];
  for (const row of grid.rows) {
    lines.push(
      row.version.padEnd(8) + ' ' + String(row.allowed).padStart(7)
      + ' ' + String(row.safe).padStart(5)
      + ' ' + String(row.guarded).padStart(8)
      + ' ' + String(row.risky).padStart(6)
      + ' ' + String(row.requiresResolve).padStart(15)
      + ' ' + String(row.gated).padStart(6),
    );
  }
  lines.push('totals: allowed=' + grid.totals.allowed + ' risky=' + grid.totals.risky + ' requiresResolve=' + grid.totals.requiresResolve);
  return Object.freeze(lines);
}
