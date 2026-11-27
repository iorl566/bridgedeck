import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

function setup() {
  const calls = [];
  const tools = buildToolSpecs(async (argv) => { calls.push(argv); return { ok: true }; });
  return { tools, calls };
}

test('browser_recipe save/approve/list 参数', async () => {
  const { tools, calls } = setup();
  const tool = tools.find((item) => item.name === 'browser_recipe');
  await tool.execute({ action: 'list' }, {});
  await tool.execute({ action: 'save', name: 'r1', file: 'r.json' }, {});
  await tool.execute({ action: 'approve', name: 'r1', confirmHuman: true, by: 'e2e' }, {});
  assert.deepEqual(calls[0], ['recipe', 'list']);
  assert.deepEqual(calls[1], ['recipe', 'save', 'r1', '--file', 'r.json']);
  assert.deepEqual(calls[2], ['recipe', 'approve', 'r1', '--confirm-human', '--by', 'e2e']);
});

test('browser_recipe approve 必须 confirmHuman', async () => {
  const { tools } = setup();
  const tool = tools.find((item) => item.name === 'browser_recipe');
  await assert.rejects(() => tool.execute({ action: 'approve', name: 'r1' }, {}), /confirmHuman=true/);
});
