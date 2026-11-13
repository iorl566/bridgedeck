import test from 'node:test';
import assert from 'node:assert/strict';
import { controllerColor, isControllerInfo } from '../../extension/src/lib/controller-info.js';
import { auditStepStatus, auditTimeline } from '../../extension/src/lib/audit-timeline.js';

test('isControllerInfo validates labels and color', () => {
  assert.equal(isControllerInfo({ name: 'a' }), true);
  assert.equal(isControllerInfo({ name: 'a', project: 'p', color: '#aabbcc' }), true);
  assert.equal(isControllerInfo({ name: '' }), false);
  assert.equal(isControllerInfo({ name: 'x'.repeat(81) }), false);
  assert.equal(isControllerInfo({ name: 'a', color: 'red' }), false);
  assert.equal(isControllerInfo({ name: 'a\u0000' }), false);
});

test('controllerColor prefers explicit color and avoids used colors', () => {
  assert.equal(controllerColor('s1', { color: '#123456' }), '#123456');
  const first = controllerColor('s1');
  const second = controllerColor('s1', null, [first]);
  assert.notEqual(first, second);
});

test('auditTimeline folds context and result into operations', () => {
  const rows = auditTimeline([
    { at: 1, kind: 'operation_started', operation_id: 'o1', data: { method: 'click' } },
    { at: 2, kind: 'context', operation_id: 'o1', data: { tab: 1 } },
    { at: 3, kind: 'operation_finished', operation_id: 'o1', data: { status: 'ok' } },
    { at: 4, kind: 'named', data: {} },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, { method: 'click', tab: 1 });
  assert.deepEqual(rows[0].result, { status: 'ok' });
});

test('auditTimeline keeps repeated calls and marks interrupted', () => {
  const rows = auditTimeline([
    { at: 1, kind: 'operation_started', operation_id: 'o1', data: {} },
    { at: 2, kind: 'operation_started', operation_id: 'o2', data: {} },
    { at: 3, kind: 'ended', data: {} },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].interrupted, true);
  assert.equal(rows[1].interrupted, true);
});

test('auditStepStatus uses result, pending list and run state', () => {
  const run = { status: 'running' };
  assert.equal(auditStepStatus({ id: 'o1', result: { status: 'error' } }, run), 'error');
  assert.equal(auditStepStatus({ id: 'o1' }, run, ['o1']), 'running');
  assert.equal(auditStepStatus({ id: 'o1' }, run, []), 'unknown');
  assert.equal(auditStepStatus({ id: 'o1' }, { status: 'ended' }), 'unknown');
});
