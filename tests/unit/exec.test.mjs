import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from '../../cli/exec.mjs';

test('page 方法可用，返回值透传', async () => {
  const calls = [];
  const page = { click: async (target) => { calls.push(target); return { ok: true }; } };
  const out = await runScript({ code: "const r = await page.click('#a'); return { r, n: 1 + 1 };", page, timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(JSON.stringify(out.result)), { r: { ok: true }, n: 2 });
  assert.deepEqual(calls, ['#a']);
});

test('不暴露 require/process/fs', async () => {
  const out = await runScript({ code: "return [typeof require, typeof process, typeof fetch];", page: {}, timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(JSON.stringify(out.result)), ['undefined', 'undefined', 'undefined']);
});

test('console 被捕获', async () => {
  const out = await runScript({ code: "console.log('hello', { a: 1 }); return 1;", page: {}, timeoutMs: 5000 });
  assert.equal(out.result, 1);
  assert.equal(out.logs[0].level, 'log');
  assert.match(out.logs[0].text, /hello/);
});

test('超时会拒绝', async () => {
  await assert.rejects(
    runScript({ code: "await new Promise(() => {});", page: {}, timeoutMs: 1000 }),
    /超时/,
  );
});
