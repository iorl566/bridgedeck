// tests/unit/trace-replay.test.mjs —— replay CLI 的 Trace v3 → plan steps 转换（纯函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTraceSteps, summarizeReplayPlan } from '../../cli/lib/trace-replay.mjs';

test('trace-replay：只保留 action/observe/wait 并回填 target', () => {
  const trace = {
    version: 3,
    steps: [
      { kind: 'action', method: 'click', params: { selector: '#btn' } },
      { kind: 'observe', method: 'observe', params: {} },
      { kind: 'wait', method: 'wait-ms', params: { ms: 100 } },
      { kind: 'human-gate', method: 'request-help', params: {} },
      { method: 'fill', target: { selector: '#kw' }, params: { value: 'x' } },
    ],
  };
  const { steps, skipped } = normalizeTraceSteps(trace);
  assert.equal(steps.length, 4);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'human-gate');
  assert.equal(steps[3].params.selector, '#kw');
  assert.equal(steps[3].params.value, 'x');
});

test('trace-replay：接受 steps 数组并拒绝缺 steps 的输入', () => {
  const normalized = normalizeTraceSteps([{ method: 'click', params: {} }]);
  assert.equal(normalized.steps.length, 1);
  assert.throws(() => normalizeTraceSteps({ version: 3 }), /缺少 steps/);
});

test('trace-replay：dry-run 摘要包含方法序列与 staleRef 提示', () => {
  const { steps } = normalizeTraceSteps({ steps: [{ method: 'click', params: { ref: '@e1' } }] });
  const summary = summarizeReplayPlan({ steps, skipped: [] }, { source: '/tmp/trace.json' });
  assert.equal(summary.totalSteps, 1);
  assert.deepEqual(summary.methods, ['click']);
  assert.equal(summary.staleRefWarning.length, 1);
  assert.match(summary.staleRefWarning[0], /@e1/);
});
