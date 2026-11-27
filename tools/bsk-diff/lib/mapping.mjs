// tools/bsk-diff/lib/mapping.mjs —— 差分矩阵的**判定层**：映射表 + 状态准则 + 优先级。
//
// 原则（见 docs/上游-DIFF-MATRIX.md 顶部「口径」）：
//   1) equal / partial 必须有**双向可核对证据**；取证不到就 must be unknown；
//   2) missing = 上游 有、我们没有；extra = 我们有、上游 0.5.0 没有；
//   3) 本文件只放"判断"，不放"事实"——事实由 extract-*.mjs 从源码/帮助/产物抽取，
//      证据行号在生成期解析，锚点命中失败会直接让生成失败（禁止留过期证据）。

export const STATUS = Object.freeze({
  EQUAL: 'equal',
  PARTIAL: 'partial',
  MISSING: 'missing',
  EXTRA: 'extra',
  UNKNOWN: 'unknown',
});
export const STATUS_VALUES = Object.freeze(Object.values(STATUS));
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2']);

export const AXES = Object.freeze([
  { id: 'cli', title: 'CLI 命令', bskUnit: 'bsk.exe 子命令' },
  { id: 'rpc', title: 'RPC 方法', bskUnit: 'bsk-protocol Method' },
  { id: 'mcp', title: 'MCP 工具', bskUnit: 'bsk mcp tool' },
  { id: 'extension', title: '扩展能力', bskUnit: '扩展产物面' },
  { id: 'feature', title: '协议 / feature floor', bskUnit: 'compatibility::Feature' },
  { id: 'error', title: '错误码', bskUnit: 'ErrorCode / RpcErrorReason' },
]);

/** 语义口径：状态到底证明到什么程度。文档必须原样引用这段。 */
export const STATUS_SEMANTICS = Object.freeze({
  equal: '两侧在同一「可核对面」上一致（名称/参数集合/字段集合/权限集合），且双方证据均已定位。不等于行为逐字节等价。',
  partial: '两侧都有该能力，但可核对面存在缺口（选项缺、字段缺、粒度不同、floor 不同），缺口逐条列在「差距」列。',
  missing: 'BSK 0.5.0 有、我方没有对应实现（本轴内）。',
  extra: '我方有、BSK 0.5.0 在本轴内没有对应物（不代表 BSK 别的轴没有该能力）。',
  unknown: '取证不足：至少一侧缺少可用于比对的机械证据，因此不判等价，只记录缺什么证据。',
});

// ---------------------------------------------------------------------------
// ① CLI 命令轴
// ---------------------------------------------------------------------------

/**
 * 上游 命令 → 我方 CLI 动词的显式映射。只列**不按同名**可解析的项；
 * 其余按同名自动解析（生成期仍会校验我方动词真实存在，否则判 missing）。
 */
export const CLI_OVERRIDES = Object.freeze({
  sync: {
    ours: 'sync',
    aliasOf: 'cooperate sync',
    note: '我方 sync 是 cooperate sync 的零仪式别名（cli/bridge.mjs main 里转发）。',
  },
  close: {
    ours: 'close',
    aliasOf: 'session stop',
    note: '我方 close 是 session stop 的零仪式别名；BSK close 额外承诺"归还借来的 tab + 立刻 detach debugger"。',
  },
  ledger: {
    ours: 'ledger',
    aliasOf: 'ledger status|resolve',
    note: 'BSK ledger 走 ledger.request RPC；我方 ledger 只有 status/resolve 两个本地子命令。',
  },
  operation: {
    ours: 'operation',
    aliasOf: 'operation await|cancel',
    note: 'BSK operation 直接映射 tool.operation_await/cancel；我方命令同名，子命令命名不同。',
  },
  read: {
    ours: 'read',
    aliasOf: 'read',
    note: 'BSK read 是"无 JavaScript 的安全 DOM 读取"；我方 read 在 read-drag.mjs 里实现，语义接近但字段/限制参数不同。',
  },
  view: {
    ours: 'view',
    aliasOf: 'view',
    note: 'BSK view 读本地保存的 observation（不刷新 ref、不触达浏览器）；我方 view 同名，另支持 view <file>。',
  },
  snapshot: {
    ours: 'snapshot',
    aliasOf: 'snapshot',
    note: '两侧同名；我方 snapshot 是 observe 的渲染变体，参数面未单列 schema。',
  },
});

/** 我方 CLI 独有动词（上游 0.5.0 无同名命令）→ extra 行。 */
export const CLI_EXTRA = Object.freeze({
  actionable: { note: '动作可用性探测（actionable RPC），BSK 无独立命令。' },
  agent: { note: 'agent brief：面向 agent 的页面简报；BSK 用 cooperate sync / observe 直接给 VOM。' },
  audit: { note: '本地审计日志 list/export/prune/clear；BSK 只有 audit.request RPC + --json。' },
  back: { note: 'navigate-back 的别名（能力已被 navigate-back 覆盖）。' },
  cancel: { note: '按 commandId 取消进行中的命令；BSK 用通用 cancel RPC（rpc_id）。' },
  'click-backend': { note: '按 backendNodeId 点击（closed shadow 场景），BSK 无对应命令。' },
  diagnose: { note: '只报告页面自动化痕迹（webdriver/扩展 DOM/CDP），BSK 无对应命令（doctor 是环境自检）。' },
  exec: { note: '在页面里执行 QuickJS/exec 编排，BSK 无对应命令。' },
  forward: { note: 'navigate-forward 的别名（能力已被 navigate-forward 覆盖）。' },
  longshot: { note: '长截图恢复（longshot recover）；BSK 由 screenshot_full_page 方法覆盖，无独立命令。' },
  'mcp-install': { note: '把 MCP server 写进各客户端配置；BSK 由 install-skill --mcp / bsk mcp 覆盖部分。' },
  pair: { note: '配对凭证管理（pair.create/list/redeem...）；BSK 用 daemon pair / local_auth.* 混合实现。' },
  pdf: { note: 'PDP 导出（printPdf），BSK 0.5.0 无 PDF 能力。' },
  refs: { note: 'refs negotiate：跨帧 ref 协商；BSK 无对应命令。' },
  schema: { note: 'schema 列表/校验（本地 JSON schema 工具），BSK 无对应命令。' },
  settings: { note: '扩展设置读写；BSK 用 popup/options 页面，CLI 无 settings 命令。' },
  trace: { note: 'trace start/stop/summary/diff/view；BSK 未暴露 trace 命令（record 面向教学文本）。' },
  ui: { note: '在浏览器里打开扩展页面（popup/options/debug/...）；BSK 用浏览器工具栏点击。' },
  'visual-click': { note: '视觉坐标点击（截图→派发→命中校验）；BSK 用 click --capture/--image-x。' },
  'visual-drag': { note: '视觉坐标拖拽；BSK drag 只有元素/相对偏移。' },
  'visual-gesture': { note: '多段手势（点选序列/多把手）；BSK 无手势命令。' },
  visuals: { note: '列出视觉候选（canvas/图片/自绘区域）；BSK 无对应命令。' },
  webmcp: { note: 'WebMCP list/call（页面内 MCP）；BSK 无对应命令。' },
});

/** CLI 轴的核心命令：这些命令的 partial 缺口优先按 P0 处理（输入/观测主链路）。 */
export const CLI_CORE = Object.freeze([
  'open', 'click', 'fill', 'press', 'select', 'drag', 'hover', 'navigate', 'observe',
  'snapshot', 'screenshot', 'read', 'extract', 'evaluate', 'step', 'plan', 'cooperate', 'dialog',
]);

/** 命令级 flag 契约（COMMAND_SPECS）覆盖不到的 上游 参数，允许按「CLI 全局 flag 全集」比对。 */
export const CLI_SPEC_TOPIC = Object.freeze({
  open: 'open',
  session: 'session',
  tab: 'tab',
  plan: 'plan',
  step: 'step',
  view: 'view',
  recipe: 'recipe',
  extract: 'extract',
  'wait-for-element': 'wait-for-element',
  'wait-for-navigation': 'wait-for-navigation',
  video: 'video',
  record: 'record',
  debug: 'debug',
  trace: 'trace',
  longshot: 'longshot',
  zoom: null,
});

/**
 * 上游 参数名 → 我方 flag 名的归一化别名（仅"确实同义"的少数几个）。
 * 其余按 kebab 名直接比较；比较前统一去 `-ms`/`_ms` 后缀、下划线转连字符。
 */
export const FLAG_ALIASES = Object.freeze({
  timeout: 'timeout',
  'timeout-ms': 'timeout',
  out: 'out',
  'save-full': 'save-full',
  'wait-until': 'wait-until',
  'max-tokens': 'max-tokens',
  'tab-id': 'tab-id',
  'click-count': 'click-count',
  'settle-ms': 'settle',
  'settle_ms': 'settle',
});

/** CLI 轴不参与"子命令面"比对的命令：clap 内置 `help` 的 Commands 段列出的是全部命令，
 *  不是它自己的子命令面，机械比对只会制造噪声。 */
export const CLI_SKIP_SUBCOMMANDS = Object.freeze(['help']);

/** 显式声明"上游 子命令在我方是顶层命令"的映射（只有这里允许用顶层动词兜底）。 */
export const CLI_SUBCOMMAND_TOP_LEVEL = Object.freeze({
  navigate: { back: 'back', forward: 'forward' },
});

/** 命令级人工备注（只写生成期无法自动推导的语义差异）。 */export const CLI_NOTES = Object.freeze({
  open: 'BSK open 一步完成"建会话+导航+等 VOM 稳定"，参数含 --wait-for/--wait-not/--max-tokens/--width/--height；我方 open 走 session start + 可选 navigate（--observe），无内置 VOM 等待。',
  step: 'BSK step 是"一次动作 + 条件同步"的核心原语（--action/--params/--policy/--until-visible）；我方 step 走 plan 引擎，参数为 steps JSON。',
  plan: '两侧都有 plan，但 BSK plan 接收已决动作列表并在首个失败处停止；我方 plan 为 steps JSON + 依赖/重试语义，参数面不同。',
  recipe: '两侧都有 recipe；BSK 子命令 list/show/run/draft/save/rm + 审批门，我方另有 approve 子命令。',
  observe: '我方 observe 参数是 BSK 的超集（vom/ax/facts/delta/pipeline 等 34 个字段），BSK 只有 5 个。',
  evaluate: 'BSK evaluate 有 --await-promise/--return-by-value，我方 evaluate 只有 expression + --unverified。',
  navigate: 'BSK navigate 有 --wait-until/--timeout-ms，我方 navigate 只有 url（等待用 wait-for-navigation）。',
  screenshot: 'BSK screenshot 只支持 --ref 裁剪；整页/分块/流式在 BSK 是独立方法 tool.screenshot_full_page。我方 screenshot 一个命令覆盖 16 个参数。',
  click: 'BSK click 支持 --capture/--image-x/--image-y/--button/--click-count/--modifiers；我方这些走 click --capture 视觉路径 + trusted/force/stable-ref 语义，参数名不同。',
  read: 'BSK read 强调"无 JavaScript 安全读取"并有 fields/max-bytes/max-nodes；我方 read 用 fields-json，缺 max-nodes/max-bytes。',
  cooperate: 'BSK cooperate 含 enable/status/sync/wait 四个动作与 --match-text/--context-lines/--settle 的表现层过滤；我方 cooperate 子命令为 sync/wait/handback/hold。',
  dialog: 'BSK dialog 含 arm/status/accept/dismiss + --queue；我方 dialog 另有 list/handle/disarm。',
  record: '两侧都是 record 子命令组：BSK 只有 start/stop，我方 start/stop/status/list/export。BSK 的 record start 会阻塞到浏览器侧结束（配合 tool.record_await），我方是 overlay 录制 + 状态轮询；导出语义（trace.json 教材）也未逐字段比对。',
  video: '两侧都是 video 子命令组：BSK start/status/stop/save/list/discard，我方在同一组之外多出 verify/durability/prune/recover/info/merge/split/trim 八个子命令（BSK 0.5.0 无对应，属于我方 extra 能力）。',
  debug: 'BSK debug 是单命令多动作（含 rule_*/har/journey/replay）；我方 debug 46 个子命令（拆分更细）。',
  update: '两侧都有 update；BSK 覆盖 check/install/verify 状态机，我方拆成 check/verify/stage/fetch/state/auto/install。',
  daemon: '两侧都有 daemon；我方另有 batch/lease/transfer/queue 等子命令组（BSK 无）。',
  'install-skill': '两侧都有 install-skill；我方 --harness/--dir/--force/--list/--all/--source/--embedded/--mcp/--commands，BSK 目标 harness 列表不同。',
  mcp: '两侧都有 mcp；BSK `bsk mcp` 暴露 7 个粗粒度工具，我方 67 个细粒度工具。',
  status: '两侧都有 status；我方 status 额外含 session/browser/queue 总览。',
  logs: '两侧都有 logs；我方 logs 是 daemon 日志别名，BSK logs 独立命令。',
  doctor: '两侧都有 doctor；BSK doctor 输出诊断+修复建议（54KB 源码），我方 doctor 略。',
  help: '两侧都有 help；BSK `help --help` 会以退出码 1 报 unrecognized subcommand（clap 内置子命令），我方 help 支持 --help。',
});

// ---------------------------------------------------------------------------
// ② RPC 方法轴
// ---------------------------------------------------------------------------

/**
 * 上游 wire 方法 → 我方协议方法的语义映射。未列出的按「归一化同名」自动配对
 * （tool.xxx → xxx 并把下划线换成连字符），配对不上的 上游 方法标 missing。
 */
export const RPC_OVERRIDES = Object.freeze({
  'tool.cooperate': { ours: ['cooperate.sync'], note: 'BSK 一个 tool.cooperate 承载 sync/wait/handback；我方拆成 cooperate.sync/wait/handback/hold。' },
  'tool.session_start': { ours: ['session.start'], note: 'BSK 走扩展方法 tool.session_start，我方 session.start 由 daemon 处理（owner 不同）。' },
  'tool.session_stop': { ours: ['session.stop'], note: 'BSK 是扩展方法 tool.session_stop；我方 session.stop 由 daemon 处理（owner 不同）。' },
  'tool.debug': { ours: ['debug.start', 'debug.stop', 'debug.current', 'debug.request', 'debug.history'], note: 'BSK tool.debug 是带 action 的单一方法；我方拆成 20+ 个 debug.* 方法。' },
  'tool.network': { ours: ['network.list', 'network.detail', 'network.waterfall', 'network.start', 'network.stop', 'network.replay'], note: 'BSK tool.network 带 action；我方拆成 network.* 六个方法。' },
  'tool.video': { ours: ['video.start', 'video.stop', 'video.status', 'video.list', 'video.discard'], note: 'BSK tool.video 带 action；我方拆成 9 个 video.* 方法。' },
  'tool.record_start': { ours: ['record.start'], note: '同名语义（下划线/点号差异）。' },
  'tool.record_stop': { ours: ['record.stop'], note: '同名语义。' },
  'tool.record_await': { ours: ['record.status'], note: 'BSK record_await 等待录制收敛；我方用 record.status 轮询，无阻塞等待方法。' },
  'tool.screenshot_full_page': { ours: ['screenshot', 'longshot.recover'], note: 'BSK 整页截图是独立方法（TransientInput + ActionConditions）；我方用 screenshot(scope=document/stream) + longshot.recover 恢复语义覆盖，无独立方法。' },
  'tool.screenshot_read': { ours: ['screenshot.read'], note: '同名语义。' },
  'tool.screenshot_release': { ours: ['screenshot.release'], note: '同名语义。' },
  'tool.observe': { ours: ['observe'], note: '同名语义；我方 observe 参数超集。' },
  'tool.get_html': { ours: ['get-html'], note: '下划线→连字符。' },
  'tool.scroll_to': { ours: ['scroll-to'], note: '下划线→连字符。' },
  'tool.tab_list': { ours: ['tab.list'], note: '命名空间命名差异（tool.tab_* ↔ tab.*）。' },
  'tool.tab_create': { ours: ['tab.new'], note: 'create ↔ new。' },
  'tool.tab_close': { ours: ['tab.close'], note: '命名空间命名差异。' },
  'tool.tab_borrow': { ours: ['tab.borrow'], note: '命名空间命名差异。' },
  'tool.tab_return': { ours: ['tab.return'], note: '命名空间命名差异。' },
  'tool.tab_select': { ours: ['tab.select'], note: '命名空间命名差异。' },
  'tool.window_resize': { ours: ['window.resize'], note: '命名空间命名差异。' },
  'tool.application': { ours: [], note: '' },
  'session.request': { ours: ['session.request_prepare', 'session.request_claim', 'session.request_cancel', 'session.request_status'], note: 'BSK 单一 session.request 带 action；我方拆成 4 个方法（粒度更细）。' },
  'browser.list': { ours: ['browsers'], note: 'BSK browser.list ↔ 我方 browsers（名称不同，参数都是空的）。' },
  'local_auth.pair': { ours: ['local.pair'], note: '配对入口命名不同；BSK 提供 devices/revoke/rotate/set_mode 四个方法，我方分别对应 pair.list/pair.revoke/pair.renew/local.trust。' },
  'local_auth.devices': { ours: ['pair.list'], note: '语义近似（设备/配对清单）。' },
  'local_auth.revoke': { ours: ['pair.revoke'], note: '语义近似。' },
  'local_auth.rotate': { ours: ['pair.renew'], note: '语义近似（rotate ↔ renew）。' },
  'local_auth.set_mode': { ours: ['local.trust'], note: '语义近似（本机信任模式）。' },
  'audit.request': { ours: ['audit.list'], note: 'BSK 单一 audit.request 带 action；我方只有 audit.list（其余审计操作在 CLI 本地）。' },
  'system.status': { ours: ['status'], note: 'BSK system.status ↔ 我方 status。' },
  'system.ping': { ours: [], note: '我方无 ping 方法（连接健康用 status / WS 心跳）。', priority: 'P1' },
  'system.handshake': { ours: [], note: '我方握手在 WebSocket 信封实现（lib/protocol.mjs），不是 RPC 方法。', priority: 'P1' },
  'ledger.request': { ours: [], note: 'BSK 账本走 RPC；我方意图账本只在 daemon 本地 + CLI（cli/commands/schema-ledger.mjs），未暴露为协议方法。' },
  cancel: { ours: [], note: 'BSK 有通用 cancel RPC（rpc_id）；我方取消散在 session.request_cancel / operation.cancel，无通用方法。' },
  'transfer.begin': { ours: ['transfer.begin'], note: '同名。' },
  'transfer.chunk': { ours: ['transfer.chunk'], note: '同名。' },
  'transfer.finish': { ours: ['transfer.finish'], note: '同名。' },
  'transfer.read': { ours: ['transfer.read'], note: '同名。' },
  'transfer.release': { ours: ['transfer.release'], note: '同名。' },
});

/** 参数面比对时两侧都剔除的字段：请求信封 + action metadata（各自 daemon 注入）。 */
export const PARAM_ENVELOPE = Object.freeze([
  'session', 'session_id', 'sessionid', 'sessionId', 'tab_id', 'tabId',
  'context', 'context_id', 'observation', 'observation_id',
  'depends_on', 'expect',
]);

/** RPC 轴 P0 判定用的核心输入字段：缺这些说明动作主链路少参数。 */
export const RPC_CRITICAL_FIELDS = Object.freeze([
  'ref', 'selector', 'value', 'key', 'url', 'expression', 'state', 'fields', 'mode', 'scope',
]);

// ---------------------------------------------------------------------------
// ③ MCP 工具轴
// ---------------------------------------------------------------------------

/**
 * 我方 67 个 MCP 工具 → 上游 0.5.0 MCP 工具/动作（`bsk_tool:action`）或 null（本轴 extra）。
 * 注意：extra 只表示"在 上游 的 MCP 工具面里没有"，不代表 上游 CLI/协议没有该能力
 * （例如 record/video/debug 在 上游 是 CLI + 协议方法，但不暴露为 MCP 工具）。
 */
export const MCP_MAP = Object.freeze({
  browser_audit: { bsk: null, note: 'BSK MCP 无审计工具（审计在 CLI/协议层）。' },
  browser_brief: { bsk: 'bsk_session:sync', note: 'BSK 用会话 sync 返回 VOM 文本；我方 brief 额外聚合引用/截断/对话框/下一步。' },
  browser_click: { bsk: 'bsk_interact:click', note: '粒度不同：BSK 是粗粒度 bsk_interact 的 action=click。' },
  browser_click_backend: { bsk: null, note: 'BSK MCP 无 backendNodeId 点击入口。' },
  browser_cooperate_sync: { bsk: 'bsk_session:sync', note: 'BSK 的协作同步与会话同步合并为一个 sync action。' },
  browser_debug_analyze: { bsk: null, note: 'BSK MCP 未暴露 debug（其 debug 仅在 CLI/协议）。' },
  browser_debug_archive: { bsk: null, note: 'BSK MCP 无 debug 工具：调试归档只能走 CLI（bsk debug archive）。' },
  browser_debug_archives: { bsk: null, note: 'BSK MCP 无 debug 工具：归档清单只能走 CLI（bsk debug archives）。' },
  browser_debug_evidence: { bsk: null, note: 'BSK MCP 无 debug 工具：证据包只能走 CLI（bsk debug evidence）。' },
  browser_debug_har: { bsk: null, note: 'BSK MCP 无 debug 工具：HAR 导出只能走 CLI（bsk debug har）。' },
  browser_debug_har_import: { bsk: null, note: 'BSK MCP 无 debug 工具：HAR 导入只能走 CLI（bsk debug har-import）。' },
  browser_debug_journal: { bsk: null, note: 'BSK MCP 无 debug 工具：调试日志只能走 CLI（bsk debug journal）。' },
  browser_debug_query: { bsk: null, note: 'BSK MCP 无 debug 工具：请求过滤查询只能走 CLI（bsk debug query）。' },
  browser_debug_start: { bsk: null, note: 'BSK MCP 无 debug 工具：采集开关只能走 CLI（bsk debug start）。' },
  browser_debug_stop: { bsk: null, note: 'BSK MCP 无 debug 工具：采集关停只能走 CLI（bsk debug stop）。' },
  browser_dialog: { bsk: 'bsk_assist:dialog_status', note: 'BSK 把 dialog_status/accept/dismiss 与 operation_await/cancel 拆成 bsk_assist 的 5 个 action；我方合并为 browser_dialog。' },
  browser_download: { bsk: null, note: 'BSK MCP 无 download 工具（协议有 tool.download）。' },
  browser_evaluate: { bsk: 'bsk_interact:evaluate', note: '粒度不同（bsk_interact action=evaluate）。' },
  browser_extract: { bsk: 'bsk_inspect:extract', note: '粒度不同（bsk_inspect action=extract）。' },
  browser_fill: { bsk: 'bsk_interact:fill', note: '粒度不同。' },
  browser_install_skill: { bsk: null, note: 'BSK MCP 无 install-skill 工具（CLI 有）。' },
  browser_longshot_recover: { bsk: null, note: 'BSK 有 screenshot_full_page，但无"分段截图恢复"工具。' },
  browser_navigate: { bsk: 'bsk_page:navigate', note: '粒度不同（bsk_page action=navigate）。' },
  browser_network_list: { bsk: 'bsk_inspect:network', note: '粒度不同（bsk_inspect action=network）。' },
  browser_network_replay_har: { bsk: null, note: 'BSK MCP 未暴露重放（协议 tool.debug 的 replay action）。' },
  browser_network_waterfall: { bsk: null, note: 'BSK network 返回缓冲，无水瀑布图视图。' },
  browser_observe: { bsk: 'bsk_inspect:observe', note: '粒度不同（bsk_inspect action=observe）。' },
  browser_pair: { bsk: null, note: 'BSK MCP 无配对工具（CLI daemon pair / local_auth.*）。' },
  browser_pdf: { bsk: null, note: 'BSK 0.5.0 无 PDF 能力。' },
  browser_plan: { bsk: 'bsk_plan', note: 'BSK bsk_plan 是一次调用跑多个输入动作；我方 browser_plan 走 plan RPC（steps 数组）。' },
  browser_read: { bsk: 'bsk_inspect:read', note: '粒度不同（bsk_inspect action=read）。' },
  browser_recipe: { bsk: 'bsk_recipe', note: '两侧都有 recipe 工具；BSK 需 BSK_RECIPES=1 才出现，我方常驻。' },
  browser_record_list: { bsk: null, note: 'BSK MCP 无 record 工具：录制清单只能走 CLI（bsk record / tool.record_*）。' },
  browser_record_start: { bsk: null, note: 'BSK MCP 无 record 工具：开始录制只能走 CLI（bsk record start）。' },
  browser_record_stop: { bsk: null, note: 'BSK MCP 无 record 工具：停止录制只能走 CLI（bsk record stop）。' },
  browser_refs_negotiate: { bsk: null, note: 'BSK 无 ref 协商工具。' },
  browser_rule_add: { bsk: null, note: 'BSK 网络规则在协议 tool.debug 的 rule_* action，未暴露为 MCP 工具。' },
  browser_rule_clear: { bsk: null, note: 'BSK MCP 无网络规则工具：清空规则只能走 CLI（bsk debug rule_clear）。' },
  browser_rule_list: { bsk: null, note: 'BSK MCP 无网络规则工具：列规则只能走 CLI（bsk debug rule_list）。' },
  browser_rule_set: { bsk: null, note: 'BSK MCP 无网络规则工具：规则启停只能走 CLI（bsk debug rule_enable/disable）。' },
  browser_screenshot: { bsk: 'bsk_inspect:screenshot', note: '粒度不同；我方另有 longshot/stream 参数。' },
  browser_session_start: { bsk: 'bsk_session:start', note: '粒度不同（bsk_session action=start）。' },
  browser_session_stop: { bsk: 'bsk_session:stop', note: '粒度不同。' },
  browser_settings: { bsk: null, note: 'BSK MCP 无设置工具。' },
  browser_status: { bsk: 'bsk_session:status', note: '粒度不同（bsk_session action=status）。' },
  browser_tab_close: { bsk: 'bsk_tabs:close', note: '粒度不同（bsk_tabs action=close）。' },
  browser_tab_move: { bsk: null, note: 'BSK tabs 无 move action。' },
  browser_tab_new: { bsk: 'bsk_tabs:create', note: 'create ↔ new。' },
  browser_tab_select: { bsk: 'bsk_tabs:select', note: '粒度不同。' },
  browser_tabs: { bsk: 'bsk_tabs:list', note: '粒度不同（bsk_tabs action=list）。' },
  browser_trace_start: { bsk: null, note: 'BSK MCP 无 trace 工具。' },
  browser_trace_stop: { bsk: null, note: 'BSK MCP 无 trace 工具：trace 只有我方 CLI 有（BSK 没有 trace 命令）。' },
  browser_trace_summary: { bsk: null, note: 'BSK MCP 无 trace 工具：trace 摘要只有我方 CLI 有。' },
  browser_update: { bsk: null, note: 'BSK MCP 无 update 工具（CLI 有）。' },
  browser_update_state: { bsk: null, note: 'BSK MCP 无 update 工具：版本状态只能走 CLI（bsk update）。' },
  browser_upload: { bsk: null, note: 'BSK MCP 无 upload 工具（协议有 tool.upload）。' },
  browser_video_info: { bsk: null, note: 'BSK MCP 无视频工具（协议 tool.video + CLI video）。' },
  browser_video_list: { bsk: null, note: 'BSK MCP 无 video 工具：录制清单只能走 CLI（bsk video list）。' },
  browser_video_merge: { bsk: null, note: 'BSK 无视频合并能力。' },
  browser_video_recover: { bsk: null, note: 'BSK 无视频恢复能力。' },
  browser_video_split: { bsk: null, note: 'BSK 无视频切分能力。' },
  browser_video_start: { bsk: null, note: 'BSK MCP 无 video 工具：开录只能走 CLI（bsk video start）。' },
  browser_video_status: { bsk: null, note: 'BSK MCP 无 video 工具：状态只能走 CLI（bsk video status）。' },
  browser_video_stop: { bsk: null, note: 'BSK MCP 无 video 工具：停止只能走 CLI（bsk video stop）。' },
  browser_video_trim: { bsk: null, note: 'BSK 无视频裁剪能力。' },
  browser_wait_for: { bsk: 'bsk_page:wait_for_element', note: 'BSK 拆成 wait_for_element / wait_for_navigation 两个 action；我方合并为 browser_wait_for。' },
  browser_window: { bsk: 'bsk_assist:resize', note: '粒度不同（bsk_assist action=resize）。' },
  browser_back: { bsk: 'bsk_page:back', note: '粒度不同（bsk_page action=back）。' },
  browser_console: { bsk: 'bsk_inspect:console', note: '粒度不同（bsk_inspect action=console）。' },
  browser_forward: { bsk: 'bsk_page:forward', note: '粒度不同（bsk_page action=forward）。' },
  browser_reload: { bsk: 'bsk_page:reload', note: '粒度不同（bsk_page action=reload）。' },
  browser_blur: { bsk: 'bsk_interact:blur', note: '粒度不同（bsk_interact action=blur）。' },
  browser_drag: { bsk: 'bsk_interact:drag', note: '粒度不同（bsk_interact action=drag）。' },
  browser_focus: { bsk: 'bsk_interact:focus', note: '粒度不同（bsk_interact action=focus）。' },
  browser_hover: { bsk: 'bsk_interact:hover', note: '粒度不同（bsk_interact action=hover）。' },
  browser_press: { bsk: 'bsk_interact:press', note: '粒度不同（bsk_interact action=press）。' },
  browser_scroll_to: { bsk: 'bsk_interact:scroll_to', note: '粒度不同（bsk_interact action=scroll_to）。' },
  browser_select: { bsk: 'bsk_interact:select', note: '粒度不同（bsk_interact action=select）。' },
  browser_wheel: { bsk: 'bsk_interact:wheel', note: '粒度不同（bsk_interact action=wheel）。' },
  browser_session_request_prepare: { bsk: 'bsk_session:request_prepare', note: '粒度不同（bsk_session action=request_prepare）。' },
  browser_session_request_status: { bsk: 'bsk_session:request_status', note: '粒度不同（bsk_session action=request_status）。' },
  browser_session_request_claim: { bsk: 'bsk_session:request_claim', note: '粒度不同（bsk_session action=request_claim）。' },
  browser_session_request_cancel: { bsk: 'bsk_session:request_cancel', note: '粒度不同（bsk_session action=request_cancel）。' },
  browser_tab_borrow: { bsk: 'bsk_tabs:borrow', note: '粒度不同（bsk_tabs action=borrow）。' },
  browser_tab_return: { bsk: 'bsk_tabs:return', note: '粒度不同（bsk_tabs action=return）。' },
  browser_assist_emulate: { bsk: 'bsk_assist:emulate', note: '粒度不同（bsk_assist action=emulate；我方按设备/视口扁平参数换算）。' },
  browser_assist_operation_await: { bsk: 'bsk_assist:operation_await', note: '粒度不同；上游 operation_id ↔ 我方协议 id。' },
  browser_assist_operation_cancel: { bsk: 'bsk_assist:operation_cancel', note: '粒度不同；上游 operation_id ↔ 我方协议 id。' },
  browser_assist_request_help: { bsk: 'bsk_assist:request_help', note: '粒度不同；上游 prompt 必填 ↔ 我方 reason + criteria。' },
  browser_inspect_html: { bsk: 'bsk_inspect:html', note: '粒度不同（bsk_inspect action=html）。' },
  browser_session_browsers: { bsk: 'bsk_session:browsers', note: '粒度不同（bsk_session action=browsers）。' },
  browser_session_list: { bsk: 'bsk_session:list', note: '粒度不同（bsk_session action=list）。' },
});

// ---------------------------------------------------------------------------
// ② RPC 轴：上游 侧 serde_json::Value / 枚举参数的 daemon 级 typed 证据
// ---------------------------------------------------------------------------
// 上游 method.rs 里部分 wire 方法的 paramsType 写成 serde_json::Value，或使用 serde 枚举
// （VideoParams），单看 method.rs 无法做字段级比对。但 上游 daemon 侧有 typed 结构体或
// 显式 JSON 键读取；下面这张表把“真正被读的字段”与证据位置固定下来，供矩阵判定使用。
export const BSK_DAEMON_PARAM_EVIDENCE = Object.freeze({
  'transfer.begin': { fields: ['session_id', 'name', 'byte_size'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1104' },
  'transfer.chunk': { fields: ['transfer_id', 'offset', 'data_base64'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1126' },
  'transfer.finish': { fields: ['transfer_id'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1137' },
  'transfer.read': { fields: ['transfer_id', 'offset', 'data_base64'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1148' },
  'transfer.release': { fields: ['transfer_id'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1159' },
  'audit.request': { fields: ['action', 'id', 'offset', 'limit', 'enabled'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ws.rs:610' },
  'local_auth.pair': { fields: ['replace'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:12' },
  'local_auth.revoke': { fields: ['device_id', 'all'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:17' },
  'local_auth.rotate': { fields: ['device_id'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:24' },
  'local_auth.set_mode': { fields: ['mode'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/local_auth/maintenance.rs:29' },
  'session.start': { fields: ['controller', 'incognito', 'browser_instance_id', 'width', 'height', 'focused'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1395' },
  'session.start_tracked': { fields: ['request_id', 'controller', 'incognito', 'browser_instance_id', 'width', 'height', 'focused'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:136' },
  'session.request': { fields: ['request_id', 'action'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/session_requests.rs:245' },
  'session.stop': { fields: ['session_id', 'all', 'recording'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:1421' },
  'session.stop_all': { fields: [], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:346' },
  'session.list': { fields: [], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:350' },
  'session.run_log': { fields: ['session_id'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/daemon/ipc.rs:285' },
});

/** ② RPC 轴：上游 serde 枚举参数（#[serde(tag="action")]）的变体字段。 */
export const BSK_VIDEO_VARIANTS = Object.freeze({
  start: { fields: ['session_id', 'tab_id', 'max_duration_ms', 'quality', 'request_id'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:13' },
  status: { fields: ['browser', 'recording_id', 'capability'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41' },
  stop: { fields: ['browser', 'recording_id', 'capability'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41' },
  discard: { fields: ['browser', 'recording_id', 'capability'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41' },
  list: { fields: ['browser'], source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/video.rs:41' },
});

// ---------------------------------------------------------------------------
// ② RPC 轴：字段级语义等价映射（名称不同但语义相同，用于把 unknown 降为 partial）
// ---------------------------------------------------------------------------
// 只在“能给出双方字段用途证据”时登记；命中后状态是 partial（不是 equal）——
// 字段名不同即说明线格式不同，行为级等价仍需真实对端验证。
export const FIELD_SEMANTIC_EQUIVALENTS = Object.freeze({
  'tool.operation_await->operation.await': {
    pairs: [['operation_id', 'id'], ['wait_ms', 'timeoutMs']],
    source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:51-57；我方 extension/src/dispatch.js:133',
    note: 'operation_id↔id、wait_ms↔timeoutMs：同一“等待被挂起操作完成”的语义，仅线字段命名/单位不同。',
  },
  'tool.operation_cancel->operation.cancel': {
    pairs: [['operation_id', 'id']],
    source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs:51-57；我方 extension/src/dispatch.js:134-137',
    note: 'operation_id↔id：取消目标为同一挂起操作。',
  },
  'tool.wait_ms->wait-ms': {
    pairs: [['duration_ms', 'ms']],
    source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/waits.rs；我方 extension/src/tools/waits.js:32',
    note: 'duration_ms↔ms；我方多 command_id 归因字段。',
  },
  'tool.dialog_dismiss->dialog.dismiss': {
    pairs: [['dialog_id', 'id']],
    source: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/dialog.rs；我方 extension/src/dialogs.js:227',
    note: 'dialog_id↔id；BSK 另带 text（仅 accept 路径语义）。',
  },
});

// ---------------------------------------------------------------------------
// ③b 上游 MCP 动作 → 我方 MCP 工具覆盖
// ---------------------------------------------------------------------------

/**
 * 上游 MCP 的 55 个动作（7 个粗粒度工具 + opt-in recipe + bsk_plan）在我方 67 个工具面上
 * 是否有直接入口。`ours: []` 表示只能通过 browser_plan(steps=[{method,...}]) 间接触达
 * ——这是"本轴缺失"，不是"我们没有该能力"，note 里必须说清楚。
 */
export const BSK_MCP_ACTION_COVERAGE = Object.freeze([
  { tool: 'bsk_session', enumName: 'Session', action: 'browsers', ours: ['browser_session_browsers'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_session', enumName: 'Session', action: 'start', ours: ['browser_session_start'], note: '粒度不同：BSK 是 bsk_session 的 action=start。' },
  { tool: 'bsk_session', enumName: 'Session', action: 'stop', ours: ['browser_session_stop'], note: '粒度不同。' },
  { tool: 'bsk_session', enumName: 'Session', action: 'list', ours: ['browser_session_list'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_session', enumName: 'Session', action: 'request_prepare', ours: ['browser_session_request_prepare'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_session', enumName: 'Session', action: 'request_status', ours: ['browser_session_request_status'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_session', enumName: 'Session', action: 'request_claim', ours: ['browser_session_request_claim'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_session', enumName: 'Session', action: 'request_cancel', ours: ['browser_session_request_cancel'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_session', enumName: 'Session', action: 'sync', ours: ['browser_brief', 'browser_cooperate_sync'], note: '我方分散在 brief（页面简报）与 cooperate_sync（协作同步）。' },
  { tool: 'bsk_session', enumName: 'Session', action: 'wait', ours: ['browser_cooperate_sync'], note: 'BSK wait 等人工交还控制；我方 browser_cooperate_sync 可带 wait 语义。' },
  { tool: 'bsk_session', enumName: 'Session', action: 'status', ours: ['browser_status'], note: '粒度不同。' },
  { tool: 'bsk_page', enumName: 'Page', action: 'navigate', ours: ['browser_navigate'], note: '粒度不同。' },
  { tool: 'bsk_page', enumName: 'Page', action: 'back', ours: ['browser_back'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_page', enumName: 'Page', action: 'forward', ours: ['browser_forward'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_page', enumName: 'Page', action: 'reload', ours: ['browser_reload'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_page', enumName: 'Page', action: 'wait_for_element', ours: ['browser_wait_for'], note: '粒度不同。' },
  { tool: 'bsk_page', enumName: 'Page', action: 'wait_for_navigation', ours: ['browser_wait_for'], note: '粒度不同。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'read', ours: ['browser_read'], note: '粒度不同。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'observe', ours: ['browser_observe'], note: '粒度不同。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'snapshot', ours: ['browser_observe'], note: '我方用 browser_observe 的 VOM 输出覆盖 aria snapshot，无独立工具。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'html', ours: ['browser_inspect_html'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'screenshot', ours: ['browser_screenshot'], note: '粒度不同。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'console', ours: ['browser_console'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'network', ours: ['browser_network_list'], note: '粒度不同。' },
  { tool: 'bsk_inspect', enumName: 'Inspect', action: 'extract', ours: ['browser_extract'], note: '粒度不同。' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'click', ours: ['browser_click'], note: '粒度不同。' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'press', ours: ['browser_press'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'fill', ours: ['browser_fill'], note: '粒度不同。' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'hover', ours: ['browser_hover'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'select', ours: ['browser_select'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'drag', ours: ['browser_drag'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'scroll_to', ours: ['browser_scroll_to'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'wheel', ours: ['browser_wheel'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'focus', ours: ['browser_focus'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'blur', ours: ['browser_blur'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_interact', enumName: 'Interact', action: 'evaluate', ours: ['browser_evaluate'], note: '粒度不同。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'list', ours: ['browser_recipe'], note: '我方 browser_recipe 是单工具带 action，覆盖 list/show/run/draft/save/rm。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'show', ours: ['browser_recipe'], note: 'browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'run', ours: ['browser_recipe'], note: 'browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'draft', ours: ['browser_recipe'], note: 'browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'save', ours: ['browser_recipe'], note: 'browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。' },
  { tool: 'bsk_recipe', enumName: 'Recipe', action: 'rm', ours: ['browser_recipe'], note: 'browser_recipe 单工具带 action 参数覆盖该 action（粒度：1 工具 ↔ 6 动作）。' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'list', ours: ['browser_tabs'], note: '粒度不同。' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'create', ours: ['browser_tab_new'], note: 'create ↔ new。' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'select', ours: ['browser_tab_select'], note: '粒度不同。' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'close', ours: ['browser_tab_close'], note: '粒度不同。' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'borrow', ours: ['browser_tab_borrow'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_tabs', enumName: 'Tabs', action: 'return', ours: ['browser_tab_return'], note: '专用工具已覆盖（仅契约形状差异，P1）' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'resize', ours: ['browser_window'], note: '粒度不同。' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'emulate', ours: ['browser_assist_emulate'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'request_help', ours: ['browser_assist_request_help'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'dialog_status', ours: ['browser_dialog'], note: '我方 browser_dialog 合并 status/accept/dismiss/operation。' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'dialog_accept', ours: ['browser_dialog'], note: 'browser_dialog 单工具合并 status/accept/dismiss（粒度：1 工具 ↔ 3 动作）。' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'dialog_dismiss', ours: ['browser_dialog'], note: 'browser_dialog 单工具合并 status/accept/dismiss（粒度：1 工具 ↔ 3 动作）。' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'operation_await', ours: ['browser_assist_operation_await'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
  { tool: 'bsk_assist', enumName: 'Assist', action: 'operation_cancel', ours: ['browser_assist_operation_cancel'], note: '专用工具已覆盖（仅契约形状差异，P1）', priority: 'P1' },
]);

// ---------------------------------------------------------------------------
// ④ 扩展能力轴
// ---------------------------------------------------------------------------

/**
 * 8 个能力面 + 1 个 manifest 权限面。
 * ours / bsk 的锚点：ours 用 {file, needle} 解析成 file:line；bsk 直接用 ref 路径
 * （上游 侧产物是构建后的 chunks/pages，符号级行号不可靠，按路径取证更诚实）。
 */
export const EXT_ROWS = Object.freeze([
  {
    capability: 'record',
    ours: [
      { file: 'extension/src/record-overlay.js', needle: 'export function installRecordOverlay' },
      { file: 'extension/src/record-events.js', needle: 'export ' },
      { file: 'extension/ui/record.html', needle: '<html' },
    ],
    bsk: [
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/record-capture.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/RecordOverlay.tsx',
      'ref/bsk-0.5.0-ext/content-scripts/record-frame.js',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/record.rs',
    ],
    status: 'partial',
    note: '两侧都是"内容脚本抓事件 + CLI 导出"；差异在 UI：我方有独立 record 面板（overlay 录制态/暂停/导出），BSK 录制浮层由 record-frame content script 注入、无独立扩展页；BSK 导出面向 trace.json 教材（record export），我方另有 record-program/replay 语义。',
    priority: 'P1',
  },
  {
    capability: 'video',
    ours: [
      { file: 'extension/src/video.js', needle: 'const MAX_BYTES' },
      { file: 'extension/offscreen.html', needle: '<html' },
      { file: 'extension/ui/panels/video-panel.js', needle: 'export ' },
    ],
    bsk: [
      'ref/bsk-0.5.0-ext/video.html',
      'ref/bsk-0.5.0-ext/video-offscreen.html',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/video/encoder.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/video/offscreen.ts',
    ],
    status: 'partial',
    note: '两侧都有 offscreen 录制 + 专用页面；BSK 固定 video.html/video-offscreen.html 两页，我方是 offscreen.html + video-panel 面板。编码参数（码率/容器/关键帧）是否逐项一致未验证（需要 E2E，不在本任务范围）。',
    priority: 'P1',
  },
  {
    capability: 'longshot',
    ours: [
      { file: 'extension/src/longshot.js', needle: 'export function planCaptureTiles' },
      { file: 'extension/src/tiled-capture.js', needle: 'export ' },
      { file: 'extension/ui/longshot.html', needle: '<html' },
    ],
    bsk: [
      'ref/bsk-0.5.0-ext/long-screenshot.html',
      'ref/bsk-0.5.0-ext/content-scripts/long-screenshot-page.js',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/long-screenshot/capture.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/long-screenshot/tiles.ts',
    ],
    status: 'partial',
    note: '两侧都分片抓取再拼接；BSK 在页面侧 content script 内拼接，我方由扩展 tiled-capture + longshot.recover 恢复。分片重叠/上限（我方 maxTiles=8）与 BSK 的服务端拼接策略未逐项对齐。',
    priority: 'P2',
  },
  {
    capability: 'overlay',
    ours: [
      { file: 'extension/src/overlay-ui.js', needle: 'export function borrowBanner' },
      { file: 'extension/src/manual-overlay.js', needle: 'export ' },
      { file: 'extension/src/target-marker.js', needle: 'export ' },
    ],
    bsk: [
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/ControlOverlay.tsx',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/overlay-controller.ts',
      'ref/bsk-0.5.0-ext/content-scripts/cooperation.js',
    ],
    status: 'partial',
    note: 'BSK 的输入拦截/提示浮层集中在 cooperation content script；我方拆成 overlay-ui（band/banner）+ manual-overlay（手动模式）+ target-marker（目标标记）+ 抑制层，组件更多、可组合，但对照 BSK 的 overlay 文案/可访问性面无逐项比对。',
    priority: 'P2',
  },
  {
    capability: 'cooperate',
    ours: [
      { file: 'extension/src/cooperation.js', needle: 'const PASSTHROUGH_TTL_MS' },
      { file: 'extension/content/cooperation.js', needle: 'const BLOCKER_ID' },
      { file: 'extension/src/control.js', needle: 'export ' },
    ],
    bsk: [
      'ref/bsk-0.5.0-ext/content-scripts/cooperation.js',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/controller.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/control-authority.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/cooperate.rs',
    ],
    status: 'partial',
    note: '两侧都有 content-script 协作层 + sync/wait/handback。我方 control.js 已支持 target/strict/auto（另有 passthrough token、租约 epoch、hold 状态），是 BSK 单控制面的超集；契约形状不同、能力已具备，按 partial（P1）记账。',
    priority: 'P1',
  },
  {
    capability: 'toolbar',
    ours: [
      { file: 'extension/ui/popup.html', needle: '<html' },
      { file: 'extension/ui/popup.js', needle: 'const ' },
    ],
    bsk: ['ref/bsk-0.5.0-ext/popup.html', 'ref/bsk-0.5.0-ext/chunks/popup-BRMQtodn.js'],
    status: 'equal',
    note: '入口面一致：两侧 manifest 都声明 action.default_popup 指向各自的 popup 页面，且都提供 options 页。只判"工具栏入口"这一可核对面一致，不涉及面板内功能。',
    priority: 'P2',
  },
  {
    capability: 'human',
    ours: [
      { file: 'extension/src/human-state.js', needle: 'const states = new Map()' },
      { file: 'extension/src/human-decisions.js', needle: 'export ' },
      { file: 'extension/content/human-watch.js', needle: 'const send = (type' },
    ],
    bsk: [
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/human_loop.rs',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-cli/src/cli/human_loop.rs',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/help-request.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/HelpRequestOverlay.tsx',
    ],
    status: 'partial',
    note: '两侧都有人工介入检测（输入事件 → 暂停 agent）；BSK 在工具层 HumanLoop 结构（request_help + InteractionPolicy feature），我方用 human-watch content script + human-state/decisions 状态机。判定阈值与暂停粒度未对齐。',
    priority: 'P1',
  },
  {
    capability: 'borrow',
    ours: [
      { file: 'extension/src/tabs-borrow.js', needle: 'const BORROW_TIMEOUT_MS' },
      { file: 'extension/src/borrow-ui.js', needle: 'const ' },
      { file: 'extension/src/lib/borrow-confirm.js', needle: 'export ' },
    ],
    bsk: [
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/content/BorrowConfirmationOverlay.tsx',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/apps/extension/src/cooperation/action-guard.ts',
      'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0/crates/bsk-protocol/src/tools/tabs.rs',
    ],
    status: 'partial',
    note: '两侧都有借用确认。我方 daemon 已用 FEATURE_PARAM_RULES（confirmationTimeoutMs → borrow_confirmation_timeout, floor 1.9）在 extension-dispatch 的 requireFeatures 做参数级特性门，默认 60s；BSK floor 1.2。门控位置/floor 不同、能力已具备，按 contract partial（P1）记账。',
    priority: 'P1',
  },
  {
    capability: 'manifest-permissions',
    ours: [{ file: 'extension/manifest.json', needle: '"permissions"' }],
    bsk: ['ref/bsk-0.5.0-ext/manifest.json'],
    status: 'partial',
    note: 'BSK 声明 activeTab，我方未声明（用 tabs + scripting 覆盖，最小权限面更窄但语义不同）；我方额外要 tabCapture（视频录制）与 declarativeNetRequest（网络规则），BSK 两者都不声明。最低 Chrome 版本也不同：BSK 125 / 我方 111。',
    priority: 'P2',
  },
]);

// ---------------------------------------------------------------------------
// ⑤ 协议 / feature floor 轴
// ---------------------------------------------------------------------------

/**
 * 我方 9 个 feature floor → 上游 Feature。
 * ours: null 表示 上游 0.5.0 没有对应 Feature（我方 extra）；
 * 每个 上游 Feature 的 floor 由 compatibility.rs 抽取（daemon/extension 双 floor）。
 */
export const FEATURE_MAP = Object.freeze({
  unverified: {
    bsk: 'unverified_script',
    note: '两侧都是"参数 unverified=true 才要求 1.9"；触发字段与 floor 完全一致。',
  },
  expect: {
    bsk: 'action_conditions',
    note: '触发条件一致（expect 非空数组/存在），但 floor 不同：BSK 1.8，我方 1.9（我方把整个 1.9 特性批次抬高）。',
  },
  read: {
    bsk: 'dom_read',
    note: 'floor 都是 1.9；但 BSK 是"操作恒要求"（FeatureWhen::Always），我方是方法级门（read 方法），触发面不同。',
  },
  'observe-delta': {
    bsk: null,
    note: '我方独有的 observe 增量补丁门（delta=true 要求 1.9）；BSK 0.5.0 无对应 Feature。',
  },
  plan: {
    bsk: null,
    note: '我方独有：plan 方法要求 1.9；BSK 的 plan 是 CLI 编排，不在协议里，也没有 Feature。',
  },
  video: {
    bsk: null,
    note: '我方独有：video.* 九个方法统一门 1.9；BSK 的 tool.video 没有 Feature 门（只在 start action 上做 interrupt gate）。',
  },
  'capture.stream': {
    bsk: null,
    note: '我方独有：screenshot 的 stream/segmented/staleAttempts 与 screenshot.read/release/longshot.recover 门 1.9；BSK 整页截图用 tool.screenshot_full_page + ActionConditions 表达，无独立 stream 门。',
  },
  'debug.journal': {
    bsk: null,
    note: '我方独有：debug.history/delete/pin/pinned 门 1.9；BSK 调试日志在 tool.debug 的 action 里，无 Feature 门。',
  },
  har: {
    bsk: null,
    note: '我方独有：network.replay 门 1.9；BSK 的 HAR 重放在 tool.debug action 里，无 Feature 门。',
  },
  borrow_confirmation_timeout: {
    bsk: 'borrow_confirmation_timeout',
    note: '同名 Feature；BSK 门保证旧扩展转发 confirmation_timeout_ms，我方 M6-P0② 已补协议门（1.9），语义对齐。',
  },
  interaction_policy: {
    bsk: 'interaction_policy',
    note: '同名 Feature；我方 M6-P0② 已补 request-help 转发门（1.9）。',
  },
  incognito_sessions: {
    bsk: 'incognito_sessions',
    note: '同名 Feature；我方 session.start incognito 门（1.9）已补。',
  },
  dialog_control: {
    bsk: 'dialog_control',
    note: '同名 Feature；我方 dialog.*/operation.* 门（1.9）已补。',
  },
  click_move_click: {
    bsk: 'click_move_click',
    note: '同名 Feature；我方 drag mode=click-move-click 门（1.9）已补。',
  },
  target_control: {
    bsk: 'target_control',
    note: '同名 Feature；我方 control_mode/claim_control 门（1.9）已补。',
  },
});

/** 上游 有、我方没有对应 feature 门的（能力或许存在，但缺协议门控）。 */
export const FEATURE_BSK_ONLY = Object.freeze({});

// ---------------------------------------------------------------------------
// ⑥ 错误码轴
// ---------------------------------------------------------------------------

/**
 * 上游 ErrorCode（15）→ 我方错误码。null = 我方没有对应码（missing）。
 * equal 由"归一化名称相同"自动判定（E_X_Y ↔ x_y），否则 partial。
 */
export const ERROR_CODE_MAP = Object.freeze({
  unknown_method: 'E_UNKNOWN_METHOD',
  unsupported: 'E_UNSUPPORTED',
  invalid_params: 'E_INVALID_PARAMS',
  not_found: 'E_NOT_FOUND',
  permission_denied: 'E_FORBIDDEN',
  timeout: 'E_TIMEOUT',
  dialog_pending: 'E_DIALOG_PENDING',
  cdp_failed: "E_PAGE_ERROR",
  protocol_error: 'E_RPC',
  cancelled: 'E_CANCELLED',
  user_aborted: "E_CANCELLED",
  version_too_old: 'E_PROTOCOL_UNSUPPORTED',
  multiple_browsers_online: 'E_BROWSER_AMBIGUOUS',
  no_browser_connected: 'E_NO_BROWSER',
  pairing_required: 'E_PAIR_REQUIRED',
});

/**
 * 上游 RpcErrorReason（102）→ 我方错误码。null = missing。
 * 值可以是字符串或 { ours, note }（需要解释映射语义时）。
 */
export const ERROR_REASON_MAP = Object.freeze({
  user_moved_tab: "E_TARGET_DETACHED",
  cooperation_sync_required: 'E_COOPERATION_STALE',
  frame_unobservable: "E_OBSERVE_FAILED",
  page_load_failed: 'E_NAV_FAIL',
  control_authority_required: 'E_CONTROL_NOT_HELD',
  control_context_invalid: 'E_CONTEXT_STALE',
  human_intervention: 'E_HUMAN_GATE',
  control_held: 'E_CONTROL_BUSY',
  document_changed: 'E_OBSERVATION_STALE',
  observation_required: 'E_CONTEXT_REQUIRED',
  observation_changed: 'E_OBSERVATION_CHANGED',
  precondition_invalid: 'E_ARG_CONFLICT',
  precondition_failed: 'E_EXPECT_FAILED',
  target_detached: 'E_TARGET_DETACHED',
  target_hidden: 'E_NOT_ACTIONABLE',
  target_disabled: 'E_NOT_ACTIONABLE',
  target_readonly: 'E_NOT_ACTIONABLE',
  target_focus_lost: 'E_FOCUS',
  target_moved: 'E_TARGET_MISMATCH',
  target_covered: 'E_OCCLUDED',
  virtual_row_recycled: 'E_STALE_REF',
  read_params_invalid: 'E_BAD_ARG',
  read_target_stale: 'E_STALE_REF',
  read_selector_invalid: 'E_BAD_ARG',
  read_field_ambiguous: "E_OPTION_AMBIGUOUS",
  read_limit: 'E_RESULT_TOO_LARGE',
  extract_params_invalid: 'E_BAD_ARG',
  extract_target_stale: 'E_STALE_REF',
  extract_target_ambiguous: "E_OPTION_AMBIGUOUS",
  extract_target_hidden: 'E_NOT_ACTIONABLE',
  extract_selector_invalid: 'E_BAD_ARG',
  extract_structure_invalid: "E_PAGE_ERROR",
  extract_field_ambiguous: "E_OPTION_AMBIGUOUS",
  extract_limit: 'E_RESULT_TOO_LARGE',
  ui_lookup_failed: "E_OBSERVE_FAILED",
  task_unavailable: 'E_NO_SESSION',
  target_unavailable: 'E_NOT_FOUND',
  task_stopping: 'E_SESSION_STOPPED',
  ui_deadline: 'E_TIMEOUT',
  preview_busy: 'E_PREVIEW_META',
  agent_window_scope: "E_UNSUPPORTED_FEATURE",
  element_not_visible: 'E_NOT_ACTIONABLE',
  input_not_ready: 'E_INPUT_BUSY',
  input_clock_unavailable: "E_INTERNAL",
  input_outcome_unknown: 'E_INTERNAL',
  uncertain_prior_effect: 'E_LEDGER_PENDING',
  input_paint_unconfirmed: "E_EXEC_FAILED",
  input_cleanup_failed: 'E_INTERNAL',
  ref_not_found: 'E_NOT_FOUND',
  ref_kind_unsupported: "E_UNSUPPORTED_FEATURE",
  visual_capture_stale: 'E_CAPTURE_STALE',
  visual_capture_invalid: 'E_CAPTURE_STALE',
  visual_coordinate_invalid: 'E_BAD_ARG',
  visual_target_changed: 'E_TARGET_MISMATCH',
  visual_pixel_budget_exceeded: 'E_TOO_LARGE',
  selector_not_found: 'E_NOT_FOUND',
  target_not_fillable: 'E_TARGET_NOT_FILLABLE',
  fill_value_invalid: 'E_BAD_ARG',
  fill_target_changed: 'E_TARGET_MISMATCH',
  fill_focus_lost: 'E_FOCUS',
  fill_value_mismatch: 'E_TARGET_MISMATCH',
  fill_failed: 'E_TARGET_MISMATCH',
  target_not_select: 'E_NOT_SELECT',
  option_not_found: 'E_OPTION_NOT_FOUND',
  option_ambiguous: 'E_OPTION_AMBIGUOUS',
  single_select_value_count: 'E_BAD_ARG',
  tab_not_active: "E_NO_TAB",
  window_resize_inactive_tab: "E_NO_TAB",
  window_resize_constrained: "E_ARG_RANGE",
  window_resize_unconfirmed: "E_EXEC_FAILED",
  window_resize_viewport_unchanged: "E_EXEC_FAILED",
  restricted_tab_url: 'E_FORBIDDEN',
  cdp_extension_access_denied: 'E_FORBIDDEN',
  observe_identity_reload_loop: "E_OBSERVE_FAILED",
  borrow_agent_window_tab: 'E_BORROW_DENIED',
  borrow_conflict: 'E_BORROW_CONFLICT',
  incognito_borrow_disabled: 'E_INCOGNITO_UNAVAILABLE',
  borrow_in_progress: 'E_BORROW_CONFLICT',
  user_denied: 'E_BORROW_DENIED',
  confirmation_timeout: 'E_BORROW_TIMEOUT',
  confirmation_ui_unavailable: 'E_HELP_DISABLED',
  borrow_outcome_unknown: 'E_INTERNAL',
  screenshot_capture_failed: 'E_SCREENSHOT',
  renderer_read_timeout: 'E_TIMEOUT',
  operation_settling: "E_INPUT_BUSY",
  user_cancelled: 'E_CANCELLED',
  page_hidden: "E_PAGE_ERROR",
  navigation: 'E_NAV_FAIL',
  watchdog_timeout: 'E_TIMEOUT',
  stale_frame: 'E_STALE_REF',
  loading_stalled: "E_TIMEOUT",
  file_input_probe_failed: 'E_NO_FILE_CHOOSER',
  file_input_not_activated: "E_NO_FILE_CHOOSER",
  set_file_input_failed: "E_NO_FILE_CHOOSER",
  upload_mechanism_unsupported: 'E_UNSUPPORTED_CAPABILITY',
  file_drop_target_unavailable: "E_TARGET_NOT_FILLABLE",
  file_drop_failed: "E_TRANSFER_STATE",
  download_capture_failed: 'E_DOWNLOAD_FAILED',
  download_path_mismatch: "E_DOWNLOAD_FAILED",
  transfer_outcome_unknown: 'E_TRANSFER_STATE',
  transfer_timeout: 'E_DAEMON_TIMEOUT',
  cleanup_failed: 'E_INTERNAL',
});

/** 错误码轴：我方某个码被多个 上游 词表共用时，标注"粗粒度映射"。 */
export const ERROR_MAPPING_NOTES = Object.freeze({
  'E_NOT_ACTIONABLE': 'BSK 用 target_hidden/target_disabled/element_not_visible 三个 reason 区分原因，我方合并为一个码（丢了原因维度）。',
  'E_FORBIDDEN': 'BSK 的 permission_denied / restricted_tab_url / cdp_extension_access_denied 都落到我方一个码。',
  'E_BAD_ARG': 'BSK 的 read_params_invalid / extract_params_invalid / fill_value_invalid / single_select_value_count 都落到 E_BAD_ARG（我方另有 E_ARG_* 细分，但不是按 BSK 的 reason 维度切）。',
});

// ---------------------------------------------------------------------------
// 优先级判定
// ---------------------------------------------------------------------------

/** 全局优先级规则说明（文档原样引用；实现见 join.mjs 的 priorityOf*）。 */
export const PRIORITY_RULES = Object.freeze([
  'P0：BSK 有能力而我方 missing；或 partial 且关键输入字段/参数/选项缺失（动作主链路不能用）。',
  'P1：两侧都有但缺口明确（floor 不同、粒度不同、原因维度丢失、unknown 的关键轴）。',
  'P2：equal / extra / 仅文档或表现层差异。',
]);

export const PRIORITY_WEIGHT = Object.freeze({ P0: 0, P1: 1, P2: 2 });
