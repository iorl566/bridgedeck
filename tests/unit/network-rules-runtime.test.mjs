// tests/unit/network-rules-runtime.test.mjs —— rules.js 运行时接线：DNR condition 单源 + 离线预检返回值。
//
// 用最小 chrome stub 直接加载扩展真实 rules.js，验证：
//   * rule_add 下发给 chrome.declarativeNetRequest 的 condition 带上了 resourceTypes/priority/tabIds
//     （由 network-rule-eval.conditionFromRule 单源构造，不是另一份手写条件）；
//   * 返回值里带 preflight（离线评估器结论），冲突/非法条件能提前暴露；
//   * rule_import / rule_clear 同样走评估器，且不改变既有规则语义。
import test from 'node:test';
import assert from 'node:assert/strict';

const dnrCalls = [];
const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        if (key == null) return Object.fromEntries(storage);
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      set: async (values) => {
        for (const [key, value] of Object.entries(values || {})) storage.set(key, value);
      },
      remove: async (key) => {
        storage.delete(key);
      },
    },
  },
  scripting: { executeScript: async () => [] },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
    onEvent: { addListener: () => {}, removeListener: () => {} },
    onDetach: { addListener: () => {}, removeListener: () => {} },
  },
  declarativeNetRequest: {
    updateSessionRules: async ({ removeRuleIds, addRules }) => {
      dnrCalls.push({ removeRuleIds: [...(removeRuleIds || [])], addRules: JSON.parse(JSON.stringify(addRules || [])) });
      return {};
    },
  },
};

const rules = await import('../../extension/src/rules.js');
const TAB = 7_701;

test('ruleAdd：DNR condition 由 conditionFromRule 单源构造（含 resourceTypes/priority/tabIds）', async () => {
  dnrCalls.length = 0;
  const result = await rules.ruleAdd({
    tabId: TAB,
    rule: {
      urlPattern: '*/api/*',
      action: 'block',
      resourceTypes: ['script', 'xmlhttprequest'],
      priority: 4,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].priority, 4);
  assert.deepEqual(result.rules[0].resourceTypes, ['script', 'xmlhttprequest']);
  assert.equal(result.preflight.counts.rules, 1);
  assert.equal(result.preflight.counts.invalid, 0);
  assert.equal(result.dnr.count, 1);

  const last = dnrCalls[dnrCalls.length - 1];
  assert.equal(last.addRules.length, 1);
  const sent = last.addRules[0];
  assert.equal(sent.priority, 4);
  assert.deepEqual(sent.action, { type: 'block' });
  assert.equal(sent.condition.urlFilter, '*/api/*');
  assert.equal(sent.condition.isUrlFilterCaseSensitive, false);
  assert.deepEqual(sent.condition.resourceTypes, ['script', 'xmlhttprequest']);
  assert.deepEqual(sent.condition.tabIds, [TAB]);
});

test('ruleAdd：冲突/非法条件进入 preflight，但不阻断既有 API 形状', async () => {
  dnrCalls.length = 0;
  const conflict = await rules.ruleAdd({
    tabId: TAB,
    rule: { urlPattern: '*/api/*', action: 'block', resourceTypes: ['script', 'xmlhttprequest'], priority: 4 },
  });
  assert.equal(conflict.ok, true);
  // 同条件不同动作 → action-conflict
  const withRedirect = await rules.ruleAdd({
    tabId: TAB,
    rule: { urlPattern: '*/api/*', action: 'modify', url: 'https://b.test/new', resourceTypes: ['script', 'xmlhttprequest'], priority: 4 },
  });
  assert.equal(withRedirect.ok, true);
  assert.equal(withRedirect.rules.length, 3); // 前一个用例的 block 仍在
  assert.equal(withRedirect.preflight.conflicts.some((item) => item.kind === 'action-conflict'), true);
  assert.equal(withRedirect.preflight.conflicts.some((item) => (
    item.ids && item.ids.includes(withRedirect.rules[withRedirect.rules.length - 1].id)
  )), true);
});

test('ruleImport/ruleClear：导入走同一评估器，清理后 preflight 清空', async () => {
  dnrCalls.length = 0;
  const imported = await rules.ruleImport({
    tabId: TAB,
    rules: [
      { urlPattern: '*/img/*', action: 'block', priority: 2 },
      { urlPattern: '*/ok', action: 'fulfill', body: 'ok' },
    ],
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.imported, 2);
  assert.equal(imported.preflight.counts.rules, 1); // fulfill 只走页面 hook，不进 DNR
  assert.equal(imported.preflight.dnr.unsupported.length, 1);
  assert.equal(imported.preflight.dnr.unsupported[0].reason, 'fetch-hook-only');
  assert.equal(imported.preflight.dnr.rules, 1);

  const listed = await rules.ruleList({ tabId: TAB });
  assert.equal(listed.ok, true);
  assert.equal(listed.rules.length, 2);

  const cleared = await rules.ruleClear({ tabId: TAB });
  assert.equal(cleared.cleared, 2);
  const afterClear = await rules.ruleList({ tabId: TAB });
  assert.equal(afterClear.rules.length, 0);
  const last = dnrCalls[dnrCalls.length - 1];
  assert.deepEqual(last.addRules, []);
});

test('rule_disable 后不再下发 DNR 规则', async () => {
  dnrCalls.length = 0;
  const added = await rules.ruleAdd({ tabId: TAB, rule: { urlPattern: '*/toggle', action: 'block' } });
  const id = added.rules[0].id;
  assert.ok(dnrCalls[dnrCalls.length - 1].addRules.length >= 1);
  await rules.ruleSetEnabled({ tabId: TAB, id, enabled: false });
  assert.deepEqual(dnrCalls[dnrCalls.length - 1].addRules, []);
  const disabled = await rules.ruleList({ tabId: TAB });
  assert.equal(disabled.rules.find((rule) => rule.id === id).enabled, false);
  await rules.ruleClear({ tabId: TAB });
});
