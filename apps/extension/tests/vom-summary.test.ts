// tests/vom-summary.test.ts —— VOM 统一摘要（packages/vom 驱动）的语义与不变量。
//
// 覆盖：
// 1) affordance：每节点判定来自 packages/vom（upload/type/toggle/select/drag/scroll/dismiss/
//    hover/activate），并与 facts 的页面属性一致；
// 2) relations：ARIA 关系/标签/表单/表格/无效状态都进入关系图，source/confidence 合法；
// 3) context/groups：landmark/form/table 分组、父子深度、表格结构事实；
// 4) stats 自洽 + verifyVomSummary 自检（含人为篡改必须被抓到）；
// 5) groups 摘要上限（前 N 组 + truncated 标记）；
// 6) 跨 frame 摘要；7) 一行诊断文本。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildObservation } from '../src/content/dom.ts';
import { assignRichElementIds, buildRichObservation, collectElements } from '../src/content/rich.ts';
import { buildVomPageFacts } from '../src/content/vom-facts.ts';
import type { VomPageFacts } from '../src/content/vom-facts.ts';
import {
  VOM_GROUP_DIGEST_LIMIT,
  VOM_SUMMARY_VERSION,
  buildVomSummary,
  collectNodeAffordances,
  renderVomSummaryText,
  summarizeVomGroups,
  verifyVomSummary,
  type VomUnifiedSummary,
} from '../src/content/vom-summary.ts';
import { createFakeDom } from './support/fake-dom.ts';
import type { FakeElementSpec } from './support/fake-dom.ts';
import { VOM_FIXTURE_DIR } from './support/write-vom-fixtures.ts';

function readFixture(name: string): VomPageFacts {
  return JSON.parse(fs.readFileSync(path.join(VOM_FIXTURE_DIR, name + '.json'), 'utf8')) as VomPageFacts;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const BASIC = readFixture('basic-form');
const BASIC_SUMMARY = buildVomSummary(BASIC);

function summaryOf(facts: VomPageFacts): VomUnifiedSummary {
  return buildVomSummary(clone(facts));
}

function nodeOf(summary: VomUnifiedSummary, id: string) {
  const node = summary.nodes.find((item) => item.id === id);
  assert.ok(node, '摘要里缺少节点：' + id);
  return node;
}

/** 通过运行时同一条 DOM 流程构造 facts（用于 groups 上限等需要构造大页面的用例）。 */
function factsFromDom(elements: FakeElementSpec[], options: { title?: string; url?: string } = {}): VomPageFacts {
  const fake = createFakeDom(elements, { title: options.title ?? '构造页', url: options.url ?? 'https://example.test/generated.html' });
  const { collected } = collectElements(fake.env);
  const elementById = assignRichElementIds(collected);
  const built = buildObservation(fake.env, {});
  const rich = buildRichObservation(fake.env, built, { vom: true });
  return buildVomPageFacts({
    url: built.url,
    title: built.title,
    env: fake.env,
    nodes: rich.nodes ?? [],
    elements: collected.map((item) => item.el),
    elementById,
  });
}

// ---------------------------------------------------------------------------
// 1) affordance
// ---------------------------------------------------------------------------

test('affordance：页面属性 → packages/vom 的类型化判定（全谱）', () => {
  const summary = BASIC_SUMMARY;
  assert.equal(nodeOf(summary, 'avatar').affordance.type, 'upload');
  assert.equal(nodeOf(summary, 'avatar').affordance.confidence, 0.95);
  assert.equal(nodeOf(summary, 'username').affordance.type, 'type');
  assert.equal(nodeOf(summary, 'agree').affordance.type, 'toggle');
  assert.equal(nodeOf(summary, 'toggle').affordance.type, 'toggle');
  // <input role=combobox> 没有 type 属性 → 浏览器默认 text，type(0.9) 高于 select(0.85)；
  // select 仍作为备选出现（同 JS 基线的同分/优先级语义）。
  assert.equal(nodeOf(summary, 'city').affordance.type, 'type');
  assert.ok(nodeOf(summary, 'city').affordance.alternatives.some((item) => item.type === 'select'));
  assert.equal(nodeOf(summary, 'slider').affordance.type, 'drag');
  assert.equal(nodeOf(summary, 'scroll-box').affordance.type, 'scroll');
  assert.equal(nodeOf(summary, 'dialog-close').affordance.type, 'dismiss');
  assert.equal(nodeOf(summary, 'dialog-close').affordance.confidence, 0.9, 'dialog 内关闭按钮应命中更强规则');
  assert.equal(nodeOf(summary, 'menu-trigger').affordance.type, 'hover');
  assert.equal(nodeOf(summary, 'submit').affordance.type, 'activate');
  // 每个节点都有 affordance 视图；统计与视图一致。
  assert.equal(summary.nodes.length, BASIC.nodes.length);
  const nonNone = summary.nodes.filter((node) => node.affordance.type !== 'none').length;
  assert.equal(summary.affordance.total, nonNone);
  assert.equal(summary.stats.affordanceTotal, nonNone);
  for (const node of summary.nodes) {
    assert.ok(node.affordance.confidence >= 0 && node.affordance.confidence <= 1);
    assert.ok(node.affordance.evidence.length <= 4);
    assert.ok(node.affordance.alternatives.length <= 2);
  }
});

test('collectNodeAffordances：节点视图与汇总来自同一次判定', () => {
  const collected = collectNodeAffordances(BASIC);
  assert.equal(collected.nodes.length, BASIC.nodes.length);
  assert.equal(collected.summary.total, collected.nodes.filter((node) => node.affordance.type !== 'none').length);
  const again = collectNodeAffordances(clone(BASIC));
  assert.deepEqual(collected.nodes, again.nodes, '同一 facts 两次判定必须一致');
});

// ---------------------------------------------------------------------------
// 2) relations
// ---------------------------------------------------------------------------

test('relations：ARIA 关系/标签/表单/无效状态进入关系图，source/confidence 合法', () => {
  const relations = BASIC_SUMMARY.relations;
  assert.equal(relations.version, 3);
  assert.ok(relations.relations.length >= 20, '关系太少：' + relations.relations.length);
  const byType = relations.stats.byType;
  assert.ok((byType.labels ?? 0) >= 1, 'labels 关系缺失：' + JSON.stringify(byType));
  assert.ok((byType.controls ?? 0) >= 1, 'controls 关系缺失：' + JSON.stringify(byType));
  assert.ok((byType.describes ?? 0) >= 1, 'describes 关系缺失：' + JSON.stringify(byType));
  assert.ok((byType.owns ?? 0) >= 1, 'owns(form 归属) 关系缺失：' + JSON.stringify(byType));
  assert.ok((byType.invalidates ?? 0) >= 1, 'invalidates 关系缺失：' + JSON.stringify(byType));
  const has = (type: string, from: string, to: string): boolean =>
    relations.relations.some((relation) => relation.type === type && relation.from === from && relation.to === to);
  assert.ok(has('labels', 'user-label', 'username'), 'label[for] 应产生 labels 边');
  assert.ok(has('describes', 'user-hint', 'username'));
  assert.ok(has('controls', 'city', 'city-list'));
  assert.ok(has('invalidates', 'user-error', 'username'));
  const kinds = new Set(['contains', 'labels', 'controls', 'owns', 'describes', 'invalidates']);
  for (const relation of relations.relations) {
    assert.ok(kinds.has(String(relation.type)), '非法关系类型：' + String(relation.type));
    assert.ok(relation.confidence >= 0 && relation.confidence <= 1);
    assert.ok(Array.isArray(relation.sources) && relation.sources.length > 0);
  }
  // 关系端点必须都在节点集合里（含 frame 节点）。
  const ids = new Set(BASIC_SUMMARY.nodes.map((node) => node.id));
  for (const frame of relations.frames) ids.add(frame.id);
  for (const relation of relations.relations) {
    assert.ok(ids.has(relation.from), '关系起点不存在：' + relation.from);
    assert.ok(ids.has(relation.to), '关系终点不存在：' + relation.to);
  }
});

// ---------------------------------------------------------------------------
// 3) context / groups
// ---------------------------------------------------------------------------

test('context/groups：landmark/form/table 分组与表格结构事实', () => {
  const context = BASIC_SUMMARY.context;
  assert.equal(context.version, 1);
  const byKind = context.stats.byKind;
  assert.equal(byKind.landmark, 2, 'main + region(scroll-box) 两个 landmark：' + JSON.stringify(byKind));
  assert.equal(byKind.form, 1, 'login-form：' + JSON.stringify(byKind));
  assert.equal(byKind.table, 1, 'people 表：' + JSON.stringify(byKind));
  const formGroup = context.groups.find((group) => group.kind === 'form');
  assert.ok(formGroup);
  assert.equal(formGroup?.anchorId, 'login-form');
  assert.ok(formGroup?.memberIds.includes('username'));
  assert.ok(formGroup?.memberIds.includes('submit'));
  const tableGroup = context.groups.find((group) => group.kind === 'table');
  assert.ok(tableGroup?.table);
  assert.deepEqual(tableGroup?.table?.headers.map((header) => header.name), ['姓名', '城市']);
  assert.equal(tableGroup?.table?.rowCount, 1);
  assert.equal(tableGroup?.table?.caption, '用户表');
  assert.equal(tableGroup?.table?.source, 'page-facts');
  // 上下文链：table 内的单元格同时属于 table；表单控件带 form 链。
  const usernameContext = context.contexts.find((item) => item.node === 'username');
  assert.ok(usernameContext?.kinds.includes('form'));
  const nameCellContext = context.contexts.find((item) => item.node === 'people-name');
  assert.ok(nameCellContext?.kinds.includes('table'));
  // groups 摘要与 context 自洽。
  const groups = BASIC_SUMMARY.groups;
  assert.equal(groups.version, 1);
  assert.equal(groups.total, context.groups.length);
  assert.deepEqual(groups.byKind, context.stats.byKind);
  assert.deepEqual(groups.byGroupKind, context.stats.byGroupKind);
  assert.equal(groups.parented, context.stats.parented);
  assert.equal(groups.tableHeaders, context.stats.tableHeaders);
  assert.equal(groups.shown, Math.min(context.groups.length, VOM_GROUP_DIGEST_LIMIT));
  for (const digest of groups.groups) {
    const group = context.groups.find((item) => item.id === digest.id);
    assert.ok(group, 'groups 摘要包含未知组：' + digest.id);
    assert.equal(digest.members, group?.members);
    assert.equal(digest.depth, group?.depth);
  }
});

test('summarizeVomGroups：按成员数降序、同数按 id 稳定排序', () => {
  const context = clone(BASIC_SUMMARY.context);
  context.groups.reverse();
  const groups = summarizeVomGroups(context);
  const members = groups.groups.map((group) => group.members);
  assert.deepEqual(members, [...members].sort((left, right) => right - left));
  const ties = groups.groups.filter((group, index) => index > 0 && groups.groups[index - 1]?.members === group.members);
  for (const group of ties) {
    const index = groups.groups.findIndex((item) => item.id === group.id);
    const previous = groups.groups[index - 1];
    assert.ok(previous);
    assert.ok(String(previous.id) < String(group.id), '同成员数应按 id 升序：' + previous.id + ' vs ' + group.id);
  }
  assert.deepEqual(summarizeVomGroups(null), {
    version: 1,
    source: 'packages/vom.context',
    total: 0,
    shown: 0,
    byKind: {},
    byGroupKind: {},
    parented: 0,
    framed: 0,
    tableHeaders: 0,
    truncated: false,
    groups: [],
  });
});

test('groups 摘要上限：超过 64 组时只列前 64，truncated=true（总数不撒谎）', () => {
  const elements: FakeElementSpec[] = [];
  for (let index = 0; index < 70; index += 1) {
    elements.push({
      tag: 'section',
      id: 'region-' + String(index),
      attrs: { role: 'region', 'aria-label': '区域 ' + String(index) },
      rect: { left: 0, top: index * 10, width: 200, height: 10 },
      children: [{
        tag: 'button',
        id: 'region-' + String(index) + '-button',
        type: 'button',
        text: '按钮 ' + String(index),
        rect: { left: 10, top: index * 10, width: 80, height: 8 },
      }],
    });
  }
  const summary = summaryOf(factsFromDom(elements));
  assert.equal(summary.groups.total, 70);
  assert.equal(summary.groups.groups.length, VOM_GROUP_DIGEST_LIMIT);
  assert.equal(summary.groups.shown, VOM_GROUP_DIGEST_LIMIT);
  assert.equal(summary.groups.truncated, true);
  assert.equal(summary.groups.byKind.landmark, 70);
});

// ---------------------------------------------------------------------------
// 4) stats / 自检
// ---------------------------------------------------------------------------

test('stats 与 relations/context/affordance 全部自洽', () => {
  const summary = BASIC_SUMMARY;
  assert.equal(summary.version, VOM_SUMMARY_VERSION);
  assert.equal(summary.source, 'packages/vom');
  assert.equal(summary.versions.facts, BASIC.version);
  assert.equal(summary.stats.nodes, BASIC.nodes.length);
  assert.equal(summary.stats.relations, summary.relations.relations.length);
  assert.equal(summary.stats.contextGroups, summary.context.groups.length);
  assert.equal(summary.stats.contextGroups, summary.groups.total);
  assert.equal(summary.stats.affordanceTotal, summary.affordance.total);
  assert.equal(summary.stats.edges, summary.edges.length);
  const byTypeSum = Object.values(summary.stats.byRelationType).reduce((sum, value) => sum + value, 0);
  assert.equal(byTypeSum, summary.relations.relations.length);
  assert.equal(summary.stats.truncated.relations, summary.relations.stats.truncated);
  assert.equal(summary.stats.truncated.contexts, summary.context.stats.truncated);
  assert.ok(summary.limitations.some((line) => line.includes('packages/vom')), '限制说明应写明单一实现来源');
  assert.ok(summary.limitations.some((line) => line.includes('无 CDP')), '限制说明应保留无 CDP 边界');
  assert.deepEqual(verifyVomSummary(summary), [], '摘要自检应通过');
});

test('verifyVomSummary：人为篡改必须被抓到（不是永远返回空）', () => {
  const broken = clone(BASIC_SUMMARY);
  broken.relations.relations.push({
    type: 'labels',
    from: 'ghost-from',
    to: 'ghost-to',
    confidence: 0.9,
    source: 'aria-labelledby',
    sources: ['aria-labelledby'],
  });
  const violations = verifyVomSummary(broken);
  assert.ok(violations.some((line) => line.includes('关系端点不在节点集合')), JSON.stringify(violations));

  const badAffordance = clone(BASIC_SUMMARY);
  const first = badAffordance.nodes[0];
  assert.ok(first);
  (first.affordance as unknown as { type: string }).type = 'teleport';
  assert.ok(verifyVomSummary(badAffordance).some((line) => line.includes('affordance 类型非法')));

  const badStats = clone(BASIC_SUMMARY);
  badStats.stats.relations += 1;
  assert.ok(verifyVomSummary(badStats).some((line) => line.includes('stats.relations')));

  const badGroups = clone(BASIC_SUMMARY);
  badGroups.groups.total += 1;
  assert.ok(verifyVomSummary(badGroups).some((line) => line.includes('groups.total')));

  assert.deepEqual(verifyVomSummary(null), ['摘要为空']);
});

// ---------------------------------------------------------------------------
// 5) 跨 frame / 诊断文本
// ---------------------------------------------------------------------------

test('frames 夹具：跨 frame 关系与上下文摘要（frame 节点参与）', () => {
  const summary = summaryOf(readFixture('frames'));
  assert.equal(summary.stats.frames, 3);
  assert.ok(summary.relations.stats.frameRelations >= 1, '应有跨 frame 关系：' + JSON.stringify(summary.relations.stats));
  assert.equal(summary.relations.frames.length, 3);
  assert.equal(summary.context.frames.length, 3);
  const frameIds = summary.relations.frames.map((frame) => frame.id).sort();
  assert.deepEqual(frameIds, ['frame:0', 'frame:5', 'frame:9']);
  assert.ok(summary.relations.relations.some((relation) => relation.frame === true), '关系上应有 frame 标记');
  assert.deepEqual(verifyVomSummary(summary), []);
});

test('renderVomSummaryText：一行文本包含关键计数（不替代结构化字段）', () => {
  const text = renderVomSummaryText(BASIC_SUMMARY);
  assert.match(text, /^VOM: nodes=\d+/);
  assert.ok(text.includes('relations=' + String(BASIC_SUMMARY.stats.relations)));
  assert.ok(text.includes('groups=' + String(BASIC_SUMMARY.groups.total)));
  assert.ok(text.includes('affordance=' + String(BASIC_SUMMARY.affordance.total)));
  assert.equal(renderVomSummaryText(null), 'VOM: (none)');
});

test('空 facts：摘要为空且自检通过（不抛异常）', () => {
  const summary = summaryOf({
    version: 1,
    url: 'https://example.test/empty.html',
    title: '',
    frameId: 0,
    nodes: [],
    frames: [],
    limits: { nodes: 900, ancestors: 32, edges: 1500, frames: 16, relations: 600, groups: 200, contexts: 200, chainDepth: 3 },
    truncated: false,
    limitations: [],
  });
  assert.equal(summary.nodes.length, 0);
  assert.equal(summary.affordance.total, 0);
  assert.equal(summary.relations.relations.length, 0);
  assert.equal(summary.groups.total, 0);
  assert.deepEqual(verifyVomSummary(summary), []);
});
