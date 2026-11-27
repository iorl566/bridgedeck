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

test('withForegroundTab 默认不动 active tab（不抢焦点）', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  const result = await withForegroundTab(1, async () => 'done');
  assert.equal(result, 'done');
  assert.deepEqual(updates, [], '默认路径不应调用 tabs.update');
  assert.equal(activeId, 2);
});

test('withForegroundTab 显式 focus 时才切换并恢复', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  const result = await withForegroundTab(1, async () => 'done', { focus: true });
  assert.equal(result, 'done');
  assert.deepEqual(updates.map((item) => item.tabId), [1, 2]);
  assert.equal(activeId, 2);
});

test('withForegroundTab 显式 focus 时用户中途切走则不强行恢复', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  await withForegroundTab(1, async () => {
    activeId = 3;
  }, { focus: true });
  assert.deepEqual(updates.map((item) => item.tabId), [1]);
});

test('withForegroundTab 兼容 foreground:true（旧内部调用）', async () => {
  const { withForegroundTab } = await import('../../extension/src/background-execution.js');
  activeId = 2;
  updates.length = 0;
  await withForegroundTab(1, async () => 'ok', { foreground: true });
  assert.deepEqual(updates.map((item) => item.tabId), [1, 2]);
});
