// M6 P0③ 交接窗口 owner 语义：handback 状态 → 控制权 owner / 窗口宽度。
// 与 BSK cooperate control_policy（auto/strict/target）+ handoff 语义对齐的加法字段单测。
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  HANDOFF_STATES,
  HANDOFF_OWNER,
  DEFAULT_HANDOFF_WINDOW_MS,
  handoffOwner,
  handoffWindowFor,
  handoffRuleFor,
  handoffTransitionTable,
} = await import('../../extension/src/lib/human-handoff.js');

test('handoff owner 映射：idle=shared / agent 态=agent / human 与 pending=human', () => {
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.IDLE], 'shared');
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.AGENT], 'agent');
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.HUMAN], 'human');
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.PENDING], 'human');
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.DONE], 'agent');
  assert.equal(HANDOFF_OWNER[HANDOFF_STATES.ABORTED], 'human');
  assert.equal(handoffOwner('handback-pending'), 'human');
  assert.equal(handoffOwner('unknown-state'), 'shared', '非法状态回退 shared，不抛异常');
});

test('交接窗口：只有 handback-pending 打开；宽度默认 60s，可注入', () => {
  assert.equal(DEFAULT_HANDOFF_WINDOW_MS, 60000);
  const open = handoffWindowFor(HANDOFF_STATES.PENDING, { openedAt: 1000, now: 5000 });
  assert.equal(open.open, true);
  assert.equal(open.handoff, true);
  assert.equal(open.owner, 'human');
  assert.equal(open.widthMs, 60000);
  assert.equal(open.closesAt, 61000);
  assert.equal(open.remainingMs, 56000);
  assert.equal(open.expired, false);
  const wide = handoffWindowFor(HANDOFF_STATES.PENDING, { openedAt: 1000, widthMs: 3000, now: 2000 });
  assert.equal(wide.widthMs, 3000);
  assert.equal(wide.remainingMs, 2000);
  const expired = handoffWindowFor(HANDOFF_STATES.PENDING, { openedAt: 1000, widthMs: 3000, now: 9000 });
  assert.equal(expired.expired, true);
  assert.equal(expired.remainingMs, 0);
  for (const state of [HANDOFF_STATES.IDLE, HANDOFF_STATES.AGENT, HANDOFF_STATES.HUMAN, HANDOFF_STATES.DONE, HANDOFF_STATES.ABORTED]) {
    const closed = handoffWindowFor(state, { openedAt: 1000, now: 2000 });
    assert.equal(closed.open, false, state + ' 不打开交接窗口');
    assert.equal(closed.widthMs, 0);
    assert.equal(closed.remainingMs, 0);
  }
});

test('交接窗口不改变既有 handback 迁移表（只加 owner/window 字段）', () => {
  assert.equal(handoffRuleFor(HANDOFF_STATES.HUMAN, 'handback.request').to, HANDOFF_STATES.PENDING);
  assert.equal(handoffTransitionTable().length, 14);
  const table = handoffTransitionTable();
  for (const rule of table) {
    assert.equal(typeof handoffOwner(rule.to), 'string');
  }
});
