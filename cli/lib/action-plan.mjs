// cli/lib/action-plan.mjs —— 命令级“动作计划”：dry-run 与真实执行共用同一份构造。
//
// 设计要点：一个 plan 就是“将要发生的事”的数据结构（RPC 步骤 / 本机写入 + 目标 +
// 风险 + 警告 + 需要的人工确认）。命令实现先 buildPlan，再二选一：
//   - dry-run：outputDryRun(plan) —— 只打印，不触达 daemon；
//   - 真实执行：callStep(plan.steps[i], io) —— 参数与 dry-run 打印的完全一致。
// 这样“预检说的请求”和“真正发出的请求”不可能漂移。
import { RISK, RISK_INFO, describeRisk, maxRisk } from './arg-contract.mjs';
import { isMutatingInCatalog } from '../../lib/method-catalog.mjs';

/** `--dry-run` 是否生效（只有目标子命令会走到这里）。 */
export function isDryRun(flags) {
  return Boolean(flags && flags['dry-run'] === true);
}

/**
 * 构造一个 RPC 步骤。risk 缺省时按协议 catalog 的“是否变异”推导：
 * 变异方法 → browser_mutation；只读方法 → read_only。
 */
export function rpcStep(method, params, options = {}) {
  const name = String(method || '');
  if (!name) throw new Error('rpcStep 需要 method');
  const risk = options.risk
    || (isMutatingInCatalog(name) ? RISK.BROWSER_MUTATION : RISK.READ_ONLY);
  return Object.freeze({
    kind: 'rpc',
    method: name,
    params: { ...(params || {}) },
    description: options.description || '',
    target: options.target || null,
    minTimeoutMs: Number.isFinite(options.minTimeoutMs) ? options.minTimeoutMs : 0,
    risk,
    effects: Object.freeze([...(options.effects || [])]),
  });
}

/**
 * 构造一个本机步骤（读/写文件、删除本地 recipe）。dry-run 只报告路径，不执行。
 * action：read | write | delete | rename
 */
export function localStep(options = {}) {
  const action = options.action || 'write';
  return Object.freeze({
    kind: 'local',
    action,
    description: options.description || '',
    paths: Object.freeze([...(options.paths || [])]),
    target: options.target || null,
    risk: options.risk || (action === 'read' ? RISK.READ_ONLY : RISK.LOCAL_WRITE),
    effects: Object.freeze([...(options.effects || [])]),
  });
}

/** 组装 plan：风险取各步骤最大者，并统一推导 mutatesBrowser / reversible。 */
export function buildPlan(options = {}) {
  const steps = [...(options.steps || [])];
  const risk = options.risk || maxRisk(steps.map((step) => step.risk));
  const info = RISK_INFO[risk] || RISK_INFO.read_only;
  return Object.freeze({
    command: String(options.command || ''),
    subcommand: options.subcommand ? String(options.subcommand) : null,
    risk,
    riskLabel: info.label,
    mutatesBrowser: info.mutatesBrowser,
    mutatesDaemon: info.mutatesDaemon,
    reversible: info.reversible,
    steps: Object.freeze(steps),
    warnings: Object.freeze([...(options.warnings || [])]),
    confirmations: Object.freeze([...(options.confirmations || [])]),
    notes: Object.freeze([...(options.notes || [])]),
  });
}

/** 把参数里的对象转成一行稳定 JSON（dry-run 打印用；不含 token/凭据）。 */
function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

/** 步骤对应的 HTTP 请求描述：dry-run 里给用户看“将要发出的请求”。 */
export function stepRequest(step) {
  if (!step || step.kind !== 'rpc') return null;
  return {
    protocol: 'bridge-rpc/1',
    transport: 'POST /rpc',
    method: step.method,
    body: { method: step.method, params: { ...step.params } },
  };
}

/** JSON 输出：dry-run 的 result。 */
export function dryRunResult(plan) {
  const requests = plan.steps.map(stepRequest).filter(Boolean);
  return {
    command: plan.command,
    subcommand: plan.subcommand,
    risk: plan.risk,
    riskLabel: plan.riskLabel,
    mutatesBrowser: plan.mutatesBrowser,
    mutatesDaemon: plan.mutatesDaemon,
    reversible: plan.reversible,
    executed: false,
    steps: plan.steps.map((step) => {
      if (step.kind === 'rpc') {
        return {
          kind: 'rpc',
          method: step.method,
          params: { ...step.params },
          description: step.description,
          target: step.target,
          risk: step.risk,
          request: stepRequest(step),
        };
      }
      return {
        kind: 'local',
        action: step.action,
        paths: [...step.paths],
        description: step.description,
        target: step.target,
        risk: step.risk,
      };
    }),
    requests,
    warnings: [...plan.warnings],
    confirmations: [...plan.confirmations],
    notes: [...plan.notes],
  };
}

function targetText(target) {
  if (!target) return null;
  if (typeof target === 'string') return target;
  const bits = [];
  for (const key of ['kind', 'sessionId', 'tabId', 'windowId', 'url', 'name', 'file']) {
    if (target[key] !== undefined && target[key] !== null && target[key] !== '') bits.push(key + '=' + target[key]);
  }
  return bits.length ? bits.join(' ') : null;
}

/** 人类可读的 dry-run 文本（逐行；print 逐行输出）。 */
export function renderDryRun(plan) {
  const lines = [];
  lines.push('dry-run：只做参数/目标/风险预检，不调用 daemon、不改浏览器');
  lines.push('命令：bridge ' + plan.command + (plan.subcommand && plan.subcommand !== 'default' ? ' ' + plan.subcommand : ''));
  lines.push('风险：' + describeRisk(plan.risk));
  if (plan.mutatesBrowser) lines.push('注意：这是 browser_mutation 类命令，真正执行会改变浏览器状态。');
  lines.push('');
  lines.push('将要执行 ' + plan.steps.length + ' 步：');
  plan.steps.forEach((step, index) => {
    const number = index + 1;
    if (step.kind === 'rpc') {
      lines.push('  ' + number + '. [rpc] ' + (step.description || step.method));
      const target = targetText(step.target);
      if (target) lines.push('       目标：' + target);
      lines.push('       请求：POST /rpc ' + stableJson({ method: step.method, params: step.params }));
    } else {
      lines.push('  ' + number + '. [local:' + step.action + '] ' + (step.description || '本机文件操作'));
      for (const file of step.paths) lines.push('       路径：' + file);
    }
  });
  if (plan.warnings.length) {
    lines.push('');
    lines.push('警告：');
    for (const warning of plan.warnings) lines.push('  - ' + warning);
  }
  if (plan.confirmations.length) {
    lines.push('');
    lines.push('需要确认：');
    for (const item of plan.confirmations) lines.push('  - ' + item);
  }
  if (plan.notes.length) {
    lines.push('');
    lines.push('说明：');
    for (const note of plan.notes) lines.push('  - ' + note);
  }
  lines.push('');
  lines.push('确认无误后去掉 --dry-run 执行。');
  return lines;
}

/** 输出 dry-run 并返回退出码 0（JSON 模式走统一信封）。 */
export function outputDryRun(plan, io) {
  if (io.isJson()) {
    io.emitJson({ ok: true, dryRun: true, result: dryRunResult(plan) });
    return 0;
  }
  for (const line of renderDryRun(plan)) io.print(line);
  return 0;
}

/** 真实执行单个 RPC 步骤（timeout 取命令超时与步骤下限的较大值）。 */
export async function callStep(step, io) {
  if (!step || step.kind !== 'rpc') throw new Error('callStep 只接受 rpc 步骤');
  const base = io.timeoutOf(io.flags || {});
  const timeout = Math.max(base, step.minTimeoutMs || 0);
  return io.callRpc(step.method, step.params, timeout);
}

/** 按协议 catalog 给“用户提供的步骤列表”标注风险（plan/step/recipe 共用）。 */
export function annotateStepMethods(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const mutating = [];
  for (const step of list) {
    const method = step && typeof step === 'object' ? String(step.method || '') : '';
    if (method && isMutatingInCatalog(method)) mutating.push(method);
  }
  return { mutating: [...new Set(mutating)], readOnly: mutating.length === 0 };
}

/** 由用户步骤列表推导整条 plan 的风险与警告。 */
export function planRiskFromSteps(steps) {  const { mutating } = annotateStepMethods(steps);
  if (!mutating.length) {
    return {
      risk: RISK.READ_ONLY,
      warnings: [],
      confirmations: [],
    };
  }
  return {
    risk: RISK.BROWSER_MUTATION,
    warnings: ['步骤里有会改变浏览器状态的方法：' + mutating.join(', ')],
    confirmations: [],
  };
}

/**
 * dry-run 的通用说明：哪些东西“没有校验/没有解析”。
 * dry-run 不允许触达 daemon，所以别名 tabId、环境变量里的会话都不做存在性校验，
 * 必须显式告诉用户，避免把“预检通过”误当成“执行一定成功”。
 */
export function dryRunNotes(flags = {}) {
  const notes = [];
  const tabFlag = flags['tab-id'];
  if (tabFlag !== undefined && !/^\d+$/.test(String(tabFlag))) {
    notes.push('--tab-id "' + String(tabFlag) + '" 是别名：dry-run 不触达 daemon，未解析；真实执行前会先解析成数字 tabId。');
  }
  const hasSessionFlag = flags.session !== undefined || flags['session-scope'] !== undefined;
  if (!hasSessionFlag && ((process.env.BB_SESSION && process.env.BB_SESSION.trim()) || (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()))) {
    notes.push('会话来自环境变量（BB_SESSION / BB_SESSION_SCOPE），dry-run 不校验它是否存在。');
  }
  return notes;
}
