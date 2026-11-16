import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlanStep, normalizePlanSteps } from '../../lib/plan-steps.mjs';
import { validateMethodParams } from '../../lib/schemas.mjs';

test('plan 三种步骤写法归一成 method/params', () => {
  assert.deepEqual(normalizePlanStep({ method: 'click', params: { ref: '@e1' } }), { method: 'click', params: { ref: '@e1' } });
  assert.deepEqual(normalizePlanStep({ action: 'fill', ref: '@e2', value: 'x' }), { method: 'fill', params: { ref: '@e2', value: 'x' } });
  assert.deepEqual(normalizePlanStep({ action: { method: 'press', params: { key: 'Tab' } }, gap: 10 }), {
    method: 'press',
    params: { key: 'Tab' },
  });
  // 归一后能通过 schema 校验
  const steps = normalizePlanSteps([{ action: 'click', selector: '#a' }]);
  assert.deepEqual(validateMethodParams('plan', { steps }), []);
});
