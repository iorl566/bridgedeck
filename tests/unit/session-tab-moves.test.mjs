import test from 'node:test';
import assert from 'node:assert/strict';
import { ExpectedTabMoves } from '../../extension/src/session-manager/tab-moves.js';

test('same-window reorder bypasses tracking', async () => {
  const moves = new ExpectedTabMoves();
  assert.equal(await moves.run({ tabId: 1, fromWindowId: 2, toWindowId: 2 }, async () => 7), 7);
});

test('detach/attach pair resolves expected move', async () => {
  const moves = new ExpectedTabMoves();
  let release;
  const running = moves.run({ tabId: 1, fromWindowId: 2, toWindowId: 3 }, () => new Promise((resolve) => { release = resolve; }));
  const detached = moves.onDetached(1, 2);
  moves.onAttached(1, 3);
  assert.equal(await detached, true);
  release('ok');
  assert.equal(await running, 'ok');
});

test('wrong attach and forget resolve false', async () => {
  const moves = new ExpectedTabMoves();
  void moves.run({ tabId: 2, fromWindowId: 1, toWindowId: 3 }, () => Promise.resolve());
  const detached = moves.onDetached(2, 1);
  moves.onAttached(2, 4);
  assert.equal(await detached, false);
  moves.forget(2);
  assert.equal(moves.operations.size, 0);
});
