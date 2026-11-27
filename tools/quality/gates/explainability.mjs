// tools/quality/gates/explainability.mjs —— 可解释性门禁。
//
// 四条硬约束（全部可执行，不靠人工 review）：
//   1) 每个错误码都必须在 taxonomy.mjs 里分类（category/retry/nextAction），
//      且分类表不得出现运行时已删除的码（双向漂移都拦）；
//   2) 每个码的 CLI 失败信封（decorateFailure/errorEnvelope）必须携带可机读的
//      code/retry（有恢复建议时还要有 hint），且通过 validateEnvelope；
//   3) 每个 quality 门禁码都必须登记完整解释，并真实出现在 CLI 可渲染的 finding 里；
//   4) 任何 finding（尤其是 blocking）都必须能被 render.mjs 渲染出
//      分类/重试/下一步 三段；auditFindings 由 run.mjs 在整轮结束后调用，
//      保证"阻断项没有解释"不可能进入最终报告。

import fs from 'node:fs';
import { ERROR_CODES, ERROR_RECOVERY, recoveryHint } from '../../../lib/error-codes.mjs';
import { decorateFailure, errorEnvelope, validateEnvelope } from '../../../cli/lib/json-contract.mjs';
import {
  CATEGORIES,
  ERROR_CATEGORIES,
  QUALITY_CODES,
  QUALITY_CODE_LIST,
  RETRY_MODES,
  explainErrorCode,
  qualityCode,
  validateQualityCodes,
  validateTaxonomy,
} from '../lib/taxonomy.mjs';
import { buildErrorCodeSample } from '../lib/fixtures.mjs';
import { fail, pass, validateFinding } from '../lib/result.mjs';
import { renderExplanation, renderFindingLine } from '../lib/render.mjs';
import { runChildRaw } from '../lib/child.mjs';

export const EXPLAINABILITY_GATE_ID = 'explainability';

/** 错误码显式恢复建议的最低覆盖率（只做健康度告警，不阻断：分类表仍给出 nextAction）。 */
export const MIN_EXPLICIT_HINT_COVERAGE = 0.2;

function gid(name) {
  return EXPLAINABILITY_GATE_ID + '/' + name;
}

/** 分类覆盖：运行时错误码 ↔ 分类表双向一致。 */
function checkTaxonomyCoverage() {
  const problems = validateTaxonomy(ERROR_CODES, ERROR_RECOVERY);
  const codes = Object.keys(ERROR_CODES).length;
  if (problems.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('taxonomy-coverage'), '错误码分类表与运行时真源不一致', {
      code: 'QUALITY_TAXONOMY_DRIFT',
      detail: '共 ' + problems.length + ' 个问题，前 8 个：' + problems.slice(0, 8).map((item) => item.kind + ':' + item.code).join(', '),
      evidence: { count: problems.length, problems: problems.slice(0, 20), codes },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('taxonomy-coverage'), '错误码分类覆盖完整（' + codes + ' 个码，双向无漂移）', {
    codes,
    categories: Object.keys(ERROR_CATEGORIES).length,
  });
}

/** quality 门禁码自身必须完整（category/retry/nextAction/格式）。 */
function checkQualityCodes() {
  const problems = validateQualityCodes();
  if (problems.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('quality-codes'), 'quality 门禁码登记不完整', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: problems.map((item) => item.kind + ':' + item.code).join(', '),
      evidence: { problems },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('quality-codes'), 'quality 门禁码登记完整（' + QUALITY_CODE_LIST.length + ' 个）', {
    codes: QUALITY_CODE_LIST,
  });
}

/** retry 语义单一真源 + 显式 hint 覆盖率健康度。 */
function checkRetryConsistency() {
  const mismatches = [];
  let explicit = 0;
  const codes = Object.keys(ERROR_CODES).sort();
  for (const code of codes) {
    const taxonomy = explainErrorCode(code);
    const recovery = ERROR_RECOVERY[code];
    if (recovery) {
      explicit += 1;
      if (recovery.retry && taxonomy && recovery.retry !== taxonomy.retry) {
        mismatches.push({ code, taxonomy: taxonomy.retry, recovery: recovery.retry });
      }
      if (recovery.hint && recoveryHint(code).hint !== recovery.hint) {
        mismatches.push({ code, field: 'hint' });
      }
    }
    if (taxonomy) {
      if (!RETRY_MODES.includes(taxonomy.retry)) mismatches.push({ code, field: 'retry-mode', value: taxonomy.retry });
      if (!ERROR_CATEGORIES[taxonomy.category]) mismatches.push({ code, field: 'category', value: taxonomy.category });
    }
  }
  if (mismatches.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('retry-consistency'), '错误码 retry 语义与单一真源不一致', {
      code: 'QUALITY_TAXONOMY_DRIFT',
      detail: '不一致数量=' + mismatches.length + '，前 5 个：' + JSON.stringify(mismatches.slice(0, 5)),
      evidence: { mismatches: mismatches.slice(0, 20) },
    });
  }
  const coverage = codes.length ? explicit / codes.length : 1;
  const evidence = {
    codes: codes.length,
    explicitHints: explicit,
    coverage: Number(coverage.toFixed(3)),
    minCoverage: MIN_EXPLICIT_HINT_COVERAGE,
  };
  if (coverage < MIN_EXPLICIT_HINT_COVERAGE) {
    // 健康度告警：分类表仍给 nextAction，但显式恢复建议不足会影响 CLI 提示质量。
    return fail(EXPLAINABILITY_GATE_ID, gid('retry-consistency'), '显式恢复建议覆盖率过低', {
      severity: 'warning',
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '显式 hint 覆盖率 ' + (coverage * 100).toFixed(1) + '% 低于阈值 ' + (MIN_EXPLICIT_HINT_COVERAGE * 100) + '%',
      evidence,
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('retry-consistency'), 'retry 与 hint 单一真源一致；显式恢复建议覆盖率 ' + (coverage * 100).toFixed(1) + '%', evidence);
}

/**
 * 每个错误码都要能生成合法 CLI 失败信封：
 * schema/ok/error.code/message 齐备；retry 必填；有恢复建议时 hint 必须出现。
 */
function checkCliEnvelopeForEveryCode() {
  const codes = Object.keys(ERROR_CODES).sort();
  const failures = [];
  for (const code of codes) {
    const envelope = errorEnvelope({ code, message: 'fixture message for ' + code });
    const problems = validateEnvelope(envelope);
    if (problems.length) {
      failures.push({ code, kind: 'invalid-envelope', problems });
      continue;
    }
    if (envelope.error.retry === undefined) failures.push({ code, kind: 'missing-retry' });
    if (!RETRY_MODES.includes(envelope.error.retry)) failures.push({ code, kind: 'bad-retry', value: envelope.error.retry });
    const explicitHint = Boolean(ERROR_RECOVERY[code] && ERROR_RECOVERY[code].hint);
    if (explicitHint && !envelope.error.hint) failures.push({ code, kind: 'missing-hint' });
    if (!explicitHint && envelope.error.hint) failures.push({ code, kind: 'unexpected-hint' });
  }
  if (failures.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-envelope'), '错误码无法生成合法 CLI 失败信封', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '失败码数量=' + failures.length + '，前 5 个：' + JSON.stringify(failures.slice(0, 5)),
      evidence: { failures: failures.slice(0, 20), checked: codes.length },
    });
  }
  // decorateFailure 必须保留既有 error 字段（只加不改），并补齐 retry。
  const sample = buildErrorCodeSample(codes, 10);
  for (const code of sample) {
    const decorated = decorateFailure({ ok: false, error: { code, message: 'x', extra: 1 } }, { command: 'fixture' });
    if (decorated.error.code !== code || decorated.error.extra !== 1 || decorated.error.retry === undefined) {
      return fail(EXPLAINABILITY_GATE_ID, gid('cli-envelope'), 'decorateFailure 改动了既有 error 字段或未补 retry', {
        code: 'QUALITY_FINDING_UNEXPLAINED',
        detail: '码 ' + code + ' 的装饰结果=' + JSON.stringify(decorated.error),
        evidence: { code, decorated: decorated.error },
      });
    }
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('cli-envelope'), '全部 ' + codes.length + ' 个错误码都能生成含 code/retry（及 hint）的合法 CLI 信封', {
    checked: codes.length,
    sample,
  });
}

/** 真实 CLI 结构化失败：退出码 2 + 单行 JSON 信封（stdout 可解析）。 */
function checkRealCliFailure(ctx) {
  const run = runChildRaw(ctx.root, 'cli/bridge.mjs', ['--json', 'definitely-not-a-command']);
  if (run.detail) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), '真实 CLI 子进程执行失败', {
      code: 'QUALITY_CHILD_FAILED',
      detail: run.detail,
      evidence: { code: run.code },
    });
  }
  if (run.code !== 2) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), 'CLI 用法错误退出码不是 2', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '实际退出码=' + run.code,
      evidence: { code: run.code, stderr: String(run.stderr || '').slice(0, 200) },
    });
  }
  const lines = String(run.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), '--json 模式下 stdout 不是单行 JSON', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: 'stdout 行数=' + lines.length,
      evidence: { lines: lines.slice(0, 4) },
    });
  }
  let envelope = null;
  try {
    envelope = JSON.parse(lines[0]);
  } catch (error) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), 'CLI 失败信封不是合法 JSON', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: String(error.message || error),
      evidence: { stdout: lines[0].slice(0, 400) },
    });
  }
  const problems = validateEnvelope(envelope);
  const code = envelope && envelope.error ? envelope.error.code : null;
  const explained = code ? explainErrorCode(code) : null;
  const ok = problems.length === 0 && envelope.ok === false && code === 'E_ARG_USAGE'
    && typeof envelope.error.retry === 'string' && explained && explained.nextAction.length >= 4;
  if (!ok) {
    return fail(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), 'CLI 结构化失败缺少可解释字段', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '信封问题=' + JSON.stringify(problems) + '，码=' + code,
      evidence: { envelope: envelope || null, explained: explained || null },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('cli-render-real'), '真实 CLI 用法错误：退出码 2 + 单行 JSON 信封（code/retry/分类 nextAction 齐全）', {
    code,
    retry: envelope.error.retry,
    nextAction: explained.nextAction,
    schema: envelope.schema,
  });
}

/** 渲染器能处理任意合法 finding（分类/重试/下一步 三段齐全）。 */
function checkRenderableFindings() {
  const failures = [];
  for (const category of Object.keys(CATEGORIES)) {
    const finding = fail(EXPLAINABILITY_GATE_ID, gid('render-' + category), '渲染夹具（' + category + '）', {
      category,
      code: 'QUALITY_GATE_FAILED',
      detail: '渲染器夹具：验证 分类/重试/下一步 三段输出（' + category + '）',
      evidence: { category },
    });
    const line = renderFindingLine(finding);
    const explanation = renderExplanation(finding);
    const label = CATEGORIES[category].label;
    if (!line.includes(label) || !line.includes(finding.retry) || !line.includes(finding.nextAction)) {
      failures.push({ category, kind: 'line', line });
      continue;
    }
    if (!explanation.includes('分类：') || !explanation.includes('重试：') || !explanation.includes('下一步：')) {
      failures.push({ category, kind: 'explanation', explanation });
    }
  }
  if (failures.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('renderable-findings'), '渲染器没有输出完整的 分类/重试/下一步', {
      code: 'QUALITY_RENDER_UNSUPPORTED',
      detail: JSON.stringify(failures.slice(0, 4)),
      evidence: { failures },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('renderable-findings'), '渲染器对全部 ' + Object.keys(CATEGORIES).length + ' 个分类都输出 分类/重试/下一步', {
    categories: Object.keys(CATEGORIES),
  });
}

/** quality 门禁码必须真的在 gate 源码里被使用（防止登记后忘记使用/使用未登记码）。 */
function checkGateCodesRegistered(ctx) {
  const gates = ['determinism', 'idempotency', 'explainability', 'antifragility'];
  const referenced = new Set();
  const missingFiles = [];
  for (const gate of gates) {
    const rel = 'tools/quality/gates/' + gate + '.mjs';
    let text = null;
    try {
      text = fs.readFileSync(ctx.root + '/' + rel, 'utf8');
    } catch {
      missingFiles.push(rel);
      continue;
    }
    for (const match of text.matchAll(/'(QUALITY_[A-Z0-9_]+)'/g)) referenced.add(match[1]);
  }
  const unregistered = [...referenced].filter((code) => !QUALITY_CODES[code]).sort();
  if (missingFiles.length || unregistered.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('gate-codes-registered'), 'gate 源码使用了未登记的 quality 门禁码', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '未登记=' + JSON.stringify(unregistered) + '，缺失 gate 文件=' + JSON.stringify(missingFiles),
      evidence: { unregistered, referenced: [...referenced].sort(), missingFiles },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('gate-codes-registered'), 'gate 源码引用的 quality 门禁码全部已登记（' + referenced.size + ' 个）', {
    referenced: [...referenced].sort(),
  });
}

/**
 * 整轮结束后的 finding 审计：run.mjs 在报告定稿前调用。
 * 返回违规 finding（gate=explainability），由 run.mjs 追加进报告。
 */
export function auditFindings(findings) {
  const violations = [];
  const seen = new Set();
  const list = Array.isArray(findings) ? findings : [];
  for (let index = 0; index < list.length; index += 1) {
    const finding = list[index];
    const label = finding && finding.id ? String(finding.id) : 'finding#' + index;
    const problems = validateFinding(finding, { requireExplainable: true, requireBlockingDetail: true });
    if (finding && typeof finding === 'object' && finding.id) {
      if (seen.has(finding.id)) problems.push('finding id 重复：' + finding.id);
      seen.add(finding.id);
    }
    if (finding && finding.ok === false) {
      const line = renderFindingLine(finding);
      if (!line.includes(finding.nextAction || '\u0000') || !line.includes(finding.retry || '\u0000')) {
        problems.push('渲染器无法输出重试/下一步');
      }
      if (finding.code && !QUALITY_CODES[finding.code] && !/^E_/.test(finding.code)) {
        problems.push('finding.code 既不是 quality 门禁码也不是错误码：' + finding.code);
      }
    }
    if (problems.length) {
      violations.push({
        id: 'explainability/audit-' + String(index + 1).padStart(3, '0'),
        label,
        problems,
      });
    }
  }
  return violations.map((violation) => fail(EXPLAINABILITY_GATE_ID, violation.id, 'finding 不符合可解释契约：' + violation.label, {
    code: 'QUALITY_FINDING_UNEXPLAINED',
    detail: violation.problems.join('；').slice(0, 400),
    evidence: { target: violation.label, problems: violation.problems.slice(0, 10) },
  }));
}

/** 审计负控制：坏 finding 必须被抓、好 finding 必须放行（证明审计非空转）。 */
function checkAuditControl() {
  const bad = { id: 'explainability/audit-bad', gate: EXPLAINABILITY_GATE_ID, ok: false, severity: 'blocking', title: '坏 finding' };
  const good = fail(EXPLAINABILITY_GATE_ID, gid('audit-good'), '好 finding', {
    code: 'QUALITY_GATE_FAILED',
    detail: '合法 finding：带 category/retry/nextAction 与 evidence',
    evidence: { fixture: true },
  });
  const badAudit = auditFindings([bad]);
  const goodAudit = auditFindings([good]);
  const ok = badAudit.length >= 1 && badAudit.every((finding) => finding.ok === false && finding.code === 'QUALITY_FINDING_UNEXPLAINED')
    && goodAudit.length === 0;
  if (!ok) {
    return fail(EXPLAINABILITY_GATE_ID, gid('audit-control'), 'finding 审计失去作用（坏样本未被拦截或好样本被误判）', {
      code: 'QUALITY_FINDING_UNEXPLAINED',
      detail: '坏样本拦截=' + badAudit.length + '，好样本误判=' + goodAudit.length,
      evidence: { badAudit, goodAudit },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('audit-control'), 'finding 审计负控制通过：坏样本被拦截、好样本放行', {
    badCount: badAudit.length,
  });
}

/** 分类表/quality 码的解释样本可被 CLI 风格渲染（每类至少一条）。 */
function checkQualityCodeRender() {
  const failures = [];
  for (const code of QUALITY_CODE_LIST) {
    const entry = qualityCode(code);
    if (!CATEGORIES[entry.category] || !RETRY_MODES.includes(entry.retry) || !entry.nextAction) {
      failures.push({ code, kind: 'incomplete' });
      continue;
    }
    const finding = fail(EXPLAINABILITY_GATE_ID, gid('quality-render-' + code.toLowerCase().replace(/_/g, '-')), '门禁码渲染夹具 ' + code, {
      code,
      detail: '门禁码渲染夹具：' + code,
      evidence: { code },
    });
    const line = renderFindingLine(finding);
    if (!line.includes(CATEGORIES[entry.category].label) || !line.includes(entry.retry) || !line.includes(entry.nextAction)) {
      failures.push({ code, kind: 'render', line });
    }
  }
  if (failures.length) {
    return fail(EXPLAINABILITY_GATE_ID, gid('quality-code-render'), 'quality 门禁码无法被渲染', {
      code: 'QUALITY_RENDER_UNSUPPORTED',
      detail: JSON.stringify(failures.slice(0, 5)),
      evidence: { failures },
    });
  }
  return pass(EXPLAINABILITY_GATE_ID, gid('quality-code-render'), '全部 ' + QUALITY_CODE_LIST.length + ' 个门禁码均可渲染 分类/重试/下一步', {
    codes: QUALITY_CODE_LIST,
  });
}

export async function runExplainabilityChecks(ctx = {}) {
  const findings = [];
  findings.push(checkTaxonomyCoverage());
  findings.push(checkQualityCodes());
  findings.push(checkRetryConsistency());
  findings.push(checkCliEnvelopeForEveryCode());
  findings.push(checkRealCliFailure(ctx));
  findings.push(checkRenderableFindings());
  findings.push(checkGateCodesRegistered(ctx));
  findings.push(checkAuditControl());
  findings.push(checkQualityCodeRender());
  return findings;
}

export const GATE = {
  id: EXPLAINABILITY_GATE_ID,
  title: '可解释性（错误码/阻断项的 category+nextAction+retry 与 CLI 渲染）',
  consumes: ['lib/error-codes.mjs', 'cli/lib/json-contract.mjs'],
  run: runExplainabilityChecks,
};

export default GATE;
