// tests/unit/mcp-schema-audit.test.mjs —— MCP 92 工具 ↔ 协议 catalog 双向硬审计的测试。
//
// 覆盖两个方向：
//   1. 真实工具集 + 契约声明 → 审计必须 clean（否则 server 启动就会失败）；
//   2. 人为注入每一类漂移 → 审计必须报出对应 code（证明审计不是空转）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_CONTRACT_AUDIT } from '../../mcp/server.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { CONTRACT_TOOL_NAMES, TOOL_CONTRACTS } from '../../mcp/tool-contracts.mjs';
import { METHOD_SCHEMAS } from '../../lib/schemas.mjs';
import { METHOD_FEATURE } from '../../lib/method-catalog.mjs';
import {
  auditToolContracts,
  collectRuntimeArgs,
  collectRuntimeMethods,
  describeToolContract,
  protocolParamName,
} from '../../mcp/schema-audit.mjs';

const cloneTools = () => TOOLS.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) }));
const cloneMethods = () => structuredClone(TOOL_METHODS);

function errorCodes(report) {
  return report.errors.map((error) => error.code);
}

test('真实 92 工具集审计 clean，且统计非空', () => {
  const report = auditToolContracts({ tools: TOOLS, toolMethods: TOOL_METHODS });
  assert.equal(report.ok, true, report.errors.map((error) => error.code + ':' + error.tool + ':' + error.message).join('\n'));
  assert.equal(report.stats.tools, 92);
  // 统计值从当前协议目录派生（schema/特性门会随协议演进变化，不把数字写死在测试里）。
  const mapped = TOOLS.flatMap((tool) => TOOL_METHODS[tool.name] || []);
  assert.equal(report.stats.schemaLessMethods, mapped.filter((method) => !METHOD_SCHEMAS[method]).length);
  assert.equal(report.stats.gatedMethods, mapped.filter((method) => METHOD_FEATURE[method]).length);
  assert.ok(report.stats.mappedArgs >= 100, '映射参数 ' + report.stats.mappedArgs);
  assert.ok(report.stats.localArgs >= 60, '本地参数 ' + report.stats.localArgs);
  assert.ok(report.stats.unexposedParams >= 60, '刻意不暴露参数 ' + report.stats.unexposedParams);
  assert.ok(report.stats.dispatchedMethods >= 15, '动作分发方法 ' + report.stats.dispatchedMethods);
  assert.equal(TOOL_CONTRACT_AUDIT.ok, true);
});

test('契约声明没有多余工具名，且每个工具都能给出契约视图', () => {
  const names = new Set(TOOLS.map((tool) => tool.name));
  assert.deepEqual(CONTRACT_TOOL_NAMES.filter((name) => !names.has(name)), []);
  assert.ok(Object.keys(TOOL_CONTRACTS).length >= 40);
  for (const tool of TOOLS) {
    tool.methods = TOOL_METHODS[tool.name];
    const view = describeToolContract(tool, { toolMethods: TOOL_METHODS });
    assert.equal(view.name, tool.name);
    assert.deepEqual(view.required, [...(tool.inputSchema.required || [])]);
    assert.equal(typeof view.params, 'object');
    for (const [arg, info] of Object.entries(view.params)) {
      assert.ok(['envelope', 'local', 'protocol'].includes(info.kind), tool.name + '.' + arg);
    }
  }
});

test('协议参数名反解覆盖别名与通用 camelCase', () => {
  assert.equal(protocolParamName('wait_timeout'), 'waitTimeoutMs');
  assert.equal(protocolParamName('max_tokens'), 'maxTokens');
  assert.equal(protocolParamName('no_clear'), 'noClear');
  assert.equal(protocolParamName('full_page'), 'fullPage');
  assert.equal(protocolParamName('tab_id'), 'tabId');
  assert.equal(protocolParamName('backend_id'), 'backendId');
  assert.equal(protocolParamName('stable_refs'), 'stableRefs');
});

test('运行时代码扫描：args.X 与字面量 rpc 方法可被抽取', () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'browser_click');
  const args = collectRuntimeArgs(tool);
  assert.ok(args.includes('ref'));
  assert.ok(args.includes('selector'));
  assert.ok(args.includes('trusted'));
  const dialog = TOOLS.find((candidate) => candidate.name === 'browser_dialog');
  // accept/dismiss 走 rpc(method, ...) 动态分发，字面量只应抽出 status/list/arm。
  assert.deepEqual(collectRuntimeMethods(dialog), ['dialog.arm', 'dialog.list', 'dialog.status']);
  const observe = TOOLS.find((candidate) => candidate.name === 'browser_observe');
  assert.deepEqual(collectRuntimeMethods(observe), ['observe']);
});

test('注入：协议参数既没覆盖也没声明 → unexposed-undeclared', () => {
  const tools = cloneTools();
  const click = tools.find((tool) => tool.name === 'browser_click');
  delete click.inputSchema.properties.stable_ref; // 覆盖 stableRef 的入参被删
  const report = auditToolContracts({ tools, toolMethods: TOOL_METHODS });
  assert.ok(errorCodes(report).includes('unexposed-undeclared'), errorCodes(report).join(','));
});

test('注入：类型不符 → type-mismatch；枚举不符 → enum-mismatch', () => {
  const tools = cloneTools();
  const click = tools.find((tool) => tool.name === 'browser_click');
  click.inputSchema.properties.trusted = { type: 'string' };
  const dialog = tools.find((tool) => tool.name === 'browser_dialog');
  dialog.inputSchema.properties.action.enum = ['status', 'accept'];
  const report = auditToolContracts({ tools, toolMethods: TOOL_METHODS });
  const codes = errorCodes(report);
  assert.ok(codes.includes('type-mismatch'), codes.join(','));
  assert.ok(codes.includes('dispatch-enum'), codes.join(','));
});

test('注入：必填不一致 → required-protocol / required-extra', () => {
  const tools = cloneTools();
  const fill = tools.find((tool) => tool.name === 'browser_fill');
  fill.inputSchema.required = []; // 协议 fill 要求 value
  const observe = tools.find((tool) => tool.name === 'browser_observe');
  observe.inputSchema.required = ['cursor']; // cursor 不是协议必填，且没写 requiredAdds
  const report = auditToolContracts({ tools, toolMethods: TOOL_METHODS });
  const codes = errorCodes(report);
  assert.ok(codes.includes('required-protocol'), codes.join(','));
  assert.ok(codes.includes('required-extra'), codes.join(','));
});

test('注入：方法映射漂移 → method-unknown；本地参数类别非法 → local-unknown', () => {
  const tools = cloneTools();
  const methods = cloneMethods();
  methods.browser_click = ['click', 'no.such.method'];
  const tools2 = cloneTools();
  const policy = TOOL_CONTRACTS.browser_window.local; // 不改全局契约，改用本地副本注入
  assert.ok(policy);
  const contracts = { ...TOOL_CONTRACTS };
  const reportUnknown = auditToolContracts({ tools, toolMethods: methods });
  assert.ok(errorCodes(reportUnknown).includes('method-unknown'), errorCodes(reportUnknown).join(','));

  const reportLocal = auditToolContracts({
    tools: tools2,
    toolMethods: TOOL_METHODS,
    contracts: { ...contracts, browser_navigate: { local: { url: 'unknown-kind' } } },
  });
  assert.ok(errorCodes(reportLocal).includes('local-unknown'), errorCodes(reportLocal).join(','));
});

test('注入：run() 读取死参数 / 调用未登记 RPC → runtime-arg / runtime-method', () => {
  const tools = cloneTools();
  const click = tools.find((tool) => tool.name === 'browser_click');
  click.run = async (args) => ({ value: args.dead_parameter });
  const observe = tools.find((tool) => tool.name === 'browser_observe');
  observe.run = async () => rpc('nope.method');
  const report = auditToolContracts({ tools, toolMethods: TOOL_METHODS });
  const codes = errorCodes(report);
  assert.ok(codes.includes('runtime-arg'), codes.join(','));
  assert.ok(codes.includes('runtime-method'), codes.join(','));
});

test('注入：契约孤儿 / 方法映射缺失 → contract-orphan / method-map', () => {
  const contracts = { ...TOOL_CONTRACTS, browser_not_a_tool: { local: {} } };
  const report = auditToolContracts({ tools: TOOLS, toolMethods: TOOL_METHODS, contracts });
  assert.ok(errorCodes(report).includes('contract-orphan'), errorCodes(report).join(','));
  const methods = cloneMethods();
  delete methods.browser_click;
  const reportMissing = auditToolContracts({ tools: TOOLS, toolMethods: methods });
  assert.ok(errorCodes(reportMissing).includes('method-map'), errorCodes(reportMissing).join(','));
});

test('注入：动作分发方法并集不一致 → dispatch-methods', () => {
  const contracts = {
    ...TOOL_CONTRACTS,
    browser_window: {
      ...TOOL_CONTRACTS.browser_window,
      actions: { arg: 'action', map: { list: ['window.list'], focus: ['window.focus'], ensure: ['window.ensureAgent'], resize: ['window.resize'], extra: ['window.close'] } },
    },
  };
  const report = auditToolContracts({ tools: TOOLS, toolMethods: TOOL_METHODS, contracts });
  const codes = errorCodes(report);
  assert.ok(codes.includes('dispatch-methods'), codes.join(','));
  assert.ok(codes.includes('dispatch-enum'), codes.join(','));
});

test('审计错误码全部在登记清单内，格式稳定', () => {
  for (const error of TOOL_CONTRACT_AUDIT.errors) {
    assert.match(error.code, /^[a-z-]+$/);
    assert.equal(typeof error.tool, 'string');
    assert.equal(typeof error.message, 'string');
  }
});
