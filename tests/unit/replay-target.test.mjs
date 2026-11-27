// tests/unit/replay-target.test.mjs —— 回放目标（元素引用）还原：描述符/选择器稳定度/唯一匹配。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../extension/src/lib/replay-target.js';

function step(index, overrides = {}) {
  return {
    index,
    ref: 'r' + index,
    kind: 'action',
    method: 'click',
    target: { selector: '#btn' },
    params: { selector: '#btn' },
    evidence: { seq: index + 1, index, frameId: 0, documentId: 'doc-1', revision: 1, url: 'https://a.test/' },
    ...overrides,
  };
}

function snapshotEntry(nodes) {
  return [{ boundary: { documentId: 'doc-1', frameId: 0 }, nodes }];
}

const nodes = [
  { selector: '#btn', tag: 'button', role: 'button', name: '提交', text: '提交', visible: true },
  { selector: '#cancel', tag: 'button', role: 'button', name: '取消', text: '取消', visible: true },
];

test('normalizeTargetDescriptor：兼容 0.3.0 {selector/text/name} 与语义描述符', () => {
  const legacy = T.normalizeTargetDescriptor({ selector: '#go', text: 'Go' });
  assert.equal(legacy.selector, '#go');
  assert.equal(legacy.text, 'Go');
  assert.equal(legacy.version, T.REPLAY_TARGET_VERSION);
  assert.equal(legacy.selectorStability.stable, true);

  const semantic = T.normalizeTargetDescriptor({
    tag: 'BUTTON',
    role: 'button',
    name: '提交',
    name_attr: 'submit',
    placeholder: '请输入',
    nearby_label: '提交按钮',
    aria_label: '提交表单',
    geometry: { rect: { x: 1, y: 2, w: 3, h: 4 } },
    attributes: { 'data-x': '1', ignored: null, 'UPPER': 'v' },
  });
  assert.equal(semantic.tag, 'button');
  assert.equal(semantic.role, 'button');
  assert.equal(semantic.nameAttr, 'submit');
  assert.equal(semantic.nearbyLabel, '提交按钮');
  assert.equal(semantic.ariaLabel, '提交表单');
  assert.deepEqual(semantic.geometry, { x: 1, y: 2, w: 3, h: 4 });
  assert.equal(semantic.attributes['data-x'], '1');
  assert.equal(semantic.attributes.upper, 'v');
});

test('normalizeTargetDescriptor：匿名/空输入返回 null；截断上限', () => {
  assert.equal(T.normalizeTargetDescriptor(null), null);
  assert.equal(T.normalizeTargetDescriptor('selector'), null);
  assert.equal(T.normalizeTargetDescriptor({ tag: 'div', role: 'button' }), null);
  assert.equal(T.isAnonymousDescriptor({ tag: 'div', role: 'button' }), true);
  assert.equal(T.isAnonymousDescriptor({ selector: '#' }), false);
  const long = T.normalizeTargetDescriptor({ selector: '#a', text: 'x'.repeat(500) });
  assert.equal(long.text.length <= T.TARGET_LIMITS.maxText, true);
  const nullGeometry = T.normalizeGeometry({ x: 'a', y: 1, w: 2, h: 3 });
  assert.equal(nullGeometry, null);
});

test('targetSignature / isSensitiveTarget', () => {
  const a = T.normalizeTargetDescriptor({ selector: '#a', text: 'x' });
  const b = T.normalizeTargetDescriptor({ selector: '#a', text: 'x', geometry: { x: 1, y: 1, w: 1, h: 1 } });
  assert.equal(T.targetSignature(a), T.targetSignature(b));
  assert.equal(T.targetSignature(null), '');
  assert.equal(T.isSensitiveTarget(T.normalizeTargetDescriptor({ name: 'Password', selector: '#pwd' })), true);
  assert.equal(T.isSensitiveTarget(T.normalizeTargetDescriptor({ name: '验证码', selector: '#code' })), true);
  assert.equal(T.isSensitiveTarget(T.normalizeTargetDescriptor({ name: '搜索', selector: '#q' })), false);
  assert.equal(T.isSensitiveTarget(null), false);
});

test('selectorStability / decomposeSelector：稳定 id 高、nth/散列 class 低', () => {
  const stable = T.selectorStability('#app-header');
  assert.equal(stable.stable, true);
  assert.equal(stable.score >= 70, true);
  const testid = T.selectorStability('[data-testid="submit"]');
  assert.equal(testid.stable, true);
  const fragile = T.selectorStability('div:nth-child(2) > ul > li.item > button');
  assert.equal(fragile.stable, false);
  assert.equal(fragile.reasons.includes('nth-position'), true);
  assert.equal(fragile.reasons.includes('medium-chain'), true);
  const hashed = T.selectorStability('.css-1a2b3c');
  assert.equal(hashed.reasons.includes('hashed-class'), true);
  const tagOnly = T.selectorStability('div');
  assert.equal(tagOnly.stable, false);
  assert.equal(T.selectorStability('').score, 0);

  const decomposed = T.decomposeSelector('#a.b[c="d"] > span:nth-of-type(2)');
  assert.equal(decomposed.ids.includes('a'), true);
  assert.equal(decomposed.classes.includes('b'), true);
  assert.equal(decomposed.hasNth, true);
  assert.equal(decomposed.depth >= 2, true);
});

test('locatorCandidates：策略顺序、去重、上限与证据', () => {
  const semantic = T.normalizeTargetDescriptor({
    tag: 'a',
    role: 'link',
    name: '文档',
    selector: '#doc-link',
    name_attr: 'doc',
  });
  const result = T.locatorCandidates(semantic);
  const strategies = result.candidates.map((candidate) => candidate.strategy);
  assert.equal(strategies[0], 'selector');
  assert.equal(strategies.includes('role-name'), true);
  assert.equal(strategies.includes('link-text'), true);
  assert.equal(new Set(strategies).size, strategies.length);
  assert.equal(result.candidates[0].score <= 1, true);
  const limited = T.locatorCandidates(semantic, { maxCandidates: 2 });
  assert.equal(limited.candidates.length, 2);
  assert.equal(T.locatorCandidates(null).candidates.length, 0);
  assert.equal(T.strategyRank('selector'), 0);
  assert.equal(T.strategyRank('unknown'), T.TARGET_STRATEGIES.length);
});

test('normalizeSnapshotNodes：字段归一、可见性默认、key 生成、数量上限', () => {
  const list = T.normalizeSnapshotNodes([
    { selector: '#a', tag: 'BUTTON', name: '提交', nameAttr: 'submit', visible: false, rect: { x: 0, y: 0, w: 10, h: 5 } },
    { selectors: ['#b'], 'data-testid': 'b-test', hidden: true },
    { text: 'hello', aria_label: 'hi' },
  ]);
  assert.equal(list.length, 3);
  assert.equal(list[0].visible, false);
  assert.equal(list[0].tag, 'button');
  assert.equal(list[0].nameAttr, 'submit');
  assert.deepEqual(list[0].geometry, { x: 0, y: 0, w: 10, h: 5 });
  assert.equal(list[1].visible, false);
  assert.equal(list[1].testid, 'b-test');
  assert.equal(list[2].ariaLabel, 'hi');
  assert.equal(list[0].key.startsWith('n'), true);
  assert.equal(T.nodeSignature({ tag: 'button', role: 'button', name: '提交', name_attr: 'submit' }), 'button|button|提交|submit');
});

test('matchNode：各策略命中/未命中语义', () => {
  const node = T.normalizeSnapshotNodes(nodes)[0];
  const hit = (strategy, value, extra = {}) => T.matchNode(node, { strategy, value, score: 1, ...extra });
  assert.equal(hit('selector', '#btn').matched, true);
  assert.equal(hit('selector', '#other').matched, false);
  assert.equal(hit('id', 'btn').reason, 'id-miss');
  assert.equal(hit('testid', 't').matched, false);
  assert.equal(hit('name-attr', 'submit').matched, false);
  assert.equal(hit('placeholder', 'x').matched, false);
  assert.equal(hit('aria-label', 'x').matched, false);
  assert.equal(hit('label-text', '提交').matched, true);
  assert.equal(hit('role-name', '提交', { role: 'button' }).matched, true);
  assert.equal(hit('role-name', '提交', { role: 'link' }).matched, false);
  assert.equal(hit('link-text', '提交').matched, true);
  assert.equal(hit('text', '提交').matched, true);
  assert.equal(hit('text', '提').matched, false);
  assert.equal(hit('node-signature', 'button|button|提交|').matched, true);
  assert.equal(hit('unknown', 'x').matched, false);
});

test('geometryAffinity：距离/重叠决定亲和度', () => {
  const recorded = { rect: { x: 0, y: 0, w: 10, h: 10 } };
  const near = T.geometryAffinity(recorded, { rect: { x: 1, y: 1, w: 10, h: 10 } });
  const far = T.geometryAffinity(recorded, { rect: { x: 500, y: 500, w: 10, h: 10 } });
  assert.equal(near !== null && near > far, true);
  assert.equal(T.geometryAffinity(recorded, null), null);
});

test('matchCandidates：唯一命中 / 模糊匹配 / 多命中拒绝 / 几何打破平局', () => {
  const normalized = T.normalizeSnapshotNodes(nodes);
  const exact = T.matchCandidates(T.locatorCandidates({ selector: '#btn' }).candidates, normalized);
  assert.equal(exact.ok, true);
  assert.equal(exact.status, 'exact');
  assert.equal(exact.reasonCode, 'TARGET_EXACT_SELECTOR');

  const fuzzy = T.matchCandidates(T.locatorCandidates({ text: '提交' }).candidates, normalized);
  assert.equal(fuzzy.ok, true);
  assert.equal(fuzzy.status, 'fallback'); // text 是后备策略：唯一命中但非主策略
  assert.equal(fuzzy.strategy, 'text');

  const duplicated = T.normalizeSnapshotNodes([...nodes, { selector: '#btn2', name: '提交', text: '提交' }]);
  const ambiguous = T.matchCandidates(T.locatorCandidates({ text: '提交' }).candidates, duplicated);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.alternatives.length >= 1, true);
  assert.equal(ambiguous.ambiguity.count >= 2, true);

  const nearby = T.normalizeSnapshotNodes([
    { selector: '#btn', name: '提交', text: '提交', rect: { x: 0, y: 0, w: 10, h: 10 } },
    { selector: '#btn2', name: '提交', text: '提交', rect: { x: 400, y: 400, w: 10, h: 10 } },
  ]);
  const tie = T.matchCandidates(T.locatorCandidates({ text: '提交' }).candidates, nearby, {
    geometry: { rect: { x: 1, y: 1, w: 10, h: 10 } },
    ambiguityMargin: 0.01,
  });
  assert.equal(tie.ok, true);
  assert.equal(tie.reasonCode, 'TARGET_GEOMETRY_TIEBREAK');

  const hidden = T.normalizeSnapshotNodes([{ selector: '#btn', visible: false }]);
  const onlyHidden = T.matchCandidates(T.locatorCandidates({ selector: '#btn' }).candidates, hidden);
  assert.equal(onlyHidden.ok, false);
  assert.equal(onlyHidden.reasonCode, 'TARGET_ONLY_HIDDEN');
  const included = T.matchCandidates(T.locatorCandidates({ selector: '#btn' }).candidates, hidden, { includeHidden: true });
  assert.equal(included.ok, true);

  const noMatch = T.matchCandidates(T.locatorCandidates({ selector: '#nothing' }).candidates, normalized);
  assert.equal(noMatch.status, 'missing');
  assert.equal(noMatch.reasonCode, 'TARGET_NO_MATCH');
  assert.equal(T.matchCandidates([], normalized).status, 'missing');
});

test('planTargetRestoration：快照命中 → exact / fallback', () => {
  const plan = T.planTargetRestoration([step(0), step(1, { target: { text: '取消' }, params: { text: '取消' } })], snapshotEntry(nodes));
  assert.equal(plan.ok, true);
  assert.equal(plan.steps[0].status, 'exact');
  assert.equal(plan.steps[0].scopeVerified, true);
  assert.equal(plan.steps[0].nodeKey.length > 0, true);
  assert.equal(plan.steps[1].status, 'fallback');
  assert.equal(plan.summary.exact, 1);
  assert.equal(plan.summary.fallback, 1);
  assert.equal(plan.warnings.length >= 0, true);
});

test('planTargetRestoration：多命中 → blocker；无快照 → planned；requireSnapshot → missing', () => {
  const ambiguousNodes = [...nodes, { selector: '#btn2', name: '提交', text: '提交' }];
  const ambiguous = T.planTargetRestoration([step(0, { target: { text: '提交' }, params: { text: '提交' } })], snapshotEntry(ambiguousNodes));
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.steps[0].status, 'ambiguous');
  assert.equal(ambiguous.blockers[0].code, 'TARGET_AMBIGUOUS');
  assert.equal(ambiguous.steps[0].blocked, true);

  const planned = T.planTargetRestoration([step(0)], null);
  assert.equal(planned.ok, true);
  assert.equal(planned.steps[0].status, 'planned');
  assert.equal(planned.steps[0].candidates.length > 0, true);
  assert.equal(planned.warnings.length, 1);

  const required = T.planTargetRestoration([step(0)], null, { requireSnapshot: true });
  assert.equal(required.ok, false);
  assert.equal(required.steps[0].status, 'missing');
  assert.equal(required.blockers[0].code, 'TARGET_NO_SNAPSHOT');

  const empty = T.planTargetRestoration([step(0)], snapshotEntry([]));
  assert.equal(empty.steps[0].status, 'missing');
  assert.equal(empty.blockers[0].code, 'TARGET_EMPTY_SNAPSHOT');
});

test('planTargetRestoration：匿名目标 forbidden、network/非 DOM 步骤 not-required', () => {
  const forbidden = T.planTargetRestoration([step(0, { target: { tag: 'div' }, params: {} })], snapshotEntry(nodes));
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.steps[0].status, 'forbidden');
  assert.equal(forbidden.blockers[0].code, 'TARGET_ANONYMOUS');

  const network = T.planTargetRestoration([step(0, { kind: 'network', method: 'network.replay', target: null, params: { url: 'https://a.test/' } })], snapshotEntry(nodes));
  assert.equal(network.ok, true);
  assert.equal(network.steps[0].status, 'not-required');
  assert.equal(network.steps[0].blocked, false);
});

test('planTargetRestoration：rebind 跟随 revision/URL 变化', () => {
  const steps = [
    step(0),
    step(1, { evidence: { documentId: 'doc-1', frameId: 0, revision: 2, url: 'https://a.test/' } }),
    step(2, { evidence: { documentId: 'doc-1', frameId: 0, revision: 2, url: 'https://a.test/next' } }),
  ];
  const plan = T.planTargetRestoration(steps, snapshotEntry(nodes));
  assert.equal(plan.steps[0].rebind, false);
  assert.equal(plan.steps[1].rebind, true);
  assert.equal(plan.steps[2].rebind, true);
});

test('buildSnapshotIndex：Map / 对象 / 条目数组 / 通配数组', () => {
  const scoped = T.buildSnapshotIndex(new Map([['doc-1|f0', nodes]]));
  assert.equal(scoped.byScope.has('doc-1|f0'), true);
  assert.deepEqual(scoped.scopes, ['doc-1|f0']);

  const objectForm = T.buildSnapshotIndex({ 'doc-1|f0': nodes });
  assert.equal(objectForm.byScope.get('doc-1|f0').length, 2);

  const entries = T.buildSnapshotIndex([{ scope: 'doc-2|f0', nodes: [{ selector: '#a' }] }]);
  assert.equal(entries.byScope.has('doc-2|f0'), true);

  const wildcard = T.buildSnapshotIndex([{ selector: '#a' }]);
  assert.equal(wildcard.wildcard.length, 1);
  assert.equal(wildcard.scopes.length, 0);
  assert.equal(T.buildSnapshotIndex(null).wildcard, null);
});

test('targetsNeedingHuman / summarizeTargetPlan / targetBlockerCodes / verifyTargetPlan', () => {
  const steps = [
    step(0),
    step(1, { humanGate: { reason: '补密码', valueKind: 'text' }, params: { selector: '#pwd' }, target: { selector: '#pwd' } }),
    step(2, { kind: 'human', method: 'human-gate', humanGate: { reason: 'x', valueKind: 'text' } }),
  ];
  const plan = T.planTargetRestoration(steps, snapshotEntry([...nodes, { selector: '#pwd', tag: 'input', name: '密码', visible: true }]));
  const human = T.targetsNeedingHuman(steps, plan);
  assert.equal(human.length, 1);
  assert.equal(human[0].index, 1);
  assert.equal(human[0].valueKind, 'text');

  const summary = T.summarizeTargetPlan(plan);
  assert.equal(summary.total, 3);
  assert.equal(summary.notRequired, 1);
  assert.equal(T.summarizeTargetPlan(null).total, 0);
  assert.deepEqual(T.targetBlockerCodes(plan), []);

  const verification = T.verifyTargetPlan(plan, 3);
  assert.equal(verification.ok, true);
  const wrongLength = T.verifyTargetPlan(plan, 9);
  assert.equal(wrongLength.ok, false);
  assert.equal(T.verifyTargetPlan(null).ok, false);
});

test('staticTargetPlan：无快照时只排候选', () => {
  const plan = T.staticTargetPlan([step(0), step(1, { kind: 'observe', method: 'observe', target: null, params: {} })]);
  assert.equal(plan.ok, true);
  assert.equal(plan.steps[0].status, 'planned');
  assert.equal(plan.steps[1].status, 'not-required');
  assert.equal(plan.steps[0].candidates.length >= 1, true);
});
