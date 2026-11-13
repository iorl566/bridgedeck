import test from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_PASSWORD_ATTRIBUTE, SENSITIVE_AUTOCOMPLETE_SELECTOR, sensitiveAutocomplete } from '../../extension/src/lib/sensitive-autocomplete.js';
import { createRandomUuid } from '../../extension/src/lib/random-uuid.js';
import { createOverlayVersionSource } from '../../extension/src/lib/overlay-version.js';

test('sensitiveAutocomplete matches token lists, not substrings', () => {
  assert.equal(sensitiveAutocomplete('section-login current-password'), true);
  assert.equal(sensitiveAutocomplete('billing cc-number'), true);
  assert.equal(sensitiveAutocomplete('one-time-code'), true);
  assert.equal(sensitiveAutocomplete('username'), false);
  assert.equal(sensitiveAutocomplete(null), false);
  assert.equal(RECORD_PASSWORD_ATTRIBUTE, 'data-bb-record-password');
  assert.match(SENSITIVE_AUTOCOMPLETE_SELECTOR, /autocomplete~="current-password" i/);
});

test('createRandomUuid uses randomUUID when available', () => {
  assert.equal(createRandomUuid({ randomUUID: () => 'fixed' }), 'fixed');
});

test('createRandomUuid fallback sets version and variant bits', () => {
  const bytes = new Uint8Array(16).fill(0xff);
  const uuid = createRandomUuid({ getRandomValues: (target) => { target.set(bytes); } });
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('overlay version increments and keeps epoch', () => {
  const next = createOverlayVersionSource('e1');
  assert.deepEqual(next(), { epoch: 'e1', generation: 1 });
  assert.deepEqual(next(), { epoch: 'e1', generation: 2 });
});
