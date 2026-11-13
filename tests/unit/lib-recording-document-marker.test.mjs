import test from 'node:test';
import assert from 'node:assert/strict';
import { markRecordingDocument } from '../../extension/src/lib/recording/document-marker.js';
import { RECORD_DOCUMENT_ATTRIBUTE } from '../../extension/src/shared/recording-document-identity.js';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
function root(attrs = {}) {
  const values = new Map(Object.entries(attrs));
  return {
    getAttribute: (name) => (values.has(name) ? values.get(name) : null),
    setAttribute: (name, value) => values.set(name, value),
    removeAttribute: (name) => values.delete(name),
    value: () => values.get(RECORD_DOCUMENT_ATTRIBUTE),
  };
}

test('markRecordingDocument sets and restores absent attribute', () => {
  const element = root();
  const marker = markRecordingDocument(uuid, element);
  assert.equal(element.value(), `bb:${uuid}`);
  marker.ensure();
  marker.restore();
  assert.equal(element.value(), undefined);
});

test('markRecordingDocument restores previous attribute', () => {
  const element = root({ [RECORD_DOCUMENT_ATTRIBUTE]: 'old' });
  const marker = markRecordingDocument(uuid, element);
  assert.equal(element.value(), `bb:${uuid}`);
  marker.restore();
  assert.equal(element.value(), 'old');
});

test('restore does not clobber a newer marker', () => {
  const element = root();
  const marker = markRecordingDocument(uuid, element);
  element.setAttribute(RECORD_DOCUMENT_ATTRIBUTE, 'new');
  marker.restore();
  assert.equal(element.value(), 'new');
});
