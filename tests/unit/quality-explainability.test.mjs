// tests/unit/quality-explainability.test.mjs —— 可解释性（错误码分类 + finding 契约 + CLI 渲染）。
//
// 重点是"阻断项没有解释就不可能通过"：
// * makeFinding 在构造期拦截缺失 category/retry/nextAction 的失败项；
// * auditFindings 在整轮结束后再审计（包括外部注入的坏 finding）；
// * 每个错误码都能生成合法 CLI 失败信封，且真实 CLI 用法错误可被解析。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIES,
  ERROR_CATEGORIES,
  ERROR_CODE_GROUPS,
  ERROR_OVERRIDES,
  ERROR_TAXONOMY,
  QUALITY_CODES,
  QUALITY_CODE_LIST,
  RETRY_MODES,
  explainErrorCode,
  qualityCode,
  validateQualityCodes,
  validateTaxonomy,
} from '../../tools/quality/lib/taxonomy.mjs';
import { ERROR_CODES, ERROR_CODE_LIST, ERROR_RECOVERY, recoveryHint } from '../../lib/error-codes.mjs';
import { decorateFailure, errorEnvelope, validateEnvelope } from '../../cli/lib/json-contract.mjs';
import {
  QualityContractError,
  attachDigest,
  describeFinding,
  fail,
  makeFinding,
  pass,
  summarizeFindings,
  summarizeGate,
  validateFinding,
  verifyDigest,
} from '../../tools/quality/lib/result.mjs';
import { auditFindings } from '../../tools/quality/gates/explainability.mjs';
import { renderExplanation, renderFindingLine, renderMarkdown, renderQuiet, renderText } from '../../tools/quality/lib/render.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('分类表与运行时错误码真源双向一致', () => {
  assert.deepEqual(validateTaxonomy(ERROR_CODES, ERROR_RECOVERY), []);
  const runtime = Object.keys(ERROR_CODES).sort();
  const taxonomy = Object.keys(ERROR_TAXONOMY).sort();
  assert.deepEqual(taxonomy, runtime);
  // 分组单射：每个码恰好一个分类。
  const grouped = Object.values(ERROR_CODE_GROUPS).flat();
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(grouped.slice().sort(), runtime);
  for (const code of Object.keys(ERROR_OVERRIDES)) assert.equal(grouped.includes(code), true, 'override 无分组：' + code);
});

test('每个错误码都有 category/retry/nextAction，且 retry 与 ERROR_RECOVERY 一致', () => {
  for (const code of ERROR_CODE_LIST) {
    const entry = explainErrorCode(code);
    assert(entry, '码未分类：' + code);
    assert.equal(entry.code, code);
    assert(RETRY_MODES.includes(entry.retry), 'retry 非法：' + code);
    assert(ERROR_CATEGORIES[entry.category], 'category 非法：' + code);
    assert.ok(entry.nextAction.length >= 4, 'nextAction 过短：' + code);
    const recovery = ERROR_RECOVERY[code];
    if (recovery && recovery.retry) assert.equal(entry.retry, recovery.retry, 'retry 与单一真源不一致：' + code);
    if (recovery && recovery.hint) assert.equal(recoveryHint(code).hint, recovery.hint);
  }
  // 非错误码返回 null（分类器不能臆造）。
  assert.equal(explainErrorCode('E_NOT_A_REAL_CODE'), null);
});

test('quality 门禁码登记完整，未登记码必须抛错', () => {
  assert.deepEqual(validateQualityCodes(), []);
  for (const code of QUALITY_CODE_LIST) {
    const entry = qualityCode(code);
    assert.equal(entry.code, code);
    assert(CATEGORIES[entry.category], 'category 不存在：' + code);
    assert(RETRY_MODES.includes(entry.retry), 'retry 非法：' + code);
    assert.ok(entry.nextAction.length >= 4);
  }
  assert.throws(() => qualityCode('QUALITY_NOT_REGISTERED'), /未登记/);
});

test('makeFinding：失败项缺解释字段直接抛 QualityContractError', () => {
  assert.throws(() => makeFinding({ gate: 'g', id: 'g/x', title: 't', ok: false }), QualityContractError);
  assert.throws(() => fail('g', 'g/x', 't', { code: 'QUALITY_GATE_FAILED', detail: 'd' }), QualityContractError);
  // 显式给全解释字段可以构造（category/retry 从 code 默认值补全）。
  const finding = fail('explainability', 'explainability/ok', '可解释失败项', {
    code: 'QUALITY_GATE_FAILED',
    detail: '细节足够长',
    evidence: { sample: 1 },
  });
  assert.equal(finding.ok, false);
  assert.equal(finding.category, 'antifragility'); // QUALITY_GATE_FAILED 的登记分类
  assert.equal(finding.retry, 'after-action');
  assert.ok(finding.nextAction.length >= 4);
  // 通过项不需要解释字段。
  const okFinding = pass('explainability', 'explainability/pass', '通过项');
  assert.equal(okFinding.severity, 'info');
  assert.equal(okFinding.code, undefined);
});

test('validateFinding 能识别缺字段/坏 id/坏 retry/重复阻断 details', () => {
  const malformed = { id: 'bad-id-without-slash', gate: '', title: '', ok: false, severity: 'blocking', category: 'nope', retry: 'maybe', nextAction: '', detail: '' };
  const problems = validateFinding(malformed, { requireExplainable: true, requireBlockingDetail: true });
  assert.ok(problems.length >= 5);
  assert.ok(problems.some((item) => item.includes('id')));
  assert.ok(problems.some((item) => item.includes('category')));
  assert.ok(problems.some((item) => item.includes('retry')));
  const good = fail('explainability', 'explainability/good', '好 finding', {
    code: 'QUALITY_GATE_FAILED',
    detail: '合法细节',
    evidence: { x: 1 },
  });
  assert.deepEqual(validateFinding(good, { requireExplainable: true, requireBlockingDetail: true }), []);
});

test('渲染器对每个分类都输出 分类/重试/下一步', () => {
  for (const category of Object.keys(CATEGORIES)) {
    const finding = fail('explainability', 'explainability/render-' + category, '渲染 ' + category, {
      category,
      code: 'QUALITY_GATE_FAILED',
      detail: '渲染细节',
      evidence: { category },
    });
    const line = renderFindingLine(finding);
    assert.ok(line.includes(CATEGORIES[category].label), '缺少分类标签：' + category);
    assert.ok(line.includes(finding.retry));
    assert.ok(line.includes(finding.nextAction));
    const explanation = renderExplanation(finding);
    assert.ok(explanation.includes('分类：'));
    assert.ok(explanation.includes('重试：'));
    assert.ok(explanation.includes('下一步：'));
    assert.ok(describeFinding(finding).includes('下一步='));
  }
  assert.equal(renderExplanation(pass('explainability', 'explainability/x', 'ok')), '');
});

test('auditFindings：坏 finding 被拦截、好 finding 放行、重复 id 被发现', () => {
  const good = fail('explainability', 'explainability/good', '好 finding', {
    code: 'QUALITY_GATE_FAILED',
    detail: '合法细节',
    evidence: { x: 1 },
  });
  assert.deepEqual(auditFindings([good, pass('determinism', 'determinism/ok', '通过项')]), []);
  const bad = { id: 'explainability/bad', gate: 'explainability', title: '坏', ok: false, severity: 'blocking' };
  const audit = auditFindings([bad]);
  assert.ok(audit.length >= 1);
  assert.equal(audit[0].code, 'QUALITY_FINDING_UNEXPLAINED');
  assert.equal(audit[0].category, 'explainability');
  assert.equal(audit[0].retry, 'no');
  // 重复 id 必须被发现。
  const duplicate = fail('explainability', 'explainability/dup', '重复', {
    code: 'QUALITY_GATE_FAILED',
    detail: '合法细节',
    evidence: { x: 1 },
  });
  const duplicateAudit = auditFindings([duplicate, duplicate]);
  assert.equal(duplicateAudit.length, 1);
  // 非 quality 码也不是错误码：说明 finding 的 code 必须来自受控集合。
  const weird = fail('explainability', 'explainability/weird', '怪码', {
    category: 'explainability',
    retry: 'no',
    nextAction: '修正 code',
    detail: 'legal detail',
    code: 'NOT_A_CODE',
    evidence: { x: 1 },
  });
  assert.equal(auditFindings([weird]).length, 1);
});

test('每个错误码都能生成合法 CLI 失败信封（code/retry/hint 规则）', () => {
  for (const code of ERROR_CODE_LIST) {
    const envelope = errorEnvelope({ code, message: 'fixture ' + code });
    assert.deepEqual(validateEnvelope(envelope), [], '信封非法：' + code);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, code);
    assert(RETRY_MODES.includes(envelope.error.retry), '信封缺 retry：' + code);
    const explicitHint = Boolean(ERROR_RECOVERY[code] && ERROR_RECOVERY[code].hint);
    assert.equal(Boolean(envelope.error.hint), explicitHint, 'hint 存在性与单一真源不一致：' + code);
  }
  const decorated = decorateFailure({ ok: false, error: { code: 'E_STALE_REF', message: 'stale', extra: 1 } }, { command: 'observe' });
  assert.equal(decorated.error.extra, 1);
  assert.equal(decorated.error.retry, 'after-action');
  assert.ok(decorated.error.hint.includes('重新 observe'));
});

test('真实 CLI 用法错误：退出码 2 + 单行 JSON 信封（可解释）', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bridge.mjs'), '--json', 'definitely-not-a-command'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(result.status, 2);
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, 'stdout 必须是单行 JSON：' + result.stdout);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.schema, 'bb.cli/1');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'E_ARG_USAGE');
  assert.equal(typeof envelope.error.retry, 'string');
  const explained = explainErrorCode(envelope.error.code);
  assert.ok(explained && explained.nextAction.length >= 4);
});

test('报告渲染：text/markdown/quiet 都带解释与 digest', () => {
  const finding = fail('explainability', 'explainability/demo', '演示阻断项', {
    code: 'QUALITY_FINDING_UNEXPLAINED',
    detail: '演示细节',
    evidence: { demo: true },
  });
  const report = attachDigest({
    schema: 'bb.quality/1',
    gate: { mode: 'check', seed: 'seed', repeats: 3, timeoutMs: 1000 },
    gates: [{ ...summarizeGate('explainability', [finding]), title: '可解释性', consumes: [] }],
    findings: [finding],
    runtime: [{ gate: 'explainability', module: 'lib/error-codes.mjs', symbol: 'ERROR_CODES', location: 'lib/error-codes.mjs:6', consumedAt: 'tools/quality/gates/explainability.mjs:14' }],
    summary: summarizeFindings([finding]),
  });
  assert.equal(verifyDigest(report).ok, true);
  assert.equal(report.summary.verdict, 'FAIL');
  const text = renderText(report);
  assert.match(text, /结论：FAIL/);
  assert.match(text, /分类：可解释性\(explainability\)/);
  assert.match(text, /重试：no/);
  assert.match(text, /下一步：/);
  assert.match(text, /运行时消费点/);
  assert.match(text, /digest=/);
  const quiet = renderQuiet(report);
  assert.match(quiet, /quality verdict=FAIL/);
  assert.equal(quiet.trim().split(/\r?\n/).length, 1);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /# BridgeDeck 质量门禁报告/);
  assert.match(markdown, /\| `explainability\/demo` \|/);
  assert.match(markdown, /可解释性/);
});
