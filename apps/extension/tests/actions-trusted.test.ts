// tests/actions-trusted.test.ts —— 动作层可信输入路由（20z / 7 / 7b / 23h3 / 23h4）单测。
//
// 覆盖：
// 1) trusted:true 的 click/fill 走 CDP（假 InputService + 假定位器），回包带
//    via:'cdp-backend' / trusted:true / inputMode:'cdp-input'，并把 backendNodeId 回填注册表；
// 2) 非 trusted / --synthetic 保持内容脚本路径（35d 的 fail-closed 语义不变）；
// 3) stableRef 解析后同样走 CDP；
// 4) 遮挡 → E_OCCLUDED（带 occludedBy，35b），定位不到 → 回退内容脚本（不假成功）；
// 5) hover/press/drag 的 trusted 路由（press 用 DOM.focus，不点目标）；
// 6) 原生输入归因时钟由 cooperate.sync 合并（23h3/23h4 不回退）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodError } from '../src/rpc/registry.ts';
import { ActionRegistry } from '../src/actions/registry.ts';
import { ExtendedActionRegistry } from '../src/actions/extended.ts';
import { ReceiptStore } from '../src/actions/receipts.ts';
import { TrustedInputClock, type TrustedInputPort } from '../src/actions/trusted-input.ts';
import type { BackendNodeHit, BackendNodeLocatorPort, BackendTargetDescriptor, HitTestResult, NodePoint, NodeValueView } from '../src/actions/backend-locator.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { StubContentTransport } from './support/stub-content.ts';

const OBSERVE_RESULT = {
  url: 'https://example.test/',
  title: '示例',
  observation: '- textbox "关键词" [@e1]\n- button "提交" [@e2]',
  refs: 2,
  revision: 4,
  documentId: 'doc-a',
  nodes: [
    { ref: '@e1', role: 'textbox', name: '关键词', tag: 'input', id: 'kw' },
    { ref: '@e2', role: 'button', name: '提交', tag: 'button', id: 'submit-btn' },
  ],
};

class FakeInput implements TrustedInputPort {
  readonly clickPoints: Array<{ tabId: number; point: { x: number; y: number }; options: Record<string, unknown> | undefined }> = [];
  readonly hoverPoints: Array<{ tabId: number; point: { x: number; y: number }; options: Record<string, unknown> | undefined }> = [];
  readonly backendClicks: Array<{ tabId: number; backendNodeId: number; options: Record<string, unknown> | undefined }> = [];
  readonly pressed: Array<{ tabId: number; key: unknown }> = [];
  readonly inserted: Array<{ tabId: number; text: string }> = [];
  readonly selectAlls: number[] = [];
  readonly drags: Array<{ tabId: number; from: { x: number; y: number }; to: { x: number; y: number }; options: Record<string, unknown> | undefined }> = [];

  async clickPoint(tabId: number, point: { x: number; y: number }, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.clickPoints.push({ tabId, point, options });
    return { ok: true, trusted: true, x: point.x, y: point.y, via: 'cdp-input' };
  }

  async hoverPoint(tabId: number, point: { x: number; y: number }, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.hoverPoints.push({ tabId, point, options });
    return { ok: true, trusted: true, x: point.x, y: point.y, moves: 5, via: 'cdp-input' };
  }

  async pressKey(tabId: number, spec: unknown): Promise<Record<string, unknown>> {
    this.pressed.push({ tabId, key: spec });
    return { ok: true, trusted: true, key: String(spec), code: 'Enter', via: 'cdp-input' };
  }

  async insertText(tabId: number, text: string): Promise<Record<string, unknown>> {
    this.inserted.push({ tabId, text });
    return { ok: true, trusted: true, length: text.length, via: 'cdp-input' };
  }

  async selectAll(tabId: number): Promise<void> {
    this.selectAlls.push(tabId);
  }

  async dragPath(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.drags.push({ tabId, from, to, options });
    return { ok: true, trusted: true, from, to, steps: Number(options?.['steps'] ?? 8), via: 'cdp-input' };
  }

  async clickBackendNode(tabId: number, backendNodeId: number, options?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.backendClicks.push({ tabId, backendNodeId, options });
    return { ok: true, trusted: true, via: 'cdp-backend', backendNodeId, x: 11, y: 22, tag: 'button', moves: 5 };
  }
}

interface FakeLocatorOptions {
  hits?: Record<string, BackendNodeHit | null>;
  hitTest?: HitTestResult;
  value?: NodeValueView;
}

class FakeLocator implements BackendNodeLocatorPort {
  readonly locateCalls: BackendTargetDescriptor[] = [];
  readonly pointCalls: number[] = [];
  readonly focusCalls: number[] = [];
  readonly hitTests: Array<{ backendNodeId: number; nodeId: number; x: number; y: number }> = [];
  readonly caretCalls: number[] = [];
  private readonly options: FakeLocatorOptions;

  constructor(options: FakeLocatorOptions = {}) {
    this.options = options;
  }

  async locate(_tabId: number, target: BackendTargetDescriptor): Promise<BackendNodeHit | null> {
    this.locateCalls.push(target);
    const key = target.selector ?? target.id ?? target.tag ?? 'default';
    if (this.options.hits && Object.hasOwn(this.options.hits, key)) return this.options.hits[key] ?? null;
    if (this.options.hits && Object.hasOwn(this.options.hits, 'default')) return this.options.hits['default'] ?? null;
    return {
      backendNodeId: target.id === 'kw' || target.tag === 'input' ? 41 : 42,
      nodeId: target.id === 'kw' || target.tag === 'input' ? 6 : 7,
      tag: target.tag === 'input' ? 'input' : 'button',
      id: target.id ?? null,
      role: target.role ?? null,
      name: target.name ?? null,
      attributes: target.id ? { id: target.id } : {},
      inClosedShadow: false,
      inOpenShadow: false,
    };
  }

  async point(_tabId: number, backendNodeId: number): Promise<NodePoint | null> {
    this.pointCalls.push(backendNodeId);
    return { x: 10, y: 20, width: 40, height: 20, tag: 'button', connected: true };
  }

  async hitTest(_tabId: number, target: { backendNodeId: number; nodeId: number }, point: { x: number; y: number }): Promise<HitTestResult> {
    this.hitTests.push({ backendNodeId: target.backendNodeId, nodeId: target.nodeId, x: point.x, y: point.y });
    return this.options.hitTest ?? { relation: 'self', occludedBy: null };
  }

  async describeValue(): Promise<NodeValueView | null> {
    return this.options.value ?? { tag: 'input', value: '', editable: true, readOnly: false, disabled: false, type: 'text' };
  }

  async focus(_tabId: number, backendNodeId: number): Promise<boolean> {
    this.focusCalls.push(backendNodeId);
    return true;
  }

  async caretToEnd(_tabId: number, backendNodeId: number): Promise<boolean> {
    this.caretCalls.push(backendNodeId);
    return true;
  }
}

function makeContent(): StubContentTransport {
  const content = new StubContentTransport();
  content.set('observe', () => ({ ok: true, result: { ...OBSERVE_RESULT } }));
  content.set('element-state', (request) => {
    const ref = String(request.params.ref ?? '');
    const tag = ref === '@e1' ? 'input' : 'button';
    return {
      ok: true,
      result: {
        attached: true,
        visible: true,
        rect: { x: 0, y: 0, width: 40, height: 20 },
        tag,
        id: ref === '@e1' ? 'kw' : 'submit-btn',
        role: ref === '@e1' ? 'textbox' : 'button',
        name: ref === '@e1' ? '关键词' : '提交',
        value: null,
        disabled: false,
        inViewport: true,
        ref,
        selector: null,
      },
    };
  });
  content.set('click', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'button',
      x: 120,
      y: 40,
      via: 'content-script',
      hit: 'self',
      isConnected: true,
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('fill', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'input',
      expected_value: String(request.params.value ?? ''),
      actual_value: String(request.params.value ?? ''),
      matches: true,
      cleared: true,
      via: 'content-script',
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('hover', () => ({ ok: true, result: { ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'button', x: 1, y: 2, generated: 3 } }));
  content.set('press', () => ({ ok: true, result: { ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'body', x: null, y: null, generated: 3 } }));
  content.set('drag', () => ({ ok: true, result: { ok: true, via: 'content-script', trusted: false, synthetic: true, tag: 'div', x: 1, y: 2, steps: 6 } }));
  return content;
}

async function observe(registry: ActionRegistry | ExtendedActionRegistry, tabId = 7): Promise<void> {
  await registry.dispatch('observe', { tabId });
}

test('click --trusted：ref 走 CDP 节点路由，回 via=cdp-backend / trusted=true，并回填 backendNodeId', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator();
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  await observe(registry);

  const clicked = await registry.dispatch('click', { tabId: 7, ref: '@e2', trusted: true }) as Record<string, unknown>;
  assert.equal(clicked.via, 'cdp-backend');
  assert.equal(clicked.trusted, true);
  assert.equal(clicked.synthetic, false);
  assert.equal(clicked.effectState, 'committed');
  assert.equal(clicked.backendNodeId, 42);
  assert.equal(clicked.evidence && (clicked.evidence as Record<string, unknown>).inputMode, 'cdp-input');
  assert.equal(content.callsFor('click').length, 0, '可信路径不应再派发内容脚本 click');
  const elementStates = content.callsFor('element-state');
  assert.equal(elementStates.length, 1);
  assert.equal(elementStates[0]?.request.params.ref, '@e2');
  assert.equal(elementStates[0]?.request.params.documentId, 'doc-a');
  assert.equal(input.backendClicks.length, 1);
  assert.equal(input.backendClicks[0]?.backendNodeId, 42);
  // 定位器拿到的描述符来自内容脚本 element-state（不是猜的 tag）。
  assert.deepEqual(
    { tag: locator.locateCalls[0]?.tag, id: locator.locateCalls[0]?.id, role: locator.locateCalls[0]?.role },
    { tag: 'button', id: 'submit-btn', role: 'button' },
  );
  // CDP 解析出的 backendNodeId 回填注册表（后续动作复用）。
  assert.equal(refs.get(7, '@e2')?.key.backendNodeId, 42);
});

test('stableRef 驱动 click：注册表解析 s- → @eN 后同样走 CDP（7b）', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator();
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  const observed = await registry.dispatch('observe', { tabId: 7 }) as { refDetails: Array<{ ref: string; stableRef: string }> };
  const detail = observed.refDetails.find((item) => item.ref === '@e2');
  assert.ok(detail);

  const clicked = await registry.dispatch('click', { tabId: 7, stableRef: detail.stableRef, trusted: true }) as Record<string, unknown>;
  assert.equal(clicked.via, 'cdp-backend');
  assert.equal(clicked.ref, '@e2');
  assert.equal(input.backendClicks[0]?.backendNodeId, 42);
});

test('非 trusted 与 --synthetic：保持内容脚本路径（35d fail-closed 不动），不触达 CDP', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator();
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  await observe(registry);

  const plain = await registry.dispatch('click', { tabId: 7, ref: '@e2' }) as Record<string, unknown>;
  assert.equal(plain.via, 'content-script');
  assert.equal(plain.trusted, false);
  assert.equal(plain.synthetic, true);

  const synthetic = await registry.dispatch('click', { tabId: 7, selector: '#focus-swap', trusted: false, synthetic: true }) as Record<string, unknown>;
  assert.equal(synthetic.via, 'content-script');
  assert.equal(locator.locateCalls.length, 0);
  assert.equal(input.backendClicks.length, 0);
  assert.equal(content.callsFor('click').length, 2);
});

test('遮挡：trusted 点击返回 E_OCCLUDED + occludedBy（35b），--force 跳过复核', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator({ hitTest: { relation: 'obstructed', occludedBy: { tag: 'div', id: 'cover', role: null, name: null } } });
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });

  await assert.rejects(
    registry.dispatch('click', { tabId: 7, selector: '#covered-btn', trusted: true }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_OCCLUDED');
      const data = error.data as Record<string, unknown>;
      assert.deepEqual(data.occludedBy, { tag: 'div', id: 'cover', role: null, name: null });
      assert.equal(data.dispatched, false);
      return true;
    },
  );
  assert.equal(input.backendClicks.length, 0, '遮挡时不得派发 CDP 点击');

  const forced = await registry.dispatch('click', { tabId: 7, selector: '#covered-btn', trusted: true, force: true }) as Record<string, unknown>;
  assert.equal(forced.via, 'cdp-backend');
  assert.equal(forced.trusted, true);
});

test('定位失败：回退内容脚本（不假成功、不伪造 trusted）', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator({ hits: { default: null } });
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });

  const clicked = await registry.dispatch('click', { tabId: 7, selector: '#maybe', trusted: true }) as Record<string, unknown>;
  assert.equal(clicked.via, 'content-script');
  assert.equal(clicked.trusted, false);
  assert.equal(content.callsFor('click').length, 1);
  assert.equal(input.backendClicks.length, 0);
});

test('fill --trusted：可信聚焦 + 全选 + insertText + 读回；不可填写时回退内容脚本', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator({ value: { tag: 'input', value: '', editable: true, readOnly: false, disabled: false, type: 'text' } });
  // 读回值：从 insertText 的记录里返回（模拟写入成功）。
  const originalDescribe = locator.describeValue.bind(locator);
  let afterWrite = false;
  locator.describeValue = async () => (afterWrite
    ? { tag: 'input', value: 'hello bridge', editable: true, readOnly: false, disabled: false, type: 'text' }
    : originalDescribe());
  const wrappedInsert = input.insertText.bind(input);
  input.insertText = async (tabId: number, text: string) => {
    afterWrite = true;
    return wrappedInsert(tabId, text);
  };
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  await observe(registry);

  const filled = await registry.dispatch('fill', { tabId: 7, ref: '@e1', value: 'hello bridge', trusted: true }) as Record<string, unknown>;
  assert.equal(filled.via, 'cdp-input');
  assert.equal(filled.trusted, true);
  assert.equal(filled.matches, true);
  assert.equal(filled.expected_value, 'hello bridge');
  assert.equal(filled.actual_value, 'hello bridge');
  assert.equal(filled.effectState, 'committed');
  assert.deepEqual(input.selectAlls, [7]);
  assert.equal(input.inserted[0]?.text, 'hello bridge');
  assert.equal(content.callsFor('fill').length, 0);

  // checkbox：非 fillable → 回退内容脚本（原口径错误语义由内容脚本负责）。
  const locator2 = new FakeLocator({ value: { tag: 'input', value: '', editable: false, readOnly: false, disabled: false, type: 'checkbox' } });
  const registry2 = new ActionRegistry({ content, refs: new RefRegistry(), input, backend: locator2, random: () => 0, now: () => 1000 });
  const fallback = await registry2.dispatch('fill', { tabId: 7, selector: '#agree', value: 'x', trusted: true }) as Record<string, unknown>;
  assert.equal(fallback.via, 'content-script');
  assert.equal(content.callsFor('fill').length, 1);
});

test('hover/press/drag --trusted：CDP 原语被调用（press 用 DOM.focus，不点目标）', async () => {
  const content = makeContent();
  content.set('observe', () => ({ ok: true, result: { ...OBSERVE_RESULT } }));
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator();
  const extended = new ExtendedActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  const actions = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  await actions.dispatch('observe', { tabId: 7 });

  const hovered = await extended.dispatch('hover', { tabId: 7, ref: '@e2', trusted: true }) as Record<string, unknown>;
  assert.equal(hovered.trusted, true);
  assert.equal(hovered.via, 'cdp-input');
  assert.equal(input.hoverPoints.length, 1);
  assert.equal(hovered.effectState, 'none');

  const pressed = await extended.dispatch('press', { tabId: 7, key: 'Enter', trusted: true }) as Record<string, unknown>;
  assert.equal(pressed.trusted, true);
  assert.equal(pressed.via, 'cdp-input');
  assert.deepEqual(input.pressed.map((item) => item.key), ['Enter']);

  const pressedTarget = await extended.dispatch('press', { tabId: 7, key: 'Tab', ref: '@e1', trusted: true }) as Record<string, unknown>;
  assert.equal(pressedTarget.trusted, true);
  assert.equal(locator.focusCalls.length, 1, 'press --ref 用 DOM.focus 聚焦目标');
  assert.equal(input.backendClicks.length, 0, 'press 不应点击目标（23h4）');

  const dragged = await extended.dispatch('drag', {
    tabId: 7,
    from: { selector: '#drag-src' },
    to: { selector: '#dropzone' },
    modifiers: ['ctrl', 'shift'],
    trusted: true,
  }) as Record<string, unknown>;
  assert.equal(dragged.trusted, true);
  assert.equal(dragged.via, 'cdp-input');
  assert.equal(input.drags.length, 1);
  assert.equal(input.drags[0]?.options?.['modifiers'], 2 | 8);
  assert.equal(dragged.effectState, 'committed');
});

test('原生输入归因：cooperate.sync 合并可信输入计数（23h3/23h4 不回退）', async () => {
  const content = makeContent();
  content.set('cooperation-state', () => ({
    ok: true,
    result: {
      frameState: {
        mutations: 0, structure: 0, texts: [], scroll: 0, document: 'https://example.test/', events: [],
        focusNeutral: true, selection: '', media: [], mediaComplete: true, textsComplete: true,
        eventsComplete: true, fieldsComplete: true, focusIsDocument: true,
        agentAttributed: 0, humanAttributed: 0, lastHumanKind: null, inputClock: 0,
        timeToleranceMs: 1.5, attribution: { owner: null, kind: null, at: null, by: null },
        expectationPending: false,
      },
      documentId: 'doc-a',
      url: 'https://example.test/',
      fingerprint: 'fp-1',
    },
  }));
  const refs = new RefRegistry();
  const receipts = new ReceiptStore({ now: () => 1000 });
  const clock = new TrustedInputClock({ now: () => 5000 });
  const input = new FakeInput();
  const locator = new FakeLocator();
  const actions = new ActionRegistry({ content, refs, receipts, input, backend: locator, inputClock: clock, random: () => 0, now: () => 1000 });
  const extended = new ExtendedActionRegistry({ content, refs, receipts, input, backend: locator, inputClock: clock, random: () => 0, now: () => 1000 });

  await actions.dispatch('click', { tabId: 7, selector: '#submit-btn', trusted: true });
  const sync = await extended.dispatch('cooperate.sync', { tabId: 7 }) as { cooperation: { frameState: Record<string, unknown> } };
  const frame = sync.cooperation.frameState;
  assert.equal(frame.agentAttributed, 1, '可信点击应计入 agentAttributed');
  assert.equal(frame.inputClock, 1, '可信点击应推进 inputClock');
  assert.equal(frame.lastHumanKind, null, '可信点击不应被记为 human');
  assert.equal((frame.attribution as Record<string, unknown>).owner, 'agent');
  assert.equal(frame.agentAttributedByTimestamp, 0);
  assert.ok(Number(frame.agentAttributedByTimestamp) + Number(frame.agentAttributedByCoordinate) <= Number(frame.agentAttributed));

  // 第二次 sync：增量已消费，不再重复计数。
  const second = await extended.dispatch('cooperate.sync', { tabId: 7 }) as { cooperation: { frameState: Record<string, unknown> } };
  assert.equal(second.cooperation.frameState.agentAttributed, 0);
});

test('35d 语义：--synthetic 即使带 trusted=false 也不进 CDP；无 input/backend 时行为与旧运行时一致', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const registry = new ActionRegistry({ content, refs, random: () => 0, now: () => 1000 });
  await observe(registry);
  const clicked = await registry.dispatch('click', { tabId: 7, selector: '#focus-swap', trusted: false }) as Record<string, unknown>;
  assert.equal(clicked.via, 'content-script');
  assert.equal(clicked.trusted, false);
  assert.equal(clicked.synthetic, true);
  assert.equal(clicked.effectState, 'committed');
  assert.equal(content.callsFor('element-state').length, 0);
});

test('CDP 中途错误：不在点击后回退内容脚本（不重放）', async () => {
  const content = makeContent();
  const refs = new RefRegistry();
  const input = new FakeInput();
  const locator = new FakeLocator();
  input.clickBackendNode = async () => {
    throw Object.assign(new Error('点击后 CDP 断开'), { code: 'E_CDP_DETACHED' });
  };
  const registry = new ActionRegistry({ content, refs, input, backend: locator, random: () => 0, now: () => 1000 });
  await assert.rejects(
    registry.dispatch('click', { tabId: 7, selector: '#submit-btn', trusted: true }),
    (error: unknown) => (error as { code?: string }).code === 'E_CDP_DETACHED',
  );
  assert.equal(content.callsFor('click').length, 0, '不应重放内容脚本点击');
});
