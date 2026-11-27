import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

test('browser_plan 把 steps 序列化给 CLI', async () => {
  const calls = [];
  const tools = buildToolSpecs(async (argv, exec) => { calls.push(argv); return { ok: true }; });
  const tool = tools.find((item) => item.name === 'browser_plan');
  assert.ok(tool, '缺少 browser_plan');
  const steps = [{ method: 'click', params: { ref: '@e1' } }];
  await tool.execute({ steps, sessionId: 's1' }, {});
  assert.equal(calls[0][0], 'plan');
  assert.equal(calls[0][1], '--steps');
  assert.deepEqual(JSON.parse(calls[0][2]), steps);
  assert.deepEqual(calls[0].slice(3), ['--session', 's1']);
});
