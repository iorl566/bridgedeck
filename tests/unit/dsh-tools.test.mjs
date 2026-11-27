import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

const tools = buildToolSpecs(async () => ({}));

test('DSH 工具表 37 个且名称唯一', () => {
  assert.equal(tools.length, 37);
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 37);
  for (const tool of tools) {
    assert.match(tool.name, /^browser_[a-z_]+$/, tool.name);
    assert.ok(tool.description, tool.name + ' 缺少描述');
    assert.ok(tool.parameters && typeof tool.parameters === 'object', tool.name + ' 缺少参数');
    assert.equal(typeof tool.execute, 'function', tool.name + ' 缺少 execute');
  }
});

test('DSH 关键工具存在', () => {
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of ['browser_plan', 'browser_ledger', 'browser_recipe', 'browser_observe', 'browser_act', 'browser_session_start']) {
    assert.ok(names.has(name), '缺少工具：' + name);
  }
});
