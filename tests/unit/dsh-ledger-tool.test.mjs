import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

function setup() {
  const calls = [];
  const tools = buildToolSpecs(async (argv, exec) => { calls.push(argv); return { ok: true, exec }; });
  return { tools, calls };
}

test('browser_ledger status/resolve 调用 CLI', async () => {
  const { tools, calls } = setup();
  const tool = tools.find((item) => item.name === 'browser_ledger');
  assert.ok(tool, '缺少 browser_ledger');
  await tool.execute({ action: 'status' }, {});
  await tool.execute({ action: 'resolve', id: 'lt_abc', outcome: 'done' }, {});
  assert.deepEqual(calls[0], ['ledger', 'status']);
  assert.deepEqual(calls[1], ['ledger', 'resolve', 'lt_abc', '--outcome', 'done']);
});

test('browser_ledger resolve 缺少 id 报错', async () => {
  const { tools } = setup();
  const tool = tools.find((item) => item.name === 'browser_ledger');
  await assert.rejects(() => tool.execute({ action: 'resolve' }, {}), /resolve 需要 id/);
});
