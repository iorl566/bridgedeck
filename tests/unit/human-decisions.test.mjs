import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHumanDecision, waitHumanDecision } from '../../extension/src/human-decisions.js';

test('human decision 解析与超时', async () => {
  const pending = waitHumanDecision('r1', 100, () => ({ decision: 'timeout' }));
  assert.equal(resolveHumanDecision({ requestId: 'r1', decision: 'allow' }), true);
  assert.equal((await pending).decision, 'allow');
  assert.equal((await waitHumanDecision('r2', 10, () => ({ decision: 'timeout' }))).decision, 'timeout');
});
