import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_DOCUMENT_ATTRIBUTE, readRecordingDocumentIdentity, recordingDocumentMarkerValue,
} from '../../extension/src/shared/recording-document-identity.js';

const uuid = '123e4567-e89b-42d3-a456-426614174000';

test('recordingDocumentMarkerValue validates UUID', () => {
  assert.equal(recordingDocumentMarkerValue(uuid), `bb:${uuid}`);
  assert.throws(() => recordingDocumentMarkerValue('not-a-uuid'), /random UUID/);
  assert.throws(() => recordingDocumentMarkerValue('123e4567-e89b-12d3-a456-426614174000'), /random UUID/);
});

test('readRecordingDocumentIdentity reads marker', () => {
  assert.equal(readRecordingDocumentIdentity({ [RECORD_DOCUMENT_ATTRIBUTE]: `bb:${uuid}` }), uuid);
  assert.equal(readRecordingDocumentIdentity({ [RECORD_DOCUMENT_ATTRIBUTE]: `xx:${uuid}` }), undefined);
  assert.equal(readRecordingDocumentIdentity({ [RECORD_DOCUMENT_ATTRIBUTE]: 'bb:bad' }), undefined);
  assert.equal(readRecordingDocumentIdentity({}), undefined);
});

test('attribute name is neutral', () => {
  assert.equal(RECORD_DOCUMENT_ATTRIBUTE, 'data-bb-record-document');
});
