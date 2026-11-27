// tests/extended-actions.test.ts —— 第三批扩展动作面（ExtendedActionRegistry）单测。
//
// 覆盖：参数校验、ref/stableRef 解析、薄动作透传、提取预算与分页游标、等待/取消、
// request-help 的 allowHelp 语义、cooperate.sync 的只读策略投影与 --match-text 折叠。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtendedActionRegistry, EXTENDED_METHODS } from '../src/actions/extended.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import type { CaptureRecordView } from '../src/actions/extended.ts';
import type { ContentRequest, ContentReply } from '../src/content/protocol.ts';

type Handler = (params: Record<string, unknown>) => unknown;

function createHarness(options: {
  handlers?: Record<string, Handler>;
  settings?: { allowHelp?: boolean };
  authorize?: (tabId: number, method: string) => { ok: true } | { ok: false; code: string; message: string; data?: unknown };
  capture?: CaptureRecordView | null;
} = {}) {
  const requests: ContentRequest[] = [];
  const handlers = options.handlers ?? {};
  const refs = new RefRegistry();
  refs.registerObservation(7, {
    documentId: 'doc-1',
    revision: 3,
    refs: [{ ref: '@e1', role: 'button', name: '提交', identity: 'id|#submit', stableRef: 's-abc' }],
  });
  const constants: Record<string, unknown> = {
    metrics: { scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 500, scrollWidth: 1000, scrollHeight: 500, devicePixelRatio: 1, documentId: 'doc-1' },
    scroll: { ok: true, scrollX: 0, scrollY: 0, clampedX: 0, clampedY: 0, bounds: null, viewport: { width: 1000, height: 500 }, ref: null, selector: null, via: 'content-script' },
    'element-state': { attached: true, visible: true, rect: { x: 10, y: 20, width: 100, height: 40 }, tag: 'button', id: 'submit', role: 'button', name: '提交', value: null, disabled: false, inViewport: true, ref: null, selector: null },
  };
  const transport = {
    async request(_tabId: number, request: ContentRequest): Promise<ContentReply> {
      requests.push(request);
      const handler = handlers[request.op];
      if (handler) {
        try {
          return { ok: true, result: handler(request.params) };
        } catch (error) {
          return { ok: false, code: (error as { code?: string }).code ?? 'E_INTERNAL', message: (error as Error).message };
        }
      }
      if (Object.prototype.hasOwnProperty.call(constants, request.op)) return { ok: true, result: constants[request.op] };
      return { ok: false, code: 'E_UNKNOWN_OP', message: 'no handler for ' + request.op };
    },
  };
  const captures = options.capture === undefined
    ? null
    : {
      consume: (id: string) => (options.capture && options.capture.id === id ? options.capture : null),
    };
  const registry = new ExtendedActionRegistry({
    content: transport,
    refs,
    captures,
    readSettings: async () => options.settings ?? { allowHelp: true },
    authorize: options.authorize ?? null,
    setTimer: (handler, ms) => setTimeout(handler, Math.min(ms, 5)),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return { registry, requests, refs };
}

function extractPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'auto',
    columns: [{ key: 'c1', label: '姓名' }, { key: 'c2', label: '城市' }],
    rows: [
      { c1: '张三', c2: '北京' },
      { c1: '李四', c2: '上海' },
      { c1: '王五', c2: '深圳' },
    ],
    totalRows: 3,
    targets: [],
    frameCount: 1,
    framesScanned: 1,
    framesSeen: 1,
    limits: { maxFrames: 16, maxTargets: 32, previewColumns: 8 },
    truncated: false,
    sourceLabel: 'auto',
    totalTables: 1,
    fingerprint: 'fp-1',
    ...overrides,
  };
}

test('extended：方法清单覆盖第三批全部方法且都有描述', () => {
  const { registry } = createHarness();
  assert.deepEqual(registry.methods(), [...EXTENDED_METHODS]);
  assert.equal(EXTENDED_METHODS.length >= 20, true);
  for (const spec of registry.specsList()) {
    assert.equal(typeof spec.description, 'string');
    assert.equal(spec.description.length > 0, true, spec.method + ' 缺少描述');
  }
});

test('extended：未注册方法回 E_UNKNOWN_METHOD', async () => {
  const { registry } = createHarness();
  await assert.rejects(() => registry.dispatch('no-such-method', {}), (error: unknown) => (error as { code?: string }).code === 'E_UNKNOWN_METHOD');
});

test('extended：scroll-to 透传 selector 并返回边界/视口', async () => {
  const { registry, requests } = createHarness();
  const result = await registry.dispatch('scroll-to', { tabId: 7, selector: '#bottom' }) as { ok: boolean; viewport: { height: number } };
  assert.equal(result.ok, true);
  assert.equal(requests[0]?.op, 'scroll');
  assert.equal(requests[0]?.params.selector, '#bottom');
  assert.equal(result.viewport.height, 500);
});

test('extended：scroll-to 缺目标与坐标时报 E_BAD_ARG', async () => {
  const { registry } = createHarness();
  await assert.rejects(() => registry.dispatch('scroll-to', { tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('extended：hover 通过 ref 解析并标注合成事件', async () => {
  const { registry, requests } = createHarness({
    handlers: {
      hover: () => ({ ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'button', ref: '@e1', selector: null, x: 10, y: 20, generated: 3 }),
    },
  });
  const result = await registry.dispatch('hover', { tabId: 7, ref: '@e1' }) as { effectState: string; synthetic: boolean };
  assert.equal(result.effectState, 'none');
  assert.equal(result.synthetic, true);
  assert.equal(requests[0]?.params.ref, '@e1');
  assert.equal(requests[0]?.params.documentId, 'doc-1');
});

test('extended：press 缺 key 报 E_BAD_ARG，有 key 派发', async () => {
  const { registry, requests } = createHarness({
    handlers: {
      press: () => ({ ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'button', ref: null, selector: '#submit', x: null, y: null, key: 'Enter', generated: 3 }),
    },
  });
  await assert.rejects(() => registry.dispatch('press', { tabId: 7, selector: '#submit' }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  const result = await registry.dispatch('press', { tabId: 7, selector: '#submit', key: 'Enter' }) as { effectState: string };
  assert.equal(result.effectState, 'committed');
  assert.equal(requests[0]?.params.key, 'Enter');
});

test('extended：wheel 校验 delta 类型', async () => {
  const { registry } = createHarness();
  await assert.rejects(() => registry.dispatch('wheel', { tabId: 7, deltaY: 'abc' }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
});

test('extended：drag 从 from 目标对象读取 selector', async () => {
  const { registry, requests } = createHarness({
    handlers: {
      drag: () => ({ ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'div', ref: null, selector: '#drag-src', x: 1, y: 2, from: { x: 1, y: 2 }, to: { x: 41, y: 32 }, steps: 4, generated: 10 }),
    },
  });
  const result = await registry.dispatch('drag', { tabId: 7, from: { selector: '#drag-src' }, dx: 40, dy: 30, steps: 4 }) as { points: number; mode: string };
  assert.equal(result.points, 4);
  assert.equal(result.mode, 'hold');
  assert.equal(requests[0]?.params.selector, '#drag-src');
  assert.equal(requests[0]?.params.dx, 40);
});

test('extended：click-point 缺 capture / capture 过期明确报错', async () => {
  const missing = createHarness();
  await assert.rejects(() => missing.registry.dispatch('click-point', { tabId: 7, capture: 'c1', imageX: 1, imageY: 2 }), (error: unknown) => (error as { code?: string }).code === 'E_NOT_IMPLEMENTED');
  const stale = createHarness({ capture: null });
  await assert.rejects(() => stale.registry.dispatch('click-point', { tabId: 7, capture: 'c1', imageX: 1, imageY: 2 }), (error: unknown) => (error as { code?: string }).code === 'E_CAPTURE_STALE');
});

test('extended：click-point 图像坐标 → 页面坐标（含 scroll 与 scale）', async () => {
  const { registry, requests } = createHarness({
    capture: { id: 'cap-1', tabId: 7, scale: 2, scrollX: 10, scrollY: 20, width: 400, height: 300, at: 1 },
    handlers: {
      metrics: () => ({ scrollX: 10, scrollY: 20 }),
      'click-point': () => ({ ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'button', ref: null, selector: null, x: 35, y: 45, generated: 3 }),
    },
  });
  const result = await registry.dispatch('click-point', { tabId: 7, capture: 'cap-1', imageX: 50, imageY: 50 }) as { x: number; y: number; capture: string };
  assert.equal(result.x, 35, 'pageX = scrollX + imageX/scale');
  assert.equal(result.y, 45);
  assert.equal(result.capture, 'cap-1');
  const clickParams = requests.find((request) => request.op === 'click-point')?.params;
  assert.equal(clickParams?.x, 35);
});

test('extended：click-point 截图后页面滚动 → E_CAPTURE_STALE', async () => {
  const { registry } = createHarness({
    capture: { id: 'cap-1', tabId: 7, scale: 1, scrollX: 0, scrollY: 0, width: 100, height: 100, at: 1 },
    handlers: { metrics: () => ({ scrollX: 0, scrollY: 80 }) },
  });
  await assert.rejects(
    () => registry.dispatch('click-point', { tabId: 7, capture: 'cap-1', imageX: 10, imageY: 10 }),
    (error: unknown) => (error as { code?: string }).code === 'E_CAPTURE_STALE',
  );
});

test('extended：snapshot 返回文本并重建 ref 表', async () => {
  const { registry, refs } = createHarness({
    handlers: {
      observe: () => ({
        url: 'https://example.test/',
        title: '示例',
        observation: '- button "提交" [@e1]',
        refs: 1,
        revision: 5,
        documentId: 'doc-1',
        nodes: [{ ref: '@e1', role: 'button', name: '提交', tag: 'button', id: 'submit' }],
      }),
    },
  });
  const result = await registry.dispatch('snapshot', { tabId: 7 }) as { text: string; refs: number; observationId: string };
  assert.equal(result.text.includes('提交'), true);
  assert.equal(result.refs, 1);
  assert.equal(result.observationId.startsWith('ob_'), true);
  assert.ok(refs.resolve(7, '@e1').ok);
});

test('extended：actionable 依据元素状态给出 ok/reason', async () => {
  const ok = createHarness({
    handlers: { 'element-state': () => ({ attached: true, visible: true, disabled: false, tag: 'button', rect: { x: 0, y: 0, width: 1, height: 1 }, inViewport: true }) },
  });
  const okResult = await ok.registry.dispatch('actionable', { tabId: 7, selector: '#submit' }) as { ok: boolean; reason: null };
  assert.equal(okResult.ok, true);
  assert.equal(okResult.reason, null);
  const hidden = createHarness({
    handlers: { 'element-state': () => ({ attached: true, visible: false, disabled: false, tag: 'button', rect: { x: 0, y: 0, width: 0, height: 0 }, inViewport: false }) },
  });
  const hiddenResult = await hidden.registry.dispatch('actionable', { tabId: 7, selector: '#submit' }) as { ok: boolean; reason: string };
  assert.equal(hiddenResult.ok, false);
  assert.equal(hiddenResult.reason, 'hidden');
});

test('extended：extract 预算 maxRows 截断并给 cursor/budget', async () => {
  const { registry } = createHarness({ handlers: { extract: () => extractPayload() } });
  const result = await registry.dispatch('extract', { tabId: 7, maxRows: 1 }) as {
    rowCount: number; rows: Array<Record<string, string>>; truncated: boolean; hasMore: boolean; cursor: string;
    budget: { maxRows: number; rows: number; stopReason: string }; coverage: { omitted: number };
  };
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor.startsWith('x1.extract.1.'), true);
  assert.equal(result.budget.maxRows, 1);
  assert.equal(result.budget.rows, 1);
  assert.equal(result.budget.stopReason, 'max-rows');
  assert.equal(result.coverage.omitted, 2);
});

test('extended：extract 预算 maxCells 生效', async () => {
  const { registry } = createHarness({ handlers: { extract: () => extractPayload() } });
  const result = await registry.dispatch('extract', { tabId: 7, maxCells: 2 }) as { cells: number; budget: { stopReason: string; maxCells: number } };
  assert.equal(result.cells <= 2, true);
  assert.equal(result.budget.stopReason, 'max-cells');
  assert.equal(result.budget.maxCells, 2);
});

test('extended：extract 预算 maxBytes 生效（按行序列化字节累计）', async () => {
  const { registry } = createHarness({ handlers: { extract: () => extractPayload() } });
  const result = await registry.dispatch('extract', { tabId: 7, maxBytes: 30 }) as { rowCount: number; budget: { stopReason: string } };
  assert.equal(result.rowCount < 3, true);
  assert.equal(result.budget.stopReason, 'max-bytes');
});

test('extended：extract 游标续取 offset 前进', async () => {
  const { registry } = createHarness({ handlers: { extract: () => extractPayload() } });
  const first = await registry.dispatch('extract', { tabId: 7, maxRows: 1 }) as { cursor: string };
  const second = await registry.dispatch('extract', { tabId: 7, cursor: first.cursor }) as { offset: number; rows: Array<Record<string, string>> };
  assert.equal(second.offset, 1);
  assert.equal(second.rows[0]?.c1, '李四');
});

test('extended：extract 游标跨方法 / 指纹变化都回 E_CURSOR_STALE', async () => {
  const { registry } = createHarness({ handlers: { extract: () => extractPayload() } });
  const first = await registry.dispatch('extract', { tabId: 7, maxRows: 1 }) as { cursor: string };
  await assert.rejects(
    () => registry.dispatch('extract.list', { tabId: 7, selector: '#items', cursor: first.cursor }),
    (error: unknown) => (error as { code?: string }).code === 'E_CURSOR_STALE',
  );
  const stale = createHarness({ handlers: { extract: () => extractPayload({ fingerprint: 'fp-2' }) } });
  await assert.rejects(
    () => stale.registry.dispatch('extract', { tabId: 7, cursor: first.cursor }),
    (error: unknown) => (error as { code?: string }).code === 'E_CURSOR_STALE',
  );
});

test('extended：extract.list 需要目标，extract.discover 返回帧/上限统计', async () => {
  const list = createHarness();
  await assert.rejects(() => list.registry.dispatch('extract.list', { tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  const discover = createHarness({
    handlers: {
      extract: (params) => extractPayload({
        mode: params.mode,
        targets: [{ id: '0', kind: 'table', frameId: 0, label: '人员表', columns: 3, rowCount: 3, preview: { columns: ['姓名'], sample: [{ c1: '张三' }] } }],
      }),
    },
  });
  const result = await discover.registry.dispatch('extract.discover', { tabId: 7 }) as { targets: unknown[]; limits: { maxTargets: number }; framesScanned: number };
  assert.equal(result.targets.length, 1);
  assert.equal(result.limits.maxTargets, 32);
  assert.equal(result.framesScanned, 1);
});

test('extended：wait-ms 参数校验与等待', async () => {
  const { registry } = createHarness();
  await assert.rejects(() => registry.dispatch('wait-ms', { tabId: 7, ms: -1 }), (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG');
  const result = await registry.dispatch('wait-ms', { tabId: 7, ms: 5 }) as { ok: boolean; ms: number };
  assert.equal(result.ok, true);
  assert.equal(result.ms, 5);
});

test('extended：wait-for-element 元素可见后 satisfied', async () => {
  let polls = 0;
  const { registry } = createHarness({
    handlers: {
      'element-state': () => {
        polls += 1;
        return polls >= 2
          ? { attached: true, visible: true, rect: { x: 0, y: 0, width: 10, height: 10 }, tag: 'div', id: 'out', role: null, name: null, value: null, disabled: false, inViewport: true, ref: null, selector: '#out' }
          : { attached: false, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, tag: 'div', id: null, role: null, name: null, value: null, disabled: false, inViewport: false, ref: null, selector: '#out' };
      },
    },
  });
  const result = await registry.dispatch('wait-for-element', { tabId: 7, selector: '#out', state: 'visible', timeoutMs: 500, operationId: 'op-1' }) as {
    satisfied: boolean; timedOut: boolean; cancelled: boolean; operationId: string;
  };
  assert.equal(result.satisfied, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.operationId, 'op-1');
  assert.equal(result.satisfied && polls >= 2, true);
});

test('extended：wait-for-element 超时返回 satisfied=false/timedOut=true', async () => {
  const { registry } = createHarness({
    handlers: { 'element-state': () => ({ attached: false, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, tag: 'div', id: null, role: null, name: null, value: null, disabled: false, inViewport: false, ref: null, selector: '#nope' }) },
  });
  const result = await registry.dispatch('wait-for-element', { tabId: 7, selector: '#nope', state: 'visible', timeoutMs: 20 }) as { satisfied: boolean; timedOut: boolean };
  assert.equal(result.satisfied, false);
  assert.equal(result.timedOut, true);
});

test('extended：wait-for-element 可被 operation.cancel 中止', async () => {
  const { registry } = createHarness({
    handlers: { 'element-state': () => ({ attached: false, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, tag: 'div', id: null, role: null, name: null, value: null, disabled: false, inViewport: false, ref: null, selector: '#nope' }) },
  });
  const waiting = registry.dispatch('wait-for-element', { tabId: 7, selector: '#nope', timeoutMs: 5000, operationId: 'op-cancel' }) as Promise<{ cancelled: boolean; timedOut: boolean }>;
  assert.deepEqual(registry.pendingOperationIds(), ['op-cancel']);
  const cancelled = await registry.dispatch('operation.cancel', { id: 'op-cancel' }) as { cancelled: boolean };
  assert.equal(cancelled.cancelled, true);
  const result = await waiting;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(registry.pendingOperationIds(), []);
});

test('extended：wait-for-element 可被 daemon cancel 帧（rpc_id）中止', async () => {
  const { registry } = createHarness({
    handlers: { 'element-state': () => ({ attached: false, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, tag: 'div', id: null, role: null, name: null, value: null, disabled: false, inViewport: false, ref: null, selector: '#nope' }) },
  });
  const waiting = registry.dispatch('wait-for-element', { tabId: 7, selector: '#nope', timeoutMs: 5000 }, { requestId: 'rpc-9' }) as Promise<{ cancelled: boolean }>;
  const cancelled = await registry.dispatch('cancel', { rpc_id: 'rpc-9' }) as { cancelled: boolean };
  assert.equal(cancelled.cancelled, true);
  const result = await waiting;
  assert.equal(result.cancelled, true);
});

test('extended：request-help 在 allowHelp=false 时回 E_HELP_DISABLED', async () => {
  const { registry } = createHarness({ settings: { allowHelp: false } });
  await assert.rejects(() => registry.dispatch('request-help', { tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_HELP_DISABLED');
  const enabled = createHarness({ settings: { allowHelp: true } });
  await assert.rejects(() => enabled.registry.dispatch('request-help', { tabId: 7 }), (error: unknown) => (error as { code?: string }).code === 'E_NOT_IMPLEMENTED');
});

test('extended：cooperate.sync 投影 per-tab 只读策略到 authority.four.action', async () => {
  const { registry } = createHarness({
    handlers: {
      observe: () => ({ url: 'https://example.test/', title: '示例', observation: '- button "提交" [@e1]\n- text 其它', refs: 1, revision: 2, documentId: 'doc-1', nodes: [{ ref: '@e1', role: 'button', name: '提交', tag: 'button', id: 'submit' }] }),
    },
    authorize: () => ({ ok: false, code: 'E_READ_ONLY', message: '只读', data: { reason: 'read-only' } }),
  });
  const result = await registry.dispatch('cooperate.sync', { tabId: 7 }) as {
    authority: { four: { action: { allowed: boolean; deniedReason: string } } };
    cooperation: { frameState: { revision: number } };
    observation: { text: string };
  };
  assert.equal(result.authority.four.action.allowed, false);
  assert.equal(result.authority.four.action.deniedReason, 'read-only');
  assert.equal(result.cooperation.frameState.revision, 2);
  assert.equal(result.observation.text.includes('提交'), true);
});

test('extended：cooperate.sync --match-text 折叠并标记省略行', async () => {
  const lines = [
    '- heading "页面"',
    '- textbox "关键词"',
    '- button "提交" [@e1]',
    '- text 其它 1',
    '- text 其它 2',
    '- text 其它 3',
  ];
  const { registry } = createHarness({
    handlers: {
      observe: () => ({ url: 'https://example.test/', title: '示例', observation: lines.join('\n'), refs: 1, revision: 1, documentId: 'doc-1', nodes: [{ ref: '@e1', role: 'button', name: '提交', tag: 'button', id: 'submit' }] }),
    },
  });
  const result = await registry.dispatch('cooperate.sync', { tabId: 7, matchText: '提交', contextLines: 1 }) as { observation: { text: string } };
  assert.equal(result.observation.text.includes('提交'), true);
  assert.equal(result.observation.text.includes('lines omitted'), true);
  assert.equal(result.observation.text.includes('其它 3'), false);
});
