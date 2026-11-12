import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetResult, DEBUG_FIELDS, matchesRequest, projectFields } from '../../extension/src/debug/query.js';

const request = {
  id: 'n1', method: 'GET', url: 'https://site.test/api', status: 200, state: 'complete',
  resource_type: 'XHR', mime_type: 'application/json', duration_ms: 5, extra: 'keep',
};

test('matchesRequest filters url/method/status/state/kind', () => {
  assert.equal(matchesRequest(request, { url: '/api' }), true);
  assert.equal(matchesRequest(request, { method: 'POST' }), false);
  assert.equal(matchesRequest(request, { status: 200, state: 'complete' }), true);
  assert.equal(matchesRequest(request, { kind: 'business' }), true);
});

test('projectFields removes non-selected debug fields', () => {
  const projected = projectFields(request, ['status']);
  assert.equal(projected.status, 200);
  assert.equal(projected.resource_type, undefined);
  assert.equal(projected.extra, 'keep');
  assert.equal(DEBUG_FIELDS.includes('status'), true);
});

test('budgetResult trims request lists and reports omission', () => {
  const value = {
    run: { id: 'r1', started_at: 1, coverage: [] },
    requests: Array.from({ length: 30 }, (_, index) => ({ ...request, url: `/api/${index}`, sequence: index })),
    next_since: 30,
  };
  const result = budgetResult(value, { action: 'requests', budget: 4096 });
  assert(result.requests.length < 30);
  assert.equal(result.output.truncated, true);
  assert(result.output.omitted.includes('requests'));
  assert.equal(result.next_since, result.requests.at(-1).sequence);
});

test('budgetResult compacts data URLs', () => {
  const value = { run: {}, requests: [{ ...request, url: 'data:image/png;base64,' + 'A'.repeat(1000) }] };
  const result = budgetResult(value, { action: 'requests', budget: 65536 });
  assert(result.requests[0].url.includes('inline content omitted'));
});
