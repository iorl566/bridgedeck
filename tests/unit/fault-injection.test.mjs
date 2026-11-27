import test from 'node:test';
import assert from 'node:assert/strict';
import { RefRegistry } from '../../extension/src/refs/ref-registry.js';
import { decodeCursor } from '../../extension/src/lib/observation-cursor.js';
import { canReplay, makeBoundary } from '../../lib/replay-timeline.mjs';
import { buildActionReceipt } from '../../extension/src/lib/action-receipt.js';

test('故障注入：无效 backend 升级/坏 cursor/空 boundary 都失败关闭', () => {
  const registry = new RefRegistry();
  registry.register(1, '@e1', { frameId: 0, documentId: 'd', revision: 1 });
  assert.equal(registry.upgradeBackend(1, '@e1', 0), null);
  assert.equal(registry.upgradeBackend(1, '@e1', 'x'), null);
  assert.throws(() => decodeCursor('not-base64-json'));
  assert.equal(canReplay(null, makeBoundary({ documentId: 'd' })).ok, false);
});

test('receipt 对非法 frame/revision 归一', () => {
  const receipt = buildActionReceipt({ method: 'click', frameId: 'x', revision: 'y', effectState: 'nope' });
  assert.equal(receipt.frameId, 0);
  assert.equal(receipt.revision, null);
  assert.equal(receipt.effectState, 'committed');
});
