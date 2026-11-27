// mcp/prompt-completion.mjs —— prompt 参数的“目录感知补全”（枚举之外的动态候选来源）。
//
// 目标（第十一批-C ②：参数补全深化）：
//   mcp/completion.mjs 已支持枚举参数（har_analysis.focus 等）与资源模板变量补全，但 prompt 里
//   还有一批参数天然有动态候选、此前却被当成自由文本：
//     - cooperation_handoff.session / recipe_from_session.session：其实可以补出已知会话 id；
//     - har_analysis.source：可选择 latest（当前会话导出）或既有 HAR 文件；
//     - cooperation_handoff.reason / debug_investigation.symptom 等：确实没有固定候选。
//   本模块声明“参数名 → 候选来源”，把目录（会话 id / 资源模板 / HAR 文件）注入后产出补全候选，
//   并区分三种语义：
//     - enum：声明里的固定枚举（仍由 completion.mjs 负责，避免两处重复）；
//     - source：有动态来源但当前没有候选（freeForm=true + hint，告诉客户端“没有候选不是错误”）；
//     - free-form：没有来源，客户端自由输入（freeForm=true + hint）。
//
// 设计约束：
//   1. 纯函数、无 IO：候选来自调用方注入的 catalog（server 从资源快照/技能目录派生）；
//   2. 不改变既有输出：没有注入 catalog 或 catalog 为空时，行为与旧版补全一致（空候选 + freeForm）；
//   3. 大小写不敏感前缀优先、完全匹配最前、子串次之（与 completion.mjs 的匹配排序一致）；
//   4. 候选去重、去空白、长度上限 256（MCP completion 单值上限），超出丢弃而不是截断。
//
// 调用点：mcp/completion.mjs 的 completePromptArgument（prompt 参数补全主路径）；
// initialize experimental['browser-bridge/completions'] 的 promptSources 声明；
// 单测 tests/unit/mcp-prompt-completion.test.mjs。

/** 补全来源种类。 */
export const PROMPT_ARGUMENT_SOURCE_KINDS = Object.freeze({
  ENUM: 'prompt-enum',
  SESSIONS: 'sessions',
  HAR_SOURCES: 'har-sources',
  FREE_FORM: 'free-form',
});

/** 参数名 → 动态来源（按参数名约定；prompt 名只用于更精确的提示语）。 */
export const PROMPT_ARGUMENT_SOURCES = Object.freeze([
  Object.freeze({ argument: 'session', source: PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS, description: '已知会话 id（来自资源快照/会话列表）' }),
  Object.freeze({ argument: 'source', source: PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES, description: 'HAR 来源：latest 或既有 .har 文件' }),
]);

/** 自由文本参数的提示语（没有候选时给客户端看；不产生候选）。 */
export const PROMPT_ARGUMENT_HINTS = Object.freeze({
  task: '自然语言任务描述：没有固定候选，直接输入',
  url: '目标 URL：没有固定候选，直接输入',
  constraints: '自然语言约束：没有固定候选，直接输入',
  symptom: '现象描述：没有固定候选，直接输入',
  target: '页面目标（URL/元素）：没有固定候选，直接输入',
  reason: '原因描述：没有固定候选，直接输入',
  goal: '目标描述：没有固定候选，直接输入',
  failure: '失败类型：见枚举候选',
  recording: '录制 id：没有固定候选，输入 video_list 里看到的 id',
  checks: '校验项：见枚举候选',
  focus: '分析重点：见枚举候选',
  layer: '协议层：见枚举候选',
});

/** HAR source 参数的固定候选（latest 永远可用；文件候选由调用方注入）。 */
export const HAR_SOURCE_LATEST = 'latest';

/** 候选值上限（与 MCP completion 规范一致）。 */
export const PROMPT_COMPLETION_LIMITS = Object.freeze({
  maxValues: 100,
  maxValueLength: 256,
  maxHarSources: 24,
});

function normalizeValues(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value == null ? '' : value).trim();
    if (!text || text.length > PROMPT_COMPLETION_LIMITS.maxValueLength) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= PROMPT_COMPLETION_LIMITS.maxValues) break;
  }
  return output;
}

/**
 * 与 completion.mjs 同语义的候选匹配排序（完全匹配 → 前缀 → 子串，同一档字典序）。
 * @returns {{ values:string[], matchKind:'all'|'exact'|'prefix'|'substring'|'none' }}
 */
export function rankCandidates(candidates, value) {
  const list = normalizeValues(candidates);
  const needle = String(value == null ? '' : value).trim().toLowerCase();
  if (!needle) return { values: list.sort((a, b) => a.localeCompare(b)), matchKind: list.length ? 'all' : 'none' };
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
  return { values, matchKind: values.length === 0 ? 'none' : (exact.length ? 'exact' : (prefix.length ? 'prefix' : 'substring')) };
}

/** 查参数名对应的动态来源声明；没有返回 null。 */
export function promptArgumentSourceOf(argumentName) {
  const name = String(argumentName || '');
  return PROMPT_ARGUMENT_SOURCES.find((entry) => entry.argument === name) || null;
}

/**
 * 解析单个 prompt 参数应如何补全（不产生候选）。
 * @param {{name:string, arguments?:Array<object>}} prompt
 * @param {string} argumentName
 * @returns {{ argument:string, kind:string, enum:(ReadonlyArray<string>|null), description:string|null, hint:string|null }}
 */
export function promptArgumentPlan(prompt, argumentName) {
  const name = String(argumentName || '');
  const declared = ((prompt && prompt.arguments) || []).find((argument) => argument && argument.name === name) || null;
  if (!declared) {
    return Object.freeze({ argument: name, kind: PROMPT_ARGUMENT_SOURCE_KINDS.FREE_FORM, enum: null, description: null, hint: 'prompt 未声明该参数' });
  }
  if (Array.isArray(declared.enum)) {
    return Object.freeze({ argument: name, kind: PROMPT_ARGUMENT_SOURCE_KINDS.ENUM, enum: Object.freeze([...declared.enum]), description: declared.description || null, hint: null });
  }
  const source = promptArgumentSourceOf(name);
  if (source) {
    return Object.freeze({ argument: name, kind: source.source, enum: null, description: declared.description || source.description, hint: null });
  }
  return Object.freeze({
    argument: name,
    kind: PROMPT_ARGUMENT_SOURCE_KINDS.FREE_FORM,
    enum: null,
    description: declared.description || null,
    hint: PROMPT_ARGUMENT_HINTS[name] || '自由文本参数：没有固定候选',
  });
}

/**
 * 目录感知的 prompt 参数补全。
 *
 * @param {{ prompt?:object, argument?:string, value?:string,
 *           catalog?:{sessions?:string[], harFiles?:string[], skillReferences?:string[]} }} input
 * @returns {{ values:ReadonlyArray<string>, total:number, kind:string, source:string|null,
 *             matchKind:string, freeForm:boolean, hint:(string|null) }}
 */
export function completePromptArgumentFromCatalog({ prompt = null, argument = '', value = '', catalog = {} } = {}) {
  const plan = promptArgumentPlan(prompt, argument);
  const bag = catalog && typeof catalog === 'object' ? catalog : {};
  if (plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.ENUM) {
    const ranked = rankCandidates(plan.enum, value);
    return Object.freeze({
      values: Object.freeze(ranked.values),
      total: ranked.values.length,
      kind: plan.kind,
      source: PROMPT_ARGUMENT_SOURCE_KINDS.ENUM,
      matchKind: ranked.matchKind,
      freeForm: false,
      hint: null,
    });
  }
  if (plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS) {
    const ranked = rankCandidates(bag.sessions || [], value);
    if (ranked.values.length) {
      return Object.freeze({
        values: Object.freeze(ranked.values),
        total: ranked.values.length,
        kind: plan.kind,
        source: PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS,
        matchKind: ranked.matchKind,
        freeForm: false,
        hint: null,
      });
    }
    return Object.freeze({
      values: Object.freeze([]),
      total: 0,
      kind: plan.kind,
      source: PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS,
      matchKind: 'none',
      freeForm: true,
      hint: '当前没有已知会话 id：先调用 browser_session_start 或 browser_sessions',
    });
  }
  if (plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES) {
    const harFiles = Array.isArray(bag.harFiles) ? bag.harFiles.slice(0, PROMPT_COMPLETION_LIMITS.maxHarSources) : [];
    const candidates = [HAR_SOURCE_LATEST, ...harFiles];
    const ranked = rankCandidates(candidates, value);
    return Object.freeze({
      values: Object.freeze(ranked.values),
      total: ranked.values.length,
      kind: plan.kind,
      source: PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES,
      matchKind: ranked.matchKind,
      freeForm: false,
      hint: harFiles.length ? null : '没有已知 HAR 文件：latest 表示从当前会话导出',
    });
  }
  return Object.freeze({
    values: Object.freeze([]),
    total: 0,
    kind: PROMPT_ARGUMENT_SOURCE_KINDS.FREE_FORM,
    source: null,
    matchKind: 'none',
    freeForm: true,
    hint: plan.hint,
  });
}

/**
 * 覆盖审计（completion 启动期/单测）：每个 prompt 的每个参数都能被分派到一种明确的补全语义，
 * 且 session/source 参数确实走动态来源、枚举参数确实走 enum。
 * @returns {{ ok:boolean, errors:Array<{code:string,target:string,message:string}>, prompts:number, arguments:number, dynamic:number }}
 */
export function auditPromptCompletion({ prompts = [] } = {}) {
  const errors = [];
  const push = (code, target, message) => errors.push(Object.freeze({ code, target: String(target), message }));
  const definitions = Array.isArray(prompts) ? prompts : [];
  if (!definitions.length) push('prompt-completion-empty', '<none>', '没有可审计的 prompt');
  let argumentsCount = 0;
  let dynamic = 0;
  for (const prompt of definitions) {
    const name = prompt && prompt.name;
    const seen = new Set();
    for (const argument of (prompt && prompt.arguments) || []) {
      argumentsCount += 1;
      if (seen.has(argument.name)) push('prompt-completion-duplicate', name + '.' + argument.name, '参数名重复');
      seen.add(argument.name);
      const plan = promptArgumentPlan(prompt, argument.name);
      if (plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.ENUM) {
        if (!Array.isArray(argument.enum) || argument.enum.length < 2) push('prompt-completion-enum', name + '.' + argument.name, '枚举参数至少 2 个值');
      } else if (plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS || plan.kind === PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES) {
        dynamic += 1;
      } else if (!plan.hint) {
        push('prompt-completion-hint', name + '.' + argument.name, '自由文本参数需要 hint（告诉客户端没有候选不是错误）');
      }
    }
    // 每个 prompt 至少要能完成一次“无 catalog”渲染（不允许补全路径抛错）。
    try {
      for (const argument of (prompt && prompt.arguments) || []) {
        const result = completePromptArgumentFromCatalog({ prompt, argument: argument.name, value: '' });
        if (!Array.isArray(result.values)) push('prompt-completion-shape', name + '.' + argument.name, '候选不是数组');
      }
    } catch (error) {
      push('prompt-completion-throw', name, String((error && error.message) || error));
    }
  }
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    prompts: definitions.length,
    arguments: argumentsCount,
    dynamic,
  });
}

/** strict 包装：补全语义分派漂移时启动即失败。 */
export function assertPromptCompletion(input) {
  const report = auditPromptCompletion(input);
  if (!report.ok) {
    throw new Error('MCP prompt 参数补全审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.target + ' ' + error.message).join('\n'));
  }
  return report;
}

/** prompt 参数补全能力快照（initialize experimental['browser-bridge/completions'].promptSources）。 */
export function promptCompletionSnapshot() {
  return Object.freeze({
    supported: true,
    sources: Object.freeze(PROMPT_ARGUMENT_SOURCES.map((entry) => Object.freeze({ argument: entry.argument, source: entry.source, description: entry.description }))),
    kinds: PROMPT_ARGUMENT_SOURCE_KINDS,
    limits: PROMPT_COMPLETION_LIMITS,
    freeFormReturnsEmpty: true,
    hints: PROMPT_ARGUMENT_HINTS,
  });
}
