// lib/method-catalog.mjs —— 协议方法单一目录：名称 / owner / effect / 特性门（feature floor）。
//
// 本文件是协议运行时的唯一权威目录，运行时入口全部从这里派生：
// - lib/protocol.mjs 的 METHOD_EFFECT 直接引用 METHOD_EFFECT_TABLE；
// - lib/methods.mjs 的 LOCAL/SESSION/INSTANCE/EXT/SESSION_QUEUE_BYPASS/MUTATING
//   由 OWNER_METHODS / DAEMON_ONLY_METHODS / SESSION_QUEUE_BYPASS_METHODS /
//   LEGACY_MUTATING_METHODS 派生，不再手写方法名清单；
// - lib/protocol-features.mjs 的 FEATURE_MIN_PROTOCOL 由 FEATURE_FLOORS 派生；
// - extension/src/generated/protocol.js 由 tools/gen-protocol.mjs 从这里生成。
//
// 依赖方向是单向的：method-catalog →（无运行时依赖）。本文件不得 import
// lib/protocol.mjs / lib/methods.mjs，否则会形成“目录 ← 手工表”的循环。
// tools/protocol-single-source.mjs 会硬审计依赖方向、派生结果与“运行时已无手工表”。
//
// 历史说明：0.3.0 冻结工作树里手工表曾分散在 protocol.mjs / methods.mjs；
// 收口后这些表已删除，只保留本目录一份事实。

// 能力桶：调用侧展示用的粗分类（不是协议特性门），历史行为保持不变。
const EXPLICIT = {
  observe: 'frames',
  'observe-frames': 'frames',
  snapshot: 'frames',
  'get-html': 'frames',
  click: 'input',
  hover: 'input',
  fill: 'input',
  press: 'input',
  select: 'input',
  drag: 'input',
  wheel: 'input',
  upload: 'input',
  download: 'input',
  'click-point': 'input',
  'shadow.click': 'input',
  'navigate': 'navigation',
  'reload': 'navigation',
  'navigate-back': 'navigation',
  'navigate-forward': 'navigation',
  screenshot: 'capture',
  'longshot': 'capture',
  'video.start': 'capture',
  'video.stop': 'capture',
  'debug.start': 'debug',
  'debug.stop': 'debug',
  'network.replay': 'debug',
  'cooperate.sync': 'cooperation',
  'cooperate.wait': 'cooperation',
  'cooperate.handback': 'cooperation',
  'session.start': 'session',
  'session.stop': 'session',
  'session.rebind': 'session',
  'pair.create': 'remote',
  'pair.redeem': 'remote',
  'pair.revoke': 'remote',
  'pair.renew': 'remote',
};

// 目录行：[方法名, owner, effect]。owner：local=daemon 自处理 / session=需会话 tabId / instance=需实例。
// 顺序沿用 lib/protocol.mjs 的 METHOD_EFFECT 插入顺序，保证生成物逐字节稳定。
const ROWS = [
  ["session.start", "local", "control_plane"],
  ["session.start_tracked", "local", "control_plane"],
  ["session.request_prepare", "local", "control_plane"],
  ["session.request_claim", "local", "control_plane"],
  ["session.request_cancel", "local", "control_plane"],
  ["session.request_status", "local", "passive_read"],
  ["session.stop", "local", "control_plane"],
  ["session.stop_all", "local", "control_plane"],
  ["session.run_log", "local", "passive_read"],
  ["session.list", "local", "control_plane"],
  ["session.rebind", "local", "control_plane"],
  ["session.pause", "local", "control_plane"],
  ["session.resume", "local", "control_plane"],
  ["session.control_status", "local", "control_plane"],
  ["session.claim_control", "local", "control_plane"],
  ["session.release_control", "local", "control_plane"],
  ["session.handoff", "local", "control_plane"],
  ["session.control_mode", "local", "control_plane"],
  ["browsers", "local", "control_plane"],
  ["status", "local", "control_plane"],
  ["settings.get", "local", "control_plane"],
  ["settings.set", "local", "control_plane"],
  ["pair.create", "local", "control_plane"],
  ["pair.list", "local", "control_plane"],
  ["pair.redeem", "local", "control_plane"],
  ["pair.revoke", "local", "control_plane"],
  ["pair.renew", "local", "control_plane"],
  ["local.pair", "local", "control_plane"],
  ["local.trust", "local", "control_plane"],
  ["audit.list", "local", "control_plane"],
  ["operations.list", "local", "control_plane"],
  ["operations.get", "local", "control_plane"],
  ["daemon.stop", "local", "control_plane"],
  ["video.list", "session", "control_plane"],
  ["video.prune", "session", "control_plane"],
  ["record.list", "session", "control_plane"],
  ["debug.history", "session", "control_plane"],
  ["debug.delete", "session", "control_plane"],
  ["diagnostics.ui", "instance", "control_plane"],
  ["transfer.begin", "local", "control_plane"],
  ["transfer.chunk", "local", "control_plane"],
  ["transfer.finish", "local", "control_plane"],
  ["transfer.read", "local", "control_plane"],
  ["transfer.release", "local", "control_plane"],
  ["observe", "session", "passive_read"],
  ["observe-frames", "session", "passive_read"],
  ["snapshot", "session", "passive_read"],
  ["get-html", "session", "passive_read"],
  ["read", "session", "passive_read"],
  ["view", "local", "passive_read"],
  ["extract", "session", "passive_read"],
  ["extract.discover", "session", "passive_read"],
  ["extract.table", "session", "passive_read"],
  ["extract.list", "session", "passive_read"],
  ["console", "session", "passive_read"],
  ["network.list", "session", "passive_read"],
  ["network.detail", "session", "passive_read"],
  ["screenshot", "session", "passive_read"],
  ["screenshot.read", "session", "passive_read"],
  ["screenshot.release", "session", "passive_read"],
  ["debug.current", "session", "passive_read"],
  ["debug.request", "session", "passive_read"],
  ["debug.performance", "session", "passive_read"],
  ["debug.coverage", "session", "passive_read"],
  ["cooperate.sync", "session", "passive_read"],
  ["hover", "session", "transient_input"],
  ["navigate", "session", "browser_mutation"],
  ["reload", "session", "browser_mutation"],
  ["navigate-back", "session", "browser_mutation"],
  ["navigate-forward", "session", "browser_mutation"],
  ["click", "session", "browser_mutation"],
  ["click-backend", "session", "browser_mutation"],
  ["fill", "session", "browser_mutation"],
  ["press", "session", "browser_mutation"],
  ["select", "session", "browser_mutation"],
  ["focus", "session", "browser_mutation"],
  ["blur", "session", "browser_mutation"],
  ["scroll-to", "session", "browser_mutation"],
  ["wheel", "session", "browser_mutation"],
  ["drag", "session", "browser_mutation"],
  ["upload", "session", "browser_mutation"],
  ["download", "session", "browser_mutation"],
  ["evaluate", "session", "browser_mutation"],
  ["webmcp.list", "session", "read"],
  ["webmcp.call", "session", "browser_mutation"],
  ["emulate", "session", "browser_mutation"],
  ["network.start", "session", "browser_mutation"],
  ["network.stop", "session", "browser_mutation"],
  ["debug.start", "session", "browser_mutation"],
  ["debug.stop", "session", "browser_mutation"],
  ["trace.start", "session", "browser_mutation"],
  ["trace.stop", "session", "browser_mutation"],
  ["trace.status", "session", "passive_read"],
  ["pdf", "session", "passive_read"],
  ["refs.negotiate", "session", "passive_read"],
  ["longshot.recover", "session", "passive_read"],
  ["record.start", "session", "browser_mutation"],
  ["record.stop", "session", "browser_mutation"],
  ["video.start", "session", "browser_mutation"],
  ["video.stop", "session", "browser_mutation"],
  ["request-help", "session", "browser_mutation"],
  ["cooperate.wait", "session", "control_plane"],
  ["cooperate.handback", "session", "control_plane"],
  ["cooperate.hold", "session", "control_plane"],
  ["dialog.arm", "session", "browser_mutation"],
  ["dialog.disarm", "session", "browser_mutation"],
  ["dialog.accept", "session", "browser_mutation"],
  ["dialog.dismiss", "session", "browser_mutation"],
  ["tab.list", "instance", "control_plane"],
  ["tab.new", "instance", "browser_mutation"],
  ["tab.policy", "session", "control_plane"],
  ["tab.alias", "instance", "control_plane"],
  ["tab.cleanup", "instance", "browser_mutation"],
  ["tab.close", "instance", "browser_mutation"],
  ["tab.select", "instance", "browser_mutation"],
  ["tab.move", "instance", "browser_mutation"],
  ["tab.borrow", "session", "browser_mutation"],
  ["tab.return", "session", "browser_mutation"],
  ["window.list", "instance", "control_plane"],
  ["window.close", "instance", "browser_mutation"],
  ["window.focus", "instance", "browser_mutation"],
  ["window.resize", "session", "browser_mutation"],
  ["dialog.list", "session", "control_plane"],
  ["dialog.status", "session", "control_plane"],
  ["dialog.handle", "session", "browser_mutation"],
  ["video.status", "session", "control_plane"],
  ["video.fetch", "session", "browser_mutation"],
  ["video.recover", "session", "browser_mutation"],
  ["video.verify", "session", "read"],
  ["video.discard", "session", "browser_mutation"],
  ["record.status", "session", "control_plane"],
  ["network.replay", "session", "browser_mutation"],
  ["network.waterfall", "session", "passive_read"],
  ["debug.capabilities", "session", "control_plane"],
  ["debug.pin", "session", "browser_mutation"],
  ["debug.pinned", "session", "control_plane"],
  ["debugger.detach", "instance", "browser_mutation"],
  ["debugger.simulate-detach", "instance", "browser_mutation"],
  ["screenshot.manual.start", "session", "browser_mutation"],
  ["screenshot.manual.frame", "session", "browser_mutation"],
  ["screenshot.manual.save", "session", "browser_mutation"],
  ["shadow.click", "session", "browser_mutation"],
  ["shadow.read", "session", "passive_read"],
  ["click-point", "session", "browser_mutation"],
  ["control-hint", "instance", "browser_mutation"],
  ["ui.open", "instance", "control_plane"],
  ["operation.await", "session", "passive_read"],
  ["operation.cancel", "session", "control_plane"],
  ["wait-ms", "session", "passive_read"],
  ["wait-for-element", "session", "passive_read"],
  ["wait-for-navigation", "session", "passive_read"],
  ["actionable", "session", "passive_read"],
  ["plan", "session", "control_plane"],
  ["step", "session", "browser_mutation"],
  ["debug.rule_add", "session", "browser_mutation"],
  ["debug.rule_clear", "session", "browser_mutation"],
  ["debug.rule_enable", "session", "browser_mutation"],
  ["debug.rule_disable", "session", "browser_mutation"],
  ["debug.rule_remove", "session", "browser_mutation"],
  ["debug.rule_import", "session", "browser_mutation"],
  ["debug.rule_list", "session", "passive_read"],
  ["debug.rule_export", "session", "passive_read"],
  ["debug.fetch_probe", "session", "browser_mutation"],
  ["window.ensureAgent", "instance", "browser_mutation"],
  ["window.newAgent", "instance", "browser_mutation"],
];

// daemon 内部生命周期/账本方法：不进入扩展 wire 协议，故不计入 165 canonical。
export const DAEMON_ONLY_METHODS = Object.freeze([
  'command.cancel',
  'inflight.list',
  'ledger.resolve',
  'ledger.status',
  'pair.rotate',
  // 兼容目标 0.5.0 对齐：通用取消（cancel { rpc_id }）与通用账本入口（ledger.request）。
  // 两者都由 daemon 本地处理：cancel 把 rpc_id 解析到 daemon→扩展的 in-flight 命令并转发
  // WS cancel；ledger.request 把 action=status|resolve 映射到既有意图账本能力。
  'cancel',
  'ledger.request',
]);

/**
 * 会话队列旁路方法：这些方法本身在等待/解除另一个命令，不能排在它后面，否则会死锁。
 * 这是协议运行时事实（与 owner/effect 同类），在目录声明一次；
 * lib/methods.mjs 的 SESSION_QUEUE_BYPASS 只做派生。
 */
export const SESSION_QUEUE_BYPASS_METHODS = Object.freeze([
  'operation.await', 'operation.cancel',
  'dialog.status', 'dialog.accept', 'dialog.dismiss',
  'cooperate.wait', 'cooperate.handback', 'cooperate.sync',
  'wait-for-navigation',
  'debug.fetch_probe',
  'request-help',
  'session.pause', 'session.resume', 'session.rebind',
]);

/**
 * 历史别名的变异判定：这些方法名从未进入 canonical 目录（旧 CLI/脚本别名），
 * 但仍可能出现在账本/预检路径上。保留其“变异”判定，避免收口时行为回退；
 * 与 canonical 方法名互斥（validateRuntimeLists 会校验）。
 */
export const LEGACY_MUTATING_METHODS = Object.freeze([
  'back', 'debug.replay', 'forward', 'type', 'window.ensure', 'window.new',
]);

// ---------------------------------------------------------------------------
// 协议兼容基线：1.8 客户端仍然可以连接（同 major minor 偏斜），但所有 1.9 特性门
// 都会被 daemon 的派发前 preflight 拒绝。新增 gated 能力时必须同时给 floor。
// ---------------------------------------------------------------------------
export const PROTOCOL_BASELINE = '1.8';
export const PROTOCOL_CURRENT = '1.9';

/**
 * 特性门 → 对端扩展至少需要的协议版本（唯一源）。
 * 十五个门：5 个参数级/方法级旧门 + 4 个真实 gated 能力（video / capture.stream /
 * debug.journal / har）+ 6 个 兼容目标 0.5.0 对齐门（借用确认超时 / 人工介入策略 /
 * 无痕会话 / 对话框控制 / click-move-click / 目标控制策略）。
 * lib/protocol-features.mjs 只能从这里派生，不得另写一份。
 *
 * floor 取值口径：我方协议基线 1.8 / 当前 1.9，新增门统一落在当前批次 1.9——
 * 1.8 基线客户端必须被全部拒绝、1.9 客户端必须全部放行（tools/protocol-single-source
 * 的兼容策略审计逐条校验）。兼容目标 侧原始 floor（daemon/extension 可能不同）记在
 * FEATURE_META.*.compatFloor / compatOperation 里作证据，不改变我方单 floor 模型。
 */
export const FEATURE_FLOORS = Object.freeze({
  unverified: '1.9',
  expect: '1.9',
  read: '1.9',
  'observe-delta': '1.9',
  plan: '1.9',
  video: '1.9',
  'capture.stream': '1.9',
  'debug.journal': '1.9',
  har: '1.9',
  // ---- 兼容目标 0.5.0 对齐：6 个此前缺失的 feature 门 ----
  borrow_confirmation_timeout: '1.9',
  interaction_policy: '1.9',
  incognito_sessions: '1.9',
  dialog_control: '1.9',
  click_move_click: '1.9',
  target_control: '1.9',
});

/**
 * 特性元数据：每个特性门解释自己由什么触发（方法集合 + 参数规则 + 人类可读标签）。
 * FEATURE_META.methods 是方法级门唯一的正向声明；METHOD_FEATURE 由它反向派生，
 * 因此“方法 → 特性”和“特性 → 方法”不会出现两份互相对不上的表。
 */
export const FEATURE_META = Object.freeze({
  unverified: Object.freeze({ label: '未校验执行', kind: 'param', params: Object.freeze(['unverified']), methods: Object.freeze([]) }),
  expect: Object.freeze({ label: '期望断言', kind: 'param', params: Object.freeze(['expect']), methods: Object.freeze([]) }),
  read: Object.freeze({ label: '确定性读取', kind: 'method', params: Object.freeze([]), methods: Object.freeze(['read']) }),
  'observe-delta': Object.freeze({ label: '观察增量', kind: 'param', params: Object.freeze(['delta']), methods: Object.freeze([]) }),
  plan: Object.freeze({ label: '计划执行', kind: 'method', params: Object.freeze([]), methods: Object.freeze(['plan']) }),
  video: Object.freeze({
    label: '视频录制',
    kind: 'method',
    params: Object.freeze([]),
    methods: Object.freeze([
      'video.start', 'video.stop', 'video.status', 'video.list', 'video.fetch',
      'video.discard', 'video.prune', 'video.recover', 'video.verify',
    ]),
  }),
  'capture.stream': Object.freeze({
    label: '流式截图',
    kind: 'method+param',
    params: Object.freeze(['stream', 'segmented', 'staleAttempts']),
    methods: Object.freeze(['screenshot.read', 'screenshot.release', 'longshot.recover']),
  }),
  'debug.journal': Object.freeze({
    label: '调试日志持久化',
    kind: 'method',
    params: Object.freeze([]),
    methods: Object.freeze(['debug.history', 'debug.delete', 'debug.pin', 'debug.pinned']),
  }),
  har: Object.freeze({
    label: 'HAR 重放',
    kind: 'method',
    params: Object.freeze([]),
    methods: Object.freeze(['network.replay']),
  }),
  // -------------------------------------------------------------------------
  // 兼容目标 0.5.0 对齐门。语义与 兼容目标 compatibility.rs 的 Feature 一一对应：
  // 旧扩展会静默忽略这些参数（confirmation_timeout_ms / incognito /
  // control_policy / mode=click-move-click / request-help 转发），所以在派发前
  // 必须用 floor 明确拒绝，而不是“看着成功、实际没生效”。
  // compatFloor/compatOperation 是 兼容目标 侧证据（只作文档/诊断，不参与我方 gate 判定）。
  // -------------------------------------------------------------------------
  borrow_confirmation_timeout: Object.freeze({
    label: '借用确认超时',
    kind: 'param',
    params: Object.freeze(['confirmationTimeoutMs']),
    methods: Object.freeze([]),
    compatFloor: '1.2',
    compatOperation: 'tab borrow --timeout',
  }),
  interaction_policy: Object.freeze({
    label: '人工介入策略',
    kind: 'method',
    params: Object.freeze([]),
    methods: Object.freeze(['request-help']),
    compatFloor: '1.3',
    compatOperation: 'request-help',
  }),
  incognito_sessions: Object.freeze({
    label: '无痕会话',
    kind: 'param',
    params: Object.freeze(['incognito']),
    methods: Object.freeze([]),
    compatFloor: '1.4',
    compatOperation: 'session start --incognito',
  }),
  dialog_control: Object.freeze({
    label: '对话框控制',
    kind: 'method',
    params: Object.freeze([]),
    methods: Object.freeze([
      'dialog.arm', 'dialog.disarm', 'dialog.accept', 'dialog.dismiss', 'dialog.handle',
      'dialog.list', 'dialog.status', 'operation.await', 'operation.cancel',
    ]),
    compatFloor: '1.5',
    compatOperation: 'dialog and operation control',
  }),
  click_move_click: Object.freeze({
    label: '点击-移动-点击拖拽',
    kind: 'param',
    params: Object.freeze(['mode']),
    methods: Object.freeze([]),
    compatFloor: '1.7',
    compatOperation: 'click-move-click',
  }),
  target_control: Object.freeze({
    label: '目标控制策略',
    kind: 'param',
    params: Object.freeze(['control_policy', 'policy']),
    methods: Object.freeze([]),
    compatFloor: '1.8',
    compatOperation: 'target control',
  }),
});

/**
 * 文件传输方法：依赖 daemon 与浏览器同机路径，远程配对实例必须显式拒绝。
 * 属于协议事实（与 owner/effect 同类），在此声明；lib/protocol.mjs 只做判定。
 */
export const FILE_TRANSFER_METHODS = Object.freeze(['upload', 'download']);

/** 方法级特性门（由 FEATURE_META.methods 反向派生；一个方法最多一个方法级门）。 */export const METHOD_FEATURE = Object.freeze(Object.fromEntries(
  Object.entries(FEATURE_META).flatMap(([feature, meta]) => meta.methods.map((method) => [method, feature])),
));

/**
 * 参数级特性门：满足对应的参数形态就要求该特性。
 * - true           该参数必须严格等于 true
 * - defined        该参数出现即要求（例如显式 staleAttempts / confirmationTimeoutMs）
 * - non-empty-array 非空数组
 * - equals         字符串参数必须等于 value（兼容目标 的 FeatureWhen::Equals / ControlPolicy）
 * methods 省略表示对所有方法生效。
 */
export const FEATURE_PARAM_RULES = Object.freeze([
  Object.freeze({ feature: 'unverified', param: 'unverified', kind: 'true' }),
  Object.freeze({ feature: 'expect', param: 'expect', kind: 'non-empty-array' }),
  Object.freeze({ feature: 'observe-delta', param: 'delta', kind: 'true' }),
  Object.freeze({ feature: 'capture.stream', param: 'stream', kind: 'true', methods: Object.freeze(['screenshot']) }),
  Object.freeze({ feature: 'capture.stream', param: 'segmented', kind: 'true', methods: Object.freeze(['screenshot']) }),
  Object.freeze({ feature: 'capture.stream', param: 'staleAttempts', kind: 'defined', methods: Object.freeze(['screenshot']) }),
  // ---- 兼容目标 0.5.0 对齐：参数触发面 ----
  // 借用确认超时：显式给 confirmationTimeoutMs 才要求该门（与 兼容目标 FeatureWhen::Present 一致）。
  Object.freeze({ feature: 'borrow_confirmation_timeout', param: 'confirmationTimeoutMs', kind: 'defined', methods: Object.freeze(['tab.borrow']) }),
  // 无痕会话：session start --incognito 才要求（与 兼容目标 FeatureWhen::True{incognito} 一致）。
  Object.freeze({ feature: 'incognito_sessions', param: 'incognito', kind: 'true', methods: Object.freeze(['session.start', 'session.start_tracked']) }),
  // click-move-click 手势（与 兼容目标 FeatureWhen::Equals{mode=click-move-click} 一致）。
  Object.freeze({ feature: 'click_move_click', param: 'mode', kind: 'equals', value: 'click-move-click', methods: Object.freeze(['drag']) }),
  // 目标控制：兼容目标 daemon 只在 control_policy=target 时要求；扩展侧 target/auto 都要求。
  // 我方 wire 同时接受 兼容目标 形（control_policy）与自身 policy 字段（cooperate.sync.policy）。
  Object.freeze({ feature: 'target_control', param: 'control_policy', kind: 'equals', value: 'target' }),
  Object.freeze({ feature: 'target_control', param: 'policy', kind: 'equals', value: 'target', methods: Object.freeze(['cooperate.sync']) }),
]);

/** 需要回执/属于“变异”的 effect 集合；receipt 直接由它推导。 */
export const RECEIPT_EFFECTS = Object.freeze(['transient_input', 'browser_mutation']);
// 历史遗留：少量 control_plane 方法仍要预写意图账本（与 lib/methods.mjs 的 CONTROL_MUTATING/MUTATING 一致）。
export const MUTATING_OVERRIDES = Object.freeze(['session.start', 'session.start_tracked', 'session.stop', 'session.rebind', 'session.pause', 'plan']);

/** 所有扩展方法请求的公共信封字段（daemon 注入）；schema 与生成物由它派生，不再各写一份。 */
export const REQUEST_ENVELOPE_KEYS = Object.freeze(['session', 'sessionId', 'tabId']);

// ---------------------------------------------------------------------------
// 方法状态机（五维）：owner / effect / partial / unknown / reconcile。
//
// - partial：结果可能被截断/分页/分段，调用方必须看结果里的 partial/cursor 而不要当全量。
// - unknown：派发后连接中断/超时时，服务端无法证明是否生效（与意图账本回执同口径：
//   需要回执的变异、以及会重建会话窗口的 control_plane 变异）。只读方法永远 known。
// - reconcile：unknown 之后的收敛策略。
//     none   只读/幂等，无需收敛
//     observe 重新观察页面事实
//     status  调指定只读方法确认（status:<method>）
//     ledger  交给意图账本/会话状态机收敛
// 这些维度全部在 method-catalog 单源声明；生成物与审计只能从本文件派生。
// ---------------------------------------------------------------------------
export const RECONCILE_STRATEGIES = Object.freeze(['none', 'observe', 'status', 'ledger']);

/** 结果可能部分返回的方法（分页/分片/流式）。 */
export const PARTIAL_METHODS = Object.freeze([
  'observe',
  'observe-frames',
  'extract',
  'extract.discover',
  'extract.table',
  'extract.list',
  'console',
  'network.list',
  'network.waterfall',
  'screenshot',
  'screenshot.read',
  'longshot.recover',
]);

/** effect → 默认收敛策略（override 优先）。 */
export const RECONCILE_DEFAULT = Object.freeze({
  passive_read: 'none',
  read: 'none',
  transient_input: 'observe',
  browser_mutation: 'observe',
  control_plane: 'ledger',
});

/**
 * 方法级收敛覆盖：
 * - '<strategy>'            使用该策略
 * - '<strategy>:<method>'   该只读方法可作为收敛证据
 * 未列出的方法按 RECONCILE_DEFAULT 推导（只读 → none）。
 */
export const RECONCILE_OVERRIDES = Object.freeze({
  'video.start': 'status:video.status',
  'video.stop': 'status:video.status',
  'video.fetch': 'status:video.status',
  'video.discard': 'status:video.list',
  'video.recover': 'status:video.status',
  'record.start': 'status:record.status',
  'record.stop': 'status:record.status',
  'debug.start': 'status:debug.current',
  'debug.stop': 'status:debug.current',
  'trace.start': 'status:trace.status',
  'trace.stop': 'status:trace.status',
  'tab.new': 'status:tab.list',
  'tab.close': 'status:tab.list',
  'tab.select': 'status:tab.list',
  'tab.move': 'status:tab.list',
  'tab.cleanup': 'status:tab.list',
  'tab.borrow': 'status:tab.list',
  'tab.return': 'status:tab.list',
  'window.close': 'status:window.list',
  'window.focus': 'status:window.list',
  'window.resize': 'status:window.list',
  'window.ensureAgent': 'status:window.list',
  'window.newAgent': 'status:window.list',
  'dialog.accept': 'status:dialog.status',
  'dialog.dismiss': 'status:dialog.status',
  'dialog.handle': 'status:dialog.status',
});

const RECEIPT_EFFECT_SET = new Set(RECEIPT_EFFECTS);
const MUTATING_OVERRIDE_SET = new Set(MUTATING_OVERRIDES);
const PARTIAL_METHOD_SET = new Set(PARTIAL_METHODS);

const fieldByName = Object.create(null);
for (const row of ROWS) fieldByName[row[0]] = row;

function rowOf(method) {
  return fieldByName[String(method || '')] || null;
}

/** 方法要求的协议 floor；无方法级特性门返回 null。 */
export function floorOf(method) {
  const feature = METHOD_FEATURE[String(method || '')];
  return feature ? FEATURE_FLOORS[feature] : null;
}

/** 目录口径的“是否变异”（供生成物 MUTATING_METHODS 使用）。 */
export function isMutatingInCatalog(method) {
  const row = rowOf(method);
  if (!row) return false;
  return RECEIPT_EFFECT_SET.has(row[2]) || MUTATING_OVERRIDE_SET.has(row[0]);
}

/** 解析一个方法的收敛策略（override → 默认推导）。 */
function reconcileOf(method, effect) {
  const override = RECONCILE_OVERRIDES[method];
  if (override) {
    const [strategy, target = null] = String(override).split(':');
    return Object.freeze({ strategy, method: target || null });
  }
  if (!isMutatingInCatalog(method)) return Object.freeze({ strategy: 'none', method: null });
  const strategy = RECONCILE_DEFAULT[effect] || 'ledger';
  return Object.freeze({ strategy, method: null });
}

/** 单方法的五维状态快照；未知方法返回 null。 */
export function methodStateOf(method) {
  const name = String(method || '');
  const row = CATALOG_BY_METHOD[name];
  if (!row) return null;
  return Object.freeze({
    owner: row.owner,
    effect: row.effect,
    partial: row.partial,
    unknown: row.unknown,
    reconcile: row.reconcile,
  });
}

/** 状态机不变量：partial 只能出现在只读方法，unknown 只能出现在“需要回执的变异”上。 */
export function validateMethodStates(rows = METHOD_CATALOG) {
  const errors = [];
  const readEffects = new Set(['passive_read', 'read']);
  const partial = new Set(PARTIAL_METHODS);
  for (const row of rows) {
    const name = row && row.method;
    if (!name) { errors.push('状态行缺少方法名'); continue; }
    if (!OWNER_KINDS_RESOLVED.has(row.owner)) errors.push(name + ' owner 非法：' + row.owner);
    if (!row.effect) errors.push(name + ' effect 为空');
    const mutating = isMutatingInCatalog(name);
    if (row.unknown !== undefined && Boolean(row.unknown) !== mutating) {
      errors.push(name + ' unknown=' + row.unknown + '，目录口径=' + mutating);
    }
    if (row.partial !== undefined && Boolean(row.partial) !== partial.has(name)) {
      errors.push(name + ' partial=' + row.partial + '，目录口径=' + partial.has(name));
    }
    if (row.partial && !readEffects.has(row.effect)) errors.push(name + ' 只有只读方法可以 partial（effect=' + row.effect + '）');
    const reconcile = row.reconcile && typeof row.reconcile === 'object' ? row.reconcile : null;
    if (!reconcile) { errors.push(name + ' 缺少 reconcile 状态'); continue; }
    if (!RECONCILE_STRATEGIES.includes(reconcile.strategy)) errors.push(name + ' reconcile 策略非法：' + reconcile.strategy);
    if (!mutating && reconcile.strategy !== 'none') errors.push(name + ' 非变异方法 reconcile 必须是 none');
    if (mutating && reconcile.strategy === 'none') errors.push(name + ' 变异方法必须有收敛策略');
    if (reconcile.method) {
      const target = CATALOG_BY_METHOD[reconcile.method];
      if (!target) errors.push(name + ' reconcile 目标不在目录：' + reconcile.method);
      else if (target.effect === 'browser_mutation' || target.effect === 'transient_input') {
        errors.push(name + ' reconcile 目标必须是只读方法：' + reconcile.method);
      }
    }
    if (reconcile.strategy === 'status' && !reconcile.method) errors.push(name + ' status 收敛必须给出目标方法');
  }
  return errors;
}
const OWNER_KINDS_RESOLVED = new Set(['local', 'session', 'instance']);

/**
 * 派生清单的不变量校验（纯函数，供 lib/methods.mjs 的 validateMethodRegistry、
 * protocol-check 与单测共用）：
 * - canonical 方法名唯一，owner 只能是 local/session/instance；
 * - 三个 owner 桶两两互斥（local ⊆ canonical local + daemon 专用，扩展方法 ⊆ canonical）；
 * - daemon 专用方法 / 历史变异别名都不得混入 canonical 目录；
 * - 队列旁路方法必须有路由归属，且不得重复；
 * - 方法级特性门的每个方法都在目录里，且 METHOD_FEATURE 的反向映射唯一。
 *
 * lists 参数仅用于测试构造负例（可注入坏的 daemonOnly/legacy/bypass/featureMeta），
 * 生产调用一律使用默认目录。
 */
export function validateRuntimeLists(rows = METHOD_CATALOG, lists = {}) {
  const daemonOnlyList = Array.isArray(lists.daemonOnly) ? lists.daemonOnly : DAEMON_ONLY_METHODS;
  const legacyList = Array.isArray(lists.legacyMutating) ? lists.legacyMutating : LEGACY_MUTATING_METHODS;
  const bypassList = Array.isArray(lists.bypass) ? lists.bypass : SESSION_QUEUE_BYPASS_METHODS;
  const featureMeta = lists.featureMeta && typeof lists.featureMeta === 'object' ? lists.featureMeta : FEATURE_META;
  const methodFeature = lists.methodFeature && typeof lists.methodFeature === 'object' ? lists.methodFeature : METHOD_FEATURE;
  const errors = [];
  const ownerOfName = new Map();
  for (const row of rows) {
    const name = row && row.method;
    if (!name) { errors.push('目录行缺少方法名'); continue; }
    if (ownerOfName.has(name)) errors.push('目录方法重复：' + name);
    else ownerOfName.set(name, row.owner);
    if (!OWNER_KINDS_RESOLVED.has(row.owner)) errors.push('目录方法 ' + name + ' owner 非法：' + row.owner);
  }
  const daemonOnly = new Set(daemonOnlyList);
  if (daemonOnly.size !== daemonOnlyList.length) errors.push('DAEMON_ONLY_METHODS 有重复方法名');
  for (const method of daemonOnlyList) {
    if (ownerOfName.has(method)) errors.push('daemon 专用方法不得进入 canonical 目录：' + method);
  }
  const legacy = new Set(legacyList);
  if (legacy.size !== legacyList.length) errors.push('LEGACY_MUTATING_METHODS 有重复方法名');
  for (const method of legacyList) {
    if (ownerOfName.has(method)) errors.push('历史变异别名不得进入 canonical 目录：' + method);
  }
  const bypass = new Set(bypassList);
  if (bypass.size !== bypassList.length) errors.push('SESSION_QUEUE_BYPASS_METHODS 有重复方法名');
  for (const method of bypassList) {
    if (!ownerOfName.has(method) && !daemonOnly.has(method)) errors.push('队列旁路方法没有路由归属：' + method);
  }
  for (const [feature, meta] of Object.entries(featureMeta)) {
    for (const method of meta.methods) {
      if (!ownerOfName.has(method)) errors.push('特性 ' + feature + ' 引用了目录外方法：' + method);
      if (methodFeature[method] !== feature) errors.push('方法 ' + method + ' 的方法级特性门反向映射不一致');
    }
  }
  return errors;
}

export const METHOD_CATALOG = Object.freeze(ROWS.map(([method, owner, effect]) => Object.freeze({
  method,
  owner,
  effect,
  receipt: RECEIPT_EFFECT_SET.has(effect),
  floor: floorOf(method),
  partial: PARTIAL_METHOD_SET.has(method),
  unknown: isMutatingInCatalog(method),
  reconcile: reconcileOf(method, effect),
})));

export const METHOD_COUNT = METHOD_CATALOG.length;
export const CATALOG_BY_METHOD = Object.freeze(Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row])));
export const METHOD_NAMES = Object.freeze(METHOD_CATALOG.map((row) => row.method));
export const SORTED_METHOD_NAMES = Object.freeze([...METHOD_NAMES].sort());
export const METHOD_EFFECT_TABLE = Object.freeze(Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.effect])));
export const METHOD_OWNER_TABLE = Object.freeze(Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, row.owner])));
export const METHOD_FEATURE_FLOOR = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.filter((row) => row.floor).map((row) => [row.method, row.floor]),
));
export const FEATURE_NAMES = Object.freeze(Object.keys(FEATURE_FLOORS));
export const FEATURE_METHODS = Object.freeze(Object.fromEntries(
  Object.entries(FEATURE_META).map(([feature, meta]) => [feature, [...meta.methods]]),
));
/** 五维状态表：与方法目录同序，生成器原样写出。 */
export const METHOD_STATE = Object.freeze(Object.fromEntries(METHOD_CATALOG.map((row) => [row.method, Object.freeze({
  owner: row.owner,
  effect: row.effect,
  partial: row.partial,
  unknown: row.unknown,
  reconcile: row.reconcile,
})])));
export const METHOD_PARTIAL = Object.freeze(METHOD_CATALOG.filter((row) => row.partial).map((row) => row.method));
export const METHOD_UNKNOWN = Object.freeze(METHOD_CATALOG.filter((row) => row.unknown).map((row) => row.method));
export const METHOD_RECONCILE = Object.freeze(Object.fromEntries(METHOD_CATALOG.map((row) => [
  row.method,
  row.reconcile.method ? row.reconcile.strategy + ':' + row.reconcile.method : row.reconcile.strategy,
])));
export const OWNER_METHODS = Object.freeze({
  local: Object.freeze(METHOD_CATALOG.filter((row) => row.owner === 'local').map((row) => row.method)),
  session: Object.freeze(METHOD_CATALOG.filter((row) => row.owner === 'session').map((row) => row.method)),
  instance: Object.freeze(METHOD_CATALOG.filter((row) => row.owner === 'instance').map((row) => row.method)),
});
// 与 lib/methods.mjs 的 LOCAL_METHODS / EXT_METHODS 对应（含 daemon 专用方法）。
export const DAEMON_METHODS = Object.freeze([...OWNER_METHODS.local, ...DAEMON_ONLY_METHODS]);
export const EXTENSION_METHODS = Object.freeze([...OWNER_METHODS.session, ...OWNER_METHODS.instance]);

/** 方法 owner：local/session/instance；未知方法返回 null。 */
export function ownerOf(method) {
  const name = String(method || '');
  const row = CATALOG_BY_METHOD[name];
  if (row) return row.owner;
  return DAEMON_ONLY_METHODS.includes(name) ? 'local' : null;
}

export function describeMethod(method) {
  const name = String(method || '');
  const row = CATALOG_BY_METHOD[name];
  // 目录外方法（daemon 专用生命周期/账本方法）保持历史默认：effect=control_plane。
  // 之前这里回退查 METHOD_EFFECT；收口后 METHOD_EFFECT 已由目录派生，
  // 直接给默认值即可，既不引入反向依赖，也不改变 daemon 专用方法的展示。
  const effect = row ? row.effect : 'control_plane';
  const state = row ? {
    partial: row.partial,
    unknown: row.unknown,
    reconcile: row.reconcile,
  } : { partial: false, unknown: false, reconcile: Object.freeze({ strategy: 'none', method: null }) };
  return {
    method: name,
    effect,
    feature: EXPLICIT[name] || 'core',
    receipt: RECEIPT_EFFECT_SET.has(effect),
    owner: ownerOf(name),
    floor: floorOf(name),
    partial: state.partial,
    unknown: state.unknown,
    reconcile: state.reconcile,
  };
}

export function listMethods() {
  return SORTED_METHOD_NAMES.map(describeMethod);
}

// ===========================================================================
// 方法可证明性目录（pre / post / effect_state / idempotent / replayable /
// recovery 六面）：仍然只有 lib/method-catalog.mjs 这一份事实。
//
// 为什么需要它：现有的 owner/effect/partial/unknown/reconcile 五维回答
// “谁执行、会不会有副作用、结果可能失败到什么程度、失败后怎么收敛”，但
// 回答不了“调用前必须满足什么、调用后能断言什么、重放安全不安全、看到某个
// 错误码时应该怎么恢复”。这些正是 CLI/MCP 在把错误翻译成“下一步动作”时
// 必须依赖的事实；如果散落在提示文案或人工经验里，就会各自漂移。
//
// 目录模型（全部声明在本文件，其它文件只许派生/消费）：
//   PROOF_RULES          有序族规则：按方法名模式匹配出六面语义
//   PROOF_OVERRIDES      单方法例外（只覆盖真正不适用族规则的方法）
//   RECOVERY_PROFILES    恢复面：族 → 适用错误码集合（错误码本身来自
//                        lib/error-codes.mjs 的登记表，这里不新增码）
//   RECOVERY_PLAYBOOK    错误码 → 恢复动作/重试语义/严重度（与 ERROR_RECOVERY
//                        的 retry 口径一致，由 tests/unit/state-recovery.test.mjs 交叉验证）
//
// 依赖方向不变：本段仍然没有 import；METHOD_PROOF 由 ROWS + 规则派生，
// 生成器不序列化它（extension/src/generated/protocol.js 只保留既有五维），
// 因此 tools/gen-protocol.mjs --check 与 docs 同步门禁不受影响。
// ===========================================================================

/** 前置条件码：调用之前必须成立的事实；判定逻辑在 lib/method-state-machine.mjs。 */
export const PROOF_PRECONDITIONS = Object.freeze({
  'daemon.local': 'daemon 本地方法（不依赖浏览器实例）',
  'instance.connected': '至少有一个已连接的浏览器实例',
  'browser.ready': '浏览器可接受新建标签页/窗口',
  'session.active': '存在活动会话',
  'session.unpaused': '会话未被人工接管暂停',
  'tab.bound': '会话已绑定标签页',
  'tab.controlled': '当前会话持有标签页控制权',
  'target.resolved': '目标 ref/selector/坐标已解析',
  'observation.fresh': 'ref/坐标来自仍然新鲜的观测',
  'recording.active': '录制或视频会话进行中',
  'debugger.idle': '目标标签页没有被其它 debugger 占用',
  'dialog.pending': '存在未处理的原生对话框',
  'transfer.open': '传输会话已打开',
  'network.capturing': '网络抓包进行中',
  'trace.active': 'trace 进行中',
  'plan.approved': '计划已获批准',
  'pair.available': 'daemon 在线且允许配对',
  'artifact.present': '目标制品（截图/视频/记录）存在',
  'cooperation.aligned': '协作上下文已对齐',
  'ui.attached': '扩展 UI 页面已连接',
  'transport.local': 'daemon 与浏览器同机（文件传输前提）',
});

/** 后置条件码：调用成功后调用方可以断言的事实；判定逻辑在 lib/method-state-machine.mjs。 */
export const PROOF_POSTCONDITIONS = Object.freeze({
  'result.returned': '返回结构化结果（成功信封）',
  'read.available': '只读数据可取（可能 partial）',
  'page.mutated': '页面 DOM/焦点/滚动等交互状态已改变',
  'navigation.committed': '导航已提交到目标文档',
  'focus.updated': '焦点状态已更新',
  'scroll.updated': '滚动位置已更新',
  'emulation.updated': '设备/环境模拟已更新',
  'tab.created': '标签页已创建',
  'tab.removed': '标签页已关闭',
  'tab.updated': '标签页属性已更新',
  'window.created': '窗口已创建',
  'window.removed': '窗口已关闭',
  'window.updated': '窗口属性已更新',
  'session.created': '会话已建立',
  'session.removed': '会话已结束',
  'session.updated': '会话状态已更新',
  'artifact.created': '制品已生成',
  'artifact.removed': '制品已删除',
  'artifact.updated': '制品状态已更新',
  'capture.available': '截图/捕获产物可读',
  'recording.active': '录制进行中',
  'recording.inactive': '录制已停止',
  'debugger.attached': '调试器已附着',
  'debugger.detached': '调试器已分离',
  'network.capturing': '网络抓包进行中',
  'network.idle': '网络抓包已停止',
  'dialog.armed': '对话框已布防/撤防',
  'dialog.resolved': '对话框已处理',
  'control.updated': '控制面状态已更新',
  'ledger.committed': '变异已落账/可证明',
  'coordination.updated': '协作状态已更新',
  'transfer.updated': '传输状态已更新',
  'policy.updated': '策略/设置已更新',
  'plan.updated': '计划状态已更新',
});

/** 成功调用会提交到哪一层状态（effect_state）；none 表示纯读/纯控制面，无页面副作用。 */
export const PROOF_EFFECT_STATES = Object.freeze({
  none: '无页面/浏览器副作用（只读或本地状态）',
  session: '会话生命周期状态',
  tab: '标签页集合/属性',
  window: '窗口集合/属性',
  page: '页面 DOM/交互状态',
  navigation: '文档导航状态',
  focus: '焦点状态',
  scroll: '滚动位置',
  dialog: '原生对话框状态',
  capture: '截图/捕获产物',
  video: '视频制品',
  recording: '录制制品',
  transfer: '文件传输会话',
  debugger: '调试器附着状态',
  network: '网络抓包/重放',
  plan: '计划/步骤状态',
  control: 'daemon 控制面状态',
  pairing: '配对/信任关系',
  ui: '扩展 UI 页面',
  policy: '设置/策略',
});

/** 恢复动作：看到某个错误码后调用方应该做什么；由 method-state-machine 展开成计划。 */
export const PROOF_RECOVERY_ACTIONS = Object.freeze({
  'none': '无需恢复（成功路径或不可恢复的终止态）',
  'fix-params': '修正参数组合后重试',
  'reobserve': '重新 observe 获取新鲜 ref/坐标后重试',
  'resync-cooperation': 'cooperate sync 重新对齐协作上下文',
  'reopen-session': '开新会话/标签页后重试',
  'rebind-tab': 'tab list / session rebind 重新绑定标签页',
  'resume-session': 'session resume 取回控制权后重试',
  'release-control': '归还/释放控制权后由持有者继续',
  'resolve-ledger': 'ledger resolve 明确 confirmed|not-applied',
  'upgrade-extension': '升级并重载浏览器扩展后重试',
  'upgrade-cli': '升级 CLI/daemon 到匹配协议后重试',
  'restart-daemon': '重启 daemon 后重试',
  'reconnect-browser': '确认扩展已加载并连上 daemon',
  'wait-human': '等待人工在页面上完成/确认',
  'change-target': '换目标或先让目标可见/可用',
  'free-debugger': '关闭 DevTools/其它 debugger 占用',
  'close-dialog': '先处理原生对话框',
  'clear-transfer': '清理传输会话后重新 begin',
  'retry-download': '重试下载并确认浏览器下载权限',
  'enable-incognito': '在扩展详情里允许 InPrivate/无痕',
  'regenerate-artifact': '重新生成截图/视频等制品',
  'wait-and-retry': '短暂等待后原样重试',
  'abort-no-retry': '不要重试：语义/参数/权限问题',
  'report-and-stop': '停止并报告实际错误与缺失能力',
});

/**
 * 可能发生在“已派发之后”的错误码：这些码本身不能证明动作未生效，重放前必须
 * 观察页面或查账本（与 lib/intent-ledger.mjs 的 UNKNOWN_OUTCOMES 同口径）。
 * 不在此集合里的错误码都发生在派发前/校验阶段，可证明页面没有被改动。
 */
export const UNKNOWN_OUTCOME_CODES = Object.freeze([
  'E_TIMEOUT', 'E_DAEMON_TIMEOUT', 'E_EXTENSION_GONE', 'E_DISCONNECTED', 'E_CANCELLED',
  'E_NAV_FAIL', 'E_JS_ERROR', 'E_PAGE_ERROR', 'E_DOWNLOAD_FAILED', 'E_NO_DOWNLOAD',
  'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_LEDGER_CONFLICT',
]);

/** 该错误码是否可能在副作用已发生之后才返回（= 结果不可证明）。 */
export function isUnknownOutcomeCode(code) {
  return UNKNOWN_OUTCOME_CODES.includes(String(code || ''));
}

/**
 * 所有方法共有的恢复码：任何调用都可能因为参数错误在派发前失败。
 * 族恢复集 = RECOVERY_BASE_CODES + RECOVERY_PROFILES[profile]（method-catalog 内合成）。
 */
export const RECOVERY_BASE_CODES = Object.freeze(['E_BAD_ARG', 'E_INVALID_PARAMS']);

/**
 * 恢复族：族 → 该族方法可能遇到的错误码（顺序稳定）。
 * 错误码必须已在 lib/error-codes.mjs 登记（测试交叉校验），这里只声明“适用性”。
 */
export const RECOVERY_PROFILES = Object.freeze({
  'control-read': Object.freeze(['E_NO_DAEMON', 'E_DAEMON', 'E_DAEMON_TIMEOUT', 'E_AUTH', 'E_AUTH_FAILED', 'E_AUTH_EXPIRED', 'E_CONFIG_INVALID', 'E_UPDATE', 'E_RPC']),
  'control-mutate': Object.freeze(['E_NO_DAEMON', 'E_DAEMON', 'E_DAEMON_TIMEOUT', 'E_AUTH', 'E_AUTH_FAILED', 'E_BAD_ARG', 'E_INVALID_PARAMS', 'E_CONFIG_INVALID', 'E_LEDGER_IO', 'E_LEDGER_WAL_IO', 'E_LEDGER_FSYNC', 'E_LEDGER_RECOVER', 'E_LEDGER_CONFLICT', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_TIMEOUT']),
  'session-lifecycle': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_SESSION_STATE', 'E_SESSION_TRANSITION', 'E_SESSION_STOPPED', 'E_START_PENDING', 'E_START_NOT_READY', 'E_QUEUE_FULL', 'E_RATE_LIMITED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_TIMEOUT', 'E_BROWSER_AMBIGUOUS', 'E_PROTOCOL_UNSUPPORTED']),
  'browser-read': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_SESSION_PAUSED', 'E_PAUSED_MANUAL', 'E_OBSERVATION_STALE', 'E_OBSERVATION_CHANGED', 'E_CURSOR_STALE', 'E_DISCONNECTED', 'E_EXTENSION_GONE', 'E_TIMEOUT', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED']),
  'capture': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_CAPTURE_STALE', 'E_CAPTURE_BAD_TAB', 'E_CAPTURE_LIMIT', 'E_OCCLUDED', 'E_TOO_LARGE', 'E_RESULT_TOO_LARGE', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED']),
  'interaction': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_SESSION_PAUSED', 'E_PAUSED_MANUAL', 'E_OBSERVATION_STALE', 'E_OBSERVATION_CHANGED', 'E_STALE_REF', 'E_NOT_FOUND', 'E_NOT_ACTIONABLE', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS', 'E_NOT_SELECT', 'E_TARGET_NOT_FILLABLE', 'E_TARGET_DETACHED', 'E_TARGET_MISMATCH', 'E_OCCLUDED', 'E_OBSCURED', 'E_DIALOG_PENDING', 'E_FORBIDDEN', 'E_INPUT_BUSY', 'E_SESSION_BUSY', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_EXTENSION_GONE', 'E_CANCELLED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_UNSUPPORTED_CAPABILITY', 'E_UNSUPPORTED_REMOTE', 'E_PROTOCOL_UNSUPPORTED']),
  'navigation': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_SESSION_PAUSED', 'E_NAV_FAIL', 'E_JS_ERROR', 'E_PAGE_ERROR', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_EXTENSION_GONE', 'E_CANCELLED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED']),
  'tab-control': Object.freeze(['E_NO_BROWSER', 'E_NO_TAB', 'E_TAB_LEASE_HELD', 'E_TAB_LEASE_NOT_HELD', 'E_BORROW_DENIED', 'E_BORROW_CONFLICT', 'E_BORROW_TIMEOUT', 'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_CONTROL_STALE', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_UNSUPPORTED_CAPABILITY', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'window-control': Object.freeze(['E_NO_BROWSER', 'E_NO_TAB', 'E_BROWSER_AMBIGUOUS', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_UNSUPPORTED_CAPABILITY', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'dialog-control': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_DIALOG_PENDING', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_UNSUPPORTED_CAPABILITY', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'video-control': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_DEBUGGER_BUSY', 'E_DISCONNECTED', 'E_TIMEOUT', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED', 'E_EXISTS', 'E_RESULT_TOO_LARGE', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'record-control': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_DISCONNECTED', 'E_TIMEOUT', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'debug-control': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_DEBUGGER_BUSY', 'E_DISCONNECTED', 'E_TIMEOUT', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED', 'E_CACHE_EMPTY', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'network-control': Object.freeze(['E_NO_BROWSER', 'E_NO_SESSION', 'E_NO_TAB', 'E_TIMEOUT', 'E_DISCONNECTED', 'E_CACHE_EMPTY', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED']),
  'transfer-control': Object.freeze(['E_TRANSFER_NOT_FOUND', 'E_TRANSFER_STATE', 'E_TRANSFER_OFFSET', 'E_TRANSFER_LIMIT', 'E_TRANSFER_INCOMPLETE', 'E_EXISTS', 'E_TOO_LARGE', 'E_UNSUPPORTED_REMOTE', 'E_NO_FILE_CHOOSER', 'E_NO_DOWNLOAD', 'E_DOWNLOAD_FAILED', 'E_BAD_ARG', 'E_TIMEOUT']),
  'pair-control': Object.freeze(['E_PAIR_INVALID', 'E_PAIR_REQUIRED', 'E_PAIR_REJECTED', 'E_AUTH', 'E_AUTH_FAILED', 'E_AUTH_EXPIRED', 'E_TOKEN_BAD_ARG', 'E_TOKEN_UNKNOWN', 'E_TOKEN_EXPIRED', 'E_TOKEN_USED', 'E_TOKEN_GRANTEE', 'E_TOKEN_CAPACITY']),
  'cooperation': Object.freeze(['E_NO_SESSION', 'E_CONTEXT_REQUIRED', 'E_CONTEXT_STALE', 'E_COOPERATION_STALE', 'E_HELP_DISABLED', 'E_SESSION_PAUSED', 'E_PAUSED_MANUAL', 'E_HUMAN_GATE', 'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_CONTROL_STALE', 'E_TIMEOUT']),
  'plan-control': Object.freeze(['E_NO_SESSION', 'E_DEPENDS_FAILED', 'E_EXPECT_FAILED', 'E_CANCELLED', 'E_REQUEST_CANCELLED', 'E_LEDGER_PENDING', 'E_LEDGER_RESOLVE_REQUIRED', 'E_TIMEOUT']),
  'wait-control': Object.freeze(['E_NO_SESSION', 'E_NO_TAB', 'E_TIMEOUT', 'E_CANCELLED', 'E_REQUEST_CANCELLED', 'E_QUEUE_FULL', 'E_RATE_LIMITED']),
  'operation-control': Object.freeze(['E_NO_SESSION', 'E_NO_TAB', 'E_TIMEOUT', 'E_CANCELLED', 'E_REQUEST_CANCELLED', 'E_QUEUE_FULL']),
  'ui-control': Object.freeze(['E_NO_BROWSER', 'E_DISCONNECTED', 'E_EXTENSION_GONE', 'E_INCOGNITO_UNAVAILABLE', 'E_TIMEOUT']),
  'refs-control': Object.freeze(['E_NO_SESSION', 'E_NO_TAB', 'E_OBSERVATION_STALE', 'E_TIMEOUT', 'E_UNSUPPORTED_CAPABILITY', 'E_PROTOCOL_UNSUPPORTED']),
});

/**
 * 错误码 → 恢复计划。retryable/maxAttempts/severity 是调用方可以直接执行的语义：
 * - severity=recoverable  可自行恢复并重试
 * - severity=needs-user   需要人工/环境变化
 * - severity=fatal        重试无意义，必须修配置/升级/报告
 * 与 lib/error-codes.mjs 的 ERROR_RECOVERY.retry 保持一致（测试交叉校验）。
 */
export const RECOVERY_PLAYBOOK = Object.freeze({
  'E_BAD_ARG': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: '参数缺失/冲突：改参数，不要原样重试' }),
  'E_INVALID_PARAMS': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: '参数非法：按 schema 修正' }),
  'E_UNKNOWN_METHOD': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '方法不在协议目录：换方法或升级组件' }),
  'E_NOT_FOUND': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '目标不在文档里：重新 observe 再定位' }),
  'E_NOT_ACTIONABLE': Object.freeze({ action: 'change-target', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '目标不可操作：等可见/启用或换目标' }),
  'E_STALE_REF': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: 'ref 已失效：重新 observe 取新 ref' }),
  'E_TARGET_DETACHED': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '目标节点已被移除：重新 observe' }),
  'E_TARGET_MISMATCH': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '落点/节点与观测不符：重新 observe/截图' }),
  'E_OBSERVATION_STALE': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '观测过期：重新 observe' }),
  'E_OBSERVATION_CHANGED': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '页面已变化：重新 observe 后重试' }),
  'E_CURSOR_STALE': Object.freeze({ action: 'reobserve', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '分页游标过期：重新取游标' }),
  'E_CAPTURE_STALE': Object.freeze({ action: 'regenerate-artifact', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '捕获已失效：重新截图' }),
  'E_CAPTURE_BAD_TAB': Object.freeze({ action: 'regenerate-artifact', retryable: false, maxAttempts: 0, severity: 'fatal', note: 'capture 引用 tab 非法：检查 tabId' }),
  'E_CAPTURE_LIMIT': Object.freeze({ action: 'regenerate-artifact', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '抑制引用超限：先释放上一次捕获' }),
  'E_OCCLUDED': Object.freeze({ action: 'close-dialog', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '被浮层遮挡：关掉浮层或用显式坐标' }),
  'E_OBSCURED': Object.freeze({ action: 'regenerate-artifact', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '落点被遮挡：重新截图取坐标' }),
  'E_OPTION_NOT_FOUND': Object.freeze({ action: 'change-target', retryable: false, maxAttempts: 0, severity: 'fatal', note: 'select 选项不存在：核对选项文本' }),
  'E_OPTION_AMBIGUOUS': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: '选项文本匹配到多个：给更精确的值' }),
  'E_NOT_SELECT': Object.freeze({ action: 'change-target', retryable: false, maxAttempts: 0, severity: 'fatal', note: '目标不是 select：换方法或换目标' }),
  'E_TARGET_NOT_FILLABLE': Object.freeze({ action: 'change-target', retryable: false, maxAttempts: 0, severity: 'fatal', note: '目标不可填写：换目标' }),
  'E_NO_SESSION': Object.freeze({ action: 'reopen-session', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '没有活动会话：先 session start' }),
  'E_NO_TAB': Object.freeze({ action: 'rebind-tab', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '标签页已关闭：重开会话或 rebind' }),
  'E_NO_BROWSER': Object.freeze({ action: 'reconnect-browser', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '没有已连接浏览器：确认扩展已加载并连上 daemon' }),
  'E_BROWSER_AMBIGUOUS': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '浏览器选择不唯一：显式指定 instance' }),
  'E_SESSION_BUSY': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '同会话有进行中操作：稍等再试' }),
  'E_SESSION_PAUSED': Object.freeze({ action: 'resume-session', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '会话被人工接管：resume 后继续' }),
  'E_PAUSED_MANUAL': Object.freeze({ action: 'resume-session', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '人工暂停中：先取回控制权' }),
  'E_SESSION_STOPPED': Object.freeze({ action: 'reopen-session', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '会话已结束：重新 start' }),
  'E_SESSION_STATE': Object.freeze({ action: 'reopen-session', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '会话状态机拒绝该操作：按状态转移重来' }),
  'E_SESSION_TRANSITION': Object.freeze({ action: 'reopen-session', retryable: false, maxAttempts: 0, severity: 'fatal', note: '非法状态迁移：检查调用顺序' }),
  'E_QUEUE_FULL': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: 'daemon 队列已满：退避后重试' }),
  'E_RATE_LIMITED': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '请求过频：退避后重试' }),
  'E_INPUT_BUSY': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '输入通道忙：按 data.retry_after_ms 等待' }),
  'E_CANCELLED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '操作被取消：先确认是否还要做' }),
  'E_REQUEST_CANCELLED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '排队阶段被取消：重新发起前先确认' }),
  'E_START_PENDING': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '会话启动中：等就绪后重试' }),
  'E_START_NOT_READY': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '会话尚未就绪：稍后重试' }),
  'E_CONTEXT_REQUIRED': Object.freeze({ action: 'resync-cooperation', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '缺协作上下文：先 cooperate sync 取 context' }),
  'E_CONTEXT_STALE': Object.freeze({ action: 'resync-cooperation', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '上下文失效：重新 cooperate sync' }),
  'E_COOPERATION_STALE': Object.freeze({ action: 'resync-cooperation', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '协作 authority 失效：刷新页面/重开会话后 sync' }),
  'E_DEPENDS_FAILED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '前置步骤失败：先修前置步骤' }),
  'E_EXPECT_FAILED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '断言不符：核对页面实际内容再决策' }),
  'E_TIMEOUT': Object.freeze({ action: 'abort-no-retry', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '超时且结果未知：先观察/查账本，不要盲目重放' }),
  'E_DISCONNECTED': Object.freeze({ action: 'reconnect-browser', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '连接断开：重连后确认结果再决定' }),
  'E_EXTENSION_GONE': Object.freeze({ action: 'reconnect-browser', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '扩展断开：确认扩展已加载' }),
  'E_LEDGER_PENDING': Object.freeze({ action: 'resolve-ledger', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '还有未结算条目：先 ledger resolve' }),
  'E_LEDGER_RESOLVE_REQUIRED': Object.freeze({ action: 'resolve-ledger', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '非幂等动作结果 UNKNOWN：必须显式 resolve' }),
  'E_LEDGER_CONFLICT': Object.freeze({ action: 'resolve-ledger', retryable: false, maxAttempts: 0, severity: 'fatal', note: '账本结论冲突：人工核对后 resolve' }),
  'E_LEDGER_IO': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '账本读写失败：检查目录权限/磁盘' }),
  'E_LEDGER_WAL_IO': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'WAL 写入失败：检查磁盘空间' }),
  'E_LEDGER_FSYNC': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'fsync 失败：检查磁盘/权限' }),
  'E_LEDGER_RECOVER': Object.freeze({ action: 'report-and-stop', retryable: false, maxAttempts: 0, severity: 'fatal', note: '崩溃恢复失败：保留账本文件并报告' }),
  'E_TAB_LEASE_HELD': Object.freeze({ action: 'release-control', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'tab 被其它会话租用：等归还或换 tab' }),
  'E_TAB_LEASE_NOT_HELD': Object.freeze({ action: 'rebind-tab', retryable: false, maxAttempts: 0, severity: 'fatal', note: '租约不存在：先 tab borrow 再归还' }),
  'E_BORROW_DENIED': Object.freeze({ action: 'wait-human', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '用户拒绝借用：先确认再借' }),
  'E_BORROW_CONFLICT': Object.freeze({ action: 'change-target', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '借用冲突：换 tab 或等对方结束后再借' }),
  'E_BORROW_TIMEOUT': Object.freeze({ action: 'wait-human', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '借用确认超时：与用户确认，不要绕过' }),
  'E_CONTROL_NOT_HELD': Object.freeze({ action: 'release-control', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '控制权不在本会话：exclusive 模式下不能写' }),
  'E_CONTROL_BUSY': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '控制权切换中：稍后重试' }),
  'E_CONTROL_STALE': Object.freeze({ action: 'release-control', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '控制权租约过期：重新获取' }),
  'E_DIALOG_PENDING': Object.freeze({ action: 'close-dialog', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '有未处理对话框：dialog.accept/dismiss 或用 operation await' }),
  'E_DEBUGGER_BUSY': Object.freeze({ action: 'free-debugger', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'tab 被其它 debugger 占用：先关掉' }),
  'E_INCOGNITO_UNAVAILABLE': Object.freeze({ action: 'enable-incognito', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '扩展未允许无痕模式' }),
  'E_UNSUPPORTED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '不支持的请求：换方法或升级组件' }),
  'E_UNSUPPORTED_CAPABILITY': Object.freeze({ action: 'upgrade-extension', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '扩展缺能力位：升级扩展或换命令' }),
  'E_UNSUPPORTED_REMOTE': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '远程实例不支持文件传输：在浏览器本机执行' }),
  'E_PROTOCOL_UNSUPPORTED': Object.freeze({ action: 'upgrade-extension', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '组件版本不兼容：升级 CLI+daemon+扩展后重连' }),
  'E_EXISTS': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '目标已存在：确认后显式覆盖或改名' }),
  'E_TOO_LARGE': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '数据超过上限：分段或缩小范围' }),
  'E_RESULT_TOO_LARGE': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '结果超过上限：用分页/过滤器' }),
  'E_CACHE_EMPTY': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '缓存为空：先产生数据（observe/start 抓包）' }),
  'E_JS_ERROR': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '页面脚本抛错：修页面/表达式' }),
  'E_PAGE_ERROR': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '页面是错误页：换目标或让用户处理' }),
  'E_NAV_FAIL': Object.freeze({ action: 'wait-and-retry', retryable: true, maxAttempts: 2, severity: 'recoverable', note: '导航失败：确认 URL 可达后重试' }),
  'E_TRANSFER_NOT_FOUND': Object.freeze({ action: 'clear-transfer', retryable: false, maxAttempts: 0, severity: 'fatal', note: '传输会话不存在：重新 begin' }),
  'E_TRANSFER_STATE': Object.freeze({ action: 'clear-transfer', retryable: false, maxAttempts: 0, severity: 'fatal', note: '传输状态不允许该操作：按 begin→chunk→finish 顺序' }),
  'E_TRANSFER_OFFSET': Object.freeze({ action: 'clear-transfer', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '分片偏移不连续：按服务端 offset 续传' }),
  'E_TRANSFER_LIMIT': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '传输超过大小/分片上限：分批传' }),
  'E_TRANSFER_INCOMPLETE': Object.freeze({ action: 'clear-transfer', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '传输未完成：补齐剩余分片' }),
  'E_NO_FILE_CHOOSER': Object.freeze({ action: 'change-target', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '上传未触发文件选择器：确认目标与页面状态' }),
  'E_NO_DOWNLOAD': Object.freeze({ action: 'retry-download', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '下载未触发：确认下载权限与目标' }),
  'E_DOWNLOAD_FAILED': Object.freeze({ action: 'retry-download', retryable: true, maxAttempts: 1, severity: 'recoverable', note: '下载失败：重试并检查网络' }),
  'E_HELP_DISABLED': Object.freeze({ action: 'wait-human', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '人工协助被关闭：用现有登录态继续或报告阻塞' }),
  'E_PAIR_INVALID': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: '配对码/链接非法：重新生成' }),
  'E_PAIR_REQUIRED': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '需要先完成配对' }),
  'E_PAIR_REJECTED': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'needs-user', note: 'token 绑定其它浏览器：在目标浏览器重新配对' }),
  'E_AUTH': Object.freeze({ action: 'upgrade-cli', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '鉴权失败：核对 token/配对' }),
  'E_AUTH_FAILED': Object.freeze({ action: 'upgrade-cli', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '鉴权失败：核对 token/配对' }),
  'E_AUTH_EXPIRED': Object.freeze({ action: 'upgrade-cli', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '鉴权过期：重新配对' }),
  'E_TOKEN_BAD_ARG': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: 'passthrough 参数非法：补 token/grantee' }),
  'E_TOKEN_UNKNOWN': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '租约不存在：重新申请 passthrough' }),
  'E_TOKEN_EXPIRED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '租约过期：重新申请' }),
  'E_TOKEN_USED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '一次性租约已消费：重新申请' }),
  'E_TOKEN_GRANTEE': Object.freeze({ action: 'fix-params', retryable: false, maxAttempts: 0, severity: 'fatal', note: '租约绑定其它 tab：用签发它的 tab 消费' }),
  'E_TOKEN_CAPACITY': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '租约存储满：清理未用租约' }),
  'E_DAEMON': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'daemon 不可用：先启动/修复 daemon' }),
  'E_NO_DAEMON': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'daemon 未运行：先 daemon start' }),
  'E_DAEMON_TIMEOUT': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: 'daemon 超时：检查负载/日志' }),
  'E_CONFIG_INVALID': Object.freeze({ action: 'restart-daemon', retryable: false, maxAttempts: 0, severity: 'fatal', note: '配置非法：修配置后重启' }),
  'E_FORBIDDEN': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '域名/策略禁止：换目标或调整策略' }),
  'E_READ_ONLY': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: '只读作用域拒绝：切到可写作用域' }),
  'E_HUMAN_GATE': Object.freeze({ action: 'wait-human', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '需要人工确认：等确认后重试' }),
  'E_SNAPSHOT_DISABLED': Object.freeze({ action: 'abort-no-retry', retryable: false, maxAttempts: 0, severity: 'fatal', note: 'MCP 快照持久化关闭：开启后重启' }),
  'E_SNAPSHOT_WRITE': Object.freeze({ action: 'restart-daemon', retryable: true, maxAttempts: 1, severity: 'needs-user', note: '快照写盘失败：检查磁盘/权限' }),
  'E_SNAPSHOT_CORRUPT': Object.freeze({ action: 'restart-daemon', retryable: false, maxAttempts: 0, severity: 'fatal', note: '快照文件损坏：清理后重建' }),
  'E_UPDATE': Object.freeze({ action: 'upgrade-cli', retryable: false, maxAttempts: 0, severity: 'needs-user', note: '更新状态异常：按 update 流程处理' }),
  'E_RPC': Object.freeze({ action: 'report-and-stop', retryable: false, maxAttempts: 0, severity: 'fatal', note: 'RPC 层错误：报告日志' }),
});

/** 有序族规则：首个命中的规则决定六面语义；方法名只在本文件出现一次（ROWS）。 */
export const PROOF_RULES = Object.freeze([
  // ---- 会话生命周期 -------------------------------------------------------
  Object.freeze({ id: 'session-start', pattern: '^session\\.(start|start_tracked|request_prepare|request_claim)$', effectState: 'session', idempotent: false, profile: 'session-lifecycle', pre: ['daemon.local', 'browser.ready'], post: ['session.created', 'tab.created'] }),
  Object.freeze({ id: 'session-cancel-request', pattern: '^session\\.request_cancel$', effectState: 'session', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local'], post: ['session.updated'] }),
  Object.freeze({ id: 'session-request-status', pattern: '^session\\.request_status$', effectState: 'none', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'session-stop', pattern: '^session\\.(stop|stop_all)$', effectState: 'session', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local', 'session.active'], post: ['session.removed'] }),
  Object.freeze({ id: 'session-read', pattern: '^session\\.(list|run_log|control_status)$', effectState: 'none', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'session-rebind', pattern: '^session\\.(rebind|handoff)$', effectState: 'session', idempotent: false, profile: 'session-lifecycle', pre: ['daemon.local', 'session.active', 'tab.bound'], post: ['session.updated'] }),
  Object.freeze({ id: 'session-pause', pattern: '^session\\.(pause|resume)$', effectState: 'session', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local', 'session.active'], post: ['session.updated'] }),
  Object.freeze({ id: 'session-control-mode', pattern: '^session\\.(control_mode|claim_control|release_control)$', effectState: 'control', idempotent: true, profile: 'session-lifecycle', pre: ['daemon.local', 'session.active'], post: ['control.updated'] }),
  // ---- daemon 控制面只读/本地 ---------------------------------------------
  Object.freeze({ id: 'control-read', pattern: '^(browsers|status|view|audit\\.list|operations\\.(list|get)|settings\\.get)$', effectState: 'none', idempotent: true, profile: 'control-read', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'settings-set', pattern: '^settings\\.set$', effectState: 'policy', idempotent: true, profile: 'control-mutate', pre: ['daemon.local'], post: ['policy.updated'] }),
  Object.freeze({ id: 'pair-create', pattern: '^pair\\.(create|redeem)$', effectState: 'pairing', idempotent: false, profile: 'pair-control', pre: ['pair.available'], post: ['control.updated'] }),
  Object.freeze({ id: 'pair-read', pattern: '^pair\\.list$', effectState: 'none', idempotent: true, profile: 'pair-control', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'pair-mutate', pattern: '^pair\\.(revoke|renew)$', effectState: 'pairing', idempotent: true, profile: 'pair-control', pre: ['pair.available'], post: ['control.updated'] }),
  Object.freeze({ id: 'local-trust', pattern: '^local\\.(pair|trust)$', effectState: 'pairing', idempotent: true, profile: 'pair-control', pre: ['daemon.local'], post: ['control.updated'] }),
  Object.freeze({ id: 'daemon-stop', pattern: '^daemon\\.stop$', effectState: 'control', idempotent: false, profile: 'control-mutate', pre: ['daemon.local'], post: ['control.updated'] }),
  // ---- 视频 / 录制 / 调试 / 网络 ------------------------------------------
  Object.freeze({ id: 'video-read', pattern: '^video\\.(list|status|verify)$', effectState: 'none', idempotent: true, profile: 'video-control', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'video-start', pattern: '^video\\.(start|recover)$', effectState: 'video', idempotent: false, profile: 'video-control', pre: ['session.active', 'tab.bound'], post: ['recording.active'] }),
  Object.freeze({ id: 'video-stop', pattern: '^video\\.stop$', effectState: 'video', idempotent: true, profile: 'video-control', pre: ['session.active', 'recording.active'], post: ['recording.inactive', 'artifact.updated'] }),
  Object.freeze({ id: 'video-fetch', pattern: '^video\\.(fetch|discard|prune)$', effectState: 'video', idempotent: false, profile: 'video-control', pre: ['daemon.local', 'artifact.present'], post: ['artifact.updated'] }),
  Object.freeze({ id: 'record-read', pattern: '^record\\.(list|status)$', effectState: 'none', idempotent: true, profile: 'record-control', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'record-start', pattern: '^record\\.start$', effectState: 'recording', idempotent: false, profile: 'record-control', pre: ['session.active', 'tab.bound'], post: ['recording.active'] }),
  Object.freeze({ id: 'record-stop', pattern: '^record\\.stop$', effectState: 'recording', idempotent: true, profile: 'record-control', pre: ['session.active', 'recording.active'], post: ['recording.inactive'] }),
  Object.freeze({ id: 'debug-read', pattern: '^debug\\.(history|current|request|performance|coverage|capabilities|pinned)$', effectState: 'none', idempotent: true, profile: 'debug-control', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  Object.freeze({ id: 'debug-lifecycle', pattern: '^debug\\.(start|stop|pin)$', effectState: 'debugger', idempotent: true, profile: 'debug-control', pre: ['session.active', 'tab.bound'], post: ['debugger.attached'] }),
  Object.freeze({ id: 'debug-delete', pattern: '^debug\\.delete$', effectState: 'none', idempotent: true, profile: 'debug-control', pre: ['daemon.local'], post: ['artifact.removed'] }),
  Object.freeze({ id: 'debug-rule-mutate', pattern: '^debug\\.rule_(add|import|clear|enable|disable|remove)$', effectState: 'debugger', idempotent: false, profile: 'debug-control', pre: ['session.active'], post: ['control.updated'] }),
  Object.freeze({ id: 'debug-rule-read', pattern: '^debug\\.rule_(list|export)$', effectState: 'none', idempotent: true, profile: 'debug-control', pre: ['session.active'], post: ['read.available'] }),
  Object.freeze({ id: 'debug-fetch-probe', pattern: '^debug\\.fetch_probe$', effectState: 'network', idempotent: false, profile: 'debug-control', pre: ['session.active', 'tab.bound'], post: ['result.returned'] }),
  Object.freeze({ id: 'debugger-control', pattern: '^debugger\\.(detach|simulate-detach)$', effectState: 'debugger', idempotent: true, profile: 'debug-control', pre: ['instance.connected'], post: ['debugger.detached'] }),
  Object.freeze({ id: 'trace-lifecycle', pattern: '^trace\\.(start|stop)$', effectState: 'debugger', idempotent: true, profile: 'debug-control', pre: ['session.active', 'tab.bound'], post: ['debugger.attached'] }),
  Object.freeze({ id: 'trace-status', pattern: '^trace\\.status$', effectState: 'none', idempotent: true, profile: 'debug-control', pre: ['session.active'], post: ['read.available'] }),
  Object.freeze({ id: 'network-control', pattern: '^network\\.(start|stop)$', effectState: 'network', idempotent: true, profile: 'network-control', pre: ['session.active', 'tab.bound'], post: ['network.capturing'] }),
  Object.freeze({ id: 'network-replay', pattern: '^network\\.replay$', effectState: 'network', idempotent: false, profile: 'network-control', pre: ['session.active', 'tab.bound'], post: ['page.mutated'] }),
  Object.freeze({ id: 'network-read', pattern: '^network\\.(list|detail|waterfall)$', effectState: 'none', idempotent: true, profile: 'network-control', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  // ---- 传输 ---------------------------------------------------------------
  Object.freeze({ id: 'transfer-open', pattern: '^transfer\\.(begin|chunk|finish)$', effectState: 'transfer', idempotent: false, profile: 'transfer-control', pre: ['transport.local', 'transfer.open'], post: ['transfer.updated'] }),
  Object.freeze({ id: 'transfer-read', pattern: '^transfer\\.read$', effectState: 'none', idempotent: true, profile: 'transfer-control', pre: ['transport.local', 'transfer.open'], post: ['read.available'] }),
  Object.freeze({ id: 'transfer-release', pattern: '^transfer\\.release$', effectState: 'transfer', idempotent: true, profile: 'transfer-control', pre: ['transport.local'], post: ['transfer.updated'] }),
  // ---- 只读观察面 ---------------------------------------------------------
  Object.freeze({ id: 'read-observe', pattern: '^(observe|observe-frames|snapshot|get-html|read|console)$', effectState: 'none', idempotent: true, profile: 'browser-read', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  Object.freeze({ id: 'read-extract', pattern: '^extract(\\.|$)', effectState: 'none', idempotent: true, profile: 'browser-read', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  Object.freeze({ id: 'read-screenshot', pattern: '^(screenshot|screenshot\\.read|longshot\\.recover)$', effectState: 'none', idempotent: true, profile: 'capture', pre: ['session.active', 'tab.bound'], post: ['capture.available'] }),
  Object.freeze({ id: 'shadow-read', pattern: '^shadow\\.read$', effectState: 'none', idempotent: true, profile: 'browser-read', pre: ['session.active', 'tab.bound', 'target.resolved'], post: ['read.available'] }),
  Object.freeze({ id: 'screenshot-release', pattern: '^screenshot\\.release$', effectState: 'capture', idempotent: true, profile: 'capture', pre: ['session.active'], post: ['artifact.removed'] }),
  Object.freeze({ id: 'screenshot-manual', pattern: '^screenshot\\.manual\\.', effectState: 'capture', idempotent: false, profile: 'capture', pre: ['session.active', 'tab.bound'], post: ['capture.available'] }),
  Object.freeze({ id: 'pdf', pattern: '^pdf$', effectState: 'capture', idempotent: true, profile: 'capture', pre: ['session.active', 'tab.bound'], post: ['artifact.created'] }),
  Object.freeze({ id: 'refs-negotiate', pattern: '^refs\\.negotiate$', effectState: 'none', idempotent: true, profile: 'refs-control', pre: ['session.active'], post: ['read.available'] }),
  // ---- 协作 ---------------------------------------------------------------
  Object.freeze({ id: 'cooperate-sync', pattern: '^cooperate\\.sync$', effectState: 'none', idempotent: true, profile: 'cooperation', pre: ['session.active'], post: ['read.available'] }),
  Object.freeze({ id: 'cooperate-wait', pattern: '^cooperate\\.(wait|handback|hold)$', effectState: 'control', idempotent: false, profile: 'cooperation', pre: ['session.active'], post: ['coordination.updated'] }),
  Object.freeze({ id: 'request-help', pattern: '^request-help$', effectState: 'control', idempotent: false, profile: 'cooperation', pre: ['session.active'], post: ['coordination.updated'] }),
  // ---- 交互（页面副作用） -------------------------------------------------
  Object.freeze({ id: 'hover', pattern: '^hover$', effectState: 'page', idempotent: true, profile: 'interaction', pre: ['session.active', 'tab.bound', 'target.resolved'], post: ['page.mutated'] }),
  Object.freeze({ id: 'navigation', pattern: '^(navigate|reload|navigate-back|navigate-forward)$', effectState: 'navigation', idempotent: false, profile: 'navigation', pre: ['session.active', 'tab.bound'], post: ['navigation.committed'] }),
  Object.freeze({ id: 'interaction', pattern: '^(click|click-backend|click-point|shadow\\.click|fill|press|select|drag|wheel|upload|download|evaluate|webmcp\\.call|step|control-hint)$', effectState: 'page', idempotent: false, profile: 'interaction', pre: ['session.active', 'tab.bound', 'target.resolved', 'observation.fresh'], post: ['page.mutated'] }),
  Object.freeze({ id: 'interaction-set', pattern: '^(focus|blur|scroll-to|emulate)$', effectState: 'page', idempotent: true, profile: 'interaction', pre: ['session.active', 'tab.bound', 'target.resolved'], post: ['page.mutated'] }),
  Object.freeze({ id: 'webmcp-list', pattern: '^webmcp\\.list$', effectState: 'none', idempotent: true, profile: 'interaction', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  // ---- 等待 / 计划 / 操作 -------------------------------------------------
  Object.freeze({ id: 'wait', pattern: '^(wait-ms|wait-for-element|wait-for-navigation)$', effectState: 'none', idempotent: true, profile: 'wait-control', pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  Object.freeze({ id: 'actionable-check', pattern: '^actionable$', effectState: 'none', idempotent: true, profile: 'browser-read', pre: ['session.active', 'tab.bound', 'target.resolved'], post: ['read.available'] }),
  Object.freeze({ id: 'plan', pattern: '^plan$', effectState: 'plan', idempotent: false, profile: 'plan-control', pre: ['session.active', 'plan.approved'], post: ['plan.updated'] }),
  Object.freeze({ id: 'operation-await', pattern: '^operation\\.await$', effectState: 'none', idempotent: true, profile: 'operation-control', pre: ['daemon.local'], post: ['read.available'] }),
  Object.freeze({ id: 'operation-cancel', pattern: '^operation\\.cancel$', effectState: 'control', idempotent: true, profile: 'operation-control', pre: ['daemon.local'], post: ['control.updated'] }),
  // ---- 对话框 -------------------------------------------------------------
  Object.freeze({ id: 'dialog-read', pattern: '^dialog\\.(list|status)$', effectState: 'none', idempotent: true, profile: 'dialog-control', pre: ['session.active'], post: ['read.available'] }),
  Object.freeze({ id: 'dialog-arm', pattern: '^dialog\\.(arm|disarm)$', effectState: 'dialog', idempotent: true, profile: 'dialog-control', pre: ['session.active', 'tab.bound'], post: ['dialog.armed'] }),
  Object.freeze({ id: 'dialog-handle', pattern: '^dialog\\.(accept|dismiss|handle)$', effectState: 'dialog', idempotent: false, profile: 'dialog-control', pre: ['session.active', 'tab.bound', 'dialog.pending'], post: ['dialog.resolved'] }),
  // ---- 标签页 / 窗口 ------------------------------------------------------
  Object.freeze({ id: 'tab-read', pattern: '^tab\\.(list|alias|policy)$', effectState: 'none', idempotent: true, profile: 'tab-control', pre: ['instance.connected'], post: ['read.available'] }),
  Object.freeze({ id: 'tab-set', pattern: '^tab\\.(select|move)$', effectState: 'tab', idempotent: true, profile: 'tab-control', pre: ['instance.connected', 'tab.bound', 'tab.controlled'], post: ['tab.updated'] }),
  Object.freeze({ id: 'tab-mutate', pattern: '^tab\\.(new|close|cleanup|borrow|return)$', effectState: 'tab', idempotent: false, profile: 'tab-control', pre: ['instance.connected', 'browser.ready', 'tab.controlled'], post: ['tab.created'] }),
  Object.freeze({ id: 'window-read', pattern: '^window\\.list$', effectState: 'none', idempotent: true, profile: 'window-control', pre: ['instance.connected'], post: ['read.available'] }),
  Object.freeze({ id: 'window-set', pattern: '^window\\.(focus|resize)$', effectState: 'window', idempotent: true, profile: 'window-control', pre: ['instance.connected'], post: ['window.updated'] }),
  Object.freeze({ id: 'window-mutate', pattern: '^window\\.(close|ensureAgent|newAgent)$', effectState: 'window', idempotent: false, profile: 'window-control', pre: ['instance.connected', 'browser.ready'], post: ['window.created'] }),
  // ---- 扩展 UI ------------------------------------------------------------
  Object.freeze({ id: 'ui-open', pattern: '^ui\\.open$', effectState: 'ui', idempotent: false, profile: 'ui-control', pre: ['instance.connected', 'ui.attached'], post: ['result.returned'] }),
  Object.freeze({ id: 'diagnostics-ui', pattern: '^diagnostics\\.ui$', effectState: 'ui', idempotent: false, profile: 'ui-control', pre: ['instance.connected'], post: ['result.returned'] }),
]);

/**
 * 单方法例外：只用于“族规则会给出错误语义”的少量方法。
 * 键 = canonical 方法名，值 = 需要覆盖的六面字段（其余字段沿用族规则）。
 */
export const PROOF_OVERRIDES = Object.freeze({
  // 只读但会生成制品：pdf 的 effect_state 是 capture（族规则已覆盖），screenshot.release 有副作用。
  'screenshot.manual.start': Object.freeze({ effectState: 'capture', idempotent: false, post: ['result.returned'] }),
  'screenshot.manual.frame': Object.freeze({ effectState: 'capture', idempotent: false, post: ['capture.available'] }),
  'screenshot.manual.save': Object.freeze({ effectState: 'capture', idempotent: false, post: ['artifact.created'] }),
  'longshot.recover': Object.freeze({ effectState: 'capture', post: ['artifact.updated'] }),
  // 控制面方法会重建会话窗口，idempotent 不能按“set 状态”判。
  'session.claim_control': Object.freeze({ idempotent: false }),
  'session.handoff': Object.freeze({ idempotent: false }),
  'session.control_mode': Object.freeze({ idempotent: true }),
  'video.recover': Object.freeze({ idempotent: false, pre: ['daemon.local', 'artifact.present'], post: ['artifact.updated'] }),
  'record.start': Object.freeze({ idempotent: false }),
  'record.stop': Object.freeze({ idempotent: true }),
  'debug.start': Object.freeze({ idempotent: true, post: ['debugger.attached'], pre: ['session.active', 'tab.bound', 'debugger.idle'] }),
  'debug.stop': Object.freeze({ idempotent: true, post: ['debugger.detached'] }),
  'trace.start': Object.freeze({ idempotent: true, post: ['debugger.attached'], pre: ['session.active', 'tab.bound', 'debugger.idle'] }),
  'trace.stop': Object.freeze({ idempotent: true, post: ['debugger.detached'], pre: ['session.active', 'tab.bound', 'trace.active'] }),
  'network.start': Object.freeze({ idempotent: true, post: ['network.capturing'] }),
  'network.stop': Object.freeze({ idempotent: true, post: ['network.idle'] }),
  // 交互里少量“set 状态”语义（族规则已给 interaction-set，这里纠正个别）。
  'evaluate': Object.freeze({ effectState: 'page', idempotent: false }),
  'emulate': Object.freeze({ effectState: 'page', idempotent: true, post: ['emulation.updated'] }),
  'scroll-to': Object.freeze({ effectState: 'scroll', post: ['scroll.updated', 'page.mutated'] }),
  'focus': Object.freeze({ effectState: 'focus', post: ['focus.updated'] }),
  'blur': Object.freeze({ effectState: 'focus', post: ['focus.updated'] }),
  // tab.new 之后会话被迁移到新 tab；tab.close 也可能改变绑定。
  'tab.new': Object.freeze({ post: ['tab.created', 'session.updated'] }),
  'tab.close': Object.freeze({ post: ['tab.removed', 'session.updated'] }),
  'tab.borrow': Object.freeze({ pre: ['instance.connected', 'browser.ready', 'tab.bound'], post: ['tab.updated'] }),
  'tab.return': Object.freeze({ pre: ['instance.connected', 'tab.bound'], post: ['tab.updated'] }),
  'window.ensureAgent': Object.freeze({ post: ['window.updated'] }),
  'window.newAgent': Object.freeze({ post: ['window.created', 'window.updated'] }),
  // 关闭类方法的后置条件：窗口/会话确实消失，且变异已落账。
  'window.close': Object.freeze({ post: ['window.removed', 'ledger.committed'] }),
  'session.stop': Object.freeze({ post: ['session.removed', 'ledger.committed'] }),
  // 只读但要求先有数据/抓包/制品。
  'network.detail': Object.freeze({ pre: ['session.active', 'tab.bound', 'network.capturing'], post: ['read.available'] }),
  'network.waterfall': Object.freeze({ pre: ['session.active', 'tab.bound'], post: ['read.available'] }),
  'video.verify': Object.freeze({ pre: ['daemon.local', 'artifact.present'], post: ['read.available'] }),
  'video.fetch': Object.freeze({ idempotent: false, pre: ['daemon.local', 'artifact.present'] }),
  'video.discard': Object.freeze({ idempotent: false, pre: ['daemon.local', 'artifact.present'] }),
  'video.prune': Object.freeze({ idempotent: true }),
  'debug.delete': Object.freeze({ pre: ['daemon.local', 'artifact.present'] }),
  'record.status': Object.freeze({ pre: ['daemon.local'], post: ['read.available'] }),
  'video.status': Object.freeze({ pre: ['daemon.local'], post: ['read.available'] }),
  'video.list': Object.freeze({ pre: ['daemon.local'], post: ['read.available'] }),
  'trace.status': Object.freeze({ pre: ['session.active'], post: ['read.available'] }),
  'operation.await': Object.freeze({ pre: ['daemon.local', 'session.active'], post: ['read.available'] }),
  'request-help': Object.freeze({ pre: ['session.active', 'cooperation.aligned'], post: ['coordination.updated'] }),
  'cooperate.wait': Object.freeze({ pre: ['session.active', 'cooperation.aligned'], post: ['coordination.updated'] }),
  'cooperate.handback': Object.freeze({ pre: ['session.active', 'cooperation.aligned'], post: ['coordination.updated'] }),
  'cooperate.hold': Object.freeze({ pre: ['session.active'], post: ['coordination.updated'] }),
  'plan': Object.freeze({ pre: ['session.active', 'session.unpaused'], post: ['plan.updated'] }),
  'step': Object.freeze({ pre: ['session.active', 'tab.bound', 'plan.approved'], post: ['page.mutated'] }),
});

/**
 * 由族规则 + 例外派生单方法六面语义。纯函数，模块加载时冻结一次；
 * 未知方法返回 null（与 methodStateOf/describeMethod 的未知语义一致）。
 * 规则正则在加载时编译一次（69 条规则 × 165 方法若每次 new RegExp，启动会多花数毫秒）。
 */
const PROOF_RULE_MATCHERS = Object.freeze(PROOF_RULES.map((rule) => Object.freeze({
  rule,
  regex: new RegExp(rule.pattern),
})));

function firstProofRule(name) {
  for (const matcher of PROOF_RULE_MATCHERS) {
    if (matcher.regex.test(name)) return matcher.rule;
  }
  return null;
}

function deriveProofOf(method, row) {
  const name = String(method || '');
  if (!row) return null;
  const matched = firstProofRule(name);
  // 兜底：理论上 ROWS 里每个方法都应命中规则；validateMethodProofs 会把兜底项报出来。
  const fallback = matched || Object.freeze({
    id: 'unclassified',
    effectState: row.effect === 'passive_read' || row.effect === 'read' ? 'none' : 'page',
    idempotent: row.effect === 'passive_read' || row.effect === 'read' || row.effect === 'control_plane',
    profile: 'browser-read',
    pre: row.owner === 'local' ? ['daemon.local'] : ['session.active'],
    post: ['result.returned'],
  });
  const override = PROOF_OVERRIDES[name] || null;
  const pick = (key, value) => (override && override[key] !== undefined ? override[key] : value);
  const proof = {
    method: name,
    rule: fallback.id,
    owner: row.owner,
    effect: row.effect,
    effectState: pick('effectState', fallback.effectState),
    pre: Object.freeze([...pick('pre', fallback.pre)]),
    post: Object.freeze([...pick('post', fallback.post)]),
    // 幂等：同方法同参数重复执行后最终状态不变（不代表可以自动重放）。
    idempotent: Boolean(pick('idempotent', fallback.idempotent)),
    // 可重放：UNKNOWN 之后能否不经人工判断直接再发一次；只读/可证明方法才允许。
    replayable: Boolean(pick('replayable', !row.unknown)),
    profile: fallback.profile,
    recovery: Object.freeze([...new Set([...RECOVERY_BASE_CODES, ...(RECOVERY_PROFILES[fallback.profile] || [])])]),
  };
  return Object.freeze(proof);
}

/** 165 个方法的六面可证明性快照（模块加载时派生；键序 = 目录顺序）。 */
export const METHOD_PROOF = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, deriveProofOf(row.method, row)]),
));

/** 单方法六面快照；未知方法返回 null。 */
export function proofOf(method) {
  return METHOD_PROOF[String(method || '')] || null;
}

/** 六面目录的不变量校验（纯函数；protocol-check / 单测 / 生成前校验共用）。 */
export function validateMethodProofs(rows = METHOD_CATALOG, proof = METHOD_PROOF) {
  const errors = [];
  const names = new Set(rows.map((row) => row && row.method));
  if (!Object.keys(proof).length) errors.push('METHOD_PROOF 为空');
  for (const [method, entry] of Object.entries(proof)) {
    if (!names.has(method)) { errors.push('可证明性表包含目录外方法：' + method); continue; }
    if (!entry || typeof entry !== 'object') { errors.push(method + ' 可证明性行不是对象'); continue; }
    if (entry.method !== method) errors.push(method + ' 可证明性行方法名不一致');
    if (entry.rule === 'unclassified') errors.push(method + ' 未命中任何可证明性族规则（需补 PROOF_RULES）');
    if (!Object.prototype.hasOwnProperty.call(PROOF_EFFECT_STATES, entry.effectState)) {
      errors.push(method + ' effect_state 非法：' + entry.effectState);
    }
    for (const code of entry.pre || []) {
      if (!Object.prototype.hasOwnProperty.call(PROOF_PRECONDITIONS, code)) errors.push(method + ' 前置条件未登记：' + code);
    }
    for (const code of entry.post || []) {
      if (!Object.prototype.hasOwnProperty.call(PROOF_POSTCONDITIONS, code)) errors.push(method + ' 后置条件未登记：' + code);
    }
    if (!Array.isArray(entry.pre) || !entry.pre.length) errors.push(method + ' 缺少前置条件');
    if (!Array.isArray(entry.post) || !entry.post.length) errors.push(method + ' 缺少后置条件');
    if (typeof entry.idempotent !== 'boolean') errors.push(method + ' idempotent 必须是布尔');
    if (typeof entry.replayable !== 'boolean') errors.push(method + ' replayable 必须是布尔');
    if (entry.replayable) {
      const column = METHOD_CATALOG.find((row) => row.method === method);
      if (column && column.unknown) errors.push(method + ' 结果可能 UNKNOWN，不能标记可重放');
    }
    const profile = RECOVERY_PROFILES[entry.profile];
    if (!profile) errors.push(method + ' 恢复族未登记：' + entry.profile);
    else if (!profile.length) errors.push(method + ' 恢复族为空：' + entry.profile);
    if (!Array.isArray(entry.recovery) || !entry.recovery.length) errors.push(method + ' 缺少恢复错误码');
    for (const code of RECOVERY_BASE_CODES) {
      if (!entry.recovery.includes(code)) errors.push(method + ' 恢复集缺少通用错误码：' + code);
    }
    for (const code of entry.recovery || []) {
      if (!Object.prototype.hasOwnProperty.call(RECOVERY_PLAYBOOK, code)) errors.push(method + ' 恢复码未在 playbook 登记：' + code);
    }
  }
  for (const row of rows) {
    if (row && row.method && !proof[row.method]) errors.push('目录方法缺少可证明性行：' + row.method);
  }
  for (const matcher of PROOF_RULE_MATCHERS) {
    const hits = rows.filter((row) => row && matcher.regex.test(row.method)).length;
    if (!hits) errors.push('可证明性族规则没有命中任何方法：' + matcher.rule.id);
  }
  // 遮蔽检测：一条规则如果命中的方法全部被更早的规则先命中，它就是死规则
  // （改这里不会影响任何方法，却让人误以为语义已覆盖）。
  const selectedRules = new Set();
  for (const row of rows) {
    if (!row || !row.method) continue;
    for (const matcher of PROOF_RULE_MATCHERS) {
      if (matcher.regex.test(row.method)) { selectedRules.add(matcher.rule.id); break; }
    }
  }
  for (const matcher of PROOF_RULE_MATCHERS) {
    if (!selectedRules.has(matcher.rule.id)) {
      errors.push('可证明性族规则被更早规则遮蔽（永远不会生效）：' + matcher.rule.id);
    }
  }
  for (const [method, override] of Object.entries(PROOF_OVERRIDES)) {
    if (!override) continue;
    if (!names.has(method)) errors.push('PROOF_OVERRIDES 指向目录外方法：' + method);
  }
  return errors;
}

// ---- 按维度拆分的派生表（消费方按维度取用；全部来自 METHOD_PROOF） --------
export const METHOD_EFFECT_STATE = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].effectState]),
));
export const METHOD_PRECONDITIONS = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].pre]),
));
export const METHOD_POSTCONDITIONS = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].post]),
));
export const METHOD_IDEMPOTENT = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].idempotent]),
));
export const METHOD_REPLAYABLE = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].replayable]),
));
export const METHOD_RECOVERY = Object.freeze(Object.fromEntries(
  METHOD_CATALOG.map((row) => [row.method, METHOD_PROOF[row.method].recovery]),
));
export const IDEMPOTENT_METHODS = Object.freeze(METHOD_CATALOG.filter((row) => METHOD_PROOF[row.method].idempotent).map((row) => row.method));
export const REPLAYABLE_METHODS = Object.freeze(METHOD_CATALOG.filter((row) => METHOD_PROOF[row.method].replayable).map((row) => row.method));
export const IDEMPOTENT_MUTATING_METHODS = Object.freeze(METHOD_CATALOG
  .filter((row) => row.unknown && METHOD_PROOF[row.method].idempotent)
  .map((row) => row.method));

// ===========================================================================
// 协议特性门的降级与迁移建议（与 floor 同源，供 lib/protocol-features.mjs 派生）。
//
// 兼容矩阵只回答“1.8 客户端能不能用”；这里回答“不能用时还能怎么做”：
// - FEATURE_FALLBACKS：特性缺失时的**可执行降级**（调用侧仍能完成目标的手段）。
//   kind=none 表示没有等价手段，只能升级；绝不把“降级”编造成语义等价。
// - FEATURE_MIGRATION：从旧协议升级到当前协议时需要做的事（按特性）。
// - PROTOCOL_MIGRATION_STEPS：整体升级步骤（与 docs 的恢复顺序一致）。
// ===========================================================================

export const FEATURE_FALLBACKS = Object.freeze({
  unverified: Object.freeze({
    kind: 'omit-param',
    param: 'unverified',
    method: null,
    note: '去掉 unverified 走常规校验路径（旧扩展会静默忽略该参数）',
  }),
  expect: Object.freeze({
    kind: 'param+verify',
    param: 'expect',
    method: 'observe',
    note: '去掉 expect，改为动作后自己 observe 核对结果',
  }),
  read: Object.freeze({
    kind: 'method',
    param: null,
    method: 'observe',
    note: '确定性 read 退化为 observe（旧协议可用；结果需要自己提取）',
  }),
  'observe-delta': Object.freeze({
    kind: 'omit-param',
    param: 'delta',
    method: null,
    note: '去掉 delta，退回全量 observe（数据更大、没有增量语义）',
  }),
  plan: Object.freeze({
    kind: 'decompose',
    param: null,
    method: null,
    note: 'daemon 不执行 plan，调用方按步骤逐条调用并自行处理依赖/断言',
  }),
  video: Object.freeze({
    kind: 'none',
    param: null,
    method: null,
    note: '旧扩展没有视频能力，且不存在语义等价的旧方法；必须升级扩展',
  }),
  'capture.stream': Object.freeze({
    kind: 'omit-params',
    params: Object.freeze(['stream', 'segmented', 'staleAttempts']),
    method: null,
    note: '去掉流式/分段参数，退回一次性截图（大页面会超限或更慢）',
  }),
  'debug.journal': Object.freeze({
    kind: 'method',
    param: null,
    method: 'debug.request',
    note: '只保留当前请求的实时调试信息；历史/持久化日志不可用',
  }),
  har: Object.freeze({
    kind: 'none',
    param: null,
    method: null,
    note: '旧扩展不支持 HAR 重放；只能人工按记录重放，不能降级成 network.start 冒充',
  }),
  // ---- 兼容目标 0.5.0 对齐门的可执行降级 ----
  borrow_confirmation_timeout: Object.freeze({
    kind: 'omit-param',
    param: 'confirmationTimeoutMs',
    method: null,
    note: '去掉显式确认超时，沿用扩展本地 60s 默认（确认闸门语义不变，但超时不可调）',
  }),
  interaction_policy: Object.freeze({
    kind: 'none',
    param: null,
    method: null,
    note: '旧扩展虽已实现 request-help，但新 daemon 必须转发并尊重其响应；没有等价降级，只能升级',
  }),
  incognito_sessions: Object.freeze({
    kind: 'omit-param',
    param: 'incognito',
    method: null,
    note: '去掉 incognito：借用普通窗口执行（不是等价隐私语义，需调用方明确接受）',
  }),
  dialog_control: Object.freeze({
    kind: 'none',
    param: null,
    method: null,
    note: '旧扩展没有 dialog/operation 控制面；只能人工处理原生对话框后重试，不能伪造自动处理',
  }),
  click_move_click: Object.freeze({
    kind: 'omit-param',
    param: 'mode',
    method: null,
    note: '退回 press-move-release 手势（与 click-move-click 语义不同：目标不会被提前释放）',
  }),
  target_control: Object.freeze({
    kind: 'omit-param',
    param: 'policy',
    method: null,
    note: '退回归一化控制策略（不向旧扩展传 target/auto，按 strict 串行语义执行）',
  }),
});

export const FEATURE_MIGRATION = Object.freeze({
  unverified: '升级扩展后 unverified 才会真正跳过二次校验；旧扩展会静默忽略，绝不能当成已校验。',
  expect: '升级后断言在扩展侧执行；旧扩展会静默忽略，调用方必须自己 observe 核对。',
  read: '升级后用 read 取得确定性结果；旧扩展用 observe 代替（结果结构不同）。',
  'observe-delta': '升级后 delta 才返回增量；旧扩展忽略该参数，退化为全量。',
  plan: '升级后由 daemon 计划执行器跑 plan；旧扩展需要调用方自己拆步骤。',
  video: '视频录制只有 1.9 扩展支持；升级 CLI+daemon+扩展后重连。',
  'capture.stream': '流式/分段截图需要 1.9 扩展；旧扩展只能一次性截图。',
  'debug.journal': '持久化调试日志需要 1.9 扩展；旧扩展只有实时 debug.request。',
  har: 'HAR 重放需要 1.9 扩展的 network.replay；旧扩展没有等价能力。',
  borrow_confirmation_timeout: '借用确认超时需要 1.9 扩展转发 confirmation_timeout_ms；旧扩展只认本地 60s。',
  interaction_policy: 'request-help 的转发/尊重需要 1.9 daemon+扩展；旧扩展上人工协助语义不可被保证。',
  incognito_sessions: '无痕会话需要 1.9 扩展的无痕窗口能力；旧扩展忽略 incognito，不能假设隐私语义。',
  dialog_control: 'dialog/operation 控制面需要 1.9 扩展；旧扩展只能人工处理原生对话框。',
  click_move_click: 'click-move-click 手势需要 1.9 扩展；旧扩展只支持 press-move-release。',
  target_control: '目标控制策略（target/auto）需要 1.9 扩展；旧扩展按 strict 归一化语义执行。',
});

export const PROTOCOL_MIGRATION_STEPS = Object.freeze([
  '升级浏览器扩展并在扩展管理页重新加载（旧扩展会静默忽略新参数）',
  '升级 CLI/daemon 到同一协议版本（bridge daemon status 查看 protocol）',
  '重新连接浏览器实例，确认 hello 里 protocol 达到 ' + PROTOCOL_CURRENT,
  '对 gated 调用先用 featureMatrix 核对可用性，再按 FEATURE_FALLBACKS 选择降级或升级',
  '若曾在旧扩展上执行新参数，按 docs 的恢复顺序重新 observe 核对，不要假设已生效',
]);
