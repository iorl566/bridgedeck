import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, takeTokenChunk } from '../../extension/src/tokens.js';

const text = Array.from({ length: 20 }, (_, index) => 'line ' + index + ' ' + 'x'.repeat(30)).join('\n');

test('预算内返回全部、无省略', () => {
  const chunk = takeTokenChunk(text, 0, 10000);
  assert.equal(chunk.next, null);
  assert.equal(chunk.omittedChars, 0);
  assert.equal(chunk.omittedLines, 0);
});

test('超预算：给出 omittedChars/omittedLines 与 next', () => {
  const chunk = takeTokenChunk(text, 0, 20);
  assert(chunk.next > 0);
  assert(chunk.omittedChars > 0);
  assert(chunk.omittedLines > 0);
  assert(chunk.used <= 20 || chunk.lines === 1);
  assert.equal(chunk.text.length + chunk.omittedChars, text.length);
});

test('单行超预算仍返回整行，不切碎', () => {
  const chunk = takeTokenChunk('x'.repeat(500), 0, 5);
  assert.equal(chunk.text, 'x'.repeat(500));
  assert.equal(chunk.next, null);
  assert.equal(chunk.omittedChars, 0);
});

test('estimateTokens 边界', () => {
  assert(estimateTokens('') >= 0);
  assert(estimateTokens('hello world') > 0);
});
