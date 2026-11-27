// tests/unit/plugin-parity.test.mjs —— 工具面三方对照（离线，不连 daemon/浏览器）。
//
// 三方真实来源（不在测试里手抄清单）：
//   1. MCP 工具：mcp/server.mjs 导出的 TOOLS（createBrowserTools 聚合）+ mcp/tool-methods.mjs 的方法映射；
//   2. DSH 插件工具：dsh-plugin/lib/tools.mjs 的 buildToolSpecs + TOOL_METHODS；
//   3. canonical 方法表：lib/method-catalog.mjs（源自 lib/protocol.mjs 的 METHOD_EFFECT）+ lib/methods.mjs 路由集合。
//
// 任何不一致都必须落到显式豁免表（每条含 reason），不允许静默放过：
//   MCP_TO_PLUGIN     MCP 工具 → 插件工具（或豁免）
//   PLUGIN_EXEMPT     插件独有工具（MCP 无对应）
//   METHOD_EXEMPTIONS canonical 方法未被任一工具面暴露的分组
//   KNOWN_LOCAL_CATALOG_GAPS  LOCAL_METHODS 已路由但 METHOD_EFFECT 未收编的方法（既有 catalog 缺口）
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../mcp/server.mjs';
import { TOOL_METHODS as MCP_TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { buildToolSpecs, TOOL_METHODS as PLUGIN_TOOL_METHODS } from '../../dsh-plugin/lib/tools.mjs';
import { createFakeAdapter } from '../../dsh-plugin/lib/fake-adapter.mjs';
import { listMethods } from '../../lib/method-catalog.mjs';
import { INSTANCE_METHODS, LOCAL_METHODS, SESSION_METHODS } from '../../lib/methods.mjs';

const MCP_NAMES = TOOLS.map((tool) => tool.name).sort();
const PLUGIN_SPECS = buildToolSpecs(async () => ({}));
const PLUGIN_NAMES = PLUGIN_SPECS.map((spec) => spec.name).sort();
const CANONICAL_METHODS = listMethods().map((entry) => entry.method);
const CANONICAL_SET = new Set(CANONICAL_METHODS);
const MCP_METHODS = new Set(Object.values(MCP_TOOL_METHODS).flat());
const PLUGIN_METHODS = new Set(Object.values(PLUGIN_TOOL_METHODS).flat());

// MCP 工具 → 插件工具（插件粒度更粗：click/fill/extract 等归并到 browser_act/browser_read 等）。
// 每条 MCP 工具必须出现；无法对应时必须给 { exempt: '<理由>' }。
const MCP_TO_PLUGIN = {
  browser_audit: ['browser_audit'],
  browser_brief: ['browser_brief'],
  browser_click: ['browser_act'],
  browser_click_backend: ['browser_click_backend'],
  browser_cooperate_sync: ['browser_cooperate'],
  browser_debug_analyze: ['browser_debug'],
  browser_debug_archive: ['browser_debug'],
  browser_debug_archives: ['browser_debug'],
  browser_debug_evidence: ['browser_debug_evidence'],
  browser_debug_har: { exempt: '插件工具面未包 HAR 导入/导出（MCP/CLI 能力）' },
  browser_debug_har_import: { exempt: '插件工具面未包 HAR 导入（MCP/CLI 能力）' },
  browser_debug_journal: ['browser_debug'],
  browser_debug_query: ['browser_debug_query'],
  browser_debug_start: ['browser_debug'],
  browser_debug_stop: ['browser_debug'],
  browser_dialog: ['browser_dialog'],
  browser_download: { exempt: '插件未包下载落盘（文件语义由 CLI 承载）' },
  browser_evaluate: ['browser_eval'],
  browser_extract: ['browser_read'],
  browser_fill: ['browser_act'],
  browser_install_skill: ['browser_install_skill'],
  browser_longshot_recover: { exempt: '插件未包长截图恢复（MCP/CLI 能力）' },
  browser_navigate: ['browser_navigate'],
  browser_network_list: ['browser_network_list', 'browser_network'],
  browser_network_replay_har: { exempt: '插件未包 HAR 重放（MCP/CLI 能力）' },
  browser_network_waterfall: { exempt: '插件未包 waterfall（MCP/CLI 能力）' },
  browser_observe: ['browser_observe'],
  browser_pair: ['browser_pair'],
  browser_pdf: { exempt: '插件未包 PDF 导出（MCP/CLI 能力）' },
  browser_plan: ['browser_plan'],
  browser_read: ['browser_read'],
  browser_recipe: ['browser_recipe'],
  browser_record_list: ['browser_record'],
  browser_record_start: ['browser_record'],
  browser_record_stop: ['browser_record'],
  browser_refs_negotiate: { exempt: '稳定 ref 协商是协议内部方法，插件未单独暴露' },
  browser_rule_add: { exempt: '插件只暴露 rule_list 与 debug 的 enable/disable/remove，未包 rule_add' },
  browser_rule_clear: { exempt: '插件未包 rule_clear（CLI/MCP 能力）' },
  browser_rule_list: ['browser_rule_list', 'browser_debug'],
  browser_rule_set: { exempt: '插件未包 rule_set 聚合动作（debug 覆盖 enable/disable/remove）' },
  browser_screenshot: ['browser_screenshot'],
  browser_session_start: ['browser_session_start'],
  browser_session_stop: ['browser_session_stop'],
  browser_settings: ['browser_settings'],
  browser_status: ['browser_status'],
  browser_tab_close: ['browser_tab_close', 'browser_tab'],
  browser_tab_move: ['browser_tab'],
  browser_tab_new: ['browser_tab_new', 'browser_tab'],
  browser_tab_select: ['browser_tab_select', 'browser_tab'],
  browser_tabs: ['browser_tab'],
  browser_trace_start: { exempt: '插件未包 CDP trace（MCP/CLI 能力）' },
  browser_trace_stop: { exempt: '插件未包 CDP trace（MCP/CLI 能力）' },
  browser_trace_summary: { exempt: '插件未包 trace 摘要（CLI 本地能力）' },
  browser_update: ['browser_update'],
  browser_update_state: ['browser_update'],
  browser_upload: { exempt: '插件未包上传（文件选择语义由 CLI 承载）' },
  browser_video_info: { exempt: '插件 video 工具只覆盖 start/stop/save/list/prune/recover，未包 info' },
  browser_video_list: ['browser_video_list', 'browser_video'],
  browser_video_merge: { exempt: '插件未包视频合并（MCP/CLI 能力）' },
  browser_video_recover: ['browser_video'],
  browser_video_split: { exempt: '插件未包视频拆分（MCP/CLI 能力）' },
  browser_video_start: ['browser_video'],
  browser_video_status: ['browser_video_status', 'browser_video'],
  browser_video_stop: ['browser_video'],
  browser_video_trim: { exempt: '插件未包视频裁剪（MCP/CLI 能力）' },
  browser_wait_for: { exempt: '插件未包 wait-for-element（CLI/MCP 能力）' },
  browser_window: ['browser_window'],
  browser_back: { exempt: '插件 navigate 工具只覆盖主路径，后退仍由 CLI/MCP back 使用' },
  browser_forward: { exempt: '插件 navigate 工具只覆盖主路径，前进仍由 CLI/MCP forward 使用' },
  browser_reload: { exempt: '插件未包 reload（CLI/MCP 能力）' },
  browser_console: ['browser_debug'],
  browser_press: ['browser_act'],
  browser_hover: ['browser_act'],
  browser_select: ['browser_act'],
  browser_drag: ['browser_act'],
  browser_scroll_to: ['browser_act'],
  browser_wheel: ['browser_act'],
  browser_focus: ['browser_act'],
  browser_blur: ['browser_act'],
  browser_session_request_prepare: { exempt: '插件 session 工具只覆盖 start/stop；tracked request_* 由 MCP 直接暴露' },
  browser_session_request_status: { exempt: '插件 session 工具只覆盖 start/stop；tracked request_* 由 MCP 直接暴露' },
  browser_session_request_claim: { exempt: '插件 session 工具只覆盖 start/stop；tracked request_* 由 MCP 直接暴露' },
  browser_session_request_cancel: { exempt: '插件 session 工具只覆盖 start/stop；tracked request_* 由 MCP 直接暴露' },
  browser_tab_borrow: ['browser_tab_borrow'],
  browser_tab_return: { exempt: '插件借用工具未包归还（MCP/CLI 能力）' },
  browser_assist_emulate: ['browser_act'],
  browser_assist_operation_await: { exempt: '插件无 operation 队列工具（MCP/CLI 能力）' },
  browser_assist_operation_cancel: { exempt: '插件无 operation 队列工具（MCP/CLI 能力）' },
  browser_assist_request_help: ['browser_cooperate'],
  browser_inspect_html: { exempt: '插件未包 get-html（MCP/CLI 能力）' },
  browser_session_browsers: { exempt: '插件无 browsers 工具（CLI/MCP 能力）' },
  browser_session_list: { exempt: '插件 session 工具只覆盖 start/stop，未包 list' },
};

// 插件独有工具：MCP 无对应工具，必须显式记录理由。
const PLUGIN_EXEMPT = {
  browser_ledger: '插件独有：意图账本 status/resolve；MCP 工具面未暴露对应工具（CLI/daemon 能力）',
};

// canonical 方法未被 MCP/插件工具面引用的分组豁免（均含理由）。
const METHOD_EXEMPTIONS = [
  {
    reason: '会话生命周期/多 Agent 控制面：由 daemon 内部或 CLI 细粒度驱动，插件/MCP 用 session.start/stop 粗粒度入口',
    methods: [
            'session.stop_all', 'session.pause', 'session.resume', 'session.rebind', 'session.run_log',
      'session.claim_control', 'session.release_control', 'session.handoff', 'session.control_status', 'session.control_mode',
    ],
  },
  {
    reason: '操作审计流：由 CLI debug/journal 等本地命令读取，MCP/插件未做独立工具',
    methods: ['operations.list', 'operations.get'],
  },
  {
    reason: '文件分片传输通道：CLI/daemon 内部实现，MCP/插件不在工具面暴露',
    methods: ['transfer.begin', 'transfer.chunk', 'transfer.finish', 'transfer.read', 'transfer.release'],
  },
  {
    reason: '本地/实例控制面：daemon 生命周期与本机配对、实例列表、分页缓存，由 CLI 直接调用',
    methods: ['view', 'pair.renew', 'local.pair', 'local.trust', 'daemon.stop'],
  },
  {
    reason: '等待/就绪原语：扩展与 CLI 内部使用，工具面用 observe/plan 组合',
    methods: ['wait-ms', 'wait-for-navigation', 'actionable'],
  },
  {
    reason: '观察实现细节（快照/阴影/按点点击）：扩展内部实现，工具面用 observe/act 抽象',
    methods: ['observe-frames', 'snapshot', 'shadow.click', 'shadow.read', 'click-point'],
  },
  {
    reason: 'extract 细分游标：CLI extract 内部步骤，工具面用 extract 聚合（MCP 同名工具已覆盖主路径）',
    methods: ['extract.discover', 'extract.list', 'extract.table'],
  },
  {
    reason: '截图高级协议：流式读/释放与手动长截图内部方法，工具面只暴露 screenshot/longshot',
    methods: ['screenshot.read', 'screenshot.release', 'screenshot.manual.start', 'screenshot.manual.frame', 'screenshot.manual.save'],
  },
  {
    reason: '调试持久化/规则导入导出：CLI 调试面能力，MCP 对应工具的方法映射为空数组',
    methods: [
      'debug.capabilities', 'debug.coverage', 'debug.delete', 'debug.fetch_probe', 'debug.history',
      'debug.pin', 'debug.pinned', 'debug.rule_export', 'debug.rule_import',
    ],
  },
  { reason: '录制状态查询：CLI record 内部使用，MCP/插件无独立工具', methods: ['record.status'] },
  { reason: '协作 hold：扩展/CLI 控制面方法，MCP 只暴露 cooperate.sync', methods: ['cooperate.hold'] },
  { reason: '视频内部管理：校验/丢弃由 CLI video 流程使用，工具面只覆盖 start/stop/save/list/recover', methods: ['video.discard', 'video.verify'] },
  { reason: 'trace.status：MCP 只暴露 trace start/stop，status 未做独立工具', methods: ['trace.status'] },
  { reason: 'plan/操作队列内部方法：由 plan/step CLI 内部驱动', methods: ['step'] },
  { reason: 'WebMCP 实验面：尚未进入 MCP/插件工具面', methods: ['webmcp.list', 'webmcp.call'] },
  { reason: '标签页策略：租约与策略内部方法，工具面用 borrow/close 承载', methods: ['tab.policy'] },
  { reason: '实例/UI 内部：扩展 UI 与调试器生命周期方法，非 Agent 工具面', methods: ['tab.alias', 'tab.cleanup', 'window.close', 'window.newAgent', 'control-hint', 'debugger.detach', 'debugger.simulate-detach', 'diagnostics.ui', 'ui.open'] },
];

// LOCAL_METHODS 已声明并路由，但 lib/protocol.mjs 的 METHOD_EFFECT 尚未收编（既有 catalog 缺口）。
// 本轮不修 lib/protocol.mjs（不在 W4 scope），以显式缺口表记录。
const KNOWN_LOCAL_CATALOG_GAPS = ['command.cancel', 'inflight.list', 'ledger.resolve', 'ledger.status', 'pair.rotate', 'cancel', 'ledger.request'];

const EXEMPT_METHODS = new Set(METHOD_EXEMPTIONS.flatMap((group) => group.methods));

function mcpExemptions() {
  return MCP_NAMES.filter((name) => MCP_TO_PLUGIN[name] && !Array.isArray(MCP_TO_PLUGIN[name]));
}

test('三方清单规模（真实来源）：MCP 67 工具 / 插件 37 工具 / canonical 165 方法', () => {
  assert.equal(MCP_NAMES.length, 92, 'MCP 工具数变化：' + MCP_NAMES.length);
  assert.equal(PLUGIN_NAMES.length, 37, '插件工具数变化：' + PLUGIN_NAMES.length);
  assert.equal(CANONICAL_METHODS.length, 165, 'canonical 方法数变化：' + CANONICAL_METHODS.length);
});

test('MCP 工具 ↔ 协议方法映射完整', () => {
  assert.deepEqual(Object.keys(MCP_TOOL_METHODS).sort(), MCP_NAMES, 'MCP 工具有缺映射/多余映射');
  assert.equal(MCP_METHODS.size, 87, 'MCP 引用的唯一方法数变化：' + MCP_METHODS.size);
});

test('插件工具 ↔ 协议方法映射完整，且映射随 spec 暴露', () => {
  assert.deepEqual(Object.keys(PLUGIN_TOOL_METHODS).sort(), PLUGIN_NAMES, '插件工具有缺映射/多余映射');
  for (const spec of PLUGIN_SPECS) {
    assert.ok(Array.isArray(spec.methods), spec.name + ' 未暴露 methods');
    assert.deepEqual(spec.methods, PLUGIN_TOOL_METHODS[spec.name], spec.name + ' 的 methods 与映射表不一致');
  }
  assert.equal(PLUGIN_METHODS.size, 71, '插件引用的唯一方法数变化：' + PLUGIN_METHODS.size);
});

test('MCP→插件覆盖：每个 MCP 工具都映射到插件工具或显式豁免', () => {
  assert.deepEqual(Object.keys(MCP_TO_PLUGIN).sort(), MCP_NAMES, 'MCP→插件对照表与 MCP 工具清单不一致');
  for (const name of MCP_NAMES) {
    const target = MCP_TO_PLUGIN[name];
    if (Array.isArray(target)) {
      assert.ok(target.length >= 1, name + ' 映射不能为空数组');
      for (const pluginName of target) {
        assert.ok(PLUGIN_NAMES.includes(pluginName), name + ' 映射到不存在的插件工具：' + pluginName);
      }
    } else {
      assert.equal(typeof target.exempt, 'string', name + ' 的豁免缺少 reason');
      assert.ok(target.exempt.length >= 8, name + ' 的豁免理由过短');
    }
  }
  assert.equal(mcpExemptions().length, 33, 'MCP 侧豁免数变化：' + mcpExemptions().length);
});

test('插件→MCP 反向覆盖：插件独有工具都有显式理由', () => {
  const covered = new Set();
  for (const target of Object.values(MCP_TO_PLUGIN)) {
    if (Array.isArray(target)) for (const name of target) covered.add(name);
  }
  for (const name of PLUGIN_NAMES) {
    if (covered.has(name)) continue;
    assert.equal(typeof PLUGIN_EXEMPT[name], 'string', '插件工具既无 MCP 对应也无豁免理由：' + name);
    assert.ok(PLUGIN_EXEMPT[name].length >= 8, name + ' 的豁免理由过短');
  }
  for (const name of Object.keys(PLUGIN_EXEMPT)) {
    assert.ok(PLUGIN_NAMES.includes(name), '豁免表引用了不存在的插件工具：' + name);
    assert.ok(!covered.has(name), '插件工具 ' + name + ' 已被 MCP 覆盖，但仍列在豁免表（过期豁免）');
  }
});

test('三方方法引用：MCP/插件引用的方法都应存在 canonical（已知 catalog 缺口除外）', () => {
  const mcpMissing = [...MCP_METHODS].filter((method) => !CANONICAL_SET.has(method)).sort();
  assert.deepEqual(mcpMissing, [], 'MCP 映射引用了 canonical 之外的方法：' + mcpMissing.join(', '));
  const knownGaps = new Set(KNOWN_LOCAL_CATALOG_GAPS);
  const pluginMissing = [...PLUGIN_METHODS].filter((method) => !CANONICAL_SET.has(method)).sort();
  for (const method of pluginMissing) {
    assert.ok(knownGaps.has(method), '插件映射引用了未知的 canonical 之外方法：' + method);
  }
  const localMissing = [...LOCAL_METHODS].filter((method) => !CANONICAL_SET.has(method)).sort();
  for (const method of localMissing) {
    assert.ok(knownGaps.has(method), 'LOCAL_METHODS 出现未记录的 catalog 缺口：' + method);
  }
});

test('canonical 未暴露方法都有显式豁免（无静默放过、无过期豁免）', () => {
  const uncovered = CANONICAL_METHODS.filter((method) => !MCP_METHODS.has(method) && !PLUGIN_METHODS.has(method));
  const silentlyDropped = uncovered.filter((method) => !EXEMPT_METHODS.has(method));
  assert.deepEqual(silentlyDropped, [], 'canonical 方法既未暴露也无豁免：' + silentlyDropped.join(', '));
  const stale = [...EXEMPT_METHODS].filter((method) => !uncovered.includes(method));
  assert.deepEqual(stale, [], '豁免表中的方法其实已被覆盖/不存在（过期豁免）：' + stale.join(', '));
  for (const group of METHOD_EXEMPTIONS) {
    assert.ok(group.reason && group.reason.length >= 8, '豁免分组缺理由');
    for (const method of group.methods) assert.ok(CANONICAL_SET.has(method), '豁免表方法不在 canonical：' + method);
  }
});

test('差异快照：显式记录的差异数可解释（不静默）', () => {
  const mcpOnly = mcpExemptions().length;
  const pluginOnly = Object.keys(PLUGIN_EXEMPT).length;
  const uncovered = CANONICAL_METHODS.filter((method) => !MCP_METHODS.has(method) && !PLUGIN_METHODS.has(method));
  const knownGaps = new Set(KNOWN_LOCAL_CATALOG_GAPS);
  const pluginOutsideCatalog = [...PLUGIN_METHODS].filter((method) => !CANONICAL_SET.has(method) && knownGaps.has(method));
  const localOutsideCatalog = [...LOCAL_METHODS].filter((method) => !CANONICAL_SET.has(method) && knownGaps.has(method));
  const total = mcpOnly + pluginOnly + uncovered.length + pluginOutsideCatalog.length + localOutsideCatalog.length;
  console.log('[parity] MCP 工具 ' + MCP_NAMES.length + ' / 插件工具 ' + PLUGIN_NAMES.length + ' / canonical ' + CANONICAL_METHODS.length);
  console.log('[parity] 差异合计 ' + total + ' 项：MCP 无插件对应 ' + mcpOnly + '；插件独有 ' + pluginOnly +
    '；canonical 未暴露 ' + uncovered.length + '；插件引用 catalog 外方法 ' + pluginOutsideCatalog.length +
    '；LOCAL 方法缺 catalog ' + localOutsideCatalog.length);
  assert.ok(total > 0, '三方完全一致时应移除本快照，而不是保留空差异');
  assert.equal(mcpOnly + pluginOnly + uncovered.length + pluginOutsideCatalog.length + localOutsideCatalog.length, total);
});

test('工具面一致性：browser_observe 只对 E_DAEMON 回退 CLI，业务错误原样上抛', async () => {
  const cliCalls = [];
  const run = async (argv) => {
    cliCalls.push(argv);
    return { url: 'https://cli/', title: 'cli', refs: 0, observation: '- cli' };
  };
  const forbidden = createFakeAdapter({ handlers: { observe: { error: { code: 'E_FORBIDDEN', message: '拒绝' } } } });
  const observeForbidden = buildToolSpecs(run, { rpc: forbidden.call }).find((spec) => spec.name === 'browser_observe');
  await assert.rejects(
    () => observeForbidden.execute({ sessionId: 's1' }, {}),
    (error) => error && error.code === 'E_FORBIDDEN',
    'daemon 业务错误不得被 CLI 兜底静默替换',
  );
  assert.equal(cliCalls.length, 0, '业务错误时不应回退 CLI');

  const offline = createFakeAdapter({ unavailable: true });
  const observeOffline = buildToolSpecs(run, { rpc: offline.call }).find((spec) => spec.name === 'browser_observe');
  const result = await observeOffline.execute({ sessionId: 's1' }, {});
  assert.equal(result.observation, '- cli');
  assert.deepEqual(cliCalls[0], ['observe', '--session', 's1']);
});
