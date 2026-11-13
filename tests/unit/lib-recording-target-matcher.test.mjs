import test from 'node:test';
import assert from 'node:assert/strict';
import { matchObservationTarget, unmatchedTarget } from '../../extension/src/lib/recording/target-matcher.js';

function observation(candidates, refs = []) {
  return {
    rootFrameId: 'root',
    index: {
      candidates: (_frameId, tag) => candidates.filter((candidate) => candidate.tag === tag),
      refs: () => refs,
    },
  };
}

test('unmatchedTarget keeps fallback labels', () => {
  assert.deepEqual(unmatchedTarget({ role: 'button', name: 'Go' }), { role: 'button', name: 'Go', unmatched: true });
  assert.deepEqual(unmatchedTarget(), { unmatched: true });
});

test('unique geometry match wins', () => {
  const candidate = { tag: 'button', ref: { ref: '@e1', role: 'button', name: 'Go' }, geometry: { rect: { x: 1, y: 2, w: 3, h: 4 } } };
  const result = matchObservationTarget({ observation: observation([candidate]), hint: { frameId: 'root', geometry: { tag: 'button', rect: { x: 1, y: 2, w: 3, h: 4 } } } });
  assert.deepEqual(result, { ref: '@e1', role: 'button', name: 'Go' });
});

test('semantic fallback identifies a single same-tag candidate', () => {
  const candidates = [
    { tag: 'button', ref: { ref: '@e1', role: 'button', name: 'Go' }, geometry: { rect: { x: 0, y: 0, w: 1, h: 1 } } },
    { tag: 'button', ref: { ref: '@e2', role: 'button', name: 'Stop' }, geometry: { rect: { x: 5, y: 5, w: 1, h: 1 } } },
  ];
  const result = matchObservationTarget({ observation: observation(candidates), hint: { frameId: 'root', geometry: { tag: 'button', rect: { x: 99, y: 99, w: 1, h: 1 } } }, fallback: { name: 'Stop' } });
  assert.equal(result.ref, '@e2');
});

test('missing frame returns unmatched and semantic-only path works', () => {
  assert.deepEqual(matchObservationTarget({ observation: observation([]), hint: { frameId: null } }), { unmatched: true });
  const refs = [{ ref: '@e3', role: 'link', name: 'Docs' }];
  assert.equal(matchObservationTarget({ observation: observation([], refs), fallback: { role: 'link', name: 'Docs' } }).ref, '@e3');
});
