import test from 'node:test';
import assert from 'node:assert/strict';
import { children, ownedByHiddenElement, signature } from '../../extension/src/cooperation/hidden-frames.js';

test('children match parent frame and document', () => {
  const inventory = [
    { frameId: 1, parentFrameId: 0, parentDocumentId: 'a', documentId: 'p', url: 'u0' },
    { frameId: 2, parentFrameId: 1, parentDocumentId: 'p', documentId: 'd1', url: 'u1' },
    { frameId: 3, parentFrameId: 1, parentDocumentId: 'old', documentId: 'd2', url: 'u2' },
  ];
  assert.deepEqual(children(inventory, inventory[0]).map((frame) => frame.frameId), [2]);
});

test('ownedByHiddenElement proves only a unique hidden mapping', () => {
  const frame = { frameId: 2, url: 'u2' };
  const siblings = [{ frameId: 2, url: 'u2' }, { frameId: 3, url: 'u3' }];
  assert.equal(ownedByHiddenElement(frame, [{ hidden: true, url: null }, { hidden: false, url: 'u3' }], siblings), true);
  assert.equal(ownedByHiddenElement(frame, [{ hidden: false, url: 'u2' }, { hidden: false, url: 'u3' }], siblings), false);
  assert.equal(ownedByHiddenElement(frame, [{ hidden: true, url: null }], siblings), false);
});

test('signature is order independent', () => {
  const a = { frameId: 1, documentId: 'a', url: 'u' };
  const b = { frameId: 2, documentId: 'b', url: 'v' };
  assert.equal(signature([a, b]), signature([b, a]));
});
