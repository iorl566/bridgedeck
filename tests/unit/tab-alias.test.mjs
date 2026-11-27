import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlias } from '../../extension/src/tab-alias.js';

test('alias 规范化', () => {
  assert.equal(normalizeAlias('Work-Mail'), 'work-mail');
  assert.equal(normalizeAlias('  tabs_1 '), 'tabs_1');
  assert.equal(normalizeAlias('1tab'), '');
  assert.equal(normalizeAlias('bad alias'), '');
  assert.equal(normalizeAlias(''), '');
  assert.equal(normalizeAlias('a'.repeat(41)), '');
});
