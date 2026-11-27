// tests/unit/protocol-audit.test.mjs —— 协议面统一审计器测试。
//
// 覆盖：
//   1) 默认审计通过：9 个分区、165 方法 / 9 特性 / 1166 义务 / 矩阵 5 版本；
//   2) 报告结构、指纹确定性、渲染行、摘要、单分区查询；
//   3) 负例：注入被篡改的矩阵报告时，matrix / risk / floor 分区必须失败；
//   4) 缓存与 JSON 序列化（status/doctor/CI 直接消费）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_ABI,
  AUDIT_REPORT_VERSION,
  AUDIT_SECTIONS,
  assertProtocolSurface,
  auditDigest,
  auditFingerprint,
  auditProtocolSurface,
  auditSection,
  auditSectionLine,
  auditStatusRows,
  cachedAudit,
  protocolSurfaceSummary,
  renderAuditReport,
} from '../../lib/protocol-audit.mjs';
import { defaultRunnerReport, runCompatibilityMatrix } from '../../lib/protocol-compat-runner.mjs';

const AUDIT = auditProtocolSurface();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 1. 默认审计
// ---------------------------------------------------------------------------

test('默认审计通过：9 个分区全部 ok', () => {
  assert.equal(AUDIT.ok, true);
  assert.deepEqual(AUDIT.issues, []);
  assert.equal(AUDIT.reportVersion, AUDIT_REPORT_VERSION);
  assert.deepEqual(AUDIT.sections.map((item) => item.name), [...AUDIT_SECTIONS]);
  assert.equal(AUDIT.sections.length, 9);
  for (const item of AUDIT.sections) {
    assert.equal(item.ok, true, item.name + ' 应通过');
    assert.equal(item.issues, 0);
  }
  assert.match(AUDIT.summary, /协议面审计通过/);
  assert.match(AUDIT.summary, /9\/9 分区/);
  assert.match(AUDIT.fingerprint, /^[0-9a-f]{8}$/);
});

test('审计计数：方法/特性/义务/夹具/矩阵/迁移阶段', () => {
  const counts = AUDIT.counts;
  assert.equal(counts.methods, 165);
  assert.equal(counts.features, 15);
  assert.equal(counts.obligations, 1166);
  assert.equal(counts.fixturePre, 21);
  assert.equal(counts.fixturePreViolated, 21);
  assert.equal(counts.fixturePost, 34);
  assert.ok(counts.fixtureContradiction >= 25);
  assert.equal(counts.matrixVersions, 5);
  assert.equal(counts.matrixCells, 5 * 165);
  assert.equal(counts.migrationPhases, 6);
  assert.equal(counts.sections, 9);
  assert.equal(counts.sectionsOk, 9);
  assert.equal(counts.issues, 0);
  const wire = JSON.parse(JSON.stringify(counts));
  assert.deepEqual(wire, { ...counts });
});

test('审计报告可 JSON 往返（CI/status 直接消费）', () => {
  const wire = JSON.parse(JSON.stringify(AUDIT));
  assert.equal(wire.ok, true);
  assert.equal(wire.sections.length, 9);
  assert.deepEqual(wire.issues, []);
  assert.equal(wire.fingerprint, AUDIT.fingerprint);
  assert.equal(wire.counts.methods, 165);
});

// ---------------------------------------------------------------------------
// 2. 指纹与渲染
// ---------------------------------------------------------------------------

test('审计指纹：同输入同指纹，分区/计数变化会改变指纹', () => {
  const again = auditProtocolSurface();
  assert.equal(again.fingerprint, AUDIT.fingerprint);
  const fake = { ...AUDIT, ok: false };
  assert.notEqual(auditFingerprint(fake), AUDIT.fingerprint);
  const altered = clone(AUDIT);
  altered.sections[0].ok = false;
  assert.notEqual(auditFingerprint(altered), AUDIT.fingerprint);
  const countsChanged = clone(AUDIT);
  countsChanged.counts.methods = 164;
  assert.notEqual(auditFingerprint(countsChanged), AUDIT.fingerprint);
  // 指纹包含矩阵指纹：带报告复现一致，不带报告则不同
  assert.equal(auditFingerprint(AUDIT, defaultRunnerReport()), AUDIT.fingerprint);
  assert.notEqual(auditFingerprint(AUDIT), AUDIT.fingerprint);
});

test('renderAuditReport：首行结论 + 9 个分区行 + 指纹行', () => {
  const lines = renderAuditReport(AUDIT);
  assert.match(lines[0], /^\[ok\] 协议面审计通过/);
  const sectionLines = lines.filter((line) => /^ {2}\[(ok|FAIL)\] [a-z-]+/.test(line));
  assert.equal(sectionLines.length, 9);
  assert.ok(lines.some((line) => line.startsWith('  fingerprint: ')));
  assert.equal(lines.length, 1 + 9 + 1);
});

test('auditDigest：紧凑摘要只含分区结论/计数/指纹', () => {
  const digest = auditDigest(AUDIT);
  assert.equal(digest.ok, true);
  assert.equal(digest.reportVersion, AUDIT_REPORT_VERSION);
  assert.equal(digest.sections.length, 9);
  assert.deepEqual(digest.counts, AUDIT.counts);
  assert.equal(digest.fingerprint, AUDIT.fingerprint);
  assert.equal(digest.summary, AUDIT.summary);
  assert.equal(Object.prototype.hasOwnProperty.call(digest, 'issues'), false, '摘要不应带逐条 issue');
  assert.ok(Object.isFrozen(digest));
});

// ---------------------------------------------------------------------------
// 3. 单分区查询
// ---------------------------------------------------------------------------

test('auditSection：每个分区都能单独查询，未知分区返回 null', () => {
  for (const name of AUDIT_SECTIONS) {
    const section = auditSection(name);
    assert.ok(section, name + ' 查询失败');
    assert.equal(section.name, name);
    assert.equal(section.ok, true, name);
    assert.deepEqual(section.issues, []);
    assert.equal(section.counts.issues, 0);
    assert.equal(section.counts.sectionIssues, 0);
  }
  assert.equal(auditSection('no-such-section'), null);
  assert.equal(auditSection(''), null);
});

// ---------------------------------------------------------------------------
// 4. 负例：注入被篡改的矩阵报告
// ---------------------------------------------------------------------------

test('注入被篡改的矩阵：matrix / risk / floor 分区必须失败', () => {
  const tampered = clone(defaultRunnerReport());
  tampered.methodRows.find((row) => row.method === 'video.start').cells['1.8'].allowed = true;
  tampered.obligations['1.9'].risky = 0;
  const audit = auditProtocolSurface({ matrix: tampered });
  assert.equal(audit.ok, false);
  assert.ok(audit.issues.length > 0);
  const failed = audit.sections.filter((item) => !item.ok).map((item) => item.name);
  assert.ok(failed.includes('matrix'), 'matrix 分区应失败：' + failed.join(','));
  assert.ok(failed.includes('risk-profile'), 'risk-profile 分区应失败：' + failed.join(','));
  assert.match(audit.summary, /协议面审计失败/);
  // 与矩阵无关的分区仍然通过
  assert.equal(audit.sections.find((item) => item.name === 'facts').ok, true);
  assert.equal(audit.sections.find((item) => item.name === 'obligations').ok, true);
  const rendered = renderAuditReport(audit);
  assert.match(rendered[0], /^\[FAIL\]/);
  assert.ok(rendered.some((line) => line.includes('FAIL') && line.includes('matrix')));
});

test('注入被篡改的矩阵：指纹随之变化（不同输入不可复用缓存）', () => {
  const tampered = clone(defaultRunnerReport());
  tampered.methodRows[0].floor = '9.9';
  const audit = auditProtocolSurface({ matrix: tampered });
  assert.notEqual(audit.fingerprint, AUDIT.fingerprint);
  assert.equal(audit.ok, false);
});

test('注入自定义矩阵（子集）：只有该矩阵的分区受影响，事实分区仍通过', () => {
  const subset = runCompatibilityMatrix({ versions: ['1.8', '1.9'], methods: ['click', 'video.start'], features: ['video'] });
  const audit = auditProtocolSurface({ matrix: subset });
  assert.equal(audit.ok, true, JSON.stringify(audit.issues.slice(0, 3)));
  assert.equal(audit.counts.matrixVersions, 2);
  assert.equal(audit.counts.matrixCells, 4);
  assert.equal(audit.sections.find((item) => item.name === 'matrix').ok, true);
});

// ---------------------------------------------------------------------------
// 5. 缓存与 ABI
// ---------------------------------------------------------------------------

test('cachedAudit：默认结论一致且命中缓存返回同一对象', () => {
  const first = cachedAudit();
  const second = cachedAudit();
  assert.equal(first, second, '同一输入应命中缓存');
  assert.equal(first.ok, true);
  assert.equal(first.fingerprint, AUDIT.fingerprint);
  const tampered = clone(defaultRunnerReport());
  tampered.methodRows[0].floor = '9.9';
  const injected = cachedAudit({ matrix: tampered });
  assert.notEqual(injected, first, '不同矩阵不应命中同一缓存');
  assert.equal(injected.ok, false);
});

test('AUDIT_ABI：暴露报告版本与分区清单', () => {
  assert.equal(AUDIT_ABI.reportVersion, AUDIT_REPORT_VERSION);
  assert.deepEqual([...AUDIT_ABI.sections], [...AUDIT_SECTIONS]);
  assert.equal(AUDIT_ABI.sections.length, 9);
  assert.ok(Object.isFrozen(AUDIT_ABI));
});

test('审计可重复执行：连续两次结果深度相等（纯函数）', () => {
  const first = auditProtocolSurface();
  const second = auditProtocolSurface();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  // 不修改输入的矩阵报告
  const matrix = defaultRunnerReport();
  const before = JSON.stringify(matrix);
  auditProtocolSurface({ matrix });
  assert.equal(JSON.stringify(matrix), before, '审计不应修改矩阵报告');
});

// ---------------------------------------------------------------------------
// 6. 状态面适配：检查行 / 紧凑快照 / 断言
// ---------------------------------------------------------------------------

test('auditStatusRows：1 行总检查 + 每分区一行，形状与 doctor 检查一致', () => {
  const rows = auditStatusRows(AUDIT);
  assert.equal(rows.length, 1 + AUDIT_SECTIONS.length);
  assert.equal(rows[0].check, 'protocol.audit');
  assert.equal(rows[0].ok, true);
  assert.match(rows[0].detail, /审计通过/);
  assert.equal(rows[0].data.fingerprint, AUDIT.fingerprint);
  assert.equal(rows[0].data.methods, 165);
  assert.equal(rows[0].data.obligations, 1166);
  for (let index = 0; index < AUDIT_SECTIONS.length; index += 1) {
    const row = rows[index + 1];
    assert.equal(row.check, 'protocol.audit.' + AUDIT_SECTIONS[index]);
    assert.equal(row.ok, true);
    assert.equal(typeof row.detail, 'string');
    assert.equal(row.data.issues, 0);
  }
  assert.ok(rows.every((row) => Object.isFrozen(row)));
});

test('protocolSurfaceSummary：紧凑快照含事实/分区/迁移摘要，可 JSON 序列化', () => {
  const summary = protocolSurfaceSummary(AUDIT);
  assert.equal(summary.ok, true);
  assert.equal(summary.fingerprint, AUDIT.fingerprint);
  assert.equal(summary.counts.methods, 165);
  assert.equal(summary.counts.sections, 9);
  assert.equal(summary.sections.length, 9);
  assert.equal(summary.migration.from, '1.8');
  assert.equal(summary.migration.to, '1.9');
  assert.equal(summary.migration.verdict, 'upgrade-required');
  assert.equal(summary.migration.gainedFeatures, 15);
  assert.match(summary.migration.fingerprint, /^[0-9a-f]{8}$/, '迁移计划指纹格式');
  assert.notEqual(summary.migration.fingerprint, summary.fingerprint, '迁移指纹不应等于审计指纹');
  const wire = JSON.parse(JSON.stringify(summary));
  assert.equal(wire.migration.feasible, true);
  assert.equal(typeof wire.summary, 'string');
});

test('assertProtocolSurface：默认通过返回报告；注入坏矩阵时抛 E_PROTOCOL_AUDIT', () => {
  const audit = assertProtocolSurface();
  assert.equal(audit.ok, true);
  assert.ok(Object.isFrozen(audit));
  const tampered = clone(defaultRunnerReport());
  tampered.methodRows[0].floor = '9.9';
  let thrown = null;
  try {
    assertProtocolSurface({ matrix: tampered });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, '坏矩阵必须抛错');
  assert.equal(thrown.code, 'E_PROTOCOL_AUDIT');
  assert.equal(thrown.data.code, 'E_PROTOCOL_AUDIT');
  assert.ok(thrown.data.issues.length > 0);
  assert.equal(thrown.data.sections.length, 9);
  assert.equal(typeof thrown.data.fingerprint, 'string');
  const wire = JSON.parse(JSON.stringify(thrown.data));
  assert.equal(wire.code, 'E_PROTOCOL_AUDIT');
});

test('auditSectionLine：单行分区状态摘要，顺序稳定', () => {
  const line = auditSectionLine(AUDIT);
  assert.equal(line, AUDIT_SECTIONS.map((name) => name + '=ok').join(' '));
  assert.match(line, /^facts=ok /);
  assert.match(line, /migration-matrix=ok$/);
  const tampered = clone(defaultRunnerReport());
  tampered.methodRows[0].floor = '9.9';
  const badLine = auditSectionLine(auditProtocolSurface({ matrix: tampered }));
  assert.match(badLine, /matrix=FAIL/);
});
