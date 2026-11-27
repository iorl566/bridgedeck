// tests/unit/protocol-mcp-requirements.test.mjs —— MCP 工具级协议要求由方法目录派生。
//
// MCP 工具数由 mcp/server.mjs 的 TOOLS 决定（数量变化不影响本文件的协议映射断言）；每个工具的方法映射来自 mcp/tool-methods.mjs，工具的
// featureGates / minProtocol 由 lib/method-catalog.mjs 派生（不在 MCP 侧再抄一份）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, toolProtocolRequirements } from '../../mcp/server.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import {
  FEATURE_FLOORS,
  FEATURE_NAMES,
  METHOD_FEATURE,
  METHOD_NAMES,
  floorOf,
} from '../../lib/method-catalog.mjs';

const NAMES = TOOLS.map((tool) => tool.name).sort();
const KNOWN_METHODS = new Set(METHOD_NAMES);

test('MCP 工具名与方法映射一一对应（数量取 TOOLS.length）', () => {
  assert.ok(TOOLS.length > 0);
  assert.equal(NAMES.length, TOOLS.length);
  assert.deepEqual(Object.keys(TOOL_METHODS).sort(), NAMES);
  assert.equal(new Set(NAMES).size, TOOLS.length);
});

test('每个工具的 featureGates/minProtocol 都由 METHOD_FEATURE/floorOf 派生', () => {
  for (const tool of TOOLS) {
    assert.ok(Array.isArray(tool.methods), tool.name);
    assert.deepEqual(tool.methods, TOOL_METHODS[tool.name], tool.name);
    const expectedGates = [...new Set(tool.methods.map((method) => METHOD_FEATURE[method]).filter(Boolean))].sort();
    assert.deepEqual(tool.featureGates, expectedGates, tool.name + ' featureGates 与目录不一致');
    const expectedFloors = [...new Set(tool.methods.map((method) => floorOf(method)).filter(Boolean))].sort();
    assert.equal(tool.minProtocol, expectedFloors.length ? expectedFloors[expectedFloors.length - 1] : null, tool.name);
    for (const gate of tool.featureGates) {
      assert.ok(FEATURE_NAMES.includes(gate), tool.name + ' 引用了未知特性 ' + gate);
      assert.equal(FEATURE_FLOORS[gate], '1.9');
    }
    for (const method of tool.methods) {
      assert.ok(KNOWN_METHODS.has(method), tool.name + ' 引用了目录外方法 ' + method);
    }
  }
});

test('视频 / HAL / 调试工具映射到对应 gated 能力', () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get('browser_video_start').featureGates, ['video']);
  assert.deepEqual(byName.get('browser_video_stop').featureGates, ['video']);
  assert.deepEqual(byName.get('browser_video_status').featureGates, ['video']);
  assert.deepEqual(byName.get('browser_video_list').featureGates, ['video']);
  assert.deepEqual(byName.get('browser_network_replay_har').featureGates, ['har']);
  assert.deepEqual(byName.get('browser_plan').featureGates, ['plan']);
  assert.deepEqual(byName.get('browser_read').featureGates, ['read']);
  assert.equal(byName.get('browser_video_start').minProtocol, '1.9');
  assert.equal(byName.get('browser_click').minProtocol, null, '无方法级特性门的工具不要求 floor');
  assert.deepEqual(byName.get('browser_click').featureGates, []);
});

test('toolProtocolRequirements 快照：gated 工具数与特性集合稳定', () => {
  const snapshot = toolProtocolRequirements();
  assert.equal(snapshot.total, TOOLS.length);
  assert.deepEqual(snapshot.tools.map((row) => row.name).sort(), NAMES);
  assert.ok(snapshot.gated > 0, '应有 gated 工具');
  assert.equal(snapshot.gated, TOOLS.filter((tool) => tool.featureGates.length > 0).length);
  const features = new Set(snapshot.tools.flatMap((row) => row.featureGates));
  assert.deepEqual([...features].sort(), [...new Set(TOOLS.flatMap((tool) => tool.featureGates))].sort());
  for (const feature of features) assert.ok(FEATURE_NAMES.includes(feature));
  for (const row of snapshot.tools) {
    if (row.featureGates.length) assert.equal(row.minProtocol, '1.9', row.name);
  }
  // 传自定义工具列表时只派生，不修改入参
  const custom = toolProtocolRequirements([{ name: 'x', methods: ['video.start'] }]);
  assert.equal(custom.total, 1);
  assert.deepEqual(custom.tools[0].featureGates, ['video']);
  assert.equal(custom.tools[0].minProtocol, '1.9');
});

test('MCP 工具方法映射引用的方法都在 canonical 目录内', () => {
  const referenced = new Set(Object.values(TOOL_METHODS).flat());
  // MCP 工具数会随任务批次增长（对接 mcp/server.mjs），这里只守住“引用方法都合法 + 核心 gated 方法仍在”。
  assert.ok(referenced.size >= 80, 'MCP 引用的唯一方法数异常变少：' + referenced.size);
  for (const method of referenced) assert.ok(KNOWN_METHODS.has(method), '未知方法 ' + method);
  const gatedReferenced = [...referenced].filter((method) => METHOD_FEATURE[method]);
  assert.ok(gatedReferenced.length >= 8, 'gated 方法引用数异常变少：' + gatedReferenced.length);
  for (const method of ['longshot.recover', 'network.replay', 'plan', 'read', 'video.start']) {
    assert.ok(gatedReferenced.includes(method), '缺少核心 gated 方法引用：' + method);
  }
});
