import test from 'node:test';
import assert from 'node:assert/strict';
import { humanHoldDelay, planHumanMove } from '../../extension/src/lib/human-input.js';

function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('短距离/非法输入不产生移动', () => {
  assert.deepEqual(planHumanMove({ x: 0, y: 0 }, { x: 1, y: 0 }), []);
  assert.deepEqual(planHumanMove(null, null), []);
});

test('轨迹：多点、非直线、有延迟、终点前停止', () => {
  const points = planHumanMove({ x: 0, y: 0 }, { x: 400, y: 0 }, { random: seeded(7) });
  assert(points.length >= 8, '轨迹点太少：' + points.length);
  assert(points.every((p) => p.delay >= 5 && p.delay <= 40), '延迟越界');
  assert(points.some((p) => Math.abs(p.y) > 0.5), '轨迹没有弓形偏离');
  const last = points[points.length - 1];
  assert(Math.hypot(last.x - 400, last.y) < 30, '最后一点离目标太远：' + JSON.stringify(last));
});

test('hold 延迟在 60–140ms', () => {
  const value = humanHoldDelay(seeded(3));
  assert(value >= 60 && value <= 140, 'hold 越界：' + value);
});
