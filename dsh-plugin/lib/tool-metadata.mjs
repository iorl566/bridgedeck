// dsh-plugin/lib/tool-metadata.mjs —— 37 个 browser_* 工具的行为元数据（单一真源）。
//
// 目的：模型与工具索引文档需要知道“这个工具属于哪类、会不会改页面、能不能安全重试、
// 失败后下一步做什么”，而不是只有一段自然语言描述。MCP 侧的同类信息是 tool annotations
// （readOnlyHint/destructiveHint/idempotentHint/openWorldHint）；这里把同一套语义在插件侧
// 显式化，并额外带上 category / sideEffects / recovery / docs，由 buildToolSpecs 合并进
// 每个 spec（模型可在工具描述外直接看到 annotations，TOOLS.md 由生成器输出）。
//
// 约束：
//   - 工具名必须与 lib/tools.mjs 的 TOOL_METHODS 一一对应；缺元数据或多元数据都让构建失败；
//   - risk 是“对用户环境的影响”，不是“实现难度”：
//       read         只读（不发动作；可能写本地文件，如截图/证据）
//       write        会改页面/浏览器/会话状态，但属于常规可恢复操作
//       destructive  可能关闭窗口、执行任意 JS、审批/回放配方、撤销配对、更新安装或改全局设置
//   - idempotent 指“同样的参数重复调用是否等价于一次”，不表示“可以随便重试”：
//       observe/read 幂等；click/fill/plan 不幂等；tab_close 重放会报 E_NO_TAB。
//   - recovery 是模型可读的一到两句“失败后下一步”，精确到工具/参数级；错误码级映射见
//     lib/error-recovery.mjs（两者互补：这里写工具语义，那里写错误码语义）。
//   - docs 指向技能 references 中的按需阅读材料（生成到 dsh-plugin/skill/references/）。

/** 影响面枚举：出现在 spec.sideEffects 里，供文档/审计消费。 */
export const SIDE_EFFECTS = Object.freeze({
  page: '修改页面 DOM/表单/滚动位置',
  browser: '创建/关闭/聚焦标签页或窗口，或挂调试器',
  session: '创建/结束会话、改变控制权或账本状态',
  filesystem: '写本地文件（截图/导出/录制/技能目录）',
  settings: '修改扩展或 daemon 配置',
  network: '发起外部网络请求（更新清单/远程配对）',
  external: '改变外部设备/远端配对关系',
});

/** 风险等级：spread 顺序即文档中的排序。 */
export const RISK_LEVELS = Object.freeze(['read', 'write', 'destructive']);

/**
 * 工具分类：label 用于文档标题，reference 是该类工具的默认按需阅读材料。
 * 分类是“任务阶段”而不是“协议命名空间”，便于模型先按阶段找工具（会话→观察→动作→证据）。
 */
export const CATEGORIES = Object.freeze({
  environment: { label: '环境与会话状态', reference: 'references/environment.md' },
  session: { label: '会话生命周期', reference: 'references/transactions.md' },
  navigation: { label: '导航', reference: 'references/actions-guide.md' },
  observe: { label: '观察与页面简报', reference: 'references/actions-guide.md' },
  action: { label: '页面动作与脚本', reference: 'references/actions-guide.md' },
  read: { label: '数据读取与导出', reference: 'references/extraction.md' },
  capture: { label: '截图与证据', reference: 'references/screenshots-and-canvas.md' },
  network: { label: '网络采集', reference: 'references/debugging.md' },
  debug: { label: '网站调试', reference: 'references/debugging.md' },
  media: { label: '视频录制', reference: 'references/video.md' },
  record: { label: '操作录制', reference: 'references/interaction-details.md' },
  cooperate: { label: '协作与共享控制', reference: 'references/cooperation.md' },
  workflow: { label: '计划与配方', reference: 'references/transactions.md' },
  ledger: { label: '意图账本', reference: 'references/transactions.md' },
  pairing: { label: '远程配对', reference: 'references/environment.md' },
  tabs: { label: '标签页管理', reference: 'references/tabs-and-profiles.md' },
  window: { label: '窗口路由', reference: 'references/tabs-and-profiles.md' },
  audit: { label: '审计记录', reference: 'references/audit.md' },
  skill: { label: '技能安装', reference: 'references/environment.md' },
  system: { label: '设置与更新', reference: 'references/environment.md' },
});

// 说明：docs 是“失败后该读哪篇”，不是工具能力清单；每条的 recovery 必须能直接指导下一步。
export const TOOL_METADATA = Object.freeze({
  browser_status: {
    title: '环境状态',
    category: 'environment',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: '先确认 daemon 与浏览器实例：daemon 未运行按 environment 参考启动；没有 browsers 时请用户在扩展里连接浏览器。',
    docs: ['references/environment.md'],
  },
  browser_session_start: {
    title: '开始会话',
    category: 'session',
    risk: 'write',
    idempotent: false,
    sideEffects: ['session', 'browser'],
    recovery: 'E_DAEMON 见 environment；E_NO_BROWSER/E_BROWSER_AMBIGUOUS 先用 browser_status 选实例；新窗口启动已带 request-id，超时可原样重试（插件会取回同一会话）。',
    docs: ['references/transactions.md', 'references/environment.md'],
  },
  browser_session_stop: {
    title: '结束会话',
    category: 'session',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['session', 'browser'],
    recovery: 'E_NO_SESSION 说明会话已结束，不要对别的会话重复 stop；借用的用户标签页会归还并保持打开。',
    docs: ['references/transactions.md'],
  },
  browser_navigate: {
    title: '导航',
    category: 'navigation',
    risk: 'write',
    idempotent: true,
    sideEffects: ['page', 'network'],
    recovery: 'E_NAV_FAIL 先确认 URL 可达与域名策略；E_NO_SESSION 先 browser_session_start；导航后旧 @eN 全部失效，必须重新 observe。',
    docs: ['references/actions-guide.md'],
  },
  browser_observe: {
    title: '观察页面',
    category: 'observe',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'E_TIMEOUT 先用 vom:false 缩小范围；失败时用 browser_status 确认会话与标签页还在，再重新 observe。',
    docs: ['references/actions-guide.md', 'references/interaction-details.md'],
  },
  browser_act: {
    title: '页面动作',
    category: 'action',
    risk: 'write',
    idempotent: false,
    sideEffects: ['page'],
    recovery: 'E_STALE_REF 重新 observe 取新 ref；E_NOT_FOUND/E_NOT_ACTIONABLE 换目标或等可见/启用；E_DIALOG_PENDING 先用 browser_dialog arm。动作不要盲目重试（可能是提交）。',
    docs: ['references/actions-guide.md'],
  },
  browser_click_backend: {
    title: '按 backendNodeId 点击',
    category: 'action',
    risk: 'write',
    idempotent: false,
    sideEffects: ['page'],
    recovery: 'backendNodeId 来自 observe 的 vom/ax 结果；找不到就先重新 observe --ax --vom；点击没有二次确认，失败不要连续补点。',
    docs: ['references/actions-guide.md'],
  },
  browser_read: {
    title: '读取页面数据',
    category: 'read',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'E_NOT_FOUND 先重新 observe；E_TOO_LARGE 用 maxRows 或缩小 selector；要整页结构化数据优先 extract 而不是 html。',
    docs: ['references/extraction.md'],
  },
  browser_screenshot: {
    title: '截图',
    category: 'capture',
    risk: 'read',
    idempotent: true,
    sideEffects: ['filesystem'],
    recovery: 'E_SCREENSHOT/E_TIMEOUT 时缩小范围（selector 或 region）；out 目录需可写；页面已关闭先重新开 tab 再截图。',
    docs: ['references/screenshots-and-canvas.md'],
  },
  browser_eval: {
    title: '执行页面 JS',
    category: 'action',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['page'],
    recovery: 'E_JS_ERROR 检查表达式与页面上下文；不要用它读 cookie/密码；常规操作优先 act/read，失败不要重复执行有副作用的表达式。',
    docs: ['references/interaction-details.md', 'references/actions-guide.md'],
  },
  browser_network: {
    title: '网络采集',
    category: 'network',
    risk: 'write',
    idempotent: false,
    sideEffects: ['browser'],
    recovery: 'bodies:true 会挂 chrome.debugger；E_DEBUGGER_BUSY 先停其它会话的调试；detail 的 id 来自 list，过期就重新 list。',
    docs: ['references/debugging.md'],
  },
  browser_dialog: {
    title: '原生弹窗',
    category: 'action',
    risk: 'write',
    idempotent: true,
    sideEffects: ['page'],
    recovery: 'E_DIALOG_PENDING 说明动作被弹窗挡住：先 arm 策略，再重新执行原动作（不要重复原来的动作）；处理完 disarm。',
    docs: ['references/native-dialogs.md'],
  },
  browser_tab_borrow: {
    title: '借用用户标签页',
    category: 'tabs',
    risk: 'write',
    idempotent: false,
    sideEffects: ['browser', 'session'],
    recovery: 'E_BORROW_DENIED 是用户拒绝，不要绕过；E_BORROW_CONFLICT 等当前借用结束或改开独立 Agent 窗口；确认条可能需要用户点确认。',
    docs: ['references/tabs-and-profiles.md'],
  },
  browser_debug: {
    title: '网站调试',
    category: 'debug',
    risk: 'write',
    idempotent: false,
    sideEffects: ['browser', 'filesystem'],
    recovery: 'start 前先 navigate 到目标页；bodies:true 会挂调试器；export/evidence/archive 需要 out 可写；E_DEBUGGER_BUSY 先 stop 其它采集。',
    docs: ['references/debugging.md'],
  },
  browser_video: {
    title: '视频录制',
    category: 'media',
    risk: 'write',
    idempotent: false,
    sideEffects: ['filesystem', 'browser'],
    recovery: 'start 后必须 stop/save 才落盘；中断后用 recover 找回；磁盘不足先 list 再 prune；recordingId 来自 start 返回值。',
    docs: ['references/video.md'],
  },
  browser_record: {
    title: '操作录制',
    category: 'record',
    risk: 'write',
    idempotent: false,
    sideEffects: ['filesystem', 'session'],
    recovery: 'export 需要 out 目录；start 后先 list 确认在录制；录制期间避免其它会话对同一 tab 做动作导致步骤混杂。',
    docs: ['references/interaction-details.md'],
  },
  browser_cooperate: {
    title: '协作控制',
    category: 'cooperate',
    risk: 'write',
    idempotent: false,
    sideEffects: ['session'],
    recovery: 'E_CONTROL_NOT_HELD/E_CONTROL_BUSY 等租约或请持有者 handback；导航/人工介入后 context 会失效，必须重新 sync。',
    docs: ['references/cooperation.md'],
  },
  browser_plan: {
    title: '多步计划',
    category: 'workflow',
    risk: 'write',
    idempotent: false,
    sideEffects: ['page'],
    recovery: '首个失败即停且不再重放已完成步骤：重新 observe 后重建剩余 steps；不确定的步骤先单独 act 验证再并入 plan。',
    docs: ['references/step-and-cache.md', 'references/transactions.md'],
  },
  browser_recipe: {
    title: '流程配方',
    category: 'workflow',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['page', 'filesystem'],
    recovery: 'approve 必须 confirmHuman=true；E_RECIPE_NOT_APPROVED 先审批；E_RECIPE_LOCKED 等另一个回放结束；rm 不可恢复。',
    docs: ['references/recipes.md', 'references/audit.md'],
  },
  browser_ledger: {
    title: '意图账本',
    category: 'ledger',
    risk: 'write',
    idempotent: false,
    sideEffects: ['session'],
    recovery: 'E_LEDGER_PENDING 时先 status 查 pending 记录，确认页面实际状态后再 resolve done|abandoned；不要为了解除阻挡盲目 abandoned。',
    docs: ['references/transactions.md'],
  },
  browser_pair: {
    title: '远程配对',
    category: 'pairing',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['external'],
    recovery: 'create 返回的配对码与 wss 地址只交给用户，不要写进日志/网页；revoke 会断开已配对客户端；E_PAIR_* 让用户在目标浏览器重新配对。',
    docs: ['references/environment.md'],
  },
  browser_update: {
    title: '更新',
    category: 'system',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['filesystem', 'network'],
    recovery: 'fetch 需要 https source 与签名 key；auto 会改后台检查设置；失败先看 state/check 输出，不要手改 dist 或版本号。',
    docs: ['references/environment.md'],
  },
  browser_settings: {
    title: '扩展设置',
    category: 'system',
    risk: 'write',
    idempotent: true,
    sideEffects: ['settings'],
    recovery: '先用 action:get 读现值再 set；daemonUrl 传空字符串恢复本地；改 borrowConfirm/allowHelp 会影响用户可见行为，先征得同意。',
    docs: ['references/environment.md'],
  },
  browser_install_skill: {
    title: '安装技能',
    category: 'skill',
    risk: 'write',
    idempotent: true,
    sideEffects: ['filesystem'],
    recovery: 'force 会覆盖目标目录；失败检查目标目录是否可写与 target/dir 是否合法；DSH 内通常不需要安装（插件已内嵌技能）。',
    docs: ['references/environment.md'],
  },
  browser_brief: {
    title: '页面简报',
    category: 'observe',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'E_NO_SESSION 先 browser_session_start；简报是带建议的快照，真正动作前仍需 observe 拿 @eN。',
    docs: ['references/actions-guide.md'],
  },
  browser_tab: {
    title: '标签页操作',
    category: 'tabs',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['browser'],
    recovery: 'close 不可恢复且会清理租约；move 需要 windowId；list 用 tab_new/tab_close 的便捷工具等价但参数更窄，按任务选一个即可。',
    docs: ['references/tabs-and-profiles.md'],
  },
  browser_audit: {
    title: '审计记录',
    category: 'audit',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'limit/offset 分页读；空结果是正常的（无记录）；需要审批链路证据时配合 recipe approve 使用。',
    docs: ['references/audit.md'],
  },
  browser_tab_new: {
    title: '新建标签页',
    category: 'tabs',
    risk: 'write',
    idempotent: false,
    sideEffects: ['browser'],
    recovery: 'E_NO_BROWSER 让用户确认扩展连接；noFocus:true 后台打开避免抢用户焦点；新 tab 需要 session 关联后才能动作。',
    docs: ['references/tabs-and-profiles.md'],
  },
  browser_tab_close: {
    title: '关闭标签页',
    category: 'tabs',
    risk: 'destructive',
    idempotent: false,
    sideEffects: ['browser'],
    recovery: 'E_NO_TAB 说明 tab 已关闭（不要再补关）；只关自己创建/借用的 tab，用户标签页优先 session stop 归还。',
    docs: ['references/tabs-and-profiles.md'],
  },
  browser_tab_select: {
    title: '激活标签页',
    category: 'tabs',
    risk: 'write',
    idempotent: true,
    sideEffects: ['browser'],
    recovery: 'E_NO_TAB 先 browser_tab action:list 取现有 tabId；会改变前台标签，注意不要打断用户手头工作。',
    docs: ['references/tabs-and-profiles.md'],
  },
  browser_network_list: {
    title: '网络列表',
    category: 'network',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: '先 browser_network action:start 再 list；filter 是 URL 子串；空列表说明还没采集或没有匹配。',
    docs: ['references/debugging.md'],
  },
  browser_rule_list: {
    title: '规则列表',
    category: 'debug',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: '没有规则是正常状态；规则增删用 browser_debug 的 rule_enable/rule_disable/rule_remove。',
    docs: ['references/debugging.md'],
  },
  browser_video_status: {
    title: '视频状态',
    category: 'media',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'interrupted 表示上次录制异常中断，用 browser_video action:recover 恢复；正常结束时没有 interrupted。',
    docs: ['references/video.md'],
  },
  browser_video_list: {
    title: '视频列表',
    category: 'media',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: '列表含字节数与过期时间；容量紧张时用 browser_video action:prune 清理过期条目。',
    docs: ['references/video.md'],
  },
  browser_debug_evidence: {
    title: '调试证据包',
    category: 'debug',
    risk: 'write',
    idempotent: true,
    sideEffects: ['filesystem'],
    recovery: '先 debug start 采集再生成证据；输出含 SHA256 完整性摘要；指定 out 时目录需可写。',
    docs: ['references/debugging.md'],
  },
  browser_debug_query: {
    title: '离线查询归档',
    category: 'debug',
    risk: 'read',
    idempotent: true,
    sideEffects: [],
    recovery: 'file 必须是 debug export 生成的 JSON；filter 是 URL 子串；文件损坏会报 JSON 错误，改用 evidence 重新导出。',
    docs: ['references/debugging.md'],
  },
  browser_window: {
    title: '窗口路由',
    category: 'window',
    risk: 'write',
    idempotent: false,
    sideEffects: ['browser'],
    recovery: 'focus 需要 windowId（先用 action:list 取）；ensure 会复用或创建 Agent 窗口，失败先 session start 建会话。',
    docs: ['references/tabs-and-profiles.md'],
  },
});

function fail(name, message) {
  throw new Error('工具元数据不合法（' + name + '）：' + message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把元数据合并进一个工具 spec（就地修改并返回 spec）。
 * 缺元数据直接抛错：宁可插件启动失败，也不要静默发布没有风险/恢复信息的工具。
 */
export function applyToolMetadata(spec) {
  if (!spec || typeof spec.name !== 'string') throw new Error('applyToolMetadata 需要带 name 的 spec');
  const meta = TOOL_METADATA[spec.name];
  if (!meta) fail(spec.name, '未在 TOOL_METADATA 中登记');
  if (!isPlainObject(meta)) fail(spec.name, '元数据必须是对象');

  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  if (!title) fail(spec.name, '缺少 title');
  const category = meta.category;
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) fail(spec.name, '未知 category：' + category);
  if (!RISK_LEVELS.includes(meta.risk)) fail(spec.name, 'risk 必须是 ' + RISK_LEVELS.join('|') + '：' + meta.risk);
  if (typeof meta.idempotent !== 'boolean') fail(spec.name, 'idempotent 必须是布尔值');
  if (!Array.isArray(meta.sideEffects)) fail(spec.name, 'sideEffects 必须是数组');
  for (const effect of meta.sideEffects) {
    if (!Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, effect)) fail(spec.name, '未知 sideEffect：' + effect);
  }
  const recovery = typeof meta.recovery === 'string' ? meta.recovery.trim() : '';
  if (recovery.length < 12) fail(spec.name, 'recovery 需要可执行的下一步（至少 12 字）');
  const docs = Array.isArray(meta.docs) && meta.docs.length
    ? meta.docs.slice()
    : [CATEGORIES[category].reference];
  for (const doc of docs) {
    if (typeof doc !== 'string' || !doc.startsWith('references/') || !doc.endsWith('.md')) {
      fail(spec.name, 'docs 必须是 references/*.md：' + doc);
    }
  }

  // 只读工具不允许有会改页面/浏览器/会话的副作用；破坏性工具必须显式标记。
  if (meta.risk === 'read') {
    for (const forbidden of ['page', 'browser', 'session', 'settings', 'external']) {
      if (meta.sideEffects.includes(forbidden)) fail(spec.name, 'read 风险不允许 sideEffect=' + forbidden);
    }
    if (meta.idempotent !== true) fail(spec.name, 'read 工具必须幂等');
  }
  if (meta.risk === 'destructive' && !meta.sideEffects.length) {
    fail(spec.name, 'destructive 工具必须声明至少一个 sideEffect');
  }

  spec.title = title;
  spec.category = category;
  spec.categoryLabel = CATEGORIES[category].label;
  spec.risk = meta.risk;
  spec.idempotent = meta.idempotent;
  spec.sideEffects = meta.sideEffects.slice();
  spec.recovery = recovery;
  spec.docs = docs;
  spec.annotations = Object.freeze({
    title,
    readOnlyHint: meta.risk === 'read',
    destructiveHint: meta.risk === 'destructive',
    idempotentHint: meta.idempotent,
    openWorldHint: true,
  });
  return spec;
}

/** 工具名集合自检：元数据表与工具表必须一一对应（测试与生成器共用）。 */
export function validateMetadataCoverage(toolNames) {
  const names = (toolNames || []).slice().sort();
  const metadataNames = Object.keys(TOOL_METADATA).sort();
  const missing = names.filter((name) => !metadataNames.includes(name));
  const extra = metadataNames.filter((name) => !names.includes(name));
  if (missing.length) throw new Error('这些工具缺少元数据：' + missing.join(', '));
  if (extra.length) throw new Error('元数据里有多余工具：' + extra.join(', '));
  return { count: names.length };
}

/** 按 category 分组，保持 CATEGORIES 声明顺序（文档生成器用）。 */
export function groupByCategory(specs) {
  const groups = new Map();
  for (const category of Object.keys(CATEGORIES)) groups.set(category, []);
  for (const spec of specs || []) {
    if (!groups.has(spec.category)) groups.set(spec.category, []);
    groups.get(spec.category).push(spec);
  }
  return groups;
}

/** 风险/幂等/副作用统计（TOOLS.md 摘要与测试断言共用）。 */
export function summarizeMetadata(specs) {
  const summary = {
    total: 0,
    risks: { read: 0, write: 0, destructive: 0 },
    idempotent: 0,
    withRecovery: 0,
    byCategory: {},
    sideEffects: {},
  };
  for (const spec of specs || []) {
    summary.total += 1;
    summary.risks[spec.risk] += 1;
    if (spec.idempotent === true) summary.idempotent += 1;
    if (typeof spec.recovery === 'string' && spec.recovery.length >= 12) summary.withRecovery += 1;
    summary.byCategory[spec.category] = (summary.byCategory[spec.category] || 0) + 1;
    for (const effect of spec.sideEffects || []) summary.sideEffects[effect] = (summary.sideEffects[effect] || 0) + 1;
  }
  return summary;
}
