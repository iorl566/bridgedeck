// tests/mc4.test.ts —— M-C 第四批新增模块的单测（收据/帧/文件/对话框/调试/富观察）。
//
// 这些测试都断言**真实行为**（状态迁移、字段、错误码、字节拼接、分页游标），
// 不是形状占位；内容脚本/浏览器 API 用假实现注入。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptStore, expectFailed, normalizeChecks, normalizeSignatures } from '../src/actions/receipts.ts';
import {
  FrameObservationService,
  frameAliasRef,
  parseFrameAlias,
  urlsMatch,
} from '../src/frames/service.ts';
import { DownloadService, UploadService } from '../src/native/service.ts';
import {
  DialogService,
  mainWorldInstallDialogHooks,
  mainWorldReadDialogs,
  mainWorldResolveDialog,
} from '../src/dialog/service.ts';
import { DebugService, OperationTimeline } from '../src/debug/service.ts';
import { buildObservation } from '../src/content/dom.ts';
import { buildRichObservation } from '../src/content/rich.ts';
import { createFakeDom, type FakeElementSpec } from './support/fake-dom.ts';
import type { ContentReply, ContentRequest } from '../src/content/protocol.ts';
import type { ScriptingApi, ScriptingInjection } from '../src/scripting/evaluate.ts';
import { RpcMethodError } from '../src/rpc/registry.ts';

// ---------------------------------------------------------------------------
// 收据 / context / 期望
// ---------------------------------------------------------------------------

const SIG_A = { attached: true, tag: 'button', id: 'b', text: '提交', value: null, checked: null, signature: 'sig-a' };

test('ReceiptStore：新观察让旧收据失效；节点签名可取出', () => {
  const store = new ReceiptStore({ now: () => 100 });
  store.addObservation(7, {
    observationId: 'ob1', documentId: 'doc-1', revision: 1, url: 'https://x/', fingerprint: 'fp-1',
    signatures: { '@e1': SIG_A },
  });
  store.addObservation(7, {
    observationId: 'ob2', documentId: 'doc-1', revision: 2, url: 'https://x/', fingerprint: 'fp-2', signatures: {},
  });
  assert.equal(store.getObservation(7, 'ob1').superseded, true);
  assert.equal(store.getObservation(7, 'ob2').receipt?.current, true);
  assert.equal(store.getObservation(7, 'ob1').receipt?.signatures['@e1']?.text, '提交');
  assert.equal(store.getObservation(7, 'nope').known, false);
});

test('ReceiptStore：context 单次使用与 policy', () => {
  const store = new ReceiptStore({ now: () => 1 });
  store.setPolicy(7, 'strict');
  assert.equal(store.getPolicy(7), 'strict');
  store.addContext(7, { contextId: 'c1', documentId: 'd', url: 'u', generation: 1, policy: 'strict' });
  assert.equal(store.getContext(7, 'c1')?.used, false);
  store.markContextUsed(7, 'c1');
  assert.equal(store.getContext(7, 'c1')?.used, true);
  store.addContext(7, { contextId: 'c2', documentId: 'd', url: 'u', generation: 2, policy: 'strict' });
  assert.equal(store.getContext(7, 'c1')?.current, false);
});

test('normalizeSignatures/expectFailed/normalizeChecks：畸形输入收敛与证据字段', () => {
  const sigs = normalizeSignatures({ '@e1': SIG_A, bad: null, '@e2': { attached: false } });
  assert.deepEqual(Object.keys(sigs).sort(), ['@e1', '@e2']);
  assert.equal(sigs['@e2']?.attached, false);
  const error = expectFailed('expect', [{ target: '#out', field: 'text', expected: '__never__', actual: 'x', kind: 'mismatch' }]);
  assert.equal(error.code, 'E_EXPECT_FAILED');
  assert.match(error.message, /__never__/);
  const data = error.data as { mismatch: { target: string }; effect_state: string; dispatched: boolean };
  assert.equal(data.mismatch.target, '#out');
  assert.equal(data.effect_state, 'none');
  assert.equal(data.dispatched, false);
  assert.deepEqual(normalizeChecks('[{"target":"#kw","field":"value","equals":"a"}]', 'x'), [{ target: '#kw', field: 'value', equals: 'a' }]);
  assert.throws(() => normalizeChecks('not-json', 'expect'), (e: unknown) => (e as RpcMethodError).code === 'E_BAD_ARG');
});

// ---------------------------------------------------------------------------
// frame 别名与逐帧观察
// ---------------------------------------------------------------------------

test('frame alias：@eN → @f<id>eN，可解析；URL 对账区分 hidden query', () => {
  assert.equal(frameAliasRef(3, '@e5'), '@f3e5');
  assert.deepEqual(parseFrameAlias('@f3e5'), { frameId: 3, localRef: '@e5' });
  assert.equal(parseFrameAlias('@e5'), null);
  assert.equal(urlsMatch('http://a/frame.html?hidden=1', 'http://a/frame.html?hidden=1#x'), true);
  assert.equal(urlsMatch('http://a/frame.html?hidden=1', 'http://a/frame.html'), false);
});

test('FrameObservationService：逐帧观察产出 aliases/隐藏帧/帧缺口，动作走 frame-projected', async () => {
  const ops: Array<{ op: string; frameId: number; params: Record<string, unknown> }> = [];
  const content = {
    async request(_tabId: number, request: ContentRequest, options: { frameId?: number } = {}): Promise<ContentReply> {
      const frameId = options.frameId ?? 0;
      ops.push({ op: request.op, frameId, params: request.params });
      if (request.op === 'frame-inventory') {
        return {
          ok: true,
          result: {
            frames: [
              { absoluteSrc: 'http://a/frame.html', hidden: false, hiddenReason: null },
              { absoluteSrc: 'http://a/hidden.html', hidden: true, hiddenReason: 'display-none' },
            ],
          },
        };
      }
      if (request.op === 'click') {
        return { ok: true, result: { ok: true, tag: 'button', x: 10, y: 20 } };
      }
      if (frameId === 0) {
        return { ok: true, result: { url: 'http://a/', observation: '- button "影子按钮" [@e1]', refs: 1, documentId: 'doc-0', revision: 1, nodes: [{ ref: '@e1' }] } };
      }
      return { ok: true, result: { url: 'http://a/frame.html', observation: '- button "框架内按钮" [@e1]', refs: 1, documentId: 'doc-' + String(frameId), revision: 2, nodes: [{ ref: '@e1' }] } };
    },
  };
  const navigation = {
    async getAllFrames() {
      return [
        { frameId: 0, parentFrameId: -1, url: 'http://a/' },
        { frameId: 5, parentFrameId: 0, url: 'http://a/frame.html' },
        { frameId: 6, parentFrameId: 0, url: 'http://a/hidden.html' },
      ];
    },
  };
  const service = new FrameObservationService({ content, navigation, now: () => 1 });
  const result = await service.observeFrames({ tabId: 7 });
  assert.equal(result.frames.length, 3);
  assert.equal(result.refs, 3);
  assert.equal(result.hiddenFrames, 1);
  const hidden = result.frames.find((frame) => frame.frameId === 6);
  assert.equal(hidden?.hidden, true);
  assert.equal(hidden?.hiddenReason, 'display-none');
  assert.equal(result.aliases.length, 2);
  assert.equal(result.aliases[0]?.ref, '@f5e1');
  assert.match(result.text, /框架内按钮/);
  const alias = service.aliasFor(7, '@f5e1');
  assert.ok(alias);
  const clicked = await service.dispatchInFrame(7, alias, 'click', {});
  assert.equal(clicked.via, 'frame-projected');
  assert.equal(clicked.frameId, 5);
  const clickOp = ops.find((op) => op.op === 'click');
  assert.equal(clickOp?.frameId, 5);
  assert.equal(clickOp?.params.ref, '@e1');
});

// ---------------------------------------------------------------------------
// upload / download
// ---------------------------------------------------------------------------

test('UploadService：分块写入 → commit 返回 committed，并校验缺失字节明确拒绝', async () => {
  const records: Array<{ op: string; params: Record<string, unknown> }> = [];
  const content = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      records.push({ op: request.op, params: request.params });
      if (request.op === 'upload-prepare') return { ok: true, result: { uploadId: 'up-1', files: 1, target: 'input', mode: 'input' } };
      if (request.op === 'upload-chunk') {
        const bytes = String(request.params.base64 ?? '').length;
        return { ok: true, result: { ok: true, received: bytes, eof: false } };
      }
      return { ok: true, result: { ok: true, via: 'input', names: ['a.txt'], files: [{ name: 'a.txt', size: 5, mime: 'text/plain' }], tag: 'input', selector: '#file', effectState: 'committed', note: 'x' } };
    },
  };
  const service = new UploadService({ content, now: () => 1 });
  const base64 = Buffer.from('hello').toString('base64');
  const result = await service.upload({ tabId: 7, selector: '#file', files: [{ name: 'a.txt', mime: 'text/plain', base64 }] });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'input');
  assert.deepEqual(result.names, ['a.txt']);
  assert.equal(result.effectState, 'committed');
  assert.deepEqual(records.map((record) => record.op), ['upload-prepare', 'upload-chunk', 'upload-commit']);

  await assert.rejects(
    service.upload({ tabId: 7, selector: '#file', files: [{ name: 'big.bin', transferId: 'tr_1' }] }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_NOT_IMPLEMENTED');
      assert.equal((error.data as { reason?: string }).reason, 'no-file-bytes');
      return true;
    },
  );
});

test('DownloadService：点击触发下载并等 chrome.downloads 完成；无下载回 E_NO_DOWNLOAD', async () => {
  let created: ((item: { id: number; state?: string; filename?: string; fileSize?: number }) => void) | null = null;
  const downloads = {
    async search(query: { id?: number; limit?: number }) {
      if (query.id === 12) return [{ id: 12, state: 'complete', filename: 'C:/tmp/sample.txt', fileSize: 28, url: 'http://a/api/download', mime: 'text/plain' }];
      return [] as Array<Record<string, unknown>>;
    },
    onCreated: {
      addListener(listener: (item: { id: number }) => void) { created = listener as never; },
      removeListener() { created = null; },
    },
  };
  const content = {
    async request(): Promise<ContentReply> {
      if (created) created({ id: 12 });
      return { ok: true, result: { ok: true } };
    },
  };
  const service = new DownloadService({
    content,
    downloads: downloads as never,
    now: (() => { let clock = 0; return () => (clock += 300); })(),
    sleep: async () => undefined,
  });
  const result = await service.download({ tabId: 7, selector: '#dl' });
  assert.equal(result.filename, 'C:/tmp/sample.txt');
  assert.equal(result.bytes, 28);
  assert.equal(result.effectState, 'committed');

  const emptyContent = { async request(): Promise<ContentReply> { return { ok: true, result: { ok: true } }; } };
  const missed = new DownloadService({
    content: emptyContent,
    downloads: { search: async () => [], onCreated: { addListener() {}, removeListener() {} } } as never,
    now: (() => { let clock = 0; return () => (clock += 600); })(),
    sleep: async () => undefined,
  });
  await assert.rejects(
    missed.download({ tabId: 7, selector: '#noop', timeoutMs: 1000 }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_NO_DOWNLOAD');
      assert.equal((error.data as { effect_state?: string }).effect_state, 'unknown');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 对话框近似
// ---------------------------------------------------------------------------

test('DialogService：click 捕获 confirm → E_DIALOG_PENDING；dismiss 重放并完成 operation', async () => {
  const state = {
    installed: false,
    armed: false,
    dialogs: [] as Array<{ id: number; type: string; message: string; at: number }>,
    plan: null as null | { settle: boolean; confirm?: boolean; promptText?: string },
    outcomes: [] as string[],
    clicks: 0,
    dialogOnNextClick: true,
  };
  const scripting: ScriptingApi = {
    scripting: {
      async executeScript<T = unknown>(injection: ScriptingInjection): Promise<Array<{ result?: T }>> {
        const func = injection.func as unknown;
        const args = (injection.args ?? []) as unknown[];
        if (func === mainWorldInstallDialogHooks) {
          const installed = !state.installed;
          state.installed = true;
          return [{ result: { ok: true, installed } as unknown as T }];
        }
        if (func === mainWorldReadDialogs) {
          const dialogs = state.dialogs.splice(0);
          return [{ result: { ok: true, dialogs } as unknown as T }];
        }
        if (func === mainWorldResolveDialog) {
          state.plan = args[0] as typeof state.plan;
          return [{ result: { ok: true } as unknown as T }];
        }
        // arm 钩子（mainWorldArmDialog 未导出）：按参数布尔值判定
        state.armed = args[0] === true;
        return [{ result: { ok: true, armed: state.armed } as unknown as T }];
      },
    },
  };
  const content = { async request(): Promise<ContentReply> { return { ok: true, result: {} }; } };
  const service = new DialogService({ content, scripting, now: () => 1000 });
  const dispatch = async (): Promise<unknown> => {
    state.clicks += 1;
    if (state.plan?.settle === true) {
      state.outcomes.push(state.plan.confirm === true ? 'accepted' : 'dismissed');
      return { ok: true };
    }
    if (state.dialogOnNextClick && state.armed) {
      state.dialogs.push({ id: 1, type: 'confirm', message: '确定继续吗？', at: 1000 });
      state.dialogOnNextClick = false;
    }
    return { ok: true };
  };
  await assert.rejects(service.dispatchClick(7, { selector: '#dlg-confirm' }, dispatch), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_DIALOG_PENDING');
    const data = error.data as { dispatched: boolean; operationId: string; dialog: { id: number; type: string } };
    assert.equal(data.dispatched, true);
    assert.equal(data.dialog.type, 'confirm');
    assert.equal(typeof data.operationId, 'string');
    return true;
  });
  assert.equal(service.status().dialogs instanceof Array, true);
  assert.equal((service.status().dialogs as Array<{ action: string }>)[0]?.action, 'pending');

  // 挂起期间的新动作：不派发（dispatched=false）。
  await assert.rejects(service.dispatchClick(7, { selector: '#dlg-alert' }, dispatch), (error: unknown) => {
    assert.equal((error as RpcMethodError).code, 'E_DIALOG_PENDING');
    const blockedData = (error as RpcMethodError).data as { dispatched: boolean };
    assert.equal(blockedData.dispatched, false);
    return true;
  });

  const dismissed = await service.dismiss({ id: 1 }, dispatch);
  assert.equal(dismissed.action, 'dismissed');
  assert.equal(state.outcomes[0], 'dismissed', '重放点击让页面拿到 dismiss 值');
  const awaited = await service.awaitOperation({ id: dismissed.operationId, timeoutMs: 100 });
  assert.equal(awaited.state, 'completed');
  assert.equal(service.pendingOf(7), null);
});

// ---------------------------------------------------------------------------
// debug 只读域
// ---------------------------------------------------------------------------

test('OperationTimeline：commandId 只用时间窗归因，窗口外返回 null', () => {
  const timeline = new OperationTimeline();
  timeline.record({ id: 'c1', method: 'click', startedAt: 1000, finishedAt: 1100, ok: true });
  assert.equal(timeline.commandFor(1050), 'c1');
  assert.equal(timeline.commandFor(5000), null);
  assert.equal(timeline.entries(10).length, 1);
});

test('DebugService：capabilities/pin/rules/console 分页（脚本假执行）', async () => {
  const scripting: ScriptingApi = {
    scripting: {
      async executeScript<T = unknown>(injection: ScriptingInjection): Promise<Array<{ result?: T }>> {
        const args = (injection.args ?? []) as Array<Record<string, unknown>>;
        const since = Number(args[0]?.since ?? 0);
        const entries = [
          { id: 1, level: 'log', text: 'cursor-a', at: 1 },
          { id: 2, level: 'warn', text: 'cursor-b', at: 2 },
        ].filter((entry) => entry.id > since);
        return [{ result: { ok: true, entries: entries.slice(0, 1), next: entries.length > 1 ? 1 : null, total: entries.length } as unknown as T }];
      },
    },
  };
  const content = { async request(): Promise<ContentReply> { return { ok: true, result: { url: 'http://a/', entries: [] } }; } };
  const rules = {
    async getSessionRules() { return [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '*/api/*' } }]; },
    async getDynamicRules() { return []; },
  };
  const debug = new DebugService({ content, scripting, rules, now: () => 10 });
  const caps = debug.capabilities();
  assert.equal((caps.actions as string[]).includes('pin'), true);
  assert.equal((caps.parts as string[]).includes('metadata'), true);
  debug.pin({ id: 'req-1' });
  assert.deepEqual(debug.pinnedList().pinned, ['req-1']);
  debug.pin({ id: 'req-1', pinned: false });
  assert.deepEqual(debug.pinnedList().pinned, []);
  const listed = await debug.rulesList();
  assert.equal((listed.rules as Array<{ action: string }>)[0]?.action, 'block');
  assert.equal(listed.readonly, true);
  const page = await debug.console({ tabId: 7, limit: 1 });
  assert.equal((page.entries as unknown[]).length, 1);
  assert.equal(page.nextCursor, 1);
});

// ---------------------------------------------------------------------------
// rich observe（VOM/AX/facts）
// ---------------------------------------------------------------------------

test('buildRichObservation：VOM 节点/AX 合并/facts/表格/阻挡层', () => {
  const elements: FakeElementSpec[] = [
    { tag: 'h1', text: '标题', rect: { left: 0, top: 0, width: 600, height: 40 } },
    {
      tag: 'form',
      id: 'f',
      rect: { left: 0, top: 40, width: 600, height: 200 },
      children: [
        {
          tag: 'input', id: 'kw', type: 'text', attrs: { 'aria-label': '搜索关键词' }, value: 'hello',
          rect: { left: 10, top: 50, width: 200, height: 28 },
        },
        { tag: 'button', id: 'submit', text: '提交', rect: { left: 10, top: 90, width: 80, height: 30 } },
      ],
    },
    {
      tag: 'table',
      id: 'people',
      rect: { left: 0, top: 250, width: 400, height: 100 },
      children: [
        {
          tag: 'thead',
          children: [{
            tag: 'tr',
            children: [
              { tag: 'th', text: '姓名', rect: { left: 0, top: 250, width: 100, height: 20 } },
              { tag: 'th', text: '城市', rect: { left: 100, top: 250, width: 100, height: 20 } },
            ],
          }],
        },
      ],
    },
  ];
  const fake = createFakeDom(elements, { title: '夹具页', url: 'https://example.test/test.html' });
  const built = buildObservation(fake.env, {});
  const rich = buildRichObservation(fake.env, built, { vom: true, ax: true, facts: true });
  assert.ok(Array.isArray(rich.nodes) && rich.nodes.length > 0);
  const button = rich.nodes?.find((node) => node.role === 'button');
  assert.equal(button?.name, '提交');
  assert.equal(button?.clickable, true);
  assert.equal(button?.backendNodeSource, 'dom-order');
  assert.equal(button?.ax?.role, 'button');
  assert.equal(Number.isInteger(button?.backendNodeId), true);
  assert.equal(rich.axJoin?.matched, rich.axJoin?.byBackendNodeId);
  assert.ok((rich.axJoin?.byBackendNodeId ?? 0) > 0);
  assert.ok((rich.facts?.nodes ?? 0) > 0);
  assert.equal(rich.facts?.axMatched, rich.facts?.vomMatched);
  const input = rich.nodes?.find((node) => node.domId === 'kw');
  assert.equal(input?.inForm, true);
  assert.equal(input?.inputState, 'filled');
  assert.equal(input?.domValue, 'hello');
  assert.ok(Array.isArray(rich.tables) && rich.tables.some((table) => table.headers.includes('姓名') && table.headers.includes('城市')));
  assert.ok(Array.isArray(rich.vom?.stages) && rich.vom?.stages.length === 6);
  assert.ok((rich.vom?.edges.length ?? 0) > 0);
  assert.match(String(rich.ariaSnapshot), /- button "提交"/);
  assert.ok(Array.isArray(rich.blockingLayers));
});

test('buildRichObservation：vom-deep 节点按绘制序（y 升序）并带漏斗摘要', () => {
  const fake = createFakeDom([
    { tag: 'h1', text: '标题', rect: { left: 0, top: 0, width: 600, height: 40 } },
    { tag: 'button', text: '下', rect: { left: 0, top: 200, width: 80, height: 30 } },
    { tag: 'button', text: '上', rect: { left: 0, top: 60, width: 80, height: 30 } },
  ], { title: 't', url: 'https://example.test/' });
  const built = buildObservation(fake.env, {});
  const rich = buildRichObservation(fake.env, built, { vomDeep: true });
  const nodes = rich.deepVom?.nodes ?? [];
  assert.ok(nodes.length >= 3);
  const ys = nodes.map((node) => node.bounds.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  assert.equal(rich.deepVom?.stages.sorted, 'paint-order');
  assert.ok((rich.deepVom?.vomFunnel.droppedReasons.length ?? 0) >= 1);
});
