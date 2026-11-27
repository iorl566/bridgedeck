import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRefDetails } from '../../extension/src/lib/ref-details.js';

test('buildRefDetails 把 cdpSessionId 纳入稳定身份', () => {
  const nodes = [{ ref: '@e1', tag: 'button', id: 'go', role: 'button', name: '提交' }];
  const a = buildRefDetails(nodes, { frameId: 0, documentId: 'https://x', cdpSessionId: '1:0' })[0];
  const b = buildRefDetails(nodes, { frameId: 0, documentId: 'https://x', cdpSessionId: '2:0' })[0];
  assert.equal(a.cdpSessionId, '1:0');
  assert.notEqual(a.stableRef, b.stableRef);
});

test('同一会话/文档下 stableRef 可复用', () => {
  const nodes = [{ ref: '@e1', tag: 'button', id: 'go', role: 'button', name: '提交' }];
  const context = { frameId: 0, documentId: 'https://x', cdpSessionId: '1:0' };
  assert.equal(buildRefDetails(nodes, context)[0].stableRef, buildRefDetails(nodes, context)[0].stableRef);
});
