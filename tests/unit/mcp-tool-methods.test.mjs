import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { createBrowserTools } from '../../mcp/tools.mjs';

const tools = createBrowserTools({
  rpc: async () => ({}),
  ensureSession: async () => 's1',
  withSession: (sessionId, params) => ({ ...params, session: sessionId }),
  parseDurationMs: () => 1000,
  runCliJson: async () => ({}),
  HOME: '/tmp',
});

test('每个 MCP 工具都有协议方法映射', () => {
  assert.equal(tools.length, 92);
  assert.equal(Object.keys(TOOL_METHODS).length, 92);
  for (const tool of tools) {
    assert.ok(Array.isArray(TOOL_METHODS[tool.name]), '缺少映射：' + tool.name);
  }
});

test('协议方法映射覆盖工具 methods', () => {
  for (const tool of tools) {
    tool.methods = TOOL_METHODS[tool.name];
    assert.deepEqual(tool.methods, TOOL_METHODS[tool.name], tool.name);
  }
});
