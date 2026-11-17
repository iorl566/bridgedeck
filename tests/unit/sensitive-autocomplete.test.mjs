import test from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_PASSWORD_ATTRIBUTE, SENSITIVE_AUTOCOMPLETE_SELECTOR, sensitiveAutocomplete } from '../../extension/src/lib/sensitive-autocomplete.js';

test('sensitiveAutocomplete matches token lists, not substrings', () => {
  assert.equal(sensitiveAutocomplete('section-login current-password'), true);
  assert.equal(sensitiveAutocomplete('billing cc-number'), true);
  assert.equal(sensitiveAutocomplete('one-time-code'), true);
  assert.equal(sensitiveAutocomplete('username'), false);
  assert.equal(sensitiveAutocomplete(null), false);
  assert.equal(RECORD_PASSWORD_ATTRIBUTE, 'data-bb-record-password');
  assert.match(SENSITIVE_AUTOCOMPLETE_SELECTOR, /autocomplete~="current-password" i/);
});
