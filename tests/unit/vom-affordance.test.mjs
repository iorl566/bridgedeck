// VOM affordance 类型化：规则、置信度、证据、payload/graph 接入，以及 stableRef 协商回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AFFORDANCE_TYPES,
  AFFORDANCE_VERSION,
  affordanceForNode,
  summarizeAffordances,
} from '../../extension/src/lib/vom-affordance.js';
import { buildVomPayload } from '../../extension/src/lib/vom-payload.js';
import { buildVomGraph } from '../../extension/src/lib/vom-graph.js';
import { estimateVomTokens } from '../../extension/src/lib/vom-weights.js';
import {
  RefRegistry,
  makeStabilitySignature,
  sameStabilitySignature,
} from '../../extension/src/refs/ref-registry.js';

const typeOf = (node) => affordanceForNode(node).type;

test('affordance：activate/type/toggle/select 基础规则', () => {
  assert.equal(typeOf({ role: 'button', tag: 'button', name: '提交' }), 'activate');
  assert.equal(typeOf({ role: 'link', tag: 'a', href: 'https://example.test/' }), 'activate');
  assert.equal(typeOf({ role: 'textbox', tag: 'input', inputType: 'text' }), 'type');
  assert.equal(typeOf({ role: 'textbox', tag: 'textarea' }), 'type');
  assert.equal(typeOf({ role: 'textbox', tag: 'div', contentEditable: true }), 'type');
  assert.equal(typeOf({ role: 'checkbox', tag: 'input', inputType: 'checkbox' }), 'toggle');
  assert.equal(typeOf({ role: 'radio', tag: 'input', inputType: 'radio' }), 'toggle');
  assert.equal(typeOf({ role: 'switch', tag: 'button' }), 'toggle');
  assert.equal(typeOf({ role: 'button', tag: 'summary', name: '详情' }), 'toggle');
  assert.equal(typeOf({ role: 'button', tag: 'button', name: '加粗', ariaPressed: true }), 'toggle');
  assert.equal(typeOf({ role: 'combobox', tag: 'select' }), 'select');
  assert.equal(typeOf({ role: 'combobox', tag: 'div', ariaHasPopup: 'listbox' }), 'select');
  assert.equal(typeOf({ role: 'listbox', tag: 'div' }), 'select');
});

test('affordance：drag/scroll/dismiss/hover/upload/focus', () => {
  assert.equal(typeOf({ role: 'button', tag: 'div', draggable: true }), 'drag');
  assert.equal(typeOf({ role: 'slider', tag: 'div', ariaValueNow: 5 }), 'drag');
  assert.equal(typeOf({ role: 'region', tag: 'div', scrollable: true }), 'scroll');
  assert.equal(typeOf({ role: 'region', tag: 'div', overflow: 'auto' }), 'scroll');
  assert.equal(typeOf({ role: 'dialog', tag: 'dialog' }), 'dismiss');
  assert.equal(typeOf({ role: 'button', tag: 'button', name: '关闭', ancestors: [{ tag: 'dialog', role: null }] }), 'dismiss');
  assert.equal(typeOf({ role: 'menuitem', tag: 'div', ariaHasPopup: 'menu', expanded: false }), 'hover');
  assert.equal(typeOf({ role: 'button', tag: 'input', inputType: 'file' }), 'upload');
  const text = affordanceForNode({ role: 'textbox', tag: 'input', inputType: 'search' });
  assert.equal(text.type, 'type');
  assert.ok(text.alternatives.some((item) => item.type === 'focus'), '输入框应给出 focus 备选');
  assert.equal(typeOf({ role: 'paragraph', tag: 'p', name: '正文' }), 'none');
  assert.equal(typeOf(null), 'none');
});

test('affordance：confidence 与 evidence 形状（规则名 + 命中字段）', () => {
  for (const node of [
    { role: 'button', tag: 'button', name: '提交' },
    { role: 'textbox', tag: 'input', inputType: 'email' },
    { role: 'checkbox', tag: 'input', inputType: 'checkbox' },
    { role: 'dialog', tag: 'dialog' },
  ]) {
    const result = affordanceForNode(node);
    assert.ok(AFFORDANCE_TYPES.includes(result.type), '非法 type：' + result.type);
    assert.ok(result.confidence > 0 && result.confidence <= 1, 'confidence 越界：' + result.confidence);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0, '缺少 evidence');
    for (const item of result.evidence) {
      assert.equal(typeof item.rule, 'string');
      assert.ok(item.rule.length > 0);
      assert.equal(typeof item.field, 'string');
      assert.ok(item.field.length > 0);
    }
    assert.ok(Array.isArray(result.alternatives));
  }
  const checkbox = affordanceForNode({ role: 'checkbox', tag: 'input', inputType: 'checkbox' });
  assert.ok(checkbox.confidence >= 0.9);
  assert.ok(checkbox.evidence.some((item) => item.field === 'inputType' && item.value === 'checkbox'));
  assert.deepEqual(affordanceForNode({ role: 'paragraph', tag: 'p' }), { type: 'none', confidence: 0, evidence: [], alternatives: [] });
});

test('summarizeAffordances：按类型计数', () => {
  const summary = summarizeAffordances([
    { role: 'button', tag: 'button', name: 'a' },
    { role: 'button', tag: 'button', name: 'b' },
    { role: 'checkbox', tag: 'input', inputType: 'checkbox' },
    { role: 'paragraph', tag: 'p' },
  ]);
  assert.equal(summary.version, AFFORDANCE_VERSION);
  assert.equal(summary.total, 3);
  assert.equal(summary.byType.activate, 2);
  assert.equal(summary.byType.toggle, 1);
});

test('payload/graph 输出带 affordance，既有字段与计费不变', () => {
  const nodes = [
    { ref: '@e1', backendNodeId: 2, role: 'button', tag: 'button', name: '提交', bounds: { x: 1, y: 2, width: 3, height: 4 }, clickable: true, vomScore: 42, vomFactors: ['interactive'] },
    { ref: '@e2', backendNodeId: 3, role: 'textbox', tag: 'input', inputType: 'text', name: '关键词' },
  ];
  const payload = buildVomPayload({ nodes, documentId: 'https://x', revision: 7 });
  assert.equal(payload.nodes[0].affordance.type, 'activate');
  assert.equal(payload.nodes[1].affordance.type, 'type');
  assert.equal(payload.nodes[0].clickable, true);
  assert.equal(payload.nodes[0].vomScore, 42);
  assert.deepEqual(payload.nodes[0].vomFactors, ['interactive']);
  // 计费只按 name+role 估算，payload 的多出的 affordance 字段不改变 token 成本。
  assert.equal(estimateVomTokens(payload.nodes[0]), estimateVomTokens(nodes[0]));

  const graph = { nodes: [{ key: 'n1', ref: '@e1', tag: 'button', role: 'button', parentKey: null }], edges: [] };
  const built = buildVomGraph({ graph, nodes: [nodes[0]] });
  assert.equal(built.payload.nodes[0].affordance.type, 'activate');
  assert.equal(built.payload.nodes[0].id, '@e1');
});

// ---- stableRef 协商：generation/revision + 稳定性签名（文档变化必须失效） ----

test('稳定性签名：documentId 变化换签名，revision 不影响', () => {
  const a = makeStabilitySignature({ backendNodeId: 11, frameId: 0, cdpSessionId: 's', documentId: 'doc-a', revision: 1 });
  const b = makeStabilitySignature({ backendNodeId: 11, frameId: 0, cdpSessionId: 's', documentId: 'doc-a', revision: 9 });
  const c = makeStabilitySignature({ backendNodeId: 11, frameId: 0, cdpSessionId: 's', documentId: 'doc-b', revision: 9 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(sameStabilitySignature(a, b), true);
  assert.equal(sameStabilitySignature(a, c), false);
  assert.equal(a.startsWith('sig:'), true);
  assert.throws(() => makeStabilitySignature({ backendNodeId: 1 }), /documentId/);
});

test('RefRegistry：文档变化推进 generation 并让旧 stableRef 判定失效', () => {
  const registry = new RefRegistry({ now: () => 1000 });
  registry.register(9, '@e1', { backendNodeId: 11, frameId: 0, cdpSessionId: 's', documentId: 'doc-a', revision: 1 }, { stableRef: 's-1', role: 'button', name: '提交' });
  const entry = registry.getByStableRef(9, 's-1');
  assert.ok(entry.signature.startsWith('sig:'));
  assert.equal(entry.generation, registry.generationOf(9));
  assert.ok(registry.getBySignature(9, entry.signature));

  // 同一份文档、revision 前进：只报 stale_revision，不算文档变化。
  const sameDoc = registry.negotiate(9, ['s-1'], { documentId: 'doc-a', revision: 2, generation: registry.generationOf(9) });
  assert.equal(sameDoc.refs[0].ok, false);
  assert.equal(sameDoc.refs[0].reason, 'stale_revision');
  assert.equal(sameDoc.refs[0].renegotiate, true);

  // 文档变化：noteDocument 推进 generation，旧 stableRef 必须 stale_document + 重协商。
  const noted = registry.noteDocument(9, 'doc-b');
  assert.equal(noted.changed, true);
  assert.ok(noted.generation > entry.generation);
  const changed = registry.negotiate(9, ['s-1'], { documentId: 'doc-b', revision: 2 });
  assert.equal(changed.refs[0].ok, false);
  assert.equal(changed.refs[0].reason, 'stale_document');
  assert.equal(changed.refs[0].renegotiate, true);
  assert.equal(changed.refs[0].signature, entry.signature);

  // 未登记的 stableRef：not_found + 重协商。
  const missing = registry.negotiate(9, ['s-missing'], { documentId: 'doc-b', revision: 2 });
  assert.equal(missing.refs[0].reason, 'not_found');
  assert.equal(missing.refs[0].renegotiate, true);

  // 重新登记新文档后旧代引用不再命中，新 stableRef 在当前文档可用。
  registry.invalidateDocument(9, 'doc-a');
  registry.register(9, '@e2', { backendNodeId: 12, frameId: 0, cdpSessionId: 's', documentId: 'doc-b', revision: 2 }, { stableRef: 's-2' });
  const fresh = registry.negotiate(9, ['s-2'], { documentId: 'doc-b', revision: 2, generation: registry.generationOf(9) });
  assert.equal(fresh.refs[0].ok, true);
  assert.equal(fresh.refs[0].stableRef, 's-2');
  assert.equal(fresh.refs[0].generation, registry.generationOf(9));
  assert.equal(fresh.refs[0].renegotiate, false);
});

test('RefRegistry resolve：generation/签名不匹配即拒绝，既有 document/revision 行为不变', () => {
  const registry = new RefRegistry();
  const key = registry.register(1, '@e1', { backendNodeId: 5, frameId: 0, cdpSessionId: 's', documentId: 'd', revision: 4 });
  const entry = registry.get(1, '@e1');
  assert.equal(registry.resolve(1, '@e1', { documentId: 'd', revision: 4 }).ok, true);
  assert.equal(registry.resolve(1, '@e1', { revision: 5 }).ok, false);
  assert.equal(registry.resolve(1, '@e1', { documentId: 'other' }).ok, false);
  assert.equal(registry.resolve(1, '@e1', { generation: key.generation + 1 }).ok, false);
  assert.equal(registry.resolve(1, '@e1', { signature: 'sig:bogus' }).ok, false);
  assert.equal(registry.resolve(1, '@e1', { signature: entry.signature }).ok, true);
  assert.equal(registry.resolve(1, '@e2').ok, false);
});
