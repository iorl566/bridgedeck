// cli/lib/arg-contract.mjs —— 目标子命令的参数契约引擎（纯函数、无 I/O）。
//
// 分工：cli/lib/command-specs.mjs 声明每个命令“允许什么”，本文件负责“怎么判定非法”。
// 所有错误都是 ArgError 子类（退出码 2），并附带 code / hint / usage，方便：
//   1) 人类用户看到“下一步怎么做”；
//   2) --json 用户拿到稳定的 error.code，可分支处理；
//   3) 测试逐条断言“非法组合在参数层就被拒绝”，而不是等到 daemon 往返失败。
import { ArgError, parseDurationMs } from './args.mjs';

/** 风险分级：dry-run / 帮助 / 回执都要用它标注“这一步会动什么”。 */
export const RISK = Object.freeze({
  READ_ONLY: 'read_only',
  LOCAL_WRITE: 'local_write',
  DAEMON_STATE: 'daemon_state',
  BROWSER_MUTATION: 'browser_mutation',
  HUMAN_GATE: 'human_gate',
});

export const RISK_ORDER = Object.freeze([RISK.READ_ONLY, RISK.LOCAL_WRITE, RISK.DAEMON_STATE, RISK.HUMAN_GATE, RISK.BROWSER_MUTATION]);

export const RISK_INFO = Object.freeze({
  read_only: Object.freeze({
    label: '只读',
    mutatesBrowser: false,
    mutatesDaemon: false,
    reversible: true,
    advice: '只读取状态，可安全重复执行。',
  }),
  local_write: Object.freeze({
    label: '本地写入',
    mutatesBrowser: false,
    mutatesDaemon: false,
    reversible: false,
    advice: '会在本机 ~/.browser-bridge 下写文件；dry-run 会列出目标路径。',
  }),
  daemon_state: Object.freeze({
    label: 'daemon 状态变更',
    mutatesBrowser: false,
    mutatesDaemon: true,
    reversible: true,
    advice: '改变 daemon 的会话/控制权状态，不直接改页面；可用 session control 复核。',
  }),
  browser_mutation: Object.freeze({
    label: '浏览器状态变更',
    mutatesBrowser: true,
    mutatesDaemon: true,
    reversible: false,
    advice: '会真正改变浏览器（导航/点击/关闭/输入）；不可自动回滚，建议先 --dry-run 看请求。',
  }),
  human_gate: Object.freeze({
    label: '人工闸门',
    mutatesBrowser: true,
    mutatesDaemon: true,
    reversible: false,
    advice: '必须由人类确认（--confirm-human）才能执行。',
  }),
});

/** 参数错误统一 code；退出码固定 2（与既有 CLI 一致）。 */
export class ContractError extends ArgError {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ContractError';
    this.code = code || 'E_BAD_ARG';
    this.hint = extra.hint || '';
    this.usage = extra.usage || '';
    this.details = extra.details;
  }
}

export function argFail(code, message, extra = {}) {
  throw new ContractError(code, message, extra);
}

function usageSuffix(context) {
  return context && context.usage ? '\n  用法：' + context.usage : '';
}

/** 该标志是否“被显式设置”（布尔标志要 true；带值标志只要出现）。 */
export function isSet(flags, name) {
  const value = flags[name];
  if (value === undefined || value === null) return false;
  if (value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 拒绝该命令不认识的参数：把“静默忽略”改成“参数层报错 + 给可用清单”。 */
export function assertAllowedFlags(flags, allowed, context = {}) {
  const known = allowed instanceof Set ? allowed : new Set(allowed || []);
  const names = Object.keys(flags || {}).filter((name) => !known.has(name));
  if (!names.length) return;
  const name = names[0];
  const tail = context.allowedList ? '\n  可用参数：' + context.allowedList : '';
  argFail(
    'E_UNKNOWN_FLAG',
    '`--' + name + '` 不是 bridge ' + (context.label || '该命令') + ' 支持的参数',
    {
      hint: '去掉 `--' + name + '`，或换用 bridge help ' + (context.topic || '<命令>') + ' 查看该命令支持的参数。' + tail,
      usage: context.usage,
      details: { flag: name, unknown: names },
    },
  );
}

/** 统计位置参数数量：少了给“缺什么”，多了给“多了什么 + 正确用法”。 */
export function assertPositionals(pos, offset, definition, context = {}) {
  const args = Array.isArray(pos) ? pos.slice(offset) : [];
  const min = definition.min ?? 0;
  const max = definition.max ?? min;
  const labels = definition.labels || [];
  if (args.length < min) {
    const missing = labels.slice(args.length, min).join(' ');
    argFail('E_ARG_MISSING', '缺少参数 ' + missing, {
      hint: definition.hint || '按用法补上位置参数；bridge help ' + (context.topic || '<命令>') + ' 有示例。' + usageSuffix(context),
      usage: context.usage,
      details: { missing, received: args.length, expectedMin: min },
    });
  }
  if (args.length > max) {
    const extra = args.slice(max).join(' ');
    argFail('E_ARG_UNEXPECTED', '多余的参数：' + extra, {
      hint: (definition.extraHint || '该子命令最多接受 ' + max + ' 个位置参数。') + usageSuffix(context),
      usage: context.usage,
      details: { extra: args.slice(max), expectedMax: max },
    });
  }
  return args;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TAB_ID_PATTERN = /^\d+$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ALIAS_PATTERN = /^[^\s]{1,64}$/;

function failType(name, message, hint, context) {
  argFail('E_ARG_TYPE', message, { hint: hint + usageSuffix(context), usage: context.usage, details: { flag: name } });
}

function asText(name, raw, context) {
  const text = String(raw);
  if (!text.trim()) {
    failType(name, '`--' + name + '` 需要非空值', '去掉空值，或按用法给一个具体值。', context);
  }
  return text;
}

/** 单个值按声明类型校验；只校验、不改写（命令仍读原始 flags）。 */
export function checkValue(name, raw, definition = {}, context = {}) {
  const kind = definition.kind || 'string';
  const values = Array.isArray(raw) ? raw : [raw];
  for (const item of values) {
    if (item === undefined || item === null) continue;
    const text = String(item);
    switch (kind) {
      case 'bool':
        break;
      case 'string':
        if (!text) failType(name, '`--' + name + '` 需要非空值', '按用法给一个具体值。', context);
        break;
      case 'name': {
        const limit = definition.maxLength || 80;
        if (!text.trim()) failType(name, '`--' + name + '` 需要非空值', '名字不能为空。', context);
        if (text.length > limit) {
          argFail('E_ARG_RANGE', '`--' + name + '` 最长 ' + limit + ' 个字符，收到 ' + text.length + ' 个', {
            hint: '缩短到 ' + limit + ' 字符以内。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        break;
      }
      case 'color':
        if (!COLOR_PATTERN.test(text)) {
          argFail('E_ARG_TYPE', '`--' + name + '` 需要 #rrggbb 颜色，收到 "' + text + '"', {
            hint: '例如 --' + name + ' "#3b82f6"。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        break;
      case 'int':
      case 'tab-id':
      case 'positive-int': {
        if (!/^-?\d+$/.test(text)) {
          failType(name, '`--' + name + '` 需要整数，收到 "' + text + '"', '例如 --' + name + ' 3。', context);
        }
        const value = Number(text);
        const min = definition.min !== undefined ? definition.min : (kind === 'positive-int' ? 1 : undefined);
        const max = definition.max;
        if (kind === 'tab-id' && value < 1) {
          argFail('E_ARG_RANGE', '`--' + name + '` 需要 ≥1 的 tabId，收到 ' + value, {
            hint: 'tabId 取自 bridge tab list 或 session start 的结果。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        if (min !== undefined && value < min) {
          argFail('E_ARG_RANGE', '`--' + name + '` 必须 >= ' + min + '，收到 ' + value, {
            hint: '按范围给值。' + usageSuffix(context), usage: context.usage,
          });
        }
        if (max !== undefined && value > max) {
          argFail('E_ARG_RANGE', '`--' + name + '` 必须 <= ' + max + '，收到 ' + value, {
            hint: '按范围给值。' + usageSuffix(context), usage: context.usage,
          });
        }
        break;
      }
      case 'duration': {
        let ms;
        try {
          ms = parseDurationMs(text, undefined);
        } catch (error) {
          failType(name, '`--' + name + '` 时间格式非法：' + error.message, '用 500ms / 20s / 2m / 1h / 30d 这类写法。', context);
        }
        if (definition.minMs !== undefined && ms < definition.minMs) {
          argFail('E_ARG_RANGE', '`--' + name + '` 必须 >= ' + definition.minMs + 'ms，收到 ' + ms + 'ms', {
            hint: '按范围给值。' + usageSuffix(context), usage: context.usage,
          });
        }
        break;
      }
      case 'enum': {
        const allowed = definition.values || [];
        if (!allowed.includes(text)) {
          argFail('E_ARG_ENUM', '`--' + name + '` 只支持 ' + allowed.join('|') + '，收到 "' + text + '"', {
            hint: '改成 ' + allowed.join(' / ') + ' 之一。' + usageSuffix(context),
            usage: context.usage,
            details: { flag: name, allowed, received: text },
          });
        }
        break;
      }
      case 'url': {
        let parsed = null;
        try {
          parsed = new URL(text);
        } catch {
          parsed = null;
        }
        const schemes = definition.schemes || ['http:', 'https:'];
        if (!parsed || !schemes.includes(parsed.protocol)) {
          argFail('E_ARG_TYPE', '`--' + name + '` 需要 ' + schemes.map((s) => s.replace(':', '')).join('/') + ' URL，收到 "' + text + '"', {
            hint: '例如 --' + name + ' https://example.com/。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        break;
      }
      case 'json': {
        try {
          JSON.parse(text);
        } catch (error) {
          argFail('E_ARG_TYPE', '`--' + name + '` 不是合法 JSON：' + error.message, {
            hint: '用单引号包住 JSON：--' + name + " '[...]'。",
            usage: context.usage,
          });
        }
        break;
      }
      case 'key-value': {
        const index = text.indexOf('=');
        if (index <= 0) {
          argFail('E_ARG_TYPE', '`--' + name + '` 需要 key=value，收到 "' + text + '"', '例如 --' + name + ' city=上海。', {
            usage: context.usage,
          });
        }
        break;
      }
      case 'last-segment': {
        if (/[\\/]$/.test(text)) {
          failType(name, '`--' + name + '` 需要文件路径，收到目录 "' + text + '"', '补上文件名。', context);
        }
        break;
      }
      case 'session-id':
        if (!SESSION_ID_PATTERN.test(text)) {
          argFail('E_ARG_TYPE', 'sessionId 只能包含字母/数字/下划线/短横线，收到 "' + text + '"', {
            hint: 'sessionId 取自 bridge session list。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        break;
      case 'tab-id-text':
        if (!TAB_ID_PATTERN.test(text)) {
          argFail('E_ARG_TYPE', '`' + name + '` 需要整数 tabId，收到 "' + text + '"', {
            hint: 'tabId 取自 bridge tab list；也可以用 tab alias 设置别名。' + usageSuffix(context),
            usage: context.usage,
            details: { label: name, received: text },
          });
        }
        break;
      case 'alias':
        if (!ALIAS_PATTERN.test(text)) {
          argFail('E_ARG_TYPE', 'alias 不能包含空白且最长 64 字符，收到 "' + text + '"', {
            hint: '例如 bridge tab alias 12 checkout。' + usageSuffix(context),
            usage: context.usage,
          });
        }
        break;
      default:
        break;
    }
  }
}

/** 位置参数按类型校验（tabId / url / ms / sessionId / int / file / string）。 */
export function checkPositional(value, kind, label, context = {}) {
  if (value === undefined) return;
  const text = String(value);
  if (kind === 'tab-id') {
    if (!TAB_ID_PATTERN.test(text)) {
      argFail('E_ARG_TYPE', label + ' 需要整数 tabId，收到 "' + text + '"', {
        hint: 'tabId 取自 bridge tab list；别名请先 tab alias。' + usageSuffix(context),
        usage: context.usage,
      });
    }
    if (Number(text) < 1) {
      argFail('E_ARG_RANGE', label + ' 需要 >= 1，收到 ' + text, { hint: 'tabId 从 1 开始。' + usageSuffix(context), usage: context.usage });
    }
    return;
  }
  if (kind === 'int' || kind === 'ms') {
    if (!/^-?\d+$/.test(text)) {
      argFail('E_ARG_TYPE', label + ' 需要整数，收到 "' + text + '"', { hint: '按用法给整数。' + usageSuffix(context), usage: context.usage });
    }
    if (kind === 'ms' && Number(text) < 0) {
      argFail('E_ARG_RANGE', label + ' 需要非负毫秒数，收到 ' + text, { hint: '给 0 或正数。' + usageSuffix(context), usage: context.usage });
    }
    return;
  }
  if (kind === 'url') {
    checkValue(label.replace(/^<|>$/g, ''), text, { kind: 'url', schemes: ['http:', 'https:', 'file:', 'about:'] }, { ...context, usage: context.usage });
    return;
  }
  if (kind === 'session-id') {
    checkValue(label.replace(/^<|>$/g, ''), text, { kind: 'session-id' }, context);
    return;
  }
  if (kind === 'file' || kind === 'path') {
    if (!text) argFail('E_ARG_MISSING', '缺少参数 ' + label, { hint: '给一个文件路径。' + usageSuffix(context), usage: context.usage });
    return;
  }
  if (kind === 'alias') {
    checkValue('alias', text, { kind: 'alias' }, context);
    return;
  }
  if (!text && kind !== 'optional-string') {
    argFail('E_ARG_MISSING', '缺少参数 ' + label, { hint: '按用法补上。' + usageSuffix(context), usage: context.usage });
  }
}

/** 依赖关系：给了 A 就必须给 B（例如 --share → --tab）。 */
export function assertRequires(flags, rules, context = {}) {
  for (const rule of rules || []) {
    if (!isSet(flags, rule.flag)) continue;
    if (typeof rule.when === 'function' && !rule.when(flags)) continue;
    const missing = (rule.requires || []).filter((name) => !isSet(flags, name));
    if (!missing.length) continue;
    argFail(
      'E_ARG_REQUIRES',
      '`--' + rule.flag + '` 需要同时提供 ' + missing.map((name) => '`--' + name + '`').join(' 或 '),
      {
        hint: rule.hint || '补上 ' + missing.map((name) => '--' + name).join(' / ') + '。' + usageSuffix(context),
        usage: context.usage,
        details: { flag: rule.flag, requires: missing },
      },
    );
  }
}

/** 互斥关系：同一组里最多出现一个。 */
export function assertExclusive(flags, groups, context = {}) {
  for (const group of groups || []) {
    const present = (group.flags || group).filter((name) => isSet(flags, name));
    if (present.length <= 1) continue;
    const names = present.map((name) => '`--' + name + '`').join('、');
    argFail('E_ARG_CONFLICT', '以下参数互斥，只能给一个：' + names, {
      hint: (group.hint || '只保留一个，另一个删掉。') + usageSuffix(context),
      usage: context.usage,
      details: { flags: present },
    });
  }
}

/** 至少给一个（例如 session stop 需要 id 或 --all）。 */
export function assertAtLeastOne(flags, names, context = {}) {
  if (names.some((name) => isSet(flags, name))) return;
  argFail('E_ARG_MISSING', '缺少参数：' + names.map((name) => '--' + name).join(' / '), {
    hint: context.hint || ('补上 ' + names.map((name) => '--' + name).join(' / ') + ' 之一。') + usageSuffix(context),
    usage: context.usage,
  });
}

/** 指定参数不允许同时出现（例如 --all 时不能再指定会话 id）。 */
export function assertAbsent(flags, names, context = {}) {
  const present = names.filter((name) => isSet(flags, name));
  if (!present.length) return;
  argFail('E_ARG_CONFLICT', '这些参数不能一起使用：' + present.map((name) => '`--' + name + '`').join('、'), {
    hint: context.hint || '删掉其中一个。' + usageSuffix(context),
    usage: context.usage,
  });
}

/**
 * 由“位置参数或标志”解析会话 id：返回 { value, source }，都不存在返回 null。
 * 只做取用与冲突检查，不校验 daemon 里是否存在（dry-run 不能触达 daemon）。
 */
export function resolveSessionArg(flags, pos, index, context = {}) {
  const positional = pos[index];
  const fromFlag = isSet(flags, 'session') ? String(flags.session) : null;
  if (positional !== undefined && positional !== '') {
    if (!fromFlag || fromFlag === String(positional)) return { value: String(positional), source: 'positional' };
    argFail('E_ARG_CONFLICT', '会话 id 给了两个不同值：位置参数 "' + positional + '" 与 --session "' + fromFlag + '"', {
      hint: '只保留一个。' + usageSuffix(context), usage: context.usage,
    });
  }
  if (fromFlag) return { value: fromFlag, source: 'flag' };
  if (isSet(flags, 'session-scope')) return { value: null, source: 'scope' };
  if (process.env.BB_SESSION && process.env.BB_SESSION.trim()) return { value: process.env.BB_SESSION.trim(), source: 'env' };
  if (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()) return { value: null, source: 'env-scope' };
  if (context.required) {
    argFail('E_ARG_MISSING', context.label || '缺少会话 id', {
      hint: '补上 <sessionId> 或 --session <id>（bridge session list 可查）；只有一个会话时可省略。' + usageSuffix(context),
      usage: context.usage,
    });
  }
  return null;
}

/** 风险取最大值（browser_mutation 会覆盖 read_only）。 */
export function maxRisk(risks) {
  let best = RISK.READ_ONLY;
  for (const risk of risks || []) {
    if (!RISK_INFO[risk]) continue;
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(best)) best = risk;
  }
  return best;
}

/** 风险描述（帮助 / dry-run / 报错共用一份）。 */
export function describeRisk(risk) {
  const info = RISK_INFO[risk] || RISK_INFO.read_only;
  return risk + '（' + info.label + '：' + info.advice + '）';
}
