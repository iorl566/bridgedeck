import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

function setup() {
  const calls = [];
  const tools = buildToolSpecs(async (argv) => { calls.push(argv); return { ok: true }; });
  return { tools, calls };
}

test('browser_act click/fill 参数', async () => {
  const { tools, calls } = setup();
  const tool = tools.find((item) => item.name === 'browser_act');
  await tool.execute({ action: 'click', ref: '@e1' }, {});
  await tool.execute({ action: 'fill', ref: '@e2', value: 'hello' }, {});
  assert.deepEqual(calls[0], ['click', '@e1']);
  assert.deepEqual(calls[1], ['fill', '@e2', '--value', 'hello']);
});

test('browser_act 缺少目标报错', async () => {
  const { tools } = setup();
  const tool = tools.find((item) => item.name === 'browser_act');
  await assert.rejects(() => tool.execute({ action: 'click' }, {}), /ref/);
});
