import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVomProfile, VOM_PROFILES } from '../../extension/src/lib/vom-profile.js';

test('resolveVomProfile 返回稳定档位', () => {
  assert.deepEqual(resolveVomProfile('compact'), { minScore: 20, maxNodes: 80, maxTokens: 4000, excludeHidden: true });
  assert.deepEqual(resolveVomProfile('BALANCED'), { minScore: 0, maxNodes: 200, maxTokens: 8000 });
  assert.deepEqual(resolveVomProfile('all'), {});
  assert.equal(resolveVomProfile('nope'), null);
  assert.equal(VOM_PROFILES.compact.maxNodes, 80);
});
