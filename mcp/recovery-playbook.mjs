// mcp/recovery-playbook.mjs —— 错误恢复“剧本”（playbook）/ 多步恢复计划 / 有状态恢复会话。
//
// 目标（第十一批-C ④：错误恢复 playbook）：
//   mcp/error-map.mjs 已经能给“这个错误可不可重试、等多久”的建议，但真实恢复往往不是
//   “原地重试”一步：
//     - E_STALE_REF 要先重新 observe 再重试，盲目重放会点错元素；
//     - E_DAEMON 要先确认 daemon 进程/会话，再重建连接（不是重试同一请求）；
//     - E_TIMEOUT 往往要先缩小 scope（更小 limit / 更短页面）再试；
//     - E_HUMAN_GATE 必须人工确认，任何自动重试都是错的。
//   本模块把“错误码/族 → 有序恢复步骤”写成可审计的剧本，并给出：
//     1. planRecovery()：一次性的可执行计划（步骤 + 动作类型 + 延迟 + 自动/需人工标记）；
//     2. RecoverySession：有状态恢复会话（next/record/backoff/升级人工），不会无限重试；
//     3. auditRecoveryPlaybooks()：启动期硬审计——每个错误大类都有剧本、终态错误不许自动重试、
//        剧本引用的工具名必须真实存在（避免文档里写了个不存在的恢复工具）。
//
// 设计约束：
//   1. 纯函数、无 IO：剧本是静态表，计划由错误码 + 历史派生；不访问 daemon/磁盘；
//   2. 与 error-map 单一来源对齐：能不能重试、退避多久都调用 error-map 的 retryPlan/retryDelayMs，
//      本模块不另造一套重试语义；
//   3. 有界：单次计划步骤数 ≤ 8，RecoverySession 自动重试次数 ≤ error-map 的 maxAttempts；
//   4. 语言中立：action 是枚举（retry/reobserve/...），具体由客户端/SDK 翻译成调用；
//   5. 不假装能自动修复：server 只把计划放进 _meta 建议客户端，绝不自动重放工具（副作用不可逆）。
//
// 调用点（真实消费）：
//   - mcp/server.mjs：tools/call 失败分支的 _meta['browser-bridge/recovery']（planRecovery）；
//     initialize experimental['browser-bridge/recovery-playbook']；启动期 assertRecoveryPlaybooks()；
//   - 单测 tests/unit/mcp-recovery-playbook.test.mjs。

import {
  ERROR_CATEGORIES,
  RETRY_POLICY,
  TERMINAL_CODES,
  classifyErrorCode,
  needsActionBeforeRetry,
  retryDelayMs,
  retryPlan,
} from './error-map.mjs';

/** 恢复动作类型（客户端/SDK 按此翻译成具体操作）。 */
export const RECOVERY_ACTION_TYPES = Object.freeze({
  RETRY: 'retry',
  CHECK_STATUS: 'check-status',
  RECONNECT: 'reconnect',
  REVALIDATE_SESSION: 'revalidate-session',
  START_SESSION: 'start-session',
  REOBSERVE: 'reobserve',
  RESOURCE_REFRESH: 'resource-refresh',
  DROP_CURSOR: 'drop-cursor',
  REDUCE_SCOPE: 'reduce-scope',
  FIX_ARGUMENTS: 'fix-arguments',
  HUMAN: 'human',
  STOP: 'stop',
});

/** 恢复严重度。 */
export const RECOVERY_SEVERITIES = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
});

/** 计划里单次最多给多少步（防止 _meta 膨胀）。 */
export const RECOVERY_LIMITS = Object.freeze({
  maxSteps: 8,
  maxHumanSteps: 2,
  maxHistory: 32,
  maxNotesLength: 240,
});

/** 一步恢复动作的构造器（纯声明；planRecovery 会补 index/attempt/delay/auto）。 */
function step(id, action, note, extra = {}) {
  return Object.freeze({ id: String(id), action, note: String(note), ...extra });
}

const AUTOMATIC = Object.freeze({ auto: true });
const MANUAL = Object.freeze({ auto: false, requiresHuman: true });

/**
 * 具体错误码 → 剧本（优先于族/大类）。
 * 约定：step.id 在同一剧本里唯一；note 是给模型/人的可读说明；tool 是建议调用的 MCP 工具。
 */
export const PLAYBOOK_STEPS = Object.freeze({
  // -- 传输/环境：不是重试能解决的，先确认进程与连接 --
  E_DAEMON: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '先调用 browser_status 确认 daemon 与浏览器进程是否在运行（不要直接重试同一请求）。', { tool: 'browser_status', ...AUTOMATIC }),
    step('reconnect-client', RECOVERY_ACTION_TYPES.RECONNECT, '若客户端持有连接：重建 MCP 连接/会话（E_DAEMON 是终端错误，旧会话不可继续）。', { ...MANUAL }),
    step('start-session', RECOVERY_ACTION_TYPES.START_SESSION, 'daemon 恢复后重新 browser_session_start 建会话，再重试原动作。', { tool: 'browser_session_start', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, 'daemon 无法启动时把诊断信息（E_DAEMON 文本 + browser_status 输出）交给人工处理。', { ...MANUAL }),
  ]),
  E_DISCONNECTED: Object.freeze([
    step('reconnect-client', RECOVERY_ACTION_TYPES.RECONNECT, 'MCP/ws 连接已断开：重建连接并重新 initialize，不要重放未确认的副作用请求。', { ...AUTOMATIC }),
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '确认 daemon 是否仍在运行（连接断开可能是 daemon 退出或网络抖动）。', { tool: 'browser_status', ...AUTOMATIC }),
    step('start-session', RECOVERY_ACTION_TYPES.START_SESSION, '重连后需要新的会话上下文时调用 browser_session_start。', { tool: 'browser_session_start', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '持续断开时停止自动重试，交给人工检查本地服务。', { ...MANUAL }),
  ]),
  E_ENV: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '环境/PATH 类错误：确认 node、daemon、BB_HOME 与权限配置。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '按 E_ENV 文本修复环境后重新启动客户端（不是重试工具）。', { ...MANUAL }),
  ]),
  // -- 会话 --
  E_SESSION_STOPPED: Object.freeze([
    step('start-session', RECOVERY_ACTION_TYPES.START_SESSION, '会话已停止：browser_session_start 建新会话，旧会话的 snapshot/ref 全部失效。', { tool: 'browser_session_start', ...AUTOMATIC }),
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '新会话里重新 browser_observe 拿新的 @eN ref。', { tool: 'browser_observe', ...AUTOMATIC }),
    // 终态错误（旧会话不可继续）的重试必须是“人工决定”的：换会话后重放副作用动作不可自动化。
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '用新会话重试原动作（参数里的 session 要替换成新 id）。', MANUAL),
  ]),
  E_NO_SESSION: Object.freeze([
    step('start-session', RECOVERY_ACTION_TYPES.START_SESSION, '当前没有可用会话：先 browser_session_start。', { tool: 'browser_session_start', ...AUTOMATIC }),
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '建会话后重新 observe 再决定动作。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '重试原动作。', MANUAL),
  ]),
  E_SESSION_BUSY: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '会话忙：按退避等待后重试（不要并发压同一会话）。', AUTOMATIC),
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '持续忙时用 browser_status/browser_brief 看是否有长任务未结束。', { tool: 'browser_brief', ...MANUAL }),
  ]),
  // -- 观察/引用失效：必须重新观察，禁止盲目重放 --
  E_STALE_REF: Object.freeze([
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, 'ref 已失效：重新 browser_observe，用新的 @eN 重试；不要用旧 ref 重放。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '用新 ref 重试原动作。', AUTOMATIC),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '反复 stale 说明页面在持续变化：人工确认是否需要等待页面稳定。', { ...MANUAL }),
  ]),
  E_OBSERVATION_STALE: Object.freeze([
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '观察快照过期：重新 browser_observe 后再做判断。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '基于新观察重试。', AUTOMATIC),
  ]),
  E_OBSERVATION_CHANGED: Object.freeze([
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '页面结构已变化：重新 observe，并把“变化事实”写进汇报。', { tool: 'browser_observe', ...AUTOMATIC }),
  ]),
  E_CURSOR_STALE: Object.freeze([
    step('drop-cursor', RECOVERY_ACTION_TYPES.DROP_CURSOR, '分页 cursor 已失效：丢掉 cursor 从第一页重新开始，不要复用旧偏移。', AUTOMATIC),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '不带 cursor 重试原分页调用。', AUTOMATIC),
  ]),
  E_TARGET_DETACHED: Object.freeze([
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '目标节点已 detach：重新 observe 定位（可能已不在 DOM）。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '目标确实消失时停止重试，按“目标不存在”汇报。', { ...MANUAL }),
  ]),
  // -- 审批 --
  E_HUMAN_GATE: Object.freeze([
    step('human-approval', RECOVERY_ACTION_TYPES.HUMAN, 'destructive 工具需要人工确认：在 tools/call 的 _meta 传 "browser-bridge/approval": "confirmed"，或走人工接管。', { ...MANUAL }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '确认后重试原调用（参数保持不变，只补审批 token）。', { ...MANUAL }),
  ]),
  // -- 协议/能力 --
  E_UNSUPPORTED_CAPABILITY: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '能力不支持：用 browser_status 看 daemon/扩展版本与 feature floor。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '需要升级本地组件或改用降级路径：交给人工决策，不要循环重试。', { ...MANUAL }),
  ]),
  E_PROTOCOL_UNSUPPORTED: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '协议版本不匹配：确认客户端声明的 protocolVersion 与服务端支持表。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '升级客户端或服务端后重连。', { ...MANUAL }),
  ]),
  E_UNKNOWN_METHOD: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '方法不存在：确认工具/方法映射与组件版本。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '改用受支持的方法（查 resources bridge://protocol/summary）。', { ...MANUAL }),
  ]),
  // -- 超时/预算：先减 scope 再重试 --
  E_TIMEOUT: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '超时：先 browser_status 确认 daemon 没卡死。', { tool: 'browser_status', ...AUTOMATIC }),
    step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '缩小请求：分页工具减小 limit、截图降低 scale/改为分段、观察限制 max_tokens。', { ...AUTOMATIC }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '按退避重试缩小后的请求。', AUTOMATIC),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '多次超时且 scope 已最小：交人工确认页面/网络是否卡死。', { ...MANUAL }),
  ]),
  E_DEADLINE: Object.freeze([
    step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '超过截止时间：缩小 scope（分页/分段/少采数据）后重试。', AUTOMATIC),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '按退避重试。', AUTOMATIC),
  ]),
  E_START_PENDING: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '浏览器/会话仍在启动：按退避等待后重试（不要重复 start）。', AUTOMATIC),
  ]),
  E_START_NOT_READY: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '组件尚未就绪：退避重试。', AUTOMATIC),
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '持续未就绪时看 browser_status 的启动阶段。', { tool: 'browser_status', ...MANUAL }),
  ]),
  // -- 资源/快照 --
  E_NOT_FOUND: Object.freeze([
    step('resource-refresh', RECOVERY_ACTION_TYPES.RESOURCE_REFRESH, '目标不存在：先 browser_observe 或读取对应 resource 刷新事实，再决定是否创建/重试。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '确认目标确实不存在时按“无此目标”汇报，不要反复重试。', { ...MANUAL }),
  ]),
  E_SNAPSHOT_DISABLED: Object.freeze([
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '快照持久化被禁用：改用 tools/call 返回内联读取，或让用户开启持久化。', { ...MANUAL }),
  ]),
  E_SNAPSHOT_CORRUPT: Object.freeze([
    step('resource-refresh', RECOVERY_ACTION_TYPES.RESOURCE_REFRESH, '快照损坏：重新调用对应工具生成新快照，不要手改持久化文件。', { ...MANUAL }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '生成新快照后重试读取。', AUTOMATIC),
  ]),
  E_SNAPSHOT_WRITE: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '写快照失败：检查 BB_HOME 磁盘/权限（不影响工具结果本身）。', { tool: 'browser_status', ...MANUAL }),
  ]),
  // -- 取消 --
  E_CANCELLED: Object.freeze([
    step('stop', RECOVERY_ACTION_TYPES.STOP, '请求已被取消/放弃：不要重试；如仍需结果，重新发起一次新请求。', MANUAL),
  ]),
  E_REQUEST_CANCELLED: Object.freeze([
    step('stop', RECOVERY_ACTION_TYPES.STOP, '请求在服务端被取消：确认原因后再决定是否重新发起。', MANUAL),
  ]),
  // -- 断言/依赖 --
  E_EXPECT_FAILED: Object.freeze([
    step('reobserve', RECOVERY_ACTION_TYPES.REOBSERVE, '断言失败：重新 observe 看页面真实状态，不要假设预期成立。', { tool: 'browser_observe', ...AUTOMATIC }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '断言与事实不符时按失败汇报（附实际值），由人决定下一步。', { ...MANUAL }),
  ]),
  E_DEPENDS_FAILED: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '前置依赖失败：查看依赖项错误码（本错误只说明“依赖先挂了”）。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '修复前置错误后重新执行整个序列，不要跳过失败依赖。', { ...MANUAL }),
  ]),
  // -- 限流/队列 --
  E_RATE_LIMITED: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '被限流：按指数退避等待后重试。', AUTOMATIC),
    step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '持续限流时降低并发/减小请求量。', AUTOMATIC),
  ]),
  E_QUEUE_FULL: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '队列满：退避后重试，避免继续灌请求。', AUTOMATIC),
    step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '降低并发/批量大小。', AUTOMATIC),
  ]),
  // -- 取证/证据 --
  E_CAPTURE_STALE: Object.freeze([
    step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '截图分片过期：按 staleAttempts 重拍当前视口，不要拼接近似重复分片。', { tool: 'browser_longshot_recover', ...AUTOMATIC }),
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '重拍后重试拼接。', AUTOMATIC),
  ]),
  // -- 内部 --
  E_INTERNAL: Object.freeze([
    step('retry', RECOVERY_ACTION_TYPES.RETRY, '内部错误：先按退避重试一次（可能有瞬时状态）。', AUTOMATIC),
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '复现时用 browser_status + journal resource 收集证据。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '再次失败时停止重试并附上错误码/时间线交人工。', { ...MANUAL }),
  ]),
});

/**
 * 错误码族 → 剧本（具体码优先，族次之，大类最后）。
 * 目前只放“同族处理方式一致”的族；能落到 error-map 大类的走 CATEGORY_PLAYBOOKS。
 */
export const PLAYBOOK_PATTERNS = Object.freeze([
  Object.freeze({
    pattern: /^E_ARG|^E_TOKEN_BAD_ARG|^E_UNKNOWN_FLAG|^E_BAD_SUBCOMMAND/,
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('fix-arguments', RECOVERY_ACTION_TYPES.FIX_ARGUMENTS, '参数错误：按错误里的 path 修正 arguments 后重试（不要原样重放）。', AUTOMATIC),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '修正后重试原工具。', AUTOMATIC),
    ]),
  }),
  Object.freeze({
    pattern: /^E_TOKEN_(?!BAD_ARG)/,
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '租约/令牌无效：重新走签发/借用流程，不要复用旧 token。', { ...MANUAL }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '拿到新 token 后重试。', { ...MANUAL }),
    ]),
  }),
  Object.freeze({
    pattern: /^E_CAPTURE_/,
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '采集受限：降低 scale/分段/减小超长页面范围后重试。', { tool: 'browser_screenshot', ...AUTOMATIC }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '按缩小后的参数重试。', AUTOMATIC),
    ]),
  }),
  Object.freeze({
    pattern: /^E_LEDGER/,
    severity: RECOVERY_SEVERITIES.FATAL,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '账本 IO 失败：检查磁盘/权限/daemon 日志；不要重放可能已记账的操作。', { tool: 'browser_status', ...MANUAL }),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '交人工核对账本一致性后再继续。', { ...MANUAL }),
    ]),
  }),
  Object.freeze({
    pattern: /^E_COOPERATION_|^E_CONTEXT_/,
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('revalidate-session', RECOVERY_ACTION_TYPES.REVALIDATE_SESSION, '协作上下文失效：重新 browser_cooperate_sync 签发 context 收据，再重试。', { tool: 'browser_cooperate_sync', ...AUTOMATIC }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '拿到新上下文后重试。', AUTOMATIC),
    ]),
  }),
]);

/**
 * error-map 大类 → 兜底剧本（保证任何已知码都有可执行建议）。
 */
export const CATEGORY_PLAYBOOKS = Object.freeze({
  [ERROR_CATEGORIES.VALIDATION]: Object.freeze({
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('fix-arguments', RECOVERY_ACTION_TYPES.FIX_ARGUMENTS, '校验类错误：修正参数（查看 _meta["browser-bridge/validation"] 的 path/code）。', AUTOMATIC),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '修正后重试。', AUTOMATIC),
    ]),
  }),
  [ERROR_CATEGORIES.SESSION]: Object.freeze({
    severity: RECOVERY_SEVERITIES.ERROR,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '会话类错误：先 browser_status 看会话/租约/标签页状态。', { tool: 'browser_status', ...AUTOMATIC }),
      step('start-session', RECOVERY_ACTION_TYPES.START_SESSION, '会话不可用时重新 browser_session_start。', { tool: 'browser_session_start', ...MANUAL }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '按退避重试。', AUTOMATIC),
    ]),
  }),
  [ERROR_CATEGORIES.TRANSPORT]: Object.freeze({
    severity: RECOVERY_SEVERITIES.FATAL,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '传输类错误：确认 daemon 进程仍在运行。', { tool: 'browser_status', ...AUTOMATIC }),
      step('reconnect-client', RECOVERY_ACTION_TYPES.RECONNECT, '重建客户端连接，不要重放未确认副作用的请求。', { ...MANUAL }),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '连接无法恢复时交人工。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.CANCELLATION]: Object.freeze({
    severity: RECOVERY_SEVERITIES.INFO,
    steps: Object.freeze([
      step('stop', RECOVERY_ACTION_TYPES.STOP, '取消是预期内的控制流：不自动重试；必要时由调用方重新发起。', MANUAL),
    ]),
  }),
  [ERROR_CATEGORIES.TIMEOUT]: Object.freeze({
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('reduce-scope', RECOVERY_ACTION_TYPES.REDUCE_SCOPE, '超时类错误：先缩小 scope（分页/分段/少采）再重试。', AUTOMATIC),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '按退避重试缩小后的请求。', AUTOMATIC),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '多次超时交人工确认页面/网络状态。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.RESOURCE]: Object.freeze({
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('resource-refresh', RECOVERY_ACTION_TYPES.RESOURCE_REFRESH, '资源类错误：重新生成/读取资源（observe、journal、evidence）后再判断。', { tool: 'browser_observe', ...AUTOMATIC }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '刷新后重试。', AUTOMATIC),
    ]),
  }),
  [ERROR_CATEGORIES.APPROVAL]: Object.freeze({
    severity: RECOVERY_SEVERITIES.WARN,
    steps: Object.freeze([
      step('human-approval', RECOVERY_ACTION_TYPES.HUMAN, '需要人工确认：带上 "browser-bridge/approval": "confirmed" 或走人工接管。', { ...MANUAL }),
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '确认后重试。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.PROTOCOL]: Object.freeze({
    severity: RECOVERY_SEVERITIES.ERROR,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '协议类错误：确认客户端/服务端/扩展版本与 feature floor。', { tool: 'browser_status', ...MANUAL }),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '需要升级组件或改走降级路径，交人工决策。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.LEDGER]: Object.freeze({
    severity: RECOVERY_SEVERITIES.FATAL,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '账本错误：检查磁盘/权限；不要重放可能已记账的操作。', { tool: 'browser_status', ...MANUAL }),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '交人工核对。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.INTERNAL]: Object.freeze({
    severity: RECOVERY_SEVERITIES.ERROR,
    steps: Object.freeze([
      step('retry', RECOVERY_ACTION_TYPES.RETRY, '内部错误：按退避重试一次。', AUTOMATIC),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '再次失败交人工并附时间线。', { ...MANUAL }),
    ]),
  }),
  [ERROR_CATEGORIES.UNKNOWN]: Object.freeze({
    severity: RECOVERY_SEVERITIES.ERROR,
    steps: Object.freeze([
      step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '未知错误：先收集 browser_status 与 journal 证据，不假设可重试。', { tool: 'browser_status', ...MANUAL }),
      step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '未知错误交人工判断。', { ...MANUAL }),
    ]),
  }),
});

/** 最后兜底（连大类都没有时）。 */
export const FALLBACK_PLAYBOOK = Object.freeze({
  severity: RECOVERY_SEVERITIES.ERROR,
  steps: Object.freeze([
    step('check-daemon-status', RECOVERY_ACTION_TYPES.CHECK_STATUS, '先收集诊断信息（browser_status）。', { tool: 'browser_status', ...MANUAL }),
    step('escalate-human', RECOVERY_ACTION_TYPES.HUMAN, '不要盲目重试，交人工。', { ...MANUAL }),
  ]),
});

/** 把步骤裁剪到上限（保留人工步骤优先级）。 */
function trimSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list.slice(0, RECOVERY_LIMITS.maxSteps);
}

function normalizeHistory(history) {
  const list = Array.isArray(history) ? history.slice(-RECOVERY_LIMITS.maxHistory) : [];
  const ids = new Set();
  for (const item of list) {
    if (typeof item === 'string') ids.add(item);
    else if (item && typeof item === 'object' && typeof item.stepId === 'string') ids.add(item.stepId);
  }
  return ids;
}

/**
 * 单个错误码的剧本（code → pattern → category → fallback）。
 * 注意：terminal 只表示“旧会话/连接不可继续”，不等于 fatal——E_NO_SESSION 建会话即可恢复；
 * 因此 severity 由剧本内容决定，terminal 单独暴露给客户端做决策。
 * @param {string} code E_XXX
 * @returns {{ code:string, category:string, severity:string, terminal:boolean,
 *             source:'code'|'family'|'category'|'fallback',
 *             steps:ReadonlyArray<object>, classification:object }}
 */
export function playbookFor(code) {
  const classification = classifyErrorCode(code);
  const value = classification.code;
  const terminal = TERMINAL_CODES.includes(value);
  if (PLAYBOOK_STEPS[value]) {
    return Object.freeze({
      code: value,
      category: classification.category,
      severity: terminalSeverity(severityForSteps(PLAYBOOK_STEPS[value]), terminal),
      terminal,
      source: 'code',
      steps: trimSteps(PLAYBOOK_STEPS[value]),
      classification,
    });
  }
  for (const rule of PLAYBOOK_PATTERNS) {
    if (!rule.pattern.test(value)) continue;
    return Object.freeze({
      code: value,
      category: classification.category,
      severity: terminalSeverity(rule.severity, terminal),
      terminal,
      source: 'family',
      steps: trimSteps(rule.steps),
      classification,
    });
  }
  const categoryPlaybook = CATEGORY_PLAYBOOKS[classification.category];
  if (categoryPlaybook) {
    return Object.freeze({
      code: value,
      category: classification.category,
      severity: terminalSeverity(categoryPlaybook.severity, terminal),
      terminal,
      source: 'category',
      steps: trimSteps(categoryPlaybook.steps),
      classification,
    });
  }
  return Object.freeze({
    code: value,
    category: classification.category,
    severity: terminalSeverity(RECOVERY_SEVERITIES.ERROR, terminal),
    terminal,
    source: 'fallback',
    steps: trimSteps(FALLBACK_PLAYBOOK.steps),
    classification,
  });
}

/** 终态错误至少是 error 级（信息类剧本如 E_CANCELLED 不受影响）。 */
function terminalSeverity(severity, terminal) {
  if (!terminal) return severity;
  return severity === RECOVERY_SEVERITIES.INFO ? severity : RECOVERY_SEVERITIES.ERROR;
}

function severityForSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.some((item) => item.action === RECOVERY_ACTION_TYPES.STOP)) return RECOVERY_SEVERITIES.INFO;
  if (list.some((item) => item.requiresHuman)) return RECOVERY_SEVERITIES.ERROR;
  return RECOVERY_SEVERITIES.WARN;
}

/**
 * 生成一次性恢复计划。
 *
 * 与 error-map 对齐：
 *   - retryPlan 决定“还能不能自动重试、退避多久”；
 *   - 剧本决定“重试之前要先做什么”；
 *   - history（已执行过的 stepId）会被跳过，避免恢复循环。
 *
 * @param {{code:string, attempt?:number, tool?:string|null, history?:Array,
 *          maxAttempts?:number}} input
 * @returns {{ code:string, category:string, severity:string, terminal:boolean,
 *             source:string, nextStep:(object|null), steps:ReadonlyArray<object>,
 *             exhausted:boolean, escalateToHuman:boolean, retry:object,
 *             summary:string, hint:string }}
 */
export function planRecovery({ code, attempt = 1, tool = null, history = [], maxAttempts = RETRY_POLICY.maxAttempts } = {}) {
  const playbook = playbookFor(code);
  const retry = retryPlan(playbook.code, { attempt, maxAttempts });
  const attempted = normalizeHistory(history);
  const steps = playbook.steps.map((item, index) => {
    const skipped = attempted.has(item.id);
    const isRetry = item.action === RECOVERY_ACTION_TYPES.RETRY;
    const auto = item.auto === true && (!isRetry || retry.retryable);
    return Object.freeze({
      index,
      id: item.id,
      action: item.action,
      note: item.note,
      ...(item.tool ? { tool: item.tool } : {}),
      auto,
      requiresHuman: item.requiresHuman === true,
      skipped,
      // 只有 retry 步需要退避；其它动作（observe/status/...）不需要等待。
      delayMs: isRetry && retry.retryable ? retryDelayMs(Math.max(0, attempt - 1), { code: playbook.code }) : 0,
    });
  });
  const next = steps.find((item) => !item.skipped) || null;
  const humanStep = steps.find((item) => item.action === RECOVERY_ACTION_TYPES.HUMAN && !item.skipped) || null;
  const exhausted = !next;
  const escalateToHuman = exhausted || (retry.attempt >= retry.maxAttempts && Boolean(humanStep)) || playbook.severity === RECOVERY_SEVERITIES.FATAL;
  const summary = buildSummary(playbook, next, { retry, escalateToHuman, exhausted });
  return Object.freeze({
    code: playbook.code,
    category: playbook.category,
    severity: playbook.severity,
    terminal: playbook.terminal,
    source: playbook.source,
    nextStep: next,
    steps: Object.freeze(steps),
    exhausted,
    escalateToHuman,
    retry,
    summary,
    hint: playbook.classification.hint || '',
    needsAction: needsActionBeforeRetry(playbook.code),
    ...(tool ? { tool } : {}),
    attempt: retry.attempt,
  });
}

function buildSummary(playbook, next, { retry, escalateToHuman, exhausted }) {
  const parts = [];
  parts.push(playbook.code + ' 属于 ' + playbook.category + ' 类（' + playbook.severity + '）');
  if (playbook.terminal) parts.push('终态错误：旧会话/连接不可继续，需要重建');
  if (exhausted) parts.push('剧本步骤已全部尝试');
  else if (next) parts.push('下一步：' + next.action + '（' + next.id + '）');
  if (retry.retryable) parts.push('可在 ' + retry.delayMs + 'ms 后自动重试（第 ' + retry.attempt + '/' + retry.maxAttempts + ' 次）');
  else parts.push('不建议自动重试（' + retry.reason + '）');
  if (escalateToHuman) parts.push('需要升级到人工');
  return parts.join('；');
}

/**
 * 有状态恢复会话：客户端可以按 next()/record() 逐步执行剧本，避免“无限重试”。
 *
 * 语义：
 *   - next() 返回当前应执行的步骤；已执行过（record 过）的步骤自动跳过；
 *   - record(stepId, {ok:true}) → 恢复完成（status='recovered'）；
 *   - record(stepId, {ok:false, code}) → 可换绑到新的错误码继续（rebind），或继续下一步；
 *   - 全部步骤走完仍未恢复 → status='exhausted'，escalate=true。
 */
export class RecoverySession {
  constructor({ code, tool = null, maxAttempts = RETRY_POLICY.maxAttempts, history = [], sleep = null } = {}) {
    this.tool = tool;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || RETRY_POLICY.maxAttempts);
    this.plan = planRecovery({ code, attempt: 1, tool, history, maxAttempts: this.maxAttempts });
    this.status = 'running';
    this.attempts = new Map();
    this.outcomes = [];
    this.executed = [];
    this.sleep = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  get code() {
    return this.plan.code;
  }

  /** 下一个应执行步骤；终态返回 { done:true, escalate:boolean }。 */
  next() {
    if (this.status !== 'running') return Object.freeze({ done: true, escalate: this.status === 'exhausted', status: this.status, step: null });
    const steps = this.plan.steps;
    for (const item of steps) {
      if (this.executed.includes(item.id)) continue;
      this.executed.push(item.id);
      const attempt = (this.attempts.get(item.id) || 0) + 1;
      this.attempts.set(item.id, attempt);
      return Object.freeze({ done: false, escalate: false, status: this.status, step: Object.freeze({ ...item, attempt }), plan: this.plan });
    }
    this.status = 'exhausted';
    return Object.freeze({ done: true, escalate: true, status: this.status, step: null, plan: this.plan });
  }

  /** 记录步骤结果。ok=true 直接结束（recovered）；ok=false 时可带新 code 换绑剧本。 */
  record(stepId, { ok = false, code = null, note = '' } = {}) {
    this.outcomes.push(Object.freeze({ stepId: String(stepId), ok: Boolean(ok), code: code == null ? null : String(code), note: String(note || ''), at: new Date().toISOString() }));
    if (ok) {
      this.status = 'recovered';
      return this.snapshot();
    }
    if (code) {
      // 换绑到新错误码：保留已执行历史，重置状态继续跑新剧本。
      this.plan = planRecovery({ code, attempt: this.attempts.size + 1, tool: this.tool, history: this.executed, maxAttempts: this.maxAttempts });
      this.status = 'running';
    }
    return this.snapshot();
  }

  /** 简化执行器：按剧本顺序执行，execute(step) 返回 true 表示恢复成功。 */
  async run(execute) {
    if (typeof execute !== 'function') throw new Error('RecoverySession.run 需要 execute(step) 回调');
    while (this.status === 'running') {
      const cursor = this.next();
      if (cursor.done) break;
      if (cursor.step.delayMs > 0) await this.sleep(cursor.step.delayMs);
      let ok = false;
      try {
        ok = Boolean(await execute(cursor.step));
      } catch (error) {
        this.record(cursor.step.id, { ok: false, code: (error && error.code) || null, note: String((error && error.message) || error) });
        continue;
      }
      this.record(cursor.step.id, { ok });
      if (ok) break;
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      code: this.plan.code,
      tool: this.tool,
      status: this.status,
      escalate: this.status === 'exhausted',
      recovered: this.status === 'recovered',
      attempts: Object.freeze([...this.attempts.entries()].map(([stepId, count]) => Object.freeze({ stepId, count }))),
      executed: Object.freeze([...this.executed]),
      outcomes: Object.freeze([...this.outcomes]),
      plan: this.plan,
    });
  }
}

/**
 * 剧本硬审计（server 启动期 assertRecoveryPlaybooks 与单测共用）。
 * 规则：
 *   - 每个 error-map 大类都有兜底剧本；
 *   - 具体码/族剧本步骤非空、step id 唯一、action 在枚举内；
 *   - 终态错误（TERMINAL_CODES）不允许“自动重试”步骤（可有人工重试）；
 *   - 剧本引用的工具名必须在真实工具集合里（传 toolNames 时校验）；
 *   - 每个剧本最多一个终态 stop，且 stop 之后不再有步骤；
 *   - FATAL 严重度剧本必须包含 human 步骤（不能只让客户端无限重连）。
 * @returns {{ ok:boolean, errors:Array<{code:string,playbook:string,message:string}>, stats:object }}
 */
export function auditRecoveryPlaybooks({ toolNames = null } = {}) {
  const errors = [];
  const push = (code, playbook, message) => errors.push(Object.freeze({ code, playbook: String(playbook || '<none>'), message }));
  const actionValues = new Set(Object.values(RECOVERY_ACTION_TYPES));
  const knownTools = Array.isArray(toolNames) && toolNames.length ? new Set(toolNames.map(String)) : null;

  const validateSteps = (label, steps, { severity, terminal }) => {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length) { push('recovery-empty', label, '剧本没有步骤'); return { steps: 0, human: 0, retry: 0 }; }
    const ids = new Set();
    let human = 0;
    let retry = 0;
    let stopped = false;
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id) push('recovery-step-id', label, '步骤缺 id');
      else if (ids.has(item.id)) push('recovery-step-duplicate', label, '步骤 id 重复：' + item.id);
      else ids.add(item.id);
      if (!item || !actionValues.has(item.action)) push('recovery-step-action', label, '未知动作类型：' + (item && item.action));
      if (item && item.action === RECOVERY_ACTION_TYPES.STOP) stopped = true;
      else if (stopped) push('recovery-step-after-stop', label, 'stop 之后不应再有步骤：' + item.id);
      if (item && item.action === RECOVERY_ACTION_TYPES.RETRY) {
        retry += 1;
        if (terminal && item.auto === true) push('recovery-terminal-retry', label, '终态错误不允许自动重试步骤：' + item.id);
      }
      if (item && (item.action === RECOVERY_ACTION_TYPES.HUMAN || item.requiresHuman)) human += 1;
      if (item && item.tool && knownTools && !knownTools.has(item.tool)) push('recovery-tool', label, '剧本引用了不存在的工具：' + item.tool);
      if (item && typeof item.note !== 'string') push('recovery-note', label, '步骤缺可读说明：' + (item && item.id));
      else if (item && item.note.length > RECOVERY_LIMITS.maxNotesLength) push('recovery-note', label, '步骤说明过长：' + item.id);
    }
    if (severity === RECOVERY_SEVERITIES.FATAL && human === 0) push('recovery-fatal-human', label, 'FATAL 剧本必须包含 human 升级步骤');
    return { steps: list.length, human, retry };
  };

  let codePlaybooks = 0;
  let familyPlaybooks = 0;
  let categoryPlaybooks = 0;
  let totalSteps = 0;
  for (const [code, steps] of Object.entries(PLAYBOOK_STEPS)) {
    const report = validateSteps(code, steps, { severity: playbookFor(code).severity, terminal: TERMINAL_CODES.includes(code) });
    codePlaybooks += 1;
    totalSteps += report.steps;
  }
  PLAYBOOK_PATTERNS.forEach((rule, index) => {
    const report = validateSteps('pattern#' + index, rule.steps, { severity: rule.severity, terminal: false });
    familyPlaybooks += 1;
    totalSteps += report.steps;
  });
  for (const [category, playbook] of Object.entries(CATEGORY_PLAYBOOKS)) {
    const report = validateSteps(category, playbook.steps, { severity: playbook.severity, terminal: false });
    categoryPlaybooks += 1;
    totalSteps += report.steps;
  }
  for (const category of Object.values(ERROR_CATEGORIES)) {
    if (!CATEGORY_PLAYBOOKS[category]) push('recovery-category-missing', category, 'error-map 大类没有兜底剧本');
  }
  // 终态码的解析结果必须标 terminal；severity 由剧本内容决定（终态≠必然 fatal）。
  for (const code of TERMINAL_CODES) {
    const playbook = playbookFor(code);
    if (!playbook.terminal) push('recovery-terminal', code, '终态错误没有标记 terminal');
  }
  // 计划生成自检：剧本可被 planRecovery 消费，且 history 能跳过步骤。
  const sample = planRecovery({ code: 'E_STALE_REF' });
  if (!sample.steps.length || !sample.nextStep) push('recovery-plan', 'E_STALE_REF', '计划没有可执行步骤');
  const skipped = planRecovery({ code: 'E_STALE_REF', history: [sample.nextStep.id] });
  if (skipped.nextStep && skipped.nextStep.id === sample.nextStep.id) push('recovery-plan', 'E_STALE_REF', 'history 没有跳过已执行步骤');
  if (planRecovery({ code: 'E_HUMAN_GATE' }).nextStep.action !== RECOVERY_ACTION_TYPES.HUMAN) push('recovery-plan', 'E_HUMAN_GATE', '审批错误的下一步应为 human');
  if (!planRecovery({ code: 'E_DAEMON' }).terminal) push('recovery-plan', 'E_DAEMON', 'E_DAEMON 计划没有标记 terminal');

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    stats: Object.freeze({
      codePlaybooks,
      familyPlaybooks,
      categoryPlaybooks,
      totalSteps,
      categories: Object.values(ERROR_CATEGORIES).length,
      actions: Object.values(RECOVERY_ACTION_TYPES).length,
    }),
  });
}

/** strict 包装：剧本表漂移（大类缺失/引用不存在工具/终态自动重试）时启动即失败。 */
export function assertRecoveryPlaybooks(input) {
  const report = auditRecoveryPlaybooks(input);
  if (!report.ok) {
    throw new Error('MCP 错误恢复剧本审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.playbook + ' ' + error.message).join('\n'));
  }
  return report;
}

/** 恢复剧本能力快照（initialize experimental['browser-bridge/recovery-playbook']）。 */
export function recoverySnapshot({ toolNames = null } = {}) {
  const audit = auditRecoveryPlaybooks({ toolNames });
  return Object.freeze({
    supported: true,
    actions: RECOVERY_ACTION_TYPES,
    severities: RECOVERY_SEVERITIES,
    limits: RECOVERY_LIMITS,
    metaKey: 'browser-bridge/recovery',
    retryPolicy: RETRY_POLICY,
    codePlaybooks: Object.keys(PLAYBOOK_STEPS).length,
    familyPatterns: PLAYBOOK_PATTERNS.length,
    categories: Object.keys(CATEGORY_PLAYBOOKS).length,
    audit: Object.freeze({ ok: audit.ok, errors: audit.errors.length, stats: audit.stats }),
    fields: Object.freeze(['code', 'category', 'severity', 'terminal', 'nextStep', 'steps', 'escalateToHuman', 'retry', 'summary']),
    stateful: Object.freeze({ class: 'RecoverySession', methods: Object.freeze(['next', 'record', 'run', 'snapshot']) }),
  });
}
