// tools/quality/lib/result.mjs —— finding/check 的唯一模型与自洽校验。
//
// 设计要点（对应任务的可解释性要求）：
// * 每个**失败** finding 必须携带 code + category + retry + nextAction + detail，
//   缺任何一个都不能被构造出来（makeCheck 直接抛 QualityContractError），
//   这样"阻断项没有解释"在源码层就不可能悄悄流进报告。
// * ok finding 不带解释字段，避免给通过项塞噪音；severity 只有 info。
// * 汇总函数是纯函数：同一组 findings 得到同一 verdict/digest/排序。
// * 文本清洗（仓库根/临时目录 → 占位符）保证报告跨机器可复现。

import { canonicalJson, digest16, stableSortBy, stripVolatile } from './canonical.mjs';
import { CATEGORIES, RETRY_MODES, qualityCode, QUALITY_CODES } from './taxonomy.mjs';

export const FINDING_SEVERITIES = Object.freeze(['blocking', 'warning', 'info']);

export class QualityContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'QualityContractError';
    this.code = 'QUALITY_FINDING_UNEXPLAINED';
    this.details = details;
  }
}

let sanitizeRoot = null;
let sanitizeTmp = null;

/** run.mjs 启动时注入仓库根与临时目录，用于把绝对路径替换成稳定占位符。 */
export function configureSanitize({ root = null, tmp = null } = {}) {
  sanitizeRoot = root ? String(root) : null;
  sanitizeTmp = tmp ? String(tmp) : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把绝对路径/换行清洗成稳定单行文本（报告可逐字节复现的前提）。 */
export function sanitizeText(value, options = {}) {
  let text = String(value == null ? '' : value);
  const root = options.root === undefined ? sanitizeRoot : options.root;
  const tmp = options.tmp === undefined ? sanitizeTmp : options.tmp;
  if (root) text = text.split(String(root)).join('<repo>');
  if (tmp) text = text.split(String(tmp)).join('<tmp>');
  text = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  const max = Number(options.max) > 0 ? Number(options.max) : 600;
  if (text.length > max) text = text.slice(0, max - 1) + '…';
  return text;
}

/** 生成解释字段：显式 category 优先，其次 quality code 自带分类。 */
function resolveExplanation({ code, category, retry, nextAction }) {
  let resolvedCategory = category || null;
  let resolvedRetry = retry || null;
  let resolvedNextAction = nextAction || null;
  let resolvedCode = code || null;
  if (resolvedCode && QUALITY_CODES[resolvedCode]) {
    const entry = qualityCode(resolvedCode);
    resolvedCategory = resolvedCategory || entry.category;
    resolvedRetry = resolvedRetry || entry.retry;
    resolvedNextAction = resolvedNextAction || entry.nextAction;
  }
  if (resolvedCategory && CATEGORIES[resolvedCategory]) {
    const base = CATEGORIES[resolvedCategory];
    resolvedRetry = resolvedRetry || base.retry;
    resolvedNextAction = resolvedNextAction || base.nextAction;
  }
  return { code: resolvedCode, category: resolvedCategory, retry: resolvedRetry, nextAction: resolvedNextAction };
}

/** 校验一条 finding 是否可解释、可渲染。返回问题字符串数组。 */
export function validateFinding(finding, options = {}) {
  const problems = [];
  if (!finding || typeof finding !== 'object') return ['finding 不是对象'];
  const id = typeof finding.id === 'string' ? finding.id.trim() : '';
  if (!id) problems.push('缺少 id');
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) problems.push('id 不是 <gate>/<check> 形式：' + id);
  if (typeof finding.gate !== 'string' || !finding.gate) problems.push('缺少 gate');
  if (typeof finding.title !== 'string' || !finding.title) problems.push('缺少 title');
  if (typeof finding.ok !== 'boolean') problems.push('ok 不是布尔值');
  if (!FINDING_SEVERITIES.includes(finding.severity)) problems.push('severity 非法：' + finding.severity);
  if (finding.ok === true) {
    if (finding.severity !== 'info') problems.push('通过项 severity 必须是 info');
    if (options.requireExplainable === true) {
      // 通过项不需要解释，但保留字段时必须形状正确。
      if (finding.retry != null && !RETRY_MODES.includes(finding.retry)) problems.push('通过项 retry 非法：' + finding.retry);
    }
    return problems;
  }
  if (!finding.code) problems.push('失败项缺少 code');
  if (!finding.category || !CATEGORIES[finding.category]) problems.push('失败项缺少合法 category：' + finding.category);
  if (!RETRY_MODES.includes(finding.retry)) problems.push('失败项 retry 非法：' + finding.retry);
  if (typeof finding.nextAction !== 'string' || finding.nextAction.trim().length < 4) problems.push('失败项缺少 nextAction');
  if (typeof finding.detail !== 'string' || finding.detail.trim().length < 4) problems.push('失败项缺少 detail');
  if (finding.severity === 'blocking' && options.requireBlockingDetail === true) {
    const evidence = finding.evidence;
    if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).length === 0) {
      problems.push('阻断项缺少 evidence（无法复核）');
    }
  }
  return problems;
}

/**
 * 构造一条 finding；失败项缺解释时直接抛错。
 * @param {{gate:string,id:string,title:string,ok?:boolean,severity?:string,code?:string,
 *   category?:string,retry?:string,nextAction?:string,detail?:string,evidence?:object,consumes?:string[]}} input
 */
export function makeFinding(input = {}) {
  const ok = input.ok === true;
  const severity = ok ? 'info' : (input.severity || 'blocking');
  const finding = {
    id: String(input.id || ''),
    gate: String(input.gate || ''),
    title: sanitizeText(input.title, { max: 160 }),
    ok,
    severity,
  };
  if (ok) {
    if (input.evidence !== undefined) finding.evidence = stripVolatile(input.evidence);
    if (Array.isArray(input.consumes) && input.consumes.length) finding.consumes = input.consumes.slice();
    return finding;
  }
  if (!FINDING_SEVERITIES.includes(severity) || severity === 'info') {
    throw new QualityContractError('失败 finding 的 severity 必须是 blocking|warning：' + severity, { id: finding.id });
  }
  const explanation = resolveExplanation(input);
  finding.code = explanation.code || 'QUALITY_GATE_FAILED';
  finding.category = explanation.category;
  finding.retry = explanation.retry;
  finding.nextAction = explanation.nextAction;
  finding.detail = sanitizeText(input.detail || '');
  // evidence 里允许出现真实模块的原始输出（含 durationMs/totalMs 等易变字段）；
  // 统一裁掉这类字段，保证报告两次运行逐字节一致。
  if (input.evidence !== undefined) finding.evidence = stripVolatile(input.evidence);
  if (Array.isArray(input.consumes) && input.consumes.length) finding.consumes = input.consumes.slice();
  const problems = validateFinding(finding, { requireExplainable: true });
  if (problems.length) {
    throw new QualityContractError('finding 不符合可解释契约：' + problems.join('；'), { id: finding.id, problems });
  }
  return finding;
}

/** 通过项快捷方式：ok + info。 */
export function pass(gate, id, title, evidence) {
  return makeFinding({ gate, id, title, ok: true, evidence });
}

/** 失败项快捷方式：blocking + 解释。 */
export function fail(gate, id, title, options = {}) {
  return makeFinding({ gate, id, title, ok: false, severity: 'blocking', ...options });
}

/** 警告项快捷方式：warning + 解释，不阻断门禁但会被渲染。 */
export function warn(gate, id, title, options = {}) {
  return makeFinding({ gate, id, title, ok: false, severity: 'warning', ...options });
}

/** 由一组 finding 生成 gate 级汇总。 */
export function summarizeGate(gateId, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const blocking = list.filter((finding) => finding.ok === false && finding.severity === 'blocking');
  const warnings = list.filter((finding) => finding.ok === false && finding.severity === 'warning');
  return {
    id: String(gateId),
    ok: blocking.length === 0,
    checks: list.length,
    passed: list.filter((finding) => finding.ok === true).length,
    blocking: blocking.length,
    warnings: warnings.length,
    blockingIds: blocking.map((finding) => finding.id).sort(),
  };
}

/** 全局汇总（纯函数，顺序稳定）。 */
export function summarizeFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const blocking = list.filter((finding) => finding.ok === false && finding.severity === 'blocking');
  const warnings = list.filter((finding) => finding.ok === false && finding.severity === 'warning');
  return {
    checks: list.length,
    passed: list.filter((finding) => finding.ok === true).length,
    failed: list.filter((finding) => finding.ok === false).length,
    blocking: blocking.length,
    warnings: warnings.length,
    verdict: blocking.length === 0 ? 'PASS' : 'FAIL',
    blockingIds: blocking.map((finding) => finding.id).sort(),
  };
}

/** 稳定排序：先 gate 注册顺序（由调用方保证），gate 内按 id 字典序。 */
export function sortFindings(findings, gateOrder = []) {
  const rank = new Map(gateOrder.map((id, index) => [id, index]));
  return stableSortBy(findings, (finding) => {
    const gateRank = rank.has(finding.gate) ? rank.get(finding.gate) : 999;
    return String(gateRank).padStart(4, '0') + '|' + finding.id;
  });
}

/**
 * 报告摘要：把不参与 digest 的字段（summary.digest 自身）剔除后计算。
 * 同一结构永远同一 digest；改一个字节 digest 就变。
 */
export function reportDigest(report) {
  const clone = { ...report, summary: { ...(report && report.summary ? report.summary : {}) } };
  delete clone.summary.digest;
  return digest16(canonicalJson(clone));
}

export function attachDigest(report) {
  const digest = reportDigest(report);
  return { ...report, summary: { ...report.summary, digest } };
}

/** digest 自校验（测试/CI 用）。 */
export function verifyDigest(report) {
  const expected = report && report.summary ? report.summary.digest : null;
  if (!expected) return { ok: false, reason: 'missing-digest' };
  const actual = reportDigest(report);
  return { ok: expected === actual, expected, actual };
}

/** 把 finding 变成一行可渲染的解释（CLI --text 与审计共用）。 */
export function describeFinding(finding) {
  if (!finding || typeof finding !== 'object') return '';
  if (finding.ok === true) return '✓ ' + finding.id + ' ' + finding.title;
  const categoryLabel = finding.category && CATEGORIES[finding.category] ? CATEGORIES[finding.category].label : finding.category;
  return [
    '✗ ' + finding.id,
    '[' + finding.severity + ']',
    finding.title,
    '· 分类=' + categoryLabel,
    '· 重试=' + finding.retry,
    '· 下一步=' + finding.nextAction,
    finding.detail ? '· 详情=' + finding.detail : '',
  ].filter(Boolean).join(' ');
}
