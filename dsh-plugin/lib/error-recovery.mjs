// dsh-plugin/lib/error-recovery.mjs —— 错误码 → 模型可执行的下一步（插件侧真源）。
//
// 为什么插件里还要有一份：插件是独立包（npm/link 安装后不保证仓库 lib/ 还在），而模型拿到的
// 是工具结果，不是 CLI 的 stderr。这里的映射把“daemon/CLI 错误码”翻译成结构化的 nextActions
// （调用哪个 browser_* 工具、跑哪条 bridge 命令、还是必须问人），由 lib/tool-output.mjs 渲染进
// 工具输出；tests/unit/plugin-error-recovery.test.mjs 会拿仓库 lib/error-codes.mjs 的权威
// 错误码清单逐条对照，防止两边漂移。
//
// 设计约束：
//   - 每个 code 必须显式登记（含 daemon 侧 auth/pair/transfer 家族），不允许“默认放过”；
//   - retry 语义与 lib/error-codes.mjs 对齐：no / transient / after-action；
//   - nextActions 必须是可执行动作：kind=tool（browser_* 工具）、cli（bridge 命令）、
//     human（必须问用户）、wait（等待/退避）。禁止只写“请重试”。
//   - canFallbackToCli 是直连→CLI 回退的唯一判定点：只有“请求还没到 daemon”的两个码允许回退，
//     避免把已经执行过的动作重放一遍（业务错误/超时不得回退）。
import { DaemonRpcError } from './daemon-rpc.mjs';

/** 重试语义（与 lib/error-codes.mjs 的 retry 取值同义，供渲染层给人读标签）。 */
export const RETRY_POLICIES = Object.freeze({
  no: '不可原样重试：先改调用方式或换方案',
  transient: '瞬时错误：退避后可原样重试',
  'after-action': '先完成一个具体动作，再重试',
});

/** 允许插件从“daemon 直连”回退到 CLI 的唯一错误码集合（请求尚未到达 daemon）。 */
export const FALLBACK_CODES = Object.freeze(['E_DAEMON', 'E_DIRECT_RPC_DISABLED']);

/** @param {unknown} error 错误对象或错误码字符串 */
export function canFallbackToCli(error) {
  const code = typeof error === 'string' ? error : error && error.code;
  return FALLBACK_CODES.includes(code);
}

// ---------------------------------------------------------------------------
// nextAction 构造器：kind 决定模型/用户如何执行，hint 写“为什么+做什么”。
// ---------------------------------------------------------------------------
function tool(target, hint) {
  return { kind: 'tool', target, hint };
}

function cli(command, hint) {
  return { kind: 'cli', target: command, hint };
}

function human(hint) {
  return { kind: 'human', target: null, hint };
}

function wait(hint) {
  return { kind: 'wait', target: null, hint };
}

const observeAgain = () => tool('browser_observe', '重新 observe 取新的 @eN，旧 ref 已失效');
const statusFirst = () => tool('browser_status', '先确认 daemon、浏览器实例与会话仍在');
const stopSession = () => tool('browser_session_stop', '结束当前会话，归还借用的标签页');

const ACTIONS = {};
function define(code, spec) {
  ACTIONS[code] = Object.freeze({
    retry: spec.retry,
    steps: Object.freeze(spec.steps.slice()),
    docs: Object.freeze((spec.docs || []).slice()),
  });
}
function defineGroup(codes, spec) {
  for (const code of codes) define(code, spec);
}

// —— 参数与目标 ——
define('E_BAD_ARG', {
  retry: 'no',
  steps: [observeAgain(), tool('browser_read', '按 kind 重新调用（read|html|extract），不要同时给 ref 与 selector')],
  docs: ['references/actions-guide.md'],
});
define('E_NOT_FOUND', {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_click_backend', '目标在 shadow/iframe 内时用 observe --ax 的 backendNodeId')],
  docs: ['references/actions-guide.md'],
});
define('E_NOT_ACTIONABLE', {
  retry: 'after-action',
  steps: [
    tool('browser_observe', '确认目标 visible/disabled 状态；等它可交互再动作'),
    tool('browser_act', '换一个可交互的父级/等价控件'),
  ],
  docs: ['references/interaction-details.md'],
});
define('E_STALE_REF', {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_act', '用新 ref 重新执行原动作；不要重放旧 ref')],
  docs: ['references/actions-guide.md'],
});
define('E_OPTION_NOT_FOUND', {
  retry: 'after-action',
  steps: [
    tool('browser_read', 'kind:html 读该 select 的真实 option value'),
    tool('browser_act', 'action:select 用 option 的 value（不是可见文本）'),
  ],
  docs: ['references/interaction-details.md'],
});
define('E_OPTION_AMBIGUOUS', {
  retry: 'no',
  steps: [tool('browser_read', '读 option 列表后用唯一 value 重新 select')],
  docs: ['references/interaction-details.md'],
});
define('E_UNKNOWN_METHOD', {
  retry: 'no',
  steps: [tool('browser_status', '确认 daemon/扩展版本匹配'), cli('bridge doctor', '版本不匹配时升级 CLI/扩展')],
  docs: ['references/environment.md'],
});

// —— 会话与并发 ——
define('E_NO_SESSION', {
  retry: 'after-action',
  steps: [tool('browser_session_start', '开始会话（要动用户标签页先 browser_tab_borrow）'), tool('browser_status', '确认已有会话可复用')],
  docs: ['references/transactions.md'],
});
define('E_SESSION_BUSY', {
  retry: 'transient',
  steps: [wait('同一会话有进行中的操作：等前一个动作结束再调，不要并发抢同一会话')],
  docs: ['references/transactions.md'],
});
define('E_SESSION_PAUSED', {
  retry: 'after-action',
  steps: [human('会话被人工接管：请用户点击“继续/交还”，或改用新会话'), cli('bridge session resume <id>', '人工协助结束后恢复会话')],
  docs: ['references/cooperation.md'],
});
defineGroup(['E_SESSION_STOPPED', 'E_REQUEST_CANCELLED', 'E_CANCELLED'], {
  retry: 'after-action',
  steps: [tool('browser_session_start', '会话已结束/请求已取消：重新开会话并重做步骤'), statusFirst()],
  docs: ['references/transactions.md'],
});
defineGroup(['E_QUEUE_FULL', 'E_RATE_LIMITED', 'E_INPUT_BUSY'], {
  retry: 'transient',
  steps: [wait('队列/限流/输入通道繁忙：退避 1-2 秒再重试，避免并发刷同一会话')],
  docs: ['references/transactions.md'],
});
define('E_NO_TAB', {
  retry: 'after-action',
  steps: [tool('browser_tab', 'action:list 重新取 tabId'), tool('browser_tab_new', '目标页已关闭：新建标签页后重新导航')],
  docs: ['references/tabs-and-profiles.md'],
});
define('E_NO_BROWSER', {
  retry: 'after-action',
  steps: [tool('browser_status', '看是否有实例在线'), human('请用户在 BridgeDeck 扩展里连接浏览器后重试')],
  docs: ['references/environment.md'],
});
define('E_BROWSER_AMBIGUOUS', {
  retry: 'no',
  steps: [tool('browser_status', '从 browsers 列表选实例 id 或设置页名称'), tool('browser_session_start', '显式传 browser 参数')],
  docs: ['references/tabs-and-profiles.md'],
});
defineGroup(['E_START_PENDING', 'E_START_NOT_READY'], {
  retry: 'transient',
  steps: [wait('会话启动中：等 1-2 秒后再发第一个动作，不要重复 session start')],
  docs: ['references/transactions.md'],
});

// —— 观测与上下文 ——
defineGroup(['E_OBSERVATION_STALE', 'E_OBSERVATION_CHANGED', 'E_CURSOR_STALE'], {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_act', '页面已变化：用新观测结果重新构造动作')],
  docs: ['references/actions-guide.md'],
});
define('E_CONTEXT_REQUIRED', {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 取 context_id 后再动作'), observeAgain()],
  docs: ['references/cooperation.md'],
});
define('E_CONTROL_CONTEXT_INVALID', {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 重新取 context_id 后重试'), human('控制面 context 已换代：不要复用旧 context_id')],
  docs: ['references/cooperation.md'],
});
define('E_UNSUPPORTED_FEATURE', {
  retry: 'no',
  steps: [cli('bridge doctor', '查看扩展/协议版本与缺失 feature'), human('升级扩展或去掉该 feature 参数降级执行')],
  docs: ['references/environment.md'],
});
defineGroup(['E_CONTEXT_STALE', 'E_COOPERATION_STALE'], {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 重新对齐观察；导航/人工介入后 context 必失效')],
  docs: ['references/cooperation.md'],
});
define('E_DEPENDS_FAILED', {
  retry: 'after-action',
  steps: [tool('browser_observe', '检查前置步骤是否真的生效'), tool('browser_plan', '拆小 steps 后重新规划，不要整单重放')],
  docs: ['references/transactions.md'],
});
define('E_EXPECT_FAILED', {
  retry: 'no',
  steps: [tool('browser_read', '读取页面实际内容核对断言'), human('断言与预期不符时先与用户确认成功标准')],
  docs: ['references/actions-guide.md'],
});
define('E_TARGET_DETACHED', {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_act', '节点已被移除：用新 ref 或换目标')],
  docs: ['references/actions-guide.md'],
});

// —— 协作租约与 capture 抑制 ——
defineGroup(['E_TOKEN_BAD_ARG', 'E_TOKEN_GRANTEE'], {
  retry: 'no',
  steps: [tool('browser_cooperate', 'action:sync 重新签发 passthrough，并从签发它的 tab 消费')],
  docs: ['references/cooperation.md'],
});
defineGroup(['E_TOKEN_UNKNOWN', 'E_TOKEN_EXPIRED', 'E_TOKEN_USED'], {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 重新申请一次性 passthrough 令牌后再动作')],
  docs: ['references/cooperation.md'],
});
define('E_TOKEN_CAPACITY', {
  retry: 'after-action',
  steps: [wait('令牌存储已满：等旧令牌被驱逐/清理后重新 sync'), tool('browser_status', '排查是否有泄露的持有者')],
  docs: ['references/cooperation.md'],
});
define('E_CAPTURE_BAD_TAB', {
  retry: 'no',
  steps: [tool('browser_tab', 'action:list 取合法 tabId 后重试')],
  docs: ['references/cooperation.md'],
});
define('E_CAPTURE_LIMIT', {
  retry: 'after-action',
  steps: [wait('抑制引用超上限：检查是否有未释放的 withOverlaysHidden，等待其释放')],
  docs: ['references/cooperation.md'],
});

// —— 动作与视觉 ——
define('E_OCCLUDED', {
  retry: 'after-action',
  steps: [
    tool('browser_observe', '看 blocking 层（弹窗/浮层）并先关闭'),
    tool('browser_dialog', '若遮挡来自原生弹窗：arm 策略后重试原动作'),
  ],
  docs: ['references/native-dialogs.md'],
});
define('E_OBSCURED', {
  retry: 'after-action',
  steps: [tool('browser_screenshot', '重新截图确认落点'), tool('browser_act', '换 ref/selector 或滚动后再点')],
  docs: ['references/screenshots-and-canvas.md'],
});
define('E_TARGET_MISMATCH', {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_screenshot', '重新截图核对坐标与目标')],
  docs: ['references/actions-guide.md'],
});
define('E_CAPTURE_STALE', {
  retry: 'after-action',
  steps: [tool('browser_screenshot', '重新截图（旧 capture 已过期）'), statusFirst()],
  docs: ['references/screenshots-and-canvas.md'],
});
define('E_BAD_MODE', {
  retry: 'no',
  steps: [tool('browser_act', '按工具描述选 action 允许的模式（如 drag 的 hold/click-move-click）')],
  docs: ['references/interaction-details.md'],
});
define('E_DIALOG_PENDING', {
  retry: 'after-action',
  steps: [
    tool('browser_dialog', 'action:arm 指定 accept/dismiss 策略（prompt 可给 promptText）'),
    tool('browser_act', '弹窗处理后再重新执行原动作；不要重复原动作'),
  ],
  docs: ['references/native-dialogs.md'],
});
define('E_EXISTS', {
  retry: 'no',
  steps: [human('同名资源已存在：确认是覆盖还是改名，不要盲目 force')],
  docs: ['references/recipes.md'],
});
defineGroup(['E_TARGET_NOT_FILLABLE', 'E_NOT_SELECT'], {
  retry: 'no',
  steps: [tool('browser_read', 'kind:read 读控件类型'), observeAgain(), tool('browser_act', '换 fill/select/click 中匹配目标类型的动作')],
  docs: ['references/interaction-details.md'],
});

// —— 读取与提取 ——
define('E_CACHE_EMPTY', {
  retry: 'after-action',
  steps: [observeAgain(), tool('browser_read', '缓存为空：先产生一次观测/读取再取缓存')],
  docs: ['references/step-and-cache.md'],
});
defineGroup(['E_TOO_LARGE', 'E_RESULT_TOO_LARGE'], {
  retry: 'no',
  steps: [
    tool('browser_observe', '先用 grep 或 vom:false 缩小观察范围'),
    tool('browser_read', 'extract 用 maxRows 分页，或改看部分 selector'),
  ],
  docs: ['references/extraction.md'],
});
defineGroup(['E_JS_ERROR', 'E_PAGE_ERROR'], {
  retry: 'no',
  steps: [tool('browser_eval', '检查表达式/页面上下文后重写；常规操作改用 act/read'), tool('browser_observe', '确认页面状态与全局对象')],
  docs: ['references/interaction-details.md'],
});

// —— 导航与等待 ——
define('E_NAV_FAIL', {
  retry: 'transient',
  steps: [tool('browser_status', '确认会话与浏览器连接'), tool('browser_navigate', '确认 URL 可访问、域名未被策略禁止后重试')],
  docs: ['references/environment.md'],
});
define('E_TIMEOUT', {
  retry: 'after-action',
  steps: [
    statusFirst(),
    tool('browser_observe', '确认页面是否卡住/弹窗未处理；缩小参数范围后重试'),
    human('若页面需要用户登录/验证码，直接求助而不是反复超时'),
  ],
  docs: ['references/help-and-recovery.md'],
});

// —— 调试与网络 ——
define('E_DEBUGGER_BUSY', {
  retry: 'after-action',
  steps: [tool('browser_network', 'action:stop 结束本会话采集'), tool('browser_debug', 'action:stop 结束其它调试后重试')],
  docs: ['references/debugging.md'],
});
defineGroup(['E_UNSUPPORTED_CAPABILITY', 'E_UNSUPPORTED_REMOTE', 'E_PROTOCOL_UNSUPPORTED'], {
  retry: 'no',
  steps: [cli('bridge doctor', '升级 CLI/扩展使协议版本匹配'), human('当前版本不支持该能力：换等价做法或升级')],
  docs: ['references/environment.md'],
});
// 协议审计自检失败（proof obligations / 兼容矩阵 / 迁移计划的不变量不成立）：
// 这是“仓库自证”失败，不是环境问题，重试无意义，必须修不变量。
define('E_PROTOCOL_AUDIT', {
  retry: 'no',
  steps: [cli('bridge doctor', '重新跑协议审计定位失败的 proof/矩阵/计划'), human('按审计报告修复不变量后再发版')],
  docs: ['references/environment.md'],
});

// —— 鉴权/配对/账本（daemon 侧） ——
defineGroup(['E_AUTH', 'E_AUTH_FAILED', 'E_AUTH_PROOF', 'E_AUTH_CHALLENGE', 'E_AUTH_EXPIRED', 'E_AUTH_BUSY', 'E_AUTH_STATE'], {
  retry: 'after-action',
  steps: [cli('bridge daemon pair', '重新生成本机配对码并让用户在扩展里填写'), human('鉴权失败需要本机配对/重新配对，不要绕过')],
  docs: ['references/environment.md'],
});
defineGroup(['E_PAIR_INVALID', 'E_PAIR_REQUIRED'], {
  retry: 'after-action',
  steps: [tool('browser_pair', 'action:create 生成新的 6 位配对码与 wss 地址'), human('让用户在目标浏览器扩展里重新配对')],
  docs: ['references/environment.md'],
});
define('E_PAIR_REJECTED', {
  retry: 'no',
  steps: [human('该 token 已绑定其它浏览器：必须在目标浏览器重新配对，不能复用')],
  docs: ['references/environment.md'],
});
define('E_PAUSED_MANUAL', {
  retry: 'after-action',
  steps: [human('用户正在手动操作：等用户交还控制权后重新同步状态')],
  docs: ['references/cooperation.md'],
});
define('E_LEDGER_PENDING', {
  retry: 'after-action',
  steps: [
    tool('browser_ledger', 'action:status 查 pending 意图与 id'),
    tool('browser_ledger', '确认页面实际状态后 action:resolve（done|abandoned）'),
  ],
  docs: ['references/transactions.md'],
});

// —— 传输与进程（daemon/CLI） ——
defineGroup(['E_DAEMON', 'E_NO_DAEMON', 'E_DAEMON_TIMEOUT', 'E_DISCONNECTED'], {
  retry: 'transient',
  steps: [
    tool('browser_status', '确认 daemon 是否已启动（插件会自动回退 CLI 一次）'),
    cli('bridge doctor', '查看 daemon/扩展连接诊断；必要时按 environment 参考启动 daemon'),
  ],
  docs: ['references/environment.md'],
});
define('E_DIRECT_RPC_DISABLED', {
  retry: 'after-action',
  steps: [cli('bridge status', '直连被 BB_PLUGIN_DIRECT_RPC=0 关闭：插件已回退 CLI，保持默认配置即可恢复直连')],
  docs: ['references/environment.md'],
});
define('E_EXTENSION_GONE', {
  retry: 'after-action',
  steps: [human('扩展已断开：请用户确认浏览器里的 BridgeDeck 扩展已加载并连接'), tool('browser_status', '确认实例重新上线')],
  docs: ['references/environment.md'],
});
defineGroup(['E_LISTEN', 'E_ENV', 'E_CONFIG_INVALID', 'E_MCP_CONFLICT', 'E_APP_SSO_FAILED'], {
  retry: 'after-action',
  steps: [cli('bridge doctor', '环境/配置类失败：按输出修配置或端口冲突，不要反复重试'), human('必要时请用户检查本机环境')],
  docs: ['references/environment.md'],
});
defineGroup(['E_BAD_JSON', 'E_BAD_REQUEST', 'E_INVALID_PARAMS'], {
  retry: 'no',
  steps: [tool('browser_status', '确认请求参数与版本匹配；按工具 schema 重新构造参数')],
  docs: ['references/environment.md'],
});
define('E_RPC', {
  retry: 'transient',
  steps: [statusFirst(), cli('bridge doctor', 'RPC 失败：查看 daemon 日志/健康检查')],
  docs: ['references/environment.md'],
});
defineGroup(['E_SPAWN', 'E_OUTPUT'], {
  retry: 'transient',
  steps: [cli('bridge status', 'CLI 进程/输出异常：确认 node 与 CLI 路径可执行'), statusFirst()],
  docs: ['references/environment.md'],
});
defineGroup(['E_TRANSFER_NOT_FOUND', 'E_TRANSFER_STATE', 'E_TRANSFER_OFFSET', 'E_TRANSFER_LIMIT', 'E_TRANSFER_INCOMPLETE'], {
  retry: 'no',
  steps: [human('文件传输句柄已失效：重新发起上传/下载，不要复用旧 transfer id')],
  docs: ['references/files.md'],
});

// —— 浏览器侧动作实现 ——
defineGroup(['E_BROWSER', 'E_CLICK', 'E_KEY', 'E_FOCUS', 'E_OBSERVE_FAILED', 'E_FOLLOW_FAILED', 'E_RELEASE_INVALID', 'E_UPDATE'], {
  retry: 'after-action',
  steps: [statusFirst(), observeAgain(), human('浏览器侧失败：确认扩展/浏览器状态后可重试一次，不要循环重试')],
  docs: ['references/help-and-recovery.md'],
});
defineGroup(['E_SCREENSHOT', 'E_PREVIEW_META'], {
  retry: 'after-action',
  steps: [statusFirst(), tool('browser_screenshot', '重新截图/预览；仍失败改用 visible 模式')],
  docs: ['references/screenshots-and-canvas.md'],
});

// —— 借用与共享控制 ——
define('E_BORROW_DENIED', {
  retry: 'no',
  steps: [human('用户拒绝了标签页借用：不要绕过，改开独立 Agent 窗口或询问用户')],
  docs: ['references/tabs-and-profiles.md'],
});
define('E_BORROW_CONFLICT', {
  retry: 'after-action',
  steps: [tool('browser_status', '看是否有其它会话占用该 tab'), wait('等当前借用结束或会话 stop 后再试')],
  docs: ['references/tabs-and-profiles.md'],
});
define('E_BORROW_TIMEOUT', {
  retry: 'after-action',
  steps: [human('借用确认超时：请用户点确认后再重试，或改用独立窗口')],
  docs: ['references/tabs-and-profiles.md'],
});
define('E_HELP_DISABLED', {
  retry: 'no',
  steps: [human('人工协助被禁用：自行处理或询问用户是否开启 allowHelp')],
  docs: ['references/help-and-recovery.md'],
});
defineGroup(['E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY'], {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 重新对齐控制权'), wait('等租约到期，或请持有者 handback 后再操作')],
  docs: ['references/cooperation.md'],
});
define('E_CONTROL_STALE', {
  retry: 'after-action',
  steps: [tool('browser_cooperate', 'action:sync 重新读取 epoch 后再操作')],
  docs: ['references/cooperation.md'],
});

// —— 文件与下载 ——
defineGroup(['E_NO_DOWNLOAD', 'E_DOWNLOAD_FAILED', 'E_NO_FILE_CHOOSER', 'E_INCOGNITO_UNAVAILABLE'], {
  retry: 'after-action',
  steps: [human('下载/文件选择器/无痕窗口不可用：确认浏览器设置与场景，再重试触发动作')],
  docs: ['references/files.md'],
});

// —— 配方 ——
define('E_RECIPE_NOT_APPROVED', {
  retry: 'after-action',
  steps: [tool('browser_recipe', 'action:approve 且 confirmHuman=true（审批前先给用户看内容）')],
  docs: ['references/recipes.md'],
});
define('E_RECIPE_CHANGED', {
  retry: 'after-action',
  steps: [tool('browser_recipe', 'action:show 重新核对内容，必要时重新 save+approve')],
  docs: ['references/recipes.md'],
});
defineGroup(['E_RECIPE_EXPIRED', 'E_RECIPE_DRAFT_EMPTY'], {
  retry: 'no',
  steps: [tool('browser_record', '重新录制流程生成新配方草稿')],
  docs: ['references/recipes.md'],
});
define('E_RECIPE_LOCKED', {
  retry: 'transient',
  steps: [wait('另一个 recipe 回放正在进行：等它结束再试，不要删锁文件硬闯')],
  docs: ['references/recipes.md'],
});

// —— 策略与其它 ——
defineGroup(['E_FORBIDDEN', 'E_READ_ONLY'], {
  retry: 'no',
  steps: [human('策略/只读 scope 不允许：换做法、换会话或征得用户同意，不要绕过')],
  docs: ['references/environment.md'],
});
defineGroup(['E_EXEC_FAILED', 'E_INTERNAL'], {
  retry: 'after-action',
  steps: [statusFirst(), human('未分类异常：把错误码与操作序列告诉用户，必要时重新开会话复现')],
  docs: ['references/help-and-recovery.md'],
});

// —— 插件自有码（不在 daemon 错误码清单里） ——
define('E_ABORTED', {
  retry: 'no',
  steps: [human('调用方主动取消：除非用户明确要求，不要自动重试')],
  docs: ['references/offline-testing.md'],
});
define('E_FAKE', {
  retry: 'no',
  steps: [cli('node dsh-plugin/scripts/tool-matrix.mjs --json', '这是 fake adapter 的测试替身错误：检查测试脚本注册的方法')],
  docs: ['references/offline-testing.md'],
});

/** 冻结后的错误码 → 恢复动作表。 */
// —— CLI 参数契约（参数层错误：重试无用，按 help 修正调用） ——
defineGroup(['E_ARG_MISSING', 'E_ARG_TYPE', 'E_ARG_ENUM', 'E_ARG_CONFLICT', 'E_ARG_REQUIRES', 'E_ARG_RANGE',
  'E_ARG_UNEXPECTED', 'E_ARG_USAGE', 'E_UNKNOWN_FLAG', 'E_BAD_SUBCOMMAND'], {
  retry: 'no',
  steps: [
    cli('bridge help', '按 help 里的用法修正参数组合（参数名校验、互斥与依赖）'),
    human('工具调用方修正入参；参数校验不通过时不要重试同一个调用'),
  ],
  docs: ['references/actions-guide.md'],
});
// —— 会话状态 / 账本 WAL / tab 租约 ——
define('E_SESSION_STATE', { retry: 'after-action', steps: [human('先让会话回到 ready（session resume / 重新 start）再动作')], docs: ['references/environment.md'] });
define('E_SESSION_TRANSITION', { retry: 'no', steps: [human('非法状态迁移：按 session 生命周期重新走 start/resume/stop，不要跳步')], docs: ['references/environment.md'] });
defineGroup(['E_LEDGER_IO', 'E_LEDGER_WAL_IO', 'E_LEDGER_FSYNC', 'E_LEDGER_RECOVER'], {
  retry: 'after-action',
  steps: [cli('bridge doctor', '检查磁盘/权限与 daemon 日志，确认账本可写'), human('账本持久化失败：恢复磁盘可用后重试，避免继续派发非幂等动作')],
  docs: ['references/transactions.md'],
});
define('E_LEDGER_RESOLVE_REQUIRED', {
  retry: 'after-action',
  steps: [cli('bridge ledger resolve', '用 --outcome confirmed|not-applied 显式结算该 UNKNOWN 记录后再动作')],
  docs: ['references/transactions.md'],
});
define('E_LEDGER_CONFLICT', { retry: 'no', steps: [human('同一记录已有不同结论：人工核对账本，不要继续重试')], docs: ['references/transactions.md'] });
define('E_TAB_LEASE_HELD', { retry: 'after-action', steps: [tool('browser_tab', '用 action:list 看当前租约持有者，或换 tab/结束占用会话'), cli('bridge session list', '确认哪个会话占用该 tab 后 stop/rebind')], docs: ['references/tabs-and-profiles.md'] });
define('E_TAB_LEASE_NOT_HELD', { retry: 'after-action', steps: [tool('browser_tab', '重新 list 并 claim 该 tab（租约可能已过期）')], docs: ['references/tabs-and-profiles.md'] });
defineGroup(['E_SNAPSHOT_DISABLED', 'E_SNAPSHOT_WRITE', 'E_SNAPSHOT_CORRUPT'], {
  retry: 'after-action',
  steps: [human('MCP 快照落盘异常：检查 BB_HOME 磁盘/权限；必要时清理 mcp-snapshots 后重试')],
  docs: ['references/debugging.md'],
});
define('E_UNSUPPORTED', { retry: 'no', steps: [human('按新能力改用 E_UNSUPPORTED_CAPABILITY 语义的出口，或升级 CLI/扩展')], docs: ['references/environment.md'] });
define('E_HUMAN_GATE', {
  retry: 'after-action',
  steps: [
    human('先让人类确认（审批/接管浮层），确认后再重试该动作'),
  ],
  docs: ['references/cooperation.md'],
});

export const ERROR_ACTIONS = Object.freeze(ACTIONS);

/** 插件自有的、不在 daemon 错误码清单里的码。 */
export const PLUGIN_ONLY_CODES = Object.freeze(['E_ABORTED', 'E_FAKE']);

/** 明确“不可自动重试”的码在渲染时给出更醒目的提示。 */
export function isAutoRetrySafe(code, context = {}) {
  const entry = ERROR_ACTIONS[code];
  if (!entry) return false;
  if (entry.retry !== 'transient') return false;
  // 非幂等工具即使遇到瞬时错误也不该自动重放（可能重复提交）。
  if (context && context.idempotent === false) return false;
  return true;
}

function truncateData(value, cap = 800) {
  if (value === undefined) return undefined;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
  if (text === undefined) return undefined;
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}

/**
 * 取一个错误码的可执行恢复方案。
 * 未登记的码落到 E_INTERNAL 的通用方案，并标记 known:false（测试会阻断 daemon 码走到这里）。
 */
export function nextActionsFor(code, context = {}) {
  const known = Object.prototype.hasOwnProperty.call(ERROR_ACTIONS, code);
  const entry = known ? ERROR_ACTIONS[code] : ERROR_ACTIONS.E_INTERNAL;
  return {
    code,
    known,
    retry: entry.retry,
    retryLabel: RETRY_POLICIES[entry.retry],
    steps: entry.steps.map((step) => ({ ...step })),
    docs: entry.docs.slice(),
    safeToAutoRetry: isAutoRetrySafe(code, context),
  };
}

/**
 * 把任意抛出物规范化为模型可用的失败描述。
 * @param {unknown} error DaemonRpcError / BridgeCliError / Error / 错误码字符串
 * @param {{ tool?: string, idempotent?: boolean, risk?: string, sessionId?: string, message?: string }} [context]
 */
export function describeError(error, context = {}) {
  const code = (typeof error === 'string' && error)
    || (error && typeof error.code === 'string' && error.code)
    || 'E_INTERNAL';
  const message = (typeof error === 'string' ? '' : error && error.message) || code;
  const recovery = nextActionsFor(code, { idempotent: context.idempotent });
  return {
    code,
    message: String(message).slice(0, 1000),
    data: truncateData(typeof error === 'string' ? undefined : error && error.data),
    retry: recovery.retry,
    retryLabel: recovery.retryLabel,
    safeToAutoRetry: recovery.safeToAutoRetry,
    known: recovery.known,
    steps: recovery.steps,
    docs: recovery.docs,
    ...(context.tool ? { tool: context.tool } : {}),
    ...(context.risk ? { risk: context.risk } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
}

/** 供渲染层做快速回归：错误对象是否来自 daemon 直连。 */
export function isDaemonRpcError(error) {
  return error instanceof DaemonRpcError || Boolean(error && error.name === 'DaemonRpcError');
}
