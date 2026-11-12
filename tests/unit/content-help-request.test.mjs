import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelpRequestData } from '../../extension/src/content/help-request.js';

function harness(response) {
  const finished = [];
  const data = createHelpRequestData(
    { requestId: 'r1', prompt: '登录', selectors: ['#a'], rects: [{ x: 1 }] },
    { finish: (...args) => finished.push(args), query: async () => response },
  );
  return { data, finished };
}

test('maps required and optional fields', () => {
  const { data } = harness(null);
  assert.equal(data.id, 'r1');
  assert.equal(data.prompt, '登录');
  assert.deepEqual(data.selectors, ['#a']);
  assert.equal('title' in data, false);
  assert.equal('displayMode' in data, false);
});

test('refreshRects returns rects only for the active request', async () => {
  assert.deepEqual(await harness({ active: true, request: { requestId: 'r1', rects: [{ x: 2 }] } }).data.refreshRects(), [{ x: 2 }]);
  assert.equal(await harness({ active: true, request: { requestId: 'r2', rects: [{ x: 2 }] } }).data.refreshRects(), undefined);
  assert.equal(await harness(null).data.refreshRects(), undefined);
});

test('continue trims note and cancel finishes', () => {
  const { data, finished } = harness(null);
  data.onContinue('  done  ');
  data.onContinue('   ');
  data.onCancel();
  assert.deepEqual(finished, [['r1', 'continued', '  done  '], ['r1', 'continued', undefined], ['r1', 'cancelled']]);
});
