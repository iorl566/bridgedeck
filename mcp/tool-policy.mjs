// mcp/tool-policy.mjs —— MCP 92 工具的分级（read / mutate / destructive）、审批策略、
// 超时策略与 MCP tool annotations 的唯一来源。
//
// 为什么需要它：
//   - 模型侧需要知道“这个工具会不会改页面/关窗口/装东西”，MCP 规范用 annotations
//     （readOnlyHint / destructiveHint / idempotentHint / openWorldHint）表达；
//   - 客户端侧需要在真正执行不可逆动作前要一次人工确认，而不是让模型一次性把会话、标签页、
//     全局设置都改掉；
//   - 不同工具的真实耗时相差两个数量级（status 与视频合并），统一 60s 超时要么误杀长任务，
//     要么让卡死工具永远不返回。
//
// 分级口径与 dsh-plugin/lib/tool-metadata.mjs 保持一致（read 允许写本地文件；write/mutate
// 改页面/会话；destructive 可能关闭窗口、执行任意 JS、审批/回放配方、撤销配对、更新安装
// 或改全局设置），但这里按 MCP 的 67 个工具粒度重新落地，并由 auditToolPolicies 审计：
//   - tier 要么等于协议方法 effect 派生值，要么在 TIER_OVERRIDES 里给出理由；
//   - destructive 必须要求审批（除非显式声明 noApproval 理由）；
//   - read 工具不允许映射变异类方法（除非 readOverride 理由）；
//   - annotations 必须与 tier/idempotent 完全一致。

import { METHOD_EFFECT } from '../lib/protocol.mjs';

export const TIERS = Object.freeze({
  read: 'read',
  mutate: 'mutate',
  destructive: 'destructive',
});

/** 审批参数：MCP tools/call 的 params._meta 里携带（不污染工具入参 schema）。 */
export const APPROVAL_META_KEY = 'browser-bridge/approval';
export const APPROVAL_CONFIRMED = 'confirmed';
/** 环境变量退出闸门：CI/自动化可以把审批关掉（默认开启）。 */
export const APPROVAL_ENV = 'BB_MCP_APPROVAL';
/** 审批放行的 retry 建议：不同客户端展示方式不同，统一在错误文本里给出。 */
export const APPROVAL_RETRY = 'after-action';

const READ_EFFECTS = new Set(['passive_read', 'read']);
const MUTATE_EFFECTS = new Set(['transient_input', 'browser_mutation', 'control_plane']);

/** 工具标题（annotations.title）；短、可读、稳定。 */
export const TOOL_TITLES = Object.freeze({
  browser_brief: '页面简报',
  browser_update_state: '更新状态',
  browser_session_start: '开始会话',
  browser_session_stop: '结束会话',
  browser_audit: '操作审计',
  browser_settings: '扩展设置',
  browser_pair: '远程配对',
  browser_install_skill: '安装技能',
  browser_recipe: '配方',
  browser_update: '更新',
  browser_record_start: '开始录制',
  browser_record_stop: '停止录制',
  browser_record_list: '录制列表',
  browser_status: '环境状态',
  browser_plan: '串行计划',
  browser_observe: '观察页面',
  browser_navigate: '导航',
  browser_click: '点击',
  browser_click_backend: '按 backendNodeId 点击',
  browser_fill: '填写',
  browser_read: '读取文本',
  browser_extract: '结构化提取',
  browser_evaluate: '执行脚本',
  browser_screenshot: '截图',
  browser_pdf: '导出 PDF',
  browser_upload: '上传文件',
  browser_download: '下载',
  browser_longshot_recover: '恢复长截图',
  browser_tabs: '标签页列表',
  browser_tab_new: '新建标签页',
  browser_tab_close: '关闭标签页',
  browser_tab_select: '激活标签页',
  browser_tab_move: '移动标签页',
  browser_refs_negotiate: '引用协商',
  browser_trace_start: '开始 trace',
  browser_trace_stop: '停止 trace',
  browser_trace_summary: 'trace 摘要',
  browser_debug_start: '开始调试采集',
  browser_debug_stop: '停止调试采集',
  browser_debug_analyze: '分析调试采集',
  browser_debug_evidence: '证据包',
  browser_debug_journal: '调试时间线',
  browser_debug_query: '查询归档',
  browser_debug_archive: '写调试归档',
  browser_debug_archives: '归档目录',
  browser_debug_har: '导出 HAR',
  browser_debug_har_import: '导入 HAR',
  browser_network_waterfall: '网络瀑布',
  browser_network_replay_har: 'HAR 重放',
  browser_network_list: '网络列表',
  browser_rule_list: '规则列表',
  browser_rule_add: '添加规则',
  browser_rule_clear: '清空规则',
  browser_rule_set: '规则启停',
  browser_video_start: '开始录制视频',
  browser_video_stop: '停止录制视频',
  browser_video_recover: '恢复视频',
  browser_video_status: '视频状态',
  browser_video_list: '视频列表',
  browser_video_trim: '裁剪视频',
  browser_video_info: '视频信息',
  browser_video_split: '视频分段',
  browser_video_merge: '合并视频',
  browser_window: '窗口路由',
  browser_wait_for: '等待元素',
  browser_cooperate_sync: '协作同步',
  browser_dialog: '原生对话框',
  // M6-P0①：兼容目标 MCP 直接动作入口（分级由协议 effect 派生：输入/导航 = mutate，console = read）。
  browser_press: '按键',
  browser_hover: '悬停',
  browser_select: '选择选项',
  browser_drag: '拖拽',
  browser_scroll_to: '滚动到元素',
  browser_wheel: '滚轮',
  browser_focus: '聚焦',
  browser_blur: '失焦',
  browser_reload: '刷新页面',
  browser_back: '历史后退',
  browser_forward: '历史前进',
  browser_console: '控制台日志',
  browser_session_request_prepare: '预登记启动请求',
  browser_session_request_status: '查询启动请求',
  browser_session_request_claim: '认领启动请求',
  browser_session_request_cancel: '取消启动请求',
  browser_tab_borrow: '借用标签页',
  browser_tab_return: '归还标签页',
  // M6-P0②：inspect html / assist（仿真、人工协助、挂起操作）/ session 查询。
  browser_inspect_html: '取原始 HTML',
  browser_assist_emulate: '设备仿真',
  browser_assist_request_help: '请求人工协助',
  browser_assist_operation_await: '等待挂起操作',
  browser_assist_operation_cancel: '取消挂起操作',
  browser_session_browsers: '浏览器实例列表',
  browser_session_list: '会话列表',
});

/**
 * 本地工具（无协议方法映射）的风险分级。
 * browser_recipe/browser_update 落在 destructive：前者可批准并回放会驱动浏览器的配方，
 * 后者会安装/替换本地程序。
 */
export const LOCAL_TOOL_TIERS = Object.freeze({
  browser_update_state: 'read',
  browser_install_skill: 'mutate',
  browser_recipe: 'destructive',
  browser_update: 'destructive',
  browser_debug_analyze: 'read',
  browser_debug_evidence: 'read',
  browser_debug_journal: 'read',
  browser_debug_query: 'read',
  browser_debug_archive: 'read',
  browser_debug_archives: 'read',
  browser_trace_summary: 'read',
  browser_video_trim: 'mutate',
  browser_video_recover: 'mutate',
  browser_video_info: 'read',
  browser_video_split: 'mutate',
  browser_video_merge: 'mutate',
  browser_debug_har: 'read',
  browser_debug_har_import: 'read',
});

/**
 * 协议 effect 派生值 → 目标 tier 的覆盖。
 * 只允许“提高安全等级”（read→mutate/destructive、mutate→destructive），
 * 或对 control_plane 的纯查询工具降为 read；两种都必须写理由。
 */
export const TIER_OVERRIDES = Object.freeze({
  browser_brief: { tier: 'read', reason: '只做 observe + dialog.status 两个只读查询，返回简报文本' },
  browser_status: { tier: 'read', reason: 'daemon 聚合状态查询，无副作用' },
  browser_audit: { tier: 'read', reason: '读取本地审计日志（limit/offset），不改变状态' },
  browser_tabs: { tier: 'read', reason: 'tab.list 是 instance 级只读查询' },
  browser_record_list: { tier: 'read', reason: 'record.list 只读历史' },
  browser_video_status: { tier: 'read', reason: 'video.status 只读当前录制状态' },
  browser_video_list: { tier: 'read', reason: 'video.list 只读已保存录制' },
  browser_session_start: { tier: 'mutate', reason: '创建会话/拉起浏览器窗口，属于常规可恢复变更' },
  browser_tab_new: { tier: 'mutate', reason: '新建标签页是常规可恢复变更' },
  browser_evaluate: { tier: 'destructive', reason: '在页面主世界执行任意 JS，可产生任意副作用' },
  browser_settings: { tier: 'destructive', reason: '修改扩展全局设置，影响后续所有会话' },
  browser_pair: { tier: 'destructive', reason: '创建/撤销远程配对会改变外部设备信任关系' },
  browser_session_stop: { tier: 'destructive', reason: '结束会话可能丢弃未保存的页面状态' },
  browser_tab_close: { tier: 'destructive', reason: '关闭标签页可能丢弃未保存内容' },
  browser_recipe: { tier: 'destructive', reason: 'approve/run 会回放会驱动浏览器的配方' },
  browser_update: { tier: 'destructive', reason: '更新流程会安装/替换本地程序文件' },
  // M6-P0②：browsers/session.list 的协议 effect 是 control_plane（默认档为 mutate），
  // 但两者都是纯查询本地方法（daemon/local-dispatch.js:14-15/34-35 只读快照），降为 read。
  browser_session_browsers: { tier: 'read', reason: 'browsers 是 daemon 的只读实例快照（BrowserList 无参数、无副作用）' },
  browser_session_list: { tier: 'read', reason: 'session.list 是 daemon 的只读会话快照（SessionList 无参数、无副作用）' },
});

/** 显式幂等：默认 read=true、mutate/destructive=false，只列出“可安全重复”的变异工具。 */
export const IDEMPOTENT_TOOLS = Object.freeze([
  'browser_navigate',
  'browser_tab_select',
  'browser_tab_move',
  'browser_window',
  'browser_rule_clear',
  'browser_debug_har',
  'browser_debug_archive',
  'browser_debug_har_import',
  'browser_debug_evidence',
  'browser_video_trim',
  'browser_video_split',
  'browser_video_merge',
]);

/** 纯本地文件工具：不接触浏览器/网络世界。 */
export const CLOSED_WORLD_TOOLS = Object.freeze([
  'browser_update_state',
  'browser_install_skill',
  'browser_trace_summary',
  'browser_debug_analyze',
  'browser_debug_evidence',
  'browser_debug_journal',
  'browser_debug_query',
  'browser_debug_archive',
  'browser_debug_archives',
  'browser_debug_har',
  'browser_debug_har_import',
  'browser_video_trim',
  'browser_video_info',
  'browser_video_split',
  'browser_video_merge',
]);

/** 分档超时（毫秒）：read 短、mutate 中、destructive 长，再叠加单工具覆盖。 */
export const TIER_TIMEOUTS = Object.freeze({
  read: 60_000,
  mutate: 120_000,
  destructive: 300_000,
});

/** 单工具超时覆盖（与工具内部 rpc 超时对齐，外层只做兜底）。 */
export const TOOL_TIMEOUTS = Object.freeze({
  browser_screenshot: 180_000,
  browser_longshot_recover: 180_000,
  browser_plan: 180_000,
  browser_upload: 180_000,
  browser_pdf: 90_000,
  browser_debug_har_import: 120_000,
  browser_video_merge: 600_000,
  browser_video_split: 300_000,
  browser_video_trim: 300_000,
  browser_video_recover: 300_000,
  // M6-P0②：人工协助要等用户操作（扩展窗口默认 180s、上限 600s，见
  // extension/src/tabs-help.js:25-26），wait 预算上限 300s（extension/src/operations.js:39）。
  // 外层 MCP 分档超时必须大于工具内部等待窗口，否则会在正常等待中被误杀。
  browser_assist_request_help: 620_000,
  browser_assist_operation_await: 330_000,
});

/** 审批不可关闭的工具：即使 BB_MCP_APPROVAL=off 也要确认。 */
export const APPROVAL_ALWAYS = Object.freeze(['browser_update']);

/** 协议 effect → tier 的默认派生（不修改目录，只读推导）。 */
export function deriveTier(tool) {
  const methods = (tool && tool.methods) || [];
  const effects = methods.map((method) => METHOD_EFFECT[method]).filter(Boolean);
  const local = LOCAL_TOOL_TIERS[tool && tool.name];
  if (methods.length === 0) return local || null;
  if (effects.length && effects.every((effect) => READ_EFFECTS.has(effect))) return TIERS.read;
  if (effects.some((effect) => MUTATE_EFFECTS.has(effect))) return TIERS.mutate;
  return local || null;
}

/**
 * 单工具策略：tier / approval / timeout / annotations。
 * 需要工具对象来派生协议 effect 分级；只按名字调用时依赖 TIER_OVERRIDES/LOCAL_TOOL_TIERS。
 * 未知工具返回 null（审计/启动会报缺失）。
 */
export function policyFor(name, tool = null) {
  const title = TOOL_TITLES[name];
  if (!title) return null;
  const override = TIER_OVERRIDES[name] || null;
  const derived = tool ? deriveTier(tool) : null;
  const tier = (override && override.tier) || LOCAL_TOOL_TIERS[name] || derived || null;
  if (!tier) return null;
  if (!Object.values(TIERS).includes(tier)) return null;
  const timeoutMs = TOOL_TIMEOUTS[name] || TIER_TIMEOUTS[tier];
  const readOnly = tier === TIERS.read;
  const destructive = tier === TIERS.destructive;
  const approvalRequired = destructive || APPROVAL_ALWAYS.includes(name);
  const overrideReason = override && typeof override.reason === 'string' ? override.reason : null;
  return Object.freeze({
    name,
    title,
    tier,
    readOnly,
    destructive,
    idempotent: readOnly || IDEMPOTENT_TOOLS.includes(name),
    openWorld: !CLOSED_WORLD_TOOLS.includes(name),
    timeoutMs,
    approvalRequired,
    approvalAlways: APPROVAL_ALWAYS.includes(name),
    tierReason: overrideReason || (LOCAL_TOOL_TIERS[name] ? '本地工具分级（LOCAL_TOOL_TIERS）' : '协议方法 effect 派生'),
    approvalReason: approvalRequired
      ? (APPROVAL_ALWAYS.includes(name)
        ? '该工具会替换/安装本地程序，必须人工确认'
        : 'destructive 工具：可能关闭窗口、执行任意 JS、改全局设置或撤销配对')
      : null,
  });
}

/** MCP tools/list 的 annotations 结构。 */
export function annotationsFor(name, tool = null) {
  const policy = policyFor(name, tool);
  if (!policy) throw new Error('未知 MCP 工具策略：' + name);
  return Object.freeze({
    title: policy.title,
    readOnlyHint: policy.readOnly,
    destructiveHint: policy.destructive,
    idempotentHint: policy.idempotent,
    openWorldHint: policy.openWorld,
  });
}

/** 审批是否在此环境被关闭。 */
export function approvalDisabled(env = process.env) {
  const value = String((env && env[APPROVAL_ENV]) || '').toLowerCase();
  return value === 'off' || value === '0' || value === 'false' || value === 'disabled';
}

/**
 * 审批是否被显式开启（默认关闭，保持既有本地 MCP 自动化行为）。
 * 只有 BB_MCP_APPROVAL=on/required/strict/1/true 时才强制 destructive 工具审批；
 * 无论该开关如何，APPROVAL_ALWAYS（如 browser_update）都必须确认。
 */
export function approvalEnforced(env = process.env) {
  const value = String((env && env[APPROVAL_ENV]) || '').toLowerCase();
  return value === 'on' || value === 'required' || value === 'strict' || value === '1' || value === 'true' || value === 'enabled';
}

/** 调用方是否已在 _meta 里确认。 */
export function approvalConfirmed(params, env = process.env) {
  const meta = params && params._meta;
  if (!meta || typeof meta !== 'object') return false;
  const value = meta[APPROVAL_META_KEY];
  return value === APPROVAL_CONFIRMED || value === true;
}

/**
 * 审批闸门：需要审批且未确认时返回错误负载；否则返回 null。
 * 返回结构直接映射到 tools/call 的 result（isError=true + 可读下一步 + _meta 标记），
 * 不抛异常，保证 MCP 客户端按协议拿到结构化提示而不是 JSON-RPC error。
 *
 * `policy` 可选：调用方已经持有策略对象时直接传入，避免为了取策略再派生一次
 * （审计/测试路径没有完整 tool 定义也能复用同一份拦截逻辑与文本）。
 */
export function approvalGate(name, params, { tool = null, env = process.env, policy: providedPolicy = null } = {}) {
  const policy = providedPolicy || policyFor(name, tool);
  if (!policy) throw new Error('未知 MCP 工具策略：' + name);
  if (!policy.approvalRequired) return null;
  if (approvalConfirmed(params, env)) return null;
  // 默认不强制审批（保持既有本地自动化）；显式开启或“恒审批”工具才拦截。
  if (!policy.approvalAlways && !approvalEnforced(env)) return null;
  const how = '在 tools/call 的 params._meta 里传 "' + APPROVAL_META_KEY + '": "' + APPROVAL_CONFIRMED + '" 后重试';
  return Object.freeze({
    isError: true,
    content: Object.freeze([
      Object.freeze({
        type: 'text',
        text: 'E_HUMAN_GATE: ' + policy.title + '（' + name + '）属于 ' + policy.tier + ' 级工具，需要人工确认。' + how + '。' + (policy.approvalReason || ''),
      }),
    ]),
    _meta: Object.freeze({
      'browser-bridge/approval': Object.freeze({ required: true, tool: name, tier: policy.tier }),
      'browser-bridge/retry': APPROVAL_RETRY,
    }),
  });
}

/**
 * 策略硬审计：server 启动时调用。
 * 返回 { ok, errors, stats }；错误 code 供测试断言。
 */
export function auditToolPolicies(tools) {
  const errors = [];
  const push = (code, tool, message) => errors.push(Object.freeze({ code, tool, message }));
  if (!Array.isArray(tools)) throw new Error('auditToolPolicies 需要工具数组');
  const names = new Set();
  const stats = { tools: 0, read: 0, mutate: 0, destructive: 0, approvals: 0, timeouts: 0 };
  for (const tool of tools) {
    const name = tool && tool.name;
    if (!name) { push('policy-shape', '<unnamed>', '工具缺少 name'); continue; }
    if (names.has(name)) push('policy-shape', name, '工具名重复');
    names.add(name);
    const policy = policyFor(name, tool);
    if (!policy) { push('policy-missing', name, '缺少工具策略（TOOL_TITLES/tier 未登记）'); continue; }
    stats.tools += 1;
    stats[policy.tier] += 1;
    if (policy.approvalRequired) stats.approvals += 1;
    if (!(policy.timeoutMs >= 1_000 && policy.timeoutMs <= 900_000)) push('policy-timeout', name, 'timeoutMs 超出 [1000, 900000]：' + policy.timeoutMs);
    stats.timeouts += policy.timeoutMs;
    const derived = deriveTier(tool);
    if (derived && derived !== policy.tier) {
      const override = TIER_OVERRIDES[name];
      if (!override || override.tier !== policy.tier || typeof override.reason !== 'string' || override.reason.trim().length < 8) {
        push('policy-tier', name, 'tier=' + policy.tier + ' 与协议 effect 派生值 ' + derived + ' 不一致，且没有带理由的 TIER_OVERRIDES');
      }
    }
    if (!derived && !TIER_OVERRIDES[name] && !LOCAL_TOOL_TIERS[name]) {
      push('policy-tier', name, '无法从方法映射派生 tier，也没有显式分级');
    }
    if (policy.tier === TIERS.read) {
      // control_plane 里也有纯查询方法（status/tab.list/audit.list），只要 override 写了理由
      // 就可以降为 read；但 browser_mutation / transient_input 绝不允许出现在 read 工具里。
      const mutating = (tool.methods || []).filter((method) => ['browser_mutation', 'transient_input'].includes(METHOD_EFFECT[method]));
      if (mutating.length) push('policy-read', name, 'read 工具映射了变异方法：' + mutating.join(', '));
      if (!policy.idempotent) push('policy-annotation', name, 'read 工具必须幂等');
    }
    if (policy.destructive !== (policy.tier === TIERS.destructive)) push('policy-annotation', name, 'destructiveHint 与 tier 不一致');
    if (policy.readOnly !== (policy.tier === TIERS.read)) push('policy-annotation', name, 'readOnlyHint 与 tier 不一致');
    if (policy.destructive && !policy.approvalRequired) push('policy-approval', name, 'destructive 工具必须要求审批');
    const annotations = annotationsFor(name, tool);
    if (annotations.title !== policy.title || annotations.readOnlyHint !== policy.readOnly
      || annotations.destructiveHint !== policy.destructive || annotations.idempotentHint !== policy.idempotent
      || annotations.openWorldHint !== policy.openWorld) {
      push('policy-annotation', name, 'annotations 与策略不一致');
    }
  }
  for (const name of Object.keys(TOOL_TITLES)) {
    if (!names.has(name)) push('policy-orphan', name, '策略声明了不存在的工具');
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), stats: Object.freeze(stats) });
}

/** strict 包装：策略缺失/漂移时 server 启动即失败。 */
export function assertToolPolicies(tools) {
  const report = auditToolPolicies(tools);
  if (!report.ok) {
    const detail = report.errors.map((error) => '  - [' + error.code + '] ' + error.tool + ': ' + error.message).join('\n');
    const error = new Error('MCP 工具策略审计失败（' + report.errors.length + ' 项）：\n' + detail);
    error.code = 'E_CONFIG_INVALID';
    error.report = report;
    throw error;
  }
  return report;
}

/** 策略快照：tools/list 的 _meta 与文档共用（纯派生，便于客户端展示分档统计）。 */
export function policySnapshot(tools) {
  const rows = tools.map((tool) => {
    const policy = policyFor(tool.name, tool);
    return {
      name: tool.name,
      tier: policy.tier,
      timeoutMs: policy.timeoutMs,
      approval: policy.approvalRequired,
      idempotent: policy.idempotent,
      openWorld: policy.openWorld,
      methods: [...(tool.methods || [])],
    };
  });
  return {
    total: rows.length,
    byTier: {
      read: rows.filter((row) => row.tier === 'read').length,
      mutate: rows.filter((row) => row.tier === 'mutate').length,
      destructive: rows.filter((row) => row.tier === 'destructive').length,
    },
    approvals: rows.filter((row) => row.approval).map((row) => row.name),
    tools: rows,
  };
}
