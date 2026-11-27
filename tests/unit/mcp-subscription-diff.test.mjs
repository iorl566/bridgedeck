// tests/unit/mcp-subscription-diff.test.mjs —— 订阅差量 / 覆盖 / 健康 / 对账计划。
//
// 覆盖：条目归一化（registry.list / Set / 字符串混合、去重）、diff（added/removed/kept/
// changed/identity）、affectedByUpdate（精确/缺失/近失）、coverageReport（覆盖数学/悬空/
// latest 建议/静态订阅/重复）、planSubscriptionChanges（收敛/幂等/排序）、subscriptionHealth
// （idle/stale/never-notified/clean）、churnReport、自检与能力快照。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBSCRIPTION_DIFF_LIMITS,
  SUBSCRIPTION_DIFF_REASONS,
  affectedByUpdate,
  assertSubscriptionDiff,
  auditSubscriptionDiff,
  churnReport,
  coverageReport,
  diffSubscriptions,
  normalizeSubscriptionEntries,
  planSubscriptionChanges,
  subscriptionDiffSnapshot,
  subscriptionHealth,
} from '../../mcp/subscription-diff.mjs';
import { buildResourceGraph } from '../../mcp/resource-graph.mjs';

const ROWS = [
  { uri: 'bridge://skill/SKILL.md', mimeType: 'text/markdown' },
  { uri: 'bridge://observation/latest', mimeType: 'application/json' },
  { uri: 'bridge://observation/s1', mimeType: 'application/json' },
  { uri: 'bridge://debug/evidence/s1', mimeType: 'application/json' },
  { uri: 'bridge://debug/journal/s1', mimeType: 'application/json' },
  { uri: 'bridge://update/state', mimeType: 'application/json' },
];

test('normalizeSubscriptionEntries：字符串/Set/条目混合、去重、保留输入顺序', () => {
  const entries = normalizeSubscriptionEntries([
    'bridge://observation/latest',
    { uri: 'bridge://observation/latest', notifications: 9 },
    { uri: ' bridge://observation/s1 ', subscribedAt: '2026-11-26T00:00:00.000Z', ageMs: 1200, notifications: 3, lastNotifiedAt: '2026-11-26T00:00:01.000Z' },
    '   ',
    null,
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].uri, 'bridge://observation/latest');
  assert.equal(entries[0].notifications, 0, '重复项保留第一条');
  assert.equal(entries[1].uri, 'bridge://observation/s1');
  assert.equal(entries[1].notifications, 3);
  assert.equal(entries[1].ageMs, 1200);
  assert.deepEqual(normalizeSubscriptionEntries(new Set(['a', 'b', 'a'])).map((entry) => entry.uri), ['a', 'b']);
  assert.deepEqual(normalizeSubscriptionEntries(null), []);
  assert.deepEqual(normalizeSubscriptionEntries([{ uri: 42 }, { nope: true }]), []);
});

test('diffSubscriptions：增删、保留、通知计数变化与相同集合', () => {
  const before = [
    { uri: 'bridge://observation/s1', notifications: 1 },
    { uri: 'bridge://observation/latest', notifications: 2 },
  ];
  const after = [
    { uri: 'bridge://observation/s1', notifications: 3 },
    { uri: 'bridge://debug/journal/s1', notifications: 0 },
  ];
  const diff = diffSubscriptions(before, after);
  assert.deepEqual(diff.added, ['bridge://debug/journal/s1']);
  assert.deepEqual(diff.removed, ['bridge://observation/latest']);
  assert.deepEqual(diff.kept, ['bridge://observation/s1']);
  assert.deepEqual(diff.changed, [{ uri: 'bridge://observation/s1', field: 'notifications', from: 1, to: 3 }]);
  assert.deepEqual(diff.counts, { before: 2, after: 2, added: 1, removed: 1, kept: 1, churn: 2 });
  assert.equal(diff.unchanged, false);

  const identity = diffSubscriptions(after, after);
  assert.equal(identity.unchanged, true);
  assert.equal(identity.counts.churn, 0);
  assert.deepEqual(identity.changed, []);

  const fromEmpty = diffSubscriptions(null, ['bridge://observation/latest']);
  assert.deepEqual(fromEmpty.added, ['bridge://observation/latest']);
  assert.deepEqual(fromEmpty.counts, { before: 0, after: 1, added: 1, removed: 0, kept: 0, churn: 1 });
});

test('affectedByUpdate：精确匹配/未订阅/同会话与 latest 近失', () => {
  const graph = buildResourceGraph(ROWS);
  const entries = [{ uri: 'bridge://observation/s1' }, { uri: 'bridge://observation/latest' }];
  const report = affectedByUpdate(entries, [
    'bridge://observation/s1',
    'bridge://debug/journal/s1',
    'bridge://debug/journal/s1',
    'bridge://not-subscribed/x',
  ], { graph });
  assert.deepEqual(report.matched, ['bridge://observation/s1']);
  assert.deepEqual(report.missing, ['bridge://debug/journal/s1', 'bridge://not-subscribed/x']);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.missingCount, 2);
  // journal/s1 与已订阅的 observation/s1 是同会话兄弟 → nearMiss。
  assert.ok(report.nearMiss.some((item) => item.uri === 'bridge://observation/s1'
    && item.reason === 'session-sibling' && item.relatedTo === 'bridge://debug/journal/s1'));
  // 没有 graph 时不做近失推断（不猜）。
  const withoutGraph = affectedByUpdate(entries, ['bridge://debug/journal/s1']);
  assert.equal(withoutGraph.nearMiss.length, 0);
  assert.equal(affectedByUpdate(entries, []).matchedCount, 0);
});

test('coverageReport：动态覆盖、悬空订阅、latest 建议、静态订阅、图指纹', () => {
  const graph = buildResourceGraph(ROWS);
  const entries = [
    { uri: 'bridge://observation/s1', notifications: 1, ageMs: 1000 },
    { uri: 'bridge://observation/gone', notifications: 0, ageMs: 10 },
    { uri: 'bridge://skill/SKILL.md', notifications: 0, ageMs: 10 },
  ];
  const coverage = coverageReport(entries, ROWS, { graph });
  assert.equal(coverage.dynamicResources, 4);
  assert.equal(coverage.subscribedDynamic, 1);
  assert.equal(coverage.unsubscribedDynamic, 3);
  assert.equal(coverage.coverage, 0.25);
  assert.deepEqual(coverage.orphanSubscriptions, ['bridge://observation/gone']);
  assert.deepEqual(coverage.staticSubscriptions, ['bridge://skill/SKILL.md']);
  assert.equal(coverage.aliasesCovered, 0);
  assert.equal(coverage.graphFingerprint, graph.fingerprint);
  // 建议顺序：latest 别名优先，然后 observation，最后其它动态。
  assert.equal(coverage.suggestions[0].uri, 'bridge://observation/latest');
  assert.equal(coverage.suggestions[0].reason, SUBSCRIPTION_DIFF_REASONS.ALIAS);
  assert.equal(coverage.suggestions[0].priority, 0.9);
  assert.ok(coverage.suggestions.some((item) => item.uri === 'bridge://debug/evidence/s1'));
  // 全部订阅后覆盖率为 1、没有建议。
  const full = coverageReport(['bridge://observation/latest', 'bridge://observation/s1', 'bridge://debug/evidence/s1', 'bridge://debug/journal/s1'], ROWS);
  assert.equal(full.coverage, 1);
  assert.equal(full.suggestions.length, 0);
  assert.equal(full.orphanSubscriptions.length, 0);
  // 空动态集合 → 覆盖率按 1 处理（没有可覆盖的内容，不是 0）。
  assert.equal(coverageReport([], []).coverage, 1);
});

test('planSubscriptionChanges：收敛、幂等、排序与体积统计', () => {
  const plan = planSubscriptionChanges(
    ['bridge://observation/latest', 'bridge://observation/s1'],
    ['bridge://observation/s1', 'bridge://stale/x'],
  );
  assert.deepEqual(plan.toSubscribe, ['bridge://observation/latest']);
  assert.deepEqual(plan.toUnsubscribe, ['bridge://stale/x']);
  assert.deepEqual(plan.unchanged, ['bridge://observation/s1']);
  assert.equal(plan.desired, 2);
  assert.equal(plan.current, 2);
  assert.equal(plan.ops, 2);

  const converged = planSubscriptionChanges(['a', 'b'], ['b', 'a']);
  assert.equal(converged.ops, 0);
  assert.deepEqual(converged.unchanged, ['a', 'b']);

  const empty = planSubscriptionChanges([], []);
  assert.equal(empty.ops, 0);
  assert.deepEqual(empty.toSubscribe, []);
  // 去重 + 去空白。
  const messy = planSubscriptionChanges([' a ', 'a', ''], []);
  assert.deepEqual(messy.toSubscribe, ['a']);
  assert.equal(messy.desired, 1);
});

test('subscriptionHealth：idle/stale/never-notified/healthy 阈值与上限', () => {
  const now = 1_700_000_000_000;
  const fresh = subscriptionHealth([
    { uri: 'bridge://observation/s1', ageMs: 1000, notifications: 2, lastNotifiedAt: new Date(now).toISOString() },
  ], { now });
  assert.equal(fresh.healthy, true);
  assert.equal(fresh.total, 1);
  assert.equal(fresh.notified, 1);
  assert.equal(fresh.neverNotified, 0);
  assert.deepEqual(fresh.idle, []);

  const idle = subscriptionHealth([
    { uri: 'bridge://observation/s1', ageMs: SUBSCRIPTION_DIFF_LIMITS.idleAfterMs + 1, notifications: 0 },
  ], { now });
  assert.deepEqual(idle.idle, ['bridge://observation/s1']);
  assert.equal(idle.healthy, false);
  assert.ok(idle.issues.some((issue) => issue.code === 'subscription-idle'));

  const stale = subscriptionHealth([
    { uri: 'bridge://observation/latest', ageMs: SUBSCRIPTION_DIFF_LIMITS.staleAfterMs + 1, notifications: 5 },
  ], { now });
  assert.deepEqual(stale.stale, ['bridge://observation/latest']);
  assert.ok(stale.issues.some((issue) => issue.code === 'subscription-stale'));

  // 用 subscribedAt 派生 ageMs（registry.list 之外的输入也能算）。
  const derived = subscriptionHealth([
    { uri: 'bridge://x/y', subscribedAt: new Date(now - 10_000).toISOString(), notifications: 1 },
  ], { now });
  assert.ok(derived.longestIdleMs >= 9_000);
  assert.equal(subscriptionHealth([], { now }).healthy, true);
});

test('churnReport：比例计算与空/非法输入', () => {
  const report = churnReport({ subscribed: 10, unsubscribed: 2, evicted: 3, capped: 1, failed: 0, cleared: 0 });
  assert.equal(report.churnRate, 0.5);
  assert.equal(report.cleanupRate, 0.2);
  assert.equal(report.evicted, 3);
  const empty = churnReport(null);
  assert.equal(empty.churnRate, 0);
  assert.equal(empty.subscribed, 0);
  const invalid = churnReport({ subscribed: 'x', evicted: -1 });
  assert.equal(invalid.subscribed, 0);
  assert.equal(invalid.evicted, -1);
});

test('auditSubscriptionDiff：自检通过且 strict 不抛错；能力快照自洽', () => {
  const report = auditSubscriptionDiff();
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.ok(report.checks >= 10);
  assert.doesNotThrow(() => assertSubscriptionDiff());

  const snapshot = subscriptionDiffSnapshot();
  assert.equal(snapshot.supported, true);
  assert.deepEqual(snapshot.fields.diff, ['added', 'removed', 'kept', 'changed', 'counts', 'unchanged']);
  assert.ok(snapshot.fields.coverage.includes('suggestions'));
  assert.ok(snapshot.fields.health.includes('idle'));
  assert.equal(snapshot.plan.fields.includes('ops'), true);
  assert.equal(snapshot.limits.maxSuggestions, SUBSCRIPTION_DIFF_LIMITS.maxSuggestions);
  assert.equal(snapshot.reconcile, 'sdk.syncResourceSubscriptions(desired)');
});

test('coverageReport：限制参数只能收紧建议条数', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ uri: 'bridge://observation/s' + index }));
  const coverage = coverageReport([], rows, { limits: { maxSuggestions: 3 } });
  assert.equal(coverage.suggestions.length, 3);
  const many = coverageReport([], rows, { limits: { maxSuggestions: 999 } });
  assert.ok(many.suggestions.length > 3);
});
