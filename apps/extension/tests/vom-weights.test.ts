// tests/vom-weights.test.ts —— observe --vom 的打分/计费/预算/排序/压缩（5b）。
//
// 口径：字段名与 0.3.0 JS observe 一致（vomWeights/vomExplain），token 估算复用
// packages/vom（单一实现）；这里是 TS 侧的可执行契约，不是“差不多”的边界。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentSession } from '../src/content/session.ts';
import { makeContentRequest, type ContentObserveResult } from '../src/content/protocol.ts';
import { createFakeDom, fixtureElements, type FakeElementSpec } from './support/fake-dom.ts';
import {
  DEFAULT_VOM_WEIGHTS,
  VOM_TOKEN_SAFETY_FACTOR,
  applySemanticGroupBudget,
  createBillingLedger,
  estimateVomTokens,
  resolveVomProfile,
  scoreVomNode,
  visibilityFlagsOf,
  type VomWeightsPayload,
} from '../src/content/vom-weights.ts';

let requestSeq = 0;

function makeSession(elements: FakeElementSpec[] = fixtureElements(), documentId = 'doc-vom'): { session: ContentSession; dom: ReturnType<typeof createFakeDom> } {
  const dom = createFakeDom(elements, { title: 'VOM 权重夹具', url: 'https://example.test/vom.html' });
  const session = new ContentSession(dom.env, { protocol: '1.9', documentId });
  return { session, dom };
}

function observe(session: ContentSession, params: Record<string, unknown> = {}): ContentObserveResult {
  requestSeq += 1;
  const reply = session.handle(makeContentRequest('observe', params, 'req-vom-' + String(requestSeq)));
  assert.equal(reply.ok, true, 'observe 应成功：' + JSON.stringify(reply));
  return (reply as { ok: true; result: ContentObserveResult }).result;
}

function weightsOf(result: ContentObserveResult): VomWeightsPayload {
  const weights = (result.richResult ?? {})['vomWeights'];
  assert.ok(weights, '缺少 vomWeights：' + JSON.stringify(Object.keys(result.richResult ?? {})));
  return weights as VomWeightsPayload;
}

function bigPage(count = 30): FakeElementSpec[] {
  const buttons: FakeElementSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    buttons.push({
      tag: 'button',
      id: 'b' + String(index),
      type: 'button',
      text: '按钮 ' + String(index),
      rect: { left: 0, top: 40 + index * 40, width: 120, height: 32 },
    });
  }
  return [
    { tag: 'h1', text: 'VOM 权重大页', rect: { left: 0, top: 0, width: 600, height: 40 } },
    {
      tag: 'form',
      id: 'form-main',
      rect: { left: 0, top: 30, width: 600, height: 1300 },
      children: [
        { tag: 'input', id: 'kw', type: 'text', attrs: { 'aria-label': '关键词' }, rect: { left: 10, top: 40, width: 200, height: 28 } },
        { tag: 'button', id: 'submit', type: 'button', text: '查询', rect: { left: 10, top: 80, width: 100, height: 32 } },
        ...buttons,
      ],
    },
    { tag: 'p', id: 'tail', text: '页尾文本', rect: { left: 0, top: 1400, width: 600, height: 30 } },
  ];
}

// ---------------------------------------------------------------------------
// 纯函数：打分 / 计费
// ---------------------------------------------------------------------------

test('scoreVomNode：交互按钮得分高于纯文本，factors 可解释且分数为整数', () => {
  const button = scoreVomNode({ role: 'button', tag: 'button', name: '提交', interactive: true, clickable: true, visible: true, inForm: true });
  const text = scoreVomNode({ role: 'paragraph', tag: 'p', name: '说明文字' });
  assert.ok(Number.isInteger(button.score));
  assert.ok(button.score > text.score, '按钮应高于文本：' + button.score + ' vs ' + text.score);
  assert.ok(button.factors.some((factor) => factor.name === 'interactive' && factor.score === DEFAULT_VOM_WEIGHTS['interactive']));
  assert.ok(button.factors.every((factor) => typeof factor.score === 'number'));
  assert.equal(visibilityFlagsOf({ hitTest: 'blocked', clickable: false, visible: true }).occluded, true);
  assert.equal(visibilityFlagsOf({ inViewport: false }).offscreen, true);
});

test('计费账本：chars-per-4 与 cjk 口径不同；o200k 词表缺失时显式回退', () => {
  const nodes = [{ name: '提交查询', role: 'button', tag: 'button' }, { name: 'hello world', role: 'textbox', tag: 'input' }];
  const cjk = createBillingLedger(nodes, { model: 'cjk-heuristic-v2' });
  const chars = createBillingLedger(nodes, { model: 'chars-per-4' });
  const o200k = createBillingLedger(nodes, { model: 'o200k' });
  assert.equal(cjk.model, 'cjk-heuristic-v2');
  assert.equal(cjk.fallback, false);
  assert.ok(cjk.totalTokens >= nodes.length * 8);
  assert.equal(chars.model, 'chars-per-4');
  assert.equal(chars.tokenizer, 'chars-per-4');
  assert.ok(chars.totalTokens > 0);
  assert.equal(o200k.model, 'o200k');
  assert.equal(o200k.fallback, true);
  assert.equal(o200k.tokenizer, 'cjk-heuristic-v2');
  assert.match(String(o200k.fallbackReason), /o200k/);
  assert.equal(o200k.totalTokens, cjk.totalTokens);
  // 节点成本 = 8 固定开销 + name/role 文本成本（'xbutton' 6 字符 → 2 token）。
  assert.equal(estimateVomTokens({ name: 'x', role: 'button' }), 8 + 2);
});

test('VOM 档位：compact 的 minScore/maxNodes/excludeHidden 固定', () => {
  assert.equal(resolveVomProfile('compact')?.minScore, 20);
  assert.equal(resolveVomProfile('compact')?.maxNodes, 80);
  assert.equal(resolveVomProfile('compact')?.excludeHidden, true);
  assert.equal(resolveVomProfile('nope'), null);
  assert.equal(String(VOM_TOKEN_SAFETY_FACTOR), '1.1');
});

test('语义组预算：未分组节点保留、按组分数选择并在超 token 时记账', () => {
  const nodes = [
    { id: 'a', vomScore: 50 },
    { id: 'b', vomScore: 40 },
    { id: 'c', vomScore: 10 },
    { id: 'loose', vomScore: 5 },
  ];
  const groups = [
    { id: 'g1', groupKind: 'form', memberIds: ['a', 'b'], tokens: 40 },
    { id: 'g2', groupKind: 'section', memberIds: ['c'], tokens: 20 },
  ];
  const limited = applySemanticGroupBudget(nodes, groups, { maxGroups: 1 });
  assert.deepEqual(limited.nodes.map((node) => node.id), ['a', 'b', 'loose']);
  assert.equal(limited.semanticFiltered.groups, 1);
  assert.ok(limited.semanticFiltered.tokensUsed >= 0);
  const tokenLimited = applySemanticGroupBudget(nodes, groups, { maxGroupTokens: 30 });
  assert.equal(tokenLimited.nodes.some((node) => node.id === 'c'), false);
});

// ---------------------------------------------------------------------------
// observe --vom：vomWeights 字段与 E2E 5b 断言形状对齐
// ---------------------------------------------------------------------------

test('5b：observe --vom 返回 vomWeights 全字段（billing/budgetPlan/estimatedTokens）', () => {
  const { session } = makeSession();
  const result = observe(session, { vom: true });
  const weights = weightsOf(result);
  assert.equal(weights.version, 1);
  assert.equal(weights.tokenSafetyFactor, 1.1);
  assert.ok(Number.isInteger(weights.estimatedTokens));
  assert.ok(weights.estimatedTokens > 0);
  assert.ok(weights.billing.totalTokens > 0);
  assert.equal(weights.estimatedTokens, weights.billing.totalTokens);
  assert.ok(weights.billing.groups > 0, 'billing 应关联语义组：' + JSON.stringify(weights.billing));
  assert.ok(weights.billing.grouped > 0);
  assert.ok(weights.budgetPlan.nodes >= 0);
  assert.equal(typeof weights.budgetPlan.tokens, 'number');
  assert.equal(weights.ranked, false);
  assert.equal(weights.top, null);
  assert.equal(weights.minScore, null);
  assert.equal(weights.profile, null);
  assert.equal(weights.excludeHidden, false);
  assert.deepEqual(weights.custom, []);
  // 每个节点都有整数 vomScore；按钮仍带 ref（不因打分/预算丢字段）。
  for (const node of result.nodes as unknown as Array<Record<string, unknown>>) {
    assert.ok(Number.isInteger(node.vomScore), 'vomScore 必须是整数：' + JSON.stringify(node.vomScore));
  }
  const button = (result.nodes as unknown as Array<Record<string, unknown>>).find((node) => node.role === 'button');
  assert.ok(button);
  assert.match(String(button?.ref ?? ''), /^@e\d+$/);
  assert.match(String(button?.stableRef ?? ''), /^s-/);
});

test('5b：--vom-billing-model chars-per-4 / o200k 生效且 estimatedTokens 用同一账本', () => {
  const { session } = makeSession();
  const chars = weightsOf(observe(session, { vom: true, vomBillingModel: 'chars-per-4' }));
  assert.equal(chars.billing.model, 'chars-per-4');
  assert.ok(chars.billing.totalTokens > 0);
  assert.equal(chars.estimatedTokens, chars.billing.totalTokens);
  const o200k = weightsOf(observe(session, { vom: true, vomBillingModel: 'o200k' }));
  assert.equal(o200k.billing.model, 'o200k');
  assert.ok(o200k.billing.totalTokens > 0);
  assert.equal(o200k.estimatedTokens, o200k.billing.totalTokens);
});

test('5b：--vom-rank/--vom-top 排序并截断，tokenSafetyFactor 恒为 1.1', () => {
  const { session } = makeSession(bigPage());
  const result = observe(session, { vom: true, vomRank: true, vomTop: 10 });
  const weights = weightsOf(result);
  const nodes = result.nodes as unknown as Array<{ vomScore: number }>;
  assert.equal(weights.ranked, true);
  assert.equal(weights.top, 10);
  assert.ok(nodes.length <= 10);
  assert.equal(weights.tokenSafetyFactor, 1.1);
  assert.ok(Number.isInteger(weights.estimatedTokens) && weights.estimatedTokens > 0);
  const scores = nodes.map((node) => node.vomScore);
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), 'vom-rank 应按分数降序');
});

test('5b：--vom-min-score 过滤且不虚报 minScore', () => {
  const { session } = makeSession(bigPage());
  const result = observe(session, { vom: true, vomMinScore: 20 });
  const weights = weightsOf(result);
  const nodes = result.nodes as unknown as Array<{ vomScore: number }>;
  assert.ok(nodes.length > 0);
  assert.ok(nodes.every((node) => node.vomScore >= 20));
  assert.equal(weights.minScore, 20);
});

test('5b：--vom-max-nodes 预算裁剪与 budget 证据', () => {
  const { session } = makeSession(bigPage());
  const result = observe(session, { vom: true, vomRank: true, vomMaxNodes: 10 });
  const weights = weightsOf(result);
  const nodes = result.nodes as unknown as Array<{ vomScore: number }>;
  assert.ok(nodes.length <= 10);
  assert.ok(weights.budget.nodes > 0, 'budget 应记录被裁数量：' + JSON.stringify(weights.budget));
  assert.ok(weights.budgetPlan.nodes > 0);
  assert.equal(weights.budgetPlan.nodeLimit, 10);
});

test('5b：--vom-profile compact 应用 minScore/maxNodes/excludeHidden', () => {
  const { session } = makeSession(bigPage());
  const result = observe(session, { vom: true, vomProfile: 'compact' });
  const weights = weightsOf(result);
  const nodes = result.nodes as unknown as Array<{ vomScore: number }>;
  assert.ok(nodes.length <= 80);
  assert.equal(weights.profile, 'compact');
  assert.equal(weights.minScore, 20);
  assert.equal(weights.excludeHidden, true);
  assert.ok(nodes.every((node) => node.vomScore >= 20));
});

test('5b：--vom-exclude-hidden 只减不增，并标记 excludeHidden', () => {
  const { session } = makeSession();
  const baseline = observe(session, { vom: true });
  const baselineCount = (baseline.nodes as unknown[]).length;
  const visibleOnly = observe(session, { vom: true, vomExcludeHidden: true });
  const weights = weightsOf(visibleOnly);
  assert.equal(weights.excludeHidden, true);
  assert.ok((visibleOnly.nodes as unknown[]).length <= baselineCount);
});

test('5b：--vom-per-group / --vom-group-tokens 触发组压缩并记账', () => {
  const { session } = makeSession(bigPage());
  const grouped = observe(session, { vom: true, vomPerGroup: 2 });
  const groupedWeights = weightsOf(grouped);
  assert.equal(groupedWeights.perGroup, 2);
  assert.ok(groupedWeights.compacted, 'perGroup 应返回 compacted');
  assert.ok(groupedWeights.compacted && groupedWeights.compacted.groups >= 1);
  const groupTokens = observe(session, { vom: true, vomGroupTokens: 30 });
  const tokenWeights = weightsOf(groupTokens);
  assert.equal(tokenWeights.groupTokens, 30);
  assert.ok(tokenWeights.compacted);
});

test('5b：--vom-weights 自定义权重生效并记入 custom', () => {
  const { session } = makeSession();
  const baseline = observe(session, { vom: true });
  const bench = (result: ContentObserveResult): number => {
    const button = (result.nodes as unknown as Array<{ role: string; vomScore: number }>).find((node) => node.role === 'button');
    return Number(button?.vomScore ?? 0);
  };
  const custom = observe(session, { vom: true, vomWeights: { interactive: 100, text: 2 } });
  const weights = weightsOf(custom);
  assert.deepEqual(weights.custom.slice().sort(), ['interactive', 'text']);
  assert.ok(bench(custom) > bench(baseline), '自定义 interactive 权重应抬高按钮分数');
});

test('5b：--vom-semantic-max-groups / --vom-group-context 生效', () => {
  const { session } = makeSession();
  const result = observe(session, { vom: true, vomSemanticMaxGroups: 1, vomGroupContext: true });
  const weights = weightsOf(result);
  assert.ok(weights.semanticFiltered, '缺少 semanticFiltered');
  assert.ok((weights.semanticFiltered?.groups ?? 0) >= 1);
  assert.equal(typeof weights.semanticFiltered?.contextGroups, 'number');
  assert.ok((weights.semanticFiltered?.tokensUsed ?? 0) >= 0);
  assert.ok(weights.budgetPlan.semanticGroups !== null);
  const tokens = observe(session, { vom: true, vomSemanticMaxTokens: 100 });
  const tokenWeights = weightsOf(tokens);
  assert.ok(tokenWeights.semanticFiltered);
  assert.ok((tokenWeights.semanticFiltered?.tokensUsed ?? 0) >= 0);
  assert.equal(typeof tokenWeights.budgetPlan.tokens, 'number');
});

test('5b：--vom-explain 返回逐节点因素明细（score 为数字）', () => {
  const { session } = makeSession();
  const result = observe(session, { vom: true, vomExplain: true });
  const explain = (result.richResult ?? {})['vomExplain'] as Record<string, Array<{ name: string; score: number }>> | undefined;
  assert.ok(explain, '缺少 vomExplain');
  const entries = Object.values(explain ?? {});
  assert.ok(entries.length > 0);
  assert.ok(entries.some((factors) => factors.some((factor) => typeof factor.score === 'number')));
});
