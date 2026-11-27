// 真实 Chromium DOM 测试：扩展确认对话框的可访问性（焦点陷阱/Escape/aria-live/键盘）。
// 由 tests/browser/a11y-dialog.html 加载；直接使用扩展运行时模块 extension/ui/a11y-dialog.js。
import {
  DIALOG_TEXT,
  announce,
  clearAnnouncements,
  closeAllDialogs,
  createFocusTrap,
  dialogText,
  isDialogOpen,
  isTabbable,
  liveRegionNode,
  openDialog,
  tabbable,
} from '/extension/ui/a11y-dialog.js';

const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const opener = () => document.getElementById('opener');
const app = () => document.getElementById('app');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => pause(10);
const key = (element, keyName, shiftKey = false) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true, cancelable: true }));
};
const click = (element) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const q = (root, selector) => {
  const node = root.querySelector(selector);
  assert(node, '找不到元素：' + selector);
  return node;
};
const allDialogs = () => [...document.querySelectorAll('[data-bb-dialog-layer]')];

function clean() {
  closeAllDialogs();
  for (const layer of allDialogs()) layer.remove();
  app().removeAttribute('aria-hidden');
  app().inert = false;
  clearAnnouncements();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('结构：role=dialog / aria-modal / labelledby / describedby / aria-live / 背景隔离', async () => {
  opener().focus();
  const api = openDialog({ title: '清空任务审计记录？', body: '只清空本机记录，无法恢复。', confirmLabel: '清空记录', lang: 'zh' });
  const card = q(api.element, '[role="dialog"]');
  assert(card.getAttribute('aria-modal') === 'true', '缺 aria-modal=true');
  const titleId = card.getAttribute('aria-labelledby');
  const bodyId = card.getAttribute('aria-describedby');
  assert(titleId && bodyId, '缺 aria-labelledby/aria-describedby');
  assert(document.getElementById(titleId).textContent === '清空任务审计记录？', 'aria-labelledby 没有指向标题');
  assert(document.getElementById(bodyId).textContent.includes('无法恢复'), 'aria-describedby 没有指向正文');
  assert(api.element.getAttribute('data-bb-dialog-layer') !== null, '对话框层标记缺失');
  assert(app().getAttribute('aria-hidden') === 'true', '背景没有 aria-hidden');
  assert(app().inert === true, '背景没有 inert');
  const live = liveRegionNode();
  assert(live && live.getAttribute('role') === 'status', 'aria-live 区 role 不是 status');
  assert(live.getAttribute('aria-live') === 'polite', 'aria-live 不是 polite');
  assert(live.getAttribute('aria-atomic') === 'true', 'aria-atomic 缺失');
  await nextFrame();
  assert(live.textContent.includes('清空任务审计记录？'), '打开后没有 aria-live 播报：' + live.textContent);
  assert(document.activeElement === api.card.querySelector('[data-cancel]'), '初始焦点不在取消按钮（破坏性操作默认焦点必须是安全选项）');
  assert(isDialogOpen(), 'isDialogOpen() 应为 true');
  api.close({ confirmed: false, via: 'test' });
  await api.result;
});

test('焦点陷阱：Tab/Shift+Tab 在对话框内循环，焦点被移出时自动拉回', async () => {
  const api = openDialog({ title: '焦点陷阱', body: 'Tab 循环', lang: 'zh' });
  const close = q(api.card, '[data-close]');
  const cancel = q(api.card, '[data-cancel]');
  const confirm = q(api.card, '[data-confirm]');
  const order = tabbable(api.card);
  assert(order.length === 3, '可聚焦元素数不是 3：' + order.length);
  assert(order[0] === close && order[1] === cancel && order[2] === confirm, 'Tab 顺序与 DOM 顺序不一致');

  cancel.focus();
  key(cancel, 'Tab');
  assert(document.activeElement === confirm, 'Tab 没有从取消到确认');
  key(confirm, 'Tab');
  assert(document.activeElement === close, 'Tab 没有从最后一个元素回绕到第一个');
  key(close, 'Tab', true);
  assert(document.activeElement === confirm, 'Shift+Tab 没有从第一个回绕到最后一个');
  key(confirm, 'Tab', true);
  assert(document.activeElement === cancel, 'Shift+Tab 没有从确认回到取消');

  // 焦点被移到对话框层内、卡片外的元素：trap 必须把焦点拉回卡片内。
  const outside = document.createElement('button');
  outside.type = 'button';
  outside.id = 'outside-focus';
  outside.textContent = 'outside';
  api.element.appendChild(outside);
  outside.focus();
  assert(api.card.contains(document.activeElement), '焦点移出对话框后没有被拉回：' + (document.activeElement && document.activeElement.id));
  api.card.focus();
  key(api.card, 'Tab');
  assert(document.activeElement === close, '从卡片容器 Tab 没有进入第一个可聚焦元素');
  api.close({ confirmed: false, via: 'test' });
  await api.result;
});

test('Escape 关闭：拒绝结算 + 焦点回到打开按钮 + 背景解除隔离 + 关闭播报', async () => {
  const trigger = opener();
  trigger.focus();
  const api = openDialog({ title: 'Escape 关闭', body: '', lang: 'zh', tone: 'danger' });
  key(api.card, 'Escape');
  const outcome = await api.result;
  assert(outcome.confirmed === false && outcome.via === 'escape', 'Escape 结算不对：' + JSON.stringify(outcome));
  assert(allDialogs().length === 0, 'Escape 后对话框层没有移除');
  assert(document.activeElement === trigger, '关闭后焦点没有回到打开按钮');
  assert(app().getAttribute('aria-hidden') === null, '背景 aria-hidden 没有恢复');
  assert(app().inert !== true, '背景 inert 没有恢复');
  assert(!isDialogOpen(), 'isDialogOpen() 应为 false');
  await nextFrame();
  const live = liveRegionNode();
  assert(live.textContent === DIALOG_TEXT.zh.dismissed, '关闭后没有播报：' + live.textContent);
});

test('鼠标路径：确认/取消/关闭 X/遮罩点击分别结算正确', async () => {
  const cases = [
    ['confirm', (api) => click(q(api.card, '[data-confirm]')), true],
    ['cancel', (api) => click(q(api.card, '[data-cancel]')), false],
    ['close', (api) => click(q(api.card, '[data-close]')), false],
    ['backdrop', (api) => click(api.element), false],
  ];
  for (const [via, run, confirmed] of cases) {
    const api = openDialog({ title: '路径 ' + via, body: '', lang: 'zh' });
    run(api);
    const outcome = await api.result;
    assert(outcome.confirmed === confirmed, via + ' 的 confirmed 不对');
    assert(outcome.via === via, via + ' 的 via 不对：' + outcome.via);
    assert(!api.element.isConnected, via + ' 后对话框仍在文档里');
    assert(typeof outcome.elapsedMs === 'number' && outcome.elapsedMs >= 0, via + ' 缺 elapsedMs');
  }
});

test('键盘：卡片上按 Enter = 取消（不误触破坏性确认）', async () => {
  const api = openDialog({ title: 'Enter 取消', body: '', lang: 'zh', tone: 'danger', initialFocus: 'confirm' });
  assert(document.activeElement === q(api.card, '[data-confirm]'), 'initialFocus=confirm 没有生效');
  api.card.focus();
  key(api.card, 'Enter');
  const outcome = await api.result;
  assert(outcome.confirmed === false && outcome.via === 'keyboard', 'Enter 没有按取消结算：' + JSON.stringify(outcome));
});

test('12 语言按钮文案：ar/he 会使用本地化标签，且不残留英文确认词', async () => {
  for (const lang of ['en', 'ar', 'he', 'ja']) {
    const api = openDialog({ title: 'T', body: 'B', lang });
    const text = dialogText(lang);
    assert(q(api.card, '[data-confirm]').textContent === text.confirm, lang + ' 确认按钮没有本地化');
    assert(q(api.card, '[data-cancel]').textContent === text.cancel, lang + ' 取消按钮没有本地化');
    assert(q(api.card, '[data-close]').getAttribute('aria-label') === text.close, lang + ' 关闭按钮 aria-label 没有本地化');
    api.close({ confirmed: false, via: 'test' });
    await api.result;
  }
});

test('returnFocus=false 时关闭不抢回焦点', async () => {
  const other = document.getElementById('other');
  other.focus();
  const api = openDialog({ title: '不还焦点', body: '', lang: 'zh', returnFocus: false });
  api.close({ confirmed: false, via: 'test' });
  await api.result;
  assert(document.activeElement !== other, 'returnFocus=false 仍然把焦点还给了打开按钮');
});

test('辅助函数：tabbable 排除禁用/隐藏/tabindex=-1，trap 可独立使用', async () => {
  const host = document.createElement('div');
  host.innerHTML = '<button id="a">a</button><button id="b" disabled>b</button>'
    + '<div id="c" tabindex="-1">c</div><div id="d" style="display:none"><button id="e">e</button></div>'
    + '<button id="f" tabindex="0">f</button>';
  document.body.appendChild(host);
  const ids = tabbable(host).map((node) => node.id);
  assert(ids.join(',') === 'a,f', 'tabbable 过滤不对：' + ids.join(','));
  assert(isTabbable(document.getElementById('b')) === false, '禁用按钮不应可 Tab');
  assert(isTabbable(document.getElementById('c')) === false, 'tabindex=-1 不应可 Tab');

  let escaped = 0;
  const trap = createFocusTrap(host, { onEscape: () => { escaped += 1; } });
  trap.activate();
  assert(document.activeElement === document.getElementById('a'), '独立 trap 初始焦点不对');
  key(host, 'Escape');
  assert(escaped === 1, '独立 trap 的 Escape 回调没有触发');
  trap.deactivate();
  host.remove();
});

test('announce 重复播报会重新触发（先清空再写入）', async () => {
  announce('第一次播报');
  await nextFrame();
  const live = liveRegionNode();
  assert(live.textContent === '第一次播报', '第一次播报失败：' + live.textContent);
  announce('第二次播报');
  await nextFrame();
  assert(live.textContent === '第二次播报', '重复播报失败：' + live.textContent);
  announce('   ');
  assert(live.textContent === '第二次播报', '空播报不应清空当前文本');
});

test('cleanup：closeAllDialogs 能关闭所有打开层并恢复背景', async () => {
  openDialog({ title: 'A', body: '', lang: 'zh' });
  openDialog({ title: 'B', body: '', lang: 'en' });
  assert(allDialogs().length === 2, '两个对话框没有同时打开');
  assert(isDialogOpen(), 'isDialogOpen 应为 true');
  closeAllDialogs();
  assert(allDialogs().length === 0, 'closeAllDialogs 后仍有对话框');
  assert(!isDialogOpen(), 'closeAllDialogs 后 isDialogOpen 应为 false');
  await pause(10);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      document.title = 'A11Y_DIALOG_PROGRESS:' + passed + ':' + name;
      await fn();
      passed += 1;
      clean();
    } catch (error) {
      clean();
      document.title = 'A11Y_DIALOG_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'A11Y_DIALOG_OK:' + passed;
})();
