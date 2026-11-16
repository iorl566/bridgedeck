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
  E_START_PENDING: '会话启动中，操作尚未就绪',
  E_START_NOT_READY: '会话尚未就绪，稍后重试',

  // —— 观测与上下文 ——
  E_OBSERVATION_STALE: '观测结果已过期，需重新 observe',
  E_CURSOR_STALE: '分页游标已过期',
  E_CONTEXT_REQUIRED: '该动作要求先提供上下文',
  E_CONTEXT_STALE: '上下文与当前页面不一致',
  E_DEPENDS_FAILED: '前置依赖步骤未成功',
  E_EXPECT_FAILED: 'expect 断言不匹配',
  E_OBSERVATION_CHANGED: '页面在观测后已变化（观测代数不符）',

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
  E_BORROW_TIMEOUT: '借用标签页超时',
  E_HELP_DISABLED: '人工协助不可用',

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
  E_RECIPE_LOCKED: '配方正在被另一个进程回放',

  // —— 其它 ——
  E_FORBIDDEN: '当前策略禁止该操作',
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
  E_BAD_ARG: { retry: 'no', hint: '检查参数组合' },
  E_NOT_FOUND: { retry: 'after-action', hint: '重新 observe 确认目标是否还在' },
  E_NOT_ACTIONABLE: { retry: 'after-action', hint: '目标不可操作：先等它可见/启用，或换目标' },
  E_STALE_REF: { retry: 'after-action', hint: 'ref 已失效：重新 observe' },
  E_OBSERVATION_STALE: { retry: 'after-action', hint: '观测过期：重新 observe' },
  E_OBSERVATION_CHANGED: { retry: 'after-action', hint: '页面已变化：重新 observe 后重试' },
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
  E_FORBIDDEN: { retry: 'no', hint: '被策略禁止，换做法或征求用户同意' },
  E_UNSUPPORTED_CAPABILITY: { retry: 'no', hint: '当前版本不支持，换能力' },
  E_UNSUPPORTED_REMOTE: { retry: 'no', hint: '远程连接不支持，改用本机' },
  E_RATE_LIMITED: { retry: 'transient', hint: '被限流，退避后重试' },
  E_QUEUE_FULL: { retry: 'transient', hint: '队列满，稍后重试' },
  E_BORROW_DENIED: { retry: 'no', hint: '用户拒绝借用，别绕过' },
  E_HELP_DISABLED: { retry: 'no', hint: '人工协助不可用，自行处理或询问用户' },
  E_TOO_LARGE: { retry: 'no', hint: '结果过大，缩小范围（--max-rows / --max-tokens）' },
  E_RESULT_TOO_LARGE: { retry: 'no', hint: '结果过大，缩小范围' },
};

/** 取恢复建议；没登记的一律按"不可自动重试"处理。 */
export function recoveryHint(code) {
  const entry = ERROR_RECOVERY[code];
  if (entry) return entry;
  return { retry: 'no', hint: '' };
}

/** 未知码统一落到 E_INTERNAL，避免客户端拿到无法分支的字符串。 */
export function normalizeErrorCode(code) {
  return ERROR_CODE_SET.has(code) ? code : 'E_INTERNAL';
}
