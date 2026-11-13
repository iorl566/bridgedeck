import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../mcp/server.mjs';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';

// 这些工具只做本地 CLI/文件操作，不直接映射 daemon RPC 方法。
const LOCAL_ONLY = new Set([
  'browser_update_state',
  'browser_install_skill',
  'browser_recipe',
  'browser_update',
  'browser_debug_analyze',
  'browser_debug_evidence',
  'browser_debug_journal',
  'browser_debug_query',
  'browser_debug_archive',
  'browser_debug_archives',
]);

test('MCP 工具数量、命名与协议方法映射', () => {
  assert.equal(TOOLS.length, 50);
  assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length);
  for (const tool of TOOLS) {
    assert.match(tool.name, /^browser_[a-z_]+$/, tool.name);
    assert.ok(Array.isArray(tool.methods), tool.name + ' 缺少 methods');
    for (const method of tool.methods) {
      assert.ok(METHOD_EFFECT[method], tool.name + ' 映射了未知方法 ' + method);
    }
    if (tool.methods.length === 0) assert.ok(LOCAL_ONLY.has(tool.name), tool.name + ' 空映射但不在本地工具清单');
    if (LOCAL_ONLY.has(tool.name)) assert.equal(tool.methods.length, 0, tool.name);
  }
});

test('生成的页面动作 schema 暴露 actionability 选项', () => {
  const click = TOOLS.find((tool) => tool.name === 'browser_click');
  assert.equal(click.methods[0], 'click');
  assert.equal(click.inputSchema.properties.trusted.type, 'boolean');
  assert.equal(click.inputSchema.properties.force.type, 'boolean');
  assert.equal(click.inputSchema.properties.wait_timeout.type, 'integer');
  const fill = TOOLS.find((tool) => tool.name === 'browser_fill');
  assert.deepEqual(fill.inputSchema.required, ['value']);
  assert.equal(fill.inputSchema.properties.no_clear.type, 'boolean');
});

test('控制类工具也从规范 schema 生成', () => {
  const tabs = TOOLS.find((tool) => tool.name === 'browser_tabs');
  assert.equal(tabs.inputSchema.properties.scope.type, 'string');
  const close = TOOLS.find((tool) => tool.name === 'browser_tab_close');
  assert.deepEqual(close.inputSchema.required, ['tab_id']);
  const wait = TOOLS.find((tool) => tool.name === 'browser_wait_for');
  assert.equal(wait.inputSchema.properties.state.type, 'string');
  assert.equal(wait.inputSchema.properties.operation_id.type, 'string');
  const record = TOOLS.find((tool) => tool.name === 'browser_record_start');
  assert.equal(record.inputSchema.properties.purpose.type, 'string');
  assert.equal(record.inputSchema.properties.max_page_tokens.type, 'integer');
  const video = TOOLS.find((tool) => tool.name === 'browser_video_status');
  assert.equal(video.inputSchema.properties.recording.type, 'string');
  const videoStart = TOOLS.find((tool) => tool.name === 'browser_video_start');
  assert.equal(videoStart.inputSchema.properties.duration_ms.type, 'integer');
  assert.equal(videoStart.inputSchema.properties.duration.type, 'string');
  const videoStop = TOOLS.find((tool) => tool.name === 'browser_video_stop');
  assert.equal(videoStop.inputSchema.properties.recording.type, 'string');
  assert.equal(videoStop.inputSchema.properties.recording_id.type, 'string');
  const network = TOOLS.find((tool) => tool.name === 'browser_network_list');
  assert.equal(network.inputSchema.properties.filter.type, 'object');
  assert.equal(network.inputSchema.properties.filter_text.type, 'string');
  assert.equal(network.inputSchema.properties.since.type, 'integer');
  const window = TOOLS.find((tool) => tool.name === 'browser_window');
  assert.equal(window.inputSchema.properties.width.type, 'number');
  assert.equal(window.inputSchema.properties.height.type, 'number');
  const dialog = TOOLS.find((tool) => tool.name === 'browser_dialog');
  assert.ok(dialog.inputSchema.properties.action.enum.includes('arm'));
  assert.equal(dialog.inputSchema.properties.prompt_text.type, 'string');
  const debugStart = TOOLS.find((tool) => tool.name === 'browser_debug_start');
  assert.equal(debugStart.inputSchema.properties.name.type, 'string');
  assert.equal(debugStart.inputSchema.properties.bodies.type, 'boolean');
  const ruleAdd = TOOLS.find((tool) => tool.name === 'browser_rule_add');
  assert.deepEqual(ruleAdd.inputSchema.required, ['rule']);
  assert.equal(ruleAdd.inputSchema.properties.rule.type, 'object');
});

test('所有 MCP inputSchema 都是封闭对象', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.inputSchema.properties, 'object', tool.name);
  }
});
