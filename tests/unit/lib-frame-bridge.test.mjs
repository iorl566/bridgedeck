import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_FRAME_PORT, RECORD_FRAME_QUERY, RECORD_FRAME_START,
  isRecordFrameQueryMessage, isRecordFrameStartMessage,
} from '../../extension/src/lib/recording/frame-bridge.js';

test('frame bridge validators', () => {
  assert.equal(isRecordFrameQueryMessage({ type: RECORD_FRAME_QUERY }), true);
  assert.equal(isRecordFrameQueryMessage({ type: 'other' }), false);
  assert.equal(isRecordFrameStartMessage({ type: RECORD_FRAME_START, requestId: 'r', startedAtMs: 1 }), true);
  assert.equal(isRecordFrameStartMessage({ type: RECORD_FRAME_START, requestId: 'r' }), false);
  assert.equal(isRecordFrameStartMessage(null), false);
});

test('frame bridge constants are neutral', () => {
  assert.equal(RECORD_FRAME_PORT, 'bb-record-frame');
  assert.equal(RECORD_FRAME_QUERY, 'bb-record-frame-query');
  assert.equal(RECORD_FRAME_START, 'bb-record-frame-start');
});
