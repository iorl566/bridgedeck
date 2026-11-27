import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTrace } from '../../lib/trace-summary.mjs';

function event(name, ts, dur = 0, cat = 'devtools.timeline') {
  return { name, ts, dur, cat };
}

test('summarizeTrace 统计事件/分类/热点/时长', () => {
  const trace = {
    traceEvents: [
      event('RunTask', 1000000, 120000),
      event('FunctionCall', 1050000, 5000),
      event('FunctionCall', 1060000, 7000),
      event('Paint', 1300000, 0),
    ],
  };
  const summary = summarizeTrace(trace);
  assert.equal(summary.events, 4);
  assert.equal(summary.durationMs, 300);
  assert.equal(summary.topNames[0].key, 'FunctionCall');
  assert.equal(summary.topNames[0].count, 2);
  assert.equal(summary.longTaskCount, 1);
  assert.equal(summary.longTasks[0].name, 'RunTask');
  assert.equal(summary.longTasks[0].durationMs, 120);
});

test('summarizeTrace 处理空/非法输入', () => {
  assert.deepEqual(summarizeTrace(null), {
    events: 0, durationMs: 0, topCategories: [], topNames: [], longTasks: [], longTaskCount: 0,
  });
  assert.equal(summarizeTrace({ traceEvents: [null, 'x'] }).events, 0);
});
