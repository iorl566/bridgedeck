// src/lib/network-rule-eval.js —— declarativeNetRequest 匹配语义的离线评估器（预检用）。
//
// 背景：扩展把规则同时下发给 DNR（block/redirect）、CDP Fetch（fulfill/modify）和页面内
// fetch/XHR 包裹。三条路径的"哪条规则会命中"语义并不完全一致，出错只能在真实请求上
// 才暴露。这里实现一份与 Chrome DNR 文档同构的离线评估器：
//
//   urlFilter 语法：'|' 开头锚定 URL 起点、'||' 锚定域名、结尾 '|' 锚定 URL 末尾、
//                   '*' 任意串、'^' 分隔符（字母/数字/_ - . % 之外或 URL 末尾）；
//                   默认大小写不敏感。
//   condition：urlFilter/regexFilter、resourceTypes/excludedResourceTypes、
//              requestMethods/excludedRequestMethods、domainType(firstParty/thirdParty)、
//              initiatorDomains/excludedInitiatorDomains、requestDomains/excludedRequestDomains、
//              tabIds/excludedTabIds。
//   优先级：高 priority 优先；同 priority 时 rule id 小的优先。
//   动作裁决：allow/allowAllRequests 命中后压抑 block/redirect（模型近似 Chrome：allow 优先）；
//             redirect 命中后压抑 block；modifyHeaders 独立返回，但 blocked/redirected 时不生效。
//
// 消费点：extension/src/rules.js —— rule_add/rule_import 返回 preflight（离线预检测试），
// syncDnrRules 用 conditionFromRule 统一构造 DNR condition。

export const DNR_RULE_ACTIONS = Object.freeze(['block', 'redirect', 'allow', 'allowAllRequests', 'modifyHeaders', 'upgradeScheme']);

export const DNR_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
]);

export const DNR_REQUEST_METHODS = Object.freeze(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

const DOMAIN_TYPES = new Set(['firstParty', 'thirdParty']);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeDomainList(list) {
  return asArray(list).map((item) => String(item || '').trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}

function hostOf(value) {
  const text = String(value || '');
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/i.exec(text);
    return match ? String(match[1]).toLowerCase().replace(/^\./, '') : '';
  }
}

function domainMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

function escapeRegExpCharacter(character) {
  return /[.*+?^${}()|[\]\\]/.test(character) ? '\\' + character : character;
}

/**
 * 把 DNR urlFilter 编译成正则。
 * 返回 {ok, regexp, source, error}；语法错误不抛异常，交给 preflight 报错。
 */
export function compileUrlFilter(urlFilter, { caseSensitive = false } = {}) {
  const source = String(urlFilter == null ? '' : urlFilter);
  if (!source) return { ok: false, regexp: null, source, error: 'urlFilter 为空' };
  let rest = source;
  let pattern = '';
  let anchoredStart = false;
  if (rest.startsWith('||')) {
    rest = rest.slice(2);
    pattern += '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#@]*@)?(?:[^\\/?#]*\\.)?';
    anchoredStart = true;
  } else if (rest.startsWith('|')) {
    rest = rest.slice(1);
    pattern += '^';
    anchoredStart = true;
  }
  let anchoredEnd = false;
  if (rest.endsWith('|')) {
    rest = rest.slice(0, -1);
    anchoredEnd = true;
  }
  for (const character of rest) {
    if (character === '*') pattern += '.*';
    else if (character === '^') pattern += '(?:[^a-z0-9_.%-]|$)';
    else pattern += escapeRegExpCharacter(character);
  }
  if (!anchoredStart) pattern = '.*' + pattern;
  if (anchoredEnd) pattern += '$';
  try {
    const regexp = new RegExp(pattern, caseSensitive ? '' : 'i');
    return { ok: true, regexp, source, pattern };
  } catch (error) {
    return { ok: false, regexp: null, source, error: String((error && error.message) || error) };
  }
}

/** 校验/规范化一条规则；返回 {ok, rule, errors, warnings}。 */
export function validateRule(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, rule: null, errors: ['rule 必须是对象'], warnings };
  }
  const action = String(raw.action && raw.action.type ? raw.action.type : raw.action || '').trim();
  if (!DNR_RULE_ACTIONS.includes(action)) errors.push('action 必须是 ' + DNR_RULE_ACTIONS.join('/'));
  const condition = raw.condition && typeof raw.condition === 'object' ? raw.condition : {};
  const urlFilter = condition.urlFilter ?? raw.urlFilter;
  const regexFilter = condition.regexFilter ?? raw.regexFilter;
  if (urlFilter != null && regexFilter != null) errors.push('urlFilter 与 regexFilter 不能同时设置');
  if (urlFilter == null && regexFilter == null) warnings.push('没有 urlFilter/regexFilter：规则会匹配所有请求');
  if (urlFilter != null) {
    const compiled = compileUrlFilter(urlFilter, { caseSensitive: condition.isUrlFilterCaseSensitive === true });
    if (!compiled.ok) errors.push('urlFilter 非法：' + compiled.error);
  }
  let regexp = null;
  if (regexFilter != null) {
    try {
      regexp = new RegExp(String(regexFilter), condition.isUrlFilterCaseSensitive === true ? '' : 'i');
    } catch (error) {
      errors.push('regexFilter 非法：' + String((error && error.message) || error));
    }
  }
  const resourceTypes = asArray(condition.resourceTypes).map((type) => String(type));
  const excludedResourceTypes = asArray(condition.excludedResourceTypes).map((type) => String(type));
  for (const type of [...resourceTypes, ...excludedResourceTypes]) {
    if (!DNR_RESOURCE_TYPES.includes(type)) errors.push('未知 resourceType：' + type);
  }
  const requestMethods = asArray(condition.requestMethods).map((method) => String(method).toLowerCase());
  const excludedRequestMethods = asArray(condition.excludedRequestMethods).map((method) => String(method).toLowerCase());
  for (const method of [...requestMethods, ...excludedRequestMethods]) {
    if (!DNR_REQUEST_METHODS.includes(method)) errors.push('未知 requestMethod：' + method);
  }
  const domainType = condition.domainType == null ? null : String(condition.domainType);
  if (domainType != null && !DOMAIN_TYPES.has(domainType)) errors.push('domainType 只能是 firstParty/thirdParty');
  const priority = raw.priority == null ? (condition.priority == null ? 1 : Number(condition.priority)) : Number(raw.priority);
  if (!Number.isInteger(priority) || priority < 1) errors.push('priority 必须是 >=1 的整数');
  const id = raw.id == null ? null : Number(raw.id);
  if (id != null && (!Number.isInteger(id) || id < 1)) errors.push('id 必须是正整数');
  let redirect = null;
  if (action === 'redirect') {
    const target = raw.action && raw.action.redirect ? raw.action.redirect : raw.redirect;
    if (!target || !(target.url || target.extensionPath || target.transform)) {
      errors.push('redirect action 缺少 redirect.url/extensionPath/transform');
    } else if (target.url != null && !/^https?:\/\//i.test(String(target.url))) {
      errors.push('redirect.url 必须是 http(s) URL');
    } else {
      redirect = { ...target };
    }
  }
  if (action === 'upgradeScheme') {
    const target = raw.action && raw.action.upgradeScheme ? raw.action.upgradeScheme : raw.upgradeScheme;
    if (!target || !['http', 'https'].includes(String(target.scheme))) errors.push('upgradeScheme.scheme 只能是 http/https');
  }
  const rule = {
    id,
    priority: Number.isInteger(priority) ? priority : 1,
    action,
    condition: {
      ...(urlFilter != null ? { urlFilter: String(urlFilter), isUrlFilterCaseSensitive: condition.isUrlFilterCaseSensitive === true } : {}),
      ...(regexFilter != null ? { regexFilter: String(regexFilter), ...(regexp ? { _regexp: regexp } : {}) } : {}),
      resourceTypes,
      excludedResourceTypes,
      requestMethods,
      excludedRequestMethods,
      ...(domainType ? { domainType } : {}),
      initiatorDomains: normalizeDomainList(condition.initiatorDomains),
      excludedInitiatorDomains: normalizeDomainList(condition.excludedInitiatorDomains),
      requestDomains: normalizeDomainList(condition.requestDomains),
      excludedRequestDomains: normalizeDomainList(condition.excludedRequestDomains),
      tabIds: asArray(condition.tabIds).map(Number).filter((value) => Number.isInteger(value)),
      excludedTabIds: asArray(condition.excludedTabIds).map(Number).filter((value) => Number.isInteger(value)),
    },
    ...(redirect ? { redirect } : {}),
    ...(action === 'upgradeScheme' ? { upgradeScheme: raw.action && raw.action.upgradeScheme ? { ...raw.action.upgradeScheme } : { ...(raw.upgradeScheme || {}) } } : {}),
    ...(raw.headers ? { headers: raw.headers } : {}),
  };
  return { ok: errors.length === 0, rule, errors, warnings };
}

function typeOfRequest(request) {
  return String(request.type || request.resourceType || 'other');
}

function matchesCondition(condition, request) {
  const url = String(request.url || '');
  const type = typeOfRequest(request);
  if (condition.resourceTypes.length && !condition.resourceTypes.includes(type)) return { matched: false, reason: 'resource-type' };
  if (condition.excludedResourceTypes.includes(type)) return { matched: false, reason: 'excluded-resource-type' };
  const method = String(request.method || 'GET').toLowerCase();
  if (condition.requestMethods.length && !condition.requestMethods.includes(method)) return { matched: false, reason: 'request-method' };
  if (condition.excludedRequestMethods.includes(method)) return { matched: false, reason: 'excluded-request-method' };
  const tabId = request.tabId == null ? null : Number(request.tabId);
  if (condition.tabIds.length && (tabId == null || !condition.tabIds.includes(tabId))) return { matched: false, reason: 'tab-id' };
  if (tabId != null && condition.excludedTabIds.includes(tabId)) return { matched: false, reason: 'excluded-tab-id' };
  const requestHost = hostOf(url);
  if (condition.requestDomains.length && !condition.requestDomains.some((domain) => domainMatches(requestHost, domain))) {
    return { matched: false, reason: 'request-domain' };
  }
  if (condition.excludedRequestDomains.some((domain) => domainMatches(requestHost, domain))) {
    return { matched: false, reason: 'excluded-request-domain' };
  }
  const initiatorUrl = String(request.initiator || request.documentUrl || request.initiatorUrl || '');
  const initiatorHost = hostOf(initiatorUrl);
  if (condition.initiatorDomains.length && !condition.initiatorDomains.some((domain) => domainMatches(initiatorHost, domain))) {
    return { matched: false, reason: 'initiator-domain' };
  }
  if (condition.excludedInitiatorDomains.some((domain) => domainMatches(initiatorHost, domain))) {
    return { matched: false, reason: 'excluded-initiator-domain' };
  }
  if (condition.domainType) {
    const thirdParty = Boolean(initiatorHost && requestHost && initiatorHost !== requestHost && !requestHost.endsWith('.' + initiatorHost) && !initiatorHost.endsWith('.' + requestHost));
    if (condition.domainType === 'thirdParty' && !thirdParty) return { matched: false, reason: 'domain-type' };
    if (condition.domainType === 'firstParty' && thirdParty) return { matched: false, reason: 'domain-type' };
  }
  if (condition.urlFilter != null) {
    const compiled = compileUrlFilter(condition.urlFilter, { caseSensitive: condition.isUrlFilterCaseSensitive === true });
    if (!compiled.ok || !compiled.regexp.test(url)) return { matched: false, reason: 'url-filter' };
  }
  if (condition.regexFilter != null) {
    let regexp = condition._regexp || null;
    if (!regexp) {
      try {
        regexp = new RegExp(condition.regexFilter, condition.isUrlFilterCaseSensitive === true ? '' : 'i');
      } catch {
        return { matched: false, reason: 'regex-filter' };
      }
    }
    if (!regexp.test(url)) return { matched: false, reason: 'regex-filter' };
  }
  return { matched: true, reason: 'matched' };
}

/** 给未规范化的 condition 补齐数组字段，避免直接消费裸规则时抛 TypeError。 */
function conditionWithDefaults(rawCondition) {
  const source = rawCondition && typeof rawCondition === 'object' ? rawCondition : {};
  return {
    ...source,
    resourceTypes: asArray(source.resourceTypes).map((type) => String(type)),
    excludedResourceTypes: asArray(source.excludedResourceTypes).map((type) => String(type)),
    requestMethods: asArray(source.requestMethods).map((method) => String(method).toLowerCase()),
    excludedRequestMethods: asArray(source.excludedRequestMethods).map((method) => String(method).toLowerCase()),
    initiatorDomains: normalizeDomainList(source.initiatorDomains),
    excludedInitiatorDomains: normalizeDomainList(source.excludedInitiatorDomains),
    requestDomains: normalizeDomainList(source.requestDomains),
    excludedRequestDomains: normalizeDomainList(source.excludedRequestDomains),
    tabIds: asArray(source.tabIds).map(Number).filter((value) => Number.isInteger(value)),
    excludedTabIds: asArray(source.excludedTabIds).map(Number).filter((value) => Number.isInteger(value)),
  };
}

/**
 * 单条规则是否命中请求。
 * 返回 {matched, reason, action, priority, ruleId}。
 */
export function ruleMatches(rule, request) {
  if (!rule || typeof rule !== 'object') return { matched: false, reason: 'bad-rule' };
  if (rule.enabled === false) return { matched: false, reason: 'disabled' };
  const rawCondition = rule.condition && typeof rule.condition === 'object' ? { ...rule.condition } : {};
  if (rawCondition.urlFilter == null && rule.urlFilter != null) rawCondition.urlFilter = rule.urlFilter;
  if (rawCondition.regexFilter == null && rule.regexFilter != null) rawCondition.regexFilter = rule.regexFilter;
  if (rawCondition.resourceTypes == null && rule.resourceTypes != null) rawCondition.resourceTypes = rule.resourceTypes;
  if (rawCondition.excludedResourceTypes == null && rule.excludedResourceTypes != null) rawCondition.excludedResourceTypes = rule.excludedResourceTypes;
  if (rawCondition.requestMethods == null && rule.requestMethods != null) rawCondition.requestMethods = rule.requestMethods;
  if (rawCondition.excludedRequestMethods == null && rule.excludedRequestMethods != null) rawCondition.excludedRequestMethods = rule.excludedRequestMethods;
  const verdict = matchesCondition(conditionWithDefaults(rawCondition), request || {});
  return {
    matched: verdict.matched,
    reason: verdict.reason,
    action: rule.action,
    priority: Number(rule.priority) || 1,
    ruleId: rule.id == null ? null : Number(rule.id),
  };
}

function compareRank(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return (a.ruleId == null ? Infinity : a.ruleId) - (b.ruleId == null ? Infinity : b.ruleId);
}

/**
 * 评估一组规则对一个请求的命中情况，并给出 DNR 风格裁决。
 * request: {url, method, type/resourceType, tabId, initiator/documentUrl}
 * 返回 {matches, winner, decision, errors}
 */
export function evaluateRules(rules, request) {
  const list = Array.isArray(rules) ? rules : [];
  const matches = [];
  let blockedRule = null;
  let redirectRule = null;
  let allowRule = null;
  let modifyRule = null;
  for (const rule of list) {
    const verdict = ruleMatches(rule, request);
    if (!verdict.matched) continue;
    matches.push(verdict);
    const category = verdict.action;
    if (category === 'block') {
      if (!blockedRule || compareRank(verdict, blockedRule) < 0) blockedRule = verdict;
    } else if (category === 'redirect' || category === 'upgradeScheme') {
      if (!redirectRule || compareRank(verdict, redirectRule) < 0) redirectRule = { ...verdict, rule };
    } else if (category === 'allow' || category === 'allowAllRequests') {
      if (!allowRule || compareRank(verdict, allowRule) < 0) allowRule = verdict;
    } else if (category === 'modifyHeaders') {
      if (!modifyRule || compareRank(verdict, modifyRule) < 0) modifyRule = { ...verdict, rule };
    }
  }
  let winner = null;
  let decision;
  if (allowRule && allowRule.priority >= 1) {
    winner = allowRule;
    decision = { allowed: true, blocked: false, redirected: false, reason: 'allow-overrides' };
  } else if (redirectRule) {
    winner = redirectRule;
    const rule = redirectRule.rule;
    const target = rule.redirect && rule.redirect.url ? String(rule.redirect.url) : '';
    const upgrade = rule.upgradeScheme && rule.upgradeScheme.scheme ? String(rule.upgradeScheme.scheme) : '';
    let redirectUrl = target;
    if (!redirectUrl && upgrade) {
      try {
        const parsed = new URL(String(request.url || ''));
        parsed.protocol = upgrade + ':';
        redirectUrl = parsed.toString();
      } catch {
        redirectUrl = '';
      }
    }
    decision = { allowed: false, blocked: false, redirected: true, redirectUrl, reason: 'redirect' };
  } else if (blockedRule) {
    winner = blockedRule;
    decision = { allowed: false, blocked: true, redirected: false, reason: 'blocked' };
  } else {
    winner = null;
    decision = { allowed: true, blocked: false, redirected: false, reason: modificationsFor(modifyRule) ? 'modify-headers' : 'no-match' };
  }
  if (modifyRule && !decision.blocked && !decision.redirected) {
    decision.modifiedHeaders = ruleHeaders(modifyRule.rule);
  }
  return {
    matches,
    winner,
    decision,
    errors: matches.length ? [] : [],
  };
}

function modificationsFor(rule) {
  return Boolean(rule && rule.rule && Array.isArray(rule.rule.headers) && rule.rule.headers.length);
}

function ruleHeaders(rule) {
  return Array.isArray(rule && rule.headers) ? rule.headers.map((header) => ({ ...header })) : [];
}

/**
 * 离线预检：校验 + 冲突/遮蔽检测 + 可选用样例请求试跑。
 * options: {existing: 已生效规则, requests: 样例请求[], tabId}
 */
export function preflightRules(rules, options = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const existing = Array.isArray(options.existing) ? options.existing : [];
  const requests = Array.isArray(options.requests) ? options.requests : [];
  const results = [];
  const errors = [];
  const warnings = [];
  const conflicts = [];
  const bySignature = new Map();
  for (const raw of list) {
    const validation = validateRule(raw);
    results.push({
      id: validation.rule ? validation.rule.id : null,
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      rule: validation.rule,
    });
    for (const message of validation.errors) errors.push({ id: raw && raw.id, message });
    for (const message of validation.warnings) warnings.push({ id: raw && raw.id, message });
    if (!validation.ok) continue;
    const signature = JSON.stringify([
      validation.rule.condition.urlFilter || validation.rule.condition.regexFilter || '*',
      validation.rule.condition.resourceTypes,
      validation.rule.condition.requestMethods,
      validation.rule.condition.domainType,
    ]);
    if (bySignature.has(signature)) {
      const previous = bySignature.get(signature);
      if (previous.action !== validation.rule.action) {
        conflicts.push({
          kind: 'action-conflict',
          message: '同一匹配条件出现不同动作',
          ids: [previous.id, validation.rule.id],
          actions: [previous.action, validation.rule.action],
        });
      } else if (previous.priority === validation.rule.priority) {
        conflicts.push({
          kind: 'duplicate',
          message: '同一条件的重复规则（同优先级，后一条永远不会命中）',
          ids: [previous.id, validation.rule.id],
        });
      } else if (previous.priority > validation.rule.priority) {
        warnings.push({ id: validation.rule.id, message: '被更高优先级规则遮蔽：#' + previous.id });
      }
    } else {
      bySignature.set(signature, validation.rule);
    }
    for (const other of existing) {
      const otherValidation = validateRule(other);
      if (!otherValidation.ok) continue;
      const otherSignature = JSON.stringify([
        otherValidation.rule.condition.urlFilter || otherValidation.rule.condition.regexFilter || '*',
        otherValidation.rule.condition.resourceTypes,
        otherValidation.rule.condition.requestMethods,
        otherValidation.rule.condition.domainType,
      ]);
      if (otherSignature === signature && otherValidation.rule.action !== validation.rule.action) {
        conflicts.push({
          kind: 'existing-conflict',
          message: '与已生效规则动作冲突',
          ids: [otherValidation.rule.id, validation.rule.id],
          actions: [otherValidation.rule.action, validation.rule.action],
        });
      }
    }
  }
  const samples = requests.length
    ? requests.map((request) => ({
      request,
      ...evaluateRules([...existing, ...results.filter((item) => item.ok).map((item) => item.rule)], request),
    }))
    : [];
  return {
    ok: errors.length === 0 && conflicts.every((conflict) => conflict.kind !== 'action-conflict'),
    results,
    errors,
    warnings,
    conflicts,
    samples,
    counts: {
      rules: list.length,
      valid: results.filter((item) => item.ok).length,
      invalid: results.filter((item) => !item.ok).length,
      warnings: warnings.length,
      conflicts: conflicts.length,
    },
  };
}

/** 批量评估：每条规则命中多少个样例请求。 */
export function evaluateBatch(rules, requests) {
  const list = Array.isArray(rules) ? rules : [];
  const samples = Array.isArray(requests) ? requests : [];
  const perRule = list.map((rule, index) => ({
    index,
    id: rule && rule.id != null ? rule.id : null,
    action: rule && rule.action,
    matches: samples.filter((request) => ruleMatches(rule, request).matched).length,
  }));
  const decisions = samples.map((request) => ({ request, ...evaluateRules(list, request) }));
  return {
    rules: list.length,
    requests: samples.length,
    perRule,
    decisions,
    blocked: decisions.filter((item) => item.decision.blocked).length,
    redirected: decisions.filter((item) => item.decision.redirected).length,
    allowed: decisions.filter((item) => item.decision.allowed).length,
  };
}

/**
 * 由扩展内部规则（urlPattern/action/...）构造 DNR condition。
 * rules.js 的 syncDnrRules 直接消费，保证"预检看到的条件"和"真正下发的条件"一致。
 */
export function conditionFromRule(rule, { tabId = null } = {}) {
  const source = rule && typeof rule === 'object' ? rule : {};
  const condition = {};
  const urlFilter = source.urlFilter ?? source.urlPattern ?? (source.url ? String(source.url) : null);
  if (source.regexFilter) condition.regexFilter = String(source.regexFilter);
  else if (urlFilter != null) {
    condition.urlFilter = String(urlFilter);
    condition.isUrlFilterCaseSensitive = source.isUrlFilterCaseSensitive === true;
  }
  const resourceTypes = asArray(source.resourceTypes).map(String);
  const excludedResourceTypes = asArray(source.excludedResourceTypes).map(String);
  if (resourceTypes.length) condition.resourceTypes = resourceTypes;
  if (excludedResourceTypes.length) condition.excludedResourceTypes = excludedResourceTypes;
  const requestMethods = asArray(source.requestMethods).map((method) => String(method).toLowerCase());
  const excludedRequestMethods = asArray(source.excludedRequestMethods).map((method) => String(method).toLowerCase());
  if (requestMethods.length) condition.requestMethods = requestMethods;
  if (excludedRequestMethods.length) condition.excludedRequestMethods = excludedRequestMethods;
  if (source.domainType) condition.domainType = String(source.domainType);
  for (const key of ['initiatorDomains', 'excludedInitiatorDomains', 'requestDomains', 'excludedRequestDomains']) {
    const domains = normalizeDomainList(source[key]);
    if (domains.length) condition[key] = domains;
  }
  const targetTab = Number.isInteger(Number(source.tabId)) ? Number(source.tabId) : (Number.isInteger(Number(tabId)) ? Number(tabId) : null);
  if (targetTab != null) condition.tabIds = [targetTab];
  if (Array.isArray(source.tabIds) && source.tabIds.length) condition.tabIds = source.tabIds.map(Number).filter(Number.isInteger);
  return condition;
}

/** 生成一条可下发的 DNR 规则（供 syncDnrRules 复用；action 由调用方决定）。 */
export function toDnrRule(rule, { id = null, priority = null, tabId = null } = {}) {
  const validation = validateRule(rule);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return {
    ok: true,
    rule: {
      id: id == null ? validation.rule.id : Number(id),
      priority: priority == null ? validation.rule.priority : Number(priority),
      action: validation.rule.action === 'upgradeScheme'
        ? { type: 'upgradeScheme', upgradeScheme: validation.rule.upgradeScheme }
        : validation.rule.action === 'redirect'
          ? { type: 'redirect', redirect: { ...validation.rule.redirect } }
          : { type: validation.rule.action },
      condition: conditionFromRule(rule, { tabId }),
    },
  };
}
