// tests/actions-backend-locator.test.ts —— CDP DOM 节点定位器单测（假 CdpChannel）。
//
// 覆盖：selector/id/描述符三条定位路径、shadow 归属、坐标（point）、命中测试
// （self/descendant/host/obstructed + occludedBy）、fill 读回/聚焦/光标末尾、错误分类。

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CdpChannel } from '../src/debug/cdp-channel.ts';
import {
  CdpBackendNodeLocator,
  accessibleNameOfNode,
  attributesOf,
  findNodeByDescriptor,
  isCdpChannelError,
  isCdpPreDispatchError,
} from '../src/actions/backend-locator.ts';

type Handler = (params: Record<string, unknown>) => unknown;

class FakeChannel implements CdpChannel {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly handlers: Record<string, Handler>;
  acquireCount = 0;

  constructor(handlers: Record<string, Handler> = {}) {
    this.handlers = handlers;
  }

  async acquire(): Promise<void> {
    this.acquireCount += 1;
  }

  release(): void {
    // no-op
  }

  async send<T = unknown>(_tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) return {} as T;
    return handler(params) as T;
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

const TREE = {
  nodeId: 1,
  nodeType: 9,
  nodeName: '#document',
  children: [
    { nodeId: 2, backendNodeId: 20, nodeType: 1, nodeName: 'INPUT', attributes: ['id', 'kw', 'type', 'text', 'aria-label', '搜索关键词'] },
    {
      nodeId: 3,
      backendNodeId: 30,
      nodeType: 1,
      nodeName: 'DIV',
      attributes: ['id', 'closed-host'],
      shadowRoots: [
        {
          nodeId: 4,
          nodeType: 11,
          nodeName: '#document-fragment',
          shadowRootType: 'closed',
          children: [{ nodeId: 5, backendNodeId: 50, nodeType: 1, nodeName: 'BUTTON', attributes: ['id', 'closed-btn'] }],
        },
      ],
    },
  ],
};

test('attributesOf / accessibleNameOfNode / findNodeByDescriptor：属性、可访问名与 shadow 归属', () => {
  assert.deepEqual(attributesOf({ attributes: ['id', 'x', 'type', 'text'] }), { id: 'x', type: 'text' });
  const button = { nodeType: 1, nodeName: 'BUTTON', attributes: ['aria-label', '提交查询'] };
  assert.equal(accessibleNameOfNode(button), '提交查询');

  const hit = findNodeByDescriptor(TREE, { tag: 'button', id: 'closed-btn' });
  assert.ok(hit);
  assert.equal(hit.backendNodeId, 50);
  assert.equal(hit.inClosedShadow, true);
  assert.equal(hit.inOpenShadow, false);
  assert.equal(hit.tag, 'button');

  const byName = findNodeByDescriptor(TREE, { tag: 'input', name: '搜索关键词', id: 'kw' });
  assert.equal(byName?.backendNodeId, 20);
  assert.equal(byName?.inClosedShadow, false);
});

test('locate：selector 精确匹配走 DOM.querySelector（describeNode 取 backendNodeId）', async () => {
  const channel = new FakeChannel({
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': (params) => (params['selector'] === '#submit-btn' ? { nodeId: 7 } : { nodeId: 0 }),
    'DOM.describeNode': () => ({ node: { backendNodeId: 42, nodeName: 'BUTTON', attributes: ['id', 'submit-btn'] } }),
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  const hit = await locator.locate(7, { selector: '#submit-btn' });
  assert.deepEqual(hit && { backendNodeId: hit.backendNodeId, tag: hit.tag, id: hit.id }, { backendNodeId: 42, tag: 'button', id: 'submit-btn' });
  assert.equal(channel.sent.some((item) => item.method === 'DOM.enable'), true);

  const missing = await locator.locate(7, { selector: '#nope' });
  assert.equal(missing, null);
});

test('locate：id 快捷路径失败后遍历 DOM（含 shadow）按描述符匹配', async () => {
  const channel = new FakeChannel({
    'DOM.getDocument': (params) => (Number(params['depth']) === -1 ? { root: TREE } : { root: { nodeId: 1 } }),
    'DOM.querySelector': () => ({ nodeId: 0 }),
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  const hit = await locator.locate(7, { tag: 'button', id: 'closed-btn', occurrence: 0 });
  assert.equal(hit?.backendNodeId, 50);
  assert.equal(hit?.inClosedShadow, true);
  assert.equal(channel.sent.some((item) => item.method === 'DOM.getDocument' && Number(item.params['depth']) === -1), true);
});

test('locate：非法 selector（CDP 抛错）→ null（调用方回退内容脚本）', async () => {
  const channel = new FakeChannel({
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': () => {
      throw Object.assign(new Error('bad selector'), { code: 'E_CDP_COMMAND' });
    },
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  assert.equal(await locator.locate(7, { selector: '#bad[' }), null);
  assert.equal(isCdpChannelError({ code: 'E_CDP_COMMAND' }), true);
  assert.equal(isCdpPreDispatchError({ code: 'E_CDP_UNAVAILABLE' }), true);
  assert.equal(isCdpPreDispatchError({ code: 'E_CDP_TIMEOUT' }), false);
});

test('point：scrollIntoView + getBoundingClientRect → 坐标', async () => {
  const channel = new FakeChannel({
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Runtime.callFunctionOn': (params) => {
      const args = params['arguments'] as Array<{ value?: unknown }> | undefined;
      return { result: { value: { x: 100, y: 50, width: 40, height: 20, tag: 'button', connected: true, scroll: args?.[0]?.value === true } } };
    },
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  const point = await locator.point(7, 42, { scroll: true });
  assert.deepEqual(point && { x: point.x, y: point.y, width: point.width, height: point.height }, { x: 100, y: 50, width: 40, height: 20 });
  const call = channel.sent.find((item) => item.method === 'Runtime.callFunctionOn');
  assert.equal((call?.params['arguments'] as Array<{ value: unknown }>)[0]?.value, true);
  assert.equal(channel.sent.some((item) => item.method === 'Runtime.releaseObject'), true);
});

test('hitTest：命中祖先 → obstructed 并给出 occludedBy；命中后代/自身不误报', async () => {
  const describeNodes: Record<number, unknown> = {
    9: { node: { nodeId: 9, backendNodeId: 99, nodeName: 'DIV', attributes: ['id', 'cover'], parentId: 0 } },
    7: { node: { nodeId: 7, backendNodeId: 42, nodeName: 'BUTTON', attributes: ['id', 'covered-btn'], parentId: 0 } },
  };
  const channel = new FakeChannel({
    'DOM.getNodeForLocation': () => ({ nodeId: 9, backendNodeId: 99 }),
    'DOM.describeNode': (params) => {
      const backend = Number(params['backendNodeId']);
      if (backend === 99) return describeNodes[9];
      if (backend === 42) return describeNodes[7];
      return describeNodes[Number(params['nodeId'])] ?? { node: {} };
    },
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  const blocked = await locator.hitTest(7, { backendNodeId: 42, nodeId: 7 }, { x: 10, y: 20 });
  assert.equal(blocked.relation, 'obstructed');
  assert.deepEqual(blocked.occludedBy && { tag: blocked.occludedBy.tag, id: blocked.occludedBy.id }, { tag: 'div', id: 'cover' });

  const descendantChannel = new FakeChannel({
    'DOM.getNodeForLocation': () => ({ nodeId: 9, backendNodeId: 99 }),
    'DOM.describeNode': (params) => {
      if (Number(params['nodeId']) === 9) return { node: { nodeId: 9, backendNodeId: 99, nodeName: 'SPAN', parentId: 7 } };
      return { node: { nodeId: 7, backendNodeId: 42, nodeName: 'BUTTON', parentId: 0 } };
    },
  });
  const descendant = await new CdpBackendNodeLocator({ client: descendantChannel }).hitTest(7, { backendNodeId: 42, nodeId: 7 }, { x: 10, y: 20 });
  assert.equal(descendant.relation, 'descendant');

  const selfChannel = new FakeChannel({
    'DOM.getNodeForLocation': () => ({ nodeId: 7, backendNodeId: 42 }),
  });
  const self = await new CdpBackendNodeLocator({ client: selfChannel }).hitTest(7, { backendNodeId: 42, nodeId: 7 }, { x: 10, y: 20 });
  assert.equal(self.relation, 'self');
});

test('describeValue / focus / caretToEnd：fill 与 press 需要的事实', async () => {
  const channel = new FakeChannel({
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Runtime.callFunctionOn': (params) => {
      const fn = String(params['functionDeclaration'] ?? '');
      if (fn.includes('setSelectionRange')) return { result: { value: true } };
      return { result: { value: { tag: 'input', value: 'abc', editable: true, readOnly: false, disabled: false, type: 'text' } } };
    },
    'DOM.focus': () => ({}),
  });
  const locator = new CdpBackendNodeLocator({ client: channel });
  const view = await locator.describeValue(7, 42);
  assert.deepEqual(view && { tag: view.tag, value: view.value, editable: view.editable }, { tag: 'input', value: 'abc', editable: true });
  assert.equal(await locator.focus(7, 42), true);
  assert.equal(await locator.caretToEnd(7, 42), true);
  assert.equal(channel.sent.some((item) => item.method === 'DOM.focus'), true);
});

test('locate：CDP 挂载失败（E_CDP_BUSY）→ null，不抛错（回退内容脚本）', async () => {
  const channel = new FakeChannel();
  channel.acquire = async () => {
    throw Object.assign(new Error('busy'), { code: 'E_CDP_BUSY' });
  };
  const locator = new CdpBackendNodeLocator({ client: channel });
  assert.equal(await locator.locate(7, { selector: '#kw' }), null);
});
