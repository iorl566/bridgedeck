import test from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptedRecordStepAck, RecordStepDelivery } from '../../extension/src/content/record-step-delivery.js';

test('RecordStepDelivery sends in order and flushes success', async () => {
  const sent = [];
  const delivery = new RecordStepDelivery('r1', async (message) => { sent.push(message); return { ok: true, sequence: message.sequence }; }, 'p1');
  delivery.enqueue({ kind: 'input', data: 'a' });
  delivery.enqueue({ kind: 'click', data: 'b' });
  assert.equal(await delivery.flush(), true);
  assert.deepEqual(sent.map((message) => message.sequence), [1, 2]);
  assert.equal(sent[0].producerId, 'p1');
});

test('RecordStepDelivery stops on failed ack and flush reports false', async () => {
  let calls = 0;
  const delivery = new RecordStepDelivery('r1', async () => { calls += 1; return { ok: false, sequence: 1 }; }, 'p1');
  delivery.enqueue({ kind: 'x' });
  assert.equal(await delivery.flush(), false);
  assert.equal(calls >= 1, true);
});

test('isAcceptedRecordStepAck validates sequence', () => {
  assert.equal(isAcceptedRecordStepAck({ ok: true, sequence: 2 }, 2), true);
  assert.equal(isAcceptedRecordStepAck({ ok: true, sequence: 1 }, 2), false);
  assert.equal(isAcceptedRecordStepAck(null, 2), false);
});
