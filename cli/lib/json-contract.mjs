// cli/lib/json-contract.mjs —— `--json` 的稳定信封（成功/失败/分页/截断）。
//
// 目标：把每个命令的 JSON 输出收敛到同一份契约，且**只做加法**——
//   ok / result / error 的既有含义一个字节都不变，只追加：
//     schema      契约版本（bb.cli/1）
//     command     顶层命令（tab / session / ...）
//     subcommand  子命令（list / close / ...），没有子命令时省略
//     page        分页/截断元数据（returned/total/totalExact/hasMore/truncated）
//     error.hint  恢复提示（来自 lib/error-codes.mjs 的单一来源）
//   page 里的 total 只有在协议真的返回总数时才 totalExact=true；否则用
//   returned 作为下界并显式标注，避免调用方把“本页条数”误当“总数”。
import { recoveryHint } from '../../lib/error-codes.mjs';

export const JSON_SCHEMA_ID = 'bb.cli/1';

/** 只认“普通对象”，数组/字符串/数字原样返回（不改变既有输出）。 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 分页规则表：命令 + 子命令 → 从 result 里读哪个数组、拿哪个 limit 标志。
 * 规则是“声明式”的，方便测试逐条断言；新增命令只需要加一行。
 */
const PAGE_RULES = Object.freeze([
  { command: 'session', sub: 'list', items: 'sessions' },
  { command: 'session', sub: 'run-log', items: 'steps', limitFlag: 'limit', truncatedKey: 'truncated' },
  { command: 'tab', sub: 'list', items: 'tabs' },
  { command: 'tab', sub: 'cleanup', items: 'close', totalKey: null },
  { command: 'recipe', sub: 'list', items: 'recipes' },
  { command: 'plan', sub: null, items: 'steps' },
  { command: 'console', sub: null, items: 'entries', limitFlag: 'limit', cursorKey: 'nextCursor' },
  { command: 'network', sub: 'list', items: 'entries', limitFlag: 'limit' },
  { command: 'debug', sub: 'requests', items: 'entries', limitFlag: 'limit' },
  { command: 'debug', sub: 'console', items: 'entries', limitFlag: 'limit' },
  { command: 'audit', sub: 'list', items: 'entries', limitFlag: 'limit', totalKey: 'total', offsetFlag: 'offset' },
  { command: 'video', sub: 'list', items: 'recordings' },
  { command: 'pair', sub: 'list', items: 'devices' },
]);

function ruleFor(command, subcommand) {
  const commandName = String(command || '');
  const subName = subcommand == null ? null : String(subcommand);
  return PAGE_RULES.find((rule) => rule.command === commandName && (rule.sub == null ? subName == null : rule.sub === subName)) || null;
}

function readPath(source, dotted) {
  if (!dotted) return undefined;
  let current = source;
  for (const part of String(dotted).split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function toBooleanOrUndefined(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function toCountOrUndefined(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * 归一化一页的分页元数据；没有可用信息时返回 null（不往输出里塞空对象）。
 * hasMore 的推导优先级：协议显式 hasMore → truncated → returned >= limit。
 */
export function normalizePage(input = {}) {
  const returned = toCountOrUndefined(input.returned);
  const declaredTotal = toCountOrUndefined(input.total);
  const limit = toCountOrUndefined(input.limit);
  const offset = toCountOrUndefined(input.offset);
  let hasMore = toBooleanOrUndefined(input.hasMore);
  const truncated = toBooleanOrUndefined(input.truncated);
  if (hasMore === undefined) {
    if (returned !== undefined && limit !== undefined && limit > 0) hasMore = returned >= limit;
    else if (truncated !== undefined) hasMore = truncated;
    // 不是分页命令（没有 limit / 没有 truncated 标记）→ 没有更多页。
    else if (returned !== undefined) hasMore = false;
  }
  const page = {};
  let meaningful = false;
  if (returned !== undefined) {
    page.returned = returned;
    meaningful = true;
  }
  if (declaredTotal !== undefined) {
    page.total = declaredTotal;
    page.totalExact = true;
    meaningful = true;
  } else if (returned !== undefined) {
    page.total = returned;
    page.totalExact = false;
    meaningful = true;
  }
  if (hasMore !== undefined) {
    page.hasMore = hasMore;
    meaningful = true;
  }
  if (truncated !== undefined) {
    page.truncated = truncated;
    meaningful = true;
  }
  if (offset !== undefined) {
    page.offset = offset;
    meaningful = true;
  }
  if (typeof input.cursor === 'string' && input.cursor) {
    page.cursor = input.cursor;
    meaningful = true;
  }
  return meaningful ? page : null;
}

/**
 * 由命令/子命令 + flags + result 推导 page。
 * extract 因为游标分页形状特殊（rowCount/coverage/cursor），单独给一条分支。
 */
export function derivePage(command, subcommand, flags = {}, result = null) {
  if (!result || typeof result !== 'object') return null;
  if (String(command || '') === 'extract') return deriveExtractPage(result);
  const rule = ruleFor(command, subcommand);
  if (!rule) {
    const hasAnyMarker = typeof result.hasMore === 'boolean' || typeof result.truncated === 'boolean';
    return hasAnyMarker ? normalizePage({ hasMore: result.hasMore, truncated: result.truncated }) : null;
  }
  const bag = result[rule.items];
  const returned = Array.isArray(bag) ? bag.length : toCountOrUndefined(bag);
  const limitValue = rule.limitFlag ? flags[rule.limitFlag] : undefined;
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  const totalValue = rule.totalKey ? result[rule.totalKey] : undefined;
  const offsetValue = rule.offsetFlag ? (result[rule.offsetFlag] ?? flags[rule.offsetFlag]) : undefined;
  const truncated = rule.truncatedKey ? toBooleanOrUndefined(result[rule.truncatedKey]) : undefined;
  const cursor = rule.cursorKey ? result[rule.cursorKey] : undefined;
  return normalizePage({
    returned,
    total: toCountOrUndefined(totalValue),
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: offsetValue === undefined ? undefined : Number(offsetValue),
    hasMore: toBooleanOrUndefined(result.hasMore),
    truncated,
    cursor: typeof cursor === 'string' ? cursor : undefined,
  });
}

/** extract 的分页：游标 + 覆盖度（页面声明总数）+ truncated。 */
function deriveExtractPage(result) {
  const rows = Array.isArray(result.rows) ? result.rows : null;
  const returned = toCountOrUndefined(result.rowCount) ?? (rows ? rows.length : undefined);
  const declared = readPath(result, 'coverage.declared');
  const total = toCountOrUndefined(declared) ?? toCountOrUndefined(readPath(result, 'coverage.total'));
  const truncated = toBooleanOrUndefined(result.truncated);
  const hasMore = result.hasMore === true || truncated === true || Boolean(result.cursor);
  return normalizePage({
    returned,
    total,
    truncated,
    hasMore,
    cursor: typeof result.cursor === 'string' ? result.cursor : undefined,
  });
}

/** 成功信封：ok/result 原样保留，只追加 schema/command/subcommand/page。 */
export function decorateSuccess(body, meta = {}) {
  const out = { ...body, schema: JSON_SCHEMA_ID };
  if (meta.command) out.command = String(meta.command);
  if (meta.subcommand) out.subcommand = String(meta.subcommand);
  if (meta.dryRun === true) out.dryRun = true;
  const page = meta.page !== undefined
    ? (meta.page ? normalizePage(meta.page) : null)
    : derivePage(meta.command, meta.subcommand, meta.flags || {}, body.result || null);
  if (page) out.page = page;
  return out;
}

/** 失败信封：error 对象原样保留，缺 hint/retry 时从错误码单一来源补上。 */
export function decorateFailure(body, meta = {}) {
  const error = isPlainObject(body.error)
    ? { ...body.error }
    : { code: 'E_INTERNAL', message: 'unknown error' };
  const code = error.code || 'E_INTERNAL';
  const advice = recoveryHint(code);
  if (typeof error.hint !== 'string' || !error.hint) {
    if (advice.hint) error.hint = advice.hint;
  }
  if (error.retry === undefined && advice.retry) error.retry = advice.retry;
  if (meta.usage && !error.usage) error.usage = String(meta.usage);
  const out = { ...body, schema: JSON_SCHEMA_ID, error };
  if (meta.command) out.command = String(meta.command);
  if (meta.subcommand) out.subcommand = String(meta.subcommand);
  return out;
}

/** 统一入口：只处理带 ok 的普通对象，其余值原样返回。 */
export function decorateJson(value, meta = {}) {
  if (!isPlainObject(value)) return value;
  if (value.schema === JSON_SCHEMA_ID) return value;
  if (value.ok === true) return decorateSuccess(value, meta);
  if (value.ok === false) return decorateFailure(value, meta);
  return value;
}

/** 参数/用法错误 → 单行 JSON 失败信封（--json 模式下 stdout 只许一行）。 */
export function errorEnvelope(error, meta = {}) {
  const details = {
    code: (error && error.code) || 'E_INTERNAL',
    message: (error && error.message) || 'unknown error',
  };
  if (error && error.hint) details.hint = String(error.hint);
  if (error && error.usage) details.usage = String(error.usage);
  if (error && error.details !== undefined) details.details = error.details;
  return decorateFailure({ ok: false, error: details }, meta);
}

/**
 * 契约自检：返回问题列表（空数组 = 合规）。测试与 doctor 类工具共用。
 * 只检查“新增字段的形状”，不参与业务输出。
 */
export function validateEnvelope(value) {
  const problems = [];
  if (!isPlainObject(value)) return ['envelope 不是对象'];
  if (value.schema !== JSON_SCHEMA_ID) problems.push('schema 缺失或不是 ' + JSON_SCHEMA_ID);
  if (typeof value.ok !== 'boolean') problems.push('ok 不是布尔值');
  if (value.command !== undefined && typeof value.command !== 'string') problems.push('command 不是字符串');
  if (value.subcommand !== undefined && typeof value.subcommand !== 'string') problems.push('subcommand 不是字符串');
  if (value.page !== undefined) {
    if (!isPlainObject(value.page)) problems.push('page 不是对象');
    else {
      const page = value.page;
      for (const key of ['returned', 'total', 'offset']) {
        if (page[key] !== undefined && !Number.isInteger(page[key])) problems.push('page.' + key + ' 不是整数');
      }
      for (const key of ['hasMore', 'truncated', 'totalExact']) {
        if (page[key] !== undefined && typeof page[key] !== 'boolean') problems.push('page.' + key + ' 不是布尔值');
      }
      if (page.cursor !== undefined && typeof page.cursor !== 'string') problems.push('page.cursor 不是字符串');
      if (page.totalExact === false && page.total !== page.returned) {
        problems.push('page.totalExact=false 时 total 必须等于 returned（下界语义）');
      }
    }
  }
  if (value.ok === false) {
    if (!isPlainObject(value.error)) problems.push('失败信封缺少 error 对象');
    else {
      if (typeof value.error.code !== 'string' || !value.error.code) problems.push('error.code 缺失');
      if (typeof value.error.message !== 'string') problems.push('error.message 缺失');
      if (value.error.hint !== undefined && typeof value.error.hint !== 'string') problems.push('error.hint 不是字符串');
      if (value.error.usage !== undefined && typeof value.error.usage !== 'string') problems.push('error.usage 不是字符串');
    }
  }
  return problems;
}
