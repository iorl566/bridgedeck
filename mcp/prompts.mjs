// mcp/prompts.mjs —— MCP prompts（可复用任务模板，按需渲染）。
//
// 目标（W5-A 第 2 项）：给客户端一组稳定的「起手式」提示词，把 BridgeDeck 的工具分级、
// 资源 URI、分页语义与恢复策略编码进去，减少每个客户端自己重复写系统提示。
//
// 约定：
//   - prompts/list 只返回声明（不含渲染结果）；tags/resources 放在 _meta 下，保持
//     MCP prompt 声明字段最小集；
//   - prompts/get 校验必填/未知/枚举参数，渲染出 MCP 规范的 messages；
//   - 模板里显式提到 tier：read 工具可直接调，destructive 工具需要 _meta 审批；
//   - 模板里显式提到 resources（bridge://skill/SKILL.md、bridge://observation/latest、
//     bridge://debug/journal/latest），让客户端知道“大文本按需读 + ?limit=&cursor= 分页”；
//   - 纯函数、无 IO，可离线渲染（测试不需要 daemon/浏览器）。

export const PROMPT_ERRORS = Object.freeze({
  NOT_FOUND: 'E_NOT_FOUND',
  MISSING_ARG: 'E_ARG_MISSING',
  UNKNOWN_ARG: 'E_ARG_UNEXPECTED',
  ENUM: 'E_ARG_ENUM',
});

/** prompt 参数允许的枚举值之外的取值统一按 E_ARG_ENUM 拒绝。 */
export const PROMPT_RESOURCE_HINTS = Object.freeze([
  'bridge://skill/SKILL.md',
  'bridge://observation/latest',
  'bridge://debug/journal/latest',
]);

/** 带 code 的 prompt 错误。 */
export class PromptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PromptError';
    this.code = code;
  }
}

const OBSERVE_FIRST = '先调 browser_status 确认 daemon 与浏览器实例，再调 browser_observe（read 级）拿带 @eN ref 的页面结构；导航后旧 ref 全部失效，必须重新 observe。';
const SAFETY = 'read 级工具（observe/read/extract/screenshot/network.list 等）可直接调用；destructive 级工具（browser_evaluate/browser_settings/browser_pair/browser_session_stop/browser_tab_close/browser_recipe/browser_update）需要在 tools/call 的 params._meta 传 "browser-bridge/approval": "confirmed" 才会执行。';
const RESOURCE_HINT = '需要完整技能说明时按需读取 resource bridge://skill/SKILL.md；需要复查最近页面快照时读 bridge://observation/latest；需要调试时间线时读 bridge://debug/journal/latest；参考文档用 bridge://skill/references/{name}；超过单段上限时用 ?limit=<1..65536>&cursor=<字符偏移> 续读（nextCursor 来自上次结果）。';
const PAGING = '分页结果（observe/extract/network.list/network.waterfall/screenshot 等）可能带 truncated/cursor；不要假设一次拿全量，按 nextCursor 续读。';

/**
 * 每个 prompt 的声明与渲染函数。
 * messages 只使用 user 角色（MCP 客户端可自行决定是否注入 system）；
 * 渲染文本里保留参数原文，便于客户端展示与调试。
 */
export const PROMPT_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'browser_task_brief',
    title: '浏览器任务简报',
    description: '为一个页面任务生成执行简报：先观察、再决定动作、按 ref 操作并验证。',
    tags: Object.freeze(['task', 'observe', 'action']),
    resources: Object.freeze(['bridge://skill/SKILL.md', 'bridge://observation/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'task', description: '要完成的页面任务（自然语言）', required: true }),
      Object.freeze({ name: 'url', description: '目标 URL（可选；给出时先导航再观察）', required: false }),
      Object.freeze({ name: 'constraints', description: '额外约束（可选；如只读、不要提交表单）', required: false }),
    ]),
    render: (args) => {
      const lines = [
        '# 浏览器任务',
        '任务：' + args.task,
        args.url ? '目标 URL：' + args.url : '目标页面：沿用当前活动标签页',
        args.constraints ? '约束：' + args.constraints : '约束：无额外约束',
        '',
        '执行顺序：',
        '1. ' + (args.url ? '调 browser_navigate（mutate 级）到目标 URL；' : '') + OBSERVE_FIRST,
        '2. 用 @eN ref 执行 browser_click / browser_fill / browser_press（mutate 级）；单个动作失败先 observe 再决定是否重试，不要盲目重放可能提交的动作。',
        '3. 需要批量已决定动作时用 browser_plan（首个失败即停，不自动重试）。',
        '4. 涉及表单提交/删除/付款等不可逆操作前，先用 browser_brief 汇报并等待人工确认。',
        '5. ' + PAGING,
        '',
        '安全：' + SAFETY,
        '资源：' + RESOURCE_HINT,
      ];
      return lines.join('\n');
    },
  }),
  Object.freeze({
    name: 'debug_investigation',
    title: '调试调查',
    description: '为一个页面问题建立调试采集、证据包与 HAR/trace 分析流程。',
    tags: Object.freeze(['debug', 'network', 'evidence']),
    resources: Object.freeze(['bridge://debug/evidence/latest', 'bridge://debug/journal/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'symptom', description: '观察到的现象/报错', required: true }),
      Object.freeze({ name: 'target', description: '相关 URL 或元素（可选）', required: false }),
    ]),
    render: (args) => [
      '# 调试调查',
      '现象：' + args.symptom,
      args.target ? '相关目标：' + args.target : '相关目标：当前页面',
      '',
      '建议流程：',
      '1. browser_debug_start（mutate 级；bodies=true 可采集响应体）→ 复现操作 → browser_debug_stop。',
      '2. browser_debug_analyze 看慢请求/错误/重复 URL；browser_network_list 与 browser_network_waterfall 定位 requestId。',
      '3. 需要可回放证据时 browser_debug_evidence 落盘证据包，并读取 resource bridge://debug/evidence/latest 复查。',
      '4. 网络问题可 browser_debug_har 导出 HAR 1.2，或用 browser_network_replay_har 重放单条请求。',
      '5. 时间线问题用 browser_debug_journal（limit 可选）读请求/控制台/操作合并事件，再读 bridge://debug/journal/latest 复查。',
      '6. 性能问题先 browser_trace_start → 复现 → browser_trace_stop，再 browser_trace_summary 看热点/长任务。',
      '',
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'cooperation_handoff',
    title: '协作交接',
    description: '在人工接管/交还浏览器控制权时生成交接说明与下一步。',
    tags: Object.freeze(['cooperation', 'human-gate']),
    resources: Object.freeze(['bridge://skill/SKILL.md']),
    arguments: Object.freeze([
      Object.freeze({ name: 'reason', description: '需要人工接管的原因', required: true }),
      Object.freeze({ name: 'session', description: '会话 id（可选；省略则用当前会话）', required: false }),
    ]),
    render: (args) => [
      '# 协作交接',
      '原因：' + args.reason,
      '会话：' + (args.session || '当前会话'),
      '',
      '流程：',
      '1. 用 browser_brief 生成交接简报（URL/标题/待处理对话框/下一步）。',
      '2. 调用 browser_cooperate_sync（read 级）签发 context 收据，再 request-help / borrow 相关动作前先确认 authority 未被换代。',
      '3. 人工完成后重新 browser_cooperate_sync，再继续动作；旧 observation 收据已失效时重新 observe。',
      '4. 不要跨会话操作被租用的标签页（E_TAB_LEASE_HELD / E_CONTROL_NOT_HELD 时先读 browser_status）。',
      '',
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'recipe_from_session',
    title: '从会话生成配方',
    description: '把一次成功操作沉淀成可审批、可回放的 recipe 草稿。',
    tags: Object.freeze(['recipe', 'replay']),
    resources: Object.freeze(['bridge://skill/SKILL.md']),
    arguments: Object.freeze([
      Object.freeze({ name: 'goal', description: '希望可重复执行的流程目标', required: true }),
      Object.freeze({ name: 'session', description: '会话 id（可选）', required: false }),
    ]),
    render: (args) => [
      '# 配方草稿',
      '目标：' + args.goal,
      '来源会话：' + (args.session || '当前会话'),
      '',
      '流程：',
      '1. 用 browser_record_start（mutate 级）记录人工操作，完成后 browser_record_stop 并 browser_record_list 复查。',
      '2. 用 browser_recipe action=draft/save 生成草稿；human gate 与参数用 params 传入，不要写死敏感值。',
      '3. 回放前先 approve（destructive 级，需要 _meta 审批），再 action=run；失败按 E_DEPENDS_FAILED / E_HUMAN_GATE 恢复。',
      '4. 配方里禁止放密码；需要凭据时用人工确认 gate。',
      '',
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'page_action_plan',
    title: '页面动作计划',
    description: '把目标拆成可串行执行的动作序列，并声明失败策略。',
    tags: Object.freeze(['plan', 'action']),
    resources: Object.freeze(['bridge://observation/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'goal', description: '要达成的页面状态', required: true }),
      Object.freeze({ name: 'constraints', description: '只读/禁止提交等约束（可选）', required: false }),
    ]),
    render: (args) => [
      '# 页面动作计划',
      '目标状态：' + args.goal,
      args.constraints ? '约束：' + args.constraints : '约束：无额外约束',
      '',
      '要求：',
      '1. 先 observe 一次，输出「步骤 → 目标 ref → 期望断言」；每一步必须能映射到具体工具。',
      '2. 用 browser_plan 串行执行已决定步骤；首个失败即停，不自动重试，失败后用 observe 复核页面事实。',
      '3. 断言用 expect 参数（feature floor 1.9），失败码 E_EXPECT_FAILED。',
      '4. 任何 destructive 步骤单独列出来，等人工确认后再执行。',
      '',
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'har_analysis',
    title: 'HAR 分析',
    description: '分析 HAR 1.2 归档：耗时分解、错误分布、跨 frame 条目与可重放候选。',
    tags: Object.freeze(['har', 'network', 'analysis']),
    resources: Object.freeze(['bridge://protocol/summary', 'bridge://debug/journal/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'source', description: 'HAR 文件路径，或 latest（从当前会话导出）', required: true }),
      Object.freeze({ name: 'focus', description: '分析重点（默认 timings）', required: false, enum: Object.freeze(['timings', 'errors', 'payloads', 'replay']) }),
    ]),
    render: (args) => [
      '# HAR 分析',
      '来源：' + args.source,
      '重点：' + (args.focus || 'timings（queueing/TTFB/download 三段耗时）'),
      '',
      '流程：',
      '1. source=latest 时先用 browser_debug_har 从当前会话导出 HAR 1.2（read 级，写本地文件）；已有文件用 browser_debug_har_import 校验格式并映射可重放入口。',
      '2. 用 browser_network_waterfall 看 queueing/TTFB/download 三段耗时；结果是分页的（limit + cursor），跨 frame 的条目单独统计，streaming 未完成（没有 response end）的不要伪造为已完成。',
      '3. 失败/4xx/5xx 用 browser_network_list（分页）按 requestId 过滤，再用 browser_debug_analyze 汇总慢请求/错误/重复 URL。',
      '4. 需要重放单条请求时 browser_network_replay_har（file + entry/filter；需要 har 特性 floor）。重放会再次发出请求，有副作用时先人工确认。',
      '5. 输出：慢请求 Top N（requestId + 三段耗时）、错误码分布、可重放候选、是否值得 browser_debug_archive 落盘；随后读取 bridge://debug/evidence/latest 复查。',
      '',
      PAGING,
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'network_diagnosis',
    title: '网络诊断',
    description: '从症状出发定位 DNS/TLS/HTTP/WebSocket/缓存层的真实失败点，并给出证据闭环。',
    tags: Object.freeze(['network', 'diagnosis', 'websocket']),
    resources: Object.freeze(['bridge://debug/journal/latest', 'bridge://debug/evidence/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'symptom', description: '观察到的网络现象（超时/500/CORS/WS 断开等）', required: true }),
      Object.freeze({ name: 'url', description: '相关 URL（可选；默认当前页面）', required: false }),
      Object.freeze({ name: 'layer', description: '怀疑的协议层（默认不预设，先看事实）', required: false, enum: Object.freeze(['dns', 'tls', 'http', 'websocket', 'cache']) }),
    ]),
    render: (args) => [
      '# 网络诊断',
      '现象：' + args.symptom,
      '目标：' + (args.url || '当前页面'),
      '怀疑层：' + (args.layer || '不预设（先看事实，再收敛到具体层）'),
      '',
      '流程：',
      '1. browser_debug_start（mutate 级；bodies=true 才采集响应体）→ 复现 → browser_debug_stop；不要在没有复现的情况下猜结论。',
      '2. browser_network_list 拿 requestId/状态码/耗时；browser_network_waterfall 区分排队/TTFB/下载与跨 frame 归属。',
      '3. WebSocket 场景看 browser_network_list 的 ws 帧视图（分页）确认帧方向、opcode 与关闭码，不要只看 HTTP 列表。',
      '4. 规则类问题（CORS/缓存/重定向）先 browser_rule_list 看当前 DNR 规则，再考虑 browser_rule_add（mutate 级；离线评估与下发同源）。',
      '5. 需要可回放证据：browser_debug_har 导出 → 读 bridge://debug/journal/latest 复查时间线 → browser_debug_evidence 落盘。',
      '6. 汇报：失败层（dns/tls/http/websocket/cache）、首个失败请求、可重放验证结果、以及是否与页面脚本错误相关（browser_debug_analyze）。',
      '',
      PAGING,
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
  Object.freeze({
    name: 'longshot_recovery',
    title: '长截图恢复',
    description: '按 stale/gap/crash/dpi-budget 四种失败形态恢复长截图，保留可校验的 manifest 证据。',
    tags: Object.freeze(['screenshot', 'recovery', 'capture']),
    resources: Object.freeze(['bridge://skill/SKILL.md', 'bridge://observation/latest']),
    arguments: Object.freeze([
      Object.freeze({ name: 'failure', description: '失败形态', required: true, enum: Object.freeze(['stale', 'gap', 'crash', 'dpi-budget']) }),
      Object.freeze({ name: 'url', description: '目标页面 URL（可选；默认当前标签页）', required: false }),
    ]),
    render: (args) => {
      const why = {
        stale: '分片过期或被后续滚动重拍覆盖：先确认当前视口与 DPR，再用 staleAttempts 重拍；不要拼接近似重复的分片。',
        gap: '中间缺片：先读 manifest 的缺片索引，只补缺失段；仍缺则降级为分段截图并如实报告。',
        crash: '浏览器/扩展重启：从 IndexedDB tile 索引恢复；标 recovered 的分片要重新校验像素高度再拼接，无法校验的整页丢弃。',
        'dpi-budget': '分数 DPR 或超长页预算：分数 DPR 只允许 1–3，>40000px 必须分段；命中像素/内存预算时先降 scale 再重试，不要静默裁剪。',
      }[args.failure];
      return [
        '# 长截图恢复',
        '失败形态：' + args.failure,
        '页面：' + (args.url || '当前标签页'),
        '判断：' + why,
        '',
        '流程：',
        '1. browser_status / browser_tabs 确认 daemon、标签页与窗口大小；browser_screenshot 先取一张视口截图确认 DPR 与页面高度。',
        '2. browser_longshot_recover（capture.stream 特性 floor，1.9）按失败形态恢复：stale 重拍、gap 补片、crash 从 tile 索引恢复、dpi-budget 降 scale 后分段。',
        '3. 恢复后用 browser_screenshot 的 stream/segmented 读回校验总高度与分片连续性；E_CAPTURE_STALE 时重新截图而不是重放旧坐标。',
        '4. 仍无法恢复时退回「分段截图 + 明示缺口」，不要把缺片拼成看似完整的长图。',
        '5. 结论写入 bridge://debug/journal/latest 复查；需要存档时 browser_debug_archive。',
        '',
        '安全：' + SAFETY,
        '资源：' + RESOURCE_HINT,
      ].join('\n');
    },
  }),
  Object.freeze({
    name: 'video_verify',
    title: '视频校验',
    description: '校验录制视频的完整性（时长/分片/sidx）并给出修复或剪辑路径。',
    tags: Object.freeze(['video', 'verify', 'recovery']),
    resources: Object.freeze(['bridge://skill/SKILL.md']),
    arguments: Object.freeze([
      Object.freeze({ name: 'recording', description: '录制 id 或本地文件路径', required: true }),
      Object.freeze({ name: 'checks', description: '校验项（默认 all）', required: false, enum: Object.freeze(['duration', 'frames', 'sidx', 'all']) }),
    ]),
    render: (args) => [
      '# 视频校验',
      '录制：' + args.recording,
      '校验项：' + (args.checks || 'all（时长 / 帧完整性 / sidx-faststart）'),
      '',
      '流程：',
      '1. browser_video_list 定位录制 id；browser_video_status 看实时状态（recording/paused/finalizing/sealed/recovered/failed），未 seal 时先别校验时长。',
      '2. browser_video_info 读 duration/尺寸/分段数/seal 状态；时长与预期对不上时先修分片，不要直接裁剪。',
      '3. 不完整或崩溃后的录制用 browser_video_recover 生成修复计划（缺片/截断/校验和不匹配分别列出）；recovered 分片要重新校验时长再合并。',
      '4. sidx/faststart 能否流式播放由 video.verify（feature floor video，1.9）判定；不通过时回到 recover 重新 seal，不要手改容器头。',
      '5. 需要裁剪/分段/合并时用 browser_video_trim / browser_video_split / browser_video_merge（mutate 级本地工具）；保留原始录制，完成后用 browser_video_info 复核。',
      '6. 汇报：总时长、分片数、缺失/恢复片段、能否流式播放、下一步（保留/重录/清理）。',
      '',
      '安全：' + SAFETY,
      '资源：' + RESOURCE_HINT,
    ].join('\n'),
  }),
]);

const PROMPT_MAP = new Map(PROMPT_DEFINITIONS.map((prompt) => [prompt.name, prompt]));

function promptMeta(prompt) {
  return Object.freeze({
    name: prompt.name,
    tags: Object.freeze([...(prompt.tags || [])]),
    resources: Object.freeze([...(prompt.resources || [])]),
    arguments: Object.freeze(prompt.arguments.map((argument) => ({
      name: argument.name,
      required: argument.required,
      enum: argument.enum ? Object.freeze([...argument.enum]) : null,
    }))),
  });
}

/** prompts/list 的返回（无渲染结果；tags/resources/enum 放 _meta 保持声明字段最小集）。 */
export function listPrompts() {
  return PROMPT_DEFINITIONS.map((prompt) => ({
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map((argument) => ({ name: argument.name, description: argument.description, required: argument.required })),
    _meta: { 'browser-bridge/prompt': promptMeta(prompt) },
  }));
}

/** 取单个 prompt 声明；未知返回 null。 */
export function promptDefinition(name) {
  return PROMPT_MAP.get(String(name || '')) || null;
}

/** 所有声明了枚举的 prompt/参数（契约测试与客户端提示用）。 */
export function promptEnumTable() {
  return PROMPT_DEFINITIONS.flatMap((prompt) => prompt.arguments
    .filter((argument) => Array.isArray(argument.enum))
    .map((argument) => ({ prompt: prompt.name, argument: argument.name, values: [...argument.enum] })));
}

function normalizeArguments(args) {
  if (args == null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new PromptError(PROMPT_ERRORS.MISSING_ARG, 'prompts/get 的 arguments 必须是对象');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(args)) normalized[String(key)] = value == null ? '' : String(value);
  return normalized;
}

/**
 * 校验 prompt 参数（必填/未知/枚举），不渲染。
 * @returns {{ ok:boolean, errors:Array<{code:string,argument:string,message:string}> }}
 */
export function validatePromptArguments(name, args) {
  const prompt = promptDefinition(name);
  if (!prompt) {
    return { ok: false, errors: [{ code: PROMPT_ERRORS.NOT_FOUND, argument: '', message: '未知 prompt：' + name }] };
  }
  let values;
  try {
    values = normalizeArguments(args);
  } catch (error) {
    return { ok: false, errors: [{ code: error.code || PROMPT_ERRORS.MISSING_ARG, argument: '', message: String(error.message) }] };
  }
  const errors = [];
  const declared = new Set(prompt.arguments.map((argument) => argument.name));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) errors.push({ code: PROMPT_ERRORS.UNKNOWN_ARG, argument: key, message: 'prompt ' + prompt.name + ' 不接受参数 ' + key });
  }
  for (const argument of prompt.arguments) {
    const value = String(values[argument.name] || '');
    if (argument.required && !value.trim()) {
      errors.push({ code: PROMPT_ERRORS.MISSING_ARG, argument: argument.name, message: 'prompt ' + prompt.name + ' 缺少必填参数 ' + argument.name });
      continue;
    }
    if (Array.isArray(argument.enum) && value.trim() && !argument.enum.includes(value)) {
      errors.push({
        code: PROMPT_ERRORS.ENUM,
        argument: argument.name,
        message: 'prompt ' + prompt.name + ' 参数 ' + argument.name + ' 取值必须是 ' + argument.enum.join('|') + '，实际 ' + JSON.stringify(value),
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * prompts/get：校验参数并渲染。
 * @returns {{ description:string, messages:Array<{role:string,content:{type:string,text:string}}>, _meta:object }}
 */
export function getPrompt(name, args) {
  const prompt = promptDefinition(name);
  if (!prompt) {
    throw new PromptError(PROMPT_ERRORS.NOT_FOUND, '未知 prompt：' + name + '（可用：' + PROMPT_DEFINITIONS.map((item) => item.name).join(', ') + '）');
  }
  const validation = validatePromptArguments(prompt.name, args);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new PromptError(first.code, first.message);
  }
  const values = normalizeArguments(args);
  const text = prompt.render(values);
  if (!text || typeof text !== 'string' || text.trim().length < 20) {
    throw new Error('prompt ' + prompt.name + ' 渲染结果异常');
  }
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
    _meta: {
      'browser-bridge/prompt': {
        ...promptMeta(prompt),
        // 渲染时实际生效的参数（客户端可回显/审计）
        arguments: prompt.arguments.map((argument) => ({ name: argument.name, value: values[argument.name] || '' })),
      },
    },
  };
}

/**
 * 审计用样例参数：枚举取第一个值，session 用固定 id，其他用 sample-<name>。
 * 导出给 auditPrompts、单测与客户端 fallback 共用，避免各处手写样例。
 */
export function sampleArguments(prompt) {
  const sample = {};
  for (const argument of prompt.arguments) {
    if (Array.isArray(argument.enum) && argument.enum.length) sample[argument.name] = argument.enum[0];
    else if (argument.name === 'session') sample[argument.name] = 's1';
    else sample[argument.name] = 'sample-' + argument.name;
  }
  return sample;
}

/**
 * 自检：所有 prompt 必填/枚举/渲染都通过，且拒绝非法参数（server/测试共用）。
 * 返回 { ok, errors, total, withEnums }。
 */
export function auditPrompts() {
  const errors = [];
  const names = new Set();
  let withEnums = 0;
  for (const prompt of PROMPT_DEFINITIONS) {
    if (!/^[a-z0-9_]+$/.test(prompt.name)) errors.push({ code: 'prompt-name', prompt: prompt.name, message: 'prompt 名必须是 snake_case' });
    if (names.has(prompt.name)) errors.push({ code: 'prompt-name', prompt: prompt.name, message: 'prompt 名重复' });
    names.add(prompt.name);
    const declared = new Set(prompt.arguments.map((argument) => argument.name));
    if (declared.size !== prompt.arguments.length) errors.push({ code: 'prompt-args', prompt: prompt.name, message: '参数名重复' });
    for (const argument of prompt.arguments) {
      if (argument.required !== true && argument.required !== false) {
        errors.push({ code: 'prompt-args', prompt: prompt.name, message: '参数 ' + argument.name + ' 缺少 boolean required' });
      }
      if (argument.enum) {
        withEnums += 1;
        if (!Array.isArray(argument.enum) || argument.enum.length < 2) {
          errors.push({ code: 'prompt-args', prompt: prompt.name, message: '参数 ' + argument.name + ' 的 enum 至少 2 个值' });
        } else if (argument.enum.some((value) => typeof value !== 'string' || !value.trim())) {
          errors.push({ code: 'prompt-args', prompt: prompt.name, message: '参数 ' + argument.name + ' 的 enum 值必须是非空字符串' });
        }
      }
    }
    const sample = sampleArguments(prompt);
    try {
      const rendered = getPrompt(prompt.name, sample);
      const text = rendered.messages[0].content.text;
      const anchor = Object.values(sample)[0] || '';
      if (!rendered.messages.length || !text.includes(anchor)) {
        errors.push({ code: 'prompt-render', prompt: prompt.name, message: '渲染结果未包含参数内容' });
      }
      if (text.length < 200) errors.push({ code: 'prompt-render', prompt: prompt.name, message: '渲染结果过短：' + text.length });
      if (!text.includes('browser_status') && !text.includes('browser_debug_start') && !text.includes('browser_')) {
        errors.push({ code: 'prompt-render', prompt: prompt.name, message: '渲染结果没有提到任何工具' });
      }
    } catch (error) {
      errors.push({ code: 'prompt-render', prompt: prompt.name, message: String((error && error.message) || error) });
    }
    // 非法参数必须被拒绝：缺必填 / 未声明 / 枚举越界。
    if (prompt.arguments.some((argument) => argument.required)) {
      const missing = validatePromptArguments(prompt.name, {});
      if (missing.ok || missing.errors[0].code !== PROMPT_ERRORS.MISSING_ARG) {
        errors.push({ code: 'prompt-validation', prompt: prompt.name, message: '缺必填参数未被拒绝' });
      }
    }
    const unknown = validatePromptArguments(prompt.name, { ...sample, __unknown__: 'x' });
    if (unknown.ok || unknown.errors[0].code !== PROMPT_ERRORS.UNKNOWN_ARG) {
      errors.push({ code: 'prompt-validation', prompt: prompt.name, message: '未声明参数未被拒绝' });
    }
    for (const argument of prompt.arguments.filter((item) => Array.isArray(item.enum))) {
      const invalid = validatePromptArguments(prompt.name, { ...sample, [argument.name]: 'not-a-valid-enum-value' });
      if (invalid.ok || invalid.errors[0].code !== PROMPT_ERRORS.ENUM) {
        errors.push({ code: 'prompt-validation', prompt: prompt.name, message: '枚举参数 ' + argument.name + ' 的非法值未被拒绝' });
      }
    }
  }
  return { ok: errors.length === 0, errors, total: PROMPT_DEFINITIONS.length, withEnums };
}
