import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExecPage,
  execTarget,
  pageSurface,
  PAGE_METHODS,
  LOCATOR_METHODS,
} from '../../lib/exec-page.mjs';

/** 记录 RPC 调用并按方法返回可预测结果的假 call。 */
function fakePage(overrides = {}) {
  const calls = [];
  const call = async (method, params = {}) => {
    calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    return { ok: true, method };
  };
  return { calls, call, page: createExecPage(call) };
}

test('execTarget 归一 @ref / selector / 对象，非法目标抛 E_BAD_ARG', () => {
  assert.deepEqual(execTarget('@e1'), { ref: '@e1' });
  assert.deepEqual(execTarget('#kw'), { selector: '#kw' });
  assert.deepEqual(execTarget({ selector: '#kw', frameId: 3 }), { selector: '#kw', frameId: 3 });
  for (const bad of [null, undefined, '', 0]) {
    assert.throws(() => execTarget(bad), (error) => error.code === 'E_BAD_ARG');
  }
});

test('page 方法映射到对应 RPC', async () => {
  const { calls, page } = fakePage();
  await page.goto('https://example.com/');
  await page.navigate('https://example.com/b');
  await page.observe({ maxNodes: 3 });
  await page.click('#a', { trusted: true });
  await page.fill('#a', 42);
  await page.press('Enter', { ref: '@e2' });
  await page.read('@e3');
  await page.evaluate('1 + 1');
  await page.wait('10');
  await page.waitFor('#a', { state: 'visible' });
  await page.webmcp.list();
  await page.webmcp.call('echo', { text: 'hi' });
  assert.deepEqual(calls.map((item) => item.method), [
    'navigate', 'navigate', 'observe', 'click', 'fill', 'press', 'read',
    'evaluate', 'wait-ms', 'wait-for-element', 'webmcp.list', 'webmcp.call',
  ]);
  assert.deepEqual(calls[3].params, { selector: '#a', trusted: true });
  assert.deepEqual(calls[4].params, { selector: '#a', value: '42' });
  assert.deepEqual(calls[5].params, { key: 'Enter', ref: '@e2' });
  assert.deepEqual(calls[9].params, { selector: '#a', state: 'visible' });
  assert.deepEqual(calls[11].params, { name: 'echo', input: { text: 'hi' } });
});

test('page.screenshot 去掉 dataUrl，只返回元数据', async () => {
  const { page } = fakePage({ screenshot: () => ({ path: 'a.png', width: 10, dataUrl: 'data:image/png;base64,AAA' }) });
  const result = await page.screenshot({ out: 'a.png' });
  assert.deepEqual(result, { path: 'a.png', width: 10 });
});

test('locator 动作方法映射到目标 RPC（ref/selector 透传）', async () => {
  const { calls, page } = fakePage();
  const loc = page.locator('#kw');
  loc.click({ trusted: true });
  loc.hover();
  loc.focus();
  loc.scrollIntoView();
  loc.fill('x');
  loc.press('Enter');
  loc.selectOption('b');
  loc.waitFor({ state: 'hidden' });
  loc.waitForVisible();
  loc.waitForHidden({ timeoutMs: 50 });
  loc.waitForAttached();
  loc.waitForDetached();
  await Promise.resolve();
  assert.deepEqual(calls.map((item) => item.method), [
    'click', 'hover', 'focus', 'scroll-to', 'fill', 'press', 'select',
    'wait-for-element', 'wait-for-element', 'wait-for-element', 'wait-for-element', 'wait-for-element',
  ]);
  for (const item of calls) assert.equal(item.params.selector, '#kw');
  assert.equal(calls[4].params.value, 'x');
  assert.equal(calls[5].params.key, 'Enter');
  assert.equal(calls[6].params.value, 'b');
  assert.equal(calls[7].params.state, 'hidden');
  assert.equal(calls[8].params.state, 'visible');
  assert.equal(calls[9].params.state, 'hidden');
  assert.equal(calls[9].params.timeoutMs, 50);
  assert.equal(calls[10].params.state, 'attached');
  assert.equal(calls[11].params.state, 'detached');
});

test('locator 读取方法：textContent/getAttribute/inputValue/isEnabled', async () => {
  const { calls, page } = fakePage({
    read: (params) => {
      if (params.fields && params.fields.length) {
        const field = params.fields[0];
        if (field.read === 'attribute') return { fields: [{ value: 'out' }] };
        return { fields: [{ text: '按钮文案' }] };
      }
      return { fields: [{ value: 'v1', disabled: false }] };
    },
  });
  const loc = page.locator('#out');
  assert.equal(await loc.textContent(), '按钮文案');
  assert.equal(await loc.getAttribute('id'), 'out');
  assert.equal(await loc.inputValue(), 'v1');
  assert.equal(await loc.isEnabled(), true);
  assert.deepEqual(calls[0].params.fields, [{ key: 'text', read: 'text' }]);
  assert.deepEqual(calls[1].params.fields, [{ key: 'value', read: 'attribute', attribute: 'id' }]);
  assert.equal(calls[2].params.fields, undefined);
});

test('locator.isEnabled 在 disabled 元素上返回 false；isVisible 走 wait-for-element(state=visible, timeoutMs=100)', async () => {
  const { calls, page } = fakePage({
    read: () => ({ fields: [{ value: 'v', disabled: true }] }),
    'wait-for-element': (params) => ({ satisfied: params.state === 'visible' || params.state === 'attached' }),
  });
  const loc = page.locator('#a');
  assert.equal(await loc.isEnabled(), false);
  assert.equal(await loc.isVisible(), true);
  assert.equal(await loc.isHidden(), false);
  assert.equal(await loc.isAttached(), true);
  const waits = calls.filter((item) => item.method === 'wait-for-element');
  assert.equal(waits.length, 3);
  for (const item of waits) assert.equal(item.params.timeoutMs, 100);
});

test('locator.getAttribute 缺属性名抛 E_BAD_ARG；count 只支持 selector', async () => {
  const { page } = fakePage();
  await assert.rejects(page.locator('#a').getAttribute(''), (error) => error.code === 'E_BAD_ARG');
  await assert.rejects(page.locator('@e1').count(), (error) => error.code === 'E_BAD_ARG');
});

test('locator.count 用 evaluate 统计 selector 元素数', async () => {
  const { calls, page } = fakePage({ evaluate: () => ({ value: 4 }) });
  assert.equal(await page.locator('button').count(), 4);
  assert.equal(calls[0].method, 'evaluate');
  assert.match(calls[0].params.expression, /querySelectorAll\("button"\)\.length/);
});

test('locator.actionable / screenshot 透传目标', async () => {
  const { calls, page } = fakePage();
  await page.locator('@e7').actionable();
  await page.locator('@e7').screenshot({ scope: 'viewport' });
  assert.deepEqual(calls[0].params, { ref: '@e7' });
  assert.deepEqual(calls[1].params, { ref: '@e7', scope: 'viewport' });
});

test('pageSurface 与实际对象一致（防止文档/QuickJS prelude 漂移）', () => {
  const { page } = fakePage();
  const surface = pageSurface();
  assert.deepEqual(surface.methods.slice().sort(), [...PAGE_METHODS, 'locator', 'webmcp'].sort());
  for (const name of surface.methods) {
    if (name === 'webmcp') {
      assert.equal(typeof page.webmcp, 'object');
      continue;
    }
    assert.equal(typeof page[name], 'function', name);
  }
  assert.equal(typeof page.locator, 'function');
  assert.equal(typeof page.webmcp.list, 'function');
  const loc = page.locator('#x');
  assert.deepEqual(Object.keys(loc).sort(), [...LOCATOR_METHODS].sort());
  for (const name of LOCATOR_METHODS) assert.equal(typeof loc[name], 'function', name);
});
