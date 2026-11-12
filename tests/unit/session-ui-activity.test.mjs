import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedUiTab, runTaskUi, UiTaskError, withUiTeardown } from '../../extension/src/session-manager/ui-activity.js';

function task(remote = true) {
  return { sessionId: 's1', remote, agentWindowId: 10, agentCreatedTabs: new Set([1]), borrowedTabs: new Map(), observedTabs: new Set() };
}
const managerFor = (ctx) => ({ get: (id) => (id === 's1' ? ctx : null) });

test('runTaskUi rejects non-remote and completes work', async () => {
  await assert.rejects(() => runTaskUi(managerFor(task(false)), 's1', async () => 1), (error) => error.code === 'not_found');
  const ctx = task();
  assert.equal(await runTaskUi(managerFor(ctx), 's1', async (op) => { op.check(); return 7; }), 7);
});

test('withUiTeardown aborts operations and returns run result', async () => {
  const ctx = task();
  const manager = managerFor(ctx);
  const pending = runTaskUi(manager, 's1', async () => new Promise(() => {}));
  const result = await withUiTeardown(ctx, 1, async () => 'ok');
  assert.equal(result, 'ok');
  await assert.rejects(() => pending, (error) => error instanceof UiTaskError && error.reason === 'task_stopping');
});

test('checkedUiTab validates ownership and window', async () => {
  const ctx = task();
  const op = { tabId: undefined, check() {}, abort() {}, mutate() {} };
  const tabs = { async get() { return { id: 1, windowId: 10 }; } };
  const tab = await checkedUiTab(ctx, op, 1, tabs);
  assert.equal(tab.id, 1);
  await assert.rejects(() => checkedUiTab(ctx, op, 2, tabs), (error) => error.code === 'not_found');
});
