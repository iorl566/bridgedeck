// lib/protocol-audit.mjs —— 协议面统一审计器（派生校验器的聚合入口）。
//
// 第二轮的三个模块各自带着自己的派生校验器：
//   lib/protocol-proof.mjs              → auditObligations()（夹具/结构/行为三层）
//   lib/protocol-compat-runner.mjs     → validateMatrixReport() / validateRiskProfile() / validateFloorPolicy()
//   lib/protocol-migration-planner.mjs → validateMigrationPlan() / validatePlannerMatrix()
//
// 单看每一份都能自证，但“整条协议面是否一致”还需要一个聚合器：把三份审计 + 既有
// 单一源事实（165 方法 / 15 特性 / 1.8 基线 / 1.9 当前）放在同一张报告里，输出
// 可打印、可断言、可 JSON 序列化的结果。真实用途：
//   - protocol-check / 单测：一次调用拿到全量审计结论，而不是逐个 import；
//   - status/doctor：把“协议面自检”作为一项健康检查（ok/fail + 摘要）；
//   - 发布前：把审计摘要作为构建证据（counts + fingerprint 稳定）。
//
// 本模块是纯聚合：它不新增事实、不新增判定规则，只调用三个模块的既有校验器。
// 依赖方向：protocol-proof / protocol-compat-runner / protocol-migration-planner → 本文件。
// 三个下层模块都不 import 本文件，因此不会形成环。

import { FEATURE_NAMES, METHOD_NAMES, PROTOCOL_BASELINE, PROTOCOL_CURRENT } from './method-catalog.mjs';
import { obligationSnapshot, validateObligationTable } from './protocol-proof.mjs';
import {
  defaultRunnerReport,
  validateFloorPolicy,
  validateMatrixReport,
  validateRiskProfile,
} from './protocol-compat-runner.mjs';
import {
  migrationSnapshot,
  planMigration,
  validateMigrationPlan,
  validatePlannerMatrix,
} from './protocol-migration-planner.mjs';

/** 审计格式版本（报告字段只增不改）。 */
export const AUDIT_REPORT_VERSION = 1;

/** 审计分区名（顺序 = 报告顺序；`ok` 需要全部通过）。 */
export const AUDIT_SECTIONS = Object.freeze([
  'facts',
  'obligations',
  'fixtures',
  'engine-behavior',
  'matrix',
  'floor-policy',
  'risk-profile',
  'migration-default',
  'migration-matrix',
]);

function section(scope, code, message, expected, actual) {
  return Object.freeze({
    scope: String(scope),
    code: String(code),
    message: String(message),
    expected: expected === undefined ? null : String(expected),
    actual: actual === undefined ? null : String(actual),
  });
}

/**
 * 事实分区：协议面的“常量合同”——165 方法 / 15 特性 / 1.8 / 1.9。
 * 这些数字被生成物、文档、MCP 工具映射共同引用，漂移时必须第一时间被看见。
 */
function auditFacts() {
  const issues = [];
  if (METHOD_NAMES.length !== 165) issues.push(section('facts.methods', '<目录>', '方法数漂移', 165, METHOD_NAMES.length));
  if (FEATURE_NAMES.length !== 15) issues.push(section('facts.features', '<目录>', '特性数漂移', 15, FEATURE_NAMES.length));
  if (PROTOCOL_BASELINE !== '1.8') issues.push(section('facts.baseline', '<目录>', '兼容基线漂移', '1.8', PROTOCOL_BASELINE));
  if (PROTOCOL_CURRENT !== '1.9') issues.push(section('facts.current', '<目录>', '当前协议漂移', '1.9', PROTOCOL_CURRENT));
  return issues;
}

/**
 * 义务分区：结构层（义务表与目录同源）。
 * 行为层与夹具层单列，便于定位到底哪一层坏了。
 */
function auditObligationStructure() {
  return validateObligationTable().map((issue) => section('obligation.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual));
}

/**
 * 夹具分区：证据向量必须真的被状态机判成 expected。
 * 直接复用 obligationSnapshot 已经算好的夹具计数，再独立跑一次夹具校验。
 */
function auditFixtures() {
  const issues = [];
  const snapshot = obligationSnapshot();
  for (const issue of snapshot.auditErrors) {
    if (String(issue.scope).startsWith('fixture.')) {
      issues.push(section('fixture.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual));
    }
  }
  const expectedPre = 21;
  const expectedPost = 34;
  if (snapshot.fixtures.preSatisfied < expectedPre) {
    issues.push(section('fixture.pre', '<夹具>', '前置满足夹具不足', expectedPre, snapshot.fixtures.preSatisfied));
  }
  if (snapshot.fixtures.postSatisfied < expectedPost) {
    issues.push(section('fixture.post', '<夹具>', '后置满足夹具不足', expectedPost, snapshot.fixtures.postSatisfied));
  }
  return issues;
}

/**
 * 行为分区：165 方法在构造证据下的硬结论单调性。
 */
function auditEngineBehavior() {
  const snapshot = obligationSnapshot();
  return snapshot.auditErrors
    .filter((issue) => String(issue.scope).startsWith('behavior.'))
    .map((issue) => section('behavior.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual));
}

/**
 * 矩阵分区：报告与 floor 独立推导一致 + 单调性 + 指纹可复现。
 * 顺序：先结构（validateMatrixReport），再风险画像（validateRiskProfile），再 floor 策略。
 */
function auditMatrix(report = defaultRunnerReport()) {
  return [
    ...validateMatrixReport(report).map((issue) => section('matrix.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual)),
    ...validateRiskProfile(report).map((issue) => section('risk.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual)),
    ...validateFloorPolicy().map((issue) => section('floor.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual)),
  ];
}

/**
 * 默认迁移计划分区：兼容基线 → 当前协议的计划必须可行且自洽。
 * 这是发布/文档最常引用的那条路径，单独审计它的阶段完整性与指纹。
 */
function auditDefaultMigration() {
  const issues = [];
  const plan = planMigration({ from: PROTOCOL_BASELINE, to: PROTOCOL_CURRENT });
  for (const issue of validateMigrationPlan(plan)) {
    issues.push(section('migration.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual));
  }
  if (plan.verdict !== 'upgrade-required') {
    issues.push(section('migration.verdict', '<计划>', '基线到当前协议应为 upgrade-required', 'upgrade-required', plan.verdict));
  }
  if (!plan.feasible) issues.push(section('migration.feasible', '<计划>', '基线到当前协议必须可行'));
  if (plan.ladder.rungs.map((rung) => rung.version).join('>') !== PROTOCOL_BASELINE + '>' + PROTOCOL_CURRENT) {
    issues.push(section('migration.ladder', '<计划>', '阶梯端点异常',
      PROTOCOL_BASELINE + '>' + PROTOCOL_CURRENT, plan.ladder.rungs.map((rung) => rung.version).join('>')));
  }
  return issues;
}

/**
 * 迁移矩阵分区：一组 (from,to) 的计划自证（含正反向 gained/lost 对称）。
 */
function auditMigrationMatrix() {
  return validatePlannerMatrix().map((issue) => section('migration.' + issue.scope, issue.code, issue.message, issue.expected, issue.actual));
}

/**
 * 协议面全量审计。
 * @param {{matrix?:object, prunedMethods?:string[]}} [options]
 * @returns {{
 *   reportVersion:number, ok:boolean,
 *   sections:Array<{name:string, ok:boolean, issues:number}>,
 *   issues:Array<object>,
 *   counts:object, fingerprint:string, summary:string,
 * }}
 */
export function auditProtocolSurface(options = {}) {
  const bag = options && typeof options === 'object' ? options : {};
  const report = bag.matrix || defaultRunnerReport();
  const sectionIssues = {
    facts: auditFacts(),
    obligations: auditObligationStructure(),
    fixtures: auditFixtures(),
    'engine-behavior': auditEngineBehavior(),
    matrix: auditMatrix(report),
    'floor-policy': [],
    'risk-profile': [],
  };
  // matrix 分区已经包含 floor/risk 的 issue；这里按 scope 前缀再分一次，保证每个分区独立可读。
  sectionIssues['floor-policy'] = sectionIssues.matrix.filter((issue) => issue.scope.startsWith('floor.'));
  sectionIssues['risk-profile'] = sectionIssues.matrix.filter((issue) => issue.scope.startsWith('risk.'));
  sectionIssues.matrix = sectionIssues.matrix.filter((issue) => !issue.scope.startsWith('floor.') && !issue.scope.startsWith('risk.'));
  sectionIssues['migration-default'] = auditDefaultMigration();
  sectionIssues['migration-matrix'] = auditMigrationMatrix();
  const sections = AUDIT_SECTIONS.map((name) => Object.freeze({
    name,
    ok: (sectionIssues[name] || []).length === 0,
    issues: (sectionIssues[name] || []).length,
  }));
  const issues = AUDIT_SECTIONS.flatMap((name) => sectionIssues[name] || []);
  const snapshot = obligationSnapshot();
  const counts = Object.freeze({
    methods: METHOD_NAMES.length,
    features: FEATURE_NAMES.length,
    obligations: snapshot.obligations.obligations,
    fixturePre: snapshot.fixtures.preSatisfied,
    fixturePreViolated: snapshot.fixtures.preViolated,
    fixturePost: snapshot.fixtures.postSatisfied,
    fixtureContradiction: snapshot.fixtures.postContradiction,
    matrixVersions: report.versions.length,
    matrixCells: report.versions.length * report.methods.length,
    migrationPhases: migrationSnapshot().phases.length,
    sections: sections.length,
    sectionsOk: sections.filter((item) => item.ok).length,
    issues: issues.length,
  });
  const ok = issues.length === 0;
  const payload = {
    reportVersion: AUDIT_REPORT_VERSION,
    ok,
    sections,
    issues: Object.freeze(issues),
    counts,
    summary: '',
    fingerprint: '',
  };
  const fingerprint = auditFingerprint(payload, report);
  const summary = ok
    ? '协议面审计通过：' + counts.methods + ' 方法 / ' + counts.features + ' 特性 / '
      + counts.obligations + ' 义务 / 矩阵 ' + counts.matrixVersions + ' 版本 / '
      + counts.sectionsOk + '/' + counts.sections + ' 分区'
    : '协议面审计失败：' + counts.issues + ' 处（' + sections.filter((item) => !item.ok).map((item) => item.name).join('、') + '）';
  return Object.freeze({
    ...payload,
    summary,
    fingerprint,
  });
}

/**
 * 审计指纹：覆盖分区结论 + 计数 + 矩阵指纹（同输入必须同指纹）。
 * @param {object} audit auditProtocolSurface 的结果（或部分字段）
 * @param {object} [matrix] 矩阵报告
 */
export function auditFingerprint(audit = {}, matrix = null) {
  const parts = [
    'v' + AUDIT_REPORT_VERSION,
    String(audit.ok),
    (audit.sections || []).map((item) => item.name + ':' + item.ok + ':' + item.issues).join(','),
    JSON.stringify(audit.counts || {}),
    matrix && matrix.fingerprint ? matrix.fingerprint : '',
  ];
  const text = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 审计报告 → 可打印文本行（CLI/日志/CI 输出）。 */
export function renderAuditReport(audit = auditProtocolSurface()) {
  const lines = [audit.ok ? '[ok] ' + audit.summary : '[FAIL] ' + audit.summary];
  for (const item of audit.sections) {
    lines.push('  [' + (item.ok ? 'ok' : 'FAIL') + '] ' + item.name + (item.issues ? '（' + item.issues + ' 处）' : ''));
  }
  for (const issue of audit.issues.slice(0, 40)) {
    lines.push('  - [' + issue.scope + '] ' + issue.code + '：' + issue.message
      + (issue.expected !== null ? '（expected=' + issue.expected + ' actual=' + issue.actual + '）' : ''));
  }
  if (audit.issues.length > 40) lines.push('  ... 其余 ' + (audit.issues.length - 40) + ' 处省略');
  lines.push('  fingerprint: ' + audit.fingerprint);
  return Object.freeze(lines);
}

/**
 * 单分区审计（status/doctor 可以只跑一个分区，避免全量开销）。
 * @param {string} name AUDIT_SECTIONS 之一
 * @param {object} [options]
 * @returns {{name:string, ok:boolean, issues:Array<object>, counts:object}|null}
 */
export function auditSection(name, options = {}) {
  const key = String(name || '');
  if (!AUDIT_SECTIONS.includes(key)) return null;
  const audit = auditProtocolSurface(options);
  const entry = audit.sections.find((item) => item.name === key);
  const issues = audit.issues.filter((issue) => {
    const prefix = issue.scope.split('.')[0];
    if (key === 'floor-policy') return prefix === 'floor';
    if (key === 'risk-profile') return prefix === 'risk';
    if (key === 'migration-default' || key === 'migration-matrix') return prefix === 'migration';
    return prefix === key;
  });
  return Object.freeze({
    name: key,
    ok: Boolean(entry && entry.ok),
    issues: Object.freeze(issues),
    counts: Object.freeze({
      issues: issues.length,
      sectionIssues: entry ? entry.issues : 0,
    }),
  });
}

/**
 * 审计摘要（status/doctor 的紧凑版）：不返回逐条 issue，只给分区结论 + 指纹。
 */
export function auditDigest(audit = auditProtocolSurface()) {
  return Object.freeze({
    ok: audit.ok,
    reportVersion: audit.reportVersion,
    sections: Object.freeze(audit.sections.map((item) => Object.freeze({
      name: item.name,
      ok: item.ok,
      issues: item.issues,
    }))),
    counts: audit.counts,
    fingerprint: audit.fingerprint,
    summary: audit.summary,
  });
}

const AUDIT_CACHE = new Map();

/**
 * 带缓存的审计（默认全量；options.matrix 可注入矩阵报告做负例）。
 * 缓存键只包含会影响结论的字段：矩阵指纹 + 是否忽略行为层（当前没有开关，占位）。
 */
export function cachedAudit(options = {}) {
  const bag = options && typeof options === 'object' ? options : {};
  const key = bag.matrix && bag.matrix.fingerprint ? 'matrix:' + bag.matrix.fingerprint : 'default';
  const cached = AUDIT_CACHE.get(key);
  if (cached) return cached;
  const audit = auditProtocolSurface(bag);
  AUDIT_CACHE.set(key, audit);
  return audit;
}

/** 审计 ABI（消费方/测试据此判断能力）。 */
export const AUDIT_ABI = Object.freeze({
  reportVersion: AUDIT_REPORT_VERSION,
  sections: AUDIT_SECTIONS,
});

// ===========================================================================
// 十、状态面适配：审计结果 → status/doctor 行 / 紧凑快照 / 断言
//
// 审计报告是给测试与 CI 的；daemon 的 status/doctor 需要的是“一组检查行”：
//   { check, ok, detail, data }
// 这里把审计分区翻译成这个形状（不修改 daemon/doctor 代码，消费方可以按需取用）。
// 另外提供 assertProtocolSurface()（与 assertProtocolCompatible 同风格）：
// 需要硬失败的地方（发布前检查、CI gate）可以直接 throw。
// ===========================================================================

/**
 * 审计 → 状态检查行（每个分区一行，外加一行总检查）。
 * 与 daemon/doctor 的 makeCheck 形状一致（check/ok/detail/data），可直接展示。
 * @param {object} [audit]
 * @returns {ReadonlyArray<{check:string, ok:boolean, detail:string, data:object}>}
 */
export function auditStatusRows(audit = auditProtocolSurface()) {
  const rows = [];
  rows.push(Object.freeze({
    check: 'protocol.audit',
    ok: audit.ok,
    detail: audit.ok
      ? '协议面审计通过（' + audit.counts.sectionsOk + '/' + audit.counts.sections + ' 分区）'
      : '协议面审计失败：' + audit.counts.issues + ' 处（' + audit.issues.slice(0, 3).map((issue) => issue.scope).join('、') + '）',
    data: Object.freeze({
      fingerprint: audit.fingerprint,
      methods: audit.counts.methods,
      obligations: audit.counts.obligations,
      matrixVersions: audit.counts.matrixVersions,
      issues: audit.counts.issues,
    }),
  }));
  for (const item of audit.sections) {
    rows.push(Object.freeze({
      check: 'protocol.audit.' + item.name,
      ok: item.ok,
      detail: item.ok ? '通过' : item.issues + ' 处不一致',
      data: Object.freeze({ issues: item.issues }),
    }));
  }
  return Object.freeze(rows);
}

/**
 * 协议面紧凑快照（status/doctor 单入口）：事实 + 分区结论 + 指纹 + 迁移摘要。
 * 不包含逐条 issue（避免状态载荷膨胀），需要细节时用 auditProtocolSurface()。
 * @param {object} [audit]
 * @returns {object}
 */
export function protocolSurfaceSummary(audit = auditProtocolSurface()) {
  const migration = migrationSnapshot();
  return Object.freeze({
    ok: audit.ok,
    reportVersion: audit.reportVersion,
    fingerprint: audit.fingerprint,
    counts: Object.freeze({
      methods: audit.counts.methods,
      features: audit.counts.features,
      obligations: audit.counts.obligations,
      matrixVersions: audit.counts.matrixVersions,
      sections: audit.counts.sections,
      sectionsOk: audit.counts.sectionsOk,
      issues: audit.counts.issues,
    }),
    sections: Object.freeze(audit.sections.map((item) => Object.freeze({ name: item.name, ok: item.ok, issues: item.issues }))),
    migration: Object.freeze({
      from: migration.from,
      to: migration.to,
      verdict: migration.verdict,
      feasible: migration.feasible,
      gainedFeatures: migration.gainedFeatures.length,
      gainedMethods: migration.gainedMethods.length,
      fingerprint: migration.fingerprint,
    }),
    summary: audit.summary,
  });
}

/**
 * 断言式审计（硬失败）：失败时抛错，错误对象带 code/data，风格与
 * lib/protocol-features.mjs 的 assertProtocolCompatible 一致。
 * @param {object} [options]
 * @returns {object} 通过时返回审计报告
 */
export function assertProtocolSurface(options = {}) {
  const audit = auditProtocolSurface(options);
  if (audit.ok) return audit;
  const error = new Error('协议面审计失败：' + audit.counts.issues + ' 处；首个问题 '
    + (audit.issues[0] ? audit.issues[0].scope + ' ' + audit.issues[0].message : '<无>'));
  error.code = 'E_PROTOCOL_AUDIT';
  error.data = Object.freeze({
    code: 'E_PROTOCOL_AUDIT',
    fingerprint: audit.fingerprint,
    counts: audit.counts,
    issues: audit.issues.slice(0, 20),
    sections: audit.sections,
  });
  throw error;
}

/**
 * 审计分区的短摘要（单行）：`facts=ok obligations=ok ...`。
 * 日志/错误信息用；顺序与 AUDIT_SECTIONS 一致。
 * @param {object} [audit]
 */
export function auditSectionLine(audit = auditProtocolSurface()) {
  return audit.sections.map((item) => item.name + '=' + (item.ok ? 'ok' : 'FAIL')).join(' ');
}
