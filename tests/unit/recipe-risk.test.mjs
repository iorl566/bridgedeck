import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunnable, recipeRisk, recipeStepMethod, recipeStepsHash } from '../../lib/recipe-store.mjs';

const recipe = (steps, extra = {}) => ({ name: 'r', steps, approved: false, ...extra });

test('只读/可逆步骤免审批', () => {
  const steps = [{ method: 'observe' }, { method: 'scroll-to', params: { ref: '@e1' } }, { method: 'wait-ms' }];
  assert.equal(recipeRisk(steps).safe, true);
  assert.doesNotThrow(() => assertRunnable(recipe(steps)));
});

test('风险步骤默认被拦截，approve 后放行', () => {
  const steps = [{ method: 'click', params: { ref: '@e1' } }, { method: 'fill', params: { ref: '@e2', value: 'x' } }];
  const risk = recipeRisk(steps);
  assert.equal(risk.safe, false);
  assert.deepEqual(risk.risky.sort(), ['click', 'fill']);
  assert.throws(() => assertRunnable(recipe(steps)), (error) => error.code === 'E_RECIPE_NOT_APPROVED');
  const approved = recipe(steps, { approved: true, expiresAt: Date.now() + 60_000, stepsHash: recipeStepsHash(steps) });
  assert.doesNotThrow(() => assertRunnable(approved));
});

test('审批过期或内容变更仍然拦截', () => {
  const steps = [{ method: 'click' }];
  const expired = recipe(steps, { approved: true, expiresAt: Date.now() - 1, stepsHash: recipeStepsHash(steps) });
  assert.throws(() => assertRunnable(expired), (error) => error.code === 'E_RECIPE_EXPIRED');
  const changed = recipe(steps, { approved: true, expiresAt: Date.now() + 60_000, stepsHash: 'deadbeef' });
  assert.throws(() => assertRunnable(changed), (error) => error.code === 'E_RECIPE_CHANGED');
});

test('步骤方法支持 method/action/command 三种写法', () => {
  assert.equal(recipeStepMethod({ method: 'observe' }), 'observe');
  assert.equal(recipeStepMethod({ action: 'screenshot' }), 'screenshot');
  assert.equal(recipeStepMethod({ command: 'scroll-to' }), 'scroll-to');
  assert.deepEqual(recipeRisk([{ action: 'click' }]).risky, ['click']);
});
