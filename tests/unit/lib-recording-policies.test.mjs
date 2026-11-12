import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRedirectQualifier } from '../../extension/src/lib/recording/navigation-policy.js';
import { resolveDraftStartUrl, shouldIncludeDraft, shouldRecordPress } from '../../extension/src/lib/recording/draft-policy.js';
import { RecordingStateRegistry } from '../../extension/src/lib/recording/state-registry.js';
import { formatTraceStateBody } from '../../extension/src/lib/recording/trace-state-body.js';

test('redirect qualifiers', () => {
  assert.equal(hasRedirectQualifier(['server_redirect']), true);
  assert.equal(hasRedirectQualifier(['client_redirect', 'other']), true);
  assert.equal(hasRedirectQualifier(['link']), false);
  assert.equal(hasRedirectQualifier(undefined), false);
});

test('press policy drops modifier/clipboard/plain keys', () => {
  assert.equal(shouldRecordPress('Meta'), false);
  assert.equal(shouldRecordPress('c', ['ctrl']), false);
  assert.equal(shouldRecordPress('Enter'), true);
  assert.equal(shouldRecordPress('Escape'), true);
  assert.equal(shouldRecordPress('a'), false);
  assert.equal(shouldIncludeDraft({ op: 'press', key: 'a' }), false);
  assert.equal(shouldIncludeDraft({ op: 'click' }), true);
});

test('draft start URL priority', () => {
  assert.equal(resolveDraftStartUrl([], 'explicit'), 'explicit');
  assert.equal(resolveDraftStartUrl([{ op: 'navigate', url: 'nav' }], undefined, 'fallback'), 'nav');
  assert.equal(resolveDraftStartUrl([{ op: 'click', pageUrl: 'page' }], undefined, 'fallback'), 'page');
  assert.equal(resolveDraftStartUrl([], undefined, undefined), 'about:blank');
});

test('state registry dedupes identity and merges metadata', () => {
  const registry = new RecordingStateRegistry();
  const first = registry.register({ url: 'u', vomText: 'body' });
  assert.equal(first.id, 's1');
  const again = registry.register({ url: 'u', vomText: 'body', title: 'T', truncated: true });
  assert.equal(again, first);
  assert.equal(again.title, 'T');
  assert.equal(again.truncated, true);
  registry.markStep('s1', 2);
  registry.markStep('s1', 2);
  assert.deepEqual(registry.values()[0].stepsHere, [2]);
});

test('trace state body annotates matching lines', () => {
  const body = formatTraceStateBody({
    stateId: 's1',
    url: 'https://x',
    title: 'T',
    stepIds: [1],
    vomText: 'a\nb',
    annotations: [{ draftId: 1, line: 1, op: 'click', detail: 'Go' }],
    stepIdByDraftId: new Map([[1, 1]]),
  });
  assert.match(body, /^# bb-observation 1/m);
  assert.match(body, /steps_here: \[1\]/);
  assert.match(body, /b  ↳ step 1: click: Go/);
});
