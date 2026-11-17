import test from 'node:test';
import assert from 'node:assert/strict';
import { canReplay, makeBoundary } from '../../lib/replay-timeline.mjs';

test('replay 只在同一 document/frame/revision 窗口内', () => {
  const event = { boundary: makeBoundary({ documentId: 'd1', frameId: 2, revision: 7 }) };
  assert.equal(canReplay(event, makeBoundary({ documentId: 'd1', frameId: 2, revision: 7 })).ok, true);
  assert.equal(canReplay(event, makeBoundary({ documentId: 'd2', frameId: 2, revision: 7 })).reason, 'document-changed');
  assert.equal(canReplay(event, makeBoundary({ documentId: 'd1', frameId: 3, revision: 7 })).reason, 'frame-changed');
  assert.equal(canReplay(event, makeBoundary({ documentId: 'd1', frameId: 2, revision: 8 })).reason, 'revision-changed');
});
