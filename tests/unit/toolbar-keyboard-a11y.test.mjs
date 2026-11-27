// toolbar 键盘可达与无障碍：keydown 状态迁移、焦点陷阱、播报队列、ARIA 属性完整性。
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildToolbarModel,
  createToolbarController,
  renderToolbarAria,
  actionAriaAttributes,
  TOOLBAR_ACTION_IDS,
  TOOLBAR_MODES,
  TOOLBAR_KEYMAP,
  TOOLBAR_LETTER_SHORTCUTS,
  ACTION_DISABLED_CODES,
} = await import('../../extension/src/lib/toolbar.js');
const { buildControllerToolbarSnapshot } = await import('../../extension/src/lib/controller-toolbar.js');

function snapshotOf(overrides = {}) {
  return buildControllerToolbarSnapshot({ tabId: 3, at: 5000, controller: { state: 'agent' }, ...overrides });
}
const borrowPending = () => snapshotOf({
  controller: { state: 'handoff' },
  borrow: { status: 'pending', requestId: 'req-k', requestedAt: 4000, timeoutMs: 60000, title: '结算页' },
});
const heldSnapshot = () => snapshotOf({ controller: { state: 'held', since: 4700 }, takeover: { paused: true } });
const borrowActive = () => snapshotOf({ controller: { state: 'borrowed', borrowed: true } });

/** 可切换的快照源：模拟页面状态在键盘操作之间变化。 */
function switchable(start = 'pending') {
  let mode = start;
  return {
    get: () => (mode === 'pending' ? borrowPending() : mode === 'held' ? heldSnapshot() : mode === 'active' ? borrowActive() : snapshotOf()),
    set: (next) => { mode = next; return mode; },
  };
}

test('键盘映射契约：方向键/首尾/激活/收起/陷阱键都声明且互不冲突', () => {
  assert.deepEqual(TOOLBAR_KEYMAP.next, ['ArrowRight', 'ArrowDown']);
  assert.deepEqual(TOOLBAR_KEYMAP.prev, ['ArrowLeft', 'ArrowUp']);
  assert.deepEqual(TOOLBAR_KEYMAP.first, ['Home']);
  assert.deepEqual(TOOLBAR_KEYMAP.last, ['End']);
  assert.deepEqual(TOOLBAR_KEYMAP.activate, ['Enter', ' ']);
  assert.deepEqual(TOOLBAR_KEYMAP.dismiss, ['Escape']);
  assert.deepEqual(TOOLBAR_KEYMAP.trapNext, ['Tab']);
  assert.deepEqual(TOOLBAR_KEYMAP.trapPrev, ['Shift+Tab']);
  const all = [
    ...TOOLBAR_KEYMAP.next, ...TOOLBAR_KEYMAP.prev, ...TOOLBAR_KEYMAP.first, ...TOOLBAR_KEYMAP.last,
    ...TOOLBAR_KEYMAP.activate, ...TOOLBAR_KEYMAP.dismiss, ...TOOLBAR_KEYMAP.trapNext, ...TOOLBAR_KEYMAP.trapPrev,
  ];
  assert.equal(new Set(all).size, all.length, '键盘映射不应有重复键');
  assert.equal(TOOLBAR_KEYMAP.activate.includes(' '), true, '空格也是激活键');
  assert.deepEqual(TOOLBAR_LETTER_SHORTCUTS, { h: 'control.handback', p: 'control.hold', r: 'control.resume', s: 'record.stop', d: 'toolbar.dismiss' });
});

test('方向键/Home/End：焦点移动 + 播报 + preventDefault', () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  const right = controller.keydown(1, { key: 'ArrowRight' });
  assert.equal(right.handled, true);
  assert.equal(right.preventDefault, true);
  assert.equal(right.reason, 'next');
  assert.equal(right.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(right.announcement.politeness, 'polite');
  assert.match(right.announcement.text, /拒绝/);

  const down = controller.keydown(1, { key: 'ArrowDown' });
  assert.equal(down.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW, '向下同样走 next 并环绕');

  const left = controller.keydown(1, { key: 'ArrowLeft' });
  assert.equal(left.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(left.reason, 'prev');

  const home = controller.keydown(1, { key: 'Home' });
  assert.equal(home.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(home.reason, 'first');
  const end = controller.keydown(1, { key: 'End' });
  assert.equal(end.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(end.reason, 'last');
  assert.equal(controller.counters().keyEvents, 5);
});

test('Enter/空格激活焦点动作：返回 pending，await 后派发并播报（assertive）', async () => {
  const dispatched = [];
  const controller = createToolbarController({
    snapshotProvider: () => borrowPending(),
    onAction: async (action, model, meta) => {
      dispatched.push({ id: action.id, requestId: meta.requestId, mode: meta.mode });
      return { ok: true, accepted: true };
    },
  });
  const enter = controller.keydown(2, { key: 'Enter' });
  assert.equal(enter.handled, true);
  assert.equal(enter.preventDefault, true);
  assert.equal(enter.reason, 'activate');
  assert.equal(enter.action.id, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.ok(enter.pending);
  const result = await enter.pending;
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, true);
  assert.equal(result.announcement.politeness, 'assertive');
  assert.deepEqual(dispatched, [{ id: 'borrow.allow', requestId: 'req-k', mode: 'borrow-confirm' }]);

  const space = controller.keydown(2, { key: ' ' });
  assert.equal(space.action.id, TOOLBAR_ACTION_IDS.BORROW_ALLOW, '空格激活当前焦点（allow）');
  await space.pending;
  assert.equal(dispatched.length, 2);
});

test('Escape 在借用确认态：拒绝静默收起，保持焦点并明确要求决定', () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  const escape = controller.keydown(3, { key: 'Escape' });
  assert.equal(escape.handled, true);
  assert.equal(escape.preventDefault, true);
  assert.equal(escape.reason, 'decision-required');
  assert.equal(escape.result.ok, false);
  assert.equal(escape.result.code, ACTION_DISABLED_CODES.PENDING);
  assert.equal(controller.state(3).dismissed, false);
  assert.equal(escape.announcement.politeness, 'assertive');
  assert.match(escape.announcement.text, /允许或拒绝/);
});

test('Escape 在普通态：收起并返回焦点目标', () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  controller.setReturnFocus(4, 'page-main');
  const escape = controller.keydown(4, { key: 'Escape' });
  assert.equal(escape.handled, true);
  assert.equal(escape.result.ok, true);
  assert.equal(escape.result.returnFocusTo, 'page-main');
  assert.equal(controller.state(4).dismissed, true);
  assert.equal(escape.announcement.politeness, 'polite');
  assert.match(escape.announcement.text, /收起/);
});

test('焦点陷阱只在 modal 生效：Tab 环绕，普通模式 Tab 交还浏览器', () => {
  const modal = createToolbarController({ snapshotProvider: () => borrowPending() });
  const tabNext = modal.keydown(5, { key: 'Tab' });
  assert.equal(tabNext.handled, true);
  assert.equal(tabNext.preventDefault, true);
  assert.equal(tabNext.reason, 'trap-next');
  assert.equal(tabNext.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  const tabPrev = modal.keydown(5, { key: 'Tab', shiftKey: true });
  assert.equal(tabPrev.reason, 'trap-prev');
  assert.equal(tabPrev.focus.focusId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(modal.counters().traps, 2);

  const normal = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  const passthrough = normal.keydown(6, { key: 'Tab' });
  assert.equal(passthrough.handled, false);
  assert.equal(passthrough.preventDefault, false);
  assert.equal(passthrough.reason, 'tab-passthrough');
});

test('输入法/修饰键/空键/隐藏态：不抢事件，返回明确原因', () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  assert.equal(controller.keydown(7, { key: 'Enter', isComposing: true }).reason, 'ime-composing');
  assert.equal(controller.keydown(7, { key: 'a', ctrlKey: true }).reason, 'modifier');
  assert.equal(controller.keydown(7, { key: 'a', metaKey: true }).reason, 'modifier');
  assert.equal(controller.keydown(7, { key: 'a', altKey: true }).reason, 'modifier');
  assert.equal(controller.keydown(7, { key: '' }).reason, 'no-key');
  assert.equal(controller.keydown(7, { key: 'F5' }).reason, 'unmapped');
  assert.equal(controller.keydown(null, { key: 'Enter' }).handled, false);

  const hidden = createToolbarController({ snapshotProvider: () => snapshotOf() });
  const result = hidden.keydown(8, { key: 'Enter' });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'toolbar-hidden');
});

test('单词快捷键：非 modal 模式下 h/p/r/s/d 触发对应意图，modal 下不生效', async () => {
  const calls = [];
  const dispatch = async (action) => { calls.push(action.id); return { ok: true }; };
  const held = createToolbarController({ snapshotProvider: () => heldSnapshot(), onAction: dispatch });
  const resume = held.keydown(9, { key: 'r' });
  assert.equal(resume.handled, true);
  assert.equal(resume.action.id, TOOLBAR_ACTION_IDS.CONTROL_RESUME);
  assert.equal(resume.reason, 'shortcut');
  await resume.pending;
  const handback = held.keydown(9, { key: 'h' });
  assert.equal(handback.action.id, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK);
  await handback.pending;
  assert.deepEqual(calls, ['control.resume', 'control.handback']);

  const active = createToolbarController({ snapshotProvider: () => borrowActive(), onAction: dispatch });
  const hold = active.keydown(10, { key: 'p' });
  assert.equal(hold.action.id, TOOLBAR_ACTION_IDS.CONTROL_HOLD);
  await hold.pending;
  const dismiss = active.keydown(10, { key: 'd' });
  assert.equal(dismiss.action.id, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS);
  await dismiss.pending;

  const modal = createToolbarController({ snapshotProvider: () => borrowPending(), onAction: dispatch });
  const before = calls.length;
  const letterInModal = modal.keydown(11, { key: 'h' });
  assert.equal(letterInModal.handled, false, 'modal 里字母快捷键关闭（避免与决定冲突）');
  assert.equal(calls.length, before);
});

test('数字快捷键：1..N 快速选择可用动作，越界返回 digit-no-action', async () => {
  const calls = [];
  const controller = createToolbarController({
    snapshotProvider: () => borrowPending(),
    onAction: async (action) => { calls.push(action.id); return { ok: true }; },
  });
  const first = controller.keydown(12, { key: '1' });
  assert.equal(first.handled, true);
  assert.equal(first.action.id, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(first.reason, 'digit');
  await first.pending;
  const second = controller.keydown(12, { key: '2' });
  assert.equal(second.action.id, TOOLBAR_ACTION_IDS.BORROW_DENY);
  await second.pending;
  assert.deepEqual(calls, ['borrow.allow', 'borrow.deny']);
  const third = controller.keydown(12, { key: '3' });
  assert.equal(third.handled, true);
  assert.equal(third.reason, 'digit-no-action');
});

test('问号打开快捷键帮助（不改变状态，仅播报可用动作）', () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  const help = controller.keydown(13, { key: '?' });
  assert.equal(help.handled, true);
  assert.equal(help.preventDefault, true);
  assert.equal(help.reason, 'help');
  assert.match(help.announcement.text, /方向键选择/);
  assert.match(help.announcement.text, /交给 Agent/);
  assert.equal(controller.state(13).dismissed, false);
});

test('播报（ARIA live）：seq 递增、队列有界、model.aria.live 反映最新一条', () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot(), announcementLimit: 2 });
  const first = controller.announce(14, '第一条', { politeness: 'polite' });
  const second = controller.announce(14, '第二条', { politeness: 'assertive' });
  const third = controller.announce(14, '第三条');
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(third.seq, 3);
  const state = controller.state(14);
  assert.equal(state.announcement.text, '第三条');
  assert.equal(state.announcements.length, 2, '播报队列有界（保留最近 2 条）');
  const model = buildToolbarModel(heldSnapshot(), { announcement: third });
  assert.equal(model.aria.live.text, '第三条');
  assert.equal(model.aria.live.politeness, 'polite');
});

test('ARIA 属性完整性：roving tabindex 只有一个 0，动作带 keyshortcuts/data 属性', () => {
  const model = buildToolbarModel(heldSnapshot(), { now: 5000 });
  const aria = renderToolbarAria(model);
  const zeroIndexes = aria.actions.filter((entry) => entry.attributes.tabindex === 0);
  assert.equal(zeroIndexes.length, 1);
  assert.equal(zeroIndexes[0].id, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK);
  for (const entry of aria.actions) {
    assert.equal(entry.attributes.role, 'button');
    assert.equal(entry.attributes['data-bb-action-enabled'], 'true');
    assert.equal(typeof entry.attributes['aria-keyshortcuts'], 'string');
  }
  assert.equal(aria.focus.activedescendant, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK);
  assert.equal(aria.container['aria-describedby'], 'bb-toolbar-status');
  assert.equal(aria.container['aria-orientation'], 'horizontal');
  assert.equal(aria.focus.roving, true);
  assert.equal(actionAriaAttributes(model, TOOLBAR_ACTION_IDS.CONTROL_RESUME).tabindex, -1);
});

test('provider 状态切换后焦点合法回退：pending→confirmed 时不再有 allow/deny', () => {
  const source = switchable('pending');
  const controller = createToolbarController({ snapshotProvider: source.get });
  assert.equal(controller.model(15).focus.activeId, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  source.set('active');
  const model = controller.model(15);
  assert.equal(model.mode, TOOLBAR_MODES.BORROW_ACTIVE);
  assert.deepEqual(model.actions.map((action) => action.id), [TOOLBAR_ACTION_IDS.CONTROL_HANDBACK, TOOLBAR_ACTION_IDS.CONTROL_HOLD, TOOLBAR_ACTION_IDS.TOOLBAR_DISMISS]);
  assert.equal(model.focus.activeId, TOOLBAR_ACTION_IDS.CONTROL_HANDBACK, '旧的 allow 不在新模型里，回退到第一个可用动作');
  assert.equal(model.actions.some((action) => action.tabIndex === 0 && action.id === TOOLBAR_ACTION_IDS.CONTROL_HANDBACK), true);
});

test('没有 onAction 时 activate 只产出 intent（默认不执行任何命令）', async () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  const result = await controller.activate(16, TOOLBAR_ACTION_IDS.BORROW_ALLOW);
  assert.equal(result.ok, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.method, 'borrow.confirm');
  assert.deepEqual(result.intent, { decision: 'allow', requestKey: 'allow' });
  assert.equal(controller.state(16).actionCount, 1);
});

test('keydown 的 model 与 controller.model 一致（同一份快照/焦点状态）', () => {
  const controller = createToolbarController({ snapshotProvider: () => borrowPending() });
  const key = controller.keydown(17, { key: 'ArrowRight' });
  const model = controller.model(17);
  assert.equal(key.model.mode, model.mode);
  assert.equal(key.model.focus.activeId, model.focus.activeId);
  assert.equal(model.focus.activeId, TOOLBAR_ACTION_IDS.BORROW_DENY);
  assert.equal(key.model.evidence.actionCount, 2);
});

test('焦点空模型：hidden/0 动作时 focusNext 返回 E_TOOLBAR_EMPTY', () => {
  const controller = createToolbarController({ snapshotProvider: () => snapshotOf() });
  const next = controller.focusNext(18);
  assert.equal(next.ok, false);
  assert.equal(next.code, 'E_NOT_FOUND');
  assert.equal(controller.focusFirst(18).ok, false);
  assert.equal(controller.focusLast(18).ok, false);
});

test('reset 清空 controller 状态（键盘事件计数一并归零）', () => {
  const controller = createToolbarController({ snapshotProvider: () => heldSnapshot() });
  controller.keydown(19, { key: 'ArrowRight' });
  controller.keydown(19, { key: 'Escape' });
  assert.equal(controller.counters().keyEvents, 2);
  controller.reset();
  assert.equal(controller.counters().keyEvents, 0);
  assert.equal(controller.counters().tabs, 0);
  assert.equal(controller.state(19).visible, false);
});
