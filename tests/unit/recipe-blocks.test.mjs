import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRecipeWhen, normalizeLoopTimes, recipeBlockRisk } from '../../lib/recipe-blocks.mjs';

test('条件与循环参数', () => {
  assert.equal(matchRecipeWhen({ urlIncludes: '/dash' }, 'https://x.test/dash?x=1'), true);
  assert.equal(matchRecipeWhen({ urlMatches: '^https://x\\.test/' }, 'https://x.test/a'), true);
  assert.equal(matchRecipeWhen({ urlMatches: '[' }, 'https://x.test/a'), false);
  assert.equal(normalizeLoopTimes(3), 3);
  assert.equal(normalizeLoopTimes(0), 0);
  assert.equal(normalizeLoopTimes(100), 50);
});

test('块风险递归检查人工/条件/循环', () => {
  const safe = (step) => ['observe', 'click'].includes(step.method);
  const risky = recipeBlockRisk([
    { type: 'human', reason: 'login' },
    { type: 'if', when: { urlIncludes: 'x' }, then: [{ method: 'click' }], else: [{ method: 'fill' }] },
    { type: 'loop', times: 2, steps: [{ method: 'evaluate' }] },
  ], safe);
  assert.deepEqual(risky, ['fill', 'evaluate']);
});
