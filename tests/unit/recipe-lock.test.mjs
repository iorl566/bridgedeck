import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRecipeLock, readRunMarker, releaseRecipeLock, writeRunMarker } from '../../lib/recipe-store.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-'));
}

test('recipe 回放锁：同进程重入、跨进程互斥、释放后可再取', () => {
  const dir = tempDir();
  const first = acquireRecipeLock(dir, 'demo', { pid: 111, now: 1000, ttlMs: 60_000 });
  assert.ok(fs.existsSync(first.file));
  // 同 pid 重入允许（覆盖）
  const again = acquireRecipeLock(dir, 'demo', { pid: 111, now: 2000, ttlMs: 60_000 });
  assert.equal(again.expiresAt, 62_000);
  // 另一个进程持有期间互斥
  assert.throws(
    () => acquireRecipeLock(dir, 'demo', { pid: 222, now: 3000, ttlMs: 60_000 }),
    (error) => error.code === 'E_RECIPE_LOCKED' && /111/.test(error.message),
  );
  // 过期后可取
  const next = acquireRecipeLock(dir, 'demo', { pid: 222, now: 63_000, ttlMs: 60_000 });
  assert.equal(next.pid, 222);
  releaseRecipeLock(next);
  assert.equal(fs.existsSync(next.file), false);
});

test('run marker 记录状态并可读回', () => {
  const dir = tempDir();
  writeRunMarker(dir, 'demo', { status: 'running', steps: 2 });
  const marker = readRunMarker(dir, 'demo');
  assert.equal(marker.status, 'running');
  assert.equal(marker.steps, 2);
  writeRunMarker(dir, 'demo', { status: 'done', completed: 2 });
  assert.equal(readRunMarker(dir, 'demo').status, 'done');
});
