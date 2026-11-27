import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_MODEL_VERSION,
  describeRecipeStep,
  flattenRecipeSteps,
  indexRecipeSteps,
  normalizeRecipeFallback,
  normalizeRecipeStep,
  normalizeRecipeSteps,
  normalizeRecipeExpect,
  recipeStepIdempotent,
  recipeStepKind,
  recipeStepRef,
  summarizeRecipeStructure,
} from '../../lib/recipe-model.mjs';

test('step 模型 v2：kind 推断覆盖 action/observe/wait/human/if/loop', () => {
  assert.equal(RECIPE_MODEL_VERSION, 2);
  assert.equal(recipeStepKind({ method: 'click' }), 'action');
  assert.equal(recipeStepKind({ method: 'observe' }), 'observe');
  assert.equal(recipeStepKind({ method: 'wait-for-element' }), 'wait');
  assert.equal(recipeStepKind({ method: 'sleep' }), 'wait');
  assert.equal(recipeStepKind({ type: 'human', reason: '登录' }), 'human');
  assert.equal(recipeStepKind({ type: 'branch', when: {} }), 'if');
  assert.equal(recipeStepKind({ type: 'gate', reason: '确认' }), 'human');
  assert.equal(recipeStepKind({ type: 'observe', method: 'read' }), 'observe');
});

test('幂等判定：只读/可逆默认幂等，写动作默认非幂等，可显式覆盖', () => {
  assert.equal(recipeStepIdempotent({ method: 'observe' }), true);
  assert.equal(recipeStepIdempotent({ method: 'scroll-to' }), true);
  assert.equal(recipeStepIdempotent({ method: 'click' }), false);
  assert.equal(recipeStepIdempotent({ method: 'fill' }), false);
  assert.equal(recipeStepIdempotent({ method: 'click', idempotent: true }), true);
  assert.equal(recipeStepIdempotent({ method: 'observe', idempotent: false }), false);
});

test('稳定 ref：同结构同参数稳定，路径/参数变化即变化', () => {
  const step = { method: 'click', params: { selector: '#a' } };
  const first = recipeStepRef(step, '0');
  assert.match(first, /^r[0-9a-f]{12}$/);
  assert.equal(recipeStepRef({ method: 'click', params: { selector: '#a' } }, '0'), first);
  assert.notEqual(recipeStepRef({ method: 'click', params: { selector: '#b' } }, '0'), first);
  assert.notEqual(recipeStepRef(step, '1'), first);
  assert.notEqual(recipeStepRef({ type: 'human', reason: 'x' }, '0'), recipeStepRef({ type: 'human', reason: 'y' }, '0'));
});

test('回退策略归一化：默认 stop，retry/skip 带次数与重试码', () => {
  const plain = normalizeRecipeFallback({ method: 'click' });
  assert.deepEqual(plain.onError, 'stop');
  assert.equal(plain.retries, 0);
  assert.ok(plain.retryOn.includes('E_TIMEOUT'));
  const retry = normalizeRecipeFallback({ method: 'observe', fallback: { onError: 'retry', retries: 99, retryDelayMs: 999999, retryOn: ['E_X'] } });
  assert.equal(retry.onError, 'retry');
  assert.equal(retry.retries, 5); // 上限
  assert.equal(retry.retryDelayMs, 60000);
  assert.deepEqual(retry.retryOn, ['E_X']);
  // continue 视为 skip；未知策略回退 stop
  assert.equal(normalizeRecipeFallback({ method: 'x', onError: 'continue' }).onError, 'skip');
  assert.equal(normalizeRecipeFallback({ method: 'x', onError: 'nope' }).onError, 'stop');
  const defaults = normalizeRecipeFallback({ method: 'x' }, { onError: 'retry', retries: 2 });
  assert.equal(defaults.onError, 'retry');
  assert.equal(defaults.retries, 2);
});

test('expect 只保留白名单字段', () => {
  assert.deepEqual(normalizeRecipeExpect({ urlIncludes: '/a', evil: 'x', selectorCount: 2 }), { urlIncludes: '/a', selectorCount: 2 });
  assert.equal(normalizeRecipeExpect(null), null);
  assert.equal(normalizeRecipeExpect({}), null);
  assert.deepEqual(normalizeRecipeExpect({ equals: { a: 1 } }), { equals: { a: 1 } });
});

test('归一化动作步骤：ref/params/fallback/expect/意图字段', () => {
  const result = normalizeRecipeStep({ method: 'fill', params: { selector: '#q' }, idempotent: true, expect: { selectorValue: 'x' }, expectOn: 'fail', revision: 3, frameId: 2 });
  assert.equal(result.errors.length, 0);
  const step = result.step;
  assert.equal(step.kind, 'action');
  assert.equal(step.method, 'fill');
  assert.equal(step.idempotent, true);
  assert.equal(step.risk, 'read_only');
  assert.equal(step.expectOn, 'fail');
  assert.equal(step.params.frameId, 2);
  assert.equal(step.sourceRevision, 3);
  assert.deepEqual(step.expect, { selectorValue: 'x' });
  assert.match(step.ref, /^r[0-9a-f]{12}$/);
});

test('confirm 转成执行期人工确认标记，且非幂等重试给出警告', () => {
  const confirmed = normalizeRecipeStep({ method: 'click', params: { selector: '#danger' }, confirm: '确认删除' });
  assert.equal(confirmed.step.params.__recipeConfirm, '确认删除');
  const warned = normalizeRecipeStep({ method: 'click', retry: 2 });
  assert.ok(warned.warnings.some((line) => line.includes('非幂等动作')));
});

test('if/loop 递归归一化，loop times 超限裁剪并报错', () => {
  const ok = normalizeRecipeStep({
    type: 'if',
    when: { urlIncludes: '/dash', negate: true },
    then: [{ method: 'click', params: { selector: '#a' } }],
    else: [{ method: 'observe' }],
  });
  assert.equal(ok.step.then.length, 1);
  assert.equal(ok.step.else.length, 1);
  assert.equal(ok.step.when.negate, true);
  const loop = normalizeRecipeStep({ type: 'loop', times: 80, steps: [{ method: 'observe' }] });
  assert.equal(loop.step.times, 50);
  assert.ok(loop.warnings.some((line) => line.includes('裁剪')));
  const bad = normalizeRecipeStep({ type: 'loop', times: 0, steps: [{ method: 'observe' }] });
  assert.equal(bad.errors.length, 1);
  assert.ok(bad.errors[0].includes('times'));
});

test('缺少 method / 非对象 / 嵌套超限都进 errors', () => {
  const missing = normalizeRecipeStep({ params: {} }, { path: '1' });
  assert.equal(missing.step, null);
  assert.match(missing.errors[0], /缺少 method/);
  assert.equal(normalizeRecipeStep(null).errors.length, 1);
  assert.equal(normalizeRecipeStep({ method: 'click' }, { depth: 99 }).errors[0].includes('嵌套'), true);
  const warnings = normalizeRecipeStep({ type: 'if', when: { foo: 1 }, then: 'nope' });
  assert.ok(warnings.warnings.some((line) => line.includes('when')));
  assert.ok(warnings.warnings.some((line) => line.includes('不是步骤数组')));
});

test('整份归一化 + 展平 + 结构摘要 + ref 索引', () => {
  const { steps, warnings, errors } = normalizeRecipeSteps([
    { method: 'observe' },
    { type: 'loop', times: 2, steps: [{ method: 'click', params: { selector: '#a' } }] },
    { type: 'if', when: { urlIncludes: '/x' }, then: [{ method: 'fill', params: { selector: '#b' } }], else: [] },
    { type: 'human', reason: '登录' },
  ]);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.equal(steps.length, 4);
  const flat = flattenRecipeSteps(steps);
  assert.deepEqual(flat.map((step) => step.method || step.kind), ['observe', 'click', 'click', 'fill', 'human']);
  const summary = summarizeRecipeStructure(steps);
  assert.equal(summary.counts.action, 2);
  assert.equal(summary.counts.observe, 1);
  assert.equal(summary.counts.loop, 1);
  assert.equal(summary.counts.if, 1);
  assert.equal(summary.counts.human, 1);
  assert.equal(summary.idempotent + summary.nonIdempotent, 3);
  assert.equal(summary.maxDepth, 2);
  const index = indexRecipeSteps(steps);
  assert.equal(index.get(steps[0].ref).method, 'observe');
  assert.equal(index.size, 6); // 顶层 4 + loop 内 click + if 内 fill
});

test('describeRecipeStep 输出 ref/方法/目标/回退', () => {
  const { steps } = normalizeRecipeSteps([{ method: 'click', params: { selector: '#go' }, fallback: { onError: 'skip' } }]);
  const text = describeRecipeStep(steps[0]);
  assert.ok(text.includes('click'));
  assert.ok(text.includes('#go'));
  assert.ok(text.includes('[skip]'));
});
