import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileAliasRecords, reconcilePolicyRecords } from '../../extension/src/lib/tab-restore.js';

test('重启后按 URL 唯一恢复 alias', () => {
  const out = reconcileAliasRecords(
    { work: { tabId: 1, url: 'https://mail.test/inbox', windowId: 10 } },
    [{ id: 9, url: 'https://mail.test/inbox', windowId: 20 }],
  );
  assert.equal(out.aliases.work.tabId, 9);
  assert.deepEqual(out.unresolved, []);
});

test('id 仍存在时优先 id', () => {
  const out = reconcileAliasRecords(
    { work: { tabId: 3, url: 'https://a.test' } },
    [{ id: 3, url: 'https://b.test' }, { id: 4, url: 'https://a.test' }],
  );
  assert.equal(out.aliases.work.tabId, 3);
});

test('同 URL 多个候选不猜', () => {
  const out = reconcileAliasRecords(
    { work: { tabId: 1, url: 'https://same.test', windowId: 99 } },
    [{ id: 2, url: 'https://same.test', windowId: 10 }, { id: 3, url: 'https://same.test', windowId: 11 }],
  );
  assert.equal(out.aliases.work, undefined);
  assert.deepEqual(out.unresolved, ['work']);
});

test('同 URL 多候选但同窗口唯一时恢复', () => {
  const out = reconcileAliasRecords(
    { work: { tabId: 1, url: 'https://same.test', windowId: 10 } },
    [{ id: 2, url: 'https://same.test', windowId: 11 }, { id: 3, url: 'https://same.test', windowId: 10 }],
  );
  assert.equal(out.aliases.work.tabId, 3);
});

test('策略重启按 URL 唯一恢复，多候选不猜', () => {
  const records = {
    1: { readOnly: true, allowedOrigins: [], keepOpen: true, url: 'https://mail.test/inbox', windowId: 10 },
    2: { readOnly: false, allowedOrigins: [], keepOpen: true, url: 'https://dup.test', windowId: 10 },
  };
  const out = reconcilePolicyRecords(records, [
    { id: 9, url: 'https://mail.test/inbox', windowId: 20 },
    { id: 10, url: 'https://dup.test', windowId: 21 },
    { id: 11, url: 'https://dup.test', windowId: 22 },
  ]);
  assert.equal(out.policies[9].keepOpen, true);
  assert.equal(out.policies[10], undefined);
  assert.deepEqual(out.unresolved, ['2']);
});
