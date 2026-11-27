// tests/content-observe-closed-shadow.test.ts —— observe 的 closed shadow / unmappedAx / cdpSessionId 接线（20v、5f、35b）。
//
// 覆盖点（内容脚本侧只做“接收/合并”，数据源在 background 的 CDP）：
// - closed shadow 候选 → 编号接在主文档 ref 之后（@eN）+ 观察行 + 回传条目；
// - unmappedAx 形状（role/name/backendNodeId/bounds/source）与“未映射的可交互元素”段；
// - cdpSessionId 语义 `tabId:frameId`（主文档 :0）与 rich 节点 stableRef 的同算法一致性；
// - 注册表：closed shadow ref 的 source/backendNodeId 便于 background 路由到 CDP pierce。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentSession } from '../src/content/session.ts';
import { makeContentRequest, type ContentObserveResult } from '../src/content/protocol.ts';
import { createFakeDom, fixtureElements, type FakeElementSpec } from './support/fake-dom.ts';
import {
  RefRegistry,
  backendNodeIdOf,
  makeCdpSessionId,
  refIdentityKeyOf,
  refIdentityOf,
  refSourceOf,
  refStableRefOf,
  registerClosedShadowRefs,
} from '../src/refs/registry.ts';
import { toObserveActionResult } from '../src/actions/observation.ts';

let requestSeq = 0;

function makeSession(
  elements: FakeElementSpec[] = fixtureElements(),
  documentId = 'doc-test',
): { session: ContentSession; dom: ReturnType<typeof createFakeDom> } {
  const dom = createFakeDom(elements);
  const session = new ContentSession(dom.env, { protocol: '1.9', documentId });
  return { session, dom };
}

function observe(session: ContentSession, params: Record<string, unknown> = {}): ContentObserveResult {
  requestSeq += 1;
  const reply = session.handle(makeContentRequest('observe', params, 'req-observe-' + String(requestSeq)));
  assert.equal(reply.ok, true, 'observe 应成功：' + JSON.stringify(reply));
  return (reply as { ok: true; result: ContentObserveResult }).result;
}

interface RichBag {
  closedShadow?: Array<Record<string, unknown>>;
  unmappedAx?: Array<Record<string, unknown>>;
  vomWeights?: Record<string, unknown>;
  observation?: string;
  nodes?: Array<Record<string, unknown>>;
  cdpSessionId?: string | null;
  axNodes?: unknown[];
}

function richOf(result: ContentObserveResult): RichBag {
  return (result.richResult ?? {}) as RichBag;
}

test('20v：closed shadow 候选编号接在主文档 ref 之后，观察行带 ref + (closed shadow)', () => {
  const { session } = makeSession();
  const result = observe(session, {
    closedShadow: true,
    closedShadowNodes: [{ text: '封闭按钮', tag: 'button', backendNodeId: 777 }],
  });
  assert.equal(result.refs, 4, 'closed shadow 不占用主文档 ref 计数');
  const line = result.observation.split('\n').find((item) => item.includes('封闭按钮'));
  assert.ok(line, '观察文本缺少 closed shadow 行：' + result.observation);
  assert.match(line ?? '', /@e5/);
  assert.match(line ?? '', /closed shadow/);
  // 条目随 richResult 上抛（background 用 ref/backendNodeId 登记 + 路由 CDP pierce）。
  const entries = richOf(result).closedShadow ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.ref, '@e5');
  assert.equal(entries[0]?.backendNodeId, 777);
  assert.equal(entries[0]?.tag, 'button');
  assert.equal(entries[0]?.via, 'closed-shadow-ref');
  assert.equal(entries[0]?.source, 'closed-shadow');
  assert.equal(result.closedShadow?.[0]?.ref, '@e5', '顶层也应带 closedShadow（daemon 透传）');
  // 内容脚本不能解析闭树 ref：ref 表只含主文档 4 个句柄。
  assert.deepEqual(session.refHandles(), ['@e1', '@e2', '@e3', '@e4']);
});

test('20v：closed shadow 支持数组形式的 closedShadow 参数，并按顺序续编号', () => {
  const { session } = makeSession();
  const result = observe(session, {
    closedShadow: [
      { text: '封闭按钮', tag: 'button', backendNodeId: 801 },
      { text: '封闭链接', tag: 'a', backendNodeId: 802, role: 'link' },
    ],
  });
  const entries = richOf(result).closedShadow ?? [];
  assert.deepEqual(entries.map((entry) => entry.ref), ['@e5', '@e6']);
  assert.deepEqual(entries.map((entry) => entry.role), ['button', 'link']);
  assert.match(result.observation, /@e6 a "封闭链接"/);
});

test('5f：unmappedAx 形状完整，观察文本追加“未映射的可交互元素”段且不带 ref', () => {
  const { session } = makeSession();
  const result = observe(session, {
    ax: true,
    unmappedAx: [{
      role: 'button',
      name: 'AX only button',
      backendNodeId: 9001,
      bounds: { x: 20, y: 20, width: 120, height: 32 },
      source: 'dom-aria',
    }],
  });
  const entries = result.unmappedAx ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.role, 'button');
  assert.equal(entries[0]?.name, 'AX only button');
  assert.equal(entries[0]?.backendNodeId, 9001);
  assert.equal(entries[0]?.bounds?.width, 120);
  assert.equal(entries[0]?.source, 'dom-aria');
  assert.ok(result.observation.includes('未映射的可交互元素'), '缺少未映射段：' + result.observation);
  assert.ok(result.observation.includes('AX only button'));
  assert.ok(!result.observation.includes('[@e9001]'), '未映射元素不应带 ref 标记');
  // axNodes 等既有字段不受影响。
  assert.ok(Array.isArray(result.richResult?.axNodes));
});

test('5f：只给 closed shadow 候选时（--ax）派生 unmappedAx（source=closed-shadow）', () => {
  const { session } = makeSession();
  const result = observe(session, {
    ax: true,
    closedShadowNodes: [{
      text: 'AX only button',
      tag: 'button',
      backendNodeId: 9002,
      bounds: { x: 20, y: 20, width: 120, height: 32 },
    }],
  });
  const entries = result.unmappedAx ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.source, 'closed-shadow');
  assert.equal(entries[0]?.role, 'button');
  assert.equal(entries[0]?.name, 'AX only button');
  assert.equal(entries[0]?.bounds?.width, 120);
  assert.ok(result.observation.includes('未映射的可交互元素'));
  // closed shadow 与 unmappedAx 同时存在时互不吞并。
  assert.equal((richOf(result).closedShadow ?? []).length, 1);
});

test('35b：cdpSessionId 回显语义 tabId:frameId，主文档以 :0 结尾', () => {
  const { session } = makeSession();
  const explicit = observe(session, { cdpSessionId: '42:0' });
  assert.equal(explicit.cdpSessionId, '42:0');
  assert.equal(richOf(explicit).cdpSessionId, undefined, 'rich 载荷不重复写 cdpSessionId');
  // 内容脚本不从 tabId 自己推导（避免与 background refDetails 的 identity 漂移）。
  const withoutExplicit = observe(session, { tabId: 7 });
  assert.equal(withoutExplicit.cdpSessionId, undefined);
  const missing = observe(session, {});
  assert.equal(missing.cdpSessionId, undefined);
  assert.equal(makeCdpSessionId(7, 0), '7:0');
  assert.equal(makeCdpSessionId(7, 3), '7:3');
});

test('35b/5b：--vom 节点 stableRef 与 background refDetails 逐字符一致（同一套 identity/hash）', () => {
  const { session } = makeSession();
  const result = observe(session, { vom: true, cdpSessionId: '42:0' });
  const nodes = result.nodes as unknown as Array<Record<string, unknown>>;
  assert.ok(nodes.length >= 4);
  const details = toObserveActionResult(result, {
    tabId: 42,
    context: { documentId: 'doc-test', frameId: 0, cdpSessionId: '42:0' },
  }).action.refDetails;
  assert.equal(details.length, result.refs);
  assert.ok(details.every((detail) => detail.cdpSessionId === '42:0'), 'refDetails 应带 cdpSessionId');
  for (const detail of details) {
    const node = nodes.find((item) => item.ref === detail.ref);
    assert.ok(node, 'refDetails 的 ref 必须在 nodes 里：' + detail.ref);
    assert.match(String(node?.stableRef ?? ''), /^s-[a-z0-9]+$/);
    assert.equal(node?.stableRef, detail.stableRef, '节点 stableRef 与 refDetails 不一致：' + detail.ref);
  }
  // 手工用共享函数复算，证明不是“两边各算一次碰巧相等”。
  const button = nodes.find((item) => item.role === 'button');
  assert.ok(button);
  const identity = refIdentityOf({
    cdpSessionId: '42:0',
    documentId: 'doc-test',
    frameId: 0,
    tag: String(button?.tag ?? ''),
    id: String(button?.id ?? ''),
    role: String(button?.role ?? ''),
    name: String(button?.name ?? ''),
  });
  assert.equal(refIdentityKeyOf(identity).startsWith('i-'), true);
  assert.equal(refStableRefOf(identity, 1), button?.stableRef);
});

test('5b：未接 cdpSessionId 时，节点 stableRef 仍与 background refDetails 一致（零漂移）', () => {
  const { session } = makeSession();
  const result = observe(session, { vom: true });
  const nodes = result.nodes as unknown as Array<Record<string, unknown>>;
  const { action, input } = toObserveActionResult(result, {
    tabId: 42,
    context: { documentId: 'doc-test' },
  });
  assert.ok(action.refDetails.length > 0);
  assert.ok(action.refDetails.every((detail) => detail.cdpSessionId === null));
  for (const detail of action.refDetails) {
    const node = nodes.find((item) => item.ref === detail.ref);
    assert.equal(node?.stableRef, detail.stableRef, 'stableRef 漂移：' + detail.ref);
  }
  // 用 ref 注册表复现 E2E 5b 的 refs negotiate：stableRef → ref 且 ok=true。
  const registry = new RefRegistry();
  registry.registerObservation(42, input);
  const button = nodes.find((item) => item.role === 'button');
  assert.ok(button);
  const negotiated = registry.negotiate(42, [String(button?.stableRef)], {
    documentId: 'doc-test',
    revision: result.revision,
  });
  assert.equal(negotiated.refs[0]?.ok, true, 'stableRef 协商失败：' + JSON.stringify(negotiated.refs));
  assert.equal(negotiated.refs[0]?.ref, button?.ref);
});

test('registry：closed shadow ref 登记 source/backendNodeId，主文档 ref 默认 dom', () => {
  const registry = new RefRegistry();
  const registered = registry.registerObservation(42, {
    documentId: 'doc-test',
    revision: 3,
    frameId: 0,
    cdpSessionId: '42:0',
    refs: [
      { ref: '@e1', role: 'button', name: '提交查询', backendNodeId: null, identity: 'btn' },
    ],
  });
  assert.equal(registered.registered, 1);
  assert.equal(refSourceOf(registry, 42, '@e1'), 'dom');
  const shadow = registerClosedShadowRefs(registry, 42, {
    documentId: 'doc-test',
    revision: 3,
    frameId: 0,
    cdpSessionId: '42:0',
  }, [
    { ref: '@e5', text: '封闭按钮', tag: 'button', role: 'button', backendNodeId: 777 },
  ]);
  assert.equal(shadow.registered, 1);
  assert.deepEqual(shadow.refs, ['@e5']);
  assert.equal(backendNodeIdOf(registry, 42, '@e5'), 777);
  assert.equal(refSourceOf(registry, 42, '@e5'), 'closed-shadow');
  const resolved = registry.resolve(42, '@e5');
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.meta.source, 'closed-shadow');
    assert.equal(resolved.meta.key.backendNodeId, 777);
    assert.equal(resolved.meta.name, '封闭按钮');
  }
  // 没有 documentId 时不登记（不阻塞 observe）。
  const skipped = registerClosedShadowRefs(registry, 42, { documentId: null }, [{ ref: '@e6', text: 'x' }]);
  assert.equal(skipped.registered, 0);
  assert.equal(skipped.skipped, 1);
  const negotiated = registry.negotiate(42, [], { documentId: 'doc-test', revision: 3 });
  assert.equal(negotiated.ok, true);
  assert.equal(negotiated.refs.length, 0);
});
