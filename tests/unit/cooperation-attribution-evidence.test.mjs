// 人类输入归因证据：谁在动、动在哪、±1.5ms 时间戳归因与冲突裁决。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTION_TIME_TOLERANCE_MS,
  buildHumanInputEvidence,
  classifyAttribution,
  describeHumanInput,
  summarizeAttributionFrames,
} from '../../extension/src/lib/attribution-evidence.js';

const NOW = 100000;

test('容差常量是 1.5ms（与内容脚本 ATTRIBUTION_TIME_TOLERANCE_MS 同值）', () => {
  assert.equal(ATTRIBUTION_TIME_TOLERANCE_MS, 1.5);
});

test('内容脚本归因：时间戳命中（|skew|<=1.5ms）判 Agent 并标记在容差内', () => {
  const classified = classifyAttribution({
    attribution: { owner: 'agent', reason: 'timestamp', kind: 'pointer', skewMs: 1.2, at: NOW - 100 },
    now: NOW,
  });
  assert.equal(classified.who, 'agent');
  assert.equal(classified.basis, 'timestamp');
  assert.equal(classified.withinTolerance, true);
  assert.equal(classified.confidence > 0.95, true);
  assert.equal(classified.skewMs, 1.2);
  assert.equal(classified.ageMs, 100);

  const outside = classifyAttribution({
    attribution: { owner: 'agent', reason: 'timestamp', kind: 'key', skewMs: -4, at: NOW - 10 },
    now: NOW,
  });
  assert.equal(outside.who, 'agent');
  assert.equal(outside.withinTolerance, false, '|skew|>1.5ms 不应标记在容差内');
});

test('内容脚本归因：坐标/按键与宽限路径的置信度分层', () => {
  const coordinate = classifyAttribution({ attribution: { owner: 'agent', reason: 'coordinate', kind: 'pointer', skewMs: null, at: NOW - 5 }, now: NOW });
  assert.equal(coordinate.basis, 'coordinate');
  assert.equal(coordinate.confidence, 0.9);
  assert.equal(coordinate.withinTolerance, null);
  const grace = classifyAttribution({ attribution: { owner: 'agent', reason: 'grace', kind: 'pointer', at: NOW - 5 }, now: NOW });
  assert.equal(grace.basis, 'grace');
  assert.equal(grace.confidence, 0.6);
});

test('人工归因：isTrusted 输入判 human；同时存在 Agent 窗口时标记冲突', () => {
  const human = classifyAttribution({
    attribution: { owner: 'human', reason: 'input', kind: 'pointer', at: NOW - 50 },
    humanState: { at: NOW - 50, frameId: 0 },
    agentWindow: { start: NOW - 100, end: NOW - 10 },
    now: NOW,
  });
  assert.equal(human.who, 'human');
  assert.equal(human.basis, 'input');
  assert.equal(human.conflicting, true);

  const noWindow = classifyAttribution({
    attribution: { owner: 'human', reason: 'input', kind: 'key', at: NOW - 50 },
    now: NOW,
  });
  assert.equal(noWindow.conflicting, false);
});

test('内容归因过期 → 回退后台 human-state；再回退 Agent 窗口；最后 unknown', () => {
  const stale = classifyAttribution({
    attribution: { owner: 'human', reason: 'input', kind: 'pointer', at: NOW - 60000 },
    humanState: { at: NOW - 400, frameId: 3, focus: 'name' },
    now: NOW,
  });
  assert.equal(stale.who, 'human');
  assert.equal(stale.basis, 'background-watch');
  assert.equal(stale.source, 'human-state');

  const windowOnly = classifyAttribution({
    agentWindow: { start: NOW - 100, end: NOW - 20 },
    now: NOW,
  });
  assert.equal(windowOnly.who, 'agent');
  assert.equal(windowOnly.basis, 'agent-window');

  const none = classifyAttribution({ now: NOW });
  assert.equal(none.who, 'unknown');
  assert.equal(none.basis, 'none');
  assert.equal(none.confidence, 0);
});

test('buildHumanInputEvidence：动在哪（frame/类型/目标/坐标）+ 计数 + 容差证据', () => {
  const evidence = buildHumanInputEvidence({
    frameState: {
      revision: 12,
      inputClock: 4,
      human: 2,
      humanAttributed: 1,
      agentAttributed: 3,
      agentAttributedByTimestamp: 2,
      agentAttributedByCoordinate: 1,
      pointer: 5,
      keyboard: 1,
      editing: true,
      busy: false,
      expectationPending: false,
      document: 'https://example.test/form',
      timeToleranceMs: 1.5,
      attribution: { owner: 'agent', reason: 'timestamp', kind: 'pointer', skewMs: 0.75, at: NOW - 20 },
      events: [{ kind: 'pointer', at: NOW - 20, label: 'submit', frameId: 0 }],
      lastHumanAt: NOW - 5000,
      lastAgentAt: NOW - 20,
      lastInput: NOW - 20,
    },
    humanState: { at: NOW - 5000, frameId: 0, focus: 'email', editing: true },
    expectation: { kinds: ['pointer'], x: 120, y: 240 },
    now: NOW,
  });
  assert.equal(evidence.who, 'agent');
  assert.equal(evidence.where.kind, 'pointer');
  assert.equal(evidence.where.label, 'submit');
  assert.equal(evidence.where.editing, true);
  assert.equal(evidence.where.x, 120);
  assert.equal(evidence.where.y, 240);
  assert.equal(evidence.when.skewMs, 0.75);
  assert.equal(evidence.when.toleranceMs, 1.5);
  assert.equal(evidence.when.withinTolerance, true);
  assert.equal(evidence.counts.byTimestamp, 2);
  assert.equal(evidence.counts.byCoordinate, 1);
  assert.equal(evidence.counts.agentAttributed, 3);
  assert.equal(evidence.frame.revision, 12);
  assert.deepEqual(evidence.frame.recentKinds, ['pointer']);
  assert.equal(evidence.evidence.rule.includes('1.5ms'), true);
  assert.equal(evidence.conflict.humanRecent, false);
});

test('buildHumanInputEvidence：无内容归因时按后台人工快照输出 where/rule', () => {
  const evidence = buildHumanInputEvidence({
    frameState: { revision: 3, lastHumanAt: NOW - 300 },
    humanState: { at: NOW - 300, frameId: 2, focus: 'q', editing: true },
    now: NOW,
  });
  assert.equal(evidence.who, 'human');
  assert.equal(evidence.where.frameId, 2);
  assert.equal(evidence.where.label, 'q');
  assert.equal(evidence.evidence.rule.includes('deny-by-default'), true);
});

test('summarizeAttributionFrames：取最新归因 frame、合计计数、隐藏 frame 不参与', () => {
  const summary = summarizeAttributionFrames([
    { frameId: 0, url: 'https://top/', hidden: false, state: { frameState: { revision: 1, humanAttributed: 1, agentAttributed: 2, attribution: { owner: 'human', reason: 'input', kind: 'key', at: NOW - 900 } } } },
    { frameId: 5, url: 'https://frame/', hidden: false, state: { frameState: { revision: 2, humanAttributed: 2, agentAttributed: 3, agentAttributedByTimestamp: 2, agentAttributedByCoordinate: 1, attribution: { owner: 'agent', reason: 'timestamp', kind: 'pointer', skewMs: 0.2, at: NOW - 10 } } } },
    { frameId: 9, url: 'https://hidden/', hidden: true, state: { frameState: { humanAttributed: 100, attribution: { owner: 'human', reason: 'input', at: NOW } } } },
  ], { now: NOW });
  assert.equal(summary.who, 'agent');
  assert.equal(summary.where.frameId, 5);
  assert.equal(summary.where.url, 'https://frame/');
  assert.equal(summary.counts.humanAttributed, 3, '隐藏 frame 的人类输入不应合计');
  assert.equal(summary.counts.agentAttributed, 5);
  assert.equal(summary.frames.length, 2);
});

test('describeHumanInput：一行摘要包含 who/frame/目标/skew/容差', () => {
  const evidence = buildHumanInputEvidence({
    frameState: {
      attribution: { owner: 'agent', reason: 'timestamp', kind: 'pointer', skewMs: 1.1, at: NOW - 5 },
      events: [{ kind: 'pointer', label: 'ok' }],
    },
    expectation: { x: 10, y: 20 },
    now: NOW,
  });
  const text = describeHumanInput(evidence);
  assert.match(text, /^归因：Agent（timestamp）/);
  assert.match(text, /frame=0/);
  assert.match(text, /kind=pointer/);
  assert.match(text, /目标=ok/);
  assert.match(text, /skew=1\.1ms/);
  assert.match(text, /容差=1\.5ms/);
  assert.match(describeHumanInput(null), /无证据/);
});
