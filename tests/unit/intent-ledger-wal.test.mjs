import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntentLedger } from '../../lib/intent-ledger.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ledger-wal-'));
}

test('snapshot 之前崩溃：WAL 能恢复 begin', () => {
  const dir = tempDir();
  const first = new IntentLedger({ dir, staleMs: 60_000 });
  const entry = first.begin('click', { ref: '@e1' }, { tabId: 7, sessionId: 's1' });
  assert.ok(fs.existsSync(first.wal), 'begin 应写 WAL');
  const second = new IntentLedger({ dir, staleMs: 60_000 });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, entry.id);
  second.load();
  assert.equal(second.entries[0].state, 'stale');
});

test('flush 后 snapshot 落盘并截断 WAL', () => {
  const dir = tempDir();
  const ledger = new IntentLedger({ dir, staleMs: 1000 });
  const entry = ledger.begin('fill', { selector: '#a' }, { tabId: 1, sessionId: 's1' });
  ledger.finish(entry, 'done');
  ledger.flush();
  assert.ok(fs.existsSync(ledger.file));
  assert.equal(fs.statSync(ledger.wal).size, 0);
});
