// tests/unit/mcp-tool-policy.test.mjs —— MCP 工具分级 / 审批 / 超时 / annotations 测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../mcp/server.mjs';
import {
  APPROVAL_ALWAYS,
  APPROVAL_CONFIRMED,
  APPROVAL_ENV,
  APPROVAL_META_KEY,
  TIERS,
  annotationsFor,
  approvalDisabled,
  approvalGate,
  assertToolPolicies,
  auditToolPolicies,
  policyFor,
  policySnapshot,
} from '../../mcp/tool-policy.mjs';

test('92 个工具全部分级，策略审计 clean', () => {
  const report = auditToolPolicies(TOOLS);
  assert.equal(report.ok, true, report.errors.map((error) => error.code + ':' + error.tool).join(','));
  assert.equal(report.stats.tools, 92);
  assert.deepEqual(report.stats, { tools: 92, read: 36, mutate: 49, destructive: 7, approvals: 7, timeouts: report.stats.timeouts });
  assert.ok(report.stats.timeouts > 0);
  assert.equal(assertToolPolicies(TOOLS).ok, true);
});

test('read/mutate/destructive 与 annotations 一一对应', () => {
  assert.deepEqual(Object.values(TIERS).sort(), ['destructive', 'mutate', 'read']);
  for (const tool of TOOLS) {
    const policy = policyFor(tool.name, tool);
    const annotations = annotationsFor(tool.name, tool);
    assert.equal(annotations.title, policy.title);
    assert.equal(annotations.readOnlyHint, policy.readOnly);
    assert.equal(annotations.destructiveHint, policy.destructive);
    assert.equal(annotations.idempotentHint, policy.idempotent);
    assert.equal(annotations.openWorldHint, policy.openWorld);
    assert.ok(policy.timeoutMs >= 1000, tool.name);
    assert.ok(policy.title.length > 0, tool.name);
    if (policy.readOnly) assert.equal(policy.approvalRequired, false, tool.name);
    if (policy.destructive) assert.equal(policy.approvalRequired, true, tool.name);
  }
});

test('关键工具分级符合语义', () => {
  const expectTier = {
    browser_status: 'read',
    browser_observe: 'read',
    browser_brief: 'read',
    browser_read: 'read',
    browser_extract: 'read',
    browser_click: 'mutate',
    browser_fill: 'mutate',
    browser_navigate: 'mutate',
    browser_evaluate: 'destructive',
    browser_session_stop: 'destructive',
    browser_tab_close: 'destructive',
    browser_settings: 'destructive',
    browser_pair: 'destructive',
    browser_recipe: 'destructive',
    browser_update: 'destructive',
    // M6-P0②：inspect html / assist / session 查询的分级（effect 派生 + 两个只读覆盖）。
    browser_inspect_html: 'read',
    browser_assist_emulate: 'mutate',
    browser_assist_request_help: 'mutate',
    browser_assist_operation_await: 'read',
    browser_assist_operation_cancel: 'mutate',
    browser_session_browsers: 'read',
    browser_session_list: 'read',
  };
  for (const [name, tier] of Object.entries(expectTier)) {
    const policy = policyFor(name, TOOLS.find((tool) => tool.name === name));
    assert.equal(policy.tier, tier, name);
  }
  assert.equal(policyFor('browser_evaluate', TOOLS.find((tool) => tool.name === 'browser_evaluate')).approvalRequired, true);
});

test('幂等 / openWorld 标记可解释', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.equal(policyFor('browser_observe', byName.get('browser_observe')).idempotent, true);
  assert.equal(policyFor('browser_click', byName.get('browser_click')).idempotent, false);
  assert.equal(policyFor('browser_navigate', byName.get('browser_navigate')).idempotent, true);
  assert.equal(policyFor('browser_trace_summary', byName.get('browser_trace_summary')).openWorld, false);
  assert.equal(policyFor('browser_observe', byName.get('browser_observe')).openWorld, true);
  assert.equal(policyFor('browser_update', byName.get('browser_update')).openWorld, true);
});

test('超时分档：read < mutate < destructive，长任务有覆盖', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const read = policyFor('browser_status', byName.get('browser_status')).timeoutMs;
  const mutate = policyFor('browser_click', byName.get('browser_click')).timeoutMs;
  const destructive = policyFor('browser_evaluate', byName.get('browser_evaluate')).timeoutMs;
  assert.ok(read < mutate && mutate < destructive, [read, mutate, destructive].join('<'));
  assert.ok(policyFor('browser_screenshot', byName.get('browser_screenshot')).timeoutMs > mutate);
  assert.ok(policyFor('browser_video_merge', byName.get('browser_video_merge')).timeoutMs >= 300_000);
});

test('审批闸门：显式开启时未确认返回 E_HUMAN_GATE，确认后放行；默认不强制', () => {
  const evaluate = TOOLS.find((tool) => tool.name === 'browser_evaluate');
  // 默认（未设置 BB_MCP_APPROVAL）保持既有本地自动化：destructive 工具直接执行。
  assert.equal(approvalGate('browser_evaluate', { _meta: {} }, { tool: evaluate, env: {} }), null);
  const enforced = { [APPROVAL_ENV]: 'required' };
  const blocked = approvalGate('browser_evaluate', { _meta: {} }, { tool: evaluate, env: enforced });
  assert.ok(blocked && blocked.isError === true);
  assert.match(blocked.content[0].text, /E_HUMAN_GATE/);
  assert.equal(blocked._meta[APPROVAL_META_KEY].required, true);
  assert.equal(blocked._meta['browser-bridge/retry'], 'after-action');
  const passed = approvalGate('browser_evaluate', { _meta: { [APPROVAL_META_KEY]: APPROVAL_CONFIRMED } }, { tool: evaluate, env: enforced });
  assert.equal(passed, null);
  const truthy = approvalGate('browser_evaluate', { _meta: { [APPROVAL_META_KEY]: true } }, { tool: evaluate, env: enforced });
  assert.equal(truthy, null);
  // read 工具根本没有闸门
  const observe = TOOLS.find((tool) => tool.name === 'browser_observe');
  assert.equal(approvalGate('browser_observe', {}, { tool: observe, env: enforced }), null);
});

test('APPROVAL_ALWAYS 工具即使默认/关闭也要求确认', () => {
  const update = TOOLS.find((tool) => tool.name === 'browser_update');
  assert.ok(update);
  for (const env of [{}, { [APPROVAL_ENV]: 'off' }]) {
    const gated = approvalGate('browser_update', { _meta: {} }, { tool: update, env });
    assert.ok(gated && gated.isError === true, JSON.stringify(env));
  }
});

test('BB_MCP_APPROVAL=off 可关闭审批，但 APPROVAL_ALWAYS 例外', () => {
  assert.equal(approvalDisabled({ [APPROVAL_ENV]: 'off' }), true);
  assert.equal(approvalDisabled({ [APPROVAL_ENV]: '1' }), false);
  assert.equal(approvalDisabled({}), false);
  const evaluate = TOOLS.find((tool) => tool.name === 'browser_evaluate');
  const bypass = approvalGate('browser_evaluate', {}, { tool: evaluate, env: { [APPROVAL_ENV]: 'off' } });
  assert.equal(bypass, null);
  const update = TOOLS.find((tool) => tool.name === 'browser_update');
  const always = approvalGate('browser_update', {}, { tool: update, env: { [APPROVAL_ENV]: 'off' } });
  assert.ok(always && always.isError === true, 'browser_update 必须始终审批');
  assert.deepEqual([...APPROVAL_ALWAYS], ['browser_update']);
});

test('策略快照包含分档统计与审批清单', () => {
  const snapshot = policySnapshot(TOOLS);
  assert.equal(snapshot.total, 92);
  assert.equal(snapshot.byTier.read + snapshot.byTier.mutate + snapshot.byTier.destructive, 92);
  assert.ok(snapshot.approvals.includes('browser_update'));
  assert.equal(snapshot.approvals.length, snapshot.byTier.destructive);
  for (const row of snapshot.tools) {
    assert.ok(Array.isArray(row.methods));
    assert.ok(['read', 'mutate', 'destructive'].includes(row.tier));
  }
});

test('策略审计能抓到 read 工具映射变异方法 / 缺失策略', () => {
  const status = TOOLS.find((tool) => tool.name === 'browser_status');
  const drifted = { ...status, methods: ['click'] }; // read 覆盖策略但映射浏览器变异方法
  const report = auditToolPolicies([...TOOLS.filter((tool) => tool.name !== 'browser_status'), drifted]);
  const codes = report.errors.map((error) => error.code);
  assert.ok(codes.includes('policy-read'), codes.join(','));
  const missing = auditToolPolicies([...TOOLS, { name: 'browser_not_real', methods: [], inputSchema: { type: 'object', properties: {} } }]);
  assert.ok(missing.errors.some((error) => error.code === 'policy-missing' && error.tool === 'browser_not_real'));
});
