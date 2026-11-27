// toolbar controller：视图模型（动作/焦点/ARIA）+ controller 状态（激活/收起/键盘）。
// 输入全部来自现有 controller-toolbar 纯聚合器与 overlay-state，不复制实现。
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildToolbarModel,
  createToolbarController,
  liveToolbarSnapshot,
  modeFor,
  modeVisible,
  evaluateAction,
  actionsForMode,
  actionAriaAttributes,
  renderToolbarAria,
  describeToolbar,
  describeSnapshotToolbar,
  toolbarEvidence,
  TOOLBAR_ACTIONS,
  TOOLBAR_ACTION_IDS,
  TOOLBAR_MODES,
  TOOLBAR_KEYMAP,
  ACTION_DISABLED_CODES,
} = await import('../../extension/src/lib/toolbar.js');
const { buildControllerToolbarSnapshot } = await import('../../extension/src/lib/controller-toolbar.js');
const { controllerState } = await import('../../extension/src/lib/controller-state.js');
const { openOverlay, closeOverlay } = await import('../../extension/src/overlay-state.js');

function snapshotOf(overrides = {}) {
  return buildControllerToolbarSnapshot({
    tabId: 3,
    at: 5000,
    controller: { state: 'agent', since: 4000 },
    ...overrides,
  });
}

function borrowPending(overrides = {}) {
  return snapshotOf({
    controller: { state: 'handoff', since: 4600 },
    borrow: { status: 'pending', requestId: 'req-3', requestedAt: 4500, timeoutMs: 60000, title: '购物车', surface: 'modal' },
    ...overrides,
  });
}

function heldSnapshot(overrides = {}) {
  return snapshotOf({
    controller: { state: 'held', since: 4700, event: 'hold.engage' },
    takeover: { paused: true },
    ...overrides,
  });
}

test('modeFor：pending 借用 > held > handoff > human > borrowed > 浮层种类 > hidden', () => {
  assert.equal(modeFor(borrowPending()), TOOLBAR_MODES.BORROW_CONFIRM);
  assert.equal(modeFor(heldSnapshot()), TOOLBAR_MODES.HELD);
  assert.equal(modeFor(snapshotOf({ controller: { state: 'handoff' } })), TOOLBAR_MODES.HANDOFF);
  assert.equal(modeFor(snapshotOf({ controller: { state: 'human' } })), TOOLBAR_MODES.MANUAL);
  assert.equal(modeFor(snapshotOf({ controller: { state: 'borrowed' } })), TOOLBAR_MODES.BORROW_ACTIVE);
  assert.equal(modeFor(snapshotOf({ borrow: { status: 'confirmed', controlled: true } })), TOOLBAR_MODES.BORROW_ACTIVE);
  assert.equal(modeFor(snapshotOf({ overlays: { overlays: [{ kind: 'help', priority: 10 }] } })), TOOLBAR_MODES.HELP);
  assert.equal(modeFor(snapshotOf({ overlays: { overlays: [{ kind: 'record', priority: 5 }] } })), TOOLBAR_MODES.RECORD);
  assert.equal(modeFor(snapshotOf({ overlays: { overlays: [{ kind: 'takeover', priority: 5 }] } })), TOOLBAR_MODES.MANUAL);
  assert.equal(modeFor(snapshotOf()), TOOLBAR_MODES.HIDDEN);
  assert.equal(modeFor(null), TOOLBAR_MODES.HIDDEN);
  assert.equal(modeVisible(TOOLBAR_MODES.HIDDEN), false);
  assert.equal(modeVisible(TOOLBAR_MODES.HELD), true);
});

test('借用确认模型：allow/deny 决策按钮、默认焦点在允许、modal + 焦点陷阱 + ARIA', () => {
  const model = buildToolbarModel(borrowPending(), { now: 5000 });
  assert.equal(model.mode, TOOLBAR_MODES.BORROW_CONFIRM);
  assert.equal(model.visible, true);
  assert.equal(model.modal, true);
  assert.equal(model.kind, 'borrow');
  assert.deepEqual(model.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.BORROW_ALLOW, TOOLBAR_ACTION_IDS.BORROW_DENY]);
  assert.equal(model.actions[0].enabled, true);
  assert.equal(model.actions[0].variant, 'primary');
  assert.equal(model.actions[0].decision, true);
  assert.equal(model.actions[0].tabIndex, 0, 'roving tabindex：焦点动作才是 0');
  assert.equal(model.actions[1].tabIndex, -1);
  assert.equal(model.focus.activeId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(model.focus.index, 0);
  assert.equal(model.focus.count, 2);
  assert.equal(model.focus.trapped, true);
  assert.equal(model.focus.roving, true);
  assert.equal(model.aria.role, 'toolbar');
  assert.match(model.aria.label, /借用确认/);
  assert.match(model.aria.label, /购物车/);
  assert.equal(model.aria.busy, true);
  assert.equal(model.keyboard.enabled, true);
  assert.equal(model.status.borrowStatus, 'pending');
  assert.equal(model.status.borrowRequestId, 'req-3');
  assert.equal(model.status.pendingMs, 500);
  assert.equal(model.status.timeLeftMs, 59500);
  assert.equal(model.evidence.modal, true);
  assert.equal(model.evidence.enabledCount, 2);
});

test('evaluateAction：模式/终止态/暂停状态决定可用性，并给出拒绝码', () => {
  const pending = borrowPending();
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.BORROW_ALLOW }, pending).enabled, true);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.BORROW_ALLOW }, snapshotOf()).code, ACTION_DISABLED_CODES.MODE);
  const held = heldSnapshot();
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.CONTROL_HANDBACK }, held).enabled, true);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.CONTROL_RESUME }, held).enabled, true);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.CONTROL_HOLD }, held).code, ACTION_DISABLED_CODES.MODE);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS }, pending).code, ACTION_DISABLED_CODES.PENDING);
  assert.match(evaluateAction({ id: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS }, pending).reason, /允许或拒绝/);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS }, held).enabled, true);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.HELP_DONE }, snapshotOf({ overlays: { overlays: [{ kind: 'help' }] } })).enabled, true);
  assert.equal(evaluateAction({ id: TOOLBAR_ACTION_IDS.RECORD_STOP }, snapshotOf({ overlays: { overlays: [{ kind: 'record' }] } })).enabled, true);
  assert.equal(evaluateAction(null, pending).code, ACTION_DISABLED_CODES.UNKNOWN);
  assert.equal(evaluateAction({ id: 'nope' }, pending).code, ACTION_DISABLED_CODES.UNKNOWN, '未知动作返回结构化 UNKNOWN');
});

test('held 模型：交给 Agent / 继续 / 收起，且不出现借用决策按钮', () => {
  const model = buildToolbarModel(heldSnapshot(), { now: 5000 });
  assert.equal(model.mode, TOOLBAR_MODES.HELD);
  assert.deepEqual(model.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.CONTROL_HANDBACK, TOOLBAR_ACTION_IDS.CONTROL_RESUME, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS]);
  assert.equal(model.actions[0].label, '交给 Agent');
  assert.equal(model.focus.activeId, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK);
  assert.equal(model.modal, false);
  assert.equal(model.focus.trapped, false);
  assert.equal(model.aria.busy, true, 'blocking/暂停时 toolbar 处于 busy');
  assert.equal(model.status.blocked, true);
  assert.equal(model.status.primaryReason, 'E_SESSION_PAUSED');
  assert.match(model.title, /人工接管/);
});

test('record/help 模型：各自动作集，help 是 modal（焦点陷阱）', () => {
  const record = buildToolbarModel(snapshotOf({ overlays: { overlays: [{ kind: 'record', priority: 5 }] } }));
  assert.equal(record.mode, TOOLBAR_MODES.RECORD);
  assert.deepEqual(record.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.RECORD_STOP, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS]);
  assert.equal(record.modal, false);
  assert.match(record.title, /录制/);

  const help = buildToolbarModel(snapshotOf({ overlays: { overlays: [{ kind: 'help', priority: 5 }] } }));
  assert.equal(help.mode, TOOLBAR_MODES.HELP);
  assert.deepEqual(help.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.HELP_DONE]);
  assert.equal(help.modal, true);
  assert.equal(help.focus.trapped, true);
  assert.match(help.title, /人工协助/);
});

test('hidden 模型：idle 无浮层不可见；confirmed 借用回退到 borrow-active', () => {
  const hidden = buildToolbarModel(snapshotOf(), { now: 5000 });
  assert.equal(hidden.mode, TOOLBAR_MODES.HIDDEN);
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.actions, []);
  assert.equal(hidden.keyboard.enabled, false);
  assert.equal(hidden.focus.activeId, null);

  const borrowed = buildToolbarModel(snapshotOf({ borrow: { status: 'confirmed' } }));
  assert.equal(borrowed.mode, TOOLBAR_MODES.BORROW_ACTIVE);
  assert.equal(borrowed.visible, true);
  assert.deepEqual(borrowed.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.CONTROL_HANDBACK, TOOLBAR_ACTION_IDS.CONTROL_HOLD, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS]);
});

test('buildToolbarModel 两种入参等价：完整快照 vs 原始聚合输入', () => {
  const raw = {
    tabId: 8,
    at: 6000,
    controller: { state: 'held', since: 5000 },
    takeover: { paused: true },
    borrow: null,
    overlays: { overlays: [{ kind: 'takeover', priority: 10 }] },
  };
  const fromRaw = buildToolbarModel(raw, { now: 6000 });
  const fromSnapshot = buildToolbarModel(buildControllerToolbarSnapshot(raw), { now: 6000 });
  assert.equal(fromRaw.mode, fromSnapshot.mode);
  assert.deepEqual(fromRaw.actions.map((action) => action.id), fromSnapshot.actions.map((action) => action.id));
  assert.equal(fromRaw.aria.label, fromSnapshot.aria.label);
});

test('renderToolbarAria：容器/动作/播报区属性一次给全', () => {
  const model = buildToolbarModel(borrowPending(), { now: 5000, announcement: { text: '借用确认', politeness: 'assertive', at: 5000, seq: 1 } });
  const aria = renderToolbarAria(model);
  assert.equal(aria.container.role, 'toolbar');
  assert.equal(aria.container['aria-modal'], undefined);
  assert.equal(aria.container['data-bb-toolbar-mode'], 'borrow-confirm');
  assert.equal(aria.container['data-bb-toolbar-visible'], 'true');
  assert.equal(aria.container['data-bb-toolbar-modal'], 'true');
  assert.equal(aria.actions.length, 2);
  assert.equal(aria.actions[0].attributes.role, 'button');
  assert.equal(aria.actions[0].attributes.tabindex, 0);
  assert.equal(aria.actions[0].attributes['aria-disabled'], 'false');
  assert.equal(aria.actions[0].attributes['data-bb-action'], 'borrow.allow');
  assert.equal(aria.actions[1].attributes.tabindex, -1);
  assert.equal(aria.live.role, 'status');
  assert.equal(aria.live['aria-live'], 'assertive');
  assert.equal(aria.live.text, '借用确认');
  assert.equal(aria.focus.trapped, true);
  assert.equal(actionAriaAttributes(model, 'missing'), null);
  assert.equal(renderToolbarAria(null), null);
});

test('describeToolbar / describeSnapshotToolbar / toolbarEvidence：摘要与精简证据', () => {
  const model = buildToolbarModel(heldSnapshot());
  const description = describeToolbar(model);
  assert.match(description, /toolbar=held/);
  assert.match(description, /focus=control\.handback/);
  assert.match(description, /blocked=E_SESSION_PAUSED/);
  assert.match(describeSnapshotToolbar(heldSnapshot()), /toolbar=held/);
  const evidence = toolbarEvidence(model);
  assert.equal(evidence.mode, 'held');
  assert.equal(evidence.visible, true);
  assert.equal(evidence.modal, false);
  assert.equal(evidence.focusId, 'control.handback');
  assert.equal(evidence.actions.length, 3);
  assert.equal(evidence.blocked, true);
  assert.equal(toolbarEvidence(null), null);
});

test('controller：focus 方向键环绕、Home/End、未知动作结构化失败', () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  const initial = controller.model(4);
  assert.equal(initial.focus.activeId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  const next = controller.focusNext(4);
  assert.equal(next.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(next.index, 1);
  const wrapped = controller.focusNext(4);
  assert.equal(wrapped.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW, '到末端环绕回第一个');
  const previous = controller.focusPrev(4);
  assert.equal(previous.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY, '到首端向前环绕到最后一个');
  const last = controller.focusLast(4);
  assert.equal(last.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  const first = controller.focusFirst(4);
  assert.equal(first.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  const focused = controller.focus(4, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(focused.ok, true);
  assert.equal(focused.index, 1);
  assert.equal(focused.announcement.politeness, 'polite');
  const missing = controller.focus(4, 'no.such.action');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, ACTION_DISABLED_CODES.UNKNOWN);
  assert.equal(controller.focus(null, 'x').code, 'E_BAD_ARG');
});

test('controller.activate：注入 onAction 收到动作/intent/meta，结果与播报落状态', async () => {
  const calls = [];
  const controller = createToolbarController({
    snapshotProvider: () => borrowPending(),
    onAction: async (action, model, meta) => {
      calls.push({ action, model, meta });
      return { ok: true, dispatched: action.id };
    },
  });
  const activated = await controller.activate(5, TOOLBAR_ACTION_IDS.BORROW_ALLOW, { source: 'test' });
  assert.equal(activated.ok, true);
  assert.equal(activated.dispatched, true);
  assert.equal(activated.method, 'borrow.confirm');
  assert.deepEqual(activated.intent, { decision: 'allow', requestKey: 'allow' });
  assert.equal(activated.meta.requestId, 'req-3');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action.id, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(calls[0].meta.tabId, 5);
  assert.equal(calls[0].meta.mode, TOOLBAR_MODES.BORROW_CONFIRM);
  assert.equal(activated.announcement.politeness, 'assertive', '决定类动作的播报是 assertive');
  const state = controller.state(5);
  assert.equal(state.lastAction, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(state.actionCount, 1);
  assert.equal(controller.counters().activations, 1);
});

test('controller.activate：禁用动作不派发、未知动作结构化失败、onAction 抛错进计数', async () => {
  let calls = 0;
  const controller = createToolbarController({
    snapshotProvider: () => heldSnapshot(),
    onAction: async () => { calls += 1; return { ok: true }; },
  });
  const notInMode = await controller.activate(6, TOOLBAR_ACTION_IDS.CONTROL_HOLD);
  assert.equal(notInMode.ok, false);
  assert.equal(notInMode.code, ACTION_DISABLED_CODES.MODE, '不在当前模式的动作直接给 MODE 拒绝');
  assert.equal(notInMode.evidence.mode, TOOLBAR_MODES.HELD);
  assert.equal(calls, 0);
  const unknown = await controller.activate(6, 'no.such.action');
  assert.equal(unknown.code, ACTION_DISABLED_CODES.UNKNOWN);
  const badTab = await controller.activate(null, 'x');
  assert.equal(badTab.code, 'E_BAD_ARG');

  const failing = createToolbarController({
    snapshotProvider: () => heldSnapshot(),
    onAction: async () => { throw new Error('dispatch exploded'); },
  });
  const failed = await failing.activate(7, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, ACTION_DISABLED_CODES.FAILED);
  assert.match(failed.error, /dispatch exploded/);
  assert.equal(failing.counters().dispatchFailures, 1);
});

test('controller.activate 收起动作会隐藏工具栏并记录返回焦点', async () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  assert.equal(controller.setReturnFocus(8, 'page-search'), 'page-search');
  const activated = await controller.activate(8, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS);
  assert.equal(activated.ok, true);
  assert.equal(controller.state(8).visible, false);
  const hiddenModel = controller.model(8);
  assert.equal(hiddenModel.visible, false);
  const shown = controller.show(8);
  assert.equal(shown.ok, true);
  assert.equal(shown.model.visible, true);
});

test('controller.dismiss：借用确认模态拒绝静默收起，普通模式收起并给返回焦点', () => {
  const pendingController = createToolbarController({ snapshotProvider: () => borrowPending() });
  const refused = pendingController.dismiss(9, 'escape');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, ACTION_DISABLED_CODES.PENDING);
  assert.deepEqual(refused.evidence.required, [TOOLBAR_ACTION_IDS.BORROW_ALLOW, TOOLBAR_ACTION_IDS.BORROW_DENY]);
  assert.equal(pendingController.state(9).visible, true);

  const heldController = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  heldController.setReturnFocus(10, 'canvas');
  const dismissed = heldController.dismiss(10, 'escape');
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.returnFocusTo, 'canvas');
  assert.equal(heldController.state(10).dismissed, true);
  assert.equal(heldController.counters().dismissed, 1);
  assert.equal(heldController.dismiss(null).code, 'E_BAD_ARG');
});

test('liveToolbarSnapshot：真实 controller-state + overlay-state 聚合进模型', () => {
  const tabId = 211;
  controllerState.transition(tabId, 'hold.engage', { source: 'test.hold' });
  openOverlay(tabId, 'takeover', { priority: 20 });
  try {
    const snapshot = liveToolbarSnapshot(tabId);
    assert.equal(snapshot.tabId, tabId);
    assert.equal(snapshot.controller.state, 'held');
    assert.equal(snapshot.toolbar.visible, true);
    const model = buildToolbarModel(snapshot);
    assert.equal(model.mode, TOOLBAR_MODES.HELD);
    assert.ok(model.actions.some((action) => action.id === TOOLBAR_ACTION_IDS.CONTROL_RESUME));
    assert.equal(model.status.controllerState, 'held');
  } finally {
    closeOverlay(tabId, 'takeover');
    controllerState.clear(tabId);
  }
});

test('controller 快照/列表/计数/forget/reset：状态可读且可清理', () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  controller.model(12);
  controller.announce(12, '已接管', { politeness: 'assertive' });
  const snapshot = controller.snapshot(12);
  assert.equal(snapshot.mode, TOOLBAR_MODES.HELD);
  assert.equal(snapshot.visible, true);
  assert.equal(snapshot.state.announcement.text, '已接管');
  assert.equal(snapshot.evidence.focusId, 'control.handback');
  const listed = controller.list();
  assert.equal(listed.some((entry) => entry.tabId === 12), true);
  assert.equal(controller.counters().tabs >= 1, true);
  assert.equal(controller.forget(12), true);
  assert.equal(controller.state(12).visible, false);
  controller.reset();
  assert.equal(controller.counters().tabs, 0);
});

test('动作定义完整性：id 唯一、方法名稳定、模式集合非空且合法', () => {
  const ids = new Set(TOOLBAR_ACTIONS.map((action) => action.id));
  assert.equal(ids.size, TOOLBAR_ACTIONS.length);
  assert.equal(TOOLBAR_ACTIONS.length >= 8, true);
  for (const action of TOOLBAR_ACTIONS) {
    assert.equal(typeof action.method, 'string');
    assert.equal(action.modes.length > 0, true);
    for (const mode of action.modes) {
      assert.equal(Object.values(TOOLBAR_MODES).includes(mode), true, '未知模式 ' + mode);
    }
  }
  const pending = actionsForMode(TOOLBAR_MODES.BORROW_CONFIRM, borrowPending());
  assert.deepEqual(pending.map((entry) => entry.action.id), [TOOLBAR_ACTION_IDS.BORROW_ALLOW, TOOLBAR_ACTION_IDS.BORROW_DENY]);
  const entries = actionsForMode(TOOLBAR_MODES.HIDDEN, snapshotOf());
  assert.deepEqual(entries, []);
  assert.equal(TOOLBAR_KEYMAP.activate.includes('Enter'), true);
});
