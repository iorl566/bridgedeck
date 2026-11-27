import test from 'node:test';
import assert from 'node:assert/strict';
import { planFinalExposure } from '../../extension/src/lib/longshot-final.js';

test('底部已覆盖时不再补拍', () => {
  assert.equal(planFinalExposure({ scrollHeight: 3000, innerHeight: 800, lastBottom: 3000, viewportHeight: 800 }), null);
});

test('底部未覆盖：滚到底并贴底绘制', () => {
  const plan = planFinalExposure({ scrollHeight: 3000, innerHeight: 800, scale: 2, lastBottom: 3000, viewportHeight: 1600 });
  assert.deepEqual(plan, { scrollY: 2200, drawY: 4400 });
});

test('缺失输入返回 null', () => {
  assert.equal(planFinalExposure({}), null);
  assert.equal(planFinalExposure({ scrollHeight: 0, innerHeight: 800 }), null);
});
