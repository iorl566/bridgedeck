import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTextChange } from '../../extension/src/lib/text-change-log.js';

test('appendTextChange 保留最近 N 条并统计丢弃', () => {
  let log = [];
  let dropped = 0;
  for (let index = 0; index < 5; index += 1) {
    const next = appendTextChange(log, { at: index + 1, before: String(index), after: String(index + 1) }, { limit: 3 });
    log = next.texts;
    dropped += next.dropped;
  }
  assert.deepEqual(log.map((item) => item.at), [3, 4, 5]);
  assert.equal(dropped, 2);
});

test('appendTextChange 空输入/单条', () => {
  const result = appendTextChange(null, { before: 'a', after: 'b' });
  assert.equal(result.texts.length, 1);
  assert.equal(result.texts[0].before, 'a');
  assert.equal(result.dropped, 0);
});
