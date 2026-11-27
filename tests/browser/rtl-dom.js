// 真实 Chromium DOM 测试：扩展 UI / 浮层的 RTL 逻辑布局与图标镜像。
// 由 tests/browser/rtl-dom.html?dir=rtl 加载；页面内同时验证 RTL 与切回 LTR。
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const style = (id, pseudo) => getComputedStyle(document.getElementById(id), pseudo || null);
const rect = (id) => document.getElementById(id).getBoundingClientRect();
const root = document.documentElement;
// 断言的是最终布局值，关闭过渡/动画避免读到过渡中间帧。
const freeze = document.createElement('style');
freeze.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
document.head.appendChild(freeze);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('RTL：页面方向来自 ?dir=rtl', () => {
  assert(root.dir === 'rtl', 'root.dir 不是 rtl：' + root.dir);
  assert(root.getAttribute('data-bb-dir') === 'rtl', 'data-bb-dir 不是 rtl');
});

test('RTL：开关滑块从右往左移动', () => {
  const knob = style('sw', '::after');
  assert(knob.right === '2px', '开关没有锚定到右侧：right=' + knob.right);
  assert(/matrix\(1, 0, 0, 1, -16, 0\)/.test(knob.transform), '开关开启位移没有镜像：' + knob.transform);
  const sliderKnob = style('slider', '::before');
  assert(sliderKnob.right === '3px', 'ui.css 开关没有锚定到右侧：right=' + sliderKnob.right);
  assert(/matrix\(1, 0, 0, 1, -16, 0\)/.test(sliderKnob.transform), 'ui.css 开关位移没有镜像：' + sliderKnob.transform);
});

test('RTL：Toast/徽标锚定内联结束侧', () => {
  const toast = rect('toast');
  assert(Math.abs(toast.left - 18) <= 1, 'toast 没有贴左边：left=' + toast.left);
  assert(toast.right < window.innerWidth - 100, 'toast 占满整行？right=' + toast.right);
  const badge = rect('badge');
  const button = rect('icon-btn');
  assert(badge.left < button.left, 'badge 没有移到按钮左侧：' + badge.left + ' / ' + button.left);
});

test('RTL：details 箭头/自定义 chevron 镜像', () => {
  const before = style('settings-summary', '::before');
  assert(before.content.includes('◂'), 'settings 箭头没有镜像：' + before.content);
  assert(before.marginLeft === '4px' && before.marginRight === '0px', 'settings 箭头间距没有逻辑化：' + before.marginLeft + '/' + before.marginRight);
  const conn = style('conn-summary', '::before');
  assert(conn.content.includes('◂'), 'conn 箭头没有镜像：' + conn.content);
  const chev = style('chev');
  assert(/matrix\(-1, 0, 0, 1, 0, 0\)/.test(chev.transform), 'chevron 没有水平镜像：' + chev.transform);
});

test('RTL：tooltip 由内联起始侧定位', () => {
  const tip = rect('tip');
  const row = rect('setting-row');
  assert(Math.abs(tip.right - row.right) <= 1, 'tooltip 没有贴右侧：tip.right=' + tip.right + ' row.right=' + row.right);
});

test('切回 LTR：同一套组件恢复物理方向', () => {
  root.dir = 'ltr';
  try {
    const toast = rect('toast');
    assert(toast.right > window.innerWidth - 100, 'LTR toast 没有贴右边：right=' + toast.right);
    const badge = rect('badge');
    const button = rect('icon-btn');
    assert(badge.left > button.left - 1, 'LTR badge 位置不对：' + badge.left + ' / ' + button.left);
    const knob = style('sw', '::after');
    assert(knob.left === '2px', 'LTR 开关没有锚定到左侧：left=' + knob.left);
    assert(/matrix\(1, 0, 0, 1, 16, 0\)/.test(knob.transform), 'LTR 开关位移不对：' + knob.transform);
    const before = style('settings-summary', '::before');
    assert(before.content.includes('▸'), 'LTR settings 箭头不对：' + before.content);
  } finally {
    root.dir = 'rtl';
  }
});

test('键盘可达性：可聚焦元素按 DOM 顺序，禁用/隐藏元素被排除', () => {
  const selector = 'button:not([disabled]), input:not([disabled]), summary, a[href], [tabindex]:not([tabindex="-1"])';
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 || box.height > 0;
  };
  const focusables = [...document.querySelectorAll(selector)].filter(visible);
  const ids = focusables.map((element) => element.id).filter(Boolean);
  assert(!ids.includes('focus-disabled'), '禁用按钮不应在 Tab 顺序里');
  assert(!ids.includes('focus-hidden'), '隐藏按钮不应在 Tab 顺序里');
  assert(ids.includes('focus-a') && ids.includes('focus-b') && ids.includes('focus-input') && ids.includes('focus-link'), '可聚焦元素缺失：' + ids.join(','));
  // 顺序与 DOM 顺序一致（RTL 不反转键盘顺序）
  const order = ['focus-a', 'focus-b', 'focus-input', 'focus-link'];
  const positions = order.map((id) => ids.indexOf(id));
  assert(positions.every((value, index) => index === 0 || value > positions[index - 1]), 'Tab 顺序不是 DOM 顺序：' + ids.join(','));
  // 逐个 focus() 验证真的可达，且方向切换不会丢焦点
  for (const id of order) {
    document.getElementById(id).focus();
    assert(document.activeElement === document.getElementById(id), id + ' 无法聚焦');
  }
  root.dir = 'rtl';
  try {
    document.getElementById('focus-b').focus();
    assert(document.activeElement === document.getElementById('focus-b'), 'RTL 切换后焦点丢失');
  } finally {
    root.dir = 'rtl';
  }
});

test('焦点环方向无关：:focus-visible 规则存在且使用 accent token / 2px 偏移', () => {
  const rules = [];
  for (const sheet of document.styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) {
      if (rule.selectorText && /:focus-visible/.test(rule.selectorText)) rules.push(rule);
    }
  }
  assert(rules.length >= 1, '样式表里没有 :focus-visible 规则');
  const text = rules.map((rule) => rule.cssText).join('\n');
  assert(/outline:\s*2px solid var\(--accent\)/.test(text) || /outline-width:\s*2px/.test(text), '焦点环不是 2px accent：' + text.slice(0, 160));
  assert(/outline-offset:\s*2px/.test(text), '焦点环缺 outline-offset: 2px');
  // 焦点环不包含方向性属性（left/right/margin-left 等），因此在 RTL 下不会偏移。
  assert(!/(?:^|[;{])\s*(?:left|right|margin-left|margin-right)\s*:/.test(text), '焦点环使用物理方向属性：' + text.slice(0, 200));
});

test('无障碍语义：开关 role=switch/aria-checked，图标按钮有可访问名称', () => {
  const sw = document.getElementById('sw');
  assert(sw.getAttribute('role') === 'switch', '开关 role 不是 switch');
  assert(sw.getAttribute('aria-checked') === 'true', '开关缺 aria-checked');
  const icon = document.getElementById('icon-btn');
  assert((icon.getAttribute('aria-label') || icon.textContent || '').trim(), '图标按钮缺可访问名称');
  for (const id of ['focus-a', 'focus-b']) {
    const button = document.getElementById(id);
    assert((button.textContent || '').trim(), id + ' 缺可访问名称');
  }
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      passed += 1;
    } catch (error) {
      document.title = 'RTL_DOM_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'RTL_DOM_OK:' + passed;
})();
