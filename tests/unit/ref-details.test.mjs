import assert from 'node:assert/strict';
import { buildRefDetails } from '../../extension/src/lib/ref-details.js';

const details = buildRefDetails([
  { ref: '@e1', backendNodeId: 42, role: 'button', name: '提交' },
  { ref: null, backendNodeId: 43 },
  { ref: '@e2', backendNodeId: null, role: 'link', name: 'x'.repeat(200) },
], { frameId: 7, documentId: 'doc-1', revision: 9 });

assert.equal(details.length, 2);
assert.deepEqual(details[0], {
  ref: '@e1', backendNodeId: 42, role: 'button', name: '提交', frameId: 7, documentId: 'doc-1', revision: 9,
});
assert.equal(details[1].backendNodeId, null);
assert.equal(details[1].name.length, 120);
assert.deepEqual(buildRefDetails(null), []);

console.log('REF_DETAILS_OK');
