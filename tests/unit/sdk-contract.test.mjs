// tests/unit/sdk-contract.test.mjs —— Node SDK ↔ 协议单源 / MCP 工具面 / 错误码清单的契约对齐。
//
// 断言 SDK 暴露的契约快照与 lib/ 的单源数据逐项一致；任何一侧漂移都会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeRpcError,
  SDK_CONTRACT,
  TOOL_PAGINATION,
  methodProtocolGate,
  normalizeErrorCode,
  protocolSupports,
  toolProtocolGate,
  isProtocolUnsupportedCode,
} from '../../sdk/index.mjs';
import { ERROR_CODE_LIST, ERROR_RECOVERY, ERROR_CODES } from '../../lib/error-codes.mjs';
import {
  FEATURE_FLOORS,
  FEATURE_NAMES,
  METHOD_FEATURE,
  METHOD_NAMES,
  METHOD_PARTIAL,
  METHOD_UNKNOWN,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import { TOOLS } from '../../mcp/server.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { policyFor } from '../../mcp/tool-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SDK_CONTRACT 的协议版本 / feature floor / 方法状态与 lib 单源一致', () => {
  assert.equal(SDK_CONTRACT.protocol.current, PROTOCOL_CURRENT);
  assert.equal(SDK_CONTRACT.protocol.baseline, PROTOCOL_BASELINE);
  assert.deepEqual(SDK_CONTRACT.features.names, [...FEATURE_NAMES]);
  assert.deepEqual(SDK_CONTRACT.features.floors, FEATURE_FLOORS);
  assert.deepEqual(SDK_CONTRACT.methods.names, [...METHOD_NAMES]);
  assert.deepEqual(SDK_CONTRACT.methods.feature, METHOD_FEATURE);
  assert.deepEqual(SDK_CONTRACT.methods.partial, [...METHOD_PARTIAL]);
  assert.deepEqual(SDK_CONTRACT.methods.unknown, [...METHOD_UNKNOWN]);
  assert.equal(SDK_CONTRACT.methods.total, METHOD_NAMES.length);
  for (const method of METHOD_NAMES) {
    const floor = SDK_CONTRACT.methods.floors[method];
    const expected = METHOD_FEATURE[method] ? FEATURE_FLOORS[METHOD_FEATURE[method]] : undefined;
    assert.equal(floor, expected, method);
  }
  // 每个方法都有五维状态快照
  assert.equal(Object.keys(SDK_CONTRACT.methods.states).length, METHOD_NAMES.length);
  assert.equal(Object.keys(SDK_CONTRACT.methods.effects).length, METHOD_NAMES.length);
});

test('SDK_CONTRACT 错误码清单 / 含义 / 恢复建议与 lib 一致', () => {
  assert.deepEqual(SDK_CONTRACT.errors.codes, [...ERROR_CODE_LIST]);
  assert.deepEqual(SDK_CONTRACT.errors.details, ERROR_CODES);
  assert.deepEqual(SDK_CONTRACT.errors.recovery, ERROR_RECOVERY);
  assert.equal(SDK_CONTRACT.errors.unsupportedCode, 'E_PROTOCOL_UNSUPPORTED');
  for (const code of ERROR_CODE_LIST) {
    assert.ok(SDK_CONTRACT.errors.details[code].length > 0, code);
  }
});

test('SDK 工具面与 MCP 92 工具 / 分档 / 分页完全一致', () => {
  assert.deepEqual(SDK_CONTRACT.tools.names, TOOLS.map((tool) => tool.name));
  assert.equal(SDK_CONTRACT.tools.names.length, 92);
  for (const tool of TOOLS) {
    const policy = policyFor(tool.name, tool);
    const pagination = TOOL_PAGINATION[tool.name];
    assert.deepEqual(pagination.methods, (TOOL_METHODS[tool.name] || []).filter((method) => METHOD_PARTIAL.includes(method)));
    assert.equal(pagination.partial, pagination.methods.length > 0, tool.name);
    assert.equal(SDK_CONTRACT.tools.tiers.byTier[policy.tier] >= 1, true, tool.name);
  }
  const partialTools = TOOLS.filter((tool) => TOOL_PAGINATION[tool.name].partial).map((tool) => tool.name).sort();
  assert.deepEqual([...SDK_CONTRACT.tools.tiers.paginated].sort(), partialTools);
  const approvals = TOOLS.filter((tool) => policyFor(tool.name, tool).approvalRequired).map((tool) => tool.name).sort();
  assert.deepEqual([...SDK_CONTRACT.tools.tiers.approvals].sort(), approvals);
});

test('methodProtocolGate：1.8 对端缺 1.9 特性，click 不受影响，参数级门生效', () => {
  assert.equal(methodProtocolGate('read', {}, '1.8').ok, false);
  assert.equal(methodProtocolGate('read', {}, '1.9').ok, true);
  assert.equal(methodProtocolGate('click', {}, '1.8').ok, true);
  const unverified = methodProtocolGate('click', { unverified: true }, '1.8');
  assert.equal(unverified.ok, false);
  assert.deepEqual(unverified.missing.map((row) => row.feature).sort(), ['unverified']);
  assert.equal(unverified.code, 'E_PROTOCOL_UNSUPPORTED');
  const delta = methodProtocolGate('observe', { delta: true }, '1.8');
  assert.ok(delta.features.includes('observe-delta'));
  assert.equal(delta.ok, false);
  assert.ok(protocolSupports('1.9', 'observe-delta') === true || protocolSupports('read', '1.9'));
});

test('toolProtocolGate：工具级特性门并集（video/har/plan）', () => {
  const video = toolProtocolGate('browser_video_start', { methods: ['video.start'], featureGates: ['video'] }, '1.8');
  assert.equal(video.ok, false);
  assert.deepEqual(video.missing.map((row) => row.feature), ['video']);
  assert.equal(toolProtocolGate('browser_video_start', { methods: ['video.start'], featureGates: ['video'] }, '1.9').ok, true);
  assert.equal(toolProtocolGate('browser_click', { methods: ['click'], featureGates: [] }, '1.8').ok, true);
  assert.equal(toolProtocolGate('browser_network_replay_har', { methods: ['network.replay'], featureGates: ['har'] }, '1.8').ok, false);
  assert.equal(toolProtocolGate('browser_plan', { methods: ['plan'], featureGates: ['plan'] }, '1.8').ok, false);
  assert.equal(isProtocolUnsupportedCode('E_PROTOCOL_UNSUPPORTED'), true);
  assert.equal(isProtocolUnsupportedCode('E_UNSUPPORTED_CAPABILITY'), true);
  assert.equal(isProtocolUnsupportedCode('E_TIMEOUT'), false);
});

test('BridgeRpcError 归一未知码并保留错误 data/effectState', () => {
  const error = new BridgeRpcError('E_NOT_A_REAL_CODE', 'boom', { data: { effect_state: 'unknown', detail: 1 }, method: 'click' });
  assert.equal(error.code, 'E_INTERNAL');
  assert.equal(error.effectState, 'unknown');
  assert.deepEqual(error.data, { effect_state: 'unknown', detail: 1 });
  assert.equal(error.method, 'click');
  assert.equal(normalizeErrorCode('E_TIMEOUT'), 'E_TIMEOUT');
  assert.equal(normalizeErrorCode('nope'), 'E_INTERNAL');
});

test('TypeScript 声明覆盖全部 92 个工具名与新增导出', () => {
  const dts = fs.readFileSync(path.join(ROOT, 'sdk', 'index.d.ts'), 'utf8');
  const missing = TOOLS.map((tool) => tool.name).filter((name) => !dts.includes("'" + name + "'"));
  assert.deepEqual(missing, [], 'd.ts 缺少工具名：' + missing.join(', '));
  for (const token of ['ToolSpec', 'ToolTier', 'ToolPagination', 'ToolCallOptions', 'SDK_CONTRACT', 'ToolName', 'callTool', 'toolProtocolGate']) {
    assert.ok(dts.includes(token), 'd.ts 缺少 ' + token);
  }
  assert.ok(dts.includes('readonly toolRuntime'));
});

test('SDK 契约快照可序列化（客户端可直接打印/落盘）', () => {
  const text = JSON.stringify(SDK_CONTRACT);
  assert.ok(text.length > 5000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.tools.names.length, 92);
  assert.equal(parsed.methods.total, METHOD_NAMES.length);
  assert.equal(parsed.errors.codes.length, ERROR_CODE_LIST.length);
});
