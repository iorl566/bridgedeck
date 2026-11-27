import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthority } from '../../extension/src/lib/authority.js';

test('四类权威快照', () => {
  const auth = buildAuthority({
    tabId: 7,
    policy: 'target',
    held: false,
    readOnly: false,
    generation: 3,
    revision: 12,
    contextId: 'c',
    observationId: 'o',
    humanActive: false,
    controlRevision: 4,
    authorityRevision: 2,
    epoch: 5,
    frameEpoch: 6,
  });
  assert.equal(auth.tab.ownership, 'agent');
  assert.equal(auth.control.generation, 3);
  assert.equal(auth.control.controlRevision, 4);
  assert.equal(auth.observation.revision, 12);
  assert.equal(auth.observation.epoch, 5);
  assert.equal(auth.observation.frameEpoch, 6);
  assert.equal(auth.action.authorityRevision, 2);
  assert.equal(auth.action.allowed, true);
});

test('四类权威计数缺省为 0，且互不串味', () => {
  const auth = buildAuthority({});
  assert.equal(auth.control.controlRevision, 0);
  assert.equal(auth.observation.epoch, 0);
  assert.equal(auth.observation.frameEpoch, 0);
  assert.equal(auth.action.authorityRevision, 0);
  assert.equal(buildAuthority({ controlRevision: 9 }).observation.epoch, 0);
});

test('held / readOnly 拒绝动作', () => {
  assert.equal(buildAuthority({ held: true }).action.deniedReason, 'held');
  assert.equal(buildAuthority({ readOnly: true }).action.deniedReason, 'read-only');
});
