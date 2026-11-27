// cli/lib/exit-codes.mjs —— CLI 退出码的单一说明表 + 批处理/裁决的结论 → 退出码映射。
//
// 背景：0.3.0 之前 CLI 的退出码语义散落在各个命令里（0 成功 / 1 业务错误 / 2 参数错误 /
// 6 对话框待处理），新增的批处理与租约裁决需要区分"部分成功""配额拒绝""已取消"，
// 但**不能改变既有命令的任何退出码**。因此本模块：
// - 只做"表格化"：把既有退出码收进 EXIT_CODES（文档、`bridge daemon help`、测试共用）；
// - 新增 3/4/5 三个码，只在第十一批 G 的新命令（batch/lease）里使用；
// - 提供纯函数映射，避免命令层各写一套 if/else。
//
// 退出码契约（只增不改）：
//   0  ok          成功（批处理/裁决全部按预期完成；dry-run 计划也算成功）
//   1  error       业务失败（含批处理全部失败、裁决 apply 后仍有步骤失败）
//   2  usage       参数/用法错误（沿用 CLI 既有 ArgError 语义）
//   3  partial     部分成功（批处理有成功也有失败；调用方应读 result 里的明细）
//   4  quota       配额拒绝（批处理一个条目都没启动，全部 denied；可重试或调大配额）
//   5  cancelled   取消/回滚（批次被 cancel，或 onError=rollback 回收了本批会话）
//   6  dialog      对话框待处理（既有语义，保持不变）
//
// 约束：本模块是纯函数/常量，不做 I/O、不 import CLI 状态；单测见
// tests/unit/daemon-cli-exit-codes.test.mjs。

/** 成功。 */
export const EXIT_OK = 0;
/** 业务失败。 */
export const EXIT_ERROR = 1;
/** 参数/用法错误（既有 CLI 语义）。 */
export const EXIT_USAGE = 2;
/** 部分成功（第十一批 G 新增，仅 batch 使用）。 */
export const EXIT_PARTIAL = 3;
/** 配额拒绝（第十一批 G 新增，仅 batch 使用）。 */
export const EXIT_QUOTA = 4;
/** 取消/回滚（第十一批 G 新增，仅 batch 使用）。 */
export const EXIT_CANCELLED = 5;
/** 对话框待处理（0.3.0 既有语义，保持不变）。 */
export const EXIT_DIALOG_PENDING = 6;

/** 退出码说明表（顺序稳定，CLI 帮助/文档/测试共用）。 */
export const EXIT_CODES = Object.freeze([
  Object.freeze({ code: EXIT_OK, name: 'ok', label: '成功', meaning: '命令按预期完成（dry-run 计划同样算成功）', commands: ['全部命令'] }),
  Object.freeze({ code: EXIT_ERROR, name: 'error', label: '业务失败', meaning: 'daemon/浏览器返回业务错误，或批量操作全部失败', commands: ['全部命令', 'daemon batch start', 'daemon lease arbitrate --apply'] }),
  Object.freeze({ code: EXIT_USAGE, name: 'usage', label: '参数错误', meaning: '参数/用法不合法（不触达 daemon）', commands: ['全部命令'] }),
  Object.freeze({ code: EXIT_PARTIAL, name: 'partial', label: '部分成功', meaning: '批量操作有成功也有失败，需读取 result.items', commands: ['daemon batch start', 'daemon batch plan'] }),
  Object.freeze({ code: EXIT_QUOTA, name: 'quota', label: '配额拒绝', meaning: '会话配额不足，批次一个条目都没启动（全部 denied）', commands: ['daemon batch start'] }),
  Object.freeze({ code: EXIT_CANCELLED, name: 'cancelled', label: '取消/回滚', meaning: '批次被取消，或 onError=rollback 回收了本批已建会话', commands: ['daemon batch start', 'daemon batch cancel'] }),
  Object.freeze({ code: EXIT_DIALOG_PENDING, name: 'dialog', label: '对话框待处理', meaning: '遇到需要人工处理的对话框（既有语义）', commands: ['page 类命令'] }),
]);

/** 按数字找说明（未知码返回 null）。 */
export function describeExitCode(code) {
  const number = Number(code);
  return EXIT_CODES.find((item) => item.code === number) || null;
}

/** 退出码表格（`bridge daemon batch --help` 之类的文本渲染用）。 */
export function exitCodeTable() {
  return EXIT_CODES.map((item) => ({
    code: item.code,
    name: item.name,
    label: item.label,
    meaning: item.meaning,
  }));
}

/** 退出码 → 一行人类可读文本。 */
export function formatExitCode(code) {
  const item = describeExitCode(code);
  if (!item) return '退出码 ' + Number(code) + '：未登记';
  return '退出码 ' + item.code + '（' + item.name + '）：' + item.meaning;
}

/**
 * 业务错误码 → 退出码。只覆盖"本来就该由 outputFailure 处理"的既有映射，
 * 不改变任何既有命令的行为（当前调用方仍走 outputFailure 的 1/6）。
 */
export function exitCodeForErrorCode(code) {
  const text = String(code || '').toUpperCase();
  if (text === 'E_DIALOG_PENDING') return EXIT_DIALOG_PENDING;
  if (!text) return EXIT_ERROR;
  return EXIT_ERROR;
}

/**
 * 批处理结论 → 退出码。
 * 输入可以是 batch RPC 的 result（含 outcome/summary），也可以是 outcome 字符串。
 * 规则：
 * - 全部成功 / 计划成功 → 0；
 * - 有成功也有失败 → 3（部分成功）；
 * - 全部失败 → 1；
 * - 全部被配额拒绝 → 4；
 * - 取消/回滚 → 5；回滚意味着"没有留下任何成果"仍是 1？统一按 5（显式取消语义），
 *   但 apply 后仍有残留会话的失败由 summary 体现，不混入退出码。
 */
export function exitCodeForBatch(result) {
  if (result === null || result === undefined) return EXIT_ERROR;
  if (typeof result === 'string') return batchOutcomeExit(result);
  const outcome = result.outcome;
  if (typeof outcome === 'string') return batchOutcomeExit(outcome);
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : {};
  const succeeded = Number(summary.succeeded) || 0;
  const failed = Number(summary.failed) || 0;
  const denied = Number(summary.denied) || 0;
  const total = Number(summary.total) || (succeeded + failed + denied);
  if (total === 0) return EXIT_OK;
  if (denied >= total && succeeded === 0) return EXIT_QUOTA;
  if ((failed > 0 || denied > 0) && succeeded > 0) return EXIT_PARTIAL;
  if (failed > 0) return EXIT_ERROR;
  if (succeeded > 0) return EXIT_OK;
  return EXIT_ERROR;
}

/** outcome 字符串 → 退出码（batch 状态机结论）。 */
export function batchOutcomeExit(outcome) {
  switch (String(outcome || '')) {
  case 'ok': return EXIT_OK;
  case 'partial': return EXIT_PARTIAL;
  case 'quota-denied': return EXIT_QUOTA;
  case 'cancelled': return EXIT_CANCELLED;
  case 'rolled-back': return EXIT_CANCELLED;
  case 'failed': return EXIT_ERROR;
  default: return EXIT_ERROR;
  }
}

/**
 * 租约裁决计划 → 退出码。
 * - dry-run（默认）永远 0：它只是计划，不是失败；
 * - apply 后如果有步骤失败（failed>0）→ 1；否则 0；
 * - plan 本身带 error（参数错误）→ 2。
 */
export function exitCodeForArbitration(plan, { apply = false } = {}) {
  if (!plan || typeof plan !== 'object') return EXIT_ERROR;
  if (plan.error && plan.error.code === 'E_BAD_ARG') return EXIT_USAGE;
  if (apply !== true) return EXIT_OK;
  const applied = plan.applied && typeof plan.applied === 'object' ? plan.applied : null;
  if (!applied) return EXIT_OK;
  const failed = applied.summary ? Number(applied.summary.failed) || 0 : 0;
  return failed > 0 ? EXIT_ERROR : EXIT_OK;
}

/** 执行结果 → "退出码 + 一行原因"，供命令层统一打印/JSON 输出。 */
export function exitSummary(code, reason = '') {
  const item = describeExitCode(code);
  return {
    code,
    name: item ? item.name : 'unknown',
    label: item ? item.label : '未知',
    reason: String(reason || ''),
    text: (item ? item.label : '未知') + (reason ? '：' + reason : ''),
  };
}
