// mcp/tool-contracts.mjs —— MCP 92 工具的「契约声明」：哪些入参映射到哪个协议方法参数、
// 哪些是 bridge 本地参数、哪些协议参数刻意不暴露，以及一个工具的动作分发集合。
//
// 这里是**声明**，不是事实来源：事实来源是 mcp/tools-*.mjs 里真实注册的 inputSchema/run
// 与 lib/schemas.mjs 的规范参数 schema。mcp/schema-audit.mjs 会把两边逐项对账：
//   - 工具入参未声明为本地参数、也无法映射到它声明的任一协议方法参数 → 失败；
//   - 协议方法参数既没有被工具入参覆盖、也没有在 UNEXPOSED 里写明理由 → 失败；
//   - required / enum / default / 类型（integer⊂number 除外）不一致 → 失败；
//   - 工具 run() 源码里读取了 schema 没声明的 args.X（死参数）或调用了 methods 没声明的
//     协议方法（未登记）→ 失败；
//   - 声明了动作分发的工具，其 action 枚举 / methods 并集必须与分发表一致 → 失败。
//
// 因此：改任何 MCP 工具 schema / 方法映射 / 协议方法参数，都必须同步本文件，否则 server
// 启动即失败（mcp/server.mjs 在模块加载时 assertToolContracts）。
//
// 约定：
//   - ENVELOPE_ARGS 由 MCP 工具统一注入，不属于任何单个工具的业务参数；
//   - 协议参数名（camelCase）到 MCP snake_case 的转换由 PARAM_ALIASES + 通用 camel 反解；
//   - LOCAL_ARG_KINDS 解释“为什么这个入参不是协议参数”；
//   - 每一条 UNEXPOSED 都必须带 reason——刻意不暴露也要写明代价，避免静默漂移。

export const CONTRACT_VERSION = 1;

/** 所有工具共有的会话信封参数（server 注入/工具内部透传）。 */
export const ENVELOPE_ARGS = Object.freeze(['session', 'session_id', 'tab_id']);

/** 协议信封字段：方法 schema 里有，但 MCP 工具统一由 session 注入/省略。 */
export const ENVELOPE_PROTOCOL_PARAMS = Object.freeze(['session', 'sessionId', 'tabId']);

/**
 * MCP snake_case → 协议 camelCase 的别名表。
 * 通用反解会把 `max_tokens` 还原成 `maxTokens`；只有缩写/历史命名需要显式登记。
 */
export const PARAM_ALIASES = Object.freeze({
  timeout_ms: 'timeoutMs',
  wait_timeout: 'waitTimeoutMs',
  settle_ms: 'settleMs',
  item_selector: 'itemSelector',
  wait_until: 'waitUntil',
  no_clear: 'noClear',
  no_focus: 'noFocus',
  full_page: 'fullPage',
  fields_json: 'fieldsJson',
});

/** 本地参数的类别与统一解释（审计要求每个本地参数都落在已知类别里）。 */
export const LOCAL_ARG_KINDS = Object.freeze({
  path: '本地文件路径（输入或输出），由工具自己读写，不进入协议 RPC 参数',
  cli: '转发给本地 CLI 子命令的参数（MCP 工具内部 spawn CLI，不经过 daemon RPC）',
  target: 'Playwright 风格的便捷目标写法，工具内部转成协议 ref/selector/stableRef',
  alias: '别名/派生参数，工具内部换算成另一个协议参数（如 duration → durationMs）',
  dispatch: '动作分发参数：工具按取值调用不同的协议方法，见 actions 声明',
  extra: '协议 schema 未声明的扩展字段，按 daemon 向后兼容的额外参数转发',
  schemaless: '对应协议方法没有 METHOD_SCHEMAS 规范 schema（daemon 侧自行校验）',
  local: '纯本地处理参数（筛选/选择/合并），不进入 RPC',
});

/**
 * 没有 METHOD_SCHEMAS 规范 schema 的协议方法：参数只能由 daemon 处理函数校验。
 * 工具映射到这些方法时，其入参在契约里声明为 schemaless 本地参数。
 *
 * 注意（M6-P0② 后）：lib/schemas.mjs 已为 status/audit.list/pair.revoke/session.* 等本地
 * 方法补齐规范 schema（task-53），因此这些方法不再列在这里；工具若已映射到它们，参数由
 * MCP↔协议 schema 审计直接对账（见 mcp/schema-audit.mjs）。这里只保留仍无 schema 的方法。
 */
export const SCHEMALESS_METHODS = Object.freeze({
  'settings.get': '扩展设置读取，无参数',
  'settings.set': '扩展设置写入：patch 由设置模块校验',
  'pair.list': '远程配对列表，无参数',
  'pair.create': '远程配对创建：ttl/label 由配对模块校验',
  'pair.redeem': '远程配对兑换：code',
  // 说明：daemon 本地方法（session.start/stop/status/audit.list/pair.revoke/session.request_*/
  // browsers/session.list）在 task-53 起都已补规范 schema，因此不再登记为 schemaless——工具入参
  // 由 MCP↔协议 schema 审计直接对账，详见 lib/schemas.mjs 与 mcp/schema-audit.mjs。
});

/** 只做本地操作（CLI/文件/更新状态），不映射任何协议方法的工具。 */
export const LOCAL_ONLY_TOOLS = Object.freeze({
  browser_update_state: '读取 ~/.browser-bridge/update-state.json',
  browser_install_skill: '把内嵌技能写到 Agent 目录',
  browser_recipe: 'recipe 由本地 CLI 管理与回放（回放时 CLI 自己连 daemon）',
  browser_update: '更新检查/下载/暂存由本地 CLI 完成',
  browser_debug_analyze: '离线分析调试采集（CLI debug analyze）',
  browser_debug_evidence: '生成本地证据包（CLI debug evidence）',
  browser_debug_journal: '读取合并调试时间线（CLI debug journal）',
  browser_debug_query: '离线查询调试归档（CLI debug query）',
  browser_debug_archive: '写调试归档文件（CLI debug archive）',
  browser_debug_archives: '列出/清理归档目录（CLI debug archives）',
  browser_trace_summary: '离线分析 Trace JSON（纯本地计算）',
  browser_video_trim: '本地 MP4 裁剪（CLI video trim）',
  browser_video_recover: '从落盘分片恢复视频；runtimeOnlyMethods 登记真实 RPC video.recover',
  browser_video_info: '本地 MP4 信息（CLI video info）',
  browser_video_split: '本地 MP4 分段（CLI video split）',
  browser_video_merge: '本地 MP4 合并（CLI video merge）',
  browser_debug_har: '导出 HAR 到本地文件（CLI debug har）',
  browser_debug_har_import: '把本地 HAR 导入为归档快照（CLI debug har-import）',
});

/**
 * 逐工具的契约差异声明（未列出的工具 = 全部入参都能直接映射到协议参数、无遗漏）。
 * 字段：
 *   local              本地参数 → 类别（LOCAL_ARG_KINDS 的 key）
 *   unexposed          { 方法: { params, reason } }：协议参数刻意不暴露
 *   requiredAdds       { 入参: reason }：MCP 比协议 schema 更严格要求的参数
 *   actions            { arg, map: { 动作: [方法...] } }：动作分发；本地 CLI 工具映射为 []
 *   unrouted           已声明方法映射但工具没有分发路径的方法（兼容性保留，附理由）
 *   runtimeOnlyMethods run() 源码里真实调用、但未登记在 TOOL_METHODS 的方法（附理由）
 *   typeWiden          MCP 类型比协议类型宽的入参（附理由；integer→number 无需声明）
 */
export const TOOL_CONTRACTS = Object.freeze({
  browser_brief: {
    unexposed: {
      observe: {
        reason: '简报是 observe 的裁剪封装：工具内部固定 maxTokens=1200/probeHover=false，其余观察参数刻意不开放，避免两个入口语义打架；需要精细观察请用 browser_observe。',
        params: [
          'probeHover', 'debugSurfaces', 'closedShadow', 'vom', 'vomDeep', 'vomTree', 'vomRank',
          'vomExplain', 'vomExcludeHidden', 'vomProfile', 'vomPerGroup', 'vomGroupTokens',
          'vomBillingModel', 'vomSemanticMaxGroups', 'vomSemanticMinScore', 'vomSemanticMaxTokens',
          'vomGroupContext', 'vomWeights', 'vomTop', 'vomMinScore', 'vomMaxNodes', 'vomMaxTokens',
          'deepMaxTokens', 'ax', 'facts', 'fallbackAx', 'compareAx', 'pipeline', 'maxTokens',
          'maxDepth', 'cursor', 'force', 'delta', 'baseline',
        ],
      },
      'dialog.status': {
        reason: '简报只读取对话框状态（pending/armed），不清理也不装配对话框；clear 会改变扩展 dialog 状态，属于 browser_dialog/CLI dialog 的写动作，不在只读简报里开放。',
        params: ['clear'],
      },
    },
  },
  // lib/schemas.mjs（task-53）已为 session.start 补规范 schema：browser/focus/incognito 直接映射；
  // tab 因 MCP 历史 schema 是 number（协议是 integer≥1）保持本地便捷参数并在此说明，
  // 其余共享/域名/配额/控制模式参数不开放（避免 MCP 会话启动面与 CLI 重叠打架）。
  browser_session_start: {
    local: { tab: 'alias' },
    unexposed: {
      'session.start': {
        reason: 'MCP 会话启动只保留 browser/tab/focus/incognito 四个便捷参数（tab 为 number 历史 schema，工具内部原样转发，范围由 daemon/会话启动器校验）；controller/scope/requestId/noFocus/share/allowDomains/denyDomains/minIntervalMs/controlMode 等精细启动参数由 CLI session start 与协议直连覆盖。noFocus 由 focus 换算（focus=true→noFocus=false），不单独开放以免两个入口语义冲突。',
        params: ['controller', 'scope', 'requestId', 'noFocus', 'share', 'allowDomains', 'denyDomains', 'minIntervalMs', 'controlMode', 'tab'],
      },
    },
  },
  // task-53 起 session.stop 有规范 schema：MCP 的 keep 直接映射协议 keep（同名同类型）。
  browser_audit: {
    local: { offset: 'extra' },
    typeWiden: {
      limit: 'MCP 历史 schema 用 number（既有调用方约束），协议 audit.list.limit 是 integer 1..500；daemon 会按整数校验，这里保留 number 避免破坏既有入参。',
    },
    unexposed: {
      'audit.list': {
        reason: 'MCP 审计工具只按 limit/offset 分页读取；since（按时间戳过滤）由 CLI audit list --since 覆盖，MCP 不开放以保持分页语义单一。',
        params: ['since'],
      },
    },
  },
  browser_settings: {
    local: { action: 'dispatch', settings: 'alias' },
    actions: { arg: 'action', map: { get: ['settings.get'], set: ['settings.set'] } },
  },
  // task-53 起 pair.revoke 有规范 schema：MCP 的 code 直接映射协议 code；deviceId 未在工具面开放。
  browser_pair: {
    local: { action: 'dispatch', ttl: 'schemaless', label: 'schemaless' },
    actions: {
      arg: 'action',
      map: {
        create: ['pair.create'],
        list: ['pair.list'],
        redeem: ['pair.redeem'],
        revoke: ['pair.revoke'],
      },
    },
    unexposed: {
      'pair.revoke': {
        reason: 'MCP 远程配对工具按 code 撤销（redeem/revoke 共用 code 入参）；deviceId（按设备 id 精确撤销）由 CLI pair revoke --device 覆盖，MCP 不开放以免两个撤销入口语义分叉。',
        params: ['deviceId'],
      },
    },
  },
  browser_install_skill: {
    local: { target: 'cli', dir: 'cli', force: 'cli' },
  },
  browser_recipe: {
    local: {
      action: 'dispatch', name: 'cli', file: 'cli', params: 'cli', confirm_human: 'cli', by: 'cli',
    },
    actions: {
      arg: 'action',
      map: { list: [], show: [], save: [], approve: [], run: [], rm: [] },
    },
  },
  browser_update: {
    local: { action: 'dispatch', source: 'cli', out: 'cli', key: 'cli', enable: 'cli' },
    actions: { arg: 'action', map: { state: [], check: [], fetch: [], auto: [] } },
  },
  browser_extract: {
    requiredAdds: { selector: 'extract 同时支持 ref 与 selector；MCP 侧把 selector 设为必填以强制目标明确（工具用 ref 时仍可绕过 CLI 校验）。' },
  },
  browser_screenshot: {
    local: { out: 'path', overlap: 'extra' },
    unexposed: {
      screenshot: {
        reason: 'MCP 截图工具只暴露落盘路径与常用长截图开关；ref/grid/scale/format/stream 等 CDP 细粒度参数走 CLI/协议直连，避免工具 schema 过宽。',
        params: ['ref', 'grid', 'gridStep', 'scale', 'visualIndex', 'profile', 'format', 'stream'],
      },
    },
  },
  browser_longshot_recover: {
    local: { out: 'path' },
    requiredAdds: {
      longshot_id: '恢复必须指定落盘长图 id',
      out: '恢复结果必须落盘（MCP 工具不返回大 base64）',
    },
    unexposed: {
      'longshot.recover': {
        reason: '工具同时接受 longshotId 与 captureId 两种 id；MCP 侧统一用 longshot_id 这一个名字，captureId 不再单独暴露。timeoutMs 由 CLI longshot recover --timeout 覆盖（恢复的分段/重试预算），MCP 固定用工具策略超时，避免调用方把等待预算设得比外层超时还短。',
        params: ['captureId', 'timeoutMs', 'scope'],
      },
    },
  },
  browser_download: {
    local: { target: 'target', overwrite: 'cli' },
    unexposed: {
      download: {
        reason: 'MCP 下载工具用 target/url 二选一的便捷写法；ref/selector/stableRef/expectRevision 由 target 解析后内部补齐，不再逐个暴露。',
        params: ['ref', 'selector', 'stableRef', 'expectRevision'],
      },
    },
  },
  browser_upload: {
    local: { target: 'target' },
    requiredAdds: {
      target: '上传必须指定目标 input[type=file]',
      files: '上传必须至少给一个本地文件（协议参数可选是为了兼容空文件选择器）',
    },
    unexposed: {
      upload: {
        reason: 'MCP 上传工具用 target + files 两个参数表达全部语义；ref/selector/stableRef/expectRevision 由 target 解析，paths 由 files 派生。',
        params: ['ref', 'selector', 'stableRef', 'expectRevision', 'paths', 'mode', 'timeoutMs'],
      },
    },
  },
  browser_pdf: {
    local: { out: 'path' },
    paramOverrides: { page_ranges: 'pages' },
    requiredAdds: { out: 'PDF 必须落盘（工具不返回大 base64）' },
    unexposed: {
      pdf: {
        reason: 'MCP PDF 工具只开放常用排版参数；纸张尺寸/preferCssPageSize/pages/margins 等精细参数走 CLI 直连。',
        params: ['preferCssPageSize', 'paperWidth', 'paperHeight'],
      },
    },
  },
  browser_tab_new: {
    unexposed: {
      'tab.new': {
        reason: 'MCP 工具只暴露 url/new_window/no_focus；windowId/focus/incognito/readOnly/allowedOrigins 由 daemon 默认策略与 CLI 其它命令覆盖。',
        params: ['windowId', 'focus', 'incognito', 'readOnly', 'allowedOrigins'],
      },
    },
  },
  browser_tab_close: {
    requiredAdds: { tab_id: '关闭必须指定标签页（协议 schema 选填是给 session 内默认 tab 用）' },
  },
  browser_tab_select: {
    requiredAdds: { tab_id: '激活必须指定标签页' },
  },
  browser_tab_move: {
    requiredAdds: {
      tab_id: '移动必须指定标签页',
      window_id: '移动必须指定目标窗口',
    },
  },
  browser_refs_negotiate: {
    requiredAdds: { stable_refs: '协商必须给出 stableRef 列表' },
    unexposed: {
      'refs.negotiate': {
        reason: 'MCP 侧只暴露批量 stable_refs；协议的单数 stableRef 由批量列表覆盖，避免两个入口。',
        params: ['stableRef'],
      },
    },
  },
  browser_trace_stop: {
    local: { output: 'path' },
  },
  browser_trace_summary: {
    local: { file: 'path' },
    requiredAdds: { file: '离线分析必须给出 Trace JSON 路径' },
  },
  browser_debug_analyze: {
    local: { file: 'local' },
  },
  browser_debug_evidence: {
    local: { out: 'path', file: 'local' },
    requiredAdds: { out: '证据包必须指定输出路径' },
  },
  browser_debug_journal: {
    local: { limit: 'cli' },
  },
  browser_debug_query: {
    local: { file: 'path', filter: 'cli' },
    requiredAdds: { file: '离线查询必须给出归档文件' },
  },
  browser_debug_archive: {
    local: { out: 'path' },
    requiredAdds: { out: '归档必须指定输出路径' },
  },
  browser_debug_archives: {
    local: { dir: 'path', prune: 'cli' },
    requiredAdds: { dir: '归档目录必须给出' },
  },
  browser_network_replay_har: {
    local: { file: 'path', entry: 'local', filter: 'local' },
    requiredAdds: { file: '重放必须给出本地 HAR 文件' },
    unexposed: {
      'network.replay': {
        reason: 'MCP 工具从本地 HAR 文件（file/entry/filter 三个本地参数）解析出重放的 id 与 request 后显式发送；不接受调用方直接注入 request/overrides，避免绕过 HAR 来源、条目校验与既有重放策略。',
        params: ['id', 'request', 'overrides'],
      },
    },
  },
  browser_debug_har: {
    local: { out: 'path' },
    requiredAdds: { out: 'HAR 必须落盘' },
  },
  browser_debug_har_import: {
    local: { file: 'path', out: 'path', name: 'cli' },
    requiredAdds: { file: '导入必须给出 HAR 文件', out: '导入快照必须落盘' },
  },
  browser_network_list: {
    local: { filter_text: 'alias' },
  },
  browser_rule_add: {
    requiredAdds: { rule: '添加规则必须给出规则对象（协议 schema 选填是为了兼容 list 复用）' },
  },
  browser_rule_set: {
    local: { action: 'dispatch' },
    actions: {
      arg: 'action',
      map: { enable: ['debug.rule_enable'], disable: ['debug.rule_disable'], remove: ['debug.rule_remove'] },
    },
    requiredAdds: {
      action: '必须指明启用/停用/删除',
      id: '必须指明规则 id',
    },
    unexposed: {
      'debug.rule_add': {
        reason: '动作分发没有 add 分支（add 由 browser_rule_add 承担）；保留 add 映射只为维持既有方法面快照，因此 rule 参数也不开放。',
        params: ['rule'],
      },
    },
    unrouted: {
      'debug.rule_add': '工具面不提供 add 分发（add 由 browser_rule_add 承担）；保留映射以维持既有方法面快照（tests/unit/protocol-mcp-requirements.test.mjs 锁定 62 个引用方法），仅参与能力/floor 派生。',
    },
  },
  browser_video_start: {
    local: { duration: 'alias' },
  },
  browser_video_stop: {
    local: { recording_id: 'alias' },
  },
  browser_video_recover: {
    runtimeOnlyMethods: {
      'video.recover': '既有分类把 browser_video_recover 记为本地工具（tests/unit/mcp-tools.test.mjs 锁定），但实现真实调用协议 video.recover；在此显式登记，避免审计把它当成静默漂移。',
    },
  },
  browser_video_trim: {
    local: { input: 'path', out: 'path', start: 'cli', end: 'cli' },
    requiredAdds: { input: '裁剪必须给出输入文件', out: '裁剪必须给出输出文件' },
  },
  browser_video_info: {
    local: { input: 'path' },
    requiredAdds: { input: '必须给出待分析 MP4 路径' },
  },
  browser_video_split: {
    local: { input: 'path', out_dir: 'path', parts: 'cli' },
    requiredAdds: { input: '分段必须给出输入文件', out_dir: '分段必须给出输出目录' },
  },
  browser_video_merge: {
    local: { inputs: 'path', out: 'path' },
    requiredAdds: { inputs: '合并必须给出输入文件列表', out: '合并必须给出输出文件' },
  },
  browser_window: {
    local: { action: 'dispatch' },
    actions: {
      arg: 'action',
      map: {
        list: ['window.list'],
        focus: ['window.focus'],
        ensure: ['window.ensureAgent'],
        resize: ['window.resize'],
      },
    },
    requiredAdds: { action: '必须指明窗口动作' },
    unexposed: {
      'window.ensureAgent': {
        reason: 'MCP 的 ensure 动作只确保 agent 窗口存在；noFocus/incognito/focus 由 daemon 窗口策略决定，工具面不开放。',
        params: ['noFocus', 'incognito', 'focus'],
      },
    },
    typeWiden: {
      window_id: 'MCP 侧沿用 number（与既有工具 schema 一致，tests/unit/mcp-tools.test.mjs 锁定 width/height 为 number）；实际取值必须是整数，daemon 会拒绝非整数。',
      width: '同上：number 历史 schema；daemon 按 integer 校验。',
      height: '同上：number 历史 schema；daemon 按 integer 校验。',
    },
  },
  browser_cooperate_sync: {
    unexposed: {
      'cooperate.sync': {
        reason: 'MCP 协作同步工具只签发 context/observation 收据；policy/probeHover/matchText/contextLines/timeoutMs 由 daemon 协作策略决定，工具面不开放以免破坏 authority 语义。',
        params: ['policy', 'probeHover', 'matchText', 'contextLines', 'timeoutMs'],
      },
    },
  },
  // task-53 起 dialog.status 有 clear、dialog.dismiss 有 id（整数）规范参数。MCP 的 dialog
  // 工具用本地 id 参数（accept/dismiss 共用，number 历史 schema）显式发送，因此 id 直接映射；
  // status 动作只读，不开放 clear。
  browser_dialog: {
    local: { action: 'dispatch' },
    actions: {
      arg: 'action',
      map: {
        status: ['dialog.status'],
        list: ['dialog.list'],
        arm: ['dialog.arm'],
        accept: ['dialog.accept'],
        dismiss: ['dialog.dismiss'],
      },
    },
    requiredAdds: { action: '必须指明对话框动作' },
    typeWiden: {
      id: 'MCP 历史 schema 用 number（accept/dismiss 共用本地 id 参数）；协议 dialog.dismiss.id 是 integer≥1，daemon 会拒绝非整数/非正数。',
    },
    unexposed: {
      'dialog.arm': {
        reason: 'MCP 工具不开放 beforeUnload 钩子（避免与浏览器导航保护策略冲突），只在 daemon 内部使用。',
        params: ['beforeUnload'],
      },
      'dialog.handle': {
        reason: 'handle 是 accept/dismiss 的统一入口；MCP 用两个显式动作，因此 handle 的 accept/dismiss 判定参数不开放。',
        params: ['accept', 'dismiss'],
      },
      'dialog.status': {
        reason: 'MCP dialog 的 status 动作是只读查询（pending/armed）；clear（清空已装配的对话框队列）属于写状态维护，由 CLI dialog 直连覆盖，不在工具面开放。',
        params: ['clear'],
      },
    },
    unrouted: {
      'dialog.handle': '工具面用 accept/dismiss 两个显式动作，不提供 handle 统一动作；保留映射以维持既有方法面快照（tests/unit/protocol-mcp-requirements.test.mjs），仅参与能力/floor 派生。',
    },
  },
  // task-53 起 status 有规范 schema（views/view/doctor/limit/limitSessions/strategy）。
  // MCP 的 browser_status 保持“固定返回 daemon 聚合快照”的既有语义，不开放视图/诊断参数。
  browser_status: {
    unexposed: {
      status: {
        reason: 'browser_status 固定返回 daemon+会话的聚合快照（既有默认载荷不变）；views/view/doctor/limit/limitSessions/strategy 等精细视图参数由 CLI status 直连覆盖，MCP 不开放以免两个入口的默认载荷/分页语义分叉。',
        params: ['views', 'view', 'doctor', 'limit', 'limitSessions', 'strategy'],
      },
    },
  },
  // M6-P0①：兼容目标 interact 的 params 字段在扩展页面处理器里真实存在（extension/injected/page-lib.js
  // 的 actionDrag/actionWheel），但 lib/schemas.mjs 未把它们收进 METHOD_SCHEMAS，因此按“协议 schema
  // 未声明的扩展字段”登记，由工具自己换算成协议参数（from/to/dx/dy/mode/holdMs/ref/selector）。
  browser_drag: {
    local: {
      source: 'extra',
      target: 'extra',
      delta: 'alias',
      mode: 'extra',
      hold_ms: 'alias',
    },
    unexposed: {
      drag: {
        reason: 'MCP 拖拽工具用 source/target/delta/mode/hold_ms 便捷参数；duration_ms/timeout_ms 等细粒度预算由 CLI/协议直连覆盖，不在工具面开放。',
        params: ['source', 'mode', 'target', 'delta', 'holdMs'],
      },
    },
  },
  browser_wheel: {
    local: { ref: 'extra', selector: 'extra' },
    unexposed: {
      wheel: {
        reason: 'MCP 滚轮工具的 ref/selector 走 local 解析；modifiers/timeout_ms 等修饰键与预算由 CLI/协议直连覆盖。',
        params: ['ref', 'selector'],
      },
    },
  },
  // M6-P0①：tracked session 的 request_* 方法在 task-53 起已有规范 schema（requestId/browser/
  // focus/noFocus/incognito/tab）。MCP 的 request_id/browser/no_focus/incognito 直接映射；
  // focus/tab 未在工具面开放（prepare 的 tab 由 browser 选择器与 CLI --tab 覆盖）。
  browser_session_request_prepare: {
    unexposed: {
      'session.request_prepare': {
        reason: 'MCP 的 prepare 只保留 request_id/browser/no_focus/incognito 四个便捷参数；focus/tab（窗口置前与显式标签页选择）由 CLI session request 与 session start --tab 覆盖，不在 MCP 工具面开放。',
        params: ['focus', 'tab'],
      },
    },
  },
  // 三个 request 动作必须带 request_id（兼容目标 tools.rs:887-897 对 prepare 之外的 request action
  // 明确报错 request_id is required；协议 schema 把 requestId 设为选填是为了兼容内部调用）。
  browser_session_request_status: {
    requiredAdds: { request_id: '查询启动请求必须给出 request_id（兼容目标同：除 prepare 外 request_id 必填）' },
  },
  browser_session_request_claim: {
    requiredAdds: { request_id: '认领启动请求必须给出 request_id（兼容目标同：除 prepare 外 request_id 必填）' },
  },
  browser_session_request_cancel: {
    requiredAdds: { request_id: '取消启动请求必须给出 request_id（兼容目标同：除 prepare 外 request_id 必填）' },
  },
  // M6-P0②：emulate 的线上字段（viewport/userAgent/acceptLanguage/platform）由工具内部按
  // CLI 同一换算从扁平参数生成（见 mcp/tools-m6b.mjs 的 buildEmulateParams）；MCP 不直接
  // 暴露这四个线字段，避免同一语义出现“扁平参数”和“线上字段”两个入口。
  browser_assist_emulate: {
    unexposed: {
      emulate: {
        reason: 'MCP 工具用兼容目标 assist 风格的扁平参数（device/width/height/dpr/mobile/ua/timezone/locale/geolocation/touch/reset），run 内部按 CLI bridge emulate 的同一换算生成扩展读取的 viewport/userAgent/acceptLanguage/platform（cli/commands/emulate.mjs:23-52）；这四个线上字段不作为 MCP 入参，避免同一语义两个入口。',
        params: ['viewport', 'userAgent', 'acceptLanguage', 'platform'],
      },
    },
  },
  // M6-P0②：request-help 的 reason 是“要用户做什么”的提示文案（扩展 requestHelp 缺它会直接
  // E_BAD_ARG，extension/src/tabs-help.js:19-21），兼容目标 assist 的 prompt 同样必填
  // （tools.rs:1988-1995 的 RequestHelpParams.prompt 不是 Option）；协议 schema 把它设成选填
  // 是为了内部调用兼容，MCP 侧收紧为必填。criteria 是扩展已实现、规范 schema 未登记的扩展字段
  // （完成条件），按 extra 原样转发。
  browser_assist_request_help: {
    local: { criteria: 'extra' },
    requiredAdds: {
      reason: '人工协助必须说明要用户做什么（扩展 requestHelp 缺 reason 直接 E_BAD_ARG；兼容目标 assist prompt 同为必填）',
    },
  },
  // M6-P0②：兼容目标 assist 用 operation_id 命名；我方协议/CLI/扩展线上字段是 id
  // （cli/commands/cooperate.mjs:70-89、extension/src/dispatch.js:133-137）。工具把
  // operation_id 换算成 id 发送，不静默丢参；两者语义完全一致。
  browser_assist_operation_await: {
    local: { operation_id: 'alias' },
  },
  browser_assist_operation_cancel: {
    local: { operation_id: 'alias' },
  },
});

/** 契约差异声明的工具名集合（审计用来核对“声明了不存在的工具”）。 */
export const CONTRACT_TOOL_NAMES = Object.freeze(Object.keys(TOOL_CONTRACTS));

/** 审计用的严格模式开关：运行时默认 strict（任一条失败即抛）。 */
export const AUDIT_CODES = Object.freeze([
  'tool-set', 'method-map', 'method-unknown', 'method-schemaless', 'local-only',
  'schema-shape', 'arg-undeclared', 'local-unknown', 'type-mismatch', 'enum-mismatch',
  'default-mismatch', 'range-mismatch', 'required-missing-prop', 'required-extra', 'required-protocol',
  'unexposed-undeclared', 'unexposed-stale', 'unexposed-declaration', 'dispatch-arg', 'dispatch-enum',
  'dispatch-methods', 'dispatch-unrouted', 'runtime-arg', 'runtime-method',
  'feature-floor', 'contract-orphan',
]);
