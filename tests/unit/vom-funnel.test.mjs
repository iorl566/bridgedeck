import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVomFunnel } from '../../extension/src/lib/vom-funnel.js';

test('summarizeVomFunnel 统计丢弃原因与保留率', () => {
  const funnel = summarizeVomFunnel({ collected: 100, skippedTag: 10, hidden: 20, stealth: 5, empty: 5, deduped: 10, emitted: 50, tokens: 900, truncated: true });
  assert.equal(funnel.collected, 100);
  assert.equal(funnel.emitted, 50);
  assert.equal(funnel.dropped, 50);
  assert.equal(funnel.keptRate, 0.5);
  assert.equal(funnel.truncated, true);
  assert.equal(funnel.droppedReasons.find((item) => item.stage === 'hidden').count, 20);
  assert.equal(funnel.droppedReasons.find((item) => item.stage === 'budget'), undefined);
});

test('summarizeVomFunnel 空输入安全', () => {
  const funnel = summarizeVomFunnel({});
  assert.equal(funnel.collected, 0);
  assert.equal(funnel.emitted, 0);
  assert.equal(funnel.dropped, 0);
  assert.equal(funnel.keptRate, 0);
  assert.deepEqual(funnel.droppedReasons, []);
});

test('summarizeVomFunnel 附带显式六阶段（collect→resolve→filter→enrich→rank→emit）', () => {
  const funnel = summarizeVomFunnel({ collected: 100, skippedTag: 10, hidden: 20, stealth: 5, empty: 5, deduped: 10, emitted: 50, tokens: 900, truncated: true });
  assert.deepEqual(funnel.stages.map((stage) => stage.name), ['collect', 'resolve', 'filter', 'enrich', 'rank', 'emit']);
  for (const stage of funnel.stages) {
    assert.equal(typeof stage.input, 'number');
    assert.equal(typeof stage.output, 'number');
    assert.equal(typeof stage.dropped, 'number');
    assert.ok(Array.isArray(stage.dropReasons));
    assert.equal(typeof stage.ms, 'number');
  }
  assert.equal(funnel.stages[0].input, 100);
  assert.equal(funnel.stages[1].output, 65);
  assert.equal(funnel.stages[5].output, 50);
  assert.equal(funnel.capture.version, 1);
  assert.deepEqual(funnel.capture.stageNames, ['collect', 'resolve', 'filter', 'enrich', 'rank', 'emit']);
  assert.equal(funnel.capture.totals.collected, 100);
  assert.equal(funnel.capture.totals.emitted, 50);
  assert.match(funnel.capture.text, /collect 100→100/);
  // visited 计数的文本观察漏斗同样映射到六阶段。
  const textFunnel = summarizeVomFunnel({ visited: 30, hidden: 6, emitted: 24 });
  assert.equal(textFunnel.stages[0].input, 30);
  assert.equal(textFunnel.stages[1].output, 24);
});
