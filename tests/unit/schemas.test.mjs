import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMethodParams } from '../../lib/schemas.mjs';

test('schema validates required fields and ranges', () => {
  assert.equal(validateMethodParams('navigate', { url: 'https://example.com' }).length, 0);
  assert.ok(validateMethodParams('navigate', {}).length > 0);
  assert.ok(validateMethodParams('fill', { selector: '#a' }).length > 0);
  assert.equal(validateMethodParams('fill', { selector: '#a', value: '' }).length, 0);
  assert.ok(validateMethodParams('observe', { maxTokens: 999999 }).length > 0);
});

test('schema ignores unknown methods and extra fields', () => {
  assert.equal(validateMethodParams('not-a-method', { anything: true }).length, 0);
  assert.equal(validateMethodParams('click', { selector: '#a', unknown: 1 }).length, 0);
});

test('schema reports missing required field path', () => {
  const errors = validateMethodParams('navigate', {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^params\.url/);
});

test('schema checks integer bounds', () => {
  assert.ok(validateMethodParams('wait-ms', { ms: 120001 }).length > 0);
  assert.equal(validateMethodParams('wait-ms', { ms: 120000 }).length, 0);
  assert.ok(validateMethodParams('observe', { maxTokens: 0 }).length > 0);
});

test('schema checks strings and patterns', () => {
  assert.ok(validateMethodParams('transfer.release', { transferId: 'bad' }).length > 0);
  assert.equal(validateMethodParams('transfer.release', { transferId: 'tr_0123456789abcdef' }).length, 0);
  assert.ok(validateMethodParams('navigate', { url: '' }).length > 0);
});

test('schema checks booleans and numbers', () => {
  assert.ok(validateMethodParams('click', { trusted: 'yes' }).length > 0);
  assert.equal(validateMethodParams('click', { trusted: true }).length, 0);
  assert.ok(validateMethodParams('drag', { modifiers: 'ctrl' }).length > 0);
  assert.equal(validateMethodParams('drag', { modifiers: 15 }).length, 0);
});

test('schema validates transfer.begin required fields and size', () => {
  assert.ok(validateMethodParams('transfer.begin', {}).length >= 2);
  assert.equal(validateMethodParams('transfer.begin', { name: 'a.bin', byteSize: 1 }).length, 0);
  assert.ok(validateMethodParams('transfer.begin', { name: 'a.bin', byteSize: 0 }).length > 0);
});

test('schema validates generic session/tabId for uncovered methods', () => {
  assert.equal(validateMethodParams('plan', { session: 's', tabId: 1, steps: [{ method: 'click' }] }).length, 0);
  assert.ok(validateMethodParams('plan', { session: 1, steps: [{ method: 'click' }] }).length > 0);
  assert.ok(validateMethodParams('plan', { tabId: 'x', steps: [{ method: 'click' }] }).length > 0);
});

test('schema validates plan steps array items', () => {
  assert.equal(validateMethodParams('plan', { steps: [{ method: 'click' }] }).length, 0);
  assert.ok(validateMethodParams('plan', { steps: [] }).length > 0);
  assert.ok(validateMethodParams('plan', { steps: [{ params: {} }] }).length > 0);
  assert.ok(validateMethodParams('plan', { steps: 'no' }).length > 0);
});

test('schema validates screenshot/extract fields', () => {
  assert.equal(validateMethodParams('screenshot', { selector: '#a', scope: 'viewport' }).length, 0);
  assert.ok(validateMethodParams('screenshot', { fullPage: 'yes' }).length > 0);
  assert.ok(validateMethodParams('extract.table', { target: 'x' }).length > 0);
  assert.equal(validateMethodParams('extract.table', { target: 1, maxRows: 2 }).length, 0);
});

test('schema reports non-object params', () => {
  assert.ok(validateMethodParams('navigate', 'not-an-object').length > 0);
});

test('schema validates action wait timeout bounds', () => {
  assert.equal(validateMethodParams('click', { waitTimeoutMs: 0 }).length, 0);
  assert.equal(validateMethodParams('click', { waitTimeoutMs: 5000 }).length, 0);
  assert.ok(validateMethodParams('click', { waitTimeoutMs: -1 }).length > 0);
  assert.ok(validateMethodParams('fill', { value: 'x', waitTimeoutMs: 1.5 }).length > 0);
});
