// lib/error-codes.mjs —— 全链路错误码的唯一真源（daemon + 扩展）。
// 扩展是独立打包的 MV3 产物，运行时不能 import 本文件；由单测保证
// extension/src/errors.js 的 KNOWN_CODES 是这份清单的子集，防止两边漂移。

/** code -> 一句话含义。新增错误码必须同时出现在这里和 PROTOCOL.md。 */
export const ERROR_CODES = {
  // —— 参数与目标 ——
  E_BAD_ARG: '参数缺失/冲突（如 ref 与 selector 同时给）',
  E_NOT_FOUND: 'ref/selector 找不到元素',
  E_NOT_ACTIONABLE: '目标存在但不可操作（不可见 / 禁用 / 尺寸为 0）',
  E_STALE_REF: 'ref 指向的元素已不在文档里，需重新 observe',
  E_OPTION_NOT_FOUND: 'select 的目标选项不存在',
  E_OPTION_AMBIGUOUS: 'select 的选项文本匹配到多个',
  E_UNKNOWN_METHOD: '未知 method',

  // —— 会话与并发 ——
  E_NO_SESSION: '没有活动会话',
  E_SESSION_BUSY: '同一会话已有进行中的操作',
  E_SESSION_PAUSED: '会话已被人工接管（暂停）',
  E_SESSION_STOPPED: '会话已结束',
  E_QUEUE_FULL: 'daemon 队列已满',
  E_RATE_LIMITED: '请求过于频繁',
  E_CANCELLED: '操作被取消',
  E_REQUEST_CANCELLED: '请求在排队阶段被取消',
  E_INPUT_BUSY: '输入通道被占用',
  E_NO_TAB: 'tabId 不存在（tab 被关闭）',
  E_NO_BROWSER: '没有可用的浏览器实例',
  E_BROWSER_AMBIGUOUS: '浏览器选择器匹配到多个实例或同名名称',
  E_START_PENDING: '会话启动中，操作尚未就绪',
  E_START_NOT_READY: '会话尚未就绪，稍后重试',

  // —— 观测与上下文 ——
  E_OBSERVATION_STALE: '观测结果已过期，需重新 observe',
  E_CURSOR_STALE: '分页游标已过期',
  E_CONTEXT_REQUIRED: '该动作要求先提供上下文',
  E_CONTEXT_STALE: '上下文与当前页面不一致（或已被重新 sync 吊销）',
  E_COOPERATION_STALE: '协作输入层 authority 已失效且无法重新对齐',
  E_CONTROL_CONTEXT_INVALID: '控制面 context_id 缺失/过期/与当前文档或帧不匹配',
  E_UNSUPPORTED_FEATURE: '对端扩展不支持所要求的 feature（协商未回执或版本过旧）',
  E_DEPENDS_FAILED: '前置依赖步骤未成功',
  E_EXPECT_FAILED: 'expect 断言不匹配',
  E_OBSERVATION_CHANGED: '页面在观测后已变化（观测代数不符）',
  E_TARGET_DETACHED: '观测时的目标节点已从文档中移除（节点级校验）',

  // —— 协作租约与 capture 抑制 ——
  E_TOKEN_BAD_ARG: 'passthrough 令牌参数非法（缺 token 或 grantee）',
  E_TOKEN_UNKNOWN: 'passthrough 令牌不存在或已被清理',
  E_TOKEN_EXPIRED: 'passthrough 令牌已过期',
  E_TOKEN_USED: 'passthrough 令牌已被消费（一次性）',
  E_TOKEN_GRANTEE: 'passthrough 令牌与调用方 grantee 不匹配',
  E_TOKEN_CAPACITY: 'passthrough 令牌存储已满且无法驱逐',
  E_CAPTURE_BAD_TAB: 'capture 抑制引用的 tabId 非法',
  E_CAPTURE_LIMIT: '同一 tab 的 capture 抑制引用超过上限',

  // —— 会话状态机 / 意图账本 WAL / tab 租约 ——
  E_SESSION_STATE: '会话状态不允许该操作（状态机拒绝）',
  E_SESSION_TRANSITION: '会话状态迁移非法',
  E_LEDGER_IO: '意图账本读写失败',
  E_LEDGER_WAL_IO: '意图账本 WAL 写入失败',
  E_LEDGER_FSYNC: '意图账本持久化（fsync）失败',
  E_LEDGER_RECOVER: '意图账本崩溃恢复失败',
  E_LEDGER_CONFLICT: '账本结论冲突（重复 resolve 且结论不一致）',
  E_LEDGER_RESOLVE_REQUIRED: '非幂等动作的 UNKNOWN 必须显式 resolve(confirmed|not-applied)',
  E_TAB_LEASE_HELD: 'tab 已被其它会话租用',
  E_TAB_LEASE_NOT_HELD: 'tab 租约不存在或已被释放',

  // —— MCP 快照持久化 ——
  E_SNAPSHOT_DISABLED: 'MCP 快照持久化被关闭（BB_MCP_SNAPSHOT=off）',
  E_SNAPSHOT_WRITE: 'MCP 快照写盘失败',
  E_SNAPSHOT_CORRUPT: 'MCP 快照文件损坏或格式不符',
  E_UNSUPPORTED: '不支持的请求（兼容别名；优先使用 E_UNSUPPORTED_CAPABILITY）',

  // —— CLI 参数契约 ——
  E_ARG_MISSING: 'CLI 参数缺失（必填项未提供）',
  E_ARG_TYPE: 'CLI 参数类型非法',
  E_ARG_ENUM: 'CLI 参数取值不在枚举内',
  E_ARG_CONFLICT: 'CLI 参数互斥组合冲突',
  E_ARG_REQUIRES: 'CLI 参数依赖缺失（如 --share 需要 --tab）',
  E_ARG_RANGE: 'CLI 参数数值超出范围',
  E_ARG_UNEXPECTED: 'CLI 参数不被该子命令接受',
  E_ARG_USAGE: 'CLI 用法错误',
  E_UNKNOWN_FLAG: '未知命令行选项',
  E_BAD_SUBCOMMAND: '未知子命令',
  E_HUMAN_GATE: '需要人工确认后才能继续（human gate）',

  // —— eval 语料与离线运行器 ——
  E_EVAL_CORPUS: 'eval 语料格式/元数据非法',
  E_EVAL_RUNNER: 'eval 离线运行器执行失败',
  E_EVAL_DOM: 'eval DOM 层失败',
  E_EVAL_DOM_ARGS: 'eval DOM 运行参数非法',
  E_EVAL_DOM_BAD_FACTS: 'eval DOM 事实读取结果非法',
  E_EVAL_DOM_BAD_JSON: 'eval DOM 事实 JSON 解析失败',
  E_EVAL_DOM_FIXTURE: 'eval DOM 夹具缺失或不可读',
  E_EVAL_DOM_NO_BROWSER: 'eval DOM 需要真实浏览器但未找到',
  E_EVAL_DOM_NO_FACTS: 'eval DOM 未产出事实',
  E_EVAL_DOM_NO_MARKER: 'eval DOM 页面缺少完成标记',
  E_EVAL_DOM_SPAWN: 'eval DOM 浏览器进程启动失败',

  // —— 动作与视觉 ——
  E_OCCLUDED: '目标被遮挡（浮层/弹窗）',
  E_OBSCURED: '视觉坐标落点被铺满视口的元素遮住',
  E_TARGET_MISMATCH: '视觉坐标落点不属于预期的候选目标',
  E_CAPTURE_STALE: '截图 capture 不存在或已过期',
  E_BAD_MODE: '动作模式取值不支持',
  E_DIALOG_PENDING: '有未处理的页面原生弹窗',
  E_EXISTS: '同名资源已存在',

  // —— 读取与提取 ——
  E_CACHE_EMPTY: '缓存为空',
  E_TOO_LARGE: '结果超过大小上限',
  E_RESULT_TOO_LARGE: '结果超过协议允许的大小',
  E_JS_ERROR: '页面内 JS 抛异常',

  // —— 导航 ——
  E_NAV_FAIL: '导航失败',
  E_TIMEOUT: '等待类命令超时',

  // —— 调试与网络 ——
  E_DEBUGGER_BUSY: '调试器被其它会话占用',
  E_UNSUPPORTED_CAPABILITY: '当前版本不支持该能力',
  E_UNSUPPORTED_REMOTE: '远程连接不支持该能力',
  E_PROTOCOL_UNSUPPORTED: '协议版本不兼容',
  E_PROTOCOL_AUDIT: '协议审计失败（proof obligations / 兼容矩阵 / 迁移计划自检不通过）',

  // —— 鉴权与会话（daemon 侧） ——
  E_AUTH: '本机鉴权失败',
  E_AUTH_BUSY: '鉴权通道正被另一请求占用',
  E_AUTH_CHALLENGE: '鉴权挑战无效',
  E_AUTH_EXPIRED: '鉴权挑战已过期',
  E_AUTH_FAILED: '鉴权证明不匹配',
  E_AUTH_PROOF: '鉴权证明格式或签名字段无效',
  E_AUTH_STATE: '鉴权状态机不允许该操作',
  E_PAIR_INVALID: '配对码无效或已使用',
  E_PAIR_REQUIRED: '需要先完成本机配对',
  E_PAIR_REJECTED: '配对 token 已绑定到其它浏览器，请重新配对',
  E_PAUSED_MANUAL: '会话因人工接管而暂停',
  E_LEDGER_PENDING: '有未确认的意图账本记录',

  // —— 传输与进程 ——
  E_DAEMON: 'daemon 不可用（未启动或连接失败，客户端侧码）',
  E_NO_DAEMON: '连不上 daemon',
  E_DAEMON_TIMEOUT: 'daemon 在限定时间内没有响应',
  E_DISCONNECTED: '连接已断开',
  E_EXTENSION_GONE: '浏览器扩展已断开',
  E_LISTEN: 'daemon 端口监听失败',
  E_SPAWN: '子进程启动失败',
  E_ENV: '运行环境不满足要求',
  E_CONFIG_INVALID: '配置项取值无效',
  E_BAD_JSON: '请求或文件不是合法 JSON',
  E_BAD_REQUEST: '请求格式不合法',
  E_INVALID_PARAMS: '参数无效',
  E_DIRECT_RPC_DISABLED: '直连 RPC 已被关闭',
  E_RPC: 'RPC 调用失败',
  E_OUTPUT: '输出写入失败',

  // —— 动作补充 ——
  E_TARGET_NOT_FILLABLE: '目标不可填写（不是输入框/可编辑区）',
  E_NOT_SELECT: '目标不是 select 元素',
  E_BROWSER: '浏览器侧操作失败',
  E_SCREENSHOT: '远程预览截图失败',
  E_PREVIEW_META: '远程预览读取页面尺寸失败',
  E_CLICK: '远程预览点击失败',
  E_KEY: '远程预览按键失败',
  E_FOCUS: '远程预览聚焦标签页失败',
  E_PAGE_ERROR: '页面内执行出错',
  E_OBSERVE_FAILED: '观察采集失败',
  E_FOLLOW_FAILED: '跟随新标签页失败',
  E_RELEASE_INVALID: '发布信息校验失败',
  E_UPDATE: '更新流程失败',
  E_MCP_CONFLICT: 'MCP 服务端口/进程冲突',
  E_APP_SSO_FAILED: '应用单点登录失败',
  E_TRANSFER_NOT_FOUND: '传输任务不存在',
  E_TRANSFER_STATE: '传输任务状态不允许该操作',

  // —— 人工接管与协作 ——
  E_BORROW_DENIED: '借用标签页被拒绝',
  E_BORROW_CONFLICT: '同一标签页已被其他会话借用或正在确认中',
  E_BORROW_TIMEOUT: '借用标签页超时',
  E_HELP_DISABLED: '人工协助不可用',
  E_CONTROL_NOT_HELD: '共享标签页的控制权不在本会话（exclusive 模式下写动作被拒绝）',
  E_CONTROL_BUSY: '共享标签页的控制权被其他会话持有，无法认领',
  E_CONTROL_STALE: '共享标签页的控制权已换代（epoch 不符，需重新读取）',

  // —— 文件与下载 ——
  E_NO_DOWNLOAD: '没有可用的下载',
  E_DOWNLOAD_FAILED: '下载失败',
  E_NO_FILE_CHOOSER: '没有可用的文件选择器',
  E_TRANSFER_OFFSET: '传输偏移不匹配',
  E_TRANSFER_LIMIT: '传输超过大小限制',
  E_TRANSFER_INCOMPLETE: '传输未完成',
  E_INCOGNITO_UNAVAILABLE: '无痕窗口不可用',

  // —— 配方 ——
  E_RECIPE_NOT_APPROVED: '配方未获批',
  E_RECIPE_CHANGED: '配方内容已变更',
  E_RECIPE_EXPIRED: '配方已过期',
  E_RECIPE_DRAFT_EMPTY: '运行日志里没有可回放的步骤（recipe 草稿为空）',
  E_RECIPE_LOCKED: '配方正在被另一个进程回放',

  // —— 其它 ——
  E_FORBIDDEN: '当前策略禁止该操作',
  E_READ_ONLY: '会话是只读 scope，不能执行变更动作',
  E_EXEC_FAILED: 'exec 脚本执行失败或超时',
  E_INTERNAL: '其它异常',
};

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES);
export const ERROR_CODE_SET = new Set(ERROR_CODE_LIST);

/**
 * 失败后的下一步动作。retry 取值：
 * - `no`            参数/策略问题，重试无用，改调用方式
 * - `transient`     连接/进程类，等一会儿原样重试
 * - `after-action`  先做一件具体的事（重观测、重截图、恢复会话…）再重试
 */
export const ERROR_RECOVERY = {
  E_PROTOCOL_AUDIT: { retry: 'no', hint: '协议审计自检失败：按 proof obligations / 兼容矩阵 / 迁移计划报告修复不变量后再试' },
  E_BAD_ARG: { retry: 'no', hint: '检查参数组合' },
  E_NOT_FOUND: { retry: 'after-action', hint: '重新 observe 确认目标是否还在' },
  E_NOT_ACTIONABLE: { retry: 'after-action', hint: '目标不可操作：先等它可见/启用，或换目标' },
  E_STALE_REF: { retry: 'after-action', hint: 'ref 已失效：重新 observe' },
  E_OBSERVATION_STALE: { retry: 'after-action', hint: '观测过期：重新 observe' },
  E_OBSERVATION_CHANGED: { retry: 'after-action', hint: '页面已变化：重新 observe 后重试' },
  E_CONTEXT_STALE: { retry: 'after-action', hint: '上下文已失效：重新 cooperate sync 取新 context' },
  E_TARGET_DETACHED: { retry: 'after-action', hint: '目标节点已被移除：重新 observe/cooperate sync 后用新 ref' },
  E_COOPERATION_STALE: { retry: 'after-action', hint: '协作 authority 无法对齐：刷新页面或重开会话后重新 cooperate sync' },
  E_CONTROL_CONTEXT_INVALID: { retry: 'after-action', hint: '重新 cooperate sync 取新的 context_id（上下文换代后旧 id 失效）' },
  E_UNSUPPORTED_FEATURE: { retry: 'no', hint: '升级扩展到支持的协议版本/feature，或去掉该 feature 参数降级执行' },
  E_TOKEN_EXPIRED: { retry: 'after-action', hint: 'passthrough 租约已过期：重新申请一次 passthrough 再试' },
  E_TOKEN_USED: { retry: 'after-action', hint: '租约只能消费一次：重新申请 passthrough' },
  E_TOKEN_UNKNOWN: { retry: 'after-action', hint: '租约不存在或已被清理：重新申请 passthrough' },
  E_TOKEN_GRANTEE: { retry: 'no', hint: '租约绑定到其它 tab：用签发它的 tab 消费' },
  E_CAPTURE_LIMIT: { retry: 'after-action', hint: '抑制引用过多：检查是否有未释放的 withOverlaysHidden' },
  E_CAPTURE_STALE: { retry: 'after-action', hint: 'capture 已失效：重新截图' },
  E_OCCLUDED: { retry: 'after-action', hint: '先关浮层/弹窗，或用 --force' },
  E_OBSCURED: { retry: 'after-action', hint: '落点被遮挡：重新截图取坐标' },
  E_TARGET_MISMATCH: { retry: 'after-action', hint: '坐标落在别的元素上：重新 observe/截图' },
  E_NO_SESSION: { retry: 'after-action', hint: '先 bridge session start（或 bridge open <url>）' },
  E_NO_TAB: { retry: 'after-action', hint: 'tab 已被关闭：重新开一个会话/标签页' },
  E_SESSION_PAUSED: { retry: 'after-action', hint: '人工接管中：session resume 后重试' },
  E_LEDGER_PENDING: { retry: 'after-action', hint: '先 ledger resolve <id> --outcome done|abandoned' },
  E_SESSION_BUSY: { retry: 'transient', hint: '同一会话有进行中的操作，稍等再用' },
  E_INPUT_BUSY: { retry: 'transient', hint: '输入通道忙，稍后重试' },
  E_TIMEOUT: { retry: 'after-action', hint: '加 --timeout，或先确认页面是否卡住' },
  E_RECIPE_LOCKED: { retry: 'transient', hint: '另一个 recipe 回放正在进行：等它结束（或删掉 <name>.lock）后重试' },
  E_EXPECT_FAILED: { retry: 'no', hint: '断言不符：核对页面实际内容再决定' },
  E_NAV_FAIL: { retry: 'transient', hint: '导航失败，确认 URL 可达后重试' },
  E_DISCONNECTED: { retry: 'transient', hint: '连接断开，稍后重试' },
  E_EXTENSION_GONE: { retry: 'after-action', hint: '扩展断开：确认浏览器里的扩展已加载' },
  E_NO_DAEMON: { retry: 'after-action', hint: 'daemon 未运行：先启动 daemon' },
  E_DAEMON: { retry: 'after-action', hint: 'daemon 不可用：先启动 daemon' },
  E_PAIR_REQUIRED: { retry: 'after-action', hint: '先完成本机配对（bridge pair）' },
  E_PAIR_REJECTED: { retry: 'no', hint: 'token 绑定的是另一个浏览器：在目标浏览器重新配对' },
  E_FORBIDDEN: { retry: 'no', hint: '被策略禁止，换做法或征求用户同意' },
  E_READ_ONLY: { retry: 'no', hint: '只读会话不能点击/输入；需要变更时新建 control scope 会话' },
  E_UNSUPPORTED_CAPABILITY: { retry: 'no', hint: '当前版本不支持，换能力' },
  E_UNSUPPORTED_REMOTE: { retry: 'no', hint: '远程连接不支持，改用本机' },
  E_RATE_LIMITED: { retry: 'transient', hint: '被限流，退避后重试' },
  E_QUEUE_FULL: { retry: 'transient', hint: '队列满，稍后重试' },
  E_BORROW_DENIED: { retry: 'no', hint: '用户拒绝借用，别绕过' },
  E_BORROW_CONFLICT: { retry: 'after-action', hint: '该标签页已被锁定：等当前借用结束或会话停止后再试' },
  E_CONTROL_NOT_HELD: { retry: 'after-action', hint: '共享 tab 的写控制权不在本会话：等租约到期，或让持有者 session handoff 给你' },
  E_CONTROL_BUSY: { retry: 'after-action', hint: '控制权被他人持有：等租约到期（session control 看剩余时间）或请持有者 handoff' },
  E_CONTROL_STALE: { retry: 'after-action', hint: '控制权已换代：重新 session control 读 epoch 后再操作' },
  E_HELP_DISABLED: { retry: 'no', hint: '人工协助不可用，自行处理或询问用户' },
  E_TOO_LARGE: { retry: 'no', hint: '结果过大，缩小范围（--max-rows / --max-tokens）' },
  E_RESULT_TOO_LARGE: { retry: 'no', hint: '结果过大，缩小范围' },
};

/** 取恢复建议；没登记的一律按"不可自动重试"处理。 */
export function recoveryHint(code) {
  const resolved = resolveErrorCode(code);
  const entry = resolved ? ERROR_RECOVERY[resolved] : null;
  if (entry) return entry;
  return { retry: 'no', hint: '' };
}

/** 未知码统一落到 E_INTERNAL，避免客户端拿到无法分支的字符串。 */
/** 兼容错误码别名：外部调用方/旧客户端线名 → 我方 canonical 错误码。 */
export const ERROR_CODE_ALIASES = Object.freeze({
  "cdp_failed": "E_PAGE_ERROR",
  "user_aborted": "E_CANCELLED",
  "agent_window_scope": "E_UNSUPPORTED_FEATURE",
  "download_path_mismatch": "E_DOWNLOAD_FAILED",
  "extract_field_ambiguous": "E_OPTION_AMBIGUOUS",
  "extract_structure_invalid": "E_PAGE_ERROR",
  "extract_target_ambiguous": "E_OPTION_AMBIGUOUS",
  "file_drop_failed": "E_TRANSFER_STATE",
  "file_drop_target_unavailable": "E_TARGET_NOT_FILLABLE",
  "file_input_not_activated": "E_NO_FILE_CHOOSER",
  "frame_unobservable": "E_OBSERVE_FAILED",
  "input_clock_unavailable": "E_INTERNAL",
  "input_paint_unconfirmed": "E_EXEC_FAILED",
  "loading_stalled": "E_TIMEOUT",
  "observe_identity_reload_loop": "E_OBSERVE_FAILED",
  "operation_settling": "E_INPUT_BUSY",
  "page_hidden": "E_PAGE_ERROR",
  "read_field_ambiguous": "E_OPTION_AMBIGUOUS",
  "ref_kind_unsupported": "E_UNSUPPORTED_FEATURE",
  "set_file_input_failed": "E_NO_FILE_CHOOSER",
  "tab_not_active": "E_NO_TAB",
  "ui_lookup_failed": "E_OBSERVE_FAILED",
  "user_moved_tab": "E_TARGET_DETACHED",
  "window_resize_constrained": "E_ARG_RANGE",
  "window_resize_inactive_tab": "E_NO_TAB",
  "window_resize_unconfirmed": "E_EXEC_FAILED",
  "window_resize_viewport_unchanged": "E_EXEC_FAILED",
});

export function resolveErrorCode(code) {
  const key = String(code || '').trim();
  if (ERROR_CODE_SET.has(key)) return key;
  const alias = ERROR_CODE_ALIASES[key];
  return alias && ERROR_CODE_SET.has(alias) ? alias : null;
}

export function normalizeErrorCode(code) {
  return resolveErrorCode(code) || 'E_INTERNAL';
}
