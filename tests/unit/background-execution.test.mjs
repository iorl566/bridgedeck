import test from 'node:test';
import assert from 'node:assert/strict';

const updates = [];
let activeId = 2;
globalThis.chrome = {
  tabs: {
    async query() {
      return [{ id: activeId }];
    },
    async update(tabId, props) {
      updates.push({ tabId, props });
      if (props && props.active === true) activeId = tabId;
    },
  },
};

test('withForegroundTab restores the previous active tab', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  const result = await withForegroundTab(1, async () => 'done');
  assert.equal(result, 'done');
  assert.deepEqual(updates.map((item) => item.tabId), [1, 2]);
  assert.equal(activeId, 2);
});

test('withForegroundTab does not restore if user switched away', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  await withForegroundTab(1, async () => {
    activeId = 3;
  });
  assert.deepEqual(updates.map((item) => item.tabId), [1]);
});
