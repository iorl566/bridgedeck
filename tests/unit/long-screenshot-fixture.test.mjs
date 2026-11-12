import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../extension/src/long-screenshot/test-fixture.js';

test('fixture renders the requested height and fixed chrome', () => {
  const html = fixture(120);
  assert.match(html, /#pattern \{[^}]*height:120px/);
  assert.match(html, /id="fixed"/);
  assert.match(html, /id="footer"/);
  assert.match(html, /id="sticky"/);
  assert.equal((html.match(/height:1px/g) ?? []).length >= 120, true);
});

test('lazy and delayed batches add scripts', () => {
  const lazy = fixture(10, true);
  assert.match(lazy, /loadMore/);
  const delayed = fixture(10, false, 2);
  assert.match(delayed, /加载中/);
  assert.match(delayed, /batches>=2/);
});
