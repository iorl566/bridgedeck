import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_CANCEL, RECORD_FINISH, RECORD_QUERY, RECORD_START, RECORD_STEP, RECORD_STOP,
  isAcceptedRecordStepAck, isRecordCancelMessage, isRecordFinishMessage, isRecordQueryMessage,
  isRecordStartMessage, isRecordStepMessage, isRecordStopMessage,
} from '../../extension/src/lib/record-bridge.js';

test('record control message validators', () => {
  assert.equal(isRecordStartMessage({ type: RECORD_START, requestId: 'r' }), true);
  assert.equal(isRecordStopMessage({ type: RECORD_STOP, requestId: 'r' }), true);
  assert.equal(isRecordCancelMessage({ type: RECORD_CANCEL, requestId: 'r' }), true);
  assert.equal(isRecordFinishMessage({ type: RECORD_FINISH, requestId: 'r' }), true);
  assert.equal(isRecordQueryMessage({ type: RECORD_QUERY }), true);
  assert.equal(isRecordStartMessage({ type: RECORD_START }), false);
});

test('isRecordStepMessage validates sequence/step', () => {
  const step = { type: RECORD_STEP, requestId: 'r', producerId: 'p', sequence: 1, step: { op: 'click' } };
  assert.equal(isRecordStepMessage(step), true);
  assert.equal(isRecordStepMessage({ ...step, sequence: 0 }), false);
  assert.equal(isRecordStepMessage({ ...step, producerId: '' }), false);
  assert.equal(isRecordStepMessage({ ...step, step: {} }), false);
});

test('isAcceptedRecordStepAck matches sequence', () => {
  assert.equal(isAcceptedRecordStepAck({ ok: true, sequence: 2 }, 2), true);
  assert.equal(isAcceptedRecordStepAck({ ok: true, sequence: 1 }, 2), false);
  assert.equal(isAcceptedRecordStepAck({ ok: false, expectedSequence: 2, error: 'x' }, 2), false);
});

test('record constants are neutral and distinct', () => {
  const values = [RECORD_START, RECORD_STEP, RECORD_STOP, RECORD_CANCEL, RECORD_FINISH, RECORD_QUERY];
  assert.equal(new Set(values).size, values.length);
  assert(values.every((value) => value.startsWith('bb-record-')));
});
