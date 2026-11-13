import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRecordedPayload, observeRecordedNavigation } from '../../extension/src/lib/recording/step-buffer.js';
import { RecordingTabCoordinator } from '../../extension/src/lib/recording/tab-coordinator.js';

function buffer() {
  return { steps: [], navigation: { currentUrl: undefined, pendingNavigation: false } };
}

test('append click/fill/press payloads', () => {
  const b = buffer();
  assert.equal(appendRecordedPayload(b, { op: 'click', target: { tag: 'button' }, page_url: 'u' }), 0);
  assert.equal(appendRecordedPayload(b, { op: 'fill', target: { tag: 'input' }, value: 'v', redacted: true }), 1);
  assert.equal(appendRecordedPayload(b, { op: 'press', key: 'a' }), 2);
  assert.equal(b.steps[2].pageUrl, undefined);
  assert.equal(b.steps[1].redacted, true);
});

test('invalid payloads are ignored', () => {
  const b = buffer();
  assert.equal(appendRecordedPayload(b, { op: 'click' }), null);
  assert.equal(appendRecordedPayload(b, { op: 'fill' }), null);
  assert.equal(appendRecordedPayload(b, { op: 'press' }), null);
});

test('navigation caused by action annotates last step', () => {
  const b = buffer();
  appendRecordedPayload(b, { op: 'click', target: { tag: 'a' } });
  const result = observeRecordedNavigation(b, 'https://next', true);
  assert.equal(result.kind, 'annotated');
  assert.equal(b.steps[0].navigatedTo, 'https://next');
});

test('redirect qualifiers coalesce and reload is recorded', () => {
  const b = buffer();
  appendRecordedPayload(b, { op: 'click', target: { tag: 'a' } });
  assert.deepEqual(observeRecordedNavigation(b, 'https://r', false, 'link', ['server_redirect']), { kind: 'coalesce_redirect', url: 'https://r' });
  assert.equal(observeRecordedNavigation(b, 'https://s', false).kind, 'appended');
  assert.equal(observeRecordedNavigation(b, 'https://s', false, 'reload').kind, 'appended');
});

test('tab activation tracks latest revision', () => {
  const c = new RecordingTabCoordinator(1, 'https://a');
  const first = c.noteActivation(2);
  assert.equal(c.isLatest(first), true);
  const second = c.noteActivation(1);
  assert.equal(c.isLatest(first), false);
  assert.equal(c.isLatest(second), true);
  assert.equal(c.activeTabId, 1);
});

test('commit updates current tab and navigation fallback', () => {
  const c = new RecordingTabCoordinator(1, 'https://a');
  c.commit(2, 'https://b');
  assert.equal(c.currentTabId, 2);
  assert.equal(c.navigation(2).currentUrl, 'https://b');
  assert.equal(c.navigation(3, 'https://c').currentUrl, 'https://c');
});
