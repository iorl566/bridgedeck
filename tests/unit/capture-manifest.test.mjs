import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCaptureManifest, pruneManifests, upsertCaptureManifest } from '../../lib/capture-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('capture manifest 记录尺寸/瓦片/URL 并清理过期', () => {
  const manifest = buildCaptureManifest({ id: 'c1', width: 800.4, height: 1200, tiles: 3, url: 'https://x', now: 1000 });
  assert.equal(manifest.width, 800);
  assert.equal(manifest.height, 1200);
  assert.equal(manifest.tiles, 3);
  const pruned = pruneManifests([manifest, { id: 'old', createdAt: new Date(0).toISOString() }], { now: 1001, ttlMs: 10 });
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].id, 'c1');
});

test('upsertCaptureManifest 去重、置顶并按上限收敛', () => {
  const older = buildCaptureManifest({ id: 'a', now: 1000 });
  const newer = buildCaptureManifest({ id: 'b', now: 2000 });
  const replaced = buildCaptureManifest({ id: 'a', width: 10, now: 3000 });
  const list = upsertCaptureManifest([older, newer], replaced, { ttlMs: 60_000, max: 2, now: 3000 });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'a');
  assert.equal(list[0].width, 10);
  assert.deepEqual(list.map((item) => item.id), ['a', 'b']);
  const capped = upsertCaptureManifest([older, newer], buildCaptureManifest({ id: 'c', now: 4000 }), { ttlMs: 60_000, max: 2, now: 4000 });
  assert.deepEqual(capped.map((item) => item.id), ['c', 'b']);
});

test('扩展镜像与根 lib 的 capture-manifest 保持一致', () => {
  const root = fs.readFileSync(path.join(ROOT, 'lib', 'capture-manifest.mjs'), 'utf8');
  const mirror = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'lib', 'capture-manifest.js'), 'utf8');
  assert.equal(mirror, root, 'capture-manifest 镜像与 lib 版本不一致');
});
