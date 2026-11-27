import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor } from '../../extension/src/lib/observation-cursor.js';

test('cursor roundtrip 保留 tab/offset/revision/document', () => {
  const value = { t: 3, o: 120, at: 99, r: 7, d: 'https://x' };
  const text = encodeCursor(value);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(text), value);
});
