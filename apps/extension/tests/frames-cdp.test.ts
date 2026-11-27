// tests/frames-cdp.test.ts —— FrameObservationService × CDP owner 投影集成单测（假 chrome.debugger）。
//
// 覆盖：observe --frames 每帧 owner/几何（含嵌套 OOPIF）、跨源/变换 owner 动作 via=cdp-frame-owner、
// 同源无变换保持 frame-projected（兼容既有 E2E 断言）、--vom 参数/字段透传（不实现 VOM 语义）、
// CDP 不可用/attach 失败/owner 解析失败三种降级路径，以及 tab 清理。

import assert from 'node:assert/strict';
import test from 'node:test';

import { FrameObservationService } from '../src/frames/service.ts';
import type { WebNavigationApi } from '../src/frames/service.ts';
import { FrameCdpService } from '../src/cdp/index.ts';
import type { CdpEventSource, CdpTarget, ChromeDebuggerApi } from '../src/cdp/index.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';

type EventListener = (source: CdpEventSource, method: string, params: Record<string, unknown>) => void;
type DetachListener = (source: CdpEventSource, reason: string) => void;

class ScriptedDebugger implements ChromeDebuggerApi {
  attachCalls = 0;
  detachCalls = 0;
  attachImpl: () => Promise<void> = async () => {};
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

  async attach(): Promise<void> {
    this.attachCalls += 1;
    await this.attachImpl();
  }

  async detach(): Promise<void> {
    this.detachCalls += 1;
  }

  async sendCommand(target: CdpTarget, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.commandImpl(target, method, params ?? {});
  }

  emitEvent(source: CdpEventSource, method: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...this.eventListeners]) listener(source, method, params);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ 页面夹具

const FRAME_URLS: Record<number, string> = {
  0: 'http://a/top.html',
  5: 'http://a/frame.html',
  6: 'http://b/oopif.html',
  7: 'http://a/transform3d-frame.html',
  8: 'http://b/inner.html',
};

const NAVIGATION_FRAMES = [
  { frameId: 0, parentFrameId: -1, url: FRAME_URLS[0] },
  { frameId: 5, parentFrameId: 0, url: FRAME_URLS[5] },
  { frameId: 6, parentFrameId: 0, url: FRAME_URLS[6] },
  { frameId: 7, parentFrameId: 0, url: FRAME_URLS[7] },
  { frameId: 8, parentFrameId: 6, url: FRAME_URLS[8] },
];

interface ContentCall {
  op: string;
  frameId: number;
  params: Record<string, unknown>;
}

function makeContent(): {
  ops: ContentCall[];
  transport: { request(tabId: number, request: ContentRequest, options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number }): Promise<ContentReply> };
} {
  const ops: ContentCall[] = [];
  const transport = {
    async request(_tabId: number, request: ContentRequest, options: { frameId?: number } = {}): Promise<ContentReply> {
      const frameId = options.frameId ?? 0;
      ops.push({ op: request.op, frameId, params: request.params });
      if (request.op === 'frame-inventory') {
        return { ok: true, result: { frames: [], count: 0, hiddenCount: 0 } };
      }
      if (request.op === 'click') {
        return {
          ok: true,
          result: {
            ok: true,
            ref: '@e1',
            selector: null,
            tag: 'button',
            x: 5,
            y: 7,
            via: 'content-script',
            hit: 'self',
            isConnected: true,
            trusted: false,
            synthetic: true,
          },
        };
      }
      // observe --vom 时内容脚本返回 richResult.vom.{graph,nodes}（公开图 + 已观察节点）。
      const vom = {
        graph: {
          available: true,
          nodes: [{
            id: 'n1',
            ref: '@e1',
            stableRef: null,
            tag: 'button',
            role: 'button',
            domId: null,
            parentId: null,
            ancestorIds: [],
            observed: true,
          }],
          edges: [],
          roots: ['n1'],
          counts: { nodes: 1, edges: 0, byType: {} },
          truncated: false,
        },
        nodes: [],
      };
      return {
        ok: true,
        result: {
          url: FRAME_URLS[frameId] ?? '',
          title: 'frame-' + String(frameId),
          observation: '- button "框架内按钮" [@e1]',
          refs: 1,
          documentId: 'doc-' + String(frameId),
          revision: 1,
          nodes: [{ ref: '@e1' }],
          ...(request.params['vom'] === true ? { richResult: { vom } } : {}),
        },
      };
    },
  };
  return { ops, transport };
}

function makeNavigation(): WebNavigationApi {
  return {
    async getAllFrames(): Promise<Array<{ frameId: number; parentFrameId: number; url?: string }>> {
      return NAVIGATION_FRAMES.map((frame) => ({ ...frame }));
    },
  };
}

// ------------------------------------------------------------------ CDP 夹具

const ROOT_TREE = {
  frameTree: {
    frame: { id: 'ROOT', url: FRAME_URLS[0] },
    childFrames: [
      { frame: { id: 'F5', parentId: 'ROOT', url: FRAME_URLS[5] } },
      { frame: { id: 'F6', parentId: 'ROOT', url: FRAME_URLS[6] } },
      { frame: { id: 'F7', parentId: 'ROOT', url: FRAME_URLS[7] } },
    ],
  },
};
const OOPIF_TREE = {
  frameTree: {
    frame: { id: 'F6', parentId: 'ROOT', url: FRAME_URLS[6] },
    childFrames: [{ frame: { id: 'F8', parentId: 'F6', url: FRAME_URLS[8] } }],
  },
};

interface Quad {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
  p4: { x: number; y: number };
  width: number;
  height: number;
  borderLeft: number;
  borderTop: number;
  transformed: boolean;
  perspective: boolean;
}

const QUADS: Record<string, Quad> = {
  'obj-105': {
    p1: { x: 10, y: 20 }, p2: { x: 410, y: 20 }, p4: { x: 10, y: 220 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
  'obj-106': {
    p1: { x: 100, y: 150 }, p2: { x: 700, y: 150 }, p4: { x: 100, y: 450 },
    width: 600, height: 300, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
  'obj-107': {
    p1: { x: 0, y: 0 }, p2: { x: 0, y: 400 }, p4: { x: -200, y: 0 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: true, perspective: false,
  },
  'obj-108': {
    p1: { x: 30, y: 40 }, p2: { x: 430, y: 40 }, p4: { x: 30, y: 240 },
    width: 400, height: 200, borderLeft: 0, borderTop: 0, transformed: false, perspective: false,
  },
};

const OWNER_BY_FRAME: Record<string, { session: string; backend: number }> = {
  F5: { session: '', backend: 105 },
  F6: { session: '', backend: 106 },
  F7: { session: '', backend: 107 },
  F8: { session: 'S6', backend: 108 },
};

function makeApi(options: { failOwner?: boolean; withOopif?: boolean } = {}): ScriptedDebugger {
  const commandImpl = async (target: CdpTarget, method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'Target.setAutoAttach' && !target.sessionId) {
      if (options.withOopif !== false) {
        api.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
          sessionId: 'S6',
          targetInfo: { targetId: 'T6', type: 'iframe', url: FRAME_URLS[6] },
        });
      }
      return {};
    }
    if (method === 'Page.getFrameTree') {
      return target.sessionId === 'S6' ? OOPIF_TREE : ROOT_TREE;
    }
    if (method === 'DOM.enable') return {};
    if (method === 'DOM.getFrameOwner') {
      if (options.failOwner === true) throw new Error('owner unavailable');
      const frameId = String(params['frameId'] ?? '');
      const entry = OWNER_BY_FRAME[frameId];
      if (!entry) throw new Error('No frame with given id ' + frameId);
      if ((target.sessionId ?? '') !== entry.session) throw new Error('owner not in this session');
      return { backendNodeId: entry.backend };
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'obj-' + String(params['backendNodeId']) } };
    }
    if (method === 'Runtime.callFunctionOn') {
      const quad = QUADS[String(params['objectId'] ?? '')];
      if (!quad) throw new Error('unknown object');
      return { result: { value: quad } };
    }
    return {};
  };
  const api = new ScriptedDebugger(commandImpl);
  return api;
}

async function makeService(
  options: { api?: ScriptedDebugger; cdp?: null } = {},
): Promise<{ service: FrameObservationService; content: ReturnType<typeof makeContent>; cdp: FrameCdpService }> {  const content = makeContent();
  const cdp = options.cdp === null
    ? null
    : new FrameCdpService({
      api: options.api ?? makeApi(),
      graphTtlMs: 0,
      settleMs: 0,
      sessionWaitMs: 500,
      timeoutMs: 500,
      idleDetachMs: 0,
      sleep: async (ms) => { await tick(ms); },
    });
  const service = new FrameObservationService({
    content: content.transport,
    navigation: makeNavigation(),
    now: () => 1,
    cdp,
  });
  return { service, content, cdp: cdp as FrameCdpService };
}

function recordOf(result: Awaited<ReturnType<FrameObservationService['observeFrames']>>, frameId: number) {
  return result.frames.find((frame) => frame.frameId === frameId);
}

function ownerOf(result: Awaited<ReturnType<FrameObservationService['observeFrames']>>, frameId: number) {
  const record = recordOf(result, frameId);
  assert.ok(record, '缺少 frame ' + String(frameId));
  assert.ok(record.owner, 'frame ' + String(frameId) + ' 缺少 CDP owner 几何');
  return record.owner;
}

function vomOf(result: Awaited<ReturnType<FrameObservationService['observeFrames']>>, frameId: number) {
  const record = recordOf(result, frameId);
  assert.ok(record, '缺少 frame ' + String(frameId));
  assert.ok(record.vom, 'frame ' + String(frameId) + ' 缺少 vom 子图');
  return record.vom;
}

// ------------------------------------------------------------------ 测试

test('observe --frames：每帧带 CDP owner/几何（同源 / OOPIF / 变换 / 嵌套 OOPIF）', async () => {
  const { service, cdp } = await makeService();
  const result = await service.observeFrames({ tabId: 7 });
  assert.equal(result.frames.length, 5);
  assert.equal(result.aliases.length, 4);
  // 主文档没有 owner 链（根帧）。
  const main = recordOf(result, 0);
  assert.equal(main?.owner, null);
  // 同源无变换：owner 有几何，但 oopif/transformed 都是 false。
  const plain = ownerOf(result, 5);
  assert.equal(plain.oopif, false);
  assert.equal(plain.crossOrigin, false);
  assert.equal(plain.transformed, false);
  assert.deepEqual(plain.rect, { x: 10, y: 20, width: 400, height: 200 });
  // 跨源 OOPIF：oopif=true；跨源段也标记 crossOrigin。
  const oopif = ownerOf(result, 6);
  assert.equal(oopif.oopif, true);
  assert.equal(oopif.crossOrigin, true);
  assert.equal(oopif.cdpFrameId, 'F6');
  // 3D 变换 owner：transformed=true。
  const transformed = ownerOf(result, 7);
  assert.equal(transformed.transformed, true);
  assert.equal(transformed.crossOrigin, false);
  // 嵌套 OOPIF：owner 链两段，内层 owner 在 OOPIF session 解析。
  const nested = ownerOf(result, 8);
  assert.equal(nested.oopif, true);
  assert.equal(nested.crossOrigin, true);
  assert.equal(nested.chain.length, 2);
  assert.equal(nested.chain[0]?.ownerSessionId, 'S6');
  assert.equal(nested.chain[1]?.ownerSessionId, '');
  // 诊断摘要 + limitations 文案随 CDP 能力切换。
  assert.equal(result.cdp?.available, true);
  assert.equal(result.cdp?.attached, true);
  assert.equal(result.cdp?.sessions, 1);
  assert.equal(result.cdp?.ownerProjections, 4);
  assert.equal(result.cdp?.projectionsFailed, 1);
  assert.match(result.limitations[0] ?? '', /CDP frame owner 投影/);
  await service.dispose();
  assert.equal(cdp.available(), false);
});

test('dispatchInFrame：跨源/变换 owner → via=cdp-frame-owner；同源无变换保持 frame-projected', async () => {
  const { service } = await makeService();
  await service.observeFrames({ tabId: 7 });

  const plainAlias = service.aliasFor(7, '@f5e1');
  assert.ok(plainAlias);
  const plain = await service.dispatchInFrame(7, plainAlias, 'click', {});
  assert.equal(plain['via'], 'frame-projected');
  assert.equal(plain['projected'], undefined);

  const oopifAlias = service.aliasFor(7, '@f6e1');
  assert.ok(oopifAlias);
  const oopif = await service.dispatchInFrame(7, oopifAlias, 'click', {});
  assert.equal(oopif['via'], 'cdp-frame-owner');
  assert.equal(oopif['oopif'], true);
  assert.equal(oopif['crossOrigin'], true);
  assert.deepEqual(oopif['projected'], { x: 105, y: 157 });
  assert.equal(oopif['trusted'], false);
  assert.equal(oopif['synthetic'], true);
  assert.equal(Array.isArray(oopif['owner_chain']), true);
  assert.equal((oopif['owner_chain'] as unknown[]).length, 1);

  const transformAlias = service.aliasFor(7, '@f7e1');
  assert.ok(transformAlias);
  const transformed = await service.dispatchInFrame(7, transformAlias, 'click', {});
  assert.equal(transformed['via'], 'cdp-frame-owner');
  assert.equal(transformed['transformed'], true);
  assert.deepEqual(transformed['projected'], { x: -7, y: 5 });

  const nestedAlias = service.aliasFor(7, '@f8e1');
  assert.ok(nestedAlias);
  const nested = await service.dispatchInFrame(7, nestedAlias, 'click', {});
  assert.equal(nested['via'], 'cdp-frame-owner');
  assert.equal((nested['owner_chain'] as unknown[]).length, 2);
  assert.deepEqual(nested['projected'], { x: 135, y: 197 });
  await service.dispose();
});

test('跨源但同进程（无 OOPIF session）也走 CDP owner 投影（页面侧读不到 contentDocument）', async () => {
  const { service } = await makeService({ api: makeApi({ withOopif: false }) });
  const result = await service.observeFrames({ tabId: 7 });
  const cross = ownerOf(result, 6);
  assert.equal(cross.oopif, false, '无子 session 时不是跨进程');
  assert.equal(cross.crossOrigin, true, '跨端口 → 跨源');
  const alias = service.aliasFor(7, '@f6e1');
  assert.ok(alias);
  const clicked = await service.dispatchInFrame(7, alias, 'click', {});
  assert.equal(clicked['via'], 'cdp-frame-owner');
  assert.equal(clicked['oopif'], false);
  assert.equal(clicked['crossOrigin'], true);
  assert.deepEqual(clicked['projected'], { x: 105, y: 157 });
  await service.dispose();
});

test('observe --frames --vom：vom 参数下发、每帧 richResult.vom 透传、跨帧装配写回', async () => {
  const { service, content } = await makeService();
  const result = await service.observeFrames({ tabId: 7, vom: true });
  const observes = content.ops.filter((op) => op.op === 'observe');
  assert.equal(observes.length, 5);
  assert.equal(observes.every((op) => op.params['vom'] === true), true, '每帧 observe 都应透传 vom:true');
  for (const frameId of [5, 6, 7, 8]) {
    const vom = vomOf(result, frameId);
    assert.equal(vom['available'], true, 'frame ' + String(frameId) + ' vom 应可用');
    const nodes = vom['nodes'] as Array<Record<string, unknown>>;
    assert.equal(nodes[0]?.['id'], 'frame:' + String(frameId), '每帧子图应含 frame 节点');
    assert.equal(nodes[1]?.['id'], 'f' + String(frameId) + ':n1', '节点 id 必须加帧前缀（vom-deep 单一实现）');
  }
  // 主文档子图也含 frame:0 节点（E2E 15d 断言）。
  const mainVom = vomOf(result, 0);
  assert.equal(mainVom['available'], true);
  assert.equal((mainVom['nodes'] as Array<Record<string, unknown>>)[0]?.['id'], 'frame:0');
  // 跨帧摘要/预算来自 vom-deep 的 FRAME_VOM_LIMITS（frames=16）。
  assert.equal(result.vomFrames?.count, 5);
  assert.equal(result.vomFrames?.unlinked, 0);
  assert.equal(Array.isArray(result.vomFrames?.links), true);
  assert.equal(result.vomLimits?.['frames'], 16);
  assert.equal(result.vomLimits?.['nodes'], 400);
  assert.equal(result.vomLimits?.['edges'], 800);
  assert.equal(result.vomError, undefined);
  // 未请求 --vom 时不带这些字段/字段为 null。
  const plain = await service.observeFrames({ tabId: 7 });
  assert.equal(plain.vomFrames, undefined);
  assert.equal(recordOf(plain, 5)?.vom, null);
  const plainObserves = content.ops.filter((op) => op.op === 'observe' && op.params['vom'] === true);
  assert.equal(plainObserves.length, 5, '只有第一次请求带 vom（共 5 帧）');
  await service.dispose();
});

test('降级：cdp 显式关闭 → owner=null、via=frame-projected、limitations 回到 no-debugger', async () => {
  const { service } = await makeService({ cdp: null });
  const result = await service.observeFrames({ tabId: 7 });
  assert.equal(result.frames.every((frame) => frame.owner === null), true);
  assert.equal(result.cdp?.available, false);
  assert.match(result.limitations[0] ?? '', /no-debugger/);
  const alias = service.aliasFor(7, '@f6e1');
  assert.ok(alias);
  const clicked = await service.dispatchInFrame(7, alias, 'click', {});
  assert.equal(clicked['via'], 'frame-projected');
  await service.dispose();
});

test('降级：owner 解析失败不抛错（owner=null，动作仍 frame-projected）', async () => {
  const { service } = await makeService({ api: makeApi({ failOwner: true }) });
  const result = await service.observeFrames({ tabId: 7 });
  assert.equal(result.frames.every((frame) => frame.owner === null), true);
  assert.equal(result.cdp?.available, true);
  assert.equal(result.cdp?.attached, true);
  assert.equal(result.cdp?.ownerProjections, 0);
  const alias = service.aliasFor(7, '@f6e1');
  assert.ok(alias);
  const clicked = await service.dispatchInFrame(7, alias, 'click', {});
  assert.equal(clicked['via'], 'frame-projected');
  await service.dispose();
});

test('降级：attach 被占用（E_CDP_BUSY）时不阻塞 observe；status 报诊断错误', async () => {
  const api = makeApi();
  api.attachImpl = async () => { throw new Error('Another debugger is already attached to the tab'); };
  const { service, cdp } = await makeService({ api });
  const result = await service.observeFrames({ tabId: 7 });
  assert.equal(result.frames.every((frame) => frame.owner === null), true);
  assert.equal(result.cdp?.available, true);
  assert.equal(result.cdp?.attached, false);
  const status = cdp.status(7);
  assert.match(String(status.error), /E_CDP_BUSY|调试会话占用/);
  await service.dispose();
});

test('tab 清理：forgetTab 后缓存与调试会话一起回收', async () => {
  const { service, cdp } = await makeService();
  await service.observeFrames({ tabId: 7 });
  assert.equal(cdp.status(7).attached, true);
  service.forgetTab(7);
  await tick(5);
  assert.equal(cdp.status(7).attached, false);
  assert.equal(cdp.status(7).cdpFrames, 0);
  assert.equal(service.aliasFor(7, '@f5e1'), null);
  await service.dispose();
});
