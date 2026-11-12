import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebugJournal, formatJournalEvent } from '../../lib/debug-journal.mjs';

test('buildDebugJournal merges requests/console/operations in time order', () => {
  const journal = buildDebugJournal({
    requests: [{ id: 1, method: 'GET', url: '/a', status: 200, startedAt: 30 }],
    console: [{ level: 'warn', text: 'w', at: 10 }],
  }, {
    operations: [{ id: 'op1', method: 'click', ts: 20, ok: true }],
  });
  assert.equal(journal.counts.total, 3);
  assert.deepEqual(journal.events.map((event) => event.type), ['console', 'operation', 'request']);
  assert.equal(journal.events[1].method, 'click');
});

test('buildDebugJournal applies limit and truncation', () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ id: index, at: index }));
  const journal = buildDebugJournal({ requests: events }, { limit: 2 });
  assert.equal(journal.events.length, 2);
  assert.equal(journal.truncated, true);
  assert.equal(journal.counts.total, 5);
});

test('formatJournalEvent is stable', () => {
  assert.match(formatJournalEvent({ type: 'request', at: 0, method: 'GET', url: '/x', status: 200 }), /request GET \/x 200/);
  assert.match(formatJournalEvent({ type: 'console', at: 0, level: 'error', text: 'bad' }), /console\[error\] bad/);
  assert.match(formatJournalEvent({ type: 'operation', at: 0, method: 'click', ok: false, commandId: 'c1' }), /operation click fail c1/);
});
