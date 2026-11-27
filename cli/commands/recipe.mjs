// cli/commands/recipe.mjs —— `bridge recipe list|show|save|draft|approve|run|rm`。
//
// 本地 recipe store / draft 模块按需动态 import（保持 CLI 启动快）；
// plan 执行器（executeRecipeBlocks）由 bridge 注入，dry-run 用同一份 store 做只读预检。
//
// step 模型 v2（lib/recipe-model.mjs）与执行器（lib/recipe-engine.mjs）都是纯函数：
//   - 参数：recipe.params 声明默认值/类型/枚举，--param 覆盖；
//   - 失败策略：stop/retry/skip（非幂等动作默认拒绝重试）；
//   - human gate：human 步骤 + step.confirm 的逐步确认；
//   - 差异报告：step.expect 期望 vs 实际，落到 <name>.report.json；
//   - 预检：dry-run 展示展平步骤/风险/幂等标记/阻塞项，真实执行前断言同一份预检。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMutatingInCatalog } from '../../lib/method-catalog.mjs';
import { recipeStepType, normalizeLoopTimes } from '../../lib/recipe-blocks.mjs';
import { parseDurationMs } from '../lib/args.mjs';
import { ContractError, RISK, maxRisk } from '../lib/arg-contract.mjs';
import {
  buildPlan, callStep, dryRunNotes, dryRunResult, isDryRun, localStep, outputDryRun, renderDryRun, rpcStep,
} from '../lib/action-plan.mjs';

/** 静态投影 recipe 的块结构（if/loop/human），给 dry-run 用；不执行任何动作。 */
export function projectRecipeSteps(steps) {
  const segments = [];
  const humanNodes = [];
  const ifNodes = [];
  const loopCounts = [];
  const methods = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push(current);
    current = [];
  };
  const walk = (list) => {
    for (const step of Array.isArray(list) ? list : []) {
      const type = recipeStepType(step);
      if (type === 'human') {
        flush();
        humanNodes.push(String(step.reason || step.prompt || '请完成人工步骤'));
        continue;
      }
      if (type === 'if') {
        flush();
        ifNodes.push(step);
        // if 的两个分支都要在“最坏情况”里被看到：投影按 then 分支统计风险，
        // else 分支同样计入风险（避免 dry-run 少报危险步骤）。
        walk(step.then);
        walk(step.else);
        continue;
      }
      if (type === 'loop') {
        flush();
        const times = normalizeLoopTimes(step.times);
        if (!times) {
          throw new ContractError('E_ARG_TYPE', 'recipe loop 需要 1-50 的 times', {
            hint: '改 recipe 里 loop 的 times（1-50 的整数或 "3"）。',
            usage: 'bridge recipe run <name>',
          });
        }
        loopCounts.push(times);
        for (let index = 0; index < times; index += 1) walk(step.steps);
        continue;
      }
      methods.push(String(step && step.method || ''));
      current.push(step);
      if (current.length >= 25) flush();
    }
  };
  walk(steps);
  flush();
  return { segments, humanNodes, ifNodes, loopCounts, methods };
}

// ---------------------------------------------------------------------------
// 回放差异报告收口（W5-B）：run 的 --json / 文本 / report.json / diff.json 共用同一份
// 差异文档与失败原因分类，避免“文本说一套、JSON 另一套”。
// ---------------------------------------------------------------------------

/** 失败原因分类：类别 → 人类可读标签。分类只依赖错误码前缀，稳定且可单测。 */
export const RECIPE_FAILURE_CATEGORIES = Object.freeze({
  policy: '审批/策略闸门',
  target: '目标定位',
  timing: '等待/超时',
  transport: '传输/守护进程',
  auth: '权限/配对',
  expectation: '期望校验',
  input: '参数/输入',
  internal: '内部错误',
});

const FAILURE_CATEGORY_RULES = Object.freeze([
  [/^E_(RECIPE|HUMAN|READ_ONLY|NOT_APPROVED|APPROVAL|POLICY|GATE)/, 'policy'],
  [/^E_(TARGET|ROW|REF|STALE|ELEMENT|SELECTOR|NOT_FOUND|DOM)/, 'target'],
  [/^E_(TIMEOUT|NAVIGATION|WAIT|BUSY|LOCK|CANCEL)/, 'timing'],
  [/^E_(NETWORK|HTTP|DNS|TLS|CONNECT|PROTOCOL|DAEMON|RPC|WS)/, 'transport'],
  [/^E_(PERMISSION|AUTH|PAIR|SECRET|SANDBOX|SCOPE)/, 'auth'],
  [/^E_(EXPECT|DIFF|ASSERT|VERIFY)/, 'expectation'],
  [/^E_(ARG|INVALID|BAD|TYPE|STATE|MISSING|CONFLICT)/, 'input'],
]);

/**
 * 失败码 → 分类与可读说明。
 * @param {string} code 错误码（如 E_TARGET_MISMATCH）
 * @param {{ retryable?: boolean, attempts?: number }} [options]
 */
export function classifyRecipeFailure(code, options = {}) {
  const normalized = String(code || 'E_INTERNAL').trim() || 'E_INTERNAL';
  let category = 'internal';
  for (const [pattern, name] of FAILURE_CATEGORY_RULES) {
    if (pattern.test(normalized)) { category = name; break; }
  }
  const retryable = options.retryable === true;
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const hints = {
    policy: '这是人工/审批闸门：先按提示完成审批或放宽只读安全策略，再重跑。',
    target: '目标不存在或已变化：用 --dry-run 复现预检，重建 recipe（ref 可能过期）。',
    timing: '等待类失败：检查页面是否已加载完成，适当调大 --wait-timeout / 步骤 fallback。',
    transport: '传输层失败：确认 daemon/扩展在线（bridge status）后重跑。',
    auth: '权限/配对失败：按提示重新配对或授权，避免用 agent 自签。',
    expectation: '期望与实际不一致：看差异明细决定改 recipe 期望还是修页面。',
    input: '参数/输入不合法：按提示修正 recipe JSON 或 --param 后再跑。',
    internal: '内部错误：保留 report/diff 证据，复现后按错误码排查。',
  };
  return {
    code: normalized,
    category,
    label: RECIPE_FAILURE_CATEGORIES[category],
    retryable,
    attempts,
    retryHint: retryable ? '可按失败策略重试（幂等或显式 retrySafe）。' : '默认不重试：避免非幂等动作重复副作用。',
    next: hints[category],
  };
}

function normalizeSeverity(value) {
  return ['error', 'warning', 'info'].includes(value) ? value : 'error';
}

const DIFF_FIELD_FAMILIES = Object.freeze([
  [/^url/, 'url'],
  [/^selector/, 'target'],
  [/^(equals|notEquals|contains|truthy|resultPath)/, 'result'],
  [/^(methodOk|count)/, 'method'],
]);

/** 差异字段 → 家族名（url/target/result/method/other），用于聚合与文本摘要。 */
export function diffFieldFamily(field) {
  const name = String(field || '');
  for (const [pattern, family] of DIFF_FIELD_FAMILIES) {
    if (pattern.test(name)) return family;
  }
  return 'other';
}

function compactResults(results) {
  return (Array.isArray(results) ? results : []).slice(0, 200).map((result) => ({
    ref: String(result && result.ref || ''),
    path: String(result && result.path || ''),
    kind: String(result && result.kind || ''),
    method: String(result && result.method || ''),
    status: String(result && result.status || 'unknown'),
    attempts: Math.max(0, Number(result && result.attempts) || 0),
    durationMs: Math.max(0, Number(result && result.durationMs) || 0),
    ...(Array.isArray(result && result.diff) && result.diff.length ? { diffFields: result.diff.map((item) => String(item && item.field || '')) } : {}),
    ...(result && result.error ? { error: { code: String(result.error.code || ''), message: String(result.error.message || '') } } : {}),
  }));
}

/**
 * 组装结构化差异文档（run report.json / diff.json / JSON 输出的共同数据源）。
 * @param {object} input { recipe, report, results, ok, planned, completed, failedAt, paramsFingerprint, error, now, files }
 */
export function buildRecipeDiffDocument(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const report = source.report && typeof source.report === 'object' ? source.report : source;
  const results = Array.isArray(source.results) ? source.results : (Array.isArray(report.results) ? report.results : []);
  const rawDifferences = Array.isArray(report.differences) ? report.differences : [];
  const differences = rawDifferences.map((difference) => {
    const severity = normalizeSeverity(difference && difference.severity);
    return {
      ref: String(difference && difference.ref || ''),
      path: String(difference && difference.path || ''),
      method: String(difference && difference.method || ''),
      field: String(difference && difference.field || ''),
      family: diffFieldFamily(difference && difference.field),
      severity,
      severityLabel: severity === 'error' ? '错误' : (severity === 'warning' ? '警告' : '信息'),
      expected: difference && difference.expected !== undefined ? difference.expected : null,
      actual: difference && difference.actual !== undefined ? difference.actual : null,
    };
  });
  const bySeverity = { error: 0, warning: 0, info: 0 };
  const byField = {};
  const byRef = {};
  for (const difference of differences) {
    bySeverity[difference.severity] += 1;
    byField[difference.field] = (byField[difference.field] || 0) + 1;
    const ref = difference.ref || '(无 ref)';
    byRef[ref] = (byRef[ref] || 0) + 1;
  }
  const statuses = report.statuses && typeof report.statuses === 'object' ? report.statuses : {};
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const firstFailure = failures[0] || (source.error ? { code: source.error.code, message: source.error.message, retryable: false, attempts: 1 } : null);
  const classification = firstFailure
    ? classifyRecipeFailure(firstFailure.code || 'E_INTERNAL', { retryable: firstFailure.retryable === true, attempts: firstFailure.attempts })
    : null;
  return {
    version: 1,
    recipe: String(source.recipe || report.recipe || ''),
    at: Number.isFinite(Number(source.now)) ? Number(source.now) : Date.now(),
    ok: source.ok !== undefined ? source.ok === true : report.ok === true,
    planned: Math.max(0, Number(source.planned != null ? source.planned : report.planned) || 0),
    completed: Math.max(0, Number(source.completed != null ? source.completed : report.completed) || 0),
    failedAt: source.failedAt !== undefined ? source.failedAt : (report.failedAt !== undefined ? report.failedAt : null),
    failedPath: source.failedPath !== undefined ? source.failedPath : (report.failedPath !== undefined ? report.failedPath : null),
    durationMs: Math.max(0, Number(report.durationMs) || 0),
    paramsFingerprint: source.paramsFingerprint || report.paramsFingerprint || null,
    statuses: {
      ok: Number(statuses.ok) || 0,
      failed: Number(statuses.failed) || 0,
      skipped: Number(statuses.skipped) || 0,
      blocked: Number(statuses.blocked) || 0,
      mismatch: Number(statuses.mismatch) || 0,
    },
    summary: {
      differences: differences.length,
      bySeverity,
      byField,
      byRef,
      steps: results.length,
      failures: failures.length,
      retryable: Array.isArray(report.retryable) ? report.retryable.length : failures.filter((item) => item && item.retryable === true).length,
    },
    differences,
    failures: failures.map((failure) => ({
      ref: String(failure && failure.ref || ''),
      path: String(failure && failure.path || ''),
      method: String(failure && failure.method || ''),
      code: String(failure && failure.code || 'E_INTERNAL'),
      message: String(failure && failure.message || ''),
      attempts: Math.max(1, Number(failure && failure.attempts) || 1),
      retryable: failure && failure.retryable === true,
    })),
    classification,
    evidence: { results: compactResults(results) },
    ...(source.files && typeof source.files === 'object' ? { files: source.files } : {}),
  };
}

/** 差异文档 → 人类可读行（--json 之外的 CLI 文本）。 */
export function renderRecipeDiffLines(document, options = {}) {
  const doc = document && typeof document === 'object' ? document : {};
  const max = Math.max(1, Number(options.max) || 10);
  const lines = [];
  const status = doc.ok ? '成功' : '失败';
  lines.push('recipe ' + (doc.recipe || '(未命名)') + ' 差异报告：' + status + '，完成 ' + (doc.completed || 0) + '/' + (doc.planned || 0) + (doc.durationMs ? '，耗时 ' + doc.durationMs + 'ms' : ''));
  const summary = doc.summary || { differences: 0, bySeverity: { error: 0, warning: 0, info: 0 }, byField: {} };
  if (!summary.differences) {
    lines.push('差异：无（所有期望都满足）');
  } else {
    lines.push('差异：' + summary.differences + ' 条（错误 ' + (summary.bySeverity.error || 0) + ' / 警告 ' + (summary.bySeverity.warning || 0) + ' / 信息 ' + (summary.bySeverity.info || 0) + '）');
    for (const difference of (doc.differences || []).slice(0, max)) {
      lines.push('  - [' + difference.severityLabel + '] ' + (difference.ref || '-') + ' ' + (difference.method || '-') + ' ' + difference.field + '：期望 ' + JSON.stringify(difference.expected) + '，实际 ' + JSON.stringify(difference.actual));
    }
    if ((doc.differences || []).length > max) lines.push('  … 另有 ' + ((doc.differences || []).length - max) + ' 条差异（--json 查看全部）');
    const fieldNames = Object.keys(summary.byField || {}).sort((left, right) => summary.byField[right] - summary.byField[left]);
    if (fieldNames.length) lines.push('差异字段：' + fieldNames.map((field) => field + '×' + summary.byField[field]).join('、'));
  }
  if (doc.classification) {
    lines.push('失败分类：' + doc.classification.category + '（' + doc.classification.label + '）· ' + doc.classification.code);
    lines.push('恢复建议：' + doc.classification.retryHint + ' ' + doc.classification.next);
  }
  return lines;
}

/** 失败分类的紧凑 JSON（错误信封里用）。 */
export function failureClassificationOf(error, options = {}) {
  if (!error || typeof error !== 'object') return null;
  return classifyRecipeFailure(error.code || 'E_INTERNAL', options);
}

/** 原子写 diff.json（目录不存在时创建）。 */
export function writeRecipeDiffFile(file, document) {
  const target = String(file || '');
  if (!target) throw new ArgErrorLike('E_BAD_ARG', 'recipe diff 文件路径为空');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...document, file: target }, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 忽略 */ }
    throw error;
  }
  return target;
}

/** 本地 ArgError 兼容（避免 helper 依赖注入的 ArgError 实例）。 */
function ArgErrorLike(code, message) {
  const error = new Error(message);
  error.name = 'ArgErrorLike';
  error.code = code;
  return error;
}

export function createRecipeCommand({
  recipeDir,
  executeRecipeBlocks,
  isJson,
  emitJson,
  print,
  outputFailure,
  outputJsonBody,
  BridgeError,
  ArgError,
  requirePos,
  intFlag,
  callRpc,
  timeoutOf,
  renderTable,
  spec,
}) {
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson,
    print,
  };

  async function loadStore() {
    return import('../../lib/recipe-store.mjs');
  }

  /** 与 bridge.withControl 对齐的公共参数（recipe run 的 plan/evaluate/request-help 都要带）。 */
  function controlParams(flags) {
    const out = {};
    if (flags.session !== undefined) out.session = String(flags.session);
    else if (flags['session-scope'] !== undefined) out.sessionScope = String(flags['session-scope']);
    else if (process.env.BB_SESSION && process.env.BB_SESSION.trim()) out.session = process.env.BB_SESSION.trim();
    else if (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()) out.sessionScope = process.env.BB_SESSION_SCOPE.trim();
    if (flags['tab-id'] !== undefined) {
      const raw = String(flags['tab-id']);
      if (/^\d+$/.test(raw)) out.tabId = Number(raw);
      else if (flags['dry-run'] === true) out.tabId = '<tabId:' + raw + '>';
      else throw new ArgError('--tab-id 需要整数或 tab 别名（先用 bridge tab alias 设置）');
    }
    if (flags.context !== undefined) out.context = String(flags.context);
    if (flags.observation !== undefined) out.observation = String(flags.observation);
    if (flags.expect !== undefined) {
      let expect;
      try {
        expect = JSON.parse(String(flags.expect));
      } catch (error) {
        throw new ArgError('--expect 不是合法 JSON：' + error.message);
      }
      if (!Array.isArray(expect)) throw new ArgError('--expect 需要数组');
      out.expect = expect;
    }
    if (flags['depends-on'] !== undefined) {
      let dependsOn;
      try {
        dependsOn = JSON.parse(String(flags['depends-on']));
      } catch (error) {
        throw new ArgError('--depends-on 不是合法 JSON：' + error.message);
      }
      if (!Array.isArray(dependsOn)) throw new ArgError('--depends-on 需要数组');
      out.dependsOn = dependsOn;
    }
    if (flags.settle !== undefined) out.settleMs = parseDurationMs(flags.settle, 0);
    if (flags['node-scope'] === true) out.nodeScope = true;
    if (flags.focus === true) out.focus = true;
    if (flags['wait-timeout'] !== undefined) {
      const waitMs = parseDurationMs(flags['wait-timeout'], 0);
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new ArgError('--wait-timeout 需要非负毫秒数');
      out.waitTimeoutMs = waitMs;
    }
    return out;
  }

  /** 注入给 lib/recipe-engine.mjs 的 driver：全部走真实 daemon RPC。 */
  function engineDrivers(flags) {
    const base = () => controlParams(flags);
    const rpcTimeout = () => timeoutOf(flags);
    return {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
      runSteps: async (steps) => callRpc('plan', { ...base(), steps }, Math.max(rpcTimeout(), 180000)),
      evaluate: async (expression) => {
        const body = await callRpc('evaluate', { ...base(), expression: String(expression) }, Math.max(rpcTimeout(), 15000));
        if (!body.ok) return body;
        return { ok: true, value: body.result && body.result.value, result: body.result };
      },
      requestHelp: async ({ reason, timeoutMs }) => {
        const waitMs = Math.max(5000, Math.min(Number(timeoutMs) || 180000, 1_800_000));
        const body = await callRpc('request-help', { ...base(), reason: String(reason), timeoutMs: waitMs }, waitMs + 5000);
        return body;
      },
    };
  }

  /** recipe run 的静态投影：把块结构展开成 dry-run 的步骤/风险/人工节点。 */
  function buildRunPlan(recipe, name, steps, flags) {
    const projection = projectRecipeSteps(steps);
    const risk = maxRisk([
      projection.humanNodes.length ? RISK.HUMAN_GATE : RISK.READ_ONLY,
      projection.methods.filter((method) => method && isMutatingInCatalog(method)).length ? RISK.BROWSER_MUTATION : RISK.READ_ONLY,
    ]);
    const planSteps = [];
    projection.segments.forEach((segment, index) => {
      planSteps.push(rpcStep('plan', { steps: segment }, {
        description: '回放第 ' + (index + 1) + ' 段（' + segment.length + ' 步）',
        target: { kind: 'recipe', name: String(name) },
        risk: segment.some((step) => step && isMutatingInCatalog(String(step.method || ''))) ? RISK.BROWSER_MUTATION : RISK.READ_ONLY,
        minTimeoutMs: 180000,
      }));
    });
    for (const reason of projection.humanNodes) {
      planSteps.push(rpcStep('request-help', {
        reason,
        timeoutMs: 180000,
      }, {
        description: '等待人工节点：' + reason,
        target: { kind: 'human', name: reason },
        risk: RISK.HUMAN_GATE,
        minTimeoutMs: 185000,
      }));
    }
    const warnings = [];
    if (projection.ifNodes.length) warnings.push('recipe 含 ' + projection.ifNodes.length + ' 个 if 块：分支按运行时 URL 选择，dry-run 只按两分支合计风险。');
    if (projection.loopCounts.length) warnings.push('recipe 含 loop 块：次数 ' + projection.loopCounts.join('/') + '，dry-run 已按次数展开风险统计。');
    const approved = recipe && recipe.approvedAt
      ? ['已审批（by ' + (recipe.approver || 'unknown') + '，审批时间 ' + new Date(recipe.approvedAt).toISOString() + '）']
      : [];
    return buildPlan({
      command: 'recipe',
      subcommand: 'run',
      risk,
      steps: planSteps,
      warnings,
      confirmations: approved,
      notes: dryRunNotes(flags),
    });
  }

  /** 读取 v2 模块（动态 import 保持 CLI 冷启动）。 */
  async function loadModel() {
    return import('../../lib/recipe-model.mjs');
  }
  async function loadPreflight() {
    return import('../../lib/recipe-preflight.mjs');
  }
  async function loadParams() {
    return import('../../lib/recipe-params.mjs');
  }
  async function loadEngine() {
    return import('../../lib/recipe-engine.mjs');
  }
  async function loadDraftV2() {
    return import('../../lib/recipe-draft-v2.mjs');
  }

  /** 预检 + 归一化（save/show/run 共用）。 */
  async function inspectRecipe(recipe, stepsInput, options = {}) {
    const model = await loadModel();
    const preflightModule = await loadPreflight();
    const paramsModule = await loadParams();
    const rawSteps = Array.isArray(stepsInput) ? stepsInput : (recipe && recipe.steps);
    const normalized = model.normalizeRecipeSteps(rawSteps, { defaults: (recipe && recipe.policy) || {} });
    const templateNames = paramsModule.collectRecipeParamNames(rawSteps);
    const preflight = preflightModule.preflightRecipe(rawSteps, {
      approved: options.approved === true,
      readOnly: options.readOnly === true,
      params: options.params || {},
      declaredParams: (recipe && recipe.params) || [],
      paramNames: templateNames,
    });
    return { normalized, preflight, templateNames, paramsModule, preflightModule };
  }

  /** 解析 --param 并按 recipe.params 声明校验/填默认值。 */
  async function resolveRunParams(recipe, flags) {
    const { RecipeStoreError } = await loadStore();
    const paramsModule = await loadParams();
    let provided;
    try {
      provided = paramsModule.parseParamPairs(flags.param);
    } catch (error) {
      throw new ArgError(error.message);
    }
    const declarations = Array.isArray(recipe.params) ? recipe.params : (recipe.params && typeof recipe.params === 'object' ? recipe.params : []);
    const templateNames = paramsModule.collectRecipeParamNames(recipe.steps);
    const resolved = paramsModule.resolveRecipeParams(declarations, provided, { templateNames });
    if (resolved.errors.length) {
      const first = resolved.errors[0];
      if (/^缺少参数 \{\{/.test(first)) {
        // 保持 v1 契约：缺占位参数仍是 E_BAD_ARG（错误信息同 substituteParams）。
        throw new RecipeStoreError('E_BAD_ARG', first);
      }
      if (/^缺少必需参数/.test(first)) throw new ArgError(first);
      throw new ContractError('E_ARG_TYPE', first, { hint: '用 --param key=value 传入正确类型的值。', usage: 'bridge recipe run <name> [--param k=v ...]' });
    }
    const values = resolved.values;
    const substituted = (Number(recipe.version) || 1) >= 2
      ? paramsModule.substituteRecipeSteps(recipe.steps, values)
      : (await loadStore()).substituteParams(recipe.steps, values);
    return {
      values,
      redacted: resolved.redacted,
      fingerprint: paramsModule.recipeParamFingerprint(resolved.redacted),
      substituted,
      declarations,
      templateNames,
      warnings: resolved.warnings,
      usedDefaults: resolved.usedDefaults,
    };
  }

  function markerSummary(preflight, preflightModule) {
    return preflightModule.summarizePreflight(preflight);
  }

  /** 回放失败：把证据写进 run marker + report.json + diff.json，并按统一错误信封输出。 */
  async function emitRunFailure(result, context) {
    const { sanitizeRecipeName, writeRunMarker, writeRunReport } = await loadStore();
    const error = result.error || { code: 'E_INTERNAL', message: 'recipe 回放失败' };
    const evidence = result.evidence || null;
    const report = {
      ok: false,
      completed: result.completed,
      planned: result.planned,
      failedAt: result.failedAt,
      failedPath: result.failedPath,
      error,
      evidence,
      report: result.report,
      paramsFingerprint: context.paramsFingerprint,
    };
    writeRunMarker(recipeDir, context.name, {
      status: 'failed',
      completed: result.completed,
      planned: result.planned,
      failedAt: result.failedAt,
      failedPath: result.failedPath,
      error: error.code,
      paramsFingerprint: context.paramsFingerprint,
      evidence,
    });
    const reportFile = writeRunReport(recipeDir, context.name, report);
    // 失败也要有结构化差异文档：文本/JSON/落盘三处共用 buildRecipeDiffDocument。
    const diffFile = path.join(recipeDir, sanitizeRecipeName(context.name) + '.diff.json');
    const diffDocument = buildRecipeDiffDocument({
      recipe: context.name,
      report: result.report || {},
      results: result.results,
      ok: false,
      planned: result.planned,
      completed: result.completed,
      failedAt: result.failedAt,
      failedPath: result.failedPath,
      paramsFingerprint: context.paramsFingerprint,
      error,
      files: { report: reportFile, diff: diffFile },
    });
    writeRecipeDiffFile(diffFile, diffDocument);
    report.diffFile = diffFile;
    report.diffSummary = diffDocument.summary;
    report.classification = diffDocument.classification;
    writeRunReport(recipeDir, context.name, report);
    const body = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        data: {
          recipe: context.name,
          failedStep: evidence && evidence.failedStep,
          canRetry: evidence ? evidence.canRetry : false,
          next: result.next || (evidence && evidence.next) || '',
          reportFile,
          diffFile,
          classification: diffDocument.classification,
          failureCategory: diffDocument.classification ? diffDocument.classification.category : null,
          differences: diffDocument.differences,
          diffSummary: diffDocument.summary,
        },
      },
    };
    if (isJson()) return outputFailure(body);
    for (const line of context.renderReport ? context.renderReport() : []) print(line);
    for (const line of renderRecipeDiffLines(diffDocument, { max: 10 })) print(line);
    print('报告文件：' + reportFile);
    print('差异文件：' + diffFile);
    return outputFailure(body);
  }

  async function cmdRun(flags, pos) {
    const store = await loadStore();
    const {
      acquireRecipeLock, assertRunnable, readRecipe, releaseRecipeLock,
      RecipeStoreError, sanitizeRecipeName, writeRunMarker, writeRunReport,
    } = store;
    const name = requirePos(pos, 2, '<name>');
    const recipe = readRecipe(recipeDir, name);
    // preflight：本地只读校验（审批/内容指纹/过期），dry-run 也会执行这层检查。
    assertRunnable(recipe);
    const params = await resolveRunParams(recipe, flags);
    const { normalized, preflight, preflightModule } = await inspectRecipe(recipe, params.substituted, {
      approved: recipe.approved === true,
      readOnly: recipe.safety && recipe.safety.readOnly === true,
      params: params.values,
    });
    const modelErrors = normalized.errors || [];
    if (modelErrors.length) {
      throw new ContractError('E_INVALID_PARAMS', 'recipe 步骤不合法：' + modelErrors[0], {
        hint: '修正 recipe JSON 后重新 save/approve。',
        usage: 'bridge recipe run <name>',
      });
    }
    const planned = buildRunPlan(recipe, name, params.substituted, flags);
    io.flags = flags;
    if (isDryRun(flags)) {
      // dry-run：只读预检（不触达 daemon），输出里保留旧的 risk/steps/confirmations 字段，
      // 额外附上 step 模型 v2 的展平计划、幂等标记与阻塞项。
      const preview = dryRunResult(planned);
      preview.preflight = preflightModule.summarizePreflight(preflight);
      preview.model = {
        version: normalized.version,
        warnings: normalized.warnings,
        plan: preflight.flattened.map((entry) => ({
          ref: entry.ref,
          path: entry.path,
          kind: entry.kind,
          method: entry.method,
          risk: entry.risk,
          idempotent: entry.idempotent,
          fallback: entry.fallback,
        })),
        humanGates: preflight.humanGates,
        confirmations: preflight.confirmations,
        estimatedRpcCalls: preflight.estimatedRpcCalls,
        paramNames: params.templateNames,
      };
      if (isJson()) {
        emitJson({ ok: true, dryRun: true, result: preview });
        return 0;
      }
      for (const line of renderDryRun(planned)) print(line);
      for (const line of preflightModule.renderPreflightText(preflight)) print(line);
      for (const entry of preflight.flattened) {
        print('  ' + (entry.idempotent ? '[幂等]' : '[非幂等]') + ' ' + (entry.method || entry.kind) + (entry.fallback && entry.fallback.onError !== 'stop' ? ' 失败策略=' + entry.fallback.onError : ''));
      }
      return 0;
    }
    if (!preflight.ok) {
      const first = preflight.blockers[0];
      const ErrorType = /NOT_APPROVED|READ_ONLY/.test(first.code) ? BridgeError : ContractError;
      throw new ErrorType(first.code, first.message, {
        hint: first.code === 'E_RECIPE_NOT_APPROVED'
          ? '先 bridge recipe show <name> 人工看步骤，再 bridge recipe approve <name> --confirm-human。'
          : '用 bridge recipe run <name> --dry-run 查看完整预检。',
        usage: 'bridge recipe run <name>',
        details: { blockers: preflight.blockers },
      });
    }
    const { runRecipeEngine } = await loadEngine();
    const lock = acquireRecipeLock(recipeDir, name);
    try {
      writeRunMarker(recipeDir, name, {
        status: 'running',
        steps: params.substituted.length,
        paramsFingerprint: params.fingerprint,
        preflight: markerSummary(preflight, preflightModule),
      });
      const result = await runRecipeEngine(normalized.steps, {
        name,
        drivers: engineDrivers(flags),
        policy: recipe.policy || {},
        params: params.redacted,
        paramsFingerprint: params.fingerprint,
        maxSteps: Number(recipe.policy && recipe.policy.maxSteps) || undefined,
        structuralSteps: true,
        onEvent: flags.verbose === true && !isJson() ? (event) => process.stderr.write('  · ' + JSON.stringify(event) + '\n') : undefined,
      });
      if (!result.ok) {
        return await emitRunFailure(result, {
          name,
          paramsFingerprint: params.fingerprint,
          renderReport: () => {
            const lines = [];
            lines.push('recipe ' + name + '：完成 ' + result.completed + '/' + result.planned);
            if (result.evidence) {
              lines.push('失败步骤：' + (result.evidence.failedStep ? result.evidence.failedStep.method + '（' + result.evidence.failedStep.ref + '）' : '-'));
              lines.push('原因：' + result.evidence.reason.code + ' ' + result.evidence.reason.message);
              lines.push('可否重试：' + (result.evidence.canRetry ? '可以' : '不可以（非幂等动作）'));
              if (result.evidence.next) lines.push('下一步：' + result.evidence.next);
            }
            return lines;
          },
        });
      }
      const engineReport = result.report || {};
      const diffFile = path.join(recipeDir, sanitizeRecipeName(name) + '.diff.json');
      const diffDocument = buildRecipeDiffDocument({
        recipe: name,
        report: engineReport,
        results: result.results,
        ok: true,
        planned: result.planned,
        completed: result.completed,
        failedAt: null,
        failedPath: null,
        paramsFingerprint: params.fingerprint,
        files: { report: path.join(recipeDir, sanitizeRecipeName(name) + '.report.json'), diff: diffFile },
      });
      writeRecipeDiffFile(diffFile, diffDocument);
      const summary = {
        ok: true,
        completed: result.completed,
        planned: result.planned,
        failedAt: null,
        failedPath: null,
        paramsFingerprint: params.fingerprint,
        report: {
          durationMs: engineReport.durationMs,
          statuses: engineReport.statuses,
          differences: engineReport.differences,
          failures: engineReport.failures,
          retryable: engineReport.retryable,
          summary: diffDocument.summary,
          classification: diffDocument.classification,
        },
        diff: diffDocument,
        diffFile,
        steps: result.results.map((item) => ({
          ref: item.ref, path: item.path, kind: item.kind, method: item.method,
          status: item.status, attempts: item.attempts, durationMs: item.durationMs,
          ...(item.branch ? { branch: item.branch } : {}),
          ...(item.skippedReason ? { skippedReason: item.skippedReason } : {}),
          ...(item.diff && item.diff.length ? { diff: item.diff } : {}),
        })),
        warnings: [...normalized.warnings, ...preflight.warnings, ...(params.warnings || [])],
      };
      writeRunMarker(recipeDir, name, {
        status: 'done',
        completed: result.completed,
        planned: result.planned,
        paramsFingerprint: params.fingerprint,
        differences: summary.report.differences.length,
      });
      const reportFile = writeRunReport(recipeDir, name, {
        ...summary,
        // 报告文件里也带 diff 文件路径；diff 文档本身包含完整证据。
        diffSummary: diffDocument.summary,
        classification: diffDocument.classification,
      });
      summary.reportFile = reportFile;
      if (isJson()) return outputJsonBody({ ok: true, result: summary });
      const replayModule = await import('../../lib/recipe-diff.mjs');
      for (const line of replayModule.renderReplayReport({
        recipe: name,
        ok: true,
        completed: result.completed,
        planned: result.planned,
        durationMs: engineReport.durationMs,
        paramsFingerprint: params.fingerprint,
        statuses: engineReport.statuses,
        differences: engineReport.differences,
        failures: engineReport.failures,
        failedAt: null,
      })) print(line);
      for (const line of renderRecipeDiffLines(diffDocument, { max: 10 })) print(line);
      for (const warning of summary.warnings) print('  注意：' + warning);
      print('报告文件：' + reportFile);
      print('差异文件：' + diffFile);
      return 0;
    } catch (error) {
      if (error && error.name === 'RecipeEngineError') {
        writeRunMarker(recipeDir, name, { status: 'failed', error: error.code, steps: params.substituted.length });
        throw new ContractError(error.code, error.message, {
          hint: '检查 recipe JSON（loop/分支/参数）后用 --dry-run 复现预检。',
          usage: 'bridge recipe run <name>',
        });
      }
      writeRunMarker(recipeDir, name, { status: 'failed', error: (error && error.code) || 'E_INTERNAL', steps: params.substituted.length });
      throw error;
    } finally {
      releaseRecipeLock(lock);
    }
  }

  return async function cmdRecipe(flags, pos, invocation) {
    const {
      approveRecipe, listRecipes, readRecipe, recipePath, saveRecipe,
    } = await loadStore();
    const sub = (invocation && invocation.sub) || pos[1];
    const context = { usage: invocation ? invocation.usage : 'bridge recipe ' + sub, sub };
    if (sub === 'list') {
      const recipes = listRecipes(recipeDir);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'list',
        risk: RISK.READ_ONLY,
        steps: [localStep({
          action: 'read',
          description: '读取 recipe 目录',
          paths: [recipeDir],
          risk: RISK.READ_ONLY,
        })],
      });
      if (isDryRun(flags)) {
        io.flags = flags;
        return outputDryRun(planned, io);
      }
      const rows = recipes.map((item) => [item.name, item.title, String(item.steps), item.file]);
      if (isJson()) {
        emitJson({ ok: true, result: { dir: recipeDir, recipes } });
        return 0;
      }
      if (!rows.length) {
        print('没有 recipe（目录 ' + recipeDir + '）');
        return 0;
      }
      print(renderTable(['name', 'title', 'steps', 'file'], rows));
      return 0;
    }
    if (sub === 'show') {
      const name = requirePos(pos, 2, '<name>');
      const recipe = readRecipe(recipeDir, name);
      const target = recipePath(recipeDir, name);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'show',
        risk: RISK.READ_ONLY,
        steps: [localStep({ action: 'read', description: '读取 recipe 文件', paths: [target], risk: RISK.READ_ONLY })],
      });
      if (isDryRun(flags)) {
        io.flags = flags;
        return outputDryRun(planned, io);
      }
      if (isJson()) {
        // v2：附带模型归一化结果与预检摘要（只读计算，不触达 daemon）。
        let details = null;
        try {
          const { normalized, preflight, preflightModule } = await inspectRecipe(recipe, recipe.steps, {
            approved: recipe.approved === true,
            readOnly: false,
          });
          details = {
            modelVersion: normalized.version,
            warnings: normalized.warnings,
            preflight: preflightModule.summarizePreflight(preflight),
            humanGates: preflight.humanGates,
            flattened: preflight.flattened.map((entry) => ({ ref: entry.ref, path: entry.path, kind: entry.kind, method: entry.method, idempotent: entry.idempotent })),
          };
        } catch (error) {
          details = { error: String((error && error.message) || error) };
        }
        emitJson({ ok: true, result: { name: String(name), recipe, details } });
        return 0;
      }
      print(JSON.stringify(recipe, null, 2));
      return 0;
    }
    if (sub === 'save') {
      const name = requirePos(pos, 2, '<name>');
      const rawFile = Array.isArray(flags.file) ? flags.file[0] : flags.file;
      if (!rawFile) throw new ArgError('recipe save 需要 --file <json>');
      const source = path.resolve(process.cwd(), String(rawFile));
      let json;
      try {
        json = JSON.parse(fs.readFileSync(source, 'utf8'));
      } catch (error) {
        throw new ContractError('E_ARG_TYPE', '读取 recipe 失败：' + error.message, {
          hint: '检查 --file 指向的 JSON：' + source,
          usage: context.usage,
        });
      }
      if (!Array.isArray(json.steps) || !json.steps.length) {
        throw new ContractError('E_ARG_TYPE', 'recipe 需要非空 steps 数组', { hint: 'recipe JSON 形如 {"name":"x","steps":[{"method":"click"}]}。', usage: context.usage });
      }
      const { normalized, preflight, preflightModule } = await inspectRecipe(json, json.steps, {
        approved: false,
        readOnly: false,
      });
      const target = recipePath(recipeDir, name);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'save',
        risk: RISK.LOCAL_WRITE,
        steps: [localStep({
          action: 'write',
          description: '保存 recipe 草稿（' + json.steps.length + ' 步）',
          paths: [target],
          risk: RISK.LOCAL_WRITE,
        })],
        warnings: ['保存的是草稿：含 click/fill 等风险步骤仍需 recipe approve --confirm-human 才能 run。'],
      });
      io.flags = flags;
      if (isDryRun(flags)) return outputDryRun(planned, io);
      if (normalized.errors.length) {
        throw new ContractError('E_INVALID_PARAMS', 'recipe 步骤不合法：' + normalized.errors[0], {
          hint: '每个步骤需要 method（或 action/command）；if/loop 需要 then/else/steps。',
          usage: context.usage,
        });
      }
      const { file: written } = saveRecipe(recipeDir, name, {
        ...json,
        version: json.version || (json.params || json.policy || json.safety ? 2 : undefined),
      });
      if (isJson()) {
        emitJson({
          ok: true,
          result: {
            name: String(name),
            file: written,
            version: Number(json.version) || 1,
            steps: normalized.steps.length,
            preflight: preflightModule.summarizePreflight(preflight),
            warnings: normalized.warnings,
          },
        });
        return 0;
      }
      print('已保存 recipe（草稿，需人工审批）：' + written);
      for (const warning of normalized.warnings) print('  注意：' + warning);
      if (preflight.counts.dangerous) print('  含 ' + preflight.counts.dangerous + ' 个危险动作步骤，需要人工审批。');
      if (preflight.counts.humanGates) print('  含 ' + preflight.counts.humanGates + ' 个人工节点，回放时会等待人类操作。');
      if (preflight.counts.confirmations) print('  含 ' + preflight.counts.confirmations + ' 个逐步确认步骤，回放时会逐个请求确认。');
      print('  审批：bridge recipe approve ' + name + ' --confirm-human');
      return 0;
    }
    if (sub === 'rm') {
      const name = requirePos(pos, 2, '<name>');
      const target = recipePath(recipeDir, name);
      if (!fs.existsSync(target)) throw new BridgeError('E_NOT_FOUND', 'recipe 不存在：' + target);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'rm',
        risk: RISK.LOCAL_WRITE,
        steps: [localStep({ action: 'delete', description: '删除 recipe 文件', paths: [target], risk: RISK.LOCAL_WRITE })],
        warnings: ['删除后需要重新 save/approve 才能回放。'],
      });
      io.flags = flags;
      if (isDryRun(flags)) return outputDryRun(planned, io);
      fs.rmSync(target, { force: true });
      if (isJson()) {
        emitJson({ ok: true, result: { deleted: target } });
        return 0;
      }
      print('已删除：' + target);
      return 0;
    }
    if (sub === 'draft') {
      const name = flags.name !== undefined
        ? String(flags.name)
        : (pos[2] && !String(pos[2]).startsWith('-') ? String(pos[2]) : '');
      if (!name) throw new ArgError('用法：bridge recipe draft --name <name> --session <id> [--limit N]');
      const sessionId = flags.session || process.env.BB_SESSION;
      if (!sessionId) throw new ArgError('recipe draft 需要 --session <id>');
      const limit = intFlag(flags, 'limit', { min: 1 });
      const target = recipePath(recipeDir, name);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'draft',
        risk: RISK.LOCAL_WRITE,
        steps: [
          rpcStep('session.run_log', { session: String(sessionId), ...(limit ? { limit } : {}) }, {
            description: '读取会话 run log',
            target: { kind: 'session', sessionId: String(sessionId) },
            risk: RISK.READ_ONLY,
          }),
          localStep({ action: 'write', description: '写入 recipe 草稿', paths: [target], risk: RISK.LOCAL_WRITE }),
        ],
        notes: dryRunNotes(flags),
      });
      io.flags = flags;
      if (isDryRun(flags)) return outputDryRun(planned, io);
      const body = await callStep(planned.steps[0], io);
      if (!body.ok) return outputFailure(body);
      const { draftRecipeV2 } = await loadDraftV2();
      const maxSteps = intFlag(flags, 'max-steps', { min: 1 });
      const drafted = draftRecipeV2(name, { ...(body.result || {}), sessionId: String(sessionId) }, { maxSteps: maxSteps || 100 });
      if (!drafted.steps.length) {
        throw new BridgeError('E_RECIPE_DRAFT_EMPTY', 'run log 里没有可回放的步骤（需要 navigate/click/hover/focus 且目标可定位）；跳过：' + JSON.stringify(drafted.skipped.slice(0, 5)));
      }
      const { file: written } = saveRecipe(recipeDir, name, {
        name,
        version: drafted.version,
        steps: drafted.steps,
        params: [],
        source: drafted.source,
      });
      if (isJson()) {
        emitJson({
          ok: true,
          result: {
            name: String(name),
            file: written,
            version: drafted.version,
            count: drafted.steps.length,
            steps: drafted.steps,
            skipped: drafted.skipped,
            humanGates: drafted.humanGates,
            warnings: drafted.warnings,
            source: drafted.source,
          },
        });
        return 0;
      }
      print('已生成 recipe 草稿：' + written + '（' + drafted.steps.length + ' 步，模型 v' + drafted.version + '）');
      for (const warning of drafted.warnings) print('  注意：' + warning);
      if (drafted.skipped.length) print('  跳过 ' + drafted.skipped.length + ' 步（取值/参数不在 run log 里）');
      if (drafted.humanGates.length) {
        print('  需要人工补值 ' + drafted.humanGates.length + ' 处（回放前请人工确认）：');
        for (const gate of drafted.humanGates.slice(0, 8)) print('    - #' + gate.index + ' ' + gate.method + ' ' + gate.target + '：' + gate.reason);
      }
      print('  审批：bridge recipe approve ' + name + ' --confirm-human');
      return 0;
    }
    if (sub === 'approve') {
      const name = requirePos(pos, 2, '<name>');
      if (flags['confirm-human'] !== true) {
        throw new ContractError('E_HUMAN_GATE', 'recipe approve 只能由人类执行：请加 --confirm-human', {
          hint: '先 bridge recipe show <name> 人工看步骤，再 bridge recipe approve <name> --confirm-human。',
          usage: context.usage,
        });
      }
      const target = recipePath(recipeDir, name);
      const planned = buildPlan({
        command: 'recipe',
        subcommand: 'approve',
        risk: RISK.HUMAN_GATE,
        steps: [localStep({
          action: 'write',
          description: '写入人工审批（绑定内容指纹与过期时间）',
          paths: [target],
          risk: RISK.HUMAN_GATE,
        })],
        confirmations: ['approve 由人类执行（--confirm-human），agent 不应自己审批自己生成的 recipe。'],
      });
      io.flags = flags;
      if (isDryRun(flags)) return outputDryRun(planned, io);
      const recipe = approveRecipe(recipeDir, name, {
        approver: flags.by !== undefined ? String(flags.by) : (os.userInfo().username || 'human'),
        host: os.hostname(),
      });
      if (isJson()) {
        emitJson({ ok: true, result: { name: String(name), approved: true, approver: recipe.approver } });
        return 0;
      }
      print('已审批 recipe：' + name + '（by ' + recipe.approver + '）');
      return 0;
    }
    if (sub === 'run') return cmdRun(flags, pos);
    throw new ContractError('E_BAD_SUBCOMMAND', 'bridge recipe 没有子命令 "' + sub + '"', {
      hint: '可用子命令：' + (spec ? spec.order.join('|') : 'list|show|save|draft|approve|run|rm') + '。',
    });
  };
}
