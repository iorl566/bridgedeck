import test from 'node:test';
import assert from 'node:assert/strict';
import { draftRecipe } from '../../lib/recipe-draft.mjs';

function step(overrides) {
  return { kind: 'action', method: 'click', target: { selector: '#x' }, replayable: true, ok: true, frameId: 0, ...overrides };
}

test('navigate + selector click 映射成 recipe 步骤', () => {
  const drafted = draftRecipe('demo', {
    steps: [
      { kind: 'navigate', method: 'navigate', origin: 'https://a.test', path: '/form', dropped_query: true, ok: true },
      step({ target: { selector: '#submit' }, revision: 2 }),
    ],
  });
  assert.deepEqual(drafted.steps, [
    { method: 'navigate', params: { url: 'https://a.test/form' } },
    { method: 'click', params: { selector: '#submit' } },
  ]);
  assert.equal(drafted.skipped.length, 0);
});

test('name 目标用于 click/hover/focus；fill/press/select 因缺参数跳过', () => {
  const drafted = draftRecipe('demo', {
    steps: [
      step({ target: { name: '提交' } }),
      step({ method: 'hover', target: { name: '更多' } }),
      step({ target: { selector: '#q' } }),
      step({ method: 'fill', target: { selector: '#q' } }),
      step({ method: 'press', target: { selector: '#q' } }),
      step({ method: 'select', target: { selector: '#q' } }),
    ],
  });
  assert.deepEqual(drafted.steps.map((item) => item.method), ['click', 'hover', 'click']);
  assert.deepEqual(drafted.skipped.map((item) => item.reason), ['needs_args', 'needs_args', 'needs_args']);
});

test('evaluate/upload/失败步骤显式跳过', () => {
  const drafted = draftRecipe('demo', {
    steps: [
      step({ method: 'evaluate', target: { selector: '#x' }, replayable: false }),
      step({ method: 'upload', target: { selector: '#f' }, replayable: false }),
      step({ ok: false, target: { selector: '#x' } }),
    ],
  });
  assert.equal(drafted.steps.length, 0);
  assert.deepEqual(drafted.skipped.map((item) => item.reason), ['needs_input', 'needs_input', 'failed']);
});

test('frameId 透传 + maxSteps 截断警告', () => {
  const steps = [];
  for (let index = 0; index < 5; index += 1) steps.push(step({ target: { selector: '#b' + index }, frameId: 2 }));
  const drafted = draftRecipe('demo', { steps }, { maxSteps: 3 });
  assert.equal(drafted.steps.length, 3);
  assert.equal(drafted.steps[0].params.frameId, 2);
  assert.ok(drafted.warnings.some((warning) => /截断/.test(warning)));
});

test('没有可回放步骤时返回空 steps', () => {
  const drafted = draftRecipe('empty', { steps: [] });
  assert.deepEqual(drafted, { name: 'empty', steps: [], skipped: [], warnings: [] });
  assert.deepEqual(draftRecipe('', {}).steps, []);
});
