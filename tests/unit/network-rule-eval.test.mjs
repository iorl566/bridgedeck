// tests/unit/network-rule-eval.test.mjs —— declarativeNetRequest 匹配语义离线评估器。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileUrlFilter,
  conditionFromRule,
  evaluateBatch,
  evaluateRules,
  preflightRules,
  ruleMatches,
  toDnrRule,
  validateRule,
} from '../../extension/src/lib/network-rule-eval.js';

function request(url, extra = {}) {
  return { url, method: 'GET', type: 'xmlhttprequest', ...extra };
}

test('urlFilter 语法：子串 / | 起止锚 / || 域名锚 / * 通配 / ^ 分隔符', () => {
  const substring = compileUrlFilter('/api/');
  assert.equal(substring.regexp.test('https://a.test/x/api/1'), true);
  assert.equal(substring.regexp.test('https://a.test/API/1'), true); // 默认大小写不敏感

  const start = compileUrlFilter('|https://a.test');
  assert.equal(start.regexp.test('https://a.test/x'), true);
  assert.equal(start.regexp.test('https://b.test/?u=https://a.test'), false);

  const domain = compileUrlFilter('||example.com/path');
  assert.equal(domain.regexp.test('https://example.com/path/x'), true);
  assert.equal(domain.regexp.test('https://sub.example.com/path'), true);
  assert.equal(domain.regexp.test('https://notexample.com/path'), false);
  assert.equal(domain.regexp.test('http://example.com/other'), false);

  const wildcard = compileUrlFilter('*/ads/*');
  assert.equal(wildcard.regexp.test('https://a.test/ads/banner.png'), true);
  assert.equal(wildcard.regexp.test('https://a.test/content/ads/'), true);

  const separator = compileUrlFilter('/api^');
  assert.equal(separator.regexp.test('https://a.test/api/1'), true);
  assert.equal(separator.regexp.test('https://a.test/api?x=1'), true);
  assert.equal(separator.regexp.test('https://a.test/apix'), false);

  const end = compileUrlFilter('sw.js|');
  assert.equal(end.regexp.test('https://a.test/sw.js'), true);
  assert.equal(end.regexp.test('https://a.test/sw.js?v=1'), false);

  const caseSensitive = compileUrlFilter('/API/', { caseSensitive: true });
  assert.equal(caseSensitive.regexp.test('https://a.test/api/'), false);
  assert.equal(compileUrlFilter('').ok, false);
});

test('validateRule：action/条件/优先级/redirect 结构校验', () => {
  assert.equal(validateRule({ action: 'explode', urlFilter: '*' }).ok, false);
  assert.equal(validateRule({ action: 'block' }).ok, true); // 缺 urlFilter 只是 warning
  assert.equal(validateRule({ action: 'block' }).warnings.length, 1);
  assert.equal(validateRule({ action: 'block', urlFilter: '/x', regexFilter: 'x' }).ok, false);
  assert.equal(validateRule({ action: 'block', urlFilter: '/x', condition: { resourceTypes: ['nope'] } }).ok, false);
  assert.equal(validateRule({ action: 'block', urlFilter: '/x', condition: { requestMethods: ['fire'] } }).ok, false);
  assert.equal(validateRule({ action: 'block', urlFilter: '/x', priority: 0 }).ok, false);
  assert.equal(validateRule({ action: 'redirect', urlFilter: '/x' }).ok, false);
  assert.equal(validateRule({ action: 'redirect', urlFilter: '/x', redirect: { url: 'ftp://x' } }).ok, false);
  assert.equal(validateRule({ action: 'redirect', urlFilter: '/x', redirect: { url: 'https://b.test/y' } }).ok, true);
  const normalized = validateRule({ id: 3, action: 'block', urlFilter: '/x', priority: 5, condition: { resourceTypes: ['script'] } });
  assert.equal(normalized.rule.priority, 5);
  assert.deepEqual(normalized.rule.condition.resourceTypes, ['script']);
});

test('ruleMatches：resourceTypes / requestMethods / tabIds / 域名条件', () => {
  const blockScripts = validateRule({ action: 'block', urlFilter: '/app', condition: { resourceTypes: ['script'] } }).rule;
  assert.equal(ruleMatches(blockScripts, request('https://a/app.js', { type: 'script' })).matched, true);
  assert.equal(ruleMatches(blockScripts, request('https://a/app.js', { type: 'image' })).reason, 'resource-type');

  const postOnly = validateRule({ action: 'block', urlFilter: '/api', condition: { requestMethods: ['post'] } }).rule;
  assert.equal(ruleMatches(postOnly, request('https://a/api', { method: 'POST' })).matched, true);
  assert.equal(ruleMatches(postOnly, request('https://a/api', { method: 'GET' })).reason, 'request-method');

  const tabOnly = validateRule({ action: 'block', urlFilter: '/x', condition: { tabIds: [4] } }).rule;
  assert.equal(ruleMatches(tabOnly, request('https://a/x', { tabId: 4 })).matched, true);
  assert.equal(ruleMatches(tabOnly, request('https://a/x', { tabId: 5 })).reason, 'tab-id');

  const initiator = validateRule({
    action: 'block',
    urlFilter: '/cdn',
    condition: { initiatorDomains: ['a.test'] },
  }).rule;
  assert.equal(ruleMatches(initiator, request('https://cdn.test/x/cdn', { initiator: 'https://a.test/' })).matched, true);
  assert.equal(ruleMatches(initiator, request('https://cdn.test/x/cdn', { initiator: 'https://b.test/' })).reason, 'initiator-domain');

  const thirdParty = validateRule({ action: 'block', urlFilter: '/x', condition: { domainType: 'thirdParty' } }).rule;
  assert.equal(ruleMatches(thirdParty, request('https://b.test/x', { initiator: 'https://a.test/' })).matched, true);
  assert.equal(ruleMatches(thirdParty, request('https://a.test/x', { initiator: 'https://a.test/' })).reason, 'domain-type');
});

test('evaluateRules：高优先级胜出、同优先级小 id 胜出、allow 压抑 block/redirect', () => {
  const rules = [
    { id: 10, priority: 2, action: 'block', condition: { urlFilter: '/api' } },
    { id: 4, priority: 5, action: 'block', condition: { urlFilter: '/api/v2' } },
    { id: 11, priority: 2, action: 'block', condition: { urlFilter: '/api' } },
  ];
  const verdict = evaluateRules(rules, request('https://a.test/api/v2/users'));
  assert.equal(verdict.matches.length, 3);
  assert.equal(verdict.decision.blocked, true);
  assert.equal(verdict.winner.ruleId, 4);

  const tied = evaluateRules([
    { id: 7, priority: 3, action: 'block', condition: { urlFilter: '/api' } },
    { id: 3, priority: 3, action: 'block', condition: { urlFilter: '/api' } },
  ], request('https://a.test/api'));
  assert.equal(tied.winner.ruleId, 3);

  const allowed = evaluateRules([
    { id: 1, priority: 1, action: 'allow', condition: { urlFilter: '/api' } },
    { id: 2, priority: 1, action: 'block', condition: { urlFilter: '/api' } },
  ], request('https://a.test/api'));
  assert.equal(allowed.decision.allowed, true);
  assert.equal(allowed.decision.blocked, false);
  assert.equal(allowed.decision.reason, 'allow-overrides');

  const redirected = evaluateRules([
    { id: 1, priority: 1, action: 'redirect', redirect: { url: 'https://b.test/new' }, condition: { urlFilter: '/old' } },
    { id: 2, priority: 1, action: 'block', condition: { urlFilter: '/old' } },
  ], request('https://a.test/old'));
  assert.equal(redirected.decision.redirected, true);
  assert.equal(redirected.decision.blocked, false);
  assert.equal(redirected.decision.redirectUrl, 'https://b.test/new');

  const upgrade = evaluateRules([
    { id: 1, priority: 1, action: 'upgradeScheme', upgradeScheme: { scheme: 'https' }, condition: { urlFilter: '/x' } },
  ], request('http://a.test/x'));
  assert.equal(upgrade.decision.redirectUrl, 'https://a.test/x');

  const noMatch = evaluateRules(rules, request('https://a.test/other'));
  assert.equal(noMatch.decision.allowed, true);
  assert.equal(noMatch.decision.reason, 'no-match');
  assert.equal(noMatch.matches.length, 0);
});

test('evaluateRules：modifyHeaders 返回修改但被 block 压抑', () => {
  const modify = {
    id: 1, priority: 1, action: 'modifyHeaders',
    headers: [{ header: 'x-test', operation: 'set', value: '1' }],
    condition: { urlFilter: '/api' },
  };
  const onlyModify = evaluateRules([modify], request('https://a.test/api'));
  assert.equal(onlyModify.decision.reason, 'modify-headers');
  assert.deepEqual(onlyModify.decision.modifiedHeaders, [{ header: 'x-test', operation: 'set', value: '1' }]);
  const blocked = evaluateRules([
    modify,
    { id: 2, priority: 3, action: 'block', condition: { urlFilter: '/api' } },
  ], request('https://a.test/api'));
  assert.equal(blocked.decision.blocked, true);
  assert.equal(blocked.decision.modifiedHeaders, undefined);
});

test('preflightRules：非法规则/动作冲突/重复规则/已生效冲突', () => {
  const report = preflightRules([
    { id: 1, priority: 1, action: 'block', condition: { urlFilter: '/a' } },
    { id: 2, priority: 1, action: 'redirect', redirect: { url: 'https://b/x' }, condition: { urlFilter: '/a' } },
    { id: 3, priority: 1, action: 'block', condition: { urlFilter: '/a' } },
    { id: 4, action: 'block', condition: { urlFilter: '/b', resourceTypes: ['nope'] } },
  ], {
    existing: [{ id: 99, priority: 2, action: 'block', condition: { urlFilter: '/c' } }],
  });
  assert.equal(report.ok, false);
  assert.equal(report.counts.rules, 4);
  assert.equal(report.counts.invalid, 1);
  assert.equal(report.errors.length, 1);
  const kinds = report.conflicts.map((conflict) => conflict.kind);
  assert.equal(kinds.includes('action-conflict'), true);
  assert.equal(kinds.includes('duplicate'), true);

  const existingConflict = preflightRules([
    { id: 5, priority: 1, action: 'redirect', redirect: { url: 'https://b/x' }, condition: { urlFilter: '/c' } },
  ], { existing: [{ id: 99, priority: 2, action: 'block', condition: { urlFilter: '/c' } }] });
  assert.equal(existingConflict.conflicts.some((conflict) => conflict.kind === 'existing-conflict'), true);

  const samples = preflightRules([
    { id: 1, priority: 1, action: 'block', condition: { urlFilter: '/api' } },
  ], { requests: [request('https://a.test/api'), request('https://a.test/other')] });
  assert.equal(samples.samples.length, 2);
  assert.equal(samples.samples[0].decision.blocked, true);
  assert.equal(samples.samples[1].decision.blocked, false);
});

test('evaluateBatch：逐规则命中计数与裁决汇总', () => {
  const rules = [
    { id: 1, priority: 1, action: 'block', condition: { urlFilter: '/api' } },
    { id: 2, priority: 1, action: 'block', condition: { urlFilter: '/img' } },
  ];
  const batch = evaluateBatch(rules, [
    request('https://a.test/api'),
    request('https://a.test/api/2'),
    request('https://a.test/img'),
    request('https://a.test/other'),
  ]);
  assert.equal(batch.rules, 2);
  assert.equal(batch.requests, 4);
  assert.equal(batch.perRule[0].matches, 2);
  assert.equal(batch.perRule[1].matches, 1);
  assert.equal(batch.blocked, 3);
  assert.equal(batch.allowed, 1);
});

test('conditionFromRule / toDnrRule：内部规则 → DNR condition 单源', () => {
  const condition = conditionFromRule({
    urlPattern: '*/api/*',
    resourceTypes: ['xmlhttprequest'],
    requestMethods: ['POST'],
    priority: 4,
  }, { tabId: 12 });
  assert.equal(condition.urlFilter, '*/api/*');
  assert.equal(condition.isUrlFilterCaseSensitive, false);
  assert.deepEqual(condition.resourceTypes, ['xmlhttprequest']);
  assert.deepEqual(condition.requestMethods, ['post']);
  assert.deepEqual(condition.tabIds, [12]);

  const converted = toDnrRule({
    id: 8,
    priority: 2,
    action: 'redirect',
    redirect: { url: 'https://b.test/x' },
    urlFilter: '*/old/*',
  }, { tabId: 3 });
  assert.equal(converted.ok, true);
  assert.equal(converted.rule.priority, 2);
  assert.deepEqual(converted.rule.action, { type: 'redirect', redirect: { url: 'https://b.test/x' } });
  assert.deepEqual(converted.rule.condition.tabIds, [3]);
  const invalid = toDnrRule({ action: 'nope', urlFilter: '/x' });
  assert.equal(invalid.ok, false);

  // evaluateRules 可直接消费 validateRule 的规范化规则（预检与真实下发同构）
  const rule = validateRule({ id: 1, action: 'block', urlFilter: '||ads.test^' }).rule;
  assert.equal(ruleMatches(rule, request('https://ads.test/banner')).matched, true);
  assert.equal(ruleMatches(rule, request('https://sub.ads.test/banner')).matched, true);
  assert.equal(ruleMatches(rule, request('https://content.test/ads.test/banner')).matched, false);
});
