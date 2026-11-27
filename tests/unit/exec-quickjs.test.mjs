import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuickJS, buildPrelude } from '../../cli/exec-quickjs.mjs';
import { createExecPage, LOCATOR_METHODS, PAGE_METHODS } from '../../lib/exec-page.mjs';

/** 假 page：read / wait-for-element / evaluate 等返回固定结构，click #missing 抛 E_NOT_FOUND。 */
function fakePage() {
  const calls = [];
  const page = createExecPage((method, params = {}) => {
    calls.push({ method, params });
    if (method === 'read') {
      if (params.fields && params.fields.length) {
        const field = params.fields[0];
        if (field.read === 'attribute') return { fields: [{ value: 'out' }] };
        return { fields: [{ text: '按钮文案' }] };
      }
      return { fields: [{ value: 'v1', disabled: false }] };
    }
    if (method === 'wait-for-element') return { satisfied: params.state === 'visible' || params.state === 'attached' };
    if (method === 'evaluate') return { value: 3 };
    if (method === 'actionable') return { ok: true, reason: '' };
    if (method === 'click' && params.selector === '#missing') {
      const error = new Error('找不到元素：' + params.selector);
      error.code = 'E_NOT_FOUND';
      error.data = { selector: params.selector };
      throw error;
    }
    return { ok: true };
  });
  return { calls, page };
}

test('QuickJS prelude 暴露与 vm 相同的 page / locator 方法面', async () => {
  const { page } = fakePage();
  const out = await runQuickJS({
    code: 'return { page: Object.keys(page).sort(), locator: Object.keys(page.locator("#x")).sort() };',
    page,
    timeoutMs: 10000,
  });
  assert.deepEqual(out.result.page, [...PAGE_METHODS, 'locator', 'webmcp'].sort());
  assert.deepEqual(out.result.locator, [...LOCATOR_METHODS].sort());
  // prelude 里确实生成了这些方法（防漂移）
  const prelude = buildPrelude();
  for (const name of LOCATOR_METHODS) assert.ok(prelude.includes(name + ': op('), name);
});

test('QuickJS 同步契约：连续 25 次 host 调用稳定', async () => {
  const { calls, page } = fakePage();
  const code = 'let last;\n'
    + Array.from({ length: 25 }, (_, i) => 'last = page.read("#x' + i + '");').join('\n')
    + '\nreturn last.fields[0].value;';
  const out = await runQuickJS({ code, page, timeoutMs: 20000 });
  assert.equal(out.result, 'v1');
  assert.equal(calls.length, 25);
  assert.equal(calls[24].params.selector, '#x24');
});

test('QuickJS locator：读取面取到真实结构', async () => {
  const { page } = fakePage();
  const out = await runQuickJS({
    code: [
      "page.locator('#kw').fill('hi');",
      "const v = page.locator('#kw').inputValue();",
      "const t = page.locator('#out').textContent();",
      "const attr = page.locator('#out').getAttribute('id');",
      "const vis = page.locator('#out').isVisible();",
      "const cnt = page.locator('button').count();",
      "const enabled = page.locator('#kw').isEnabled();",
      "const act = page.locator('#kw').actionable();",
      'return { v, t, attr, vis, cnt, enabled, actOk: act.ok };',
    ].join('\n'),
    page,
    timeoutMs: 20000,
  });
  assert.deepEqual(out.result, { v: 'v1', t: '按钮文案', attr: 'out', vis: true, cnt: 3, enabled: true, actOk: true });
});

test('QuickJS 错误码/数据跨边界保留', async () => {
  const { page } = fakePage();
  const out = await runQuickJS({
    code: [
      "try { page.locator('#missing').click(); return { code: 'no-throw' }; }",
      'catch (e) { return { code: e.code, message: e.message, selector: e.data && e.data.selector }; }',
    ].join('\n'),
    page,
    timeoutMs: 10000,
  });
  assert.equal(out.result.code, 'E_NOT_FOUND');
  assert.match(out.result.message, /找不到元素/);
  assert.equal(out.result.selector, '#missing');
});

test('QuickJS 未捕获的 host 错误以原错误码冒泡', async () => {
  const { page } = fakePage();
  await assert.rejects(
    runQuickJS({ code: "page.locator('#missing').click(); return 1;", page, timeoutMs: 10000 }),
    (error) => error.code === 'E_NOT_FOUND' && /找不到元素/.test(error.message),
  );
});

test('QuickJS 拒绝 await/async 脚本并给出 E_BAD_ARG 指引', async () => {
  const { page } = fakePage();
  await assert.rejects(
    runQuickJS({ code: "const r = await page.read('#x'); return r;", page, timeoutMs: 5000 }),
    (error) => error.code === 'E_BAD_ARG' && /同步 page API/.test(error.message),
  );
  await assert.rejects(
    runQuickJS({ code: "const f = async function () { return 1; }; return f;", page, timeoutMs: 5000 }),
    (error) => error.code === 'E_BAD_ARG',
  );
});

test('QuickJS 捕获 console 日志', async () => {
  const { page } = fakePage();
  const out = await runQuickJS({ code: "console.log('hello', 'quickjs'); console.error('bad'); return 1;", page, timeoutMs: 5000 });
  assert.equal(out.result, 1);
  assert.deepEqual(out.logs.map((item) => item.level), ['log', 'error']);
  assert.match(out.logs[0].text, /hello quickjs/);
});

test('QuickJS 超时中断（同步死循环）', async () => {
  const { page } = fakePage();
  await assert.rejects(
    runQuickJS({ code: 'while (true) {}', page, timeoutMs: 1000 }),
    (error) => error.code === 'E_EXEC_FAILED' && /超时/.test(error.message),
  );
});

test('QuickJS 语法错误归为 E_EXEC_FAILED，非法 target 归为 E_BAD_ARG', async () => {
  const { page } = fakePage();
  await assert.rejects(
    runQuickJS({ code: 'return (', page, timeoutMs: 5000 }),
    (error) => error.code === 'E_EXEC_FAILED' && /QuickJS 执行失败/.test(error.message),
  );
  await assert.rejects(
    runQuickJS({ code: 'page.locator(null).click(); return 1;', page, timeoutMs: 5000 }),
    (error) => error.code === 'E_BAD_ARG',
  );
});

test('同进程多次 runQuickJS 稳定（回归：退出期 refcount / 多调用 abort）', async () => {
  const { page } = fakePage();
  for (let round = 0; round < 2; round += 1) {
    const a = await runQuickJS({ code: 'return page.read("#a").fields[0].value;', page, timeoutMs: 5000 });
    const b = await runQuickJS({ code: 'page.locator("#b").click(); return page.locator("#b").isVisible();', page, timeoutMs: 5000 });
    assert.equal(a.result, 'v1');
    assert.equal(b.result, true);
  }
});
