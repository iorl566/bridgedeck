import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupWait, settleBeforeDeadline } from '../../extension/src/browser-driver/cdp-timing.js';

test('settleBeforeDeadline 空任务立刻成功', async () => {
  assert.equal(await settleBeforeDeadline([], Date.now() + 1000), true);
});

test('settleBeforeDeadline 全部完成返回 true', async () => {
  const done = Promise.resolve(1);
  assert.equal(await settleBeforeDeadline([done, Promise.reject(new Error('x')).catch(() => 0)], Date.now() + 1000), true);
});

test('settleBeforeDeadline 超时返回 false 且不抛错', async () => {
  const pending = new Promise(() => {});
  assert.equal(await settleBeforeDeadline([pending], Date.now() + 20), false);
  assert.equal(await settleBeforeDeadline([pending], Date.now() - 1), false);
});

test('cleanupWait 支持自定义等待预算', async () => {
  assert.equal(await cleanupWait(Promise.resolve(), 50), true);
  assert.equal(await cleanupWait(new Promise(() => {}), 10), false);
});
