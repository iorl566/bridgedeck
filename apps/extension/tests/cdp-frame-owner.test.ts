// tests/cdp-frame-owner.test.ts —— CDP frame owner 投影单测（假 chrome.debugger）。
//
// 覆盖：纯 rect 投影、2D/3D 变换 owner、perspective homography、嵌套 OOPIF（owner 链
// 逐段在父文档 session 解析）、owner/帧缺失与命令失败的降级（返回 null 不抛错）、
// frame tree 合并与 URL 链。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CdpClient,
  buildFrameGraph,
  frameChainByUrl,
  frameOwnerGeometry,
  isCrossOriginSegment,
  parseOwnerQuad,
  projectFrameOwnerPoint,
  projectQuadPoint,
  readFrameGraph,
} from '../src/cdp/index.ts';
import type { CdpEventSource, CdpFrameGraph, CdpFrameNode, CdpTarget, ChromeDebuggerApi } from '../src/cdp/index.ts';

type EventListener = (source: CdpEventSource, method: string, params: Record<string, unknown>) => void;
type DetachListener = (source: CdpEventSource, reason: string) => void;

class ScriptedDebugger implements ChromeDebuggerApi {
  attachCalls = 0;
  detachCalls = 0;
  commands: Array<{ target: CdpTarget; method: string; params: Record<string, unknown> }> = [];
  commandImpl: (target: CdpTarget, method: string, params: Record<string, unknown>) => Promise<unknown>;
  private readonly eventListeners = new Set<EventListener>();
  private readonly detachListeners = new Set<DetachListener>();
  readonly onEvent = {
    addListener: (listener: EventListener): void => { this.eventListeners.add(listener); },
    removeListener: (listener: EventListener): void => { this.eventListeners.delete(listener); },
  };
  readonly onDetach = {
    addListener: (listener: DetachListener): void => { this.detachListeners.add(listener); },
    removeListener: (listener: DetachListener): void => { this.detachListeners.delete(listener); },
  };

  constructor(commandImpl: (target: CdpTarget, method: string, params: Record<string, unknown>) => Promise<unknown>) {
    this.commandImpl = commandImpl;
  }

  async attach(): Promise<void> { this.attachCalls += 1; }

  async detach(): Promise<void> { this.detachCalls += 1; }

  async sendCommand(target: CdpTarget, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ target, method, params: params ?? {} });
    return this.commandImpl(target, method, params ?? {});
  }

  emitEvent(source: CdpEventSource, method: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...this.eventListeners]) listener(source, method, params);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ROOT_URL = 'http://a/nested.html';
const PLAIN_URL = 'http://a/frame.html';
const TRANSFORM_URL = 'http://a/transform3d-frame.html';
const PERSPECTIVE_URL = 'http://a/perspective-frame.html';
const OUTER_URL = 'http://b/nested-cross2-outer.html';
const INNER_URL = 'http://b/nested-cross2-inner.html';

interface Quad {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  p3?: { x: number; y: number };
  p4: { x: number; y: number };
  width: number;
  height: number;
  borderLeft: number;
  borderTop: number;
  transformed: boolean;
  perspective: boolean;
}

const QUADS: Record<string, Quad> = {
  // 101：纯 rect（同源无变换）
  'obj-101': {
    p1: { x: 10, y: 20 }, p2: { x: 410, y: 20 }, p4: { x: 10, y: 220 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
  // 102：2D 变换（rotate 90°，宽 400 高 200）
  'obj-102': {
    p1: { x: 0, y: 0 }, p2: { x: 0, y: 400 }, p4: { x: -200, y: 0 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: true, perspective: false,
  },
  // 103：3D + perspective（单位正方形 + 右下角 p3）
  'obj-103': {
    p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p3: { x: 100, y: 100 }, p4: { x: 0, y: 100 },
    width: 100, height: 100, borderLeft: 0, borderTop: 0, transformed: true, perspective: true,
  },
  // 201：OOPIF 内层 owner（外层文档视口坐标）
  'obj-201': {
    p1: { x: 30, y: 40 }, p2: { x: 430, y: 40 }, p4: { x: 30, y: 240 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
  // 202：OOPIF 外层 owner（顶层文档视口坐标）
  'obj-202': {
    p1: { x: 5, y: 6 }, p2: { x: 605, y: 6 }, p4: { x: 5, y: 306 },
    width: 600, height: 300, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
};

const ROOT_TREE = {
  frameTree: {
    frame: { id: 'ROOT', url: ROOT_URL },
    childFrames: [
      { frame: { id: 'F-PLAIN', parentId: 'ROOT', url: PLAIN_URL } },
      { frame: { id: 'F-3D', parentId: 'ROOT', url: TRANSFORM_URL } },
      { frame: { id: 'F-PERSP', parentId: 'ROOT', url: PERSPECTIVE_URL } },
      { frame: { id: 'F-OUTER', parentId: 'ROOT', url: OUTER_URL } },
    ],
  },
};

const OOPIF_TREE = {
  frameTree: {
    frame: { id: 'F-OUTER', parentId: 'ROOT', url: OUTER_URL },
    childFrames: [
      { frame: { id: 'F-INNER', parentId: 'F-OUTER', url: INNER_URL } },
    ],
  },
};

const OWNER_BY_FRAME: Record<string, { session: string; backend: number }> = {
  'F-PLAIN': { session: '', backend: 101 },
  'F-3D': { session: '', backend: 102 },
  'F-PERSP': { session: '', backend: 103 },
  'F-INNER': { session: 'S-OOPIF', backend: 201 },
  'F-OUTER': { session: '', backend: 202 },
};

function scriptedCommand(
  failOwnerFor: Set<string> = new Set(),
): (target: CdpTarget, method: string, params: Record<string, unknown>) => Promise<unknown> {
  return async (target, method, params) => {
    if (method === 'Target.setAutoAttach' && !target.sessionId) {
      // 只在 root 开关时上线 OOPIF 子 session（模拟 Target.attachedToTarget 事件）。
      return {};
    }
    if (method === 'Page.getFrameTree') {
      return target.sessionId === 'S-OOPIF' ? OOPIF_TREE : ROOT_TREE;
    }
    if (method === 'DOM.enable') return {};
    if (method === 'DOM.getFrameOwner') {
      const frameId = String(params['frameId'] ?? '');
      const entry = OWNER_BY_FRAME[frameId];
      if (!entry) throw new Error('No frame with given id ' + frameId);
      if (failOwnerFor.has(frameId)) throw new Error('owner unavailable for ' + frameId);
      if ((target.sessionId ?? '') !== entry.session) {
        throw new Error('owner not in this session: ' + frameId);
      }
      return { backendNodeId: entry.backend };
    }
    if (method === 'DOM.resolveNode') {
      const backend = Number(params['backendNodeId']);
      return { object: { objectId: 'obj-' + String(backend) } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const objectId = String(params['objectId'] ?? '');
      const quad = QUADS[objectId];
      if (!quad) throw new Error('unknown object ' + objectId);
      return { result: { value: quad } };
    }
    return {};
  };
}

function makeApi(
  options: { withOopifSession?: boolean; failOwnerFor?: Set<string>; onRootAutoAttach?: (api: ScriptedDebugger) => void } = {},
): ScriptedDebugger {
  const api = new ScriptedDebugger(scriptedCommand(options.failOwnerFor));
  if (options.withOopifSession !== false) {
    const original = api.commandImpl;
    api.commandImpl = async (target, method, params) => {
      if (method === 'Target.setAutoAttach' && !target.sessionId) {
        api.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
          sessionId: 'S-OOPIF',
          targetInfo: { targetId: 'T-OOPIF', type: 'iframe', url: OUTER_URL },
        });
        options.onRootAutoAttach?.(api);
      }
      return original(target, method, params);
    };
  }
  return api;
}

async function setupGraph(options: { withOopifSession?: boolean; failOwnerFor?: Set<string> } = {}): Promise<{
  api: ScriptedDebugger;
  client: CdpClient;
  graph: CdpFrameGraph;
}> {
  const api = makeApi(options);
  const client = new CdpClient({ api, idleDetachMs: 0, sleep: async (ms) => { await tick(ms); } });
  const graph = await readFrameGraph(client, 7, { settleMs: 0, timeoutMs: 500, sessionWaitMs: 500, now: () => 1_000 });
  return { api, client, graph };
}

test('readFrameGraph：root + OOPIF 子 session 合并，同名 frame 由子 session 归属', async () => {
  const { client, graph } = await setupGraph();
  assert.equal(graph.sessions.length, 1);
  assert.equal(graph.sessions[0]?.sessionId, 'S-OOPIF');
  const outer = graph.byId.get('F-OUTER');
  assert.equal(outer?.sessionId, 'S-OOPIF', 'OOPIF 帧的文档归属子 session');
  assert.equal(outer?.crossProcess, true);
  const inner = graph.byId.get('F-INNER');
  assert.equal(inner?.sessionId, 'S-OOPIF');
  assert.equal(inner?.parentFrameId, 'F-OUTER');
  assert.equal(graph.byId.get('ROOT')?.sessionId, '');
  // URL 链：目标 → 父 → 根
  const innerChain = frameChainByUrl(graph, INNER_URL);
  assert.deepEqual(innerChain?.map((frame) => frame.frameId), ['F-INNER', 'F-OUTER', 'ROOT']);
  await client.dispose();
});

test('projectFrameOwnerPoint：纯 rect 投影（同源、无变换）', async () => {
  const { client, graph } = await setupGraph();
  const projection = await projectFrameOwnerPoint(client, graph, { url: PLAIN_URL, point: { x: 5, y: 7 } });
  assert.ok(projection);
  assert.equal(projection.x, 15);
  assert.equal(projection.y, 27);
  assert.equal(projection.via, 'cdp-frame-owner');
  assert.equal(projection.oopif, false);
  assert.equal(projection.crossOrigin, false, '同源 frame 不是 crossOrigin');
  assert.equal(projection.transformed, false);
  assert.equal(projection.owners.length, 1);
  assert.equal(projection.owners[0]?.cdpFrameId, 'F-PLAIN');
  assert.equal(projection.owners[0]?.crossOrigin, false);
  assert.deepEqual(projection.owners[0]?.rect, { x: 10, y: 20, width: 400, height: 200 });
  await client.dispose();
});

test('projectFrameOwnerPoint：2D 变换 owner（rotate 90°）按矩阵投影', async () => {
  const { client, graph } = await setupGraph();
  const projection = await projectFrameOwnerPoint(client, graph, { url: TRANSFORM_URL, point: { x: 10, y: 0 } });
  assert.ok(projection);
  assert.equal(projection.transformed, true);
  assert.equal(projection.oopif, false);
  assert.equal(projection.x, 0);
  assert.equal(projection.y, 10);
  await client.dispose();
});

test('projectFrameOwnerPoint：perspective/3D owner 用 homography（含 p3）', async () => {
  const { client, graph } = await setupGraph();
  const projection = await projectFrameOwnerPoint(client, graph, { url: PERSPECTIVE_URL, point: { x: 50, y: 50 } });
  assert.ok(projection);
  assert.equal(projection.transformed, true);
  assert.equal(projection.owners[0]?.perspective, true);
  assert.equal(projection.x, 50);
  assert.equal(projection.y, 50);
  const quad = parseOwnerQuad(QUADS['obj-103']);
  assert.ok(quad);
  assert.deepEqual(projectQuadPoint(quad.quad, { x: 100, y: 100 }), { x: 100, y: 100 });
  await client.dispose();
});

test('嵌套 OOPIF：owner 链逐段在父文档 session 解析，坐标逐层投影', async () => {
  const { client, graph } = await setupGraph();
  const projection = await projectFrameOwnerPoint(client, graph, { url: INNER_URL, point: { x: 1, y: 2 } });
  assert.ok(projection);
  assert.equal(projection.oopif, true);
  assert.equal(projection.crossOrigin, true, '跨源链必须标记 crossOrigin（即使同进程）');
  assert.equal(projection.transformed, false);
  assert.equal(projection.owners.length, 2);
  assert.equal(projection.owners[0]?.cdpFrameId, 'F-INNER');
  assert.equal(projection.owners[0]?.crossOrigin, false, '内层与外层同源');
  assert.equal(projection.owners[0]?.ownerSessionId, 'S-OOPIF', '内层 owner 在 OOPIF 文档里解析');
  assert.equal(projection.owners[1]?.cdpFrameId, 'F-OUTER');
  assert.equal(projection.owners[1]?.crossOrigin, true, '外层与顶层跨源');
  assert.equal(projection.owners[1]?.ownerSessionId, '', '外层 owner 在 root 文档里解析');
  // 内层 (1,2) → 外层文档 (31,42) → 顶层 (36,48)
  assert.equal(projection.x, 36);
  assert.equal(projection.y, 48);
  await client.dispose();
});

test('frameOwnerGeometry：frames 列表用的 owner/几何（origin + rect + chain）', async () => {
  const { client, graph } = await setupGraph();
  const geometry = await frameOwnerGeometry(client, graph, INNER_URL);
  assert.ok(geometry);
  assert.equal(geometry.via, 'cdp-frame-owner');
  assert.equal(geometry.oopif, true);
  assert.equal(geometry.cdpFrameId, 'F-INNER');
  assert.deepEqual(geometry.origin, { x: 35, y: 46 });
  assert.deepEqual(geometry.rect, { x: 30, y: 40, width: 400, height: 200 });
  assert.equal(geometry.chain.length, 2);
  await client.dispose();
});

test('降级：URL 不存在 / owner 命令失败 / OOPIF session 缺失都返回 null，不抛错', async () => {
  const { client, graph } = await setupGraph();
  assert.equal(await projectFrameOwnerPoint(client, graph, { url: 'http://a/unknown.html' }), null);
  // 根帧没有 owner（链长度 1）
  assert.equal(await projectFrameOwnerPoint(client, graph, { url: ROOT_URL }), null);
  const failed = await setupGraph({ failOwnerFor: new Set(['F-INNER', 'F-OUTER']) });
  assert.equal(await projectFrameOwnerPoint(failed.client, failed.graph, { url: INNER_URL }), null);
  assert.equal(await frameOwnerGeometry(failed.client, failed.graph, OUTER_URL), null);
  await client.dispose();
  await failed.client.dispose();
});

test('isCrossOriginSegment：端口/opaque origin 判定（securityOrigin 优先，URL origin 兜底）', () => {
  const frame = (overrides: Partial<CdpFrameNode>): CdpFrameNode => ({
    frameId: 'F',
    parentFrameId: 'ROOT',
    url: 'http://127.0.0.1:1000/a.html',
    securityOrigin: '',
    sessionId: '',
    crossProcess: false,
    ...overrides,
  });
  // 同端口同源
  assert.equal(isCrossOriginSegment(
    frame({ url: 'http://127.0.0.1:1000/frame.html' }),
    frame({ url: 'http://127.0.0.1:1000/top.html' }),
  ), false);
  // 不同端口 → 跨源（页面侧读不到 contentDocument；E2E 23p3 场景）
  assert.equal(isCrossOriginSegment(
    frame({ url: 'http://127.0.0.1:2000/outer.html' }),
    frame({ url: 'http://127.0.0.1:1000/top.html' }),
  ), true);
  // securityOrigin 优先（sandbox/opaque origin：URL 相同但源不同）
  assert.equal(isCrossOriginSegment(
    frame({ url: 'http://a/frame.html', securityOrigin: 'null' }),
    frame({ url: 'http://a/top.html', securityOrigin: 'http://a' }),
  ), true);
  assert.equal(isCrossOriginSegment(
    frame({ url: 'http://a/frame.html', securityOrigin: 'null' }),
    frame({ url: 'http://a/top.html', securityOrigin: 'null' }),
  ), true);
  assert.equal(isCrossOriginSegment(
    frame({ url: 'http://a/frame.html', securityOrigin: 'http://a' }),
    frame({ url: 'http://a/top.html', securityOrigin: 'http://a' }),
  ), false);
  // about:blank / 非法 URL 保守 false
  assert.equal(isCrossOriginSegment(
    frame({ url: 'about:blank' }),
    frame({ url: 'http://a/top.html' }),
  ), false);
});

test('buildFrameGraph：没有子 session 时 OOPIF 只是 root 树叶（链仍可达，但 owner 可能解析失败）', async () => {  const api = makeApi({ withOopifSession: false });
  const client = new CdpClient({ api, idleDetachMs: 0, sleep: async (ms) => { await tick(ms); } });
  const graph = await readFrameGraph(client, 7, { settleMs: 0, timeoutMs: 500, now: () => 1 });
  assert.equal(graph.sessions.length, 0);
  assert.equal(graph.byId.get('F-OUTER')?.sessionId, '');
  // 内层帧不可见 → URL 链找不到
  assert.equal(frameChainByUrl(graph, INNER_URL), null);
  // 手工构造合并：子 session 覆盖 root 的 OOPIF 节点
  const merged = buildFrameGraph(7, 2, [
    { sessionId: '', tree: ROOT_TREE.frameTree },
    { sessionId: 'S-OOPIF', tree: OOPIF_TREE.frameTree },
  ], [], true);
  assert.equal(merged.byId.get('F-OUTER')?.sessionId, 'S-OOPIF');
  assert.equal(merged.byId.get('F-INNER')?.sessionId, 'S-OOPIF');
  await client.dispose();
});
