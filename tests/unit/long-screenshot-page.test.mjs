import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotError } from '../../extension/src/long-screenshot/types.js';
import { pageError } from '../../extension/src/long-screenshot/page.js';

test('pageError preserves ScreenshotError codes', () => {
  assert.equal(pageError(new ScreenshotError('changed')), 'changed');
  assert.equal(pageError(new ScreenshotError('interrupted', 'page_hidden')), 'interrupted');
});

test('pageError maps unknown errors to interrupted', () => {
  assert.equal(pageError(new Error('boom')), 'interrupted');
  assert.equal(pageError('x'), 'interrupted');
});
