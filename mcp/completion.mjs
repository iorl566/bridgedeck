// mcp/completion.mjs —— MCP `completion/complete` 参数补全（prompt 参数 / resource 模板参数）。
//
// 目标（第十批-B ①：prompts 深化）：MCP 的 completion/complete 让客户端在用户输入
// prompt 参数或 resource 模板变量时向 server 要候选值。BridgeDeck 有 9+ 个 prompt
// （其中若干参数是枚举）和 4 个资源模板（技能参考名 / 会话 id），此前客户端只能靠
// prompts/list 的 _meta 自己推断候选 —— 现在 server 直接提供补全：
//   1. ref/prompt：按 prompt 声明过滤参数枚举（大小写不敏感前缀优先、子串次之）；
//   2. ref/resource：按 uriTemplate 变量名补全（技能参考文件名 / 会话 id 由调用方注入）；
//   3. 规范边界：单次最多 100 个值（MCP 2024-11-05 上限），超出时给 total/hasMore
//      与可续读游标（复用 mcp/cursor.mjs），不静默截断；
//   4. 未知 prompt/参数/模板 → JSON-RPC -32602（E_ARG_*），与 prompts/get 的错误口径一致；
//   5. 自由文本参数不伪造候选：返回值空数组 + `_meta.freeForm=true`，让客户端知道
//      “没有候选项不是错误”；
//   6. 纯函数 + 依赖注入（prompt 声明、技能参考名、会话 id 由 server 传入），
//      不读盘、不访问 daemon，可离线单测。
//
// 调用点：mcp/server.mjs 的 completion/complete 方法、initialize 的 completions 能力声明、
// 启动期 assertCompletions()；单测 tests/unit/mcp-completion.test.mjs。

import { paginateList } from './cursor.mjs';
import { PROMPT_DEFINITIONS, promptDefinition } from './prompts.mjs';
import { completePromptArgumentFromCatalog, promptArgumentPlan } from './prompt-completion.mjs';

/** 规范上限：completion 单次最多 100 个候选值。 */
export const COMPLETION_LIMITS = Object.freeze({
  maxValues: 100,
  maxValueLength: 256,
  maxArgumentNameLength: 64,
  defaultLimit: 100,
});

/** 支持的 ref 类型。 */
export const COMPLETION_REF_TYPES = Object.freeze(['ref/prompt', 'ref/resource']);

/** 补全错误码（server 统一映射到 -32602）。 */
export const COMPLETION_ERRORS = Object.freeze({
  NOT_FOUND: 'E_NOT_FOUND',
  UNKNOWN_ARG: 'E_ARG_UNEXPECTED',
  MISSING_ARG: 'E_ARG_MISSING',
  BAD_REF: 'E_BAD_ARG',
});

/** 带 code 的补全错误。 */
export class CompletionError extends Error {
  constructor(code, message) {
    super(String(message));
    this.name = 'CompletionError';
    this.code = code;
  }
}

/**
 * 已知资源模板（与 mcp/resources.mjs 的 templates() 顺序一致）。
 * 这里只声明“变量名 → 候选来源”，候选本身由 server 注入（技能参考名 / 会话 id）。
 */
export const COMPLETION_TEMPLATES = Object.freeze([
  Object.freeze({ uriTemplate: 'bridge://skill/references/{name}', variable: 'name', source: 'skill-references', multi: false }),
  Object.freeze({ uriTemplate: 'bridge://observation/{session}', variable: 'session', source: 'sessions', multi: false }),
  Object.freeze({ uriTemplate: 'bridge://debug/evidence/{session}', variable: 'session', source: 'sessions', multi: false }),
  Object.freeze({ uriTemplate: 'bridge://debug/journal/{session}', variable: 'session', source: 'sessions', multi: false }),
]);

/** 自由文本参数名的提示（用于 _meta.freeForm 的说明；不产生候选）。 */
export const FREE_FORM_HINTS = Object.freeze({
  task: '自然语言任务描述：没有固定候选，直接输入',
  url: '目标 URL：没有固定候选，直接输入',
  constraints: '自然语言约束：没有固定候选，直接输入',
  symptom: '现象描述：没有固定候选，直接输入',
  target: '页面目标（URL/元素）：没有固定候选，直接输入',
  reason: '原因描述：没有固定候选，直接输入',
  source: 'HAR 来源：输入 .har 路径或 latest',
  recording: '录制 id：没有固定候选，输入 video list 里的 id',
  failure: '失败类型：见枚举候选',
});

/** 候选值的规范化：去空白、去重、超长丢弃。 */
export function normalizeCandidates(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    if (text.length > COMPLETION_LIMITS.maxValueLength) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

/**
 * 前缀/子串匹配并排序：
 *   1. value 为空 → 全部候选（按字典序）；
 *   2. 完全等于 value 的排最前，其次是前缀匹配，再是子串匹配，最后是包含忽略大小写；
 *   3. 同一档内按字典序，保证稳定。
 * @returns {{ values:Array<string>, matchKind:'all'|'exact'|'prefix'|'substring' }}
 */
export function matchCandidates(candidates, value) {
  const list = normalizeCandidates(candidates);
  const needle = String(value == null ? '' : value).trim().toLowerCase();
  if (!needle) return { values: list.sort((a, b) => a.localeCompare(b)), matchKind: 'all' };
  const exact = [];
  const prefix = [];
  const substring = [];
  for (const candidate of list) {
    const lower = candidate.toLowerCase();
    if (lower === needle) exact.push(candidate);
    else if (lower.startsWith(needle)) prefix.push(candidate);
    else if (lower.includes(needle)) substring.push(candidate);
  }
  const values = [...exact.sort(), ...prefix.sort(), ...substring.sort()];
  return {
    values,
    matchKind: values.length === 0 ? 'none' : (exact.length ? 'exact' : (prefix.length ? 'prefix' : 'substring')),
  };
}

/** 把候选值按规范上限分页（超出 100 时需要客户端带 cursor 续读）。 */
export function paginateCompletionValues(values, { cursor = null, limit = null } = {}) {
  const effectiveLimit = limit == null ? COMPLETION_LIMITS.maxValues : Math.min(Number(limit) || COMPLETION_LIMITS.maxValues, COMPLETION_LIMITS.maxValues);
  return paginateList(values, {
    cursor,
    limit: effectiveLimit,
    label: 'completion',
    defaultLimit: COMPLETION_LIMITS.maxValues,
    maxLimit: COMPLETION_LIMITS.maxValues,
  });
}

/** 校验 completion/complete 的 params 形状（不做语义分派）。 */
export function validateCompletionParams(params) {
  const bag = params && typeof params === 'object' ? params : {};
  const ref = bag.ref;
  if (!ref || typeof ref !== 'object') {
    throw new CompletionError(COMPLETION_ERRORS.BAD_REF, 'completion/complete 需要 params.ref（ref/prompt 或 ref/resource）');
  }
  const type = String(ref.type || '');
  if (!COMPLETION_REF_TYPES.includes(type)) {
    throw new CompletionError(COMPLETION_ERRORS.BAD_REF, 'ref.type 必须是 ' + COMPLETION_REF_TYPES.join('|') + '，实际 ' + JSON.stringify(ref.type));
  }
  const argument = bag.argument;
  if (!argument || typeof argument !== 'object') {
    throw new CompletionError(COMPLETION_ERRORS.MISSING_ARG, 'completion/complete 需要 params.argument {name, value}');
  }
  const name = String(argument.name || '').trim();
  if (!name) throw new CompletionError(COMPLETION_ERRORS.MISSING_ARG, 'completion/complete 需要 argument.name');
  if (name.length > COMPLETION_LIMITS.maxArgumentNameLength) {
    throw new CompletionError(COMPLETION_ERRORS.BAD_REF, 'argument.name 超长（>' + COMPLETION_LIMITS.maxArgumentNameLength + '）');
  }
  const value = argument.value == null ? '' : String(argument.value);
  const context = bag.context && typeof bag.context === 'object' ? bag.context : null;
  return { ref, argument: { name, value }, context, type };
}

/**
 * ref/prompt 补全：按 prompt 声明里的 enum 给候选；enum 之外的参数按目录里的动态来源
 * （已知会话 id / HAR 来源）补全；确实没有候选的自由文本参数返回空 + freeForm（不是错误）。
 *
 * 第十一批-C 起：catalog 会传入 prompt 补全（此前只有资源模板用到 catalog），因此
 * cooperation_handoff.session 这类参数能补出真实会话 id；没注入 catalog 时行为与旧版一致。
 */
export function completePromptArgument({ ref, argument, prompts = PROMPT_DEFINITIONS, catalog = {} } = {}) {
  const name = String(ref && ref.name || '');
  const prompt = findPromptIn(prompts, name);
  if (!prompt) {
    throw new CompletionError(COMPLETION_ERRORS.NOT_FOUND, '未知 prompt：' + name + '（可用：' + (prompts || []).map((item) => item.name).join(', ') + '）');
  }
  const declared = (prompt.arguments || []).find((item) => item.name === argument.name);
  if (!declared) {
    throw new CompletionError(
      COMPLETION_ERRORS.UNKNOWN_ARG,
      'prompt ' + prompt.name + ' 不接受参数 ' + argument.name + '（可用：' + (prompt.arguments || []).map((item) => item.name).join(', ') + '）',
    );
  }
  if (Array.isArray(declared.enum)) {
    const matched = matchCandidates(declared.enum, argument.value);
    return {
      values: matched.values,
      total: matched.values.length,
      matchKind: matched.matchKind,
      freeForm: false,
      source: 'prompt-enum',
      prompt: prompt.name,
      argument: argument.name,
    };
  }
  // 动态来源（sessions / har-sources）：目录里有候选就返回候选；没有候选时保持旧输出。
  const enriched = completePromptArgumentFromCatalog({ prompt, argument: argument.name, value: argument.value, catalog });
  if (!enriched.freeForm && enriched.values.length) {
    return {
      values: [...enriched.values],
      total: enriched.values.length,
      matchKind: enriched.matchKind,
      freeForm: false,
      source: enriched.source,
      prompt: prompt.name,
      argument: argument.name,
      ...(enriched.hint ? { hint: enriched.hint } : {}),
    };
  }
  return {
    values: [],
    total: 0,
    matchKind: 'none',
    freeForm: true,
    source: 'prompt-free-form',
    prompt: prompt.name,
    argument: argument.name,
    hint: enriched.hint || FREE_FORM_HINTS[declared.name] || '自由文本参数：没有固定候选',
  };
}

function findPromptIn(prompts, name) {
  if (!Array.isArray(prompts)) return null;
  return prompts.find((item) => item && item.name === name) || null;
}

/**
 * ref/resource 补全：按 uriTemplate 的变量名补全。
 * catalog 由调用方注入：{ skillReferences: string[], sessions: string[] }。
 */
export function completeResourceArgument({ ref, argument, catalog = {} } = {}) {
  const uriTemplate = String(ref && ref.uri || '');
  if (!uriTemplate) throw new CompletionError(COMPLETION_ERRORS.BAD_REF, 'ref/resource 需要 ref.uri（模板字符串）');
  const template = COMPLETION_TEMPLATES.find((item) => item.uriTemplate === uriTemplate);
  if (!template) {
    throw new CompletionError(
      COMPLETION_ERRORS.NOT_FOUND,
      '未知资源模板：' + uriTemplate + '（可用：' + COMPLETION_TEMPLATES.map((item) => item.uriTemplate).join(', ') + '）',
    );
  }
  if (template.variable !== argument.name) {
    throw new CompletionError(
      COMPLETION_ERRORS.UNKNOWN_ARG,
      '资源模板 ' + uriTemplate + ' 的变量是 ' + template.variable + '，不是 ' + argument.name,
    );
  }
  const candidates = template.source === 'skill-references'
    ? normalizeCandidates(catalog.skillReferences || [])
    : normalizeCandidates(catalog.sessions || []);
  const matched = matchCandidates(candidates, argument.value);
  return {
    values: matched.values,
    total: matched.values.length,
    matchKind: matched.matchKind,
    freeForm: false,
    source: template.source,
    uriTemplate,
    argument: argument.name,
    ...(template.source === 'sessions' && candidates.length === 0
      ? { hint: '当前没有已知会话 id：先调用 browser_session_start 或 browser_sessions' }
      : {}),
  };
}

/**
 * completion/complete 主入口：校验 → 分派 → 分页 → 组装 MCP 应答。
 * @returns {{ completion:{ values:Array<string>, total:number, hasMore:boolean },
 *             _meta:{ 'browser-bridge/completion': object } }}
 */
export function complete(params, { prompts = PROMPT_DEFINITIONS, catalog = {}, cursor = null, limit = null } = {}) {
  const { ref, argument, type } = validateCompletionParams(params);
  const extra = params && typeof params === 'object' ? params : {};
  const pageCursor = cursor != null ? cursor : extra.cursor;
  const pageLimit = limit != null ? limit : extra.limit;
  const result = type === 'ref/prompt'
    ? completePromptArgument({ ref, argument, prompts, catalog })
    : completeResourceArgument({ ref, argument, catalog });
  const paged = paginateCompletionValues(result.values, { cursor: pageCursor, limit: pageLimit });
  const response = {
    completion: {
      values: [...paged.page],
      total: result.total,
      hasMore: paged.hasMore,
    },
  };
  if (paged.nextCursor) response.nextCursor = paged.nextCursor;
  response._meta = {
    'browser-bridge/completion': {
      refType: type,
      ...(type === 'ref/prompt' ? { prompt: result.prompt } : { uriTemplate: result.uriTemplate }),
      argument: argument.name,
      value: argument.value,
      matchKind: result.matchKind,
      freeForm: result.freeForm === true,
      source: result.source,
      candidates: result.total,
      returned: paged.page.length,
      hasMore: paged.hasMore,
      nextCursor: paged.nextCursor,
      maxValues: COMPLETION_LIMITS.maxValues,
      ...(result.hint ? { hint: result.hint } : {}),
    },
  };
  return response;
}

/**
 * 补全自检：每个 prompt 的枚举参数都能补出非空候选；每个资源模板变量都能被分派。
 * server 启动期 assertCompletions 与单测共用。
 * @returns {{ ok:boolean, errors:Array<{code:string,target:string,message:string}>, prompts:number, templates:number, enumArguments:number }}
 */
export function auditCompletions({ prompts = PROMPT_DEFINITIONS, templates = COMPLETION_TEMPLATES } = {}) {
  const errors = [];
  let enumArguments = 0;
  for (const prompt of prompts) {
    for (const argument of (prompt.arguments || [])) {
      if (!Array.isArray(argument.enum)) continue;
      enumArguments += 1;
      try {
        const result = complete({ ref: { type: 'ref/prompt', name: prompt.name }, argument: { name: argument.name, value: '' } }, { prompts });
        if (result.completion.values.length !== argument.enum.length) {
          errors.push({ code: 'completion-enum', target: prompt.name + '.' + argument.name, message: '枚举候选数不符：' + result.completion.values.length + ' != ' + argument.enum.length });
        }
        for (const value of result.completion.values) {
          if (!argument.enum.includes(value)) {
            errors.push({ code: 'completion-enum', target: prompt.name + '.' + argument.name, message: '候选不在声明枚举内：' + value });
          }
        }
      } catch (error) {
        errors.push({ code: 'completion-throw', target: prompt.name + '.' + argument.name, message: String((error && error.message) || error) });
      }
    }
  }
  for (const template of templates) {
    try {
      const result = complete({
        ref: { type: 'ref/resource', uri: template.uriTemplate },
        argument: { name: template.variable, value: '' },
      }, { catalog: { skillReferences: [], sessions: [] } });
      if (!Array.isArray(result.completion.values)) {
        errors.push({ code: 'completion-template', target: template.uriTemplate, message: '候选不是数组' });
      }
    } catch (error) {
      errors.push({ code: 'completion-template', target: template.uriTemplate, message: String((error && error.message) || error) });
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors.map((error) => Object.freeze(error))),
    prompts: prompts.length,
    templates: templates.length,
    enumArguments,
  });
}

/** strict 包装：补全表/枚举漂移时启动即失败。 */
export function assertCompletions(input) {
  const report = auditCompletions(input);
  if (!report.ok) {
    throw new Error('MCP completion 审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.target + ' ' + error.message).join('\n'));
  }
  return report;
}

/** 补全能力快照（initialize capabilities/completions 与 experimental 声明）。 */
export function completionSnapshot({ prompts = PROMPT_DEFINITIONS, templates = COMPLETION_TEMPLATES, skillReferences = [], sessions = [] } = {}) {
  const promptSources = prompts.flatMap((prompt) => (prompt.arguments || [])
    .map((argument) => promptArgumentPlan(prompt, argument.name))
    .filter((plan) => plan.kind !== 'free-form' && plan.kind !== 'prompt-enum')
    .map((plan) => ({ prompt: prompt.name, argument: plan.argument, kind: plan.kind })));
  return Object.freeze({
    supported: true,
    refTypes: COMPLETION_REF_TYPES,
    limits: COMPLETION_LIMITS,
    prompts: prompts.length,
    templates: templates.length,
    enumArguments: prompts.reduce((sum, prompt) => sum + (prompt.arguments || []).filter((argument) => Array.isArray(argument.enum)).length, 0),
    // 第十一批-C：enum 之外的动态补全来源（session / HAR source），客户端可据此知道哪些
    // 自由文本参数其实有候选（catalog 里会话/HAR 文件越多，候选越完整）。
    promptSources: Object.freeze(promptSources.map((item) => Object.freeze(item))),
    catalog: Object.freeze({
      skillReferences: skillReferences.length,
      sessions: sessions.length,
    }),
    cursorParam: 'cursor',
    freeFormReturnsEmpty: true,
  });
}

/** 判断名字是否是已知 prompt（server 侧轻量校验辅助）。 */
export function isKnownPrompt(name, prompts = PROMPT_DEFINITIONS) {
  return Boolean(findPromptIn(prompts, String(name || '')) || promptDefinition(name));
}
