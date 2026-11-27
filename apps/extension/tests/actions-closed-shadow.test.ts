// tests/actions-closed-shadow.test.ts —— R2b 跨路接线：observe 候选透传 / refDetails 事实 /
// closed shadow ref 登记与 pierce 动作路由（20v / 5f / 35b）。
//
// 这 4 处属 actions 写域（R2b 不能改 actions/**）：
// 1) params.ts observe 归一放行 closedShadowNodes/unmappedAx/cdpSessionId；
// 2) finishObserve 给 refDetails 写 cdpSessionId（tabId:0）并回填 hitTest/occludedBy/
//    inViewport/pointerEvents（只改展示字段，不改 identity/stableRef）；
// 3) registerObservation 之后登记 closed shadow ref（source='closed-shadow'）；
// 4) dispatch 对 closed-shadow ref 走注入的 pierce（clickRefNode/readRefNode），
//    未注入时 E_UNSUPPORTED_CAPABILITY。

import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodError } from '../src/rpc/registry.ts';
import { ActionRegistry, type PierceRefRouter } from '../src/actions/registry.ts';
import { normalizePageAction } from '../src/actions/params.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { StubContentTransport } from './support/stub-content.ts';

const OBSERVE_WITH_FACTS = {
  url: 'https://example.test/',
  title: '示例',
  observation: '- textbox "关键词" [@e1]\n- button "提交查询" [@e2]',
  refs: 2,
  revision: 3,
  documentId: 'doc-a',
  nodes: [
    {
      ref: '@e1',
      role: 'textbox',
      name: '关键词',
      tag: 'input',
      id: 'kw',
      hitTest: 'self',
      occludedBy: null,
      inViewport: true,
      pointerEvents: 'auto',
    },
    {
      ref: '@e2',
      role: 'button',
      name: '提交查询',
      tag: 'button',
      id: 'submit-btn',
      hitTest: 'blocked',
      occludedBy: { tag: 'div', role: null, id: 'cover', name: null },
      inViewport: true,
      pointerEvents: 'auto',
    },
  ],
  richResult: {
    closedShadow: [
      {
        ref: '@e3',
        text: '封闭按钮',
        tag: 'button',
        role: 'button',
        name: '封闭按钮',
        backendNodeId: 777,
        via: 'closed-shadow-ref',
        source: 'closed-shadow',
      },
    ],
    unmappedAx: [],
  },
};

function makeHarness(options: { pierce?: PierceRefRouter | null } = {}): {
  registry: ActionRegistry;
  content: StubContentTransport;
  refs: RefRegistry;
} {
  const content = new StubContentTransport();
  content.set('observe', () => ({ ok: true, result: { ...OBSERVE_WITH_FACTS } }));
  content.set('click', () => ({
    ok: true,
    result: {
      ok: true,
      ref: null,
      selector: null,
      tag: 'button',
      x: 1,
      y: 2,
      via: 'content-script',
      hit: 'self',
      isConnected: true,
      trusted: false,
      synthetic: true,
    },
  }));
  const refs = new RefRegistry();
  const registry = new ActionRegistry({ content, refs, random: () => 0, now: () => 1000, pierce: options.pierce ?? null });
  return { registry, content, refs };
}

test('params：observe 放行 closedShadowNodes / unmappedAx / cdpSessionId，并收敛字段（不原样透传任意对象）', () => {
  const normalized = normalizePageAction('observe', {
    tabId: 7,
    closedShadowNodes: [
      { text: ' 封闭按钮 ', tag: 'BUTTON', backendNodeId: 777, bounds: { x: 10, y: 20, width: 30, height: 40 }, junk: 'drop-me' },
      { text: '' },
      'not-a-record',
    ],
    unmappedAx: [{ role: 'button', name: 'AX only', backendNodeId: 9001, source: 'dom-aria' }],
    cdpSessionId: ' 7:0 ',
  });
  assert.equal(normalized.params.cdpSessionId, '7:0');
  const shadow = normalized.params.closedShadowNodes as Array<Record<string, unknown>>;
  assert.equal(shadow.length, 1, '空文本/非对象候选应被丢弃');
  assert.deepEqual(shadow[0], {
    text: '封闭按钮',
    tag: 'button',
    backendNodeId: 777,
    bounds: { x: 10, y: 20, width: 30, height: 40 },
  });
  assert.equal((normalized.params.unmappedAx as Array<Record<string, unknown>>)[0]?.backendNodeId, 9001);

  // 显式空 cdpSessionId 不写入（不伪造会话标识）。
  const without = normalizePageAction('observe', { tabId: 7, cdpSessionId: '   ' });
  assert.equal(without.params.cdpSessionId, undefined);
});

test('finishObserve：refDetails 写 cdpSessionId=tabId:0 并回填 hitTest/occludedBy/inViewport/pointerEvents', async () => {
  const { registry, content, refs } = makeHarness();
  const observed = await registry.dispatch('observe', { tabId: 7, vom: true }) as {
    refDetails: Array<Record<string, unknown>>;
    closedShadowRegistered: number;
    closedShadow?: Array<Record<string, unknown>>;
  };
  // observe 请求要带 cdpSessionId，内容脚本才能算出与 refDetails 相同的 stableRef（5b）。
  const observeCall = content.callsFor('observe')[0];
  assert.equal(observeCall?.request.params.cdpSessionId, '7:0');

  const kw = observed.refDetails.find((detail) => detail.ref === '@e1');
  const submit = observed.refDetails.find((detail) => detail.ref === '@e2');
  assert.equal(kw?.cdpSessionId, '7:0');
  assert.equal(kw?.hitTest, 'self');
  assert.equal(kw?.occludedBy, null);
  assert.equal(kw?.inViewport, true);
  assert.equal(kw?.pointerEvents, 'auto');
  assert.equal(submit?.hitTest, 'blocked');
  assert.deepEqual(submit?.occludedBy, { tag: 'div', role: null, id: 'cover', name: null });

  // closed shadow：registerObservation 之后登记，source='closed-shadow' + backendNodeId。
  assert.equal(observed.closedShadowRegistered, 1);
  assert.deepEqual(observed.closedShadow?.map((item) => item.ref), ['@e3']);
  const entry = refs.get(7, '@e3');
  assert.equal(entry?.source, 'closed-shadow');
  assert.equal(entry?.key.backendNodeId, 777);
  assert.equal(entry?.name, '封闭按钮');
  // 主文档 ref 仍是 dom 来源（不被 closed shadow 路由抢走）。
  assert.equal(refs.get(7, '@e1')?.source, 'dom');
});

test('30b/35b：节点没有 hitTest 等字段时 refDetails 显式 null（不伪造事实）', async () => {
  const content = new StubContentTransport();
  content.set('observe', () => ({
    ok: true,
    result: {
      url: 'https://example.test/',
      title: 't',
      observation: '- button "提交" [@e1]',
      refs: 1,
      revision: 1,
      documentId: 'doc-a',
      nodes: [{ ref: '@e1', role: 'button', name: '提交', tag: 'button', id: 'submit-btn' }],
    },
  }));
  const registry = new ActionRegistry({ content, refs: new RefRegistry(), random: () => 0, now: () => 1000 });
  const observed = await registry.dispatch('observe', { tabId: 9 }) as { refDetails: Array<Record<string, unknown>>; closedShadowRegistered: number };
  assert.equal(observed.refDetails[0]?.cdpSessionId, '9:0');
  assert.equal(observed.refDetails[0]?.hitTest, null);
  assert.equal(observed.refDetails[0]?.occludedBy, null);
  assert.equal(observed.refDetails[0]?.inViewport, null);
  assert.equal(observed.refDetails[0]?.pointerEvents, null);
  assert.equal(observed.closedShadowRegistered, 0);
});

test('20v：closed-shadow ref 走注入的 pierce（click → via=closed-shadow-ref；read → value）', async () => {
  const clicks: Array<{ tabId: number; backendNodeId: number }> = [];
  const reads: Array<{ tabId: number; backendNodeId: number }> = [];
  const pierce: PierceRefRouter = {
    async clickRefNode(tabId, backendNodeId) {
      clicks.push({ tabId, backendNodeId });
      return { ok: true, trusted: true, via: 'closed-shadow-ref', x: 12, y: 34, backendNodeId, at: 1234 };
    },
    async readRefNode(tabId, backendNodeId) {
      reads.push({ tabId, backendNodeId });
      return { ok: true, matched: '封闭按钮', value: '封闭按钮', tag: 'button', via: 'closed-shadow-ref', backendNodeId, at: 1234 };
    },
  };
  const { registry, content } = makeHarness({ pierce });
  await registry.dispatch('observe', { tabId: 7 });

  const clicked = await registry.dispatch('click', { tabId: 7, ref: '@e3', trusted: true }) as Record<string, unknown>;
  assert.equal(clicked.via, 'closed-shadow-ref');
  assert.equal(clicked.trusted, true);
  assert.equal(clicked.synthetic, false);
  assert.equal(clicked.effectState, 'committed');
  assert.equal(clicked.ref, '@e3');
  assert.equal(clicked.selector, null);
  assert.deepEqual(clicks, [{ tabId: 7, backendNodeId: 777 }]);
  assert.equal(content.callsFor('click').length, 0, 'closed shadow ref 不应下发内容脚本');

  const read = await registry.dispatch('read', { tabId: 7, ref: '@e3' }) as Record<string, unknown>;
  assert.equal(read.value, '封闭按钮');
  assert.equal(read.ref, '@e3');
  assert.deepEqual(read.fields, []);
  assert.equal(read.count, 1);
  assert.deepEqual(reads, [{ tabId: 7, backendNodeId: 777 }]);
  assert.equal(content.callsFor('read').length, 0);
});

test('未注入 pierce：closed-shadow ref 明确 E_UNSUPPORTED_CAPABILITY（不假成功）', async () => {
  const { registry, content } = makeHarness();
  await registry.dispatch('observe', { tabId: 7 });
  await assert.rejects(
    registry.dispatch('click', { tabId: 7, ref: '@e3', trusted: true }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_UNSUPPORTED_CAPABILITY');
      const data = error.data as Record<string, unknown>;
      assert.equal(data.backendNodeId, 777);
      assert.ok(Array.isArray(data.alternatives) && data.alternatives.length > 0);
      return true;
    },
  );
  assert.equal(content.callsFor('click').length, 0);
});

test('主文档 ref 不受 pierce 路由影响（继续走内容脚本）', async () => {
  const via: string[] = [];
  const pierce: PierceRefRouter = {
    async clickRefNode() {
      via.push('pierce');
      return { ok: true };
    },
    async readRefNode() {
      return { ok: true };
    },
  };
  const { registry, content } = makeHarness({ pierce });
  await registry.dispatch('observe', { tabId: 7 });
  const clicked = await registry.dispatch('click', { tabId: 7, ref: '@e2' }) as Record<string, unknown>;
  assert.equal(clicked.via, 'content-script');
  assert.deepEqual(via, []);
  assert.equal(content.callsFor('click').length, 1);
});
