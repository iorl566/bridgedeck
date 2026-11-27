// tests/coop-runtime.test.ts —— 人工协作运行时时单测（human-watch 状态机 / hold / handback / 协助卡片）。
//
// 全部依赖注入：假时钟 + 假 sleep + 假页面注入器（按函数引用分派）+ 假扩展动作面 dispatch，
// 因此可以精确驱动「检测到人工操作 → hold → 静默 → ready」「人工交回 → 立刻 ready」
// 「协助卡片出现 → 完成/条件满足/超时 → 自动交还」这几条语义，不需要真实浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOPERATION_METHODS,
  CooperationRuntime,
  HumanWatchStore,
  HELP_OVERLAY_HOST_ID,
  createCooperationCommands,
  normalizeHelpCriteria,
  type CooperationInjector,
  type CooperationRuntimeDeps,
} from '../src/runtime/cooperation.ts';
import {
  checkHelpCriteria,
  hideHelpOverlay,
  installHumanWatch,
  markAgentInput,
  measureTarget,
  readHelpState,
  readHumanActivity,
  showHelpOverlay,
  type HelpOverlayOptions,
  type HelpPageState,
  type HumanActivityState,
} from '../src/content/cooperation.ts';

interface Harness {
  runtime: CooperationRuntime;
  clock: () => number;
  advance: (ms: number) => void;
  held: Set<number>;
  injected: Array<{ tabId: number; func: unknown; args: unknown[] }>;
  page: {
    human: HumanActivityState;
    decision: HelpPageState | null;
    criteriaOk: boolean;
    requestId: string;
    overlayOptions: HelpOverlayOptions | null;
    hideCount: number;
    activateCount: number;
  };
  setSettings: (settings: { allowHelp?: boolean }) => void;
}

function createHarness(options: {
  withExtended?: boolean;
  withInject?: boolean;
  pollIntervalMs?: number;
  onSleep?: (count: number, page: Harness['page']) => void;
} = {}): Harness {
  let clock = 1_000_000;
  const held = new Set<number>();
  const injected: Harness['injected'] = [];
  const page: Harness['page'] = {
    human: {
      installed: true,
      active: false,
      lastInputAt: 0,
      lastKind: '',
      lastLabel: '',
      sensitive: false,
      editable: false,
      inputClock: 0,
      at: clock,
    },
    decision: null,
    criteriaOk: false,
    requestId: '',
    overlayOptions: null,
    hideCount: 0,
    activateCount: 0,
  };
  let settings: { allowHelp?: boolean } = { allowHelp: true };
  let sleepCount = 0;
  const inject: CooperationInjector = async (tabId, func, args) => {
    injected.push({ tabId, func: func as unknown, args: args ?? [] });
    const target = func as unknown;
    if (target === (installHumanWatch as unknown)) return true;
    if (target === (readHumanActivity as unknown)) return { ...page.human, at: clock };
    if (target === (measureTarget as unknown)) return { x: 1, y: 2, width: 30, height: 20, viewport: { width: 1000, height: 800 } };
    if (target === (showHelpOverlay as unknown)) {
      const overlay = (args?.[0] ?? {}) as HelpOverlayOptions;
      page.overlayOptions = overlay;
      page.requestId = String(overlay.requestId || '');
      return { ok: true, requestId: page.requestId, hostId: HELP_OVERLAY_HOST_ID, highlight: false, at: clock };
    }
    if (target === (hideHelpOverlay as unknown)) {
      page.hideCount += 1;
      return true;
    }
    if (target === (readHelpState as unknown)) return page.decision;
    if (target === (checkHelpCriteria as unknown)) return { ok: page.criteriaOk, checks: [], at: clock };
    if (target === (markAgentInput as unknown)) return 123;
    return null;
  };
  const deps: CooperationRuntimeDeps = {
    inject: options.withInject === false ? null : inject,
    dispatchExtended: options.withExtended === false
      ? null
      : async () => ({
        ok: true,
        context_id: 'ctx_1',
        observation_id: 'obs_1',
        control: { mode: 'agent', inputLocked: false },
        cooperation: { frameState: { revision: 2 } },
      }),
    readSettings: async () => settings,
    control: {
      isHeld: (tabId: number) => held.has(tabId),
      setHeld: (tabId: number, value: boolean) => {
        if (value) held.add(tabId);
        else held.delete(tabId);
      },
    },
    activateTab: async () => {
      page.activateCount += 1;
    },
    resolveSelector: async (_tabId: number, target: string) => (target === '@e1' ? '#submit-btn' : null),
    now: () => clock,
    sleep: async (ms: number) => {
      sleepCount += 1;
      clock += ms;
      if (options.onSleep) options.onSleep(sleepCount, page);
    },
    pollIntervalMs: options.pollIntervalMs ?? 100,
  };
  const runtime = new CooperationRuntime(deps);
  return {
    runtime,
    clock: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    held,
    injected,
    page,
    setSettings: (next) => {
      settings = next;
    },
  };
}

function noteHuman(runtime: CooperationRuntime, tabId: number, at: number, kind = 'click', inputClock = 1): void {
  const handled = runtime.handleRuntimeMessage({
    type: 'bb.human.activity',
    at,
    kind,
    label: '提交查询',
    sensitive: false,
    editable: false,
    inputClock,
    active: true,
  }, tabId);
  assert.equal(handled, true, 'bb.human.activity 应被运行时接管');
}

// ---------------------------------------------------------------------------
// cooperate wait：检测人工操作 / 静默恢复
// ---------------------------------------------------------------------------

test('coop runtime wait：检测到人工操作 → ready=false + mode=human，静默后 ready=true', async () => {
  const harness = createHarness();
  const { runtime } = harness;
  noteHuman(runtime, 7, harness.clock());

  const busy = await runtime.wait({ tabId: 7, timeoutMs: 500 });
  assert.equal(busy.ready, false, '人工操作中不应 ready');
  assert.equal(busy.held, false, '这是人工输入触发的判定，不是显式 hold');
  assert.equal((busy.state as Record<string, unknown>).mode, 'human');
  assert.equal((busy.state as Record<string, unknown>).humanInput, true);
  assert.equal(typeof (busy.state as Record<string, unknown>).lastHumanAt, 'number');
  assert.equal(busy.humanDetected, true);
  assert.equal(busy.waitedMs, 500, '应在 timeout 处返回（不是立即返回）');
  assert.equal((busy.input as Record<string, unknown>).uia, false, '没有 UIA 级监听：证据里如实标注');
  assert.match(String(busy.note), /UIA/);
  const human = busy.human as Record<string, unknown>;
  assert.equal(human.active, true);
  assert.equal(human.kind, 'click');

  // 静默窗口过去：人工停手 → ready=true（不等 timeout）。
  harness.advance(2_000);
  const idle = await runtime.wait({ tabId: 7, timeoutMs: 500 });
  assert.equal(idle.ready, true, '人工停手后应恢复 ready');
  assert.equal((idle.state as Record<string, unknown>).mode, 'agent');
  assert.equal((idle.state as Record<string, unknown>).humanInput, false);
  assert.equal(idle.waitedMs, 0, 'ready 时应立即返回');
});

test('coop runtime wait：显式 cooperate hold 也让 ready=false（但没有人工输入证据）', async () => {
  const harness = createHarness();
  harness.held.add(7);
  const result = await harness.runtime.wait({ tabId: 7, timeoutMs: 0 });
  assert.equal(result.ready, false);
  assert.equal(result.held, true);
  assert.equal((result.state as Record<string, unknown>).mode, 'human');
  assert.equal((result.state as Record<string, unknown>).humanInput, false);
});

test('coop runtime wait：缺少 tabId → E_BAD_ARG', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.runtime.wait({}),
    (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG',
  );
});

// ---------------------------------------------------------------------------
// cooperate handback：人工交回后立刻 ready
// ---------------------------------------------------------------------------

test('coop runtime handback：人工交回后立刻 ready（清静默边界，不等自然静默）', async () => {
  const harness = createHarness();
  const { runtime } = harness;
  noteHuman(runtime, 7, harness.clock());
  const busy = await runtime.wait({ tabId: 7, timeoutMs: 300 });
  assert.equal(busy.ready, false);

  const handback = await runtime.handback({ tabId: 7 });
  assert.equal(handback.ok, true);
  assert.equal(handback.handedBack, true);
  assert.equal(handback.held, false);
  assert.equal(typeof handback.clearedAt, 'number');
  assert.equal((handback.state as Record<string, unknown>).mode, 'ready');

  const ready = await runtime.wait({ tabId: 7, timeoutMs: 3_000 });
  assert.equal(ready.ready, true, '人工交回后应立刻 ready');
  assert.equal(ready.waitedMs, 0);
  const human = ready.human as Record<string, unknown>;
  assert.equal(human.active, false);
  assert.equal(Number(human.lastHumanAt) > 0, true, '历史人工证据仍保留（不是伪造没发生）');

  // 交回后的新人工输入应重新触发判定（边界不是永久屏蔽）。
  harness.advance(100);
  noteHuman(runtime, 7, harness.clock(), 'pointerdown', 2);
  const busyAgain = await runtime.wait({ tabId: 7, timeoutMs: 0 });
  assert.equal(busyAgain.ready, false);
});

test('coop runtime handback：同时释放显式 hold', async () => {
  const harness = createHarness();
  harness.held.add(7);
  const busy = await harness.runtime.wait({ tabId: 7, timeoutMs: 0 });
  assert.equal(busy.ready, false);
  const handback = await harness.runtime.handback({ tabId: 7 });
  assert.equal(handback.held, false);
  assert.equal(harness.held.has(7), false, 'handback 后 hold 闸门必须放开');
  const ready = await harness.runtime.wait({ tabId: 7, timeoutMs: 1_000 });
  assert.equal(ready.ready, true);
});

// ---------------------------------------------------------------------------
// 兜底 / 降级
// ---------------------------------------------------------------------------

test('coop runtime wait：runtime 消息丢失时用页面 human-watch 兜底', async () => {
  const harness = createHarness();
  harness.page.human = {
    installed: true,
    active: true,
    lastInputAt: harness.clock() - 120,
    lastKind: 'pointerdown',
    lastLabel: '提交查询',
    sensitive: false,
    editable: false,
    inputClock: 3,
    at: harness.clock(),
  };
  const busy = await harness.runtime.wait({ tabId: 7, timeoutMs: 200 });
  assert.equal(busy.ready, false);
  assert.equal((busy.state as Record<string, unknown>).mode, 'human');
  assert.equal(busy.humanDetected, true);

  harness.advance(2_000);
  harness.page.human = { ...harness.page.human, active: false };
  const idle = await harness.runtime.wait({ tabId: 7, timeoutMs: 200 });
  assert.equal(idle.ready, true);
});

test('coop runtime wait：页面未装 human-watch 时补装并如实标注能力边界', async () => {
  const harness = createHarness();
  harness.page.human = { ...harness.page.human, installed: false };
  const result = await harness.runtime.wait({ tabId: 7, timeoutMs: 0 });
  assert.equal(result.ready, true);
  assert.match(String(result.note), /尚未安装/);
  assert.equal(
    harness.injected.some((entry) => entry.func === (installHumanWatch as unknown)),
    true,
    'wait 应补装 human-watch（只对之后的输入生效）',
  );
});

// ---------------------------------------------------------------------------
// cooperate sync：人工编辑对账
// ---------------------------------------------------------------------------

test('coop runtime sync：复用扩展动作面并补 reconciliation.humanEdits', async () => {
  const harness = createHarness();
  const { runtime } = harness;
  noteHuman(runtime, 7, harness.clock(), 'click', 1);
  noteHuman(runtime, 7, harness.clock() + 5, 'input', 2);

  const first = await runtime.sync({ tabId: 7 });
  assert.equal(first.ok, true);
  assert.equal(first.context_id, 'ctx_1', '应保留扩展动作面的 context_id');
  assert.ok(first.cooperation, '应保留扩展动作面的 cooperation 快照');
  const reconciliation = first.reconciliation as Record<string, unknown>;
  assert.equal(Number(reconciliation.humanEdits) >= 1, true, '23u 依赖 reconciliation.humanEdits >= 1');
  assert.equal(reconciliation.totalHumanAttributed, 2);
  assert.equal(typeof reconciliation.lastHumanAt, 'number');
  assert.equal((first.human_input as Record<string, unknown>).active, true);
  assert.equal((first.control as Record<string, unknown>).humanActive, true);
  assert.equal((first.control as Record<string, unknown>).mode, 'human');

  const second = await runtime.sync({ tabId: 7 });
  assert.equal(Number((second.reconciliation as Record<string, unknown>).humanEdits), 0, '没有新人工编辑时不应重复计数');

  harness.advance(10);
  noteHuman(runtime, 7, harness.clock(), 'pointerdown', 3);
  const third = await runtime.sync({ tabId: 7 });
  assert.equal(Number((third.reconciliation as Record<string, unknown>).humanEdits) >= 1, true);
});

test('coop runtime sync：没有扩展动作面时仍返回最小结构与对账', async () => {
  const harness = createHarness({ withExtended: false });
  const result = await harness.runtime.sync({ tabId: 7 });
  assert.equal(result.ok, true);
  assert.equal((result.reconciliation as Record<string, unknown>).humanEdits, 0);
  assert.ok(result.human_input);
});

// ---------------------------------------------------------------------------
// request-help：浮层 / 完成 / 自动交还
// ---------------------------------------------------------------------------

test('coop request-help：allowHelp=false 保持既有拒绝语义（不注入浮层）', async () => {
  const harness = createHarness();
  harness.setSettings({ allowHelp: false });
  await assert.rejects(
    () => harness.runtime.requestHelp({ tabId: 7, reason: '需要登录' }),
    (error: unknown) => (error as { code?: string }).code === 'E_HELP_DISABLED',
  );
  assert.equal(harness.injected.length, 0, '关闭时不应注入任何页面浮层');
});

test('coop request-help：浮层出现 → 用户点“完成并交还” → done + 自动交还', async () => {
  let harnessRef: Harness | null = null;
  const harness = createHarness({
    onSleep: (count, page) => {
      // 模拟用户在浮动卡片上点“完成并交还控制权”：页面侧状态 = done。
      if (count === 1) {
        page.decision = { requestId: page.requestId, action: 'done', note: '', at: 0, attached: false };
      }
    },
  });
  harnessRef = harness;
  harness.held.add(7);
  noteHuman(harness.runtime, 7, harness.clock());

  const result = await harness.runtime.requestHelp({
    tabId: 7,
    reason: '请确认页面上的登录状态',
    target: '@e1',
    timeoutMs: 60_000,
  });
  assert.ok(harnessRef);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'done');
  assert.equal(result.note, '');
  assert.equal(result.criteriaSatisfied, false);
  assert.equal(result.host, HELP_OVERLAY_HOST_ID);
  assert.equal(harness.page.hideCount, 1, '完成后必须清理浮层');
  assert.equal(harness.page.activateCount, 1, '协助期间应把目标 tab 置前（best-effort）');
  assert.equal(harness.held.has(7), false, '完成 = 自动交还：应释放 hold');
  const human = harness.runtime.snapshot(7).human as Record<string, unknown>;
  assert.equal(human.active, false, '完成交还后人工静默边界清零');

  const overlay = harness.page.overlayOptions;
  assert.ok(overlay, '应把浮层选项注入页面');
  assert.equal(overlay?.reason, '请确认页面上的登录状态');
  assert.equal(typeof overlay?.requestId, 'string');
  assert.ok(overlay?.targetRect, '@e1 目标应解析成 selector 并量出高亮矩形');
  assert.equal(overlay?.targetRect?.width, 30);
});

test('coop request-help：完成条件满足 → 快速 done 并自动交还（24b2）', async () => {
  const harness = createHarness({
    onSleep: (_count, page) => {
      page.criteriaOk = true;
    },
  });
  const started = harness.clock();
  const result = await harness.runtime.requestHelp({
    tabId: 7,
    reason: '等待页面条件',
    criteria: [{ kind: 'selector_exists', selector: 'body' }],
    timeoutMs: 10_000,
  });
  assert.equal(result.action, 'done');
  assert.equal(result.criteriaSatisfied, true);
  assert.equal(result.note, '');
  assert.equal(harness.clock() - started <= 500, true, '完成条件满足后应快速返回，不等 timeout');
  assert.equal(harness.page.hideCount, 1);
});

test('coop request-help：bb.help.resolved 运行时消息可提前结算（skip + 备注）', async () => {
  const harness = createHarness({
    onSleep: (count, page) => {
      if (count === 1) {
        harness.runtime.handleRuntimeMessage({
          type: 'bb.help.resolved',
          requestId: page.requestId,
          action: 'skip',
          note: '用户选择跳过',
        }, 7);
      }
    },
  });
  const result = await harness.runtime.requestHelp({ tabId: 7, reason: '需要人工确认', timeoutMs: 10_000 });
  assert.equal(result.action, 'skip');
  assert.equal(result.note, '用户选择跳过');
  assert.equal(harness.page.hideCount, 1);
});

test('coop request-help：超时 → action=timeout，浮层仍被清理', async () => {
  const harness = createHarness();
  const result = await harness.runtime.requestHelp({ tabId: 7, reason: '没人响应', timeoutMs: 1 });
  assert.equal(result.action, 'timeout');
  assert.equal(result.note, '');
  assert.equal(harness.page.hideCount, 1);
  // 超时下限 5s（与 0.3.0 JS 一致），不应按 1ms 立刻超时。
  assert.equal(result.timeoutMs, 5_000);
});

test('coop request-help：缺 reason / 缺注入能力时明确报错', async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.runtime.requestHelp({ tabId: 7 }),
    (error: unknown) => (error as { code?: string }).code === 'E_BAD_ARG',
  );
  const broken = createHarness({ withInject: false });
  await assert.rejects(
    () => broken.runtime.requestHelp({ tabId: 7, reason: '需要登录' }),
    (error: unknown) => (error as { code?: string }).code === 'E_NOT_IMPLEMENTED',
  );
});

// ---------------------------------------------------------------------------
// 消息路由 / 诊断
// ---------------------------------------------------------------------------

test('coop runtime：runtime 消息路由（activity / blur / help.resolved / 未知）', async () => {
  const harness = createHarness();
  const { runtime, clock } = harness;
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.human.activity', at: clock() }, 7), true);
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.human.blur', at: clock() }, 7), true);
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.help.resolved', requestId: 'x', action: 'done' }, 7), true);
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.help.resolved' }, 7), false);
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.unknown' }, 7), false);
  assert.equal(runtime.handleRuntimeMessage({ type: 'bb.human.activity' }, 0), false, '没有合法 tab 时不记活动');

  // blur 的 quiet 保护：刚有输入时不立即清；确实静默后才清。
  const fresh = createHarness();
  noteHuman(fresh.runtime, 9, fresh.clock());
  fresh.runtime.handleRuntimeMessage({ type: 'bb.human.blur', at: fresh.clock() }, 9);
  assert.equal((fresh.runtime.snapshot(9).human as Record<string, unknown>).active, true, '刚输入后的 blur 不应误清活动');
  const older = createHarness();
  noteHuman(older.runtime, 9, older.clock());
  older.advance(2_000);
  older.runtime.handleRuntimeMessage({ type: 'bb.human.blur', at: older.clock() }, 9);
  assert.equal((older.runtime.snapshot(9).human as Record<string, unknown>).active, false);
});

test('coop runtime：markAgentInput / snapshot / forget', async () => {
  const harness = createHarness();
  assert.equal(await harness.runtime.markAgentInput(7), true);
  noteHuman(harness.runtime, 7, harness.clock());
  const snapshot = harness.runtime.snapshot(7);
  assert.equal(snapshot.tabId, 7);
  const human = snapshot.human as Record<string, unknown>;
  assert.equal(human.received, 1);
  assert.equal(Array.isArray(snapshot.pendingDecisions), true);
  harness.runtime.forget(7);
  assert.equal((harness.runtime.snapshot(7).human as Record<string, unknown>).received, 0);
  const noTab = harness.runtime.snapshot(null);
  assert.equal('tabId' in noTab, false);
});

test('coop HumanWatchStore：静默窗口/交回/对账口径', () => {
  let clock = 1_000;
  const store = new HumanWatchStore({ now: () => clock, silentWindowMs: 1_500 });
  assert.equal(store.isActive(1), false);
  store.note(1, { at: clock, kind: 'click', inputClock: 1 });
  assert.equal(store.isActive(1), true);
  clock += 1_600;
  assert.equal(store.isActive(1), false, '超过静默窗口应视为停手');
  const reconciliation = store.reconcile(1);
  assert.equal(reconciliation.humanEdits, 1);
  assert.equal(reconciliation.lastHumanAt, 1_000);
  assert.equal(store.reconcile(1).humanEdits, 0);

  // handback：交回前的输入不再算“正在操作”；交回后的新输入重新计数。
  clock = 5_000;
  store.note(1, { at: clock });
  assert.equal(store.isActive(1), true);
  const clearedAt = store.handback(1);
  assert.equal(clearedAt, clock);
  assert.equal(store.isActive(1), false);
  clock += 1;
  store.note(1, { at: clock });
  assert.equal(store.isActive(1), true);

  // 早于 clearedAt 的迟到事件被忽略（消息可能晚到）。
  clock = 5_002;
  store.note(1, { at: 4_999 });
  assert.equal(store.snapshot(1).received, 3);

  assert.equal(store.forget(1), true);
  assert.equal(store.size, 0);
});

test('coop normalizeHelpCriteria：归一/过滤/上限', () => {
  assert.deepEqual(normalizeHelpCriteria(undefined), []);
  assert.deepEqual(
    normalizeHelpCriteria([
      { kind: 'selector_exists', selector: 'body' },
      { type: 'text_exists', text: '登录成功' },
      { kind: 'selector_visible', selector: '' },
      { kind: 'unknown-kind' },
      { kind: 'url_contains', text: 'example.test' },
    ]),
    [
      { kind: 'selector_exists', selector: 'body' },
      { kind: 'text_exists', text: '登录成功' },
      { kind: 'unknown-kind' },
      { kind: 'url_contains', text: 'example.test' },
    ],
  );
  const many = Array.from({ length: 20 }, (_value, index) => ({ kind: 'selector_exists', selector: '#e' + index }));
  assert.equal(normalizeHelpCriteria(many).length, 10);
});

test('coop createCooperationCommands：注册项方法/串行性/描述，并驱动同一运行时', async () => {
  const harness = createHarness();
  assert.deepEqual([...COOPERATION_METHODS].sort(), ['cooperate.handback', 'cooperate.sync', 'cooperate.wait', 'request-help']);
  const commands = createCooperationCommands(harness.runtime);
  assert.equal(commands.length, 4);
  const byMethod = new Map(commands.map((command) => [command.method, command]));
  assert.equal(byMethod.get('cooperate.wait')?.serialized, false);
  assert.equal(byMethod.get('cooperate.handback')?.serialized, false);
  assert.equal(byMethod.get('cooperate.sync')?.serialized, true);
  assert.equal(byMethod.get('request-help')?.serialized, false, '等待人工的 request-help 绝不能排在同 tab 动作链后面');
  for (const command of commands) {
    assert.equal(command.timeoutMs, null, '超时交给 daemon 帧预算（CLI 已按 timeout+5s 发放）');
    assert.equal(String(command.description).length > 0, true);
  }

  noteHuman(harness.runtime, 7, harness.clock());
  const waitCommand = byMethod.get('cooperate.wait');
  assert.ok(waitCommand);
  const waited = await waitCommand.handler({
    method: 'cooperate.wait',
    params: { tabId: 7, timeoutMs: 0 },
    timeoutMs: 5_000,
    requestId: 'r1',
    now: harness.clock(),
  }) as Record<string, unknown>;
  assert.equal(waited.ready, false);
  assert.equal((waited.state as Record<string, unknown>).mode, 'human');
});
