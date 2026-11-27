import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRunLog } from '../../daemon/run-log-record.js';

test('recordRunLog 记录目标但不含输入值', () => {
  const entries = [];
  const route = { session: { runLog: { record: (entry) => entries.push(entry) }, tabId: 7 } };
  recordRunLog(route, 'fill', { receipt: { revision: 3, effectState: 'committed' }, url: 'https://x' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 'fill');
  assert.equal(entries[0].revision, 3);
  assert.equal(entries[0].effectState, 'committed');
  assert.equal(JSON.stringify(entries[0]).includes('value'), false);
});

test('recordRunLog 跳过无 runLog 会话', () => {
  assert.doesNotThrow(() => recordRunLog({}, 'click', {}));
  assert.doesNotThrow(() => recordRunLog({ session: {} }, 'click', {}));
});
