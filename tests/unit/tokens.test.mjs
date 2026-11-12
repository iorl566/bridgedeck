import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, takeTokenChunk } from '../../extension/src/tokens.js';

test('token estimate is monotonic and handles CJK/English', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world') >= 2);
  assert.ok(estimateTokens('你好世界') >= 3);
  assert.ok(estimateTokens('hello world and more text') > estimateTokens('hello'));
});

test('token chunks advance a cursor without losing text', () => {
  const text = Array.from({ length: 20 }, (_, i) => '- item ' + i + ' lorem ipsum').join('\n');
  const parts = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const chunk = takeTokenChunk(text, offset, 12);
    parts.push(chunk.text);
    if (!chunk.next) break;
    offset = chunk.next;
  }
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
});
