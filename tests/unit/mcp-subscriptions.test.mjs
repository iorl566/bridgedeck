// tests/unit/mcp-subscriptions.test.mjs —— MCP resources/subscribe 订阅集合与变更推送。
//
// 覆盖：上限/环境变量、URI 归一化、幂等订阅、LRU 淘汰、URI 级精确通知、单批上限、
// 通知失败隔离、断开清理、只读统计与通知消息形状。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_UPDATED_NOTIFICATION,
  SUBSCRIPTION_ERRORS,
  SUBSCRIPTION_LIMITS,
  SubscriptionError,
  createSubscriptionRegistry,
  normalizeSubscriptionUri,
  resolveSubscriptionLimits,
  subscriptionDisabled,
  updatedNotification,
} from '../../mcp/subscriptions.mjs';

function limits(overrides = {}) {
  return { enabled: true, maxSubscriptions: 2, maxUriLength: 64, maxNotificationsPerUpdate: 2, ...overrides };
}

function harness(overrides = {}) {
  const messages = [];
  const clock = { value: 1_000 };
  const registry = createSubscriptionRegistry({
    limits: limits(),
    now: () => clock.value,
    notify: (message) => messages.push(message),
    ...overrides,
  });
  return { registry, messages, clock };
}

test('环境变量：默认上限、只能收紧、off 关闭', () => {
  const defaults = resolveSubscriptionLimits({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.maxSubscriptions, SUBSCRIPTION_LIMITS.maxSubscriptions);
  assert.equal(defaults.maxNotificationsPerUpdate, SUBSCRIPTION_LIMITS.maxNotificationsPerUpdate);
  assert.equal(defaults.maxUriLength, SUBSCRIPTION_LIMITS.maxUriLength);

  const tightened = resolveSubscriptionLimits({
    BB_MCP_SUBSCRIPTIONS_MAX: '8',
    BB_MCP_SUBSCRIPTIONS_BATCH: '4',
  });
  assert.equal(tightened.maxSubscriptions, 8);
  assert.equal(tightened.maxNotificationsPerUpdate, 4);

  const inflated = resolveSubscriptionLimits({ BB_MCP_SUBSCRIPTIONS_MAX: '999999', BB_MCP_SUBSCRIPTIONS_BATCH: '999999' });
  assert.equal(inflated.maxSubscriptions, SUBSCRIPTION_LIMITS.maxSubscriptions, '上限只能收紧不能放大');
  assert.equal(inflated.maxNotificationsPerUpdate, SUBSCRIPTION_LIMITS.maxNotificationsPerUpdate);

  const invalid = resolveSubscriptionLimits({ BB_MCP_SUBSCRIPTIONS_MAX: '-1', BB_MCP_SUBSCRIPTIONS_BATCH: 'abc' });
  assert.equal(invalid.maxSubscriptions, SUBSCRIPTION_LIMITS.maxSubscriptions);
  assert.equal(invalid.maxNotificationsPerUpdate, SUBSCRIPTION_LIMITS.maxNotificationsPerUpdate);

  assert.equal(subscriptionDisabled({ BB_MCP_SUBSCRIPTIONS: 'off' }), true);
  assert.equal(subscriptionDisabled({ BB_MCP_SUBSCRIPTIONS: '0' }), true);
  assert.equal(subscriptionDisabled({}), false);
  assert.equal(resolveSubscriptionLimits({ BB_MCP_SUBSCRIPTIONS: 'off' }).enabled, false);
});

test('URI 归一化：去空白、拒绝空/非字符串/超长/控制字符', () => {
  assert.equal(normalizeSubscriptionUri('  bridge://observation/latest ', limits()), 'bridge://observation/latest');
  assert.throws(() => normalizeSubscriptionUri(42, limits()), (error) => {
    assert.ok(error instanceof SubscriptionError);
    assert.equal(error.code, SUBSCRIPTION_ERRORS.BAD_URI);
    return true;
  });
  assert.throws(() => normalizeSubscriptionUri('   ', limits()), (error) => error.code === SUBSCRIPTION_ERRORS.BAD_URI);
  assert.throws(() => normalizeSubscriptionUri('bridge://x/' + 'a'.repeat(80), limits()), (error) => /上限/.test(error.message));
  assert.throws(() => normalizeSubscriptionUri('bridge://x/\nnext', limits()), (error) => /控制字符/.test(error.message));
});

test('订阅：幂等、计数、订阅时间与只读列表', () => {
  const { registry, clock } = harness();
  const first = registry.subscribe('bridge://observation/latest');
  assert.equal(first.added, true);
  assert.equal(first.enabled, true);
  assert.equal(first.count, 1);
  assert.equal(first.max, 2);
  assert.equal(first.evicted, null);
  assert.equal(registry.has('bridge://observation/latest'), true);
  assert.equal(registry.size(), 1);
  assert.equal(registry.has(42), false, '非法 URI 查询返回 false 而不是抛错');

  clock.value += 500;
  const duplicate = registry.subscribe('bridge://observation/latest');
  assert.equal(duplicate.added, false, '重复订阅不重复计数');
  assert.equal(duplicate.subscribedAt, first.subscribedAt, '重复订阅不重置订阅时间');
  assert.equal(registry.stats().counters.duplicateSubscribes, 1);

  clock.value += 500;
  registry.subscribe('bridge://debug/journal/latest');
  const rows = registry.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uri, 'bridge://observation/latest');
  assert.equal(rows[0].ageMs, 1_000);
  assert.equal(rows[1].subscribedAt, new Date(2_000).toISOString());
  assert.equal(rows[0].notifications, 0);
  assert.equal(rows[0].lastNotifiedAt, null);
});

test('订阅有界：达到上限淘汰最早订阅的一条并如实报告', () => {
  const { registry } = harness();
  registry.subscribe('bridge://observation/s1');
  registry.subscribe('bridge://observation/s2');
  const third = registry.subscribe('bridge://observation/s3');
  assert.equal(third.added, true);
  assert.equal(third.evicted, 'bridge://observation/s1');
  assert.equal(third.count, 2);
  assert.equal(registry.has('bridge://observation/s1'), false);
  assert.equal(registry.has('bridge://observation/s3'), true);
  assert.equal(registry.stats().counters.evicted, 1);
  assert.deepEqual(registry.list().map((row) => row.uri), ['bridge://observation/s2', 'bridge://observation/s3']);
});

test('订阅关闭时：订阅/推送都是 no-op，但返回结构可判断', () => {
  const messages = [];
  const registry = createSubscriptionRegistry({
    limits: limits({ enabled: false }),
    notify: (message) => messages.push(message),
  });
  const report = registry.subscribe('bridge://observation/latest');
  assert.equal(report.added, false);
  assert.equal(report.enabled, false);
  assert.equal(report.evicted, null);
  assert.equal(registry.size(), 0);
  const push = registry.notifyUpdated(['bridge://observation/latest'], { kind: 'observation' });
  assert.equal(push.enabled, false);
  assert.equal(push.updated, 0);
  assert.deepEqual(messages, []);
});

test('推送：只通知已订阅 URI，重复 URI 去重，未订阅计入 skipped', () => {
  const { registry, messages, clock } = harness();
  registry.subscribe('bridge://observation/latest');
  clock.value += 10;
  const report = registry.notifyUpdated([
    'bridge://observation/latest',
    'bridge://observation/latest',
    'bridge://debug/journal/latest',
  ], { kind: 'observation', key: 's1', action: 'record', tool: 'browser_observe' });
  assert.equal(report.enabled, true);
  assert.equal(report.updated, 1);
  assert.deepEqual(report.uris, ['bridge://observation/latest']);
  assert.equal(report.skipped, 1, '未订阅 URI 跳过；重复 URI 去重但不计为 skipped');
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.jsonrpc, '2.0');
  assert.equal(message.method, RESOURCE_UPDATED_NOTIFICATION);
  assert.equal(message.params.uri, 'bridge://observation/latest');
  assert.equal(message.params._meta['browser-bridge/resource-update'].kind, 'observation');
  assert.equal(message.params._meta['browser-bridge/resource-update'].key, 's1');
  assert.equal(message.params._meta['browser-bridge/resource-update'].tool, 'browser_observe');
  assert.equal(message.params._meta['browser-bridge/resource-update'].sequence, 1);
  assert.match(String(message.params._meta['browser-bridge/resource-update'].at), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(registry.stats().counters.updates, 1);
  assert.equal(registry.stats().counters.notifications, 1);
  assert.equal(registry.stats().counters.skippedUnsubscribed, 1);
  const entry = registry.list()[0];
  assert.equal(entry.notifications, 1);
  assert.equal(entry.lastNotifiedAt, new Date(1_010).toISOString());
});

test('推送单批上限：超过 maxNotificationsPerUpdate 的订阅不通知并计数 capped', () => {
  const messages = [];
  const registry = createSubscriptionRegistry({
    limits: limits({ maxSubscriptions: 8, maxNotificationsPerUpdate: 2 }),
    notify: (message) => messages.push(message),
  });
  const uris = ['bridge://observation/s1', 'bridge://observation/s2', 'bridge://observation/s3'];
  for (const uri of uris) registry.subscribe(uri);
  const report = registry.notifyUpdated(uris, { action: 'record' });
  assert.equal(report.updated, 2);
  assert.equal(report.capped, 1);
  assert.equal(messages.length, 2);
  assert.equal(registry.stats().counters.capped, 1);
});

test('通知失败隔离：notify 抛错只记计数，不中断其他订阅者', () => {
  const delivered = [];
  let calls = 0;
  const registry = createSubscriptionRegistry({
    limits: limits({ maxNotificationsPerUpdate: 3 }),
    log: () => {},
    notify: (message) => {
      calls += 1;
      if (calls === 1) throw new Error('stdout 已关闭');
      delivered.push(message.params.uri);
    },
  });
  registry.subscribe('bridge://observation/s1');
  registry.subscribe('bridge://observation/s2');
  const report = registry.notifyUpdated(['bridge://observation/s1', 'bridge://observation/s2'], { action: 'record' });
  assert.equal(report.updated, 1);
  assert.deepEqual(delivered, ['bridge://observation/s2']);
  const stats = registry.stats();
  assert.equal(stats.counters.failed, 1);
  assert.equal(stats.counters.notifications, 1);
  assert.match(String(stats.lastError), /stdout/);
  assert.equal(registry.list()[0].notifications, 0, '失败不记为已通知');
});

test('取消订阅幂等；未订阅过返回 found=false 但仍是成功语义', () => {
  const { registry } = harness();
  registry.subscribe('bridge://observation/latest');
  const removed = registry.unsubscribe('bridge://observation/latest');
  assert.equal(removed.found, true);
  assert.equal(removed.count, 0);
  assert.equal(registry.has('bridge://observation/latest'), false);
  const again = registry.unsubscribe('bridge://observation/latest');
  assert.equal(again.found, false);
  assert.equal(again.count, 0);
  const missing = registry.unsubscribe('bridge://debug/journal/latest');
  assert.equal(missing.found, false);
});

test('断开清理：clear 清空全部订阅并记录原因；之后推送不再发', () => {
  const { registry, messages } = harness();
  registry.subscribe('bridge://observation/latest');
  registry.subscribe('bridge://debug/evidence/latest');
  const cleared = registry.clear('client-disconnect');
  assert.equal(cleared.cleared, 2);
  assert.equal(cleared.count, 0);
  assert.equal(registry.size(), 0);
  const stats = registry.stats();
  assert.equal(stats.counters.cleared, 2);
  assert.equal(stats.lastClear.reason, 'client-disconnect');
  assert.equal(stats.active, 0);
  const report = registry.notifyUpdated(['bridge://observation/latest'], {});
  assert.equal(report.updated, 0);
  assert.deepEqual(messages, []);
  assert.equal(registry.clear('again').cleared, 0, '重复清理幂等');
});

test('updatedNotification 纯函数：只带白名单元数据，序列号合法才带', () => {
  const message = updatedNotification('bridge://x', {
    kind: 'journal',
    key: 's1',
    action: 'record',
    tool: 'browser_debug_journal',
    at: '2026-01-01T00:00:00.000Z',
    sequence: 7,
    extra: 'ignored',
  });
  assert.deepEqual(Object.keys(message).sort(), ['jsonrpc', 'method', 'params']);
  const meta = message.params._meta['browser-bridge/resource-update'];
  assert.deepEqual(Object.keys(meta).sort(), ['action', 'at', 'key', 'kind', 'sequence', 'tool']);
  const sparse = updatedNotification('bridge://x', { sequence: -1, kind: 42 });
  assert.equal(sparse.params._meta['browser-bridge/resource-update'].sequence, undefined);
  assert.equal(sparse.params._meta['browser-bridge/resource-update'].kind, undefined);
  assert.equal(updatedNotification('bridge://x').params.uri, 'bridge://x');
});

test('stats/limits 只读快照与通知方法名单一来源', () => {
  const { registry } = harness();
  registry.subscribe('bridge://observation/latest');
  const stats = registry.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.active, 1);
  assert.equal(stats.notification, RESOURCE_UPDATED_NOTIFICATION);
  assert.equal(stats.limits.maxSubscriptions, 2);
  assert.equal(registry.notification, RESOURCE_UPDATED_NOTIFICATION);
  assert.equal(Object.isFrozen(stats), true);
  assert.equal(Object.isFrozen(registry.limits), true);
});
