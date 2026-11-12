import test from 'node:test';
import assert from 'node:assert/strict';
import { OBSERVATION_TIMEOUT_MS, sanitizeFields } from '../../extension/src/debug/observer.js';

test('sanitizeFields limits and redacts sensitive fields', () => {
  const snapshot = sanitizeFields({
    fields: [
      { key: 'email', label: 'Email', name: 'email', value: 'a@b.test' },
      { key: 'password', label: 'Password', name: 'password', value: 'secret' },
      { key: 'note', label: 'Note', value: 'x'.repeat(300) },
    ],
    text: 'page',
    navigation: 'navigate',
  });
  assert.equal(snapshot.fields.length, 3);
  assert.equal(snapshot.fields[0].state, 'available');
  assert.equal(snapshot.fields[0].value, 'a@b.test');
  assert.equal(snapshot.fields[1].state, 'redacted');
  assert.equal(snapshot.fields[1].value, undefined);
  assert.equal(snapshot.fields[2].state, 'truncated');
  assert.equal(snapshot.text, 'page');
  assert.equal(snapshot.navigation, 'navigate');
  assert.equal(OBSERVATION_TIMEOUT_MS, 600);
});

test('sanitizeFields caps fields at 16 and flags partial', () => {
  const snapshot = sanitizeFields({ fields: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })) });
  assert.equal(snapshot.fields.length, 16);
  assert.equal(snapshot.fields_partial, false);
  assert.equal(sanitizeFields({}).fields_partial, true);
});

test('sanitizeFields truncates long page text', () => {
  const snapshot = sanitizeFields({ text: 'a'.repeat(7000), fields: [] });
  assert.equal(snapshot.text.length, 6000);
  assert.equal(snapshot.truncated, true);
});
