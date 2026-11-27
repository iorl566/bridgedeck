import test from 'node:test';
import assert from 'node:assert/strict';
import { planIdleClose } from '../../extension/src/lib/tab-idle.js';

const tab = (tabId, extra = {}) => ({ tabId, windowId: 1, owned: 'agent', active: false, lastAccessed: 0, ...extra });

test('只关空闲 Agent tab；用户/keepOpen/active/最后一条保留', () => {
  const plan = planIdleClose([
    tab(1, { lastAccessed: 0 }),
    tab(2, { lastAccessed: 1800 }),
    tab(3, { owned: 'user' }),
    tab(4, { keepOpen: true }),
    tab(5, { active: true }),
  ], { idleMs: 500, now: 2000 });
  assert.deepEqual(plan.close, [1]);
  assert.deepEqual(plan.keep.map((item) => item.tabId).sort(), [2, 3, 4, 5]);
});

test('窗口里最后一条不关', () => {
  const plan = planIdleClose([tab(1, { windowId: 2 })], { idleMs: 0, now: 10 });
  assert.deepEqual(plan.close, []);
  assert.equal(plan.keep[0].reason, 'last-in-window');
});

test('keepOpen 集合与空输入', () => {
  const plan = planIdleClose([tab(1), tab(2)], { idleMs: 100, now: 1000, keepOpen: new Set([1]) });
  assert.deepEqual(plan.close, [2]);
  assert.deepEqual(planIdleClose(null).close, []);
});
