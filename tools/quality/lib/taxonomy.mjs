// tools/quality/lib/taxonomy.mjs —— 可解释性门禁的单一分类表（错误码 + 门禁码）。
//
// 为什么门禁里要有一份分类表：lib/error-codes.mjs 是 daemon 运行时的错误码真源，
// 但它只要求"码有含义"，不保证每个码都有 category / nextAction / retry。
// 质量门禁把"可解释性"变成可执行约束：
//   1) ERROR_CODES 里出现的每个码都必须能在本表分类（新增码不分类 = 门禁失败）；
//   2) 本表不能出现 ERROR_CODES 里没有的码（防漂移，两个方向都查）；
//   3) 当 lib/error-codes.mjs 的 ERROR_RECOVERY 也登记了该码时，retry 语义必须一致
//      （单一真源优先，本表只补 nextAction 与 default 分类）。
//
// 分类是"稳定契约"：改动这里要同步 docs/PROTOCOL.md 的错误码表（由 docs 批次负责）。

import { ERROR_CODES, ERROR_RECOVERY } from '../../../lib/error-codes.mjs';

/** 门禁 finding 的分类：id → 展示名 + 默认处置语义。 */
export const CATEGORIES = Object.freeze({
  determinism: Object.freeze({
    label: '确定性',
    retry: 'after-action',
    nextAction: '找出引入随机/时间/环境依赖的代码，固定 seed 或改为纯函数后重跑门禁',
  }),
  idempotency: Object.freeze({
    label: '幂等',
    retry: 'after-action',
    nextAction: '检查幂等 token 的派生输入与重复执行分支，确保同 token 不产生第二次副作用',
  }),
  explainability: Object.freeze({
    label: '可解释性',
    retry: 'no',
    nextAction: '为错误码/阻断项补 category/nextAction/retry，或在 lib/error-codes.mjs 登记恢复建议',
  }),
  antifragility: Object.freeze({
    label: '反脆弱',
    retry: 'after-action',
    nextAction: '检查超时/取消/预算耗尽路径的清理逻辑，确保结构化失败且无僵尸状态',
  }),
  harness: Object.freeze({
    label: '门禁框架',
    retry: 'no',
    nextAction: '门禁框架自身异常：修复 registry/runner 后重跑（不要绕过门禁）',
  }),
  budget: Object.freeze({
    label: '预算',
    retry: 'after-action',
    nextAction: '提高 --timeout/预算上限，或用 --gate 缩小本次检查范围',
  }),
  consumption: Object.freeze({
    label: '消费点',
    retry: 'after-action',
    nextAction: '更新 tools/quality/lib/consumers.mjs 的运行时消费点，保证 file:line 与符号真实存在',
  }),
  drift: Object.freeze({
    label: '漂移',
    retry: 'no',
    nextAction: '分类表与运行时单一真源不一致：同步 lib/error-codes.mjs 或本分类表后重跑',
  }),
  usage: Object.freeze({
    label: '用法',
    retry: 'no',
    nextAction: '按 --help 修正命令行参数后重跑',
  }),
});

export const RETRY_MODES = Object.freeze(['no', 'transient', 'after-action']);

/** 错误码分类：id → 默认 retry/nextAction（码级 override 见下）。 */
export const ERROR_CATEGORIES = Object.freeze({
  argument: { label: '参数与目标', retry: 'no', nextAction: '核对参数组合并重新 observe 目标（ref/selector 只能二选一）' },
  observation: { label: '观测与上下文', retry: 'after-action', nextAction: '重新 observe / cooperate sync 后使用新 ref 与 context' },
  session: { label: '会话与并发', retry: 'transient', nextAction: '确认会话处于可用状态，稍后重试或重建会话' },
  ledger: { label: '账本与持久化', retry: 'after-action', nextAction: '检查账本/WAL 状态，必要时 ledger resolve 或人工核对页面后再操作' },
  cooperation: { label: '协作租约与控制权', retry: 'after-action', nextAction: '重新申请 passthrough/borrow 或等待控制权租约刷新后再试' },
  auth: { label: '鉴权与配对', retry: 'after-action', nextAction: '重新完成本机配对/鉴权后再调用' },
  protocol: { label: '协议与兼容', retry: 'no', nextAction: '升级/对齐协议版本或改用当前版本支持的能力' },
  transport: { label: '传输与进程', retry: 'transient', nextAction: '确认 daemon/扩展进程存活，检查配置与连接后重试' },
  debug: { label: '调试与网络', retry: 'after-action', nextAction: '停止其它调试会话，释放 debugger 后重试' },
  action: { label: '动作与视觉', retry: 'after-action', nextAction: '确认目标可见、未被遮挡且可操作，必要时重新截图/observe' },
  read: { label: '读取与体积', retry: 'no', nextAction: '缩小读取范围或提高上限（--max-rows / --max-tokens）后重试' },
  navigation: { label: '导航', retry: 'transient', nextAction: '确认 URL 可达、页面未卡死后重试' },
  recipe: { label: '配方', retry: 'after-action', nextAction: '按提示审批/重新生成 recipe，或等待并发的 recipe 回放结束后重试' },
  transfer: { label: '文件与传输', retry: 'after-action', nextAction: '检查传输任务状态/偏移与下载目录后重试' },
  eval: { label: '评测与语料', retry: 'no', nextAction: '修 eval 语料/夹具或运行环境（需要浏览器时先确认浏览器可用）' },
  cli: { label: 'CLI 参数契约', retry: 'no', nextAction: '按 bridge -h / 子命令用法修正命令行后重试' },
  internal: { label: '其它', retry: 'no', nextAction: '记录错误并检查 daemon 日志；不要盲目重试' },
});

/** 码 → 分类组（每个 ERROR_CODES 里的码必须且只能出现一次）。 */
export const ERROR_CODE_GROUPS = Object.freeze({
  argument: [
    'E_BAD_ARG', 'E_NOT_FOUND', 'E_NOT_ACTIONABLE', 'E_STALE_REF', 'E_OPTION_NOT_FOUND',
    'E_OPTION_AMBIGUOUS', 'E_UNKNOWN_METHOD',
  ],
  observation: [
    'E_OBSERVATION_STALE', 'E_CURSOR_STALE', 'E_CONTEXT_REQUIRED', 'E_CONTEXT_STALE',
    'E_OBSERVATION_CHANGED', 'E_TARGET_DETACHED', 'E_DEPENDS_FAILED', 'E_EXPECT_FAILED',
  ],
  session: [
    'E_NO_SESSION', 'E_SESSION_BUSY', 'E_SESSION_PAUSED', 'E_SESSION_STOPPED', 'E_QUEUE_FULL',
    'E_RATE_LIMITED', 'E_CANCELLED', 'E_REQUEST_CANCELLED', 'E_INPUT_BUSY', 'E_NO_TAB',
    'E_NO_BROWSER', 'E_BROWSER_AMBIGUOUS', 'E_START_PENDING', 'E_START_NOT_READY', 'E_PAUSED_MANUAL',
    'E_SESSION_STATE', 'E_SESSION_TRANSITION',
  ],
  ledger: [
    'E_LEDGER_IO', 'E_LEDGER_WAL_IO', 'E_LEDGER_FSYNC', 'E_LEDGER_RECOVER', 'E_LEDGER_CONFLICT',
    'E_LEDGER_RESOLVE_REQUIRED', 'E_TAB_LEASE_HELD', 'E_TAB_LEASE_NOT_HELD', 'E_LEDGER_PENDING',
    'E_SNAPSHOT_DISABLED', 'E_SNAPSHOT_WRITE', 'E_SNAPSHOT_CORRUPT',
  ],
  cooperation: [
    'E_COOPERATION_STALE', 'E_TOKEN_BAD_ARG', 'E_TOKEN_UNKNOWN', 'E_TOKEN_EXPIRED', 'E_TOKEN_USED',
    'E_TOKEN_GRANTEE', 'E_TOKEN_CAPACITY', 'E_CAPTURE_BAD_TAB', 'E_CAPTURE_LIMIT',
    'E_BORROW_DENIED', 'E_BORROW_CONFLICT', 'E_BORROW_TIMEOUT', 'E_HELP_DISABLED',
    'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_CONTROL_STALE', 'E_HUMAN_GATE', 'E_CONTROL_CONTEXT_INVALID',
  ],
  auth: [
    'E_AUTH', 'E_AUTH_BUSY', 'E_AUTH_CHALLENGE', 'E_AUTH_EXPIRED', 'E_AUTH_FAILED', 'E_AUTH_PROOF',
    'E_AUTH_STATE', 'E_PAIR_INVALID', 'E_PAIR_REQUIRED', 'E_PAIR_REJECTED',
  ],
  protocol: [
    'E_UNSUPPORTED', 'E_PROTOCOL_UNSUPPORTED', 'E_PROTOCOL_AUDIT', 'E_UNSUPPORTED_CAPABILITY', 'E_UNSUPPORTED_FEATURE',
    'E_UNSUPPORTED_REMOTE',
  ],
  transport: [
    'E_DAEMON', 'E_NO_DAEMON', 'E_DAEMON_TIMEOUT', 'E_DISCONNECTED', 'E_EXTENSION_GONE', 'E_LISTEN',
    'E_SPAWN', 'E_ENV', 'E_CONFIG_INVALID', 'E_BAD_JSON', 'E_BAD_REQUEST', 'E_INVALID_PARAMS',
    'E_DIRECT_RPC_DISABLED', 'E_RPC', 'E_OUTPUT',
  ],
  debug: ['E_DEBUGGER_BUSY'],
  action: [
    'E_OCCLUDED', 'E_OBSCURED', 'E_TARGET_MISMATCH', 'E_CAPTURE_STALE', 'E_BAD_MODE', 'E_DIALOG_PENDING',
    'E_EXISTS', 'E_TARGET_NOT_FILLABLE', 'E_NOT_SELECT', 'E_BROWSER', 'E_SCREENSHOT', 'E_PREVIEW_META',
    'E_CLICK', 'E_KEY', 'E_FOCUS', 'E_PAGE_ERROR', 'E_OBSERVE_FAILED', 'E_FOLLOW_FAILED', 'E_JS_ERROR',
  ],
  read: ['E_CACHE_EMPTY', 'E_TOO_LARGE', 'E_RESULT_TOO_LARGE'],
  navigation: ['E_NAV_FAIL', 'E_TIMEOUT'],
  recipe: ['E_RECIPE_NOT_APPROVED', 'E_RECIPE_CHANGED', 'E_RECIPE_EXPIRED', 'E_RECIPE_DRAFT_EMPTY', 'E_RECIPE_LOCKED'],
  transfer: [
    'E_TRANSFER_NOT_FOUND', 'E_TRANSFER_STATE', 'E_NO_DOWNLOAD', 'E_DOWNLOAD_FAILED', 'E_NO_FILE_CHOOSER',
    'E_TRANSFER_OFFSET', 'E_TRANSFER_LIMIT', 'E_TRANSFER_INCOMPLETE', 'E_INCOGNITO_UNAVAILABLE',
  ],
  eval: [
    'E_EVAL_CORPUS', 'E_EVAL_RUNNER', 'E_EVAL_DOM', 'E_EVAL_DOM_ARGS', 'E_EVAL_DOM_BAD_FACTS',
    'E_EVAL_DOM_BAD_JSON', 'E_EVAL_DOM_FIXTURE', 'E_EVAL_DOM_NO_BROWSER', 'E_EVAL_DOM_NO_FACTS',
    'E_EVAL_DOM_NO_MARKER', 'E_EVAL_DOM_SPAWN',
  ],
  cli: [
    'E_ARG_MISSING', 'E_ARG_TYPE', 'E_ARG_ENUM', 'E_ARG_CONFLICT', 'E_ARG_REQUIRES', 'E_ARG_RANGE',
    'E_ARG_UNEXPECTED', 'E_ARG_USAGE', 'E_UNKNOWN_FLAG', 'E_BAD_SUBCOMMAND',
  ],
  internal: ['E_INTERNAL', 'E_FORBIDDEN', 'E_READ_ONLY', 'E_EXEC_FAILED', 'E_UPDATE', 'E_RELEASE_INVALID', 'E_MCP_CONFLICT', 'E_APP_SSO_FAILED'],
});

/** 码级 override：覆盖分类默认的 retry/nextAction（更有信息量的处置建议）。 */
export const ERROR_OVERRIDES = Object.freeze({
  E_STALE_REF: { retry: 'after-action', nextAction: 'ref 已失效：重新 observe 后用新 @eN 重试' },
  E_NOT_FOUND: { retry: 'after-action', nextAction: '重新 observe 确认目标仍在页面中' },
  E_NOT_ACTIONABLE: { retry: 'after-action', nextAction: '等目标可见/启用，或换一个可操作目标' },
  E_OBSERVATION_STALE: { retry: 'after-action', nextAction: '观测过期：重新 observe 后重试' },
  E_OBSERVATION_CHANGED: { retry: 'after-action', nextAction: '页面已变化：重新 observe 后重试' },
  E_CURSOR_STALE: { retry: 'after-action', nextAction: '分页游标过期：从头重新分页读取' },
  E_CONTEXT_STALE: { retry: 'after-action', nextAction: '上下文失效：重新 cooperate sync 取新 context' },
  E_CONTEXT_REQUIRED: { retry: 'after-action', nextAction: '先 cooperate sync 取得 context，再带 --context 调用' },
  E_TARGET_DETACHED: { retry: 'after-action', nextAction: '目标节点已被移除：重新 observe/cooperate sync 后用新 ref' },
  E_DEPENDS_FAILED: { retry: 'no', nextAction: '修复前置步骤失败原因后重跑整条计划' },
  E_EXPECT_FAILED: { retry: 'no', nextAction: '核对页面实际内容与期望值，修正断言或页面' },
  E_SESSION_BUSY: { retry: 'transient', nextAction: '同一会话有进行中的操作：等它结束再重试' },
  E_SESSION_PAUSED: { retry: 'after-action', nextAction: '人工接管中：session resume 后重试' },
  E_NO_SESSION: { retry: 'after-action', nextAction: '先 bridge session start 或 bridge open <url>' },
  E_NO_TAB: { retry: 'after-action', nextAction: 'tab 已被关闭：重新开会话/标签页' },
  E_QUEUE_FULL: { retry: 'transient', nextAction: 'daemon 队列满：稍后退避重试' },
  E_RATE_LIMITED: { retry: 'transient', nextAction: '被限流：退避后重试' },
  E_CANCELLED: { retry: 'no', nextAction: '操作被取消：确认是否主动取消，避免无意义重放' },
  E_REQUEST_CANCELLED: { retry: 'no', nextAction: '请求在排队阶段被取消：重新发起前确认会话状态' },
  E_START_NOT_READY: { retry: 'transient', nextAction: '会话尚未就绪：等 status 变 ready 后重试' },
  E_START_PENDING: { retry: 'transient', nextAction: '会话启动中：等就绪后重试' },
  E_TIMEOUT: { retry: 'after-action', nextAction: '加 --timeout，或先确认页面/daemon 是否卡住' },
  E_NAV_FAIL: { retry: 'transient', nextAction: '确认 URL 可达后重试导航' },
  E_LEDGER_PENDING: { retry: 'after-action', nextAction: '先 ledger resolve <id> --outcome confirmed|not-applied 解锁' },
  E_LEDGER_CONFLICT: { retry: 'no', nextAction: '账本结论冲突：人工核对页面状态，不要用新结论覆盖' },
  E_LEDGER_RESOLVE_REQUIRED: { retry: 'after-action', nextAction: '崩溃恢复后的非幂等动作必须显式 resolve confirmed|not-applied' },
  E_LEDGER_WAL_IO: { retry: 'after-action', nextAction: '检查磁盘空间/权限；账本已降级但内存态仍生效' },
  E_LEDGER_FSYNC: { retry: 'after-action', nextAction: '检查磁盘与文件系统；持久化未确认，勿假定重启后安全' },
  E_LEDGER_IO: { retry: 'after-action', nextAction: '检查账本目录可写性与权限' },
  E_LEDGER_RECOVER: { retry: 'after-action', nextAction: '账本恢复失败：人工检查 ledger.status 后决定 resolve 或丢弃' },
  E_TAB_LEASE_HELD: { retry: 'after-action', nextAction: '等待租约到期，或让持有者 session handoff 给你' },
  E_TAB_LEASE_NOT_HELD: { retry: 'after-action', nextAction: '先获得 tab 租约再操作' },
  E_TOKEN_EXPIRED: { retry: 'after-action', nextAction: 'passthrough 过期：重新申请一次后再试' },
  E_TOKEN_USED: { retry: 'after-action', nextAction: 'passthrough 只能消费一次：重新申请' },
  E_TOKEN_UNKNOWN: { retry: 'after-action', nextAction: 'passthrough 不存在：重新申请' },
  E_TOKEN_GRANTEE: { retry: 'no', nextAction: '令牌绑定的 tab 不匹配：用签发它的 tab 消费' },
  E_CAPTURE_STALE: { retry: 'after-action', nextAction: '截图已失效：重新截图后再用坐标' },
  E_CAPTURE_LIMIT: { retry: 'after-action', nextAction: '抑制引用过多：检查未释放的 withOverlaysHidden' },
  E_OCCLUDED: { retry: 'after-action', nextAction: '先关浮层/弹窗，或用 --force 前确认风险' },
  E_OBSCURED: { retry: 'after-action', nextAction: '落点被遮挡：重新截图取坐标后重试' },
  E_TARGET_MISMATCH: { retry: 'after-action', nextAction: '坐标/视觉落点不是预期目标：重新 observe 或截图' },
  E_DIALOG_PENDING: { retry: 'after-action', nextAction: '先处理原生对话框，再 operation await 取结果' },
  E_RECIPE_NOT_APPROVED: { retry: 'after-action', nextAction: '人工审批：bridge recipe approve <name> --confirm-human' },
  E_RECIPE_EXPIRED: { retry: 'after-action', nextAction: '审批已过期（24h）：重新审批后回放' },
  E_RECIPE_CHANGED: { retry: 'after-action', nextAction: '审批后内容变更：重新审批' },
  E_RECIPE_LOCKED: { retry: 'transient', nextAction: '另一个 recipe 回放进行中：等结束（或清理过期 lock）后重试' },
  E_RECIPE_DRAFT_EMPTY: { retry: 'no', nextAction: '运行日志为空：先执行可回放的步骤再生成草稿' },
  E_NO_DAEMON: { retry: 'after-action', nextAction: 'daemon 未运行：先启动 daemon' },
  E_DAEMON: { retry: 'after-action', nextAction: 'daemon 不可用：先启动或检查连接' },
  E_DAEMON_TIMEOUT: { retry: 'transient', nextAction: 'daemon 无响应：检查负载，稍后重试' },
  E_EXTENSION_GONE: { retry: 'after-action', nextAction: '扩展断开：确认浏览器里的扩展已加载' },
  E_DISCONNECTED: { retry: 'transient', nextAction: '连接断开：稍后重连重试' },
  E_AUTH: { retry: 'after-action', nextAction: '鉴权失败：重新 pair/token 后重试' },
  E_PAIR_REQUIRED: { retry: 'after-action', nextAction: '先完成本机配对（bridge pair）' },
  E_PAIR_REJECTED: { retry: 'no', nextAction: 'token 绑定其它浏览器：在目标浏览器重新配对' },
  E_FORBIDDEN: { retry: 'no', nextAction: '被策略禁止：换做法或征求用户同意' },
  E_READ_ONLY: { retry: 'no', nextAction: '只读会话不能变更：新建 control scope 会话' },
  E_HUMAN_GATE: { retry: 'after-action', nextAction: '等待人工确认完成后再继续' },
  E_BORROW_DENIED: { retry: 'no', nextAction: '用户拒绝借用：不要绕过，先沟通' },
  E_BORROW_CONFLICT: { retry: 'after-action', nextAction: '标签页已被锁定：等借用结束再试' },
  E_BORROW_TIMEOUT: { retry: 'no', nextAction: '借用超时：确认用户在场后重新申请' },
  E_CONTROL_NOT_HELD: { retry: 'after-action', nextAction: '写控制权不在本会话：等租约或让持有者 handoff' },
  E_CONTROL_BUSY: { retry: 'after-action', nextAction: '控制权被他人持有：等租约到期或 handoff' },
  E_CONTROL_STALE: { retry: 'after-action', nextAction: '控制权已换代：重新 session control 读 epoch 再操作' },
  E_HELP_DISABLED: { retry: 'no', nextAction: '人工协助不可用：自行处理或询问用户' },
  E_TOO_LARGE: { retry: 'no', nextAction: '结果过大：缩小范围（--max-rows/--max-tokens）' },
  E_RESULT_TOO_LARGE: { retry: 'no', nextAction: '结果超协议上限：缩小范围或分批读取' },
  E_PROTOCOL_AUDIT: { retry: 'no', nextAction: '协议审计自检失败：按 proof obligations/兼容矩阵报告修复后重跑' },
  E_PROTOCOL_UNSUPPORTED: { retry: 'no', nextAction: '协议版本不兼容：升级客户端/daemon 对齐版本' },
  E_UNSUPPORTED_CAPABILITY: { retry: 'no', nextAction: '当前版本不支持该能力：换能力或升级' },
  E_UNSUPPORTED_REMOTE: { retry: 'no', nextAction: '远程连接不支持：改本机执行' },
  E_DEBUGGER_BUSY: { retry: 'after-action', nextAction: '其它调试会话占用 debugger：先停止它' },
  E_UNKNOWN_METHOD: { retry: 'no', nextAction: '方法名不存在：查 bridge -h 或协议目录' },
  E_ARG_USAGE: { retry: 'no', nextAction: '按 bridge -h 修正命令用法' },
  E_INTERNAL: { retry: 'no', nextAction: '记录错误与 daemon 日志，不要盲目重试' },
  E_JS_ERROR: { retry: 'no', nextAction: '页面内 JS 抛错：检查表达式/页面状态' },
  E_EXEC_FAILED: { retry: 'no', nextAction: 'exec 失败或超时：检查脚本与页面上下文' },
});

/** 由分组 + override 展开成 code → 完整解释。 */
function buildErrorTaxonomy() {
  const table = {};
  for (const [category, codes] of Object.entries(ERROR_CODE_GROUPS)) {
    for (const code of codes) {
      const base = ERROR_CATEGORIES[category];
      const override = ERROR_OVERRIDES[code] || {};
      table[code] = Object.freeze({
        code,
        category,
        label: base.label,
        retry: override.retry || base.retry,
        nextAction: override.nextAction || base.nextAction,
        explicit: Boolean(ERROR_RECOVERY[code]),
      });
    }
  }
  return Object.freeze(table);
}

export const ERROR_TAXONOMY = buildErrorTaxonomy();

export const ERROR_TAXONOMY_VERSION = 1;

/** 质量门禁自身使用的稳定门禁码（每个都必须在下面登记 category/retry/nextAction）。 */
export const QUALITY_CODES = Object.freeze({
  QUALITY_GATE_FAILED: { category: 'antifragility', retry: 'after-action', nextAction: '按 finding 的 detail/evidence 修复后重跑 node tools/quality/run.mjs --check' },
  QUALITY_GATE_TIMEOUT: { category: 'harness', retry: 'after-action', nextAction: '放宽 --timeout，或定位卡死的 gate 后重跑' },
  QUALITY_GATE_CANCELLED: { category: 'harness', retry: 'no', nextAction: '本次检查被主动取消；确认后重新发起完整检查' },
  QUALITY_GATE_THREW: { category: 'harness', retry: 'no', nextAction: 'gate 内部异常：按 detail 修复后重跑（不要忽略异常）' },
  QUALITY_BUDGET_EXHAUSTED: { category: 'budget', retry: 'after-action', nextAction: '提高预算或缩小 --gate 范围，确保所有 gate 都被真实执行' },
  QUALITY_FINDING_UNEXPLAINED: { category: 'explainability', retry: 'no', nextAction: '给 finding 补 category/nextAction/retry，使其可被 CLI 渲染' },
  QUALITY_CONSUMPTION_DRIFT: { category: 'consumption', retry: 'after-action', nextAction: '更新消费者表或修复被引用的符号，保证 file:line 真实可追溯' },
  QUALITY_TAXONOMY_DRIFT: { category: 'drift', retry: 'no', nextAction: '同步 lib/error-codes.mjs 与 tools/quality/lib/taxonomy.mjs 的分类表' },
  QUALITY_DETERMINISM_MISMATCH: { category: 'determinism', retry: 'after-action', nextAction: '定位引入非确定性的输入（时间/随机/键顺序），固定后重跑' },
  QUALITY_DETERMINISM_DETECTOR_BLIND: { category: 'determinism', retry: 'no', nextAction: '确定性探测器对新旧控制样本失效：修复 detector 后用真实样本重验' },
  QUALITY_SEED_UNSTABLE: { category: 'determinism', retry: 'no', nextAction: '检查 seed 派生/夹具生成，确保同 seed 跨进程输出一致' },
  QUALITY_IDEMPOTENCY_VIOLATION: { category: 'idempotency', retry: 'after-action', nextAction: '修复重复执行路径：同 token 必须命中同一结论且不产生第二次副作用' },
  QUALITY_ANTIFRAGILITY_LEAK: { category: 'antifragility', retry: 'after-action', nextAction: '补清理（timer/临时目录/监听器）并让失败结构化后可审计' },
  QUALITY_CHILD_FAILED: { category: 'determinism', retry: 'after-action', nextAction: '跨进程子任务失败：看 child 的 stderr 摘要，修复后重跑' },
  QUALITY_RENDER_UNSUPPORTED: { category: 'explainability', retry: 'no', nextAction: '渲染器拒绝了 finding：补齐必填字段或修复 render.mjs' },
  QUALITY_USAGE: { category: 'usage', retry: 'no', nextAction: '按错误提示修正命令行参数' },
});

/** 取 quality 门禁码的完整解释（未知码抛错，避免"未登记的新码"流出去）。 */
export function qualityCode(code) {
  const entry = QUALITY_CODES[code];
  if (!entry) throw new Error('未登记的 quality 门禁码：' + code);
  return { code, ...entry, categoryLabel: CATEGORIES[entry.category] ? CATEGORIES[entry.category].label : entry.category };
}

export const QUALITY_CODE_LIST = Object.freeze(Object.keys(QUALITY_CODES));

/** 取错误码解释；未分类的码返回 null（由门禁报告 missing）。 */
export function explainErrorCode(code) {
  return ERROR_TAXONOMY[code] || null;
}

/**
 * 校验分类表与运行时单一真源的一致性。
 * 返回问题列表（空数组 = 一致），每条都是 blocking finding 的素材。
 */
export function validateTaxonomy(runtimeCodes = ERROR_CODES, runtimeRecovery = ERROR_RECOVERY) {
  const problems = [];
  const runtimeList = Object.keys(runtimeCodes || {}).sort();
  const taxonomyList = Object.keys(ERROR_TAXONOMY).sort();
  for (const code of runtimeList) {
    if (!ERROR_TAXONOMY[code]) {
      problems.push({ kind: 'missing', code, detail: '运行时错误码没有可解释分类' });
      continue;
    }
    const entry = ERROR_TAXONOMY[code];
    if (!RETRY_MODES.includes(entry.retry)) problems.push({ kind: 'bad-retry', code, detail: 'retry 非法：' + entry.retry });
    if (typeof entry.nextAction !== 'string' || entry.nextAction.trim().length < 4) {
      problems.push({ kind: 'empty-next-action', code, detail: 'nextAction 缺失或过短' });
    }
    if (!ERROR_CATEGORIES[entry.category]) problems.push({ kind: 'bad-category', code, detail: '分类不存在：' + entry.category });
    const recovery = (runtimeRecovery || {})[code];
    if (recovery && recovery.retry && recovery.retry !== entry.retry) {
      problems.push({
        kind: 'retry-drift',
        code,
        detail: '分类 retry=' + entry.retry + ' 与 lib/error-codes.mjs 的 ' + recovery.retry + ' 不一致',
      });
    }
  }
  for (const code of taxonomyList) {
    if (!Object.prototype.hasOwnProperty.call(runtimeCodes || {}, code)) {
      problems.push({ kind: 'stale', code, detail: '分类表里的码已不在运行时错误码真源' });
    }
  }
  // 分组本身必须是单射：同一个码出现在两个分组里会让 override 语义变得含糊。
  const seen = new Map();
  for (const [category, codes] of Object.entries(ERROR_CODE_GROUPS)) {
    for (const code of codes) {
      if (seen.has(code)) problems.push({ kind: 'duplicate-group', code, detail: '同时出现在 ' + seen.get(code) + ' 与 ' + category });
      else seen.set(code, category);
      if (!/^E_[A-Z0-9_]+$/.test(code)) problems.push({ kind: 'bad-code-format', code, detail: '错误码格式非法' });
    }
  }
  for (const code of Object.keys(ERROR_OVERRIDES)) {
    if (!seen.has(code)) problems.push({ kind: 'orphan-override', code, detail: 'override 的码不在任何分组里' });
  }
  return problems;
}

/** 校验 quality 门禁码自身：每个码都要有完整可渲染解释。 */
export function validateQualityCodes() {
  const problems = [];
  for (const [code, entry] of Object.entries(QUALITY_CODES)) {
    if (!/^QUALITY_[A-Z0-9_]+$/.test(code)) problems.push({ kind: 'bad-code-format', code, detail: 'quality 码格式非法' });
    // quality 门禁码使用 finding 分类（CATEGORIES），不是运行时错误码分类（ERROR_CATEGORIES）。
    if (!CATEGORIES[entry.category]) problems.push({ kind: 'bad-category', code, detail: 'category 不存在：' + entry.category });
    if (!RETRY_MODES.includes(entry.retry)) problems.push({ kind: 'bad-retry', code, detail: 'retry 非法：' + entry.retry });
    if (typeof entry.nextAction !== 'string' || entry.nextAction.trim().length < 4) {
      problems.push({ kind: 'empty-next-action', code, detail: 'nextAction 缺失或过短' });
    }
  }
  return problems;
}
