import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OBSERVATION_MAX_FILES, OBSERVATION_TTL_MS, pruneObservationCache } from '../../lib/observation-cache.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-obs-'));
}

test('删除超过 TTL 的观察缓存，保留新鲜的', () => {
  const dir = tempDir();
  const old = path.join(dir, 'old.json');
  const fresh = path.join(dir, 'fresh.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const now = Date.now();
  fs.utimesSync(old, new Date(now - OBSERVATION_TTL_MS - 1000), new Date(now - OBSERVATION_TTL_MS - 1000));
  const result = pruneObservationCache(dir, { now });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

test('按数量上限删除最旧的文件', () => {
  const dir = tempDir();
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const file = path.join(dir, `ob_${index}.json`);
    fs.writeFileSync(file, '{}');
    const stamp = new Date(now - (5 - index) * 1000);
    fs.utimesSync(file, stamp, stamp);
  }
  const result = pruneObservationCache(dir, { now, maxFiles: 2 });
  assert.equal(result.removed, 3);
  assert.equal(result.kept, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ob_3.json', 'ob_4.json']);
});

test('目录不存在时安全返回', () => {
  assert.deepEqual(pruneObservationCache(path.join(os.tmpdir(), 'bb-obs-missing-' + Date.now())), { removed: 0, kept: 0 });
});

test('忽略非 json 文件', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  pruneObservationCache(dir, { maxFiles: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
});
