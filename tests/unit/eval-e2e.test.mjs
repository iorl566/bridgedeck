import test from 'node:test';
import assert from 'node:assert/strict';
import { parseE2EResults, summarizeCases } from '../../lib/eval-e2e.mjs';

test('E2E 结果解析 + 缺失 case 为 unverified', () => {
  const results = parseE2EResults('  PASS  23p3. OOPIF — ok\n  FAIL  35d. replaced — bad\n');
  assert.equal(results.get('23p3').ok, true);
  assert.equal(results.get('35d').ok, false);
  const summary = summarizeCases(['23p3', '35d', 'missing'], results);
  assert.equal(summary.checks.length, 2);
  assert.equal(summary.unverified[0].id, 'missing');
});
