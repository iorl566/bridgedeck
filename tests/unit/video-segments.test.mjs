import test from 'node:test';
import assert from 'node:assert/strict';
import { planVideoSegments } from '../../cli/lib/video-segments.mjs';

test('planVideoSegments 均分且最后一段到结尾', () => {
  const plan = planVideoSegments(10, 4);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((item) => item.start), [0, 2.5, 5, 7.5]);
  assert.equal(plan[3].end, 10);
  assert.ok(plan.every((item) => item.end > item.start));
});

test('planVideoSegments 数量边界与非法输入', () => {
  assert.equal(planVideoSegments(6, 1).length, 2);
  assert.equal(planVideoSegments(6, 99).length, 10);
  assert.throws(() => planVideoSegments(0, 2), /时长无效/);
  assert.throws(() => planVideoSegments(NaN, 2), /时长无效/);
});
