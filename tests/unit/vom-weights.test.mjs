import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreVomNode, attachVomScores, rankVomNodes, filterVomNodes, selectVomNodes, estimateVomTokens, estimateTextTokens, DEFAULT_VOM_WEIGHTS, VOM_WEIGHTS_VERSION } from '../../extension/src/lib/vom-weights.js';

test('scoreVomNode：交互/语义/表单加分，屏外减分', () => {
  const button = scoreVomNode({ interactive: true, role: 'button', name: '提交', rect: { x: 10, y: 10, w: 80, h: 30 }, depth: 2 });
  const offscreen = scoreVomNode({ interactive: false, name: '', rect: { x: -5000, y: -5000, w: 0, h: 0 }, depth: 2 });
  assert.ok(button.score > offscreen.score, JSON.stringify({ button, offscreen }));
  assert.ok(button.factors.some((factor) => factor.name === 'interactive'));
  assert.equal(VOM_WEIGHTS_VERSION, 1);
  assert.ok(DEFAULT_VOM_WEIGHTS.interactive > 0);
});

test('attachVomScores 不改变顺序，rankVomNodes 按分数排序', () => {
  const nodes = [
    { id: 'low', interactive: false, name: '', rect: { x: 0, y: 0, w: 0, h: 0 } },
    { id: 'high', interactive: true, role: 'button', name: 'OK', rect: { x: 0, y: 0, w: 80, h: 30 } },
  ];
  const scored = attachVomScores(nodes);
  assert.deepEqual(scored.map((node) => node.id), ['low', 'high']);
  assert.ok(scored.every((node) => Number.isInteger(node.vomScore)));
  assert.deepEqual(rankVomNodes(scored).map((node) => node.id), ['high', 'low']);
  assert.deepEqual(rankVomNodes(scored, { limit: 1 }).map((node) => node.id), ['high']);
});

test('filterVomNodes 按分数下限过滤', () => {
  const nodes = [{ vomScore: 5 }, { vomScore: 20 }, { vomScore: 35 }];
  assert.deepEqual(filterVomNodes(nodes, 10).map((node) => node.vomScore), [20, 35]);
  assert.equal(filterVomNodes(null, 10).length, 0);
});

test('selectVomNodes 按节点数/token 预算截断', () => {
  const nodes = [
    { id: 'a', name: 'aa', role: 'button' },
    { id: 'b', name: 'bb', role: 'button' },
    { id: 'c', name: 'cc', role: 'button' },
  ];
  const byNodes = selectVomNodes(nodes, { maxNodes: 2 });
  assert.deepEqual(byNodes.nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(byNodes.dropped, { nodes: 1, tokens: estimateVomTokens(nodes[2]) });
  const all = selectVomNodes(nodes, {});
  assert.equal(all.nodes.length, 3);
  assert.deepEqual(all.dropped, { nodes: 0, tokens: 0 });
  const byTokens = selectVomNodes(nodes, { maxTokens: estimateVomTokens(nodes[0]) + estimateVomTokens(nodes[1]) });
  assert.equal(byTokens.nodes.length, 2);
});

test('estimateTextTokens CJK 感知', () => {
  assert.equal(estimateTextTokens('提交'), 3);
  assert.equal(estimateTextTokens('hello world'), 3);
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('😀'), 3);
  assert.ok(estimateTextTokens('😀') > estimateTextTokens('a'));
  assert.equal(estimateVomTokens({ name: '提交', role: 'button' }), 12);
});

test('scoreVomNode 对 disabled 节点扣分', () => {
  const base = scoreVomNode({ interactive: true, role: 'button', name: '提交' });
  const disabled = scoreVomNode({ interactive: true, role: 'button', name: '提交', disabled: true });
  assert.equal(disabled.score, base.score - 30);
  assert.ok(disabled.factors.some((factor) => factor.name === 'disabled'));
});

test('scoreVomNode 对 focused 节点加分', () => {
  const base = scoreVomNode({ interactive: true, role: 'button', name: '提交' });
  const focused = scoreVomNode({ interactive: true, role: 'button', name: '提交', focused: true });
  assert.equal(focused.score, base.score + 6);
  assert.ok(focused.factors.some((factor) => factor.name === 'focused'));
});

test('scoreVomNode 对 occluded 节点扣分', () => {
  const base = scoreVomNode({ interactive: true, role: 'button', name: '提交', clickable: true });
  const occluded = scoreVomNode({ interactive: true, role: 'button', name: '提交', clickable: true, hitTest: 'blocked' });
  assert.equal(occluded.score, base.score - 10);
  assert.ok(occluded.factors.some((factor) => factor.name === 'occluded'));
});

test('scoreVomNode 对表单内节点加分', () => {
  const base = scoreVomNode({ interactive: true, role: 'textbox', name: '关键词' });
  const inForm = scoreVomNode({ interactive: true, role: 'textbox', name: '关键词', inForm: true });
  assert.equal(inForm.score, base.score + 4);
  assert.ok(inForm.factors.some((factor) => factor.name === 'inForm'));
});

test('scoreVomNode 对 required 节点加分', () => {
  const base = scoreVomNode({ interactive: true, role: 'textbox', name: '邮箱' });
  const required = scoreVomNode({ interactive: true, role: 'textbox', name: '邮箱', required: true });
  assert.equal(required.score, base.score + 3);
  assert.ok(required.factors.some((factor) => factor.name === 'required'));
});

test('scoreVomNode 对 landmark 后代加分', () => {
  const base = scoreVomNode({ interactive: true, role: 'button', name: '提交' });
  const landmark = scoreVomNode({ interactive: true, role: 'button', name: '提交', ancestors: [{ tag: 'nav', role: 'navigation' }] });
  assert.equal(landmark.score, base.score + 2);
  assert.ok(landmark.factors.some((factor) => factor.name === 'landmark'));
});

test('scoreVomNode 对 selected/expanded/checked 加分', () => {
  const baseOption = scoreVomNode({ interactive: true, role: 'option', name: 'A' });
  const selected = scoreVomNode({ interactive: true, role: 'option', name: 'A', selected: true });
  const baseButton = scoreVomNode({ interactive: true, role: 'button', name: 'A' });
  const expanded = scoreVomNode({ interactive: true, role: 'button', name: 'A', expanded: true });
  const baseCheckbox = scoreVomNode({ interactive: true, role: 'checkbox', name: 'A' });
  const checked = scoreVomNode({ interactive: true, role: 'checkbox', name: 'A', checked: true });
  assert.equal(selected.score, baseOption.score + 8);
  assert.equal(expanded.score, baseButton.score + 2);
  assert.equal(checked.score, baseCheckbox.score + 2);
});

test('scoreVomNode 对 invalid 加分', () => {
  const base = scoreVomNode({ interactive: true, role: 'textbox', name: '邮箱' });
  const invalid = scoreVomNode({ interactive: true, role: 'textbox', name: '邮箱', invalid: true });
  assert.equal(invalid.score, base.score + 4);
  assert.ok(invalid.factors.some((factor) => factor.name === 'invalid'));
});

test('scoreVomNode 对 live region 加分', () => {
  const base = scoreVomNode({ role: 'status', name: '提示' });
  const live = scoreVomNode({ role: 'status', name: '提示', ariaLive: 'polite' });
  assert.equal(live.score, base.score + 2);
});

test('scoreVomNode 对 aria-hidden 按 hidden 同罚', () => {
  const base = scoreVomNode({ role: 'button', name: 'x' });
  const hidden = scoreVomNode({ role: 'button', name: 'x', ariaHidden: true });
  assert.equal(hidden.score, base.score - 70);
});

test('scoreVomNode 对 heading 加分', () => {
  const base = scoreVomNode({ tag: 'div', role: 'heading', name: '标题' });
  const heading = scoreVomNode({ tag: 'h2', role: 'heading', name: '标题' });
  assert.equal(heading.score, base.score + 6);
  assert.ok(heading.factors.some((factor) => factor.name === 'heading'));
});

test('scoreVomNode 对低对比度减分', () => {
  const base = scoreVomNode({ tag: 'p', role: 'paragraph', name: '文本' });
  const low = scoreVomNode({ tag: 'p', role: 'paragraph', name: '文本', lowContrast: true });
  assert.equal(low.score, base.score - 2);
});

test('scoreVomNode 对有描述的控件加分', () => {
  const base = scoreVomNode({ role: 'textbox', name: '邮箱' });
  const described = scoreVomNode({ role: 'textbox', name: '邮箱', ariaDescribedBy: 'hint' });
  assert.equal(described.score, base.score + 1);
});

test('scoreVomNode 对有 controls 关系的控件加分', () => {
  const base = scoreVomNode({ role: 'button', name: '菜单' });
  const controls = scoreVomNode({ role: 'button', name: '菜单', ariaControls: 'menu' });
  assert.equal(controls.score, base.score + 1);
});

test('scoreVomNode 对 aria-labelledby 加分', () => {
  const base = scoreVomNode({ role: 'button', name: '提交' });
  const labelled = scoreVomNode({ role: 'button', name: '提交', ariaLabelledBy: 'lbl' });
  assert.equal(labelled.score, base.score + 1);
});

test('scoreVomNode 对 aria-pressed/aria-current 加分', () => {
  const base = scoreVomNode({ role: 'button', name: 'A' });
  const pressed = scoreVomNode({ role: 'button', name: 'A', ariaPressed: true });
  const current = scoreVomNode({ role: 'link', name: 'A', ariaCurrent: 'page' });
  assert.equal(pressed.score, base.score + 2);
  assert.equal(current.score, scoreVomNode({ role: 'link', name: 'A' }).score + 3);
});

test('scoreVomNode 对 aria-haspopup 加分', () => {
  const base = scoreVomNode({ role: 'button', name: '菜单' });
  const popup = scoreVomNode({ role: 'button', name: '菜单', ariaHasPopup: 'menu' });
  assert.equal(popup.score, base.score + 1);
});

test('scoreVomNode 对 h1/h2 额外加分', () => {
  const h2 = scoreVomNode({ tag: 'h2', role: 'heading', name: '标题' });
  const h3 = scoreVomNode({ tag: 'h3', role: 'heading', name: '标题' });
  assert.equal(h2.score, h3.score + 2);
});

test('scoreVomNode 对 aria-valuenow 加分', () => {
  const base = scoreVomNode({ role: 'slider', name: '音量' });
  const range = scoreVomNode({ role: 'slider', name: '音量', ariaValueNow: 50 });
  assert.equal(range.score, base.score + 1);
});
