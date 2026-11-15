// evaluate 在 CSP 禁止 eval 的页面上应回退到 CDP Runtime.evaluate（GitHub、Bing 等真实站点）。
import test from 'node:test';
import assert from 'node:assert/strict';

const state = {
  scriptResults: [],
  scriptCalls: 0,
  attachCalls: 0,
  detachCalls: 0,
  sendCalls: [],
  cdpReply: null,
};

globalThis.chrome = {
  scripting: {
    executeScript: async () => {
      state.scriptCalls += 1;
      return [{ result: state.scriptResults.shift() }];
    },
  },
  debugger: {
    attach: async () => { state.attachCalls += 1; },
    detach: async () => { state.detachCalls += 1; },
    sendCommand: async (target, method, params) => {
      state.sendCalls.push({ target, method, params });
      return state.cdpReply;
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  tabs: { get: async () => ({ active: true }) },
};

const { evalInMain } = await import('../../extension/src/inject.js');

function reset() {
  state.scriptResults = [];
  state.scriptCalls = 0;
  state.attachCalls = 0;
  state.detachCalls = 0;
  state.sendCalls = [];
  state.cdpReply = null;
}

const CSP_MESSAGE = "EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self'";

test('CSP 禁止 eval 时回退到 CDP Runtime.evaluate', async () => {
  reset();
  state.scriptResults = [{ ok: false, error: { code: 'E_JS_ERROR', message: CSP_MESSAGE } }];
  state.cdpReply = { result: { type: 'number', value: 366 } };

  const result = await evalInMain(7, 'document.body.innerText.length');

  assert.equal(result.value, 366);
  assert.equal(state.attachCalls, 1, '应挂载 debugger');
  assert.equal(state.sendCalls.length, 1);
  assert.equal(state.sendCalls[0].method, 'Runtime.evaluate');
  assert.equal(state.sendCalls[0].params.expression, 'document.body.innerText.length');
  assert.equal(state.sendCalls[0].params.returnByValue, true);
  assert.equal(state.detachCalls, 0, '会话内保持 attach，交给 75s 空闲软分离');
});

test('后续 CDP 回退复用同一 attach（不再每次 attach/detach）', async () => {
  reset();
  state.scriptResults = [
    { ok: false, error: { code: 'E_JS_ERROR', message: CSP_MESSAGE } },
    { ok: false, error: { code: 'E_JS_ERROR', message: CSP_MESSAGE } },
  ];
  state.cdpReply = { result: { type: 'number', value: 1 } };

  await evalInMain(8, '1');
  await evalInMain(8, '2');

  assert.equal(state.attachCalls, 1, '第二次应复用缓存 attach');
  assert.equal(state.detachCalls, 0);
});

test('CDP 回退返回异常时映射为 E_JS_ERROR', async () => {
  reset();
  state.scriptResults = [{ ok: false, error: { code: 'E_JS_ERROR', message: CSP_MESSAGE } }];
  state.cdpReply = { exceptionDetails: { exception: { description: 'TypeError: x is not a function\n  at y' } } };

  await assert.rejects(() => evalInMain(7, 'x()'), (error) => {
    assert.equal(error.code, 'E_JS_ERROR');
    assert.equal(error.message, 'TypeError: x is not a function');
    return true;
  });
  assert.equal(state.detachCalls, 0, '异常后同样保持 attach，交给空闲软分离');
});

test('普通脚本错误不触发 CDP 回退', async () => {
  reset();
  state.scriptResults = [{ ok: false, error: { code: 'E_JS_ERROR', message: 'ReferenceError: foo is not defined' } }];

  await assert.rejects(() => evalInMain(7, 'foo'), (error) => error.code === 'E_JS_ERROR');
  assert.equal(state.attachCalls, 0);
  assert.equal(state.sendCalls.length, 0);
});

test('注入路径成功时不挂 debugger', async () => {
  reset();
  state.scriptResults = [{ ok: true, value: 42 }];

  const result = await evalInMain(7, '40 + 2');

  assert.equal(result.value, 42);
  assert.equal(state.attachCalls, 0);
  assert.equal(state.detachCalls, 0);
});

test('CDP 结果为 undefined 时返回 null 并带说明', async () => {
  reset();
  state.scriptResults = [{ ok: false, error: { code: 'E_JS_ERROR', message: CSP_MESSAGE } }];
  state.cdpReply = { result: { type: 'undefined' } };

  const result = await evalInMain(7, 'void 0');

  assert.equal(result.value, null);
  assert.match(result.note, /undefined/);
});
