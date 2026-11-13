import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDialogType, parseDialogOpeningParams, truncateDialogField } from '../../extension/src/browser-driver/dialog-parser.js';

test('normalizeDialogType only accepts known types', () => {
  assert.equal(normalizeDialogType('prompt'), 'prompt');
  assert.equal(normalizeDialogType('beforeunload'), 'beforeunload');
  assert.equal(normalizeDialogType('other'), 'alert');
  assert.equal(normalizeDialogType(undefined), 'alert');
});

test('parseDialogOpeningParams projects fields', () => {
  assert.deepEqual(parseDialogOpeningParams({ type: 'confirm', message: 'm', url: 'u', defaultPrompt: 'p', hasBrowserHandler: true }), {
    type: 'confirm', message: 'm', url: 'u', defaultPrompt: 'p', hasBrowserHandler: true,
  });
  assert.deepEqual(parseDialogOpeningParams({}), { type: 'alert', message: '', url: undefined, defaultPrompt: undefined, hasBrowserHandler: undefined });
});

test('truncateDialogField caps long fields', () => {
  assert.equal(truncateDialogField('short'), 'short');
  assert.match(truncateDialogField('x'.repeat(5000)), /\.\.\. \[truncated\]$/);
});
