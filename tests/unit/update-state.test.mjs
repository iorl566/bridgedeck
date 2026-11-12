import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUpdateState, writeUpdateState } from '../../lib/update-state.mjs';

test('update state merges patches atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-state-'));
  const file = path.join(dir, 'state.json');
  assert.deepEqual(readUpdateState(file), {});
  writeUpdateState(file, { lastCheck: { version: '0.1.1' } });
  const next = writeUpdateState(file, { lastStage: { version: '0.1.1' } });
  assert.equal(next.lastCheck.version, '0.1.1');
  assert.equal(next.lastStage.version, '0.1.1');
  assert.ok(next.updatedAt);
  assert.equal(readUpdateState(file).lastStage.version, '0.1.1');
  fs.rmSync(dir, { recursive: true, force: true });
});
