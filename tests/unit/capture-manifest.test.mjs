import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureManifest, pruneManifests } from '../../lib/capture-manifest.mjs';

test('capture manifest 记录尺寸/瓦片/URL 并清理过期', () => {
  const manifest = buildCaptureManifest({ id: 'c1', width: 800.4, height: 1200, tiles: 3, url: 'https://x', now: 1000 });
  assert.equal(manifest.width, 800);
  assert.equal(manifest.height, 1200);
  assert.equal(manifest.tiles, 3);
  const pruned = pruneManifests([manifest, { id: 'old', createdAt: new Date(0).toISOString() }], { now: 1001, ttlMs: 10 });
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].id, 'c1');
});
