import test from 'node:test';
import assert from 'node:assert/strict';

const created = [];
const cleared = [];
globalThis.chrome = {
  notifications: {
    create(id, options) {
      created.push({ id, options });
      return Promise.resolve(id);
    },
    clear(id) {
      cleared.push(id);
      return Promise.resolve(true);
    },
  },
  tabs: {
    async get() {
      return { title: 'Example' };
    },
  },
};

const { notifyActionRequest, getActionNotification, clearActionNotification } = await import('../../extension/src/action-notifications.js');
const { overlayTexts } = await import('../../extension/src/overlay-texts.js');

test('service worker creates a borrow notification and registers the action', async () => {
  const result = await notifyActionRequest('borrow', { requestId: 'r1', tabId: 42, title: 'Example' });
  assert.equal(result.ok, true);
  assert.equal(result.notificationId, 'bb-borrow-r1');
  assert.deepEqual(getActionNotification('bb-borrow-r1'), { kind: 'borrow', requestId: 'r1', tabId: 42 });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.buttons[0].title, '允许');
  assert.equal(created[0].options.buttons[1].title, '拒绝');
});

test('clearing removes the registry and the system notification', async () => {
  clearActionNotification('borrow', 'r1');
  assert.equal(getActionNotification('bb-borrow-r1'), null);
  assert.deepEqual(cleared, ['bb-borrow-r1']);
});

test('missing request data is rejected without registering', async () => {
  const before = created.length;
  assert.equal((await notifyActionRequest('borrow', { tabId: 42 })).ok, false);
  assert.equal((await notifyActionRequest('borrow', { requestId: 'r2' })).ok, false);
  assert.equal(created.length, before);
});

test('system notification uses the selected overlay language (ja)', async () => {
  const ja = overlayTexts('ja');
  const result = await notifyActionRequest('borrow', { requestId: 'r-ja', tabId: 42, lang: 'ja' });
  assert.equal(result.ok, true);
  const options = created[created.length - 1].options;
  assert.ok(options.title.includes(ja.borrow.title), options.title);
  assert.equal(options.buttons[0].title, ja.borrow.allow);
  assert.equal(options.buttons[1].title, ja.borrow.deny);
  clearActionNotification('borrow', 'r-ja');
});
