// tests/evaluate.test.ts —— MAIN world evaluate（chrome.scripting）单测。
//
// 假 scripting API 真的去执行注入函数（与浏览器行为同形：把 func 序列化后调用），
// 因此能覆盖：表达式求值、返回 JSON 安全化、Promise 标记、异常/CSP、参数与 world 注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInMainWorld, MAIN_WORLD_EVALUATOR_SOURCE, type ScriptingApi } from '../src/scripting/evaluate.ts';

function createFakeScripting(options: { reject?: string } = {}) {
  const injections: Array<{ target: { tabId: number; frameIds?: number[] }; world?: string; func: (...args: unknown[]) => unknown; args?: unknown[] }> = [];
  const api: ScriptingApi = {
    scripting: {
      async executeScript<T>(injection: { target: { tabId: number; frameIds?: number[] }; world?: 'MAIN' | 'ISOLATED'; func: (...args: never[]) => unknown; args?: unknown[] }): Promise<Array<{ result?: T; error?: { message?: string } }>> {
        injections.push(injection as never);
        if (options.reject) throw new Error(options.reject);
        const func = injection.func as unknown as (...args: unknown[]) => unknown;
        try {
          return [{ result: func(...(injection.args ?? [])) as T }];
        } catch (error) {
          return [{ error: { message: error instanceof Error ? error.message : String(error) } }];
        }
      },
    },
  };
  return { api, injections };
}

test('evaluate：表达式在 MAIN world 执行并返回 JSON 值', async () => {
  const { api, injections } = createFakeScripting();
  const result = await evaluateInMainWorld(api, 7, '1 + 1');
  assert.equal(result.value, 2);
  assert.equal(result.world, 'main');
  assert.equal(result.verified, false);
  assert.equal(injections[0]?.world, 'MAIN');
  assert.deepEqual(injections[0]?.target, { tabId: 7, frameIds: [0] });
  assert.deepEqual(injections[0]?.args, ['1 + 1']);
});

test('evaluate：页面主世界可见全局变量（模拟 window 语义）', async () => {
  const { api } = createFakeScripting();
  (globalThis as { __bbProbeValue?: number }).__bbProbeValue = 41;
  try {
    const result = await evaluateInMainWorld(api, 7, 'globalThis.__bbProbeValue + 1');
    assert.equal(result.value, 42);
  } finally {
    delete (globalThis as { __bbProbeValue?: number }).__bbProbeValue;
  }
});

test('evaluate：返回值 JSON 安全化（函数→null、DOM 节点→结构摘要、循环深度截断）', async () => {
  const { api } = createFakeScripting();
  const result = await evaluateInMainWorld(api, 7, '({ n: 1, f: () => 1, el: { nodeType: 1, tagName: "DIV", id: "x", textContent: "hi" } })');
  const value = result.value as { n: number; f: null; el: { tag: string; id: string; text: string } };
  assert.equal(value.n, 1);
  assert.equal(value.f, null);
  assert.equal(value.el.tag, 'div');
  assert.equal(value.el.id, 'x');
  assert.equal(value.el.text, 'hi');
});

test('evaluate：Promise 返回值标记为 [promise]（不伪造 await）', async () => {
  const { api } = createFakeScripting();
  const result = await evaluateInMainWorld(api, 7, 'Promise.resolve(1)');
  assert.equal(result.value, '[promise]');
});

test('evaluate：页面执行抛错 → E_EVAL_FAILED 带 reason', async () => {
  const { api } = createFakeScripting();
  await assert.rejects(
    () => evaluateInMainWorld(api, 7, 'throw new Error("boom")'),
    (error: unknown) => {
      const bag = error as { code?: string; data?: { reason?: string } };
      assert.equal(bag.code, 'E_EVAL_FAILED');
      assert.equal(String(bag.data?.reason).includes('boom'), true);
      return true;
    },
  );
});

test('evaluate：CSP unsafe-eval 被拒绝时带 csp 证据', async () => {
  const { api } = createFakeScripting();
  const bag = globalThis as { eval?: (source: string) => unknown };
  const original = bag.eval;
  bag.eval = () => {
    throw new Error("Evaluating a string as JavaScript violates the following Content Security Policy directive: 'unsafe-eval' is not an allowed source of script.");
  };
  try {
    await assert.rejects(
      () => evaluateInMainWorld(api, 7, '1'),
      (error: unknown) => {
        const payload = error as { code?: string; data?: { csp?: string } };
        assert.equal(payload.code, 'E_EVAL_FAILED');
        assert.equal(payload.data?.csp, 'unsafe-eval');
        return true;
      },
    );
  } finally {
    bag.eval = original;
  }
});

test('evaluate：空表达式 / 非法 tabId → E_BAD_ARG', async () => {
  const { api } = createFakeScripting();
  await assert.rejects(() => evaluateInMainWorld(api, 7, '   '), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  await assert.rejects(() => evaluateInMainWorld(api, 0, '1'), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('evaluate：没有 scripting API → E_EVAL_UNAVAILABLE', async () => {
  await assert.rejects(
    () => evaluateInMainWorld(null, 7, '1'),
    (error: unknown) => (error as { code?: string }).code === 'E_EVAL_UNAVAILABLE',
  );
  const broken = { scripting: {} } as unknown as ScriptingApi;
  await assert.rejects(
    () => evaluateInMainWorld(broken, 7, '1'),
    (error: unknown) => (error as { code?: string }).code === 'E_EVAL_UNAVAILABLE',
  );
});

test('evaluate：注入本身失败（页面受限/已关闭）→ E_EVAL_FAILED', async () => {
  const { api } = createFakeScripting({ reject: 'Cannot access contents of url' });
  await assert.rejects(
    () => evaluateInMainWorld(api, 7, '1'),
    (error: unknown) => (error as { code?: string }).code === 'E_EVAL_FAILED',
  );
});

test('evaluate：注入执行体是自包含函数（无闭包引用）', () => {
  assert.equal(MAIN_WORLD_EVALUATOR_SOURCE.includes('function mainWorldEvaluate'), true);
  assert.equal(MAIN_WORLD_EVALUATOR_SOURCE.includes('sanitize'), true);
  // 执行体里不能出现“引用外部 helper 标识符”的写法
  assert.equal(/[^.\w]clipHtml\s*\(/.test(MAIN_WORLD_EVALUATOR_SOURCE), false);
  assert.equal(/[^.\w]jsonSafe\s*\(/.test(MAIN_WORLD_EVALUATOR_SOURCE), false);
});
